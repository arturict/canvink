/**
 * The Android app is a viewer: it reads text, ink, images and PDF printouts,
 * edits text and searches, but never draws. The flag is fixed at build time
 * (`pnpm build:android`), so the web and desktop bundles keep every tool and
 * the bundler drops the viewer-only branches from them.
 */
export const VIEWER_APP: boolean = __CANVINK_VIEWER__;
