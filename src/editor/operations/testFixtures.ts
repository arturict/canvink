import type { RichTextElementV2, StrokeElementV2 } from '../../domain/v2/types';

export function stroke(overrides: Partial<StrokeElementV2> = {}): StrokeElementV2 {
  return {
    id: 'stroke-1',
    kind: 'stroke',
    frame: { x: 0, y: 0, width: 40, height: 0, rotation: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    locked: false,
    tool: 'pen',
    points: [0, 10, 20, 30, 40].map((x, index) => ({
      x,
      y: 0,
      // Values the packed stroke form stores exactly, so tests hold under either write format.
      pressure: (index % 3) / 2,
      tiltX: index,
      tiltY: 0 - index,
      time: index * 10,
      pointerType: 'pen',
    })),
    color: '#000000',
    size: 2,
    opacity: 1,
    ...overrides,
  };
}

export function richText(overrides: Partial<RichTextElementV2> = {}): RichTextElementV2 {
  return {
    id: 'text-1',
    kind: 'richText',
    frame: { x: 10, y: 10, width: 100, height: 50, rotation: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    locked: false,
    content: {
      type: 'doc',
      blocks: [{ id: 'block-1', type: 'paragraph', spans: [{ text: 'hello', marks: [] }] }],
    },
    style: { color: '#000000', fontFamily: 'sans-serif', fontSize: 16, textAlign: 'left' },
    ...overrides,
  };
}

