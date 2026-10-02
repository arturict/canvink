import { describe, expect, it } from 'vitest';
import { ProtectedNotebookKeyring } from './keyringPersistence';

describe('protected notebook keyring persistence', () => {
  it('reopens current and historical epochs after a protected desktop-style restart', async () => {
    const protectedValues = new Map<string, Uint8Array>();
    const store = {
      load: async (id: string) => protectedValues.get(id)?.map((byte) => byte ^ 0xa5),
      save: async (id: string, value: Uint8Array) => {
        const protectedCopy = value.map((byte) => byte ^ 0xa5);
        protectedValues.set(id, protectedCopy);
        value.fill(0);
      },
      clear: (id: string) => { protectedValues.delete(id); },
    };
    const first = await ProtectedNotebookKeyring.create('notebook', store);
    const epochOne = first.keyForEpoch(1);
    const epochTwo = await first.rotate();
    expect(first.currentEpoch).toBe(2);

    const reopened = await ProtectedNotebookKeyring.load('notebook', store);
    expect(reopened?.currentEpoch).toBe(2);
    expect(reopened?.keyForEpoch(1)).toEqual(epochOne);
    expect(reopened?.keyForEpoch(2)).toEqual(epochTwo);
  });
});
