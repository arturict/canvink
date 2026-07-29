import { createId } from '../domain/ids';
import {
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_MARKDOWN_IMPORT_BYTES,
  MAX_PDF_FILE_BYTES,
  MAX_PDF_PAGES,
  MAX_TEXT_CHARS,
  MAX_WORKSPACE_IMPORT_BYTES,
} from '../domain/limits';
import type { jsPDF as JsPDF } from 'jspdf';
import type {
  ActiveContext,
  ImageElement,
  InkPoint,
  Notebook,
  Page,
  PageElement,
  PdfElement,
  Section,
  StrokeElement,
  WorkspaceState,
} from '../domain/types';
import { getStrokeOutline } from '../editor/ink';
import { normalizeWorkspace, pageToMarkdown } from '../domain/workspace';

function safeFilename(value: string): string {
  const cleaned = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'canvink-page';
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function workspaceBackup(workspace: WorkspaceState): { blob: Blob; filename: string } {
  return {
    blob: new Blob([JSON.stringify(workspace, null, 2)], {
      type: 'application/json',
    }),
    filename: `canvink-workspace-${new Date().toISOString().slice(0, 10)}.json`,
  };
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
}

export function exportWorkspaceJson(workspace: WorkspaceState): void {
  const backup = workspaceBackup(workspace);
  triggerDownload(backup.blob, backup.filename);
}

export async function saveWorkspaceBackup(
  workspace: WorkspaceState,
): Promise<'saved-file' | 'download-started'> {
  const backup = workspaceBackup(workspace);
  const pickerWindow = window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: Array<{
        description: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<{
      createWritable: () => Promise<{
        write: (data: Blob) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  };

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: backup.filename,
        types: [
          {
            description: 'Canvink workspace export',
            accept: { 'application/json': ['.json'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(backup.blob);
      await writable.close();
      return 'saved-file';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(
          'Workspace replacement cancelled before the backup was saved.',
          { cause: error },
        );
      }
    }
  }

  triggerDownload(backup.blob, backup.filename);
  return 'download-started';
}

export function exportPageMarkdown(context: ActiveContext): void {
  triggerDownload(
    new Blob([pageToMarkdown(context)], { type: 'text/markdown;charset=utf-8' }),
    `${safeFilename(context.page.title)}.md`,
  );
}

export async function parseWorkspaceJson(file: File): Promise<WorkspaceState> {
  if (file.size > MAX_WORKSPACE_IMPORT_BYTES) {
    throw new Error('This workspace export is larger than the 64 MiB import limit.');
  }
  const value: unknown = JSON.parse(await file.text());
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    !('notebooks' in value)
  ) {
    throw new Error('This file is not a Canvink workspace export.');
  }
  const workspace = normalizeWorkspace(value);
  await validateWorkspaceAssetPreviews(workspace);
  return workspace;
}

export function markdownToPage(markdown: string, title: string): Page {
  const createdAt = new Date().toISOString();
  return {
    id: createId('page'),
    title: title.replace(/\.md$/i, '') || 'Imported note',
    mode: 'a4',
    createdAt,
    updatedAt: createdAt,
    elements: [
      {
        id: createId('text'),
        kind: 'text',
        x: 70,
        y: 70,
        width: 654,
        height: 940,
        text: markdown,
        color: '#1e2925',
        fontSize: 17,
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontWeight: 400,
        createdAt,
        updatedAt: createdAt,
      },
    ],
  };
}

export async function markdownFileToPage(file: File): Promise<Page> {
  const isMarkdown =
    file.type === 'text/markdown' ||
    file.type === 'text/plain' ||
    /\.md$/i.test(file.name);
  if (!isMarkdown) {
    throw new Error('Portable note import accepts only .md Markdown files.');
  }
  if (file.size > MAX_MARKDOWN_IMPORT_BYTES) {
    throw new Error('Markdown imports are limited to 2 MiB.');
  }
  const markdown = await file.text();
  if (markdown.length > MAX_TEXT_CHARS) {
    throw new Error('This Markdown note contains too much text to import safely.');
  }
  return markdownToPage(markdown, file.name);
}

export async function fileToImageElement(file: File, x = 80, y = 80): Promise<ImageElement> {
  if (file.size === 0 || file.size > MAX_IMAGE_FILE_BYTES) {
    throw new Error('Images must be between 1 byte and 12 MiB.');
  }
  const header = await imageHeaderDimensions(file);
  if (header.width * header.height > MAX_IMAGE_PIXELS) {
    throw new Error('This image exceeds the 40 megapixel safety limit.');
  }
  const dataUrl = await fileToDataUrl(file, header.mimeType);
  const dimensions = await imageDimensions(dataUrl);
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new Error('This decoded image exceeds the 40 megapixel safety limit.');
  }
  const maxWidth = 620;
  const maxHeight = 560;
  const scale = Math.min(1, maxWidth / dimensions.width, maxHeight / dimensions.height);
  const createdAt = new Date().toISOString();

  return {
    id: createId('image'),
    kind: 'image',
    x,
    y,
    dataUrl,
    name: file.name,
    alt: file.name.replace(/\.[^.]+$/, ''),
    width: Math.max(80, dimensions.width * scale),
    height: Math.max(80, dimensions.height * scale),
    createdAt,
    updatedAt: createdAt,
  };
}

export async function fileToPdfElement(file: File, x = 80, y = 80): Promise<PdfElement> {
  if (file.size === 0 || file.size > MAX_PDF_FILE_BYTES) {
    throw new Error('PDF files must be between 1 byte and 32 MiB.');
  }
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (
    bytes.length < 5 ||
    String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-'
  ) {
    throw new Error('This file does not have a valid PDF header.');
  }
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    maxImageSize: MAX_IMAGE_PIXELS,
    stopAtErrors: true,
  });
  const pdfDocument = await loadingTask.promise;
  try {
    if (pdfDocument.numPages < 1 || pdfDocument.numPages > MAX_PDF_PAGES) {
      throw new Error('PDF previews support between 1 and 500 pages.');
    }
    const firstPage = await pdfDocument.getPage(1);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    if (
      !Number.isFinite(baseViewport.width) ||
      !Number.isFinite(baseViewport.height) ||
      baseViewport.width <= 0 ||
      baseViewport.height <= 0
    ) {
      throw new Error('The first PDF page has invalid dimensions.');
    }
    const scale = Math.min(1.4, 520 / baseViewport.width);
    const viewport = firstPage.getViewport({ scale });
    const canvasWidth = Math.ceil(viewport.width);
    const canvasHeight = Math.ceil(viewport.height);
    if (
      !Number.isSafeInteger(canvasWidth) ||
      !Number.isSafeInteger(canvasHeight) ||
      canvasWidth < 1 ||
      canvasHeight < 1 ||
      canvasWidth > 8_192 ||
      canvasHeight > 8_192 ||
      canvasWidth * canvasHeight > MAX_IMAGE_PIXELS
    ) {
      throw new Error('The first PDF page exceeds the preview pixel limit.');
    }
    const canvas = window.document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser could not create a PDF preview.');
    await firstPage.render({ canvas, canvasContext: context, viewport }).promise;
    const previewDataUrl = canvas.toDataURL('image/jpeg', 0.9);
    const createdAt = new Date().toISOString();

    return {
      id: createId('pdf'),
      kind: 'pdf',
      x,
      y,
      previewDataUrl,
      sourceName: file.name,
      pageCount: pdfDocument.numPages,
      width: viewport.width,
      height: viewport.height,
      createdAt,
      updatedAt: createdAt,
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function fileToDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(new Blob([file], { type: mimeType }));
  });
}

interface ImageHeader {
  width: number;
  height: number;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

async function imageHeaderDimensions(file: Blob): Promise<ImageHeader> {
  const headerBytes = new Uint8Array(
    await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer(),
  );
  const view = new DataView(
    headerBytes.buffer,
    headerBytes.byteOffset,
    headerBytes.byteLength,
  );

  if (
    headerBytes.length >= 24 &&
    headerBytes[0] === 0x89 &&
    headerBytes[1] === 0x50 &&
    headerBytes[2] === 0x4e &&
    headerBytes[3] === 0x47 &&
    headerBytes[4] === 0x0d &&
    headerBytes[5] === 0x0a &&
    headerBytes[6] === 0x1a &&
    headerBytes[7] === 0x0a
  ) {
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
      mimeType: 'image/png',
    };
  }

  if (
    headerBytes.length >= 10 &&
    (ascii(headerBytes, 0, 6) === 'GIF87a' ||
      ascii(headerBytes, 0, 6) === 'GIF89a')
  ) {
    return {
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
      mimeType: 'image/gif',
    };
  }

  if (
    headerBytes.length >= 30 &&
    ascii(headerBytes, 0, 4) === 'RIFF' &&
    ascii(headerBytes, 8, 4) === 'WEBP'
  ) {
    const chunk = ascii(headerBytes, 12, 4);
    if (chunk === 'VP8X') {
      return {
        width: uint24LittleEndian(headerBytes, 24) + 1,
        height: uint24LittleEndian(headerBytes, 27) + 1,
        mimeType: 'image/webp',
      };
    }
    if (chunk === 'VP8L' && headerBytes[20] === 0x2f) {
      const b1 = headerBytes[21];
      const b2 = headerBytes[22];
      const b3 = headerBytes[23];
      const b4 = headerBytes[24];
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
        mimeType: 'image/webp',
      };
    }
    if (
      chunk === 'VP8 ' &&
      headerBytes[23] === 0x9d &&
      headerBytes[24] === 0x01 &&
      headerBytes[25] === 0x2a
    ) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
        mimeType: 'image/webp',
      };
    }
  }

  if (
    headerBytes.length >= 4 &&
    headerBytes[0] === 0xff &&
    headerBytes[1] === 0xd8
  ) {
    const startOfFrameMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb,
      0xcd, 0xce, 0xcf,
    ]);
    let offset = 2;
    while (offset + 8 < headerBytes.length) {
      if (headerBytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (headerBytes[offset] === 0xff) offset += 1;
      const marker = headerBytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > headerBytes.length) break;
      const segmentLength = view.getUint16(offset);
      if (segmentLength < 2 || offset + segmentLength > headerBytes.length) break;
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        return {
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
          mimeType: 'image/jpeg',
        };
      }
      offset += segmentLength;
    }
  }

  throw new Error(
    'Could not safely read this PNG, JPEG, WebP, or GIF image header.',
  );
}

async function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onerror = () => reject(new Error('Could not decode this image.'));
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = dataUrl;
  });
}

function imageBlobFromDataUrl(dataUrl: string): {
  blob: Blob;
  mimeType: ImageHeader['mimeType'];
} {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
    dataUrl,
  );
  if (!match || match[2].length % 4 !== 0) {
    throw new Error('A workspace image contains invalid base64 data.');
  }
  const estimatedBytes = Math.floor((match[2].length * 3) / 4);
  if (estimatedBytes === 0 || estimatedBytes > MAX_IMAGE_FILE_BYTES) {
    throw new Error('A workspace image exceeds the 12 MiB decoded-size limit.');
  }

  let binary: string;
  try {
    binary = window.atob(match[2]);
  } catch {
    throw new Error('A workspace image contains invalid base64 data.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return {
    blob: new Blob([bytes], { type: match[1].toLocaleLowerCase() }),
    mimeType: match[1].toLocaleLowerCase() as ImageHeader['mimeType'],
  };
}

async function validateWorkspaceImage(dataUrl: string): Promise<void> {
  const decoded = imageBlobFromDataUrl(dataUrl);
  const header = await imageHeaderDimensions(decoded.blob);
  if (header.mimeType !== decoded.mimeType) {
    throw new Error('A workspace image media type does not match its file header.');
  }
  if (
    header.width < 1 ||
    header.height < 1 ||
    header.width * header.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('A workspace image exceeds the 40 megapixel safety limit.');
  }
  const intrinsic = await imageDimensions(dataUrl);
  if (
    intrinsic.width < 1 ||
    intrinsic.height < 1 ||
    intrinsic.width * intrinsic.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('A decoded workspace image exceeds the 40 megapixel safety limit.');
  }
}

export async function validateWorkspaceAssetPreviews(
  workspace: WorkspaceState,
): Promise<void> {
  const validateElement = async (element: PageElement): Promise<void> => {
    if (element.kind === 'image') {
      await validateWorkspaceImage(element.dataUrl);
    } else if (element.kind === 'pdf') {
      await validateWorkspaceImage(element.previewDataUrl);
    }
  };
  const validatePage = async (page: Page): Promise<void> => {
    for (const element of page.elements) await validateElement(element);
  };
  const validateSection = async (section: Section): Promise<void> => {
    for (const page of section.pages) await validatePage(page);
  };
  const validateNotebook = async (notebook: Notebook): Promise<void> => {
    for (const section of notebook.sections) await validateSection(section);
  };

  for (const notebook of workspace.notebooks) await validateNotebook(notebook);

  for (const entry of workspace.trash) {
    if (entry.kind === 'notebook' && 'sections' in entry.item) {
      await validateNotebook(entry.item);
    } else if (entry.kind === 'section' && 'pages' in entry.item) {
      await validateSection(entry.item);
    } else if (entry.kind === 'page' && 'elements' in entry.item) {
      await validatePage(entry.item);
    } else if (entry.kind === 'element' && 'kind' in entry.item) {
      await validateElement(entry.item);
    }
  }
}

function colorChannels(color: string): [number, number, number] {
  const normalized = color.replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ];
  }
  return [30, 41, 37];
}

function vectorStroke(
  pdf: JsPDF,
  element: StrokeElement,
  scale: number,
  offsetX: number,
  offsetY: number,
): void {
  const pointerIsPen = element.points.some((point) => point.pointerType === 'pen');
  const outline = getStrokeOutline(element.points, element.size, !pointerIsPen);
  if (outline.length < 3) return;

  const [red, green, blue] = colorChannels(element.color);
  pdf.setFillColor(red, green, blue);
  pdf.setGState(pdf.GState({ opacity: element.opacity }));
  const first = outline[0];
  const relativeLines: [number, number][] = [];
  for (let index = 1; index < outline.length; index += 1) {
    relativeLines.push([
      (outline[index][0] - outline[index - 1][0]) * scale,
      (outline[index][1] - outline[index - 1][1]) * scale,
    ]);
  }
  pdf.lines(
    relativeLines,
    offsetX + (first[0] + element.x) * scale,
    offsetY + (first[1] + element.y) * scale,
    [1, 1],
    'F',
    true,
  );
  pdf.setGState(pdf.GState({ opacity: 1 }));
}

function pageLogicalSize(page: Page): { width: number; height: number } {
  return page.mode === 'a4' ? { width: 794, height: 1123 } : { width: 1600, height: 1000 };
}

function jsPdfImageFormat(source: string): 'PNG' | 'JPEG' | 'WEBP' | 'GIF' {
  const mimeType = /^data:image\/(png|jpe?g|webp|gif);base64,/i.exec(source)?.[1].toLowerCase();
  if (mimeType === 'png') return 'PNG';
  if (mimeType === 'jpg' || mimeType === 'jpeg') return 'JPEG';
  if (mimeType === 'webp') return 'WEBP';
  if (mimeType === 'gif') return 'GIF';
  throw new Error('Unsupported PDF image preview format.');
}

export async function createPagePdf(context: ActiveContext): Promise<JsPDF> {
  const { jsPDF } = await import('jspdf');
  const orientation = context.page.mode === 'a4' ? 'portrait' : 'landscape';
  const pdf = new jsPDF({
    orientation,
    unit: 'mm',
    format: 'a4',
    compress: true,
  });
  const logical = pageLogicalSize(context.page);
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 10;
  const scale = Math.min(
    (pageWidth - margin * 2) / logical.width,
    (pageHeight - margin * 2) / logical.height,
  );
  const offsetX = (pageWidth - logical.width * scale) / 2;
  const offsetY = (pageHeight - logical.height * scale) / 2;

  pdf.setFillColor(255, 254, 250);
  pdf.rect(offsetX, offsetY, logical.width * scale, logical.height * scale, 'F');

  for (const element of context.page.elements) {
    if (element.kind === 'stroke') {
      vectorStroke(pdf, element, scale, offsetX, offsetY);
      continue;
    }

    if (element.kind === 'text') {
      const [red, green, blue] = colorChannels(element.color);
      pdf.setTextColor(red, green, blue);
      pdf.setFont('helvetica', element.fontWeight >= 600 ? 'bold' : 'normal');
      pdf.setFontSize(Math.max(5, element.fontSize * scale * 2.8346));
      const lines = pdf.splitTextToSize(element.text, element.width * scale);
      pdf.text(
        lines,
        offsetX + element.x * scale,
        offsetY + (element.y + element.fontSize) * scale,
        {
          lineHeightFactor: 1.35,
          baseline: 'alphabetic',
          maxWidth: element.width * scale,
        },
      );
      continue;
    }

    const source = element.kind === 'image' ? element.dataUrl : element.previewDataUrl;
    try {
      pdf.addImage(
        source,
        jsPdfImageFormat(source),
        offsetX + element.x * scale,
        offsetY + element.y * scale,
        element.width * scale,
        element.height * scale,
        undefined,
        'FAST',
      );
    } catch {
      pdf.setDrawColor(180, 185, 180);
      pdf.rect(
        offsetX + element.x * scale,
        offsetY + element.y * scale,
        element.width * scale,
        element.height * scale,
      );
    }
  }

  return pdf;
}

export async function exportPagePdf(context: ActiveContext): Promise<void> {
  const pdf = await createPagePdf(context);
  pdf.save(`${safeFilename(context.page.title)}.pdf`);
}

export function pointsToBounds(points: InkPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}
