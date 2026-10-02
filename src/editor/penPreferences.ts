import { useSyncExternalStore } from 'react';
import {
  DEFAULT_PEN_BUTTON_MAPPING,
  parsePenButtonMapping,
  PEN_BUTTONS_LEGACY_KEY,
  PEN_BUTTONS_STORAGE_KEY,
  type PenButtonAction,
  type PenButtonMapping,
  type PenSlot,
} from './penButtons';

const PEN_SEEN_KEY = 'canvink:pen-seen';

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Whether a pen has ever touched or hovered over the canvas on this device. */
export function readPenSeen(): boolean {
  return storage()?.getItem(PEN_SEEN_KEY) === 'true';
}

export function markPenSeen(): void {
  try {
    storage()?.setItem(PEN_SEEN_KEY, 'true');
  } catch {
    // Without storage the pen counts as seen for this session only.
  }
}

let cachedRaw: string | null | undefined;
let cachedMapping: PenButtonMapping = DEFAULT_PEN_BUTTON_MAPPING;

/** The stored mapping; the same object while the stored text is unchanged, as a store snapshot must be. */
export function readPenButtonMapping(): PenButtonMapping {
  const store = storage();
  const raw = store?.getItem(PEN_BUTTONS_STORAGE_KEY) ?? null;
  const legacy = raw === null ? store?.getItem(PEN_BUTTONS_LEGACY_KEY) ?? null : null;
  const key = raw ?? (legacy ? `legacy:${legacy}` : null);
  if (key !== cachedRaw) {
    cachedRaw = key;
    cachedMapping = parsePenButtonMapping(raw, legacy);
  }
  return cachedMapping;
}

export function setPenButtonAction(slot: PenSlot, action: PenButtonAction): void {
  const next = { ...readPenButtonMapping(), [slot]: action };
  try {
    storage()?.setItem(PEN_BUTTONS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Without storage the choice is not kept.
  }
  cachedRaw = JSON.stringify(next);
  cachedMapping = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** What each pen button does; stays in sync between the pen menu and the canvas. */
export function usePenButtonMapping(): PenButtonMapping {
  return useSyncExternalStore(subscribe, readPenButtonMapping, () => DEFAULT_PEN_BUTTON_MAPPING);
}
