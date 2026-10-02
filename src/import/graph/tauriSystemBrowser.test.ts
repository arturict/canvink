import { describe, expect, it, vi } from 'vitest';
import { createTauriSystemBrowserCallbackBridge } from './tauriSystemBrowser';

const REDIRECT = 'http://127.0.0.1:49152/onenote/callback';

describe('Tauri OneNote system-browser bridge', () => {
  it('starts the bounded native authorize command only after a callback waiter exists', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'onenote_system_browser_authorize') return '?code=abc&state=expected';
      return undefined;
    });
    const bridge = createTauriSystemBrowserCallbackBridge(REDIRECT, invoke);
    const controller = new AbortController();
    await expect(bridge.openExternal(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      controller.signal,
    )).rejects.toThrow('listener was not prepared');

    const callback = bridge.waitForCallback(controller.signal);
    await bridge.openExternal(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      controller.signal,
    );
    await expect(callback).resolves.toBe('?code=abc&state=expected');
    expect(invoke).toHaveBeenCalledWith('onenote_system_browser_authorize', {
      request: expect.objectContaining({
        redirectUri: REDIRECT,
        timeoutMs: 180_000,
        operationId: expect.stringMatching(/^[a-f0-9]{48}$/),
      }),
    });
  });

  it('rejects non-loopback configuration and propagates cancellation to native code', async () => {
    expect(() => createTauriSystemBrowserCallbackBridge('https://app.example.test/callback', vi.fn()))
      .toThrow('loopback');
    let release: (() => void) | undefined;
    const invoke = vi.fn((command: string) => command === 'onenote_system_browser_authorize'
      ? new Promise<string>((resolve) => { release = () => resolve('?code=late&state=late'); })
      : Promise.resolve(undefined));
    const bridge = createTauriSystemBrowserCallbackBridge(REDIRECT, invoke);
    const controller = new AbortController();
    const callback = bridge.waitForCallback(controller.signal);
    const opening = bridge.openExternal(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      controller.signal,
    );
    controller.abort();
    await expect(callback).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith(
      'onenote_cancel_system_browser_authorization',
      expect.objectContaining({ operationId: expect.any(String) }),
    );
    release?.();
    await expect(opening).resolves.toBeUndefined();
  });
});
