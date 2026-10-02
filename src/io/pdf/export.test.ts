import { describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';
import { degrees, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MemoryAssetRepository, storeOriginalAsset } from '../../assets';
import type { PageElementV2 } from '../../domain/v2';
import type { GraphElementV3, MathElementV3 } from '../../domain/v3';
import { buildPdfGraphRenderPlanForTesting, exportComposedPdf, type PdfPageRasterizer } from './export';
import { inspectPdf } from './inspect';
import { loadComputeEngine } from '../../math/runtime';

// The engine loads on demand in the app; these exports evaluate formulas at once.
await loadComputeEngine();

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0),
);

function sourcePdf(): Uint8Array {
  const pdf = new jsPDF({ unit: 'pt', format: [200, 300] });
  pdf.text('Original', 20, 30);
  return new Uint8Array(pdf.output('arraybuffer'));
}

async function textViewportTransform(bytes: Uint8Array, text: string): Promise<number[]> {
  const task = getDocument({ data: bytes.slice(), disableAutoFetch: true, disableStream: true, stopAtErrors: true });
  try {
    const page = await task.promise.then((document) => document.getPage(1));
    try {
      const item = (await page.getTextContent()).items.find((candidate) => 'str' in candidate && candidate.str === text);
      if (!item || !('transform' in item)) throw new Error(`Missing PDF.js text item ${text}.`);
      return Util.transform(page.getViewport({ scale: 1 }).transform, item.transform);
    } finally {
      page.cleanup();
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function hasNonAxisTransform(bytes: Uint8Array): Promise<boolean> {
  const task = getDocument({ data: bytes.slice(), disableAutoFetch: true, disableStream: true, stopAtErrors: true });
  try {
    const page = await task.promise.then((document) => document.getPage(1));
    try {
      const operators = await page.getOperatorList();
      return operators.fnArray.some((operator, index) => {
        if (operator !== OPS.transform) return false;
        const values = operators.argsArray[index] as number[];
        return Math.abs(values[1] ?? 0) > 0.01 && Math.abs(values[2] ?? 0) > 0.01;
      });
    } finally {
      page.cleanup();
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function pathOperatorCount(bytes: Uint8Array): Promise<number> {
  const task = getDocument({ data: bytes.slice(), disableAutoFetch: true, disableStream: true, stopAtErrors: true });
  try {
    const page = await task.promise.then((document) => document.getPage(1));
    try {
      const operators = await page.getOperatorList();
      return operators.fnArray.filter((operator) => operator === OPS.constructPath).length;
    } finally {
      page.cleanup();
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

describe('ordered PDF composition', () => {
  it('exports prioritized Math text and bounded Graph polylines as passive PDF operators', async () => {
    const common = {
      createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', locked: false,
    };
    const math: MathElementV3 = {
      ...common, id: 'math', kind: 'math', frame: { x: 20, y: 20, width: 180, height: 60, rotation: 0 },
      inputKind: 'typed', autoRecognition: 'inherit', typedLatex: 'typed-secret', recognizedLatex: 'recognized-secret', correctedLatex: 'y=x^2',
      recognition: { state: 'recognized', alternatives: [], warnings: ['provider-warning-secret'] },
      result: { state: 'valid', exactLatex: 'x^2', diagnostics: [] },
      dependencies: { defines: ['y'], references: ['x'], dependsOnElementIds: [], state: 'valid' },
    };
    const graph: GraphElementV3 = {
      ...common, id: 'graph', kind: 'graph', frame: { x: 20, y: 100, width: 260, height: 160, rotation: 0 },
      series: [{ id: 'series', sourceMathElementId: 'math', color: '#3366cc', visible: true }],
      viewport: { xMin: -2, xMax: 2, yMin: -1, yMax: 4, equalScale: false, axesVisible: true, gridVisible: true },
    };
    const exported = await exportComposedPdf({
      repository: new MemoryAssetRepository(),
      pages: [{
        width: 300, height: 280, elementsById: { math, graph }, zOrder: ['math', 'graph'],
        mathSettings: { numberMode: 'exact', angleMode: 'degrees' },
      }],
    });
    const inspected = await inspectPdf(exported);
    expect(inspected.pages[0].text).toContain('y=x²');
    expect(inspected.pages[0].text).toContain('= x²');
    expect(inspected.pages[0].text).not.toContain('typed-secret');
    expect(inspected.pages[0].text).not.toContain('provider-warning-secret');
    expect(await pathOperatorCount(exported)).toBeGreaterThan(20);
    expect(new TextDecoder('latin1').decode(exported)).not.toContain('<svg');
  });

  it.each(['pending', 'unrecognized'] as const)(
    'exports stored raw-ink polylines for %s Math without dropping an available derivation',
    async (state) => {
      const common = {
        createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', locked: false,
      };
      const math: MathElementV3 = {
        ...common,
        id: 'ink-math', kind: 'math', frame: { x: 20, y: 30, width: 200, height: 100, rotation: 0 },
        inputKind: 'ink', autoRecognition: 'inherit',
        ...(state === 'pending' ? { recognizedLatex: 'x+1' } : {}),
        recognition: { state, alternatives: [], warnings: [] },
        result: state === 'pending'
          ? { state: 'valid', exactLatex: '2', diagnostics: [] }
          : { state: 'none', diagnostics: [] },
        dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'valid' },
        rawInk: {
          captureFrame: { x: 100, y: 200, width: 100, height: 50, rotation: 0 },
          sourceStrokes: [{
            ...common,
            id: 'raw', kind: 'stroke', frame: { x: 100, y: 200, width: 100, height: 50, rotation: 0 },
            tool: 'pen', color: '#aabbcc', size: 2, opacity: 0.75, tombstonedAt: common.updatedAt,
            points: [
              { x: 100, y: 200, pressure: 0.5, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' },
              { x: 126.875, y: 211.25, pressure: 0.5, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' },
              { x: 200, y: 250, pressure: 0.5, tiltX: 0, tiltY: 0, time: 3, pointerType: 'pen' },
            ],
          }],
        },
      };
      const exported = await exportComposedPdf({
        repository: new MemoryAssetRepository(),
        pages: [{
          width: 260, height: 180, elementsById: { [math.id]: math }, zOrder: [math.id],
          mathSettings: { numberMode: 'exact', angleMode: 'degrees' },
        }],
      });
      const inspected = await inspectPdf(exported);
      const raw = new TextDecoder('latin1').decode(exported);

      expect(await pathOperatorCount(exported)).toBeGreaterThan(2);
      // Capture point (126.875, 211.25) maps into the moved/resized block at
      // page point (73.75, 52.5), or PDF bottom-up y=127.5.
      expect(raw).toContain('73.75');
      expect(raw).toContain('127.5');
      if (state === 'pending') {
        expect(inspected.pages[0].text).toContain('x+1');
        expect(inspected.pages[0].text).toContain('= 2');
      } else {
        expect(inspected.pages[0].text).toContain('Math');
      }
    },
  );

  it('uses decimal/radian page settings, page variables, explicit null segments, and implicit paths', async () => {
    const common = {
      createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', locked: false,
    };
    const makeMath = (id: string, y: number, latex: string): MathElementV3 => ({
      ...common, id, kind: 'math', frame: { x: 10, y, width: 120, height: 45, rotation: 0 },
      inputKind: 'typed', autoRecognition: 'inherit', typedLatex: latex,
      recognition: { state: 'idle', alternatives: [], warnings: [] },
      result: { state: 'none', diagnostics: [] },
      dependencies: { defines: [], references: [], dependsOnElementIds: [], state: 'valid' },
    });
    const definition = makeMath('definition', 0, 'a=2');
    const decimal = {
      ...makeMath('decimal', 10, '\\frac{1}{3}'),
      result: { state: 'valid', exactLatex: '\\frac{1}{3}', decimalText: '0.333', diagnostics: [] },
    } satisfies MathElementV3;
    const line = makeMath('line-source', 20, 'y=a x');
    const discontinuous = makeMath('segments-source', 30, 'y=\\frac{1}{x}');
    const circle = makeMath('circle-source', 40, 'x^2+y^2=4');
    const sine = makeMath('sine-source', 50, 'y=\\sin(x)');
    const makeGraph = (id: string, sourceMathElementId: string, y: number): GraphElementV3 => ({
      ...common, id, kind: 'graph', frame: { x: 140, y, width: 180, height: 120, rotation: 0 },
      series: [{ id: `${id}-series`, sourceMathElementId, color: '#3366cc', visible: true }],
      viewport: { xMin: -3.2, xMax: 3.2, yMin: -3.2, yMax: 3.2, equalScale: true, axesVisible: true, gridVisible: true },
    });
    const lineGraph = makeGraph('line', line.id, 0);
    const segmentedGraph = makeGraph('segments', discontinuous.id, 125);
    const circleGraph = makeGraph('circle', circle.id, 250);
    const sineGraph = makeGraph('sine', sine.id, 375);
    const elements = {
      [definition.id]: definition, [decimal.id]: decimal, [line.id]: line,
      [discontinuous.id]: discontinuous, [circle.id]: circle, [sine.id]: sine,
      [lineGraph.id]: lineGraph, [segmentedGraph.id]: segmentedGraph,
      [circleGraph.id]: circleGraph, [sineGraph.id]: sineGraph,
    };
    const page = {
      width: 340, height: 510, elementsById: elements,
      zOrder: [decimal.id, lineGraph.id, segmentedGraph.id, circleGraph.id, sineGraph.id],
      mathSettings: { numberMode: 'decimal' as const, angleMode: 'radians' as const },
    };
    const radians = await exportComposedPdf({ repository: new MemoryAssetRepository(), pages: [page] });
    const degreesPdf = await exportComposedPdf({
      repository: new MemoryAssetRepository(),
      pages: [{ ...page, mathSettings: { ...page.mathSettings, angleMode: 'degrees' } }],
    });
    const inspected = await inspectPdf(radians);

    expect(inspected.pages[0].text).toContain('(1)/(3)');
    expect(inspected.pages[0].text).toContain('= 0.333');
    expect(inspected.pages[0].text).not.toContain('\\frac');
    expect(await pathOperatorCount(radians)).toBeGreaterThan(40);
    const linePlan = buildPdfGraphRenderPlanForTesting(lineGraph, elements, 'radians');
    const segmentedPlan = buildPdfGraphRenderPlanForTesting(segmentedGraph, elements, 'radians');
    const circlePlan = buildPdfGraphRenderPlanForTesting(circleGraph, elements, 'radians');
    const radiansPlan = buildPdfGraphRenderPlanForTesting(sineGraph, elements, 'radians');
    const degreesPlan = buildPdfGraphRenderPlanForTesting(sineGraph, elements, 'degrees');
    expect(linePlan.series[0].polylines[0]?.length).toBeGreaterThan(20);
    expect(segmentedPlan.series[0].polylines).toHaveLength(2);
    expect(circlePlan.series[0].polylines[0]?.length).toBeGreaterThan(8);
    expect(radiansPlan.series[0].polylines).not.toEqual(degreesPlan.series[0].polylines);
    expect(degreesPdf.byteLength).toBeGreaterThan(0);
  });

  it('composes original-page backgrounds with ordered vector annotations and appended pages', async () => {
    const repository = new MemoryAssetRepository();
    const original = await storeOriginalAsset(repository, {
      bytes: sourcePdf(),
      mimeType: 'application/pdf',
      fileName: 'source.pdf',
      kind: 'pdf',
    });
    const background: PageElementV2 = {
      id: 'background', kind: 'pdf', frame: { x: 0, y: 0, width: 200, height: 300, rotation: 0 },
      createdAt: 'now', updatedAt: 'now', locked: true, originalAsset: original.ref,
      previewAsset: { ...original.ref, role: 'preview' }, pageCount: 1, sourceAvailability: 'original',
    };
    const stroke: PageElementV2 = {
      id: 'ink', kind: 'stroke', frame: { x: 10, y: 10, width: 50, height: 50, rotation: 0 },
      createdAt: 'now', updatedAt: 'now', locked: false, tool: 'pen',
      points: [
        { x: 10, y: 10, pressure: 0.5, tiltX: 0, tiltY: 0, time: 1, pointerType: 'pen' },
        { x: 60, y: 60, pressure: 0.7, tiltX: 0, tiltY: 0, time: 2, pointerType: 'pen' },
      ], color: '#ff0000', size: 2, opacity: 1,
    };
    const text: PageElementV2 = {
      id: 'text', kind: 'richText', frame: { x: 20, y: 80, width: 150, height: 60, rotation: 0 },
      createdAt: 'now', updatedAt: 'now', locked: false,
      content: { type: 'doc', blocks: [{ id: 'b', type: 'paragraph', spans: [{ text: 'Annotation Ω', marks: [] }] }] },
      style: { color: '#000000', fontFamily: 'missing-font', fontSize: 12, textAlign: 'left' },
    };
    const laterText: PageElementV2 = {
      ...text,
      id: 'later-text',
      frame: { ...text.frame, y: 120 },
      content: { type: 'doc', blocks: [{ id: 'later', type: 'paragraph', spans: [{ text: 'Later layer', marks: [] }] }] },
    };
    const rasterPages: number[] = [];
    const rasterizer: PdfPageRasterizer = {
      rasterize: async ({ pageNumber }) => { rasterPages.push(pageNumber); return { bytes: PNG, format: 'PNG' }; },
    };
    const exported = await exportComposedPdf({
      repository,
      rasterizer,
      pages: [
        { width: 200, height: 300, source: { asset: original.ref, pageNumber: 1 }, elementsById: { background, ink: stroke, text, 'later-text': laterText }, zOrder: ['background', 'ink', 'text', 'later-text'] },
        { width: 200, height: 300, elementsById: { text }, zOrder: ['text'] },
      ],
    });
    const inspected = await inspectPdf(exported);
    expect(inspected.pageCount).toBe(2);
    expect(inspected.pages[0].text).toContain('Original');
    expect(inspected.pages[0].text).toContain('Annotation ?');
    expect(inspected.pages[0].text.indexOf('Annotation ?')).toBeLessThan(inspected.pages[0].text.indexOf('Later layer'));
    expect(inspected.pages[1].text).toContain('Annotation ?');
    expect(rasterPages).toEqual([]);
  });

  it('retains the original page box, rotation, and selectable source text', async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([320, 180]);
    page.setRotation(degrees(90));
    page.drawText('Vector source text', { x: 24, y: 48, size: 14 });
    const sourceBytes = await source.save({ useObjectStreams: false });
    const repository = new MemoryAssetRepository();
    const original = await storeOriginalAsset(repository, {
      bytes: sourceBytes,
      mimeType: 'application/pdf',
      fileName: 'rotated-source.pdf',
      kind: 'pdf',
    });
    const background: PageElementV2 = {
      id: 'source', kind: 'pdf', frame: { x: 0, y: 0, width: 180, height: 320, rotation: 0 },
      createdAt: 'now', updatedAt: 'now', locked: true, originalAsset: original.ref,
      previewAsset: { ...original.ref, role: 'preview' }, pageCount: 1, sourceAvailability: 'original',
    };

    const exported = await exportComposedPdf({
      repository,
      pages: [{
        width: 180,
        height: 320,
        source: { asset: original.ref, pageNumber: 1 },
        elementsById: { source: background },
        zOrder: ['source'],
      }],
    });
    const inspected = await inspectPdf(exported);
    expect(inspected.pages[0]).toMatchObject({
      width: 180,
      height: 320,
      rotation: 90,
      hasExtractableText: true,
    });
    expect(inspected.pages[0].text).toContain('Vector source text');
  });

  it('maps overlays into the visible CropBox for rotated and unrotated source pages', async () => {
    for (const { rotation, userUnit } of [{ rotation: 0, userUnit: 2 }, { rotation: 90, userUnit: 1 }] as const) {
      const source = await PDFDocument.create({ updateMetadata: false });
      const sourcePage = source.addPage([320, 180]);
      sourcePage.setCropBox(40, 20, 200, 120);
      sourcePage.setRotation(degrees(rotation));
      sourcePage.node.set(PDFName.of('UserUnit'), PDFNumber.of(userUnit));
      const repository = new MemoryAssetRepository();
      const original = await storeOriginalAsset(repository, {
        bytes: await source.save({ useObjectStreams: false }),
        mimeType: 'application/pdf', fileName: `crop-${rotation}.pdf`, kind: 'pdf',
      });
      const width = (rotation === 90 ? 120 : 200) * userUnit;
      const height = (rotation === 90 ? 200 : 120) * userUnit;
      const overlay: PageElementV2 = {
        id: 'overlay', kind: 'richText', frame: { x: 20, y: 20, width: 80, height: 30, rotation: 0 },
        createdAt: 'now', updatedAt: 'now', locked: false,
        content: { type: 'doc', blocks: [{ id: 'b', type: 'paragraph', spans: [{ text: 'Overlay', marks: [] }] }] },
        style: { color: '#000000', fontFamily: 'sans-serif', fontSize: 12, textAlign: 'left' },
      };
      const exported = await exportComposedPdf({
        repository,
        pages: [{ width, height, source: { asset: original.ref, pageNumber: 1 }, elementsById: { overlay }, zOrder: ['overlay'] }],
      });
      const matrix = await textViewportTransform(exported, 'Overlay');
      const xScale = Math.hypot(matrix[0], matrix[1]);
      const yScale = Math.hypot(matrix[2], matrix[3]);
      expect(matrix[4]).toBeCloseTo(20, 1);
      expect(xScale).toBeCloseTo(yScale, 4);
      expect(xScale).toBeCloseTo(12, 1);
    }
  });

  it('drops source PDF actions and annotations while retaining passive page content', async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([200, 300]);
    page.drawText('Passive text', { x: 20, y: 250 });
    const action = source.context.obj({
      S: 'URI',
      URI: PDFString.of('https://attacker.invalid/secret-sentinel'),
    });
    const actionRef = source.context.register(action);
    const annotation = source.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [0, 0, 100, 100],
      A: actionRef,
    });
    const annotationRef = source.context.register(annotation);
    const passiveAppearance = source.context.stream(new TextEncoder().encode('passive-appearance-sentinel'));
    const passiveAppearanceRef = source.context.register(passiveAppearance);
    const passiveAnnotationRef = source.context.register(source.context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [10, 220, 140, 260],
      AP: { N: passiveAppearanceRef },
    }));
    const embeddedStream = source.context.stream(new TextEncoder().encode('embedded-payload-sentinel'));
    const embeddedRef = source.context.register(embeddedStream);
    const fileSpec = source.context.obj({
      Type: 'Filespec',
      F: PDFString.of('payload-sentinel.txt'),
      EF: { F: embeddedRef },
    });
    const fileSpecRef = source.context.register(fileSpec);
    page.node.set(PDFName.of('AA'), source.context.obj({ O: actionRef }));
    page.node.set(PDFName.of('Annots'), source.context.obj([annotationRef, passiveAnnotationRef]));
    page.node.set(PDFName.of('AF'), source.context.obj([fileSpecRef]));
    source.catalog.set(PDFName.of('OpenAction'), actionRef);
    const bytes = await source.save({ useObjectStreams: false });
    const repository = new MemoryAssetRepository();
    const original = await storeOriginalAsset(repository, {
      bytes,
      mimeType: 'application/pdf',
      fileName: 'active-source.pdf',
      kind: 'pdf',
    });
    const background: PageElementV2 = {
      id: 'source', kind: 'pdf', frame: { x: 0, y: 0, width: 200, height: 300, rotation: 0 },
      createdAt: 'now', updatedAt: 'now', locked: true, originalAsset: original.ref,
      previewAsset: { ...original.ref, role: 'preview' }, pageCount: 1, sourceAvailability: 'original',
    };

    const exported = await exportComposedPdf({
      repository,
      pages: [{
        width: 200,
        height: 300,
        source: { asset: original.ref, pageNumber: 1 },
        elementsById: { source: background },
        zOrder: ['source'],
      }],
    });
    const reopened = await PDFDocument.load(exported, { updateMetadata: false });
    expect(reopened.catalog.has(PDFName.of('OpenAction'))).toBe(false);
    expect(reopened.catalog.has(PDFName.of('Names'))).toBe(false);
    expect(reopened.getPage(0).node.has(PDFName.of('AA'))).toBe(false);
    expect(reopened.getPage(0).node.has(PDFName.of('Annots'))).toBe(false);
    expect(reopened.getPage(0).node.has(PDFName.of('AF'))).toBe(false);
    expect((await inspectPdf(exported)).pages[0].text).toContain('Passive text');
    const raw = new TextDecoder('latin1').decode(exported);
    expect(raw).not.toContain('attacker.invalid/secret-sentinel');
    expect(raw).not.toContain('payload-sentinel.txt');
    expect(raw).not.toContain('embedded-payload-sentinel');
    expect(raw).not.toContain('passive-appearance-sentinel');
  });

  it('exports rotated rich text and shapes with non-axis-aligned operators', async () => {
    const repository = new MemoryAssetRepository();
    const imageAsset = await storeOriginalAsset(repository, {
      bytes: PNG, mimeType: 'image/png', fileName: 'pixel.png', kind: 'image',
    });
    const attachmentAsset = await storeOriginalAsset(repository, {
      bytes: new TextEncoder().encode('passive attachment'), mimeType: 'text/plain', fileName: 'notes.txt', kind: 'attachment',
    });
    const text: PageElementV2 = {
      id: 'rotated-text', kind: 'richText', frame: { x: 40, y: 50, width: 100, height: 40, rotation: 30 },
      createdAt: 'now', updatedAt: 'now', locked: false,
      content: { type: 'doc', blocks: [{ id: 'b', type: 'paragraph', spans: [{ text: 'Rotated', marks: [] }] }] },
      style: { color: '#000000', fontFamily: 'sans-serif', fontSize: 12, textAlign: 'left' },
    };
    const shape: PageElementV2 = {
      id: 'rotated-shape', kind: 'shape', frame: { x: 160, y: 40, width: 80, height: 50, rotation: 30 },
      createdAt: 'now', updatedAt: 'now', locked: false, shape: 'rectangle',
      strokeColor: '#112233', strokeWidth: 2, fillColor: '#ddeeff',
    };
    const image: PageElementV2 = {
      id: 'rotated-image', kind: 'image', frame: { x: 40, y: 110, width: 50, height: 30, rotation: 25 },
      createdAt: 'now', updatedAt: 'now', locked: false, asset: imageAsset.ref, alt: 'pixel',
    };
    const attachment: PageElementV2 = {
      id: 'rotated-attachment', kind: 'attachment', frame: { x: 130, y: 110, width: 130, height: 40, rotation: -20 },
      createdAt: 'now', updatedAt: 'now', locked: false, asset: attachmentAsset.ref, displayName: 'notes.txt',
    };
    const exported = await exportComposedPdf({
      repository,
      imageRasterizer: { rasterize: async () => ({ bytes: PNG, format: 'PNG' }) },
      pages: [{
        width: 300,
        height: 200,
        elementsById: { 'rotated-text': text, 'rotated-shape': shape, 'rotated-image': image, 'rotated-attachment': attachment },
        zOrder: ['rotated-text', 'rotated-shape', 'rotated-image', 'rotated-attachment'],
      }],
    });
    const matrix = await textViewportTransform(exported, 'Rotated');
    expect(Math.abs(matrix[1])).toBeGreaterThan(1);
    expect(Math.abs(matrix[2])).toBeGreaterThan(1);
    const attachmentMatrix = await textViewportTransform(exported, 'Attachment: notes.txt');
    expect(Math.abs(attachmentMatrix[1])).toBeGreaterThan(1);
    expect(Math.abs(attachmentMatrix[2])).toBeGreaterThan(1);
    expect(await hasNonAxisTransform(exported)).toBe(true);
    const raw = new TextDecoder('latin1').decode(exported);
    expect(raw).toContain('177.858983848622');
  });

  it('enforces the shared 500-page export limit', async () => {
    const page = { width: 100, height: 100, elementsById: {}, zOrder: [] };
    await expect(exportComposedPdf({
      repository: new MemoryAssetRepository(),
      pages: Array.from({ length: 501 }, () => page),
    })).rejects.toThrow(/between 1 and 500/);
  });

  it('rejects missing z-order elements instead of silently dropping annotations', async () => {
    await expect(exportComposedPdf({
      repository: new MemoryAssetRepository(),
      rasterizer: { rasterize: async () => ({ bytes: PNG, format: 'PNG' }) },
      pages: [{ width: 100, height: 100, elementsById: {}, zOrder: ['missing'] }],
    })).rejects.toThrow(/missing element/);
  });
});
