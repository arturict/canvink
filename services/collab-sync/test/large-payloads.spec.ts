// Payloads above one SQLite row (2 MB) are chunked in Durable Object storage:
// a heavy page's snapshot must survive a reconnect byte for byte.
import { describe, expect, it } from "vitest";
import {
  collectUntilSynced,
  connectRoomSocket,
  createRoom,
  createSpace,
  frameQueue,
  mintTestJwt,
  send,
} from "./helpers";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues is capped at 64 KiB per call.
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

async function helloAsOwner(roomId: string, ownerToken: string) {
  const ws = await connectRoomSocket(roomId);
  const q = frameQueue(ws);
  send(ws, { t: "hello", auth: { kind: "owner", ownerToken } });
  const frames = await collectUntilSynced(q);
  return { ws, q, frames };
}

async function nextOfType(q: ReturnType<typeof frameQueue>, type: string) {
  for (;;) {
    const frame = await q.next();
    if (frame.t === type) return frame;
  }
}

describe("large snapshots and changes", () => {
  it("stores a 5 MB snapshot and a 3 MB change chunked and replays them intact", async () => {
    const { roomId, ownerToken } = await createRoom();
    const snapshot = randomBytes(5 * 1024 * 1024);
    const change = randomBytes(3 * 1024 * 1024);
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "announce", docId: "page-1", kind: "page" });
    send(owner.ws, { t: "snapshot", docId: "page-1", payload: toBase64Url(snapshot), covers: 0 });
    send(owner.ws, { t: "append", docId: "page-1", payload: toBase64Url(change) });
    expect(await nextOfType(owner.q, "seq")).toMatchObject({ docId: "page-1", seq: 1 });

    const again = await helloAsOwner(roomId, ownerToken);
    const snap = again.frames.find((f) => f.t === "snapshot");
    const app = again.frames.find((f) => f.t === "append");
    expect(snap?.payload).toBe(toBase64Url(snapshot));
    expect(app?.payload).toBe(toBase64Url(change));
  });

  it("replaces a chunked snapshot on compaction and drops the compacted chunked change", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await helloAsOwner(roomId, ownerToken);
    send(owner.ws, { t: "announce", docId: "page-1", kind: "page" });
    send(owner.ws, { t: "snapshot", docId: "page-1", payload: toBase64Url(randomBytes(4_000_000)), covers: 0 });
    send(owner.ws, { t: "append", docId: "page-1", payload: toBase64Url(randomBytes(2_500_000)) });
    await nextOfType(owner.q, "seq");
    const compacted = randomBytes(1_200_000);
    send(owner.ws, { t: "snapshot", docId: "page-1", payload: toBase64Url(compacted), covers: 1 });
    send(owner.ws, { t: "append", docId: "page-1", payload: toBase64Url(new Uint8Array([1, 2, 3])) });
    expect(await nextOfType(owner.q, "seq")).toMatchObject({ seq: 2 });

    const again = await helloAsOwner(roomId, ownerToken);
    expect(again.frames.find((f) => f.t === "snapshot")?.payload).toBe(toBase64Url(compacted));
    const appends = again.frames.filter((f) => f.t === "append");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ seq: 2, payload: toBase64Url(new Uint8Array([1, 2, 3])) });
  });

  it("keeps the personal space log counter in step across chunked writes and removal", async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const spaceId = (body as { spaceId: string }).spaceId;
    const jwt = await mintTestJwt(sub);
    const ws = await connectRoomSocket(spaceId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "personal", jwt } });
    await collectUntilSynced(q);
    send(ws, { t: "announce", docId: "page-1", kind: "page" });
    send(ws, { t: "snapshot", docId: "page-1", payload: toBase64Url(randomBytes(3_000_000)), covers: 0 });
    send(ws, { t: "snapshot", docId: "page-1", payload: toBase64Url(randomBytes(2_000_000)), covers: 0 });
    send(ws, { t: "remove", docId: "page-1" });
    send(ws, { t: "announce", docId: "page-2", kind: "page" });
    send(ws, { t: "snapshot", docId: "page-2", payload: toBase64Url(new Uint8Array([9])), covers: 0 });
    await new Promise((r) => setTimeout(r, 200));

    const again = await connectRoomSocket(spaceId);
    const q2 = frameQueue(again);
    send(again, { t: "hello", auth: { kind: "personal", jwt } });
    const frames = await collectUntilSynced(q2);
    expect(frames.find((f) => f.t === "welcome")?.docs).toEqual([{ docId: "page-2", kind: "page" }]);
    expect(frames.filter((f) => f.t === "snapshot")).toHaveLength(1);
  });

  it("holds a few hundred documents in one personal space", { timeout: 60_000 }, async () => {
    const sub = `user_${crypto.randomUUID()}`;
    const { body } = await createSpace(sub);
    const spaceId = (body as { spaceId: string }).spaceId;
    const jwt = await mintTestJwt(sub);
    const ws = await connectRoomSocket(spaceId);
    const q = frameQueue(ws);
    send(ws, { t: "hello", auth: { kind: "personal", jwt } });
    await collectUntilSynced(q);
    for (let i = 0; i < 400; i += 1) {
      send(ws, { t: "announce", docId: `page-${i}`, kind: "page" });
      send(ws, { t: "snapshot", docId: `page-${i}`, payload: toBase64Url(randomBytes(20_000)), covers: 0 });
    }
    await new Promise((r) => setTimeout(r, 500));

    const again = await connectRoomSocket(spaceId);
    const q2 = frameQueue(again);
    send(again, { t: "hello", auth: { kind: "personal", jwt } });
    const frames = await collectUntilSynced(q2);
    expect(frames.filter((f) => f.t === "snapshot")).toHaveLength(400);
  });
});
