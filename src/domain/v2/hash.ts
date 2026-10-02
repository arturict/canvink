import type { Sha256Checksum } from './types';

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-256 is unavailable in this runtime. Migration was not started.');
  }
  return globalThis.crypto;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<Sha256Checksum> {
  const input = new Uint8Array(bytes).buffer;
  const digest = await cryptoApi().subtle.digest('SHA-256', input);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha256:${hex}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Value is not JSON serializable.');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value instanceof Uint8Array) {
    return canonicalJson(Array.from(value));
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Whether two values have the same canonical JSON (key order and `undefined` members do not
 * matter), compared structurally. Comparing two records of hundreds of documents this way
 * allocates nothing, where building both strings is a visible part of a commit.
 */
export function sameCanonicalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  // `canonicalJson` writes bytes as an array of numbers, so bytes equal an array of the same numbers.
  const leftList = left instanceof Uint8Array || Array.isArray(left) ? (left as ArrayLike<unknown>) : undefined;
  const rightList = right instanceof Uint8Array || Array.isArray(right) ? (right as ArrayLike<unknown>) : undefined;
  if (leftList || rightList) {
    if (!leftList || !rightList || leftList.length !== rightList.length) return false;
    for (let index = 0; index < leftList.length; index += 1) {
      if (!sameCanonicalJson(leftList[index], rightList[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => sameCanonicalJson(leftRecord[key], rightRecord[key]));
}

export async function sha256Canonical(value: unknown): Promise<Sha256Checksum> {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(value)));
}
