/**
 * One answer to "is my work safe?", from the two things the app knows: the
 * local save (every keystroke is written to this device) and, with an
 * account, the sync with the cloud. Pure so the mapping is exhaustively
 * tested; `SyncStatus.tsx` only renders it.
 */

import type { SpaceStatus } from '../../personal-space';

export type LocalSaveState = 'saving' | 'saved' | 'error';

export type SyncKind =
  | 'local-saved' // no account: written to this device
  | 'local-saving'
  | 'local-error'
  | 'synced'
  | 'syncing'
  | 'offline'
  | 'needs-sign-in'
  | 'quota'
  | 'error';

export type SyncIcon = 'hard-drive' | 'cloud-check' | 'refresh' | 'cloud-off' | 'warning';

export interface SyncView {
  kind: SyncKind;
  icon: SyncIcon;
  /** `problem` is the only tone that asks for attention. */
  tone: 'ok' | 'busy' | 'quiet' | 'problem';
  /** Turning means the cloud sync is working; a soft pulse means a local write is under way. */
  motion: 'none' | 'spin' | 'pulse';
}

/** The Worker refused the credential: the person has to sign in again, retrying will not help. */
export function needsSignIn(status: SpaceStatus | null): boolean {
  return status?.kind === 'error' && /reauth|unauthori[sz]ed|signed out/i.test(status.message);
}

/**
 * Which state wins: a failed local save is the most serious (the work is not
 * on this device), then a cloud problem, then work in progress, then rest.
 * `status` is null without an account.
 */
export function syncView(save: LocalSaveState, status: SpaceStatus | null): SyncView {
  if (save === 'error') return { kind: 'local-error', icon: 'warning', tone: 'problem', motion: 'none' };
  const cloud = status && status.kind !== 'disabled' && status.kind !== 'signed-out' ? status : null;
  if (!cloud) {
    return save === 'saving'
      ? { kind: 'local-saving', icon: 'hard-drive', tone: 'busy', motion: 'pulse' }
      : { kind: 'local-saved', icon: 'hard-drive', tone: 'quiet', motion: 'none' };
  }
  switch (cloud.kind) {
    case 'quota-exceeded':
      return { kind: 'quota', icon: 'warning', tone: 'problem', motion: 'none' };
    case 'error':
      return needsSignIn(cloud)
        ? { kind: 'needs-sign-in', icon: 'warning', tone: 'problem', motion: 'none' }
        : { kind: 'error', icon: 'warning', tone: 'problem', motion: 'none' };
    case 'link-required':
      return { kind: 'needs-sign-in', icon: 'warning', tone: 'problem', motion: 'none' };
    case 'offline':
      return { kind: 'offline', icon: 'cloud-off', tone: 'quiet', motion: 'none' };
    case 'bootstrapping':
    case 'reconnecting':
      return { kind: 'syncing', icon: 'refresh', tone: 'busy', motion: 'spin' };
    case 'synced':
      return save === 'saving'
        ? { kind: 'synced', icon: 'cloud-check', tone: 'busy', motion: 'pulse' }
        : { kind: 'synced', icon: 'cloud-check', tone: 'ok', motion: 'none' };
    default: {
      const exhaustive: never = cloud;
      throw new Error(`Unhandled SpaceStatus: ${JSON.stringify(exhaustive)}`);
    }
  }
}
