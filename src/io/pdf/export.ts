import { reopenAsset, type AssetRepository } from '../../assets';
import {
  MAX_IMAGE_PIXELS,
  MAX_PDF_FILE_BYTES,
  MAX_PDF_PAGES,
  MAX_POINTS_PER_STROKE,
  MAX_TEXT_CHARS,
} from '../../domain/limits';
import type { PageElementV2 } from '../../domain/v2';
import type { MathPageSettingsV1, PageElementV3 } from '../../domain/v3';
import { evaluateMathPage, prepareGraphExpression, sampleGraphExpression, splitExplicitGraphPoints } from '../../math/engine';
import { holdsMathElements, loadComputeEngine } from '../../math/runtime';
import { buildStaticMathRenderPlan, preferredMathLatex } from '../mathStaticRender';
import { inkOutline } from '../../editor/ink';
import type { jsPDF as JsPDF } from 'jspdf';
import type { Degrees } from 'pdf-lib';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export interface PdfPageRasterizer {
  rasterize(input: {
    pdfBytes: Uint8Array;
    pageNumber: number;
    width: number;
    height: number;
  }): Promise<{ bytes: Uint8Array; format: 'PNG' | 'JPEG' }>;
}

export interface ImageAssetRasterizer {
  rasterize(input: { bytes: Uint8Array; mimeType: string }): Promise<{
    bytes: Uint8Array;
    format: 'PNG' | 'JPEG';
  }>;
}

export interface PdfExportPage {
  width: number;
  height: number;
  elementsById: Readonly<Record<string, PageElementV3>>;
  zOrder: readonly string[];
  /** Required whenever the page contains Math or Graph elements. */
  mathSettings?: Pick<MathPageSettingsV1, 'numberMode' | 'angleMode'>;
  source?: { asset: NonNullable<Extract<PageElementV3, { kind: 'pdf' }>['originalAsset']>; pageNumber: number };
}

export interface ComposedPdfExportInput {
  pages: readonly PdfExportPage[];
  repository: AssetRepository;
  /**
   * Retained for callers that also offer raster previews. Original PDF
   * backgrounds are copied structurally during export and are never flattened
   * through this rasterizer.
   */
  rasterizer?: PdfPageRasterizer;
  imageRasterizer?: ImageAssetRasterizer;
}

/**
 * The export's work limits, checked page by page while pages are prepared,
 * so a caller that reads pages one at a time can stop at the first page that
 * exceeds them instead of preparing every page first.
 */
export function createPdfExportBudgetCheck(): (page: PdfExportPage, index: number) => void {
  const budget = { elements: 0, points: 0, textChars: 0 };
  return (page, index) => {
    if (index >= MAX_PDF_PAGES) {
      throw new Error(`PDF export requires between 1 and ${MAX_PDF_PAGES} ordered pages.`);
    }
    validatePage(page, index, budget);
  };
}

export async function exportComposedPdf(input: ComposedPdfExportInput): Promise<Uint8Array> {
  if (input.pages.length === 0 || input.pages.length > MAX_PDF_PAGES) {
    throw new Error(`PDF export requires between 1 and ${MAX_PDF_PAGES} ordered pages.`);
  }
  const budget = { elements: 0, points: 0, textChars: 0 };
  for (const [pageIndex, page] of input.pages.entries()) validatePage(page, pageIndex, budget);

  const [{ jsPDF }, { degrees, PDFDocument, PDFName }] = await Promise.all([
    import('jspdf'),
    import('pdf-lib'),
    input.pages.some((page) => holdsMathElements(page.elementsById)) ? loadComputeEngine() : undefined,
  ]);
  const sourceDocuments = new Map<string, Awaited<ReturnType<typeof PDFDocument.load>>>();
  let uniqueAssetBytes = 0;
  for (const page of input.pages) {
    if (!page.source || sourceDocuments.has(page.source.asset.assetId)) continue;
    const original = await reopenAsset(input.repository, page.source.asset);
    uniqueAssetBytes += original.byteLength;
    assertAssetBudget(uniqueAssetBytes);
    const source = await PDFDocument.load(original, {
      updateMetadata: false,
      ignoreEncryption: false,
    });
    if (source.getPageCount() > MAX_PDF_PAGES) {
      throw new Error(`PDF source exceeds the ${MAX_PDF_PAGES}-page limit.`);
    }
    sourceDocuments.set(page.source.asset.assetId, source);
  }

  let overlayPdf: InstanceType<typeof jsPDF> | undefined;
  const rasterCache = new Map<string, Awaited<ReturnType<NonNullable<ComposedPdfExportInput['imageRasterizer']>['rasterize']>>>();
  for (const page of input.pages) {
    if (!overlayPdf) {
      overlayPdf = new jsPDF({ unit: 'pt', format: [page.width, page.height], orientation: page.width > page.height ? 'landscape' : 'portrait' });
    } else {
      overlayPdf.addPage([page.width, page.height], page.width > page.height ? 'landscape' : 'portrait');
    }
    for (const id of page.zOrder) {
      const element = page.elementsById[id];
      if (!element || (element.kind === 'stroke' && element.tombstonedAt)) continue;
      if (isStructuralSourceBackground(element, page)) continue;
      if (element.kind === 'stroke') drawStroke(overlayPdf, element);
      else if (element.kind === 'shape') drawShape(overlayPdf, element);
      else if (element.kind === 'richText') drawRichText(overlayPdf, element);
      else if (element.kind === 'math') drawMath(overlayPdf, element, page.mathSettings as PdfMathSettings);
      else if (element.kind === 'graph') drawGraph(overlayPdf, element, page.elementsById, page.mathSettings as PdfMathSettings);
      else if (element.kind === 'image' || element.kind === 'pdf') {
        if (!input.imageRasterizer) {
          throw new Error(`PDF export needs an image rasterizer for ${element.kind} element ${element.id}.`);
        }
        const ref = element.kind === 'image' ? element.asset : element.previewAsset;
        let raster = rasterCache.get(ref.assetId);
        if (!raster) {
          const bytes = await reopenAsset(input.repository, ref);
          uniqueAssetBytes += bytes.byteLength;
          assertAssetBudget(uniqueAssetBytes);
          raster = await input.imageRasterizer.rasterize({ bytes, mimeType: ref.mimeType });
          rasterCache.set(ref.assetId, raster);
        }
        const bottomLeft = framePoint(element.frame, 0, element.frame.height);
        overlayPdf.addImage(
          raster.bytes,
          raster.format,
          bottomLeft.x,
          bottomLeft.y - element.frame.height,
          element.frame.width,
          element.frame.height,
          undefined,
          'FAST',
          -element.frame.rotation,
        );
      } else drawAttachment(overlayPdf, element);
    }
  }
  if (!overlayPdf) throw new Error('PDF export did not initialize.');

  const overlayDocument = await PDFDocument.load(overlayPdf.output('arraybuffer'), {
    updateMetadata: false,
  });
  const output = await PDFDocument.create({ updateMetadata: false });

  for (const [pageIndex, page] of input.pages.entries()) {
    let outputPage;
    let overlayPlacement: { x: number; y: number; width: number; height: number; rotate?: ReturnType<typeof degrees> };
    if (page.source) {
      const source = sourceDocuments.get(page.source.asset.assetId);
      if (!source) throw new Error('PDF source asset was not preloaded.');
      const sourceIndex = page.source.pageNumber - 1;
      if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= source.getPageCount()) {
        throw new Error(`PDF source page ${page.source.pageNumber} is outside the original document.`);
      }
      const sourcePage = source.getPage(sourceIndex);
      overlayPlacement = sourceOverlayPlacement(sourcePage, page, degrees);
      // Source interactivity is outside Canvink's passive-document boundary.
      // Remove active roots before copying so their indirect object graphs are
      // never registered as reachable or serialized output objects.
      sourcePage.node.delete(PDFName.of('AA'));
      sourcePage.node.delete(PDFName.of('Annots'));
      sourcePage.node.delete(PDFName.of('AF'));
      const [copied] = await output.copyPages(source, [sourceIndex]);
      outputPage = output.addPage(copied);
    } else {
      outputPage = output.addPage([page.width, page.height]);
      overlayPlacement = { x: 0, y: 0, width: page.width, height: page.height };
    }

    const embeddedOverlay = await output.embedPage(overlayDocument.getPage(pageIndex));
    outputPage.drawPage(embeddedOverlay, overlayPlacement);
    outputPage.node.delete(PDFName.of('AA'));
    outputPage.node.delete(PDFName.of('Annots'));
    outputPage.node.delete(PDFName.of('AF'));
  }

  output.catalog.delete(PDFName.of('AA'));
  output.catalog.delete(PDFName.of('OpenAction'));
  output.catalog.delete(PDFName.of('Names'));
  output.catalog.delete(PDFName.of('AcroForm'));

  const bytes = await output.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  if (bytes.byteLength > MAX_PDF_FILE_BYTES) {
    throw new Error(`PDF export exceeds the ${MAX_PDF_FILE_BYTES}-byte limit.`);
  }
  return bytes;
}

export function createBrowserPdfRasterizer(): PdfPageRasterizer {
  return {
    async rasterize({ pdfBytes, pageNumber, width, height }) {
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new Error('PDF page number is invalid.');
      if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
        throw new Error('PDF raster dimensions are invalid.');
      }
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const task = pdfjs.getDocument({
        data: pdfBytes.slice(),
        stopAtErrors: true,
        disableAutoFetch: true,
        disableStream: true,
      });
      const document = await task.promise;
      try {
        const page = await document.getPage(pageNumber);
        try {
          const base = page.getViewport({ scale: 1 });
          const pixelScale = Math.sqrt(16_000_000 / (base.width * base.height));
          const scale = Math.min(width / base.width, height / base.height, pixelScale, 2);
          const viewport = page.getViewport({ scale });
          const canvas = globalThis.document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          if (canvas.width * canvas.height > 16_000_000) throw new Error('PDF raster exceeds the pixel limit.');
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('Browser cannot create a PDF rasterization context.');
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          const response = await fetch(canvas.toDataURL('image/png'));
          return { bytes: new Uint8Array(await response.arrayBuffer()), format: 'PNG' };
        } finally {
          page.cleanup();
        }
      } finally {
        document.cleanup();
        await task.destroy().catch(() => undefined);
      }
    },
  };
}

export function createBrowserImageAssetRasterizer(): ImageAssetRasterizer {
  return {
    async rasterize({ bytes, mimeType }) {
      if (mimeType === 'image/png') return { bytes: bytes.slice(), format: 'PNG' };
      if (mimeType === 'image/jpeg') return { bytes: bytes.slice(), format: 'JPEG' };
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: mimeType }));
      try {
        if (bitmap.width * bitmap.height > 16_000_000) {
          throw new Error('Image export exceeds the pixel limit.');
        }
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Browser cannot create an image export canvas.');
        context.drawImage(bitmap, 0, 0);
        const response = await fetch(canvas.toDataURL('image/png'));
        return { bytes: new Uint8Array(await response.arrayBuffer()), format: 'PNG' };
      } finally {
        bitmap.close();
      }
    },
  };
}

/**
 * Ink is exported as the same pressure-shaped outline the editor paints, so
 * a stroke keeps its thick and thin parts in the PDF.
 */
function drawStroke(pdf: PdfDocument, element: Extract<PageElementV2, { kind: 'stroke' }>): void {
  const outline = inkOutline(element);
  if (outline.length < 3) return;
  const [red, green, blue] = color(element.color);
  pdf.setFillColor(red, green, blue);
  pdf.setGState(pdf.GState({ opacity: element.opacity }));
  const lines: Array<[number, number]> = [];
  for (let index = 1; index < outline.length; index += 1) {
    lines.push([outline[index][0] - outline[index - 1][0], outline[index][1] - outline[index - 1][1]]);
  }
  pdf.lines(lines, outline[0][0], outline[0][1], [1, 1], 'F', true);
  pdf.setGState(pdf.GState({ opacity: 1 }));
}

function drawShape(pdf: PdfDocument, element: Extract<PageElementV2, { kind: 'shape' }>): void {
  const [red, green, blue] = color(element.strokeColor);
  pdf.setDrawColor(red, green, blue);
  pdf.setLineWidth(element.strokeWidth);
  const frame = element.frame;
  const style = element.fillColor ? 'FD' : 'S';
  if (element.fillColor) {
    const [fillRed, fillGreen, fillBlue] = color(element.fillColor);
    pdf.setFillColor(fillRed, fillGreen, fillBlue);
  }
  if ((element.shape === 'line' || element.shape === 'arrow') && element.points?.length && element.points.length >= 2) {
    const start = element.points[0];
    const end = element.points.at(-1) ?? start;
    pdf.line(start.x, start.y, end.x, end.y);
    if (element.shape === 'arrow') drawArrowHead(pdf, start, end, element.strokeWidth);
  } else if (element.shape === 'ellipse') {
    drawPolygon(pdf, Array.from({ length: 48 }, (_, index) => {
      const angle = (index / 48) * Math.PI * 2;
      return framePoint(frame, frame.width / 2 + Math.cos(angle) * frame.width / 2, frame.height / 2 + Math.sin(angle) * frame.height / 2);
    }), style);
  } else if (element.shape === 'triangle') {
    drawPolygon(pdf, [
      framePoint(frame, frame.width / 2, 0),
      framePoint(frame, frame.width, frame.height),
      framePoint(frame, 0, frame.height),
    ], style);
  } else if (element.shape === 'axes') {
    drawSegment(pdf, framePoint(frame, 0, frame.height / 2), framePoint(frame, frame.width, frame.height / 2));
    drawSegment(pdf, framePoint(frame, frame.width / 2, 0), framePoint(frame, frame.width / 2, frame.height));
  } else {
    drawPolygon(pdf, [
      framePoint(frame, 0, 0),
      framePoint(frame, frame.width, 0),
      framePoint(frame, frame.width, frame.height),
      framePoint(frame, 0, frame.height),
    ], style);
  }
}

function drawPolygon(
  pdf: PdfDocument,
  points: readonly { x: number; y: number }[],
  style: 'FD' | 'S',
): void {
  if (points.length < 2) return;
  const start = points[0];
  const vectors = points.slice(1).map((point, index) => {
    const previous = points[index];
    return [point.x - previous.x, point.y - previous.y] as [number, number];
  });
  pdf.lines(vectors, start.x, start.y, [1, 1], style, true);
}

function drawSegment(pdf: PdfDocument, start: { x: number; y: number }, end: { x: number; y: number }): void {
  pdf.line(start.x, start.y, end.x, end.y);
}

function drawArrowHead(
  pdf: PdfDocument,
  start: { x: number; y: number },
  end: { x: number; y: number },
  strokeWidth: number,
): void {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const length = Math.max(8, strokeWidth * 4);
  for (const offset of [-Math.PI / 6, Math.PI / 6]) {
    pdf.line(end.x, end.y, end.x - length * Math.cos(angle + offset), end.y - length * Math.sin(angle + offset));
  }
}

function drawRichText(pdf: PdfDocument, element: Extract<PageElementV2, { kind: 'richText' }>): void {
  const text = element.content.blocks
    .flatMap((block) => block.type === 'table'
      ? block.rows.map((row) => row.flatMap((cell) => cell.map((span) => span.text)).join(' | '))
      : [block.spans.map((span) => span.text).join('')])
    .join('\n');
  if (!text) return;
  const [red, green, blue] = color(element.style.color);
  pdf.setTextColor(red, green, blue);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(Math.max(6, Math.min(72, element.style.fontSize)));
  const safe = [...text].map((character) => character.charCodeAt(0) <= 255 ? character : '?').join('');
  const anchor = framePoint(element.frame, 0, element.style.fontSize);
  pdf.text(pdf.splitTextToSize(safe, Math.max(1, element.frame.width)), anchor.x, anchor.y, {
    baseline: 'top',
    angle: -element.frame.rotation,
  });
}

function drawAttachment(
  pdf: PdfDocument,
  element: Extract<PageElementV2, { kind: 'attachment' }>,
): void {
  pdf.setFillColor(238, 244, 241);
  pdf.setDrawColor(120, 144, 134);
  drawPolygon(pdf, [
    framePoint(element.frame, 0, 0),
    framePoint(element.frame, element.frame.width, 0),
    framePoint(element.frame, element.frame.width, element.frame.height),
    framePoint(element.frame, 0, element.frame.height),
  ], 'FD');
  pdf.setTextColor(30, 41, 37);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(11);
  const anchor = framePoint(element.frame, 10, 18);
  pdf.text(
    `Attachment: ${[...element.displayName].map((character) => character.charCodeAt(0) <= 255 ? character : '?').join('')}`,
    anchor.x,
    anchor.y,
    { maxWidth: Math.max(1, element.frame.width - 20), angle: -element.frame.rotation },
  );
}

type PdfMathSettings = Pick<MathPageSettingsV1, 'numberMode' | 'angleMode'>;

function drawMath(
  pdf: PdfDocument,
  element: Extract<PageElementV3, { kind: 'math' }>,
  settings: PdfMathSettings,
): void {
  const plan = buildStaticMathRenderPlan(element, settings.numberMode);
  pdf.setFillColor(247, 250, 249);
  pdf.setDrawColor(120, 144, 134);
  drawPolygon(pdf, [
    framePoint(element.frame, 0, 0),
    framePoint(element.frame, element.frame.width, 0),
    framePoint(element.frame, element.frame.width, element.frame.height),
    framePoint(element.frame, 0, element.frame.height),
  ], 'FD');
  pdf.setTextColor(22, 33, 29);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(14);
  const anchor = framePoint(element.frame, 10, 18);
  pdf.text(schoolMathText(plan.latex || 'Math'), anchor.x, anchor.y, {
    maxWidth: Math.max(1, element.frame.width - 20), angle: -element.frame.rotation,
  });
  if (plan.result) {
    pdf.setTextColor(49, 88, 74);
    const resultAnchor = framePoint(element.frame, 10, 40);
    pdf.text(`= ${schoolMathText(plan.result)}`, resultAnchor.x, resultAnchor.y, {
      maxWidth: Math.max(1, element.frame.width - 20), angle: -element.frame.rotation,
    });
  }
  drawMathRawInk(pdf, element);
}

function drawMathRawInk(
  pdf: PdfDocument,
  element: Extract<PageElementV3, { kind: 'math' }>,
): void {
  if (!element.rawInk) return;
  const capture = element.rawInk.captureFrame;
  const scaleX = element.frame.width / Math.max(1, capture.width);
  const scaleY = element.frame.height / Math.max(1, capture.height);
  const strokeScale = Math.sqrt(Math.abs(scaleX * scaleY));
  for (const stroke of element.rawInk.sourceStrokes) {
    if (stroke.points.length < 2) continue;
    const [red, green, blue] = color(stroke.color);
    pdf.setDrawColor(red, green, blue);
    pdf.setLineWidth(Math.max(0.1, stroke.size * strokeScale));
    pdf.setGState(pdf.GState({ opacity: stroke.opacity, 'stroke-opacity': stroke.opacity }));
    const points = stroke.points.map((point) => framePoint(
      element.frame,
      (point.x - capture.x) * scaleX,
      (point.y - capture.y) * scaleY,
    ));
    for (let index = 1; index < points.length; index += 1) {
      pdf.line(points[index - 1].x, points[index - 1].y, points[index].x, points[index].y);
    }
    pdf.setGState(pdf.GState({ opacity: 1, 'stroke-opacity': 1 }));
  }
}

function drawGraph(
  pdf: PdfDocument,
  element: Extract<PageElementV3, { kind: 'graph' }>,
  elementsById: Readonly<Record<string, PageElementV3>>,
  settings: PdfMathSettings,
): void {
  const plan = buildPdfGraphRenderPlanForTesting(element, elementsById, settings.angleMode);
  const map = (point: { x: number; y: number }) => framePoint(
    element.frame,
    (point.x - plan.viewport.xMin) / (plan.viewport.xMax - plan.viewport.xMin) * element.frame.width,
    element.frame.height - (point.y - plan.viewport.yMin) / (plan.viewport.yMax - plan.viewport.yMin) * element.frame.height,
  );
  pdf.setFillColor(255, 255, 255);
  pdf.setDrawColor(120, 144, 134);
  drawPolygon(pdf, [
    framePoint(element.frame, 0, 0),
    framePoint(element.frame, element.frame.width, 0),
    framePoint(element.frame, element.frame.width, element.frame.height),
    framePoint(element.frame, 0, element.frame.height),
  ], 'FD');
  if (plan.viewport.gridVisible) {
    pdf.setDrawColor(220, 229, 225);
    pdf.setLineWidth(0.5);
    for (let index = 1; index < 10; index += 1) {
      drawSegment(pdf, framePoint(element.frame, element.frame.width * index / 10, 0), framePoint(element.frame, element.frame.width * index / 10, element.frame.height));
      drawSegment(pdf, framePoint(element.frame, 0, element.frame.height * index / 10), framePoint(element.frame, element.frame.width, element.frame.height * index / 10));
    }
  }
  if (plan.viewport.axesVisible) {
    pdf.setDrawColor(102, 117, 111);
    pdf.setLineWidth(1);
    if (plan.viewport.xMin <= 0 && plan.viewport.xMax >= 0) {
      const x = (0 - plan.viewport.xMin) / (plan.viewport.xMax - plan.viewport.xMin) * element.frame.width;
      drawSegment(pdf, framePoint(element.frame, x, 0), framePoint(element.frame, x, element.frame.height));
    }
    if (plan.viewport.yMin <= 0 && plan.viewport.yMax >= 0) {
      const y = element.frame.height - (0 - plan.viewport.yMin) / (plan.viewport.yMax - plan.viewport.yMin) * element.frame.height;
      drawSegment(pdf, framePoint(element.frame, 0, y), framePoint(element.frame, element.frame.width, y));
    }
  }
  for (const series of plan.series) {
    const [red, green, blue] = color(series.color);
    pdf.setDrawColor(red, green, blue);
    pdf.setLineWidth(1.5);
    for (const polyline of series.polylines) {
      for (let index = 1; index < polyline.length; index += 1) {
        drawSegment(pdf, map(polyline[index - 1]), map(polyline[index]));
      }
    }
  }
}

function schoolMathText(value: string): string {
  let text = Array.from(value).slice(0, 4_096).join('');
  // Deliberately bounded text conversion only. This is not HTML, TeX rendering,
  // or evaluation; it turns common school notation into passive readable text.
  for (let index = 0; index < 8; index += 1) {
    const next = text
      .replace(/\\frac\{([^{}]{1,256})\}\{([^{}]{1,256})\}/g, '($1)/($2)')
      .replace(/\\sqrt\{([^{}]{1,256})\}/g, 'sqrt($1)');
    if (next === text) break;
    text = next;
  }
  text = text
    .replace(/\\(?:cdot|times)\b/g, '·')
    .replace(/\\div\b/g, '÷')
    .replace(/\\pm\b/g, '±')
    .replace(/\\pi\b/g, 'pi')
    .replace(/\\(?:leq|le)\b/g, '<=')
    .replace(/\\(?:geq|ge)\b/g, '>=')
    .replace(/\\neq\b/g, '!=')
    .replace(/\^\{?2\}?/g, '²')
    .replace(/\^\{?3\}?/g, '³')
    .replace(/\\([A-Za-z]{1,32})/g, '$1')
    .replace(/[{}]/g, '');
  return Array.from(text)
    .slice(0, 4_096)
    .map((character) => character.charCodeAt(0) <= 255 ? character : '?')
    .join('');
}

export function buildPdfGraphRenderPlanForTesting(
  graph: Extract<PageElementV3, { kind: 'graph' }>,
  elementsById: Readonly<Record<string, PageElementV3>>,
  angleMode: MathPageSettingsV1['angleMode'],
): { viewport: typeof graph.viewport; series: Array<{ color: string; polylines: Array<Array<{ x: number; y: number }>> }> } {
  const mathElements = Object.values(elementsById).filter(
    (candidate): candidate is Extract<PageElementV3, { kind: 'math' }> => candidate.kind === 'math',
  );
  const pageResults = evaluateMathPage(mathElements.map((math) => ({
    id: math.id,
    x: math.frame.x,
    y: math.frame.y,
    latex: preferredMathLatex(math),
  })), { angleMode });
  const variables: Record<string, number> = {};
  for (const result of pageResults) {
    const decimal = result.value?.decimalValue;
    if (result.status === 'ok' && result.variable && decimal !== null && decimal !== undefined && Number.isFinite(decimal)) {
      variables[result.variable] = decimal;
    }
  }
  let totalPoints = 0;
  const series: Array<{ color: string; polylines: Array<Array<{ x: number; y: number }>> }> = [];
  for (const candidate of graph.series) {
    if (!candidate.visible || series.length >= 8 || totalPoints >= 768) continue;
    const source = elementsById[candidate.sourceMathElementId];
    const polylines: Array<Array<{ x: number; y: number }>> = [];
    if (source?.kind === 'math') {
      try {
        const prepared = prepareGraphExpression(preferredMathLatex(source), { angleMode });
        const sampled = sampleGraphExpression(prepared, {
          minX: graph.viewport.xMin,
          maxX: graph.viewport.xMax,
          minY: graph.viewport.yMin,
          maxY: graph.viewport.yMax,
          samples: 97,
          gridSize: 33,
          variables,
          maxOperations: 500_000,
          maxEvaluationMs: 100,
        });
        const sampledLines = sampled.kind === 'implicit'
          ? sampled.paths.map((path) => [...path])
          : splitExplicitGraphPoints(sampled.points, {
              minY: graph.viewport.yMin,
              maxY: graph.viewport.yMax,
            });
        for (const line of sampledLines) {
          const remaining = 768 - totalPoints;
          if (remaining < 2) break;
          const bounded = line.slice(0, remaining).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
          if (bounded.length >= 2) {
            polylines.push(bounded);
            totalPoints += bounded.length;
          }
        }
      } catch {
        // Unsupported/undefined graph sources remain a passive empty series.
      }
    }
    series.push({ color: /^#[0-9a-f]{6}$/i.test(candidate.color) ? candidate.color : '#1f5eff', polylines });
  }
  return { viewport: structuredClone(graph.viewport), series };
}

function validatePage(
  page: PdfExportPage,
  index: number,
  budget: { elements: number; points: number; textChars: number },
): void {
  if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
    throw new Error(`PDF export page ${index + 1} has invalid dimensions.`);
  }
  if (page.width * page.height > MAX_IMAGE_PIXELS) {
    throw new Error(`PDF export page ${index + 1} exceeds the page-area limit.`);
  }
  const unique = new Set(page.zOrder);
  if (unique.size !== page.zOrder.length) throw new Error(`PDF export page ${index + 1} has duplicate z-order IDs.`);
  const hasMath = page.zOrder.some((id) => {
    const kind = page.elementsById[id]?.kind;
    return kind === 'math' || kind === 'graph';
  });
  if (hasMath && (
    !page.mathSettings
    || (page.mathSettings.numberMode !== 'exact' && page.mathSettings.numberMode !== 'decimal')
    || (page.mathSettings.angleMode !== 'degrees' && page.mathSettings.angleMode !== 'radians')
  )) throw new Error(`PDF export page ${index + 1} requires valid Math settings.`);
  budget.elements += page.zOrder.length;
  if (budget.elements > 50_000) throw new Error('PDF export exceeds the 50000-element work limit.');
  for (const id of page.zOrder) {
    const element = page.elementsById[id];
    if (!element) throw new Error(`PDF export page ${index + 1} references missing element ${id}.`);
    if (element.kind === 'stroke') {
      if (element.points.length > MAX_POINTS_PER_STROKE) throw new Error(`PDF export stroke ${id} exceeds the point limit.`);
      budget.points += element.points.length;
      if (budget.points > MAX_POINTS_PER_STROKE) throw new Error('PDF export exceeds the aggregate stroke-point work limit.');
    } else if (element.kind === 'richText') {
      budget.textChars += richTextLength(element);
    } else if (element.kind === 'math') {
      const plan = buildStaticMathRenderPlan(element, page.mathSettings?.numberMode);
      budget.textChars += plan.latex.length + (plan.result?.length ?? 0);
      for (const stroke of element.rawInk?.sourceStrokes ?? []) {
        if (stroke.points.length > MAX_POINTS_PER_STROKE) throw new Error(`PDF export Math raw stroke ${stroke.id} exceeds the point limit.`);
        budget.points += stroke.points.length;
        if (budget.points > MAX_POINTS_PER_STROKE) throw new Error('PDF export exceeds the aggregate stroke-point work limit.');
      }
    } else if (element.kind === 'attachment') {
      budget.textChars += element.displayName.length;
    }
    if (budget.textChars > MAX_TEXT_CHARS) throw new Error('PDF export exceeds the text work limit.');
  }
}

function richTextLength(element: Extract<PageElementV2, { kind: 'richText' }>): number {
  return element.content.blocks.reduce((total, block) => total + (block.type === 'table'
    ? block.rows.reduce((rowTotal, row) => rowTotal + row.reduce((cellTotal, cell) => cellTotal + cell.reduce((spanTotal, span) => spanTotal + span.text.length, 0), 0), 0)
    : block.spans.reduce((spanTotal, span) => spanTotal + span.text.length, 0)), 0);
}

function framePoint(
  frame: { x: number; y: number; width: number; height: number; rotation: number },
  localX: number,
  localY: number,
): { x: number; y: number } {
  const radians = frame.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = localX - frame.width / 2;
  const dy = localY - frame.height / 2;
  return {
    x: frame.x + frame.width / 2 + dx * cos - dy * sin,
    y: frame.y + frame.height / 2 + dx * sin + dy * cos,
  };
}

function isStructuralSourceBackground(element: PageElementV3, page: PdfExportPage): boolean {
  return element.kind === 'pdf'
    && element.locked
    && Boolean(page.source)
    && element.originalAsset?.assetId === page.source?.asset.assetId
    && element.frame.x === 0
    && element.frame.y === 0
    && element.frame.width === page.width
    && element.frame.height === page.height
    && element.frame.rotation === 0;
}

function assertAssetBudget(bytes: number): void {
  if (bytes > MAX_PDF_FILE_BYTES) throw new Error(`PDF export inputs exceed the ${MAX_PDF_FILE_BYTES}-byte work limit.`);
}

function sourceOverlayPlacement(
  sourcePage: {
    getCropBox(): { x: number; y: number; width: number; height: number };
    getRotation(): { angle: number };
  },
  page: PdfExportPage,
  makeDegrees: (angle: number) => Degrees,
): { x: number; y: number; width: number; height: number; rotate?: Degrees } {
  const crop = sourcePage.getCropBox();
  const rawAngle = sourcePage.getRotation().angle;
  const angle = ((rawAngle % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(angle)) throw new Error(`PDF source rotation ${rawAngle} is unsupported.`);
  const swapped = angle === 90 || angle === 270;
  const visualWidth = swapped ? crop.height : crop.width;
  const visualHeight = swapped ? crop.width : crop.height;
  const scaleX = page.width / visualWidth;
  const scaleY = page.height / visualHeight;
  const tolerance = Math.max(0.01, Math.max(scaleX, scaleY) * 0.001);
  if (![crop.x, crop.y, crop.width, crop.height, scaleX, scaleY].every(Number.isFinite)
    || crop.width <= 0 || crop.height <= 0 || scaleX <= 0 || scaleY <= 0
    || Math.abs(scaleX - scaleY) > tolerance) {
    throw new Error('PDF source CropBox, rotation, and editor dimensions are inconsistent.');
  }
  if (angle === 90) return { x: crop.x + crop.width, y: crop.y, width: crop.height, height: crop.width, rotate: makeDegrees(90) };
  if (angle === 180) return { x: crop.x + crop.width, y: crop.y + crop.height, width: crop.width, height: crop.height, rotate: makeDegrees(180) };
  if (angle === 270) return { x: crop.x, y: crop.y + crop.height, width: crop.height, height: crop.width, rotate: makeDegrees(270) };
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

function color(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return [0, 0, 0];
  return [Number.parseInt(match[1].slice(0, 2), 16), Number.parseInt(match[1].slice(2, 4), 16), Number.parseInt(match[1].slice(4, 6), 16)];
}

type PdfDocument = JsPDF;
