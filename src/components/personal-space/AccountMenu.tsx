/**
 * The account entry in the topbar: a small avatar button (the account's
 * picture when signed in, a neutral person icon otherwise) that opens the
 * shared app menu (`src/ui/AppMenuButton.tsx`). Signed out, the menu says what
 * an account adds and offers "Anmelden / Konto erstellen". Signed in, it is
 * only the account: who you are, a one-line sync status, the Konto page, the
 * app downloads that make sense and "Abmelden". Counts and devices live on the
 * Konto page; the sync status has its own icon (`SyncStatus.tsx`).
 *
 * Sign-in/out go through the existing `useOptionalAuth()` seam
 * (`src/auth/AuthContext.ts`) so this module never imports Clerk directly.
 */

import { Download, LogIn, LogOut, Smartphone, UserRound, UserRoundCog } from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatLocale } from '../../i18n/core';
import type { OptionalAuthValue } from '../../auth';
import type { SpaceStatus } from '../../personal-space';
import { presenceColorFor, safeAvatarUrl } from '../../collab/presence';
import { PresenceAvatar } from '../collab/presence/PresenceAvatars';
import { AppMenuButton, menuGroups } from '../../ui/AppMenuButton';
import type { ContextMenuEntry } from '../../ui/ContextMenu';
import { ANDROID_DOWNLOAD_PATH, DESKTOP_DOWNLOAD_PATH } from '../../platform/desktopDownload';
import { VIEWER_APP } from '../../platform/viewerApp';
import { syncSentence } from './SyncStatus';
import type { LocalSaveState } from './syncView';
import './account.css';

export type AccountMenuViewModel =
  | { signedIn: false; canSignIn: boolean }
  | {
    signedIn: true;
    name: string | null;
    email: string | null;
    imageUrl: string | null;
  };

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Pure: human-readable byte count. */
export function formatAssetSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${SIZE_UNITS[unitIndex]}`;
}

/** Pure: what the menu should render, given auth state. */
export function accountMenuViewModel(auth: OptionalAuthValue): AccountMenuViewModel {
  if (!auth.available || !auth.isSignedIn) {
    return { signedIn: false, canSignIn: auth.available };
  }
  return {
    signedIn: true,
    name: auth.user?.fullName?.trim() || null,
    email: auth.user?.primaryEmailAddress ?? null,
    imageUrl: safeAvatarUrl(auth.user?.imageUrl ?? undefined) ?? null,
  };
}

export type AppFlavour = 'web' | 'desktop' | 'android';

/** Which app this is, to offer only the downloads that make sense: never the app you are in. */
export function appFlavour(auth: OptionalAuthValue): AppFlavour {
  if (VIEWER_APP) return 'android';
  return auth.available && auth.desktop !== undefined ? 'desktop' : 'web';
}

/** Which downloads the menu offers: the desktop installer on the web, the Android app everywhere but in it. */
export function downloadsFor(flavour: AppFlavour): Array<'desktop' | 'android'> {
  return flavour === 'web' ? ['desktop', 'android'] : flavour === 'desktop' ? ['android'] : [];
}

/** A menu item cannot be a link, so the file is fetched through a throwaway anchor. */
function startDownload(href: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

export interface AccountMenuProps {
  auth: OptionalAuthValue;
  /** Opens the Konto page. */
  onOpenAccount(): void;
  /** Stops account-bound sync before the Clerk session ends. */
  onSignOut(): void;
  /** The one-line sync status; absent when the feature is off. */
  sync?: { save: LocalSaveState; status: SpaceStatus | null };
}

export default function AccountMenu({ auth, onOpenAccount, onSignOut, sync }: AccountMenuProps) {
  const { t, language } = useI18n();
  const model = accountMenuViewModel(auth);
  const displayName = model.signedIn ? model.name ?? model.email ?? t('account.dialog.title') : null;
  const avatarUser = model.signedIn
    ? {
      name: displayName ?? '?',
      color: presenceColorFor(auth.available && auth.user ? auth.user.id : 'account'),
      ...(model.imageUrl ? { imageUrl: model.imageUrl } : {}),
    }
    : null;
  const buttonLabel = model.signedIn
    ? t('account.button.signedIn', { name: displayName ?? '' })
    : t('account.button.signedOut');
  const flavour = appFlavour(auth);
  const isDesktopApp = auth.available && auth.desktop !== undefined;

  const downloads: ContextMenuEntry[] = downloadsFor(flavour).map((kind) => kind === 'desktop'
    ? {
      id: 'download-desktop',
      label: t('account.menu.downloadDesktop'),
      icon: <Download size={15} />,
      onSelect: () => startDownload(DESKTOP_DOWNLOAD_PATH),
    }
    : {
      id: 'download-android',
      label: t('account.menu.downloadAndroid'),
      icon: <Smartphone size={15} />,
      onSelect: () => startDownload(ANDROID_DOWNLOAD_PATH),
    });

  // Built when the menu opens, so "vor 5 Minuten" is current.
  const items = (): ContextMenuEntry[] => {
    const syncLine = sync ? syncSentence(t, sync.save, sync.status, Date.now(), formatLocale(language)) : null;
    if (!model.signedIn) {
      return menuGroups([
        [{
          kind: 'header',
          id: 'signed-out',
          content: (
            <div className="account-menu__signed-out">
              <strong>{t('space.account.signedOutNote')}</strong>
              <span>
                {model.canSignIn
                  ? t(isDesktopApp ? 'space.account.desktopBenefit' : 'space.account.signedOutBenefit')
                  : t('space.account.unavailable')}
              </span>
            </div>
          ),
        }],
        [model.canSignIn && {
          id: 'sign-in',
          label: t('space.account.signInOrUp'),
          icon: <LogIn size={15} />,
          onSelect: () => {
            if (auth.available) auth.openSignIn();
          },
        }],
        downloads,
      ], 'account-menu');
    }
    return menuGroups([
      [{
        kind: 'header',
        id: 'identity',
        content: (
          <div className="account-menu__identity">
            {avatarUser ? <PresenceAvatar user={avatarUser} size={40} /> : null}
            <span>
              <strong>{displayName}</strong>
              {model.email && model.email !== displayName ? <small>{model.email}</small> : null}
              {syncLine ? <small className="account-menu__sync" data-testid="account-sync-line">{syncLine}</small> : null}
            </span>
          </div>
        ),
      }],
      [{ id: 'manage', label: t('account.menu.manage'), icon: <UserRoundCog size={15} />, onSelect: onOpenAccount }],
      downloads,
      [{
        id: 'sign-out',
        label: t('space.account.signOut'),
        icon: <LogOut size={15} />,
        onSelect: () => {
          onSignOut();
          if (auth.available) void auth.signOut?.();
        },
      }],
    ], 'account-menu');
  };

  return (
    <AppMenuButton label={buttonLabel} title={buttonLabel} className="account-menu__button" items={items} align="end">
      {avatarUser ? (
        <PresenceAvatar user={avatarUser} size={28} />
      ) : (
        <span className="account-menu__anonymous" aria-hidden="true"><UserRound size={17} /></span>
      )}
    </AppMenuButton>
  );
}
