import { verifyMigrationResult } from '../domain/v2/migration';
import type { MigrationResultV2, StoredDocumentV2 } from '../domain/v2/types';
import type { StoredCanvinkDocument } from '../domain/v3';
import type { AutomergeTaskRequest, AutomergeTaskResponse, AutomergeTaskResults } from './automergeTaskCore';
import {
  DefaultAutomergeMigrationMaterializer,
  InMemoryAutomergeRepoMigrationAdapter,
  stageSchemaV3Upgrade,
  type ActivatedDocumentV2,
  type AutomergeMigrationMaterializer,
  type AutomergeRepoMigrationAdapter,
  type ReopenedRepoDocument,
  type RepoChunkV2,
  type StagedRepoWorkspace,
} from './v2WorkspaceStorage';

/** The worker is stopped after this long without a job: Automerge's WebAssembly memory only grows. */
const IDLE_STOP_MS = 5_000;

/** The worker could not run the job at all (no workers, it failed to start or died); the main thread can still do it. */
export class AutomergeWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomergeWorkerUnavailableError';
  }
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * One worker for the whole-workspace Automerge jobs of the first start and of schema upgrades
 * (see automergeTaskCore.ts). A job that fails inside the worker rejects with that job's own error,
 * as it would on the main thread; a worker that cannot run at all rejects with
 * `AutomergeWorkerUnavailableError`, and `runInWorkerOrHere` then does the job on the main thread.
 */
export class AutomergeTaskWorker {
  private worker?: Worker;
  private broken = false;
  private nextId = 1;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly createWorker: () => Worker, private readonly idleMs = IDLE_STOP_MS) {}

  run<K extends AutomergeTaskRequest['task']>(request: Extract<AutomergeTaskRequest, { task: K }>): Promise<AutomergeTaskResults[K]> {
    clearTimeout(this.idleTimer);
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new AutomergeWorkerUnavailableError('The Automerge task worker is not available.'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      worker.postMessage({ ...request, id });
    });
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = undefined;
    this.failAll(new AutomergeWorkerUnavailableError('The Automerge task worker was stopped.'));
  }

  private ensureWorker(): Worker | undefined {
    if (this.broken) return undefined;
    if (this.worker) return this.worker;
    try {
      const worker = this.createWorker();
      worker.onmessage = (event: MessageEvent<AutomergeTaskResponse>) => {
        const response = event.data;
        const waiting = this.pending.get(response.id);
        if (!waiting) return;
        this.pending.delete(response.id);
        if (response.ok) {
          waiting.resolve(response.result);
        } else if (response.unavailable) {
          this.broken = true;
          waiting.reject(new AutomergeWorkerUnavailableError(response.message));
        } else {
          const error = new Error(response.message);
          error.name = response.name;
          waiting.reject(error);
        }
        if (this.pending.size === 0) this.scheduleIdleStop(worker);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        this.broken = true;
        this.worker?.terminate();
        this.worker = undefined;
        this.failAll(new AutomergeWorkerUnavailableError(`The Automerge task worker failed: ${event.message}`));
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

let shared: AutomergeTaskWorker | undefined;

/** The bundled worker, or undefined where workers do not exist (tests, old runtimes). */
export function sharedAutomergeTaskWorker(): AutomergeTaskWorker | undefined {
  if (typeof Worker === 'undefined') return undefined;
  shared ??= new AutomergeTaskWorker(() => new Worker(new URL('./automergeTask.worker.ts', import.meta.url), {
    type: 'module',
    name: 'canvink-automerge-tasks',
  }));
  return shared;
}

/** Runs a job in the worker; where the worker cannot run it at all, `here` does it on the main thread. */
export async function runInWorkerOrHere<K extends AutomergeTaskRequest['task']>(
  worker: AutomergeTaskWorker | undefined,
  request: Extract<AutomergeTaskRequest, { task: K }>,
  here: () => Promise<AutomergeTaskResults[K]>,
): Promise<AutomergeTaskResults[K]> {
  if (!worker) return here();
  try {
    return await worker.run(request);
  } catch (error) {
    if (error instanceof AutomergeWorkerUnavailableError) return here();
    throw error;
  }
}

/** Materializes a migration's documents in the worker. */
export class WorkerAutomergeMigrationMaterializer implements AutomergeMigrationMaterializer {
  constructor(
    private readonly worker: AutomergeTaskWorker | undefined = sharedAutomergeTaskWorker(),
    private readonly fallback: AutomergeMigrationMaterializer = new DefaultAutomergeMigrationMaterializer(),
  ) {}

  async materialize(migration: MigrationResultV2): Promise<StoredDocumentV2[]> {
    // Verified here, where the asset bytes are; the worker gets the documents without them.
    await verifyMigrationResult(migration);
    return runInWorkerOrHere(
      this.worker,
      { task: 'materialize', migration: { ...migration, assets: [] } },
      () => this.fallback.materialize(migration),
    );
  }
}

/** Stages and reopens a migration's Repo image in the worker. */
export class WorkerAutomergeRepoMigrationAdapter implements AutomergeRepoMigrationAdapter {
  constructor(
    private readonly worker: AutomergeTaskWorker | undefined = sharedAutomergeTaskWorker(),
    private readonly fallback: AutomergeRepoMigrationAdapter = new InMemoryAutomergeRepoMigrationAdapter(),
  ) {}

  stage(documents: StoredCanvinkDocument[]): Promise<StagedRepoWorkspace> {
    return runInWorkerOrHere(this.worker, { task: 'stage', documents }, () => this.fallback.stage(documents));
  }

  reopen(chunks: RepoChunkV2[], documents: ActivatedDocumentV2[]): Promise<ReopenedRepoDocument[]> {
    return runInWorkerOrHere(this.worker, { task: 'reopen', chunks, documents }, () => this.fallback.reopen(chunks, documents));
  }
}

/** Stages the schema v2 to v3 upgrade of a whole Repo image in the worker. */
export function stageSchemaV3UpgradeInWorker(
  chunks: RepoChunkV2[],
  documents: ActivatedDocumentV2[],
  worker: AutomergeTaskWorker | undefined = sharedAutomergeTaskWorker(),
): Promise<StagedRepoWorkspace> {
  return runInWorkerOrHere(worker, { task: 'upgradeSchemaV3', chunks, documents }, () => stageSchemaV3Upgrade(chunks, documents));
}
