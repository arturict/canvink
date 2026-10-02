import { describe, expect, it } from "vitest";
import {
  clampToBounds,
  doubleTapViewport,
  dragAxis,
  dragViewport,
  fitZoom,
  flingStep,
  openingViewport,
  pageSwipe,
  readingBounds,
  readingContentRect,
  releaseVelocity,
  rubberBand,
  viewportForRegion,
} from "./readingViewport";

const phone = { width: 400, height: 800 };
const insets = { top: 64, bottom: 56 };
const text = (x: number, y: number, width: number, height: number) => ({ kind: "richText", frame: { x, y, width, height } });

describe("reading view of a page on a phone", () => {
  it("fits a desktop page's content width to the screen and starts below the app bar", () => {
    const content = readingContentRect([text(72, 72, 560, 400), text(72, 600, 700, 300)], null);
    expect(content.x).toBe(0);
    expect(content.width).toBeGreaterThanOrEqual(772);
    const view = openingViewport(content, phone, insets);
    expect(view.zoom).toBeCloseTo((400 - 20) / content.width, 2);
    // The page's left edge sits at the side padding, its top under the chrome.
    expect(view.panX).toBeCloseTo(10, 0);
    expect(view.panY).toBe(64 + 16);
  });

  it("starts at the content of a OneNote page that begins far down", () => {
    const content = readingContentRect([text(100, 1300, 500, 200)], null);
    expect(content.y).toBe(1276);
    const view = openingViewport(content, phone, insets);
    expect(view.panY).toBeCloseTo(80 - 1276 * view.zoom, 3);
  });

  it("ignores erased ink and never fits a single short line larger than reading size", () => {
    const content = readingContentRect([
      { kind: "stroke", frame: { x: 3000, y: 0, width: 10, height: 10 }, tombstonedAt: "2026-01-01T00:00:00Z" },
      text(10, 10, 100, 20),
    ], null);
    expect(content.width).toBe(320);
    expect(fitZoom(content, 400)).toBeLessThanOrEqual(1.2);
  });

  it("keeps a fitted page from moving sideways and stops at its last line", () => {
    const content = { x: 0, y: 0, width: 760, height: 3000 };
    const zoom = fitZoom(content, phone.width);
    const bounds = readingBounds(content, phone, zoom, insets);
    expect(bounds.minPanX).toBeCloseTo(bounds.maxPanX, 5);
    const bottom = clampToBounds({ zoom, panX: 0, panY: -1e6 }, bounds);
    // The last content ends above the bottom chrome.
    expect(bottom.panY + 3000 * zoom).toBeCloseTo(800 - 56 - 16, 5);
  });

  it("stretches past an edge with growing resistance", () => {
    const bounds = { minPanX: 0, maxPanX: 0, minPanY: -1000, maxPanY: 80 };
    const small = dragViewport({ zoom: 1, panX: 0, panY: 80 + 40 }, bounds, { x: 400, y: 800 });
    const large = dragViewport({ zoom: 1, panX: 0, panY: 80 + 400 }, bounds, { x: 400, y: 800 });
    expect(small.overshoot.y).toBe(40);
    expect(small.viewport.panY - 80).toBeLessThan(40);
    expect(large.viewport.panY - 80).toBeLessThan(400);
    expect(large.viewport.panY).toBeGreaterThan(small.viewport.panY);
    expect(Math.abs(rubberBand(1e7, 300))).toBeLessThan(300);
  });

  it("scrolls vertically unless the finger clearly goes sideways", () => {
    expect(dragAxis({ x: 3, y: 4 }, false)).toBeNull();
    expect(dragAxis({ x: 10, y: 30 }, false)).toBe("y");
    expect(dragAxis({ x: 40, y: 10 }, false)).toBe("x");
    expect(dragAxis({ x: 40, y: 10 }, true)).toBe("free");
  });

  it("turns the page after a long or quick swipe past the side, never for a vertical scroll", () => {
    expect(pageSwipe(-80, 0, "x")).toBe("next");
    expect(pageSwipe(80, 0, "x")).toBe("previous");
    expect(pageSwipe(-40, 0, "x")).toBeNull();
    expect(pageSwipe(-40, -1, "x")).toBe("next");
    expect(pageSwipe(-200, 0, "y")).toBeNull();
  });

  it("keeps a flick moving, slowing down, until it reaches the end of the page", () => {
    const bounds = { minPanX: 0, maxPanX: 0, minPanY: -2000, maxPanY: 0 };
    let state: { viewport: { zoom: number; panX: number; panY: number }; velocity: { x: number; y: number } } | null = {
      viewport: { zoom: 1, panX: 0, panY: 0 },
      velocity: { x: 0, y: -3 },
    };
    let travelled = 0;
    let frames = 0;
    while (state && frames < 1000) {
      const next = flingStep(state.viewport, state.velocity, bounds, 16);
      if (!next) break;
      travelled = -next.viewport.panY;
      expect(Math.abs(next.velocity.y)).toBeLessThanOrEqual(Math.abs(state.velocity.y));
      state = next;
      frames += 1;
    }
    expect(travelled).toBeGreaterThan(500);
    expect(travelled).toBeLessThanOrEqual(2000);
    expect(frames).toBeLessThan(1000);
  });

  it("measures the release speed from the last moments of a drag", () => {
    const samples = [
      { x: 0, y: 0, time: 0 },
      { x: 0, y: -100, time: 100 },
      { x: 0, y: -200, time: 150 },
      { x: 0, y: -300, time: 200 },
    ];
    expect(releaseVelocity(samples).y).toBeCloseTo(-2, 5);
  });

  it("zooms in on a double tap and back to the fitted width on the next", () => {
    const content = { x: 0, y: 0, width: 760, height: 3000 };
    const opened = openingViewport(content, phone, insets);
    const zoomed = doubleTapViewport(opened, { x: 200, y: 300 }, content, phone, insets);
    expect(zoomed.zoom).toBeGreaterThan(opened.zoom * 2);
    const back = doubleTapViewport(zoomed, { x: 200, y: 300 }, content, phone, insets);
    expect(back.zoom).toBeCloseTo(opened.zoom, 5);
    expect(back.panX).toBe(opened.panX);
  });

  it("shows a text box at a size to type in", () => {
    const content = { x: 0, y: 0, width: 900, height: 2000 };
    const view = viewportForRegion({ x: 72, y: 500, width: 360, height: 40 }, content, phone, insets);
    expect(view.zoom).toBeGreaterThan(fitZoom(content, phone.width));
    expect(view.zoom).toBeLessThanOrEqual(1.25);
    expect(view.panY + 500 * view.zoom).toBeCloseTo(80, 5);
  });
});
