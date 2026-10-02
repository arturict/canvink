import { Cloud, CloudOff, RefreshCw, TriangleAlert, Smartphone } from 'lucide-react';
import { formatLocale } from '../i18n/core';
import { useI18n } from '../i18n';
import { statusLabelKey } from '../components/personal-space/SpaceStatusIndicator';
import { relativeTime } from './model';
import type { MobileWorkspace } from './useMobileWorkspace';

/**
 * One calm line about where the notes are: synced (and when), on the way,
 * offline with the count of changes waiting, or only on this device.
 */
export function SyncLine({ ws, now }: { ws: MobileWorkspace; now: Date }) {
  const { t, language } = useI18n();
  const status = ws.spaceStatus;
  const signedIn = ws.auth.available && ws.auth.isSignedIn;
  if (!ws.personalSpaceEnabled || !signedIn || status.kind === 'disabled' || status.kind === 'signed-out') {
    return (
      <span className="m-sync" data-state="local">
        <Smartphone size={14} aria-hidden="true" />
        {t('mobile.sync.localOnly')}
      </span>
    );
  }
  if (status.kind === 'synced') {
    const progress = ws.personalSpace.offlineProgress;
    return (
      <span className="m-sync" data-state="synced" role="status">
        <Cloud size={14} aria-hidden="true" />
        {progress
          ? t('space.status.downloading', { done: progress.total - progress.remaining, total: progress.total })
          : t('mobile.sync.syncedAt', { time: relativeTime(status.lastSyncedAt, now, formatLocale(language)) })}
      </span>
    );
  }
  if (status.kind === 'offline') {
    return (
      <span className="m-sync" data-state="offline" role="status">
        <CloudOff size={14} aria-hidden="true" />
        {status.pendingDocs > 0
          ? (status.pendingDocs === 1 ? t('space.status.pending.one') : t('space.status.pending', { count: status.pendingDocs }))
          : t('mobile.sync.offline')}
      </span>
    );
  }
  if (status.kind === 'bootstrapping' || status.kind === 'reconnecting') {
    return (
      <span className="m-sync" data-state="busy" role="status">
        <RefreshCw size={14} aria-hidden="true" className="m-spin" />
        {t(statusLabelKey(status))}
      </span>
    );
  }
  return (
    <span className="m-sync" data-state="warning" role="status">
      <TriangleAlert size={14} aria-hidden="true" />
      {t(statusLabelKey(status))}
    </span>
  );
}
