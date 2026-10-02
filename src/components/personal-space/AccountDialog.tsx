/**
 * The Konto page: profile, sign-in, devices and storage in Canvink's own
 * design, opened from the avatar menu. A dialog on a computer, full screen on
 * a phone. Profile and sign-in talk to the sign-in provider through the
 * Clerk-agnostic `AccountApi` (`src/auth/accountApi.ts`); password and
 * two-step flows are Clerk's own components, styled like the app. The page is
 * loaded on demand, so it costs nothing until someone opens it.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { HardDrive, UserRound, Monitor, X, KeyRound } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import type { OptionalAuthValue } from '../../auth';
import type { SpaceDescriptor } from '../../personal-space';
import { presenceColorFor, safeAvatarUrl } from '../../collab/presence';
import { useBackClosesLayer } from '../../platform/backClosesLayer';
import { useConfirm } from '../../ui/ConfirmDialog';
import { PresenceAvatar } from '../collab/presence/PresenceAvatars';
import AccountProfileTab from './AccountProfileTab';
import AccountSignInTab from './AccountSignInTab';
import AccountDevicesTab from './AccountDevicesTab';
import AccountStorageTab from './AccountStorageTab';
import './account.css';

export type AccountTab = 'profile' | 'signIn' | 'devices' | 'storage';

type SignedInAuth = Extract<OptionalAuthValue, { available: true }>;

export interface AccountDialogProps {
  auth: SignedInAuth;
  descriptor: SpaceDescriptor | null;
  /** The personal space is on: devices and storage have something to show. */
  personalSpace: boolean;
  syncUrl?: string;
  initialTab?: AccountTab;
  onClose(): void;
}

const TAB_LABELS: Record<AccountTab, TranslationKey> = {
  profile: 'account.tab.profile',
  signIn: 'account.tab.signIn',
  devices: 'account.tab.devices',
  storage: 'account.tab.storage',
};

const TAB_ICONS = { profile: UserRound, signIn: KeyRound, devices: Monitor, storage: HardDrive } as const;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export default function AccountDialog({ auth, descriptor, personalSpace, syncUrl, initialTab, onClose }: AccountDialogProps) {
  const { t } = useI18n();
  const id = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const { confirm, element: confirmElement } = useConfirm();
  const tabs: AccountTab[] = ['profile'];
  if (auth.account) tabs.push('signIn');
  if (personalSpace && syncUrl) tabs.push('devices');
  if (personalSpace) tabs.push('storage');
  const [tab, setTab] = useState<AccountTab>(initialTab && tabs.includes(initialTab) ? initialTab : 'profile');
  useBackClosesLayer(true, onClose);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const name = auth.user?.fullName?.trim() || auth.user?.primaryEmailAddress || t('account.dialog.title');
  const avatar = {
    name,
    color: presenceColorFor(auth.user?.id ?? 'account'),
    ...(safeAvatarUrl(auth.user?.imageUrl ?? undefined) ? { imageUrl: safeAvatarUrl(auth.user?.imageUrl ?? undefined) } : {}),
  };

  // On the document, not the dialog: after a confirmation the focused button
  // may be gone (a removed address), and Escape must still close the page.
  // A confirmation on top takes its own Escape first.
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('.confirm-overlay')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((item) => item.offsetParent !== null);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    if (!next) return;
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };

  // In the body, like the confirmation dialog: the ribbon and the topbar form
  // stacking contexts of their own that would otherwise draw over this page.
  return createPortal(
    <div
      className="account-dialog-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={onKeyDown}
      >
        <header className="account-dialog__header">
          <h2 id={`${id}-title`}>{t('account.dialog.title')}</h2>
          <button type="button" className="account-dialog__close" aria-label={t('space.account.close')} onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="account-dialog__body">
          <nav className="account-dialog__nav" aria-label={t('account.dialog.tabs')}>
            <div className="account-dialog__who">
              <PresenceAvatar user={avatar} size={44} />
              <span>
                <strong>{name}</strong>
                {auth.user?.primaryEmailAddress && auth.user.primaryEmailAddress !== name ? (
                  <small>{auth.user.primaryEmailAddress}</small>
                ) : null}
              </span>
            </div>
            <div role="tablist" aria-orientation="vertical" className="account-dialog__tabs">
              {tabs.map((entry) => {
                const Icon = TAB_ICONS[entry];
                return (
                  <button
                    key={entry}
                    id={`${id}-tab-${entry}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === entry}
                    aria-controls={`${id}-panel`}
                    tabIndex={tab === entry ? 0 : -1}
                    onClick={() => setTab(entry)}
                    onKeyDown={onTabKeyDown}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {t(TAB_LABELS[entry])}
                  </button>
                );
              })}
            </div>
          </nav>
          <div id={`${id}-panel`} className="account-dialog__panel" role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
            {tab === 'profile' ? <AccountProfileTab auth={auth} confirm={confirm} /> : null}
            {tab === 'signIn' ? <AccountSignInTab auth={auth} confirm={confirm} /> : null}
            {tab === 'devices' ? <AccountDevicesTab auth={auth} syncUrl={syncUrl} confirm={confirm} /> : null}
            {tab === 'storage' ? <AccountStorageTab descriptor={descriptor} /> : null}
          </div>
        </div>
      </section>
      {confirmElement}
    </div>,
    document.body,
  );
}
