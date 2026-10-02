// Canvink collab-sync worker: HTTP + WebSocket router that forwards every
// request to the room's NotebookRoom Durable Object (identified by an
// unguessable, worker-minted roomId). The worker itself holds no room state.
import { handleAssetRoute } from "./assets";
import { handleDeviceRoute } from "./devices";
import { handleInvitationRoute } from "./invitations";
import { checkRoomCreationRateLimit } from "./rateLimit";
import { handleSpaceRoute } from "./space";
import { generateRoomId } from "./util/crypto";
import type { Env } from "./types";

export { NotebookRoom } from "./room";

const ROOM_ID_PATH = /^\/api\/v1\/rooms\/([A-Za-z0-9_-]{1,64})(\/.*)?$/;
const ASSET_ID_PATH = /^\/api\/v1\/me\/assets\/(.+)$/;

function corsOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowed.includes("*")) return origin;
  return allowed.includes(origin) ? origin : null;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const origin = corsOrigin(request, env);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

function handlePreflight(request: Request, env: Env): Response | null {
  if (request.method !== "OPTIONS") return null;
  const origin = corsOrigin(request, env);
  const headers = new Headers();
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set(
      "Access-Control-Allow-Methods",
      request.headers.get("Access-Control-Request-Method") ?? "GET,POST,PATCH,DELETE,OPTIONS",
    );
    headers.set(
      "Access-Control-Allow-Headers",
      request.headers.get("Access-Control-Request-Headers") ?? "Authorization,Content-Type",
    );
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(null, { status: 204, headers });
}

function roomStub(env: Env, roomId: string): DurableObjectStub {
  const id = env.NOTEBOOK_ROOM.idFromName(roomId);
  return env.NOTEBOOK_ROOM.get(id);
}

function clientIp(request: Request): string {
  // Cloudflare-provided, not attacker-controllable at the edge.
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const allowed = await checkRoomCreationRateLimit(env.ROOM_CREATE_RATE_LIMITER, clientIp(request));
  if (!allowed) {
    return Response.json({ error: "rate-limited" }, { status: 429 });
  }

  const roomId = generateRoomId();
  const stub = roomStub(env, roomId);
  // The room cannot know its own id (it is the name of the Durable Object); the Worker tells it.
  const initHeaders = new Headers(request.headers);
  initHeaders.set("X-Room-Id", roomId);
  const doResponse = await stub.fetch("https://room.internal/init", {
    method: "POST",
    body: request.body,
    headers: initHeaders,
  });
  if (!doResponse.ok) return doResponse;
  const { ownerToken } = (await doResponse.json()) as { ownerToken: string };
  return Response.json({ roomId, ownerToken }, { status: 201 });
}

async function handleRoomSubroute(
  request: Request,
  env: Env,
  roomId: string,
  subpath: string,
  url: URL,
): Promise<Response> {
  const stub = roomStub(env, roomId);
  const target = new URL(`https://room.internal${subpath}`);
  target.search = url.search;
  // The room id comes from the URL only; a client-sent value is overwritten.
  const headers = new Headers(request.headers);
  headers.set("X-Room-Id", roomId);

  // Small JSON bodies, buffered: the room may refuse (403) before reading a
  // streamed body, which then throws "Can't read from request stream after
  // response has been sent" in this worker.
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.method !== "DELETE";
  return stub.fetch(target.toString(), {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const preflight = handlePreflight(request, env);
    if (preflight) return preflight;

    const url = new URL(request.url);

    if (url.pathname === "/api/v1/rooms" && request.method === "POST") {
      const response = await handleCreateRoom(request, env);
      return withCors(response, request, env);
    }

    if (url.pathname === "/api/v1/me/space" && (request.method === "POST" || request.method === "GET")) {
      const response = await handleSpaceRoute(request, env);
      return withCors(response, request, env);
    }

    const invitationResponse = await handleInvitationRoute(request, env, url);
    if (invitationResponse) return withCors(invitationResponse, request, env);

    const deviceResponse = await handleDeviceRoute(request, env, url);
    if (deviceResponse) return withCors(deviceResponse, request, env);

    const assetMatch = ASSET_ID_PATH.exec(url.pathname);
    if (
      assetMatch &&
      (request.method === "HEAD" ||
        request.method === "GET" ||
        request.method === "PUT" ||
        request.method === "DELETE")
    ) {
      const response = await handleAssetRoute(request, env, assetMatch[1] as string);
      return withCors(response, request, env);
    }

    const match = ROOM_ID_PATH.exec(url.pathname);
    if (match) {
      const roomId = match[1] as string;
      const subpath = match[2] ?? "";

      if (subpath === "/ws") {
        // WebSocket upgrades are not subject to CORS in the fetch sense;
        // forward as-is so the Upgrade header reaches the Durable Object.
        return handleRoomSubroute(request, env, roomId, "/ws", url);
      }

      // Ink segments of a shared notebook: content-addressed blobs scoped to this room.
      const roomAsset = /^\/assets\/([0-9a-f]{64})$/.exec(subpath);
      if (
        roomAsset &&
        (request.method === "HEAD" || request.method === "GET" || request.method === "PUT")
      ) {
        // The room id comes from the URL only; any client-sent value is overwritten, so a
        // credential of one room can never address the objects of another.
        const headers = new Headers(request.headers);
        headers.set("X-Room-Id", roomId);
        const init: RequestInit = { method: request.method, headers };
        if (request.method === "PUT") {
          // Buffered, not streamed: the room answers a refused or deduplicated upload
          // before reading the body, and a body still being piped then throws
          // "Can't read from request stream after response has been sent" here, which
          // took down the local dev server. Segments are small (well under the 128 MB
          // isolate limit), so buffering costs little.
          init.body = await request.arrayBuffer();
        }
        const response = await roomStub(env, roomId).fetch(
          `https://room.internal/room-assets/${roomAsset[1] as string}`,
          init,
        );
        return withCors(response, request, env);
      }

      if (subpath === "/links" && (request.method === "POST" || request.method === "DELETE")) {
        const response = await handleRoomSubroute(request, env, roomId, "/links", url);
        return withCors(response, request, env);
      }

      if (subpath === "/collaborators" && request.method === "DELETE") {
        const response = await handleRoomSubroute(request, env, roomId, "/collaborators", url);
        return withCors(response, request, env);
      }

      // Sharing management (owner and admins; the room checks the role): members, invitations, link.
      const managed =
        (subpath === "/members" && request.method === "GET")
        || (/^\/members\/[^/]+$/.test(subpath) && (request.method === "PATCH" || request.method === "DELETE"))
        || (subpath === "/invites" && request.method === "POST")
        || (/^\/invites\/[^/]+$/.test(subpath) && request.method === "DELETE")
        || (subpath === "/link" && (request.method === "GET" || request.method === "PUT"))
        || (subpath === "/link/regenerate" && request.method === "POST")
        || (subpath === "/leave" && request.method === "POST")
        || (subpath === "/owner-profile" && request.method === "PUT");
      if (managed) {
        const response = await handleRoomSubroute(request, env, roomId, subpath, url);
        return withCors(response, request, env);
      }

      if (subpath === "/meta" && request.method === "GET") {
        const response = await handleRoomSubroute(request, env, roomId, "/meta", url);
        return withCors(response, request, env);
      }

      if (subpath === "" && request.method === "DELETE") {
        const response = await handleRoomSubroute(request, env, roomId, "/", url);
        return withCors(response, request, env);
      }
    }

    return withCors(new Response("not found", { status: 404 }), request, env);
  },
};
