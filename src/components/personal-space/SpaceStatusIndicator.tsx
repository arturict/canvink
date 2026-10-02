/**
 * Pure mappings from `SpaceStatus` to labels, icons and numbers, kept outside
 * the component (`SyncStatus.tsx`) per this repo's test convention
 * (`environment: 'node'` Vitest; component tests exercise pure presenters,
 * not rendering). The topbar indicator itself is `SyncStatus`.
 */

import type { TranslationKey } from '../../i18n';
import type { SpaceStatus } from '../../personal-space';

export type SpaceStatusIconName = 'cloud' | 'cloud-off' | 'refresh' | 'warning';

/** Exhaustive over every `SpaceStatus` variant (§5.2); a new variant is a compile error here. */
export function statusLabelKey(status: SpaceStatus): TranslationKey {
  switch (status.kind) {
    case 'disabled':
      return 'space.status.disabled';
    case 'signed-out':
      return 'space.status.signedOut';
    case 'link-required':
      return 'space.status.linkRequired';
    case 'bootstrapping':
      return 'space.status.bootstrapping';
    case 'synced':
      return 'space.status.synced';
    case 'offline':
      return 'space.status.offline';
    case 'reconnecting':
      return 'space.status.reconnecting';
    case 'quota-exceeded':
      return 'space.status.quotaExceeded';
    case 'error':
      return 'space.status.error';
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled SpaceStatus: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Icon family per §5.9 (`Cloud`, `CloudOff`, `RefreshCw`, `TriangleAlert`). */
export function statusIconName(status: SpaceStatus): SpaceStatusIconName {
  switch (status.kind) {
    case 'disabled':
    case 'signed-out':
    case 'link-required':
    case 'offline':
      return 'cloud-off';
    case 'bootstrapping':
    case 'reconnecting':
      return 'refresh';
    case 'synced':
      return 'cloud';
    case 'quota-exceeded':
    case 'error':
      return 'warning';
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled SpaceStatus: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** How far the background download of the account's pages is, 0 to 100. */
export function downloadPercent(progress: { remaining: number; total: number }): number {
  if (progress.total <= 0) return 0;
  const done = Math.min(progress.total, Math.max(0, progress.total - progress.remaining));
  return Math.round((done / progress.total) * 100);
}

/** Pending-changes count shown alongside the label; only `offline` carries one. */
export function statusPendingCount(status: SpaceStatus): number | null {
  return status.kind === 'offline' ? status.pendingDocs : null;
}
