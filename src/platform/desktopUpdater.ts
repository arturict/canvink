import { flushWithTimeout } from './flushOnWindowClose';

/** The desktop app looks for a new version on start and then this often. */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export type UpdateStage = 'check' | 'download' | 'restart';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'restarting'; version: string }
  | { kind: 'error'; version: string; stage: Exclude<UpdateStage, 'check'> };

/** The part of the Tauri updater the controller uses, so tests need no Tauri. */
export interface PendingUpdate {
  version: string;
  download(onProgress: (downloaded: number, total: number | null) => void): Promise<void>;
  /** On Windows the installer takes over and ends the process; elsewhere it returns. */
  install(): Promise<void>;
}

export interface DesktopUpdaterDeps {
  check(): Promise<PendingUpdate | null>;
  relaunch(): Promise<void>;
  /** Writes queued ink, the storage runtime and starts a sync before the app is replaced. */
  flush(): Promise<unknown>;
}

export interface DesktopUpdateController {
  getState(): UpdateState;
  subscribe(listener: () => void): () => void;
  /** Looks for a new version; silent when there is none or the network is down. */
  check(): Promise<void>;
  /** Downloads the found version in the background. */
  download(): Promise<void>;
  /** Flushes, installs the downloaded version and relaunches. */
  restart(): Promise<void>;
}

export function createDesktopUpdateController(deps: DesktopUpdaterDeps): DesktopUpdateController {
  let state: UpdateState = { kind: 'idle' };
  let pending: PendingUpdate | null = null;
  const listeners = new Set<() => void>();

  const set = (next: UpdateState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async check() {
      // Nothing to look for while a version is on its way or waiting for the restart.
      if (state.kind !== 'idle') return;
      try {
        const found = await deps.check();
        if (!found || state.kind !== 'idle') return;
        pending = found;
        set({ kind: 'available', version: found.version });
      } catch {
        // A failed check (offline, feed not reachable) is not worth a message; the next check retries.
      }
    },
    async download() {
      if (!pending || (state.kind !== 'available' && state.kind !== 'error')) return;
      if (state.kind === 'error' && state.stage !== 'download') return;
      const { version } = pending;
      set({ kind: 'downloading', version, percent: null });
      try {
        await pending.download((downloaded, total) => {
          const percent = total && total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : null;
          if (state.kind === 'downloading' && state.percent !== percent) set({ kind: 'downloading', version, percent });
        });
        set({ kind: 'ready', version });
      } catch {
        set({ kind: 'error', version, stage: 'download' });
      }
    },
    async restart() {
      if (!pending || (state.kind !== 'ready' && !(state.kind === 'error' && state.stage === 'restart'))) return;
      const { version } = state;
      set({ kind: 'restarting', version });
      try {
        await flushWithTimeout(deps.flush);
        await pending.install();
        await deps.relaunch();
      } catch {
        set({ kind: 'error', version, stage: 'restart' });
      }
    },
  };
}

/** True in the Tauri desktop app, false in the browser. */
export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

/**
 * The real updater. The Tauri plugins are imported on first use, so the web
 * build never loads them.
 */
export function createTauriUpdaterDeps(flush: () => Promise<unknown>): DesktopUpdaterDeps {
  return {
    flush,
    async check() {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        download: (onProgress) => {
          let downloaded = 0;
          let total: number | null = null;
          return update.download((event) => {
            if (event.event === 'Started') total = event.data.contentLength ?? null;
            else if (event.event === 'Progress') downloaded += event.data.chunkLength;
            onProgress(downloaded, total);
          });
        },
        install: () => update.install(),
      };
    },
    async relaunch() {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}
