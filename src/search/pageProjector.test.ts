import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerPageProjector, type PageProjectionRequest, type PageProjectionResponse } from './pageProjector';

/** A stand-in for the projection worker that answers requests when told to. */
class FakeWorker {
  onmessage: ((event: MessageEvent<PageProjectionResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: PageProjectionRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

  postMessage(request: PageProjectionRequest, transfer: Transferable[]): void {
    this.requests.push(request);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  answer(response: PageProjectionResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<PageProjectionResponse>);
  }

  crash(message: string): void {
    this.onerror?.({ message, preventDefault: () => undefined } as ErrorEvent);
  }
}

const page = { documentId: 'page:a', notebookId: 'n', pageId: 'a', sectionId: 's', title: 'A', tags: [], updatedAt: '', zOrder: [], elementsById: {}, schemaVersion: 3 as const };

describe('WorkerPageProjector', () => {
  it('matches answers to requests and transfers the bytes', async () => {
    const worker = new FakeWorker();
    const projector = new WorkerPageProjector(() => worker as unknown as Worker);
    const bytes = new Uint8Array([1, 2, 3]);
    const first = projector.project('page:a', bytes);
    const second = projector.project('page:b', new Uint8Array([4]));
    expect(worker.requests.map((request) => request.documentId)).toEqual(['page:a', 'page:b']);
    expect(worker.transfers[0]).toEqual([bytes.buffer]);

    worker.answer({ id: worker.requests[1].id, ok: false, message: 'not a page' });
    worker.answer({ id: worker.requests[0].id, ok: true, page, pdfRequests: [], heads: ['h'] });
    await expect(first).resolves.toMatchObject({ heads: ['h'], page: { pageId: 'a' } });
    await expect(second).rejects.toThrow('not a page');
  });

  it('copies a view into a larger buffer before transferring it', () => {
    const worker = new FakeWorker();
    const projector = new WorkerPageProjector(() => worker as unknown as Worker);
    const shared = new Uint8Array([9, 8, 7, 6]);
    void projector.project('page:a', shared.subarray(1, 3)).catch(() => undefined);
    expect(worker.requests[0].bytes).toEqual(new Uint8Array([8, 7]));
    expect(shared.byteLength).toBe(4);
    projector.dispose();
  });

  it('fails pending and later requests once the worker dies', async () => {
    const worker = new FakeWorker();
    let created = 0;
    const projector = new WorkerPageProjector(() => { created += 1; return worker as unknown as Worker; });
    const pending = projector.project('page:a', new Uint8Array([1]));
    worker.crash('out of memory');
    await expect(pending).rejects.toThrow('out of memory');
    await expect(projector.project('page:b', new Uint8Array([2]))).rejects.toThrow('not available');
    expect(created).toBe(1);
    expect(worker.terminated).toBe(true);
  });

  describe('when idle', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('stops the worker after its last answer and starts a new one for the next request', async () => {
      vi.useFakeTimers();
      const workers: FakeWorker[] = [];
      const projector = new WorkerPageProjector(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      }, 1_000);
      const first = projector.project('page:a', new Uint8Array([1]));
      workers[0].answer({ id: workers[0].requests[0].id, ok: true, page, pdfRequests: [], heads: ['h'] });
      await first;
      await vi.advanceTimersByTimeAsync(999);
      expect(workers[0].terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(workers[0].terminated).toBe(true);

      const second = projector.project('page:b', new Uint8Array([2]));
      expect(workers).toHaveLength(2);
      workers[1].answer({ id: workers[1].requests[0].id, ok: true, page, pdfRequests: [], heads: ['h2'] });
      await expect(second).resolves.toMatchObject({ heads: ['h2'] });
      projector.dispose();
    });

    it('keeps the worker while a request is still pending', async () => {
      vi.useFakeTimers();
      const worker = new FakeWorker();
      const projector = new WorkerPageProjector(() => worker as unknown as Worker, 1_000);
      const first = projector.project('page:a', new Uint8Array([1]));
      const second = projector.project('page:b', new Uint8Array([2]));
      worker.answer({ id: worker.requests[0].id, ok: true, page, pdfRequests: [], heads: ['h'] });
      await first;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(worker.terminated).toBe(false);
      worker.answer({ id: worker.requests[1].id, ok: true, page, pdfRequests: [], heads: ['h'] });
      await second;
      await vi.advanceTimersByTimeAsync(1_001);
      expect(worker.terminated).toBe(true);
    });
  });
});
