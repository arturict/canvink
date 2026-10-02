import { describe, expect, it } from 'vitest';
import type { StrokeElementV2 } from '../domain/v2';
import { extendsStrokes } from './InkLayers';

function stroke(id: string): StrokeElementV2 {
  return {
    id,
    kind: 'stroke',
    frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    createdAt: '',
    updatedAt: '',
    locked: false,
    tool: 'pen',
    points: [],
    color: '#000',
    size: 3,
    opacity: 1,
  };
}

describe('extendsStrokes', () => {
  const [a, b, c] = [stroke('a'), stroke('b'), stroke('c')];

  it('is true when strokes were only added at the end, so a tile can paint just those', () => {
    expect(extendsStrokes([a], [a, b])).toBe(true);
    expect(extendsStrokes([], [a])).toBe(true);
    expect(extendsStrokes([a, b], [a, b, c])).toBe(true);
  });

  it('is false for anything that needs the tile repainted from scratch', () => {
    expect(extendsStrokes([a, b], [a, b])).toBe(false);
    expect(extendsStrokes([a, b], [a])).toBe(false);
    expect(extendsStrokes([a, b], [b, a, c])).toBe(false);
    expect(extendsStrokes([a, b], [a, stroke('b'), c])).toBe(false);
    expect(extendsStrokes([a], [c, a])).toBe(false);
  });
});
