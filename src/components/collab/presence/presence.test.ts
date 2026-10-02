import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresenceHub, type PresencePeer, type PresenceTransport } from '../../../collab/presence';
import type { PresenceEvent } from '../../../collab/session';
import { createCanvasPresencePort } from './canvasPort';
import { peersByPageId } from './PagePresence';
import { stackOrder, visibleAvatars } from './PresenceStack';
import { deviceNameKey, presenceUserFor } from './presenceUser';

function peer(connId: string, userId: string, page: string | null, away = false): PresencePeer {
  return {
    connId,
    role: 'editor',
    user: { id: userId, name: userId.toUpperCase(), color: '#1971c2' },
    page,
    away,
    cursor: null,
    focus: null,
    view: null,
    focusAt: 0,
    ink: null,
    seenAt: 0,
    activeAt: 0,
  };
}

describe('presence identity', () => {
  it('names local-only devices by family', () => {
    expect(deviceNameKey('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('presence.device.windows');
    expect(deviceNameKey('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('presence.device.iphone');
    expect(deviceNameKey('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('presence.device.ipad');
    expect(deviceNameKey('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('presence.device.mac');
    expect(deviceNameKey('Mozilla/5.0 (Linux; Android 15)')).toBe('presence.device.android');
    expect(deviceNameKey('curl/8')).toBe('presence.device.other');
  });

  it('uses the Clerk name and picture when signed in and never sends raw ids', () => {
    const signedIn = presenceUserFor({
      available: true,
      isSignedIn: true,
      user: { id: 'user_2abc', primaryEmailAddress: 'anna@example.ch', fullName: 'Anna Keller', imageUrl: 'https://img.clerk.com/a' },
      getToken: async () => null,
      openSignIn: () => undefined,
    }, 'device-1', 'Windows-PC');
    expect(signedIn).toMatchObject({ name: 'Anna Keller', imageUrl: 'https://img.clerk.com/a' });
    expect(signedIn.id).not.toContain('user_2abc');

    const local = presenceUserFor({ available: false }, 'device-1', 'Windows-PC');
    expect(local).toMatchObject({ name: 'Windows-PC' });
    expect(local.imageUrl).toBeUndefined();
    expect(local.id).not.toContain('device-1');
  });
});

describe('avatar grouping', () => {
  it('lists everyone in the notebook, this page and active people first, and shows three faces', () => {
    const peers = [
      peer('a', 'a', 'page-2'),
      peer('b', 'b', 'page-1'),
      peer('c', 'c', 'page-1', true),
      peer('d', 'd', 'page-2'),
      peer('e', 'e', null),
    ];
    const ordered = stackOrder(peers.map((entry) => ({ ...entry, activeAt: 1_000 })), 'page-1', 1_000);
    expect(ordered.map((entry) => entry.user.id)).toEqual(['b', 'a', 'd', 'e', 'c']);
    const { shown, more } = visibleAvatars(ordered);
    expect(shown).toHaveLength(3);
    expect(more).toBe(2);
  });

  it('dims a person after a few idle minutes', () => {
    const idle = { ...peer('a', 'a', 'page-1'), activeAt: 0 };
    const fresh = { ...peer('b', 'b', 'page-1'), activeAt: 200_000 };
    expect(stackOrder([idle, fresh], 'page-1', 200_000).map((entry) => entry.user.id)).toEqual(['b', 'a']);
  });

  it('maps people to page ids for the page list, leaving out absent ones', () => {
    const byPage = peersByPageId(
      [peer('a', 'a', 'doc-1'), peer('b', 'b', 'doc-1', true), peer('c', 'c', 'doc-unknown')],
      (docId) => (docId === 'doc-1' ? 'page-1' : undefined),
    );
    expect([...byPage.keys()]).toEqual(['page-1']);
    expect(byPage.get('page-1')?.map((entry) => entry.user.id)).toEqual(['a']);
  });
});

describe('canvas presence port', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the canvas only the present peers on its own page', () => {
    let emit: (event: PresenceEvent) => void = () => undefined;
    const transport: PresenceTransport = {
      sendPresence: () => true,
      subscribePresence: (listener) => { emit = listener; return () => undefined; },
    };
    const hub = new PresenceHub(transport, { user: { id: 'me', name: 'Me', color: '#1971c2' } });
    const port = createCanvasPresencePort(hub, 'doc-1');
    const state = (page: string, away = false) => ({
      v: 1, user: { id: `u-${page}-${away}`, name: 'P', color: '#c2255c' }, page, away, cursor: [1, 1], focus: null, ink: null,
    });
    emit({ kind: 'state', from: 'c1', role: 'editor', state: state('doc-1') });
    emit({ kind: 'state', from: 'c2', role: 'editor', state: state('doc-2') });
    emit({ kind: 'state', from: 'c3', role: 'editor', state: state('doc-1', true) });
    expect(port.getPeers().map((entry) => entry.connId)).toEqual(['c1']);
    // Stable between changes, as `useSyncExternalStore` requires.
    expect(port.getPeers()).toBe(port.getPeers());
    hub.dispose();
  });
});
