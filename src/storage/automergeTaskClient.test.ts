import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceState } from '../domain/types';
import { prepareV1ToV2Migration } from '../domain/v2/migration';
import type { MigrationResultV2, StoredDocumentV2 } from '../domain/v2/types';
import type { AutomergeTaskRequest, AutomergeTaskResponse } from './automergeTaskCore';
import {
  AutomergeTaskWorker,
  AutomergeWorkerUnavailableError,
  WorkerAutomergeMigrationMaterializer,
  runInWorkerOrHere,
} from './automergeTaskClient';

type Handler = (request: AutomergeTaskRequest & { id: number }) => AutomergeTaskResponse | undefined;

/** A worker that answers each request through `handler` on the next tick. */
class FakeWorker {
  onmessage: ((event: MessageEvent<AutomergeTaskResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly requests: Array<AutomergeTaskRequest & { id: number }> = [];

  constructor(private readonly handler: Handler) {}

  postMessage(request: AutomergeTaskRequest & { id: number }): void {
    this.requests.push(request);
    setTimeout(() => {
      const response = this.handler(request);
      if (response) this.onmessage?.({ data: response } as MessageEvent<AutomergeTaskResponse>);
    }, 0);
  }

  crash(message: string): void {
    this.onerror?.({ message, preventDefault: () => undefined } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const TIME = '2026-10-01T08:00:00.000Z';
const workspace: WorkspaceState = {
  schemaVersion: 1,
  updatedAt: TIME,
  notebooks: [{
    id: 'notebook-1', title: 'School', color: '#123456', createdAt: TIME, updatedAt: TIME,
    sections: [{
      id: 'section-1', title: 'Physics', createdAt: TIME, updatedAt: TIME,
      pages: [{ id: 'page-1', title: 'Vectors', mode: 'a4', createdAt: TIME, updatedAt: TIME, elements: [] }],
    }],
  }],
  trash: [],
  activeNotebookId: 'notebook-1',
  activeSectionId: 'section-1',
  activePageId: 'page-1',
};
const stored = [{ documentId: 'page:a' }] as unknown as StoredDocumentV2[];
let migration: MigrationResultV2;
beforeAll(async () => {
  migration = await prepareV1ToV2Migration(workspace);
});

describe('AutomergeTaskWorker', () => {
  it('returns what the worker answers, and answers several jobs by their ids', async () => {
    const fake = new FakeWorker((request) => ({ id: request.id, ok: true, result: request.task }));
    const worker = new AutomergeTaskWorker(() => fake as unknown as Worker);
    const [first, second] = await Promise.all([
      worker.run({ task: 'materialize', migration }),
      worker.run({ task: 'stage', documents: [] }),
    ]);
    expect(first).toBe('materialize');
    expect(second).toBe('stage');
    worker.dispose();
  });

  it('rejects with the job\'s own error, name included, and keeps working afterwards', async () => {
    const fake = new FakeWorker((request) => request.task === 'stage'
      ? { id: request.id, ok: false, name: 'RangeError', message: 'Staged document changed identity.' }
      : { id: request.id, ok: true, result: 'fine' });
    const worker = new AutomergeTaskWorker(() => fake as unknown as Worker);
    await expect(worker.run({ task: 'stage', documents: [] })).rejects.toMatchObject({
      name: 'RangeError',
      message: 'Staged document changed identity.',
    });
    await expect(worker.run({ task: 'materialize', migration })).resolves.toBe('fine');
    worker.dispose();
  });

  it('reports a worker that cannot start or dies as unavailable', async () => {
    const dying = new FakeWorker(() => undefined);
    const worker = new AutomergeTaskWorker(() => dying as unknown as Worker);
    const waiting = worker.run({ task: 'materialize', migration });
    dying.crash('out of memory');
    await expect(waiting).rejects.toBeInstanceOf(AutomergeWorkerUnavailableError);
    // Later jobs do not try the broken worker again.
    await expect(worker.run({ task: 'materialize', migration })).rejects.toBeInstanceOf(AutomergeWorkerUnavailableError);

    const unstartable = new AutomergeTaskWorker(() => { throw new Error('no workers here'); });
    await expect(unstartable.run({ task: 'materialize', migration })).rejects.toBeInstanceOf(AutomergeWorkerUnavailableError);
  });

  it('stops an idle worker so its WebAssembly memory is released', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeWorker((request) => ({ id: request.id, ok: true, result: 1 }));
      const worker = new AutomergeTaskWorker(() => fake as unknown as Worker, 1_000);
      const done = worker.run({ task: 'materialize', migration });
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(fake.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(fake.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runInWorkerOrHere', () => {
  it('does the job on the main thread only when the worker cannot run it at all', async () => {
    const here = vi.fn(async () => stored);
    const unavailable = new AutomergeTaskWorker(() => { throw new Error('no workers here'); });
    await expect(runInWorkerOrHere(unavailable, { task: 'materialize', migration }, here)).resolves.toBe(stored);
    await expect(runInWorkerOrHere(undefined, { task: 'materialize', migration }, here)).resolves.toBe(stored);
    expect(here).toHaveBeenCalledTimes(2);

    // A job that fails in the worker fails; the main thread would fail the same way.
    const failing = new FakeWorker((request) => ({ id: request.id, ok: false, name: 'Error', message: 'Migration contains duplicate assets.' }));
    const worker = new AutomergeTaskWorker(() => failing as unknown as Worker);
    await expect(runInWorkerOrHere(worker, { task: 'materialize', migration }, here)).rejects.toThrow('duplicate assets');
    expect(here).toHaveBeenCalledTimes(2);
    worker.dispose();
  });

  it('materializes through the worker without the asset bytes, and falls back to the given materializer without one', async () => {
    const fallback = { materialize: vi.fn(async () => stored) };
    await expect(new WorkerAutomergeMigrationMaterializer(undefined, fallback).materialize(migration)).resolves.toBe(stored);
    expect(fallback.materialize).toHaveBeenCalledOnce();

    const fake = new FakeWorker((request) => ({ id: request.id, ok: true, result: stored }));
    const worker = new AutomergeTaskWorker(() => fake as unknown as Worker);
    const withAsset: MigrationResultV2 = {
      ...migration,
      assets: [{ assetId: 'sha256:x', checksum: 'sha256:x', size: 1, bytes: new Uint8Array(1) }] as unknown as MigrationResultV2['assets'],
    };
    // Verified on the main thread first, where the asset bytes are: this one does not verify.
    await expect(new WorkerAutomergeMigrationMaterializer(worker, fallback).materialize(withAsset)).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);

    await expect(new WorkerAutomergeMigrationMaterializer(worker, fallback).materialize(migration)).resolves.toBe(stored);
    expect(fallback.materialize).toHaveBeenCalledOnce();
    const request = fake.requests[0];
    expect(request?.task).toBe('materialize');
    expect(request?.task === 'materialize' && request.migration.assets).toEqual([]);
    worker.dispose();
  });
});
