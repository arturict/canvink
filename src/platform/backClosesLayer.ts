import { useEffect } from 'react';
import { VIEWER_APP } from './viewerApp';

/**
 * Android's back gesture closes the layer on top (navigation drawer, account
 * menu) before it leaves the app. While a layer is open it owns one history
 * entry, so the WebView's back navigation pops that entry instead of exiting,
 * and the popstate closes the layer. Without an open layer back still exits.
 * A no-op outside the Android app.
 *
 * Chrome's WebView skips history entries that were added before the person
 * touched the page, so a layer that is already open at start (the drawer)
 * takes its entry with the first touch. Until then back leaves the app.
 */
export function useBackClosesLayer(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!VIEWER_APP || !open) return undefined;
    let pushed = false;
    let popped = false;
    const onPop = () => {
      popped = true;
      close();
    };
    const push = () => {
      pushed = true;
      window.history.pushState({ canvinkLayer: true }, '');
      window.addEventListener('popstate', onPop, { once: true });
    };
    let waiting: (() => void) | null = null;
    if (window.navigator.userActivation?.hasBeenActive ?? true) {
      push();
    } else {
      waiting = () => window.setTimeout(() => {
        if (!pushed && window.navigator.userActivation?.hasBeenActive) push();
      }, 0);
      window.addEventListener('pointerup', waiting, { once: true, capture: true });
    }
    return () => {
      if (waiting) window.removeEventListener('pointerup', waiting, true);
      window.removeEventListener('popstate', onPop);
      // Closed another way (a tap): drop the entry the layer added.
      if (pushed && !popped && (window.history.state as { canvinkLayer?: boolean } | null)?.canvinkLayer) window.history.back();
    };
    // `close` only sets state; the layer's lifetime is `open`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
