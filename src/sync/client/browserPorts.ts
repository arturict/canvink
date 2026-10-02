import type { DocHandle, DocHandleChangePayload } from '@automerge/automerge-repo';
import * as Automerge from '@automerge/automerge';
import { createStore, get, set } from 'idb-keyval';
import type { DocumentHeads } from '../types';
import { SyncClientError } from './errors';
import type { DurableSyncSnapshot, DurableSyncStatePort, SyncDocumentPort } from './types';

const SYNC_DATABASE = 'canvink-sync-client';
const SYNC_STORE = 'durable-state';

export interface BrowserSyncKeyValuePort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

class IndexedDbSyncKeyValue implements BrowserSyncKeyValuePort {
  private readonly store = createStore(SYNC_DATABASE, SYNC_STORE);
  get(key: string): Promise<unknown> { return get(key, this.store); }
  set(key: string, value: unknown): Promise<void> { return set(key, value, this.store); }
}

export class BrowserDurableSyncState implements DurableSyncStatePort {
  constructor(private readonly storage: BrowserSyncKeyValuePort = new IndexedDbSyncKeyValue()) {}

  async load(notebookId: string): Promise<DurableSyncSnapshot | undefined> {
    const value = await this.storage.get(snapshotKey(notebookId));
    if (value === undefined) return undefined;
    assertSnapshot(value, notebookId);
    return structuredClone(value);
  }

  async save(snapshot: DurableSyncSnapshot): Promise<void> {
    assertSnapshot(snapshot, snapshot.notebookId);
    await this.storage.set(snapshotKey(snapshot.notebookId), structuredClone(snapshot));
  }
}

/**
 * Browser private keys deliberately survive only this JavaScript session.
 * WebCrypto remains the crypto implementation, but no extractable wrapping key
 * is persisted in IndexedDB/localStorage where script compromise could reuse it.
 */
export class BrowserSessionSecretStore {
  readonly persistence = 'session-only' as const;
  readonly limitation = 'Private keys are lost when this browser session closes. Use an approved device or recovery code to reconnect.';
  private readonly values = new Map<string, Uint8Array>();

  constructor() {
    if (!globalThis.crypto?.subtle) throw new SyncClientError('key-epoch-unavailable', 'WebCrypto is unavailable in this browser.');
  }

  save(id: string, secret: Uint8Array): void {
    if (!id || !(secret instanceof Uint8Array) || secret.byteLength === 0) throw new SyncClientError('protocol-error', 'Browser secret is invalid.');
    const previous = this.values.get(id);
    previous?.fill(0);
    this.values.set(id, secret.slice());
    secret.fill(0);
  }

  load(id: string): Uint8Array | undefined {
    return this.values.get(id)?.slice();
  }

  clear(id?: string): void {
    if (id) {
      this.values.get(id)?.fill(0);
      this.values.delete(id);
      return;
    }
    for (const value of this.values.values()) value.fill(0);
    this.values.clear();
  }
}

interface RegisteredHandle {
  handle: DocHandle<object>;
  remoteDepth: number;
  unsubscribe(): void;
}

/** Source string of the encrypted sync's remote applies in the workspace change feed. */
export const ENCRYPTED_SYNC_SOURCE = 'encrypted-sync';

export interface SyncWorkspaceChangeEvent {
  documentId: string;
  beforeHeads: readonly string[];
  heads: readonly string[];
  origin: { kind: 'local' } | { kind: 'remote'; source: string } | { kind: 'topology' };
  /** The document after the change; valid only while the listener runs. */
  document?: Automerge.Doc<unknown>;
  added?: boolean;
}

/**
 * The workspace documents of one synchronized notebook, loaded or not (the
 * part of `WorkspaceV2Runtime` the bridge needs; tests fake it). Remote
 * changes for documents without a registered handle are merged here, and
 * local changes of such documents come from its change feed.
 */
export interface SyncWorkspaceDocumentsPort {
  /** Whether a workspace document belongs to the synchronized notebook. */
  includes(documentId: string): boolean;
  /** The notebook's documents (root and pages), without loading any. */
  listDocuments(): readonly string[];
  getDocumentHeads(documentId: string): readonly string[] | undefined;
  applyRemoteDocumentChanges(
    documentId: string,
    change: Uint8Array,
    options: { source: string },
  ): Promise<'applied' | 'unchanged' | 'rejected' | 'unknown'>;
  subscribeToDocumentChanges(listener: (event: SyncWorkspaceChangeEvent) => void): () => void;
}

/**
 * Connects Automerge Repo handles to the encrypted coordinator. The open page
 * is registered with its handle; with a workspace port, every other document
 * of the notebook syncs too: remote changes are merged through the runtime
 * (an unloaded page is loaded, updated, persisted and freed), and local
 * changes (a topology commit, a page edited while it is not the registered
 * one) are captured from the runtime's change feed.
 */
export class DocHandleSyncBridge implements SyncDocumentPort {
  private readonly handles = new Map<string, RegisteredHandle>();
  /** Heads whose changes were captured (or received) per unregistered document. */
  private readonly captured = new Map<string, string[]>();
  private unsubscribeWorkspace?: () => void;

  constructor(private readonly workspace?: SyncWorkspaceDocumentsPort) {}

  /**
   * Starts capturing local changes of unregistered notebook documents from
   * the workspace change feed. Returns a stop function.
   */
  attachWorkspace(onLocalChange: (documentId: string, change: Uint8Array) => void | Promise<void>): () => void {
    const workspace = this.workspace;
    if (!workspace) return () => undefined;
    this.unsubscribeWorkspace?.();
    // Capture starts at the current heads: a commit reports a page that is
    // not loaded without its previous heads, so the baseline must be known
    // before the first such change.
    for (const documentId of workspace.listDocuments()) {
      if (!this.captured.has(documentId)) this.captured.set(documentId, [...(workspace.getDocumentHeads(documentId) ?? [])]);
    }
    const unsubscribe = workspace.subscribeToDocumentChanges((event) => {
      const { documentId } = event;
      if (!workspace.includes(documentId)) return;
      if (event.added || this.handles.has(documentId) || !event.document) {
        // A registered handle captures its own changes; an added document is
        // new to this feed and starts at its current heads.
        this.captured.set(documentId, [...event.heads]);
        return;
      }
      if (event.origin.kind === 'remote' && event.origin.source === ENCRYPTED_SYNC_SOURCE) {
        this.captured.set(documentId, [...event.heads]);
        return;
      }
      const baseline = this.captured.get(documentId)
        ?? (event.beforeHeads.length > 0 ? [...event.beforeHeads] : [...(workspace.getDocumentHeads(documentId) ?? [])]);
      let changes: Uint8Array[];
      try {
        changes = Automerge.getChangesSince(event.document, baseline).map((change) => change.slice());
      } catch (error) {
        throw new SyncClientError('protocol-error', 'Local Automerge changes could not be captured.', { cause: error });
      }
      this.captured.set(documentId, [...event.heads]);
      for (const change of changes) void Promise.resolve(onLocalChange(documentId, change));
    });
    this.unsubscribeWorkspace = unsubscribe;
    return () => {
      unsubscribe();
      if (this.unsubscribeWorkspace === unsubscribe) this.unsubscribeWorkspace = undefined;
    };
  }

  register<T extends object>(
    documentId: string,
    handle: DocHandle<T>,
    onLocalChange: (documentId: string, change: Uint8Array) => void | Promise<void>,
  ): () => void {
    const existing = this.handles.get(documentId);
    existing?.unsubscribe();
    const typed = handle as unknown as DocHandle<object>;
    const entry: RegisteredHandle = { handle: typed, remoteDepth: 0, unsubscribe: () => undefined };
    const listener = ({ patchInfo, doc }: DocHandleChangePayload<object>) => {
      if (entry.remoteDepth > 0) return;
      let changes: Uint8Array[];
      try {
        changes = Automerge.getChanges(patchInfo.before, doc).map((change) => change.slice());
      } catch (error) {
        throw new SyncClientError('protocol-error', 'Local Automerge changes could not be captured.', { cause: error });
      }
      for (const change of changes) void Promise.resolve(onLocalChange(documentId, change));
    };
    typed.on('change', listener);
    entry.unsubscribe = () => typed.off('change', listener);
    this.handles.set(documentId, entry);
    return () => {
      if (this.handles.get(documentId) !== entry) return;
      entry.unsubscribe();
      this.handles.delete(documentId);
      // From here on the feed captures this document; it starts where the handle stopped.
      this.captured.set(documentId, Automerge.getHeads(typed.doc()));
    };
  }

  async applyRemoteChange(documentId: string, change: Uint8Array): Promise<void> {
    const entry = this.handles.get(documentId);
    if (!entry) {
      await this.applyThroughWorkspace(documentId, change);
      return;
    }
    entry.remoteDepth += 1;
    try {
      entry.handle.update((document) => Automerge.applyChanges(Automerge.clone(document), [change.slice()])[0]);
    } catch (error) {
      throw new SyncClientError('protocol-error', 'A remote Automerge change could not be applied.', { cause: error });
    } finally {
      entry.remoteDepth -= 1;
    }
  }

  async heads(): Promise<readonly DocumentHeads[]> {
    return [...this.handles.entries()].map(([documentId, entry]) => ({
      documentId,
      heads: Automerge.getHeads(entry.handle.doc()).map(hexHead),
    }));
  }

  async allChanges(): Promise<ReadonlyArray<{ documentId: string; change: Uint8Array }>> {
    return [...this.handles.entries()].flatMap(([documentId, entry]) =>
      Automerge.getAllChanges(entry.handle.doc()).map((change) => ({ documentId, change: change.slice() })),
    );
  }

  /**
   * A change for a document that is not registered (not the open page) is
   * merged through the workspace runtime instead of aborting the catch-up.
   * Only a document the workspace does not have still fails, as before.
   */
  private async applyThroughWorkspace(documentId: string, change: Uint8Array): Promise<void> {
    if (!this.workspace?.includes(documentId)) {
      throw new SyncClientError('protocol-error', 'The synchronized document is not open.');
    }
    let result: Awaited<ReturnType<SyncWorkspaceDocumentsPort['applyRemoteDocumentChanges']>>;
    try {
      result = await this.workspace.applyRemoteDocumentChanges(documentId, change.slice(), { source: ENCRYPTED_SYNC_SOURCE });
    } catch (error) {
      throw new SyncClientError('protocol-error', 'A remote Automerge change could not be applied.', { cause: error });
    }
    if (result === 'unknown' || result === 'rejected') {
      throw new SyncClientError('protocol-error', 'The synchronized document is not part of this workspace.');
    }
  }
}

function snapshotKey(notebookId: string): string { return `notebook:${notebookId}`; }

function assertSnapshot(value: unknown, notebookId: string): asserts value is DurableSyncSnapshot {
  if (
    typeof value !== 'object' || value === null ||
    (value as DurableSyncSnapshot).version !== 1 ||
    (value as DurableSyncSnapshot).notebookId !== notebookId ||
    (value as DurableSyncSnapshot).inbox?.notebookId !== notebookId ||
    !Array.isArray((value as DurableSyncSnapshot).outbox?.pending)
  ) throw new SyncClientError('protocol-error', 'Browser durable sync state is invalid.');
}

function hexHead(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new SyncClientError('protocol-error', 'Automerge returned an invalid head.');
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}
