// PERSONAL-SYNC.md §3.7: desktop sign-in through the system browser. Covers
// the one-time code (PKCE S256), the device credential (refresh rotation,
// reuse detection), device tokens on the personal surface, revocation and the
// rate limit.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mintDeviceAccessToken } from "../src/auth/device";
import { handleDeviceRoute } from "../src/devices";
import { resetFallbackRateLimiterForTests } from "../src/rateLimit";
import { deriveSpaceId } from "../src/space";
import type { Env } from "../src/types";
import {
  base64UrlToText,
  collectUntilSynced,
  connectRoomSocket,
  createLink,
  createRoom,
  createSpace,
  frameQueue,
  mintTestJwt,
  send,
} from "./helpers";

const BASE = "https://example.com";

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function requestCode(bearer: string, challenge: string, clientIp = crypto.randomUUID()) {
  return SELF.fetch(`${BASE}/api/v1/device/code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify({ challenge, method: "S256" }),
  });
}

async function tokenRequest(body: Record<string, unknown>) {
  return SELF.fetch(`${BASE}/api/v1/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

async function codeStatus(bearer: string, code: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/v1/device/code/status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return ((await res.json()) as { status: string }).status;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  device_id: string;
  user: { id: string; name?: string; picture?: string };
}

/** Signs `sub` in on a new device: code for a fresh PKCE pair, then exchange. */
async function signInDevice(sub: string, deviceName = "DESKTOP-TEST (Windows)", client: Record<string, unknown> = {}) {
  const clerk = await mintTestJwt(sub);
  const verifier = randomVerifier();
  const codeRes = await requestCode(clerk, await challengeFor(verifier));
  expect(codeRes.status).toBe(201);
  const { code } = (await codeRes.json()) as { code: string };
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    device_name: deviceName,
    ...client,
  });
  expect(res.status).toBe(200);
  return { clerk, code, verifier, tokens: (await res.json()) as TokenResponse };
}

async function helloPersonal(spaceId: string, token: string) {
  const ws = await connectRoomSocket(spaceId);
  const q = frameQueue(ws);
  send(ws, { t: "hello", auth: { kind: "personal", jwt: token } });
  return { ws, q };
}

async function listDevices(bearer: string) {
  return SELF.fetch(`${BASE}/api/v1/me/devices`, { headers: { Authorization: `Bearer ${bearer}` } });
}

async function revokeDevice(bearer: string, deviceId: string) {
  return SELF.fetch(`${BASE}/api/v1/me/devices/${deviceId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

beforeEach(() => resetFallbackRateLimiterForTests());

describe("POST /api/v1/device/code", () => {
  it("needs a Clerk session and a well-formed S256 challenge", async () => {
    const challenge = await challengeFor(randomVerifier());
    const anonymous = await SELF.fetch(`${BASE}/api/v1/device/code`, {
      method: "POST",
      body: JSON.stringify({ challenge }),
    });
    expect(anonymous.status).toBe(401);

    const clerk = await mintTestJwt(`user_${crypto.randomUUID()}`);
    expect((await requestCode(clerk, "too-short")).status).toBe(400);
    const plain = await SELF.fetch(`${BASE}/api/v1/device/code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clerk}` },
      body: JSON.stringify({ challenge, method: "plain" }),
    });
    expect(plain.status).toBe(400);
  });

  it("refuses a device token, so a device can never mint further devices", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { tokens } = await signInDevice(sub);
    const res = await requestCode(tokens.access_token, await challengeFor(randomVerifier()));
    expect(res.status).toBe(401);
  });

  it("rate-limits code issuance per account", async () => {
    const clerk = await mintTestJwt(`user_${crypto.randomUUID()}`);
    const challenge = await challengeFor(randomVerifier());
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await requestCode(clerk, challenge)).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("creates the personal space on first use and routes the code to it", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const res = await requestCode(await mintTestJwt(sub), await challengeFor(randomVerifier()));
    const { code, expires_in } = (await res.json()) as { code: string; expires_in: number };
    expect(expires_in).toBe(120);
    const spaceId = await deriveSpaceId(sub, env.PERSONAL_SPACE_SALT);
    expect(code.startsWith(`${spaceId}.`)).toBe(true);
  });
});

describe("POST /api/v1/device/token: code exchange", () => {
  it("issues a device credential and reports the code as used", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { clerk, code, tokens } = await signInDevice(sub);
    expect(tokens.expires_in).toBe(600);
    expect(tokens.refresh_token).toMatch(/^cvr1\./);
    expect(tokens.user.id).toBe(sub);
    expect(await codeStatus(clerk, code)).toBe("used");
  });

  it("status is pending before the exchange and unknown for another account", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const clerk = await mintTestJwt(sub);
    const res = await requestCode(clerk, await challengeFor(randomVerifier()));
    const { code } = (await res.json()) as { code: string };
    expect(await codeStatus(clerk, code)).toBe("pending");
    expect(await codeStatus(await mintTestJwt(`user_${crypto.randomUUID()}`), code)).toBe("unknown");
  });

  it("rejects a wrong verifier and burns the code (an intercepted code is useless without it)", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const clerk = await mintTestJwt(sub);
    const verifier = randomVerifier();
    const { code } = (await (await requestCode(clerk, await challengeFor(verifier))).json()) as { code: string };

    const stolen = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: randomVerifier() });
    expect(stolen.status).toBe(400);
    const late = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier });
    expect(late.status).toBe(400);
    expect(await codeStatus(clerk, code)).toBe("expired");
  });

  it("a replayed code fails and signs out the device it issued", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { clerk, code, verifier, tokens } = await signInDevice(sub);
    const replay = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier });
    expect(replay.status).toBe(400);
    const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refresh.status).toBe(400);
    const list = (await (await listDevices(clerk)).json()) as { devices: unknown[] };
    expect(list.devices).toEqual([]);
  });

  it("rejects an expired code", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const clerk = await mintTestJwt(sub);
    const verifier = randomVerifier();
    const { code } = (await (await requestCode(clerk, await challengeFor(verifier))).json()) as { code: string };
    const spaceId = await deriveSpaceId(sub, env.PERSONAL_SPACE_SALT);
    const stub = env.NOTEBOOK_ROOM.get(env.NOTEBOOK_ROOM.idFromName(spaceId));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE device_codes SET expiresAt = 0");
    });
    expect(await codeStatus(clerk, code)).toBe("expired");
    const res = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier });
    expect(res.status).toBe(400);
  });

  it("rejects malformed grants", async () => {
    expect((await tokenRequest({ grant_type: "password" })).status).toBe(400);
    expect((await tokenRequest({ grant_type: "authorization_code", code: "x", code_verifier: "y" })).status).toBe(400);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: "cvr1.nope" })).status).toBe(400);
  });

  it("carries the Clerk name and picture captured at sign-in into device tokens and presence", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    await createSpace(sub);
    const spaceId = await deriveSpaceId(sub, env.PERSONAL_SPACE_SALT);
    const stub = env.NOTEBOOK_ROOM.get(env.NOTEBOOK_ROOM.idFromName(spaceId));
    const verifier = randomVerifier();
    // The Worker passes the verified Clerk claims to the Durable Object; the
    // test shim has no profile claims, so this step goes to the DO directly.
    const doRes = await stub.fetch("https://room.internal/device/code", {
      method: "POST",
      body: JSON.stringify({
        sub,
        challenge: await challengeFor(verifier),
        name: "Anna Keller",
        picture: "https://img.clerk.com/anna.png",
      }),
    });
    const { secret } = (await doRes.json()) as { secret: string };
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code: `${spaceId}.${secret}`,
      code_verifier: verifier,
    });
    const tokens = (await res.json()) as TokenResponse;
    expect(tokens.user).toEqual({ id: sub, name: "Anna Keller", picture: "https://img.clerk.com/anna.png" });
    const claims = JSON.parse(base64UrlToText(tokens.access_token.split(".")[1] as string)) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub, name: "Anna Keller", picture: "https://img.clerk.com/anna.png" });

    const device = await helloPersonal(spaceId, tokens.access_token);
    await collectUntilSynced(device.q);
    const web = await helloPersonal(spaceId, await mintTestJwt(sub));
    await collectUntilSynced(web.q);
    send(device.ws, { t: "presence", state: { user: { id: "d", name: "Someone else", color: "#123456" } } });
    let frame = await web.q.next();
    while (frame.t !== "presence") frame = await web.q.next();
    expect((frame.state as { user: { name: string; img: string } }).user).toMatchObject({
      name: "Anna Keller",
      img: "https://img.clerk.com/anna.png",
    });
    device.ws.close();
    web.ws.close();
  });
});

describe("device tokens on the personal surface", () => {
  it("open the account's personal room and GET /me/space like the Clerk session", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { tokens } = await signInDevice(sub);
    const spaceId = await deriveSpaceId(sub, env.PERSONAL_SPACE_SALT);

    const space = await SELF.fetch(`${BASE}/api/v1/me/space`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(space.status).toBe(200);
    expect(((await space.json()) as { spaceId: string }).spaceId).toBe(spaceId);

    const { ws, q } = await helloPersonal(spaceId, tokens.access_token);
    const frames = await collectUntilSynced(q);
    expect(frames[0]).toMatchObject({ t: "welcome", role: "owner" });
    ws.close();
  });

  it("are refused by another account's personal room", async () => {
    const { tokens } = await signInDevice(`user_${crypto.randomUUID()}`);
    const other = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(other);
    const foreign = await helloPersonal((body as { spaceId: string }).spaceId, tokens.access_token);
    expect((await foreign.q.closeEvent()).code).toBe(4401);
  });

  it("join a shared notebook as a reader through the link, until the device is signed out", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { clerk, tokens } = await signInDevice(sub);
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);

    const ws = await connectRoomSocket(roomId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "user", jwt: tokens.access_token, linkSecret } });
    const frames = await collectUntilSynced(q);
    expect(frames[0]).toMatchObject({ t: "welcome", role: "viewer" });
    ws.close();

    expect((await revokeDevice(clerk, tokens.device_id)).status).toBe(204);
    const again = await connectRoomSocket(roomId);
    const againQ = frameQueue(again);
    send(again, { t: "hello", auth: { kind: "user", jwt: tokens.access_token, linkSecret } });
    expect((await againQ.closeEvent()).code).toBe(4401);
  });

  it("reject a forged or expired token", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { tokens } = await signInDevice(sub);
    const forged = await mintDeviceAccessToken({ sub, deviceId: tokens.device_id }, "not-the-server-secret");
    const expired = await mintDeviceAccessToken(
      { sub, deviceId: tokens.device_id },
      env.DEVICE_TOKEN_SECRET,
      Math.floor(Date.now() / 1000) - 3600,
    );
    for (const token of [forged.token, expired.token]) {
      const res = await SELF.fetch(`${BASE}/api/v1/me/space`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
    }
  });

  it("reauth keeps a device socket on the same device", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { tokens } = await signInDevice(sub);
    const spaceId = await deriveSpaceId(sub, env.PERSONAL_SPACE_SALT);
    const { ws, q } = await helloPersonal(spaceId, tokens.access_token);
    await collectUntilSynced(q);
    send(ws, { t: "reauth", jwt: await mintTestJwt(sub) });
    expect((await q.closeEvent()).code).toBe(4401);
  });
});

describe("refresh-token rotation", () => {
  it("rotates on every refresh; the new token works and a stale one signs the device out", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { clerk, tokens } = await signInDevice(sub);
    const first = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as TokenResponse;
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotated.device_id).toBe(tokens.device_id);

    // Past the retry leeway, the old token coming back means a copy exists.
    const spaceId = await deriveSpaceId(sub, env.PERSONAL_SPACE_SALT);
    const stub = env.NOTEBOOK_ROOM.get(env.NOTEBOOK_ROOM.idFromName(spaceId));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE devices SET rotatedAt = 0");
    });
    const reuse = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(reuse.status).toBe(400);
    const afterReuse = await tokenRequest({ grant_type: "refresh_token", refresh_token: rotated.refresh_token });
    expect(afterReuse.status).toBe(400);
    expect(((await (await listDevices(clerk)).json()) as { devices: unknown[] }).devices).toEqual([]);
  });

  it("accepts one retry with the previous token right after a rotation (lost response)", async () => {
    const { tokens } = await signInDevice(`user_${crypto.randomUUID()}`);
    const first = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(first.status).toBe(200);
    const retry = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(retry.status).toBe(200);
    const next = (await retry.json()) as TokenResponse;
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: next.refresh_token })).status).toBe(200);
  });
});

describe("GET/DELETE /api/v1/me/devices", () => {
  it("lists devices for the Clerk session only", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { clerk, tokens } = await signInDevice(sub, "LAPTOP (Windows)");
    const res = await listDevices(clerk);
    expect(res.status).toBe(200);
    const { devices } = (await res.json()) as { devices: { id: string; label: string }[] };
    expect(devices).toEqual([expect.objectContaining({ id: tokens.device_id, label: "LAPTOP (Windows)" })]);
    expect((await listDevices(tokens.access_token)).status).toBe(401);
  });

  it("revoking from the web closes the device's socket and ends its refresh token", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { clerk, tokens } = await signInDevice(sub);
    const spaceId = await deriveSpaceId(sub, env.PERSONAL_SPACE_SALT);
    const { ws, q } = await helloPersonal(spaceId, tokens.access_token);
    await collectUntilSynced(q);

    expect((await revokeDevice(clerk, tokens.device_id)).status).toBe(204);
    expect((await q.closeEvent()).code).toBe(4401);
    const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refresh.status).toBe(400);
    // The still-unexpired access token is refused wherever the space's DO is reached.
    const again = await helloPersonal(spaceId, tokens.access_token);
    expect((await again.q.closeEvent()).code).toBe(4401);
    const space = await SELF.fetch(`${BASE}/api/v1/me/space`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(space.status).toBe(401);
    ws.close();
  });

  it("a device may sign itself out, but not another device", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const a = await signInDevice(sub, "A");
    const b = await signInDevice(sub, "B");
    expect((await revokeDevice(a.tokens.access_token, b.tokens.device_id)).status).toBe(403);
    expect((await revokeDevice(a.tokens.access_token, a.tokens.device_id)).status).toBe(204);
    const { devices } = (await (await listDevices(a.clerk)).json()) as { devices: { id: string }[] };
    expect(devices.map((d) => d.id)).toEqual([b.tokens.device_id]);
  });
});

describe("device identity (installation, platform, version, rename)", () => {
  const INSTALL = "inst_AAAAAAAAAAAAAAAAAAAAAA";

  it("one installation is one device: signing in again replaces the older row", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const client = { install_id: INSTALL, platform: "android", app_version: "0.3.1" };
    const first = await signInDevice(sub, "", client);
    const second = await signInDevice(sub, "", { ...client, app_version: "0.3.2" });
    const other = await signInDevice(sub, "PC", { install_id: "inst_BBBBBBBBBBBBBBBBBBBBBB", platform: "windows" });
    const { devices } = (await (await listDevices(second.clerk)).json()) as {
      devices: { id: string; platform?: string; appVersion?: string }[];
    };
    expect(devices.map((d) => d.id)).toEqual([second.tokens.device_id, other.tokens.device_id]);
    expect(devices[0]).toEqual(expect.objectContaining({ platform: "android", appVersion: "0.3.2" }));
    // The replaced credential is signed out like any revoked device.
    const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: first.tokens.refresh_token });
    expect(refresh.status).toBe(400);
  });

  it("without an installation id every sign-in is its own device (older apps)", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const a = await signInDevice(sub);
    await signInDevice(sub);
    const { devices } = (await (await listDevices(a.clerk)).json()) as { devices: unknown[] };
    expect(devices).toHaveLength(2);
  });

  it("ignores malformed client fields", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { clerk } = await signInDevice(sub, "X", { install_id: "short", platform: "toaster", app_version: "<script>" });
    const { devices } = (await (await listDevices(clerk)).json()) as { devices: Record<string, unknown>[] };
    expect(devices[0]).not.toHaveProperty("platform");
    expect(devices[0]).not.toHaveProperty("appVersion");
  });

  it("a refresh keeps the listed app version current", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { clerk, tokens } = await signInDevice(sub, "PC", { platform: "windows", app_version: "0.3.1" });
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      app_version: "0.3.2",
    });
    expect(refreshed.status).toBe(200);
    const { devices } = (await (await listDevices(clerk)).json()) as { devices: { appVersion?: string }[] };
    expect(devices[0]?.appVersion).toBe("0.3.2");
  });

  it("renames a device for the Clerk session only", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { clerk, tokens } = await signInDevice(sub, "PC");
    const rename = (bearer: string, label: unknown) =>
      SELF.fetch(`${BASE}/api/v1/me/devices/${tokens.device_id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
    expect((await rename(tokens.access_token, "Mine")).status).toBe(401);
    expect((await rename(clerk, 42)).status).toBe(400);
    const done = await rename(clerk, "  Schul-Laptop  ");
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ id: tokens.device_id, label: "Schul-Laptop" });
    const { devices } = (await (await listDevices(clerk)).json()) as { devices: { label: string }[] };
    expect(devices[0]?.label).toBe("Schul-Laptop");
    // An older entry keeps its platform when the new name no longer spells it out.
    const legacy = await signInDevice(sub, "OLD-PC (Windows)");
    const renamedLegacy = await SELF.fetch(`${BASE}/api/v1/me/devices/${legacy.tokens.device_id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${clerk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Werkstatt" }),
    });
    expect(renamedLegacy.status).toBe(200);
    const all = (await (await listDevices(clerk)).json()) as { devices: { id: string; label: string; platform?: string }[] };
    expect(all.devices.find((d) => d.id === legacy.tokens.device_id)).toEqual(
      expect.objectContaining({ label: "Werkstatt", platform: "windows" }),
    );
    // Another account's device is not found, never renamed.
    const stranger = await mintTestJwt(`user_${crypto.randomUUID()}`);
    expect((await rename(stranger, "Hijacked")).status).toBe(404);
  });
});

describe("configuration and CORS", () => {
  it("fails closed with 503 while DEVICE_TOKEN_SECRET is unset", async () => {
    const request = new Request(`${BASE}/api/v1/device/token`, {
      method: "POST",
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "x" }),
    });
    const envWithout: Env = { ...(env as unknown as Env), DEVICE_TOKEN_SECRET: undefined };
    const res = await handleDeviceRoute(request, envWithout, new URL(request.url));
    expect(res?.status).toBe(503);
  });

  it("allows the desktop app's WebView origins", async () => {
    for (const origin of ["http://tauri.localhost", "tauri://localhost", "https://canvink.example.com"]) {
      const res = await SELF.fetch(`${BASE}/api/v1/device/token`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
    const evil = await SELF.fetch(`${BASE}/api/v1/device/token`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
