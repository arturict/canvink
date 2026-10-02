/**
 * Geräte: the Canvink apps signed in to this account (PERSONAL-SYNC.md §3.7),
 * with a friendly name, platform and version, when each was last active, a
 * rename and a sign-out through the app's own confirmation. Several rows that
 * say the same thing (older sign-ins of one app) are shown as one device and
 * signed out together. The list needs the web sign-in; the desktop and Android
 * apps show only their own row and point to the web app.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Globe, LogOut, Monitor, Pencil, Smartphone, X } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import { formatLocale } from '../../i18n/core';
import {
  groupDevices,
  listDesktopDevices,
  platformFromUserAgent,
  relativeTime,
  renameDesktopDevice,
  revokeDesktopDevice,
  type DesktopDevice,
  type DeviceEntry,
  type DevicePlatform,
} from '../../personal-space';
import { appFlavour } from './AccountMenu';
import { AccountWebLink } from './accountWebLink';
import type { Confirm, SignedInAuth } from './accountShared';

const KIND_KEYS: Record<DevicePlatform, TranslationKey> = {
  windows: 'account.device.kind.windows',
  macos: 'account.device.kind.macos',
  linux: 'account.device.kind.linux',
  android: 'account.device.kind.android',
  ios: 'account.device.kind.ios',
  other: 'account.device.kind.other',
};

type Translate = ReturnType<typeof useI18n>['t'];

function appLabel(t: Translate, platform: DevicePlatform, version: string | null): string {
  const app = t(platform === 'android' || platform === 'ios' ? 'account.device.app.mobile' : 'account.device.app.desktop');
  return version ? `${app} ${version}` : app;
}

/** The name to show: the computer's own, else its kind ("Windows-PC", "Android"). */
function entryTitle(t: Translate, entry: Pick<DeviceEntry, 'name' | 'platform'>): string {
  return entry.name ?? t(KIND_KEYS[entry.platform]);
}

function PlatformIcon({ platform }: { platform: DevicePlatform }) {
  return platform === 'android' || platform === 'ios' ? <Smartphone size={20} aria-hidden="true" /> : <Monitor size={20} aria-hidden="true" />;
}

export default function AccountDevicesTab({
  auth,
  syncUrl,
  confirm,
}: {
  auth: SignedInAuth;
  syncUrl: string | undefined;
  confirm: Confirm;
}) {
  const { t, language } = useI18n();
  const locale = formatLocale(language);
  const flavour = appFlavour(auth);
  const [devices, setDevices] = useState<DesktopDevice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const webList = flavour === 'web' && Boolean(syncUrl);

  useEffect(() => {
    if (!webList || !syncUrl) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const jwt = await auth.getToken();
        if (!jwt) throw new Error('no-token');
        const list = await listDesktopDevices({ syncUrl }, jwt);
        if (cancelled) return;
        setDevices(list);
        setNow(Date.now());
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, syncUrl, webList]);

  const entries = useMemo(() => groupDevices(devices ?? []), [devices]);

  const withToken = async (work: (jwt: string, config: { syncUrl: string }) => Promise<void>) => {
    if (!syncUrl) return;
    setActionFailed(false);
    try {
      const jwt = await auth.getToken();
      if (!jwt) throw new Error('no-token');
      await work(jwt, { syncUrl });
    } catch {
      setActionFailed(true);
    }
  };

  const signOut = async (entry: DeviceEntry) => {
    const name = entryTitle(t, entry);
    const ok = await confirm({
      title: t('account.devices.signOutTitle', { name }),
      message: t('account.devices.signOutMessage'),
      confirmLabel: t('account.devices.signOut'),
      danger: true,
    });
    if (!ok) return;
    setBusy(entry.id);
    await withToken(async (jwt, config) => {
      await Promise.all(entry.ids.map((id) => revokeDesktopDevice(config, jwt, id)));
      setDevices((current) => current?.filter((device) => !entry.ids.includes(device.id)) ?? null);
    });
    setBusy(null);
  };

  const rename = async (event: FormEvent, entry: DeviceEntry) => {
    event.preventDefault();
    const label = draft.trim();
    if (!label) return;
    setBusy(entry.id);
    await withToken(async (jwt, config) => {
      const kept = await Promise.all(entry.ids.map((id) => renameDesktopDevice(config, jwt, id, label)));
      // The Worker keeps an older entry's platform when the new name no longer spells it out.
      const platform = entry.platform === 'other' ? {} : { platform: entry.platform };
      setDevices((current) => current?.map((device) => (entry.ids.includes(device.id) ? { ...platform, ...device, label: kept[0] ?? label } : device)) ?? null);
      setRenaming(null);
    });
    setBusy(null);
  };

  const version = typeof __CANVINK_VERSION__ === 'string' ? __CANVINK_VERSION__ : null;
  const thisPlatform = platformFromUserAgent(navigator.userAgent, navigator.maxTouchPoints);
  const thisTitle = flavour === 'web' ? t('account.devices.thisBrowser') : t(KIND_KEYS[thisPlatform]);
  const thisSubtitle = flavour === 'web' ? t(KIND_KEYS[thisPlatform]) : appLabel(t, thisPlatform, version);

  return (
    <section className="account-dialog__section" aria-labelledby="account-devices-title">
      <h3 id="account-devices-title">{t('account.tab.devices')}</h3>
      <p className="account-dialog__hint">{t('account.devices.intro')}</p>
      <ul className="account-dialog__devices" data-testid="account-devices">
        <li className="account-dialog__device account-dialog__device--current">
          {flavour === 'web' ? <Globe size={20} aria-hidden="true" /> : <PlatformIcon platform={thisPlatform} />}
          <span className="account-dialog__list-main">
            <strong>{thisTitle}</strong>
            <small>{thisSubtitle} · {t('account.devices.activeNow')}</small>
          </span>
          <span className="account-dialog__badge">{t('account.devices.thisDevice')}</span>
        </li>
        {entries.map((entry) => {
          const title = entryTitle(t, entry);
          const subtitle = [entry.name ? t(KIND_KEYS[entry.platform]) : null, appLabel(t, entry.platform, entry.appVersion)]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={entry.id} className="account-dialog__device">
              <PlatformIcon platform={entry.platform} />
              {renaming === entry.id ? (
                <form className="account-dialog__rename" onSubmit={(event) => void rename(event, entry)}>
                  <label>
                    <span className="sr-only">{t('account.devices.nameLabel')}</span>
                    <input
                      autoFocus
                      maxLength={60}
                      value={draft}
                      aria-label={t('account.devices.nameLabel')}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                    />
                  </label>
                  <button type="submit" className="account-dialog__primary" disabled={busy === entry.id || !draft.trim()}>
                    <Check size={14} aria-hidden="true" />
                    {t('account.devices.save')}
                  </button>
                  <button type="button" onClick={() => setRenaming(null)} aria-label={t('common.cancel')}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </form>
              ) : (
                <>
                  <span className="account-dialog__list-main">
                    <strong>{title}</strong>
                    <small>{subtitle}</small>
                    <small>
                      {now - Date.parse(entry.lastUsedAt) < 60_000
                        ? t('account.devices.activeNow')
                        : t('account.devices.lastActive', { time: relativeTime(entry.lastUsedAt, now, locale) })}
                      {entry.ids.length > 1 ? ` · ${t('account.devices.merged', { count: entry.ids.length })}` : ''}
                    </small>
                  </span>
                  <span className="account-dialog__device-actions">
                    <button
                      type="button"
                      disabled={busy === entry.id}
                      aria-label={t('account.devices.renameLabel', { name: title })}
                      onClick={() => { setRenaming(entry.id); setDraft(entry.name ?? ''); }}
                    >
                      <Pencil size={14} aria-hidden="true" />
                      {t('account.devices.rename')}
                    </button>
                    <button
                      type="button"
                      disabled={busy === entry.id}
                      aria-label={t('account.devices.signOutLabel', { name: title })}
                      onClick={() => void signOut(entry)}
                    >
                      <LogOut size={14} aria-hidden="true" />
                      {t('account.devices.signOut')}
                    </button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {webList && devices && entries.length === 0 ? <p className="account-dialog__hint">{t('account.devices.empty')}</p> : null}
      {failed ? <p className="account-dialog__error" role="alert">{t('account.devices.failed')}</p> : null}
      {actionFailed ? <p className="account-dialog__error" role="alert">{t('account.devices.actionFailed')}</p> : null}
      {flavour === 'web' ? null : (
        <>
          <p className="account-dialog__hint">{t('account.devices.appOnly')}</p>
          <AccountWebLink />
        </>
      )}
    </section>
  );
}
