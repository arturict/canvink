/**
 * Moves documents of a shared notebook into the workspace.
 *
 * A joined notebook is not a copy: its documents are adopted with their whole
 * Automerge history (`adoptedDocuments` of a topology transaction), so the
 * workspace copy and the room copy share ancestry and later merge without
 * duplicating anything. Both directions use the same transaction: a link
 * opened for the first time adopts the notebook and its pages, and a page a
 * collaborator adds later is adopted when the room announces it.
 */

import * as Automerge from '@automerge/automerge';
import { openRoomSession, type DocKind, type Role } from '../../collab';
import type { V2RuntimeState, WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';

/** The documents of a shared notebook as the room holds them. */
export interface SharedNotebookDocuments {
  roomId: string;
  /** What the room let this account in as; a link only ever makes a reader. */
  role: Role;
  notebookDocumentId: string;
  notebookId: string;
  title: string;
  /** Page document ids in notebook order, every one of them present in `documents`. */
  pageDocumentIds: string[];
  documents: Array<{ documentId: string; kind: 'notebook' | 'page'; bytes: Uint8Array }>;
}

export class JoinRoomError extends Error {
  constructor(readonly reason: 'unauthorized' | 'incomplete' | 'closed' | 'conflict', message: string) {
    super(message);
    this.name = 'JoinRoomError';
  }
}

interface NotebookShape {
  documentId?: unknown;
  notebookId?: unknown;
  title?: unknown;
  sections?: Array<{ pageDocumentIds?: unknown }>;
}

function readNotebook(bytes: Uint8Array): { documentId: string; notebookId: string; title: string; pageDocumentIds: string[] } | undefined {
  const doc = Automerge.load<NotebookShape>(bytes);
  try {
    const plain = Automerge.toJS(doc) as NotebookShape;
    if (typeof plain.documentId !== 'string' || typeof plain.notebookId !== 'string') return undefined;
    const pageDocumentIds = (plain.sections ?? []).flatMap((section) => (
      Array.isArray(section.pageDocumentIds) ? section.pageDocumentIds.filter((id): id is string => typeof id === 'string') : []
    ));
    return {
      documentId: plain.documentId,
      notebookId: plain.notebookId,
      title: typeof plain.title === 'string' ? plain.title : '',
      pageDocumentIds,
    };
  } finally {
    Automerge.free(doc);
  }
}

export interface FetchSharedNotebookOptions {
  syncUrl: string;
  roomId: string;
  /** Absent when the account was invited by name: the room lets it in by its verified address. */
  linkSecret?: string;
  /** A fresh account token for every connection attempt. */
  getToken: () => Promise<string | null>;
  /** How long the room may take to hand over a complete notebook. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Connects to the room with the account, and the link if there is one (which
 * registers the account as a reader), and resolves once the notebook and every
 * page it lists have arrived. The connection is closed again; the long-lived binding
 * belongs to `useSharedNotebookSync`.
 */
export function fetchSharedNotebook(options: FetchSharedNotebookOptions): Promise<SharedNotebookDocuments> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(() => reject(new JoinRoomError('incomplete', 'The shared notebook did not arrive completely.'))),
      options.timeoutMs ?? 45_000,
    );
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      session.close();
      outcome();
    };
    const onAbort = (): void => finish(() => reject(new JoinRoomError('closed', 'The join was cancelled.')));
    const session = openRoomSession({
      syncUrl: options.syncUrl,
      roomId: options.roomId,
      auth: { kind: 'user', jwt: '', ...(options.linkSecret ? { linkSecret: options.linkSecret } : {}) },
      getAuth: async () => {
        const jwt = await options.getToken();
        if (!jwt) throw new JoinRoomError('unauthorized', 'Signed out.');
        return { kind: 'user', jwt, ...(options.linkSecret ? { linkSecret: options.linkSecret } : {}) };
      },
      docStorage: 'bytes',
      callbacks: {
        onStatus: (status) => {
          if (status === 'live') check();
          else if (status === 'closed' || status === 'error') {
            finish(() => reject(new JoinRoomError('closed', 'The room closed the connection.')));
          }
        },
        onError: (error) => {
          if (error.code === 'unauthorized') {
            finish(() => reject(new JoinRoomError('unauthorized', error.detail ?? 'The room refused this account.')));
          }
        },
      },
    });

    const check = (): void => {
      if (settled || session.getStatus() !== 'live') return;
      const entries = [...session.getDocs()];
      const notebookEntry = entries.find(([, entry]) => entry.kind === 'notebook');
      const notebookBytes = notebookEntry ? session.getDocBytes(notebookEntry[0]) : undefined;
      if (!notebookEntry || !notebookBytes) return;
      const notebook = readNotebook(notebookBytes);
      if (!notebook) return;
      const documents: SharedNotebookDocuments['documents'] = [
        { documentId: notebookEntry[0], kind: 'notebook', bytes: notebookBytes },
      ];
      for (const pageDocumentId of notebook.pageDocumentIds) {
        const bytes = session.getDocBytes(pageDocumentId);
        if (!bytes) return;
        documents.push({ documentId: pageDocumentId, kind: 'page', bytes });
      }
      finish(() => resolve({
        roomId: options.roomId,
        role: session.getRole() ?? 'viewer',
        notebookDocumentId: notebookEntry[0],
        notebookId: notebook.notebookId,
        title: notebook.title,
        pageDocumentIds: notebook.pageDocumentIds,
        documents,
      }));
    };
    session.subscribeDocsChanged(check);
    session.subscribeSynced(check);
    options.signal?.addEventListener('abort', onAbort);
  });
}

function schemaState(runtime: WorkspaceV2Runtime): V2RuntimeState {
  const state = runtime.getState();
  if (state.schemaVersion === 1) throw new Error('Sharing requires the schema-v2/v3 workspace.');
  return state;
}

/**
 * Lists the notebook and its pages in the workspace, with their history.
 * Resolves to the notebook id; a notebook the workspace already has is left
 * as it is (the room merges into it once it is bound).
 */
export async function adoptSharedNotebook(
  runtime: WorkspaceV2Runtime,
  shared: SharedNotebookDocuments,
): Promise<{ notebookId: string; added: boolean }> {
  const state = await runtime.ensureSchemaV3();
  const known = new Set(state.activation.manifest.notebookDocumentIds as readonly string[]);
  if (known.has(shared.notebookDocumentId)) return { notebookId: shared.notebookId, added: false };
  const knownPages = new Set(state.activation.manifest.pageDocumentIds as readonly string[]);
  // A page id the workspace already holds, in another notebook, is a different document with an
  // unrelated history (installs before 2026-09-25 all shared one start page id). Merging the two
  // would duplicate content, so the notebook is not added.
  if (shared.pageDocumentIds.some((documentId) => knownPages.has(documentId))) {
    throw new JoinRoomError('conflict', 'The workspace already holds a different page under the id of a page of this notebook.');
  }
  const fresh = shared.documents;
  await runtime.commitWorkspaceGraphRevision({
    operationId: `join:${shared.roomId}`,
    expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
    onConflict: 'rebase',
    message: `Join shared notebook ${shared.title}`,
    // Pages first, so the notebook never lists a page the workspace does not hold yet.
    adoptedDocuments: [
      ...fresh.filter((document) => document.kind === 'page'),
      ...fresh.filter((document) => document.kind === 'notebook'),
    ],
    updateManifest: (manifest) => {
      manifest.notebookDocumentIds = [...manifest.notebookDocumentIds, shared.notebookDocumentId];
      manifest.pageDocumentIds = [
        ...manifest.pageDocumentIds,
        ...fresh.filter((document) => document.kind === 'page').map((document) => document.documentId),
      ];
    },
  });
  return { notebookId: shared.notebookId, added: true };
}

/** How long a page that is not listed by the notebook yet may wait for the notebook's update. */
const NOTEBOOK_LISTING_WAIT_MS = 20_000;

function listsPage(runtime: WorkspaceV2Runtime, notebookId: string, documentId: string): boolean {
  const state = runtime.getState();
  if (state.schemaVersion === 1) return false;
  return state.notebooks.some((notebook) => notebook.notebookId === notebookId
    && notebook.sections.some((section) => section.pageDocumentIds.includes(documentId)));
}

function waitUntilListed(runtime: WorkspaceV2Runtime, notebookId: string, documentId: string): Promise<boolean> {
  if (listsPage(runtime, notebookId, documentId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, NOTEBOOK_LISTING_WAIT_MS);
    unsubscribe = runtime.subscribeToState(() => {
      if (!listsPage(runtime, notebookId, documentId)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/**
 * A collaborator added a page: adopts its document into the workspace so the
 * notebook that lists it shows it. Documents that are not pages of this
 * notebook are ignored (the room only holds this notebook).
 */
export async function adoptRemotePage(
  runtime: WorkspaceV2Runtime,
  notebookId: string,
  documentId: string,
  kind: DocKind,
  bytes: Uint8Array,
): Promise<void> {
  if (kind !== 'page') return;
  const state = schemaState(runtime);
  if ((state.activation.manifest.pageDocumentIds as readonly string[]).includes(documentId)) return;
  const document = Automerge.load<{ notebookId?: unknown; kind?: unknown }>(bytes);
  const belongs = (() => {
    try {
      const plain = Automerge.toJS(document);
      return plain.kind === 'page' && plain.notebookId === notebookId;
    } finally {
      Automerge.free(document);
    }
  })();
  if (!belongs) return;
  // A page whose notebook update has not arrived yet waits for it: the manifest must only list pages some section lists.
  if (!await waitUntilListed(runtime, notebookId, documentId)) return;
  const current = schemaState(runtime);
  if ((current.activation.manifest.pageDocumentIds as readonly string[]).includes(documentId)) return;
  await runtime.commitWorkspaceGraphRevision({
    operationId: `collab-page:${notebookId}:${documentId}:${Date.now().toString(36)}`,
    expectedActivationArtifactFingerprint: current.activation.artifactFingerprint,
    onConflict: 'rebase',
    message: 'Adopt page from shared notebook',
    adoptedDocuments: [{ documentId, kind: 'page', bytes }],
    updateManifest: (manifest) => {
      if (manifest.pageDocumentIds.includes(documentId)) return;
      manifest.pageDocumentIds = [...manifest.pageDocumentIds, documentId];
    },
  });
}
