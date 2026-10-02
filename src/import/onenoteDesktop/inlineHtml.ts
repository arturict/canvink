import type { RichTextMark, RichTextSpan } from '../types';

/**
 * OneNote stores each paragraph's text (`one:T`) as a CDATA fragment of
 * inline HTML: `<span style='font-weight:bold'>`, `<a href=…>`, `<br>`,
 * unquoted attributes such as `<span lang=de-CH>`, and conditional comments
 * that carry MathML for typed equations. This reads that fragment into spans
 * plus the appearance the span model cannot hold (colour, size, highlight),
 * which the caller folds into element-level style or reports as dropped.
 */
export interface InlineTextStyle {
  color?: string;
  /** CSS pixels */
  fontSize?: number;
  fontFamily?: string;
  highlighted?: boolean;
  script?: 'super' | 'sub';
}

export interface StyledSpan extends RichTextSpan {
  style: InlineTextStyle;
}

export interface InlineHtmlResult {
  spans: StyledSpan[];
  /** A typed OneNote equation was present; only its text fallback survives. */
  hadEquation: boolean;
  droppedUnsafeLink: boolean;
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­',
  ndash: '–', mdash: '—', hellip: '…', euro: '€', laquo: '«', raquo: '»',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', middot: '·',
  times: '×', divide: '÷', deg: '°', plusmn: '±', sup2: '²', sup3: '³',
};

const NAMED_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
  maroon: '#800000', navy: '#000080', teal: '#008080', olive: '#808000', lime: '#00ff00',
  aqua: '#00ffff', fuchsia: '#ff00ff', silver: '#c0c0c0',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : '�';
    }
    return NAMED[entity] ?? match;
  });
}

export function parseCssColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'automatic' || trimmed === 'auto' || trimmed === 'inherit' || trimmed === 'windowtext') return undefined;
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/.exec(trimmed);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1];
    return `#${digits}`;
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(trimmed);
  if (rgb) {
    return `#${rgb.slice(1, 4).map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('')}`;
  }
  return NAMED_COLORS[trimmed];
}

/** `11.0pt` → 14.67 CSS pixels. */
export function parseFontSize(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(pt|px)?\s*$/i.exec(value);
  if (!match) return undefined;
  const size = Number(match[1]) * ((match[2] ?? 'pt').toLowerCase() === 'pt' ? 4 / 3 : 1);
  return size > 0 && size < 1000 ? size : undefined;
}

export function parseStyleAttribute(value: string | undefined): Map<string, string> {
  const style = new Map<string, string>();
  if (!value) return style;
  for (const declaration of value.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;
    style.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim());
  }
  return style;
}

export function fontFamilyFromCss(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
  return first || undefined;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (name in attributes) continue;
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

interface Frame {
  tag: string;
  marks: RichTextMark[];
  style: InlineTextStyle;
}

function styleFrame(parent: Frame, tag: string, attributes: Record<string, string>): Frame {
  const marks = [...parent.marks];
  const style: InlineTextStyle = { ...parent.style };
  const css = parseStyleAttribute(attributes.style);
  const weight = css.get('font-weight');
  if (tag === 'b' || tag === 'strong' || weight === 'bold' || /^[6-9]00$/.test(weight ?? '')) marks.push({ type: 'bold' });
  if (tag === 'i' || tag === 'em' || css.get('font-style') === 'italic') marks.push({ type: 'italic' });
  const decoration = `${css.get('text-decoration') ?? ''} ${css.get('text-decoration-line') ?? ''}`;
  if (tag === 'u' || /\bunderline\b/.test(decoration)) marks.push({ type: 'underline' });
  if (tag === 's' || tag === 'strike' || tag === 'del' || /\bline-through\b/.test(decoration)) marks.push({ type: 'strikethrough' });
  if (tag === 'code') marks.push({ type: 'code' });
  const color = parseCssColor(css.get('color'));
  if (color) style.color = color;
  const fontSize = parseFontSize(css.get('font-size'));
  if (fontSize) style.fontSize = fontSize;
  const family = fontFamilyFromCss(css.get('font-family'));
  if (family) style.fontFamily = family;
  const background = css.get('background') ?? css.get('background-color');
  if (background && parseCssColor(background) && parseCssColor(background) !== '#ffffff') style.highlighted = true;
  const verticalAlign = css.get('vertical-align');
  if (tag === 'sup' || verticalAlign === 'super') style.script = 'super';
  if (tag === 'sub' || verticalAlign === 'sub') style.script = 'sub';
  return { tag, marks, style };
}

function sameMarks(left: readonly RichTextMark[], right: readonly RichTextMark[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStyle(left: InlineTextStyle, right: InlineTextStyle): boolean {
  return left.color === right.color && left.fontSize === right.fontSize && left.fontFamily === right.fontFamily
    && left.highlighted === right.highlighted && left.script === right.script;
}

function dedupeMarks(marks: RichTextMark[]): RichTextMark[] {
  const seen = new Set<string>();
  return marks.filter((mark) => {
    const key = mark.type === 'link' ? `link:${mark.href}` : mark.type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseOneNoteInlineHtml(html: string, base: InlineTextStyle = {}): InlineHtmlResult {
  const spans: StyledSpan[] = [];
  const stack: Frame[] = [{ tag: '#root', marks: [], style: { ...base } }];
  let hadEquation = false;
  let droppedUnsafeLink = false;
  const push = (text: string) => {
    if (!text) return;
    const frame = stack[stack.length - 1];
    const marks = dedupeMarks(frame.marks);
    const previous = spans[spans.length - 1];
    if (previous && sameMarks(previous.marks, marks) && sameStyle(previous.style, frame.style)) {
      previous.text += text;
    } else {
      spans.push({ text, marks, style: { ...frame.style } });
    }
  };
  const token = /<!--([\s\S]*?)-->|<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)|(<)/g;
  for (const match of html.matchAll(token)) {
    if (match[1] !== undefined) {
      if (/\bmathML\b|<math\b/i.test(match[1])) hadEquation = true;
      continue;
    }
    if (match[5] !== undefined || match[6] !== undefined) {
      // OneNote writes line breaks inside a paragraph only as <br>; raw newlines are layout whitespace.
      push(decodeHtmlEntities(match[5] ?? match[6]).replace(/[\r\n\t]+/g, ' '));
      continue;
    }
    const closing = match[2] === '/';
    const tag = match[3].toLowerCase();
    if (tag === 'br') {
      if (!closing) push('\n');
      continue;
    }
    if (tag === 'math') hadEquation = true;
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const selfClosing = /\/\s*$/.test(match[4]);
    const attributes = parseAttributes(match[4].replace(/\/\s*$/, ''));
    const frame = styleFrame(stack[stack.length - 1], tag, attributes);
    if (tag === 'a') {
      const href = safeHref(attributes.href);
      if (href) frame.marks.push({ type: 'link', href });
      else if (attributes.href) droppedUnsafeLink = true;
    }
    if (!selfClosing) stack.push(frame);
  }
  return { spans, hadEquation, droppedUnsafeLink };
}
