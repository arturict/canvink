/**
 * Where the query's words sit in a result text, so the snippet can mark them.
 * Matching ignores case and accents the way the index does, one code unit for
 * one code unit, so a range found in the folded text is a range of the text.
 */
function foldUnit(unit: string): string {
  const folded = unit.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return folded.length === 1 ? folded : unit;
}

export function foldForMatch(text: string): string {
  let output = '';
  for (let index = 0; index < text.length; index += 1) output += foldUnit(text[index]);
  return output;
}

const OPERATOR_TERM = /^(tag|is):/iu;

/** The free words of a query: operators such as `tag:` and `is:` mark nothing. */
export function queryWords(query: string): string[] {
  return [...new Set(
    query.split(/\s+/u).filter((term) => term && !OPERATOR_TERM.test(term)).map(foldForMatch),
  )];
}

export function highlightRanges(text: string, query: string): Array<[number, number]> {
  const words = queryWords(query);
  if (words.length === 0 || !text) return [];
  const folded = foldForMatch(text);
  const ranges: Array<[number, number]> = [];
  for (const word of words) {
    for (let at = folded.indexOf(word); at !== -1; at = folded.indexOf(word, at + word.length)) {
      ranges.push([at, at + word.length]);
    }
  }
  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

export interface TextPart {
  text: string;
  match: boolean;
}

export function highlightParts(text: string, query: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const [start, end] of highlightRanges(text, query)) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}
