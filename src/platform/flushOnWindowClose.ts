import { VIEWER_APP } from './viewerApp';

/** How long closing waits for the last write before the window goes anyway. */
export const CLOSE_FLUSH_TIMEOUT_MS = 5_000;

export interface CloseRequestEvent {
  preventDefault(): void;
}

export interface CloseableWindow {
  onCloseRequested(handler: (event: CloseRequestEvent) => Promise<void>): Promise<() => void>;
  destroy(): Promise<void>;
}

/**
 * The desktop app's window close is an OS event: `pagehide` is not guaranteed
 * to run, and an async write started there can be cut off when the process
 * exits. The close is held back until the pending edits (including unsealed
 * ink) are durable, then the window is destroyed. A failing or hanging write
 * does not trap the window open; the ink journal still holds the strokes.
 * Returns the function that removes the handler.
 */
export async function flushBeforeWindowClose(
  appWindow: CloseableWindow,
  flush: () => Promise<unknown>,
  timeoutMs = CLOSE_FLUSH_TIMEOUT_MS,
): Promise<() => void> {
  return appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    try {
      await flushWithTimeout(flush, timeoutMs);
    } finally {
      await appWindow.destroy();
    }
  });
}

/**
 * Waits for the flush, but never longer than the timeout and never fails: the
 * caller (closing the window, relaunching after an update) goes on either way,
 * because the ink journal still holds what a failed write did not save.
 */
export async function flushWithTimeout(
  flush: () => Promise<unknown>,
  timeoutMs = CLOSE_FLUSH_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([flush().catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers the close handler in the Tauri desktop app; a no-op in the browser.
 * The Android app has no window to close: it saves when it goes to the
 * background (`visibilitychange`, see flushOnLeave).
 */
export async function flushBeforeDesktopWindowClose(flush: () => Promise<unknown>): Promise<() => void> {
  if (typeof window === 'undefined' || window.__TAURI_INTERNALS__ === undefined || VIEWER_APP) return () => undefined;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return flushBeforeWindowClose(getCurrentWindow(), flush);
}
