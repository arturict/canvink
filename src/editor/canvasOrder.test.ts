import { describe, expect, it } from 'vitest';
import type { ImageElementV2, PdfElementV2 } from '../domain/v2';
import type { PageElementV3 } from '../domain/v3';
import {
  backgroundAt,
  canBecomeBackground,
  isBackgroundElement,
  orderWithBackgrounds,
  reorderElements,
} from './canvasOrder';
import { buildPageLayers } from './InkLayers';
import { selectByLasso, strokesCrossedBy } from './inkGeometry';
import { constrainViewport } from './LiveCanvasEditor';
import { richText, stroke } from './operations/testFixtures';

const TIME = '2026-09-24T08:00:00.000Z';
const asset = { assetId: 'sha256:a', checksum: 'sha256:a', mimeType: 'image/png', size: 1, role: 'original' } as const;

function image(id: string, locked = false): ImageElementV2 {
  return {
    id, kind: 'image', frame: { x: 0, y: 0, width: 400, height: 300, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked, asset, alt: id,
  };
}

function pdf(id: string, locked = true): PdfElementV2 {
  return {
    id, kind: 'pdf', frame: { x: 72, y: 72, width: 600, height: 800, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked,
    previewAsset: { ...asset, role: 'preview' }, pageCount: 1, sourceAvailability: 'preview-only',
  };
}

function page(elements: PageElementV3[]): Record<string, PageElementV3> {
  return Object.fromEntries(elements.map((element) => [element.id, element]));
}

describe('page backgrounds', () => {
  it('are locked images and PDF pages only', () => {
    expect(isBackgroundElement(pdf('sheet'))).toBe(true);
    expect(isBackgroundElement(image('photo'))).toBe(false);
    expect(isBackgroundElement(stroke({ locked: true }))).toBe(false);
    expect(canBecomeBackground(image('photo'))).toBe(true);
    expect(canBecomeBackground(richText())).toBe(false);
  });

  it('are painted below every ink run and element, whatever their page order', () => {
    const elements = page([stroke({ id: 'ink' }), pdf('sheet'), richText({ id: 'note' })]);
    const layers = buildPageLayers(['ink', 'sheet', 'note'], elements);
    expect(layers.map((layer) => [layer.kind === 'ink' ? layer.key : layer.id, layer.zIndex])).toEqual([
      ['ink:ink', 1],
      ['sheet', 0],
      ['note', 3],
    ]);
  });

  it('are skipped by lasso and eraser but still found by a right-click', () => {
    const elements = page([pdf('sheet'), stroke({ id: 'answer', points: stroke().points.map((point) => ({ ...point, x: point.x + 100, y: 100 })) })]);
    const lasso = [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 900 }, { x: 0, y: 900 }];
    expect(selectByLasso(elements, lasso)).toEqual(['answer']);
    expect(strokesCrossedBy(elements, { x: 90, y: 100 }, { x: 160, y: 100 }, 6)).toEqual(['answer']);
    expect(backgroundAt(elements, ['sheet', 'answer'], { x: 300, y: 400 })).toBe('sheet');
    expect(backgroundAt(elements, ['sheet', 'answer'], { x: 10, y: 10 })).toBeUndefined();
  });

  it('move below everything else when an image is set as background', () => {
    const elements = page([richText({ id: 'note' }), image('photo'), stroke({ id: 'ink' })]);
    expect(orderWithBackgrounds(['note', 'photo', 'ink'], elements, ['photo'])).toEqual(['photo', 'note', 'ink']);
  });
});

describe('Reihenfolge commands', () => {
  const elements = page([pdf('sheet'), stroke({ id: 'a' }), stroke({ id: 'b' }), richText({ id: 'c' }), image('d')]);
  const order = ['sheet', 'a', 'b', 'c', 'd'];

  it('brings to front and sends to back, keeping backgrounds at the bottom', () => {
    expect(reorderElements(order, elements, ['a'], 'front')).toEqual(['sheet', 'b', 'c', 'd', 'a']);
    expect(reorderElements(order, elements, ['d'], 'back')).toEqual(['sheet', 'd', 'a', 'b', 'c']);
  });

  it('moves one level forward or backward past the neighbour', () => {
    expect(reorderElements(order, elements, ['b'], 'forward')).toEqual(['sheet', 'a', 'c', 'b', 'd']);
    expect(reorderElements(order, elements, ['c', 'd'], 'backward')).toEqual(['sheet', 'a', 'c', 'd', 'b']);
    expect(reorderElements(order, elements, ['d'], 'forward')).toEqual(order);
  });
});

describe('free page viewport', () => {
  it('never shows desk above or left of a free page', () => {
    expect(constrainViewport({ zoom: 0.5, panX: 120, panY: -40 }, true)).toEqual({ zoom: 0.5, panX: 0, panY: -40 });
    expect(constrainViewport({ zoom: 0.5, panX: 120, panY: 80 }, false)).toEqual({ zoom: 0.5, panX: 120, panY: 80 });
  });
});
