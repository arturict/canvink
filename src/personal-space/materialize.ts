/**
 * `applySpacePlan` — applies a `SpacePlan` (PERSONAL-SYNC.md §5.4) to the local
 * workspace through `WorkspaceV2Runtime.commitWorkspaceGraphRevision` (§5.5).
 *
 * This is the only file in the personal-space module tree that performs I/O
 * against the runtime; `manifestProjection.ts` stays pure so it can be
 * unit-tested without one.
 */

import type { TrashRecordV2 } from "../domain/v2";
import type { Sha256Checksum } from "../domain/v2";
import type { TrashRecordV3, WorkspaceManifest } from "../domain/v3";
import type { V2RuntimeState, WorkspaceV2Runtime } from "../storage/workspaceV2Runtime";
import { SPACE_ADOPT_BATCH_MS, SPACE_ADOPT_COMMIT_BYTES } from "./contract";
import type { SpacePlan } from "./contract";

export interface ApplySpacePlanOptions {
  operationId: string;
  message: string;
  /**
   * Recomputes a fresh plan against the runtime's current state. Used for the
   * single retry after an "activation changed" conflict (§5.5): the caller
   * re-reads `runtime.getState()` and re-projects (`projectSpacePlan`)
   * before this is invoked again. When omitted, the retry resubmits the same
   * plan against the refreshed activation fingerprint, which is sufficient
   * whenever nothing else raced the first attempt.
   */
  reprojectPlan?: () => SpacePlan;
  /**
   * The activation the plan was projected from. The plan lists whole manifest id lists, so it
   * must not commit on top of a newer activation (a local create that landed while planning
   * would be dropped). Without `reprojectPlan` a conflict then propagates, and the caller plans
   * again from the newer state. When omitted, the current fingerprint is read at commit time.
   */
  plannedFromFingerprint?: Sha256Checksum;
  /** Applied to the manifest of the last commit of the plan, after the plan itself (for example to repair the active target). */
  finalizeManifest?: (manifest: WorkspaceManifest) => void;
  /** Adopted bytes per commit; see `SPACE_ADOPT_COMMIT_BYTES`. */
  maxCommitBytes?: number;
}

function isPlanEmpty(plan: SpacePlan): boolean {
  return plan.adoptedDocuments.length === 0
    && plan.placeholderPages.length === 0
    && plan.removedDocumentIds.length === 0
    && plan.notebookDocumentIds.length === 0
    && plan.pageDocumentIds.length === 0
    && plan.trashAdditions.length === 0
    && plan.trashRemovals.length === 0;
}

function isActivationConflict(error: unknown): boolean {
  return error instanceof Error && /changed before the topology transaction/i.test(error.message);
}

interface TrashDeltaRecord {
  id: string;
  kind: "notebook" | "page";
  deletedAt: string;
  origin: { source: "personal-space" };
  notebookDocumentId?: string;
  pageDocumentId?: string;
}

function applyTrashDelta<T extends { kind: string; notebookDocumentId?: string; pageDocumentId?: string }>(
  existing: readonly T[],
  plan: SpacePlan,
): Array<T | TrashDeltaRecord> {
  const removalIds = new Set(plan.trashRemovals);
  const kept = existing.filter((record) => {
    const documentId = record.kind === "notebook"
      ? record.notebookDocumentId
      : record.kind === "page" ? record.pageDocumentId : undefined;
    return documentId === undefined || !removalIds.has(documentId);
  });
  const additions: TrashDeltaRecord[] = plan.trashAdditions.map((addition) => ({
    id: addition.documentId,
    kind: addition.kind,
    deletedAt: addition.deletedAt,
    origin: { source: "personal-space" },
    ...(addition.kind === "notebook"
      ? { notebookDocumentId: addition.documentId }
      : { pageDocumentId: addition.documentId }),
  }));
  return [...kept, ...additions];
}

/** Replaces `notebookDocumentIds`/`pageDocumentIds` and applies the trash delta (§5.4 rules 4-5). */
/**
 * Exported (Wave 5 integration need, additive-only, behaviour unchanged): a caller that must
 * bypass `applySpacePlan` for a single commit — e.g. to also repair `manifest.active` when the
 * plan removes the document the manifest currently points at, which `applyPlanToManifest` itself
 * has no way to know about — still needs this same replace/trash logic instead of duplicating it.
 */
export function applyPlanToManifest(manifest: WorkspaceManifest, plan: SpacePlan): void {
  manifest.notebookDocumentIds = [...plan.notebookDocumentIds];
  manifest.pageDocumentIds = [...plan.pageDocumentIds];
  if (manifest.schemaVersion === 3) {
    manifest.trash = applyTrashDelta<TrashRecordV3>(manifest.trash, plan) as TrashRecordV3[];
  } else {
    manifest.trash = applyTrashDelta<TrashRecordV2>(manifest.trash, plan) as TrashRecordV2[];
  }
}

async function commitPlanOnce(
  runtime: WorkspaceV2Runtime,
  plan: SpacePlan,
  options: ApplySpacePlanOptions,
  isRetry: boolean,
): Promise<V2RuntimeState | null> {
  const state = runtime.getState();
  if (state.schemaVersion === 1) {
    throw new Error("applySpacePlan requires an active schema-v2/v3 workspace (call ensureSchemaV3 first).");
  }
  // A retry without a re-projection has no newer plan, so it follows the current state as before.
  const planned = isRetry ? undefined : options.plannedFromFingerprint;
  try {
    return await runtime.commitWorkspaceGraphRevision({
      operationId: options.operationId,
      expectedActivationArtifactFingerprint: planned ?? state.activation.artifactFingerprint,
      // The plan was derived from `state`; a newer activation needs a re-projected plan, not a rebase.
      onConflict: "fail",
      message: options.message,
      adoptedDocuments: plan.adoptedDocuments,
      placeholderPages: plan.placeholderPages,
      removedDocumentIds: plan.removedDocumentIds,
      updateManifest: (manifest) => {
        applyPlanToManifest(manifest, plan);
        options.finalizeManifest?.(manifest);
      },
    });
  } catch (error) {
    if (isRetry || !isActivationConflict(error)) throw error;
    // A stale plan is never resubmitted on top of the newer activation.
    if (options.plannedFromFingerprint && !options.reprojectPlan) throw error;
    const freshPlan = options.reprojectPlan ? options.reprojectPlan() : plan;
    if (isPlanEmpty(freshPlan)) return null;
    return commitPlanOnce(runtime, freshPlan, options, true);
  }
}

/**
 * Splits adopted documents into commits of about `maxBytes` each, pages before notebooks so
 * that a notebook never lands ahead of a page it lists. A document larger than the limit is
 * a commit of its own.
 */
export function batchAdoptedDocuments(
  documents: SpacePlan["adoptedDocuments"],
  maxBytes: number,
): Array<SpacePlan["adoptedDocuments"]> {
  const ordered = [
    ...documents.filter((document) => document.kind === "page"),
    ...documents.filter((document) => document.kind === "notebook"),
  ];
  const batches: Array<SpacePlan["adoptedDocuments"]> = [];
  let current: SpacePlan["adoptedDocuments"] = [];
  let currentBytes = 0;
  for (const document of ordered) {
    if (current.length > 0 && currentBytes + document.bytes.byteLength > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(document);
    currentBytes += document.bytes.byteLength;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The commit for one batch that is not the last: it only adds documents, in the order the workspace already has. */
function interimPlan(
  state: V2RuntimeState,
  plan: SpacePlan,
  batch: SpacePlan["adoptedDocuments"],
  placeholderPages: SpacePlan["placeholderPages"],
): SpacePlan {
  const manifest = state.activation.manifest;
  const batchIds = new Set(batch.map((document) => document.documentId));
  const withNew = (existing: readonly string[], added: readonly string[]): string[] =>
    [...existing, ...added.filter((documentId) => !existing.includes(documentId))];
  return {
    adoptedDocuments: batch,
    placeholderPages,
    removedDocumentIds: plan.removedDocumentIds.filter((documentId) => batchIds.has(documentId)),
    notebookDocumentIds: withNew(manifest.notebookDocumentIds, batch.filter((document) => document.kind === "notebook").map((document) => document.documentId)),
    pageDocumentIds: withNew(
      manifest.pageDocumentIds,
      [...batch.filter((document) => document.kind === "page").map((document) => document.documentId), ...placeholderPages.map((page) => page.documentId)],
    ),
    trashAdditions: [],
    trashRemovals: [],
  };
}

/**
 * Applies `plan` to `runtime`, adopting at most about `SPACE_ADOPT_COMMIT_BYTES` of documents in
 * one topology transaction. One transaction that writes an entire account holds the storage
 * transaction queue for as long as it takes, and every save of a page the user edits meanwhile
 * waits behind it. The last commit carries the plan's ordering, removals and trash changes.
 *
 * - Returns `null` (no-op) when the plan is empty in every field.
 * - On an "activation changed" conflict, retries **exactly once** (optionally
 *   against a freshly reprojected plan via `options.reprojectPlan`); a second
 *   conflict propagates to the caller, which defers to the next
 *   `docsChanged` tick rather than looping here.
 */
export async function applySpacePlan(
  runtime: WorkspaceV2Runtime,
  plan: SpacePlan,
  options: ApplySpacePlanOptions,
): Promise<V2RuntimeState | null> {
  if (isPlanEmpty(plan)) return null;
  const batches = batchAdoptedDocuments(plan.adoptedDocuments, options.maxCommitBytes ?? SPACE_ADOPT_COMMIT_BYTES);
  if (batches.length <= 1) return commitPlanOnce(runtime, plan, options, false);
  let next: V2RuntimeState | null = null;
  // Documents an earlier commit adopted; a replaced placeholder was removed together with them.
  const adoptedBefore = new Set<string>();
  for (const [position, batch] of batches.entries()) {
    const isLast = position === batches.length - 1;
    const state = runtime.getState();
    if (state.schemaVersion === 1) {
      throw new Error("applySpacePlan requires an active schema-v2/v3 workspace (call ensureSchemaV3 first).");
    }
    const placeholderPages = position === 0 ? plan.placeholderPages : [];
    const step: SpacePlan = isLast
      ? {
        ...plan,
        adoptedDocuments: batch,
        placeholderPages,
        removedDocumentIds: plan.removedDocumentIds.filter((documentId) => !adoptedBefore.has(documentId)),
      }
      : interimPlan(state, plan, batch, placeholderPages);
    for (const document of batch) adoptedBefore.add(document.documentId);
    next = await commitPlanOnce(
      runtime,
      step,
      {
        ...options,
        // Later commits follow the activation the previous one published, so a local commit in
        // between fails the batch instead of being overwritten by the plan's id lists.
        ...(options.plannedFromFingerprint && next ? { plannedFromFingerprint: next.activation.artifactFingerprint } : {}),
        operationId: `${options.operationId}-${position}`,
        // A retry after a conflict re-projects the whole plan, which only the last commit may do.
        reprojectPlan: isLast ? options.reprojectPlan : undefined,
        finalizeManifest: isLast ? options.finalizeManifest : undefined,
      },
      false,
    );
  }
  return next;
}

export interface SpacePlanMaterializer {
  /** Schedules a plan application `debounceMs` from now, coalescing with any pending schedule.
   * `getPlan`/`getOptions` are evaluated only once the debounce window elapses, so a burst of
   * `schedule` calls during a large catch-up produces exactly one transaction. */
  schedule(getPlan: () => SpacePlan, getOptions: () => ApplySpacePlanOptions): void;
  /** Applies the most recently scheduled plan immediately, if one is pending. */
  flushNow(): Promise<V2RuntimeState | null>;
  /** Cancels any pending scheduled application without applying it. */
  dispose(): void;
}

/**
 * Debounces `applySpacePlan` calls by `debounceMs` (default `SPACE_ADOPT_BATCH_MS`), so that a
 * catch-up delivering many `docsChanged` events in quick succession produces exactly one
 * transaction (§5.5).
 */
export function createSpacePlanMaterializer(
  runtime: WorkspaceV2Runtime,
  options: { debounceMs?: number } = {},
): SpacePlanMaterializer {
  const debounceMs = options.debounceMs ?? SPACE_ADOPT_BATCH_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { getPlan: () => SpacePlan; getOptions: () => ApplySpacePlanOptions } | undefined;

  const runPending = async (): Promise<V2RuntimeState | null> => {
    if (!pending) return null;
    const { getPlan, getOptions } = pending;
    pending = undefined;
    return applySpacePlan(runtime, getPlan(), getOptions());
  };

  return {
    schedule(getPlan, getOptions) {
      pending = { getPlan, getOptions };
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void runPending();
      }, debounceMs);
    },
    flushNow() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      return runPending();
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = undefined;
    },
  };
}
