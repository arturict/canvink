/**
 * Turns the Worker's device rows into what the account page shows. The same
 * app can end up listed several times: before the Worker knew an installation
 * (`install_id`), every sign-in added a row, and a phone has no computer name,
 * so those rows differ in nothing but their id. Rows that say the same thing
 * are shown as one device and signed out together.
 */

import type { DesktopDevice } from './deviceApi';

export type DevicePlatform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'other';

const PLATFORMS: readonly DevicePlatform[] = ['windows', 'macos', 'linux', 'android', 'ios'];
/** The label an older Worker stored when the app sent no computer name. */
const GENERIC_LABELS = new Set(['canvink desktop', 'canvink']);
const LEGACY_LABEL = /^(.*?)\s*\((windows|macos|linux|android|ios)\)\s*$/i;

function platformOf(value: string | undefined): DevicePlatform | null {
  const lower = value?.toLowerCase();
  return PLATFORMS.find((platform) => platform === lower) ?? null;
}

export interface DeviceDescription {
  /** The computer's name, or null when there is none worth showing. */
  name: string | null;
  platform: DevicePlatform;
  appVersion: string | null;
}

export function describeDevice(device: Pick<DesktopDevice, 'label' | 'platform' | 'appVersion'>): DeviceDescription {
  let name = device.label.trim();
  let platform = platformOf(device.platform);
  const legacy = LEGACY_LABEL.exec(name);
  if (legacy) {
    name = (legacy[1] ?? '').trim();
    platform ??= platformOf(legacy[2]);
  }
  return {
    name: name && !GENERIC_LABELS.has(name.toLowerCase()) ? name : null,
    platform: platform ?? 'other',
    appVersion: device.appVersion ?? null,
  };
}

export interface DeviceEntry extends DeviceDescription {
  /** The row that was used last; its version and time stand for the group. */
  id: string;
  lastUsedAt: string;
  /** Every row behind this entry: signing the entry out revokes them all. */
  ids: string[];
}

/** One entry per name and platform, most recently used first. */
export function groupDevices(devices: readonly DesktopDevice[]): DeviceEntry[] {
  const groups = new Map<string, DeviceEntry>();
  for (const device of devices) {
    const description = describeDevice(device);
    const key = `${description.platform}|${(description.name ?? '').toLowerCase()}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...description, id: device.id, lastUsedAt: device.lastUsedAt, ids: [device.id] });
      continue;
    }
    existing.ids.push(device.id);
    if (Date.parse(device.lastUsedAt) > Date.parse(existing.lastUsedAt)) {
      existing.id = device.id;
      existing.lastUsedAt = device.lastUsedAt;
      existing.appVersion = description.appVersion ?? existing.appVersion;
    }
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
}

/** The platform of this browser, for the "Dieses Gerät" row. */
export function platformFromUserAgent(userAgent: string, maxTouchPoints = 0): DevicePlatform {
  const agent = userAgent.toLowerCase();
  if (agent.includes('android')) return 'android';
  if (agent.includes('iphone') || agent.includes('ipad') || (agent.includes('macintosh') && maxTouchPoints > 1)) return 'ios';
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('macintosh') || agent.includes('mac os')) return 'macos';
  if (agent.includes('linux') || agent.includes('cros')) return 'linux';
  return 'other';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "vor 2 Tagen", "gerade eben": how long ago, in the reader's language. */
export function relativeTime(iso: string, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (Number.isNaN(elapsed)) return '';
  if (elapsed < MINUTE) return format.format(0, 'second');
  if (elapsed < HOUR) return format.format(-Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return format.format(-Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 30 * DAY) return format.format(-Math.floor(elapsed / DAY), 'day');
  if (elapsed < 365 * DAY) return format.format(-Math.floor(elapsed / (30 * DAY)), 'month');
  return format.format(-Math.floor(elapsed / (365 * DAY)), 'year');
}
