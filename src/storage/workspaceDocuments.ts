import * as Automerge from '@automerge/automerge';
import {
  generateAutomergeUrl,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  type AutomergeUrl,
  type Chunk,
  type StorageKey,
} from '@automerge/automerge-repo';
import type {
  CanvinkAtomicCommitPlan,
  CanvinkStorageRecord,
} from '../crdt/canvinkStorageAdapter';
import type { CanvinkAutomergeDoc, LiveCanvinkDocumentV2 } from '../crdt';

/**
 * The storage a lazily loading workspace needs next to the Automerge Repo:
 * direct reads of one document's chunks (to load a page without keeping it in
 * the Repo), reads of the derived page index, and atomic writes that combine
 * Repo chunks with index entries. `CanvinkStorageAdapter` implements it for
 * IndexedDB and the Tauri SQLite bridge.
 */
export interface WorkspaceDocumentStorage {
  loadRange(keyPrefix: StorageKey): Promise<Chunk[]>;
  loadShared(keyPrefix: readonly string[]): Promise<CanvinkStorageRecord[]>;
  commitAtomically(plan: CanvinkAtomicCommitPlan): Promise<void>;
}

export const REPO_NAMESPACE = 'automerge-repo';
const AUTOMERGE_URL_PREFIX = 'automerge:';

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Same content hash Automerge Repo uses for incremental chunk keys. */
export async function chunkHash(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer));
}

/** Same heads hash Automerge Repo uses for snapshot chunk keys. */
export async function headsHash(heads: readonly string[]): Promise<string> {
  const encoder = new TextEncoder();
  const parts = heads.map((head) => encoder.encode(head));
  const merged = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return chunkHash(merged);
}

/**
 * Validating a URL decodes it and checks its checksum, which adds up when every commit of a
 * notebook with hundreds of pages looks up every page again. A URL's storage id never changes.
 */
const storageIds = new Map<string, string>();
const STORAGE_ID_CACHE_LIMIT = 20_000;

function rememberStorageId(url: string, storageId: string): void {
  if (storageIds.size >= STORAGE_ID_CACHE_LIMIT) storageIds.clear();
  storageIds.set(url, storageId);
}

export function storageIdOfUrl(url: string): string {
  const known = storageIds.get(url);
  if (known !== undefined) return known;
  let storageId: string;
  try {
    storageId = parseAutomergeUrl(url as AutomergeUrl).documentId;
  } catch {
    throw new Error(`Invalid Automerge URL ${url}.`);
  }
  rememberStorageId(url, storageId);
  return storageId;
}

/** `isValidAutomergeUrl` with the storage id cache, for the activation checks that run on every commit. */
export function isValidDocumentUrl(url: string): boolean {
  if (storageIds.has(url)) return true;
  if (!isValidAutomergeUrl(url)) return false;
  storageIdOfUrl(url);
  return true;
}

export function newDocumentUrl(): { url: AutomergeUrl; storageId: string } {
  const url = generateAutomergeUrl();
  // A fresh URL is `automerge:<document id>` and was just built from a valid id, so there is
  // nothing to decode again.
  const storageId = url.slice(AUTOMERGE_URL_PREFIX.length);
  rememberStorageId(url, storageId);
  return { url, storageId };
}

export function randomActorId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes.buffer);
}

/**
 * Loads a document straight from its stored chunks, the way the Repo's
 * storage subsystem does, but outside the Repo: the caller owns the returned
 * document and must `Automerge.free` it. A fresh random actor keeps changes
 * made to this copy distinct from any live copy of the same document.
 */
export async function loadDocumentFromStorage<T extends LiveCanvinkDocumentV2>(
  storage: WorkspaceDocumentStorage,
  storageId: string,
): Promise<CanvinkAutomergeDoc<T> | undefined> {
  const snapshots = await storage.loadRange([storageId, 'snapshot']);
  const incrementals = await storage.loadRange([storageId, 'incremental']);
  const parts = [...snapshots, ...incrementals].flatMap((chunk) => chunk.data ? [chunk.data] : []);
  if (parts.length === 0) return undefined;
  const merged = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  const actor = randomActorId();
  try {
    // `load` materialises the document in one pass; loading incrementally
    // into an empty document computes and applies a patch per value, which
    // is several times slower for pages with thousands of strokes.
    return Automerge.load<T>(merged, { actor }) as CanvinkAutomergeDoc<T>;
  } catch {
    // A truncated trailing chunk (an interrupted write): load what is readable.
    return Automerge.loadIncremental(Automerge.init<T>({ actor }), merged) as CanvinkAutomergeDoc<T>;
  }
}

export function freeDocument(document: Automerge.Doc<unknown> | undefined): void {
  if (!document) return;
  try {
    Automerge.free(document);
  } catch {
    // Already freed, or an outdated reference to a document that moved on.
  }
}
