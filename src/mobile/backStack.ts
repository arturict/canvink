import { useEffect, useRef, useSyncExternalStore } from 'react';
import { hasNativeBridge, setNativeBackEnabled } from './nativeBridge';

/**
 * Android's back gesture and button for the phone app.
 *
 * In the app, MainActivity asks the page through `window.__canvinkBack`
 * whenever back is used while the page said it has somewhere to go back to
 * (setBackEnabled); otherwise the system leaves the app. Android 14 and later
 * send the gesture's progress too ("predictive back"), so the screen follows
 * the finger before it is committed or cancelled.
 *
 * In a browser (tests, a phone's browser) every step back is a history entry,
 * so the browser's back button and gesture do the same.
 *
 * Open layers (sheets, menus) close first, newest first; then the screens of
 * the navigation stack (see navigation.ts) are popped.
 */

export type BackPhase = 'started' | 'progress' | 'cancelled' | 'pressed';
export interface BackProgress {
  phase: Exclude<BackPhase, 'pressed'>;
  /** 0 to 1 while the gesture is held. */
  progress: number;
  /** The screen edge the gesture started from. */
  edge: 'left' | 'right';
}

interface Layer {
  id: number;
  close: () => void;
}

let layers: Layer[] = [];
let layerId = 0;
const layerListeners = new Set<() => void>();

function notifyLayers(): void {
  for (const listener of layerListeners) listener();
}

function subscribeLayers(listener: () => void): () => void {
  layerListeners.add(listener);
  return () => layerListeners.delete(listener);
}

function layerCount(): number {
  return layers.length;
}

/** While `open`, back closes this layer (a sheet, a menu) before anything else. */
export function useBackLayer(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return undefined;
    layerId += 1;
    const layer: Layer = { id: layerId, close: () => closeRef.current() };
    layers = [...layers, layer];
    notifyLayers();
    return () => {
      layers = layers.filter((candidate) => candidate !== layer);
      notifyLayers();
    };
  }, [open]);
}

export interface BackNavigationOptions {
  /** Steps back the screen stack still has inside the app. */
  depth: number;
  /** Goes one screen back. */
  onBack: () => void;
  /** Progress of a predictive back gesture on the top screen (Android 14+). */
  onProgress?: (progress: BackProgress) => void;
}

/**
 * Connects the screen stack and the open layers to the system's back. Used
 * once, by the app's root.
 */
export function useBackNavigation({ depth, onBack, onProgress }: BackNavigationOptions): void {
  const openLayers = useSyncExternalStore(subscribeLayers, layerCount, layerCount);
  const latest = useRef({ onBack, onProgress, depth });
  useEffect(() => {
    latest.current = { onBack, onProgress, depth };
  });
  const native = hasNativeBridge();
  const total = depth + openLayers;

  /** One step back: the newest layer, else the top screen. */
  const stepBack = useRef(() => {
    const layer = layers[layers.length - 1];
    if (layer) {
      layer.close();
      return;
    }
    if (latest.current.depth > 0) latest.current.onBack();
  });

  // The app: the native side calls in for each back gesture.
  useEffect(() => {
    if (!native) return undefined;
    window.__canvinkBack = (phase, progress, edge) => {
      const onTop = layers.length === 0;
      if (phase === 'pressed') {
        stepBack.current();
        return;
      }
      if (!onTop) return;
      if (phase === 'started' || phase === 'progress' || phase === 'cancelled') {
        latest.current.onProgress?.({ phase, progress: Math.min(1, Math.max(0, progress)), edge: edge === 1 ? 'right' : 'left' });
      }
    };
    return () => {
      delete window.__canvinkBack;
    };
  }, [native]);

  useEffect(() => {
    if (native) setNativeBackEnabled(total > 0);
  }, [native, total]);

  // A browser: one history entry per step back.
  const historyDepth = useRef(0);
  const silentPops = useRef(0);
  useEffect(() => {
    if (native) return undefined;
    const onPopState = () => {
      if (silentPops.current > 0) {
        silentPops.current -= 1;
        return;
      }
      if (historyDepth.current === 0) return;
      historyDepth.current -= 1;
      stepBack.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [native]);
  useEffect(() => {
    if (native) return;
    if (total > historyDepth.current) {
      for (let step = historyDepth.current; step < total; step += 1) {
        window.history.pushState({ canvinkBack: step + 1 }, '');
      }
      historyDepth.current = total;
    } else if (total < historyDepth.current) {
      // Closed in the app (a back arrow, a tab): drop the entries it held.
      const extra = historyDepth.current - total;
      historyDepth.current = total;
      silentPops.current += 1;
      window.history.go(-extra);
    }
  }, [native, total]);
}

/** Closes every open layer (navigating somewhere new). */
export function closeAllLayers(): void {
  for (const layer of [...layers].reverse()) layer.close();
}
