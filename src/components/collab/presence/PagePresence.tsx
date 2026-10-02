import { createContext, useContext } from 'react';
import { distinctPeople, type PresencePeer } from '../../../collab/presence';
import { useI18n } from '../../../i18n';
import { PresenceAvatar } from './PresenceAvatars';

/** People per page id, for the page list. Empty outside shared notebooks. */
export const PagePresenceContext = createContext<ReadonlyMap<string, readonly PresencePeer[]>>(new Map());

/** Groups a room's peers by the page id they are on (`docIdToPageId` maps document ids). */
export function peersByPageId(
  peers: readonly PresencePeer[],
  docIdToPageId: (docId: string) => string | undefined,
): Map<string, PresencePeer[]> {
  const result = new Map<string, PresencePeer[]>();
  for (const peer of distinctPeople(peers)) {
    if (!peer.page || peer.away) continue;
    const pageId = docIdToPageId(peer.page);
    if (!pageId) continue;
    const list = result.get(pageId) ?? [];
    list.push(peer);
    result.set(pageId, list);
  }
  return result;
}

/** Small faces next to a page in the page list: who is on that page right now. */
export function PagePresenceDots({ pageId }: { pageId: string }) {
  const { t } = useI18n();
  const peers = useContext(PagePresenceContext).get(pageId);
  if (!peers || peers.length === 0) return null;
  const label = t('presence.page.here', { names: peers.map((peer) => peer.user.name).join(', ') });
  return (
    <span className="page-presence" role="img" aria-label={label} title={label}>
      {peers.slice(0, 3).map((peer, index) => (
        <PresenceAvatar key={peer.user.id} user={peer.user} size={16} className="page-presence__face" stackIndex={index} />
      ))}
      {peers.length > 3 ? <span className="page-presence__more">+{peers.length - 3}</span> : null}
    </span>
  );
}
