import { graphError } from './errors';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const ONENOTE_ORIGIN = 'https://www.onenote.com';
const RAW_CONTENT_ELEMENTS = new Set(['script', 'style', 'iframe', 'svg', 'math', 'noscript']);

export interface GraphHtmlResourceReference {
  id: string;
  kind: 'image' | 'attachment';
  mediaTypeHint?: string;
  fileName?: string;
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt);/gi, (match) => {
    const values: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    return values[match.toLowerCase()] ?? match;
  });
}

function findTagEnd(html: string, start: number): number {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (index >= source.length || source[index] === '/') break;
    const start = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    const name = source.slice(start, index).toLowerCase();
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
    if (name && !(name in result)) result[name] = decodeEntities(value);
  }
  return result;
}

function validOpaqueId(value: string): boolean {
  if (!value || value.length > 512 || /[/\\?#]/.test(value)) return false;
  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && codePoint !== 0x7f;
  });
}

export function graphResourceId(value: string | undefined): string | undefined {
  if (!value || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
    let match: RegExpExecArray | null = null;
    if (url.origin === GRAPH_ORIGIN && !url.search) {
      match = /^\/v1\.0\/me\/onenote\/resources\/([^/]+)\/(?:content|\$value)\/?$/i.exec(url.pathname);
    } else if (url.origin === ONENOTE_ORIGIN && !url.search) {
      match = /^\/api\/v1\.0\/(?:me\/notes\/)?resources\/([^/]+)\/\$value\/?$/i.exec(url.pathname);
    }
    if (!match) return undefined;
    const id = decodeURIComponent(match[1]);
    return validOpaqueId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalGraphResourceUrl(resourceId: string): string {
  if (!validOpaqueId(resourceId)) throw graphError({ code: 'unsafe-url', operation: 'validate-resource-id' });
  return `${GRAPH_ORIGIN}/v1.0/me/onenote/resources/${encodeURIComponent(resourceId)}/content`;
}

export function validateGraphUrl(value: string, operation: string): string {
  if (value.length > 8192) throw graphError({ code: 'unsafe-url', operation });
  try {
    const url = new URL(value);
    if (
      url.origin !== GRAPH_ORIGIN
      || url.protocol !== 'https:'
      || url.username
      || url.password
      || url.hash
      || !url.pathname.startsWith('/v1.0/me/onenote/')
    ) throw graphError({ code: 'unsafe-url', operation });
    return url.href;
  } catch (error) {
    if (error instanceof Error && error.name === 'OneNoteGraphAcquisitionError') throw error;
    throw graphError({ code: 'unsafe-url', operation });
  }
}

export function extractGraphResourceReferences(html: string): GraphHtmlResourceReference[] {
  const lowerHtml = html.toLowerCase();
  const references = new Map<string, GraphHtmlResourceReference>();
  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf('<', index);
    if (tagStart === -1) break;
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      index = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }
    const tagEnd = findTagEnd(html, tagStart + 1);
    if (tagEnd === -1) break;
    const raw = html.slice(tagStart + 1, tagEnd).trim();
    const match = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(raw);
    if (!match || raw.startsWith('/')) {
      index = tagEnd + 1;
      continue;
    }
    const name = match[1].toLowerCase();
    if (RAW_CONTENT_ELEMENTS.has(name)) {
      const close = lowerHtml.indexOf(`</${name}`, tagEnd + 1);
      const closeEnd = close === -1 ? -1 : findTagEnd(html, close + name.length + 2);
      index = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    if (name === 'img' || name === 'object') {
      const attrs = attributes(raw.slice(match[0].length));
      const candidates = name === 'img'
        ? [attrs['data-fullres-src'], attrs.src]
        : [attrs.data];
      const id = candidates.map(graphResourceId).find((candidate): candidate is string => Boolean(candidate));
      if (id && !references.has(id)) {
        references.set(id, {
          id,
          kind: name === 'img' ? 'image' : 'attachment',
          mediaTypeHint: name === 'img'
            ? attrs['data-fullres-src-type'] ?? attrs['data-src-type']
            : attrs.type,
          fileName: name === 'object' ? attrs['data-attachment'] : undefined,
        });
      }
    }
    index = tagEnd + 1;
  }
  return [...references.values()];
}
