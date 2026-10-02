import { materializeMigrationAsAutomerge } from '../crdt/migration';
import type { MigrationResultV2, StoredDocumentV2 } from '../domain/v2/types';
import type { StoredCanvinkDocument } from '../domain/v3';
import {
  InMemoryAutomergeRepoMigrationAdapter,
  stageSchemaV3Upgrade,
  type ActivatedDocumentV2,
  type ReopenedRepoDocument,
  type RepoChunkV2,
  type StagedRepoWorkspace,
} from './v2WorkspaceStorage';

/**
 * Whole-workspace Automerge jobs of the first start and of schema upgrades. Each takes plain data
 * and returns plain data, so it runs in a worker (see automergeTask.worker.ts) and the interface
 * keeps its turns, or on the main thread where workers do not exist (see automergeTaskClient.ts).
 */
export type AutomergeTaskRequest =
  /** The migration without its asset bytes, which the caller verified: they are of no use here and large to copy. */
  | { task: 'materialize'; migration: MigrationResultV2 }
  | { task: 'stage'; documents: StoredCanvinkDocument[] }
  | { task: 'reopen'; chunks: RepoChunkV2[]; documents: ActivatedDocumentV2[] }
  | { task: 'upgradeSchemaV3'; chunks: RepoChunkV2[]; documents: ActivatedDocumentV2[] };

export interface AutomergeTaskResults {
  materialize: StoredDocumentV2[];
  stage: StagedRepoWorkspace;
  reopen: ReopenedRepoDocument[];
  upgradeSchemaV3: StagedRepoWorkspace;
}

export type AutomergeTaskResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; name: string; message: string; unavailable?: true };

export async function runAutomergeTask(request: AutomergeTaskRequest): Promise<AutomergeTaskResults[AutomergeTaskRequest['task']]> {
  const adapter = new InMemoryAutomergeRepoMigrationAdapter();
  switch (request.task) {
    case 'materialize':
      return (await materializeMigrationAsAutomerge(request.migration, { alreadyVerified: true })).documents;
    case 'stage':
      return adapter.stage(request.documents);
    case 'reopen':
      return adapter.reopen(request.chunks, request.documents);
    case 'upgradeSchemaV3':
      return stageSchemaV3Upgrade(request.chunks, request.documents);
  }
}
