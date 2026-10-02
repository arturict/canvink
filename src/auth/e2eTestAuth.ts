/**
 * e2e-only auth seam for the personal-space and sharing Playwright suites
 * (PERSONAL-SYNC.md §9 Wave 5, task 5): "two browser contexts share one test
 * identity by injecting the same `test:<sub>:<hmac>` token through the auth
 * seam." `ClerkGate` provides it app-wide, so a join-link editor and the
 * presence identity use it too; `?__canvinkTestName=` sets a display name.
 *
 * It synthesizes an `OptionalAuthValue` locally, gated on a build-time secret
 * (`VITE_PERSONAL_SPACE_TEST_AUTH_SECRET`, baked in only for the e2e app
 * build) plus a runtime-only `sub`, read from the URL so two page loads with
 * the same query string share one identity and a third with a different
 * value is a different identity (V8). Absent the build-time secret, this
 * dead-code-eliminates to nothing — the same shape as
 * `VITE_CANVINK_ALLOW_FEATURE_OVERRIDE` (`src/config/featureFlags.ts`).
 *
 * The token format and its HMAC mirror the Worker's test shim exactly
 * (`services/collab-sync/src/auth/clerk.ts` `verifyTestShim` /
 * `hmacSha256Base64Url`), so a token this module mints is accepted by a
 * `wrangler dev` instance configured with the same `TEST_AUTH_SECRET`.
 */

import type { OptionalAuthValue } from './AuthContext';
import { createE2EAccountApi } from './e2eTestAccount';

const QUERY_PARAM = '__canvinkSpaceTestSub';
const NAME_PARAM = '__canvinkTestName';
/** `?__canvinkTestEmail=a@x.test,b@x.test`: the verified addresses of the test identity (invitations match them). */
const EMAIL_PARAM = '__canvinkTestEmail';
/** `?__canvinkTestSignedOut=1`: auth is available but nobody is signed in (the signed-out account UI). */
const SIGNED_OUT_PARAM = '__canvinkTestSignedOut';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256Base64Url(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function buildTestToken(sub: string, secret: string, emails: readonly string[], name: string | null): Promise<string> {
  if (emails.length === 0) {
    const mac = await hmacSha256Base64Url(sub, secret);
    return `test:${sub}:${mac}`;
  }
  // The Worker's `testv2:` shim carries verified addresses; the MAC covers the whole payload.
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ sub, emails, ...(name ? { name } : {}) })));
  return `testv2:${payload}:${await hmacSha256Base64Url(payload, secret)}`;
}

export interface E2ETestAuthOptions {
  /** Test/integrator seam; defaults to `import.meta.env.VITE_PERSONAL_SPACE_TEST_AUTH_SECRET`. */
  secret?: string;
  /** Test/integrator seam; defaults to reading `?__canvinkSpaceTestSub=` from `search`. */
  search?: string;
}

/**
 * Returns a synthetic `OptionalAuthValue` for the e2e test-auth seam, or
 * `undefined` when it does not apply (no secret configured, or no `sub` in
 * the URL) — the caller falls back to the real `useOptionalAuth()` in that
 * case.
 */
export function resolveE2ETestAuth(options: E2ETestAuthOptions = {}): OptionalAuthValue | undefined {
  const secret = options.secret ?? (import.meta.env.VITE_PERSONAL_SPACE_TEST_AUTH_SECRET as string | undefined);
  if (!secret) return undefined;
  const search = options.search ?? window.location.search;
  const params = new URLSearchParams(search);
  if (params.get(SIGNED_OUT_PARAM) === '1') {
    return { available: true, isSignedIn: false, user: null, getToken: async () => null, openSignIn: () => undefined };
  }
  const sub = params.get(QUERY_PARAM);
  if (!sub) return undefined;
  const fullName = params.get(NAME_PARAM);
  const emails = (params.get(EMAIL_PARAM) ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

  return {
    available: true,
    isSignedIn: true,
    user: { id: sub, primaryEmailAddress: emails[0] ?? null, fullName: fullName || null, imageUrl: null },
    getToken: () => buildTestToken(sub, secret, emails, fullName),
    openSignIn: () => undefined,
    ...(emails[0] ? { account: createE2EAccountApi(fullName, emails[0]) } : {}),
  };
}
