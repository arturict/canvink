import type { AssetBlob, Sha256Checksum } from '../../domain/v2';
import type { NotebookDocV3, PageDocV3 } from '../../domain/v3';
import type {
  OneNoteApplyBeginRequest,
  OneNoteApplyCommitResult,
  OneNoteApplyTarget,
  OneNoteApplyTargetSnapshot,
  OneNoteApplyWriter,
} from './types';

/**
 * An in-memory apply target for tests: it keeps what the apply path writes
 * and follows the runtime's receipt rules (a replay with the same import ID
 * and artifact is reported as already committed).
 */
export class MemoryOneNoteApplyTarget implements OneNoteApplyTarget {
  snapshot: OneNoteApplyTargetSnapshot;
  receipt?: OneNoteApplyCommitResult;
  private receiptFingerprint?: Sha256Checksum;
  notebook?: NotebookDocV3;
  pages: PageDocV3[] = [];
  assets: AssetBlob[] = [];
  aborted = 0;
  verifyFailure = false;
  rollbackCalls = 0;
  rollbackStatus: 'rolled-back' | 'already-rolled-back' = 'rolled-back';

  constructor(
    activationArtifactFingerprint: Sha256Checksum = `sha256:${'1'.repeat(64)}`,
    existing: { notebookDocumentIds?: string[]; pageDocumentIds?: string[] } = {},
  ) {
    this.snapshot = {
      schemaVersion: 3,
      activationArtifactFingerprint,
      notebookDocumentIds: existing.notebookDocumentIds ?? [],
      pageDocumentIds: existing.pageDocumentIds ?? [],
    };
  }

  async inspect(): Promise<OneNoteApplyTargetSnapshot> {
    return structuredClone(this.snapshot);
  }

  async begin(request: OneNoteApplyBeginRequest): Promise<OneNoteApplyWriter> {
    if (this.snapshot.notebookDocumentIds.includes(request.notebook.documentId)) {
      throw new Error('Imported document IDs collide with the active workspace.');
    }
    const listed = new Set(request.notebook.sections.flatMap((section) => section.pageDocumentIds));
    const pages: PageDocV3[] = [];
    const assets: AssetBlob[] = [];
    let stagedBytes = 0;
    return {
      addAssets: async (added) => {
        assets.push(...added);
        stagedBytes += added.reduce((sum, asset) => sum + asset.size, 0);
      },
      addPage: async (page) => {
        if (!listed.has(page.documentId)) throw new Error(`Page ${page.documentId} is not listed in the notebook.`);
        pages.push(structuredClone(page));
        stagedBytes += 100;
      },
      progress: () => ({ pages: pages.length, assets: assets.length, stagedBytes }),
      commit: async (fingerprint) => {
        if (this.receipt?.importId === request.importId) {
          if (this.receiptFingerprint !== fingerprint) {
            throw new Error(`Import ID ${request.importId} was already used for another artifact.`);
          }
          return { ...structuredClone(this.receipt), status: 'already-committed' };
        }
        if (pages.length !== listed.size) throw new Error('Every listed page must be written before commit.');
        this.notebook = structuredClone(request.notebook);
        this.pages = pages;
        this.assets = assets;
        this.receiptFingerprint = fingerprint;
        this.receipt = {
          status: 'committed',
          importId: request.importId,
          artifactFingerprint: `sha256:${'2'.repeat(64)}`,
          backupId: `import-backup:${request.importId}`,
          notebookDocumentId: request.notebook.documentId,
          pageDocumentIds: pages.map((page) => page.documentId),
          assetIds: assets.map((asset) => asset.assetId),
        };
        return structuredClone(this.receipt);
      },
      abort: async () => {
        this.aborted += 1;
      },
    };
  }

  async verify(result: OneNoteApplyCommitResult): Promise<void> {
    if (this.verifyFailure) throw new Error('reopen failed');
    if (result.notebookDocumentId !== this.receipt?.notebookDocumentId) throw new Error('unknown import');
  }

  async rollback(): Promise<'rolled-back' | 'already-rolled-back'> {
    this.rollbackCalls += 1;
    return this.rollbackStatus;
  }
}
