import { describe, expect, it } from 'vitest';
import { richText, stroke } from './testFixtures';
import {
  selectElementsInPolygon,
  selectElementsInRect,
  resizeSelectionFromCorner,
  transformSelection,
  MAX_LASSO_POINTS,
} from './geometry';
import {
  distanceToRulerEdge,
  rulerEdgePoints,
  snapPointToAngle,
  snapPointToGrid,
  snapPointToRuler,
  snapPointToRulerEdge,
} from './snapping';

describe('lasso, selection transforms, and snapping', () => {
  it('selects intersecting frames with rectangle and self-intersecting polygon lassos', () => {
    const elements = { text: richText({ id: 'text', frame: { x: 4, y: 4, width: 2, height: 2, rotation: 0 } }) };
    expect(selectElementsInRect(elements, { x: 0, y: 0, width: 10, height: 10 })).toEqual(['text']);
    expect(
      selectElementsInPolygon(elements, [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 10, y: 0 },
      ]),
    ).toEqual(['text']);
  });

  it('handles a zero-area lasso without selecting distant elements', () => {
    const elements = { text: richText({ id: 'text' }) };
    expect(selectElementsInRect(elements, { x: 0, y: 0, width: 0, height: 0 })).toEqual([]);
    expect(() =>
      selectElementsInPolygon(
        elements,
        Array.from({ length: MAX_LASSO_POINTS + 1 }, (_, index) => ({ x: index, y: 0 })),
      ),
    ).toThrow(/exceeds/);
  });

  it('immutably transforms selected stroke points and leaves locked elements untouched', () => {
    const selected = stroke({ id: 'selected' });
    const locked = richText({ id: 'locked', locked: true });
    const source = { selected, locked };
    const transformed = transformSelection(
      source,
      ['selected', 'locked'],
      { translateX: 10, translateY: 5 },
      'later',
    );
    expect(transformed.selected.frame.x).toBe(10);
    expect(transformed.selected.kind === 'stroke' && transformed.selected.points[0].x).toBe(10);
    expect(transformed.locked).toBe(locked);
    expect(source.selected.frame.x).toBe(0);
  });

  it('scales a selection proportionally from every corner and clamps inversion', () => {
    const bounds = { x: 10, y: 20, width: 100, height: 50 };
    expect(resizeSelectionFromCorner(bounds, 'south-east', { x: 210, y: 120 })).toMatchObject({
      scaleX: 2,
      scaleY: 2,
      origin: { x: 10, y: 20 },
    });
    expect(resizeSelectionFromCorner(bounds, 'north-west', { x: 60, y: 45 })).toMatchObject({
      scaleX: 0.5,
      scaleY: 0.5,
      origin: { x: 110, y: 70 },
    });
    expect(resizeSelectionFromCorner(bounds, 'south-east', { x: 0, y: 0 })).toMatchObject({
      scaleX: 0.1,
      scaleY: 0.1,
    });
  });

  it('snaps to grids, angle increments, and infinite ruler lines', () => {
    expect(snapPointToGrid({ x: 14, y: 16 }, 10)).toEqual({ x: 10, y: 20 });
    const angle = snapPointToAngle({ x: 0, y: 0 }, { x: 9, y: 2 }, 45);
    expect(angle.y).toBeCloseTo(0);
    expect(snapPointToRuler({ x: 4, y: 6 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ x: 4, y: 0 });
    expect(snapPointToRuler({ x: 4, y: 6 }, { x: 2, y: 2 }, { x: 2, y: 2 })).toEqual({ x: 2, y: 2 });
  });

  it('projects nearby points to the visible edge of a freely rotated ruler', () => {
    const ruler = {
      center: { x: 200, y: 160 },
      angleDegrees: 37,
      length: 400,
      edgeOffset: -32,
    };
    const [start, end] = rulerEdgePoints(ruler);
    expect(Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI).toBeCloseTo(37);

    const tangent = {
      x: Math.cos(37 * Math.PI / 180),
      y: Math.sin(37 * Math.PI / 180),
    };
    const onEdge = {
      x: start.x + tangent.x * 120,
      y: start.y + tangent.y * 120,
    };
    const nearby = { x: onEdge.x - tangent.y * 12, y: onEdge.y + tangent.x * 12 };
    expect(distanceToRulerEdge(nearby, ruler)).toBeCloseTo(12);
    expect(snapPointToRulerEdge(nearby, ruler, 16)).toEqual(expect.objectContaining({
      x: expect.closeTo(onEdge.x, 8),
      y: expect.closeTo(onEdge.y, 8),
    }));
    expect(snapPointToRulerEdge(nearby, ruler, 8)).toEqual(nearby);
    const beyondVisibleEdge = {
      x: end.x + tangent.x * 80,
      y: end.y + tangent.y * 80,
    };
    expect(snapPointToRulerEdge(beyondVisibleEdge, ruler, 16)).toEqual(beyondVisibleEdge);
  });
});
