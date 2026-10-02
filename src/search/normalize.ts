import { normalizePageTag } from '../domain/pageTags';
import { SEARCH_LIMITS } from './types';

const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:[.'’_-][\p{L}\p{N}]+)*|[\p{Sm}]/gu;
const COMBINING_MARKS = /\p{M}+/gu;
const WHITESPACE = /\s+/u;

export class SearchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchLimitError';
  }
}

export class CorruptSearchIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptSearchIndexError';
  }
}

/** UTF-8 byte length without encoding: text is measured for every field of every record and every token. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3; // a lone surrogate is encoded as U+FFFD
  }
  return bytes;
}

export function boundedText(value: string, label: string): string {
  if (utf8Length(value) > SEARCH_LIMITS.fieldUtf8Bytes) {
    throw new SearchLimitError(`${label} exceeds ${SEARCH_LIMITS.fieldUtf8Bytes} UTF-8 bytes.`);
  }
  return value;
}

/**
 * Joins the texts read from a page's printouts (one per PDF page or
 * recognised image) into one field. A page with hundreds of printouts holds
 * more text than a field may, and rejecting it would leave the whole page
 * without a record. Texts identical to an earlier one are left out. Beyond
 * half the field bound only words no earlier text has are kept, so every word
 * stays searchable and the field stays bounded. A single text larger than the
 * bound is still rejected.
 */
export function joinExtractedText(parts: readonly string[], label: string): string {
  const unique = [...new Set(parts)];
  for (const part of unique) boundedText(part, label);
  const joined = unique.join('\n');
  const limit = SEARCH_LIMITS.fieldUtf8Bytes;
  if (utf8Length(joined) <= limit) return joined;

  const wholeBudget = limit / 2;
  const head: string[] = [];
  const known = new Set<string>();
  let used = 0;
  let next = 0;
  for (; next < unique.length; next += 1) {
    const size = utf8Length(unique[next]) + 1;
    if (used + size > wholeBudget) break;
    head.push(unique[next]);
    used += size;
    for (const word of unique[next].split(WHITESPACE)) known.add(word);
  }
  // Words are compared as written: splitting is several times cheaper than
  // tokenizing a megabyte of text, and a word that differs only in case or
  // punctuation costs a few bytes.
  const words: string[] = [];
  for (; next < unique.length && used < limit; next += 1) {
    for (const word of unique[next].split(WHITESPACE)) {
      if (!word || known.has(word)) continue;
      known.add(word);
      used += utf8Length(word) + 1;
      if (used > limit) break;
      words.push(word);
    }
  }
  return [...head, words.join(' ')].filter(Boolean).join('\n');
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) > 0x7f) return false;
  return true;
}

/** Folds a token that is already normalized: no accents, `ß` as `ss`. */
function foldNormalized(normalized: string): string {
  // ASCII has no marks and no `ß`, and most tokens are ASCII.
  if (isAscii(normalized)) return normalized;
  return normalized.normalize('NFKD').replace(COMBINING_MARKS, '').replaceAll('ß', 'ss');
}

export function foldSearchToken(value: string): string {
  return foldNormalized(normalizeSearchText(value));
}

export function tokenizeSearchText(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of normalized.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (utf8Length(token) > SEARCH_LIMITS.tokenLength) continue;
    for (const candidate of [token, foldNormalized(token)]) {
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        tokens.push(candidate);
      }
    }
  }
  return tokens;
}

export function parseSearchQuery(value: string): string[] {
  if (utf8Length(value) > SEARCH_LIMITS.queryUtf8Bytes) {
    throw new SearchLimitError(`Search query exceeds ${SEARCH_LIMITS.queryUtf8Bytes} UTF-8 bytes.`);
  }
  const tokens = tokenizeSearchText(value);
  if (tokens.length > SEARCH_LIMITS.queryTokens) {
    throw new SearchLimitError(`Search query exceeds ${SEARCH_LIMITS.queryTokens} normalized tokens.`);
  }
  return tokens;
}

export type SearchTaskState = 'open' | 'done';

/**
 * A query split into free text and the bounded `tag:`/`is:` operators. Terms
 * that look like an operator but carry an unknown value stay free text, so a
 * typo narrows nothing silently instead of returning an empty page list.
 */
export interface SearchQueryExpression {
  tokens: string[];
  tags: string[];
  taskStates: SearchTaskState[];
}

const OPERATOR_TERM = /^(tag|is):(.*)$/u;
const MAX_QUERY_TAGS = 8;

export function isEmptySearchQueryExpression(expression: SearchQueryExpression): boolean {
  return expression.tokens.length === 0
    && expression.tags.length === 0
    && expression.taskStates.length === 0;
}

export function parseSearchQueryExpression(value: string): SearchQueryExpression {
  if (utf8Length(value) > SEARCH_LIMITS.queryUtf8Bytes) {
    throw new SearchLimitError(`Search query exceeds ${SEARCH_LIMITS.queryUtf8Bytes} UTF-8 bytes.`);
  }
  const tags: string[] = [];
  const taskStates = new Set<SearchTaskState>();
  const freeTerms: string[] = [];
  for (const term of value.normalize('NFKC').split(/\s+/u)) {
    if (!term) continue;
    const operator = OPERATOR_TERM.exec(term.toLowerCase());
    if (!operator) {
      freeTerms.push(term);
      continue;
    }
    const [, name, rawValue] = operator;
    if (name === 'tag') {
      const tag = normalizePageTag(rawValue);
      if (!tag) {
        freeTerms.push(term);
        continue;
      }
      if (!tags.includes(tag)) {
        if (tags.length === MAX_QUERY_TAGS) {
          throw new SearchLimitError(`Search query exceeds ${MAX_QUERY_TAGS} tag filters.`);
        }
        tags.push(tag);
      }
      continue;
    }
    if (rawValue === 'open' || rawValue === 'done') taskStates.add(rawValue);
    else if (rawValue === 'task') { taskStates.add('open'); taskStates.add('done'); }
    else freeTerms.push(term);
  }
  const tokens = tokenizeSearchText(freeTerms.join(' '));
  if (tokens.length > SEARCH_LIMITS.queryTokens) {
    throw new SearchLimitError(`Search query exceeds ${SEARCH_LIMITS.queryTokens} normalized tokens.`);
  }
  return { tokens, tags, taskStates: [...taskStates] };
}

