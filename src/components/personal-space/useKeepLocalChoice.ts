/**
 * "Keep only on this device": the answer to the first-contact choice (a device
 * with its own notebooks signs in to an account that has others) that leaves
 * everything as it is. The device stays a local workspace, the account is not
 * connected, nothing is uploaded and nothing is removed. The answer is
 * remembered per account so the choice is not asked at every start; the
 * account menu offers it again.
 */

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'canvink:personal-space:keep-local:v1';

type Listener = () => void;
const listeners = new Set<Listener>();
// Closed with the back gesture or the scrim: asked again at the next start, not for the rest of this session.
let snoozed = false;

function notify(): void {
  for (const listener of listeners) listener();
}

export function loadKeepLocalSub(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface KeepLocalChoice {
  /** The choice is settled for now: the dialog stays closed. */
  settled: boolean;
  /** The person chose "only on this device" for this account. */
  keptLocal: boolean;
  keepLocal(): void;
  /** Closes the dialog without an answer; it comes back at the next start. */
  snooze(): void;
  /** Asks again (the account menu's "connect"). */
  reconsider(): void;
}

export function useKeepLocalChoice(sub: string | undefined): KeepLocalChoice {
  const storedSub = useSyncExternalStore(subscribe, loadKeepLocalSub, () => null);
  const isSnoozed = useSyncExternalStore(subscribe, () => snoozed, () => false);
  const keptLocal = sub !== undefined && storedSub === sub;
  const keepLocal = useCallback(() => {
    if (sub === undefined) return;
    try {
      localStorage.setItem(STORAGE_KEY, sub);
    } catch {
      // Not remembered across starts; the answer still holds for this session.
    }
    snoozed = true;
    notify();
  }, [sub]);
  const snooze = useCallback(() => {
    snoozed = true;
    notify();
  }, []);
  const reconsider = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing was remembered.
    }
    snoozed = false;
    notify();
  }, []);
  return { settled: keptLocal || isSnoozed, keptLocal, keepLocal, snooze, reconsider };
}
