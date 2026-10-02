import { describe, expect, it } from "vitest";
import type { StrokePointV2 } from "../domain/v2";
import {
  createHeldInkShapeElement,
  recognizeHeldInkShape,
} from "./inkShapeRecognition";

function strokePoints(points: ReadonlyArray<readonly [number, number]>): StrokePointV2[] {
  return points.map(([x, y], index) => ({
    x,
    y,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    time: index * 12,
    pointerType: "pen",
  }));
}

describe("held ink shape recognition", () => {
  it("turns a rough hand-drawn box into a clean rectangle", () => {
    const candidate = recognizeHeldInkShape(strokePoints([
      [20, 20], [55, 18], [95, 20], [130, 23],
      [132, 50], [129, 82], [94, 85], [54, 84],
      [18, 80], [17, 52], [20, 20],
    ]));

    expect(candidate?.shape).toBe("rectangle");
    expect(Math.max(candidate!.frame.width, candidate!.frame.height)).toBeGreaterThan(100);
    expect(Math.min(candidate!.frame.width, candidate!.frame.height)).toBeGreaterThan(50);
  });

  it("recognizes a held circle or ellipse without changing its pen styling", () => {
    const points = Array.from({ length: 41 }, (_, index) => {
      const angle = index / 40 * Math.PI * 2;
      return [100 + Math.cos(angle) * 62, 80 + Math.sin(angle) * 38] as const;
    });
    const candidate = recognizeHeldInkShape(strokePoints(points));
    expect(candidate?.shape).toBe("ellipse");

    const element = createHeldInkShapeElement({
      candidate: candidate!,
      id: "shape-1",
      timestamp: "2026-08-05T12:00:00.000Z",
      color: "#1d4ed8",
      strokeWidth: 3,
    });
    expect(element).toMatchObject({
      id: "shape-1",
      kind: "shape",
      shape: "ellipse",
      strokeColor: "#1d4ed8",
      strokeWidth: 3,
    });
  });

  it("straightens a held freehand line", () => {
    const candidate = recognizeHeldInkShape(strokePoints([
      [15, 20], [45, 22], [80, 23], [115, 24], [150, 25],
    ]));
    expect(candidate?.shape).toBe("line");
    expect(candidate?.points).toEqual([{ x: 15, y: 20 }, { x: 150, y: 25 }]);
  });

  it("does not reinterpret open handwriting or small marks", () => {
    expect(recognizeHeldInkShape(strokePoints([
      [10, 10], [30, 40], [45, 12], [60, 42], [75, 15], [95, 45],
    ]))).toBeUndefined();
    expect(recognizeHeldInkShape(strokePoints([
      [10, 10], [13, 11], [15, 12], [17, 11],
    ]))).toBeUndefined();
  });
});
