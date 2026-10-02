// B3: per-IP rate limiting for unauthenticated POST /rooms.
//
// Prefers the Cloudflare Rate Limiting binding (`ROOM_CREATE_RATE_LIMITER`,
// see wrangler.jsonc) when present. Falls back to a best-effort per-isolate
// in-memory limiter otherwise — not durable, not shared across isolates, but
// still meaningfully raises the cost of naive unbounded room creation, and
// keeps this worker functional in environments/tests that don't provide the
// real binding.
import type { RateLimiterBinding } from "./types";

const FALLBACK_LIMIT = 10;
const FALLBACK_WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  windowStart: number;
}

// Module-level: persists for the isolate's lifetime, cleared implicitly on
// cold start/eviction. Keyed by IP.
const fallbackBuckets = new Map<string, Bucket>();

function fallbackAllow(key: string, now: number): boolean {
  const bucket = fallbackBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= FALLBACK_WINDOW_MS) {
    fallbackBuckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= FALLBACK_LIMIT) return false;
  bucket.count += 1;
  return true;
}

/** Returns true when the request is allowed to proceed. */
export async function checkRoomCreationRateLimit(
  binding: RateLimiterBinding | undefined,
  clientIp: string,
): Promise<boolean> {
  if (binding) {
    try {
      const result = await binding.limit({ key: clientIp });
      return result.success;
    } catch {
      // Binding present but errored: fail open to the in-memory fallback
      // rather than blocking all room creation on a transient binding issue.
    }
  }
  return fallbackAllow(clientIp, Date.now());
}

/** Test-only: clears the in-memory fallback state between test cases. */
export function resetFallbackRateLimiterForTests(): void {
  fallbackBuckets.clear();
  spaceCreateBuckets.clear();
  assetPutBuckets.clear();
  deviceCodeBuckets.clear();
  deviceTokenBuckets.clear();
}

// ---- Personal-space rate limits (PERSONAL-SYNC.md §7) -----------------
// Best-effort, per-isolate, same caveat as the fallback above. Keyed on the
// Clerk `sub` rather than the IP, since a personal space is reached only
// with a verified identity.

const SPACE_CREATE_LIMIT = 30;
const SPACE_CREATE_WINDOW_MS = 60_000;
/** Sized for importing a large notebook: ~1,800 assets finish in about three minutes. */
const ASSET_PUT_LIMIT = 600;
const ASSET_PUT_WINDOW_MS = 60_000;

const spaceCreateBuckets = new Map<string, Bucket>();
const assetPutBuckets = new Map<string, Bucket>();

function bucketAllow(
  buckets: Map<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** `POST /api/v1/me/space`: 30 calls / 60s per `sub`. */
export async function checkSpaceCreationRateLimit(sub: string): Promise<boolean> {
  return bucketAllow(spaceCreateBuckets, sub, SPACE_CREATE_LIMIT, SPACE_CREATE_WINDOW_MS, Date.now());
}

/** Asset `PUT`: 60 calls / 60s per `sub`. */
export async function checkAssetPutRateLimit(sub: string): Promise<boolean> {
  return bucketAllow(assetPutBuckets, sub, ASSET_PUT_LIMIT, ASSET_PUT_WINDOW_MS, Date.now());
}

// ---- Desktop device login (PERSONAL-SYNC.md §3.7) ------------------------
// Same best-effort, per-isolate caveat. A code is 256 random bits and a
// wrong verifier burns it, so these limits guard cost and noise, not the
// secrecy of the code.

const DEVICE_CODE_LIMIT = 10;
const DEVICE_CODE_WINDOW_MS = 60_000;
const DEVICE_TOKEN_LIMIT = 30;
const DEVICE_TOKEN_WINDOW_MS = 60_000;

const deviceCodeBuckets = new Map<string, Bucket>();
const deviceTokenBuckets = new Map<string, Bucket>();

/** `POST /api/v1/device/code`: 10 codes / 60s per `sub`. */
export async function checkDeviceCodeRateLimit(sub: string): Promise<boolean> {
  return bucketAllow(deviceCodeBuckets, sub, DEVICE_CODE_LIMIT, DEVICE_CODE_WINDOW_MS, Date.now());
}

/** `POST /api/v1/device/token`: 30 exchanges or refreshes / 60s per client IP. */
export async function checkDeviceTokenRateLimit(clientIp: string): Promise<boolean> {
  return bucketAllow(deviceTokenBuckets, clientIp, DEVICE_TOKEN_LIMIT, DEVICE_TOKEN_WINDOW_MS, Date.now());
}
