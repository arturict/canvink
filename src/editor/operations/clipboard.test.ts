import { describe, expect, it } from 'vitest';
import type { GraphElementV3, MathElementV3, PageElementV3 } from '../../domain/v3';
import type { AssetRef } from '../../domain/v2';
import { pasteElementsFromClipboard, serializeElementsForClipboard } from './clipboard';
import { richText, stroke } from './testFixtures';

describe('strict editor clipboard', () => {
  it('serializes selected elements and remaps element, source, block, and z-order IDs', () => {
    const source = stroke({ id: 'source' });
    const segment = stroke({ id: 'segment', sourceStrokeId: 'source' });
    const text = richText();
    const serialized = serializeElementsForClipboard(
      { source, segment, [text.id]: text },
      ['source', 'segment', text.id],
      ['source', text.id, 'segment'],
    );
    const pasted = pasteElementsFromClipboard(serialized, (old, index) => `${old}:copy:${index}`);

    expect(pasted.zOrder).toEqual(['source:copy:0', 'text-1:copy:2', 'segment:copy:1']);
    const pastedSegment = pasted.elementsById['segment:copy:1'];
    expect(pastedSegment.kind === 'stroke' && pastedSegment.sourceStrokeId).toBe('source:copy:0');
    const pastedText = pasted.elementsById['text-1:copy:2'];
    expect(pastedText.kind === 'richText' && pastedText.content.blocks[0].id).not.toBe('block-1');
  });

  it('copies Math dependencies and Graph sources transitively and remaps every reference', () => {
    const source = mathElement({ id: 'math-source', typedLatex: 'a=2' });
    const dependent = mathElement({
      id: 'math-dependent',
      typedLatex: 'a+1',
      dependencies: { ...mathElement().dependencies, references: ['a'], dependsOnElementIds: ['math-source'] },
    });
    const graph = graphElement('math-dependent');
    const serialized = serializeElementsForClipboard(
      { 'math-source': source, 'math-dependent': dependent, graph },
      ['graph'],
      ['math-source', 'math-dependent', 'graph'],
    );
    const pasted = pasteElementsFromClipboard(serialized, (old, index) => `${old}:copy:${index}`);

    expect(pasted.zOrder).toEqual(['math-source:copy:2', 'math-dependent:copy:1', 'graph:copy:0']);
    const pastedDependent = pasted.elementsById['math-dependent:copy:1'];
    expect(pastedDependent.kind === 'math' && pastedDependent.dependencies.dependsOnElementIds)
      .toEqual(['math-source:copy:2']);
    const pastedGraph = pasted.elementsById['graph:copy:0'];
    expect(pastedGraph.kind === 'graph' && pastedGraph.series[0].sourceMathElementId)
      .toBe('math-dependent:copy:1');
    expect(pastedGraph.kind === 'graph' && pastedGraph.series[0].id).not.toBe('series-1');
  });

  it('remaps and translates immutable raw ink without mutating the source', () => {
    const raw = stroke({ id: 'raw-1' });
    const math = mathElement({
      id: 'ink-math', inputKind: 'converted-ink', typedLatex: undefined,
      rawInk: { captureFrame: raw.frame, sourceStrokes: [raw] },
    });
    const serialized = serializeElementsForClipboard({ 'ink-math': math }, ['ink-math'], ['ink-math']);
    const pasted = pasteElementsFromClipboard(serialized, (old, index) => `${old}:copy:${index}`);
    const copy = pasted.elementsById['ink-math:copy:0'];
    if (copy.kind !== 'math' || !copy.rawInk) throw new Error('missing pasted ink math');
    expect(copy.rawInk.sourceStrokes[0].id).toBe('raw-1:copy:1');
    expect(copy.rawInk.sourceStrokes[0].points[0].x).toBe(raw.points[0].x + 20);
    expect(math.rawInk?.sourceStrokes[0].id).toBe('raw-1');
  });

  it('rejects orphaned graph sources and aggregate raw-ink point overflow', () => {
    expect(() => pasteElementsFromClipboard(JSON.stringify({
      format: 'canvink-elements-v1', elements: [graphElement('missing')], zOrder: ['graph'],
    }), (old) => `${old}:copy`)).toThrow(/unknown ID/);

    const largeStroke = stroke({ points: Array.from({ length: 40_001 }, (_, index) => ({
      x: index, y: index, pressure: 0.5, tiltX: 0, tiltY: 0, time: index, pointerType: 'pen',
    })) });
    const values = Object.fromEntries(Array.from({ length: 5 }, (_, index) => {
      const id = `math-${index}`;
      return [id, mathElement({
        id, inputKind: 'ink', typedLatex: undefined,
        rawInk: { captureFrame: largeStroke.frame, sourceStrokes: [{ ...largeStroke, id: `raw-${index}` }] },
      })];
    }));
    expect(() => serializeElementsForClipboard(values, Object.keys(values), Object.keys(values)))
      .toThrow(/too many stroke points/);
  });

  it('rejects malformed values, unknown z-order IDs, and oversized text', () => {
    expect(() => pasteElementsFromClipboard('{}', () => 'id')).toThrow(/format/);
    expect(() =>
      pasteElementsFromClipboard(
        JSON.stringify({
          format: 'canvink-elements-v1',
          elements: [{ ...richText(), content: null }],
          zOrder: ['text-1'],
        }),
        (oldId) => `${oldId}:copy`,
      ),
    ).toThrow(/rich-text/);
    const serialized = serializeElementsForClipboard({ text: richText({ id: 'text' }) }, ['text'], ['text']);
    const malformed = JSON.parse(serialized) as { zOrder: string[] };
    malformed.zOrder = ['unknown'];
    expect(() =>
      pasteElementsFromClipboard(
        JSON.stringify(malformed),
        (oldId, index) => `${oldId}:${index}`,
      ),
    ).toThrow(/unknown ID/);
    expect(() =>
      serializeElementsForClipboard(
        { text: richText({ id: 'text', content: { type: 'doc', blocks: [{ id: 'b', type: 'paragraph', spans: [{ text: 'x'.repeat(9 * 1024 * 1024), marks: [] }] }] } }) },
        ['text'],
        ['text'],
      ),
    ).toThrow(/byte limit/);
  });

  it('round-trips every valid v2 element kind without dropping optional fields', () => {
    const asset = {
      assetId: `sha256:${'a'.repeat(64)}`, checksum: `sha256:${'a'.repeat(64)}`,
      mimeType: 'image/png', size: 4, fileName: 'diagram.png', role: 'original' as const,
    } as AssetRef;
    const common = {
      frame: { x: 1, y: 2, width: 30, height: 40, rotation: 5 },
      createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:01Z', locked: false,
    };
    const values: Record<string, PageElementV3> = {
      text: richText({ id: 'text' }),
      stroke: stroke({ id: 'stroke', tombstonedAt: '2026-08-03T00:00:02Z' }),
      shape: { ...common, id: 'shape', kind: 'shape', shape: 'rectangle', strokeColor: '#000000', fillColor: '#ffffff', strokeWidth: 2, points: [{ x: 1, y: 2 }] },
      image: { ...common, id: 'image', kind: 'image', asset, alt: 'diagram' },
      pdf: { ...common, id: 'pdf', kind: 'pdf', previewAsset: { ...asset, role: 'preview' }, originalAsset: { ...asset, mimeType: 'application/pdf' }, pageCount: 2, sourcePageNumber: 1, sourceAvailability: 'original' },
      attachment: { ...common, id: 'attachment', kind: 'attachment', asset: { ...asset, mimeType: 'text/plain' }, displayName: 'notes.txt' },
    };
    const ids = Object.keys(values);
    const serialized = serializeElementsForClipboard(values, ids, ids);
    const parsed = JSON.parse(serialized) as { elements: PageElementV3[] };
    expect(Object.fromEntries(parsed.elements.map((element) => [element.id, element])))
      .toEqual(JSON.parse(JSON.stringify(values)));
  });

  it('round-trips complete currency snapshot provenance and rejects partial metadata', () => {
    const currency = mathElement({
      result: {
        state: 'valid', exactLatex: '10 EUR', decimalText: '10 EUR', diagnostics: [],
        currencyRate: {
          base: 'CHF', quote: 'EUR', asOf: '2026-08-03T00:00:00Z', source: 'SNB snapshot',
          status: 'stale', snapshotVersion: 1,
        },
      },
    });
    const serialized = serializeElementsForClipboard({ [currency.id]: currency }, [currency.id], [currency.id]);
    const pasted = pasteElementsFromClipboard(serialized, (old) => `${old}:copy`);
    const copied = pasted.elementsById[`${currency.id}:copy`];
    expect(copied?.kind === 'math' ? copied.result.currencyRate : undefined).toEqual(currency.result.currencyRate);
    const malformed = JSON.parse(serialized) as { elements: Array<{ result: { currencyRate: Record<string, unknown> } }> };
    delete malformed.elements[0].result.currencyRate.status;
    expect(() => pasteElementsFromClipboard(JSON.stringify(malformed), (old) => `${old}:bad`))
      .toThrow(/currency rate/);
  });

  it('rejects unknown or secret fields at every nested contract boundary', () => {
    const cases: unknown[] = [
      { ...stroke(), apiKey: 'secret' },
      { ...stroke(), points: [{ ...stroke().points[0], token: 'secret' }] },
      { ...richText(), content: { type: 'doc', blocks: [{ id: 'b', type: 'paragraph', spans: [{ text: 'x', marks: [{ type: 'bold', secret: 'x' }] }] }] } },
      { ...mathElement(), recognition: { state: 'recognized', alternatives: [], warnings: [], provider: { kind: 'mathpix', token: 'secret' } } },
      { ...graphElement('math-source'), series: [{ ...graphElement('math-source').series[0], endpoint: 'secret' }] },
    ];
    for (const [index, element] of cases.entries()) {
      expect(() => pasteElementsFromClipboard(JSON.stringify({
        format: 'canvink-elements-v1', elements: [element], zOrder: [(element as { id: string }).id],
      }), (old) => `${old}:${index}`)).toThrow(/unsupported fields/);
    }
    expect(() => pasteElementsFromClipboard(JSON.stringify({
      format: 'canvink-elements-v1', elements: [stroke()], zOrder: ['stroke-1'], apiKey: 'secret',
    }), (old) => `${old}:copy`)).toThrow(/unsupported fields/);
  });

  it('enforces a recursive depth budget before walking attacker-controlled values', () => {
    const malicious = stroke() as unknown as Record<string, unknown>;
    let nested: Record<string, unknown> = malicious;
    for (let depth = 0; depth < 70; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.secret = child;
      nested = child;
    }
    expect(() => pasteElementsFromClipboard(JSON.stringify({
      format: 'canvink-elements-v1', elements: [malicious], zOrder: ['stroke-1'],
    }), (old) => `${old}:copy`)).toThrow(/nested too deeply/);
  });
});

function mathElement(overrides: Partial<MathElementV3> = {}): MathElementV3 {
  return {
    id: 'math-source', kind: 'math', frame: { x: 10, y: 20, width: 160, height: 60, rotation: 0 },
    createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', locked: false,
    inputKind: 'typed', autoRecognition: 'inherit', typedLatex: 'x^2',
    recognition: { state: 'idle', alternatives: [], warnings: [] },
    result: { state: 'valid', exactLatex: '4', decimalText: '4', diagnostics: [] },
    dependencies: { defines: [], references: ['x'], dependsOnElementIds: [], state: 'valid' },
    ...overrides,
  };
}

function graphElement(sourceMathElementId: string): GraphElementV3 {
  return {
    id: 'graph', kind: 'graph', frame: { x: 20, y: 100, width: 320, height: 200, rotation: 0 },
    createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', locked: false,
    series: [{ id: 'series-1', sourceMathElementId, color: '#3366cc', visible: true }],
    viewport: { xMin: -5, xMax: 5, yMin: -5, yMax: 5, equalScale: true, axesVisible: true, gridVisible: true },
  };
}
