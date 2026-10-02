import { describe, expect, it } from "vitest";
import type { LivePageDocV2 } from "../crdt";
import { initialViewportFor } from "./initialViewport";

type Elements = LivePageDocV2["elementsById"];

function element(id: string, x: number, y: number, width = 100, height = 40, extra: Record<string, unknown> = {}) {
  return {
    id, kind: "stroke", frame: { x, y, width, height, rotation: 0 }, locked: false, ...extra,
  };
}

function page(elements: ReturnType<typeof element>[], pageType: "free" | "a4" = "free") {
  return {
    pageType,
    elementsById: Object.fromEntries(elements.map((item) => [item.id, item])) as unknown as Elements,
  };
}

const VIEW = { width: 1000, height: 700 };
const OFFSET = { x: 24, y: 24 };

describe("initialViewportFor", () => {
  it("keeps the plain start when content is in the first screen", () => {
    expect(initialViewportFor(page([element("a", 40, 60), element("b", 100, 5000)]), VIEW, OFFSET)).toBeNull();
  });

  it("keeps the plain start for an empty page and for a fixed sheet", () => {
    expect(initialViewportFor(page([]), VIEW, OFFSET)).toBeNull();
    expect(initialViewportFor(page([element("a", 40, 4000)], "a4"), VIEW, OFFSET)).toBeNull();
  });

  it("scrolls down to the topmost content that lies below the first screen", () => {
    const view = initialViewportFor(page([element("a", 118, 2835), element("b", 300, 4000)]), VIEW, OFFSET);
    expect(view).toEqual({ zoom: 1, panX: 0, panY: -(2835 - 24) });
  });

  it("also scrolls right when the topmost content lies beyond the first screen's width", () => {
    const view = initialViewportFor(page([element("a", 3000, 900, 200)]), VIEW, OFFSET);
    expect(view).toEqual({ zoom: 1, panX: -(3000 - 24), panY: -(900 - 24) });
  });

  it("keeps the plain start when a printout fills the first screen and notes lie further down", () => {
    const printout = element("bg", 0, 0, 800, 1100, { kind: "image", locked: true });
    expect(initialViewportFor(page([printout, element("a", 60, 1500)]), VIEW, OFFSET)).toBeNull();
  });

  it("scrolls to a printout that starts below the first screen", () => {
    const printout = element("bg", 36, 1200, 800, 1100, { kind: "pdf", locked: true });
    expect(initialViewportFor(page([printout]), VIEW, OFFSET)).toEqual({ zoom: 1, panX: 0, panY: -(1200 - 24) });
  });

  it("ignores erased strokes", () => {
    const erased = element("gone", 40, 60, 100, 40, { tombstonedAt: "2026-09-30T08:00:00.000Z" });
    expect(initialViewportFor(page([erased, element("a", 50, 3000)]), VIEW, OFFSET)).toEqual({ zoom: 1, panX: 0, panY: -(3000 - 24) });
  });

  it("ignores elements with unusable frames", () => {
    const broken = element("x", Number.NaN, 10);
    expect(initialViewportFor(page([broken, element("a", 50, 3000)]), VIEW, OFFSET)).toEqual({ zoom: 1, panX: 0, panY: -(3000 - 24) });
  });
});
