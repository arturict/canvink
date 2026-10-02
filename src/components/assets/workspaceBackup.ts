import { StoredZipBlobWriter } from '../../io';
import type { V2RuntimeState, WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { exportNotebookBundle } from './bundleWorkspace';

export const WORKSPACE_BACKUP_FORMAT = 'canvink-workspace-backup' as const;

export interface WorkspaceBackupIndex {
  format: typeof WORKSPACE_BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  notebooks: Array<{
    documentId: string;
    title: string;
    trashed: boolean;
    pages: number;
    /** A `.canvink` bundle inside the backup; each imports on its own. */
    file: string;
  }>;
}

/**
 * Backs up the whole workspace as one ZIP: an index plus one `.canvink`
 * bundle per notebook (trashed notebooks included). Bundles are written page
 * by page into Blob storage, so the backup needs memory for one page at a
 * time, whatever the size of the workspace.
 */
export async function exportWorkspaceBackup(
  runtime: WorkspaceV2Runtime,
  state: V2RuntimeState,
  options: { onProgress?: (done: number, total: number) => void } = {},
): Promise<Blob> {
  const trashed = new Set(state.activation.manifest.trash.flatMap((entry) =>
    entry.kind === 'notebook' && entry.notebookDocumentId ? [entry.notebookDocumentId] : []));
  const notebooks = state.activation.manifest.notebookDocumentIds.flatMap((documentId) => {
    const notebook = state.notebooks.find((candidate) => candidate.documentId === documentId);
    return notebook ? [notebook] : [];
  });
  const total = notebooks.reduce(
    (sum, notebook) => sum + notebook.sections.reduce((count, section) => count + section.pageDocumentIds.length, 0),
    0,
  );
  const index: WorkspaceBackupIndex = {
    format: WORKSPACE_BACKUP_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    notebooks: notebooks.map((notebook, position) => ({
      documentId: notebook.documentId,
      title: notebook.title,
      trashed: trashed.has(notebook.documentId),
      pages: notebook.sections.reduce((count, section) => count + section.pageDocumentIds.length, 0),
      file: `notebooks/${String(position + 1).padStart(4, '0')}.canvink`,
    })),
  };
  const zip = new StoredZipBlobWriter();
  zip.push(zip.add('workspace.json', new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`)));
  let done = 0;
  for (const [position, notebook] of notebooks.entries()) {
    const bundle = await exportNotebookBundle(runtime, state, notebook.notebookId, {
      onProgress: (pages) => options.onProgress?.(done + pages, total),
    });
    done += index.notebooks[position].pages;
    zip.push(await zip.addBlob(index.notebooks[position].file, bundle));
  }
  return zip.finish();
}
