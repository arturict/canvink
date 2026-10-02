import { describe, expect, it } from 'vitest';
import { describeDevice, groupDevices, platformFromUserAgent, relativeTime } from './deviceDisplay';
import type { DesktopDevice } from './deviceApi';

function device(id: string, label: string, lastUsedAt: string, extra: Partial<DesktopDevice> = {}): DesktopDevice {
  return { id, label, createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt, ...extra };
}

describe('describeDevice', () => {
  it('reads the platform and name out of an older "HOST (Windows)" label', () => {
    expect(describeDevice({ label: 'DESKTOP-0OCI3UR (Windows)' })).toEqual({
      name: 'DESKTOP-0OCI3UR',
      platform: 'windows',
      appVersion: null,
    });
  });

  it('shows no name for the generic label of a phone', () => {
    expect(describeDevice({ label: 'Canvink Desktop (android)' })).toEqual({ name: null, platform: 'android', appVersion: null });
    expect(describeDevice({ label: '', platform: 'android', appVersion: '0.3.2' })).toEqual({
      name: null,
      platform: 'android',
      appVersion: '0.3.2',
    });
  });

  it('prefers what the app sent over what the label says', () => {
    expect(describeDevice({ label: 'Schul-Laptop', platform: 'linux', appVersion: '0.3.1' })).toEqual({
      name: 'Schul-Laptop',
      platform: 'linux',
      appVersion: '0.3.1',
    });
  });
});

describe('groupDevices', () => {
  it('folds the repeated sign-ins of one app into one entry and keeps every id', () => {
    const entries = groupDevices([
      device('a', 'Canvink Desktop (android)', '2026-09-28T10:00:00.000Z'),
      device('b', 'DESKTOP-0OCI3UR (Windows)', '2026-10-01T08:00:00.000Z'),
      device('c', 'Canvink Desktop (android)', '2026-10-01T09:00:00.000Z'),
      device('d', 'Canvink Desktop (android)', '2026-09-30T09:00:00.000Z'),
    ]);
    expect(entries.map((entry) => [entry.platform, entry.name, entry.ids.sort()])).toEqual([
      ['android', null, ['a', 'c', 'd']],
      ['windows', 'DESKTOP-0OCI3UR', ['b']],
    ]);
    expect(entries[0]?.id).toBe('c');
    expect(entries[0]?.lastUsedAt).toBe('2026-10-01T09:00:00.000Z');
  });

  it('keeps differently named computers apart and takes the newest version', () => {
    const entries = groupDevices([
      device('a', 'PC-A', '2026-10-01T09:00:00.000Z', { platform: 'windows', appVersion: '0.3.1' }),
      device('b', 'PC-B', '2026-10-01T08:00:00.000Z', { platform: 'windows' }),
      device('c', 'PC-A', '2026-10-01T10:00:00.000Z', { platform: 'windows', appVersion: '0.3.2' }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: 'PC-A', appVersion: '0.3.2', ids: ['a', 'c'] });
  });
});

describe('platformFromUserAgent', () => {
  it('names the platform of this browser', () => {
    expect(platformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(platformFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
    expect(platformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5)).toBe('ios');
    expect(platformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 0)).toBe('macos');
    expect(platformFromUserAgent('curl/8')).toBe('other');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  it('speaks in the reader\'s language', () => {
    expect(relativeTime('2026-10-01T11:59:50.000Z', now, 'en-US')).toBe('now');
    expect(relativeTime('2026-10-01T09:00:00.000Z', now, 'en-US')).toBe('3 hours ago');
    expect(relativeTime('2026-09-29T12:00:00.000Z', now, 'en-US')).toBe('2 days ago');
    expect(relativeTime('2026-09-30T12:00:00.000Z', now, 'de-CH')).toBe('gestern');
    expect(relativeTime('2026-09-29T12:00:00.000Z', now, 'de-CH')).toBe('vorgestern');
  });
});
