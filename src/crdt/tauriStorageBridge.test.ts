import { runStorageAdapterTests } from '@automerge/automerge-repo/helpers/tests/storage-adapter-tests.js';
import { describe, expect, it } from 'vitest';
import { CanvinkStorageAdapter, type CanvinkStorageMutation } from './canvinkStorageAdapter';
import {
  decodeBase64Strict,
  encodeBase64Strict,
  TauriCanvinkStorageBridge,
  TauriStorageAtomicityError,
  TauriStorageBridgeError,
  type TauriStorageInvoke,
} from './tauriStorageBridge';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function keysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function hasPrefix(key: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= key.length && prefix.every((segment, index) => key[index] === segment);
}

interface FakeRecord {
  key: string[];
  data: Uint8Array;
}

class FakeNativeRepo {
  readonly calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  readonly records: FakeRecord[] = [];
  failNextCommand?: string;
  malformedRange?: unknown;

  readonly invoke: TauriStorageInvoke = async (command, args = {}) => {
    this.calls.push({ command, args: structuredClone(args) });
    if (this.failNextCommand === command) {
      this.failNextCommand = undefined;
      throw { code: 'SQLITE_BUSY', message: 'simulated native transaction failure' };
    }
    const key = Array.isArray(args.key) ? [...args.key] as string[] : undefined;
    const prefix = Array.isArray(args.prefix) ? [...args.prefix] as string[] : undefined;
    switch (command) {
      case 'v2_repo_load': {
        const record = this.records.find((candidate) => keysEqual(candidate.key, key ?? []));
        return record ? encodeBase64Strict(record.data) : null;
      }
      case 'v2_repo_save': {
        if (!key || !Array.isArray(args.data)) throw new Error('invalid fake save input');
        const data = new Uint8Array(args.data as number[]);
        const existing = this.records.findIndex((candidate) => keysEqual(candidate.key, key));
        const record = { key, data };
        if (existing >= 0) this.records[existing] = record;
        else this.records.push(record);
        return null;
      }
      case 'v2_repo_remove': {
        const existing = this.records.findIndex((candidate) => keysEqual(candidate.key, key ?? []));
        if (existing < 0) return false;
        this.records.splice(existing, 1);
        return true;
      }
      case 'v2_repo_load_range':
        if (this.malformedRange !== undefined) return this.malformedRange;
        return this.records
          .filter((record) => hasPrefix(record.key, prefix ?? []))
          .map((record) => ({
            key: [...record.key],
            data: encodeBase64Strict(record.data),
          }));
      case 'v2_repo_remove_range': {
        const before = this.records.length;
        const kept = this.records.filter((record) => !hasPrefix(record.key, prefix ?? []));
        this.records.splice(0, this.records.length, ...kept);
        return before - kept.length;
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };
}

runStorageAdapterTests(
  async () => {
    const native = new FakeNativeRepo();
    return {
      adapter: new CanvinkStorageAdapter({
        bridge: new TauriCanvinkStorageBridge({ invoke: native.invoke }),
      }),
    };
  },
  'TauriCanvinkStorageBridge',
);

describe('TauriCanvinkStorageBridge', () => {
  it('round-trips canonical Base64 and rejects permissive variants', () => {
    const source = bytes(0, 1, 2, 127, 128, 254, 255);
    const encoded = encodeBase64Strict(source);

    expect(decodeBase64Strict(encoded)).toEqual(source);
    expect(decodeBase64Strict('')).toEqual(bytes());
    expect(() => decodeBase64Strict(`${encoded}\n`)).toThrow('canonical Base64');
    expect(() => decodeBase64Strict('Zh==')).toThrow('canonical Base64');
    expect(() => decodeBase64Strict('abcd-', 10)).toThrow('canonical Base64');
    expect(() => decodeBase64Strict(encoded, source.length - 1)).toThrow('byte limit');
  });

  it('keeps delimiter-containing hierarchical keys distinct and clones returned bytes', async () => {
    const native = new FakeNativeRepo();
    const adapter = new CanvinkStorageAdapter({
      namespace: ['repo'],
      bridge: new TauriCanvinkStorageBridge({ invoke: native.invoke }),
    });
    await adapter.save(['course/math', 'page'], bytes(1));
    await adapter.save(['course', 'math/page'], bytes(2));
    await adapter.save(['course', 'math', 'page'], bytes(3));

    const first = await adapter.load(['course/math', 'page']);
    first![0] = 99;
    await expect(adapter.load(['course/math', 'page'])).resolves.toEqual(bytes(1));
    await expect(adapter.load(['course', 'math/page'])).resolves.toEqual(bytes(2));
    await expect(adapter.load(['course', 'math', 'page'])).resolves.toEqual(bytes(3));
    await expect(adapter.loadRange(['course'])).resolves.toHaveLength(2);
  });

  it('uses the Rust Vec<u8> command shape while applying strict binary normalization', async () => {
    const native = new FakeNativeRepo();
    const bridge = new TauriCanvinkStorageBridge({ invoke: native.invoke });
    const source = bytes(7, 8, 9);
    const pending = bridge.commit([{ type: 'save', key: ['repo', 'key'], data: source }]);
    source[0] = 99;
    await pending;

    const save = native.calls.find((call) => call.command === 'v2_repo_save');
    expect(save?.args).toEqual({ key: ['repo', 'key'], data: [7, 8, 9] });
    await expect(bridge.load(['repo', 'key'])).resolves.toEqual(bytes(7, 8, 9));
  });

  it('rejects malformed, duplicate, out-of-prefix, and oversized native ranges', async () => {
    const native = new FakeNativeRepo();
    const bridge = new TauriCanvinkStorageBridge({ invoke: native.invoke });
    const limits = { maxEntries: 2, maxBytes: 4 };
    const invalidRanges: Array<[unknown, string]> = [
      [{ key: ['doc'], data: 'AQ==', extra: true }, 'invalid shape'],
      [[{ key: ['other'], data: 'AQ==' }], 'outside the requested prefix'],
      [
        [
          { key: ['doc', 'a'], data: 'AQ==' },
          { key: ['doc', 'a'], data: 'Ag==' },
        ],
        'duplicate range key',
      ],
      [[{ key: ['doc', 'a'], data: 'not base64' }], 'canonical Base64'],
      [
        [
          { key: ['doc', 'a'], data: 'AQ==' },
          { key: ['doc', 'b'], data: 'Ag==' },
          { key: ['doc', 'c'], data: 'Aw==' },
        ],
        'entry limit',
      ],
    ];

    for (const [range, message] of invalidRanges) {
      native.malformedRange = Array.isArray(range) ? range : [range];
      await expect(bridge.loadRange(['doc'], limits)).rejects.toThrow(message);
    }
  });

  it('refuses a multi-mutation commit before making any IPC call', () => {
    const native = new FakeNativeRepo();
    const bridge = new TauriCanvinkStorageBridge({ invoke: native.invoke });
    const mutations: CanvinkStorageMutation[] = [
      { type: 'save', key: ['repo', 'a'], data: bytes(1) },
      { type: 'save', key: ['assets', 'hash'], data: bytes(2) },
    ];

    expect(() => bridge.commit(mutations)).toThrow(TauriStorageAtomicityError);
    expect(native.calls).toEqual([]);
    expect(native.records).toEqual([]);
  });

  it('maps a single-command failure without publishing a partial value', async () => {
    const native = new FakeNativeRepo();
    native.records.push({ key: ['repo', 'existing'], data: bytes(9) });
    native.failNextCommand = 'v2_repo_save';
    const bridge = new TauriCanvinkStorageBridge({ invoke: native.invoke });

    const failure = bridge.commit([
      { type: 'save', key: ['repo', 'new'], data: bytes(1) },
    ]);
    await expect(failure).rejects.toMatchObject({
      name: 'TauriStorageBridgeError',
      operation: 'save',
      command: 'v2_repo_save',
      nativeCode: 'SQLITE_BUSY',
    } satisfies Partial<TauriStorageBridgeError>);
    expect(native.records).toEqual([{ key: ['repo', 'existing'], data: bytes(9) }]);
  });

  it('preflights range limits and preserves records when native removal fails', async () => {
    const native = new FakeNativeRepo();
    native.records.push(
      { key: ['repo', 'doc', 'a'], data: bytes(1) },
      { key: ['repo', 'doc', 'b'], data: bytes(2) },
    );
    native.failNextCommand = 'v2_repo_remove_range';
    const bridge = new TauriCanvinkStorageBridge({ invoke: native.invoke });

    await expect(
      bridge.removeRange(['repo', 'doc'], { maxEntries: 2, maxBytes: 2 }),
    ).rejects.toBeInstanceOf(TauriStorageBridgeError);
    expect(native.calls.map((call) => call.command)).toEqual([
      'v2_repo_load_range',
      'v2_repo_remove_range',
    ]);
    expect(native.records).toHaveLength(2);
  });

  it('rejects construction outside Tauri unless invoke is explicitly injected', () => {
    expect(() => new TauriCanvinkStorageBridge()).toThrow(/only in the desktop runtime/i);
    expect(
      () => new TauriCanvinkStorageBridge({ invoke: async () => null }),
    ).not.toThrow();
  });
});
