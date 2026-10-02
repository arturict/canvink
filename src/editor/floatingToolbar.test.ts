import { describe, expect, it } from "vitest";
import {
  DEFAULT_FULL_PAGE_TOOLBAR,
  clampToViewport,
  effectiveEdge,
  loadFullPageToolbar,
  nearestEdge,
  nudgeToolbar,
  offsetAlongEdge,
  placeToolbar,
  saveFullPageToolbar,
} from "./floatingToolbar";

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

describe("floating toolbar geometry", () => {
  it("snaps to the edge nearest to where the drag ended", () => {
    expect(nearestEdge({ x: 700, y: 30 }, desktop)).toBe("top");
    expect(nearestEdge({ x: 20, y: 450 }, desktop)).toBe("left");
    expect(nearestEdge({ x: 1420, y: 600 }, desktop)).toBe("right");
    expect(nearestEdge({ x: 700, y: 880 }, desktop)).toBe("bottom");
  });

  it("uses only the side edges on a phone", () => {
    expect(nearestEdge({ x: 300, y: 10 }, phone)).toBe("right");
    expect(nearestEdge({ x: 100, y: 830 }, phone)).toBe("left");
    expect(effectiveEdge("top", phone)).toBe("left");
    expect(effectiveEdge("right", phone)).toBe("right");
    expect(effectiveEdge("top", desktop)).toBe("top");
  });

  it("keeps the toolbar inside the window whatever the window size", () => {
    const size = { width: 700, height: 44 };
    expect(placeToolbar("top", 0.5, size, desktop)).toEqual({ x: 370, y: 8 });
    // Centred near the right end, it stops at the margin.
    expect(placeToolbar("top", 0.98, size, desktop)).toEqual({ x: 732, y: 8 });
    // The same place after the window became narrower.
    expect(placeToolbar("top", 0.98, size, { width: 800, height: 600 })).toEqual({ x: 92, y: 8 });
    expect(placeToolbar("right", 0.5, { width: 44, height: 700 }, desktop)).toEqual({ x: 1388, y: 100 });
    // Larger than the window: pinned to the margin rather than off-screen.
    expect(placeToolbar("bottom", 0.5, { width: 2000, height: 44 }, desktop)).toEqual({ x: 8, y: 848 });
    expect(clampToViewport({ x: -40, y: 2000 }, { width: 44, height: 300 }, desktop)).toEqual({ x: 8, y: 592 });
  });

  it("records the place along the edge as a fraction", () => {
    expect(offsetAlongEdge("top", { x: 360, y: 0 }, desktop)).toBe(0.25);
    expect(offsetAlongEdge("left", { x: 0, y: 675 }, desktop)).toBe(0.75);
    expect(offsetAlongEdge("left", { x: 0, y: -10 }, desktop)).toBe(0);
  });

  it("moves along the edge or across to another edge with the arrow keys", () => {
    expect(nudgeToolbar({ edge: "top", offset: 0.5 }, "ArrowRight", desktop)).toEqual({ edge: "top", offset: 0.6 });
    expect(nudgeToolbar({ edge: "top", offset: 0.5 }, "ArrowLeft", desktop)?.offset).toBeCloseTo(0.4);
    expect(nudgeToolbar({ edge: "top", offset: 0.5 }, "ArrowDown", desktop)).toEqual({ edge: "bottom", offset: 0.5 });
    expect(nudgeToolbar({ edge: "top", offset: 0.5 }, "ArrowUp", desktop)).toBeNull();
    expect(nudgeToolbar({ edge: "left", offset: 0.95 }, "ArrowDown", desktop)).toEqual({ edge: "left", offset: 1 });
    // A phone has no top edge to move to.
    expect(nudgeToolbar({ edge: "left", offset: 0.5 }, "ArrowUp", phone)?.edge).toBe("left");
    expect(nudgeToolbar({ edge: "left", offset: 0.5 }, "ArrowRight", phone)).toEqual({ edge: "right", offset: 0.5 });
  });

  it("remembers its state per device and ignores damaged storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(loadFullPageToolbar(storage)).toEqual(DEFAULT_FULL_PAGE_TOOLBAR);
    saveFullPageToolbar(storage, { mode: "docked", edge: "right", offset: 0.3, collapsed: true });
    expect(loadFullPageToolbar(storage)).toEqual({ mode: "docked", edge: "right", offset: 0.3, collapsed: true });
    store.set("canvink.fullPageToolbar.v1", "{\"edge\":\"middle\",\"offset\":7}");
    expect(loadFullPageToolbar(storage)).toEqual({ ...DEFAULT_FULL_PAGE_TOOLBAR, offset: 1 });
    store.set("canvink.fullPageToolbar.v1", "not json");
    expect(loadFullPageToolbar(storage)).toEqual(DEFAULT_FULL_PAGE_TOOLBAR);
    expect(loadFullPageToolbar(null)).toEqual(DEFAULT_FULL_PAGE_TOOLBAR);
  });
});
