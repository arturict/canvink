// Verified e-mail addresses of a signed-in account, for invitations by e-mail.
//
// An invitation names an address; the person it is meant for proves they own it by being signed in
// with a Clerk account that has that address *verified* (primary or secondary). The Worker never
// trusts an address a client sends. It learns the verified addresses from
//   1. the session token, when the Clerk instance adds an `emails` claim (see `emailsFromClaims`), and
//   2. the Clerk Backend API (`GET /v1/users/:id`), which lists every address with its verification
//      status, secondary ones included. That needs the secret `CLERK_SECRET_KEY`.
// Without either, nobody can claim an invitation: the access check fails closed.
import type { AuthEnv, VerifiedIdentity } from "./clerk";

export interface EmailEnv extends AuthEnv {
  /** Clerk Backend API secret key (`sk_...`), set with `wrangler secret put CLERK_SECRET_KEY`. */
  CLERK_SECRET_KEY?: string;
  /** Test seam and self-hosted Clerk proxies; defaults to `https://api.clerk.com`. */
  CLERK_API_URL?: string;
}

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
export const MAX_EMAIL_LENGTH = 254;

/** Trimmed, lower-cased address, or `null` when it is not a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

interface CacheEntry {
  emails: string[];
  at: number;
}

/** Per-isolate cache: a Clerk call per socket connect would be slow and rate limited. */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

async function fetchBackendEmails(sub: string, env: EmailEnv): Promise<string[] | null> {
  const key = env.CLERK_SECRET_KEY;
  if (!key) return null;
  const base = (env.CLERK_API_URL ?? "https://api.clerk.com").replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/v1/users/${encodeURIComponent(sub)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { email_addresses?: unknown } | null;
  if (!body || !Array.isArray(body.email_addresses)) return null;
  const verified: string[] = [];
  for (const entry of body.email_addresses) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { email_address?: unknown; verification?: { status?: unknown } | null };
    if (record.verification?.status !== "verified") continue;
    const email = normalizeEmail(record.email_address);
    if (email) verified.push(email);
  }
  return verified;
}

/** Every verified address the identity is known to own, normalised and de-duplicated. */
export async function verifiedEmailsFor(
  identity: Pick<VerifiedIdentity, "sub" | "emails">,
  env: EmailEnv,
): Promise<string[]> {
  const found = new Set<string>();
  for (const raw of identity.emails ?? []) {
    const email = normalizeEmail(raw);
    if (email) found.add(email);
  }
  const cached = cache.get(identity.sub);
  let backend: string[] | null;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    backend = cached.emails;
  } else {
    backend = await fetchBackendEmails(identity.sub, env);
    if (backend) cache.set(identity.sub, { emails: backend, at: Date.now() });
  }
  for (const email of backend ?? []) found.add(email);
  return [...found];
}

/** Forgets cached addresses (tests). */
export function clearEmailCache(): void {
  cache.clear();
}
