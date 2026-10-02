import type {
  CanvinkStorageBridge,
  CanvinkStorageMutation,
  CanvinkStorageRecord,
  CanvinkStorageScanLimits,
} from './canvinkStorageAdapter';

const MAX_KEY_SEGMENTS = 32;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_SEGMENT_BYTES = 4 * 1024;
const MAX_DATA_BYTES = 32 * 1024 * 1024;
const MAX_RANGE_ENTRIES = 10_000;
const MAX_RANGE_BYTES = 128 * 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_CHUNK_BYTES = 24 * 1024;
const encoder = new TextEncoder();

export const TAURI_STAGE_MIGRATION_COMMAND = 'v2_stage_migration' as const;

export type TauriStorageInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface TauriStorageBridgeOptions {
  /** Tests and alternate native shells can inject the same narrow command transport. */
  invoke?: TauriStorageInvoke;
}

export class TauriStorageBridgeError extends Error {
  constructor(
    public readonly operation: string,
    public readonly command: string,
    message: string,
    options?: ErrorOptions & { nativeCode?: string },
  ) {
    super(message, options);
    this.name = 'TauriStorageBridgeError';
    this.nativeCode = options?.nativeCode;
  }

  readonly nativeCode?: string;
}

export class TauriStorageAtomicityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TauriStorageAtomicityError';
  }
}

export function isTauriStorageRuntime(): boolean {
  const tauriWindow = typeof window === 'undefined'
    ? undefined
    : window as Window & { __TAURI_INTERNALS__?: unknown };
  return (
    tauriWindow !== undefined &&
    typeof tauriWindow.__TAURI_INTERNALS__ !== 'undefined'
  );
}

function assertBinary(value: Uint8Array, label: string, maxBytes = MAX_DATA_BYTES): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} must be a Uint8Array.`);
  if (value.byteLength > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
  return Uint8Array.from(value);
}

function controlFree(value: string): boolean {
  return !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function validateKey(
  value: unknown,
  label: string,
  allowEmpty: boolean,
): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array of strings.`);
  }
  if (value.length > MAX_KEY_SEGMENTS) throw new Error(`${label} has too many segments.`);
  let keyBytes = 0;
  return value.map((segment, index) => {
    if (typeof segment !== 'string' || segment.length === 0 || !controlFree(segment)) {
      throw new Error(`${label} segment ${index + 1} is empty or contains control characters.`);
    }
    const segmentBytes = encoder.encode(segment).byteLength;
    if (segmentBytes > MAX_SEGMENT_BYTES) {
      throw new Error(`${label} segment ${index + 1} exceeds the byte limit.`);
    }
    keyBytes += segmentBytes;
    if (keyBytes > MAX_KEY_BYTES) throw new Error(`${label} exceeds the byte limit.`);
    return segment;
  });
}

function hasPrefix(key: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= key.length && prefix.every((segment, index) => key[index] === segment);
}

function keysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function validateScanLimits(limits: CanvinkStorageScanLimits): CanvinkStorageScanLimits {
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries < 1 ||
    limits.maxEntries > MAX_RANGE_ENTRIES ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1 ||
    limits.maxBytes > MAX_RANGE_BYTES
  ) {
    throw new Error('Tauri range limits exceed the native storage contract.');
  }
  return { maxEntries: limits.maxEntries, maxBytes: limits.maxBytes };
}

export function encodeBase64Strict(value: Uint8Array): string {
  const bytes = assertBinary(value, 'Base64 input');
  if (typeof globalThis.btoa !== 'function') {
    throw new Error('This runtime does not provide a Base64 encoder.');
  }
  let result = '';
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    let binary = '';
    for (const byte of chunk) binary += String.fromCharCode(byte);
    result += globalThis.btoa(binary);
  }
  return result;
}

export function decodeBase64Strict(
  value: string,
  maxBytes = MAX_DATA_BYTES,
): Uint8Array {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    throw new Error('Native binary response is not canonical Base64.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('Base64 byte limit must be a non-negative safe integer.');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const byteLength = (value.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(byteLength) || byteLength > maxBytes) {
    throw new Error('Native binary response exceeds the byte limit.');
  }
  if (typeof globalThis.atob !== 'function') {
    throw new Error('This runtime does not provide a Base64 decoder.');
  }
  let decoded: string;
  try {
    decoded = globalThis.atob(value);
  } catch (error) {
    throw new Error('Native binary response is not valid Base64.', { cause: error });
  }
  if (decoded.length !== byteLength) throw new Error('Native Base64 length is inconsistent.');
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  if (encodeBase64Strict(bytes) !== value) {
    throw new Error('Native binary response is not canonical Base64.');
  }
  return bytes;
}

function decodeNativeBytes(value: unknown, label: string, maxBytes: number): Uint8Array {
  if (typeof value === 'string') return decodeBase64Strict(value, maxBytes);
  if (value instanceof Uint8Array) {
    const bytes = assertBinary(value, label, maxBytes);
    return decodeBase64Strict(encodeBase64Strict(bytes), maxBytes);
  }
  if (value instanceof ArrayBuffer) {
    const bytes = assertBinary(new Uint8Array(value), label, maxBytes);
    return decodeBase64Strict(encodeBase64Strict(bytes), maxBytes);
  }
  if (Array.isArray(value)) {
    if (value.length > maxBytes) throw new Error(`${label} exceeds the byte limit.`);
    const bytes = new Uint8Array(value.length);
    value.forEach((byte, index) => {
      if (!Number.isSafeInteger(byte) || byte < 0 || byte > 255) {
        throw new Error(`${label} contains an invalid byte at index ${index}.`);
      }
      bytes[index] = byte;
    });
    return decodeBase64Strict(encodeBase64Strict(bytes), maxBytes);
  }
  throw new Error(`${label} is not a supported native binary value.`);
}

function ipcByteArray(value: Uint8Array): number[] {
  // Rust commands accept Vec<u8>. Canonical Base64 round-tripping prevents
  // accidental sparse/non-byte arrays while retaining the command's actual shape.
  return Array.from(decodeBase64Strict(encodeBase64Strict(value)));
}

function nativeErrorDetails(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) return { message: error.message };
  if (typeof error === 'string') return { message: error };
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : 'Native command failed.';
    const code = typeof record.code === 'string' ? record.code : undefined;
    return { message, code };
  }
  return { message: 'Native command failed.' };
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (fields.length !== 2 || fields[0] !== 'data' || fields[1] !== 'key') {
    throw new Error(`${label} has an invalid shape.`);
  }
  return record;
}

async function defaultInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<unknown>(command, args);
}

/** Native SQLite bridge for the narrow schema-v2 Repo commands. */
export class TauriCanvinkStorageBridge implements CanvinkStorageBridge {
  private readonly invoke: TauriStorageInvoke;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: TauriStorageBridgeOptions = {}) {
    if (!options.invoke && !isTauriStorageRuntime()) {
      throw new Error('Tauri Repo storage is available only in the desktop runtime.');
    }
    this.invoke = options.invoke ?? defaultInvoke;
  }

  async load(key: readonly string[]): Promise<Uint8Array | undefined> {
    const safeKey = validateKey(key, 'Tauri Repo key', false);
    const value = await this.call('load', 'v2_repo_load', { key: safeKey });
    if (value === null || value === undefined) return undefined;
    return decodeNativeBytes(value, 'Tauri Repo value', MAX_DATA_BYTES);
  }

  async loadRange(
    keyPrefix: readonly string[],
    requestedLimits: CanvinkStorageScanLimits,
  ): Promise<CanvinkStorageRecord[]> {
    const prefix = validateKey(keyPrefix, 'Tauri Repo prefix', true);
    const limits = validateScanLimits(requestedLimits);
    const value = await this.call('loadRange', 'v2_repo_load_range', { prefix });
    if (!Array.isArray(value)) throw new Error('Tauri Repo range response must be an array.');
    if (value.length > limits.maxEntries) throw new Error('Tauri Repo range exceeds the entry limit.');
    const seen: string[][] = [];
    let totalBytes = 0;
    return value.map((entry, index) => {
      const record = strictRecord(entry, `Tauri Repo range entry ${index + 1}`);
      const key = validateKey(record.key, `Tauri Repo range key ${index + 1}`, false);
      if (!hasPrefix(key, prefix)) throw new Error('Tauri Repo returned a key outside the requested prefix.');
      if (seen.some((candidate) => keysEqual(candidate, key))) {
        throw new Error('Tauri Repo returned a duplicate range key.');
      }
      seen.push(key);
      const data = decodeNativeBytes(
        record.data,
        `Tauri Repo range value ${index + 1}`,
        Math.min(MAX_DATA_BYTES, limits.maxBytes),
      );
      totalBytes += data.byteLength;
      if (totalBytes > limits.maxBytes) throw new Error('Tauri Repo range exceeds the byte limit.');
      return { key, data };
    });
  }

  commit(mutations: readonly CanvinkStorageMutation[]): Promise<void> {
    if (mutations.length === 0) return Promise.resolve();
    if (mutations.length > 1) {
      throw new TauriStorageAtomicityError(
        `Native Repo IPC has no generic atomic batch command; ${mutations.length} mutations were not sent. Use ${TAURI_STAGE_MIGRATION_COMMAND} for migration staging.`,
      );
    }
    const mutation = mutations[0];
    const key = validateKey(mutation.key, 'Tauri Repo mutation key', false);
    if (mutation.type === 'save') {
      const data = assertBinary(mutation.data, 'Tauri Repo mutation value');
      return this.enqueue(async () => {
        const result = await this.call('save', 'v2_repo_save', {
          key,
          data: ipcByteArray(data),
        });
        if (result !== null && result !== undefined) {
          throw new Error('Tauri Repo save returned an unexpected value.');
        }
      });
    }
    return this.enqueue(async () => {
      const result = await this.call('remove', 'v2_repo_remove', { key });
      if (typeof result !== 'boolean') throw new Error('Tauri Repo remove response must be boolean.');
    });
  }

  removeRange(
    keyPrefix: readonly string[],
    requestedLimits: CanvinkStorageScanLimits,
  ): Promise<void> {
    const prefix = validateKey(keyPrefix, 'Tauri Repo prefix', true);
    const limits = validateScanLimits(requestedLimits);
    return this.enqueue(async () => {
      // Preflight honors adapter limits that may be lower than Rust's fixed limits.
      const before = await this.loadRange(prefix, limits);
      const result = await this.call('removeRange', 'v2_repo_remove_range', { prefix });
      if (!Number.isSafeInteger(result) || (result as number) < 0) {
        throw new Error('Tauri Repo remove-range response must be a non-negative safe integer.');
      }
      if ((result as number) > before.length) {
        throw new Error('Tauri Repo range changed concurrently during bounded removal.');
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async call(
    operation: string,
    command: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.invoke(command, args);
    } catch (error) {
      if (error instanceof TauriStorageBridgeError) throw error;
      const details = nativeErrorDetails(error);
      throw new TauriStorageBridgeError(
        operation,
        command,
        `Native Repo ${operation} failed: ${details.message}`,
        { cause: error, nativeCode: details.code },
      );
    }
  }
}
