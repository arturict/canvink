import { SYNC_PROTOCOL_VERSION, type SyncEnvelope } from '../../../src/sync/types';

export const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0),
);

export function imageWithDimensions(width: number, height: number): Uint8Array {
  const bytes = TINY_PNG.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, crc32(bytes.subarray(12, 29)));
  return bytes;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

export function polyglotPng(): Uint8Array {
  const suffix = new TextEncoder().encode('<script>window.__CANVINK_XSS__=true</script>');
  const bytes = new Uint8Array(TINY_PNG.byteLength + suffix.byteLength);
  bytes.set(TINY_PNG);
  bytes.set(suffix, TINY_PNG.byteLength);
  return bytes;
}

export function pdfBombLike(): Uint8Array {
  return new TextEncoder().encode(
    '%PDF-1.7\n1 0 obj<</Length 4294967295/Filter/FlateDecode>>stream\nx\x9c\x03\x00\nendstream\nendobj\n%%EOF\n',
  );
}

export function syncPacket(sequence: number, marker = sequence): SyncEnvelope {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    notebookId: 'notebook-security',
    documentId: 'document-security',
    deviceId: 'device-security',
    keyEpoch: 1,
    sequence,
    changeHash: new Uint8Array(32).fill(marker),
    nonce: new Uint8Array(24).fill(marker),
    ciphertext: new Uint8Array([marker, marker + 1]),
    signature: new Uint8Array(64).fill(marker),
  };
}
