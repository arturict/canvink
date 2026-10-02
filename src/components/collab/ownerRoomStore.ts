/**
 * Per-notebook owner room credentials, persisted so a shared notebook keeps
 * syncing after a reload. Deliberately stores only `roomId` + `ownerToken` —
 * an owner session authenticates with `{ kind: 'owner', ownerToken }` alone,
 * so the `linkSecret` never needs to (and must never) live here; it is shown
 * once in `ShareNotebookDialog` and otherwise stays only in the share URL the
 * owner copies out.
 */

const STORAGE_KEY = 'canvink:collab:rooms:v1';

export interface OwnerRoomRecord {
  roomId: string;
  ownerToken: string;
}

type OwnerRoomsByNotebook = Record<string, OwnerRoomRecord>;

function readStorage(): OwnerRoomsByNotebook {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: OwnerRoomsByNotebook = {};
    for (const [notebookId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' && value !== null
        && typeof (value as OwnerRoomRecord).roomId === 'string'
        && typeof (value as OwnerRoomRecord).ownerToken === 'string'
      ) {
        result[notebookId] = { roomId: (value as OwnerRoomRecord).roomId, ownerToken: (value as OwnerRoomRecord).ownerToken };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeStorage(rooms: OwnerRoomsByNotebook): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
}

export function loadOwnerRooms(): OwnerRoomsByNotebook {
  return readStorage();
}

export function getOwnerRoom(notebookId: string): OwnerRoomRecord | undefined {
  return readStorage()[notebookId];
}

export function saveOwnerRoom(notebookId: string, record: OwnerRoomRecord): void {
  const rooms = readStorage();
  rooms[notebookId] = record;
  writeStorage(rooms);
}

export function removeOwnerRoom(notebookId: string): void {
  const rooms = readStorage();
  if (!(notebookId in rooms)) return;
  delete rooms[notebookId];
  writeStorage(rooms);
}
