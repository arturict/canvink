// `GET /api/v1/me/invitations` and `DELETE /api/v1/me/invitations/:roomId`: the notebooks that were
// shared with the signed-in account's verified e-mail addresses and that it has not opened yet.
//
// An invitation is only an index entry (see inbox.ts). Opening the notebook with the account is
// what claims it: the room checks the verified addresses itself, so listing never grants anything.
import { verifySpaceToken } from "./auth/device";
import { verifiedEmailsFor } from "./auth/emails";
import { inboxList, type InboxEntry } from "./inbox";
import { roleRank, type Env } from "./types";

/** An account has a handful of addresses; this bounds the fan-out to the inbox Durable Objects. */
const MAX_ADDRESSES = 10;
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function verifiedAddresses(request: Request, env: Env): Promise<string[] | Response> {
  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return Response.json({ error: "unauthorized" }, { status: 401 });
  let identity;
  try {
    identity = await verifySpaceToken(match[1] as string, env);
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return (await verifiedEmailsFor(identity, env)).slice(0, MAX_ADDRESSES);
}

export async function handleInvitationRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/v1/me/invitations" && request.method === "GET") {
    const emails = await verifiedAddresses(request, env);
    if (emails instanceof Response) return emails;
    const byRoom = new Map<string, InboxEntry>();
    for (const email of emails) {
      for (const entry of await inboxList(env, email)) {
        const known = byRoom.get(entry.roomId);
        if (!known || roleRank(entry.role) > roleRank(known.role)) byRoom.set(entry.roomId, entry);
      }
    }
    const invitations = [...byRoom.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json({ invitations }, { headers: { "Cache-Control": "no-store" } });
  }

  const decline = /^\/api\/v1\/me\/invitations\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (decline && request.method === "DELETE") {
    const roomId = decline[1] as string;
    if (!ROOM_ID.test(roomId)) return Response.json({ error: "bad-room-id" }, { status: 400 });
    const emails = await verifiedAddresses(request, env);
    if (emails instanceof Response) return emails;
    const stub = env.NOTEBOOK_ROOM.get(env.NOTEBOOK_ROOM.idFromName(roomId));
    await stub.fetch("https://room.internal/invites/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Room-Id": roomId },
      body: JSON.stringify({ emails }),
    });
    return new Response(null, { status: 204 });
  }

  return null;
}
