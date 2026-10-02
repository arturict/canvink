/** The phone app looks for a newer APK on start and then this often. */
export const ANDROID_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type Invoke = <T>(command: string) => Promise<T>;

export interface AndroidUpdateInfo {
  version: string;
}

async function tauriInvoke(): Promise<Invoke> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

/** The newer published version, or null when the app is current, offline or the feed is unreachable. */
export async function checkAndroidUpdate(invoke?: Invoke): Promise<AndroidUpdateInfo | null> {
  try {
    const call = invoke ?? await tauriInvoke();
    return await call<AndroidUpdateInfo | null>('android_update_check');
  } catch {
    return null;
  }
}

/** Opens the APK download in the system browser, which installs it over the old version. */
export async function openAndroidUpdate(invoke?: Invoke): Promise<boolean> {
  try {
    const call = invoke ?? await tauriInvoke();
    return await call<boolean>('android_update_open');
  } catch {
    return false;
  }
}
