/**
 * The one persisted fact about this device's link to a personal space: which
 * `spaceId` belongs to which Clerk `sub`, and when the link was made
 * (PERSONAL-SYNC.md §5.1, §6.8). Defensive-parse shape mirrors
 * `src/components/collab/ownerRoomStore.ts:19-45`.
 */

import type { SpaceLinkRecord } from './contract';

const STORAGE_KEY = 'canvink:personal-space:link:v1';

function isSpaceLinkRecord(value: unknown): value is SpaceLinkRecord {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as SpaceLinkRecord).spaceId === 'string'
    && typeof (value as SpaceLinkRecord).sub === 'string'
    && typeof (value as SpaceLinkRecord).linkedAt === 'string'
  );
}

function readStorage(): SpaceLinkRecord | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isSpaceLinkRecord(parsed)) return undefined;
    return { spaceId: parsed.spaceId, sub: parsed.sub, linkedAt: parsed.linkedAt };
  } catch {
    return undefined;
  }
}

function writeStorage(record: SpaceLinkRecord): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
}

function clearStorage(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

/** Returns the persisted link record, or `undefined` if none exists or it is malformed. */
export function loadSpaceLink(): SpaceLinkRecord | undefined {
  return readStorage();
}

/** Persists (overwrites) the link record for this device. */
export function saveSpaceLink(record: SpaceLinkRecord): void {
  writeStorage(record);
}

/**
 * Removes the persisted link record. Sign-out (§6.8) does **not** call this —
 * it keeps the link record so the same `sub` resumes without the P8 dialog.
 * This exists for the account-switch and "unlink this device" flows only.
 */
export function clearSpaceLink(): void {
  clearStorage();
}
