import type { OptionalAuthValue } from '../../../auth';
import { hashString, presenceColorFor, safeAvatarUrl, type PresenceUser } from '../../../collab/presence';
import type { TranslationKey } from '../../../i18n';

export type DeviceNameKey = Extract<TranslationKey, `presence.device.${string}`>;

/**
 * A readable device name for people who are not signed in. Derived from the
 * user agent only; nothing identifying beyond the device family is sent.
 */
export function deviceNameKey(userAgent: string, maxTouchPoints = 0): DeviceNameKey {
  const agent = userAgent.toLowerCase();
  if (agent.includes('ipad') || (agent.includes('macintosh') && maxTouchPoints > 1)) return 'presence.device.ipad';
  if (agent.includes('iphone')) return 'presence.device.iphone';
  if (agent.includes('android')) return 'presence.device.android';
  if (agent.includes('cros')) return 'presence.device.chromebook';
  if (agent.includes('windows')) return 'presence.device.windows';
  if (agent.includes('macintosh') || agent.includes('mac os')) return 'presence.device.mac';
  if (agent.includes('linux')) return 'presence.device.linux';
  return 'presence.device.other';
}

/**
 * The identity others see. Signed in: the Clerk name and profile picture.
 * Otherwise the device name. The id is a hash, so neither the Clerk user id
 * nor the local device id leaves the device.
 */
export function presenceUserFor(auth: OptionalAuthValue, deviceId: string, deviceName: string): PresenceUser {
  const user = auth.available && auth.isSignedIn ? auth.user : null;
  if (user) {
    const id = `u${hashString(`clerk:${user.id}`).toString(36)}`;
    const emailName = user.primaryEmailAddress?.split('@')[0] ?? null;
    const imageUrl = safeAvatarUrl(user.imageUrl ?? undefined);
    return {
      id,
      name: user.fullName?.trim() || emailName || deviceName,
      color: presenceColorFor(id),
      ...(imageUrl ? { imageUrl } : {}),
    };
  }
  const id = `d${hashString(`device:${deviceId}`).toString(36)}`;
  return { id, name: deviceName, color: presenceColorFor(id) };
}
