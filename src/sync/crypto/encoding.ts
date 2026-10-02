import { CryptoProtocolError } from './types';

const encoder = new TextEncoder();
const MAX_FIELD_BYTES = 64 * 1024 * 1024 + 1024;

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new CryptoProtocolError('invalid-input', 'Canonical field length is invalid.');
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

export function canonicalInteger(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CryptoProtocolError('invalid-input', 'Canonical integer must be non-negative.');
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

export function canonicalText(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new CryptoProtocolError('invalid-input', 'Canonical text field is invalid.');
  }
  return encoder.encode(value);
}

/** Domain-separated, named, length-prefixed binary encoding. */
export function canonicalEncode(
  domain: string,
  fields: readonly (readonly [name: string, value: Uint8Array])[],
): Uint8Array {
  const domainBytes = canonicalText(domain);
  const seen = new Set<string>();
  const encoded = fields.map(([name, value]) => {
    if (seen.has(name)) throw new CryptoProtocolError('invalid-input', 'Canonical field repeats.');
    seen.add(name);
    const nameBytes = canonicalText(name);
    if (!(value instanceof Uint8Array) || value.byteLength > MAX_FIELD_BYTES) {
      throw new CryptoProtocolError('limit-exceeded', 'Canonical field exceeds its byte limit.');
    }
    return [u32(nameBytes.length), nameBytes, u32(value.length), value] as const;
  });
  const total =
    4 + domainBytes.length + 4 +
    encoded.reduce((sum, parts) => sum + parts.reduce((partSum, part) => partSum + part.length, 0), 0);
  const output = new Uint8Array(total);
  let offset = 0;
  const append = (part: Uint8Array): void => {
    output.set(part, offset);
    offset += part.length;
  };
  append(u32(domainBytes.length));
  append(domainBytes);
  append(u32(encoded.length));
  for (const parts of encoded) for (const part of parts) append(part);
  return output;
}

export function recipientFields(recipient: {
  kind: string;
  deviceId?: string;
  accountId?: string;
  recoveryKeyId?: string;
}): Array<readonly [string, Uint8Array]> {
  const identifier = recipient.deviceId ?? recipient.accountId ?? recipient.recoveryKeyId;
  if (!identifier) throw new CryptoProtocolError('invalid-input', 'Recipient identifier is missing.');
  return [
    ['recipientKind', canonicalText(recipient.kind)],
    ['recipientId', canonicalText(identifier)],
  ];
}
