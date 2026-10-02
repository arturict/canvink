import { useEffect, useRef } from 'react';
import { jumpTarget, type PresenceHub } from '../../../collab/presence';

/**
 * Takes this device to where a person is: opens their page, then shows the
 * part of it their window shows. Returns false when they are not on a page
 * (in the page list) or no longer in the room.
 */
export function jumpToPerson(
  hub: PresenceHub,
  userId: string,
  currentDocId: string | null,
  openPage: (docId: string) => void,
): boolean {
  const peer = hub.getPerson(userId);
  if (!peer?.page) return false;
  if (peer.page !== currentDocId) openPage(peer.page);
  const target = jumpTarget(peer);
  if (target) hub.requestReveal(peer.page, target);
  return true;
}

/**
 * "Folgen": while `hub` has a followed person, every change of their page or
 * window is mirrored here until the person stops following (pointer or wheel
 * on the canvas, the chip's button) or leaves.
 */
export function useFollowDriver(
  hub: PresenceHub | null,
  following: string | null,
  currentDocId: string | null,
  openPage: (docId: string) => void,
): void {
  const currentRef = useRef(currentDocId);
  const openRef = useRef(openPage);
  useEffect(() => {
    currentRef.current = currentDocId;
    openRef.current = openPage;
  });
  useEffect(() => {
    if (!hub || !following) return;
    let lastPage: string | null = currentRef.current;
    let lastView = '';
    const apply = (): void => {
      const peer = hub.getPerson(following);
      if (!peer?.page) return;
      const target = jumpTarget(peer);
      const key = `${peer.page}|${target ? `${target.x},${target.y},${target.width},${target.height}` : ''}`;
      if (key === lastView) return;
      lastView = key;
      if (peer.page !== lastPage) {
        lastPage = peer.page;
        openRef.current(peer.page);
      }
      if (target) hub.requestReveal(peer.page, target);
    };
    apply();
    return hub.subscribe(apply);
  }, [hub, following]);
}
