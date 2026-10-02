import type { Sha256Checksum } from '../../domain/v2';
import type { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import type {
  OneNoteApplyBeginRequest,
  OneNoteApplyCommitResult,
  OneNoteApplyTarget,
  OneNoteApplyTargetSnapshot,
  OneNoteApplyWriter,
} from './types';

export class WorkspaceV2RuntimeOneNoteApplyTarget implements OneNoteApplyTarget {
  private committedSchemaVersion?: 3;

  constructor(private readonly runtime: WorkspaceV2Runtime) {}

  async inspect(): Promise<OneNoteApplyTargetSnapshot> {
    const state = await this.runtime.ensureSchemaV3();
    if (state.schemaVersion !== 3 || state.authoritative !== 'v3') {
      throw new Error('OneNote import requires an activated current workspace.');
    }
    return {
      schemaVersion: state.schemaVersion,
      activationArtifactFingerprint: state.activation.artifactFingerprint,
      notebookDocumentIds: state.activation.manifest.notebookDocumentIds.slice(),
      pageDocumentIds: state.activation.manifest.pageDocumentIds.slice(),
    };
  }

  async begin(request: OneNoteApplyBeginRequest): Promise<OneNoteApplyWriter> {
    const snapshot = await this.inspect();
    if (snapshot.notebookDocumentIds.includes(request.notebook.documentId)) {
      return this.replayWriter(request);
    }
    // No expected activation fingerprint: adding a new notebook cannot
    // conflict with edits made while a long import is being written.
    const writer = await this.runtime.beginAdditiveImport({
      importId: request.importId,
      preparedAt: request.preparedAt,
      notebook: request.notebook,
    });
    return {
      addAssets: (assets) => writer.addAssets(assets),
      addPage: (page) => writer.addPage(page),
      progress: () => writer.progress(),
      commit: async (fingerprint) => {
        const result = await writer.commit(fingerprint);
        this.committedSchemaVersion = request.notebook.schemaVersion;
        return result;
      },
      abort: () => writer.abort(),
    };
  }

  /**
   * The notebook already exists: this is a replay of an import whose commit
   * succeeded but whose acknowledgement was lost. The pages are converted as
   * usual (to recompute the artifact fingerprint) but nothing is written; the
   * commit resolves the stored import receipt, which reports an identical
   * artifact as already committed and rejects anything else.
   */
  private replayWriter(request: OneNoteApplyBeginRequest): OneNoteApplyWriter {
    let pages = 0;
    return {
      addAssets: async () => undefined,
      addPage: async () => {
        pages += 1;
      },
      progress: () => ({ pages, assets: 0, stagedBytes: 0 }),
      commit: async (fingerprint: Sha256Checksum): Promise<OneNoteApplyCommitResult> => {
        const result = await this.runtime.findCommittedImport(request.importId, fingerprint);
        if (!result) throw new Error('Imported document IDs collide with the active workspace.');
        this.committedSchemaVersion = request.notebook.schemaVersion;
        return result;
      },
      abort: async () => undefined,
    };
  }

  async verify(result: OneNoteApplyCommitResult): Promise<void> {
    const state = this.runtime.getState();
    if (
      this.committedSchemaVersion === undefined
      || state.schemaVersion !== this.committedSchemaVersion
      || state.authoritative !== 'v3'
    ) {
      throw new Error('The imported workspace did not reopen with its active schema.');
    }
    const notebookIds = new Set(state.activation.manifest.notebookDocumentIds);
    const pageIds = new Set(state.activation.manifest.pageDocumentIds);
    if (!notebookIds.has(result.notebookDocumentId)
      || result.pageDocumentIds.some((id) => !pageIds.has(id))) {
      throw new Error('The reopened workspace is missing imported document roots.');
    }
    // A replay reports the activation of the original commit, which later
    // commits may have superseded; a fresh commit must be the current one.
    if (result.status === 'committed' && state.activation.artifactFingerprint !== result.artifactFingerprint) {
      throw new Error('The reopened workspace does not match the committed import artifact.');
    }
    const assetIds = new Set(state.activation.assetIds);
    if (result.assetIds.some((id) => !assetIds.has(id))) {
      throw new Error('The reopened workspace is missing imported assets.');
    }
  }

  rollback(importId: string): Promise<'rolled-back' | 'already-rolled-back'> {
    return this.runtime.rollbackWorkspaceImport(importId);
  }
}

export function createWorkspaceV2RuntimeOneNoteApplyTarget(
  runtime: WorkspaceV2Runtime,
): OneNoteApplyTarget {
  return new WorkspaceV2RuntimeOneNoteApplyTarget(runtime);
}
