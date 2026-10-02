/**
 * Wires the personal-space session, port, projection, materialiser and asset
 * queue into `V2NotebookApp.tsx` (PERSONAL-SYNC.md §5.8, §9 Wave 5).
 *
 * Preconditions enforced, in order, before any socket opens:
 *   1. `enabled && syncUrl && auth.available && auth.isSignedIn`.
 *   2. `runtime` is non-null (write access already held; see the module doc
 *      comment in PERSONAL-SYNC.md §5.8 for why multi-tab safety is inherited
 *      rather than re-implemented here).
 *   3. `workspace.schemaVersion === 3` (this hook calls `ensureSchemaV3()`
 *      itself when it is not, before doing anything else).
 *   4. A `SpaceLinkRecord` exists for `auth.user.id`, or the P8 first-contact
 *      choice has been resolved (`addLocalToAccount` / `discardLocalForAccount`).
 *
 * `{ kind: 'disabled' }` short-circuits before any of the above run: no HTTP
 * call, no WebSocket, no module-level side effect.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Automerge from '@automerge/automerge';
import type { OptionalAuthValue } from '../../auth';
import { isBundledStartPageId } from '../../domain/sample';
import type { AssetBlob, Sha256Checksum } from '../../domain/v2';
import { whenIdle } from '../../performance/yield';
import { prewarmAdoptedDocument, previewAdoptedDocument } from '../../storage/adoptionPrep';
import { parsePublishedSummary } from '../../storage/pageIndex';
import type { V2RuntimeState, WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { RICH_TEXT_EDIT_MESSAGE } from '../../editor/richText/editStamp';
import { getAutomergeSnapshot, loadAutomergeDocument } from '../../crdt';
import { swappedDocuments } from '../../ink/rebuildLease';
import { inkSegments } from '../../ink/segmentStore';
import { createInkSegmentSync, type InkSegmentSync } from '../../personal-space/assets/inkSegmentSync';
import type { LiveNotebookDocV2, LivePageDocV2 } from '../../crdt';
import { attachAckCompaction } from '../../collab';
import {
  addNotebook,
  addPage,
  AssetSyncQueue,
  type AssetRequestOptions,
  clearSpaceLink,
  clearSpaceResume,
  filterResumeToLocalCopies,
  loadSpaceResume,
  loadOfflineCopiesPolicy,
  saveSpaceResume,
  createInitialWorkspaceDoc,
  createOrGetSpace,
  applySpacePlan,
  bindPersonalSpace,
  createRuntimeSpacePort,
  deleteAsset as httpDeleteAsset,
  getAsset as httpGetAsset,
  headAsset as httpHeadAsset,
  initWorkspaceDoc,
  isWorkspaceDocId,
  loadSpaceLink,
  openPersonalSpaceSession,
  projectSpacePlan,
  toDecodedNotebook,
  type DecodedNotebook,
  purge,
  putAsset as httpPutAsset,
  recordAsset,
  restore,
  saveSpaceLink,
  setNotebookSharedRoom,
  rewriteWorkspaceDoc,
  saveWorkspaceDoc,
  sharesHistory,
  softDelete,
  publishSummaries,
  summariesToPublish,
  SPACE_ADOPT_BATCH_MS,
  SPACE_FIRST_ADOPT_MS,
  SPACE_MAX_SNAPSHOT_BYTES,
  SPACE_WORKSPACE_DOC_ID,
  type ApplySpacePlanOptions,
  type AssetSyncHttpPort,
  type AssetSyncRuntimePort,
  type PersonalSpaceBinding,
  type PersonalSpaceSession,
  type SpaceCredential,
  type SpaceDescriptor,
  type SpacePlan,
  type SpaceStatus,
  type SpaceWorkspaceDocV1,
} from '../../personal-space';
import { applyDeviceNetwork } from '../../personal-space/spaceSession';
import { keyBetween } from '../../personal-space/fractionalOrder';

// ---------------------------------------------------------------------------------------
// Auth adapter: `useOptionalAuth()` only exposes a raw JWT string
// (`getToken(): Promise<string | null>`), never its `exp` claim — the personal
// session needs both (`SpaceCredential`), the same way `OpenSessionCredentials
// .getClerkJwt` in `src/collab` refreshes a token on reconnect without ever
// decoding it itself. Decoding here, once, is the smallest way to get `exp`
// without touching `src/auth/**`.
// ---------------------------------------------------------------------------------------

export function decodeJwtExpirySeconds(jwt: string): number | undefined {
  try {
    const payloadSegment = jwt.split('.')[1];
    if (!payloadSegment) return undefined;
    const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = atob(padded);
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === 'number' ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

/** Falls back to a conservative 55s lifetime (Clerk session tokens live ~60s, P6) when `exp` cannot be decoded. */
export function credentialFromJwt(jwt: string, nowS: () => number): SpaceCredential {
  const expiresAt = decodeJwtExpirySeconds(jwt);
  return { jwt, expiresAt: expiresAt ?? nowS() + 55 };
}

// ---------------------------------------------------------------------------------------
// Pristine-starter detection (§2.4): a brand-new device's local workspace is not the bare
// "1 starter notebook / 1 section / 1 page" shape the spec's pseudocode sketches — this app
// seeds every first launch with the rich onboarding sample from `createDefaultWorkspace()`
// (`src/domain/sample.ts`: one notebook titled "My notebook", 3 sections, 4 pages, one of
// which carries a migration-preserved start page id, see `isBundledStartPageId`). "Pristine" here
// means "still recognizably that sample": exactly one notebook, the bundled start page still
// present, and no MORE pages/sections than the sample shipped with (a user who only renamed
// something or edited existing bundled text is still treated as pristine — this checks
// structure, not content equality, which is a deliberate under-detection bias: wrongly
// treating edited content as "not pristine" only costs an extra P8 dialog the user can
// dismiss with "add local to the account"; wrongly treating it as pristine would silently
// pull over real edits, which is the worse failure mode).
// ---------------------------------------------------------------------------------------

const BUNDLED_SAMPLE_MAX_PAGES = 4;
const BUNDLED_SAMPLE_MAX_SECTIONS = 3;

/** See `startCatchUpWatchdog`'s doc comment: must stay strictly greater than
 * `SPACE_ADOPT_BATCH_MS` or every tick perpetually resets `scheduleCatchUp`'s own debounce timer
 * before it ever gets a quiet gap to fire. */
const CATCH_UP_WATCHDOG_INTERVAL_MS = SPACE_ADOPT_BATCH_MS + 1_000;
/** Pause before a failed first contact with the Worker is tried again (it also retries on `online`). */
const BOOTSTRAP_RETRY_MS = 15_000;
/** How often the resume record follows the documents that synced since it was written. */
const RESUME_WRITE_INTERVAL_MS = 20_000;
/** Quiet time after a document's last frame before it goes to the adoption workers. */
const PREWARM_SETTLE_MS = 250;
/** Quiet time after a frame of the workspace document before the newest copy is loaded. */
const WORKSPACE_DOC_SETTLE_MS = 40;
/** The room's workspace document is rewritten without its history once it is this large and would shrink to under half. */
const WORKSPACE_REWRITE_MIN_BYTES = 256 * 1024;
const WORKSPACE_REWRITE_MIN_RATIO = 2;
/** The rewrite waits until the first catch-up and the page downloads it starts are over. */
const WORKSPACE_REWRITE_DELAY_MS = 4_000;
const WORKSPACE_REWRITE_ATTEMPTS = 15;
/** Pages requested from the room at once by the background download. */
const HYDRATE_BATCH_DOCS = 32;
/** Pause between two download batches, so the interface keeps its turns. */
const HYDRATE_PAUSE_MS = 40;
/** Longest wait for idle time between two download batches; a busy page still gets its pages. */
const HYDRATE_IDLE_TIMEOUT_MS = 400;
/** Publishing this many summaries at once makes the workspace document worth compacting. */
const COMPACT_AFTER_PUBLISHED_PAGES = 20;
/** Wait before page summaries changed by local edits are published. */
const SUMMARY_PUBLISH_DELAY_MS = 2_000;
/** Assets read from storage and uploaded together (see the asset upload in the topology effect). */
const ASSET_UPLOAD_BATCH = 8;

export function isLocalWorkspacePristine(workspace: V2RuntimeState): boolean {
  if (workspace.notebooks.length !== 1) return false;
  const [notebook] = workspace.notebooks;
  if (!notebook) return false;
  if (notebook.sections.length > BUNDLED_SAMPLE_MAX_SECTIONS) return false;
  if (workspace.pages.length > BUNDLED_SAMPLE_MAX_PAGES) return false;
  if (!workspace.pages.some((page) => isBundledStartPageId(page.pageId))) return false;
  // Whatever the person touched (a rename, a drawing, a setting, a typed line) moves a time of
  // last change off the time of creation; the bundled sample is created with both equal.
  if (notebook.updatedAt !== notebook.createdAt) return false;
  if (notebook.sections.some((section) => section.updatedAt !== section.createdAt)) return false;
  return workspace.pages.every((page) => page.updatedAt === page.createdAt);
}

/**
 * Whether a page of the bundled starter holds text the person typed. Typing only splices a text
 * block, so it leaves no trace in the page's times (before the editor stamped them) and the check
 * has to look at the page's changes. Unreadable pages count as written in: the safe answer is
 * the one that asks.
 */
export async function starterHoldsTypedText(
  runtime: Pick<WorkspaceV2Runtime, 'readDocument'>,
  workspace: V2RuntimeState,
): Promise<boolean> {
  for (const page of workspace.pages) {
    try {
      const typed = await runtime.readDocument(page.documentId, (document) => Automerge
        .getAllChanges(document as Automerge.Doc<object>)
        .some((change) => Automerge.decodeChange(change).message === RICH_TEXT_EDIT_MESSAGE));
      if (typed) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// A catch-up plan that purges the local pristine starter (§2.4) can leave the manifest's
// `active` target (a domain notebookId/sectionId/pageId triple, not a documentId) dangling —
// `applySpacePlan`/`applyPlanToManifest` only ever rewrite `notebookDocumentIds`/
// `pageDocumentIds`/`trash`, never `active`, so nothing else fixes this up. Deriving a
// replacement from whatever the SAME plan just adopted (rather than from local state, which by
// definition has nothing else left once the starter is gone) keeps this within the same
// transaction, avoiding a separate later commit that would briefly leave the workspace with an
// invalid active context (workspaceV2Runtime.ts's own validation is strict about this, by design).
// ---------------------------------------------------------------------------------------

type AdoptedDocument = SpacePlan['adoptedDocuments'][number];

/**
 * The notebook an adopted document holds. Reading it loads the document, which for a notebook of
 * hundreds of pages takes a noticeable part of a second, so the adoption workers do it (the commit
 * needs the same result and shares it); only a runtime without workers loads it here.
 */
async function adoptedNotebook(doc: AdoptedDocument, schemaVersion: 2 | 3): Promise<LiveNotebookDocV2 | undefined> {
  const prepared = await previewAdoptedDocument(doc, schemaVersion);
  if (prepared?.notebook) return prepared.notebook;
  try {
    return getAutomergeSnapshot(
      loadAutomergeDocument(doc.bytes, { expectedDocumentId: doc.documentId, expectedKind: 'notebook' }),
    ) as LiveNotebookDocV2;
  } catch {
    return undefined;
  }
}

/** The page id of an adopted page document: from its published summary or a worker, never by loading a (possibly huge) page here. */
async function adoptedPageId(doc: AdoptedDocument, schemaVersion: 2 | 3): Promise<string | undefined> {
  const prepared = await previewAdoptedDocument(doc, schemaVersion);
  if (prepared?.summary) return prepared.summary.pageId;
  try {
    return (getAutomergeSnapshot(
      loadAutomergeDocument(doc.bytes, { expectedDocumentId: doc.documentId, expectedKind: 'page' }),
    ) as LivePageDocV2).pageId;
  } catch {
    return undefined;
  }
}

export async function deriveActiveFromAdoptedDocuments(
  adoptedDocuments: SpacePlan['adoptedDocuments'],
  schemaVersion: 2 | 3,
): Promise<{ notebookId: string; sectionId: string; pageId: string } | undefined> {
  const byDocumentId = new Map(adoptedDocuments.map((doc) => [doc.documentId, doc] as const));
  for (const doc of adoptedDocuments) {
    if (doc.kind !== 'notebook') continue;
    const notebook = await adoptedNotebook(doc, schemaVersion);
    if (!notebook) continue;
    for (const section of notebook.sections) {
      for (const pageDocumentId of section.pageDocumentIds) {
        const pageDoc = byDocumentId.get(pageDocumentId);
        if (!pageDoc || pageDoc.kind !== 'page') {
          continue;
        }
        const pageId = await adoptedPageId(pageDoc, schemaVersion);
        if (pageId !== undefined) return { notebookId: notebook.notebookId, sectionId: section.id, pageId };
      }
    }
  }
  return undefined;
}

/**
 * The page a first catch-up has to download so that the workspace has a stored page to show: the
 * first page of the first adopted notebook, when it is only listed by its summary. Undefined when
 * a stored page is already adopted.
 */
export async function landingPageToDownload(plan: SpacePlan, schemaVersion: 2 | 3): Promise<string | undefined> {
  if (await deriveActiveFromAdoptedDocuments(plan.adoptedDocuments, schemaVersion) !== undefined) return undefined;
  const placeholders = new Set(plan.placeholderPages.map((page) => page.documentId));
  for (const doc of plan.adoptedDocuments) {
    if (doc.kind !== 'notebook') continue;
    const notebook = await adoptedNotebook(doc, schemaVersion);
    if (!notebook) continue;
    for (const section of notebook.sections) {
      const first = section.pageDocumentIds.find((pageDocumentId) => placeholders.has(pageDocumentId));
      if (first) return first;
    }
  }
  return undefined;
}

/**
 * The MIME type an asset is uploaded with, from its first bytes. Only the
 * upload's `Content-Type` in the account's asset store depends on it: pages
 * keep each asset's real MIME type in their own elements, which sync as
 * documents. Reading it from the bytes needs no page at all, where finding
 * the referencing element would mean loading pages (all of them, in the worst
 * case) for every upload. Formats without a clear signature (office files,
 * archives, plain text) are uploaded as `application/octet-stream`.
 */
export function findAssetMimeType(bytes: Uint8Array): string {
  const startsWith = (...signature: number[]): boolean =>
    bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  const ascii = (offset: number, text: string): boolean =>
    bytes.byteLength >= offset + text.length
    && [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (ascii(0, 'BM')) return 'image/bmp';
  if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  if (ascii(4, 'ftypavif')) return 'image/avif';
  if (ascii(4, 'ftypheic') || ascii(4, 'ftypheix') || ascii(4, 'ftypmif1')) return 'image/heic';
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------------------
const NO_SHARED_ROOMS: ReadonlyMap<string, string> = new Map();

// Local -> workspace-doc projection (the mirror image of `projectSpacePlan`, which goes
// workspace-doc -> local). Pure: computes the mutator list a local topology change requires;
// applying it is the caller's job.
// ---------------------------------------------------------------------------------------

export function projectLocalTopologyIntoWorkspaceDoc(
  doc: SpaceWorkspaceDocV1,
  workspace: V2RuntimeState,
  now: string,
  /** Share rooms of the joined notebooks of this device, by notebook document id. */
  sharedRooms: ReadonlyMap<string, string> = NO_SHARED_ROOMS,
): Automerge.ChangeFn<SpaceWorkspaceDocV1> | null {
  const notebookIds = workspace.activation.manifest.notebookDocumentIds as string[];
  const pageIds = workspace.activation.manifest.pageDocumentIds as string[];
  const trash = workspace.activation.manifest.trash as Array<{
    kind: string;
    notebookDocumentId?: string;
    pageDocumentId?: string;
  }>;

  const missingNotebookIds = notebookIds.filter((id) => !doc.notebooks[id]);
  const missingPageIds = pageIds.filter((id) => !doc.pages[id]);
  const trashedNotebookIds = new Set(
    trash.filter((r) => r.kind === 'notebook' && r.notebookDocumentId).map((r) => r.notebookDocumentId as string),
  );
  const trashedPageIds = new Set(
    trash.filter((r) => r.kind === 'page' && r.pageDocumentId).map((r) => r.pageDocumentId as string),
  );
  const softDeletesToApply = [
    ...notebookIds.filter((id) => trashedNotebookIds.has(id) && doc.notebooks[id] && !doc.notebooks[id]?.deletedAt)
      .map((id) => ({ kind: 'notebook' as const, id })),
    ...pageIds.filter((id) => trashedPageIds.has(id) && doc.pages[id] && !doc.pages[id]?.deletedAt)
      .map((id) => ({ kind: 'page' as const, id })),
  ];
  const restoresToApply = [
    ...Object.entries(doc.notebooks)
      .filter(([id, entry]) => entry.deletedAt && !entry.purgedAt && !trashedNotebookIds.has(id) && notebookIds.includes(id))
      .map(([id]) => ({ kind: 'notebook' as const, id })),
    ...Object.entries(doc.pages)
      .filter(([id, entry]) => entry.deletedAt && !entry.purgedAt && !trashedPageIds.has(id) && pageIds.includes(id))
      .map(([id]) => ({ kind: 'page' as const, id })),
  ];
  const purgedNotebookIds = Object.keys(doc.notebooks).filter(
    (id) => !doc.notebooks[id]?.purgedAt && !notebookIds.includes(id) && !doc.notebooks[id]?.deletedAt === false && !notebookIds.includes(id),
  );
  // A page document that a rebuild replaced (its notebook says so) is retired for everyone, once
  // its replacement is part of the workspace.
  const supersededPageIds = workspace.notebooks
    .flatMap((notebook) => swappedDocuments(notebook))
    .filter((swap) => pageIds.includes(swap.replacement) || doc.pages[swap.replacement])
    .map((swap) => swap.replaced)
    .filter((id) => doc.pages[id] && !doc.pages[id]?.purgedAt);
  // A notebook this device used to know about, still soft-deleted in the doc, and no longer
  // present locally at all (a confirmed hard purge, §6.3 rule 4) becomes a purge here too.
  const localPurgedNotebookIds = Object.keys(doc.notebooks).filter(
    (id) => doc.notebooks[id]?.deletedAt && !doc.notebooks[id]?.purgedAt && !notebookIds.includes(id),
  );
  const localPurgedPageIds = Object.keys(doc.pages).filter(
    (id) => doc.pages[id]?.deletedAt && !doc.pages[id]?.purgedAt && !pageIds.includes(id),
  );

  const roomsToRecord = [...sharedRooms].filter(([documentId, roomId]) => (
    notebookIds.includes(documentId) && doc.notebooks[documentId]?.sharedRoomId !== roomId
  ));

  if (
    missingNotebookIds.length === 0
    && roomsToRecord.length === 0
    && missingPageIds.length === 0
    && softDeletesToApply.length === 0
    && restoresToApply.length === 0
    && localPurgedNotebookIds.length === 0
    && localPurgedPageIds.length === 0
    && supersededPageIds.length === 0
    && purgedNotebookIds.length === 0
  ) {
    return null;
  }

  const pageOwners = new Map<string, string>();
  for (const notebook of workspace.notebooks) {
    for (const section of notebook.sections) {
      for (const pageDocumentId of section.pageDocumentIds) pageOwners.set(pageDocumentId, notebook.documentId);
    }
  }

  return (mutableDoc) => {
    let previousOrder = Object.values(mutableDoc.notebooks)
      .map((entry) => entry.order)
      .sort()
      .at(-1);
    for (const id of missingNotebookIds) {
      const order = keyBetween(previousOrder, undefined);
      previousOrder = order;
      addNotebook(id, { order, addedAt: now })(mutableDoc);
    }
    for (const [documentId, roomId] of roomsToRecord) setNotebookSharedRoom(documentId, roomId)(mutableDoc);
    for (const id of missingPageIds) {
      const owner = pageOwners.get(id);
      if (!owner) continue;
      addPage(id, { notebookDocumentId: owner, addedAt: now })(mutableDoc);
    }
    for (const { kind, id } of softDeletesToApply) softDelete(kind, id, now)(mutableDoc);
    for (const { kind, id } of restoresToApply) restore(kind, id)(mutableDoc);
    for (const id of localPurgedNotebookIds) purge('notebook', id, now)(mutableDoc);
    for (const id of localPurgedPageIds) purge('page', id, now)(mutableDoc);
    for (const id of supersededPageIds) purge('page', id, now)(mutableDoc);
  };
}

// ---------------------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------------------

export interface UsePersonalSpaceSyncOptions {
  runtime: WorkspaceV2Runtime | null;
  workspace: V2RuntimeState | null;
  syncUrl: string | undefined;
  auth: OptionalAuthValue;
  enabled: boolean;
  onWorkspaceReplaced(next: V2RuntimeState): void;
  onNotice(message: string): void;
  onStatus(status: SpaceStatus): void;
  /**
   * The share rooms of the notebooks this device joined, by notebook document id. They are written
   * into the account's workspace document so the account's other devices connect those notebooks
   * to the same rooms.
   */
  sharedRooms?: ReadonlyMap<string, string>;
  /** The account's workspace document names these rooms for notebooks (it changed, or this is its first state). */
  onSharedRooms?(rooms: ReadonlyMap<string, string>): void;
}

/** How many pages of the account this device still has to download for its offline copies. */
export interface OfflineProgress {
  remaining: number;
  total: number;
}

export interface UsePersonalSpaceSyncResult {
  descriptor: SpaceDescriptor | null;
  /** Set while pages are downloaded in the background; null when every page is stored (or none is wanted). */
  offlineProgress: OfflineProgress | null;
  /** Forces an immediate flush of any pending materialisation/upload. */
  syncNow(): void;
  /** Stops the session; keeps the link record and the local workspace (§6.8). */
  signOut(): void;
  /** P8 "add local notebooks to the account": they join the account as additional notebooks, nothing is removed. */
  addLocalToAccount(): void;
  /**
   * P8 "discard this device's notebooks": the account's workspace replaces them. Destructive; call it
   * only after the person confirmed. "Keep only on this device" needs no call: without a link the
   * workspace stays local and unsynced.
   */
  discardLocalForAccount(): void;
  /** Forgets the share room of a notebook the person left, for every device of the account. */
  clearSharedRoom(notebookDocumentId: string): void;
  /**
   * Lazy asset download (§5.7): kicks off (or joins) a remote fetch for an asset the local
   * activation does not have yet, batching the result into a later `commitWorkspaceGraphRevision`
   * via `AssetSyncQueue.requestAsset`. A no-op (resolves `undefined`) whenever no session is open
   * (personal space disabled, still bootstrapping, ...) — safe to call unconditionally, the same
   * way `personalSpaceAssetRepository` (`runtimeAssetRepository.ts`) expects to call it.
   */
  requestAsset(assetId: string, options?: AssetRequestOptions): Promise<Uint8Array | undefined>;
}

interface PendingLinkChoice {
  spaceId: string;
  remoteDocCount: number;
}

export function usePersonalSpaceSync(options: UsePersonalSpaceSyncOptions): UsePersonalSpaceSyncResult {
  const { runtime, workspace, syncUrl, auth, enabled, onWorkspaceReplaced, onNotice, onStatus, sharedRooms, onSharedRooms } = options;

  // Whether the device has a network. The socket cannot tell an offline phone from an
  // unreachable server, so the device state turns "reconnecting" into "offline" (applyDeviceNetwork).
  const onlineRef = useRef(typeof navigator === 'undefined' ? true : navigator.onLine);
  const rawStatusRef = useRef<SpaceStatus>({ kind: 'disabled' });
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  });
  const reportStatus = useCallback((status: SpaceStatus): void => {
    rawStatusRef.current = status;
    onStatusRef.current(applyDeviceNetwork(status, onlineRef.current));
  }, []);
  useEffect(() => {
    const change = (online: boolean) => () => {
      if (onlineRef.current === online) return;
      onlineRef.current = online;
      onStatusRef.current(applyDeviceNetwork(rawStatusRef.current, online));
    };
    const goOnline = change(true);
    const goOffline = change(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const [descriptor, setDescriptor] = useState<SpaceDescriptor | null>(null);
  // Bumped to re-run the bootstrap after a failed first contact (see the bootstrap effect).
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const pendingLinkChoiceRef = useRef<PendingLinkChoice | null>(null);

  const sessionRef = useRef<PersonalSpaceSession | null>(null);
  // The shell's first render must not pay for Automerge's first call (WebAssembly warm-up) nor
  // build the account document: until a session opens, an empty document stands in, and
  // `openSession` creates the real one. `useRef(Automerge.init())` would build one on every render,
  // and the notebook shell renders on every keystroke; the initializer form runs once.
  const [initialWorkspaceDoc] = useState(() => Automerge.init<SpaceWorkspaceDocV1>());
  const workspaceDocRef = useRef<Automerge.Doc<SpaceWorkspaceDocV1>>(initialWorkspaceDoc);
  const workspaceDocAnnouncedRef = useRef(false);
  // `true` once `workspaceDocRef.current` shares Automerge ancestry with the room's
  // `workspace:root` history — either because this session pushed its own local doc as the seed
  // (§2.3 PUSH bootstrap) or because a prior `workspace:root` `docsChanged` event already adopted
  // the room's doc wholesale (see the `bindSpacePort` docs-changed handler below for why the very
  // first adoption in a PULL/normal-bootstrap session must be a replace, not an
  // `Automerge.merge`). `initWorkspaceDoc()`'s freshly-created root map objects (`notebooks`,
  // `pages`) and the room's independently-created ones have no common ancestor: found via
  // repeated `personal-space.spec.ts` V5 runs that `Automerge.merge(freshLocalDoc, remoteDoc)`
  // resolves that concurrent-creation conflict via Automerge's own (from this caller's
  // perspective, arbitrary) tie-break — sometimes keeping the freshly-created *empty* local map
  // instead of the remote's populated one, silently discarding every notebook/page the room ever
  // had. Once this is `true`, `workspaceDocRef.current` descends from the same root the room's
  // replies do, so merging further incremental updates is the correct, safe operation.
  const workspaceDocAdoptedRemoteRef = useRef(false);
  const onSharedRoomsRef = useRef(onSharedRooms);
  useEffect(() => {
    onSharedRoomsRef.current = onSharedRooms;
  });
  // What was last told to `onSharedRooms`, so an unchanged document does not notify again.
  const reportedSharedRoomsRef = useRef('');
  const reportSharedRooms = useCallback((): void => {
    const notify = onSharedRoomsRef.current;
    if (!notify) return;
    const rooms = new Map<string, string>();
    for (const [documentId, entry] of Object.entries(workspaceDocRef.current.notebooks)) {
      if (entry.sharedRoomId && !entry.deletedAt && !entry.purgedAt) rooms.set(documentId, entry.sharedRoomId);
    }
    const key = JSON.stringify([...rooms].sort());
    if (key === reportedSharedRoomsRef.current) return;
    reportedSharedRoomsRef.current = key;
    notify(rooms);
  }, []);
  // The document binding (`bindPersonalSpace`): local changes of every document come from the
  // runtime's document change feed, remote ones are merged through the runtime whether or not
  // the page is open, so nothing here has to be rebound when a page is loaded, evicted or
  // changed by a topology commit.
  const bindingRef = useRef<PersonalSpaceBinding | null>(null);
  // Which docIds this device announced to the room (`session.announceDoc` + an initial
  // snapshot). Survives a reopened session so a doc is never announced twice.
  const announcedToRoomRef = useRef<Set<string>>(new Set());
  const assetQueueRef = useRef<AssetSyncQueue | null>(null);
  const inkSyncRef = useRef<InkSegmentSync | null>(null);
  const catchUpDoneRef = useRef(false);
  const schedulePublishRef = useRef<() => void>(() => undefined);
  // Set after a large publish: the next acknowledgement of the workspace document compacts it,
  // so that a new device receives it as one snapshot instead of the big change.
  const compactWorkspaceOnAckRef = useRef(false);
  // Snapshot, taken exactly once when a PULL/normal-bootstrap session opens (`openSession`), of
  // the bundled starter's own notebook + page document ids — `undefined` whenever the local
  // workspace was not pristine to begin with. See `scheduleCatchUp`'s `pristineNow` doc comment
  // for why this must not be recomputed fresh on every flush.
  const pristineStarterIdsRef = useRef<string[] | undefined>(undefined);
  // `false` once the bootstrap found typed text in the bundled starter: the starter then holds the
  // person's own content and is never disposable, however small it is. `true` otherwise (a device
  // that is already linked keeps the structure-only check; its starter documents are the account's).
  const starterUntouchedRef = useRef(true);
  // Set after the person confirmed to discard this device's notebooks for the account's: the next
  // catch-up treats every local document like the pristine starter and removes it in the same
  // transaction in which it adopts the account's. Cleared once that commit happened.
  const discardLocalRef = useRef(false);
  // A hand-rolled debounce around `applySpacePlan` (rather than the `createSpacePlanMaterializer`
  // helper from `materialize.ts`): that helper's `schedule()` is fire-and-forget, so its caller
  // never learns the resulting `V2RuntimeState` and cannot forward it to `onWorkspaceReplaced`.
  // Wave 5 integration needs that state (adopted notebooks/pages must actually appear in the UI
  // after catch-up), so this keeps the same debounce contract (§5.5: a burst of `docsChanged`
  // events during a large catch-up still produces exactly one transaction) while calling
  // `applySpacePlan` directly and awaiting its result.
  const catchUpTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const catchUpPendingRef = useRef<{ getPlan: () => Promise<SpacePlan>; getOptions: () => ApplySpacePlanOptions; shouldClosePristineWindow: () => boolean } | null>(null);
  // `scheduleCatchUp` assigns itself here once defined, so `flushCatchUp` (defined first, to keep
  // `scheduleCatchUp`'s own debounced-timer closure simple) can still call it back for the retry
  // below without a circular `useCallback` dependency.
  const scheduleCatchUpRef = useRef<() => void>(() => undefined);
  // How many times, in a row, the catch-up watchdog (see `catchUpWatchdogTimerRef` below) has
  // kicked a still-pristine session. Bounds the watchdog so a permanently broken connection does
  // not retry forever.
  const catchUpRetryCountRef = useRef(0);
  // The resume record last written, and the timer that refreshes it while a session is open.
  const resumeWrittenRef = useRef<string | undefined>(undefined);
  const resumeTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Documents received but not yet handed to the adoption workers (see `onRemoteDocAdded`).
  const prewarmQueueRef = useRef(new Map<string, 'notebook' | 'page'>());
  const prewarmTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // True while a catch-up flush is planning, preparing or committing.
  const catchUpFlushingRef = useRef(false);
  // Bytes the session held at the previous watchdog tick, to tell a live replay from a stalled one.
  const lastReceivedBytesRef = useRef(0);
  // The spaceId the currently-open session was opened against, so the watchdog can force a
  // brand-new WebSocket connection (a fresh server-side replay-on-connect) — see
  // `reopenSessionRef`'s doc comment for why.
  const activeSpaceIdRef = useRef<string | undefined>(undefined);
  // Set once `openSession` is defined (same ref-forwarding pattern as `scheduleCatchUpRef`, to
  // avoid a circular `useCallback` dependency): tears down and reopens the room connection for
  // `activeSpaceIdRef.current`. Needed because a merely-recomputed `getPlan` against whatever
  // `workspaceDocRef.current` already holds can never become more complete on its own if no
  // further `docsChanged` frame ever arrives for this connection (observed in practice: a brand
  // new client's very first server-side replay can occasionally come up short — or, worse, never
  // fire a `docsChanged` callback at all for a doc it eventually should — with nothing about the
  // *existing* connection ever prompting a natural retry once the first device goes quiet).
  // Forcing a whole new connection re-triggers the server's replay computation from scratch.
  const reopenSessionRef = useRef<() => void>(() => undefined);
  // Independent watchdog (deliberately NOT driven by `flushCatchUp`'s own retry-after-a-real-flush
  // logic, which only ever runs if at least one real `docsChanged` callback already fired for this
  // connection): ticks unconditionally, once a second, from the moment a PULL/normal-bootstrap
  // session opens (`openSession`'s `seedDoc === undefined` branch), for as long as
  // `!catchUpDoneRef.current`, whether or not any `docsChanged` frame has ever arrived at all.
  // See `startCatchUpWatchdog`'s own doc comment for why this had to move out of `flushCatchUp`.
  const catchUpWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Asset ids currently mid-upload. The upload-diff effect below re-runs on every `workspace`
  // change, and `workspace` now also changes on every adopted catch-up commit (not just the
  // user's own edits) — without this guard, a catch-up landing while an upload from an earlier
  // run of the same effect is still in flight would recompute the same "missing" diff (the
  // asset is not yet recorded in `workspaceDocRef.current.assets`, since that only happens once
  // the upload actually finishes) and start a second, duplicate concurrent upload for it.
  const uploadingAssetIdsRef = useRef<Set<string>>(new Set());
  // Pages this device lists but does not store yet are downloaded in the background (see
  // `hydratePages`). `demandedPagesRef` holds the ones the user asked for by opening them.
  const workspaceApplyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const applyPendingWorkspaceDocRef = useRef<() => void>(() => undefined);
  const hydratingRef = useRef(false);
  const demandedPagesRef = useRef(new Set<string>());
  const downloadAttemptsRef = useRef(new Map<string, number>());
  const hydrateRef = useRef<() => Promise<void>>(async () => undefined);
  const persistResumeRef = useRef<() => void>(() => undefined);
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rewriteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rewriteAttemptsRef = useRef(0);
  const rewriteRunnerRef = useRef<() => void>(() => undefined);
  const examinedSummariesRef = useRef(new WeakSet<object>());
  const [offlineProgress, setOfflineProgress] = useState<OfflineProgress | null>(null);

  const isSignedIn = auth.available && auth.isSignedIn;
  const userId = auth.available ? auth.user?.id : undefined;

  const resolveJwt = useCallback(async (): Promise<string> => {
    if (!auth.available) throw new Error('Auth is not available.');
    const jwt = await auth.getToken();
    if (!jwt) throw new Error('No auth token is available.');
    return jwt;
  }, [auth]);

  const httpConfig = useMemo(() => (syncUrl ? { syncUrl } : null), [syncUrl]);

  const sendWorkspaceDocDelta = useCallback((priorHeads: string[]) => {
    const session = sessionRef.current;
    if (!session) return;
    if (!workspaceDocAnnouncedRef.current) {
      workspaceDocAnnouncedRef.current = true;
      session.announceDoc(SPACE_WORKSPACE_DOC_ID, 'workspace');
      session.sendSnapshot(SPACE_WORKSPACE_DOC_ID, saveWorkspaceDoc(workspaceDocRef.current), 0);
      return;
    }
    const bytes = Automerge.saveSince(workspaceDocRef.current, priorHeads);
    if (bytes.byteLength === 0) return;
    session.sendLocalChange(SPACE_WORKSPACE_DOC_ID, bytes);
  }, []);

  const mutateWorkspaceDoc = useCallback((change: Automerge.ChangeFn<SpaceWorkspaceDocV1>) => {
    const before = Automerge.getHeads(workspaceDocRef.current);
    workspaceDocRef.current = Automerge.change(workspaceDocRef.current, change);
    sendWorkspaceDocDelta(before);
  }, [sendWorkspaceDocDelta]);

  // A workspace document that grew large through rewritten summaries is replaced once by a copy without
  // its history (see `rewriteWorkspaceDoc`). Only a device that holds the room's document and finished
  // its first catch-up does it, and only when the result is much smaller.
  const rewriteBloatedWorkspaceDoc = useCallback((): void => {
    const session = sessionRef.current;
    if (!session || !session.isLive()) return;
    // The first adoption of the room's document and the first catch-up come first; look again shortly.
    if (!catchUpDoneRef.current || !workspaceDocAdoptedRemoteRef.current || workspaceApplyTimerRef.current !== undefined) {
      if (rewriteAttemptsRef.current < WORKSPACE_REWRITE_ATTEMPTS) {
        rewriteAttemptsRef.current += 1;
        rewriteTimerRef.current = setTimeout(() => rewriteRunnerRef.current(), WORKSPACE_REWRITE_DELAY_MS);
      }
      return;
    }
    const roomBytes = session.getDocBytes(SPACE_WORKSPACE_DOC_ID)?.byteLength ?? 0;
    if (roomBytes < WORKSPACE_REWRITE_MIN_BYTES) return;
    const seq = session.getDocSeq(SPACE_WORKSPACE_DOC_ID);
    if (seq === undefined) return;
    const rewritten = rewriteWorkspaceDoc(workspaceDocRef.current);
    const bytes = saveWorkspaceDoc(rewritten);
    if (bytes.byteLength * WORKSPACE_REWRITE_MIN_RATIO > roomBytes) return;
    workspaceDocRef.current = rewritten;
    session.replaceDoc(SPACE_WORKSPACE_DOC_ID, bytes, seq);
  }, []);
  useEffect(() => {
    rewriteRunnerRef.current = rewriteBloatedWorkspaceDoc;
  }, [rewriteBloatedWorkspaceDoc]);

  const flushCatchUp = useCallback(async (): Promise<void> => {
    if (catchUpTimerRef.current !== undefined) {
      clearTimeout(catchUpTimerRef.current);
      catchUpTimerRef.current = undefined;
    }
    // One flush at a time: adopting a large account takes seconds, and a second flush that
    // started meanwhile would plan and prepare the same documents again and then fail on the
    // activation the first one committed. What was scheduled meanwhile stays pending and is
    // re-armed once this flush finished.
    if (catchUpFlushingRef.current) return;
    const pending = catchUpPendingRef.current;
    catchUpPendingRef.current = null;
    if (!pending || !runtime) return;
    catchUpFlushingRef.current = true;
    try {
    let plan: SpacePlan;
    try {
      plan = await pending.getPlan();
    } catch (error) {
      // Planning failed (the room did not answer, a document was unreadable): the watchdog and the
      // next received document plan again.
      console.warn('[personal-space] catch-up planning failed; will retry on the next scheduleCatchUp', error);
      return;
    }
    const options = pending.getOptions();
    const state = runtime.getState();
    // §2.4's purge can remove the notebook/page the manifest's `active` target currently names
    // (see `deriveActiveFromAdoptedDocuments`'s doc comment) — `applySpacePlan` has no way to
    // repair that, so when it would leave `active` dangling, bypass it for a direct
    // `commitWorkspaceGraphRevision` that also fixes `active` up, in the very same transaction.
    const activeStillValid = state.schemaVersion === 1 || (() => {
      const activeNotebook = state.notebooks.find((notebook) => notebook.notebookId === state.activation.manifest.active.notebookId);
      return activeNotebook !== undefined && plan.notebookDocumentIds.includes(activeNotebook.documentId);
    })();
    // A failed commit here must never be silent: this is the one place a catch-up plan can drop
    // an adopted notebook/page on the floor without the room ever being told, and the retry this
    // schedules (see `shouldClosePristineWindow`'s doc comment) only helps if the failure is
    // actually visible somewhere while diagnosing it — `console.warn` (not `.error`, which the
    // e2e suite's `runtimeGuard` treats as a hard test failure for *any* unexpected occurrence)
    // surfaces it in the browser console without turning a merely-transient, self-healing race
    // into a spurious end-to-end failure.
    const logCatchUpCommitFailure = (site: string, error: unknown): null => {
      console.warn(`[personal-space] catch-up commit failed (${site}); will retry on the next scheduleCatchUp`, error);
      // A local commit that won the race leaves the plan stale: plan again from the newer state.
      if (/changed before the topology transaction/i.test(String(error))) scheduleCatchUpRef.current();
      return null;
    };
    // The plan is applied in commits of bounded size (see `applySpacePlan`); the commit that
    // removes the pristine starter also moves the active target to a page of the account.
    const replacement = activeStillValid
      ? undefined
      : await deriveActiveFromAdoptedDocuments(plan.adoptedDocuments, state.schemaVersion);
    const next = activeStillValid || replacement
      ? await applySpacePlan(runtime, plan, {
        ...options,
        ...(replacement ? { finalizeManifest: (manifest) => { manifest.active = replacement; } } : {}),
      }).catch((error: unknown) => logCatchUpCommitFailure(replacement ? 'repair-active applySpacePlan' : 'applySpacePlan', error))
      : null; // Nothing safe to activate yet; defer to a later catch-up.
    // See `shouldClosePristineWindow`'s doc comment: only close the window once this round's
    // plan was actually committed. A thrown/failed commit must leave it open for a retry.
    if (next && pending.shouldClosePristineWindow()) {
      catchUpDoneRef.current = true;
      // The discard the person confirmed has happened; a later reconnect must not discard again.
      discardLocalRef.current = false;
    }
    if (next) {
      onWorkspaceReplaced(next);
      // Adopted documents need nothing more here: the commit reports them as added documents,
      // the port starts their change tracking at the adopted heads (the room's), and the binding
      // subscribes them through the port's document-set notification. They came from the room,
      // so the push after the first catch-up finds them there and never announces them again.
      // Once the first catch-up closed, local documents the room lacks (a device that added its
      // own notebooks to the account) are announced now.
      if (catchUpDoneRef.current) {
        void bindingRef.current?.pushLocal();
        schedulePublishRef.current();
        void hydrateRef.current();
      }
    }
    } finally {
      catchUpFlushingRef.current = false;
      if (catchUpPendingRef.current && catchUpTimerRef.current === undefined) {
        catchUpTimerRef.current = setTimeout(() => {
          catchUpTimerRef.current = undefined;
          void flushCatchUp();
        }, catchUpDoneRef.current ? SPACE_ADOPT_BATCH_MS : SPACE_FIRST_ADOPT_MS);
      }
    }
  }, [runtime, onWorkspaceReplaced]);

  const scheduleCatchUp = useCallback(() => {
    if (!runtime) return;
    // Shared between this schedule's `getPlan`/`getOptions` (always called as a pair, `getPlan`
    // first, by `flushCatchUp`): whether *this* flush should durably close off the "still
    // pristine, first catch-up" window. It must NOT close automatically on every flush — see
    // the `hasAdoptedNotebook` guard below for why.
    let closePristineWindow = false;
    // The activation this round's plan is projected from (set by `getPlan`, read by `getOptions`).
    let plannedFromFingerprint: Sha256Checksum | undefined;
    catchUpPendingRef.current = {
      getPlan: async () => {
        applyPendingWorkspaceDocRef.current();
        const state = runtime.getState();
        plannedFromFingerprint = state.schemaVersion === 1 ? undefined : state.activation.artifactFingerprint;
        if (state.schemaVersion === 1) {
          return {
            adoptedDocuments: [], placeholderPages: [], removedDocumentIds: [], notebookDocumentIds: [],
            pageDocumentIds: [], trashAdditions: [], trashRemovals: [],
          };
        }
        // §2.4: while the local workspace is still the untouched pristine starter (bundled
        // sample), its documentIds must not count as "already local" for adoption purposes.
        // The bundled sample's page carries a fixed, well-known documentId
        // (`BUNDLED_START_PAGE_ID`, shared by every install created before 2026-09-25, not random per
        // device), so a genuine account notebook that legitimately owns *that exact page* (the
        // very common case: device A did nothing but rename the starter notebook and edit its
        // starter page before this device ever pulled) would otherwise be judged "not adoptable"
        // for that one page, since `projectSpacePlan` treats any documentId already present in
        // `activation.documents` as already-owned-and-current, never something to replace. Hiding
        // the pristine starter's own documentIds from the activation snapshot handed to
        // `projectSpacePlan` (only for this one, first, still-pristine catch-up) makes that page
        // adoptable like any other, and its content is genuinely replaced by the adopted remote
        // bytes rather than kept — correct, because the local copy is about to be discarded
        // anyway. The starter's remaining, non-colliding documents (which by definition cannot be
        // remote-adoptable, since `remoteDocBytes` never holds locally-invented ids) simply drop
        // out of the plan instead, and are removed explicitly below, in the SAME transaction —
        // never a later one, which would instead have to purge a page a freshly-adopted notebook
        // still lists in its sections, and fail the same referential-integrity check the other way.
        // Deliberately NOT `isLocalWorkspacePristine(state)` recomputed fresh every flush: a
        // still-open pristine window can, by design (see the `hasAdoptedNotebook` guard just
        // below), legitimately adopt an orphan page (a page whose notebook has not landed yet)
        // *before* closing the window. That adoption adds a brand-new document to `state.pages`
        // — recomputing "is this still structurally the bundled sample" from `state` on the next
        // flush would then see one extra page and (correctly, but unhelpfully) conclude the
        // workspace is no longer pristine, permanently closing the window and abandoning the
        // purge before the notebook itself ever arrived. `pristineStarterIdsRef` instead snapshots
        // the *original* starter's own document ids exactly once, when this session first opened
        // (`openSession`), so every flush in the same still-open window agrees on exactly which
        // ids the starter contributed, regardless of how many orphan pages get adopted alongside
        // it in between.
        // A device that already synced its starter (it pushed it, or adopted it before) looks
        // just as "pristine" by structure, but its starter documents are the account's own: the
        // room's copies share their history. Treating them as disposable would replace them with
        // the room's copies and drop edits this device has not sent yet. Only a copy with an
        // unrelated history (another install's bundled start page) may be replaced.
        const session = sessionRef.current;
        const roomBytes = (documentId: string): Uint8Array | undefined => session?.getDocBytes(documentId);
        // A confirmed discard skips this: the person asked for the account's copies to win.
        if (!catchUpDoneRef.current && pristineStarterIdsRef.current !== undefined && !discardLocalRef.current) {
          let starterIsAccounts = false;
          for (const documentId of pristineStarterIdsRef.current) {
            const remoteBytes = roomBytes(documentId);
            if (!remoteBytes || !state.activation.documents.some((document) => document.documentId === documentId)) continue;
            // One starter document at a time; a page that is not loaded is read for this check only.
            if (await runtime.readDocument(documentId, (local) => sharesHistory(local as Automerge.Doc<object>, remoteBytes))) {
              starterIsAccounts = true;
              break;
            }
          }
          if (starterIsAccounts) pristineStarterIdsRef.current = undefined;
        }
        const pristineNow = !catchUpDoneRef.current && pristineStarterIdsRef.current !== undefined;
        const starterIdSet = new Set(pristineNow ? pristineStarterIdsRef.current : []);
        const projectionActivation = pristineNow
          ? { ...state.activation, documents: state.activation.documents.filter((document) => !starterIdSet.has(document.documentId)) }
          : state.activation;
        // Only documents this device would adopt need their bytes: the ones the account's
        // workspace doc lists and the projection's activation does not hold (a placeholder page
        // is listed but not held). They are read from the session's compact copies instead of
        // being kept in a second map.
        const placeholderIds = new Set(runtime.listPlaceholderDocuments());
        const heldIds = new Set(
          projectionActivation.documents.map((document) => document.documentId).filter((documentId) => !placeholderIds.has(documentId)),
        );
        const localPagePlacement = new Map<string, { notebookId: string; sectionId: string }>();
        for (const notebook of state.notebooks) {
          if (starterIdSet.has(notebook.documentId)) continue;
          for (const section of notebook.sections) {
            for (const pageDocumentId of section.pageDocumentIds) {
              localPagePlacement.set(pageDocumentId, { notebookId: notebook.notebookId, sectionId: section.id });
            }
          }
        }
        // A page nobody published a summary for cannot be listed before it is downloaded (an
        // account written before summaries were published, or a page another device just
        // added): those pages are fetched first, all at once, and adopted with the plan.
        const live = sessionRef.current;
        if (live?.isLive()) {
          const unlisted = Object.entries(workspaceDocRef.current.pages)
            .filter(([documentId, entry]) => !entry.purgedAt
              && !heldIds.has(documentId)
              && !placeholderIds.has(documentId)
              && live.getDocs().has(documentId)
              && !live.holdsDoc(documentId)
              && !parsePublishedSummary(entry.summary, documentId))
            .map(([documentId]) => documentId);
          if (unlisted.length > 0) await live.fetchDocs(unlisted).catch(() => undefined);
        }
        const project = async (): Promise<SpacePlan> => {
          const remoteDocBytes = new Map<string, Uint8Array>();
          for (const documentId of [...Object.keys(workspaceDocRef.current.notebooks), ...Object.keys(workspaceDocRef.current.pages)]) {
            if (heldIds.has(documentId)) continue;
            const bytes = roomBytes(documentId);
            if (bytes) remoteDocBytes.set(documentId, bytes);
          }
          // The notebooks a plan adopts are read in the adoption workers (and by the commit that
          // follows, which shares the result), not loaded here for every plan.
          const decodedNotebooks = new Map<string, DecodedNotebook>();
          await Promise.all(Object.keys(workspaceDocRef.current.notebooks).map(async (documentId) => {
            const bytes = remoteDocBytes.get(documentId);
            if (!bytes || workspaceDocRef.current.notebooks[documentId]?.purgedAt) return;
            const prepared = await previewAdoptedDocument({ documentId, kind: 'notebook', bytes }, state.schemaVersion);
            if (prepared?.notebook) decodedNotebooks.set(documentId, toDecodedNotebook(prepared.notebook));
          }));
          return projectSpacePlan({
            workspaceDoc: workspaceDocRef.current,
            remoteDocBytes,
            activation: projectionActivation,
            placeholderDocumentIds: placeholderIds,
            localPagePlacement,
            decodedNotebooks,
          });
        };
        let basePlan = await project();
        if (pristineNow) {
          // The page the view lands on after the first catch-up must be a stored page, not a
          // placeholder: it is downloaded ahead of the others, and the commit adopts it with the notebooks.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const landingPageId = await landingPageToDownload(basePlan, state.schemaVersion);
            if (!landingPageId) break;
            const live = sessionRef.current;
            if (!live?.isLive()) break;
            const arrived = await live.fetchDocs([landingPageId]).then(() => live.holdsDoc(landingPageId), () => false);
            if (!arrived) break;
            basePlan = await project();
          }
        }
        if (!pristineNow || starterIdSet.size === 0) {
          // Nothing left to purge (either already done, or the local workspace was never the
          // untouched starter to begin with): this catch-up is unremarkable, close the window.
          closePristineWindow = true;
          return basePlan;
        }
        // Do not purge the pristine starter notebook (nor mark the pristine window closed) until
        // the account's own notebook has actually been adopted this round. `docsChanged` for
        // `workspace:root` and for the account's other documents arrive as independent WS
        // frames — nothing guarantees they land within the same debounce window — so a flush can
        // legitimately fire with the workspace doc already merged but zero notebook/page bytes
        // received yet. Purging the local starter *then* would leave the workspace with no
        // notebook at all (the active-context invariant would break) and, since the "first
        // catch-up" window would already be marked closed, permanently forfeit the chance to
        // fold the purge into a later, better-informed transaction (see the `usePersonalSpaceSync
        // .test.ts`-adjacent Wave 5 report for how this was found: intermittently, depending on
        // WS frame arrival order).
        const hasAdoptedNotebook = basePlan.adoptedDocuments.some((doc) => doc.kind === 'notebook');
        if (!hasAdoptedNotebook) return basePlan;
        closePristineWindow = true;
        const adoptedIdSet = new Set(basePlan.adoptedDocuments.map((doc) => doc.documentId));
        // A starter id that was just adopted under the same id (the colliding-page case above)
        // stays in the manifest lists, but its local root must still leave in this transaction:
        // listing it as removed as well lets the storage stage replace the local document with
        // the adopted bytes. Without that the commit fails with "collides with an existing root"
        // on every retry and a fresh second device never shows the account's notebooks.
        const replacedStarterIds = [...starterIdSet].filter((id) => adoptedIdSet.has(id));
        const removeStarterIds = [...starterIdSet].filter((id) => !adoptedIdSet.has(id));
        if (removeStarterIds.length === 0 && replacedStarterIds.length === 0) return basePlan;
        // `projectSpacePlan`'s own "local-only" pass-through for manifest ids
        // (`activation.manifest.notebookDocumentIds`/`pageDocumentIds`) is independent of the
        // `documents` list hidden above — the starter's ids still leak into `basePlan`'s output
        // lists via the manifest, so they need filtering out here too, explicitly.
        return {
          ...basePlan,
          removedDocumentIds: [...basePlan.removedDocumentIds, ...removeStarterIds, ...replacedStarterIds],
          notebookDocumentIds: basePlan.notebookDocumentIds.filter((id) => !removeStarterIds.includes(id)),
          pageDocumentIds: basePlan.pageDocumentIds.filter((id) => !removeStarterIds.includes(id)),
        };
      },
      getOptions: () => ({
        operationId: `space-catch-up-${Date.now()}`,
        message: 'Personal-space catch-up',
        ...(plannedFromFingerprint ? { plannedFromFingerprint } : {}),
      }),
      // Deliberately NOT read/applied inside `getOptions` (before the commit even runs): the
      // pristine window must only close once this round's plan was actually *committed*, not
      // merely computed. `getPlan` can decide `closePristineWindow = true` and then have the
      // commit itself throw (e.g. the `commitWorkspaceGraphRevision` "collides with an existing
      // root" race) or resolve `next === null` for any other reason — in both cases nothing was
      // actually adopted, so the window must stay open for a later flush to retry, otherwise the
      // watchdog (gated on `catchUpDoneRef.current`) permanently stops nudging and this device
      // never adopts anything, ever, for the rest of the session.
      shouldClosePristineWindow: () => closePristineWindow,
    };
    if (catchUpTimerRef.current !== undefined) clearTimeout(catchUpTimerRef.current);
    catchUpTimerRef.current = setTimeout(() => {
      catchUpTimerRef.current = undefined;
      void flushCatchUp();
    }, catchUpDoneRef.current ? SPACE_ADOPT_BATCH_MS : SPACE_FIRST_ADOPT_MS);
  }, [runtime, flushCatchUp]);
  useEffect(() => {
    scheduleCatchUpRef.current = scheduleCatchUp;
  }, [scheduleCatchUp]);

  /**
   * Waits until what the session received has been adopted: the binding hands received documents
   * to the catch-up, whose plan is then applied right away instead of after the debounce.
   */
  const settleAdoption = useCallback(async (): Promise<void> => {
    await bindingRef.current?.idle();
    for (let round = 0; round < 400; round += 1) {
      if (catchUpFlushingRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (!catchUpPendingRef.current) return;
      await flushCatchUp();
    }
  }, [flushCatchUp]);

  /**
   * Pages to request from the room, most wanted first: the ones the user opened, pages that have
   * no published summary (they cannot be listed before they are downloaded), the placeholders
   * (newest first, only when offline copies are kept) and pages this device stores but whose
   * state in the room is unknown (a device without a resume record), which are reconciled.
   */
  const pagesToDownload = useCallback((keepAll: boolean): string[] => {
    const session = sessionRef.current;
    if (!session || !runtime) return [];
    const state = runtime.getState();
    if (state.schemaVersion === 1) return [];
    const known = new Set(state.activation.documents.map((document) => document.documentId));
    const placeholders = new Set(runtime.listPlaceholderDocuments());
    const summaries = new Map(state.pages.map((page) => [page.documentId, page] as const));
    const attempts = downloadAttemptsRef.current;
    const wanted: Array<{ documentId: string; rank: number; updatedAt: string }> = [];
    for (const [documentId, entry] of Object.entries(workspaceDocRef.current.pages)) {
      if (entry.purgedAt || session.holdsDoc(documentId) || !session.getDocs().has(documentId)) continue;
      if ((attempts.get(documentId) ?? 0) >= 3) continue;
      const demanded = demandedPagesRef.current.has(documentId);
      if (placeholders.has(documentId)) {
        wanted.push({ documentId, rank: demanded ? 0 : 2, updatedAt: summaries.get(documentId)?.updatedAt ?? '' });
      } else if (!known.has(documentId) && !parsePublishedSummary(entry.summary, documentId)) {
        wanted.push({ documentId, rank: demanded ? 0 : 1, updatedAt: '' });
      }
    }
    // Local pages the room has but never sent: nothing can be pushed for them until the room's state is known.
    for (const [documentId, entry] of session.getDocs()) {
      if (entry.kind !== 'page' || !session.awaitsFetch(documentId) || !runtime.isDocumentAvailable(documentId)) continue;
      if ((attempts.get(documentId) ?? 0) >= 3) continue;
      wanted.push({ documentId, rank: 3, updatedAt: '' });
    }
    return wanted
      .filter((page) => page.rank >= 3 || page.rank <= 1 || keepAll)
      .sort((left, right) => left.rank - right.rank || right.updatedAt.localeCompare(left.updatedAt))
      .map((page) => page.documentId);
  }, [runtime]);

  /**
   * Downloads the pages this device lists but does not store, a few at a time, once the first
   * catch-up finished. Each batch is adopted in bounded commits before the next is requested, so
   * the storage queue stays free for the user's own saves. Only opened pages are wanted when the
   * device keeps no offline copies.
   */
  const hydratePages = useCallback(async (): Promise<void> => {
    if (hydratingRef.current || !runtime) return;
    hydratingRef.current = true;
    let total = 0;
    try {
      for (;;) {
        const session = sessionRef.current;
        if (!session || !session.isLive() || !catchUpDoneRef.current) return;
        const targets = pagesToDownload(loadOfflineCopiesPolicy() === 'all');
        total = Math.max(total, targets.length);
        setOfflineProgress(targets.length === 0 ? null : { remaining: targets.length, total });
        if (targets.length === 0) {
          // Every page is here: the next visit resumes from what this device holds, also when the tab closes without a pagehide.
          persistResumeRef.current();
          return;
        }
        const batch = targets.slice(0, HYDRATE_BATCH_DOCS);
        for (const documentId of batch) {
          downloadAttemptsRef.current.set(documentId, (downloadAttemptsRef.current.get(documentId) ?? 0) + 1);
        }
        // A dropped connection ends the pass; the next `synced` starts it again.
        const arrived = await session.fetchDocs(batch).then(() => true, () => false);
        if (!arrived) return;
        await settleAdoption();
        // What the room held of pages this device stores is known now: push what it lacks.
        void bindingRef.current?.pushLocal();
        // The background download has the lowest priority: the next batch waits for idle time, so a
        // click, typing or scrolling is served before it (it still goes on after `HYDRATE_IDLE_TIMEOUT_MS`).
        await whenIdle(HYDRATE_IDLE_TIMEOUT_MS, HYDRATE_PAUSE_MS);
      }
    } finally {
      hydratingRef.current = false;
    }
  }, [runtime, pagesToDownload, settleAdoption]);
  useEffect(() => {
    hydrateRef.current = hydratePages;
  }, [hydratePages]);

  /** The user opened (or an export needs) a page that is only listed: fetch it ahead of the background pass. */
  const requestPage = useCallback((documentId: string): void => {
    demandedPagesRef.current.add(documentId);
    downloadAttemptsRef.current.delete(documentId);
    const session = sessionRef.current;
    if (!session || !session.isLive()) {
      // Without a live connection the page cannot arrive, and the reader must not wait for it:
      // it fails at once, and the next `synced` downloads the page (it stays in `demandedPagesRef`).
      throw new Error('The account is not connected, so the page cannot be downloaded.');
    }
    void session.fetchDocs([documentId]).then(
      () => settleAdoption(),
      () => runtime?.abandonContentRequest(documentId, 'The connection dropped before the page arrived.'),
    );
  }, [runtime, settleAdoption]);

  /**
   * Publishes the summaries of the pages this device holds into the workspace document (see
   * `summariesToPublish`), so that a fresh device can list the account before it holds any page.
   * Debounced without extending: continuous editing still publishes every couple of seconds.
   */
  const publishSummariesNow = useCallback((): void => {
    publishTimerRef.current = undefined;
    if (!sessionRef.current || !catchUpDoneRef.current || !runtime) return;
    const state = runtime.getState();
    if (state.schemaVersion !== 3) return;
    // A summary object is examined once: an edit produces a new one, so unchanged pages cost nothing here.
    const changed = state.pages.filter((page) => !examinedSummariesRef.current.has(page) && runtime.isDocumentAvailable(page.documentId));
    const due = summariesToPublish(workspaceDocRef.current, changed);
    // A page the workspace document does not list yet (its entry follows the topology commit) is looked at again.
    for (const page of changed) if (workspaceDocRef.current.pages[page.documentId]) examinedSummariesRef.current.add(page);
    if (due.length === 0) return;
    if (due.length >= COMPACT_AFTER_PUBLISHED_PAGES) compactWorkspaceOnAckRef.current = true;
    mutateWorkspaceDoc(publishSummaries(due));
  }, [runtime, mutateWorkspaceDoc]);
  const schedulePublish = useCallback((): void => {
    publishTimerRef.current ??= setTimeout(publishSummariesNow, SUMMARY_PUBLISH_DELAY_MS);
  }, [publishSummariesNow]);
  useEffect(() => {
    schedulePublishRef.current = schedulePublish;
  }, [schedulePublish]);
  // A local edit that changes what a page shows reaches the account's summary shortly after.
  useEffect(() => {
    if (workspace && catchUpDoneRef.current && sessionRef.current) schedulePublish();
  }, [workspace, schedulePublish]);

  /**
   * Records which documents this device holds exactly as the room does, so the next visit does
   * not download them again. Only documents whose local copy has the room's heads qualify: a
   * copy with unsent local work, or one not yet adopted, is fetched or reconciled as before.
   */
  const persistResume = useCallback((): void => {
    const session = sessionRef.current;
    const spaceId = activeSpaceIdRef.current;
    if (!session || !runtime || !spaceId) return;
    const docs: ReturnType<PersonalSpaceSession['getResumeState']>['docs'] = {};
    for (const [docId, entry] of Object.entries(session.getResumeState().docs)) {
      if (isWorkspaceDocId(docId)) continue;
      const local = runtime.getDocumentHeads(docId);
      if (local && local.length === entry.heads.length && entry.heads.every((head) => local.includes(head))) docs[docId] = entry;
    }
    resumeWrittenRef.current = saveSpaceResume(spaceId, { docs }, resumeWrittenRef.current);
  }, [runtime]);

  useEffect(() => {
    persistResumeRef.current = persistResume;
  }, [persistResume]);

  const teardownSession = useCallback(() => {
    runtime?.setDocumentContentSource(undefined);
    clearTimeout(workspaceApplyTimerRef.current);
    workspaceApplyTimerRef.current = undefined;
    clearTimeout(publishTimerRef.current);
    publishTimerRef.current = undefined;
    clearTimeout(rewriteTimerRef.current);
    rewriteTimerRef.current = undefined;
    examinedSummariesRef.current = new WeakSet();
    demandedPagesRef.current.clear();
    downloadAttemptsRef.current.clear();
    clearTimeout(prewarmTimerRef.current);
    prewarmTimerRef.current = undefined;
    prewarmQueueRef.current.clear();
    if (resumeTimerRef.current !== undefined) {
      clearInterval(resumeTimerRef.current);
      resumeTimerRef.current = undefined;
    }
    bindingRef.current?.dispose();
    bindingRef.current = null;
    if (catchUpTimerRef.current !== undefined) {
      clearTimeout(catchUpTimerRef.current);
      catchUpTimerRef.current = undefined;
    }
    if (catchUpWatchdogTimerRef.current !== undefined) {
      clearTimeout(catchUpWatchdogTimerRef.current);
      catchUpWatchdogTimerRef.current = undefined;
    }
    catchUpPendingRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    workspaceDocAnnouncedRef.current = false;
    workspaceDocAdoptedRemoteRef.current = false;
    catchUpDoneRef.current = false;
    assetQueueRef.current = null;
    inkSyncRef.current?.stop();
    inkSyncRef.current = null;
    uploadingAssetIdsRef.current.clear();
    announcedToRoomRef.current.clear();
    catchUpRetryCountRef.current = 0;
    lastReceivedBytesRef.current = 0;
    pristineStarterIdsRef.current = undefined;
  }, [runtime]);

  /**
   * Ticks unconditionally, for as long as `!catchUpDoneRef.current`: unlike the retry that used
   * to live at the end of `flushCatchUp`, this does not require a single real `docsChanged`
   * callback to have ever fired for the current connection first. That mattered in practice — a
   * run was observed where a brand-new second device's session sat fully "live" (the WS handshake
   * succeeded) yet never received a single `docsChanged` callback for `workspace:root` or any
   * other doc at all, so `scheduleCatchUp`/`flushCatchUp` never ran even once and nothing was
   * ever in a position to retry itself. Every 5th tick forces a whole new connection
   * (`reopenSessionRef`) rather than only recomputing the plan against unchanged in-memory state
   * (see `reopenSessionRef`'s doc comment); the rest just nudge `scheduleCatchUp` in case a
   * `docsChanged` callback DID fire but the resulting plan came up short (§2.4's own "adopted a
   * page but not the notebook yet" case).
   *
   * The tick interval must stay strictly greater than `SPACE_ADOPT_BATCH_MS`
   * (`scheduleCatchUp`'s own debounce window): `scheduleCatchUp` shares one debounce timer
   * between this watchdog's nudges and every genuine `docsChanged`-triggered call, and merely
   * *scheduling* a flush resets that timer rather than running it — found via repeated
   * `personal-space.spec.ts` V5 runs that a 1-second tick against a 2-second debounce
   * mathematically guarantees `flushCatchUp` never actually executes for as long as the watchdog
   * keeps ticking (every nudge cancels the previous one before it can fire), so a real,
   * already-landed catch-up sat pending, unapplied, for the watchdog's entire ~20-tick budget.
   * `CATCH_UP_WATCHDOG_INTERVAL_MS` leaves a comfortable margin above the debounce window so a
   * quiet gap for the pending flush to actually run always exists between nudges.
   */
  const startCatchUpWatchdog = useCallback((): void => {
    if (catchUpWatchdogTimerRef.current !== undefined) {
      clearTimeout(catchUpWatchdogTimerRef.current);
      catchUpWatchdogTimerRef.current = undefined;
    }
    const tick = (): void => {
      catchUpWatchdogTimerRef.current = undefined;
      if (catchUpDoneRef.current) return;
      if (catchUpRetryCountRef.current >= 20) return;
      // A replay that is still delivering is not stuck. Reconnecting then throws away
      // everything received so far and restarts the whole download, which is what made
      // a large account take minutes; only a replay that stopped growing counts.
      const received = sessionRef.current?.getMemoryDiagnostics().storedBytes ?? 0;
      const progressed = received !== lastReceivedBytesRef.current || catchUpFlushingRef.current;
      lastReceivedBytesRef.current = received;
      if (progressed) {
        scheduleCatchUpRef.current();
        catchUpWatchdogTimerRef.current = setTimeout(tick, CATCH_UP_WATCHDOG_INTERVAL_MS);
        return;
      }
      catchUpRetryCountRef.current += 1;
      const forceReconnect = catchUpRetryCountRef.current % 5 === 0;
      if (forceReconnect) {
        // `reopenSessionRef` calls `openSession` again, which starts a brand new watchdog of its
        // own (see the call at the end of `openSession`) — this tick must not also reschedule
        // itself, or two watchdog loops would run concurrently against the same refs.
        reopenSessionRef.current();
        return;
      }
      scheduleCatchUpRef.current();
      catchUpWatchdogTimerRef.current = setTimeout(tick, CATCH_UP_WATCHDOG_INTERVAL_MS);
    };
    catchUpWatchdogTimerRef.current = setTimeout(tick, CATCH_UP_WATCHDOG_INTERVAL_MS);
  }, []);

  /**
   * `workspace:root` arrived or changed in the room. `bytes` is the session's full copy; loading
   * it gives this device an independent document (the session keeps only compact bytes, and a
   * shared WASM document could otherwise be consumed by the session's next merge).
   */
  const applyPendingWorkspaceDoc = useCallback((): void => {
    clearTimeout(workspaceApplyTimerRef.current);
    workspaceApplyTimerRef.current = undefined;
    const session = sessionRef.current;
    if (!session) return;
    const update = session.takeDocUpdates(SPACE_WORKSPACE_DOC_ID);
    if (!update.full && !update.changes) return;
    // A device that holds the room's document already needs only the changes that came after it:
    // loading the whole document again costs seconds on the main thread for every change a peer makes.
    if (workspaceDocAdoptedRemoteRef.current && !update.full && update.changes) {
      try {
        const applied = Automerge.loadIncremental(workspaceDocRef.current, update.changes);
        // Changes whose dependencies this copy lacks stay queued and invisible; the full copy has them.
        if (Automerge.getMissingDeps(applied, []).length === 0) {
          workspaceDocRef.current = applied;
          reportSharedRooms();
          scheduleCatchUp();
          return;
        }
      } catch {
        // Falls back to the room's full copy below.
      }
    }
    const bytes = session.getDocBytes(SPACE_WORKSPACE_DOC_ID);
    if (!bytes) return;
    const remote = Automerge.load<SpaceWorkspaceDocV1>(bytes);
    // See `workspaceDocAdoptedRemoteRef`'s doc comment: only merge once this device's own
    // `workspaceDocRef.current` shares ancestry with the room's history. The very first
    // adoption in a PULL/normal-bootstrap session instead replaces it outright.
    workspaceDocRef.current = workspaceDocAdoptedRemoteRef.current
      ? Automerge.merge(workspaceDocRef.current, remote)
      : remote;
    workspaceDocAdoptedRemoteRef.current = true;
    reportSharedRooms();
    scheduleCatchUp();
  }, [reportSharedRooms, scheduleCatchUp]);
  useEffect(() => {
    applyPendingWorkspaceDocRef.current = applyPendingWorkspaceDoc;
  }, [applyPendingWorkspaceDoc]);

  /**
   * `workspace:root` arrived or changed in the room. A replay delivers it in many frames; what came
   * is applied once they settled (see `applyPendingWorkspaceDoc`).
   */
  const onRemoteWorkspaceDoc = useCallback((): void => {
    workspaceApplyTimerRef.current ??= setTimeout(applyPendingWorkspaceDoc, WORKSPACE_DOC_SETTLE_MS);
  }, [applyPendingWorkspaceDoc]);

  const openSession = useCallback((spaceId: string, seedDoc?: Automerge.Doc<SpaceWorkspaceDocV1>) => {
    if (!runtime || !syncUrl) return;
    activeSpaceIdRef.current = spaceId;
    if (catchUpTimerRef.current !== undefined) {
      clearTimeout(catchUpTimerRef.current);
      catchUpTimerRef.current = undefined;
    }
    catchUpPendingRef.current = null;
    workspaceDocRef.current = seedDoc ?? initWorkspaceDoc();
    workspaceDocAnnouncedRef.current = false;
    reportedSharedRoomsRef.current = '';
    // PUSH bootstrap (`seedDoc` given) already has genuine local content (this device's own
    // notebooks/pages) baked into `workspaceDocRef.current`'s history — future `workspace:root`
    // arrivals must merge, never replace. PULL/normal-bootstrap (`seedDoc` undefined) starts from
    // a fresh, contentless `initWorkspaceDoc()` with no shared ancestry with the room's own
    // history yet — see `workspaceDocAdoptedRemoteRef`'s doc comment for why its first adoption
    // must replace instead.
    workspaceDocAdoptedRemoteRef.current = seedDoc !== undefined;
    catchUpDoneRef.current = seedDoc === undefined ? false : true;
    // Snapshot the starter's own ids exactly once, here, from the runtime state as it stands
    // right now (before this session's catch-up ever mutates it) — see `pristineStarterIdsRef`'s
    // doc comment for why every later flush must reuse this same snapshot rather than
    // recomputing it from (by then, possibly already partially adopted) live state. A reconnect
    // (`reopenSessionRef`) calls `openSession` again with `seedDoc` still `undefined`, which
    // recomputes this from the runtime's current state at reconnect time — by design, since a
    // genuine local commit unrelated to this catch-up (e.g. a rename) could have happened in the
    // interim and must be reflected.
    const initialState = runtime.getState();
    const disposable = seedDoc === undefined && initialState.schemaVersion !== 1
      && (discardLocalRef.current || (starterUntouchedRef.current && isLocalWorkspacePristine(initialState)));
    pristineStarterIdsRef.current = disposable
      ? [...initialState.notebooks.map((notebook) => notebook.documentId), ...initialState.pages.map((page) => page.documentId)]
      : undefined;

    const flushPrewarm = (): void => {
      prewarmTimerRef.current = undefined;
      const queued = [...prewarmQueueRef.current];
      prewarmQueueRef.current.clear();
      const state = runtime.getState();
      if (state.schemaVersion === 1) return;
      for (const [docId, kind] of queued) {
        const bytes = sessionRef.current?.getDocBytes(docId);
        const expectedSummary = kind === 'page'
          ? parsePublishedSummary(workspaceDocRef.current.pages[docId]?.summary, docId)
          : undefined;
        if (bytes) prewarmAdoptedDocument({ documentId: docId, kind, bytes, ...(expectedSummary ? { expectedSummary } : {}) }, state.schemaVersion);
      }
    };
    const port = createRuntimeSpacePort(runtime, {
      // A notebook/page the account has and this device does not: the catch-up plan adopts it
      // (its bytes are read from the session when the plan is computed).
      onRemoteDocAdded: (docId, kind) => {
        // Preparing starts with the download instead of after it (see `prewarmAdoptedDocument`).
        // A document's frames arrive back to back, so it is prepared once they settled.
        prewarmQueueRef.current.set(docId, kind);
        prewarmTimerRef.current ??= setTimeout(flushPrewarm, PREWARM_SETTLE_MS);
        scheduleCatchUp();
      },
    });

    const resume = filterResumeToLocalCopies(loadSpaceResume(spaceId), (documentId) => runtime.getDocumentHeads(documentId));
    const session = openPersonalSpaceSession({
      syncUrl,
      spaceId,
      resume,
      lazyPages: true,
      getAuth: async () => credentialFromJwt(await resolveJwt(), () => Date.now() / 1000),
      getFullSnapshotBytes: (docId) => (isWorkspaceDocId(docId)
        ? saveWorkspaceDoc(workspaceDocRef.current)
        : port.getSnapshotBytes(docId)),
      onStatus: (status) => reportStatus(status),
      onDocsChanged: () => undefined,
    });
    sessionRef.current = session;
    runtime.setDocumentContentSource({ request: requestPage });
    // The room keeps a document as its snapshot plus every change since; without compaction a
    // page that is edited for months replays as thousands of changes on every new device. After
    // every 64 acknowledged appends of a document this device sends its full save as the new
    // snapshot, which the room stores in place of the changes it covers.
    attachAckCompaction(session, async (docId) => {
      const bytes = isWorkspaceDocId(docId) ? saveWorkspaceDoc(workspaceDocRef.current) : await port.getSnapshotBytes(docId);
      return bytes && bytes.byteLength <= SPACE_MAX_SNAPSHOT_BYTES ? bytes : undefined;
    });
    session.subscribeAcked((docId, seq) => {
      if (!isWorkspaceDocId(docId) || !compactWorkspaceOnAckRef.current) return;
      compactWorkspaceOnAckRef.current = false;
      session.sendSnapshot(docId, saveWorkspaceDoc(workspaceDocRef.current), seq);
    });
    bindingRef.current = bindPersonalSpace({
      session,
      port,
      onWorkspaceDoc: onRemoteWorkspaceDoc,
      onRemoteDocApplied: () => scheduleCatchUp(),
      // Before a pulling device finished its first catch-up, its (pristine) local documents
      // must not reach the room; see `pristineStarterIdsRef`.
      mayPushLocal: () => catchUpDoneRef.current,
      announced: announcedToRoomRef.current,
    });

    if (resumeTimerRef.current !== undefined) clearInterval(resumeTimerRef.current);
    resumeTimerRef.current = setInterval(persistResume, RESUME_WRITE_INTERVAL_MS);
    session.subscribeSynced(() => {
      void bindingRef.current?.idle().then(persistResume);
      // The room now sent the workspace and the notebooks: the first catch-up can list every page
      // (a fresh device has no need to wait for a debounce), and pages the user opened while the
      // connection was down are requested.
      scheduleCatchUp();
      schedulePublish();
      void hydratePages();
      clearTimeout(rewriteTimerRef.current);
      rewriteAttemptsRef.current = 0;
      rewriteTimerRef.current = setTimeout(() => rewriteRunnerRef.current(), WORKSPACE_REWRITE_DELAY_MS);
    });

    if (seedDoc) {
      // PUSH bootstrap (§2.3): announce + snapshot the workspace doc now; every local notebook/
      // page document follows once the session is live (the binding's push after `synced`),
      // read and sent one at a time instead of all at once into the offline queue.
      workspaceDocAnnouncedRef.current = true;
      session.announceDoc(SPACE_WORKSPACE_DOC_ID, 'workspace');
      session.sendSnapshot(SPACE_WORKSPACE_DOC_ID, saveWorkspaceDoc(seedDoc), 0);
    }
    // PULL/normal bootstrap (seedDoc undefined): no explicit kick needed here — the room's own
    // `workspace:root` snapshot arrives through `bindSpacePort`'s `subscribeDocsChanged`, which
    // calls `scheduleCatchUp()`, whose debounced plan folds in the pristine-starter purge (§2.4).

    const queueHttp: AssetSyncHttpPort = {
      headAsset: async (assetId) => (await httpHeadAsset({ syncUrl }, await resolveJwt(), assetId)).exists,
      putAsset: async (assetId, bytes, mimeType) => {
        await httpPutAsset({ syncUrl }, await resolveJwt(), assetId, bytes as unknown as BodyInit, {
          contentType: mimeType,
          contentLength: bytes.byteLength,
        });
      },
      getAsset: async (assetId) => {
        const result = await httpGetAsset({ syncUrl }, await resolveJwt(), assetId);
        return result ? { bytes: result.bytes, mimeType: result.contentType ?? 'application/octet-stream' } : undefined;
      },
    };
    const queueRuntime: AssetSyncRuntimePort = {
      recordUploadedAsset: (entry) => {
        mutateWorkspaceDoc(recordAsset(entry.assetId, entry));
      },
      adoptDownloadedAssets: async (assets) => {
        const state = runtime.getState();
        if (state.schemaVersion === 1) return;
        const blobs: AssetBlob[] = assets.map((asset) => ({
          assetId: asset.assetId as Sha256Checksum,
          checksum: asset.assetId as Sha256Checksum,
          size: asset.size,
          bytes: asset.bytes,
        }));
        const next = await runtime.commitWorkspaceGraphRevision({
          operationId: `space-asset-adopt-${Date.now()}`,
          expectedActivationArtifactFingerprint: state.activation.artifactFingerprint,
          message: 'Adopt personal-space assets',
          assets: blobs,
        });
        onWorkspaceReplaced(next);
      },
    };
    assetQueueRef.current = new AssetSyncQueue({ http: queueHttp, runtime: queueRuntime });
    // Ink segments use the same routes; uploads run in the background and pages fetch what they lack.
    inkSyncRef.current?.stop();
    inkSyncRef.current = createInkSegmentSync({ http: queueHttp, store: inkSegments() });
    inkSyncRef.current.start();
    // See `startCatchUpWatchdog`'s doc comment: started unconditionally, not only after a real
    // `docsChanged` callback already fired. Harmless (immediately a no-op) once `catchUpDoneRef
    // .current` is already `true` (the PUSH-bootstrap / `seedDoc` case, just above).
    startCatchUpWatchdog();
  }, [runtime, syncUrl, resolveJwt, onRemoteWorkspaceDoc, scheduleCatchUp, mutateWorkspaceDoc, onWorkspaceReplaced, reportStatus, startCatchUpWatchdog, persistResume, requestPage, schedulePublish, hydratePages]);
  useEffect(() => {
    reopenSessionRef.current = () => {
      const spaceId = activeSpaceIdRef.current;
      if (!spaceId) return;
      // Deliberately not `teardownSession()`: that also clears `announcedToRoomRef`, which would
      // make the next push re-announce every local doc as if brand new (only `workspace:root`'s
      // in-memory state — reset below, inside `openSession`, via `seedDoc === undefined` — is
      // actually suspect here).
      bindingRef.current?.dispose();
      bindingRef.current = null;
      sessionRef.current?.close();
      sessionRef.current = null;
      openSession(spaceId);
    };
  }, [openSession]);

  useEffect(() => {
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') persistResume();
    };
    window.addEventListener('pagehide', persistResume);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', persistResume);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [persistResume]);

  // --- Bootstrap decision (§2.3, §2.4, P8) -------------------------------------------------

  useEffect(() => {
    if (!enabled || !syncUrl || !runtime || !workspace || !isSignedIn || !userId || !httpConfig) {
      teardownSession();
      reportStatus(enabled ? (isSignedIn ? { kind: 'bootstrapping', phase: 'push' } : { kind: 'signed-out' }) : { kind: 'disabled' });
      return;
    }
    if (workspace.schemaVersion !== 3) {
      void runtime.ensureSchemaV3().then((next) => onWorkspaceReplaced(next));
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retry = (): void => {
      if (cancelled) return;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      window.removeEventListener('online', retry);
      setBootstrapAttempt((attempt) => attempt + 1);
    };

    // A device that is already linked knows its space and can open the session without the
    // HTTP round trip. That matters offline: the app starts without a network (laptop at
    // school), the session reports "offline, N changes waiting" and reconnects by itself once
    // the network is back, instead of failing the bootstrap and never trying again.
    const knownLink = loadSpaceLink();
    if (knownLink && knownLink.sub === userId) {
      openSession(knownLink.spaceId);
      void (async () => {
        try {
          const desc = await createOrGetSpace(httpConfig, await resolveJwt());
          if (cancelled) return;
          setDescriptor(desc);
          if (desc.spaceId !== knownLink.spaceId) {
            saveSpaceLink({ spaceId: desc.spaceId, sub: userId, linkedAt: new Date().toISOString() });
            teardownSession();
            openSession(desc.spaceId);
          }
        } catch {
          // Offline or the Worker is unreachable: the open session keeps retrying on its own.
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    reportStatus({ kind: 'bootstrapping', phase: 'push' });

    void (async () => {
      try {
        const jwt = await resolveJwt();
        const desc = await createOrGetSpace(httpConfig, jwt);
        if (cancelled) return;
        setDescriptor(desc);

        const link = loadSpaceLink();
        // Structure alone cannot tell the untouched sample from one the person wrote in: a phone
        // whose "Schnelle Notizen" page got a line of text looks exactly like a fresh install.
        // Replacing it by the account's notebooks threw that text away without asking.
        starterUntouchedRef.current = !(await starterHoldsTypedText(runtime, workspace));
        if (cancelled) return;
        const localIsPristine = isLocalWorkspacePristine(workspace) && starterUntouchedRef.current;

        if (link && link.sub === userId) {
          openSession(desc.spaceId);
          return;
        }

        if (desc.docCount === 0) {
          // PUSH (§2.3) — nothing on the other side yet, regardless of what is local.
          const seed = createInitialWorkspaceDoc({
            notebookDocumentIdsInOrder: workspace.activation.manifest.notebookDocumentIds as string[],
            notebooks: workspace.notebooks.map((notebook) => ({
              documentId: notebook.documentId,
              pageDocumentIds: notebook.sections.flatMap((section) => section.pageDocumentIds),
            })),
            now: new Date().toISOString(),
          });
          saveSpaceLink({ spaceId: desc.spaceId, sub: userId, linkedAt: new Date().toISOString() });
          openSession(desc.spaceId, seed);
          return;
        }

        if (localIsPristine) {
          // PULL (§2.4) — no dialog: the account already has data and the local workspace is
          // still the untouched default, so there is nothing to ask the user about.
          saveSpaceLink({ spaceId: desc.spaceId, sub: userId, linkedAt: new Date().toISOString() });
          openSession(desc.spaceId);
          return;
        }

        // P8: both sides hold data. Surface the dialog and wait.
        pendingLinkChoiceRef.current = { spaceId: desc.spaceId, remoteDocCount: desc.docCount };
        reportStatus({ kind: 'link-required', localHasData: true, remoteDocCount: desc.docCount });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'personal-space bootstrap failed';
        reportStatus({ kind: 'error', message });
        onNotice(message);
        // Try again when the browser reports a network, and in any case after a while.
        window.addEventListener('online', retry);
        retryTimer = setTimeout(retry, BOOTSTRAP_RETRY_MS);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      window.removeEventListener('online', retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per (enabled, signed-in, spaceId-relevant) transition and per retry; re-running per keystroke would reopen the socket.
  }, [enabled, syncUrl, runtime, isSignedIn, userId, httpConfig, workspace?.schemaVersion === 3, bootstrapAttempt]);

  // --- Local topology -> workspace doc (the direction §5.8's `commitTopology` triggers) ----

  useEffect(() => {
    if (!catchUpDoneRef.current || !sessionRef.current || !workspace || workspace.schemaVersion !== 3) return;
    const change = projectLocalTopologyIntoWorkspaceDoc(workspaceDocRef.current, workspace, new Date().toISOString(), sharedRooms);
    if (change) mutateWorkspaceDoc(change);

    // No rebind here: the binding follows the document set through the port, and the runtime's
    // change feed reports every edit, topology commits included.
    const runtimeNow = runtime;
    if (runtimeNow && assetQueueRef.current) {
      const knownAssetIds = new Set(Object.keys(workspaceDocRef.current.assets));
      const localAssetIds = (workspace.activation.assetIds as string[]) ?? [];
      const missing = localAssetIds.filter((id) => !knownAssetIds.has(id) && !uploadingAssetIdsRef.current.has(id));
      if (missing.length > 0) {
        for (const assetId of missing) uploadingAssetIdsRef.current.add(assetId);
        // A large import brings hundreds of assets: read and upload them in small batches so
        // only a few are in memory at once.
        void (async () => {
          for (let index = 0; index < missing.length; index += ASSET_UPLOAD_BATCH) {
            const queue = assetQueueRef.current;
            if (!queue) return;
            const batch: Array<{ assetId: string; bytes: Uint8Array; mimeType: string; size: number }> = [];
            for (const assetId of missing.slice(index, index + ASSET_UPLOAD_BATCH)) {
              const blob = await runtimeNow.getAsset(assetId as Sha256Checksum);
              if (blob) batch.push({ assetId, bytes: blob.bytes, mimeType: findAssetMimeType(blob.bytes), size: blob.size });
            }
            if (batch.length > 0) await queue.syncUploads(batch, knownAssetIds);
          }
        })().catch(() => undefined).finally(() => {
          for (const assetId of missing) uploadingAssetIdsRef.current.delete(assetId);
        });
      }
    }
  }, [workspace, mutateWorkspaceDoc, runtime, sharedRooms]);

  useEffect(() => () => teardownSession(), [teardownSession]);

  // Stable on purpose: the shell builds its asset repository from it, and the picture cache is
  // scoped to that repository. A new function on every render made every image element read,
  // hash and decode its asset again.
  const requestAsset = useCallback(
    (assetId: string, options?: AssetRequestOptions) => assetQueueRef.current?.requestAsset(assetId, options) ?? Promise.resolve(undefined),
    [],
  );
  return {
    descriptor,
    offlineProgress,
    syncNow: () => {
      void flushCatchUp();
      void assetQueueRef.current?.flushAdoption();
    },
    signOut: () => {
      teardownSession();
      reportStatus({ kind: 'signed-out' });
    },
    addLocalToAccount: () => {
      const choice = pendingLinkChoiceRef.current;
      if (!choice || !userId || !workspace || workspace.schemaVersion !== 3) return;
      pendingLinkChoiceRef.current = null;
      saveSpaceLink({ spaceId: choice.spaceId, sub: userId, linkedAt: new Date().toISOString() });
      // Not a fresh seed: the account already has a workspace doc, and a second, independently
      // created one has an unrelated history. Merged in the room, one side's notebook list won
      // and the other device never saw these notebooks. Opening like a pull adopts the account's
      // workspace doc first; the local notebooks then join it through the topology projection
      // after the first catch-up, and nothing local is removed because the workspace is not the
      // pristine starter.
      openSession(choice.spaceId);
    },
    discardLocalForAccount: () => {
      const choice = pendingLinkChoiceRef.current;
      if (!choice || !userId) return;
      pendingLinkChoiceRef.current = null;
      saveSpaceLink({ spaceId: choice.spaceId, sub: userId, linkedAt: new Date().toISOString() });
      // The caller asked the person first (a confirmation); the local notebooks leave with the
      // account's first catch-up, as the untouched starter does.
      discardLocalRef.current = true;
      openSession(choice.spaceId);
    },
    clearSharedRoom: (notebookDocumentId: string) => {
      if (!sessionRef.current || !catchUpDoneRef.current) return;
      mutateWorkspaceDoc(setNotebookSharedRoom(notebookDocumentId, undefined));
    },
    requestAsset,
  };
}

/** Exported for the account-switch flow (§6.8); not called from sign-out. */
export function forgetSpaceLink(): void {
  const link = loadSpaceLink();
  if (link) clearSpaceResume(link.spaceId);
  clearSpaceLink();
}

/** Exported so a caller can pre-check without a full asset round trip (unused today, kept for parity with `http.ts`'s surface). */
export { httpDeleteAsset as deleteSpaceAsset };
