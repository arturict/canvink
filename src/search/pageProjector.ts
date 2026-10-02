import type { PdfTextRequest } from './searchablePage';
import type { SearchablePage } from './types';

export interface PageProjectionRequest {
  id: number;
  documentId: string;
  bytes: Uint8Array;
}

export type PageProjectionResponse =
  | { id: number; ok: true; page: SearchablePage; pdfRequests: PdfTextRequest[]; heads: string[] }
  | { id: number; ok: false; message: string };

export interface ProjectedPage {
  page: SearchablePage;
  pdfRequests: PdfTextRequest[];
  heads: string[];
}

/** Turns stored page bytes into the page's searchable part. */
export interface PageProjector {
  project(documentId: string, bytes: Uint8Array): Promise<ProjectedPage>;
  dispose(): void;
}

/**
 * Projects pages in a dedicated worker (see pageProjection.worker.ts), one
 * request at a time in the order they were made. The bytes are transferred,
 * not copied. When the worker cannot start or dies, every pending and later
 * request fails, and callers read the page on the main thread instead.
 */
export class WorkerPageProjector implements PageProjector {
  private worker?: Worker;
  private broken = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (page: ProjectedPage) => void; reject: (error: Error) => void }>();

  /**
   * `idleMs` after its last answer the worker is stopped and a later request
   * starts a new one: Automerge's WebAssembly memory only grows, and a
   * worker that once loaded a page with thousands of strokes would keep
   * hundreds of megabytes for as long as the app runs.
   */
  constructor(
    private readonly createWorker: () => Worker,
    private readonly idleMs = 15_000,
  ) {}

  project(documentId: string, bytes: Uint8Array): Promise<ProjectedPage> {
    clearTimeout(this.idleTimer);
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error('The page projection worker is not available.'));
    const id = this.nextId;
    this.nextId += 1;
    // The buffer is transferred; a view into a larger buffer is copied first
    // so that nothing else loses its bytes.
    const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: PageProjectionRequest = { id, documentId, bytes: owned };
      worker.postMessage(request, [owned.buffer]);
    });
  }

  get available(): boolean {
    return !this.broken;
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = undefined;
    this.failAll(new Error('The page projection worker was stopped.'));
  }

  private ensureWorker(): Worker | undefined {
    if (this.broken) return undefined;
    if (this.worker) return this.worker;
    try {
      const worker = this.createWorker();
      worker.onmessage = (event: MessageEvent<PageProjectionResponse>) => {
        const response = event.data;
        const waiting = this.pending.get(response.id);
        if (!waiting) return;
        this.pending.delete(response.id);
        if (response.ok) waiting.resolve({ page: response.page, pdfRequests: response.pdfRequests, heads: response.heads });
        else waiting.reject(new Error(response.message));
        if (this.pending.size === 0) this.scheduleIdleStop(worker);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        this.broken = true;
        this.worker?.terminate();
        this.worker = undefined;
        this.failAll(new Error(`The page projection worker failed: ${event.message}`));
      };
      this.worker = worker;
      return worker;
    } catch {
      this.broken = true;
      return undefined;
    }
  }

  private scheduleIdleStop(worker: Worker): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.worker !== worker || this.pending.size > 0) return;
      worker.terminate();
      this.worker = undefined;
    }, this.idleMs);
  }

  private failAll(error: Error): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    waiting.forEach(({ reject }) => reject(error));
  }
}

/** A projector backed by the bundled worker, or undefined where workers do not exist (tests, old runtimes). */
export function createDefaultPageProjector(): WorkerPageProjector | undefined {
  if (typeof Worker === 'undefined') return undefined;
  return new WorkerPageProjector(() => new Worker(new URL('./pageProjection.worker.ts', import.meta.url), {
    type: 'module',
    name: 'canvink-page-projection',
  }));
}
