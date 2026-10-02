// Per-person sharing roles: owner, admin, editor, viewer ("Lesen"), link access (always a reader),
// invitations by verified e-mail address, the invitation inbox, live role changes and migration.
// All identities and addresses are synthetic.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifiedEmailsFor } from "../src/auth/emails";
import type { Env, MemberRole } from "../src/types";
import {
  collectUntilSynced,
  connectRoomSocket,
  createLink,
  createRoom,
  frameQueue,
  mintTestJwt,
  mintTestJwtWithEmails,
  send,
  sha256HexOf,
  textToBase64Url,
} from "./helpers";

const BASE = "https://example.com";
type Frame = Record<string, unknown>;
type Queue = ReturnType<typeof frameQueue>;
type Cred = { owner?: string; jwt?: string; link?: string };
interface SchemaRunner {
  ensureSchema(): void;
}
interface RoomWithEnv {
  env: Env;
}

/** The room instance `runInDurableObject` hands over, narrowed to the one private member a test reaches for. */
function schemaRunner(instance: unknown): SchemaRunner {
  if (typeof instance === "object" && instance !== null && "ensureSchema" in instance && typeof instance.ensureSchema === "function") {
    return instance as SchemaRunner;
  }
  throw new Error("not a NotebookRoom");
}
function roomEnv(instance: unknown): Env {
  if (typeof instance === "object" && instance !== null && "env" in instance) return (instance as RoomWithEnv).env;
  throw new Error("not a NotebookRoom");
}

// ---- helpers -------------------------------------------------------------

function authHeaders(cred: Cred): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cred.owner) headers.Authorization = `Owner ${cred.owner}`;
  if (cred.jwt) headers.Authorization = `Bearer ${cred.jwt}`;
  if (cred.link) headers["X-Link-Secret"] = cred.link;
  return headers;
}

function call(roomId: string, method: string, path: string, cred: Cred, body?: unknown): Promise<Response> {
  const headers = authHeaders(cred);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return SELF.fetch(`${BASE}/api/v1/rooms/${roomId}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function connectAs(roomId: string, auth: Frame, extra: Frame = {}) {
  const ws = await connectRoomSocket(roomId);
  const q = frameQueue(ws);
  send(ws, { t: "hello", auth, ...extra });
  const frames = await collectUntilSynced(q);
  return { ws, q, frames };
}

/** The hello is refused: the socket is closed with 4401. */
async function expectRefused(roomId: string, auth: Frame, extra: Frame = {}): Promise<void> {
  const ws = await connectRoomSocket(roomId);
  const q = frameQueue(ws);
  send(ws, { t: "hello", auth, ...extra });
  expect((await q.closeEvent()).code).toBe(4401);
}

async function nextOfType(q: Queue, t: string, ms = 2000): Promise<Frame> {
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

async function noFrameOfType(q: Queue, t: string, ms = 300): Promise<boolean> {
  try {
    await nextOfType(q, t, ms);
    return false;
  } catch {
    return true;
  }
}

/** A room with `doc-1` announced and one change stored; the link is on unless `link: false`. */
async function newRoom(opts: { link?: boolean } = {}) {
  const { roomId, ownerToken } = await createRoom();
  const linkSecret = opts.link === false ? "" : (await createLink(roomId, ownerToken)).linkSecret;
  const owner = await connectAs(roomId, { kind: "owner", ownerToken });
  send(owner.ws, { t: "announce", docId: "doc-1", kind: "notebook" });
  send(owner.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("base") });
  expect(await nextOfType(owner.q, "seq")).toEqual({ t: "seq", docId: "doc-1", seq: 1 });
  owner.ws.close();
  return { roomId, ownerToken, linkSecret };
}
type Room = Awaited<ReturnType<typeof newRoom>>;

interface Person {
  sub: string;
  email: string;
  jwt: string;
}

async function person(label: string, extraEmails: string[] = []): Promise<Person> {
  const id = crypto.randomUUID().slice(0, 8);
  const sub = `user_${label}_${id}`;
  const email = `${label}-${id}@example.test`;
  return { sub, email, jwt: await mintTestJwtWithEmails(sub, [email, ...extraEmails], `Name ${label}`) };
}

function invite(room: Room, email: unknown, role: unknown): Promise<Response> {
  return call(room.roomId, "POST", "/invites", { owner: room.ownerToken }, { email, role });
}

/** Invites a new person by address, has them sign in, and returns them with their open socket. */
async function member(room: Room, role: MemberRole, label: string = role) {
  const who = await person(label);
  expect((await invite(room, who.email, role)).status).toBe(201);
  const conn = await connectAs(room.roomId, { kind: "user", jwt: who.jwt });
  expect(conn.frames[0]).toMatchObject({ t: "welcome", role });
  return { ...who, ...conn };
}

/** The reader kinds that must all be refused every write. */
const readerKinds: [string, (room: Room) => Promise<{ ws: WebSocket; q: Queue; frames: Frame[] }>][] = [
  ["an anonymous link reader", (room) => connectAs(room.roomId, { kind: "link", linkSecret: room.linkSecret })],
  [
    "a signed-in link reader",
    async (room) => {
      const who = await person("linkreader");
      return connectAs(room.roomId, { kind: "user", jwt: who.jwt, linkSecret: room.linkSecret });
    },
  ],
  ["a reader invited by e-mail", (room) => member(room, "viewer")],
];

async function membersOf(room: Room): Promise<{
  you: { role: string; sub?: string };
  owner: { name?: string; email?: string };
  members: { sub: string; role: string; via: string; name?: string; email?: string }[];
  invites: { email: string; role: string }[];
  link: { enabled: boolean; linkSecret: string | null };
}> {
  const res = await call(room.roomId, "GET", "/members", { owner: room.ownerToken });
  expect(res.status).toBe(200);
  return res.json();
}

/** What the room stores, as a fresh owner connection sees it. */
async function storedState(room: Room): Promise<{ docs: unknown; changes: Frame[] }> {
  const { ws, frames } = await connectAs(room.roomId, { kind: "owner", ownerToken: room.ownerToken });
  ws.close();
  return {
    docs: frames[0]?.docs,
    changes: frames.filter((f) => f.t === "append" || f.t === "snapshot"),
  };
}

async function putAsset(room: Room, cred: Cred): Promise<Response> {
  const bytes = crypto.getRandomValues(new Uint8Array(128));
  const hex = await sha256HexOf(bytes);
  return SELF.fetch(`${BASE}/api/v1/rooms/${room.roomId}/assets/${hex}`, {
    method: "PUT",
    headers: { ...authHeaders(cred), "Content-Type": "application/octet-stream" },
    body: bytes,
  });
}

async function invitationsFor(jwt: string): Promise<{ roomId: string; notebookTitle: string; role: string }[]> {
  const res = await SELF.fetch(`${BASE}/api/v1/me/invitations`, { headers: { Authorization: `Bearer ${jwt}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { invitations: { roomId: string; notebookTitle: string; role: string }[] }).invitations;
}

function declineInvitation(jwt: string, roomId: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/v1/me/invitations/${roomId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

// ---- readers cannot write --------------------------------------------------

describe.each(readerKinds)("%s", (_name, join) => {
  it("is a viewer and every write frame is rejected as read-only without storing anything", async () => {
    const room = await newRoom();
    const before = await storedState(room);
    const reader = await join(room);
    expect(reader.frames[0]).toMatchObject({ t: "welcome", role: "viewer" });

    send(reader.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("nope") });
    expect(await nextOfType(reader.q, "error")).toMatchObject({ code: "read-only" });
    send(reader.ws, { t: "snapshot", docId: "doc-1", payload: textToBase64Url("nope"), covers: 1 });
    expect(await nextOfType(reader.q, "error")).toMatchObject({ code: "read-only" });
    send(reader.ws, { t: "announce", docId: "doc-2", kind: "page" });
    expect(await nextOfType(reader.q, "error")).toMatchObject({ code: "read-only" });
    send(reader.ws, { t: "remove", docId: "doc-1" });
    expect(await nextOfType(reader.q, "error")).toMatchObject({ code: "read-only" });

    expect(await storedState(room)).toEqual(before);
  });

  it("has its presence ink stripped while the pointer is relayed", async () => {
    const room = await newRoom();
    const owner = await connectAs(room.roomId, { kind: "owner", ownerToken: room.ownerToken });
    const reader = await join(room);
    send(reader.ws, { t: "presence", state: { v: 1, page: "p1", cursor: [3, 4], ink: { points: [[1, 1]] } } });
    const relayed = await nextOfType(owner.q, "presence");
    expect(relayed).toMatchObject({ role: "viewer", state: { page: "p1", cursor: [3, 4], ink: null } });
  });
});

describe("a reader over HTTP", () => {
  it("cannot store a room asset (403) with an account token, the link secret or as an invited viewer", async () => {
    const room = await newRoom();
    const linkReader = await person("assetlink");
    await connectAs(room.roomId, { kind: "user", jwt: linkReader.jwt, linkSecret: room.linkSecret });
    const invited = await member(room, "viewer");
    expect((await putAsset(room, { jwt: linkReader.jwt })).status).toBe(403);
    expect((await putAsset(room, { jwt: invited.jwt })).status).toBe(403);
    expect((await putAsset(room, { link: room.linkSecret })).status).toBe(403);
    expect((await putAsset(room, { owner: room.ownerToken })).status).toBe(201);
  });

  it("is refused every management route with 403, with an account token or the link secret", async () => {
    const room = await newRoom();
    const reader = await person("httpreader");
    await connectAs(room.roomId, { kind: "user", jwt: reader.jwt, linkSecret: room.linkSecret });
    const targets: [string, string, unknown?][] = [
      ["GET", "/members"],
      ["POST", "/invites", { email: "x@example.test", role: "viewer" }],
      ["DELETE", "/invites/x%40example.test"],
      ["PATCH", `/members/${reader.sub}`, { role: "admin" }],
      ["DELETE", `/members/${reader.sub}`],
      ["GET", "/link"],
      ["PUT", "/link", { enabled: false }],
      ["POST", "/link/regenerate"],
      ["POST", "/links"],
    ];
    for (const [method, path, body] of targets) {
      for (const cred of [{ jwt: reader.jwt }, { link: room.linkSecret }]) {
        const res = await call(room.roomId, method, path, cred, body);
        expect(res.status, `${method} ${path} ${Object.keys(cred)[0]}`).toBe(403);
      }
    }
    expect((await membersOf(room)).members.find((m) => m.sub === reader.sub)).toMatchObject({ role: "viewer" });
  });
});

// ---- link access is never more than a reader ------------------------------------

describe("link access", () => {
  it("never grants more than viewer, whatever role hints the client sends", async () => {
    const room = await newRoom();
    const who = await person("hinter");
    const conn = await connectAs(
      room.roomId,
      { kind: "user", jwt: who.jwt, linkSecret: room.linkSecret, role: "editor", asRole: "admin" },
      { role: "admin", requestedRole: "owner" },
    );
    expect(conn.frames[0]).toMatchObject({ t: "welcome", role: "viewer" });
    send(conn.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("x"), role: "editor" });
    expect(await nextOfType(conn.q, "error")).toMatchObject({ code: "read-only" });
  });

  it("the link secret header reads as a viewer", async () => {
    const room = await newRoom();
    const meta = await call(room.roomId, "GET", "/meta", { link: room.linkSecret });
    expect(await meta.json()).toMatchObject({ role: "viewer" });
  });

  it("a new room starts with the link off; turning it on lets readers in", async () => {
    const { roomId, ownerToken } = await createRoom();
    const off = await call(roomId, "GET", "/link", { owner: ownerToken });
    expect(await off.json()).toMatchObject({ enabled: false });
    const on = await call(roomId, "PUT", "/link", { owner: ownerToken }, { enabled: true });
    const { enabled, linkSecret } = (await on.json()) as { enabled: boolean; linkSecret: string };
    expect(enabled).toBe(true);
    const reader = await connectAs(roomId, { kind: "link", linkSecret });
    expect(reader.frames[0]).toMatchObject({ role: "viewer" });
  });

  it("PUT /link needs a boolean", async () => {
    const room = await newRoom();
    const res = await call(room.roomId, "PUT", "/link", { owner: room.ownerToken }, { enabled: "no" });
    expect(res.status).toBe(400);
  });

  it("turning the link off closes link readers and refuses new link joins, but keeps people invited by name", async () => {
    const room = await newRoom();
    const anonymous = await connectAs(room.roomId, { kind: "link", linkSecret: room.linkSecret });
    const signedIn = await person("signedlink");
    const linkUser = await connectAs(room.roomId, { kind: "user", jwt: signedIn.jwt, linkSecret: room.linkSecret });
    const named = await member(room, "editor");
    const namedViewer = await member(room, "viewer");

    const res = await call(room.roomId, "PUT", "/link", { owner: room.ownerToken }, { enabled: false });
    expect(await res.json()).toMatchObject({ enabled: false });

    expect((await anonymous.q.closeEvent()).code).toBe(4401);
    expect((await linkUser.q.closeEvent()).code).toBe(4401);
    await expectRefused(room.roomId, { kind: "link", linkSecret: room.linkSecret });
    await expectRefused(room.roomId, { kind: "user", jwt: (await person("late")).jwt, linkSecret: room.linkSecret });
    expect((await call(room.roomId, "GET", "/meta", { link: room.linkSecret })).status).toBe(401);
    // The former link user's registration is gone as well.
    await expectRefused(room.roomId, { kind: "user", jwt: signedIn.jwt });

    // The named members stay connected and keep their roles.
    send(named.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("still here") });
    expect(await nextOfType(named.q, "seq")).toMatchObject({ seq: 2 });
    send(namedViewer.ws, { t: "presence", state: { v: 1 } });
    expect(await noFrameOfType(namedViewer.q, "error")).toBe(true);
    const again = await connectAs(room.roomId, { kind: "user", jwt: named.jwt });
    expect(again.frames[0]).toMatchObject({ role: "editor" });
  });

  it("a link reader promoted by name survives the link being turned off", async () => {
    const room = await newRoom();
    const who = await person("promoted");
    const conn = await connectAs(room.roomId, { kind: "user", jwt: who.jwt, linkSecret: room.linkSecret });
    const patch = await call(room.roomId, "PATCH", `/members/${who.sub}`, { owner: room.ownerToken }, { role: "editor" });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ role: "editor", via: "invite" });
    await nextOfType(conn.q, "role");
    await call(room.roomId, "PUT", "/link", { owner: room.ownerToken }, { enabled: false });
    expect((await connectAs(room.roomId, { kind: "user", jwt: who.jwt })).frames[0]).toMatchObject({ role: "editor" });
  });

  it("regenerating refuses the old secret, accepts the new one and leaves named members alone", async () => {
    const room = await newRoom();
    const named = await member(room, "editor");
    const oldReader = await connectAs(room.roomId, { kind: "link", linkSecret: room.linkSecret });

    const res = await call(room.roomId, "POST", "/link/regenerate", { owner: room.ownerToken });
    expect(res.status).toBe(201);
    const { linkSecret: fresh, enabled } = (await res.json()) as { linkSecret: string; enabled: boolean };
    expect(enabled).toBe(true);
    expect(fresh).not.toBe(room.linkSecret);

    expect((await oldReader.q.closeEvent()).code).toBe(4401);
    await expectRefused(room.roomId, { kind: "link", linkSecret: room.linkSecret });
    expect((await connectAs(room.roomId, { kind: "link", linkSecret: fresh })).frames[0]).toMatchObject({ role: "viewer" });
    expect(await (await call(room.roomId, "GET", "/link", { owner: room.ownerToken })).json()).toEqual({
      enabled: true,
      linkSecret: fresh,
    });

    send(named.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("fine") });
    expect(await nextOfType(named.q, "seq")).toMatchObject({ seq: 2 });
  });
});

// ---- editors cannot escalate -------------------------------------------------------

describe("an editor", () => {
  it("writes, but cannot invite, change roles, remove people, switch the link or promote themselves", async () => {
    const room = await newRoom();
    const editor = await member(room, "editor");
    const other = await member(room, "viewer");

    send(editor.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("edit") });
    expect(await nextOfType(editor.q, "seq")).toMatchObject({ seq: 2 });
    expect((await putAsset(room, { jwt: editor.jwt })).status).toBe(201);

    const cred = { jwt: editor.jwt };
    const attempts: [string, string, unknown?][] = [
      ["GET", "/members"],
      ["POST", "/invites", { email: "new@example.test", role: "viewer" }],
      ["DELETE", "/invites/new%40example.test"],
      ["PATCH", `/members/${editor.sub}`, { role: "admin" }],
      ["PATCH", `/members/${other.sub}`, { role: "admin" }],
      ["DELETE", `/members/${other.sub}`],
      ["GET", "/link"],
      ["PUT", "/link", { enabled: false }],
      ["POST", "/link/regenerate"],
      ["POST", "/links"],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(room.roomId, method, path, cred, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    // Owner-token-only routes refuse an account token altogether (DELETE /links is a management route).
    expect((await call(room.roomId, "DELETE", "", cred)).status).toBe(401);
    expect((await call(room.roomId, "DELETE", "/links", cred)).status).toBe(403);
    expect((await call(room.roomId, "DELETE", "/collaborators", cred)).status).toBe(401);
    expect((await call(room.roomId, "PUT", "/owner-profile", cred, { jwt: editor.jwt })).status).toBe(401);

    const state = await membersOf(room);
    expect(state.members.find((m) => m.sub === editor.sub)?.role).toBe("editor");
    expect(state.members.find((m) => m.sub === other.sub)?.role).toBe("viewer");
    expect(state.invites).toEqual([]);
    expect(state.link.enabled).toBe(true);
    expect(await noFrameOfType(other.q, "role")).toBe(true);
  });

  it("a member's token for another room grants nothing here", async () => {
    const room = await newRoom();
    const elsewhere = await newRoom();
    const editor = await member(elsewhere, "editor");
    await expectRefused(room.roomId, { kind: "user", jwt: editor.jwt });
    expect((await call(room.roomId, "GET", "/members", { jwt: editor.jwt })).status).toBe(401);
  });
});

// ---- admins ---------------------------------------------------------------------------

describe("an admin", () => {
  it("edits and manages sharing: invites, changes roles, removes people and switches the link", async () => {
    const room = await newRoom();
    const admin = await member(room, "admin");
    const target = await member(room, "viewer");
    const cred = { jwt: admin.jwt };

    send(admin.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("admin edit") });
    expect(await nextOfType(admin.q, "seq")).toMatchObject({ seq: 2 });

    const invited = await call(room.roomId, "POST", "/invites", cred, { email: "by-admin@example.test", role: "editor" });
    expect(invited.status).toBe(201);
    expect((await membersOf(room)).invites).toMatchObject([{ email: "by-admin@example.test", role: "editor" }]);
    expect((await call(room.roomId, "DELETE", "/invites/by-admin%40example.test", cred)).status).toBe(204);

    const promoted = await call(room.roomId, "PATCH", `/members/${target.sub}`, cred, { role: "editor" });
    expect(promoted.status).toBe(200);
    expect(await nextOfType(target.q, "role")).toEqual({ t: "role", role: "editor" });

    expect((await call(room.roomId, "PUT", "/link", cred, { enabled: false })).status).toBe(200);
    expect((await call(room.roomId, "PUT", "/link", cred, { enabled: true })).status).toBe(200);
    expect((await call(room.roomId, "POST", "/link/regenerate", cred)).status).toBe(201);
    expect((await call(room.roomId, "GET", "/link", cred)).status).toBe(200);
    expect((await call(room.roomId, "GET", "/members", cred)).status).toBe(200);

    expect((await call(room.roomId, "DELETE", `/members/${target.sub}`, cred)).status).toBe(204);
    expect((await target.q.closeEvent()).code).toBe(4401);
    // Still not the owner: removing the whole room needs the owner token.
    expect((await call(room.roomId, "DELETE", "", cred)).status).toBe(401);
  });

  it("cannot demote or remove the owner account, and cannot take ownership", async () => {
    const room = await newRoom();
    const owner = await person("owner");
    expect(
      (await call(room.roomId, "PUT", "/owner-profile", { owner: room.ownerToken }, { jwt: owner.jwt })).status,
    ).toBe(204);
    const admin = await member(room, "admin");

    for (const role of ["viewer", "editor", "admin"]) {
      const res = await call(room.roomId, "PATCH", `/members/${owner.sub}`, { jwt: admin.jwt }, { role });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "owner-protected" });
    }
    const removal = await call(room.roomId, "DELETE", `/members/${owner.sub}`, { jwt: admin.jwt });
    expect(removal.status).toBe(403);
    expect(await removal.json()).toEqual({ error: "owner-protected" });
    // The owner token itself is held to the same rule.
    expect((await call(room.roomId, "DELETE", `/members/${owner.sub}`, { owner: room.ownerToken })).status).toBe(403);

    // An admin cannot set the owner profile (owner token only), and the owner is still the owner.
    const hijack = await person("hijack");
    expect((await call(room.roomId, "PUT", "/owner-profile", { jwt: admin.jwt }, { jwt: hijack.jwt })).status).toBe(401);
    expect((await connectAs(room.roomId, { kind: "user", jwt: owner.jwt })).frames[0]).toMatchObject({ role: "owner" });
    expect((await connectAs(room.roomId, { kind: "user", jwt: admin.jwt })).frames[0]).toMatchObject({ role: "admin" });
  });
});

// ---- the owner ------------------------------------------------------------------------

describe("the owner account", () => {
  it("is the owner on any signed-in device after PUT /owner-profile, is never a member and cannot leave", async () => {
    const room = await newRoom();
    const owner = await person("ownerdev");
    // The owner first joined through the link as a reader.
    await connectAs(room.roomId, { kind: "user", jwt: owner.jwt, linkSecret: room.linkSecret });
    expect((await membersOf(room)).members.map((m) => m.sub)).toContain(owner.sub);

    expect(
      (await call(room.roomId, "PUT", "/owner-profile", { owner: room.ownerToken }, { jwt: owner.jwt })).status,
    ).toBe(204);
    expect((await call(room.roomId, "PUT", "/owner-profile", { owner: room.ownerToken }, { jwt: "garbage" })).status).toBe(400);

    const state = await membersOf(room);
    expect(state.members.map((m) => m.sub)).not.toContain(owner.sub);
    expect(state.owner).toEqual({ name: "Name ownerdev", email: owner.email });

    const conn = await connectAs(room.roomId, { kind: "user", jwt: owner.jwt });
    expect(conn.frames[0]).toMatchObject({ role: "owner" });
    send(conn.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("owner on another device") });
    expect(await nextOfType(conn.q, "seq")).toMatchObject({ seq: 2 });
    const asAccount = await call(room.roomId, "GET", "/members", { jwt: owner.jwt });
    expect(asAccount.status).toBe(200);
    expect((await asAccount.json()) as { you: unknown }).toMatchObject({ you: { role: "owner", sub: owner.sub } });

    const leave = await call(room.roomId, "POST", "/leave", { jwt: owner.jwt });
    expect(leave.status).toBe(403);
    expect(await leave.json()).toEqual({ error: "owner-protected" });
  });

  it("sees the member list: owner profile, members with role and via, invitations and the link", async () => {
    const room = await newRoom();
    const owner = await person("shape");
    await call(room.roomId, "PUT", "/owner-profile", { owner: room.ownerToken }, { jwt: owner.jwt });
    const named = await member(room, "editor", "named");
    const reader = await person("shapelink");
    await connectAs(room.roomId, { kind: "user", jwt: reader.jwt, linkSecret: room.linkSecret });
    await invite(room, "Pending@Example.TEST", "admin");

    const state = await membersOf(room);
    expect(state.you).toEqual({ role: "owner" });
    expect(state.owner).toEqual({ name: "Name shape", email: owner.email });
    expect(state.link).toMatchObject({ enabled: true, linkSecret: room.linkSecret });
    expect(state.members).toHaveLength(2);
    expect(state.members.find((m) => m.sub === named.sub)).toMatchObject({
      role: "editor",
      via: "invite",
      name: "Name named",
      email: named.email,
    });
    expect(state.members.find((m) => m.sub === reader.sub)).toMatchObject({
      role: "viewer",
      via: "link",
      name: "Name shapelink",
    });
    expect(state.invites).toMatchObject([{ email: "pending@example.test", role: "admin" }]);
    expect((await call(room.roomId, "GET", "/members", {})).status).toBe(401);
    expect((await call("doesnotexist", "GET", "/members", { owner: room.ownerToken })).status).toBe(401);
  });
});

// ---- invitations by e-mail --------------------------------------------------------------

describe("invitations by e-mail", () => {
  it("validates the address, the role, duplicates and the owner's own address", async () => {
    const room = await newRoom();
    for (const email of ["", "not-an-address", "a@b", "two words@example.test", 42, null]) {
      const res = await invite(room, email, "viewer");
      expect(res.status, String(email)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-email" });
    }
    for (const role of ["owner", "root", "", undefined]) {
      const res = await invite(room, "ok@example.test", role);
      expect(res.status, String(role)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-role" });
    }
    expect((await call(room.roomId, "POST", "/invites", { owner: room.ownerToken }, "nope")).status).toBe(400);

    // The owner's own verified address cannot be invited.
    const owner = await person("selfinvite");
    await call(room.roomId, "PUT", "/owner-profile", { owner: room.ownerToken }, { jwt: owner.jwt });
    const self = await invite(room, owner.email.toUpperCase(), "editor");
    expect(self.status).toBe(409);
    expect(await self.json()).toEqual({ error: "is-owner" });

    // Neither can an address that already belongs to a member.
    const named = await member(room, "viewer", "dup");
    const dup = await invite(room, named.email, "editor");
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "already-member" });
  });

  it("lists a pending invitation, and inviting the same address again updates its role", async () => {
    const room = await newRoom();
    expect((await invite(room, "again@example.test", "viewer")).status).toBe(201);
    expect((await invite(room, "AGAIN@example.test ", "admin")).status).toBe(201);
    const state = await membersOf(room);
    expect(state.members).toEqual([]);
    expect(state.invites).toMatchObject([{ email: "again@example.test", role: "admin" }]);
  });

  it("cannot be claimed by another account, by a token without the verified address, or by a forged token", async () => {
    const room = await newRoom({ link: false });
    const invited = await person("invitee");
    expect((await invite(room, invited.email, "editor")).status).toBe(201);

    const stranger = await person("stranger");
    await expectRefused(room.roomId, { kind: "user", jwt: stranger.jwt });
    await expectRefused(room.roomId, { kind: "user", jwt: await mintTestJwt(invited.sub) });
    await expectRefused(room.roomId, { kind: "user", jwt: await mintTestJwtWithEmails(invited.sub, []) });
    expect((await call(room.roomId, "GET", "/meta", { jwt: stranger.jwt })).status).toBe(401);
    // The MAC covers the payload: swapping in the invited address needs the secret.
    const forged = invited.jwt.replace(/:[^:]+$/, ":AAAA");
    await expectRefused(room.roomId, { kind: "user", jwt: forged });

    expect((await membersOf(room)).invites).toHaveLength(1);
    expect((await membersOf(room)).members).toEqual([]);
  });

  it("is claimed by the verified address on a socket hello, once, with the invited role", async () => {
    const room = await newRoom({ link: false });
    const invited = await person("claimer");
    await invite(room, invited.email, "admin");

    const conn = await connectAs(room.roomId, { kind: "user", jwt: invited.jwt });
    expect(conn.frames[0]).toMatchObject({ t: "welcome", role: "admin" });
    const state = await membersOf(room);
    expect(state.invites).toEqual([]);
    expect(state.members).toMatchObject([{ sub: invited.sub, role: "admin", via: "invite", email: invited.email }]);

    // Another account cannot claim the same, already used invitation.
    await expectRefused(room.roomId, { kind: "user", jwt: (await person("latecomer")).jwt });
  });

  it("is claimed by an HTTP bearer request as well", async () => {
    const room = await newRoom({ link: false });
    const invited = await person("httpclaim");
    await invite(room, invited.email, "viewer");
    const meta = await call(room.roomId, "GET", "/meta", { jwt: invited.jwt });
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ role: "viewer" });
  });

  it("matches the address case-insensitively", async () => {
    const room = await newRoom({ link: false });
    const id = crypto.randomUUID().slice(0, 8);
    expect((await invite(room, `Mixed.Case-${id}@Example.TEST`, "editor")).status).toBe(201);
    const jwt = await mintTestJwtWithEmails(`user_case_${id}`, [`MIXED.case-${id}@EXAMPLE.test`]);
    expect((await connectAs(room.roomId, { kind: "user", jwt })).frames[0]).toMatchObject({ role: "editor" });
  });

  it("an existing link reader is refused a duplicate invitation, and the owner promotes them by role instead", async () => {
    const room = await newRoom();
    const who = await person("both");
    const conn = await connectAs(room.roomId, { kind: "user", jwt: who.jwt, linkSecret: room.linkSecret });
    expect(conn.frames[0]).toMatchObject({ role: "viewer" });
    expect((await invite(room, who.email, "editor")).status).toBe(409);
    await call(room.roomId, "PATCH", `/members/${who.sub}`, { owner: room.ownerToken }, { role: "editor" });
    await call(room.roomId, "PUT", "/link", { owner: room.ownerToken }, { enabled: false });
    expect((await connectAs(room.roomId, { kind: "user", jwt: who.jwt })).frames[0]).toMatchObject({ role: "editor" });
  });

  it("can be withdrawn before it is claimed", async () => {
    const room = await newRoom({ link: false });
    const invited = await person("withdrawn");
    await invite(room, invited.email, "editor");
    expect(
      (await call(room.roomId, "DELETE", `/invites/${encodeURIComponent(invited.email)}`, { owner: room.ownerToken })).status,
    ).toBe(204);
    expect((await call(room.roomId, "DELETE", "/invites/not-an-address", { owner: room.ownerToken })).status).toBe(400);
    expect((await membersOf(room)).invites).toEqual([]);
    await expectRefused(room.roomId, { kind: "user", jwt: invited.jwt });
  });
});

// ---- the invitation inbox -------------------------------------------------------------------

describe("the invitation inbox", () => {
  it("lists the pending invitation for the invitee only, and drops it once claimed", async () => {
    const room = await newRoom({ link: false });
    const invited = await person("inbox");
    await invite(room, invited.email, "editor");

    expect(await invitationsFor(invited.jwt)).toMatchObject([
      { roomId: room.roomId, notebookTitle: "Test notebook", role: "editor" },
    ]);
    expect(await invitationsFor((await person("nobody")).jwt)).toEqual([]);

    await connectAs(room.roomId, { kind: "user", jwt: invited.jwt });
    expect(await invitationsFor(invited.jwt)).toEqual([]);
  });

  it("shows invitations sent to any verified address of the account, with the highest role per notebook", async () => {
    const room = await newRoom({ link: false });
    const second = `second-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const who = await person("twoaddr", [second]);
    await invite(room, who.email, "viewer");
    await invite(room, second, "admin");
    expect(await invitationsFor(who.jwt)).toMatchObject([{ roomId: room.roomId, role: "admin" }]);
  });

  it("disappears when the invitation is withdrawn", async () => {
    const room = await newRoom({ link: false });
    const who = await person("revokedinbox");
    await invite(room, who.email, "viewer");
    expect(await invitationsFor(who.jwt)).toHaveLength(1);
    await call(room.roomId, "DELETE", `/invites/${encodeURIComponent(who.email)}`, { owner: room.ownerToken });
    expect(await invitationsFor(who.jwt)).toEqual([]);
  });

  it("can be declined, which also ends the invitation in the room; somebody else declining does nothing", async () => {
    const room = await newRoom({ link: false });
    const who = await person("decliner");
    await invite(room, who.email, "editor");

    expect((await declineInvitation((await person("meddler")).jwt, room.roomId)).status).toBe(204);
    expect(await invitationsFor(who.jwt)).toHaveLength(1);

    expect((await declineInvitation(who.jwt, room.roomId)).status).toBe(204);
    expect(await invitationsFor(who.jwt)).toEqual([]);
    expect((await membersOf(room)).invites).toEqual([]);
    await expectRefused(room.roomId, { kind: "user", jwt: who.jwt });
  });

  it("needs a signed-in account", async () => {
    expect((await SELF.fetch(`${BASE}/api/v1/me/invitations`)).status).toBe(401);
    const bad = await SELF.fetch(`${BASE}/api/v1/me/invitations`, { headers: { Authorization: "Bearer test:x:bad" } });
    expect(bad.status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/v1/me/invitations/someroom`, { method: "DELETE" })).status).toBe(401);
  });

  it("is cleared by a full unshare, which also closes every socket", async () => {
    const room = await newRoom();
    const pending = await person("pendingunshare");
    await invite(room, pending.email, "viewer");
    const live = await member(room, "editor");
    const anonymous = await connectAs(room.roomId, { kind: "link", linkSecret: room.linkSecret });
    expect(await invitationsFor(pending.jwt)).toHaveLength(1);

    expect((await call(room.roomId, "DELETE", "", { owner: room.ownerToken })).status).toBe(204);
    expect((await live.q.closeEvent()).code).toBe(4401);
    expect((await anonymous.q.closeEvent()).code).toBe(4401);
    expect(await invitationsFor(pending.jwt)).toEqual([]);
    await expectRefused(room.roomId, { kind: "user", jwt: live.jwt });
    expect((await call(room.roomId, "GET", "/members", { owner: room.ownerToken })).status).toBe(401);
  });
});

// ---- verified addresses from Clerk ---------------------------------------------------------------

describe("verified e-mail addresses", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type ClerkAddress = { email_address: string; status: string };

  function stubClerkUsers(users: Record<string, ClerkAddress[]>): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const sub = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const addresses = users[sub];
        if (!addresses) return new Response("{}", { status: 404 });
        return Response.json({
          email_addresses: addresses.map((a) => ({
            email_address: a.email_address,
            verification: { status: a.status },
          })),
        });
      }),
    );
  }
  const fakeEnv = (key?: string): Parameters<typeof verifiedEmailsFor>[1] => ({
    TEST_AUTH_SECRET: "x",
    ...(key ? { CLERK_SECRET_KEY: key } : {}),
  });

  it("reads primary and secondary addresses from the Clerk Backend API, drops unverified ones and normalises case", async () => {
    const sub = `user_unit_${crypto.randomUUID()}`;
    stubClerkUsers({
      [sub]: [
        { email_address: "Primary@Example.test", status: "verified" },
        { email_address: "secondary@example.test", status: "verified" },
        { email_address: "pending@example.test", status: "unverified" },
        { email_address: "not an address", status: "verified" },
      ],
    });
    const emails = await verifiedEmailsFor(
      { sub, emails: ["Token@Example.test", "primary@example.test"] },
      fakeEnv("sk_test_synthetic"),
    );
    expect(emails.sort()).toEqual(["primary@example.test", "secondary@example.test", "token@example.test"]);
  });

  it("falls back to the token claim without a secret key, or when the API fails", async () => {
    const sub = `user_unit_${crypto.randomUUID()}`;
    stubClerkUsers({});
    expect(await verifiedEmailsFor({ sub, emails: ["claim@example.test"] }, fakeEnv())).toEqual(["claim@example.test"]);
    expect(await verifiedEmailsFor({ sub, emails: ["claim@example.test"] }, fakeEnv("sk_test_synthetic"))).toEqual([
      "claim@example.test",
    ]);
    expect(await verifiedEmailsFor({ sub }, fakeEnv())).toEqual([]);
  });

  it("lets an account claim an invitation sent to its verified secondary address, and ignores an unverified one", async () => {
    const room = await newRoom({ link: false });
    const id = crypto.randomUUID().slice(0, 8);
    const secondary = `secondary-${id}@example.test`;
    const unverified = `unverified-${id}@example.test`;
    const sub = `user_clerk_${id}`;
    const jwt = await mintTestJwtWithEmails(sub, []);
    stubClerkUsers({
      [sub]: [
        { email_address: secondary, status: "verified" },
        { email_address: unverified, status: "unverified" },
      ],
    });
    // The room (its Durable Object instance) and the Worker need a key to call the Backend API with.
    const stub = env.NOTEBOOK_ROOM.get(env.NOTEBOOK_ROOM.idFromName(room.roomId));
    await runInDurableObject(stub, (instance) => {
      roomEnv(instance).CLERK_SECRET_KEY = "sk_test_synthetic";
    });
    (env as Env).CLERK_SECRET_KEY = "sk_test_synthetic";
    try {
      await invite(room, unverified, "admin");
      await expectRefused(room.roomId, { kind: "user", jwt });
      await invite(room, secondary, "editor");
      expect(await invitationsFor(jwt)).toMatchObject([{ roomId: room.roomId, role: "editor" }]);
      const conn = await connectAs(room.roomId, { kind: "user", jwt });
      expect(conn.frames[0]).toMatchObject({ role: "editor" });
    } finally {
      delete (env as Env).CLERK_SECRET_KEY;
    }
  });
});

// ---- live role changes ---------------------------------------------------------------------------------

describe("role changes on open sockets", () => {
  it("demoting an editor pushes the new role at once and rejects the next write", async () => {
    const room = await newRoom();
    const editor = await member(room, "editor");
    send(editor.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("before") });
    expect(await nextOfType(editor.q, "seq")).toMatchObject({ seq: 2 });

    const res = await call(room.roomId, "PATCH", `/members/${editor.sub}`, { owner: room.ownerToken }, { role: "viewer" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sub: editor.sub, role: "viewer" });
    expect(await nextOfType(editor.q, "role")).toEqual({ t: "role", role: "viewer" });

    send(editor.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("after") });
    expect(await nextOfType(editor.q, "error")).toMatchObject({ code: "read-only" });
    expect((await storedState(room)).changes).toHaveLength(2);
  });

  it("promoting a viewer lets the very next write through", async () => {
    const room = await newRoom();
    const viewer = await member(room, "viewer");
    send(viewer.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("denied") });
    expect(await nextOfType(viewer.q, "error")).toMatchObject({ code: "read-only" });

    await call(room.roomId, "PATCH", `/members/${viewer.sub}`, { owner: room.ownerToken }, { role: "editor" });
    expect(await nextOfType(viewer.q, "role")).toEqual({ t: "role", role: "editor" });
    send(viewer.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("allowed") });
    expect(await nextOfType(viewer.q, "seq")).toMatchObject({ seq: 2 });
  });

  it("a demoted admin loses management at once", async () => {
    const room = await newRoom();
    const admin = await member(room, "admin");
    await call(room.roomId, "PATCH", `/members/${admin.sub}`, { owner: room.ownerToken }, { role: "editor" });
    expect(await nextOfType(admin.q, "role")).toEqual({ t: "role", role: "editor" });
    expect((await call(room.roomId, "GET", "/members", { jwt: admin.jwt })).status).toBe(403);
  });

  it("validates the role and the member", async () => {
    const room = await newRoom();
    const editor = await member(room, "editor");
    const cred = { owner: room.ownerToken };
    for (const role of ["owner", "root", undefined]) {
      const res = await call(room.roomId, "PATCH", `/members/${editor.sub}`, cred, { role });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-role" });
    }
    const ghost = await call(room.roomId, "PATCH", "/members/user_ghost", cred, { role: "viewer" });
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({ error: "not-a-member" });
    expect((await call(room.roomId, "DELETE", "/members/user_ghost", cred)).status).toBe(204);
  });

  it("removing a member closes their sockets with 4401 and refuses a reconnect", async () => {
    const room = await newRoom({ link: false });
    const editor = await member(room, "editor");
    const second = await connectAs(room.roomId, { kind: "user", jwt: editor.jwt });

    expect((await call(room.roomId, "DELETE", `/members/${editor.sub}`, { owner: room.ownerToken })).status).toBe(204);
    expect((await editor.q.closeEvent()).code).toBe(4401);
    expect((await second.q.closeEvent()).code).toBe(4401);
    await expectRefused(room.roomId, { kind: "user", jwt: editor.jwt });
    expect((await membersOf(room)).members).toEqual([]);
  });

  it("leaving closes the member's own sockets and refuses a reconnect", async () => {
    const room = await newRoom({ link: false });
    const editor = await member(room, "editor");
    expect((await call(room.roomId, "POST", "/leave", {})).status).toBe(401);
    expect((await call(room.roomId, "POST", "/leave", { link: room.linkSecret })).status).toBe(401);
    expect((await call(room.roomId, "POST", "/leave", { jwt: editor.jwt })).status).toBe(204);
    expect((await editor.q.closeEvent()).code).toBe(4401);
    await expectRefused(room.roomId, { kind: "user", jwt: editor.jwt });
    expect((await call("doesnotexist", "POST", "/leave", { jwt: editor.jwt })).status).toBe(404);
  });
});

// ---- presence of editors ---------------------------------------------------------------------------------------

describe("presence ink of an editor", () => {
  it("is relayed untouched", async () => {
    const room = await newRoom();
    const owner = await connectAs(room.roomId, { kind: "owner", ownerToken: room.ownerToken });
    const editor = await member(room, "editor");
    send(editor.ws, { t: "presence", state: { v: 1, ink: { points: [[1, 2]] } } });
    expect(await nextOfType(owner.q, "presence")).toMatchObject({
      role: "editor",
      state: { ink: { points: [[1, 2]] } },
    });
  });
});

// ---- migration -------------------------------------------------------------------------------------------------

describe("migration of collaborators from before roles", () => {
  const stubOf = (roomId: string) => env.NOTEBOOK_ROOM.get(env.NOTEBOOK_ROOM.idFromName(roomId));

  /** Rewrites the table the way an old room stored it (`sub`, `addedAt`) and runs the schema step again. */
  async function downgradeToOldShape(roomId: string, subs: string[]): Promise<void> {
    await runInDurableObject(stubOf(roomId), (instance, state) => {
      state.storage.sql.exec("DROP TABLE collaborators");
      state.storage.sql.exec("CREATE TABLE collaborators (sub TEXT PRIMARY KEY, addedAt TEXT)");
      for (const sub of subs) {
        state.storage.sql.exec("INSERT INTO collaborators (sub, addedAt) VALUES (?, ?)", sub, "2026-08-01T00:00:00.000Z");
      }
      schemaRunner(instance).ensureSchema();
    });
  }

  it("turns old rows into editors via 'migrated', which the link being off does not touch", async () => {
    const room = await newRoom();
    const old = await person("legacy");
    await downgradeToOldShape(room.roomId, [old.sub]);

    expect((await membersOf(room)).members).toMatchObject([{ sub: old.sub, role: "editor", via: "migrated" }]);

    const conn = await connectAs(room.roomId, { kind: "user", jwt: old.jwt });
    expect(conn.frames[0]).toMatchObject({ role: "editor" });
    send(conn.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("legacy edit") });
    expect(await nextOfType(conn.q, "seq")).toMatchObject({ seq: 2 });

    await call(room.roomId, "PUT", "/link", { owner: room.ownerToken }, { enabled: false });
    send(conn.ws, { t: "append", docId: "doc-1", payload: textToBase64Url("after link off") });
    expect(await nextOfType(conn.q, "seq")).toMatchObject({ seq: 3 });
    expect((await connectAs(room.roomId, { kind: "user", jwt: old.jwt })).frames[0]).toMatchObject({ role: "editor" });
  });

  it("running the migration again does not change roles that were set since", async () => {
    const room = await newRoom();
    const old = await person("legacy2");
    await downgradeToOldShape(room.roomId, [old.sub]);
    await call(room.roomId, "PATCH", `/members/${old.sub}`, { owner: room.ownerToken }, { role: "viewer" });
    await runInDurableObject(stubOf(room.roomId), (instance) => schemaRunner(instance).ensureSchema());
    expect((await membersOf(room)).members).toMatchObject([{ sub: old.sub, role: "viewer", via: "invite" }]);
  });

  it("a room from before the link switch counts the link as on while it has link rows, off without", async () => {
    const withLink = await newRoom();
    const without = await newRoom({ link: false });
    for (const room of [withLink, without]) {
      await runInDurableObject(stubOf(room.roomId), (_instance, state) => {
        state.storage.sql.exec("DELETE FROM meta WHERE key IN ('linkEnabled', 'linkSecret')");
      });
    }
    expect((await connectAs(withLink.roomId, { kind: "link", linkSecret: withLink.linkSecret })).frames[0]).toMatchObject({
      role: "viewer",
    });
    expect(await (await call(withLink.roomId, "GET", "/link", { owner: withLink.ownerToken })).json()).toMatchObject({
      enabled: true,
    });
    expect(await (await call(without.roomId, "GET", "/link", { owner: without.ownerToken })).json()).toMatchObject({
      enabled: false,
    });
  });
});
