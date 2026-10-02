import { readSavedDocumentHeads } from '../crdt/documentHeads';
import type { AdoptionPrepRequest, AdoptionPrepResponse, PreparedAdoption } from './adoptionPrepCore';
import { sameHeadSet, type PageSummary } from './pageIndex';

export type { PreparedAdoption } from './adoptionPrepCore';

/** A worker that stays idle this long is stopped: Automerge's WebAssembly memory only grows. */
const IDLE_STOP_MS = 5_000;
const MAX_WORKERS = 4;
/**
 * A job that gets no answer this long is given up: the commit that waits for it holds the
 * workspace's mutation queue, so a worker that never answers (an out-of-memory crash the
 * page is not told about) must not hold every later save and commit with it.
 */
const JOB_TIMEOUT_MS = 30_000;

export interface AdoptionPrepInput {
  documentId: string;
  kind: 'notebook' | 'page';
  bytes: Uint8Array;
  /**
   * The summary the account published for this page. When the bytes are one
   * complete save with exactly the summary's heads, the summary is used as it
   * is and the page is neither loaded nor validated here: loading every page
   * of a large account is what made a fresh device wait, and the page is
   * validated when it is opened.
   */
  expectedSummary?: PageSummary;
}

/** The preparation a published summary makes unnecessary, or undefined when the bytes do not match it. */
export function prepareFromPublishedSummary(document: AdoptionPrepInput): PreparedAdoption | undefined {
  if (document.kind !== 'page' || !document.expectedSummary) return undefined;
  const heads = readSavedDocumentHeads(document.bytes);
  if (!heads || !sameHeadSet(heads, document.expectedSummary.heads)) return undefined;
  return { heads, summary: document.expectedSummary };
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

interface Job {
  request: AdoptionPrepRequest;
  resolve: (prepared: PreparedAdoption | undefined) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Prepares adopted documents in a small pool of workers, so that adopting a
 * large notebook neither blocks the interface nor runs on one core. The bytes
 * are copied, since the caller still needs them for the commit. Where workers
 * do not exist or one fails, the affected documents resolve to `undefined`
 * and the commit prepares them itself, which also reports a bad document the
 * way it always did.
 */
export class AdoptionPreparer {
  private workers: PoolWorker[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private broken = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly inFlight = new Map<number, Job>();

  constructor(
    private readonly createWorker: () => Worker,
    private readonly maxWorkers = MAX_WORKERS,
    private readonly jobTimeoutMs = JOB_TIMEOUT_MS,
  ) {}

  /** Prepares one document; resolves to `undefined` when it could not be prepared in a worker. */
  prepareOne(document: AdoptionPrepInput, schemaVersion: 2 | 3): Promise<PreparedAdoption | undefined> {
    if (this.broken) return Promise.resolve(undefined);
    clearTimeout(this.idleTimer);
    return new Promise((resolve) => {
      const id = this.nextId;
      this.nextId += 1;
      this.queue.push({
        request: { id, documentId: document.documentId, kind: document.kind, schemaVersion, bytes: document.bytes },
        resolve,
      });
      this.pump();
    });
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    for (const { worker } of this.workers) worker.terminate();
    this.workers = [];
    this.failAll();
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const slot = this.workers.find((candidate) => !candidate.busy) ?? this.spawn();
      if (!slot) {
        if (this.workers.length === 0) this.failAll();
        return;
      }
      const job = this.queue.shift() as Job;
      slot.busy = true;
      this.inFlight.set(job.request.id, job);
      job.timer = setTimeout(() => this.abandon(slot, job), this.jobTimeoutMs);
      slot.worker.postMessage(job.request);
    }
  }

  private spawn(): PoolWorker | undefined {
    if (this.broken || this.workers.length >= this.maxWorkers) return undefined;
    try {
      const worker = this.createWorker();
      const slot: PoolWorker = { worker, busy: false };
      worker.onmessage = (event: MessageEvent<AdoptionPrepResponse>) => {
        const response = event.data;
        const job = this.inFlight.get(response.id);
        if (!job) return;
        clearTimeout(job.timer);
        this.inFlight.delete(response.id);
        slot.busy = false;
        job.resolve(response.ok ? response.prepared : undefined);
        this.pump();
        if (this.queue.length === 0 && this.inFlight.size === 0) this.scheduleIdleStop();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        this.broken = true;
        this.dispose();
      };
      this.workers.push(slot);
      return slot;
    } catch {
      this.broken = true;
      return undefined;
    }
  }

  /** The worker did not answer in time: its document is prepared by the commit instead, and the worker is replaced. */
  private abandon(slot: PoolWorker, job: Job): void {
    if (!this.inFlight.delete(job.request.id)) return;
    job.resolve(undefined);
    slot.worker.terminate();
    this.workers = this.workers.filter((candidate) => candidate !== slot);
    this.pump();
  }

  private scheduleIdleStop(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.queue.length > 0 || this.inFlight.size > 0) return;
      for (const { worker } of this.workers) worker.terminate();
      this.workers = [];
    }, IDLE_STOP_MS);
  }

  private failAll(): void {
    const waiting = [...this.queue, ...this.inFlight.values()];
    for (const job of waiting) clearTimeout(job.timer);
    this.queue = [];
    this.inFlight.clear();
    for (const job of waiting) job.resolve(undefined);
  }
}

let shared: AdoptionPreparer | undefined;

function sharedPreparer(): AdoptionPreparer | undefined {
  if (typeof Worker === 'undefined') return undefined;
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  shared ??= new AdoptionPreparer(
    () => new Worker(new URL('./adoptionPrep.worker.ts', import.meta.url), { type: 'module', name: 'canvink-adoption' }),
    Math.max(1, Math.min(MAX_WORKERS, cores - 1)),
  );
  return shared;
}

/** Preparations already started, by the very bytes they were started for. */
const started = new WeakMap<Uint8Array, Promise<PreparedAdoption | undefined>>();

/**
 * Starts preparing a document as soon as its bytes arrive, so that a large
 * account is mostly prepared by the time its download ends and the commit
 * finds the result waiting. `prepareAdoptedDocuments` picks it up by identity
 * of the bytes.
 */
export function prewarmAdoptedDocument(document: AdoptionPrepInput, schemaVersion: 2 | 3): void {
  const preparer = sharedPreparer();
  if (!preparer || started.has(document.bytes) || prepareFromPublishedSummary(document)) return;
  started.set(document.bytes, preparer.prepareOne(document, schemaVersion));
}

/**
 * What an adopted document holds (a page's summary, a notebook's snapshot), read without loading it
 * on the main thread: from the published summary or a worker, sharing the result with the
 * preparation the commit will look for. Undefined where no worker could do it, and the caller reads
 * the bytes itself then.
 */
export async function previewAdoptedDocument(
  document: AdoptionPrepInput,
  schemaVersion: 2 | 3,
): Promise<PreparedAdoption | undefined> {
  const published = prepareFromPublishedSummary(document);
  if (published) return published;
  const preparer = sharedPreparer();
  if (!preparer) return undefined;
  let pending = started.get(document.bytes);
  if (!pending) {
    pending = preparer.prepareOne(document, schemaVersion);
    started.set(document.bytes, pending);
  }
  const prepared = await pending;
  if (!prepared) started.delete(document.bytes);
  return prepared;
}

/** Prepares adopted documents in workers; documents that could not be prepared there are left out of the map. */
export async function prepareAdoptedDocuments(
  documents: readonly AdoptionPrepInput[],
  schemaVersion: 2 | 3,
): Promise<Map<string, PreparedAdoption>> {
  const results = new Map<string, PreparedAdoption>();
  const remaining: AdoptionPrepInput[] = [];
  for (const document of documents) {
    const published = prepareFromPublishedSummary(document);
    if (published) results.set(document.documentId, published);
    else remaining.push(document);
  }
  const preparer = sharedPreparer();
  if (!preparer || remaining.length === 0) return results;
  // Largest first keeps the pool busy to the end instead of ending on one big page.
  const ordered = [...remaining].sort((left, right) => right.bytes.byteLength - left.bytes.byteLength);
  await Promise.all(ordered.map(async (document) => {
    let pending = started.get(document.bytes);
    if (!pending) {
      pending = preparer.prepareOne(document, schemaVersion);
      started.set(document.bytes, pending);
    }
    const prepared = await pending;
    if (prepared) results.set(document.documentId, prepared);
    else started.delete(document.bytes);
  }));
  return results;
}
