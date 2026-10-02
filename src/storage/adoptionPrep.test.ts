import { describe, expect, it, vi } from 'vitest';
import * as Automerge from '@automerge/automerge';
import { createAutomergeDocument, saveAutomergeDocument } from '../crdt';
import type { PageDocV3 } from '../domain/v3';
import { AdoptionPreparer, prepareAdoptedDocuments, prepareFromPublishedSummary, previewAdoptedDocument } from './adoptionPrep';
import { summarizePage } from './pageIndex';
import type { AdoptionPrepRequest, PreparedAdoption } from './adoptionPrepCore';

/** A worker that answers each request after the given delay, recording how many ran at once. */
class FakeWorker {
  static active = 0;
  static peak = 0;
  static created = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor(private readonly fail: (request: AdoptionPrepRequest) => boolean = () => false) {
    FakeWorker.created += 1;
  }

  postMessage(request: AdoptionPrepRequest): void {
    FakeWorker.active += 1;
    FakeWorker.peak = Math.max(FakeWorker.peak, FakeWorker.active);
    setTimeout(() => {
      FakeWorker.active -= 1;
      const prepared: PreparedAdoption = { heads: [request.documentId] };
      this.onmessage?.({ data: this.fail(request) ? { id: request.id, ok: false, message: 'bad' } : { id: request.id, ok: true, prepared } } as MessageEvent);
    }, 5);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const input = (documentId: string, size: number) => ({ documentId, kind: 'page' as const, bytes: new Uint8Array(size) });

describe('AdoptionPreparer', () => {
  it('prepares documents across at most the allowed number of workers', async () => {
    FakeWorker.active = 0;
    FakeWorker.peak = 0;
    FakeWorker.created = 0;
    const preparer = new AdoptionPreparer(() => new FakeWorker() as unknown as Worker, 3);
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => preparer.prepareOne(input(id, 1), 3)));
    expect(results.map((result) => result?.heads[0])).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(FakeWorker.created).toBe(3);
    expect(FakeWorker.peak).toBe(3);
    preparer.dispose();
  });

  it('resolves a document the worker rejected to undefined, so the commit loads it itself', async () => {
    const preparer = new AdoptionPreparer(() => new FakeWorker((request) => request.documentId === 'broken') as unknown as Worker, 2);
    const [good, broken] = await Promise.all([preparer.prepareOne(input('good', 1), 3), preparer.prepareOne(input('broken', 1), 3)]);
    expect(good?.heads).toEqual(['good']);
    expect(broken).toBeUndefined();
    preparer.dispose();
  });

  it('gives up on every pending document when a worker cannot start', async () => {
    const preparer = new AdoptionPreparer(() => { throw new Error('no workers here'); }, 2);
    await expect(preparer.prepareOne(input('a', 1), 3)).resolves.toBeUndefined();
    await expect(preparer.prepareOne(input('b', 1), 3)).resolves.toBeUndefined();
  });
});

describe('AdoptionPreparer timeout', () => {
  /** A worker that never answers the requests it is given. */
  class SilentWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    postMessage(): void {}
    terminate(): void { this.terminated = true; }
  }

  it('gives up on a job the worker never answers, so the commit can prepare the document itself', async () => {
    vi.useFakeTimers();
    try {
      const workers: SilentWorker[] = [];
      const preparer = new AdoptionPreparer(() => {
        const worker = new SilentWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      }, 1, 1_000);
      const first = preparer.prepareOne(input('a', 1), 3);
      const second = preparer.prepareOne(input('b', 1), 3);
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(first).resolves.toBeUndefined();
      // The silent worker was replaced, and the queued document got its own turn (and its own timeout).
      expect(workers[0]?.terminated).toBe(true);
      expect(workers).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(second).resolves.toBeUndefined();
      preparer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('preparing from a published summary', () => {
  const page: PageDocV3 = {
    schemaVersion: 3, documentId: 'page:p', kind: 'page', notebookId: 'n', sectionId: 's', pageId: 'p', title: 'Published',
    tags: [], pageType: 'a4', background: { type: 'grid', color: '#ffffff' }, createdAt: 't', updatedAt: 't',
    elementsById: {}, zOrder: [], version: { protocol: 'uninitialized', heads: [] },
  };
  const bytes = saveAutomergeDocument(createAutomergeDocument(page));
  const heads = Automerge.getHeads(Automerge.load(bytes));

  it('uses the summary without loading the page when the bytes are one save with exactly its heads', () => {
    const expectedSummary = summarizePage(page, heads);
    const prepared = prepareFromPublishedSummary({ documentId: 'page:p', kind: 'page', bytes, expectedSummary });
    expect(prepared).toEqual({ heads, summary: expectedSummary });
  });

  it('does not trust a summary written for other heads, or for a notebook', () => {
    const stale = summarizePage(page, ['f'.repeat(64)]);
    expect(prepareFromPublishedSummary({ documentId: 'page:p', kind: 'page', bytes, expectedSummary: stale })).toBeUndefined();
    expect(prepareFromPublishedSummary({ documentId: 'notebook:n', kind: 'notebook', bytes, expectedSummary: summarizePage(page, heads) })).toBeUndefined();
    expect(prepareFromPublishedSummary({ documentId: 'page:p', kind: 'page', bytes })).toBeUndefined();
  });

  it('prepares a matching page without any worker', async () => {
    const expectedSummary = summarizePage(page, heads);
    const prepared = await prepareAdoptedDocuments([{ documentId: 'page:p', kind: 'page', bytes, expectedSummary }], 3);
    expect(prepared.get('page:p')?.summary).toEqual(expectedSummary);
  });

  it('previews a matching page from its summary, and leaves a page it cannot read here to the caller', async () => {
    const expectedSummary = summarizePage(page, heads);
    // Without workers (this test environment has none) only a published summary can answer.
    await expect(previewAdoptedDocument({ documentId: 'page:p', kind: 'page', bytes, expectedSummary }, 3))
      .resolves.toEqual({ heads, summary: expectedSummary });
    await expect(previewAdoptedDocument({ documentId: 'page:p', kind: 'page', bytes }, 3)).resolves.toBeUndefined();
  });
});
