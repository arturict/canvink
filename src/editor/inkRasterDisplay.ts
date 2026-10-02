import { loadV2UiState } from "../components/v2WorkspaceView";
import { featureOverrideAllowed } from "../config/featureFlags";
import { inkRasterStore, type InkRasterRecord } from "./inkRasterStore";
import type { Rect } from "./operations/geometry";

/**
 * The showing half of the ink picture cache (see inkRaster.ts): looking a
 * picture up, decoding it and placing it. Kept free of the editor so the
 * startup screen can show the picture before the notebook's code has loaded.
 */

export interface InkRasterPlacement {
  /** The editor's viewport, relative to the element the picture is shown in. */
  box: Rect;
  /** The paper, relative to `box`. */
  paper: Rect;
  /** The picture, relative to `box`, in CSS pixels (zoom 1). */
  ink: Rect;
}

/**
 * Where a stored picture goes in an element whose top-left corner is at
 * `container` on screen. The page opens at zoom 1, so a page unit is a CSS
 * pixel and the picture covers `bounds` from the page's origin.
 */
export function inkRasterPlacement(
  record: Pick<InkRasterRecord, "origin" | "bounds" | "view" | "paper">,
  container: { left: number; top: number },
): InkRasterPlacement {
  const { view, paper, origin, bounds } = record;
  return {
    box: { x: view.x - container.left, y: view.y - container.top, width: view.width, height: view.height },
    paper: { x: paper.x - view.x, y: paper.y - view.y, width: paper.width, height: paper.height },
    ink: { x: origin.x + bounds.x - view.x, y: origin.y + bounds.y - view.y, width: bounds.width, height: bounds.height },
  };
}

export interface ShownInkRaster {
  record: InkRasterRecord;
  bitmap: ImageBitmap;
}

/**
 * A page's stored picture, decoded and ready to paint, or null when there is
 * none, it cannot be read, or it takes longer than `timeoutMs`.
 *
 * A build that allows feature overrides (the e2e build) can set
 * `window.__canvinkInkRasterWaitMs` to widen the wait. The short default keeps
 * a slow lookup from delaying a page, but on a busy machine it would decide
 * whether the picture shows at all, which a test of the picture cannot accept.
 */
export async function loadInkRaster(pageId: string, timeoutMs: number): Promise<ShownInkRaster | null> {
  const store = inkRasterStore();
  const widened = featureOverrideAllowed(import.meta.env) && typeof window !== "undefined"
    ? (window as Window & { __canvinkInkRasterWaitMs?: number }).__canvinkInkRasterWaitMs
    : undefined;
  if (typeof widened === "number" && widened > timeoutMs) timeoutMs = widened;
  if (!store || typeof createImageBitmap !== "function") return null;
  let expired = false;
  const load = (async () => {
    const record = await store.load(pageId);
    if (!record) return null;
    const bitmap = await createImageBitmap(record.blob);
    if (expired) {
      bitmap.close();
      return null;
    }
    return { record, bitmap };
  })().catch(() => null);
  const timeout = new Promise<null>((resolve) => setTimeout(() => {
    expired = true;
    resolve(null);
  }, timeoutMs));
  return Promise.race([load, timeout]);
}

/** How long the startup waits for the start page's picture; its database is opened cold. */
export const STARTUP_INK_RASTER_WAIT_MS = 250;

let startup: Promise<ShownInkRaster | null> | null | undefined;
let startupFound: ShownInkRaster | null = null;

/**
 * The picture of the page the app opens on (the page last viewed on this
 * device), looked up once per start; null when there is no such page.
 */
export function startupInkRaster(): Promise<ShownInkRaster | null> | null {
  if (startup !== undefined) return startup;
  let pageId: string | undefined;
  try {
    pageId = loadV2UiState(typeof window === "undefined" ? null : window.localStorage).recentPageIds[0];
  } catch {
    pageId = undefined;
  }
  startup = pageId
    ? loadInkRaster(pageId, STARTUP_INK_RASTER_WAIT_MS).then((raster) => {
      startupFound = raster;
      return raster;
    })
    : null;
  return startup;
}

/**
 * The start page's picture when it has already been found, so a screen that
 * takes over from another shows it in its first frame, without a gap.
 */
export function startupInkRasterFound(): ShownInkRaster | null {
  return startupFound;
}
