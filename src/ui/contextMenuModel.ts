/**
 * Pure parts of the context menu: where it opens and which item a key moves
 * to. Kept free of React and the DOM so they can be tested in Node.
 */

export interface MenuPoint {
  x: number;
  y: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Distance the menu keeps from the window edge. */
export const MENU_EDGE_MARGIN = 6;

/**
 * Places a menu at the pointer like a desktop context menu: down and to the
 * right of the point, flipped to the other side of the point when it would
 * cross the right or bottom edge, and finally clamped into the window.
 */
export function placeMenu(point: MenuPoint, size: MenuSize, viewport: Viewport): MenuPoint {
  let x = point.x;
  let y = point.y;
  if (x + size.width > viewport.width - MENU_EDGE_MARGIN) x = point.x - size.width;
  if (y + size.height > viewport.height - MENU_EDGE_MARGIN) y = point.y - size.height;
  const maxX = Math.max(MENU_EDGE_MARGIN, viewport.width - size.width - MENU_EDGE_MARGIN);
  const maxY = Math.max(MENU_EDGE_MARGIN, viewport.height - size.height - MENU_EDGE_MARGIN);
  return {
    x: Math.round(Math.min(Math.max(MENU_EDGE_MARGIN, x), maxX)),
    y: Math.round(Math.min(Math.max(MENU_EDGE_MARGIN, y), maxY)),
  };
}

/**
 * Places a menu under a button: its right edge on the button's right edge
 * (`end`) or its left edge on the button's left edge (`start`), flipped above
 * the button when it would cross the bottom edge, and clamped into the window.
 */
export function placeBelow(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: MenuSize,
  viewport: Viewport,
  align: 'start' | 'end',
  gap = 6,
): MenuPoint {
  const x = align === 'end' ? anchor.right - size.width : anchor.left;
  const below = anchor.bottom + gap;
  const y = below + size.height > viewport.height - MENU_EDGE_MARGIN ? anchor.top - gap - size.height : below;
  const maxX = Math.max(MENU_EDGE_MARGIN, viewport.width - size.width - MENU_EDGE_MARGIN);
  const maxY = Math.max(MENU_EDGE_MARGIN, viewport.height - size.height - MENU_EDGE_MARGIN);
  return {
    x: Math.round(Math.min(Math.max(MENU_EDGE_MARGIN, x), maxX)),
    y: Math.round(Math.min(Math.max(MENU_EDGE_MARGIN, y), maxY)),
  };
}

/**
 * Places a submenu beside its parent item: to the right when it fits, else
 * to the left, aligned with the item's top and clamped vertically.
 */
export function placeSubmenu(
  item: { left: number; right: number; top: number },
  size: MenuSize,
  viewport: Viewport,
): MenuPoint {
  const fitsRight = item.right + size.width <= viewport.width - MENU_EDGE_MARGIN;
  const x = fitsRight ? item.right - 2 : item.left - size.width + 2;
  return placeMenu({ x, y: item.top - 5 }, size, viewport);
}

/**
 * The next enabled index when moving through a menu with the arrow keys,
 * wrapping at both ends. Returns -1 when nothing is enabled.
 */
export function nextEnabledIndex(
  enabled: readonly boolean[],
  current: number,
  direction: 1 | -1,
): number {
  const count = enabled.length;
  if (count === 0 || !enabled.some(Boolean)) return -1;
  let index = current;
  for (let step = 0; step < count; step += 1) {
    index = (index + direction + count) % count;
    if (enabled[index]) return index;
  }
  return -1;
}

/** First enabled index whose label starts with `letter` after `current` (typeahead). */
export function typeaheadIndex(
  labels: readonly string[],
  enabled: readonly boolean[],
  current: number,
  letter: string,
): number {
  const wanted = letter.toLocaleLowerCase();
  const count = labels.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (current + step + count) % count;
    if (enabled[index] && labels[index].trim().toLocaleLowerCase().startsWith(wanted)) return index;
  }
  return -1;
}
