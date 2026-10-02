import { describe, expect, it } from "vitest";
import { freeSpotBelow } from "./placement";

const box = (x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}) =>
  ({ kind: "richText", frame: { x, y, width, height }, ...extra });

describe("freeSpotBelow", () => {
  it("keeps the wanted spot when it is free", () => {
    expect(freeSpotBelow([box(500, 0, 100, 100)], { x: 80, y: 80, width: 360, height: 120 }))
      .toEqual({ x: 80, y: 80, width: 360, height: 120 });
  });

  it("stacks repeated inserts below each other", () => {
    const first = box(80, 80, 360, 120);
    const second = box(80, 224, 360, 120);
    expect(freeSpotBelow([first, second], { x: 80, y: 80, width: 360, height: 120 }).y).toBe(368);
  });

  it("writes over ink and backgrounds instead of avoiding them", () => {
    const wanted = { x: 80, y: 80, width: 360, height: 120 };
    expect(freeSpotBelow([
      { kind: "stroke", frame: { x: 90, y: 90, width: 50, height: 50 } },
      box(0, 0, 800, 1100, { kind: "pdf", locked: true }),
    ], wanted)).toEqual(wanted);
  });
});
