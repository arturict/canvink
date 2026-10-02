import type { StrokeElementV2 } from '../domain/v2';

/**
 * A closing or reloading page can be cut off while its asynchronous writes
 * (IndexedDB, the ink journal) are still running, and the strokes drawn in the
 * last moments are then gone. `localStorage` is written synchronously, so the
 * editor puts the strokes it wrote recently, and the ones still waiting, there
 * when the page is hidden. The next start puts back those the page lacks
 * (strokes have ids, so one that did get saved is not added twice).
 */
const KEY_PREFIX = 'canvink:unsaved-ink:';
/** Beyond this the record is skipped: a localStorage quota error must never break closing. */
const MAX_BYTES = 1_500_000;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function stashUnsavedInk(documentId: string, strokes: readonly StrokeElementV2[]): void {
  const store = storage();
  if (!store) return;
  try {
    if (strokes.length === 0) {
      store.removeItem(KEY_PREFIX + documentId);
      return;
    }
    const json = JSON.stringify(strokes);
    if (json.length <= MAX_BYTES) store.setItem(KEY_PREFIX + documentId, json);
  } catch {
    // Without storage the page's own write is all there is.
  }
}

function isStroke(item: unknown): item is StrokeElementV2 {
  if (typeof item !== 'object' || item === null) return false;
  const candidate = item as { kind?: unknown; id?: unknown; points?: unknown };
  return candidate.kind === 'stroke' && typeof candidate.id === 'string' && Array.isArray(candidate.points);
}

/** The stashed strokes of a page, which are forgotten once read. */
export function takeUnsavedInk(documentId: string): StrokeElementV2[] {
  const store = storage();
  if (!store) return [];
  try {
    const json = store.getItem(KEY_PREFIX + documentId);
    store.removeItem(KEY_PREFIX + documentId);
    const parsed: unknown = json ? JSON.parse(json) : [];
    return Array.isArray(parsed) ? parsed.filter(isStroke) : [];
  } catch {
    return [];
  }
}
