/**
 * Reads the heads of a complete Automerge save without loading the document.
 *
 * `Automerge.load` builds the whole JavaScript object tree of a document; for
 * a page with tens of thousands of strokes that costs far more than the room
 * session needs, which only has to know which heads it holds. The heads sit at
 * a fixed place in a document chunk, right after the actor list
 * (automerge storage format: magic, checksum, chunk type 0, length, actors,
 * heads, ...). Anything else, such as a change chunk or a save with trailing
 * chunks, returns `undefined` and the caller loads the document instead.
 */

import * as Automerge from '@automerge/automerge';

const MAGIC = [0x85, 0x6f, 0x4a, 0x83];
const DOCUMENT_CHUNK_TYPE = 0;
const HASH_BYTES = 32;

function readUleb(bytes: Uint8Array, start: number): { value: number; next: number } | undefined {
  let value = 0;
  let multiplier = 1;
  let position = start;
  for (let i = 0; i < 5; i += 1) {
    const byte = bytes[position];
    if (byte === undefined) return undefined;
    position += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: position };
    multiplier *= 128;
  }
  return undefined;
}

function toHex(bytes: Uint8Array, start: number): string {
  let hex = '';
  for (let i = 0; i < HASH_BYTES; i += 1) hex += (bytes[start + i] as number).toString(16).padStart(2, '0');
  return hex;
}

export function readSavedDocumentHeads(bytes: Uint8Array): string[] | undefined {
  if (bytes.byteLength < 10) return undefined;
  for (let i = 0; i < MAGIC.length; i += 1) if (bytes[i] !== MAGIC[i]) return undefined;
  if (bytes[8] !== DOCUMENT_CHUNK_TYPE) return undefined;
  const length = readUleb(bytes, 9);
  if (!length) return undefined;
  // A save with anything after the document chunk needs a real load to know its heads.
  if (length.next + length.value !== bytes.byteLength) return undefined;
  const actors = readUleb(bytes, length.next);
  if (!actors) return undefined;
  let position = actors.next;
  for (let i = 0; i < actors.value; i += 1) {
    const actorLength = readUleb(bytes, position);
    if (!actorLength) return undefined;
    position = actorLength.next + actorLength.value;
  }
  const headCount = readUleb(bytes, position);
  if (!headCount) return undefined;
  position = headCount.next;
  if (position + headCount.value * HASH_BYTES > bytes.byteLength) return undefined;
  const heads: string[] = [];
  for (let i = 0; i < headCount.value; i += 1) heads.push(toHex(bytes, position + i * HASH_BYTES));
  return heads;
}

/**
 * Whether `bytes` is a sequence of change chunks (what an append or `saveSince` produces): every
 * chunk starts with the Automerge magic, is not a document chunk and ends inside the bytes. Only the
 * framing is checked, so unlike `advanceHeads` this reads no operation; a chunk whose content is
 * damaged passes and fails where the changes are applied.
 */
export function isChangeSequence(bytes: Uint8Array): boolean {
  let position = 0;
  let chunks = 0;
  while (position < bytes.byteLength) {
    if (position + 10 > bytes.byteLength) return false;
    for (let i = 0; i < MAGIC.length; i += 1) if (bytes[position + i] !== MAGIC[i]) return false;
    if (bytes[position + 8] === DOCUMENT_CHUNK_TYPE) return false;
    const length = readUleb(bytes, position + 9);
    if (!length) return false;
    const end = length.next + length.value;
    if (end > bytes.byteLength) return false;
    position = end;
    chunks += 1;
  }
  return chunks > 0;
}

/**
 * The heads after `bytes` (a sequence of change chunks, as an append or
 * `saveSince` produces) were added to a document that had `heads`, worked out
 * from the changes' own hashes and dependencies without a document. Returns
 * `undefined` for anything else (a document chunk, garbage), and the caller
 * falls back to loading.
 */
export function advanceHeads(heads: readonly string[], bytes: Uint8Array): string[] | undefined {
  const current = new Set(heads);
  let position = 0;
  let chunks = 0;
  while (position < bytes.byteLength) {
    if (position + 10 > bytes.byteLength) return undefined;
    for (let i = 0; i < MAGIC.length; i += 1) if (bytes[position + i] !== MAGIC[i]) return undefined;
    if (bytes[position + 8] === DOCUMENT_CHUNK_TYPE) return undefined;
    const length = readUleb(bytes, position + 9);
    if (!length) return undefined;
    const end = length.next + length.value;
    if (end > bytes.byteLength) return undefined;
    let change: Automerge.DecodedChange;
    try {
      change = Automerge.decodeChange(bytes.subarray(position, end));
    } catch {
      return undefined;
    }
    for (const dependency of change.deps) current.delete(dependency);
    current.add(change.hash);
    position = end;
    chunks += 1;
  }
  return chunks === 0 ? undefined : [...current];
}
