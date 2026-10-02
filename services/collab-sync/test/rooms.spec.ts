import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  collectUntilSynced,
  connectRoomSocket,
  createLink,
  createRoom,
  frameQueue,
  getMeta,
  mintTestJwt,
  send,
} from "./helpers";

describe("room creation", () => {
  it("returns a distinct roomId and ownerToken per room", async () => {
    const a = await createRoom("Notebook A");
    const b = await createRoom("Notebook B");

    expect(a.roomId).not.toBe(b.roomId);
    expect(a.ownerToken).not.toBe(b.ownerToken);
    expect(a.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.ownerToken.length).toBeGreaterThan(20);
  });
});

describe("link creation", () => {
  it("requires a valid ownerToken", async () => {
    const { roomId } = await createRoom();

    const noAuth = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/links`, {
      method: "POST",
    });
    expect(noAuth.status).toBe(401);

    const badAuth = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/links`, {
      method: "POST",
      headers: { Authorization: "Owner not-the-real-token" },
    });
    expect(badAuth.status).toBe(401);
  });

  it("creates a link secret for the real owner", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    expect(linkSecret.length).toBeGreaterThan(20);
  });

  it("revokes all links so a revoked link secret no longer grants access", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);

    const before = await getMeta(roomId, { linkSecret });
    expect(before.status).toBe(200);

    const revoke = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/links`, {
      method: "DELETE",
      headers: { Authorization: `Owner ${ownerToken}` },
    });
    expect(revoke.status).toBe(204);

    const after = await getMeta(roomId, { linkSecret });
    expect(after.status).toBe(401);
  });
});

describe("meta endpoint", () => {
  it("returns notebookTitle/role/docCount for a valid link secret", async () => {
    const { roomId, ownerToken } = await createRoom("My notebook");
    const { linkSecret } = await createLink(roomId, ownerToken);

    const res = await getMeta(roomId, { linkSecret });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notebookTitle: string; role: string; docCount: number };
    expect(body).toEqual({ notebookTitle: "My notebook", role: "viewer", docCount: 0 });
  });

  it("returns owner role for the ownerToken", async () => {
    const { roomId, ownerToken } = await createRoom();
    const res = await getMeta(roomId, { ownerToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("owner");
  });

  it("rejects invalid credentials", async () => {
    const { roomId } = await createRoom();
    const res = await getMeta(roomId, { linkSecret: "totally-made-up" });
    expect(res.status).toBe(401);
  });

  it("rejects a bearer JWT for a subject that is not a registered collaborator", async () => {
    const { roomId } = await createRoom();
    const jwt = await mintTestJwt("user_never_joined");
    const res = await getMeta(roomId, { jwt });
    expect(res.status).toBe(401);
  });

  it("D2: no longer accepts the link secret as a `?k=` query string", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const res = await SELF.fetch(
      `https://example.com/api/v1/rooms/${roomId}/meta?k=${encodeURIComponent(linkSecret)}`,
    );
    expect(res.status).toBe(401);
  });

  it("D2: accepts the link secret via the X-Link-Secret header", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const res = await getMeta(roomId, { linkSecret });
    expect(res.status).toBe(200);
  });
});

describe("B2: collaborator revocation and full unshare", () => {
  it("clears registered collaborators so their JWT alone no longer grants editor access", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const jwt = await mintTestJwt("user_to_revoke");

    // Register as a collaborator via jwt + linkSecret over the meta endpoint
    // isn't supported (see README's documented ambiguity #1), so register
    // via a WS hello instead, then close it.
    const first = await connectRoomSocket(roomId);
    const q1 = frameQueue(first);
    send(first, { t: "hello", auth: { kind: "user", jwt, linkSecret } });
    await collectUntilSynced(q1);
    first.close();

    const before = await getMeta(roomId, { jwt });
    expect(before.status).toBe(200);

    const revoke = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/collaborators`, {
      method: "DELETE",
      headers: { Authorization: `Owner ${ownerToken}` },
    });
    expect(revoke.status).toBe(204);

    const after = await getMeta(roomId, { jwt });
    expect(after.status).toBe(401);
  });

  it("closes a live editor socket with 4401 when collaborators are cleared, but leaves a live viewer alone", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const jwt = await mintTestJwt("user_live");

    const editor = await connectRoomSocket(roomId);
    const editorQ = frameQueue(editor);
    send(editor, { t: "hello", auth: { kind: "user", jwt, linkSecret } });
    await collectUntilSynced(editorQ);

    // Punch-list regression guard: a link-only viewer's credential is
    // untouched by `/collaborators` (that's `/links`), and the client
    // treats any socket close as fatal (it never reconnects) — so this
    // route must not evict it too, only registered editors.
    const owner = await connectRoomSocket(roomId);
    const ownerQ = frameQueue(owner);
    send(owner, { t: "hello", auth: { kind: "owner", ownerToken } });
    await collectUntilSynced(ownerQ);

    const viewer = await connectRoomSocket(roomId);
    const viewerQ = frameQueue(viewer);
    send(viewer, { t: "hello", auth: { kind: "link", linkSecret } });
    await collectUntilSynced(viewerQ);

    const revoke = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/collaborators`, {
      method: "DELETE",
      headers: { Authorization: `Owner ${ownerToken}` },
    });
    expect(revoke.status).toBe(204);

    const editorClose = await editorQ.closeEvent();
    expect(editorClose.code).toBe(4401);

    // The viewer must still be usable: send a fresh announce as the owner
    // (still connected) and confirm the viewer receives the live broadcast,
    // proving its socket was never closed.
    send(owner, { t: "announce", docId: "doc-after-revoke", kind: "notebook" });
    const broadcast = await viewerQ.next();
    expect(broadcast).toMatchObject({ t: "announce", docId: "doc-after-revoke" });
  });

  it("requires the real ownerToken to clear collaborators", async () => {
    const { roomId } = await createRoom();
    const res = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/collaborators`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("full unshare wipes the room so every route returns 404/unauthorized", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);

    const del = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}`, {
      method: "DELETE",
      headers: { Authorization: `Owner ${ownerToken}` },
    });
    expect(del.status).toBe(204);

    expect((await getMeta(roomId, { linkSecret })).status).toBe(404);
    expect(
      (await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/links`, {
        method: "POST",
        headers: { Authorization: `Owner ${ownerToken}` },
      })).status,
    ).toBe(401);
  });

  it("closes every live socket (owner included) with 4401 on full unshare", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await connectRoomSocket(roomId);
    const q = frameQueue(owner);
    send(owner, { t: "hello", auth: { kind: "owner", ownerToken } });
    await collectUntilSynced(q);

    const del = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}`, {
      method: "DELETE",
      headers: { Authorization: `Owner ${ownerToken}` },
    });
    expect(del.status).toBe(204);

    const closeEvent = await q.closeEvent();
    expect(closeEvent.code).toBe(4401);
  });
});

describe("B3: unauthenticated room-creation bounds", () => {
  it("rejects a non-JSON body with 400 instead of throwing", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all {{{",
    });
    expect(res.status).toBe(400);
  });

  it("punch-list: rejects a JSON array body with 400 (isRecord must exclude arrays)", async () => {
    // `typeof [] === "object"` — without an explicit `Array.isArray` guard, a
    // JSON array body passed `isRecord`, and `notebookTitle` (an optional
    // field never present on an array) came back `undefined`, silently
    // skipping title validation instead of failing it, so this used to
    // return 201.
    const res = await SELF.fetch("https://example.com/api/v1/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["not", "an", "object"]),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-string notebookTitle with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookTitle: 12345 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a notebookTitle over 200 chars with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookTitle: "x".repeat(201) }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a notebookTitle at exactly 200 chars", async () => {
    const room = await createRoom("x".repeat(200));
    expect(room.roomId).toBeDefined();
  });

  it("B3: rate-limits room creation per IP (fallback in-memory limiter)", async () => {
    const clientIp = `rate-limit-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 10; i++) {
      const room = await createRoom(`room ${i}`, { clientIp });
      expect(room.roomId).toBeDefined();
    }
    const res = await SELF.fetch("https://example.com/api/v1/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
      body: JSON.stringify({ notebookTitle: "one too many" }),
    });
    expect(res.status).toBe(429);

    // A different IP is unaffected.
    const other = await createRoom("unrelated", { clientIp: `${clientIp}-other` });
    expect(other.roomId).toBeDefined();
  });

  it("caps links per room at 20", async () => {
    const { roomId, ownerToken } = await createRoom();
    for (let i = 0; i < 20; i++) {
      const res = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/links`, {
        method: "POST",
        headers: { Authorization: `Owner ${ownerToken}` },
      });
      expect(res.status).toBe(201);
    }
    const overCap = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/links`, {
      method: "POST",
      headers: { Authorization: `Owner ${ownerToken}` },
    });
    expect(overCap.status).toBe(400);
  });
});
