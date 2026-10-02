import { canonicalJson } from '../../domain/v2';
import { sharedMathEngine, type LocalMathEngine } from '../engine';

export interface ScrubbableNumberLiteral {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly source: string;
  readonly value: number;
  readonly role: 'number' | 'exponent' | 'percent';
}

export interface ScrubbableNumberSet {
  readonly sourceFingerprint: string;
  readonly literals: readonly ScrubbableNumberLiteral[];
}

export interface NumberScrubReplacement {
  readonly latex: string;
  readonly target: ScrubbableNumberLiteral;
  readonly sourceFingerprint: string;
}

export interface NumberScrubRequest {
  readonly targetId: string;
  readonly sourceFingerprint: string;
  readonly value: number;
}

const NUMBER_PATTERN = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g;
const MAX_SCRUBBABLE_LITERALS = 128;
const MAX_SCRUB_ABSOLUTE_VALUE = 1_000_000_000;

export function listScrubbableNumbers(
  latex: string,
  engine: LocalMathEngine = sharedMathEngine(),
): ScrubbableNumberSet {
  engine.inspect(latex);
  if (latex.length > engine.limits.maxLatexLength) throw new Error('Formula exceeds the scrubber input limit.');
  const literals: ScrubbableNumberLiteral[] = [];
  for (const match of latex.matchAll(NUMBER_PATTERN)) {
    if (match.index === undefined) continue;
    let start = match.index;
    const end = start + match[0].length;
    const preceding = latex[start - 1];
    const following = latex[end];
    if (isIdentifierCharacter(preceding) || isIdentifierCharacter(following)) continue;
    if (preceding === '-' && isUnaryMinus(latex, start - 1)) start -= 1;
    const source = latex.slice(start, end);
    const value = Number(source);
    if (!Number.isFinite(value)) throw new Error('Formula contains a non-finite numeric literal.');
    const role = literalRole(latex, start, end);
    const literal: ScrubbableNumberLiteral = Object.freeze({
      id: `number:${start}:${end}:${role}:${stableTextHash(source)}`,
      start,
      end,
      source,
      value,
      role,
    });
    literals.push(literal);
    if (literals.length > MAX_SCRUBBABLE_LITERALS) throw new Error('Formula contains too many numeric literals.');
  }
  return Object.freeze({
    sourceFingerprint: stableSourceFingerprint(latex),
    literals: Object.freeze(literals),
  });
}

export function replaceScrubbableNumber(
  latex: string,
  request: NumberScrubRequest,
  engine: LocalMathEngine = sharedMathEngine(),
): NumberScrubReplacement {
  if (!request.targetId) throw new Error('An explicit scrubber target ID is required.');
  if (!request.sourceFingerprint) throw new Error('The scrubber source fingerprint is required.');
  if (!Number.isFinite(request.value) || Math.abs(request.value) > MAX_SCRUB_ABSOLUTE_VALUE) {
    throw new Error('Scrubber value must be finite and within the released bound.');
  }
  const listing = listScrubbableNumbers(latex, engine);
  if (listing.sourceFingerprint !== request.sourceFingerprint) {
    throw new Error('Scrubber source changed after preview; commit was rejected.');
  }
  const target = listing.literals.find((literal) => literal.id === request.targetId);
  if (!target) throw new Error('Scrubber target is stale or does not belong to this formula.');
  if (target.role === 'exponent' && (!Number.isInteger(request.value)
    || Math.abs(request.value) > engine.limits.maxLiteralExponent)) {
    throw new Error(`Exponent scrubber values must be bounded integers within ${engine.limits.maxLiteralExponent}.`);
  }
  const replacement = formatReplacement(latex, target, request.value);
  const nextLatex = `${latex.slice(0, target.start)}${replacement}${latex.slice(target.end)}`;
  engine.inspect(nextLatex);
  return {
    latex: nextLatex,
    target,
    sourceFingerprint: stableSourceFingerprint(nextLatex),
  };
}

function literalRole(latex: string, start: number, end: number): ScrubbableNumberLiteral['role'] {
  if (/^\s*\\%/.test(latex.slice(end))) return 'percent';
  let cursor = start - 1;
  while (cursor >= 0 && /\s/.test(latex[cursor])) cursor -= 1;
  if (latex[cursor] === '-') {
    cursor -= 1;
    while (cursor >= 0 && /\s/.test(latex[cursor])) cursor -= 1;
  }
  if (latex[cursor] === '^') return 'exponent';
  if (latex[cursor] === '{') {
    cursor -= 1;
    while (cursor >= 0 && /\s/.test(latex[cursor])) cursor -= 1;
    if (latex[cursor] === '^') return 'exponent';
  }
  return 'number';
}

function isUnaryMinus(latex: string, minusIndex: number): boolean {
  let cursor = minusIndex - 1;
  while (cursor >= 0 && /\s/.test(latex[cursor])) cursor -= 1;
  return cursor < 0 || '=+-*/^(,{['.includes(latex[cursor]);
}

function formatReplacement(
  latex: string,
  target: ScrubbableNumberLiteral,
  value: number,
): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  const text = String(normalized);
  if (!text.startsWith('-') || target.source.startsWith('-')) return text;
  if (target.role === 'exponent') {
    const before = latex.slice(0, target.start).trimEnd();
    return before.endsWith('{') ? text : `{${text}}`;
  }
  let cursor = target.start - 1;
  while (cursor >= 0 && /\s/.test(latex[cursor])) cursor -= 1;
  return cursor < 0 || '=({[,'.includes(latex[cursor]) ? text : `(${text})`;
}

function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z_]/.test(value);
}

function stableSourceFingerprint(latex: string): string {
  // Stable non-security fingerprint for stale-target detection. Security and
  // persistence hashes continue to use SHA-256 elsewhere.
  const source = canonicalJson({ version: 1, latex });
  return `scrub-v1:${stableTextHash(source)}`;
}

function stableTextHash(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
