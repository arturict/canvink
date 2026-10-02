import { describe, expect, it } from 'vitest';
import { needsSignIn, syncView } from './syncView';
import type { SpaceStatus } from '../../personal-space';

const synced: SpaceStatus = { kind: 'synced', lastSyncedAt: '2026-10-01T10:00:00.000Z' };

describe('syncView: one answer to "is my work safe?"', () => {
  it('without an account it only reports the local save', () => {
    for (const status of [null, { kind: 'disabled' }, { kind: 'signed-out' }] as const) {
      expect(syncView('saved', status)).toMatchObject({ kind: 'local-saved', icon: 'hard-drive', tone: 'quiet', motion: 'none' });
      expect(syncView('saving', status)).toMatchObject({ kind: 'local-saving', motion: 'pulse' });
    }
  });

  it('a failed local save wins over every cloud state', () => {
    expect(syncView('error', synced)).toMatchObject({ kind: 'local-error', tone: 'problem' });
    expect(syncView('error', null)).toMatchObject({ kind: 'local-error' });
  });

  it('shows the four cloud states with distinct icons', () => {
    expect(syncView('saved', synced)).toMatchObject({ kind: 'synced', icon: 'cloud-check', tone: 'ok' });
    expect(syncView('saved', { kind: 'reconnecting' })).toMatchObject({ kind: 'syncing', icon: 'refresh', motion: 'spin' });
    expect(syncView('saved', { kind: 'bootstrapping', phase: 'pull' })).toMatchObject({ kind: 'syncing' });
    expect(syncView('saved', { kind: 'offline', pendingDocs: 2 })).toMatchObject({ kind: 'offline', icon: 'cloud-off' });
    expect(syncView('saved', { kind: 'error', message: 'boom' })).toMatchObject({ kind: 'error', icon: 'warning', tone: 'problem' });
  });

  it('a local write under way pulses the icon without hiding the cloud state', () => {
    expect(syncView('saving', synced)).toMatchObject({ kind: 'synced', motion: 'pulse' });
  });

  it('tells "sign in again" apart from a failure that a retry can fix', () => {
    const expired: SpaceStatus = { kind: 'error', message: 'Reauthentication required.' };
    expect(needsSignIn(expired)).toBe(true);
    expect(needsSignIn({ kind: 'error', message: 'socket closed' })).toBe(false);
    expect(needsSignIn(null)).toBe(false);
    expect(syncView('saved', expired).kind).toBe('needs-sign-in');
    expect(syncView('saved', { kind: 'link-required', localHasData: true, remoteDocCount: 3 }).kind).toBe('needs-sign-in');
  });

  it('a full quota is its own problem state', () => {
    expect(syncView('saved', { kind: 'quota-exceeded', scope: 'assets' })).toMatchObject({ kind: 'quota', tone: 'problem' });
  });
});
