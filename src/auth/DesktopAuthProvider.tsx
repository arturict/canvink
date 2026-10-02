import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthStatusContext, UNAVAILABLE_AUTH, type OptionalAuthValue } from './AuthContext';

/**
 * Account sign-in for the Tauri desktop app (PERSONAL-SYNC.md §3.7). Clerk is
 * never loaded here: "Anmelden" opens canvink.example.com/desktop-login in the
 * default browser, and the Rust side (src-tauri/src/desktop_auth.rs) receives
 * the `canvink://auth` answer, holds the refresh token and hands out
 * short-lived device access tokens. The rest of the app sees the same
 * `OptionalAuthValue` it gets from Clerk on the web.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

export interface DesktopAuthStatus {
  configured: boolean;
  signedIn: boolean;
  user: { id: string; name?: string; picture?: string } | null;
  pending: boolean;
  error: 'failed' | 'expired' | 'browserFailed' | null;
}

export const DESKTOP_AUTH_CHANGED_EVENT = 'desktop-auth://changed';

export interface DesktopAuthBridge {
  invoke: Invoke;
  listen: Listen;
}

async function tauriBridge(): Promise<DesktopAuthBridge> {
  const [core, event] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  return { invoke: core.invoke, listen: event.listen };
}

/** Pure: the auth value the app sees for a desktop sign-in status. */
export function desktopAuthValue(status: DesktopAuthStatus | null, bridge: DesktopAuthBridge | null): OptionalAuthValue {
  if (!status?.configured || !bridge) return UNAVAILABLE_AUTH;
  const start = () => {
    void bridge.invoke('desktop_login_start').catch(() => undefined);
  };
  return {
    available: true,
    isSignedIn: status.signedIn,
    user: status.user
      ? {
        id: status.user.id,
        primaryEmailAddress: null,
        fullName: status.user.name ?? null,
        imageUrl: status.user.picture ?? null,
      }
      : null,
    // Signed out resolves to null; no network throws, so callers retry.
    getToken: async () => {
      const token = await bridge.invoke<{ token: string; expiresAt: number } | null>('desktop_access_token');
      return token?.token ?? null;
    },
    openSignIn: start,
    signOut: () => bridge.invoke<void>('desktop_logout'),
    desktop: {
      pending: status.pending,
      error: status.error,
      reopenBrowser: start,
      submitCode: async (code: string) => {
        try {
          await bridge.invoke('desktop_login_submit', { input: code });
          return true;
        } catch {
          return false;
        }
      },
      cancel: () => {
        void bridge.invoke('desktop_login_cancel').catch(() => undefined);
      },
      recheck: () => {
        void bridge.invoke('desktop_access_token', { force: true }).catch(() => undefined);
      },
    },
  };
}

export interface DesktopAuthProviderProps {
  children: ReactNode;
  /** Test seam; defaults to the Tauri IPC. */
  bridge?: DesktopAuthBridge;
}

export default function DesktopAuthProvider({ children, bridge: injected }: DesktopAuthProviderProps) {
  const [bridge, setBridge] = useState<DesktopAuthBridge | null>(injected ?? null);
  const [status, setStatus] = useState<DesktopAuthStatus | null>(null);

  useEffect(() => {
    if (injected) return undefined;
    let cancelled = false;
    void tauriBridge().then((loaded) => {
      if (!cancelled) setBridge(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [injected]);

  useEffect(() => {
    if (!bridge) return undefined;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void bridge.listen<DesktopAuthStatus>(DESKTOP_AUTH_CHANGED_EVENT, (event) => setStatus(event.payload))
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      });
    void bridge.invoke<DesktopAuthStatus>('desktop_auth_status').then((current) => {
      if (!cancelled) setStatus(current);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [bridge]);

  const value = useMemo(() => desktopAuthValue(status, bridge), [status, bridge]);
  return <AuthStatusContext.Provider value={value}>{children}</AuthStatusContext.Provider>;
}
