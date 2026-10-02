/**
 * The Android app's native half (src-tauri/gen/android/.../MainActivity.kt)
 * exposes `window.CanvinkAndroid` to the page: haptics, the system back
 * gesture, the system bars' insets, sharing and the splash screen. Everything
 * here is a no-op in a browser, so the mobile shell runs the same there.
 */

export type HapticKind = 'tick' | 'confirm' | 'reject' | 'long';

interface CanvinkAndroidInterface {
  haptic(kind: string): void;
  /** Whether the app handles back itself (a screen or sheet to close) or the system leaves the app. */
  setBackEnabled(enabled: boolean): void;
  /** JSON of the system bar insets in CSS pixels: {top, bottom, left, right, keyboard, fontScale}. */
  insets(): string;
  /** Light or dark icons in the status and navigation bars. */
  setSystemBars(lightBackground: boolean): void;
  shareText(subject: string, text: string): void;
  shareFile(base64: string, mimeType: string, fileName: string, subject: string): void;
  /** The first screen has painted: the system splash screen may go. */
  ready(): void;
  /** Logs a start-up or page-open time (src/mobile/metrics.ts). */
  metric(name: string, milliseconds: number): void;
}

export interface NativeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Height of the on-screen keyboard (the window is already shortened by it). */
  keyboard: number;
  /** The system's font size setting, 1 for the default. */
  fontScale: number;
}

declare global {
  interface Window {
    CanvinkAndroid?: CanvinkAndroidInterface;
    /** Called by MainActivity for the back gesture (see backStack.ts). */
    __canvinkBack?: (phase: string, progress: number, edge: number) => void;
    /** Called by MainActivity when the system bars or the keyboard change. */
    __canvinkInsets?: (insets: NativeInsets) => void;
  }
}

function bridge(): CanvinkAndroidInterface | null {
  return typeof window !== 'undefined' && window.CanvinkAndroid ? window.CanvinkAndroid : null;
}

export function hasNativeBridge(): boolean {
  return bridge() !== null;
}

export function haptic(kind: HapticKind): void {
  try {
    bridge()?.haptic(kind);
  } catch {
    // Haptics are a nicety; a failing call changes nothing else.
  }
}

export function setNativeBackEnabled(enabled: boolean): void {
  try {
    bridge()?.setBackEnabled(enabled);
  } catch {
    // Without the bridge the history fallback handles back (see backStack.ts).
  }
}

export function setSystemBarsLight(light: boolean): void {
  try {
    bridge()?.setSystemBars(light);
  } catch {
    // The system keeps its own choice.
  }
}

export function nativeReady(): void {
  try {
    bridge()?.ready();
  } catch {
    // The splash screen leaves on its own after a short timeout.
  }
}

export function nativeMetric(name: string, milliseconds: number): void {
  try {
    bridge()?.metric(name, milliseconds);
  } catch {
    // Measuring never disturbs the app.
  }
}

export function parseInsets(json: string | null | undefined): NativeInsets | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null) return null;
    const read = (key: string, fallback = 0) => {
      const entry = (value as Record<string, unknown>)[key];
      return typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? entry : fallback;
    };
    return {
      top: read('top'),
      bottom: read('bottom'),
      left: read('left'),
      right: read('right'),
      keyboard: read('keyboard'),
      fontScale: read('fontScale', 1) || 1,
    };
  } catch {
    return null;
  }
}

/**
 * Publishes the native insets as CSS variables on the root element and keeps
 * them current. In a browser the CSS falls back to env(safe-area-inset-*).
 */
export function installNativeInsets(): () => void {
  const native = bridge();
  if (!native) return () => undefined;
  const apply = (insets: NativeInsets) => {
    const style = document.documentElement.style;
    style.setProperty('--native-inset-top', `${insets.top}px`);
    style.setProperty('--native-inset-bottom', `${insets.bottom}px`);
    style.setProperty('--native-inset-left', `${insets.left}px`);
    style.setProperty('--native-inset-right', `${insets.right}px`);
    style.setProperty('--font-scale', String(Math.min(2, Math.max(0.8, insets.fontScale))));
    document.documentElement.dataset.keyboard = insets.keyboard > 0 ? 'open' : 'closed';
    window.dispatchEvent(new Event('canvink:insets'));
  };
  let initial: NativeInsets | null;
  try {
    initial = parseInsets(native.insets());
  } catch {
    initial = null;
  }
  if (initial) apply(initial);
  window.__canvinkInsets = apply;
  return () => {
    if (window.__canvinkInsets === apply) delete window.__canvinkInsets;
  };
}

/** Shares a link or text through the system's share sheet; false when there is none. */
export async function shareText(subject: string, text: string): Promise<boolean> {
  const native = bridge();
  if (native) {
    native.shareText(subject, text);
    return true;
  }
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: subject, text });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Shares a file (a page as PDF) through the system's share sheet; false when there is none. */
export async function shareFile(bytes: Uint8Array, mimeType: string, fileName: string, subject: string): Promise<boolean> {
  const native = bridge();
  if (native) {
    native.shareFile(base64(bytes), mimeType, fileName, subject);
    return true;
  }
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof File !== 'undefined') {
    const file = new File([bytes.slice().buffer], fileName, { type: mimeType });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: subject });
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}
