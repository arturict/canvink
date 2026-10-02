import { useEffect, useRef } from 'react';
import { LegacyPageRebuilder, type RebuildRuntime } from '../ink/legacyRebuild';
import { pendingInk } from '../ink/pendingInk';
import type { SpaceStatus } from '../personal-space/contract';
import type { V2RuntimeState, WorkspaceV2Runtime } from '../storage/workspaceV2Runtime';
import { VIEWER_APP } from '../platform/viewerApp';
import { localDeviceId } from './v2WorkspaceView';

const INK_FREE_KEY = 'canvink:ink-free-documents:v1';
const INK_FREE_LIMIT = 4_000;

/** Documents found to hold no strokes of their own, remembered on this device (see `LegacyRebuildOptions.inkFree`). */
function inkFreeMarks(storage: Storage | null): { has(documentId: string): boolean; add(documentId: string): void } {
  let ids = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(INK_FREE_KEY) ?? '[]');
    if (Array.isArray(parsed)) ids = new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    // Unreadable marks only mean that the documents are looked at again.
  }
  return {
    has: (documentId) => ids.has(documentId),
    add: (documentId) => {
      ids.add(documentId);
      if (ids.size > INK_FREE_LIMIT) ids = new Set([...ids].slice(ids.size - INK_FREE_LIMIT));
      try {
        storage?.setItem(INK_FREE_KEY, JSON.stringify([...ids]));
      } catch {
        // A full or blocked storage only means that the documents are looked at again.
      }
    },
  };
}

/**
 * Starts the background rebuild of legacy pages (see ink/legacyRebuild.ts) for the open workspace.
 * It runs only for a signed-in-or-local writer (never a viewer), when the page is visible and the
 * personal space, if there is one, has caught up. The user sees nothing; the remaining count is
 * published as a data attribute on the document element for tests and benchmarks.
 */
export function useLegacyInkRebuild(params: {
  runtime: WorkspaceV2Runtime | null;
  workspace: V2RuntimeState | null;
  activePageId: string | undefined;
  viewerMode: boolean;
  spaceStatus: SpaceStatus;
  recentPageIds: readonly string[];
}): void {
  const { runtime, workspace, activePageId, viewerMode, spaceStatus, recentPageIds } = params;
  const rebuilderRef = useRef<LegacyPageRebuilder | null>(null);
  const spaceStatusRef = useRef(spaceStatus);
  const recentRef = useRef(recentPageIds);
  const lastActivityRef = useRef(0);
  // The phone viewer never rewrites ink, not even to migrate old strokes.
  const enabled = Boolean(runtime) && workspace?.schemaVersion === 3 && !viewerMode && !VIEWER_APP;

  useEffect(() => {
    spaceStatusRef.current = spaceStatus;
    recentRef.current = recentPageIds;
  }, [spaceStatus, recentPageIds]);

  useEffect(() => {
    lastActivityRef.current = Date.now();
    const touch = (): void => { lastActivityRef.current = Date.now(); };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true });
    return () => { for (const name of events) window.removeEventListener(name, touch); };
  }, []);

  useEffect(() => {
    if (!enabled || !runtime) return;
    const rebuilder = new LegacyPageRebuilder({
      runtime: runtime as unknown as RebuildRuntime,
      deviceId: localDeviceId(typeof localStorage === 'undefined' ? null : localStorage),
      inkFree: inkFreeMarks(typeof localStorage === 'undefined' ? null : localStorage),
      isQuiet: (ms) => Date.now() - lastActivityRef.current >= ms && pendingInk().documentsWithPendingInk().length === 0,
      canRun: () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
        const kind = spaceStatusRef.current.kind;
        return kind === 'disabled' || kind === 'signed-out' || kind === 'synced';
      },
      recentPageIds: () => recentRef.current,
      onRebuilt: () => {
        const root = document.documentElement;
        root.dataset.inkRebuilt = String(Number(root.dataset.inkRebuilt ?? '0') + 1);
      },
      onProgress: (remaining) => {
        document.documentElement.dataset.inkRebuild = remaining > 0 ? String(remaining) : 'done';
      },
    });
    rebuilderRef.current = rebuilder;
    rebuilder.start();
    return () => {
      rebuilder.stop();
      rebuilderRef.current = null;
    };
  }, [enabled, runtime]);

  useEffect(() => {
    if (activePageId) rebuilderRef.current?.onPageOpened(activePageId);
  }, [activePageId, enabled]);
}
