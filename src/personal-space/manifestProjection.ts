/**
 * `projectSpacePlan` — the pure heart of the personal-space merge
 * (PERSONAL-SYNC.md §5.4). Given the workspace CRDT doc, the raw bytes the
 * session currently holds for remote documents, and the local activation, it
 * computes everything `materialize.ts` must apply to the local workspace.
 *
 * Total and deterministic: same inputs -> same output. No I/O, no clock, no
 * randomness — every timestamp comes from the workspace doc itself.
 */

import { loadAutomergeDocument, getAutomergeSnapshot, type LiveNotebookDocV2 } from "../crdt";
import { parsePublishedSummary, type PageSummary } from "../storage/pageIndex";
import type { V2ActivationRecord } from "../storage/v2WorkspaceStorage";
import { compareOrderedEntries } from "./fractionalOrder";
import type { SpacePlan, SpaceWorkspaceDocV1 } from "./contract";

export interface ProjectSpacePlanInput {
  workspaceDoc: SpaceWorkspaceDocV1;
  /** Full Automerge saves for the docs the session holds, keyed by docId. */
  remoteDocBytes: ReadonlyMap<string, Uint8Array>;
  activation: V2ActivationRecord;
  /**
   * Pages of the activation this device lists but does not store (see `WorkspaceV2Runtime
   * .listPlaceholderDocuments`). They count as present for ordering, but not as held: bytes the
   * session has for one replace the placeholder.
   */
  placeholderDocumentIds?: ReadonlySet<string>;
  /**
   * Where the notebooks this device already stores put each page, by page document id. A page
   * is only listed by its published summary when that agrees with the notebook that lists it.
   */
  localPagePlacement?: ReadonlyMap<string, { notebookId: string; sectionId: string }>;
  /**
   * Notebooks of `remoteDocBytes` that were already decoded elsewhere (in a worker), by document id.
   * Decoding loads the whole notebook document, which a plan would otherwise do on the main thread
   * for every notebook, every time it is computed.
   */
  decodedNotebooks?: ReadonlyMap<string, DecodedNotebook>;
}

/** Minimal shape shared by `TrashRecordV2` and `TrashRecordV3`, enough for projection. */
interface TrashRecordLike {
  kind: "notebook" | "section" | "page" | "element";
  notebookDocumentId?: string;
  pageDocumentId?: string;
}

export interface DecodedNotebook {
  pageDocumentIds: string[];
  placement: Map<string, { notebookId: string; sectionId: string }>;
}

/** What a plan needs of a notebook, from its snapshot. */
export function toDecodedNotebook(snapshot: LiveNotebookDocV2): DecodedNotebook {
  const placement = new Map<string, { notebookId: string; sectionId: string }>();
  for (const section of snapshot.sections) {
    for (const pageDocumentId of section.pageDocumentIds) {
      placement.set(pageDocumentId, { notebookId: snapshot.notebookId, sectionId: section.id });
    }
  }
  return { pageDocumentIds: snapshot.sections.flatMap((section) => section.pageDocumentIds), placement };
}

function decodeNotebook(documentId: string, bytes: Uint8Array): DecodedNotebook | undefined {
  try {
    const document = loadAutomergeDocument(bytes, { expectedDocumentId: documentId, expectedKind: "notebook" });
    return toDecodedNotebook(getAutomergeSnapshot(document) as LiveNotebookDocV2);
  } catch {
    // Malformed or not-yet-fully-synced bytes: treat as unavailable this round; a later
    // `docsChanged` tick will retry once more (or better) bytes arrive. Never throws.
    return undefined;
  }
}

export function projectSpacePlan(input: ProjectSpacePlanInput): SpacePlan {
  const { workspaceDoc, remoteDocBytes, activation } = input;
  // Every document of the activation is known; the ones without a stored copy (placeholders)
  // are not held, so bytes for one of them are adopted in its place.
  const localDocumentIds = new Set(activation.documents.map((document) => document.documentId));
  const placeholderIds = input.placeholderDocumentIds ?? new Set<string>();
  const heldDocumentIds = new Set([...localDocumentIds].filter((documentId) => !placeholderIds.has(documentId)));
  const trash = (activation.manifest.trash as TrashRecordLike[]) ?? [];

  // --- Step 1 + 2: adopt, with referential integrity -------------------------------------

  const candidateNotebookIds = Object.entries(workspaceDoc.notebooks)
    .filter(([documentId, entry]) => !entry.purgedAt && !heldDocumentIds.has(documentId) && remoteDocBytes.has(documentId))
    .map(([documentId]) => documentId);
  const candidatePageIds = Object.entries(workspaceDoc.pages)
    .filter(([documentId, entry]) => !entry.purgedAt && !heldDocumentIds.has(documentId) && remoteDocBytes.has(documentId))
    .map(([documentId]) => documentId);
  const candidatePageIdSet = new Set(candidatePageIds);
  // Pages the account lists with a summary and this device has neither stored nor received:
  // they are listed by that summary until their documents are downloaded.
  const placeholderSummaries = new Map<string, PageSummary>();
  for (const [documentId, entry] of Object.entries(workspaceDoc.pages)) {
    if (entry.purgedAt || localDocumentIds.has(documentId) || remoteDocBytes.has(documentId)) continue;
    const summary = parsePublishedSummary(entry.summary, documentId);
    if (summary) placeholderSummaries.set(documentId, summary);
  }

  const decodedNotebooks = new Map<string, DecodedNotebook>();
  // A notebook is adoptable only once every page its sections reference is either already
  // local, itself a candidate for adoption this round, or listed by a summary (§5.4 rule 2).
  const adoptedNotebookIds = candidateNotebookIds.filter((documentId) => {
    const bytes = remoteDocBytes.get(documentId);
    if (!bytes) return false;
    const decoded = input.decodedNotebooks?.get(documentId) ?? decodeNotebook(documentId, bytes);
    if (decoded === undefined) return false;
    decodedNotebooks.set(documentId, decoded);
    return decoded.pageDocumentIds.every((pageId) =>
      localDocumentIds.has(pageId) || candidatePageIdSet.has(pageId) || placeholderSummaries.has(pageId));
  });
  const adoptedNotebookIdSet = new Set(adoptedNotebookIds);

  // A page is adoptable only once its owning notebook is already local or adopted this round.
  const adoptedPageIds = candidatePageIds.filter((documentId) => {
    const owner = workspaceDoc.pages[documentId]?.notebookDocumentId;
    return owner !== undefined && (localDocumentIds.has(owner) || adoptedNotebookIdSet.has(owner));
  });

  // A summary is only trusted where it agrees with the notebook that lists the page, so that the
  // workspace graph the commit validates cannot reject it; a page that disagrees is downloaded.
  const placement = new Map<string, { notebookId: string; sectionId: string }>(input.localPagePlacement ?? []);
  for (const notebookId of adoptedNotebookIds) {
    for (const [pageDocumentId, place] of decodedNotebooks.get(notebookId)?.placement ?? []) placement.set(pageDocumentId, place);
  }
  const placeholderPages: SpacePlan["placeholderPages"] = [];
  for (const [documentId, summary] of placeholderSummaries) {
    const owner = workspaceDoc.pages[documentId]?.notebookDocumentId;
    if (owner === undefined || !(localDocumentIds.has(owner) || adoptedNotebookIdSet.has(owner))) continue;
    const listed = placement.get(documentId);
    if (listed && (listed.notebookId !== summary.notebookId || listed.sectionId !== summary.sectionId)) continue;
    placeholderPages.push({ documentId, summary });
  }
  const placeholderPageIdSet = new Set(placeholderPages.map((page) => page.documentId));

  const adoptedDocuments: SpacePlan["adoptedDocuments"] = [
    ...adoptedNotebookIds.map((documentId) => ({
      documentId,
      kind: "notebook" as const,
      bytes: remoteDocBytes.get(documentId) as Uint8Array,
    })),
    ...adoptedPageIds.map((documentId) => {
      const expectedSummary = parsePublishedSummary(workspaceDoc.pages[documentId]?.summary, documentId);
      return {
        documentId,
        kind: "page" as const,
        bytes: remoteDocBytes.get(documentId) as Uint8Array,
        ...(expectedSummary ? { expectedSummary } : {}),
      };
    }),
  ];
  // A downloaded page replaces its placeholder: the placeholder leaves in the same commit and
  // the page stays listed.
  const replacedPlaceholderIds = adoptedPageIds.filter((documentId) => placeholderIds.has(documentId));

  // --- Step 3: purge ----------------------------------------------------------------------

  const purgedNotebookIds = Object.entries(workspaceDoc.notebooks)
    .filter(([documentId, entry]) => entry.purgedAt !== undefined && localDocumentIds.has(documentId))
    .map(([documentId]) => documentId);
  const purgedPageIds = Object.entries(workspaceDoc.pages)
    .filter(([documentId, entry]) => entry.purgedAt !== undefined && localDocumentIds.has(documentId))
    .map(([documentId]) => documentId);
  const removedDocumentIds = [...purgedNotebookIds, ...purgedPageIds];
  // Left out of the ordering filters below: a replaced placeholder stays in the lists.
  const removedDocumentIdSet = new Set(removedDocumentIds);

  // --- Step 4: order ------------------------------------------------------------------------

  const presentNotebookEntries = Object.entries(workspaceDoc.notebooks)
    .filter(([documentId, entry]) => !entry.purgedAt
      && !removedDocumentIdSet.has(documentId)
      && (localDocumentIds.has(documentId) || adoptedNotebookIdSet.has(documentId)))
    .map(([documentId, entry]) => ({ documentId, order: entry.order }))
    .sort(compareOrderedEntries);
  const workspaceDocNotebookIds = new Set(Object.keys(workspaceDoc.notebooks));
  const manifestNotebookIds = (activation.manifest.notebookDocumentIds as string[]) ?? [];
  const localOnlyNotebookIds = manifestNotebookIds.filter(
    (documentId) => !workspaceDocNotebookIds.has(documentId) && !removedDocumentIdSet.has(documentId),
  );
  const notebookDocumentIds = [
    ...presentNotebookEntries.map((entry) => entry.documentId),
    ...localOnlyNotebookIds,
  ];

  const presentPageIds = Object.entries(workspaceDoc.pages)
    .filter(([documentId, entry]) => !entry.purgedAt
      && !removedDocumentIdSet.has(documentId)
      && (localDocumentIds.has(documentId) || adoptedPageIds.includes(documentId) || placeholderPageIdSet.has(documentId)))
    .map(([documentId]) => documentId);
  const workspaceDocPageIds = new Set(Object.keys(workspaceDoc.pages));
  const manifestPageIds = (activation.manifest.pageDocumentIds as string[]) ?? [];
  const localOnlyPageIds = manifestPageIds.filter(
    (documentId) => !workspaceDocPageIds.has(documentId) && !removedDocumentIdSet.has(documentId),
  );
  const pageDocumentIds = [...new Set([...localOnlyPageIds, ...presentPageIds])];

  // --- Step 5: trash ------------------------------------------------------------------------

  const isLocallyTrashed = (kind: "notebook" | "page", documentId: string): boolean => trash.some(
    (record) => record.kind === kind
      && (kind === "notebook" ? record.notebookDocumentId === documentId : record.pageDocumentId === documentId),
  );

  const trashAdditions: SpacePlan["trashAdditions"] = [];
  for (const [documentId, entry] of Object.entries(workspaceDoc.notebooks)) {
    if (!entry.deletedAt || entry.purgedAt) continue;
    if (!localDocumentIds.has(documentId) && !adoptedNotebookIdSet.has(documentId)) continue;
    if (isLocallyTrashed("notebook", documentId)) continue;
    trashAdditions.push({ documentId, kind: "notebook", deletedAt: entry.deletedAt });
  }
  for (const [documentId, entry] of Object.entries(workspaceDoc.pages)) {
    if (!entry.deletedAt || entry.purgedAt) continue;
    if (!localDocumentIds.has(documentId) && !adoptedPageIds.includes(documentId) && !placeholderPageIdSet.has(documentId)) continue;
    if (isLocallyTrashed("page", documentId)) continue;
    trashAdditions.push({ documentId, kind: "page", deletedAt: entry.deletedAt });
  }

  const trashRemovals: string[] = [];
  for (const record of trash) {
    if (record.kind === "notebook" && record.notebookDocumentId) {
      const entry = workspaceDoc.notebooks[record.notebookDocumentId];
      if (entry && !entry.deletedAt && !entry.purgedAt) trashRemovals.push(record.notebookDocumentId);
    } else if (record.kind === "page" && record.pageDocumentId) {
      const entry = workspaceDoc.pages[record.pageDocumentId];
      if (entry && !entry.deletedAt && !entry.purgedAt) trashRemovals.push(record.pageDocumentId);
    }
  }

  return {
    adoptedDocuments,
    placeholderPages,
    removedDocumentIds: [...removedDocumentIds, ...replacedPlaceholderIds],
    notebookDocumentIds,
    pageDocumentIds,
    trashAdditions,
    trashRemovals: [...new Set(trashRemovals)],
  };
}
