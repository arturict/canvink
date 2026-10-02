import type { PageElementV3 as PageElementV2 } from "../domain/v3";
import type { Point } from "./operations";

/**
 * Page backgrounds and element order, as in OneNote's context menu: an image
 * or PDF page "set as background" is stored as a locked element. It is drawn
 * below all ink and text, cannot be clicked, dragged, lassoed or erased, and
 * is only released again through the context menu. The `locked` field already
 * had this meaning for the PDF backgrounds of imported OneNote pages.
 */
export function isBackgroundElement(element: PageElementV2 | undefined): boolean {
  return Boolean(element && element.locked && (element.kind === "image" || element.kind === "pdf"));
}

/** Whether an element may become a page background. */
export function canBecomeBackground(element: PageElementV2 | undefined): boolean {
  return Boolean(element && !element.locked && (element.kind === "image" || element.kind === "pdf"));
}

function frameContains(frame: PageElementV2["frame"], point: Point): boolean {
  // Backgrounds are placed unrotated; a rotated one is tested by its box.
  return point.x >= frame.x && point.x <= frame.x + frame.width
    && point.y >= frame.y && point.y <= frame.y + frame.height;
}

/** The topmost background under a point, which a right-click still reaches. */
export function backgroundAt(
  elements: Readonly<Record<string, PageElementV2>>,
  order: readonly string[],
  point: Point,
): string | undefined {
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const element = elements[order[index]];
    if (isBackgroundElement(element) && element && frameContains(element.frame, point)) return element.id;
  }
  return undefined;
}

export type OrderAction = "front" | "forward" | "backward" | "back";

/**
 * The page order after moving `ids` as OneNote's "Reihenfolge" commands do.
 * Backgrounds always stay first, below everything else, so an element sent
 * to the back is still drawn above the worksheet it annotates, on screen and
 * in exports alike.
 */
export function reorderElements(
  order: readonly string[],
  elements: Readonly<Record<string, PageElementV2>>,
  ids: readonly string[],
  action: OrderAction,
): string[] {
  const moving = new Set(ids);
  const backgrounds = order.filter((id) => isBackgroundElement(elements[id]));
  const rest = order.filter((id) => !isBackgroundElement(elements[id]));
  let next: string[];
  if (action === "front") {
    next = [...rest.filter((id) => !moving.has(id)), ...rest.filter((id) => moving.has(id))];
  } else if (action === "back") {
    next = [...rest.filter((id) => moving.has(id)), ...rest.filter((id) => !moving.has(id))];
  } else {
    next = [...rest];
    if (action === "forward") {
      for (let index = next.length - 2; index >= 0; index -= 1) {
        if (moving.has(next[index]) && !moving.has(next[index + 1])) {
          [next[index], next[index + 1]] = [next[index + 1], next[index]];
        }
      }
    } else {
      for (let index = 1; index < next.length; index += 1) {
        if (moving.has(next[index]) && !moving.has(next[index - 1])) {
          [next[index], next[index - 1]] = [next[index - 1], next[index]];
        }
      }
    }
  }
  return [...backgrounds, ...next];
}

/** The order after making `ids` backgrounds: they move below everything else. */
export function orderWithBackgrounds(
  order: readonly string[],
  elements: Readonly<Record<string, PageElementV2>>,
  ids: readonly string[],
): string[] {
  const becoming = new Set(ids);
  const isBackground = (id: string) => becoming.has(id) || isBackgroundElement(elements[id]);
  return [...order.filter(isBackground), ...order.filter((id) => !isBackground(id))];
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
