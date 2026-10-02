import * as Automerge from '@automerge/automerge';
import {
  getSharedAutomergeSnapshot,
  projectLiveRichText,
  type LiveNotebookDocV2,
  type LivePageDocV2,
  type PageAutomergeDoc,
} from '../crdt';
import type { PageDocV3, PageElementV3 } from '../domain/v3';
import type { V2RuntimeState, WorkspaceGraphRevisionRequest, WorkspaceV2Runtime } from '../storage/workspaceV2Runtime';
import { pendingInk } from './pendingInk';
import {
  activeClaims,
  claimChange,
  leaseWinner,
  nextGenerationDocumentId,
  releaseChange,
  DEFAULT_LEASE_TTL_MS,
  SWAP_PREFIX,
} from './rebuildLease';
import { DEFAULT_SEAL_OPTIONS } from './seal';
import { inkSegments } from './segmentStore';

/**
 * Pages written before ink segments keep every operation they ever had, so they stay slow to open
 * however they are edited; only a new document forgets that history. This rebuilds them in the
 * background, in place: the page keeps its page id, its place in its section, its sub-page level, its
 * pins and tags, and its title; only the document behind it is new (its document id gets a
 * generation suffix). It does so through the same steps as the "Neu aufbauen" action: build a copy
 * with its ink in segments, check it against the original stroke by stroke, and only then let it
 * replace the original. The original is kept, hidden, until the copy's segments have reached the
 * cloud, then dropped, and a `swap:` field in the notebook tells the other devices to retire it.
 *
 * Exactly one device rebuilds a given page: a claim in the notebook document decides (see
 * rebuildLease.ts). Everything runs when the device is otherwise quiet, one page at a time, recently
 * opened and heaviest pages first; a legacy page the user opens is rebuilt at once.
 */
export interface RebuildRuntime {
  getState(): ReturnType<WorkspaceV2Runtime['getState']>;
  ensureSchemaV3(): Promise<V2RuntimeState>;
  commitWorkspaceGraphRevision(request: WorkspaceGraphRevisionRequest): Promise<V2RuntimeState>;
  readDocument<T>(documentId: string, reader: (document: Automerge.Doc<unknown>) => T | Promise<T>): Promise<T>;
  getDocumentHeads(documentId: string): readonly string[] | undefined;
  sealPendingInk(documentId: string): Promise<number>;
  storedDocumentBytes(documentId: string): Promise<number>;
}

export interface LegacyRebuildOptions {
  runtime: RebuildRuntime;
  deviceId: string;
  now?: () => Date;
  /** Pages whose stored document is at least this large are legacy candidates. */
  minBytes?: number;
  /** How long a claim is visible before this device acts on it, so a rival claim can arrive. */
  settleMs?: number;
  leaseTtlMs?: number;
  /** How long after the swap the hidden original stays, at least, before it is dropped. */
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether nothing has been touched for `ms` (pen, keys, pointer). Rebuilding of idle pages waits for it. */
  isQuiet?: (ms: number) => boolean;
  /** Whether it is a fit moment at all: page visible, sync (if configured) caught up. */
  canRun?: () => boolean;
  /** Most recently opened page ids first. */
  recentPageIds?: () => readonly string[];
  /**
   * Documents already found to hold no strokes of their own, kept by the owner across visits (a
   * document never gains legacy strokes: new ink goes into segments), so that a page that is large
   * for other reasons is looked at once, not at every start.
   */
  inkFree?: { has(documentId: string): boolean; add(documentId: string): void };
  /** Reports the number of legacy pages still to do (a tiny, invisible hint). */
  onProgress?: (remaining: number, current?: string) => void;
  /** Called after a page was replaced (and verified). */
  onRebuilt?: (documentId: string) => void;
}

export type RebuildOutcome = 'rebuilt' | 'skipped' | 'leased' | 'lost' | 'changed' | 'mismatch';

const DEFAULT_MIN_BYTES = 40_000;
const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_GRACE_MS = 10_000;
const UPLOAD_WAIT_MS = 5 * 60_000;
const IDLE_TICK_MS = 20_000;
const AFTER_REBUILT_DELAY_MS = 1_500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Captured {
  projection: PageDocV3;
  heads: string[];
  strokeIds: string[];
  elementIds: string[];
}

function strokesOf(page: LivePageDocV2): string[] {
  return page.zOrder.filter((id) => page.elementsById[id]?.kind === 'stroke');
}

/**
 * Whether the document itself holds enough strokes as elements for the rebuild to move them into
 * segments, which is what makes a page slow. A page can be large for other reasons (hundreds of
 * printout pictures), and sealing leaves a few strokes as elements (short runs are cheaper that
 * way), so neither counts.
 */
export function hasLegacyInk(document: Automerge.Doc<unknown>): boolean {
  const elements = (document as unknown as { elementsById?: Record<string, unknown> }).elementsById;
  if (!elements) return false;
  let strokes = 0;
  for (const id of Object.keys(elements)) {
    const element = elements[id] as { kind?: unknown; tombstonedAt?: unknown } | undefined;
    if (element?.kind === 'stroke' && element.tombstonedAt === undefined && (strokes += 1) >= DEFAULT_SEAL_OPTIONS.minRun) return true;
  }
  return false;
}

/**
 * Whether two snapshots of a page hold the same ink and elements: the same strokes in the same
 * order with the same samples (to the precision segments hold), colours and sizes, and the same
 * other elements.
 */
export function sameContent(before: LivePageDocV2, after: LivePageDocV2): boolean {
  if (before.title !== after.title || before.pageId !== after.pageId) return false;
  if (before.zOrder.length !== after.zOrder.length) return false;
  for (let index = 0; index < before.zOrder.length; index += 1) {
    const id = before.zOrder[index];
    if (id !== after.zOrder[index]) return false;
    const a = before.elementsById[id];
    const b = after.elementsById[id];
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === 'stroke' && b.kind === 'stroke') {
      if (a.color !== b.color || a.size !== b.size || a.tool !== b.tool || a.points.length !== b.points.length) return false;
      for (let at = 0; at < a.points.length; at += 1) {
        const p = a.points[at];
        const q = b.points[at];
        if (Math.abs(p.x - q.x) > 1 / 200 || Math.abs(p.y - q.y) > 1 / 200 || Math.abs(p.pressure - q.pressure) > 1 / 200) return false;
      }
    }
  }
  return true;
}

export class LegacyPageRebuilder {
  private readonly runtime: RebuildRuntime;
  private readonly now: () => Date;
  private readonly minBytes: number;
  private readonly settleMs: number;
  private readonly leaseTtlMs: number;
  private readonly graceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sizes = new Map<string, number>();
  private readonly legacyInk = new Map<string, boolean>();
  private readonly failedAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = true;
  private openedQueue: string[] = [];
  private readonly droppable = new Map<string, { replacement: string; notebookDocumentId: string; since: number }>();

  constructor(private readonly options: LegacyRebuildOptions) {
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
    this.minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(5_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** A page was opened: if it is legacy it is rebuilt at once, as soon as the pen is still. */
  onPageOpened(pageId: string): void {
    if (this.stopped) return;
    if (!this.openedQueue.includes(pageId)) this.openedQueue.push(pageId);
    this.schedule(300);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().then((outcome) => {
        // A page that was rebuilt is followed by the next one at once (the quiet-time check still gates
        // it); waiting out the idle interval after every page made 100 pages a matter of an hour.
        if (!this.stopped) this.schedule(this.openedQueue.length > 0 ? 1_000 : outcome === 'rebuilt' ? AFTER_REBUILT_DELAY_MS : IDLE_TICK_MS);
      });
    }, delayMs);
  }

  private state(): V2RuntimeState | undefined {
    const state = this.runtime.getState();
    return state.schemaVersion === 3 ? (state as V2RuntimeState) : undefined;
  }

  /** The stored size of a page's listed document, cached for the session. */
  private async sizeOf(documentId: string): Promise<number> {
    const known = this.sizes.get(documentId);
    if (known !== undefined) return known;
    const size = await this.runtime.storedDocumentBytes(documentId).catch(() => 0);
    this.sizes.set(documentId, size);
    return size;
  }

  /** Whether a page's document holds strokes of its own; looked at once per document. */
  private async holdsLegacyInk(documentId: string): Promise<boolean> {
    const known = this.legacyInk.get(documentId);
    if (known !== undefined) return known;
    if (this.options.inkFree?.has(documentId)) {
      this.legacyInk.set(documentId, false);
      return false;
    }
    // A document that cannot be read is treated as a candidate: the rebuild then fails and is tried later.
    const holds = await this.runtime.readDocument(documentId, (document) => hasLegacyInk(document)).catch(() => true);
    this.legacyInk.set(documentId, holds);
    if (!holds) this.options.inkFree?.add(documentId);
    return holds;
  }

  private listedPageDocuments(state: V2RuntimeState): Array<{ documentId: string; pageId: string }> {
    const listed: Array<{ documentId: string; pageId: string }> = [];
    // Looked up by document id: a notebook of hundreds of pages must not cost a scan per page.
    const pageIds = new Map(state.pages.map((page) => [page.documentId, page.pageId] as const));
    for (const notebook of state.notebooks) {
      for (const section of notebook.sections) {
        for (const documentId of section.pageDocumentIds) {
          const pageId = pageIds.get(documentId);
          if (pageId !== undefined) listed.push({ documentId, pageId });
        }
      }
    }
    return listed;
  }

  /** Legacy candidates in the order they should be rebuilt: recent pages, then the heaviest. */
  private async candidates(state: V2RuntimeState): Promise<Array<{ documentId: string; pageId: string; size: number }>> {
    const recent = this.options.recentPageIds?.() ?? [];
    const recentSet = new Set(recent);
    const pages = this.listedPageDocuments(state);
    // Measure recent pages first, the rest one after the other while nothing else needs the thread.
    const ordered = [
      ...recent.flatMap((pageId) => pages.filter((page) => page.pageId === pageId)),
      ...pages.filter((page) => !recentSet.has(page.pageId)),
    ];
    const found: Array<{ documentId: string; pageId: string; size: number }> = [];
    for (const page of ordered) {
      const size = await this.sizeOf(page.documentId);
      if (size >= this.minBytes) found.push({ ...page, size });
    }
    const rank = (pageId: string): number => {
      const at = recent.indexOf(pageId);
      return at >= 0 && at < 10 ? at : Number.POSITIVE_INFINITY;
    };
    return found.sort((left, right) => (rank(left.pageId) - rank(right.pageId)) || (right.size - left.size));
  }

  /** One step of the background loop: drop what is due, else rebuild the next page. Public for tests. */
  async tick(): Promise<RebuildOutcome | 'idle'> {
    if (this.stopped || this.busy) return 'idle';
    if (this.options.canRun && !this.options.canRun()) return 'idle';
    this.busy = true;
    try {
      return await this.step();
    } catch (error) {
      // Typically a topology commit that raced the user's own change; the page is tried again later.
      console.error('[ink] the background rebuild of legacy pages stopped for now', error);
      return 'idle';
    } finally {
      this.busy = false;
    }
  }

  private async step(): Promise<RebuildOutcome | 'idle'> {
    await this.dropDue();
    const state = this.state();
    if (!state) return 'idle';
    const openedPageId = this.openedQueue.shift();
    if (openedPageId) {
      const page = state.pages.find((candidate) => candidate.pageId === openedPageId
        && this.listedPageDocuments(state).some((listed) => listed.documentId === candidate.documentId));
      // What the page weighs now, not what it weighed when it was first measured.
      if (page) this.sizes.delete(page.documentId);
      const failedRecently = page && (this.failedAt.get(page.documentId) ?? 0) + 10 * 60_000 > this.now().getTime();
      if (page && !failedRecently && await this.sizeOf(page.documentId) >= this.minBytes && await this.holdsLegacyInk(page.documentId)) {
        // The user is looking at it: wait for a quiet moment, then do it now.
        if (this.options.isQuiet && !this.options.isQuiet(1_500)) {
          this.openedQueue.unshift(openedPageId);
          return 'idle';
        }
        return await this.rebuildDocument(page.documentId);
      }
      return 'idle';
    }
    if (this.options.isQuiet && !this.options.isQuiet(15_000)) return 'idle';
    const now = this.now().getTime();
    const candidates = (await this.candidates(state))
      .filter((candidate) => (this.failedAt.get(candidate.documentId) ?? 0) + 10 * 60_000 < now);
    // The first page that holds strokes of its own is next; the pages behind it are counted without
    // loading them (each check loads a document, which takes a moment), and a page that turns out to
    // hold none is not looked at again.
    let next: { documentId: string; pageId: string; size: number } | undefined;
    let behind = 0;
    for (const candidate of candidates) {
      if (next) behind += 1;
      else if (await this.holdsLegacyInk(candidate.documentId)) next = candidate;
    }
    this.options.onProgress?.(next ? behind + 1 : 0, next?.pageId);
    if (!next) return 'idle';
    const outcome = await this.rebuildDocument(next.documentId);
    this.options.onProgress?.(Math.max(0, behind + (outcome === 'rebuilt' ? 0 : 1)));
    return outcome;
  }

  private notebookOf(state: V2RuntimeState, documentId: string): { notebook: LiveNotebookDocV2; sectionId: string } | undefined {
    for (const notebook of state.notebooks) {
      const section = notebook.sections.find((candidate) => candidate.pageDocumentIds.includes(documentId));
      if (section) return { notebook, sectionId: section.id };
    }
    return undefined;
  }

  private async commit(
    message: string,
    build: (state: V2RuntimeState) => Omit<WorkspaceGraphRevisionRequest, 'operationId' | 'expectedActivationArtifactFingerprint' | 'message'>,
  ): Promise<V2RuntimeState> {
    const ready = await this.runtime.ensureSchemaV3();
    return this.runtime.commitWorkspaceGraphRevision({
      operationId: `ink-rebuild-${message}-${this.now().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      expectedActivationArtifactFingerprint: ready.activation.artifactFingerprint,
      message: `Rebuild page (${message})`,
      ...build(ready),
    });
  }

  private async capture(documentId: string): Promise<Captured> {
    return this.runtime.readDocument(documentId, (document) => {
      const snapshot = getSharedAutomergeSnapshot<LivePageDocV2>(document as PageAutomergeDoc);
      const elementsById: PageDocV3['elementsById'] = {};
      for (const [elementId, element] of Object.entries(snapshot.elementsById)) {
        if (element.kind === 'richText') {
          const { text: _text, ...metadata } = structuredClone(element);
          void _text;
          elementsById[elementId] = { ...metadata, content: projectLiveRichText(document as PageAutomergeDoc, elementId) } as PageElementV3;
        } else elementsById[elementId] = structuredClone(element) as PageElementV3;
      }
      const projection = {
        ...structuredClone(snapshot),
        schemaVersion: 3,
        elementsById,
        version: { protocol: 'uninitialized', heads: [] },
      } as unknown as PageDocV3;
      return {
        projection,
        heads: [...Automerge.getHeads(document)],
        strokeIds: strokesOf(snapshot),
        elementIds: [...snapshot.zOrder],
      };
    });
  }

  /**
   * Rebuilds one page in place. Returns why it did not when it did not; a page left as it was is
   * safe to try again later.
   */
  async rebuildDocument(documentId: string): Promise<RebuildOutcome> {
    const start = this.state();
    if (!start) return 'skipped';
    const located = this.notebookOf(start, documentId);
    if (!located) return 'skipped';
    const { deviceId } = this.options;
    const notebookDocumentId = located.notebook.documentId;
    const nowMs = this.now().getTime();

    const rival = leaseWinner(located.notebook, documentId, nowMs);
    if (rival && rival !== deviceId) return 'leased';

    // Claim, then give a rival claim time to arrive before acting on it.
    await this.commit('claim', () => ({
      changes: [{
        documentId: notebookDocumentId,
        change: (document) => claimChange(documentId, deviceId, this.now(), this.leaseTtlMs)(document as unknown as Record<string, unknown>),
      }],
    }));
    const release = async (): Promise<void> => {
      await this.commit('release', () => ({
        changes: [{ documentId: notebookDocumentId, change: (document) => releaseChange(documentId, deviceId)(document as unknown as Record<string, unknown>) }],
      })).catch(() => undefined);
    };
    await this.sleep(this.settleMs);
    const afterSettle = this.state()?.notebooks.find((notebook) => notebook.documentId === notebookDocumentId);
    if (!afterSettle || leaseWinner(afterSettle, documentId, this.now().getTime()) !== deviceId) {
      await release();
      return 'lost';
    }

    try {
      await this.runtime.sealPendingInk(documentId);
      const captured = await this.capture(documentId);
      const replacement = nextGenerationDocumentId(documentId);
      const newProjection = { ...captured.projection, documentId: replacement } as PageDocV3;

      // Nothing may have changed in the original since the copy was taken.
      const heads = this.runtime.getDocumentHeads(documentId);
      if (!heads || heads.length !== captured.heads.length || !captured.heads.every((head) => heads.includes(head))) {
        await release();
        return 'changed';
      }

      await this.commit('swap', (state) => {
        const located2 = this.notebookOf(state, documentId);
        if (!located2) throw new Error('The page left its section while it was rebuilt.');
        return {
          newDocuments: [newProjection],
          changes: [{
            documentId: notebookDocumentId,
            change: (document) => {
              if (document.kind !== 'notebook') return;
              const section = document.sections.find((candidate) => candidate.id === located2.sectionId);
              if (!section) throw new Error('The section changed while its page was rebuilt.');
              const index = section.pageDocumentIds.indexOf(documentId);
              if (index < 0) throw new Error('The page changed places while it was rebuilt.');
              // The claim must still be ours at the moment of the swap.
              if (leaseWinner(document as unknown as object, documentId, this.now().getTime()) !== deviceId) {
                throw new Error('The rebuild claim is no longer ours.');
              }
              // Same place, same section: the list entry is replaced, not moved.
              section.pageDocumentIds.splice(index, 1, replacement);
              section.updatedAt = this.now().toISOString();
              releaseChange(documentId)(document as unknown as Record<string, unknown>);
            },
          }],
          updateManifest: (manifest) => {
            manifest.pageDocumentIds = [...manifest.pageDocumentIds.filter((id) => id !== replacement), replacement];
          },
        };
      });

      // Strokes drawn while the swap was under way belong to the new document.
      const stray = pendingInk().strokes(documentId);
      for (const stroke of stray) pendingInk().upsert(replacement, stroke);
      pendingInk().clear(documentId, stray.map((stroke) => stroke.id));

      const verified = await this.runtime.readDocument(replacement, (document) => {
        const after = getSharedAutomergeSnapshot<LivePageDocV2>(document as PageAutomergeDoc);
        return { after, count: strokesOf(after).length };
      });
      const original = await this.runtime.readDocument(documentId, (document) => getSharedAutomergeSnapshot<LivePageDocV2>(document as PageAutomergeDoc));
      if (verified.count !== captured.strokeIds.length || !sameContent(original, verified.after)) {
        await this.revert(documentId, replacement, notebookDocumentId);
        return 'mismatch';
      }
      this.droppable.set(documentId, { replacement, notebookDocumentId, since: this.now().getTime() });
      // Whatever strokes the copy still holds as elements cannot be moved any further: it is done, however
      // large it stays, so it is never rebuilt again.
      this.legacyInk.set(replacement, false);
      this.options.inkFree?.add(replacement);
      this.options.onRebuilt?.(documentId);
      return 'rebuilt';
    } catch (error) {
      this.failedAt.set(documentId, this.now().getTime());
      await release();
      console.error('[ink] rebuilding a page failed; it stays as it was', error);
      return 'skipped';
    }
  }

  /** The copy did not match: put the original back in its place and forget the copy. */
  private async revert(documentId: string, replacement: string, notebookDocumentId: string): Promise<void> {
    this.failedAt.set(documentId, this.now().getTime());
    await this.commit('revert', (state) => {
      const located = this.notebookOf(state, replacement);
      return {
        removedDocumentIds: [replacement],
        changes: [{
          documentId: notebookDocumentId,
          change: (document) => {
            if (document.kind !== 'notebook') return;
            for (const section of document.sections) {
              const index = section.pageDocumentIds.indexOf(replacement);
              if (index >= 0 && located) section.pageDocumentIds.splice(index, 1, documentId);
            }
          },
        }],
        updateManifest: (manifest) => {
          manifest.pageDocumentIds = manifest.pageDocumentIds.filter((id) => id !== replacement);
        },
      };
    });
  }

  /** Whether every segment the copy references is in the cloud (or there is no cloud to wait for). */
  private async uploaded(replacement: string): Promise<boolean> {
    const store = inkSegments();
    if (!store.hasRemote()) return true;
    const hashes = this.runtime.getState().schemaVersion === 3
      ? (this.state()?.pages.find((page) => page.documentId === replacement)?.assets ?? [])
        .filter((asset) => asset.mimeType === 'application/vnd.canvink.ink-segment')
        .map((asset) => asset.assetId.slice('sha256:'.length))
      : [];
    const pending = new Set(await store.localBackend.pendingUploads());
    return hashes.every((hash) => !pending.has(hash));
  }

  /** Drops originals whose replacement is verified, in the cloud, and has had its grace period. */
  private async dropDue(): Promise<void> {
    const state = this.state();
    if (!state) return;
    for (const [documentId, entry] of [...this.droppable]) {
      if (!state.pages.some((page) => page.documentId === documentId)) {
        this.droppable.delete(documentId);
        continue;
      }
      if (this.now().getTime() - entry.since < this.graceMs) continue;
      const waited = this.now().getTime() - entry.since;
      if (!(await this.uploaded(entry.replacement)) && waited < UPLOAD_WAIT_MS) continue;
      await this.commit('drop', () => ({
        removedDocumentIds: [documentId],
        // Other devices retire the original from the personal space when they see this field.
        changes: [{
          documentId: entry.notebookDocumentId,
          change: (document) => {
            (document as unknown as Record<string, unknown>)[`${SWAP_PREFIX}${entry.replacement}`] = documentId;
          },
        }],
        updateManifest: (manifest) => {
          manifest.pageDocumentIds = manifest.pageDocumentIds.filter((id) => id !== documentId);
        },
      })).catch(() => undefined);
      this.droppable.delete(documentId);
    }
  }

  /** Test seam: the claims currently visible for a page. */
  claimsOn(documentId: string): string[] {
    const state = this.state();
    const located = state && this.notebookOf(state, documentId);
    return located ? activeClaims(located.notebook, documentId, this.now().getTime()).map((claim) => claim.deviceId) : [];
  }
}
