import { normalizePageTag } from '../../domain/pageTags';
import type {
  FidelityIssue,
  ImportedInkStroke,
  ImportedTextStyle,
  PageContentCounts,
  PlannedPageBackground,
  RichBlock,
  RichTextSpan,
  SpatialPosition,
  TableCell,
} from '../types';
import type { OneNoteDesktopInkFile, OneNoteDesktopInkObject } from './exportFormat';
import {
  fontFamilyFromCss,
  parseCssColor,
  parseFontSize,
  parseOneNoteInlineHtml,
  parseStyleAttribute,
  type InlineTextStyle,
  type StyledSpan,
} from './inlineHtml';
import { childElements, firstChild, localName, textContent, type XmlElement } from './xml';

/** OneNote positions and sizes are in points (1/72 inch); Canvink pages use CSS pixels (1/96 inch). */
export const POINTS_TO_PX = 96 / 72;
const DEFAULT_FONT_PX = 11 * POINTS_TO_PX;
const INDENT_PX = 24;
/** OneNote places the first outline of a new page at y = 86.4 pt, below its title. */
const TITLE_BAND_PX = 86.4 * POINTS_TO_PX;
const TOP_MARGIN_PX = 24;
/** Canvink's file card needs room for the name and its open and download buttons. */
const MIN_FILE_CARD = { width: 360, height: 96 };

/** Resolves an exported file path to what the converter needs to know about it. */
export interface DesktopAssetInfo {
  /** Identifier of the resource in the import plan. */
  resourceId: string;
  mediaType: string;
  bytes: number;
  width?: number;
  height?: number;
  originalName?: string;
}

export interface DesktopPageConversionOptions {
  asset(path: string): DesktopAssetInfo | undefined;
  ink?: OneNoteDesktopInkFile;
  /** Returns why a resource cannot be imported (size limits), or undefined when it can. */
  rejectResource?(path: string, kind: 'image' | 'pdf' | 'attachment'): string | undefined;
}

export interface DesktopPageConversion {
  title: string;
  blocks: RichBlock[];
  issues: FidelityIssue[];
  counts: PageContentCounts;
  tags: string[];
  taskState?: 'open' | 'done';
  background?: PlannedPageBackground;
}

interface QuickStyle {
  name: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  spaceBefore: number;
  spaceAfter: number;
}

interface TagDefinition {
  name: string;
  symbol: string;
}

interface Placed {
  block: RichBlock;
  z: number;
  background: boolean;
  order: number;
}

interface PageContext {
  options: DesktopPageConversionOptions;
  quickStyles: Map<string, QuickStyle>;
  tagDefinitions: Map<string, TagDefinition>;
  issues: FidelityIssue[];
  issueKeys: Set<string>;
  placed: Placed[];
  counts: PageContentCounts;
  tags: Set<string>;
  openTasks: number;
  doneTasks: number;
}

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function issue(context: PageContext, value: FidelityIssue): void {
  // One entry per kind of loss keeps the review readable on pages with hundreds of objects.
  const key = `${value.code}:${value.sourceElement ?? ''}`;
  if (context.issueKeys.has(key)) return;
  context.issueKeys.add(key);
  context.issues.push(value);
}

function box(element: XmlElement): { x: number; y: number; z: number; width?: number; height?: number } | undefined {
  const position = firstChild(element, 'Position');
  if (!position) return undefined;
  const x = number(position.attributes.x);
  const y = number(position.attributes.y);
  if (x === undefined || y === undefined) return undefined;
  const size = firstChild(element, 'Size');
  const width = number(size?.attributes.width);
  const height = number(size?.attributes.height);
  return {
    x: x * POINTS_TO_PX,
    y: y * POINTS_TO_PX,
    z: number(position.attributes.z) ?? 0,
    width: width !== undefined && width > 0 ? width * POINTS_TO_PX : undefined,
    height: height !== undefined && height > 0 ? height * POINTS_TO_PX : undefined,
  };
}

function elementSize(element: XmlElement): { width?: number; height?: number } {
  const size = firstChild(element, 'Size');
  const width = number(size?.attributes.width);
  const height = number(size?.attributes.height);
  return {
    width: width !== undefined && width > 0 ? width * POINTS_TO_PX : undefined,
    height: height !== undefined && height > 0 ? height * POINTS_TO_PX : undefined,
  };
}

function place(context: PageContext, block: RichBlock, z: number, background = false): void {
  context.placed.push({ block, z, background, order: context.placed.length });
}

// ---------------------------------------------------------------------------
// Ink

/** Largest deviation, in CSS pixels, that point simplification may introduce. */
const INK_TOLERANCE_PX = 0.2;

/**
 * Drops pen samples that lie on the line between their neighbours
 * (Ramer–Douglas–Peucker). OneNote records ink at the digitiser's full rate;
 * every point becomes several CRDT fields in Canvink, so collinear samples
 * cost storage and load time without changing what is drawn. Pressure counts
 * as a third dimension, weighted by how much it changes the stroke's width.
 */
export function simplifyInkPoints(points: ImportedInkStroke['points'], size: number, tolerance = INK_TOLERANCE_PX): ImportedInkStroke['points'] {
  if (points.length <= 2) return points;
  const pressureWeight = Math.max(0.5, size) * 1.24;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    const a = points[start];
    const b = points[end];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let worst = -1;
    let worstIndex = -1;
    for (let index = start + 1; index < end; index += 1) {
      const point = points[index];
      const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
      const ex = point.x - (a.x + t * dx);
      const ey = point.y - (a.y + t * dy);
      const ep = (point.pressure - (a.pressure + t * (b.pressure - a.pressure))) * pressureWeight;
      const error = ex * ex + ey * ey + ep * ep;
      if (error > worst) {
        worst = error;
        worstIndex = index;
      }
    }
    if (worstIndex !== -1 && worst > tolerance * tolerance) {
      keep[worstIndex] = 1;
      stack.push([start, worstIndex], [worstIndex, end]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

/** Top-left corner of the pen's centre line over all strokes of an ink object. */
export function inkOrigin(ink: OneNoteDesktopInkObject): { x: number; y: number } {
  let x = Number.POSITIVE_INFINITY;
  let y = Number.POSITIVE_INFINITY;
  for (const stroke of ink.strokes) {
    for (let index = 0; index + 2 < stroke.p.length; index += 3) {
      x = Math.min(x, stroke.p[index]);
      y = Math.min(y, stroke.p[index + 1]);
    }
  }
  return Number.isFinite(x) ? { x, y } : { x: ink.bounds[0], y: ink.bounds[1] };
}

/** Offsets below this are rounding between OneNote's point positions and ISF coordinates. */
const INK_POSITION_TOLERANCE_PX = 4;

/**
 * Maps one decoded ISF object into page pixels. OneNote stores ISF in
 * HIMETRIC page coordinates, which WPF converts to device-independent pixels,
 * so the points already are Canvink page pixels (verified on real pages: they
 * match the object's one:Position within half a pixel). Only when an object's
 * ink lies elsewhere than OneNote places it (ink with its own origin, or flow
 * ink laid out at an estimated position) is it moved, never scaled, so that
 * `target` is the top-left corner of the pen's centre line.
 */
export function inkStrokesAt(
  ink: OneNoteDesktopInkObject,
  target: { x: number; y: number },
): ImportedInkStroke[] {
  const origin = inkOrigin(ink);
  let dx = target.x - origin.x;
  let dy = target.y - origin.y;
  if (Math.abs(dx) <= INK_POSITION_TOLERANCE_PX && Math.abs(dy) <= INK_POSITION_TOLERANCE_PX) {
    dx = 0;
    dy = 0;
  }
  return ink.strokes.flatMap((stroke): ImportedInkStroke[] => {
    const points: ImportedInkStroke['points'] = [];
    let pressureVaries = false;
    for (let index = 0; index + 2 < stroke.p.length; index += 3) {
      const pressure = stroke.p[index + 2];
      if (points.length > 0 && Math.abs(pressure - points[0].pressure) > 0.001) pressureVaries = true;
      points.push({
        x: stroke.p[index] + dx,
        y: stroke.p[index + 1] + dy,
        pressure,
      });
    }
    if (points.length === 0) return [];
    const highlighter = stroke.hl;
    const size = Math.max(stroke.w, stroke.h);
    return [{
      tool: highlighter ? 'highlighter' : 'pen',
      color: stroke.c,
      opacity: highlighter ? 0.45 : Math.max(0.05, stroke.a / 255),
      size,
      hasPressure: !highlighter && !stroke.ip && pressureVaries,
      points: simplifyInkPoints(points, size),
    }];
  });
}

function inkObject(context: PageContext, element: XmlElement): OneNoteDesktopInkObject | undefined {
  const key = element.attributes.canvinkInk;
  const ink = key ? context.options.ink?.objects[key] : undefined;
  if (!ink || ink.strokes.length === 0) {
    issue(context, {
      code: 'ink-data-missing',
      severity: 'unsupported',
      message: element.attributes.canvinkError
        ? `Ink could not be exported: ${element.attributes.canvinkError}`
        : 'An ink object had no decodable stroke data.',
      sourceElement: localName(element),
    });
    return undefined;
  }
  return ink;
}

function addInk(context: PageContext, strokes: ImportedInkStroke[], z: number): void {
  if (strokes.length === 0) return;
  context.counts.inkObjects += 1;
  context.counts.inkStrokes += strokes.length;
  place(context, { type: 'ink', strokes }, z);
}

// ---------------------------------------------------------------------------
// Images, printouts and files

function imageBlock(
  context: PageContext,
  element: XmlElement,
  position: SpatialPosition,
  background: boolean,
): RichBlock | undefined {
  const path = element.attributes.canvinkAsset;
  const info = path ? context.options.asset(path) : undefined;
  if (info && info.bytes === 0) {
    issue(context, {
      code: 'resource-not-downloaded',
      severity: 'unsupported',
      message: 'OneNote has not downloaded this picture to this computer yet, so it was not exported.',
      sourceElement: 'Image',
    });
    return undefined;
  }
  if (!path || !info || !/^image\/(png|jpeg|gif|webp|bmp)$/.test(info.mediaType)) {
    issue(context, {
      code: 'image-resource-missing',
      severity: 'unsupported',
      message: element.attributes.canvinkError
        ? `An image could not be exported: ${element.attributes.canvinkError}`
        : 'An image had no exported picture data.',
      sourceElement: 'Image',
    });
    return undefined;
  }
  const rejected = context.options.rejectResource?.(path, 'image');
  if (rejected) {
    issue(context, { code: 'resource-too-large', severity: 'unsupported', message: rejected, sourceElement: 'Image' });
    return undefined;
  }
  return {
    type: 'image',
    resourceId: info.resourceId,
    mediaType: info.mediaType,
    alt: element.attributes.alt ?? element.attributes.altText ?? '',
    position,
    ...(background ? { background: true } : {}),
  };
}

function fileBlock(context: PageContext, element: XmlElement, position: SpatialPosition): RichBlock | undefined {
  const path = element.attributes.canvinkFile;
  const info = path ? context.options.asset(path) : undefined;
  const name = element.attributes.preferredName
    ?? info?.originalName
    ?? element.attributes.pathSource?.split(/[\\/]/).at(-1)
    ?? 'Datei';
  if (info && info.bytes === 0) {
    issue(context, {
      code: 'resource-not-downloaded',
      severity: 'unsupported',
      message: `OneNote has not downloaded the file ${name} to this computer yet, so it was not exported.`,
      sourceElement: localName(element),
    });
    return undefined;
  }
  if (!path || !info) {
    issue(context, {
      code: 'attachment-resource-missing',
      severity: 'unsupported',
      message: element.attributes.canvinkError
        ? `The file ${name} could not be exported: ${element.attributes.canvinkError}`
        : `The file ${name} was not in OneNote's local cache.`,
      sourceElement: localName(element),
    });
    return undefined;
  }
  const rejected = context.options.rejectResource?.(path, 'attachment');
  if (rejected) {
    issue(context, { code: 'resource-too-large', severity: 'unsupported', message: rejected, sourceElement: localName(element) });
    return undefined;
  }
  context.counts.attachments += 1;
  return {
    type: 'attachment',
    resourceId: info.resourceId,
    mediaType: info.mediaType,
    fileName: name,
    position: {
      ...position,
      width: Math.max(MIN_FILE_CARD.width, position.width ?? 0),
      height: Math.max(MIN_FILE_CARD.height, position.height ?? 0),
    },
  };
}

interface PageLevelFile {
  element: XmlElement;
  order: number;
  y: number;
}

/**
 * Links each printout image to the file it was printed from. OneNote records
 * this as `xpsFileIndex` on both the image and the file's `one:Printout`
 * (or `sourceDocument` on the image and the file's `one:Previews`). Older
 * pages without either fall back to document order: a printout's pages
 * follow its file icon, so the nearest PDF before it (or vertically nearest)
 * owns it.
 */
function assignPrintouts(printouts: Array<{ element: XmlElement; order: number; y: number }>, files: PageLevelFile[]): Array<PageLevelFile | undefined> {
  const byXpsIndex = new Map<string, PageLevelFile>();
  const bySourceDocument = new Map<string, PageLevelFile>();
  for (const file of files) {
    const xpsIndex = firstChild(file.element, 'Printout')?.attributes.xpsFileIndex;
    if (xpsIndex !== undefined) byXpsIndex.set(xpsIndex, file);
    const sourceDocument = firstChild(file.element, 'Previews')?.attributes.sourceDocument;
    if (sourceDocument) bySourceDocument.set(sourceDocument.toLowerCase(), file);
  }
  const pdfs = files.filter((file) => /\.pdf$/i.test(
    file.element.attributes.preferredName ?? file.element.attributes.pathSource ?? file.element.attributes.canvinkFile ?? '',
  ));
  return printouts.map((printout) => {
    const xpsIndex = printout.element.attributes.xpsFileIndex;
    if (xpsIndex !== undefined && byXpsIndex.has(xpsIndex)) return byXpsIndex.get(xpsIndex);
    const sourceDocument = printout.element.attributes.sourceDocument?.toLowerCase();
    if (sourceDocument && bySourceDocument.has(sourceDocument)) return bySourceDocument.get(sourceDocument);
    const before = pdfs.filter((file) => file.order < printout.order);
    if (before.length > 0) return before[before.length - 1];
    return [...pdfs].sort((left, right) => Math.abs(left.y - printout.y) - Math.abs(right.y - printout.y))[0];
  });
}

// ---------------------------------------------------------------------------
// Outlines

interface TextAccumulator {
  blocks: RichBlock[];
  /** Characters per colour, size and family, to pick the element-wide style. */
  colors: Map<string, number>;
  sizes: Map<number, number>;
  families: Map<string, number>;
  characters: number;
}

interface OutlineCursor {
  x: number;
  y: number;
  width: number;
  z: number;
  text: TextAccumulator;
  textTop: number;
  /** Top of the OneNote text box. */
  boxTop: number;
  estimated: boolean;
}

function emptyText(): TextAccumulator {
  return { blocks: [], colors: new Map(), sizes: new Map(), families: new Map(), characters: 0 };
}

function count<K>(map: Map<K, number>, key: K, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function dominant<K>(map: Map<K, number>, total: number, share: number): K | undefined {
  let best: K | undefined;
  let bestCount = 0;
  for (const [key, value] of map) {
    if (value > bestCount) {
      best = key;
      bestCount = value;
    }
  }
  return best !== undefined && total > 0 && bestCount / total >= share ? best : undefined;
}

const FONT_STACKS: Record<string, string> = {
  calibri: 'Calibri, Carlito, "Segoe UI", Arial, sans-serif',
  'calibri light': '"Calibri Light", Calibri, Carlito, "Segoe UI", Arial, sans-serif',
  arial: 'Arial, "Liberation Sans", Helvetica, sans-serif',
  'segoe ui': '"Segoe UI", system-ui, sans-serif',
  'times new roman': '"Times New Roman", "Liberation Serif", Times, serif',
  'cambria math': '"Cambria Math", Cambria, "STIX Two Math", serif',
  cambria: 'Cambria, Caladea, Georgia, serif',
  consolas: 'Consolas, "Liberation Mono", ui-monospace, monospace',
};

export function fontStack(family: string): string {
  const known = FONT_STACKS[family.toLowerCase()];
  if (known) return known;
  const quoted = /^[\w -]+$/.test(family) ? `"${family}"` : 'system-ui';
  return `${quoted}, "Segoe UI", system-ui, sans-serif`;
}

function flushText(context: PageContext, cursor: OutlineCursor, nextTop: number): void {
  const text = cursor.text;
  if (text.blocks.length > 0) {
    const textStyle: ImportedTextStyle = {};
    const color = dominant(text.colors, text.characters, 0.6);
    if (color) textStyle.color = color;
    const size = dominant(text.sizes, text.characters, 0.4);
    textStyle.fontSize = size ?? DEFAULT_FONT_PX;
    const family = dominant(text.families, text.characters, 0.4);
    if (family) textStyle.fontFamily = fontStack(family);
    const colored = [...text.colors].some(([key, value]) => key !== color && key !== '#000000' && value > 0);
    if (colored) {
      issue(context, {
        code: 'style-dropped',
        severity: 'visual',
        message: 'Text colours that differ within one text box were not kept.',
        sourceElement: 'color',
      });
    }
    context.counts.textFrames += 1;
    place(context, {
      type: 'textFrame',
      blocks: text.blocks,
      textStyle,
      position: {
        x: cursor.x,
        y: cursor.textTop,
        width: cursor.width,
        height: Math.max(24, nextTop - cursor.textTop),
      },
    }, cursor.z);
  }
  cursor.text = emptyText();
  cursor.textTop = nextTop;
}

function quickStyle(context: PageContext, element: XmlElement): QuickStyle | undefined {
  const index = element.attributes.quickStyleIndex;
  return index === undefined ? undefined : context.quickStyles.get(index);
}

function paragraphBaseStyle(context: PageContext, element: XmlElement, inherited: InlineTextStyle): InlineTextStyle {
  const style: InlineTextStyle = { ...inherited };
  const quick = quickStyle(context, element);
  if (quick?.fontSize) style.fontSize = quick.fontSize;
  if (quick?.fontFamily) style.fontFamily = quick.fontFamily;
  if (quick?.color) style.color = quick.color;
  const css = parseStyleAttribute(element.attributes.style);
  const fontSize = parseFontSize(css.get('font-size'));
  if (fontSize) style.fontSize = fontSize;
  const family = fontFamilyFromCss(css.get('font-family'));
  if (family) style.fontFamily = family;
  const color = parseCssColor(css.get('color'));
  if (color) style.color = color;
  return style;
}

function plainSpans(spans: readonly StyledSpan[]): RichTextSpan[] {
  return spans.map(({ text, marks }) => ({ text, marks }));
}

/** Splits `<br>` line breaks into separate paragraphs; the portable model has no hard break. */
function splitLines(spans: readonly StyledSpan[]): StyledSpan[][] {
  const lines: StyledSpan[][] = [[]];
  for (const span of spans) {
    const parts = span.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ ...span, text: part });
    });
  }
  return lines;
}

function readText(
  context: PageContext,
  oe: XmlElement,
  base: InlineTextStyle,
): StyledSpan[] {
  const spans: StyledSpan[] = [];
  for (const t of childElements(oe, 'T')) {
    const parsed = parseOneNoteInlineHtml(textContent(t), base);
    if (parsed.hadEquation) {
      issue(context, {
        code: 'unsupported-element',
        severity: 'simplified',
        message: 'A typed OneNote equation was imported as its plain-text form.',
        sourceElement: 'math',
      });
    }
    if (parsed.droppedUnsafeLink) {
      issue(context, {
        code: 'unsafe-url-dropped',
        severity: 'simplified',
        message: 'A OneNote-internal or unsafe link target was removed; its text was kept.',
        sourceElement: 'a',
      });
    }
    spans.push(...parsed.spans);
  }
  return spans;
}

function recordStyle(context: PageContext, text: TextAccumulator, spans: readonly StyledSpan[], countSizes: boolean): void {
  for (const span of spans) {
    const characters = span.text.replace(/\s/g, '').length;
    if (characters === 0) continue;
    text.characters += characters;
    count(text.colors, span.style.color ?? '#000000', characters);
    if (countSizes && span.style.fontSize) count(text.sizes, Math.round(span.style.fontSize * 100) / 100, characters);
    if (span.style.fontFamily) count(text.families, span.style.fontFamily, characters);
    if (span.style.highlighted) {
      issue(context, { code: 'style-dropped', severity: 'visual', message: 'Text highlight colour was not kept.', sourceElement: 'highlight' });
    }
    if (span.style.script) {
      issue(context, { code: 'style-dropped', severity: 'visual', message: 'Superscript or subscript was imported as normal text.', sourceElement: span.style.script });
    }
  }
}

function estimateTextHeight(spans: readonly StyledSpan[], width: number, fallbackSize: number): number {
  const size = spans.find((span) => span.style.fontSize)?.style.fontSize ?? fallbackSize;
  const characters = spans.reduce((sum, span) => sum + span.text.length, 0);
  const perLine = Math.max(8, Math.floor(width / (size * 0.5)));
  return Math.max(1, Math.ceil(characters / perLine)) * size * 1.35;
}

function todoTag(context: PageContext, oe: XmlElement): { checked: boolean } | undefined {
  let result: { checked: boolean } | undefined;
  for (const tag of childElements(oe, 'Tag')) {
    const definition = context.tagDefinitions.get(tag.attributes.index ?? '');
    const isTodo = definition
      ? /to ?do|aufgabe|erledigen|checkbox/i.test(definition.name) || definition.symbol === '3'
      : tag.attributes.completed !== undefined;
    if (isTodo) {
      const checked = tag.attributes.completed === 'true';
      if (checked) context.doneTasks += 1;
      else context.openTasks += 1;
      result = { checked };
    } else if (definition) {
      const normalized = normalizePageTag(definition.name);
      if (normalized) context.tags.add(normalized);
    }
  }
  return result;
}

function tableBlock(context: PageContext, table: XmlElement, base: InlineTextStyle): RichBlock {
  const rows: TableCell[][] = childElements(table, 'Row').map((row) => childElements(row, 'Cell').map((cell) => {
    const paragraphs: RichTextSpan[][] = [];
    const visit = (children: XmlElement | undefined, depth: number) => {
      for (const oe of children ? childElements(children, 'OE') : []) {
        const spans = readText(context, oe, paragraphBaseStyle(context, oe, base));
        const todo = todoTag(context, oe);
        // A table cell holds plain paragraphs, so list markers are kept as text ("a)", "1.", "•").
        const list = firstChild(oe, 'List');
        const marker = list
          ? (firstChild(list, 'Number')?.attributes.text ?? (firstChild(list, 'Bullet') ? '•' : undefined))
          : undefined;
        // Empty paragraphs are kept as blank lines; OneNote users leave room for handwriting with them.
        if (spans.length > 0 || childElements(oe, 'T').length > 0) {
          paragraphs.push([
            ...(todo ? [{ text: todo.checked ? '☑ ' : '☐ ', marks: [] }] : []),
            ...(marker ? [{ text: `${marker} `, marks: [] }] : []),
            ...plainSpans(spans),
          ]);
        }
        if (todo) {
          // The live table model only supports text cells. Preserve the visible
          // state and page task metadata without claiming an editable checkbox.
          issue(context, {
            code: 'unsupported-element',
            severity: 'simplified',
            message: 'A checklist inside a table was kept as checkbox text; its page task state was preserved.',
            sourceElement: 'table-Tag',
          });
        }
        for (const child of childElements(oe)) {
          const name = localName(child);
          if (name !== 'T' && name !== 'OEChildren' && name !== 'List' && name !== 'Tag' && name !== 'Meta') {
            issue(context, {
              code: 'unsupported-element',
              severity: 'simplified',
              message: `A ${name} inside a table cell was not imported.`,
              sourceElement: `table-${name}`,
            });
          }
        }
        visit(firstChild(oe, 'OEChildren'), depth + 1);
      }
    };
    visit(firstChild(cell, 'OEChildren'), 0);
    // A table cell holds one paragraph in the portable model, so its lines are joined with a line break.
    const content: RichTextSpan[] = [];
    paragraphs.forEach((spans, index) => {
      if (index > 0) content.push({ text: '\n', marks: [] });
      content.push(...spans);
    });
    return {
      header: false,
      rowSpan: 1,
      colSpan: 1,
      blocks: [{ type: 'paragraph', content }],
    };
  }));
  return { type: 'table', rows };
}

function descendants(element: XmlElement, name: string): XmlElement[] {
  return childElements(element).flatMap((child) => (localName(child) === name ? [child] : descendants(child, name)));
}

function inkFlowObjects(element: XmlElement): XmlElement[] {
  const name = localName(element);
  if (name === 'InkWord' || name === 'InkDrawing') return [element];
  return childElements(element).flatMap(inkFlowObjects);
}

function visitOEChildren(
  context: PageContext,
  cursor: OutlineCursor,
  container: XmlElement | undefined,
  depth: number,
  inherited: InlineTextStyle,
): void {
  for (const oe of container ? childElements(container, 'OE') : []) {
    const base = paragraphBaseStyle(context, oe, inherited);
    const quick = quickStyle(context, oe);
    const indent = depth * INDENT_PX;
    let handledContent = false;
    for (const child of childElements(oe)) {
      const name = localName(child);
      if (name === 'T' || name === 'List' || name === 'Tag' || name === 'OEChildren' || name === 'Meta') continue;
      handledContent = true;
      if (name === 'Table') {
        cursor.text.blocks.push(tableBlock(context, child, base));
        const rows = childElements(child, 'Row').length;
        cursor.y += rows * (base.fontSize ?? DEFAULT_FONT_PX) * 1.6;
      } else if (name === 'Image') {
        const size = elementSize(child);
        flushText(context, cursor, cursor.y);
        const width = size.width ?? 200;
        const height = size.height ?? 150;
        const block = imageBlock(context, child, { x: cursor.x + indent, y: cursor.y, width, height }, false);
        if (block) {
          context.counts.images += 1;
          place(context, block, cursor.z);
        }
        cursor.estimated = true;
        cursor.y += height + 4;
        cursor.textTop = cursor.y;
      } else if (name === 'InsertedFile' || name === 'MediaFile') {
        flushText(context, cursor, cursor.y);
        const size = elementSize(child);
        const height = size.height ?? 48;
        const block = fileBlock(context, child, { x: cursor.x + indent, y: cursor.y, width: size.width ?? 220, height });
        if (block) place(context, block, cursor.z);
        cursor.estimated = true;
        cursor.y += height + 4;
        cursor.textTop = cursor.y;
      } else if (name === 'InkParagraph' || name === 'InkWord' || name === 'InkDrawing') {
        flushText(context, cursor, cursor.y);
        // Ink written into a text flow sits in the flow of its text box.
        let lineX = cursor.x + indent;
        let lineHeight = 0;
        for (const word of inkFlowObjects(child)) {
          const ink = inkObject(context, word);
          if (!ink) continue;
          const [, , inkWidth, inkHeight] = ink.bounds;
          // The 2013 schema gives InkWord x, y, width and height attributes in points.
          const size = elementSize(word);
          const attributeWidth = number(word.attributes.width);
          const attributeHeight = number(word.attributes.height);
          const width = size.width ?? (attributeWidth !== undefined && attributeWidth > 0 ? attributeWidth * POINTS_TO_PX : inkWidth);
          const height = size.height ?? (attributeHeight !== undefined && attributeHeight > 0 ? attributeHeight * POINTS_TO_PX : inkHeight);
          const offsetX = number(word.attributes.x);
          if (offsetX !== undefined) lineX = cursor.x + offsetX * POINTS_TO_PX;
          // ISF coordinates are page coordinates; keep them when they fall
          // inside this text box, otherwise lay the word out at the cursor.
          const origin = inkOrigin(ink);
          const insideBox = origin.x >= cursor.x - 48 && origin.x <= cursor.x + cursor.width + 48
            && origin.y >= cursor.boxTop - 48 && origin.y <= cursor.y + 400;
          addInk(context, inkStrokesAt(ink, insideBox ? origin : { x: lineX, y: cursor.y }), cursor.z);
          if (!insideBox) cursor.estimated = true;
          lineX += width + 6;
          lineHeight = Math.max(lineHeight, height);
        }
        cursor.y += Math.max(lineHeight, DEFAULT_FONT_PX * 1.35);
        cursor.textTop = cursor.y;
      } else {
        issue(context, {
          code: 'unsupported-element',
          severity: 'simplified',
          message: `A OneNote ${name} object was not imported.`,
          sourceElement: name,
        });
      }
    }
    const spans = readText(context, oe, base);
    const hasText = spans.some((span) => span.text.trim().length > 0);
    // Empty paragraphs are kept: OneNote users space their notes with them.
    if (hasText || (!handledContent && childElements(oe, 'T').length > 0)) {
      const list = firstChild(oe, 'List');
      const todo = todoTag(context, oe);
      const heading = /^h([1-6])$/i.exec(quick?.name ?? '');
      if (depth > 0 && !heading) {
        issue(context, {
          code: 'list-nesting-flattened',
          severity: 'simplified',
          message: 'Indentation and nested list levels were flattened.',
          sourceElement: 'OEChildren',
        });
      }
      recordStyle(context, cursor.text, spans, !heading);
      cursor.y += (quick?.spaceBefore ?? 0) * POINTS_TO_PX;
      const lines = splitLines(spans);
      if (todo) {
        cursor.text.blocks.push({
          type: 'checklist',
          items: lines.map((line) => ({ checked: todo.checked, content: plainSpans(line) })),
        });
      } else if (list) {
        const ordered = firstChild(list, 'Number') !== undefined;
        const [first, ...rest] = lines;
        cursor.text.blocks.push({
          type: 'list',
          ordered,
          items: [{ blocks: [{ type: 'paragraph', content: plainSpans(first) }] }],
        });
        // Continuation lines of a list item stay plain paragraphs rather than new bullets.
        rest.forEach((line) => cursor.text.blocks.push({ type: 'paragraph', content: plainSpans(line) }));
      } else if (heading) {
        lines.forEach((line) => cursor.text.blocks.push({
          type: 'heading',
          level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6,
          content: plainSpans(line),
        }));
      } else {
        lines.forEach((line) => cursor.text.blocks.push({ type: 'paragraph', content: plainSpans(line) }));
      }
      cursor.y += estimateTextHeight(spans, cursor.width - indent, base.fontSize ?? DEFAULT_FONT_PX)
        + (quick?.spaceAfter ?? 0) * POINTS_TO_PX;
    }
    visitOEChildren(context, cursor, firstChild(oe, 'OEChildren'), depth + 1, base);
  }
}

function convertOutline(context: PageContext, outline: XmlElement): void {
  const position = box(outline);
  if (!position) {
    issue(context, { code: 'invalid-position', severity: 'visual', message: 'A text box without a position was placed at the top left.', sourceElement: 'Outline' });
  }
  const cursor: OutlineCursor = {
    x: position?.x ?? 48,
    y: position?.y ?? 48,
    width: Math.max(80, position?.width ?? 600),
    z: position?.z ?? 0,
    text: emptyText(),
    textTop: position?.y ?? 48,
    boxTop: position?.y ?? 48,
    estimated: false,
  };
  visitOEChildren(context, cursor, firstChild(outline, 'OEChildren'), 0, {});
  const bottom = position?.height !== undefined && !cursor.estimated
    ? Math.max(cursor.y, (position.y ?? 0) + position.height)
    : cursor.y;
  flushText(context, cursor, bottom);
  if (cursor.estimated) {
    issue(context, {
      code: 'layout-estimated',
      severity: 'visual',
      message: 'Pictures, files or ink inside a text box were placed at an estimated position.',
      sourceElement: 'Outline',
    });
  }
}

// ---------------------------------------------------------------------------
// Page

function readQuickStyles(page: XmlElement): Map<string, QuickStyle> {
  const styles = new Map<string, QuickStyle>();
  for (const definition of childElements(page, 'QuickStyleDef')) {
    const index = definition.attributes.index;
    if (index === undefined) continue;
    styles.set(index, {
      name: definition.attributes.name ?? '',
      fontFamily: definition.attributes.font,
      fontSize: parseFontSize(definition.attributes.fontSize),
      color: parseCssColor(definition.attributes.fontColor),
      spaceBefore: number(definition.attributes.spaceBefore) ?? 0,
      spaceAfter: number(definition.attributes.spaceAfter) ?? 0,
    });
  }
  return styles;
}

function readTagDefinitions(page: XmlElement): Map<string, TagDefinition> {
  const definitions = new Map<string, TagDefinition>();
  for (const definition of childElements(page, 'TagDef')) {
    const index = definition.attributes.index;
    if (index === undefined) continue;
    definitions.set(index, { name: definition.attributes.name ?? '', symbol: definition.attributes.symbol ?? '' });
  }
  return definitions;
}

function readTitle(context: PageContext, page: XmlElement): string {
  const title = firstChild(page, 'Title');
  if (!title) return '';
  const parts: string[] = [];
  const visit = (element: XmlElement) => {
    for (const child of childElements(element)) {
      const name = localName(child);
      if (name === 'T') parts.push(parseOneNoteInlineHtml(textContent(child)).spans.map((span) => span.text).join(''));
      else if (name === 'OE' || name === 'OEChildren') visit(child);
      else if (name.startsWith('Ink')) {
        issue(context, { code: 'ink-data-missing', severity: 'simplified', message: 'A handwritten page title was not imported.', sourceElement: 'Title' });
      }
    }
  };
  visit(title);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * OneNote's rule lines (one:RuleLines with Horizontal and Vertical spacing in
 * points) become Canvink's lined or squared paper, and a page colour its
 * paper colour.
 */
export function pageBackground(page: XmlElement): PlannedPageBackground | undefined {
  const settings = firstChild(page, 'PageSettings');
  if (!settings) return undefined;
  const color = parseCssColor(settings.attributes.color) ?? '#ffffff';
  const rules = firstChild(settings, 'RuleLines');
  const horizontal = rules?.attributes.visible === 'true' ? firstChild(rules, 'Horizontal') : undefined;
  const vertical = rules?.attributes.visible === 'true' ? firstChild(rules, 'Vertical') : undefined;
  if (!horizontal) return color === '#ffffff' ? undefined : { type: 'plain', color };
  const spacing = number(horizontal.attributes.spacing);
  const lineColor = parseCssColor(horizontal.attributes.color);
  return {
    type: vertical ? 'grid' : 'lined',
    color,
    ...(spacing !== undefined && spacing > 0 ? { spacing: spacing * POINTS_TO_PX } : {}),
    ...(lineColor ? { lineColor } : {}),
  };
}

function translateBlock(block: RichBlock, dx: number, dy: number): void {
  if (block.position) {
    if (block.position.x !== undefined) block.position.x += dx;
    if (block.position.y !== undefined) block.position.y += dy;
  }
  if (block.type === 'ink') {
    for (const stroke of block.strokes) {
      for (const point of stroke.points) {
        point.x += dx;
        point.y += dy;
      }
    }
  }
}

function blockTopLeft(block: RichBlock): { x: number; y: number } {
  if (block.type === 'ink') {
    let x = Number.POSITIVE_INFINITY;
    let y = Number.POSITIVE_INFINITY;
    for (const stroke of block.strokes) {
      for (const point of stroke.points) {
        x = Math.min(x, point.x - stroke.size / 2);
        y = Math.min(y, point.y - stroke.size / 2);
      }
    }
    return { x, y };
  }
  return { x: block.position?.x ?? 0, y: block.position?.y ?? 0 };
}

/**
 * Converts one page of a OneNote desktop export (the page XML from
 * `GetPageContent`, with binary data externalised by the exporter).
 */
export function convertDesktopPageXml(page: XmlElement, options: DesktopPageConversionOptions): DesktopPageConversion {
  if (localName(page) !== 'Page') throw new Error('The page XML has no one:Page root.');
  const context: PageContext = {
    options,
    quickStyles: readQuickStyles(page),
    tagDefinitions: readTagDefinitions(page),
    issues: [],
    issueKeys: new Set(),
    placed: [],
    counts: { textFrames: 0, images: 0, printoutPages: 0, attachments: 0, inkObjects: 0, inkStrokes: 0 },
    tags: new Set(),
    openTasks: 0,
    doneTasks: 0,
  };
  const title = readTitle(context, page);
  const pageLevel = childElements(page);
  const files: PageLevelFile[] = [];
  const printouts: Array<{ element: XmlElement; order: number; y: number }> = [];

  pageLevel.forEach((element, order) => {
    const name = localName(element);
    if (name === 'InsertedFile' || name === 'MediaFile') {
      files.push({ element, order, y: box(element)?.y ?? 0 });
    } else if (name === 'Outline') {
      // A file dropped into a text box sits inside the outline; its printout
      // pages still lie on the page itself and belong to it.
      for (const nested of descendants(element, 'InsertedFile')) {
        files.push({ element: nested, order, y: box(element)?.y ?? 0 });
      }
    } else if (name === 'Image' && element.attributes.isPrintOut === 'true') {
      printouts.push({ element, order, y: box(element)?.y ?? 0 });
    }
  });

  for (const element of pageLevel) {
    const name = localName(element);
    if (name === 'Outline') {
      convertOutline(context, element);
    } else if (name === 'Image' && element.attributes.isPrintOut !== 'true') {
      const position = box(element);
      if (!position) continue;
      const background = element.attributes.backgroundImage === 'true' || element.attributes.isBackground === 'true';
      const block = imageBlock(context, element, position, background);
      if (block) {
        context.counts.images += 1;
        place(context, block, position.z, background);
      }
    } else if (name === 'InkDrawing' || name === 'InkWord' || name === 'InkParagraph') {
      const position = box(element);
      const ink = inkObject(context, element);
      if (!ink) continue;
      const target = position ?? { ...inkOrigin(ink), z: 0 };
      addInk(context, inkStrokesAt(ink, target), target.z);
    } else if (name === 'InsertedFile' || name === 'MediaFile') {
      const position = box(element);
      const block = position ? fileBlock(context, element, position) : undefined;
      if (block) place(context, block, position?.z ?? 0);
    } else if (!['Image', 'Title', 'QuickStyleDef', 'TagDef', 'PageSettings', 'Meta', 'MediaPlaylist', 'XPSFile'].includes(name)) {
      issue(context, {
        code: 'unsupported-element',
        severity: 'simplified',
        message: `A OneNote ${name} object was not imported.`,
        sourceElement: name,
      });
    }
  }

  const owners = assignPrintouts(printouts, files);
  // Page numbers come from `originalPageNumber` when OneNote recorded it
  // (zero-based where any page of the file says 0), else from the order.
  const recorded = printouts.map((printout) => number(printout.element.attributes.originalPageNumber));
  const zeroBased = new Set<PageLevelFile | undefined>();
  owners.forEach((owner, index) => { if (recorded[index] === 0) zeroBased.add(owner); });
  const seen = new Map<PageLevelFile | undefined, number>();
  const pageNumbers = owners.map((owner, index) => {
    const ordinal = (seen.get(owner) ?? 0) + 1;
    seen.set(owner, ordinal);
    const value = recorded[index];
    return value !== undefined && Number.isInteger(value) && value >= 0
      ? value + (zeroBased.has(owner) ? 1 : 0)
      : ordinal;
  });
  const pageCounts = new Map<PageLevelFile | undefined, number>();
  owners.forEach((owner, index) => pageCounts.set(owner, Math.max(pageCounts.get(owner) ?? 0, pageNumbers[index], seen.get(owner) ?? 0)));
  printouts.forEach((printout, index) => {
    const position = box(printout.element);
    if (!position) return;
    const owner = owners[index];
    const pageNumber = Math.max(1, pageNumbers[index]);
    const preview = imageBlock(context, printout.element, position, true);
    if (!preview || preview.type !== 'image') return;
    const originalPath = owner?.element.attributes.canvinkFile;
    const originalInfo = originalPath ? options.asset(originalPath) : undefined;
    const originalUsable = originalPath !== undefined
      && originalInfo?.mediaType === 'application/pdf'
      && options.rejectResource?.(originalPath, 'pdf') === undefined;
    context.counts.printoutPages += 1;
    if (originalUsable && owner && originalInfo) {
      place(context, {
        type: 'pdfPage',
        previewResourceId: preview.resourceId,
        originalResourceId: originalInfo.resourceId,
        pageNumber,
        pageCount: Math.max(pageNumber, pageCounts.get(owner) ?? pageNumber),
        background: true,
        position,
      }, position.z, true);
    } else {
      // Printouts of Word files or of the "Send to OneNote" printer have no PDF behind them.
      place(context, preview, position.z, true);
    }
  });

  // Backgrounds stay beneath everything; the rest keeps OneNote's z-order.
  const ordered = [...context.placed].sort((left, right) => (
    Number(right.background) - Number(left.background) || left.z - right.z || left.order - right.order
  ));
  const blocks = ordered.map((item) => item.block);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    const corner = blockTopLeft(block);
    if (Number.isFinite(corner.x)) minX = Math.min(minX, corner.x);
    if (Number.isFinite(corner.y)) minY = Math.min(minY, corner.y);
  }
  // Canvink pages start at 0,0, so content OneNote placed left of the margin
  // is shifted in as a whole. OneNote also reserves a band at the top of the
  // canvas for the page title, which Canvink shows above the canvas instead;
  // that band is removed so the page starts with its content.
  const dx = Number.isFinite(minX) && minX < 0 ? -minX : 0;
  const dy = !Number.isFinite(minY) ? 0 : minY < 0 ? -minY : -Math.max(0, Math.min(minY, TITLE_BAND_PX) - TOP_MARGIN_PX);
  if (dx !== 0 || dy !== 0) {
    for (const block of blocks) translateBlock(block, dx, dy);
  }

  return {
    title,
    blocks,
    issues: context.issues,
    counts: context.counts,
    tags: [...context.tags],
    ...(pageBackground(page) ? { background: pageBackground(page) } : {}),
    ...(context.openTasks + context.doneTasks > 0
      ? { taskState: context.openTasks > 0 ? 'open' as const : 'done' as const }
      : {}),
  };
}
