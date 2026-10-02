/**
 * Geometry and the remembered state of the floating drawing toolbar of the
 * full page view (OneNote's floating ink toolbar). The toolbar always rests
 * against one edge of the window; its place along that edge is kept as the
 * fraction of the edge where its centre sits, so it survives resizing,
 * rotation and the change between a horizontal and a vertical layout.
 */

export type ToolbarEdge = "top" | "bottom" | "left" | "right";
export type FullPageToolbarMode = "floating" | "docked";

export interface FullPageToolbarState {
  /** "docked" keeps the Draw tab's command row across the top. */
  mode: FullPageToolbarMode;
  edge: ToolbarEdge;
  /** Centre of the toolbar along its edge, 0 (start) to 1 (end). */
  offset: number;
  collapsed: boolean;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

const STORAGE_KEY = "canvink.fullPageToolbar.v1";
const EDGES: readonly ToolbarEdge[] = ["top", "bottom", "left", "right"];

/** Distance between the toolbar and the window edge, in CSS pixels. */
export const TOOLBAR_MARGIN = 8;

/**
 * Narrower windows (phones in portrait) only use the side edges: a
 * horizontal strip of every pen would not fit across them.
 */
export const HORIZONTAL_MIN_WIDTH = 640;

export const DEFAULT_FULL_PAGE_TOOLBAR: FullPageToolbarState = {
  mode: "floating",
  edge: "top",
  offset: 0.5,
  collapsed: false,
};

export function isVerticalEdge(edge: ToolbarEdge): boolean {
  return edge === "left" || edge === "right";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The edge the toolbar actually uses in this window: on a phone a top or
 * bottom choice moves to the left side, where a right hand does not cover it.
 */
export function effectiveEdge(edge: ToolbarEdge, viewport: Size): ToolbarEdge {
  if (viewport.width >= HORIZONTAL_MIN_WIDTH || isVerticalEdge(edge)) return edge;
  return "left";
}

/** The window edge closest to a point, such as where a drag ended. */
export function nearestEdge(point: Point, viewport: Size): ToolbarEdge {
  const distances: Record<ToolbarEdge, number> = {
    top: point.y,
    bottom: viewport.height - point.y,
    left: point.x,
    right: viewport.width - point.x,
  };
  const candidates = viewport.width >= HORIZONTAL_MIN_WIDTH
    ? EDGES
    : EDGES.filter(isVerticalEdge);
  return candidates.reduce((best, edge) => (distances[edge] < distances[best] ? edge : best));
}

/** Where along an edge a toolbar centred on `centre` sits, as a fraction. */
export function offsetAlongEdge(edge: ToolbarEdge, centre: Point, viewport: Size): number {
  const length = isVerticalEdge(edge) ? viewport.height : viewport.width;
  const along = isVerticalEdge(edge) ? centre.y : centre.x;
  return length > 0 ? clamp(along / length, 0, 1) : 0.5;
}

/**
 * The top-left corner of a toolbar of `size` resting on `edge`, kept fully
 * inside the window with a margin; a toolbar larger than the window stays at
 * the margin.
 */
export function placeToolbar(
  edge: ToolbarEdge,
  offset: number,
  size: Size,
  viewport: Size,
  margin = TOOLBAR_MARGIN,
): Point {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  if (isVerticalEdge(edge)) {
    return {
      x: edge === "left" ? margin : maxLeft,
      y: clamp(offset * viewport.height - size.height / 2, margin, maxTop),
    };
  }
  return {
    x: clamp(offset * viewport.width - size.width / 2, margin, maxLeft),
    y: edge === "top" ? margin : maxTop,
  };
}

/** Keeps a toolbar that is being dragged inside the window. */
export function clampToViewport(corner: Point, size: Size, viewport: Size, margin = TOOLBAR_MARGIN): Point {
  return {
    x: clamp(corner.x, margin, Math.max(margin, viewport.width - size.width - margin)),
    y: clamp(corner.y, margin, Math.max(margin, viewport.height - size.height - margin)),
  };
}

const NUDGE = 0.1;

/**
 * Moves the toolbar with the arrow keys of its grip: along its edge in
 * steps, or across to the edge the arrow points at.
 */
export function nudgeToolbar(
  state: Pick<FullPageToolbarState, "edge" | "offset">,
  key: string,
  viewport: Size,
): Pick<FullPageToolbarState, "edge" | "offset"> | null {
  const edge = effectiveEdge(state.edge, viewport);
  const vertical = isVerticalEdge(edge);
  const along: Record<string, number> = vertical
    ? { ArrowUp: -NUDGE, ArrowDown: NUDGE }
    : { ArrowLeft: -NUDGE, ArrowRight: NUDGE };
  if (key in along) return { edge, offset: clamp(state.offset + along[key], 0, 1) };
  const across: Record<string, ToolbarEdge> = { ArrowUp: "top", ArrowDown: "bottom", ArrowLeft: "left", ArrowRight: "right" };
  const target = across[key];
  if (!target || target === edge || effectiveEdge(target, viewport) !== target) return null;
  return { edge: target, offset: state.offset };
}

export function loadFullPageToolbar(storage: Pick<Storage, "getItem"> | null): FullPageToolbarState {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as Partial<Record<keyof FullPageToolbarState, unknown>> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_FULL_PAGE_TOOLBAR;
    const edge = EDGES.find((candidate) => candidate === parsed.edge);
    return {
      mode: parsed.mode === "docked" ? "docked" : "floating",
      edge: edge ?? DEFAULT_FULL_PAGE_TOOLBAR.edge,
      offset: typeof parsed.offset === "number" && Number.isFinite(parsed.offset)
        ? clamp(parsed.offset, 0, 1)
        : DEFAULT_FULL_PAGE_TOOLBAR.offset,
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return DEFAULT_FULL_PAGE_TOOLBAR;
  }
}

export function saveFullPageToolbar(storage: Pick<Storage, "setItem"> | null, state: FullPageToolbarState): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Without storage the toolbar keeps its place for this session only.
  }
}
