import type { PresenceHub, PresencePeer } from '../../../collab/presence';
import type { CanvasPresencePort } from '../../../editor/presence/types';

/**
 * The canvas's view of a room's presence for one page: it reports local
 * activity to the hub and sees only the peers on the same page.
 */
export function createCanvasPresencePort(hub: PresenceHub, pageDocId: string): CanvasPresencePort {
  let source: readonly PresencePeer[] | null = null;
  let filtered: readonly PresencePeer[] = [];
  const getPeers = (): readonly PresencePeer[] => {
    const peers = hub.getPeers();
    if (peers !== source) {
      source = peers;
      filtered = peers.filter((peer) => peer.page === pageDocId && !peer.away);
    }
    return filtered;
  };
  return {
    pointer: (point) => hub.setCursor(point),
    inkProgress: (style, points) => hub.inkProgress(style, points),
    inkEnd: () => hub.inkEnd(),
    selection: (bounds) => hub.setSelection(bounds),
    viewport: (view) => hub.setView(view),
    subscribeReveal: (listener) => hub.subscribeReveal(pageDocId, listener),
    interacted: () => hub.follow(null),
    subscribe: (listener) => hub.subscribe(listener),
    getPeers,
  };
}
