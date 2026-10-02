import { reopenAsset, type AssetRepository } from '../../assets';
import { translateNow } from '../../i18n/current';
import {
  projectLiveRichText,
  type LivePageDocV2,
  type PageAutomergeDoc,
} from '../../crdt';
import { mathPageSettings, pageContent, type PageElementV3 } from '../../domain/v3';
import {
  buildStaticGraphRenderPlan,
  buildStaticMathRenderPlan,
} from '../../io/mathStaticRender';
import type { RichTextDocument, RichTextSpan } from '../../domain/v2';
import { buildDocx, type DocxBlock } from '../../io/docx';
import { fixedPaperDimensions, ruleLineColor, ruleSpacing } from '../../editor/paper';
import { holdsMathElements, loadComputeEngine } from '../../math/runtime';

export interface PortableLivePage {
  page: LivePageDocV2;
  elementsById: Record<string, PageElementV3>;
  width: number;
  height: number;
}

export function portableLivePage(page: LivePageDocV2, document: PageAutomergeDoc): PortableLivePage {
  const elementsById: Record<string, PageElementV3> = {};
  for (const [id, element] of Object.entries(page.elementsById)) {
    if (element.kind === 'richText') {
      const { text: _text, ...metadata } = structuredClone(element);
      void _text;
      elementsById[id] = { ...metadata, content: projectLiveRichText(document, id) };
    } else {
      elementsById[id] = structuredClone(element);
    }
  }
  const elementWidth = Math.max(0, ...Object.values(page.elementsById).map(
    (element) => element.frame.x + element.frame.width,
  ));
  const elementHeight = Math.max(0, ...Object.values(page.elementsById).map(
    (element) => element.frame.y + element.frame.height,
  ));
  const sheet = fixedPaperDimensions(page);
  return {
    page,
    elementsById,
    width: sheet?.width ?? Math.max(1_200, Math.ceil(elementWidth + 72)),
    height: sheet?.height ?? Math.max(800, Math.ceil(elementHeight + 72)),
  };
}

function spanToMarkdown(span: RichTextSpan): string {
  const has = (type: RichTextSpan['marks'][number]['type']) =>
    span.marks.some((mark) => mark.type === type);
  let text = span.text;
  if (has('inlineCode')) text = `\`${text}\``;
  if (has('bold')) text = `**${text}**`;
  if (has('italic')) text = `*${text}*`;
  if (has('strike')) text = `~~${text}~~`;
  if (has('underline')) text = `<u>${text}</u>`;
  const link = span.marks.find((mark) => mark.type === 'link');
  if (link?.href) text = `[${text}](${link.href})`;
  return text;
}

function spansToMarkdown(spans: readonly RichTextSpan[]): string {
  return spans.map(spanToMarkdown).join('');
}

function tableLines(rows: readonly RichTextSpan[][][]): string[] {
  if (rows.length === 0) return [];
  const columnCount = Math.max(...rows.map((row) => row.length));
  const cell = (spans: readonly RichTextSpan[]) =>
    spansToMarkdown(spans).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim() || ' ';
  const render = (row: readonly RichTextSpan[][]) => {
    const cells = Array.from({ length: columnCount }, (_, index) => cell(row[index] ?? []));
    return `| ${cells.join(' | ')} |`;
  };
  const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
  return [render(rows[0]), separator, ...rows.slice(1).map(render)];
}

function richTextLines(document: RichTextDocument): string[] {
  const lines: string[] = [];
  for (const block of document.blocks) {
    if (block.type === 'table') {
      lines.push(...tableLines(block.rows));
      continue;
    }
    const text = spansToMarkdown(block.spans);
    if (block.type === 'heading') {
      lines.push(`${'#'.repeat(block.level ?? 1)} ${text}`);
    } else if (block.type === 'checkItem') {
      lines.push(`- [${block.checked ? 'x' : ' '}] ${text}`);
    } else if (block.list === 'ordered') {
      lines.push(`1. ${text}`);
    } else if (block.list === 'bullet') {
      lines.push(`- ${text}`);
    } else {
      lines.push(text);
    }
  }
  return lines;
}

async function imageBitmap(repository: AssetRepository, ref: Parameters<typeof reopenAsset>[1]) {
  const bytes = await reopenAsset(repository, ref);
  const blob = new Blob([Uint8Array.from(bytes)], { type: ref.mimeType });
  try {
    return await createImageBitmap(blob);
  } catch (error) {
    throw new Error(translateNow('error.export.imageDecode', { id: ref.assetId }), { cause: error });
  }
}

function drawPaper(context: CanvasRenderingContext2D, portable: PortableLivePage): void {
  const { width, height, page } = portable;
  context.fillStyle = page.background.color;
  context.fillRect(0, 0, width, height);
  const spacing = ruleSpacing(page.background);
  if (spacing === undefined) return;
  // The same spacing, colour and strength as on screen.
  context.strokeStyle = ruleLineColor(page.background);
  context.lineWidth = 1;
  for (let y = spacing; y < height; y += spacing) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  if (page.background.type === 'grid' || page.background.type === 'millimeter') {
    for (let x = spacing; x < width; x += spacing) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
  }
}

async function drawElement(
  context: CanvasRenderingContext2D,
  element: PageElementV3,
  repository: AssetRepository,
  elementsById: Readonly<Record<string, PageElementV3>>,
  numberMode: 'exact' | 'decimal',
  angleMode: 'degrees' | 'radians',
): Promise<void> {
  if (element.kind === 'stroke') {
    if (element.tombstonedAt || element.points.length < 2) return;
    context.save();
    context.globalAlpha = element.opacity;
    context.strokeStyle = element.color;
    context.lineWidth = element.size;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(element.points[0].x, element.points[0].y);
    element.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.stroke();
    context.restore();
    return;
  }
  const { frame } = element;
  context.save();
  context.translate(frame.x + frame.width / 2, frame.y + frame.height / 2);
  context.rotate(frame.rotation * Math.PI / 180);
  context.translate(-frame.width / 2, -frame.height / 2);
  if (element.kind === 'richText') {
    context.fillStyle = element.style.color;
    context.font = `${Math.max(6, Math.min(96, element.style.fontSize))}px ${element.style.fontFamily}`;
    context.textBaseline = 'top';
    const lineHeight = element.style.fontSize * 1.3;
    richTextLines(element.content).forEach((line, index) => {
      context.fillText(line, 0, index * lineHeight, frame.width);
    });
  } else if (element.kind === 'shape') {
    context.strokeStyle = element.strokeColor;
    context.lineWidth = element.strokeWidth;
    if (element.fillColor) context.fillStyle = element.fillColor;
    context.beginPath();
    if (element.shape === 'ellipse') context.ellipse(frame.width / 2, frame.height / 2, frame.width / 2, frame.height / 2, 0, 0, Math.PI * 2);
    else if (element.shape === 'triangle') {
      context.moveTo(frame.width / 2, 0); context.lineTo(frame.width, frame.height); context.lineTo(0, frame.height); context.closePath();
    } else if (element.shape === 'line' || element.shape === 'arrow') {
      context.moveTo(0, 0); context.lineTo(frame.width, frame.height);
    } else {
      context.rect(0, 0, frame.width, frame.height);
    }
    if (element.fillColor) context.fill();
    context.stroke();
  } else if (element.kind === 'math') {
    const plan = buildStaticMathRenderPlan(element, numberMode);
    context.fillStyle = '#f7faf9';
    context.fillRect(0, 0, frame.width, frame.height);
    context.strokeStyle = '#789086';
    context.strokeRect(0, 0, frame.width, frame.height);
    context.fillStyle = '#16211d';
    context.font = '18px ui-serif, serif';
    context.textBaseline = 'top';
    if (plan.latex) context.fillText(plan.latex, 10, 8, Math.max(1, frame.width - 20));
    if (plan.result) {
      context.fillStyle = '#31584a';
      context.font = '16px ui-serif, serif';
      context.fillText(`= ${plan.result}`, 10, 34, Math.max(1, frame.width - 20));
    }
    drawMathRawInk(context, element);
  } else if (element.kind === 'graph') {
    drawStaticGraph(context, element, elementsById, angleMode);
  } else if (element.kind === 'image' || element.kind === 'pdf') {
    const ref = element.kind === 'image' ? element.asset : element.previewAsset;
    const bitmap = await imageBitmap(repository, ref);
    try {
      context.drawImage(bitmap, 0, 0, frame.width, frame.height);
    } finally {
      bitmap.close();
    }
  } else {
    context.fillStyle = '#eef4f1';
    context.fillRect(0, 0, frame.width, frame.height);
    context.strokeStyle = '#789086';
    context.strokeRect(0, 0, frame.width, frame.height);
    context.fillStyle = '#1e2925';
    context.font = '16px system-ui';
    context.fillText(`Anhang: ${element.displayName}`, 12, 12, Math.max(1, frame.width - 24));
  }
  context.restore();
}

function drawMathRawInk(
  context: CanvasRenderingContext2D,
  element: Extract<PageElementV3, { kind: 'math' }>,
): void {
  if (!element.rawInk) return;
  const capture = element.rawInk.captureFrame;
  const scaleX = element.frame.width / Math.max(1, capture.width);
  const scaleY = element.frame.height / Math.max(1, capture.height);
  const strokeScale = Math.sqrt(Math.abs(scaleX * scaleY));
  for (const stroke of element.rawInk.sourceStrokes) {
    if (stroke.points.length < 2) continue;
    const points = stroke.points.map((point) => ({
      x: (point.x - capture.x) * scaleX,
      y: (point.y - capture.y) * scaleY,
    }));
    context.save();
    context.globalAlpha = stroke.opacity;
    context.strokeStyle = stroke.color;
    context.lineWidth = Math.max(0.1, stroke.size * strokeScale);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    context.restore();
  }
}

export async function renderPortablePagePng(
  portable: PortableLivePage,
  repository: AssetRepository,
): Promise<Uint8Array> {
  if (portable.width * portable.height > 16_000_000) {
    throw new Error(translateNow('error.export.pixelLimit'));
  }
  if (holdsMathElements(portable.elementsById)) await loadComputeEngine();
  const canvas = document.createElement('canvas');
  canvas.width = portable.width;
  canvas.height = portable.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error(translateNow('error.export.noCanvas'));
  drawPaper(context, portable);
  const settings = mathPageSettings(portable.page);
  for (const id of portable.page.zOrder) {
    const element = portable.elementsById[id];
    if (!element) throw new Error(translateNow('error.export.missingElement', { id }));
    await drawElement(context, element, repository, portable.elementsById, settings.numberMode, settings.angleMode);
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error(translateNow('error.export.pngEncode'))),
    'image/png',
  ));
  return new Uint8Array(await blob.arrayBuffer());
}

export function portablePageMarkdown(portable: PortableLivePage): string {
  const content = pageContent(portable.page);
  if (content.kind === 'markdown') return content.source;
  const lines = [`# ${portable.page.title}`, ''];
  const settings = mathPageSettings(portable.page);
  for (const id of portable.page.zOrder) {
    const element = portable.elementsById[id];
    if (!element || (element.kind === 'stroke' && element.tombstonedAt)) continue;
    if (element.kind === 'richText') lines.push(...richTextLines(element.content), '');
    else if (element.kind === 'image') lines.push(`![${element.alt || 'Bild'}](canvink-asset:${element.asset.assetId})`, '');
    else if (element.kind === 'pdf') lines.push(`[${translateNow('export.markdown.pdfPage', { page: element.sourcePageNumber ?? 1 })}](canvink-asset:${element.originalAsset?.assetId ?? element.previewAsset.assetId})`, '');
    else if (element.kind === 'attachment') lines.push(`[Anhang: ${element.displayName}](canvink-asset:${element.asset.assetId})`, '');
    else if (element.kind === 'shape') lines.push(`> Form: ${element.shape}`, '');
    else if (element.kind === 'math') {
      const plan = buildStaticMathRenderPlan(element, settings.numberMode);
      lines.push(`> Math: ${markdownCode(plan.latex || 'unrecognized')}${plan.result ? ` = ${markdownCode(plan.result)}` : ''}`, '');
    } else if (element.kind === 'graph') {
      const plan = buildStaticGraphRenderPlan(element, portable.elementsById, settings.angleMode);
      for (const series of plan.series) {
        const samples = series.polylines.flat().filter((_, index) => index % 12 === 0).slice(0, 8)
          .map((point) => `(${formatCoordinate(point.x)}, ${formatCoordinate(point.y)})`).join(' → ');
        lines.push(`> Graph: ${markdownCode(series.label || 'unrecognized')}${samples ? `; samples ${samples}` : '; no finite samples'}`, '');
      }
    }
    else lines.push(`> ${translateNow('export.markdown.ink', { points: element.points.length })}`, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function drawStaticGraph(
  context: CanvasRenderingContext2D,
  element: Extract<PageElementV3, { kind: 'graph' }>,
  elementsById: Readonly<Record<string, PageElementV3>>,
  angleMode: 'degrees' | 'radians',
): void {
  const plan = buildStaticGraphRenderPlan(element, elementsById, angleMode);
  const { width, height } = element.frame;
  const mapX = (x: number) => (x - plan.viewport.xMin) / (plan.viewport.xMax - plan.viewport.xMin) * width;
  const mapY = (y: number) => height - (y - plan.viewport.yMin) / (plan.viewport.yMax - plan.viewport.yMin) * height;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#dce5e1';
  context.lineWidth = 1;
  if (plan.viewport.gridVisible) {
    for (let index = 1; index < 10; index += 1) {
      context.beginPath(); context.moveTo(width * index / 10, 0); context.lineTo(width * index / 10, height); context.stroke();
      context.beginPath(); context.moveTo(0, height * index / 10); context.lineTo(width, height * index / 10); context.stroke();
    }
  }
  if (plan.viewport.axesVisible) {
    context.strokeStyle = '#66756f';
    if (plan.viewport.xMin <= 0 && plan.viewport.xMax >= 0) {
      context.beginPath(); context.moveTo(mapX(0), 0); context.lineTo(mapX(0), height); context.stroke();
    }
    if (plan.viewport.yMin <= 0 && plan.viewport.yMax >= 0) {
      context.beginPath(); context.moveTo(0, mapY(0)); context.lineTo(width, mapY(0)); context.stroke();
    }
  }
  for (const series of plan.series) {
    context.strokeStyle = series.color;
    context.lineWidth = 2;
    for (const polyline of series.polylines) {
      context.beginPath();
      polyline.forEach((point, index) => index === 0
        ? context.moveTo(mapX(point.x), mapY(point.y))
        : context.lineTo(mapX(point.x), mapY(point.y)));
      context.stroke();
    }
  }
  context.strokeStyle = '#789086';
  context.strokeRect(0, 0, width, height);
}

function markdownCode(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  const longest = Math.max(0, ...[...compact.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${compact}${fence}`;
}

function formatCoordinate(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/** Downloads a Blob as it is; large exports stay in the browser's Blob storage. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener noreferrer';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadBytes(bytes: Uint8Array, mimeType: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener noreferrer';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** A rectangle in page coordinates. */
export interface PageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedRegion {
  png: Uint8Array;
  width: number;
  height: number;
}

type RegionRenderer = (elementIds: readonly string[], region: PageRegion) => Promise<RenderedRegion>;

/** Vertical distance under which visual elements are exported as one picture. */
const REGION_MERGE_GAP = 24;

function visualBounds(element: PageElementV3): PageRegion {
  const pad = element.kind === 'stroke' ? element.size / 2 + 2 : 2;
  return {
    x: element.frame.x - pad,
    y: element.frame.y - pad,
    width: element.frame.width + pad * 2,
    height: element.frame.height + pad * 2,
  };
}

/**
 * Word export order: text containers become editable text, while ink,
 * shapes, images, PDF printouts, formulas and graphs are grouped into
 * pictures of the page regions they cover (handwriting written over a
 * worksheet stays on top of it). Everything is emitted top to bottom.
 */
export function pageDocxLayout(portable: PortableLivePage): Array<
  | { kind: 'text'; id: string; top: number }
  | { kind: 'region'; ids: string[]; region: PageRegion; top: number }
  | { kind: 'attachment'; name: string; top: number }
> {
  const zIndex = new Map(portable.page.zOrder.map((id, index) => [id, index]));
  const items: ReturnType<typeof pageDocxLayout> = [];
  const visual: Array<{ id: string; bounds: PageRegion }> = [];
  for (const id of portable.page.zOrder) {
    const element = portable.elementsById[id];
    if (!element || (element.kind === 'stroke' && (element.tombstonedAt || element.points.length === 0))) continue;
    if (element.kind === 'richText') items.push({ kind: 'text', id, top: element.frame.y });
    else if (element.kind === 'attachment') items.push({ kind: 'attachment', name: element.displayName, top: element.frame.y });
    else visual.push({ id, bounds: visualBounds(element) });
  }
  visual.sort((left, right) => left.bounds.y - right.bounds.y);
  let current: { ids: string[]; region: PageRegion } | null = null;
  const regions: Array<{ ids: string[]; region: PageRegion }> = [];
  for (const entry of visual) {
    const bottom = current ? current.region.y + current.region.height : -Infinity;
    if (current && entry.bounds.y <= bottom + REGION_MERGE_GAP) {
      const left = Math.min(current.region.x, entry.bounds.x);
      const right = Math.max(current.region.x + current.region.width, entry.bounds.x + entry.bounds.width);
      current.region = {
        x: left,
        y: current.region.y,
        width: right - left,
        height: Math.max(bottom, entry.bounds.y + entry.bounds.height) - current.region.y,
      };
      current.ids.push(entry.id);
    } else {
      current = { ids: [entry.id], region: { ...entry.bounds } };
      regions.push(current);
    }
  }
  for (const region of regions) {
    region.ids.sort((left, right) => (zIndex.get(left) ?? 0) - (zIndex.get(right) ?? 0));
    items.push({ kind: 'region', ids: region.ids, region: region.region, top: region.region.y });
  }
  return items.sort((left, right) => left.top - right.top);
}

function markdownSpans(line: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) spans.push({ text: line.slice(last, match.index), marks: [] });
    const token = match[0];
    if (token.startsWith('**')) spans.push({ text: token.slice(2, -2), marks: [{ type: 'bold' }] });
    else if (token.startsWith('~~')) spans.push({ text: token.slice(2, -2), marks: [{ type: 'strike' }] });
    else if (token.startsWith('`')) spans.push({ text: token.slice(1, -1), marks: [{ type: 'inlineCode' }] });
    else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      spans.push({ text: link?.[1] ?? token, marks: link ? [{ type: 'link', href: link[2] }] : [] });
    } else spans.push({ text: token.slice(1, -1), marks: [{ type: 'italic' }] });
    last = match.index + token.length;
  }
  if (last < line.length) spans.push({ text: line.slice(last), marks: [] });
  return spans;
}

/** Markdown pages: headings, lists, to-dos, tables and inline marks. */
export function markdownDocxBlocks(source: string): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: RichTextSpan[][][] = [];
      for (; index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index]); index += 1) {
        const cells = lines[index].trim().slice(1, -1).split('|').map((cell) => cell.trim());
        if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
        rows.push(cells.map((cell) => markdownSpans(cell)));
      }
      index -= 1;
      blocks.push({ kind: 'rich', block: { id: `md-table-${index}`, type: 'table', rows } });
      continue;
    }
    const id = `md-${index}`;
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    const taskMatch = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    const bulletMatch = /^\s*[-*+]\s+(.*)$/.exec(line);
    const orderedMatch = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'rich', block: { id, type: 'heading', level, spans: markdownSpans(headingMatch[2]) } });
    } else if (taskMatch) {
      blocks.push({ kind: 'rich', block: { id, type: 'checkItem', checked: taskMatch[1].toLowerCase() === 'x', spans: markdownSpans(taskMatch[2]) } });
    } else if (bulletMatch) {
      blocks.push({ kind: 'rich', block: { id, type: 'paragraph', list: 'bullet', spans: markdownSpans(bulletMatch[1]) } });
    } else if (orderedMatch) {
      blocks.push({ kind: 'rich', block: { id, type: 'paragraph', list: 'ordered', spans: markdownSpans(orderedMatch[1]) } });
    } else {
      blocks.push({ kind: 'rich', block: { id, type: 'paragraph', spans: markdownSpans(line) } });
    }
  }
  return blocks;
}

export async function portablePageDocx(
  portable: PortableLivePage,
  options: { subtitle?: string; renderRegion: RegionRenderer; attachmentLabel: (name: string) => string },
): Promise<Uint8Array> {
  const blocks: DocxBlock[] = [{ kind: 'title', text: portable.page.title, subtitle: options.subtitle }];
  const content = pageContent(portable.page);
  if (content.kind === 'markdown') {
    blocks.push(...markdownDocxBlocks(content.source));
    return buildDocx(blocks);
  }
  for (const item of pageDocxLayout(portable)) {
    if (item.kind === 'text') {
      const element = portable.elementsById[item.id];
      if (element?.kind !== 'richText') continue;
      for (const block of element.content.blocks) blocks.push({ kind: 'rich', block });
    } else if (item.kind === 'attachment') {
      blocks.push({ kind: 'note', text: options.attachmentLabel(item.name) });
    } else {
      const rendered = await options.renderRegion(item.ids, item.region);
      blocks.push({ kind: 'image', ...rendered, description: portable.page.title });
    }
  }
  return buildDocx(blocks);
}

/** Renders the given elements of one page region on white, at twice the size for sharp print. */
export async function renderPortableRegionPng(
  portable: PortableLivePage,
  repository: AssetRepository,
  elementIds: readonly string[],
  region: PageRegion,
): Promise<RenderedRegion> {
  const scale = 2;
  const width = Math.max(1, Math.ceil(region.width));
  const height = Math.max(1, Math.ceil(region.height));
  if (width * height * scale * scale > 16_000_000) {
    throw new Error(translateNow('error.export.pixelLimit'));
  }
  if (holdsMathElements(portable.elementsById)) await loadComputeEngine();
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error(translateNow('error.export.noCanvas'));
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.translate(-region.x, -region.y);
  const settings = mathPageSettings(portable.page);
  for (const id of elementIds) {
    const element = portable.elementsById[id];
    if (element) await drawElement(context, element, repository, portable.elementsById, settings.numberMode, settings.angleMode);
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error(translateNow('error.export.pngEncode'))),
    'image/png',
  ));
  return { png: new Uint8Array(await blob.arrayBuffer()), width, height };
}
