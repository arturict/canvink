// PERSONAL-SYNC.md §9 Wave 1: personal rooms, cross-kind refusal, the
// `workspace` doc kind, reauth, and space isolation.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleSpaceRoute } from "../src/space";
import type { Env } from "../src/types";
import {
  collectUntilSynced,
  connectRoomSocket,
  createRoom,
  createSpace,
  frameQueue,
  getSpace,
  mintTestJwt,
  send,
  textToBase64Url,
} from "./helpers";

async function helloAsPersonal(spaceId: string, jwt: string) {
  const ws = await connectRoomSocket(spaceId);
  const q = frameQueue(ws);
  send(ws, { t: "hello", auth: { kind: "personal", jwt } });
  const frames = await collectUntilSynced(q);
  return { ws, q, frames };
}

describe("POST|GET /api/v1/me/space", () => {
  it("creates a personal space, 201 on first call, 200 idempotent on the second", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const first = await createSpace(sub);
    expect(first.res.status).toBe(201);
    const body = first.body as { spaceId: string; kind: string; docCount: number };
    expect(body.kind).toBe("personal");
    expect(body.docCount).toBe(0);
    expect(body.spaceId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const second = await createSpace(sub);
    expect(second.res.status).toBe(200);
    expect((second.body as { spaceId: string }).spaceId).toBe(body.spaceId);
  });

  it("derives distinct, deterministic spaceIds per sub", async () => {
    const subA = `user_a_${crypto.randomUUID()}`;
    const subB = `user_b_${crypto.randomUUID()}`;
    const a1 = await createSpace(subA);
    const a2 = await createSpace(subA);
    const b = await createSpace(subB);
    expect((a1.body as { spaceId: string }).spaceId).toBe((a2.body as { spaceId: string }).spaceId);
    expect((a1.body as { spaceId: string }).spaceId).not.toBe((b.body as { spaceId: string }).spaceId);
  });

  it("GET returns 404 before the space is ever created", async () => {
    const sub = `user_never_created_${crypto.randomUUID()}`;
    const res = await getSpace(sub);
    expect(res.status).toBe(404);
  });

  it("GET returns the same descriptor after creation, with no side effects", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const res = await getSpace(sub);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
  });

  it("rejects a missing/invalid bearer token", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/me/space", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("503s when PERSONAL_SPACE_SALT is unset (fail closed)", async () => {
    const jwt = await mintTestJwt("user_x");
    const request = new Request("https://example.com/api/v1/me/space", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const envWithoutSalt: Env = { ...(env as unknown as Env), PERSONAL_SPACE_SALT: undefined };
    const res = await handleSpaceRoute(request, envWithoutSalt);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "personal-space-not-configured" });
  });
});

describe("PERSONAL-SYNC.md §3.1: cross-kind refusal", () => {
  it("a personal room refuses POST /links, DELETE /links, DELETE /collaborators and DELETE / (unshare)", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const spaceId = (body as { spaceId: string }).spaceId;

    const createLinkRes = await SELF.fetch(`https://example.com/api/v1/rooms/${spaceId}/links`, {
      method: "POST",
    });
    expect(createLinkRes.status).toBe(403);
    expect(await createLinkRes.json()).toEqual({ error: "not-a-shared-room" });

    const revokeLinksRes = await SELF.fetch(`https://example.com/api/v1/rooms/${spaceId}/links`, {
      method: "DELETE",
    });
    expect(revokeLinksRes.status).toBe(403);
    expect(await revokeLinksRes.json()).toEqual({ error: "not-a-shared-room" });

    const clearCollabRes = await SELF.fetch(`https://example.com/api/v1/rooms/${spaceId}/collaborators`, {
      method: "DELETE",
    });
    expect(clearCollabRes.status).toBe(403);
    expect(await clearCollabRes.json()).toEqual({ error: "not-a-shared-room" });

    const unshareRes = await SELF.fetch(`https://example.com/api/v1/rooms/${spaceId}`, {
      method: "DELETE",
    });
    expect(unshareRes.status).toBe(403);
    expect(await unshareRes.json()).toEqual({ error: "not-a-shared-room" });
  });

  it("a shared room refuses hello.auth.kind = 'personal'", async () => {
    const { roomId } = await createRoom();
    const jwt = await mintTestJwt(`user_${crypto.randomUUID()}`);
    const ws = await connectRoomSocket(roomId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "personal", jwt } });
    const closeEvent = await q.closeEvent();
    expect(closeEvent.code).toBe(4401);
  });

  it("a personal room refuses hello.auth.kind of owner/link/user", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const spaceId = (body as { spaceId: string }).spaceId;
    const jwt = await mintTestJwt(sub);

    const ownerWs = await connectRoomSocket(spaceId);
    const ownerQ = frameQueue(ownerWs);
    send(ownerWs, { t: "hello", auth: { kind: "owner", ownerToken: "whatever" } });
    expect((await ownerQ.closeEvent()).code).toBe(4401);

    const linkWs = await connectRoomSocket(spaceId);
    const linkQ = frameQueue(linkWs);
    send(linkWs, { t: "hello", auth: { kind: "link", linkSecret: "whatever" } });
    expect((await linkQ.closeEvent()).code).toBe(4401);

    const userWs = await connectRoomSocket(spaceId);
    const userQ = frameQueue(userWs);
    send(userWs, { t: "hello", auth: { kind: "user", jwt } });
    expect((await userQ.closeEvent()).code).toBe(4401);
  });

  it("a shared room refuses an announce/snapshot shaped like the personal workspace doc", async () => {
    const { roomId, ownerToken } = await createRoom();
    const ws = await connectRoomSocket(roomId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "owner", ownerToken } });
    await collectUntilSynced(q);

    send(ws, { t: "announce", docId: "workspace:root", kind: "workspace" });
    expect(await q.next()).toMatchObject({ t: "error", code: "bad-frame" });

    // Same rule even when only the docId matches, not the kind.
    send(ws, { t: "announce", docId: "workspace:root", kind: "notebook" });
    expect(await q.next()).toMatchObject({ t: "error", code: "bad-frame" });

    send(ws, { t: "snapshot", docId: "workspace:root", payload: textToBase64Url("x"), covers: 0 });
    expect(await q.next()).toMatchObject({ t: "error", code: "bad-frame" });

    // Socket must still be usable afterwards (non-fatal).
    send(ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    send(ws, { t: "append", docId: "doc-1", payload: textToBase64Url("ok") });
    expect(await q.next()).toMatchObject({ t: "seq", docId: "doc-1", seq: 1 });
  });
});

describe("PERSONAL-SYNC.md §3.3: the workspace doc in a personal room", () => {
  it("accepts announce kind:'workspace' only for docId 'workspace:root'", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const spaceId = (body as { spaceId: string }).spaceId;
    const jwt = await mintTestJwt(sub);
    const { ws, q } = await helloAsPersonal(spaceId, jwt);

    send(ws, { t: "announce", docId: "workspace:root", kind: "workspace" });
    send(ws, { t: "append", docId: "workspace:root", payload: textToBase64Url("wsdoc") });
    expect(await q.next()).toMatchObject({ t: "seq", docId: "workspace:root", seq: 1 });

    send(ws, { t: "announce", docId: "not-the-root", kind: "workspace" });
    expect(await q.next()).toMatchObject({ t: "error", code: "bad-frame" });
  });

  it("welcome.notebookTitle is '' in a personal room", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const spaceId = (body as { spaceId: string }).spaceId;
    const jwt = await mintTestJwt(sub);
    const { frames } = await helloAsPersonal(spaceId, jwt);
    expect(frames[0]).toMatchObject({ t: "welcome", role: "owner", notebookTitle: "" });
  });
});

describe("PERSONAL-SYNC.md §3.4: reauth", () => {
  it("closes 4401 when reauth resolves to a different sub", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const other = `user_other_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const spaceId = (body as { spaceId: string }).spaceId;
    const jwt = await mintTestJwt(sub);
    const { ws, q } = await helloAsPersonal(spaceId, jwt);

    const otherJwt = await mintTestJwt(other);
    send(ws, { t: "reauth", jwt: otherJwt });
    expect((await q.closeEvent()).code).toBe(4401);
  });

  it("extends the deadline and answers 'reauthed' for the same sub", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const spaceId = (body as { spaceId: string }).spaceId;
    const jwt = await mintTestJwt(sub);
    const { ws, q } = await helloAsPersonal(spaceId, jwt);

    const freshJwt = await mintTestJwt(sub);
    send(ws, { t: "reauth", jwt: freshJwt });
    const reauthed = await q.next();
    expect(reauthed.t).toBe("reauthed");
    expect(typeof reauthed.expiresAt).toBe("number");

    // The socket keeps working afterwards.
    send(ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    send(ws, { t: "append", docId: "doc-1", payload: textToBase64Url("still-writable") });
    expect(await q.next()).toMatchObject({ t: "seq", docId: "doc-1", seq: 1 });
  });

  it("is a non-fatal bad-frame on a shared-room (non-personal) socket", async () => {
    const { roomId, ownerToken } = await createRoom();
    const ws = await connectRoomSocket(roomId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "owner", ownerToken } });
    await collectUntilSynced(q);

    send(ws, { t: "reauth", jwt: "irrelevant" });
    expect(await q.next()).toMatchObject({ t: "error", code: "bad-frame" });

    // Socket still usable.
    send(ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    send(ws, { t: "append", docId: "doc-1", payload: textToBase64Url("ok") });
    expect(await q.next()).toMatchObject({ t: "seq", docId: "doc-1", seq: 1 });
  });
});

describe("PERSONAL-SYNC.md §9: isolation — the security-critical case", () => {
  it("two different subs get two different spaceIds and cannot read each other's docs, including a forged spaceId in the URL", async () => {
    const subA = `user_a_${crypto.randomUUID()}`;
    const subB = `user_b_${crypto.randomUUID()}`;
    const a = await createSpace(subA);
    const b = await createSpace(subB);
    const spaceIdA = (a.body as { spaceId: string }).spaceId;
    const spaceIdB = (b.body as { spaceId: string }).spaceId;
    expect(spaceIdA).not.toBe(spaceIdB);

    const jwtA = await mintTestJwt(subA);
    const { ws: wsA, q: qA } = await helloAsPersonal(spaceIdA, jwtA);
    send(wsA, { t: "announce", docId: "notebook:secret", kind: "notebook" });
    send(wsA, { t: "append", docId: "notebook:secret", payload: textToBase64Url("A's private content") });
    expect(await qA.next()).toMatchObject({ t: "seq", docId: "notebook:secret", seq: 1 });

    // B connects to its OWN space: sees nothing of A's.
    const jwtB = await mintTestJwt(subB);
    const { frames: framesB } = await helloAsPersonal(spaceIdB, jwtB);
    expect(framesB[0]).toMatchObject({ t: "welcome", docs: [] });

    // B attempts to reach A's space by forging the spaceId in the WS URL,
    // authenticating with B's own JWT. `resolveWsRole` compares the JWT's
    // sub against *that room's* `personalSub` (A's), which never matches.
    const forgedWs = await connectRoomSocket(spaceIdA);
    const forgedQ = frameQueue(forgedWs);
    send(forgedWs, { t: "hello", auth: { kind: "personal", jwt: jwtB } });
    expect((await forgedQ.closeEvent()).code).toBe(4401);
  });
});

describe("lazy replay and fetch (personal rooms)", () => {
  /** A space holding a workspace doc, a notebook and two pages, one of them with a later change. */
  async function seededSpace() {
    const sub = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const spaceId = (body as { spaceId: string }).spaceId;
    const jwt = await mintTestJwt(sub);
    const { ws, q } = await helloAsPersonal(spaceId, jwt);
    const docs: Array<[string, "workspace" | "notebook" | "page"]> = [
      ["workspace:root", "workspace"],
      ["notebook:n1", "notebook"],
      ["page:p1", "page"],
      ["page:p2", "page"],
    ];
    for (const [docId, kind] of docs) {
      send(ws, { t: "announce", docId, kind });
      send(ws, { t: "snapshot", docId, payload: textToBase64Url(`snapshot of ${docId}`), covers: 0 });
    }
    send(ws, { t: "append", docId: "page:p2", payload: textToBase64Url("change of p2") });
    expect(await q.next()).toMatchObject({ t: "seq", docId: "page:p2", seq: 1 });
    ws.close();
    return { spaceId, jwt };
  }

  it("replays everything but the pages the client holds nothing of when hello is lazy", async () => {
    const { spaceId, jwt } = await seededSpace();
    const ws = await connectRoomSocket(spaceId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "personal", jwt }, lazy: true });
    const frames = await collectUntilSynced(q);
    expect(frames[0]).toMatchObject({ t: "welcome", lazy: true });
    const welcome = frames[0] as { docs: Array<{ docId: string }> };
    expect(welcome.docs.map((doc) => doc.docId).sort()).toEqual(["notebook:n1", "page:p1", "page:p2", "workspace:root"]);
    const replayed = frames.filter((frame) => frame.t === "snapshot" || frame.t === "append").map((frame) => frame.docId);
    expect(replayed.sort()).toEqual(["notebook:n1", "workspace:root"]);
  });

  it("still replays a page the client resumes, from its seq", async () => {
    const { spaceId, jwt } = await seededSpace();
    const ws = await connectRoomSocket(spaceId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "personal", jwt }, lazy: true, since: { "page:p2": 0 } });
    const frames = await collectUntilSynced(q);
    const p2 = frames.filter((frame) => frame.docId === "page:p2");
    expect(p2.map((frame) => frame.t)).toEqual(["append"]);
  });

  it("does not claim lazy support for an ordinary hello, which replays every document", async () => {
    const { spaceId, jwt } = await seededSpace();
    const { frames } = await helloAsPersonal(spaceId, jwt);
    expect(frames[0]).not.toHaveProperty("lazy");
    const replayed = new Set(frames.filter((frame) => frame.t === "snapshot").map((frame) => frame.docId));
    expect(replayed).toEqual(new Set(["notebook:n1", "page:p1", "page:p2", "workspace:root"]));
  });

  it("answers a fetch with the documents' snapshots and changes, then fetched", async () => {
    const { spaceId, jwt } = await seededSpace();
    const ws = await connectRoomSocket(spaceId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "personal", jwt }, lazy: true });
    await collectUntilSynced(q);
    send(ws, { t: "fetch", id: "7", docIds: ["page:p2", "page:p1", "page:missing"] });
    const seen: Array<Record<string, unknown>> = [];
    for (;;) {
      const frame = await q.next();
      seen.push(frame);
      if (frame.t === "fetched") break;
    }
    expect(seen.map((frame) => [frame.t, frame.docId])).toEqual([
      ["snapshot", "page:p2"],
      ["append", "page:p2"],
      ["snapshot", "page:p1"],
      ["fetched", undefined],
    ]);
    expect(seen.at(-1)).toMatchObject({ id: "7", known: ["page:p2", "page:p1"] });
  });

  it("skips a snapshot the fetching client already holds", async () => {
    const { spaceId, jwt } = await seededSpace();
    const ws = await connectRoomSocket(spaceId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "personal", jwt }, lazy: true });
    await collectUntilSynced(q);
    send(ws, { t: "fetch", id: "1", docIds: ["page:p2"], since: { "page:p2": 0 } });
    const seen: string[] = [];
    for (;;) {
      const frame = await q.next();
      seen.push(String(frame.t));
      if (frame.t === "fetched") break;
    }
    expect(seen).toEqual(["append", "fetched"]);
  });

  it("rejects a malformed or oversized fetch without closing the socket", async () => {
    const { spaceId, jwt } = await seededSpace();
    const ws = await connectRoomSocket(spaceId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "personal", jwt }, lazy: true });
    await collectUntilSynced(q);
    send(ws, { t: "fetch", docIds: "page:p1" });
    expect(await q.next()).toMatchObject({ t: "error", code: "bad-frame", detail: "malformed fetch" });
    send(ws, { t: "fetch", docIds: Array.from({ length: 65 }, (_, index) => `page:${index}`) });
    expect(await q.next()).toMatchObject({ t: "error", code: "bad-frame", detail: "malformed fetch" });
    send(ws, { t: "ping" });
    expect(await q.next()).toMatchObject({ t: "pong" });
  });
});
