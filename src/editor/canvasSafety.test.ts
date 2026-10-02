import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_SIDE,
  MAX_INK_TILES,
  MAX_TILE_SIDE,
  clampCanvasSize,
  inkTileSize,
  safeCanvasDpr,
} from "./canvasSafety";

describe("clampCanvasSize", () => {
  it("leaves an allocatable size alone", () => {
    expect(clampCanvasSize(3840, 2160)).toEqual({ width: 3840, height: 2160 });
  });

  it("keeps the side and the area inside what browsers allocate, with the aspect ratio", () => {
    for (const [width, height] of [[20000, 600], [9000, 9000], [100000, 100000], [5000, 12000]]) {
      const size = clampCanvasSize(width, height);
      expect(size.width).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
      expect(size.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
      expect(size.width * size.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
      expect(Math.abs(size.width / size.height / (width / height) - 1)).toBeLessThan(0.01);
    }
  });

  it("never returns an empty or non-finite canvas", () => {
    expect(clampCanvasSize(0, 0)).toEqual({ width: 1, height: 1 });
    expect(clampCanvasSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ width: 1, height: 1 });
    expect(clampCanvasSize(1_000_000, 1)).toEqual({ width: MAX_CANVAS_SIDE, height: 1 });
  });
});

describe("safeCanvasDpr", () => {
  it("keeps the screen's ratio where the canvas fits", () => {
    expect(safeCanvasDpr(1920, 1080, 2)).toBe(2);
  });

  it("lowers the ratio so a huge window stays allocatable", () => {
    const dpr = safeCanvasDpr(7000, 4000, 3);
    expect(dpr).toBeLessThan(3);
    const size = clampCanvasSize(7000 * dpr, 4000 * dpr);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(size.width).toBeCloseTo(7000 * dpr, -1);
  });

  it("falls back to 1 for a broken ratio", () => {
    expect(safeCanvasDpr(800, 600, 0)).toBe(1);
    expect(safeCanvasDpr(800, 600, Number.NaN)).toBe(1);
  });
});

describe("inkTileSize", () => {
  const view = (width: number, height: number) => ({ x: 0, y: 0, width, height });

  it("keeps the base size for a view that needs few tiles", () => {
    expect(inkTileSize(512, 1, view(1600, 1200))).toBe(512);
  });

  it("grows tiles instead of creating hundreds of canvases when zoomed far out", () => {
    const tile = inkTileSize(512, 0.5, view(60000, 40000));
    const count = (Math.floor(60000 / tile) + 1) * (Math.floor(40000 / tile) + 1);
    expect(count).toBeLessThanOrEqual(MAX_INK_TILES);
    expect(Math.ceil(tile * 0.5)).toBeLessThanOrEqual(MAX_TILE_SIDE);
  });

  it("never lets a tile pass the tile side limit", () => {
    const tile = inkTileSize(512, 4, view(1_000_000, 1_000_000));
    expect(Math.ceil(tile * 4)).toBeLessThanOrEqual(MAX_TILE_SIDE);
  });
});
