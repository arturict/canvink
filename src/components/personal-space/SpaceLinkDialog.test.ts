import { describe, expect, it } from 'vitest';
import { linkDialogOptions } from './SpaceLinkDialog';
import type { SpaceStatus } from '../../personal-space';

describe('linkDialogOptions', () => {
  it('is hidden for every non-link-required status', () => {
    const statuses: SpaceStatus[] = [
      { kind: 'disabled' },
      { kind: 'signed-out' },
      { kind: 'bootstrapping', phase: 'pull' },
      { kind: 'synced', lastSyncedAt: 'now' },
      { kind: 'offline', pendingDocs: 0 },
      { kind: 'reconnecting' },
      { kind: 'quota-exceeded', scope: 'log' },
      { kind: 'error', message: 'x' },
    ];
    for (const status of statuses) {
      expect(linkDialogOptions(status)).toEqual({ visible: false, remoteDocCount: 0 });
    }
  });

  it('is visible only when both the local device and the account hold data (P8)', () => {
    expect(linkDialogOptions({ kind: 'link-required', localHasData: true, remoteDocCount: 5 }))
      .toEqual({ visible: true, remoteDocCount: 5 });
  });

  it('stays hidden when there is no local data, even if the account has documents', () => {
    expect(linkDialogOptions({ kind: 'link-required', localHasData: false, remoteDocCount: 5 }).visible).toBe(false);
  });

  it('stays hidden when the account is empty, even with local data', () => {
    expect(linkDialogOptions({ kind: 'link-required', localHasData: true, remoteDocCount: 0 }).visible).toBe(false);
  });
});
