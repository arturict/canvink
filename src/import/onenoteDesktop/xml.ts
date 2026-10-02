/**
 * A small, strict XML reader for the page XML that OneNote's desktop COM API
 * writes (`GetPageContent`). That XML is machine-generated and well-formed,
 * so this reader supports exactly what it uses: elements with namespace
 * prefixes kept in the name, attributes, text, CDATA, comments, processing
 * instructions and the five predefined plus numeric entities. It rejects
 * DOCTYPEs, so no external entity can ever be resolved.
 */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export class XmlParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} (offset ${offset})`);
    this.name = 'XmlParseError';
  }
}

const PREDEFINED: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };
const NAME_START = /[A-Za-z_:À-￿]/u;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/u;

export function decodeXmlEntities(value: string, offset = 0): string {
  if (!value.includes('&')) return value;
  return value.replace(/&([^;&\s]{1,16});/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        throw new XmlParseError(`Invalid character reference ${match}`, offset);
      }
      return String.fromCodePoint(codePoint);
    }
    const predefined = PREDEFINED[entity];
    if (predefined === undefined) throw new XmlParseError(`Unknown entity ${match}`, offset);
    return predefined;
  });
}

export function parseXml(source: string, options: { maxNodes?: number; maxDepth?: number } = {}): XmlElement {
  const maxNodes = options.maxNodes ?? 2_000_000;
  const maxDepth = options.maxDepth ?? 256;
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const document: XmlElement = { name: '#document', attributes: {}, children: [] };
  const stack: XmlElement[] = [document];
  let index = 0;
  let nodes = 0;

  const add = (node: XmlNode) => {
    nodes += 1;
    if (nodes > maxNodes) throw new XmlParseError('The XML document has too many nodes', index);
    stack[stack.length - 1].children.push(node);
  };
  const readName = (): string => {
    const start = index;
    if (!NAME_START.test(text[index] ?? '')) throw new XmlParseError('Expected an XML name', index);
    index += 1;
    while (index < text.length && NAME_CHAR.test(text[index])) index += 1;
    return text.slice(start, index);
  };
  const skipSpace = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };

  while (index < text.length) {
    const next = text.indexOf('<', index);
    if (next === -1 || next > index) {
      const end = next === -1 ? text.length : next;
      const raw = text.slice(index, end);
      if (stack.length > 1) add(decodeXmlEntities(raw, index));
      else if (raw.trim()) throw new XmlParseError('Text outside the root element', index);
      index = end;
      continue;
    }
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      if (end === -1) throw new XmlParseError('Unterminated comment', index);
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', index)) {
      const end = text.indexOf(']]>', index + 9);
      if (end === -1) throw new XmlParseError('Unterminated CDATA section', index);
      if (stack.length === 1) throw new XmlParseError('CDATA outside the root element', index);
      add(text.slice(index + 9, end));
      index = end + 3;
      continue;
    }
    if (text.startsWith('<?', index)) {
      const end = text.indexOf('?>', index + 2);
      if (end === -1) throw new XmlParseError('Unterminated processing instruction', index);
      index = end + 2;
      continue;
    }
    if (text.startsWith('<!', index)) throw new XmlParseError('DOCTYPE declarations are not accepted', index);
    if (text.startsWith('</', index)) {
      index += 2;
      const name = readName();
      skipSpace();
      if (text[index] !== '>') throw new XmlParseError('Malformed end tag', index);
      index += 1;
      const open = stack.pop();
      if (!open || open === document || open.name !== name) {
        throw new XmlParseError(`Mismatched end tag </${name}>`, index);
      }
      continue;
    }
    index += 1;
    const element: XmlElement = { name: readName(), attributes: {}, children: [] };
    for (;;) {
      skipSpace();
      const character = text[index];
      if (character === undefined) throw new XmlParseError('Unterminated start tag', index);
      if (character === '/' || character === '>') break;
      const attribute = readName();
      skipSpace();
      if (text[index] !== '=') throw new XmlParseError(`Attribute ${attribute} has no value`, index);
      index += 1;
      skipSpace();
      const quote = text[index];
      if (quote !== '"' && quote !== "'") throw new XmlParseError('Attribute value is not quoted', index);
      const end = text.indexOf(quote, index + 1);
      if (end === -1) throw new XmlParseError('Unterminated attribute value', index);
      if (attribute in element.attributes) throw new XmlParseError(`Duplicate attribute ${attribute}`, index);
      element.attributes[attribute] = decodeXmlEntities(text.slice(index + 1, end), index);
      index = end + 1;
    }
    if (stack.length === 1 && document.children.some((child) => typeof child !== 'string')) {
      throw new XmlParseError('The XML document has more than one root element', index);
    }
    add(element);
    if (text[index] === '/') {
      if (text[index + 1] !== '>') throw new XmlParseError('Malformed empty-element tag', index);
      index += 2;
    } else {
      index += 1;
      if (stack.length > maxDepth) throw new XmlParseError('The XML document is nested too deeply', index);
      stack.push(element);
    }
  }
  if (stack.length !== 1) throw new XmlParseError(`Unclosed element <${stack[stack.length - 1].name}>`, index);
  const root = document.children.find((child): child is XmlElement => typeof child !== 'string');
  if (!root) throw new XmlParseError('The XML document has no root element', 0);
  return root;
}

/** Local name without its namespace prefix (`one:Outline` → `Outline`). */
export function localName(element: XmlElement): string {
  const colon = element.name.indexOf(':');
  return colon === -1 ? element.name : element.name.slice(colon + 1);
}

export function childElements(element: XmlElement, name?: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => (
    typeof child !== 'string' && (name === undefined || localName(child) === name)
  ));
}

export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child): child is XmlElement => (
    typeof child !== 'string' && localName(child) === name
  ));
}

export function textContent(element: XmlElement): string {
  return element.children.map((child) => (typeof child === 'string' ? child : textContent(child))).join('');
}
