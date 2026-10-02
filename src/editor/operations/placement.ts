interface Frame { x: number; y: number; width: number; height: number }

interface PlacedElement {
  kind: string;
  frame: Frame;
  locked?: boolean;
  tombstonedAt?: string | null;
}

const GAP = 24;

/**
 * Where a newly inserted box goes when the user did not point at a spot:
 * the wanted position, moved down below whatever box it would cover, so
 * repeated inserts stack instead of landing on top of each other. Ink and
 * backgrounds (locked elements) are writing surface, not obstacles.
 */
export function freeSpotBelow(elements: Iterable<PlacedElement>, wanted: Frame): Frame {
  const obstacles = [...elements].filter((element) =>
    element.kind !== "stroke" && !element.locked && !element.tombstonedAt);
  const frame = { ...wanted };
  // Each move clears at least one obstacle, so this ends after at most one
  // pass per obstacle.
  for (let guard = 0; guard <= obstacles.length; guard += 1) {
    const hit = obstacles.find(({ frame: other }) =>
      frame.x < other.x + other.width && other.x < frame.x + frame.width
      && frame.y < other.y + other.height && other.y < frame.y + frame.height);
    if (!hit) break;
    frame.y = hit.frame.y + hit.frame.height + GAP;
  }
  return frame;
}
