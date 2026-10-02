// Ink segments of a shared room: content-addressed blobs scoped to the room, over HEAD/GET/PUT.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createLink, createRoom, sha256HexOf } from "./helpers";

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

function roomAsset(
  roomId: string,
  method: "HEAD" | "GET" | "PUT",
  hex: string,
  headers: Record<string, string>,
  body?: Uint8Array,
): Promise<Response> {
  return SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/assets/${hex}`, { method, headers, body });
}

describe("room asset routes", () => {
  it("lets the owner store a blob and a link holder read it, and refuses a viewer's write", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const bytes = randomBytes(2048);
    const hex = await sha256HexOf(bytes);
    const owner = { Authorization: `Owner ${ownerToken}` };
    const viewer = { "X-Link-Secret": linkSecret };

    expect((await roomAsset(roomId, "HEAD", hex, viewer)).status).toBe(204);
    const put = await roomAsset(roomId, "PUT", hex, { ...owner, "Content-Type": "application/octet-stream" }, bytes);
    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ assetId: `sha256:${hex}`, size: bytes.byteLength });

    expect((await roomAsset(roomId, "HEAD", hex, viewer)).status).toBe(200);
    const get = await roomAsset(roomId, "GET", hex, viewer);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

    const other = randomBytes(64);
    const otherHex = await sha256HexOf(other);
    const refused = await roomAsset(roomId, "PUT", otherHex, viewer, other);
    expect(refused.status).toBe(403);
    expect((await roomAsset(roomId, "HEAD", otherHex, owner)).status).toBe(204);
  });

  it("deduplicates, verifies the hash and refuses callers without a credential", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = { Authorization: `Owner ${ownerToken}` };
    const bytes = randomBytes(300);
    const hex = await sha256HexOf(bytes);
    expect((await roomAsset(roomId, "PUT", hex, owner, bytes)).status).toBe(201);
    const again = await roomAsset(roomId, "PUT", hex, owner, bytes);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ deduplicated: true });

    const wrong = await sha256HexOf(randomBytes(300));
    const mismatch = await roomAsset(roomId, "PUT", wrong, owner, bytes);
    expect(mismatch.status).toBe(400);
    expect((await roomAsset(roomId, "HEAD", wrong, owner)).status).toBe(204);

    expect((await roomAsset(roomId, "GET", hex, {})).status).toBe(401);
    expect((await roomAsset(roomId, "GET", hex, { Authorization: "Owner nope" })).status).toBe(401);
  });

  it("keeps rooms apart: another room's credential reads nothing here, whatever it claims", async () => {
    const first = await createRoom();
    const second = await createRoom();
    const bytes = randomBytes(128);
    const hex = await sha256HexOf(bytes);
    await roomAsset(first.roomId, "PUT", hex, { Authorization: `Owner ${first.ownerToken}` }, bytes);

    // The second room's owner holds no credential for the first room.
    expect((await roomAsset(first.roomId, "GET", hex, { Authorization: `Owner ${second.ownerToken}` })).status).toBe(401);
    // ...and a spoofed room header never reaches the object of the first room.
    const spoofed = await roomAsset(second.roomId, "GET", hex, {
      Authorization: `Owner ${second.ownerToken}`,
      "X-Room-Id": first.roomId,
    });
    expect(spoofed.status).toBe(204);
  });

  it("rejects a malformed hash and removes the blobs when the room is deleted", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = { Authorization: `Owner ${ownerToken}` };
    expect((await roomAsset(roomId, "GET", "abc", owner)).status).toBe(404);
    const bytes = randomBytes(90);
    const hex = await sha256HexOf(bytes);
    await roomAsset(roomId, "PUT", hex, owner, bytes);
    expect(await env.ASSETS?.head(`rooms/${roomId}/${hex}`)).not.toBeNull();

    const del = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}`, { method: "DELETE", headers: owner });
    expect(del.status).toBe(204);
    expect(await env.ASSETS?.head(`rooms/${roomId}/${hex}`)).toBeNull();
  });
});

void createLink;
