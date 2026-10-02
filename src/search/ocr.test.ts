import {
  OCR_LIMITS,
  OcrBackpressureError,
  OcrCancelledError,
  OcrQueue,
  type OcrAdapter,
  type OcrRecognitionResult,
} from './ocr';
import { expect, test, vi } from 'vitest';

function pngFixture(fill = 0): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, fill]);
}

function result(text: string, languageTag = 'de-DE'): OcrRecognitionResult {
  return {
    engine: 'windows-media-ocr',
    languageTag,
    text,
    lines: [{
      text,
      words: [{ text, boundingBox: { x: 1, y: 2, width: 30, height: 10 } }],
    }],
  };
}

class DeferredOcr implements OcrAdapter {
  readonly calls: Array<{ bytes: Uint8Array; languageTag?: string; resolve: (value: OcrRecognitionResult) => void }> = [];

  async availableLanguages(): Promise<string[]> {
    return ['de-DE', 'en-US'];
  }

  recognize(bytes: Uint8Array, languageTag?: string): Promise<OcrRecognitionResult> {
    return new Promise((resolve) => this.calls.push({ bytes, ...(languageTag ? { languageTag } : {}), resolve }));
  }
}

test('queues local scan OCR with installed language choice and preserves boxes', async () => {
  const adapter = new DeferredOcr();
  const queue = new OcrQueue(adapter);
  const pending = queue.recognize(pngFixture(), 'de-DE');
  await vi.waitFor(() => expect(adapter.calls).toHaveLength(1));
  adapter.calls[0]?.resolve(result('Kräfte ∑ F = 0'));
  await expect(pending).resolves.toEqual(result('Kräfte ∑ F = 0'));
  expect(await adapter.availableLanguages()).toEqual(['de-DE', 'en-US']);
});

test('cancels queued and active jobs without publishing stale OCR projections', async () => {
  const adapter = new DeferredOcr();
  const queue = new OcrQueue(adapter, 2);
  const activeController = new AbortController();
  const queuedController = new AbortController();
  const active = queue.recognize(pngFixture(1), 'de-DE', activeController.signal);
  const queued = queue.recognize(pngFixture(2), 'de-DE', queuedController.signal);
  queuedController.abort();
  await expect(queued).rejects.toBeInstanceOf(OcrCancelledError);
  activeController.abort();
  adapter.calls[0]?.resolve(result('discard me'));
  await expect(active).rejects.toBeInstanceOf(OcrCancelledError);
});

test('applies bounded backpressure and rejects non-image or huge input before native invocation', async () => {
  const adapter = new DeferredOcr();
  const queue = new OcrQueue(adapter, 1);
  const first = queue.recognize(pngFixture());
  await expect(queue.recognize(pngFixture(2))).rejects.toBeInstanceOf(OcrBackpressureError);
  expect(() => queue.recognize(new Uint8Array([1, 2, 3, 4]))).toThrow(TypeError);
  expect(() => queue.recognize(new Uint8Array(OCR_LIMITS.imageBytes + 1))).toThrow(RangeError);
  adapter.calls[0]?.resolve(result('done'));
  await expect(first).resolves.toMatchObject({ text: 'done' });
});
