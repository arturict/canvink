// The invitation inbox: where a person finds the notebooks that were shared with their e-mail
// address before they had joined.
//
// There is no database next to the Worker, so the index is one more Durable Object per address,
// named by the SHA-256 of the normalised address. It reuses the `NotebookRoom` class (like a
// personal space does) with `meta.kind = "inbox"` and holds one row per room that invited the
// address. The rooms write to it when they create or revoke an invitation; the Worker reads it for
// `GET /api/v1/me/invitations`. It is internal: no client route addresses an inbox Durable Object,
// and an invitation is only ever *claimed* in the room, which re-checks the verified addresses.
import { sha256Hex } from "./util/crypto";
import type { Env, MemberRole } from "./types";

export interface InboxEntry {
  roomId: string;
  notebookTitle: string;
  role: MemberRole;
  /** Display name of the person who invited, when known. */
  invitedBy?: string;
  createdAt: string;
}

async function inboxStub(env: Env, email: string): Promise<DurableObjectStub> {
  const name = `inbox-v1:${await sha256Hex(email)}`;
  return env.NOTEBOOK_ROOM.get(env.NOTEBOOK_ROOM.idFromName(name));
}

export async function inboxPut(env: Env, email: string, entry: InboxEntry): Promise<void> {
  const stub = await inboxStub(env, email);
  await stub.fetch("https://room.internal/inbox/put", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
}

export async function inboxDelete(env: Env, email: string, roomId: string): Promise<void> {
  const stub = await inboxStub(env, email);
  await stub.fetch("https://room.internal/inbox/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId }),
  });
}

export async function inboxList(env: Env, email: string): Promise<InboxEntry[]> {
  const stub = await inboxStub(env, email);
  const response = await stub.fetch("https://room.internal/inbox/list");
  if (!response.ok) return [];
  const body = (await response.json()) as { invitations?: InboxEntry[] };
  return body.invitations ?? [];
}
