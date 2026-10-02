import { parseJoinFragment, parseOpenFragment } from '../../collab';

export interface JoinHash {
  roomId: string;
  /** Absent for `#open=<roomId>`: the account is let in by name (an invitation), not by the link. */
  linkSecret?: string;
}

/**
 * D13: thin wrapper delegating to the strict `parseJoinFragment` from
 * `src/collab/http.ts` — this used to duplicate a looser, hand-rolled
 * parser (no anchoring, `[^.]+` instead of a validated charset), which could
 * disagree with the canonical parser on malformed input. Kept as a small
 * UI-local file only so call sites in this directory don't need to reach
 * into `src/collab/` directly; the logic itself lives in exactly one place.
 */
export function parseJoinHash(hash: string): JoinHash | null {
  return parseJoinFragment(hash) ?? parseOpenFragment(hash);
}
