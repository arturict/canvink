import { describe, expect, it } from 'vitest';
import { encodeBase64Strict } from '../crdt/tauriStorageBridge';
import {
  DpapiBridgeError,
  WindowsDpapiBridge,
  type DpapiInvoke,
} from './dpapiBridge';

describe('WindowsDpapiBridge', () => {
  it('clones and wipes caller-owned plaintext before invoking DPAPI', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: DpapiInvoke = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args: structuredClone(args) });
      return { protectedBase64: encodeBase64Strict(Uint8Array.of(9, 8, 7)) } as T;
    };
    const material = Uint8Array.of(1, 2, 3, 4);

    const protectedBlob = await new WindowsDpapiBridge(invoke).protectKeyMaterial(material);

    expect(material).toEqual(Uint8Array.of(0, 0, 0, 0));
    expect(protectedBlob).toBe('CQgH');
    expect(calls).toEqual([{
      command: 'protect_key_material',
      args: { materialBase64: 'AQIDBA==' },
    }]);
  });

  it('returns a detached plaintext buffer from a strict native response', async () => {
    const invoke: DpapiInvoke = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      expect(command).toBe('unprotect_key_material');
      expect(args).toEqual({ protectedBase64: 'CQgH' });
      return { materialBase64: 'AQIDBA==' } as T;
    };

    const material = await new WindowsDpapiBridge(invoke).unprotectKeyMaterial('CQgH');

    expect(material).toEqual(Uint8Array.of(1, 2, 3, 4));
  });

  it('wipes plaintext and maps native details to an opaque typed error', async () => {
    const invoke: DpapiInvoke = async () => {
      throw { code: 'unprotectionFailed', message: 'Windows error 13 at secret path' };
    };
    const material = Uint8Array.of(5, 6, 7);

    const failure = await new WindowsDpapiBridge(invoke)
      .protectKeyMaterial(material)
      .catch((error: unknown) => error);

    expect(material).toEqual(Uint8Array.of(0, 0, 0));
    expect(failure).toBeInstanceOf(DpapiBridgeError);
    expect(failure).toMatchObject({ code: 'native-failure' });
    expect((failure as Error).message).not.toMatch(/Windows|secret path|13/i);
  });

  it('rejects malformed native responses and offers no non-Tauri fallback', async () => {
    const malformed = new WindowsDpapiBridge(async <T>() => ({
      protectedBase64: 'not base64',
    }) as T);
    const material = Uint8Array.of(1);
    await expect(malformed.protectKeyMaterial(material)).rejects.toMatchObject({
      code: 'invalid-response',
    });
    expect(material).toEqual(Uint8Array.of(0));

    const unavailableMaterial = Uint8Array.of(2, 3);
    await expect(
      new WindowsDpapiBridge().protectKeyMaterial(unavailableMaterial),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(unavailableMaterial).toEqual(Uint8Array.of(0, 0));
  });

  it('rejects empty, oversized, and non-canonical protected blobs before invoke', async () => {
    let invoked = false;
    const bridge = new WindowsDpapiBridge(async <T>() => {
      invoked = true;
      return undefined as T;
    });

    await expect(bridge.unprotectKeyMaterial('')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(bridge.unprotectKeyMaterial('AQI')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      bridge.protectKeyMaterial(new Uint8Array(1024 * 1024 + 1)),
    ).rejects.toMatchObject({ code: 'payload-too-large' });
    expect(invoked).toBe(false);
  });
});
