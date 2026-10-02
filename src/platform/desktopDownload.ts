/**
 * The Windows installer is a static file of the web Worker (`public/download/`),
 * copied there from the desktop build. It has no code signature yet, so
 * Windows SmartScreen asks for confirmation on first launch.
 */
export const DESKTOP_DOWNLOAD_PATH = '/download/Canvink_x64-setup.exe';

/**
 * The Android app is a signed APK outside any store, a static file of the web
 * Worker like the installer (`pnpm release:android` copies it here, with the
 * `android.json` feed the app reads for a newer version).
 */
export const ANDROID_DOWNLOAD_PATH = '/download/Canvink.apk';
