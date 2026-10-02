import { describe, expect, it } from 'vitest';
import { eraseStrokePoints, eraseWholeStroke, reconcileStrokeTombstone } from './eraser';
import { stroke } from './testFixtures';

describe('immutable stroke erasers', () => {
  it('tombstones the source and creates immutable surviving segments', () => {
    const source = stroke();
    const result = eraseStrokePoints(source, [{ x: 20, y: 0 }], 1, 'erase-time', (root, erased, index) => `${root}:${erased}:${index}`);

    expect(result.changed).toBe(true);
    expect(result.source.tombstonedAt).toBe('erase-time');
    expect(result.segments).toHaveLength(2);
    expect(result.segments.map((segment) => segment.sourceStrokeId)).toEqual(['stroke-1', 'stroke-1']);
    expect(result.segments[0].points.map((point) => [point.x, point.pressure, point.time])).toEqual([
      [0, 0, 0],
      [10, 0.5, 10],
    ]);
    expect(result.segments.every((segment) => !Object.hasOwn(segment, 'tombstonedAt'))).toBe(true);
    expect(source.tombstonedAt).toBeUndefined();
  });

  it('applies minimum-point rules to zero-length strokes', () => {
    const dot = stroke({ points: [stroke().points[0]], frame: { x: 0, y: 0, width: 0, height: 0, rotation: 0 } });
    const erased = eraseStrokePoints(dot, [{ x: 0, y: 0 }], 2, 'erase-time', () => 'segment');
    expect(erased.source.tombstonedAt).toBe('erase-time');
    expect(erased.segments).toEqual([]);
    expect(eraseStrokePoints(dot, [{ x: 100, y: 100 }], 2, 'erase-time', () => 'segment').changed).toBe(false);
  });

  it('is idempotent when the source has already been tombstoned', () => {
    const first = eraseWholeStroke(stroke(), 'first');
    const second = eraseStrokePoints(first.source, [{ x: 0, y: 0 }], 5, 'second', () => 'bad');
    expect(second).toEqual({ source: first.source, segments: [], changed: false });
  });

  it('prevents an offline stale live version from resurrecting a tombstoned stroke', () => {
    const tombstone = eraseWholeStroke(stroke({ updatedAt: '2026-01-01' }), '2026-01-02').source;
    const staleOffline = stroke({ updatedAt: '2026-01-03' });
    expect(reconcileStrokeTombstone(tombstone, staleOffline).tombstonedAt).toBe('2026-01-02');
  });
});
