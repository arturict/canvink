// Type-only contract for the Canvink personal space (cross-device sync of a signed-in
// user's own notebooks). See services/collab-sync/PERSONAL-SYNC.md §4.3 and §5.2.
//
// This is the Wave-0 seed: every later wave imports its shared types and constants from
// this file (via ./index.ts). No runtime code, no behaviour. Do not add logic here.

import type { ImmutableString } from "@automerge/automerge";
import type { PageSummary } from "../storage/pageIndex";

// ---------------------------------------------------------------------------------------
// §4.3 — the workspace CRDT document (docId "workspace:root", kind "workspace")
// ---------------------------------------------------------------------------------------

/** The workspace topology + asset manifest CRDT document. Never enters the local Repo or
 * activation; materialised into the manifest via `commitWorkspaceGraphRevision`. */
export interface SpaceWorkspaceDocV1 {
  v: 1;
  /** Notebook roots, keyed by their canonical documentId `notebook:<notebookId>`. */
  notebooks: Record<string, SpaceNotebookEntry>;
  /** Page documents, keyed by `page:<pageId>`. */
  pages: Record<string, SpacePageEntry>;
  /** Asset manifest: which content hashes exist in this space's R2 prefix. */
  assets: Record<string, SpaceAssetEntry>;
}

export interface SpaceNotebookEntry {
  /** Fractional index; sort ascending, tie-break by documentId. */
  order: string;
  addedAt: string; // ISO 8601
  /** Soft delete (trash). Never removed from the map while soft-deleted. */
  deletedAt?: string;
  /** Hard delete. Set only by an explicit confirmed purge; see §6.3. */
  purgedAt?: string;
  /**
   * The share room of a notebook someone else shared and this account joined. A device that
   * adopts the notebook connects it to that room with the account token alone (the Worker knows
   * the account as a collaborator since the first join), so the notebook syncs the same way on
   * every device of the account. Absent on notebooks the account shares itself: those connect
   * with the owner token, which stays on the device that created the share.
   */
  sharedRoomId?: string;
}

export interface SpacePageEntry {
  /** Owning notebook root documentId. A page never changes notebooks in place; a move is
   * remove-here + add-there inside the notebook doc's `sections`. */
  notebookDocumentId: string;
  addedAt: string;
  deletedAt?: string;
  purgedAt?: string;
  /**
   * What the sidebar, search results and page pickers show about the page (title, place, tags,
   * dates, assets), published by a device that holds the page. A fresh device lists every page
   * from these entries and downloads the documents afterwards, instead of loading each page
   * first to learn its title. Absent on entries written before summaries were published; a
   * device that holds the page adds it. Stored as one immutable string of JSON (see
   * `parsePublishedSummary`); a map of fields is what older builds wrote.
   */
  summary?: ImmutableString | PageSummary;
}

export interface SpaceAssetEntry {
  size: number;
  mimeType: string;
  addedAt: string;
}

// ---------------------------------------------------------------------------------------
// §5.2 — status, descriptors, plan (wave-0 seed)
// ---------------------------------------------------------------------------------------

export type SpaceStatus =
  | { kind: "disabled" } // no VITE_PERSONAL_SPACE / no Clerk / no sync URL
  | { kind: "signed-out" }
  | { kind: "link-required"; localHasData: boolean; remoteDocCount: number }
  | { kind: "bootstrapping"; phase: "push" | "pull" | "adopt" }
  | { kind: "synced"; lastSyncedAt: string }
  | { kind: "offline"; pendingDocs: number }
  | { kind: "reconnecting" }
  | { kind: "quota-exceeded"; scope: "log" | "assets" }
  | { kind: "error"; message: string };

export interface SpaceDescriptor {
  spaceId: string;
  kind: "personal";
  docCount: number;
  logBytes: number;
  assetCount: number;
  assetBytes: number;
  createdAt: string;
  quota: { logBytes: number; assetBytes: number; maxAssetBytes: number };
}

export interface SpaceLinkRecord {
  spaceId: string;
  sub: string;
  linkedAt: string;
}

/** Everything materialize.ts must apply to the local workspace. */
export interface SpacePlan {
  adoptedDocuments: Array<{
    documentId: string;
    kind: "notebook" | "page";
    bytes: Uint8Array;
    /** The account's published summary of the page, when it has one. */
    expectedSummary?: PageSummary;
  }>;
  /** Pages the account lists whose documents this device has not downloaded: shown from their summary. */
  placeholderPages: Array<{ documentId: string; summary: PageSummary }>;
  removedDocumentIds: string[];
  notebookDocumentIds: string[]; // full replacement order for the manifest
  pageDocumentIds: string[]; // full replacement list for the manifest
  trashAdditions: Array<{ documentId: string; kind: "notebook" | "page"; deletedAt: string }>;
  trashRemovals: string[];
}

export const SPACE_WORKSPACE_DOC_ID = "workspace:root";
export const SPACE_ADOPT_BATCH_MS = 2_000;
/** Debounce of the first catch-up of a session: the room then only sends the workspace and notebooks, so there is no long replay to wait out. */
export const SPACE_FIRST_ADOPT_MS = 250;
/**
 * Adopted document bytes per storage commit. A commit is one IndexedDB transaction, and the
 * page saves of the user queue behind it, so it stays short: about what one page save costs.
 */
export const SPACE_ADOPT_COMMIT_BYTES = 2 * 1024 * 1024;
export const SPACE_ASSET_BATCH_MS = 2_000;
export const SPACE_MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const SPACE_MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const SPACE_REAUTH_MARGIN_S = 15;
export const SPACE_WORKSPACE_DOC_COMPACT_EVERY = 32;
