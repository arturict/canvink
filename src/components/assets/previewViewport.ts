import { useEffect, useState } from 'react';

/**
 * How close a printout page is to what the canvas shows.
 *
 * near: within a screen of the visible area; the sharp picture is decoded.
 * mid:  within four screens; only its 200 px thumbnail is decoded.
 * far:  nothing is decoded; the light placeholder of the exact final size shows.
 */
export type Zone = 'far' | 'mid' | 'near';

const NEAR_MARGIN = '100% 100% 100% 100%';
const MID_MARGIN = '400% 100% 400% 100%';

interface Watcher {
  node: Element;
  near: boolean;
  mid: boolean;
  notify(zone: Zone): void;
}

interface Registry {
  watchers: Map<Element, Watcher>;
  observers: [IntersectionObserver, IntersectionObserver];
}

// One pair of observers per canvas viewport, however many pages it holds.
const registries = new Map<Element | null, Registry>();

function zoneOf(watcher: Watcher): Zone {
  return watcher.near ? 'near' : watcher.mid ? 'mid' : 'far';
}

function registryFor(root: Element | null): Registry {
  let registry = registries.get(root);
  if (registry) return registry;
  const made: Registry = { watchers: new Map(), observers: undefined as unknown as Registry['observers'] };
  const observe = (margin: string, key: 'near' | 'mid') => new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const watcher = made.watchers.get(entry.target);
      if (!watcher) continue;
      const before = zoneOf(watcher);
      watcher[key] = entry.isIntersecting;
      const after = zoneOf(watcher);
      if (after !== before) watcher.notify(after);
    }
  }, { root, rootMargin: margin });
  made.observers = [observe(NEAR_MARGIN, 'near'), observe(MID_MARGIN, 'mid')];
  registries.set(root, made);
  registry = made;
  return registry;
}

/** Reports the zone of `node` now and whenever it changes. Returns the way to stop. */
export function watchZone(node: Element, notify: (zone: Zone) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    notify('near');
    return () => undefined;
  }
  // The canvas clips its content, so its margin, not the window's, decides what counts as close.
  const root = node.closest('.live-canvas-viewport');
  const registry = registryFor(root);
  registry.watchers.set(node, { node, near: false, mid: false, notify });
  for (const observer of registry.observers) observer.observe(node);
  return () => {
    registry.watchers.delete(node);
    for (const observer of registry.observers) observer.unobserve(node);
    if (registry.watchers.size === 0) {
      for (const observer of registry.observers) observer.disconnect();
      registries.delete(root);
    }
  };
}

export function useZone(node: Element | null): Zone {
  const [zone, setZone] = useState<Zone>(typeof IntersectionObserver === 'undefined' ? 'near' : 'far');
  useEffect(() => (node ? watchZone(node, setZone) : undefined), [node]);
  return zone;
}

/**
 * Screens between `node` and the visible area, times ten and rounded: 0 while
 * any of it is on screen. The cloud fetch queue serves the smallest first.
 */
export function fetchPriority(node: Element | null): number {
  if (!node) return 100;
  const viewport = node.closest('.live-canvas-viewport')?.getBoundingClientRect();
  if (!viewport || viewport.height === 0) return 0;
  const rect = node.getBoundingClientRect();
  const gap = rect.bottom < viewport.top ? viewport.top - rect.bottom : rect.top > viewport.bottom ? rect.top - viewport.bottom : 0;
  return Math.round((gap / viewport.height) * 10);
}

/**
 * Decoded pictures that stay on screen or were on it a moment ago, within a
 * memory budget. A picture being looked at is pinned; the rest go least
 * recently used first, and an evicted picture falls back to its thumbnail.
 */
export class DecodedBudget {
  private readonly entries = new Map<string, { bytes: number; pinned: boolean; evict(): void }>();
  private total = 0;

  constructor(private readonly budgetBytes: number) {}

  add(key: string, bytes: number, evict: () => void): void {
    this.remove(key);
    this.entries.set(key, { bytes, pinned: true, evict });
    this.total += bytes;
    this.enforce();
  }

  /** Marks a picture as looked at (pinned) or as a candidate for eviction, and as most recently used either way. */
  pin(key: string, pinned: boolean): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.pinned = pinned;
    this.entries.set(key, entry);
    this.enforce();
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
  }

  stats(): { bytes: number; pictures: number } {
    return { bytes: this.total, pictures: this.entries.size };
  }

  private enforce(): void {
    for (const [key, entry] of [...this.entries]) {
      if (this.total <= this.budgetBytes) return;
      if (entry.pinned) continue;
      this.remove(key);
      entry.evict();
    }
  }
}

/** Decoded RGBA of the pictures kept for a moment after they left the screen, at most. */
export const decodedPictures = new DecodedBudget(160 * 1024 * 1024);

/**
 * Calls `onSettled` once the canvas has stopped moving and zooming for a
 * moment. The canvas moves by rewriting its surface's transform, so that
 * attribute is what to watch; there is one watcher per canvas viewport.
 */
const SETTLE_MS = 250;
const settleRegistries = new Map<Element, { listeners: Set<() => void>; observer: MutationObserver; timer: ReturnType<typeof setTimeout> | undefined }>();

export function watchSettled(node: Element, onSettled: () => void): () => void {
  const root = node.closest('.live-canvas-viewport');
  const surface = root?.querySelector('.live-canvas-surface');
  if (!root || !surface || typeof MutationObserver === 'undefined') return () => undefined;
  let registry = settleRegistries.get(root);
  if (!registry) {
    const made = {
      listeners: new Set<() => void>(),
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      observer: new MutationObserver(() => {
        if (made.timer !== undefined) clearTimeout(made.timer);
        made.timer = setTimeout(() => {
          made.timer = undefined;
          for (const listener of [...made.listeners]) listener();
        }, SETTLE_MS);
      }),
    };
    made.observer.observe(surface, { attributes: true, attributeFilter: ['style'] });
    settleRegistries.set(root, made);
    registry = made;
  }
  registry.listeners.add(onSettled);
  const joined = registry;
  return () => {
    joined.listeners.delete(onSettled);
    if (joined.listeners.size > 0) return;
    if (joined.timer !== undefined) clearTimeout(joined.timer);
    joined.observer.disconnect();
    settleRegistries.delete(root);
  };
}
