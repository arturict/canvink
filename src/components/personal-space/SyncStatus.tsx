/**
 * The one place that answers "is my work safe?": a small icon in the topbar
 * for the local save and, with an account, the sync with the cloud. Like
 * OneNote's sync status it only reports and lets you retry; the account lives
 * behind the avatar. The icon carries the state, its tooltip says it in words,
 * and a click opens a popover with the last sync, anything still waiting and
 * the one action that helps. State logic is in `syncView.ts`.
 */

import { useEffect, useState } from 'react';
import { Cloud, CloudCheck, CloudOff, HardDrive, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import { formatLocale } from '../../i18n/core';
import type { SpaceStatus } from '../../personal-space';
import { relativeTime } from '../../personal-space';
import { useBackClosesLayer } from '../../platform/backClosesLayer';
import { downloadPercent, statusLabelKey, statusPendingCount } from './SpaceStatusIndicator';
import { needsSignIn, syncView, type LocalSaveState, type SyncIcon, type SyncKind } from './syncView';

const ICONS: Record<SyncIcon, LucideIcon> = {
  'hard-drive': HardDrive,
  'cloud-check': CloudCheck,
  refresh: RefreshCw,
  'cloud-off': CloudOff,
  warning: TriangleAlert,
};

const TIP_KEYS: Record<SyncKind, TranslationKey> = {
  'local-saved': 'sync.tip.localSaved',
  'local-saving': 'sync.tip.localSaving',
  'local-error': 'sync.tip.localFailed',
  synced: 'sync.tip.synced',
  syncing: 'sync.tip.syncing',
  offline: 'sync.tip.offline',
  'needs-sign-in': 'sync.tip.needsSignIn',
  quota: 'sync.tip.quota',
  error: 'sync.tip.error',
};

const HEADING_KEYS: Record<SyncKind, TranslationKey> = {
  'local-saved': 'sync.heading.localSaved',
  'local-saving': 'sync.heading.localSaving',
  'local-error': 'sync.heading.localFailed',
  synced: 'sync.heading.synced',
  syncing: 'sync.heading.syncing',
  offline: 'sync.heading.offline',
  'needs-sign-in': 'sync.heading.needsSignIn',
  quota: 'sync.heading.quota',
  error: 'sync.heading.error',
};

type Translate = ReturnType<typeof useI18n>['t'];

/** Under a minute ago reads "gerade eben", not "vor 12 Sekunden". */
function isJustNow(iso: string, now: number): boolean {
  return now - Date.parse(iso) < 60_000;
}

/** The state in one short sentence: the tooltip, and the sync line of the account menu. */
export function syncSentence(
  t: Translate,
  save: LocalSaveState,
  status: SpaceStatus | null,
  now: number,
  locale: string,
): string {
  const view = syncView(save, status);
  // While a local write is under way the tooltip says so, whatever the cloud does.
  if (save === 'saving' && view.kind === 'synced') return t('sync.tip.localSaving');
  if (status?.kind === 'synced' && view.kind === 'synced') {
    return isJustNow(status.lastSyncedAt, now)
      ? t('sync.tip.syncedNow')
      : t('sync.tip.synced', { time: relativeTime(status.lastSyncedAt, now, locale) });
  }
  return t(TIP_KEYS[view.kind]);
}

export interface SyncStatusProps {
  save: { state: LocalSaveState; error: string | null };
  /** The personal-space status; null without an account. */
  status: SpaceStatus | null;
  /** Pages still to be downloaded for the offline copies. */
  offlineProgress?: { remaining: number; total: number } | null;
  /** Local-only: offer to sign in from the popover. */
  canSignIn: boolean;
  onSyncNow(): void;
  onSignIn(): void;
  onOpenStorage(): void;
}

export default function SyncStatus({
  save,
  status,
  offlineProgress = null,
  canSignIn,
  onSyncNow,
  onSignIn,
  onOpenStorage,
}: SyncStatusProps) {
  const { t, language } = useI18n();
  const locale = formatLocale(language);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useBackClosesLayer(open, () => setOpen(false));
  useEffect(() => {
    // "vor 5 Minuten" ages while nothing else changes.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const view = syncView(save.state, status);
  const cloud = status && status.kind !== 'disabled' && status.kind !== 'signed-out' ? status : null;
  const Icon = ICONS[view.icon];
  const sentence = syncSentence(t, save.state, status, now, locale);
  const downloading = offlineProgress && cloud?.kind === 'synced' ? offlineProgress : null;
  const downloaded = downloading ? downloading.total - downloading.remaining : 0;
  const downloadLabel = downloading ? t('space.status.downloading', { done: downloaded, total: downloading.total }) : '';
  const pending = cloud ? statusPendingCount(cloud) : null;
  const close = () => setOpen(false);
  const readable = cloud ? t(statusLabelKey(cloud)) : '';
  const accountLine = cloud ? t(statusLabelKey(cloud)) : '';
  const lastSynced = cloud?.kind === 'synced'
    ? isJustNow(cloud.lastSyncedAt, now) ? t('sync.row.justNow') : relativeTime(cloud.lastSyncedAt, now, locale)
    : null;

  return (
    <>
    <details
      className="sync-status"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) setOpen(next);
        if (next) setNow(Date.now());
      }}
    >
      <summary
        role="button"
        className="sync-status__button topbar-action topbar-action--icon"
        data-testid="save-status"
        data-state={save.state}
        data-sync={view.kind}
        data-tone={view.tone}
        data-motion={view.motion}
        data-downloading={downloading ? 'true' : undefined}
        aria-label={t('sync.button', { state: sentence })}
        aria-expanded={open}
        title={sentence}
      >
        <Icon size={16} aria-hidden="true" />
        {downloading ? (
          <span
            className="sync-status__progress"
            role="progressbar"
            aria-label={downloadLabel}
            aria-valuemin={0}
            aria-valuemax={downloading.total}
            aria-valuenow={downloaded}
            data-offline-remaining={downloading.remaining}
          >
            <span style={{ width: `${downloadPercent(downloading)}%` }} />
          </span>
        ) : null}
        {/* Without an account the label says it all and the icon carries no text, as before. */}
        {cloud ? <span className="sr-only">{readable}</span> : null}
      </summary>
      <section className="sync-status__popover" aria-label={t(HEADING_KEYS[view.kind])}>
        <div className="sync-status__heading" data-tone={view.tone}>
          <Icon size={18} aria-hidden="true" />
          <strong>{t(HEADING_KEYS[view.kind])}</strong>
        </div>
        <dl className="sync-status__rows">
          <div>
            <dt>{t('sync.row.device')}</dt>
            <dd>
              {save.state === 'error'
                ? t('sync.row.deviceFailed')
                : save.state === 'saving'
                  ? t('sync.row.deviceSaving')
                  : t('sync.row.deviceSaved')}
            </dd>
          </div>
          {cloud ? (
            <div>
              <dt>{t('sync.row.account')}</dt>
              <dd>{accountLine}</dd>
            </div>
          ) : null}
          {lastSynced ? (
            <div>
              <dt>{t('sync.row.lastSynced')}</dt>
              <dd>{lastSynced}</dd>
            </div>
          ) : null}
        </dl>
        {downloading ? (
          <div className="sync-status__download">
            <span>{downloadLabel}</span>
            <span className="sync-status__bar" aria-hidden="true">
              <span style={{ width: `${downloadPercent(downloading)}%` }} />
            </span>
          </div>
        ) : null}
        {pending !== null && pending > 0 ? (
          <p className="sync-status__note">
            {pending === 1 ? t('space.status.pending.one') : t('space.status.pending', { count: pending })}
          </p>
        ) : null}
        <SyncNote t={t} kind={view.kind} status={status} saveError={save.error} />
        <div className="sync-status__actions">
          <SyncAction
            t={t}
            kind={view.kind}
            canSignIn={canSignIn}
            quotaScope={status?.kind === 'quota-exceeded' ? status.scope : null}
            onSyncNow={onSyncNow}
            onSignIn={() => { close(); onSignIn(); }}
            onOpenStorage={() => { close(); onOpenStorage(); }}
          />
        </div>
      </section>
    </details>
    {save.state === 'error' && save.error ? (
      <span className="sr-only" role="alert">{`${t('workspace.save.failed')}: ${save.error}`}</span>
    ) : null}
    </>
  );
}

function SyncNote({
  t,
  kind,
  status,
  saveError,
}: {
  t: Translate;
  kind: SyncKind;
  status: SpaceStatus | null;
  saveError: string | null;
}) {
  switch (kind) {
    case 'local-saved':
    case 'local-saving':
      return <p className="sync-status__note">{t('sync.note.local')}</p>;
    case 'local-error':
      return <p className="sync-status__note sync-status__note--problem" role="alert">{saveError}</p>;
    case 'offline':
      return <p className="sync-status__note">{t('sync.note.offline')}</p>;
    case 'needs-sign-in':
      return (
        <p className="sync-status__note sync-status__note--problem">
          {status?.kind === 'link-required' ? t('sync.note.linkRequired') : t('sync.note.needsSignIn')}
        </p>
      );
    case 'quota':
      return (
        <p className="sync-status__note sync-status__note--problem">
          {status?.kind === 'quota-exceeded' && status.scope === 'assets' ? t('sync.note.quotaAssets') : t('sync.note.quotaLog')}
        </p>
      );
    case 'error':
      return (
        <p className="sync-status__note sync-status__note--problem">
          {t('sync.note.error')}
          {status?.kind === 'error' && status.message && !needsSignIn(status) ? (
            <small>{t('sync.note.details', { message: status.message })}</small>
          ) : null}
        </p>
      );
    case 'synced':
    case 'syncing':
      return null;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled sync kind: ${String(exhaustive)}`);
    }
  }
}

function SyncAction({
  t,
  kind,
  canSignIn,
  quotaScope,
  onSyncNow,
  onSignIn,
  onOpenStorage,
}: {
  t: Translate;
  kind: SyncKind;
  canSignIn: boolean;
  quotaScope: 'log' | 'assets' | null;
  onSyncNow(): void;
  onSignIn(): void;
  onOpenStorage(): void;
}) {
  switch (kind) {
    case 'synced':
      return <button type="button" className="sync-status__primary" onClick={onSyncNow}><RefreshCw size={15} aria-hidden="true" />{t('space.account.syncNow')}</button>;
    case 'syncing':
      return <button type="button" className="sync-status__primary" disabled><RefreshCw size={15} aria-hidden="true" />{t('space.account.syncNow')}</button>;
    case 'offline':
    case 'error':
      return <button type="button" className="sync-status__primary" onClick={onSyncNow}><RefreshCw size={15} aria-hidden="true" />{t('sync.retry')}</button>;
    case 'needs-sign-in':
      return <button type="button" className="sync-status__primary" onClick={onSignIn}>{t('sync.signIn')}</button>;
    case 'quota':
      return (
        <button type="button" className="sync-status__primary" data-scope={quotaScope ?? undefined} onClick={onOpenStorage}>
          {t('sync.openStorage')}
        </button>
      );
    case 'local-saved':
    case 'local-saving':
      return canSignIn ? <button type="button" className="sync-status__primary" onClick={onSignIn}><Cloud size={15} aria-hidden="true" />{t('sync.signIn')}</button> : null;
    case 'local-error':
      return null;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled sync kind: ${String(exhaustive)}`);
    }
  }
}
