// Personal-space route glue: spaceId derivation and the
// `POST|GET /api/v1/me/space` routes (PERSONAL-SYNC.md §2.1, §3.5).
//
// The Worker never trusts a client-supplied spaceId for authorization or for
// an R2 key: it is always re-derived here from the verified Clerk `sub` plus
// `PERSONAL_SPACE_SALT`.
import { verifySpaceToken } from "./auth/device";
import { checkSpaceCreationRateLimit } from "./rateLimit";
import { hmacSha256Base64Url } from "./util/crypto";
import type { Env } from "./types";
import { DEVICE_ID_HEADER, MAX_ASSET_BYTES, MAX_SPACE_LOG_BYTES, SPACE_ASSET_QUOTA_BYTES } from "./types";

/** PERSONAL-SYNC.md §2.1:
 * `spaceId = base64url(HMAC-SHA256(key=PERSONAL_SPACE_SALT, msg="canvink-space-v1:" + sub)).slice(0, 22)` */
export async function deriveSpaceId(sub: string, salt: string): Promise<string> {
  const full = await hmacSha256Base64Url(`canvink-space-v1:${sub}`, salt);
  return full.slice(0, 22);
}

export function roomStub(env: Env, roomId: string): DurableObjectStub {
  const id = env.NOTEBOOK_ROOM.idFromName(roomId);
  return env.NOTEBOOK_ROOM.get(id);
}

export interface ResolvedSpaceAuth {
  sub: string;
  spaceId: string;
  /** Set when the caller used a desktop device token (PERSONAL-SYNC.md §3.7). */
  deviceId?: string;
}

/** Verifies `Authorization: Bearer <clerk jwt | device token>` and derives the caller's spaceId.
 * Returns `null` on a missing/invalid credential; the caller is responsible for
 * the `PERSONAL_SPACE_SALT`-unset 503 (checked first, so this function is only
 * ever called once the salt is known to exist). */
export async function resolveSpaceAuth(request: Request, env: Env): Promise<ResolvedSpaceAuth | null> {
  if (!env.PERSONAL_SPACE_SALT) return null;
  const auth = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(auth);
  if (!match) return null;
  try {
    const identity = await verifySpaceToken(match[1] as string, env);
    const spaceId = await deriveSpaceId(identity.sub, env.PERSONAL_SPACE_SALT);
    return { sub: identity.sub, spaceId, ...(identity.deviceId ? { deviceId: identity.deviceId } : {}) };
  } catch {
    return null;
  }
}

interface SpaceStats {
  kind: "personal";
  docCount: number;
  logBytes: number;
  assetCount: number;
  assetBytes: number;
  createdAt: string;
}

function buildDescriptor(spaceId: string, stats: SpaceStats) {
  return {
    spaceId,
    kind: "personal" as const,
    docCount: stats.docCount,
    logBytes: stats.logBytes,
    assetCount: stats.assetCount,
    assetBytes: stats.assetBytes,
    quota: {
      logBytes: MAX_SPACE_LOG_BYTES,
      assetBytes: SPACE_ASSET_QUOTA_BYTES,
      maxAssetBytes: MAX_ASSET_BYTES,
    },
    createdAt: stats.createdAt,
  };
}

/** `POST|GET /api/v1/me/space` (PERSONAL-SYNC.md §3.5). */
export async function handleSpaceRoute(request: Request, env: Env): Promise<Response> {
  if (!env.PERSONAL_SPACE_SALT) {
    return Response.json({ error: "personal-space-not-configured" }, { status: 503 });
  }

  const auth = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(auth);
  if (!match) return Response.json({ error: "unauthorized" }, { status: 401 });

  let identity;
  try {
    identity = await verifySpaceToken(match[1] as string, env);
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const spaceId = await deriveSpaceId(identity.sub, env.PERSONAL_SPACE_SALT);
  const stub = roomStub(env, spaceId);
  const deviceHeaders: Record<string, string> = identity.deviceId ? { [DEVICE_ID_HEADER]: identity.deviceId } : {};

  if (request.method === "POST") {
    const allowed = await checkSpaceCreationRateLimit(identity.sub);
    if (!allowed) return Response.json({ error: "rate-limited" }, { status: 429 });

    const doResponse = await stub.fetch("https://room.internal/space/init", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceHeaders },
      body: JSON.stringify({ sub: identity.sub }),
    });
    if (!doResponse.ok) return doResponse;
    const stats = (await doResponse.json()) as SpaceStats;
    return Response.json(buildDescriptor(spaceId, stats), { status: doResponse.status });
  }

  // GET
  const doResponse = await stub.fetch("https://room.internal/space", { method: "GET", headers: deviceHeaders });
  if (!doResponse.ok) return doResponse;
  const stats = (await doResponse.json()) as SpaceStats;
  return Response.json(buildDescriptor(spaceId, stats), { status: 200 });
}
