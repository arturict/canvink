import { useSyncExternalStore } from 'react';

/**
 * OneNote's "touch mode" for Canvink. The preference is automatic by default
 * and can be forced on or off from the Ansicht tab. Automatic mode follows the
 * input hardware: a primary coarse pointer or no hover (Windows reports this
 * once a 2-in-1 is used as a tablet), a device with only coarse pointers, or a
 * finger or pen being the latest pointer seen. A mouse moving again switches
 * an automatic 2-in-1 back to the compact layout.
 */
export type TouchModePreference = 'auto' | 'on' | 'off';
export type PointerKind = 'mouse' | 'pen' | 'touch';

export interface TouchSignals {
  coarsePrimary: boolean;
  coarseOnly: boolean;
  hoverNone: boolean;
  lastPointer: PointerKind | null;
}

export interface TouchModeState {
  preference: TouchModePreference;
  active: boolean;
}

export const TOUCH_MODE_STORAGE_KEY = 'canvink:touch-mode';

export function parseTouchModePreference(value: unknown): TouchModePreference {
  return value === 'on' || value === 'off' ? value : 'auto';
}

export function resolveTouchMode(preference: TouchModePreference, signals: TouchSignals): boolean {
  if (preference !== 'auto') return preference === 'on';
  return signals.coarsePrimary
    || signals.coarseOnly
    || signals.hoverNone
    || signals.lastPointer === 'touch'
    || signals.lastPointer === 'pen';
}

export function pointerKind(pointerType: string): PointerKind | null {
  return pointerType === 'mouse' || pointerType === 'pen' || pointerType === 'touch' ? pointerType : null;
}

function matches(query: string): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches;
}

function readSignals(lastPointer: PointerKind | null): TouchSignals {
  return {
    coarsePrimary: matches('(pointer: coarse)'),
    coarseOnly: matches('(any-pointer: coarse)') && !matches('(any-pointer: fine)'),
    hoverNone: matches('(hover: none)'),
    lastPointer,
  };
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

let preference: TouchModePreference = parseTouchModePreference(storage()?.getItem(TOUCH_MODE_STORAGE_KEY));
let lastPointer: PointerKind | null = null;
let state: TouchModeState = { preference, active: resolveTouchMode(preference, readSignals(lastPointer)) };
const listeners = new Set<() => void>();

function refresh(): void {
  const active = resolveTouchMode(preference, readSignals(lastPointer));
  if (active === state.active && preference === state.preference) return;
  state = { preference, active };
  applyToDocument();
  for (const listener of listeners) listener();
}

function applyToDocument(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.touchMode = state.active ? 'on' : 'off';
}

export function setTouchModePreference(next: TouchModePreference): void {
  preference = next;
  try {
    storage()?.setItem(TOUCH_MODE_STORAGE_KEY, next);
  } catch {
    // Without storage the choice lasts for this session only.
  }
  refresh();
}

export function getTouchModeState(): TouchModeState {
  return state;
}

/** True while the latest input came from a finger or pen, whatever the layout. */
export function lastInputWasTouchOrPen(): boolean {
  return lastPointer === 'touch' || lastPointer === 'pen' || state.active;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTouchMode(): TouchModeState {
  return useSyncExternalStore(subscribe, getTouchModeState, getTouchModeState);
}

const MEDIA_QUERIES = ['(pointer: coarse)', '(any-pointer: coarse)', '(any-pointer: fine)', '(hover: none)'];

/**
 * Starts following the input hardware and keeps `data-touch-mode` on the root
 * element in sync. Call once at startup, before the first render.
 */
export function installTouchMode(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onPointer = (event: PointerEvent) => {
    const kind = pointerKind(event.pointerType);
    if (!kind || kind === lastPointer) return;
    lastPointer = kind;
    refresh();
  };
  const lists = typeof window.matchMedia === 'function' ? MEDIA_QUERIES.map((query) => window.matchMedia(query)) : [];
  const onMedia = () => refresh();
  document.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
  document.addEventListener('pointermove', onPointer, { capture: true, passive: true });
  for (const list of lists) list.addEventListener('change', onMedia);
  applyToDocument();
  refresh();
  return () => {
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('pointermove', onPointer, true);
    for (const list of lists) list.removeEventListener('change', onMedia);
  };
}

/**
 * The browser's own context menu (and the text-selection callout that comes
 * with a long press) never opens on the app's chrome when a finger or pen
 * is in use. Text fields and editable text keep it for copy and paste; the
 * app's own context menus call preventDefault themselves.
 */
export function shouldSuppressNativeContextMenu(target: EventTarget | null, touchInput: boolean): boolean {
  if (!touchInput || !(target instanceof Element)) return false;
  return !target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-native-context-menu]');
}

export function installNativeMenuGuard(): () => void {
  const onContextMenu = (event: Event) => {
    if (shouldSuppressNativeContextMenu(event.target, lastInputWasTouchOrPen())) event.preventDefault();
  };
  document.addEventListener('contextmenu', onContextMenu);
  return () => document.removeEventListener('contextmenu', onContextMenu);
}
