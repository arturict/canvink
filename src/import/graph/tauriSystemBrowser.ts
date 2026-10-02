import type { TauriSystemBrowserCallbackBridge } from './auth';

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const CALLBACK_TIMEOUT_MS = 180_000;

function validateLoopbackRedirect(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The packaged OneNote sign-in requires a valid loopback redirect URI.');
  }
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.port
    || url.pathname === '/'
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('The packaged OneNote sign-in requires an exact HTTP loopback URI with port and callback path.');
  }
  return url.href;
}

function operationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isTauriSystemBrowserAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

export function createTauriSystemBrowserCallbackBridge(
  redirectUri: string,
  injectedInvoke?: Invoke,
): TauriSystemBrowserCallbackBridge {
  const exactRedirectUri = validateLoopbackRedirect(redirectUri);
  let pending: {
    resolve(value: string): void;
    reject(reason: unknown): void;
    signal: AbortSignal;
    operationId: string;
    cleanup(): void;
  } | undefined;

  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (injectedInvoke) return injectedInvoke(command, args) as Promise<T>;
    const tauri = await import('@tauri-apps/api/core');
    return tauri.invoke<T>(command, args);
  };

  return {
    waitForCallback(signal) {
      if (pending) return Promise.reject(new Error('A OneNote system-browser callback is already pending.'));
      if (signal.aborted) return Promise.reject(new DOMException('The OneNote authorization was cancelled.', 'AbortError'));
      return new Promise<string>((resolve, reject) => {
        const id = operationId();
        const onAbort = () => {
          void invoke('onenote_cancel_system_browser_authorization', { operationId: id });
          pending?.cleanup();
          pending = undefined;
          reject(new DOMException('The OneNote authorization was cancelled.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending = {
          resolve,
          reject,
          signal,
          operationId: id,
          cleanup: () => signal.removeEventListener('abort', onAbort),
        };
      });
    },
    async openExternal(url, signal) {
      if (signal.aborted) {
        throw new DOMException('The OneNote authorization was cancelled.', 'AbortError');
      }
      const parsed = new URL(url);
      if (/\/oauth2\/v2\.0\/logout$/i.test(parsed.pathname)) {
        await invoke('onenote_open_system_browser_logout', { logoutUrl: url });
        return;
      }
      const active = pending;
      if (!active || active.signal !== signal) {
        throw new Error('The OneNote callback listener was not prepared before browser launch.');
      }
      try {
        const callback = await invoke<string>('onenote_system_browser_authorize', {
          request: {
            operationId: active.operationId,
            authorizationUrl: url,
            redirectUri: exactRedirectUri,
            timeoutMs: CALLBACK_TIMEOUT_MS,
          },
        });
        if (pending === active) {
          active.cleanup();
          pending = undefined;
          active.resolve(callback);
        }
      } catch (cause) {
        if (pending === active) {
          active.cleanup();
          pending = undefined;
          active.reject(cause);
        }
        throw cause;
      }
    },
  };
}
