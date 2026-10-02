import { describe, expect, it } from "vitest";
import { PRESENCE_BURST, PRESENCE_REFILL_PER_SECOND } from "../src/types";
import {
  collectUntilSynced,
  connectRoomSocket,
  createLink,
  createRoom,
  frameQueue,
  send,
  textToBase64Url,
} from "./helpers";

type Queue = ReturnType<typeof frameQueue>;

async function join(roomId: string, auth: Record<string, unknown>) {
  const ws = await connectRoomSocket(roomId);
  const q = frameQueue(ws);
  send(ws, { t: "hello", auth });
  const frames = await collectUntilSynced(q);
  return { ws, q, frames };
}

/** Next frame whose type is `t`, skipping anything else; fails after `ms`. */
async function nextOfType(q: Queue, t: string, ms = 2000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`no ${t} frame within ${ms}ms`);
    const frame = await Promise.race([
      q.next(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ]);
    if (frame === null) throw new Error(`no ${t} frame within ${ms}ms`);
    if (frame.t === t) return frame;
  }
}

/** Resolves `true` when no frame of type `t` arrives within `ms`. */
async function noFrameOfType(q: Queue, t: string, ms = 300): Promise<boolean> {
  try {
    await nextOfType(q, t, ms);
    return false;
  } catch {
    return true;
  }
}

describe("presence relay", () => {
  it("relays a presence state to the other sockets with a connection id and role, never back to the sender", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const owner = await join(roomId, { kind: "owner", ownerToken });
    const viewer = await join(roomId, { kind: "link", linkSecret });

    send(owner.ws, { t: "presence", state: { v: 1, page: "p1", cursor: [10, 20] } });
    const relayed = await nextOfType(viewer.q, "presence");
    expect(relayed).toMatchObject({ t: "presence", role: "owner", state: { v: 1, page: "p1", cursor: [10, 20] } });
    expect(typeof relayed.from).toBe("string");
    expect(await noFrameOfType(owner.q, "presence")).toBe(true);
  });

  it("lets a viewer publish presence, stamped with the viewer role", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const owner = await join(roomId, { kind: "owner", ownerToken });
    const viewer = await join(roomId, { kind: "link", linkSecret });

    send(viewer.ws, { t: "presence", state: { v: 1, cursor: [1, 2] } });
    expect(await nextOfType(owner.q, "presence")).toMatchObject({ role: "viewer", state: { cursor: [1, 2] } });
  });

  it("replays the latest presence of live sockets to a socket that joins later, and nothing of closed ones", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const owner = await join(roomId, { kind: "owner", ownerToken });
    const gone = await join(roomId, { kind: "link", linkSecret });
    send(owner.ws, { t: "presence", state: { v: 1, page: "first" } });
    send(owner.ws, { t: "presence", state: { v: 1, page: "second" } });
    send(gone.ws, { t: "presence", state: { v: 1, page: "gone" } });
    await nextOfType(gone.q, "presence");
    await nextOfType(owner.q, "presence");
    gone.ws.close();
    await nextOfType(owner.q, "presence-leave");

    const late = await join(roomId, { kind: "link", linkSecret });
    const replayed = await nextOfType(late.q, "presence");
    expect(replayed).toMatchObject({ role: "owner", state: { page: "second" } });
    expect(await noFrameOfType(late.q, "presence")).toBe(true);
  });

  it("announces presence-leave with the same connection id when a socket closes", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const owner = await join(roomId, { kind: "owner", ownerToken });
    const viewer = await join(roomId, { kind: "link", linkSecret });
    send(viewer.ws, { t: "presence", state: { v: 1 } });
    const relayed = await nextOfType(owner.q, "presence");
    viewer.ws.close();
    expect(await nextOfType(owner.q, "presence-leave")).toEqual({ t: "presence-leave", from: relayed.from });
  });

  it("never stores presence as a document change", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await join(roomId, { kind: "owner", ownerToken });
    send(owner.ws, { t: "announce", docId: "doc-1", kind: "page" });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("change") });
    await nextOfType(owner.q, "seq");
    send(owner.ws, { t: "presence", state: { v: 1, page: "doc-1" } });

    const again = await join(roomId, { kind: "owner", ownerToken });
    const appends = again.frames.filter((frame) => frame.t === "append");
    expect(appends).toHaveLength(1);
  });

  it("rejects an oversized or malformed presence state without closing the socket", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await join(roomId, { kind: "owner", ownerToken });
    send(owner.ws, { t: "presence", state: { blob: "x".repeat(20 * 1024) } });
    expect(await nextOfType(owner.q, "error")).toMatchObject({ code: "payload-too-large" });
    send(owner.ws, { t: "presence", state: [1, 2] });
    expect(await nextOfType(owner.q, "error")).toMatchObject({ code: "bad-frame" });
    send(owner.ws, { t: "ping" });
    expect(await nextOfType(owner.q, "pong")).toEqual({ t: "pong" });
  });

  it("drops presence frames past the per-socket budget instead of relaying a flood", async () => {
    const { roomId, ownerToken } = await createRoom();
    const { linkSecret } = await createLink(roomId, ownerToken);
    const owner = await join(roomId, { kind: "owner", ownerToken });
    const viewer = await join(roomId, { kind: "link", linkSecret });
    const flooded = 200;
    const startedAt = Date.now();
    for (let index = 0; index < flooded; index += 1) {
      send(owner.ws, { t: "presence", state: { v: 1, n: index } });
    }
    // The room handles one socket's frames in order and relays them to the
    // viewer in order, so an announce sent after the flood arrives after every
    // presence frame that was relayed. Counting up to it needs no quiet period.
    send(owner.ws, { t: "announce", docId: "doc-1", kind: "page" });
    let relayed = 0;
    for (;;) {
      const frame = await viewer.q.next();
      if (frame.t === "announce") break;
      if (frame.t === "presence") relayed += 1;
    }
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    // The bucket refills against the wall clock, so on a loaded machine the
    // flood may take long enough to earn extra tokens. The budget is the burst
    // plus what the elapsed time refills, so the upper bound scales with it.
    const allowed = Math.ceil(PRESENCE_BURST + elapsedSeconds * PRESENCE_REFILL_PER_SECOND) + 1;
    expect(relayed).toBeLessThanOrEqual(Math.min(allowed, flooded));
    expect(relayed).toBeGreaterThanOrEqual(PRESENCE_BURST);
    if (allowed < flooded) expect(relayed).toBeLessThan(flooded);
  });
});

describe("broadcast scope", () => {
  it("does not send live changes or presence to a socket that never completed hello", async () => {
    const { roomId, ownerToken } = await createRoom();
    const owner = await join(roomId, { kind: "owner", ownerToken });
    const lurker = await connectRoomSocket(roomId);
    const lurkerQueue = frameQueue(lurker);

    send(owner.ws, { t: "announce", docId: "doc-1", kind: "page" });
    send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("secret") });
    send(owner.ws, { t: "presence", state: { v: 1 } });
    await nextOfType(owner.q, "seq");

    expect(await noFrameOfType(lurkerQueue, "announce", 200)).toBe(true);
  });
});
