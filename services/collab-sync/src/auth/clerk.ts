// RS256 Clerk JWT verification via WebCrypto against a cached JWKS, plus the
// TEST_AUTH_SECRET HMAC shim used by tests and local dev (PROTOCOL.md ##Clerk
// verification).
import { base64UrlToBytes, constantTimeEqual, hmacSha256Base64Url } from "../util/crypto";

export interface AuthEnv {
  CLERK_ISSUER?: string;
  CLERK_JWKS_URL?: string;
  TEST_AUTH_SECRET?: string;
  /** D5: optional comma-separated allow-list checked against the JWT's `azp` claim. */
  CLERK_AUTHORIZED_PARTIES?: string;
}

export interface VerifiedIdentity {
  sub: string;
  /** Unix seconds. Required (PERSONAL-SYNC.md §3.2) for the personal-space auth
   * expiry gate; every JWT already carries a mandatory `exp` (see the D5/punch-list
   * check below), and the test shim synthesizes one. */
  exp: number;
  /** Display name and picture from the Clerk session token, when the Clerk
   * instance adds them as `name` and `picture` claims. Presence uses them so
   * a signed-in collaborator cannot pose as someone else. */
  name?: string;
  picture?: string;
  /** Verified e-mail addresses the token itself vouches for: the `emails` claim, or `email` with
   * `email_verified: true`, when the Clerk instance adds them to the session token. The full list
   * (secondary addresses too) comes from the Clerk Backend API, see `auth/emails.ts`. */
  emails?: string[];
}

/** Reads the optional e-mail claims, dropping anything malformed or unverified. */
export function emailsFromClaims(claims: Record<string, unknown>): string[] {
  const found: string[] = [];
  if (Array.isArray(claims.emails)) {
    for (const entry of claims.emails) if (typeof entry === "string") found.push(entry);
  }
  if (typeof claims.email === "string" && claims.email_verified === true) found.push(claims.email);
  return found;
}

/** Reads the optional profile claims, dropping anything malformed. */
export function profileFromClaims(claims: Record<string, unknown>): Pick<VerifiedIdentity, "name" | "picture"> {
  const name = typeof claims.name === "string" ? claims.name.trim().slice(0, 80) : "";
  const picture = typeof claims.picture === "string"
    && claims.picture.length <= 1000
    && claims.picture.startsWith("https://")
    ? claims.picture
    : "";
  return { ...(name ? { name } : {}), ...(picture ? { picture } : {}) };
}

interface JwksCacheEntry {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // 1h, per PROTOCOL.md

// Module-level cache: one Worker isolate handles many requests/DO calls, and
// refetching JWKS per request would be wasteful and slow. Keyed by JWKS URL
// so multiple Clerk instances (e.g. across tests) don't collide.
const jwksCache = new Map<string, JwksCacheEntry>();

function jwksUrlFor(env: AuthEnv): string {
  if (env.CLERK_JWKS_URL) return env.CLERK_JWKS_URL;
  if (env.CLERK_ISSUER) return `${env.CLERK_ISSUER}/.well-known/jwks.json`;
  throw new Error("Clerk not configured: set CLERK_ISSUER or CLERK_JWKS_URL");
}

/** JsonWebKey plus the `kid` field the DOM lib type omits (RFC 7517 §4.5). */
type JwkWithKid = JsonWebKey & { kid?: string };

async function importRsaKey(jwk: JwkWithKid): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function fetchJwks(url: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: JwkWithKid[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (!jwk.kid) continue;
    keys.set(jwk.kid, await importRsaKey(jwk));
  }
  return keys;
}

async function getKey(env: AuthEnv, kid: string): Promise<CryptoKey | undefined> {
  const url = jwksUrlFor(env);
  const cached = jwksCache.get(url);
  const fresh = cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS;

  if (fresh && cached.keys.has(kid)) return cached.keys.get(kid);

  // Either no cache, expired cache, or unknown kid: refetch once.
  const keys = await fetchJwks(url);
  jwksCache.set(url, { keys, fetchedAt: Date.now() });
  return keys.get(kid);
}

function b64urlJsonParse<T>(segment: string): T {
  const bytes = base64UrlToBytes(segment);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

interface ClerkClaims {
  iss?: string;
  sub?: string;
  exp?: number;
  nbf?: number;
  [key: string]: unknown;
}

/** Verifies a Clerk-issued RS256 JWT. Returns the identity or throws. */
export async function verifyClerkJwt(jwt: string, env: AuthEnv): Promise<VerifiedIdentity> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = b64urlJsonParse<{ alg?: string; kid?: string }>(headerB64);
  if (header.alg !== "RS256") throw new Error("unsupported alg");
  if (!header.kid) throw new Error("missing kid");

  const key = await getKey(env, header.kid);
  if (!key) throw new Error("unknown kid");

  const signature = base64UrlToBytes(sigB64);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
  if (!valid) throw new Error("bad signature");

  const claims = b64urlJsonParse<ClerkClaims>(payloadB64);
  const now = Math.floor(Date.now() / 1000);

  // D5: fail closed. An unconfigured issuer must never be treated as "skip
  // this check" — that previously let any RS256 JWT verifiable against the
  // JWKS URL in scope pass with no issuer pinning at all. A real JWT is
  // rejected outright unless `CLERK_ISSUER` is a non-empty string.
  if (!env.CLERK_ISSUER) throw new Error("Clerk issuer not configured");
  if (claims.iss !== env.CLERK_ISSUER) throw new Error("bad issuer");
  // Punch-list fix: `exp` is mandatory, not merely checked-when-present. A
  // real JWT with no `exp` claim previously never expired at all — the
  // `typeof claims.exp === "number"` guard silently skipped the check
  // instead of rejecting the token, the same fail-open shape as the D5
  // issuer bug. The test shim (`verifyTestShim`) never reaches this
  // function, so it is unaffected.
  if (typeof claims.exp !== "number") throw new Error("missing exp");
  if (claims.exp < now) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now) throw new Error("not yet valid");
  if (!claims.sub) throw new Error("missing sub");

  if (env.CLERK_AUTHORIZED_PARTIES) {
    const authorizedParties = env.CLERK_AUTHORIZED_PARTIES.split(",").map((p) => p.trim()).filter(Boolean);
    if (authorizedParties.length > 0) {
      const azp = typeof claims.azp === "string" ? claims.azp : undefined;
      if (!azp || !authorizedParties.includes(azp)) throw new Error("bad azp");
    }
  }

  const emails = emailsFromClaims(claims);
  return { sub: claims.sub, exp: claims.exp, ...profileFromClaims(claims), ...(emails.length > 0 ? { emails } : {}) };
}

/**
 * Test shim (PROTOCOL.md "Clerk verification"): a token shaped
 * `test:<sub>:<hmacSha256(sub, TEST_AUTH_SECRET) as base64url>` is accepted
 * with identity `<sub>`. Only active when `TEST_AUTH_SECRET` is configured;
 * that env var must never exist in a deployed environment.
 */
async function verifyTestShim(token: string, secret: string): Promise<VerifiedIdentity | null> {
  if (token.startsWith("testv2:")) return verifyTestShimV2(token, secret);
  if (!token.startsWith("test:")) return null;
  const rest = token.slice("test:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) throw new Error("malformed test token");
  const sub = rest.slice(0, lastColon);
  const providedMac = rest.slice(lastColon + 1);
  const expectedMac = await hmacSha256Base64Url(sub, secret);
  if (!constantTimeEqual(providedMac, expectedMac)) throw new Error("bad test token mac");
  // PERSONAL-SYNC.md §3.2: a synthetic 1h expiry, since the shim token format
  // carries no claims of its own.
  return { sub, exp: Math.floor(Date.now() / 1000) + 3600 };
}

/**
 * Test shim with e-mail addresses: `testv2:<base64url(JSON {sub, emails, name?})>:<hmacSha256(payload
 * segment, TEST_AUTH_SECRET) as base64url>`. The MAC covers the whole payload, so a test cannot
 * claim someone else's address without the secret. Like the plain shim it exists only where
 * `TEST_AUTH_SECRET` is configured, never in production.
 */
async function verifyTestShimV2(token: string, secret: string): Promise<VerifiedIdentity> {
  const parts = token.split(":");
  if (parts.length !== 3) throw new Error("malformed test token");
  const payloadB64 = parts[1] as string;
  const providedMac = parts[2] as string;
  const expectedMac = await hmacSha256Base64Url(payloadB64, secret);
  if (!constantTimeEqual(providedMac, expectedMac)) throw new Error("bad test token mac");
  const payload = b64urlJsonParse<{ sub?: unknown; emails?: unknown; name?: unknown }>(payloadB64);
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("malformed test token");
  const emails = Array.isArray(payload.emails)
    ? payload.emails.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    sub: payload.sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
    emails,
    ...(typeof payload.name === "string" && payload.name ? { name: payload.name } : {}),
  };
}

/** Verifies a bearer token, preferring the test shim when configured, else Clerk RS256. */
export async function verifyBearerToken(token: string, env: AuthEnv): Promise<VerifiedIdentity> {
  if (env.TEST_AUTH_SECRET) {
    const shimResult = await verifyTestShim(token, env.TEST_AUTH_SECRET);
    if (shimResult) return shimResult;
  }
  return verifyClerkJwt(token, env);
}
