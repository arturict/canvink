import type { StrokeElementV2 } from '../../domain/v2';
import {
  DEFAULT_MATH_PAGE_SETTINGS,
  type MathElementV3,
  type PageDocV3,
  type PageElementV3,
} from '../../domain/v3';

export const TEST_TIME = '2026-08-03T12:00:00.000Z';

export function mathElement(
  id: string,
  latex: string,
  options: { readonly x?: number; readonly y?: number } = {},
): MathElementV3 {
  return {
    id,
    kind: 'math',
    frame: { x: options.x ?? 0, y: options.y ?? 0, width: 100, height: 40, rotation: 0 },
    createdAt: TEST_TIME,
    updatedAt: TEST_TIME,
    locked: false,
    inputKind: 'typed',
    autoRecognition: 'inherit',
    typedLatex: latex,
    recognition: { state: 'idle', alternatives: [], warnings: [] },
    result: { state: 'none', diagnostics: [] },
    dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'valid' },
  };
}

export function stroke(id: string, x: number, y: number, pointCount = 2): StrokeElementV2 {
  const points = Array.from({ length: pointCount }, (_, index) => ({
    x: x + index,
    y: y + index,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    time: index,
    pointerType: 'pen',
  }));
  return {
    id,
    kind: 'stroke',
    frame: { x, y, width: Math.max(0, pointCount - 1), height: Math.max(0, pointCount - 1), rotation: 0 },
    createdAt: TEST_TIME,
    updatedAt: TEST_TIME,
    locked: false,
    tool: 'pen',
    points,
    color: '#000000',
    size: 2,
    opacity: 1,
  };
}

export function inkMathElement(id = 'math-ink'): MathElementV3 {
  const source = stroke('source-stroke', 10, 20);
  return {
    ...mathElement(id, ''),
    inputKind: 'converted-ink',
    typedLatex: undefined,
    rawInk: {
      captureFrame: { ...source.frame },
      sourceStrokes: [structuredClone(source)],
    },
  };
}

export function page(elements: readonly PageElementV3[]): PageDocV3 {
  return {
    schemaVersion: 3,
    documentId: 'page-document',
    kind: 'page',
    notebookId: 'notebook',
    sectionId: 'section',
    pageId: 'page',
    title: 'Math page',
    tags: [],
    pageType: 'free',
    background: { type: 'plain', color: '#ffffff' },
    createdAt: TEST_TIME,
    updatedAt: TEST_TIME,
    elementsById: Object.fromEntries(elements.map((element) => [element.id, element])),
    zOrder: elements.map((element) => element.id),
    version: { protocol: 'uninitialized', heads: [] },
    mathSettings: { ...DEFAULT_MATH_PAGE_SETTINGS },
  };
}
