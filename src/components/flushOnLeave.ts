/**
 * Edits reach IndexedDB a moment after they are made (a short debounce in the
 * runtime and the shell). When the page is closed, or hidden (a tablet keeps a
 * hidden tab only until it needs the memory), the pending write starts at
 * once instead of waiting for its timer.
 *
 * `visibilitychange` covers tab switches and backgrounding, `pagehide` closing
 * and navigating away. Returns the function that removes both listeners.
 */
export function flushWhenLeaving(
  scope: EventTarget,
  page: EventTarget & { readonly visibilityState: string },
  flush: () => Promise<unknown>,
): () => void {
  const flushNow = (): void => {
    void flush().catch(() => undefined);
  };
  const onVisibilityChange = (): void => {
    if (page.visibilityState === 'hidden') flushNow();
  };
  scope.addEventListener('pagehide', flushNow);
  page.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    scope.removeEventListener('pagehide', flushNow);
    page.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
