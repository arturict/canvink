export interface FullscreenDocumentLike {
  fullscreenElement: Element | null;
  documentElement: Element & { requestFullscreen?: () => Promise<void> };
  exitFullscreen?: () => Promise<void>;
}

export async function toggleBrowserFullscreen(
  documentLike: FullscreenDocumentLike,
): Promise<boolean> {
  if (documentLike.fullscreenElement) {
    if (!documentLike.exitFullscreen) throw new Error('Fullscreen cannot be closed in this environment.');
    await documentLike.exitFullscreen();
    return false;
  }
  if (!documentLike.documentElement.requestFullscreen) {
    throw new Error('Fullscreen is not supported in this environment.');
  }
  await documentLike.documentElement.requestFullscreen();
  return true;
}

export async function toggleAppFullscreen(): Promise<boolean> {
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();
    const next = !(await appWindow.isFullscreen());
    await appWindow.setFullscreen(next);
    return next;
  }
  return toggleBrowserFullscreen(document);
}

/** Enters or leaves document fullscreen; a no-op when it is already in that state. */
export async function setBrowserFullscreen(
  documentLike: FullscreenDocumentLike,
  next: boolean,
): Promise<boolean> {
  if (Boolean(documentLike.fullscreenElement) === next) return next;
  return toggleBrowserFullscreen(documentLike);
}

/**
 * Puts the app window into or out of fullscreen: the Tauri window on the
 * desktop, the document in a browser. The full page view uses it to hide the
 * operating system's chrome as well; it works without it where fullscreen is
 * unavailable (iPad Safari, embedded views).
 */
export async function setAppFullscreen(next: boolean): Promise<boolean> {
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();
    if ((await appWindow.isFullscreen()) !== next) await appWindow.setFullscreen(next);
    return next;
  }
  return setBrowserFullscreen(document, next);
}
