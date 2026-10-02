/**
 * The notebooks of this workspace that someone else shared, with the room each
 * one syncs through. A joined notebook is an ordinary notebook of the
 * workspace (it lives in the same storage and syncs with the personal space
 * like any other); this record only says that it is also bound to a room.
 * Deliberately stores only the `roomId` and the last known role: after the first join the Worker
 * knows the account as a member, so every later connection (also from
 * another device) authenticates with the account token alone and the link
 * secret never has to be kept.
 *
 * Keyed by `notebookId`, like `ownerRoomStore.ts` for the notebooks this
 * device shares itself.
 */

import { isRole, type Role } from '../../collab/protocol';

const STORAGE_KEY = 'canvink:collab:joined:v1';

export interface JoinedRoomRecord {
  roomId: string;
  /**
   * The role the room last granted this account, kept so a notebook opens read-only or editable
   * before the connection says so. Absent for a record from before roles existed: such a notebook
   * is read-only until the room confirms the role (the room decides, never the device).
   */
  role?: Role;
}

type JoinedRoomsByNotebook = Record<string, JoinedRoomRecord>;

function readStorage(): JoinedRoomsByNotebook {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: JoinedRoomsByNotebook = {};
    for (const [notebookId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null && typeof (value as JoinedRoomRecord).roomId === 'string') {
        const role = (value as JoinedRoomRecord).role;
        result[notebookId] = {
          roomId: (value as JoinedRoomRecord).roomId,
          ...(isRole(role) ? { role } : {}),
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeStorage(rooms: JoinedRoomsByNotebook): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
}

export function loadJoinedRooms(): JoinedRoomsByNotebook {
  return readStorage();
}

export function getJoinedRoom(notebookId: string): JoinedRoomRecord | undefined {
  return readStorage()[notebookId];
}

export function saveJoinedRoom(notebookId: string, record: JoinedRoomRecord): void {
  const rooms = readStorage();
  const known = rooms[notebookId];
  // An update that only repeats the room keeps the role already known for it.
  const role = record.role ?? (known?.roomId === record.roomId ? known.role : undefined);
  if (known?.roomId === record.roomId && known.role === role) return;
  rooms[notebookId] = { roomId: record.roomId, ...(role ? { role } : {}) };
  writeStorage(rooms);
}

export function removeJoinedRoom(notebookId: string): void {
  const rooms = readStorage();
  if (!(notebookId in rooms)) return;
  delete rooms[notebookId];
  writeStorage(rooms);
}
