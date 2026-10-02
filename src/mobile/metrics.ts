/**
 * Start-up and page-open times of the phone app, measured where they end and
 * logged by the native side (MainActivity, `adb logcat -s Canvink`). In a
 * browser they stay in the Performance timeline (performance.getEntriesByType('measure')).
 */

import { nativeMetric } from './nativeBridge';

let pageOpenStart: { pageId: string; at: number } | null = null;
const reported = new Set<string>();

function report(name: string, milliseconds: number): void {
  const value = Math.round(milliseconds);
  try {
    performance.measure(`canvink:${name}`, { start: performance.now() - value, duration: value });
  } catch {
    // Older engines without measure options: the native log below still has it.
  }
  nativeMetric(name, value);
}

/** Once per start: the first screen with the person's notes has painted. */
export function reportFirstScreen(name: 'home' | 'page'): void {
  const key = `first-${name}`;
  if (reported.has(key)) return;
  reported.add(key);
  requestAnimationFrame(() => requestAnimationFrame(() => report(key, performance.now())));
}

/** A page is about to open after a tap. */
export function startPageOpen(pageId: string): void {
  pageOpenStart = { pageId, at: performance.now() };
}

/** The opened page's content has painted. */
export function finishPageOpen(pageId: string): void {
  if (!pageOpenStart || pageOpenStart.pageId !== pageId) return;
  const started = pageOpenStart.at;
  pageOpenStart = null;
  report('page-open', performance.now() - started);
}
