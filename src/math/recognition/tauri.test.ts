import { describe, expect, it, vi } from 'vitest';
import {
  BrowserUnavailableRecognitionProvider,
  TauriMathProviderConfiguration,
  TauriRecognitionProvider,
  type MathRecognitionInvoke,
} from './tauri';
import type { ExplicitMathRecognitionSelection } from './types';

function selection(provider: 'compatible' | 'mathpix' = 'compatible'): ExplicitMathRecognitionSelection {
  return {
    kind: 'explicitMathSelection', trigger: 'explicitUserSelection', userInitiated: true,
    operationId: 'operation_1234567890', requestId: 'request_1234567890', provider,
    bounds: { x: 40, y: 70, width: 100, height: 50 },
    strokes: [{ points: [{ x: 40, y: 70 }, { x: 140, y: 120 }] }],
    locale: 'de-CH', settings: { angleMode: 'degree', decimalSeparator: 'comma' },
  };
}

describe('Tauri recognition boundary', () => {
  it('passes only a normalized explicit selection and validates response binding', async () => {
    let captured: Record<string, unknown> | undefined;
    const invoke: MathRecognitionInvoke = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      expect(command).toBe('math_recognize');
      captured = structuredClone(args);
      const request = args?.request as Record<string, unknown>;
      return {
        protocolVersion: 1,
        provider: 'compatible',
        requestId: request.requestId,
        revisionSha256: request.revisionSha256,
        latex: 'x^2', candidates: [], warnings: [], modelVersion: 'fixture', apiVersion: 'v1',
      } as T;
    };
    const result = await TauriRecognitionProvider.compatible(invoke).recognize(selection());
    expect(result.latex).toBe('x^2');
    expect(JSON.stringify(captured)).not.toMatch(/notebook|page|element|endpoint|token/i);
    expect((captured?.request as { strokes: Array<{ points: Array<{ x: number; y: number }> }> })
      .strokes[0].points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('never invokes when aborted or when provider and selection differ', async () => {
    const invoke = vi.fn(async <T>(): Promise<T> => undefined as T) as MathRecognitionInvoke;
    const controller = new AbortController();
    controller.abort();
    await expect(TauriRecognitionProvider.compatible(invoke).recognize(selection(), {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'aborted' });
    await expect(TauriRecognitionProvider.mathpix(invoke).recognize(selection()))
      .rejects.toMatchObject({ code: 'invalid-input' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cancels an in-flight native request exactly once and keeps the binding isolated', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let rejectRecognition: ((reason: unknown) => void) | undefined;
    const invoke: MathRecognitionInvoke = <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args: structuredClone(args) });
      if (command === 'math_recognition_cancel') {
        rejectRecognition?.({ code: 'aborted' });
        return Promise.resolve(true as T);
      }
      return new Promise<T>((_resolve, reject) => { rejectRecognition = reject; });
    };
    const controller = new AbortController();
    const pending = TauriRecognitionProvider.compatible(invoke).recognize(selection(), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(calls.map(({ command }) => command)).toEqual(['math_recognize', 'math_recognition_cancel']);
    const recognizeRequest = calls[0].args?.request as Record<string, unknown>;
    expect(calls[1].args).toEqual({
      request: {
        requestId: recognizeRequest.requestId,
        revisionSha256: recognizeRequest.revisionSha256,
      },
    });
  });

  it('removes cancellation after completion so a later abort is a no-op', async () => {
    const calls: string[] = [];
    const invoke: MathRecognitionInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      const request = args?.request as Record<string, unknown>;
      return {
        protocolVersion: 1, provider: 'compatible', requestId: request.requestId,
        revisionSha256: request.revisionSha256, latex: 'x', candidates: [], warnings: [],
      } as T;
    };
    const controller = new AbortController();
    await TauriRecognitionProvider.compatible(invoke).recognize(selection(), { signal: controller.signal });
    controller.abort();
    await Promise.resolve();
    expect(calls).toEqual(['math_recognize']);
  });

  it('consumes credential byte arrays and native status never returns credentials or endpoint', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: MathRecognitionInvoke = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ command, args: structuredClone(args) });
      return { provider: 'compatible', configured: true, networkScope: 'private', updatedAt: '2026-08-03T12:00:00.000Z' } as T;
    };
    const token = new TextEncoder().encode('secret-provider-token');
    const status = await new TauriMathProviderConfiguration(invoke).configureCompatible({
      endpoint: 'https://gpu.tailnet.ts.net/v1/math/recognize',
      networkScope: 'private', allowInsecurePrivateHttp: false, bearerToken: token,
    });
    expect(token.every((byte) => byte === 0)).toBe(true);
    expect(status).toEqual({
      provider: 'compatible', configured: true, networkScope: 'private', updatedAt: '2026-08-03T12:00:00.000Z',
    });
    expect(JSON.stringify(status)).not.toMatch(/secret|endpoint|token|gpu/i);
    expect(calls).toHaveLength(1);
  });

  it('maps native details to opaque errors and web provider is hard unavailable', async () => {
    const failing: MathRecognitionInvoke = async () => {
      throw { code: 'network-error', message: 'https://private-host token=leak', retryable: true };
    };
    const error = await TauriRecognitionProvider.compatible(failing).recognize(selection())
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'network-error', retryable: true });
    expect((error as Error).message).not.toMatch(/private-host|token|https/i);

    const browser = new BrowserUnavailableRecognitionProvider('mathpix');
    await expect(browser.recognize()).rejects.toMatchObject({ code: 'provider-unavailable' });
    await expect(browser.status()).resolves.toEqual({
      provider: 'mathpix', configured: false, networkScope: 'public',
    });
  });
});
