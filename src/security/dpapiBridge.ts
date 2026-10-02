import { decodeBase64Strict, encodeBase64Strict } from '../crdt/tauriStorageBridge';

const MAX_KEY_MATERIAL_BYTES = 1024 * 1024;

export type DpapiInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export type DpapiBridgeErrorCode =
  | 'unavailable'
  | 'invalid-input'
  | 'payload-too-large'
  | 'native-failure'
  | 'invalid-response';

export class DpapiBridgeError extends Error {
  constructor(public readonly code: DpapiBridgeErrorCode, message: string) {
    super(message);
    this.name = 'DpapiBridgeError';
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

async function defaultInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

function validateSecretInput(material: Uint8Array): Uint8Array {
  if (!(material instanceof Uint8Array) || material.byteLength === 0) {
    throw new DpapiBridgeError('invalid-input', 'Key material must be a non-empty byte array.');
  }
  if (material.byteLength > MAX_KEY_MATERIAL_BYTES) {
    wipe(material);
    throw new DpapiBridgeError('payload-too-large', 'Key material exceeds the size limit.');
  }
  const working = Uint8Array.from(material);
  // protectKeyMaterial consumes the caller-owned secret by contract.
  wipe(material);
  return working;
}

function strictResponse(
  value: unknown,
  field: 'protectedBase64' | 'materialBase64',
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DpapiBridgeError('invalid-response', 'Native key protection returned an invalid response.');
  }
  const keys = Object.keys(value);
  const encoded = (value as Record<string, unknown>)[field];
  if (keys.length !== 1 || keys[0] !== field || typeof encoded !== 'string' || encoded.length === 0) {
    throw new DpapiBridgeError('invalid-response', 'Native key protection returned an invalid response.');
  }
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Strict(encoded, MAX_KEY_MATERIAL_BYTES);
  } catch {
    throw new DpapiBridgeError('invalid-response', 'Native key protection returned an invalid response.');
  }
  if (decoded.byteLength === 0) {
    throw new DpapiBridgeError('invalid-response', 'Native key protection returned an invalid response.');
  }
  wipe(decoded);
  return encoded;
}

function nativeCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

function opaqueNativeError(error: unknown): DpapiBridgeError {
  switch (nativeCode(error)) {
    case 'invalidInput':
      return new DpapiBridgeError('invalid-input', 'Key material is empty or malformed.');
    case 'payloadTooLarge':
      return new DpapiBridgeError('payload-too-large', 'Key material exceeds the size limit.');
    case 'unsupportedPlatform':
      return new DpapiBridgeError('unavailable', 'Operating-system key protection is unavailable.');
    default:
      return new DpapiBridgeError('native-failure', 'Operating-system key protection failed.');
  }
}

export class WindowsDpapiBridge {
  private readonly invoke: DpapiInvoke;
  private readonly injected: boolean;

  constructor(invoke?: DpapiInvoke) {
    this.invoke = invoke ?? defaultInvoke;
    this.injected = invoke !== undefined;
  }

  /** Consumes and zeroes `material` on every path. Persist only the returned opaque blob. */
  async protectKeyMaterial(material: Uint8Array): Promise<string> {
    const working = validateSecretInput(material);
    try {
      if (!this.injected && !isTauriRuntime()) {
        throw new DpapiBridgeError(
          'unavailable',
          'DPAPI key protection is available only in the desktop app.',
        );
      }
      let response: unknown;
      try {
        response = await this.invoke('protect_key_material', {
          materialBase64: encodeBase64Strict(working),
        });
      } catch (error) {
        if (error instanceof DpapiBridgeError) throw error;
        throw opaqueNativeError(error);
      }
      return strictResponse(response, 'protectedBase64');
    } finally {
      wipe(working);
    }
  }

  /** Returns a detached plaintext buffer; the caller must zero it after importing the key. */
  async unprotectKeyMaterial(protectedBase64: string): Promise<Uint8Array> {
    if (!this.injected && !isTauriRuntime()) {
      throw new DpapiBridgeError(
        'unavailable',
        'DPAPI key protection is available only in the desktop app.',
      );
    }
    let protectedBytes: Uint8Array;
    try {
      protectedBytes = decodeBase64Strict(protectedBase64, MAX_KEY_MATERIAL_BYTES);
    } catch {
      throw new DpapiBridgeError('invalid-input', 'Protected key material is malformed.');
    }
    if (protectedBytes.byteLength === 0) {
      throw new DpapiBridgeError('invalid-input', 'Protected key material is empty.');
    }
    wipe(protectedBytes);
    let response: unknown;
    try {
      response = await this.invoke('unprotect_key_material', { protectedBase64 });
    } catch (error) {
      throw opaqueNativeError(error);
    }
    const encoded = strictResponse(response, 'materialBase64');
    const intermediate = decodeBase64Strict(encoded, MAX_KEY_MATERIAL_BYTES);
    try {
      return Uint8Array.from(intermediate);
    } finally {
      wipe(intermediate);
    }
  }
}
