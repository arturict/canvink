/**
 * Fractional indexing for the personal-space workspace doc (see
 * services/collab-sync/PERSONAL-SYNC.md §4.3, §5.4, §6.2).
 *
 * `SpaceNotebookEntry.order` is a plain string that sorts correctly with
 * ordinary lexicographic (`<`) string comparison. A reorder rewrites exactly
 * one scalar under Automerge, which is a last-writer-wins register: safe under
 * concurrent edits, unlike an Automerge list (which can duplicate or drop
 * entries under concurrent inserts). `keyBetween` produces a fresh key that
 * sorts strictly between two existing keys (or before the first / after the
 * last, or as the very first key when there are none yet).
 *
 * Pure, no I/O, no randomness. Each key is a base62 "integer part" (whose
 * first character encodes its own length, so integer parts of different
 * magnitudes still compare correctly) optionally followed by a "fractional
 * part" used to subdivide space between two keys that share the same integer
 * part.
 */

const BASE62_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SMALLEST_INTEGER = "A00000000000000000000000000";
const INTEGER_ZERO = "a0";

function digitValue(digit: string): number {
  const value = BASE62_DIGITS.indexOf(digit);
  if (value < 0) throw new Error(`Invalid fractional-order digit: ${JSON.stringify(digit)}.`);
  return value;
}

/** Length of the integer part implied by its first character (Figma/Rocicorp scheme):
 * 'a'..'z' encode increasing positive lengths, 'A'..'Z' encode increasing negative lengths. */
function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`Invalid fractional-order key head: ${JSON.stringify(head)}.`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0] ?? "");
  if (length > key.length) throw new Error(`Invalid fractional-order key: ${JSON.stringify(key)}.`);
  return key.slice(0, length);
}

function validateKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`Invalid fractional-order key: ${JSON.stringify(key)}.`);
  const head = integerPart(key);
  const fraction = key.slice(head.length);
  if (fraction.endsWith("0")) throw new Error(`Invalid fractional-order key (trailing zero): ${JSON.stringify(key)}.`);
}

function validateIntegerPart(part: string): void {
  if (part.length !== integerLength(part[0] ?? "")) {
    throw new Error(`Invalid fractional-order integer part: ${JSON.stringify(part)}.`);
  }
}

/** One step up the integer-part ladder, or `null` at the maximum representable value. */
function incrementInteger(value: string): string | null {
  validateIntegerPart(value);
  const head = value[0];
  const digits = value.slice(1).split("");
  let carry = true;
  for (let index = digits.length - 1; carry && index >= 0; index -= 1) {
    const next = digitValue(digits[index]) + 1;
    if (next === BASE62_DIGITS.length) {
      digits[index] = "0";
    } else {
      digits[index] = BASE62_DIGITS[next];
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return "a0";
  if (head === "z") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > "a") digits.push("0");
  else digits.pop();
  return nextHead + digits.join("");
}

/** One step down the integer-part ladder, or `null` at the minimum representable value. */
function decrementInteger(value: string): string | null {
  validateIntegerPart(value);
  const head = value[0];
  const digits = value.slice(1).split("");
  let borrow = true;
  for (let index = digits.length - 1; borrow && index >= 0; index -= 1) {
    const next = digitValue(digits[index]) - 1;
    if (next === -1) {
      digits[index] = BASE62_DIGITS[BASE62_DIGITS.length - 1];
    } else {
      digits[index] = BASE62_DIGITS[next];
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return `Z${digits.join("")}${BASE62_DIGITS[BASE62_DIGITS.length - 1]}`;
  if (head === "A") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (nextHead < "Z") digits.push(BASE62_DIGITS[BASE62_DIGITS.length - 1]);
  else digits.pop();
  return nextHead + digits.join("");
}

/** A fractional-part midpoint strictly between `a` and `b` (`b` may be absent, meaning "no upper bound"). */
function fractionMidpoint(a: string, b: string | undefined): string {
  if (b !== undefined && a >= b) throw new Error(`fractionMidpoint requires a < b (got ${JSON.stringify(a)}, ${JSON.stringify(b)}).`);
  if (a.endsWith("0") || (b !== undefined && b.endsWith("0"))) {
    throw new Error("fractionMidpoint operands must not carry a trailing zero.");
  }
  if (b !== undefined) {
    let sharedLength = 0;
    while ((a[sharedLength] ?? "0") === b[sharedLength]) sharedLength += 1;
    if (sharedLength > 0) {
      return b.slice(0, sharedLength) + fractionMidpoint(a.slice(sharedLength), b.slice(sharedLength));
    }
  }
  const lowDigit = a.length > 0 ? digitValue(a[0]) : 0;
  const highDigit = b !== undefined ? digitValue(b[0]) : BASE62_DIGITS.length;
  if (highDigit - lowDigit > 1) {
    const midDigit = Math.round((lowDigit + highDigit) / 2);
    return BASE62_DIGITS[midDigit];
  }
  if (b !== undefined && b.length > 1) return b.slice(0, 1);
  return BASE62_DIGITS[lowDigit] + fractionMidpoint(a.slice(1), undefined);
}

/**
 * Produces a key that sorts strictly between `a` and `b` under plain string
 * comparison. Omit `a` for "before the first entry", omit `b` for "after the
 * last entry", omit both for the very first key ever generated (`"a0"`).
 *
 * Throws if `a` and `b` are not already correctly ordered (`a >= b`), or if
 * either is not a well-formed key produced by this module.
 */
export function keyBetween(a?: string, b?: string): string {
  if (a !== undefined) validateKey(a);
  if (b !== undefined) validateKey(b);
  if (a !== undefined && b !== undefined && a >= b) {
    throw new Error(`keyBetween requires a < b (got ${JSON.stringify(a)}, ${JSON.stringify(b)}).`);
  }

  if (a === undefined && b === undefined) return INTEGER_ZERO;

  if (a === undefined) {
    const headInteger = integerPart(b as string);
    const fraction = (b as string).slice(headInteger.length);
    if (headInteger === SMALLEST_INTEGER) return headInteger + fractionMidpoint("", fraction);
    if (headInteger < (b as string)) return headInteger;
    const decremented = decrementInteger(headInteger);
    if (decremented === null) throw new Error("Cannot generate a key before the smallest representable key.");
    return decremented;
  }

  if (b === undefined) {
    const headInteger = integerPart(a);
    const fraction = a.slice(headInteger.length);
    const incremented = incrementInteger(headInteger);
    return incremented === null ? headInteger + fractionMidpoint(fraction, undefined) : incremented;
  }

  const lowInteger = integerPart(a);
  const lowFraction = a.slice(lowInteger.length);
  const highInteger = integerPart(b);
  const highFraction = b.slice(highInteger.length);
  if (lowInteger === highInteger) return lowInteger + fractionMidpoint(lowFraction, highFraction);
  const incremented = incrementInteger(lowInteger);
  if (incremented === null) throw new Error("Cannot generate a key: the lower key is already at the maximum integer part.");
  if (incremented < b) return incremented;
  return lowInteger + fractionMidpoint(lowFraction, undefined);
}

/** Sorts `SpaceNotebookEntry`-shaped order keys ascending, tie-broken by id, per §4.3. */
export function compareOrderedEntries(
  a: { order: string; documentId: string },
  b: { order: string; documentId: string },
): number {
  if (a.order < b.order) return -1;
  if (a.order > b.order) return 1;
  if (a.documentId < b.documentId) return -1;
  if (a.documentId > b.documentId) return 1;
  return 0;
}
