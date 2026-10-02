/**
 * Pure helpers for the personal-space workspace CRDT document
 * (`docId: "workspace:root"`, `kind: "workspace"`; see PERSONAL-SYNC.md §4.3).
 *
 * This document is a plain Automerge document — it is never wrapped in
 * `assertCanvinkAutomergeDocument` and never enters the local Repo/activation
 * (§0 P3). All helpers here are free of I/O: no network, no clock reads
 * (timestamps are always supplied by the caller), no randomness.
 */

import * as Automerge from "@automerge/automerge";
import type { ImmutableString } from "@automerge/automerge";
import type { SpaceWorkspaceDocV1 } from "./contract";
import { keyBetween } from "./fractionalOrder";

/** A mutator compatible with `Automerge.change(doc, callback)`. */
export type WorkspaceDocChangeFn = Automerge.ChangeFn<SpaceWorkspaceDocV1>;

/** A brand-new, empty workspace doc: `{ v: 1, notebooks: {}, pages: {}, assets: {} }`. */
export function initWorkspaceDoc(): Automerge.Doc<SpaceWorkspaceDocV1> {
  return Automerge.change<SpaceWorkspaceDocV1>(Automerge.init<SpaceWorkspaceDocV1>(), (doc) => {
    doc.v = 1;
    doc.notebooks = {};
    doc.pages = {};
    doc.assets = {};
  });
}

/** Loads a workspace doc from its full Automerge save. */
export function loadWorkspaceDoc(bytes: Uint8Array): Automerge.Doc<SpaceWorkspaceDocV1> {
  return Automerge.load<SpaceWorkspaceDocV1>(bytes);
}

/** The full Automerge save of a workspace doc, suitable for the persisted cache copy (§5.6). */
export function saveWorkspaceDoc(doc: Automerge.Doc<SpaceWorkspaceDocV1>): Uint8Array {
  return Automerge.save(doc);
}

/**
 * The same state in a new document that has none of the old one's history, without the asset
 * references older builds published inside page summaries (see `summaryPublishing.ts`). The
 * workspace document lists every page of the account, and every rewrite of a summary stays in
 * its history: after a few months a document of 450 pages was 1.4 MB and took 6 s to load on
 * the main thread, where the same state as a new document is 135 KB and loads in well under a
 * second. The result has no common ancestor with `doc`, so it only ever replaces the room's copy
 * (see `RoomSession.replaceDoc`), never merges with it.
 */
export function rewriteWorkspaceDoc(doc: Automerge.Doc<SpaceWorkspaceDocV1>): Automerge.Doc<SpaceWorkspaceDocV1> {
  const plain = JSON.parse(JSON.stringify(doc)) as SpaceWorkspaceDocV1;
  // The JSON round trip turned every published summary into a plain string; each goes back in as one
  // immutable string, and a map of fields from an older build is converted the same way.
  const summaries = new Map<string, ImmutableString>();
  for (const [documentId, entry] of Object.entries(plain.pages)) {
    const summary: unknown = entry.summary;
    if (summary === undefined || summary === null) continue;
    if (typeof summary === "string") {
      summaries.set(documentId, new Automerge.ImmutableString(summary));
    } else {
      const { assets: _assets, ...published } = summary as Record<string, unknown>;
      void _assets;
      summaries.set(documentId, new Automerge.ImmutableString(JSON.stringify(published)));
    }
    delete entry.summary;
  }
  return Automerge.change(Automerge.init<SpaceWorkspaceDocV1>(), (next) => {
    next.v = 1;
    next.notebooks = plain.notebooks;
    next.pages = plain.pages;
    next.assets = plain.assets;
    for (const [documentId, summary] of summaries) next.pages[documentId]!.summary = summary;
  });
}

/** One local document's place in the notebook graph, for seeding an initial workspace doc. */
export interface WorkspaceDocSeedNotebook {
  documentId: string;
  /** `page:<pageId>` document ids belonging to this notebook, in any order. */
  pageDocumentIds: readonly string[];
}

export interface WorkspaceDocSeedInput {
  /** Notebook `documentId`s, in the order they should receive ascending fractional keys. */
  notebookDocumentIdsInOrder: readonly string[];
  notebooks: readonly WorkspaceDocSeedNotebook[];
  now: string;
}

/**
 * Builds an initial `SpaceWorkspaceDocV1` for the "add local notebooks to the
 * account" bootstrap choice (§0 P8, "additive"): every local notebook and its
 * pages become space entries, ordered by fractional key in the caller's given
 * order. A page whose owning notebook is not present in `notebooks` is
 * skipped — the workspace doc only ever asserts what its own creator knows to
 * be true; a dangling reference is a caller bug, not something this function
 * should paper over.
 */
export function createInitialWorkspaceDoc(input: WorkspaceDocSeedInput): Automerge.Doc<SpaceWorkspaceDocV1> {
  const notebookByDocumentId = new Map(input.notebooks.map((notebook) => [notebook.documentId, notebook]));
  return Automerge.change(initWorkspaceDoc(), (doc) => {
    let previousOrder: string | undefined;
    for (const documentId of input.notebookDocumentIdsInOrder) {
      const notebook = notebookByDocumentId.get(documentId);
      if (!notebook) continue;
      const order = keyBetween(previousOrder, undefined);
      previousOrder = order;
      doc.notebooks[documentId] = { order, addedAt: input.now };
      for (const pageDocumentId of notebook.pageDocumentIds) {
        doc.pages[pageDocumentId] = { notebookDocumentId: documentId, addedAt: input.now };
      }
    }
  });
}

// ---------------------------------------------------------------------------------------
// Mutators (§9 Wave 3). Each returns an `Automerge.ChangeFn`, so callers write
// `Automerge.change(doc, addNotebook(id, { order, addedAt }))`. None of them read a clock,
// touch the network, or throw for a merely-stale caller assumption — a documentId that
// no longer exists (already purged elsewhere) is a silent no-op, not an error, because the
// caller may be applying a locally-queued mutation after a concurrent remote purge landed.
// ---------------------------------------------------------------------------------------

export type SpaceEntryKind = "notebook" | "page";

/** Adds a notebook entry. Idempotent: never resurrects an entry that already exists
 * (including one that is soft- or hard-deleted) — use `restore` for that. */
export function addNotebook(
  documentId: string,
  entry: { order: string; addedAt: string },
): WorkspaceDocChangeFn {
  return (doc) => {
    if (doc.notebooks[documentId]) return;
    doc.notebooks[documentId] = { order: entry.order, addedAt: entry.addedAt };
  };
}

/** Adds a page entry. Idempotent, for the same reason as `addNotebook`. */
export function addPage(
  documentId: string,
  entry: { notebookDocumentId: string; addedAt: string },
): WorkspaceDocChangeFn {
  return (doc) => {
    if (doc.pages[documentId]) return;
    doc.pages[documentId] = { notebookDocumentId: entry.notebookDocumentId, addedAt: entry.addedAt };
  };
}

/** Sets `deletedAt` (trash). A no-op on a missing or already-purged entry: a hard delete is
 * final and a soft delete can never resurrect it (§6.3). */
export function softDelete(kind: SpaceEntryKind, documentId: string, deletedAt: string): WorkspaceDocChangeFn {
  return (doc) => {
    const entry = kind === "notebook" ? doc.notebooks[documentId] : doc.pages[documentId];
    if (!entry || entry.purgedAt) return;
    entry.deletedAt = deletedAt;
  };
}

/** Clears `deletedAt` (undo trash). A no-op on a missing or already-purged entry. */
export function restore(kind: SpaceEntryKind, documentId: string): WorkspaceDocChangeFn {
  return (doc) => {
    const entry = kind === "notebook" ? doc.notebooks[documentId] : doc.pages[documentId];
    if (!entry || entry.purgedAt) return;
    delete entry.deletedAt;
  };
}

/** Sets `purgedAt` (hard delete). Only ever reachable, per §6.3, from an explicit confirmed
 * trash action; this function itself has no such gate — the caller enforces it. */
export function purge(kind: SpaceEntryKind, documentId: string, purgedAt: string): WorkspaceDocChangeFn {
  return (doc) => {
    const entry = kind === "notebook" ? doc.notebooks[documentId] : doc.pages[documentId];
    if (!entry) return;
    entry.purgedAt = purgedAt;
  };
}

/** Rewrites a notebook's fractional-index `order` (§6.2 concurrent-reorder LWW register).
 * A no-op on a missing or already-purged notebook. */
export function reorderNotebook(documentId: string, order: string): WorkspaceDocChangeFn {
  return (doc) => {
    const entry = doc.notebooks[documentId];
    if (!entry || entry.purgedAt) return;
    entry.order = order;
  };
}

/**
 * Records (or, with `undefined`, clears) the share room a joined notebook syncs through. A no-op
 * on a missing or purged notebook and when the value is already set.
 */
export function setNotebookSharedRoom(documentId: string, roomId: string | undefined): WorkspaceDocChangeFn {
  return (doc) => {
    const entry = doc.notebooks[documentId];
    if (!entry || entry.purgedAt || entry.sharedRoomId === roomId) return;
    if (roomId === undefined) delete entry.sharedRoomId;
    else entry.sharedRoomId = roomId;
  };
}

/** Records an asset in the manifest. Idempotent: an asset id is a content hash, so an
 * existing entry is never overwritten by a re-upload of the same bytes. */
export function recordAsset(
  assetId: string,
  entry: { size: number; mimeType: string; addedAt: string },
): WorkspaceDocChangeFn {
  return (doc) => {
    if (doc.assets[assetId]) return;
    doc.assets[assetId] = { size: entry.size, mimeType: entry.mimeType, addedAt: entry.addedAt };
  };
}
