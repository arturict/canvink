import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  collectUntilSynced,
  connectRoomSocket,
  createLink,
  createRoom,
  frameQueue,
  mintTestJwt,
  mintTestJwtWithEmails,
  send,
  textToBase64Url,
} from "./helpers";

async function helloAsViewer(roomId: string, linkSecret: string) {
  const ws = await connectRoomSocket(roomId);
  const q = frameQueue(ws);
  send(ws, { t: "hello", auth: { kind: "link", linkSecret } });
  const frames = await collectUntilSynced(q);
  return { ws, q, frames };
}

async function helloAsOwner(roomId: string, ownerToken: string) {
  const ws = await connectRoomSocket(roomId);
  const q = frameQueue(ws);
  send(ws, { t: "hello", auth: { kind: "owner", ownerToken } });
  const frames = await collectUntilSynced(q);
  return { ws, q, frames };
}

describe("hello / welcome / catch-up", () => {
  it("grants viewer role for a link secret, then sends catch-up and synced", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);

    const { frames } = await helloAsViewer(roomId, linkSecret);
    expect(frames[0]).toMatchObject({ t: "welcome", role: "viewer", docs: [] });
    expect(frames.at(-1)).toEqual({ t: "synced" });
  });
});

describe("viewer write protection", () => {
  it("rejects append as read-only and does not persist it", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);

    // Owner announces + appends a doc first so it exists.
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    await new Promise((r) => setTimeout(r, 0));

    const viewer = await helloAsViewer(roomId, linkSecret);
    send(viewer.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("nope") });
    const err = await viewer.q.next();
    expect(err).toMatchObject({ t: "error", code: "read-only" });

    // Reconnect and confirm no change was persisted for doc-1.
    const check = await helloAsViewer(roomId, linkSecret);
    const catchUp = check.frames.filter((f) => f.docId === "doc-1");
    expect(catchUp).toEqual([]);
  });

  it("rejects snapshot/announce/remove as read-only too", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const viewer = await helloAsViewer(roomId, linkSecret);

    send(viewer.ws, { t: "announce", docId: "d", kind: "page" });
    expect(await viewer.q.next()).toMatchObject({ t: "error", code: "read-only" });

    send(viewer.ws, { t: "snapshot", docId: "d", payload: textToBase64Url("x"), covers: 0 });
    expect(await viewer.q.next()).toMatchObject({ t: "error", code: "read-only" });

    send(viewer.ws, { t: "remove", docId: "d" });
    expect(await viewer.q.next()).toMatchObject({ t: "error", code: "read-only" });
  });
});

describe("owner append + broadcast", () => {
  it("persists an append with an incrementing seq and broadcasts it live", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);

    const owner = await helloAsOwner(roomId, ownerToken);
    // Viewer must be connected before the announce so it observes the
    // live broadcast (not just catch-up on a later connection).
    const viewer = await helloAsViewer(roomId, linkSecret);

    send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    const announceFrame = await viewer.q.next();
    expect(announceFrame).toMatchObject({ t: "announce", docId: "doc-1" });

    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("change-1") });
    const appendFrame = await viewer.q.next();
    expect(appendFrame).toMatchObject({ t: "append", docId: "doc-1", seq: 1 });

    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("change-2") });
    const appendFrame2 = await viewer.q.next();
    expect(appendFrame2).toMatchObject({ t: "append", docId: "doc-1", seq: 2 });
  });

  it("rejects append for a doc that was never announced/created", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "append", docId: "ghost", payload: textToBase64Url("x") });
    expect(await owner.q.next()).toMatchObject({ t: "error", code: "unknown-doc" });
  });
});

describe("snapshot compaction", () => {
  it("drops covered changes so catch-up only replays what remains", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("c1") });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("c2") });
    send(owner.ws, {
      t: "snapshot",
      docId: "doc-1",
      payload: textToBase64Url("full-save-covering-2"),
      covers: 2,
    });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("c3") });

    // give the DO a tick to process the sequential sends
    await new Promise((r) => setTimeout(r, 20));

    const fresh = await connectRoomSocket(roomId);
    const q = frameQueue(fresh);
    send(fresh, { t: "hello", auth: { kind: "owner", ownerToken } });
    const frames = await collectUntilSynced(q);

    const snapshotFrames = frames.filter((f) => f.t === "snapshot");
    const appendFrames = frames.filter((f) => f.t === "append");

    expect(snapshotFrames).toHaveLength(1);
    expect(snapshotFrames[0]).toMatchObject({ docId: "doc-1", covers: 2 });
    // only the change after `covers` should remain
    expect(appendFrames).toHaveLength(1);
    expect(appendFrames[0]).toMatchObject({ docId: "doc-1", seq: 3 });
  });
});

describe("resume via since", () => {
  it("skips changes the client already has", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("c1") });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("c2") });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("c3") });
    await new Promise((r) => setTimeout(r, 20));

    const resumer = await connectRoomSocket(roomId);
    const q = frameQueue(resumer);
    send(resumer, {
      t: "hello",
      auth: { kind: "owner", ownerToken },
      since: { "doc-1": 2 },
    });
    const frames = await collectUntilSynced(q);
    const appendFrames = frames.filter((f) => f.t === "append");
    expect(appendFrames).toHaveLength(1);
    expect(appendFrames[0]).toMatchObject({ docId: "doc-1", seq: 3 });
  });
});

describe("Clerk test-shim + link → viewer, then registered collaborator reconnect", () => {
  it("grants viewer role (never editor) and registers the reader on jwt+linkSecret", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const jwt = await mintTestJwt("user_123");

    const ws = await connectRoomSocket(roomId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "user", jwt, linkSecret } });
    const frames = await collectUntilSynced(q);
    expect(frames[0]).toMatchObject({ t: "welcome", role: "viewer" });
  });

  it("lets a registered link reader reconnect with just the JWT and keeps them a viewer", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const jwt = await mintTestJwt("user_456");

    const first = await connectRoomSocket(roomId);
    const q1 = frameQueue(first);
    send(first, { t: "hello", auth: { kind: "user", jwt, linkSecret } });
    await collectUntilSynced(q1);

    const second = await connectRoomSocket(roomId);
    const q2 = frameQueue(second);
    send(second, { t: "hello", auth: { kind: "user", jwt } });
    const frames = await collectUntilSynced(q2);
    expect(frames[0]).toMatchObject({ t: "welcome", role: "viewer" });
  });

  it("makes an editor of an account invited by e-mail, who then writes", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    const invite = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/invites`, {
      method: "POST",
      headers: { Authorization: `Owner ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "editor@example.test", role: "editor" }),
    });
    expect(invite.status).toBe(201);

    const jwt = await mintTestJwtWithEmails("user_editor", ["editor@example.test"]);
    const ws = await connectRoomSocket(roomId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "user", jwt } });
    const frames = await collectUntilSynced(q);
    expect(frames[0]).toMatchObject({ t: "welcome", role: "editor" });

    send(ws, { t: "append", docId: "doc-1", payload: textToBase64Url("edit") });
    expect(await q.next()).toEqual({ t: "seq", docId: "doc-1", seq: 1 });
  });

  it("does not grant editor to an unregistered JWT without a link secret", async () => {
    const { roomId } = await createRoom();
    const jwt = await mintTestJwt("stranger");

    const ws = await connectRoomSocket(roomId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "user", jwt } });
    const closeEvent = await q.closeEvent();
    expect(closeEvent.code).toBe(4401);
  });
});

describe("oversized frames", () => {
  it("rejects a frame larger than the 16 MiB limit", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await helloAsOwner(roomId, ownerToken);
    const huge = "x".repeat(17 * 1024 * 1024);
    send(owner.ws, { t: "append", docId: "doc-1", payload: huge });
    expect(await owner.q.next()).toMatchObject({ t: "error", code: "payload-too-large" });
  });
});

describe("B1c: append ack drives client-side compaction", () => {
  it("acks the sender only (never broadcast) with the assigned seq", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const owner = await helloAsOwner(roomId, ownerToken);
    const viewer = await helloAsViewer(roomId, linkSecret);

    send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    await viewer.q.next(); // announce broadcast

    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("c1") });
    const ack = await owner.q.next();
    expect(ack).toEqual({ t: "seq", docId: "doc-1", seq: 1 });

    const broadcast = await viewer.q.next();
    expect(broadcast).toMatchObject({ t: "append", docId: "doc-1", seq: 1 });
    expect(broadcast.t).not.toBe("seq");
  });
});

describe("B1a: reconnect data loss fix — catch-up skip rule", () => {
  it("skips resending the snapshot when the client's since already reaches covers", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("c1") });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("c2") });
    send(owner.ws, {
      t: "snapshot",
      docId: "doc-1",
      payload: textToBase64Url("full-save-covering-2"),
      covers: 2,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Reconnecting with since >= covers must NOT receive the snapshot again
    // (previously it always did — B1's reconnect data-loss root cause,
    // since the client would then replace its live doc with it).
    const caughtUp = await connectRoomSocket(roomId);
    const q = frameQueue(caughtUp);
    send(caughtUp, { t: "hello", auth: { kind: "owner", ownerToken }, since: { "doc-1": 2 } });
    const frames = await collectUntilSynced(q);
    expect(frames.filter((f) => f.t === "snapshot")).toHaveLength(0);
    expect(frames.filter((f) => f.t === "append")).toHaveLength(0);

    // A client behind covers still gets the snapshot.
    const behind = await connectRoomSocket(roomId);
    const q2 = frameQueue(behind);
    send(behind, { t: "hello", auth: { kind: "owner", ownerToken }, since: { "doc-1": 0 } });
    const frames2 = await collectUntilSynced(q2);
    expect(frames2.filter((f) => f.t === "snapshot")).toHaveLength(1);
  });

  it("still sends the snapshot to a brand-new joiner even when covers is 0 (no since entry at all)", async () => {
    // Regression guard: `covers` defaults to 0 for any never-compacted doc,
    // which must not be conflated with "the client already has covers=0
    // worth of state" for a client that has simply never seen the doc.
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });
    send(owner.ws, {
      t: "snapshot",
      docId: "doc-1",
      payload: textToBase64Url("initial-share-snapshot"),
      covers: 0,
    });
    await new Promise((r) => setTimeout(r, 20));

    const viewer = await helloAsViewer(roomId, linkSecret);
    expect(viewer.frames.filter((f) => f.t === "snapshot")).toHaveLength(1);
  });
});

describe("D1: allow-list role checks", () => {
  it("still denies writes for any non-owner/non-editor role (regression guard for the deny-list flip)", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const viewer = await helloAsViewer(roomId, linkSecret);
    send(viewer.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("x") });
    expect(await viewer.q.next()).toMatchObject({ t: "error", code: "read-only" });
  });
});

describe("D6: frame validation and wedged-socket protection", () => {
  it("answers and closes an authless hello instead of leaving the socket hanging", async () => {
    const { roomId } = await createRoom();
    const ws = await connectRoomSocket(roomId);
    const q = frameQueue(ws);
    send(ws, { t: "hello" });
    const err = await q.next();
    expect(err).toMatchObject({ t: "error", code: "bad-frame" });
    const closeEvent = await q.closeEvent();
    expect(closeEvent.code).toBe(4400);
  });

  it("rejects an append with invalid base64 as a non-fatal bad-frame and keeps the socket usable", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });

    send(owner.ws, { t: "append", docId: "doc-1", payload: "not base64url!!" });
    expect(await owner.q.next()).toMatchObject({ t: "error", code: "bad-frame" });

    // socket must still be usable afterwards
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("ok") });
    expect(await owner.q.next()).toMatchObject({ t: "seq", docId: "doc-1", seq: 1 });
  });
});
