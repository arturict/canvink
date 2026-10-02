import { invoke } from '@tauri-apps/api/core';

export const OCR_LIMITS = Object.freeze({
  imageBytes: 32 * 1024 * 1024,
  pendingJobs: 8,
  languageTagCharacters: 64,
});

export interface OcrBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  boundingBox: OcrBoundingBox;
  confidence?: number;
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
}

export interface OcrRecognitionResult {
  engine: 'windows-media-ocr';
  languageTag: string;
  text: string;
  textAngle?: number;
  lines: OcrLine[];
}

export interface OcrAdapter {
  availableLanguages(): Promise<string[]>;
  recognize(imageBytes: Uint8Array, languageTag?: string): Promise<OcrRecognitionResult>;
}

export class OcrCancelledError extends Error {
  constructor() {
    super('OCR request was cancelled.');
    this.name = 'OcrCancelledError';
  }
}

export class OcrBackpressureError extends Error {
  constructor() {
    super(`OCR queue already contains ${OCR_LIMITS.pendingJobs} jobs.`);
    this.name = 'OcrBackpressureError';
  }
}

function isSupportedImage(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const bmp = bytes[0] === 0x42 && bytes[1] === 0x4d;
  const tiff = (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
    || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a);
  return png || jpeg || bmp || tiff;
}

function validateInput(bytes: Uint8Array, languageTag?: string): void {
  if (bytes.byteLength === 0 || bytes.byteLength > OCR_LIMITS.imageBytes) {
    throw new RangeError(`OCR image must contain 1 to ${OCR_LIMITS.imageBytes} bytes.`);
  }
  if (!isSupportedImage(bytes)) throw new TypeError('OCR accepts decoded PNG, JPEG, BMP, or TIFF image bytes only.');
  if (languageTag !== undefined && (!languageTag || languageTag.length > OCR_LIMITS.languageTagCharacters)) {
    throw new TypeError('OCR language tag is empty or too long.');
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export class TauriWindowsOcrAdapter implements OcrAdapter {
  availableLanguages(): Promise<string[]> {
    return invoke<string[]>('ocr_available_languages');
  }

  async recognize(imageBytes: Uint8Array, languageTag?: string): Promise<OcrRecognitionResult> {
    validateInput(imageBytes, languageTag);
    return invoke<OcrRecognitionResult>('ocr_recognize_image', {
      request: {
        dataBase64: bytesToBase64(imageBytes),
        ...(languageTag ? { languageTag } : {}),
      },
    });
  }
}

export class UnsupportedBrowserOcrAdapter implements OcrAdapter {
  async availableLanguages(): Promise<string[]> {
    return [];
  }

  async recognize(): Promise<OcrRecognitionResult> {
    throw new Error('Local OCR is available only in the Windows desktop app.');
  }
}

interface QueueJob {
  bytes: Uint8Array;
  languageTag?: string;
  signal?: AbortSignal;
  resolve: (result: OcrRecognitionResult) => void;
  reject: (error: unknown) => void;
  cancelled: boolean;
  removeAbortListener?: () => void;
}

export class OcrQueue {
  private readonly pending: QueueJob[] = [];
  private active: QueueJob | null = null;
  private closed = false;

  constructor(private readonly adapter: OcrAdapter, private readonly maximumPending: number = OCR_LIMITS.pendingJobs) {
    if (!Number.isInteger(maximumPending) || maximumPending < 1 || maximumPending > OCR_LIMITS.pendingJobs) {
      throw new RangeError(`OCR queue capacity must be between 1 and ${OCR_LIMITS.pendingJobs}.`);
    }
  }

  recognize(imageBytes: Uint8Array, languageTag?: string, signal?: AbortSignal): Promise<OcrRecognitionResult> {
    validateInput(imageBytes, languageTag);
    if (this.closed) return Promise.reject(new OcrCancelledError());
    if (signal?.aborted) return Promise.reject(new OcrCancelledError());
    if (this.pending.length + (this.active ? 1 : 0) >= this.maximumPending) {
      return Promise.reject(new OcrBackpressureError());
    }
    return new Promise((resolve, reject) => {
      const job: QueueJob = {
        bytes: imageBytes.slice(),
        ...(languageTag ? { languageTag } : {}),
        ...(signal ? { signal } : {}),
        resolve,
        reject,
        cancelled: false,
      };
      if (signal) {
        const cancel = () => {
          job.cancelled = true;
          const pendingIndex = this.pending.indexOf(job);
          if (pendingIndex >= 0) {
            this.pending.splice(pendingIndex, 1);
            reject(new OcrCancelledError());
          }
        };
        signal.addEventListener('abort', cancel, { once: true });
        job.removeAbortListener = () => signal.removeEventListener('abort', cancel);
      }
      this.pending.push(job);
      void this.pump();
    });
  }

  cancelPending(): void {
    for (const job of this.pending.splice(0)) {
      job.cancelled = true;
      job.removeAbortListener?.();
      job.reject(new OcrCancelledError());
    }
  }

  close(): void {
    this.closed = true;
    this.cancelPending();
    if (this.active) this.active.cancelled = true;
  }

  private async pump(): Promise<void> {
    if (this.active || this.closed) return;
    const job = this.pending.shift();
    if (!job) return;
    this.active = job;
    try {
      const result = await this.adapter.recognize(job.bytes, job.languageTag);
      if (job.cancelled || job.signal?.aborted) job.reject(new OcrCancelledError());
      else job.resolve(result);
    } catch (error) {
      if (job.cancelled || job.signal?.aborted) job.reject(new OcrCancelledError());
      else job.reject(error);
    } finally {
      job.removeAbortListener?.();
      this.active = null;
      void this.pump();
    }
  }
}
