import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAssetRepository } from '../../assets';
import type { LivePageDocV2 } from '../../crdt';
import type { PageElementV3 } from '../../domain/v3';
import { markdownDocxBlocks, pageDocxLayout, portablePageMarkdown, renderPortablePagePng, type PortableLivePage } from './pageExport';
import { loadComputeEngine } from '../../math/runtime';

// The engine loads on demand in the app; these exports evaluate formulas at once.
await loadComputeEngine();

const TIME = '2026-08-03T00:00:00Z';

function portable(): PortableLivePage {
  const elementsById: Record<string, PageElementV3> = {
    math: {
      id: 'math', kind: 'math', frame: { x: 10, y: 10, width: 180, height: 64, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false, inputKind: 'typed', autoRecognition: 'inherit',
      typedLatex: 'typed-secret', recognizedLatex: 'recognized-secret', correctedLatex: 'y=x^2',
      recognition: { state: 'recognized', alternatives: [], warnings: ['warning-secret'] },
      result: { state: 'valid', exactLatex: 'x^2', decimalText: 'decimal-secret', diagnostics: [] },
      dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: [], state: 'valid' },
    },
    graph: {
      id: 'graph', kind: 'graph', frame: { x: 10, y: 90, width: 300, height: 180, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false,
      series: [{ id: 'series', sourceMathElementId: 'math', color: '#3366cc', visible: true }],
      viewport: { xMin: -2, xMax: 2, yMin: -1, yMax: 4, equalScale: false, axesVisible: true, gridVisible: true },
    },
  };
  const page = {
    schemaVersion: 3, documentId: 'page:p', kind: 'page', notebookId: 'n', sectionId: 's', pageId: 'p',
    title: 'Math Canvas', tags: [], pageType: 'free', background: { type: 'plain', color: '#ffffff' },
    createdAt: TIME, updatedAt: TIME, mathSettings: { version: 1, resultMode: 'suggest', numberMode: 'exact', angleMode: 'degrees', autoRecognition: true },
    elementsById, zOrder: ['math', 'graph'],
  } as LivePageDocV2;
  return { page, elementsById, width: 400, height: 320 };
}

afterEach(() => vi.unstubAllGlobals());

describe('portable Math Canvas page exports', () => {
  it('writes prioritized Math and bounded graph samples to Markdown without operational metadata', () => {
    const markdown = portablePageMarkdown(portable());
    expect(markdown).toContain('Math: `y=x^2` = `x^2`');
    expect(markdown).toContain('Graph: `y=x^2`; samples');
    expect(markdown).not.toContain('typed-secret');
    expect(markdown).not.toContain('recognized-secret');
    expect(markdown).not.toContain('warning-secret');
    expect(markdown).not.toContain('<svg');
  });

  it('exports a Markdown page source byte-for-byte without adding a title or newline', () => {
    const source = portable();
    source.page = {
      ...source.page,
      pageContent: { version: 1, kind: 'markdown', source: '# Eigene Seite\n\nKein Abschluss-Newline' },
    } as LivePageDocV2;
    expect(portablePageMarkdown(source)).toBe('# Eigene Seite\n\nKein Abschluss-Newline');
  });

  it('renders headings, tasks, lists, inline marks, and tables as structured Markdown', () => {
    const base = portable();
    const rich = {
      id: 'rich', kind: 'richText', frame: { x: 0, y: 0, width: 300, height: 200, rotation: 0 },
      createdAt: TIME, updatedAt: TIME, locked: false,
      style: { color: '#000000', fontFamily: 'sans', fontSize: 16, textAlign: 'left' },
      content: {
        type: 'doc',
        blocks: [
          { id: 'b1', type: 'heading', level: 2, spans: [{ text: 'Kapitel', marks: [] }] },
          { id: 'b2', type: 'paragraph', spans: [
            { text: 'fett', marks: [{ type: 'bold' }] },
            { text: ' und ', marks: [] },
            { text: 'Quelle', marks: [{ type: 'link', href: 'https://example.org' }] },
          ] },
          { id: 'b3', type: 'checkItem', checked: true, spans: [{ text: 'erledigt', marks: [] }] },
          { id: 'b4', type: 'checkItem', checked: false, spans: [{ text: 'offen', marks: [] }] },
          { id: 'b5', type: 'paragraph', list: 'bullet', spans: [{ text: 'Punkt', marks: [] }] },
          { id: 'b6', type: 'paragraph', list: 'ordered', spans: [{ text: 'Schritt', marks: [] }] },
          { id: 'b7', type: 'table', rows: [
            [[{ text: 'A', marks: [] }], [{ text: 'B', marks: [] }]],
            [[{ text: 'a|1', marks: [] }], [{ text: 'b', marks: [] }]],
          ] },
        ],
      },
    } as unknown as PageElementV3;
    base.elementsById = { rich };
    base.page = { ...base.page, elementsById: { rich }, zOrder: ['rich'] } as LivePageDocV2;

    const md = portablePageMarkdown(base);
    expect(md).toContain('## Kapitel');
    expect(md).toContain('**fett** und [Quelle](https://example.org)');
    expect(md).toContain('- [x] erledigt');
    expect(md).toContain('- [ ] offen');
    expect(md).toContain('- Punkt');
    expect(md).toContain('1. Schritt');
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    // A literal pipe inside a cell must be escaped so the column count survives.
    expect(md).toContain('a\\|1');
  });

  it('renders Math text and bounded Graph polylines into a PNG canvas without markup execution', async () => {
    const text: string[] = [];
    let segments = 0;
    const context = {
      fillStyle: '', strokeStyle: '', font: '', textBaseline: '', lineWidth: 1,
      fillRect: vi.fn(), strokeRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
      lineTo: vi.fn(() => { segments += 1; }), stroke: vi.fn(), save: vi.fn(), restore: vi.fn(),
      translate: vi.fn(), rotate: vi.fn(), fillText: vi.fn((value: string) => text.push(value)),
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0, height: 0,
      getContext: () => context,
      toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' })),
    };
    vi.stubGlobal('document', { createElement: () => canvas });
    const bytes = await renderPortablePagePng(portable(), new MemoryAssetRepository());
    expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(text).toContain('y=x^2');
    expect(text).toContain('= x^2');
    expect(segments).toBeGreaterThan(20);
  });

  it.each(['pending', 'unrecognized'] as const)(
    'renders stored raw-ink polylines for %s Math in block-local PNG coordinates',
    async (state) => {
      const source = portable();
      const math = source.elementsById.math;
      if (math.kind !== 'math') throw new Error('Expected Math fixture.');
      source.elementsById = {
        math: {
          ...math,
          inputKind: 'ink',
          typedLatex: undefined,
          correctedLatex: undefined,
          ...(state === 'pending' ? { recognizedLatex: 'x+1' } : { recognizedLatex: undefined }),
          recognition: { state, alternatives: [], warnings: [] },
          result: state === 'pending'
            ? { state: 'valid', exactLatex: '2', diagnostics: [] }
            : { state: 'none', diagnostics: [] },
          frame: { x: 20, y: 30, width: 200, height: 100, rotation: 0 },
          rawInk: {
            captureFrame: { x: 100, y: 200, width: 100, height: 50, rotation: 0 },
            sourceStrokes: [{
              id: 'raw', kind: 'stroke', frame: { x: 100, y: 200, width: 100, height: 50, rotation: 0 },
              createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#aabbcc', size: 2,
              opacity: 0.75, tombstonedAt: TIME,
              points: [
                { x: 100, y: 200, pressure: 0.5, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' },
                { x: 150, y: 225, pressure: 0.5, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' },
                { x: 200, y: 250, pressure: 0.5, tiltX: 0, tiltY: 0, time: 3, pointerType: 'pen' },
              ],
            }],
          },
        },
      };
      source.page = { ...source.page, elementsById: source.elementsById, zOrder: ['math'] } as LivePageDocV2;
      const moves: Array<[number, number]> = [];
      const lines: Array<[number, number]> = [];
      const texts: string[] = [];
      const strokes: Array<{ color: string; width: number; alpha: number }> = [];
      const tracked = { strokeStyle: '', lineWidth: 1, globalAlpha: 1 };
      const context = {
        ...tracked, fillStyle: '', font: '', textBaseline: '', lineCap: 'butt', lineJoin: 'miter',
        fillRect: vi.fn(), strokeRect: vi.fn(), beginPath: vi.fn(),
        moveTo: vi.fn((x: number, y: number) => moves.push([x, y])),
        lineTo: vi.fn((x: number, y: number) => lines.push([x, y])),
        stroke: vi.fn(function (this: typeof tracked) {
          strokes.push({ color: this.strokeStyle, width: this.lineWidth, alpha: this.globalAlpha });
        }),
        save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
        fillText: vi.fn((value: string) => texts.push(value)),
      } as unknown as CanvasRenderingContext2D;
      const canvas = {
        width: 0, height: 0, getContext: () => context,
        toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob([Uint8Array.of(7)], { type: 'image/png' })),
      };
      vi.stubGlobal('document', { createElement: () => canvas });

      await renderPortablePagePng(source, new MemoryAssetRepository());

      expect(moves).toContainEqual([0, 0]);
      expect(lines).toContainEqual([100, 50]);
      expect(lines).toContainEqual([200, 100]);
      expect(strokes).toContainEqual({ color: '#aabbcc', width: 4, alpha: 0.75 });
      if (state === 'pending') expect(texts).toEqual(expect.arrayContaining(['x+1', '= 2']));
      else expect(texts).toEqual([]);
    },
  );
});

describe('Word export layout', () => {
  const stroke = (id: string, y: number): PageElementV3 => ({
    id, kind: 'stroke', frame: { x: 40, y, width: 120, height: 30, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', color: '#1d4ed8', size: 3, opacity: 1,
    points: [{ x: 40, y, pressure: 0.5, time: 0 }, { x: 160, y: y + 30, pressure: 0.5, time: 1 }],
  } as PageElementV3);
  const text = (id: string, y: number, value: string): PageElementV3 => ({
    id, kind: 'richText', frame: { x: 40, y, width: 300, height: 40, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false,
    content: { type: 'doc', blocks: [{ id: `${id}-b`, type: 'paragraph', spans: [{ text: value, marks: [] }] }] },
    style: { color: '#111827', fontFamily: 'Inter', fontSize: 16, textAlign: 'left' },
  } as PageElementV3);

  it('keeps text editable and groups nearby handwriting into one picture, top to bottom', () => {
    const elementsById = {
      below: text('below', 400, 'Lösung'),
      inkA: stroke('inkA', 100),
      inkB: stroke('inkB', 140),
      title: text('title', 20, 'Aufgabe 1'),
      farInk: stroke('farInk', 600),
    };
    const page = {
      ...portable().page, elementsById, zOrder: ['inkB', 'below', 'inkA', 'title', 'farInk'],
    } as LivePageDocV2;
    const layout = pageDocxLayout({ page, elementsById, width: 800, height: 800 });
    expect(layout.map((item) => item.kind === 'region' ? `region:${item.ids.join('+')}` : item.kind === 'text' ? `text:${item.id}` : 'attachment'))
      .toEqual(['text:title', 'region:inkB+inkA', 'text:below', 'region:farInk']);
  });

  it('converts Markdown pages into Word blocks', () => {
    const blocks = markdownDocxBlocks('# Titel\n\n- [x] erledigt\n- Punkt mit **fett**\n1. eins\n\n| Fach | Aufgabe |\n| --- | --- |\n| Mt | Ü78 |');
    expect(blocks.map((block) => block.kind === 'rich' ? `${block.block.type}${'list' in block.block && block.block.list ? `:${block.block.list}` : ''}` : block.kind))
      .toEqual(['heading', 'checkItem', 'paragraph:bullet', 'paragraph:ordered', 'table']);
    const bullet = blocks[2];
    if (bullet.kind !== 'rich' || bullet.block.type === 'table') throw new Error('Expected a list item.');
    expect(bullet.block.spans).toEqual([{ text: 'Punkt mit ', marks: [] }, { text: 'fett', marks: [{ type: 'bold' }] }]);
  });
});
