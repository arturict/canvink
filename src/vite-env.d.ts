/// <reference types="vite/client" />

declare const __CANVINK_COMMIT__: string;
declare const __CANVINK_VERSION__: string;
declare const __CANVINK_VIEWER__: boolean;

interface Window {
  __TAURI_INTERNALS__?: unknown;
}

interface ImportMetaEnv {
  readonly VITE_CANVINK_FEATURE_MATH_CANVAS?: string;
  readonly VITE_CANVINK_FEATURE_AI_ASSIST?: string;
}
