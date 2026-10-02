import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MigrationProgress } from '../storage/v2WorkspaceStorage';
import {
  WorkspaceV2RecoveryRequiredError,
  type V2RuntimeState,
  type WorkspaceV2Runtime,
} from '../storage/workspaceV2Runtime';

export type WorkspaceV2RuntimeFactory = (
  onMigrationProgress: (progress: MigrationProgress) => void,
) => WorkspaceV2Runtime | Promise<WorkspaceV2Runtime>;

export type WorkspaceV2StartupPhase =
  | 'opening'
  | 'migrating'
  | 'ready'
  | 'recovery-required'
  | 'failed';

export interface WorkspaceV2RuntimeView {
  phase: WorkspaceV2StartupPhase;
  runtime: WorkspaceV2Runtime | null;
  state: V2RuntimeState | null;
  progress: MigrationProgress | null;
  error: Error | null;
  recoveryCode: WorkspaceV2RecoveryRequiredError['code'] | null;
  retry: () => void;
}

export function useWorkspaceV2Runtime(
  factory: WorkspaceV2RuntimeFactory,
): WorkspaceV2RuntimeView {
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<WorkspaceV2StartupPhase>('opening');
  const [runtime, setRuntime] = useState<WorkspaceV2Runtime | null>(null);
  const [state, setState] = useState<V2RuntimeState | null>(null);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const lifecycleRef = useRef(0);
  const runtimePromiseRef = useRef<Promise<WorkspaceV2Runtime> | null>(null);
  const onProgress = useCallback((next: MigrationProgress) => {
    setProgress(next);
    if (next.phase !== 'active-v2' && next.phase !== 'failed') setPhase('migrating');
  }, []);
  const runtimePromise = useMemo(
    () => {
      void generation;
      return Promise.resolve(factory(onProgress));
    },
    [factory, generation, onProgress],
  );

  useEffect(() => {
    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    runtimePromiseRef.current = runtimePromise;
    let active = true;
    void runtimePromise.then(async (nextRuntime) => {
      if (!active) return;
      setRuntime(nextRuntime);
      const opened = await nextRuntime.startup();
      if (!active) return;
      const activated = opened.schemaVersion === 2
        ? opened
        : await nextRuntime.migrateV1ToV2();
      if (!active) return;
      setState(activated);
      setPhase('ready');
    }).catch((failure: unknown) => {
      if (!active) return;
      const nextError = failure instanceof Error ? failure : new Error(String(failure));
      setError(nextError);
      setPhase(
        nextError instanceof WorkspaceV2RecoveryRequiredError
          ? 'recovery-required'
          : 'failed',
      );
    });

    return () => {
      active = false;
      queueMicrotask(() => {
        const sameLifecycle = lifecycleRef.current === lifecycle;
        const replacedRuntime = runtimePromiseRef.current !== runtimePromise;
        if (!sameLifecycle && !replacedRuntime) return;
        void runtimePromise.then((nextRuntime) => nextRuntime.shutdown()).catch(() => undefined);
      });
    };
  }, [runtimePromise]);

  return {
    phase,
    runtime,
    state,
    progress,
    error,
    recoveryCode: error instanceof WorkspaceV2RecoveryRequiredError ? error.code : null,
    retry: () => {
      setPhase('opening');
      setRuntime(null);
      setState(null);
      setProgress(null);
      setError(null);
      setGeneration((current) => current + 1);
    },
  };
}
