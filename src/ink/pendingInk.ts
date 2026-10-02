import type { StrokeElementV2 } from '../domain/v2';
import { decodeInkSegment, encodeInkSegment, quantizeStroke } from './segmentCodec';
import { inkSegments } from './segmentStore';

/**
 * Strokes that are drawn but not yet sealed into a segment.
 *
 * Writing every stroke into the page document would put its Automerge
 * operations into the document's history for good, whatever happens to the
 * stroke later, and that history is what makes a heavily inked page slow to
 * open. So a stroke first lives here, in memory and in a small journal record
 * in local storage that survives a restart, and joins the document as part of
 * a segment a moment later (`sealPendingInk`). Until then snapshots of the
 * page show it on top of everything else, exactly where a stroke is drawn.
 */
export interface PendingInkListener {
  (documentId: string, count: number): void;
}

interface PendingPage {
  strokes: Map<string, StrokeElementV2>;
  version: number;
  cached?: { version: number; list: readonly StrokeElementV2[] };
}

const JOURNAL_DELAY_MS = 40;

export class PendingInk {
  private readonly pages = new Map<string, PendingPage>();
  private readonly listeners = new Set<PendingInkListener>();
  private readonly journalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly journalWrites = new Map<string, Promise<void>>();
  private counter = 0;

  /** Called after every change of a page's pending strokes. */
  subscribe(listener: PendingInkListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Changes whenever the page's pending strokes do; part of the key of cached snapshots. */
  version(documentId: string): number {
    return this.pages.get(documentId)?.version ?? 0;
  }

  count(documentId: string): number {
    return this.pages.get(documentId)?.strokes.size ?? 0;
  }

  has(documentId: string, strokeId: string): boolean {
    return this.pages.get(documentId)?.strokes.has(strokeId) ?? false;
  }

  /** The pending strokes in the order they were drawn. The list is shared and frozen. */
  strokes(documentId: string): readonly StrokeElementV2[] {
    const page = this.pages.get(documentId);
    if (!page) return [];
    if (!page.cached || page.cached.version !== page.version) {
      page.cached = { version: page.version, list: Object.freeze([...page.strokes.values()]) };
    }
    return page.cached.list;
  }

  documentsWithPendingInk(): string[] {
    return [...this.pages.entries()].filter(([, page]) => page.strokes.size > 0).map(([id]) => id);
  }

  private touch(documentId: string, page: PendingPage): void {
    this.counter += 1;
    page.version = this.counter;
    this.scheduleJournal(documentId);
    for (const listener of [...this.listeners]) listener(documentId, page.strokes.size);
  }

  /**
   * Adds a stroke or replaces the one with its id (an update keeps the place
   * in the drawing order). The stored copy has the precision a segment holds.
   */
  upsert(documentId: string, stroke: StrokeElementV2): void {
    let page = this.pages.get(documentId);
    if (!page) {
      page = { strokes: new Map(), version: 0 };
      this.pages.set(documentId, page);
    }
    const stored = { ...quantizeStroke(stroke) };
    // Snapshots share this object with the editor, so it is immutable.
    stored.points = stored.points.map((point) => ({ ...point }));
    for (const point of stored.points) Object.freeze(point);
    Object.freeze(stored.points);
    Object.freeze(stored.frame);
    page.strokes.set(stroke.id, Object.freeze(stored));
    this.touch(documentId, page);
  }

  remove(documentId: string, strokeId: string): boolean {
    const page = this.pages.get(documentId);
    if (!page?.strokes.delete(strokeId)) return false;
    this.touch(documentId, page);
    return true;
  }

  /** Forgets strokes that a segment now holds. */
  clear(documentId: string, strokeIds: Iterable<string>): void {
    const page = this.pages.get(documentId);
    if (!page) return;
    let changed = false;
    for (const id of strokeIds) changed = page.strokes.delete(id) || changed;
    if (changed) this.touch(documentId, page);
    if (page.strokes.size === 0 && changed) this.pages.delete(documentId);
  }

  private scheduleJournal(documentId: string): void {
    const previous = this.journalTimers.get(documentId);
    if (previous !== undefined) clearTimeout(previous);
    this.journalTimers.set(documentId, setTimeout(() => {
      this.journalTimers.delete(documentId);
      void this.writeJournal(documentId);
    }, JOURNAL_DELAY_MS));
  }

  /** Writes the journal record now; resolves when it is durable. */
  writeJournal(documentId: string): Promise<void> {
    const timer = this.journalTimers.get(documentId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.journalTimers.delete(documentId);
    }
    const strokes = this.strokes(documentId);
    const backend = inkSegments().localBackend;
    const previous = this.journalWrites.get(documentId) ?? Promise.resolve();
    const write = previous.then(() => backend.writeJournal(
      documentId,
      strokes.length === 0 ? undefined : encodeInkSegment(strokes),
    )).catch(() => undefined);
    this.journalWrites.set(documentId, write);
    return write;
  }

  /** Waits until every journal record written so far is durable. */
  async flushJournals(): Promise<void> {
    for (const documentId of [...this.journalTimers.keys()]) await this.writeJournal(documentId);
    await Promise.all([...this.journalWrites.values()]);
  }

  /**
   * Restores the strokes a previous session drew but did not get to seal
   * (the app closed or crashed within the sealing delay). Strokes the page
   * already shows are dropped by the caller, which knows the page.
   */
  async recover(documentId: string, alreadyShown: (strokeId: string) => boolean): Promise<number> {
    if (this.pages.has(documentId)) return 0;
    const bytes = await inkSegments().localBackend.readJournal(documentId);
    if (!bytes) return 0;
    let strokes: StrokeElementV2[];
    try {
      strokes = decodeInkSegment(bytes);
    } catch {
      return 0;
    }
    let restored = 0;
    for (const stroke of strokes) {
      if (alreadyShown(stroke.id)) continue;
      this.upsert(documentId, stroke);
      restored += 1;
    }
    if (restored === 0) await inkSegments().localBackend.writeJournal(documentId, undefined);
    return restored;
  }

  /** Page documents that have a journal record in local storage. */
  journaledDocuments(): Promise<string[]> {
    return inkSegments().localBackend.journalKeys();
  }

  /** Test seam. */
  reset(): void {
    for (const timer of this.journalTimers.values()) clearTimeout(timer);
    this.journalTimers.clear();
    this.journalWrites.clear();
    this.pages.clear();
  }
}

let sharedPending: PendingInk | undefined;

export function pendingInk(): PendingInk {
  sharedPending ??= new PendingInk();
  return sharedPending;
}

/** Version of a page's pending strokes without creating the registry (snapshot code calls this on every read). */
export function pendingInkVersion(documentId: string): number {
  return sharedPending?.version(documentId) ?? 0;
}

export function pendingInkStrokes(documentId: string): readonly StrokeElementV2[] {
  return sharedPending?.strokes(documentId) ?? [];
}
