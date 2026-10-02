import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Download, RefreshCw, TriangleAlert } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  UPDATE_CHECK_INTERVAL_MS,
  createDesktopUpdateController,
  createTauriUpdaterDeps,
  isDesktopApp,
} from '../platform/desktopUpdater';
import { VIEWER_APP } from '../platform/viewerApp';

/**
 * Update button of the desktop app, next to the account and sync icon. The
 * desktop app bundles the web build, so a new version arrives as a signed
 * installer: "Update verfügbar" starts the download in the background,
 * "Neu starten" saves everything, installs and reopens. Renders nothing in the
 * browser and while there is no new version.
 */
export default function DesktopUpdateChip({ flush }: { flush: () => Promise<unknown> }) {
  // The phone app looks for its APK itself (src/mobile/AccountSheet.tsx): Tauri's updater has no Android support.
  return isDesktopApp() && !VIEWER_APP ? <DesktopUpdateChipInner flush={flush} /> : null;
}

function DesktopUpdateChipInner({ flush }: { flush: () => Promise<unknown> }) {
  const { t } = useI18n();
  // `flush` must be stable: a new one would build a new controller and lose the update state.
  const controller = useMemo(() => createDesktopUpdateController(createTauriUpdaterDeps(flush)), [flush]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    void controller.check();
    const timer = window.setInterval(() => void controller.check(), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [controller]);

  if (state.kind === 'idle') return null;

  const base = 'v2-update-chip';
  if (state.kind === 'available') {
    return (
      <button
        type="button"
        className={base}
        data-testid="update-chip"
        data-state="available"
        title={t('update.available.hint', { version: state.version })}
        onClick={() => void controller.download()}
      >
        <Download size={14} aria-hidden="true" />
        <span>{t('update.available')}</span>
      </button>
    );
  }
  if (state.kind === 'downloading') {
    const label = state.percent === null
      ? t('update.downloading')
      : t('update.downloading.percent', { percent: String(state.percent) });
    return (
      <span className={base} data-testid="update-chip" data-state="downloading" role="status" aria-live="polite">
        <RefreshCw size={14} className="v2-update-chip__spin" aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  }
  if (state.kind === 'ready' || state.kind === 'restarting') {
    return (
      <button
        type="button"
        className={`${base} ${base}--ready`}
        data-testid="update-chip"
        data-state={state.kind}
        disabled={state.kind === 'restarting'}
        title={t('update.ready.hint', { version: state.version })}
        onClick={() => void controller.restart()}
      >
        <RefreshCw size={14} aria-hidden="true" />
        <span>{state.kind === 'restarting' ? t('update.restarting') : t('update.ready')}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`${base} ${base}--error`}
      data-testid="update-chip"
      data-state="error"
      title={t('update.error.hint')}
      onClick={() => void (state.stage === 'download' ? controller.download() : controller.restart())}
    >
      <TriangleAlert size={14} aria-hidden="true" />
      <span>{t('update.error')}</span>
    </button>
  );
}
