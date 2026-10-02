// Personal-space asset routes: HEAD/PUT/GET/DELETE /api/v1/me/assets/:assetId,
// proxied to the personal room's Durable Object, which owns the R2 access so
// the update to the `assetBytes`/`assetCount` counters is serialised with the
// WebSocket handlers (PERSONAL-SYNC.md §3.5, §3.6, §4.2).
import { checkAssetPutRateLimit } from "./rateLimit";
import { resolveSpaceAuth, roomStub } from "./space";
import type { Env } from "./types";
import { DEVICE_ID_HEADER } from "./types";

const BARE_HEX = /^[0-9a-f]{64}$/;
const SHA256_PREFIXED = /^sha256:([0-9a-f]{64})$/;

/** Accepts the canonical `sha256:<64 hex>` form (URL-encoded as `sha256%3A<hex>`,
 * which `decodeURIComponent` restores to a literal colon) or a bare 64-hex form.
 * Anything else is invalid. Returns the lowercase hex part only. */
export function parseAssetId(rawSegment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
  const prefixed = SHA256_PREFIXED.exec(decoded);
  if (prefixed) return prefixed[1] as string;
  if (BARE_HEX.test(decoded)) return decoded;
  return null;
}

/** `HEAD|PUT|GET|DELETE /api/v1/me/assets/:assetId` (PERSONAL-SYNC.md §3.5). */
export async function handleAssetRoute(
  request: Request,
  env: Env,
  rawAssetId: string,
): Promise<Response> {
  const hexPart = parseAssetId(rawAssetId);
  if (!hexPart) return Response.json({ error: "bad-asset-id" }, { status: 400 });

  if (!env.PERSONAL_SPACE_SALT) {
    return Response.json({ error: "personal-space-not-configured" }, { status: 503 });
  }
  // The R2 bucket cannot be provisioned on this Cloudflare account yet
  // (`wrangler r2 bucket create` fails with error 10042 — R2 not enabled).
  // Fail closed rather than forwarding to a DO that has no bucket binding.
  if (!env.ASSETS) {
    return Response.json({ error: "assets-not-configured" }, { status: 503 });
  }

  const auth = await resolveSpaceAuth(request, env);
  if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (request.method === "PUT") {
    const allowed = await checkAssetPutRateLimit(auth.sub);
    if (!allowed) return Response.json({ error: "rate-limited" }, { status: 429 });
  }

  const stub = roomStub(env, auth.spaceId);
  const target = `https://room.internal/assets/${hexPart}`;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const contentLength = request.headers.get("content-length");
  const range = request.headers.get("Range");
  if (contentType) headers.set("content-type", contentType);
  if (contentLength) headers.set("content-length", contentLength);
  if (range) headers.set("Range", range);
  // Server-derived only, never trusted from the client; used by the DO to
  // build the `spaces/<spaceId>/<hex>` R2 key (PERSONAL-SYNC.md §4.2).
  headers.set("X-Space-Id", auth.spaceId);
  if (auth.deviceId) headers.set(DEVICE_ID_HEADER, auth.deviceId);

  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers };
  if (request.method === "PUT") {
    init.body = request.body;
    // Required by the Workers runtime when streaming a ReadableStream body
    // straight through to another `fetch` (PERSONAL-SYNC.md §3.5: "the
    // Worker never buffers the asset").
    init.duplex = "half";
  }

  return stub.fetch(target, init);
}
