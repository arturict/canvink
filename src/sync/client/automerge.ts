import * as Automerge from '@automerge/automerge';
import type { DocumentHeads } from '../types';
import { SyncClientError } from './errors';
import type { SyncDocumentPort } from './types';

interface StoredDoc {
  document: Automerge.Doc<Record<string, unknown>>;
  update(document: Automerge.Doc<Record<string, unknown>>): void;
}

/** Bridges raw Automerge changes without serializing the surrounding document. */
export class AutomergeDocumentBridge implements SyncDocumentPort {
  private readonly documents = new Map<string, StoredDoc>();

  register<T extends object>(
    documentId: string,
    document: Automerge.Doc<T>,
    update: (document: Automerge.Doc<T>) => void,
  ): () => void {
    if (!documentId || this.documents.has(documentId)) throw new SyncClientError('protocol-error', 'Document registration is invalid.');
    this.documents.set(documentId, {
      document: document as Automerge.Doc<Record<string, unknown>>,
      update: update as unknown as (document: Automerge.Doc<Record<string, unknown>>) => void,
    });
    return () => this.documents.delete(documentId);
  }

  replace<T extends object>(documentId: string, document: Automerge.Doc<T>): void {
    const stored = this.require(documentId);
    stored.document = document as Automerge.Doc<Record<string, unknown>>;
  }

  extractLocalChanges<T extends object>(
    documentId: string,
    before: Automerge.Doc<T>,
    after: Automerge.Doc<T>,
  ): Uint8Array[] {
    this.require(documentId);
    try {
      return Automerge.getChanges(before, after).map((change) => change.slice());
    } catch (error) {
      throw new SyncClientError('protocol-error', 'Local Automerge changes could not be extracted.', { cause: error });
    }
  }

  async applyRemoteChange(documentId: string, change: Uint8Array): Promise<void> {
    const stored = this.require(documentId);
    try {
      const [next] = Automerge.applyChanges(Automerge.clone(stored.document), [change.slice()]);
      stored.document = next;
      stored.update(next);
    } catch (error) {
      throw new SyncClientError('protocol-error', 'A remote Automerge change could not be applied.', { cause: error });
    }
  }

  async heads(): Promise<readonly DocumentHeads[]> {
    return [...this.documents.entries()].map(([documentId, stored]) => ({
      documentId,
      heads: Automerge.getHeads(stored.document).map(hexHead),
    }));
  }

  async allChanges(): Promise<ReadonlyArray<{ documentId: string; change: Uint8Array }>> {
    return [...this.documents.entries()].flatMap(([documentId, stored]) =>
      Automerge.getAllChanges(stored.document).map((change) => ({ documentId, change: change.slice() })),
    );
  }

  get<T extends object>(documentId: string): Automerge.Doc<T> {
    return this.require(documentId).document as Automerge.Doc<T>;
  }

  private require(documentId: string): StoredDoc {
    const stored = this.documents.get(documentId);
    if (!stored) throw new SyncClientError('protocol-error', 'The sync document is unavailable.');
    return stored;
  }
}

function hexHead(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new SyncClientError('protocol-error', 'Automerge returned an invalid head.');
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}
