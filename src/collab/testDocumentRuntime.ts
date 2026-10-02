/**
 * Test-only stand-in for the document API of `WorkspaceV2Runtime`
 * (`DocumentFeedRuntime`): an in-memory set of Automerge documents with the
 * same change feed semantics (origin, beforeHeads, a document that is only
 * valid while listeners run, `added` events). "Loaded" is tracked only to let
 * tests assert that sync never needed a page in memory. Not a `*.test.ts`
 * file, so vitest never runs it as a suite.
 */

import * as Automerge from '@automerge/automerge';
import type {
  DocumentFeedApplyResult,
  DocumentFeedEvent,
  DocumentFeedOrigin,
  DocumentFeedRuntime,
} from './documentFeedPort';

interface StoredDocument {
  kind: 'notebook' | 'page';
  doc: Automerge.Doc<unknown>;
}

export class FakeDocumentRuntime implements DocumentFeedRuntime {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly documentListeners = new Set<(event: DocumentFeedEvent) => void>();
  private readonly stateListeners = new Set<() => void>();
  /** Number of `readDocument` calls per document (a stand-in for loading a page). */
  readonly reads = new Map<string, number>();

  constructor(documents: Array<{ documentId: string; kind: 'notebook' | 'page'; doc: Automerge.Doc<unknown> }> = []) {
    for (const document of documents) this.documents.set(document.documentId, { kind: document.kind, doc: document.doc });
  }

  /** The current document (for assertions; the real runtime has no such accessor). */
  doc<T>(documentId: string): Automerge.Doc<T> {
    const stored = this.documents.get(documentId);
    if (!stored) throw new Error(`Unknown document ${documentId}.`);
    return stored.doc as Automerge.Doc<T>;
  }

  /** Replaces the stored copy without an event, as a reload from storage would. */
  addDocument(documentId: string, kind: 'notebook' | 'page', doc: Automerge.Doc<unknown>, options: { emit?: boolean } = {}): void {
    this.documents.set(documentId, { kind, doc });
    if (options.emit) {
      this.emit({ documentId, kind, beforeHeads: [], heads: Automerge.getHeads(doc), origin: { kind: 'topology' }, added: true });
      this.notifyState();
    }
  }

  removeDocument(documentId: string): void {
    this.documents.delete(documentId);
    this.notifyState();
  }

  /** A local edit (origin `local`), or a commit (`topology`). */
  change<T>(documentId: string, mutate: Automerge.ChangeFn<T>, origin: DocumentFeedOrigin = { kind: 'local' }): void {
    const stored = this.documents.get(documentId);
    if (!stored) throw new Error(`Unknown document ${documentId}.`);
    const beforeHeads = Automerge.getHeads(stored.doc);
    stored.doc = Automerge.change(stored.doc as Automerge.Doc<T>, mutate) as Automerge.Doc<unknown>;
    this.emit({ documentId, kind: stored.kind, beforeHeads, heads: Automerge.getHeads(stored.doc), origin, document: stored.doc });
  }

  listDocuments(): Array<{ documentId: string; kind: 'notebook' | 'page' }> {
    return [...this.documents].map(([documentId, stored]) => ({ documentId, kind: stored.kind }));
  }

  getDocumentHeads(documentId: string): readonly string[] | undefined {
    const stored = this.documents.get(documentId);
    return stored ? Automerge.getHeads(stored.doc) : undefined;
  }

  subscribeToDocumentChanges(listener: (event: DocumentFeedEvent) => void): () => void {
    this.documentListeners.add(listener);
    return () => { this.documentListeners.delete(listener); };
  }

  subscribeToState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  async readDocument<T>(documentId: string, reader: (document: Automerge.Doc<unknown>) => T | Promise<T>): Promise<T> {
    const stored = this.documents.get(documentId);
    if (!stored) throw new Error(`Document ${documentId} is not part of the active workspace.`);
    this.reads.set(documentId, (this.reads.get(documentId) ?? 0) + 1);
    return reader(stored.doc);
  }

  async applyRemoteDocumentChanges(
    documentId: string,
    bytes: Uint8Array,
    options: { source: string; accept?: (local: Automerge.Doc<unknown>, bytes: Uint8Array) => boolean },
  ): Promise<DocumentFeedApplyResult> {
    const stored = this.documents.get(documentId);
    if (!stored) return 'unknown';
    if (options.accept && !options.accept(stored.doc, bytes)) return 'rejected';
    const beforeHeads = Automerge.getHeads(stored.doc);
    stored.doc = Automerge.loadIncremental(stored.doc, bytes);
    const heads = Automerge.getHeads(stored.doc);
    if (beforeHeads.length === heads.length && beforeHeads.every((head) => heads.includes(head))) return 'unchanged';
    this.emit({ documentId, kind: stored.kind, beforeHeads, heads, origin: { kind: 'remote', source: options.source }, document: stored.doc });
    return 'applied';
  }

  private emit(event: DocumentFeedEvent): void {
    for (const listener of [...this.documentListeners]) listener(event);
  }

  private notifyState(): void {
    for (const listener of [...this.stateListeners]) listener();
  }
}
