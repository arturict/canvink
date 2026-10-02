/**
 * Pure helpers for the `/desktop-login` page (PERSONAL-SYNC.md §3.7). The
 * desktop app opens that page with its PKCE challenge and a `state` value;
 * the page hands the one-time code back through the `canvink://` scheme.
 */

export const DESKTOP_DEEP_LINK = 'canvink://auth';

/** Which native app opened the page; only the wording differs, the hand-off is the same. */
export type DesktopLoginPlatform = 'desktop' | 'android';

export interface DesktopLoginParams {
  challenge: string;
  state: string;
  platform: DesktopLoginPlatform;
}

/** An S256 challenge is 43 base64url characters; `state` is opaque to the page. */
export function parseDesktopLoginParams(search: string): DesktopLoginParams | null {
  const params = new URLSearchParams(search);
  const challenge = params.get('challenge') ?? '';
  const state = params.get('state') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
  // An unknown or missing value means the desktop app, which never sent one.
  const platform = params.get('platform') === 'android' ? 'android' : 'desktop';
  return { challenge, state, platform };
}

export function desktopDeepLink(code: string, state: string): string {
  const query = new URLSearchParams({ code, state });
  return `${DESKTOP_DEEP_LINK}?${query.toString()}`;
}
