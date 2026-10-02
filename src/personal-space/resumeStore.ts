/**
 * What this device already holds of a personal space's documents, kept
 * between visits so that a returning device does not download the whole
 * account again: per document its room sequence number and the heads the
 * device's own copy contained at that point. A stale record is harmless (the
 * room then sends more than needed) and an entry is only used when the local
 * copy still has exactly those heads.
 */

import type { RoomResume } from '../collab/session';

const KEY_PREFIX = 'canvink:personal-space:resume:v1:';

function isEntry(value: unknown): value is RoomResume['docs'][string] {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as RoomResume['docs'][string];
  return (entry.kind === 'notebook' || entry.kind === 'page')
    && Number.isInteger(entry.seq)
    && entry.seq >= 0
    && Array.isArray(entry.heads)
    && entry.heads.length > 0
    && entry.heads.every((head) => typeof head === 'string');
}

export function loadSpaceResume(spaceId: string): RoomResume {
  if (typeof localStorage === 'undefined') return { docs: {} };
  try {
    const raw = localStorage.getItem(KEY_PREFIX + spaceId);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    const docs = typeof parsed === 'object' && parsed !== null ? (parsed as { docs?: unknown }).docs : undefined;
    if (typeof docs !== 'object' || docs === null) return { docs: {} };
    return { docs: Object.fromEntries(Object.entries(docs).filter(([, entry]) => isEntry(entry))) as RoomResume['docs'] };
  } catch {
    return { docs: {} };
  }
}

/** Writes the record when it differs from `previous` (a serialized earlier write); returns what is stored now. */
export function saveSpaceResume(spaceId: string, resume: RoomResume, previous?: string): string {
  const serialized = JSON.stringify({ docs: resume.docs });
  if (serialized === previous || typeof localStorage === 'undefined') return serialized;
  try {
    localStorage.setItem(KEY_PREFIX + spaceId, serialized);
  } catch {
    // Storage full or blocked: the next visit downloads everything again, as before.
  }
  return serialized;
}

export function clearSpaceResume(spaceId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(KEY_PREFIX + spaceId);
}

/** Keeps the entries whose local copy still has exactly the recorded heads. */
export function filterResumeToLocalCopies(
  resume: RoomResume,
  localHeads: (docId: string) => readonly string[] | undefined,
): RoomResume {
  const docs: RoomResume['docs'] = {};
  for (const [docId, entry] of Object.entries(resume.docs)) {
    const local = localHeads(docId);
    if (!local || local.length !== entry.heads.length) continue;
    const recorded = new Set(entry.heads);
    if (local.every((head) => recorded.has(head))) docs[docId] = entry;
  }
  return { docs };
}
