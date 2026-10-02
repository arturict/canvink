import { describe, expect, it } from 'vitest';
import { downloadPercent, statusIconName, statusLabelKey, statusPendingCount } from './SpaceStatusIndicator';
import { de, en } from '../../i18n/catalog';
import type { SpaceStatus } from '../../personal-space';

const EVERY_STATUS: SpaceStatus[] = [
  { kind: 'disabled' },
  { kind: 'signed-out' },
  { kind: 'link-required', localHasData: true, remoteDocCount: 3 },
  { kind: 'bootstrapping', phase: 'push' },
  { kind: 'bootstrapping', phase: 'pull' },
  { kind: 'bootstrapping', phase: 'adopt' },
  { kind: 'synced', lastSyncedAt: '2026-09-02T00:00:00.000Z' },
  { kind: 'offline', pendingDocs: 4 },
  { kind: 'reconnecting' },
  { kind: 'quota-exceeded', scope: 'log' },
  { kind: 'quota-exceeded', scope: 'assets' },
  { kind: 'error', message: 'boom' },
];

describe('statusLabelKey (exhaustiveness over every SpaceStatus variant)', () => {
  it('returns a translation key that exists in both catalogs, for every status', () => {
    for (const status of EVERY_STATUS) {
      const key = statusLabelKey(status);
      expect(de).toHaveProperty(key);
      expect(en).toHaveProperty(key);
    }
  });

  it('maps each kind to its dedicated space.status.* key', () => {
    expect(statusLabelKey({ kind: 'disabled' })).toBe('space.status.disabled');
    expect(statusLabelKey({ kind: 'signed-out' })).toBe('space.status.signedOut');
    expect(statusLabelKey({ kind: 'link-required', localHasData: false, remoteDocCount: 0 }))
      .toBe('space.status.linkRequired');
    expect(statusLabelKey({ kind: 'bootstrapping', phase: 'adopt' })).toBe('space.status.bootstrapping');
    expect(statusLabelKey({ kind: 'synced', lastSyncedAt: 'now' })).toBe('space.status.synced');
    expect(statusLabelKey({ kind: 'offline', pendingDocs: 0 })).toBe('space.status.offline');
    expect(statusLabelKey({ kind: 'reconnecting' })).toBe('space.status.reconnecting');
    expect(statusLabelKey({ kind: 'quota-exceeded', scope: 'assets' })).toBe('space.status.quotaExceeded');
    expect(statusLabelKey({ kind: 'error', message: 'x' })).toBe('space.status.error');
  });
});

describe('statusIconName', () => {
  it('covers every status kind without throwing', () => {
    for (const status of EVERY_STATUS) {
      expect(() => statusIconName(status)).not.toThrow();
    }
  });

  it('picks a warning icon for quota-exceeded and error', () => {
    expect(statusIconName({ kind: 'quota-exceeded', scope: 'log' })).toBe('warning');
    expect(statusIconName({ kind: 'error', message: 'x' })).toBe('warning');
  });

  it('picks the synced cloud icon only for synced', () => {
    expect(statusIconName({ kind: 'synced', lastSyncedAt: 'now' })).toBe('cloud');
    expect(statusIconName({ kind: 'offline', pendingDocs: 1 })).toBe('cloud-off');
  });

  it('picks a refresh icon for the in-progress states', () => {
    expect(statusIconName({ kind: 'bootstrapping', phase: 'pull' })).toBe('refresh');
    expect(statusIconName({ kind: 'reconnecting' })).toBe('refresh');
  });
});

describe('statusPendingCount', () => {
  it('is only non-null for offline', () => {
    expect(statusPendingCount({ kind: 'offline', pendingDocs: 7 })).toBe(7);
    expect(statusPendingCount({ kind: 'synced', lastSyncedAt: 'now' })).toBeNull();
    expect(statusPendingCount({ kind: 'disabled' })).toBeNull();
  });
});

describe('downloadPercent', () => {
  it('follows the pages still to download and stays within 0 to 100', () => {
    expect(downloadPercent({ remaining: 400, total: 400 })).toBe(0);
    expect(downloadPercent({ remaining: 100, total: 400 })).toBe(75);
    expect(downloadPercent({ remaining: 0, total: 400 })).toBe(100);
    expect(downloadPercent({ remaining: 5, total: 0 })).toBe(0);
    // The total can lag behind while pages are listed; a remainder above it never gives a negative bar.
    expect(downloadPercent({ remaining: 12, total: 10 })).toBe(0);
  });
});
