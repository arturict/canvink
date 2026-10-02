import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { OptionalAuthValue } from '../../../auth';
import type { PresenceHub, PresencePeer, PresenceUser } from '../../../collab/presence';
import { useI18n } from '../../../i18n';
import { createCanvasPresencePort } from './canvasPort';
import { deviceNameKey, presenceUserFor } from './presenceUser';

const NO_PEERS: readonly PresencePeer[] = [];
const noopSubscribe = () => () => undefined;
const noPeers = () => NO_PEERS;

export function useLocalPresenceUser(auth: OptionalAuthValue, deviceId: string): PresenceUser {
  const { t } = useI18n();
  const deviceName = t(deviceNameKey(
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
    typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
  ));
  const user = auth.available && auth.isSignedIn ? auth.user : null;
  return useMemo(
    () => presenceUserFor(auth, deviceId, deviceName),
    // `auth` is a new object on every Clerk render; only these fields matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceId, deviceName, user?.id, user?.fullName, user?.primaryEmailAddress, user?.imageUrl],
  );
}

/**
 * Keeps a hub's local state in step with the UI: the page shown here and
 * whether this tab is visible. A hidden tab counts as away, so its pointer
 * disappears for the others.
 */
export function usePresenceLifecycle(hub: PresenceHub | null, pageDocId: string | null, user: PresenceUser): void {
  useEffect(() => {
    hub?.setUser(user);
  }, [hub, user]);
  useEffect(() => {
    hub?.setPage(pageDocId);
  }, [hub, pageDocId]);
  useEffect(() => {
    if (!hub || typeof document === 'undefined') return;
    const update = () => hub.setAway(document.visibilityState === 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [hub]);
}

/** Everyone in the room; changes only on join, leave, page switch or away. */
export function usePresenceRoster(hub: PresenceHub | null): readonly PresencePeer[] {
  return useSyncExternalStore(
    hub ? hub.subscribeRoster : noopSubscribe,
    hub ? hub.getRoster : noPeers,
    noPeers,
  );
}

export function useCanvasPresencePort(hub: PresenceHub | null, pageDocId: string | null) {
  return useMemo(
    () => (hub && pageDocId ? createCanvasPresencePort(hub, pageDocId) : undefined),
    [hub, pageDocId],
  );
}
