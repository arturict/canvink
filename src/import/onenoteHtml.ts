import { normalizePageTag } from '../domain/pageTags';
import type {
  AttachmentBlock,
  FidelityIssue,
  GraphResourceInput,
  ImageBlock,
  RichBlock,
  RichTextMark,
  RichTextSpan,
  SpatialPosition,
  TableCell,
} from './types';

const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_NODES = 100_000;
const DEFAULT_MAX_DEPTH = 128;
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const DROPPED_WITH_CONTENT = new Set([
  'applet', 'audio', 'canvas', 'embed', 'form', 'iframe', 'math', 'noscript',
  'script', 'style', 'svg', 'video',
]);
const INLINE_ELEMENTS = new Set([
  'a', 'b', 'br', 'code', 'del', 'em', 'i', 'mark', 's', 'small', 'span',
  'strike', 'strong', 'sub', 'sup', 'u',
]);
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', apos: "'", gt: '>', lt: '<', nbsp: '\u00a0', quot: '"',
};

interface RootNode {
  type: 'root';
  children: HtmlNode[];
}

interface ElementNode {
  type: 'element';
  name: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
}

interface TextNode {
  type: 'text';
  value: string;
}

type HtmlNode = ElementNode | TextNode;

export interface OneNoteHtmlConversionOptions {
  maxHtmlBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
}

export interface OneNoteHtmlConversionResult {
  blocks: RichBlock[];
  issues: FidelityIssue[];
  hadSourceContent: boolean;
  tags: string[];
  taskState?: 'open' | 'done';
}

interface ConversionContext {
  issues: FidelityIssue[];
  resources: ResourceResolver;
  styleCache: WeakMap<ElementNode, Map<string, string>>;
  tags: Set<string>;
  sawOpenTask: boolean;
  sawDoneTask: boolean;
}

interface ResourceResolver {
  byUrl: Map<string, GraphResourceInput>;
  byId: Map<string, GraphResourceInput>;
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi,
    (match, entity: string) => {
      if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
      const hexadecimal = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return '\ufffd';
      return String.fromCodePoint(codePoint);
    },
  );
}

function findTagEnd(html: string, start: number): number {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (index >= source.length || source[index] === '/') break;
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    while (/\s/.test(source[index] ?? '')) index += 1;
    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] ?? '')) index += 1;
      const quote = source[index] === '"' || source[index] === "'" ? source[index++] : '';
      const valueStart = index;
      if (quote) {
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    // First attribute wins, avoiding ambiguous duplicate security-sensitive values.
    if (name && !(name in attributes) && !name.startsWith('on')) {
      attributes[name] = decodeEntities(value);
    }
  }
  return attributes;
}

function parseHtml(
  html: string,
  maxNodes: number,
  maxDepth: number,
  issues: FidelityIssue[],
): RootNode | null {
  const root: RootNode = { type: 'root', children: [] };
  const stack: Array<RootNode | ElementNode> = [root];
  const lowerHtml = html.toLowerCase();
  let index = 0;
  let nodeCount = 0;

  const addNode = (node: HtmlNode): boolean => {
    nodeCount += 1;
    if (nodeCount > maxNodes) return false;
    stack[stack.length - 1].children.push(node);
    return true;
  };

  while (index < html.length) {
    if (html[index] !== '<') {
      const nextTag = html.indexOf('<', index);
      const end = nextTag === -1 ? html.length : nextTag;
      if (!addNode({ type: 'text', value: decodeEntities(html.slice(index, end)) })) return null;
      index = end;
      continue;
    }
    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4);
      if (commentEnd === -1) {
        issues.push({ code: 'malformed-html', severity: 'simplified', message: 'An unterminated HTML comment was dropped.' });
        break;
      }
      index = commentEnd + 3;
      continue;
    }
    const end = findTagEnd(html, index + 1);
    if (end === -1) {
      issues.push({ code: 'malformed-html', severity: 'simplified', message: 'An unterminated HTML tag was dropped.' });
      break;
    }
    const rawTag = html.slice(index + 1, end).trim();
    if (!rawTag || rawTag[0] === '!' || rawTag[0] === '?') {
      index = end + 1;
      continue;
    }
    const closing = rawTag[0] === '/';
    const tagSource = closing ? rawTag.slice(1).trim() : rawTag;
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(tagSource);
    if (!nameMatch) {
      issues.push({ code: 'malformed-html', severity: 'simplified', message: 'A malformed HTML tag was dropped.' });
      index = end + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    if (closing) {
      for (let stackIndex = stack.length - 1; stackIndex > 0; stackIndex -= 1) {
        const candidate = stack[stackIndex];
        if (candidate.type === 'element' && candidate.name === name) {
          stack.length = stackIndex;
          break;
        }
      }
      index = end + 1;
      continue;
    }

    if (DROPPED_WITH_CONTENT.has(name)) {
      issues.push({
        code: 'unsupported-element',
        severity: 'unsupported',
        message: `<${name}> content was not imported.`,
        sourceElement: name,
      });
      if (!VOID_ELEMENTS.has(name)) {
        const closeStart = lowerHtml.indexOf(`</${name}`, end + 1);
        if (closeStart !== -1) {
          const closeEnd = findTagEnd(html, closeStart + name.length + 2);
          index = closeEnd === -1 ? html.length : closeEnd + 1;
          continue;
        }
      }
      index = end + 1;
      continue;
    }

    const element: ElementNode = {
      type: 'element',
      name,
      attributes: parseAttributes(tagSource.slice(nameMatch[0].length)),
      children: [],
    };
    if (!addNode(element)) return null;
    const selfClosing = /\/\s*$/.test(rawTag) || VOID_ELEMENTS.has(name);
    if (!selfClosing) {
      if (stack.length >= maxDepth) return null;
      stack.push(element);
    }
    index = end + 1;
  }
  return root;
}

function addIssue(context: ConversionContext, issue: FidelityIssue): void {
  context.issues.push(issue);
}

function sameMarks(left: RichTextMark[], right: RichTextMark[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeSpans(spans: RichTextSpan[], preserveWhitespace = false): RichTextSpan[] {
  const normalized: RichTextSpan[] = [];
  for (const span of spans) {
    const text = preserveWhitespace ? span.text : span.text.replace(/[\t\r\n ]+/g, ' ');
    if (!text) continue;
    const uniqueMarks = span.marks.filter((mark, index, marks) => {
      const key = mark.type === 'link' ? `${mark.type}:${mark.href}` : mark.type;
      return marks.findIndex((candidate) => (candidate.type === 'link' ? `${candidate.type}:${candidate.href}` : candidate.type) === key) === index;
    });
    const previous = normalized[normalized.length - 1];
    if (previous && sameMarks(previous.marks, uniqueMarks)) previous.text += text;
    else normalized.push({ text, marks: uniqueMarks });
  }
  if (!preserveWhitespace && normalized.length > 0) {
    normalized[0].text = normalized[0].text.replace(/^ /, '');
    normalized[normalized.length - 1].text = normalized[normalized.length - 1].text.replace(/ $/, '');
  }
  return normalized.filter((span) => span.text.length > 0);
}

function parseStyle(node: ElementNode, context: ConversionContext): Map<string, string> {
  const cached = context.styleCache.get(node);
  if (cached) return cached;
  const result = new Map<string, string>();
  const style = node.attributes.style;
  context.styleCache.set(node, result);
  if (!style) return result;
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator <= 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim().toLowerCase();
    if (!property || result.has(property)) continue;
    if (['position', 'left', 'top', 'width', 'height', 'z-index', 'font-weight', 'font-style', 'text-decoration'].includes(property)) {
      result.set(property, value);
    } else {
      addIssue(context, {
        code: 'style-dropped',
        severity: 'visual',
        message: `The ${property} style was not imported.`,
        sourceElement: node.name,
      });
    }
  }
  return result;
}

function boundedNumber(value: string | undefined, requirePixels: boolean): number | undefined {
  if (!value) return undefined;
  const pattern = requirePixels ? /^-?\d+(?:\.\d+)?px$/ : /^-?\d+(?:\.\d+)?(?:px)?$/;
  if (!pattern.test(value.trim().toLowerCase())) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 1_000_000 ? parsed : undefined;
}

function spatialPosition(node: ElementNode, context: ConversionContext): SpatialPosition | undefined {
  const style = parseStyle(node, context);
  const hasSpatialStyle = ['position', 'left', 'top', 'width', 'height', 'z-index'].some((key) => style.has(key));
  const hasSizeAttribute = node.attributes.width !== undefined || node.attributes.height !== undefined;
  if (!hasSpatialStyle && !hasSizeAttribute) return undefined;

  const positionValue = style.get('position');
  if (positionValue && positionValue !== 'absolute' && positionValue !== 'relative') {
    addIssue(context, { code: 'invalid-position', severity: 'visual', message: `The ${positionValue} position was not imported.`, sourceElement: node.name });
  }
  const position: SpatialPosition = {};
  const candidates: Array<[keyof SpatialPosition, string | undefined, boolean]> = [
    ['x', style.get('left'), true],
    ['y', style.get('top'), true],
    ['width', style.get('width') ?? node.attributes.width, style.has('width')],
    ['height', style.get('height') ?? node.attributes.height, style.has('height')],
    ['zIndex', style.get('z-index'), false],
  ];
  for (const [key, raw, requirePixels] of candidates) {
    if (raw === undefined) continue;
    const parsed = boundedNumber(raw, requirePixels);
    if (parsed === undefined || ((key === 'width' || key === 'height') && parsed < 0)) {
      addIssue(context, { code: 'invalid-position', severity: 'visual', message: `An invalid ${key} value was not imported.`, sourceElement: node.name });
    } else {
      position[key] = parsed;
    }
  }
  return Object.keys(position).length > 0 ? position : undefined;
}

function sourceId(node: ElementNode): string | undefined {
  const value = node.attributes['data-id'] ?? node.attributes.id;
  return value && value.length <= 256 ? value : undefined;
}

function safeHref(value: string | undefined): string | undefined {
  if (!value || Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  })) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('#') && /^#[A-Za-z0-9_.:-]+$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function styleMarks(node: ElementNode, context: ConversionContext): RichTextMark[] {
  const style = parseStyle(node, context);
  const marks: RichTextMark[] = [];
  if (style.get('font-weight') === 'bold' || /^[6-9]00$/.test(style.get('font-weight') ?? '')) marks.push({ type: 'bold' });
  if (style.get('font-style') === 'italic') marks.push({ type: 'italic' });
  const decoration = style.get('text-decoration') ?? '';
  if (decoration.split(/\s+/).includes('underline')) marks.push({ type: 'underline' });
  if (decoration.split(/\s+/).some((item) => item === 'line-through')) marks.push({ type: 'strikethrough' });
  return marks;
}

function inlineContent(
  nodes: HtmlNode[],
  context: ConversionContext,
  inheritedMarks: RichTextMark[] = [],
  preserveWhitespace = false,
): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      spans.push({ text: node.value, marks: inheritedMarks });
      continue;
    }
    if (node.name === 'br') {
      spans.push({ text: '\n', marks: inheritedMarks });
      continue;
    }
    if (!INLINE_ELEMENTS.has(node.name)) {
      addIssue(context, { code: 'unsupported-element', severity: 'simplified', message: `<${node.name}> was flattened to text.`, sourceElement: node.name });
      spans.push(...inlineContent(node.children, context, inheritedMarks, preserveWhitespace));
      continue;
    }
    const marks = [...inheritedMarks, ...styleMarks(node, context)];
    if (node.name === 'b' || node.name === 'strong') marks.push({ type: 'bold' });
    if (node.name === 'i' || node.name === 'em') marks.push({ type: 'italic' });
    if (node.name === 'u') marks.push({ type: 'underline' });
    if (node.name === 's' || node.name === 'strike' || node.name === 'del') marks.push({ type: 'strikethrough' });
    if (node.name === 'code') marks.push({ type: 'code' });
    if (node.name === 'a') {
      const href = safeHref(node.attributes.href);
      if (href) marks.push({ type: 'link', href });
      else if (node.attributes.href) addIssue(context, { code: 'unsafe-url-dropped', severity: 'simplified', message: 'An unsafe link target was removed.', sourceElement: 'a' });
    }
    if (node.name === 'sub' || node.name === 'sup' || node.name === 'mark' || node.name === 'small') {
      addIssue(context, { code: 'style-dropped', severity: 'visual', message: `<${node.name}> formatting was not imported.`, sourceElement: node.name });
    }
    spans.push(...inlineContent(node.children, context, marks, preserveWhitespace));
  }
  return normalizeSpans(spans, preserveWhitespace);
}

function resourceIdFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['graph.microsoft.com', 'www.onenote.com'].includes(url.hostname.toLowerCase())) return undefined;
    const match = /\/(?:onenote|notes)\/resources\/([^/]+)\/(?:\$value|content)(?:\/)?$/i.exec(url.pathname)
      ?? /\/v1\.0\/resources\/([^/]+)\/(?:\$value|content)(?:\/)?$/i.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function resolveResource(value: string | undefined, resolver: ResourceResolver): GraphResourceInput | undefined {
  if (!value) return undefined;
  return resolver.byUrl.get(value.trim()) ?? (resourceIdFromUrl(value) ? resolver.byId.get(resourceIdFromUrl(value)!) : undefined);
}

function imageBlock(node: ElementNode, context: ConversionContext): ImageBlock | null {
  const source = node.attributes['data-fullres-src'] ?? node.attributes.src;
  const resource = resolveResource(source, context.resources);
  const safeImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
  if (!resource || !safeImageTypes.has(resource.mediaType.toLowerCase())) {
    addIssue(context, { code: 'image-resource-missing', severity: 'unsupported', message: 'An image did not match a supplied local Graph image resource.', sourceElement: 'img' });
    return null;
  }
  return {
    type: 'image',
    resourceId: resource.id,
    mediaType: resource.mediaType,
    alt: node.attributes.alt ?? '',
    sourceId: sourceId(node),
    position: spatialPosition(node, context),
  };
}

function safeFileName(value: string, context: ConversionContext): string {
  const sanitized = Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f || '<>:"/\\|?*'.includes(character) ? '_' : character;
    })
    .join('')
    .replace(/^\.+$/, '_')
    .slice(0, 255);
  if (sanitized !== value || !sanitized) {
    addIssue(context, { code: 'unsafe-file-name', severity: 'simplified', message: 'Unsafe attachment filename characters were replaced.', sourceElement: 'object' });
  }
  return sanitized || 'attachment';
}

function attachmentBlock(node: ElementNode, context: ConversionContext): AttachmentBlock | null {
  const resource = resolveResource(node.attributes.data, context.resources);
  if (!resource) {
    addIssue(context, { code: 'attachment-resource-missing', severity: 'unsupported', message: 'An attachment did not match a supplied local Graph resource.', sourceElement: 'object' });
    return null;
  }
  return {
    type: 'attachment',
    resourceId: resource.id,
    mediaType: resource.mediaType,
    fileName: safeFileName(node.attributes['data-attachment'] ?? resource.fileName ?? 'attachment', context),
    sourceId: sourceId(node),
    position: spatialPosition(node, context),
  };
}

const KNOWN_TAG_ALIASES: Readonly<Record<string, string>> = {
  important: 'important', critical: 'critical', question: 'question', definition: 'definition',
  highlight: 'highlight', idea: 'idea', contact: 'contact', address: 'address',
  phone: 'phone-number', 'phone-number': 'phone-number', website: 'website',
  password: 'password', source: 'source', 'project-a': 'project-a', 'project-b': 'project-b',
};


function tagState(node: ElementNode, context: ConversionContext): boolean | undefined {
  const raw = node.attributes['data-tag'];
  if (!raw) return undefined;
  let task: boolean | undefined;
  for (const part of raw.split(/[,;]/)) {
    const value = part.normalize('NFKC').trim().toLowerCase();
    if (!value) continue;
    const taskMatch = /^(?:to[\s_-]?do|todo|task)(?::\s*(completed|complete|done|checked))?$/.exec(value);
    if (taskMatch) {
      task = Boolean(taskMatch[1]);
      context.tags.add('todo');
      if (task) context.sawDoneTask = true; else context.sawOpenTask = true;
      continue;
    }
    const normalized = normalizePageTag(value);
    if (!normalized) {
      addIssue(context, { code: 'data-tag-unsupported', severity: 'simplified', message: 'An invalid OneNote data-tag could not be preserved.', sourceElement: node.name });
      continue;
    }
    context.tags.add(normalized.startsWith('onenote:')
      ? normalized
      : KNOWN_TAG_ALIASES[normalized] ?? `onenote:${normalized}`);
  }
  return task;
}

function directDescendants(node: ElementNode, names: Set<string>): ElementNode[] {
  const result: ElementNode[] = [];
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (names.has(child.name)) result.push(child);
    else if (['tbody', 'thead', 'tfoot'].includes(child.name)) result.push(...directDescendants(child, names));
  }
  return result;
}

function positiveSpan(value: string | undefined): number {
  const parsed = value && /^\d+$/.test(value) ? Number.parseInt(value, 10) : 1;
  return parsed >= 1 && parsed <= 1000 ? parsed : 1;
}

function convertTable(node: ElementNode, context: ConversionContext): RichBlock | null {
  const rows = directDescendants(node, new Set(['tr'])).map((row) =>
    directDescendants(row, new Set(['td', 'th'])).map<TableCell>((cell) => {
      const blocks = convertNodes(cell.children, context);
      return {
        header: cell.name === 'th',
        rowSpan: positiveSpan(cell.attributes.rowspan),
        colSpan: positiveSpan(cell.attributes.colspan),
        blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [] }],
      };
    }),
  ).filter((row) => row.length > 0);
  if (rows.length === 0) return null;
  return { type: 'table', rows, sourceId: sourceId(node), position: spatialPosition(node, context) };
}

function convertList(node: ElementNode, context: ConversionContext): RichBlock | null {
  const items = node.children.filter((child): child is ElementNode => child.type === 'element' && child.name === 'li');
  if (items.length === 0) return null;
  const converted = items.map((item) => ({ checked: tagState(item, context), blocks: convertNodes(item.children, context) }));
  if (converted.every((item) => item.checked !== undefined)) {
    return {
      type: 'checklist',
      items: converted.map((item, index) => ({
        checked: item.checked ?? false,
        content: inlineContent(items[index].children, context),
      })),
      sourceId: sourceId(node),
      position: spatialPosition(node, context),
    };
  }
  const start = node.name === 'ol' ? positiveSpan(node.attributes.start) : undefined;
  return {
    type: 'list',
    ordered: node.name === 'ol',
    start,
    items: converted.map((item) => ({
      checked: item.checked,
      blocks: item.blocks.length > 0 ? item.blocks : [{ type: 'paragraph', content: [] }],
    })),
    sourceId: sourceId(node),
    position: spatialPosition(node, context),
  };
}

function convertElement(node: ElementNode, context: ConversionContext): RichBlock[] {
  const common = { sourceId: sourceId(node), position: spatialPosition(node, context) };
  if (/^h[1-6]$/.test(node.name)) {
    return [{ type: 'heading', level: Number(node.name[1]) as 1 | 2 | 3 | 4 | 5 | 6, content: inlineContent(node.children, context, styleMarks(node, context)), ...common }];
  }
  if (node.name === 'p') {
    const checked = tagState(node, context);
    const containsBlockContent = node.children.some((child) => child.type === 'element' && !INLINE_ELEMENTS.has(child.name));
    if (containsBlockContent) {
      const blocks = convertNodes(node.children, context);
      if (checked !== undefined) {
        addIssue(context, { code: 'unsupported-element', severity: 'simplified', message: 'A checklist item containing block media was imported without its checklist state.', sourceElement: 'p' });
      }
      return common.position || common.sourceId ? [{ type: 'spatialGroup', blocks, ...common }] : blocks;
    }
    const content = inlineContent(node.children, context, styleMarks(node, context));
    return checked === undefined
      ? [{ type: 'paragraph', content, ...common }]
      : [{ type: 'checklist', items: [{ checked, content }], ...common }];
  }
  if (node.name === 'blockquote' || node.name === 'pre') {
    const marks: RichTextMark[] = node.name === 'pre' ? [{ type: 'code' }] : styleMarks(node, context);
    return [{ type: node.name === 'pre' ? 'code' : 'blockquote', content: inlineContent(node.children, context, marks, node.name === 'pre'), ...common }];
  }
  if (node.name === 'ul' || node.name === 'ol') {
    const list = convertList(node, context);
    return list ? [list] : [];
  }
  if (node.name === 'table') {
    const table = convertTable(node, context);
    return table ? [table] : [];
  }
  if (node.name === 'img') {
    const image = imageBlock(node, context);
    return image ? [image] : [];
  }
  if (node.name === 'object') {
    const attachment = attachmentBlock(node, context);
    return attachment ? [attachment] : [];
  }
  if (node.name === 'div') {
    const blocks = convertNodes(node.children, context);
    return common.position || common.sourceId ? [{ type: 'spatialGroup', blocks, ...common }] : blocks;
  }
  if (['body', 'html', 'main', 'article', 'section', 'header', 'footer', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th'].includes(node.name)) {
    return convertNodes(node.children, context);
  }
  if (['head', 'title', 'meta', 'link'].includes(node.name)) return [];
  if (node.name === 'hr') {
    addIssue(context, { code: 'unsupported-element', severity: 'simplified', message: '<hr> was not imported.', sourceElement: 'hr' });
    return [];
  }
  addIssue(context, { code: 'unsupported-element', severity: 'simplified', message: `<${node.name}> was flattened.`, sourceElement: node.name });
  return convertNodes(node.children, context);
}

function convertNodes(nodes: HtmlNode[], context: ConversionContext): RichBlock[] {
  const blocks: RichBlock[] = [];
  let inlineRun: HtmlNode[] = [];
  const flushInline = () => {
    if (inlineRun.length === 0) return;
    const content = inlineContent(inlineRun, context);
    if (content.some((span) => span.text.trim().length > 0)) blocks.push({ type: 'paragraph', content });
    inlineRun = [];
  };
  for (const node of nodes) {
    if (node.type === 'text' || INLINE_ELEMENTS.has(node.name)) {
      inlineRun.push(node);
    } else {
      flushInline();
      blocks.push(...convertElement(node, context));
    }
  }
  flushInline();
  return blocks;
}

function createResolver(resources: readonly GraphResourceInput[]): ResourceResolver {
  const byUrl = new Map<string, GraphResourceInput>();
  const byId = new Map<string, GraphResourceInput>();
  for (const resource of resources) {
    if (!byUrl.has(resource.contentUrl.trim())) byUrl.set(resource.contentUrl.trim(), resource);
    if (!byId.has(resource.id)) byId.set(resource.id, resource);
  }
  return { byUrl, byId };
}

export function convertOneNoteHtml(
  html: string,
  resources: readonly GraphResourceInput[],
  options: OneNoteHtmlConversionOptions = {},
): OneNoteHtmlConversionResult {
  const issues: FidelityIssue[] = [];
  const maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  if (new TextEncoder().encode(html).byteLength > maxHtmlBytes) {
    return {
      blocks: [],
      issues: [{ code: 'content-limit-exceeded', severity: 'unsupported', message: `Page HTML exceeds the ${maxHtmlBytes}-byte import limit.` }],
      hadSourceContent: html.trim().length > 0,
      tags: [],
    };
  }
  const root = parseHtml(html, options.maxNodes ?? DEFAULT_MAX_NODES, options.maxDepth ?? DEFAULT_MAX_DEPTH, issues);
  if (!root) {
    issues.push({ code: 'content-limit-exceeded', severity: 'unsupported', message: 'Page HTML exceeds the parser node or depth limit.' });
    return { blocks: [], issues, hadSourceContent: html.trim().length > 0, tags: [] };
  }
  const context: ConversionContext = {
    issues,
    resources: createResolver(resources),
    styleCache: new WeakMap(),
    tags: new Set(),
    sawOpenTask: false,
    sawDoneTask: false,
  };
  return {
    blocks: convertNodes(root.children, context),
    issues,
    hadSourceContent: root.children.some((node) => node.type === 'element' || node.value.trim().length > 0),
    tags: [...context.tags].sort(),
    ...(context.sawOpenTask || context.sawDoneTask
      ? { taskState: context.sawOpenTask ? 'open' as const : 'done' as const }
      : {}),
  };
}
