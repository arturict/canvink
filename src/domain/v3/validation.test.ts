import { describe, expect, it } from 'vitest';
import { MAX_TEXT_CHARS } from '../limits';
import { assertV3ManifestMathData, assertV3PageMathGraph } from './validation';
import { pageContent, type GraphElementV3, type MathElementV3, type PageDocV3 } from './types';

const TIME = '2026-08-03T08:00:00.000Z';

function math(): MathElementV3 {
  return {
    id: 'math-1', kind: 'math', frame: { x: 0, y: 0, width: 120, height: 50, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, inputKind: 'typed',
    autoRecognition: 'inherit', typedLatex: 'y=x^2',
    recognition: { state: 'recognized', alternatives: [], warnings: [] },
    result: { state: 'valid', exactLatex: 'x^2', diagnostics: [] },
    dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: [], state: 'valid' },
  };
}

function graph(): GraphElementV3 {
  return {
    id: 'graph-1', kind: 'graph', frame: { x: 0, y: 60, width: 400, height: 300, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false,
    series: [{ id: 'series-1', sourceMathElementId: 'math-1', color: '#2463eb', visible: true }],
    viewport: { xMin: -10, xMax: 10, yMin: -10, yMax: 10, equalScale: true, axesVisible: true, gridVisible: true },
  };
}

describe('schema-v3 Math Canvas validation', () => {
  it('accepts bounded typed math and page-local graph references', () => {
    expect(() => assertV3PageMathGraph({
      mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
      elementsById: { 'math-1': math(), 'graph-1': graph() },
    })).not.toThrow();
  });

  it('validates strict canvas/Markdown page content and returns a cloned canvas default', () => {
    expect(() => assertV3PageMathGraph({
      pageContent: { version: 1, kind: 'markdown', source: '# Algebra\n\nx = 2' },
      elementsById: {},
    })).not.toThrow();
    expect(() => assertV3PageMathGraph({
      pageContent: { version: 1, kind: 'canvas', extra: true },
      elementsById: {},
    })).toThrow(/unsupported field extra/);
    expect(() => assertV3PageMathGraph({
      pageContent: { version: 1, kind: 'markdown', source: 'x'.repeat(MAX_TEXT_CHARS + 1) },
      elementsById: {},
    })).toThrow(/bounded string/);

    const legacy = { pageContent: undefined } as Pick<PageDocV3, 'pageContent'>;
    const first = pageContent(legacy);
    const second = pageContent(legacy);
    expect(first).toEqual({ version: 1, kind: 'canvas' });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('preserves complete bounded currency snapshot provenance', () => {
    const value = math();
    value.result.currencyRate = {
      base: 'CHF', quote: 'EUR', asOf: TIME, source: 'SNB snapshot', status: 'stale', snapshotVersion: 1,
    };
    expect(() => assertV3PageMathGraph({ elementsById: { 'math-1': value } })).not.toThrow();
    const malformed = structuredClone(value) as unknown as { result: { currencyRate: { snapshotVersion: number } } };
    malformed.result.currencyRate.snapshotVersion = 2;
    expect(() => assertV3PageMathGraph({ elementsById: { 'math-1': malformed } })).toThrow(/snapshotVersion/);
  });

  it.each(['endpoint', 'token', 'requestId'])('rejects persistent provider secret field %s', (field) => {
    const value = math() as unknown as Record<string, unknown>;
    const recognition = value.recognition as Record<string, unknown>;
    recognition.provider = { kind: 'mathpix', [field]: 'must-not-persist' };
    expect(() => assertV3PageMathGraph({ elementsById: { 'math-1': value } }))
      .toThrow(`unsupported field ${field}`);
  });

  it('rejects cross-page/missing graph sources and non-finite viewport data', () => {
    const missing = graph();
    expect(() => assertV3PageMathGraph({ elementsById: { 'graph-1': missing } }))
      .toThrow(/missing or non-math source/);
    const invalid = graph();
    invalid.viewport.xMax = Number.POSITIVE_INFINITY;
    expect(() => assertV3PageMathGraph({ elementsById: { 'math-1': math(), 'graph-1': invalid } }))
      .toThrow(/bounded finite number/);
  });

  it('also rejects provider secrets hidden in detached math trash records', () => {
    const detached = math() as unknown as Record<string, unknown>;
    (detached.recognition as Record<string, unknown>).provider = {
      kind: 'compatible-endpoint', endpoint: 'https://secret.example',
    };
    expect(() => assertV3ManifestMathData({
      schemaVersion: 3, format: 'canvink-schema-v3', trash: [{ element: detached }],
    })).toThrow(/unsupported field endpoint/);
  });
});
