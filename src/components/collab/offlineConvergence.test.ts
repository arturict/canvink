/**
 * Offline behaviour of a shared notebook's owner, end to end in memory: the
 * real room session, owner binding and runtime port against a small fake of
 * the collab-sync relay (seq assignment, acks, broadcast, catch-up by
 * `since`). Covers drawing offline, a reload while offline, a connection that
 * drops with appends in flight, and concurrent edits from both sides.
 */

import * as Automerge from '@automerge/automerge';
import { afterEach, describe, expect, it } from 'vitest';
import { bindEditorSession, openRoomSession, type EditorSessionBinding, type RoomSession } from '../../collab';
import { encodeBase64Url } from '../../collab/protocol';
import { FakeDocumentRuntime } from '../../collab/testDocumentRuntime';
import { FakeRelay } from '../../collab/testRelay';
import { getAutomergeSnapshot, loadAutomergeDocument, type LivePageDocV2 } from '../../crdt';
import type { StrokeElementV2 } from '../../domain/v2';
import { applyPageElementChanges } from '../../editor/pageChanges';
import type { V2RuntimeState } from '../../storage/workspaceV2Runtime';
import { createRuntimeEditorPort, type RuntimeEditorPortSource } from './runtimeEditorPort';

const TIME = '2026-09-24T00:00:00.000Z';
const PAGE = 'page:1';
const NOTEBOOK = 'notebook:1';

function stroke(id: string, x: number): StrokeElementV2 {
  const points = Array.from({ length: 6 }, (_, index) => ({
    x: x + index, y: index, pressure: 0.5, tiltX: 0, tiltY: 0, time: index, pointerType: 'pen' as const,
  }));
  return {
    id, kind: 'stroke', frame: { x, y: 0, width: 5, height: 5, rotation: 0 },
    createdAt: TIME, updatedAt: TIME, locked: false, tool: 'pen', points, color: '#1d4ed8', size: 3, opacity: 1,
  };
}

function initialPage(): Automerge.Doc<LivePageDocV2> {
  return Automerge.from<LivePageDocV2>({
    schemaVersion: 3, documentId: PAGE, kind: 'page', notebookId: 'n1', sectionId: 's1', pageId: 'p1',
    title: 'Mathe', tags: [], pageType: 'free', background: { type: 'grid', color: '#fff' },
    createdAt: TIME, updatedAt: TIME, elementsById: {}, zOrder: [],
  } as unknown as LivePageDocV2);
}

/**
 * One device's persisted documents. Survives a "reload": a new session and
 * a new port are created over the same stored docs, as the app does from
 * IndexedDB.
 */
class Device {
  readonly runtime: FakeDocumentRuntime & RuntimeEditorPortSource;
  session: RoomSession | undefined;
  private unbind: EditorSessionBinding | undefined;

  constructor(page: Automerge.Doc<LivePageDocV2>, notebook: Automerge.Doc<{ kind: string }>) {
    const documents = new FakeDocumentRuntime([
      { documentId: NOTEBOOK, kind: 'notebook', doc: notebook },
      { documentId: PAGE, kind: 'page', doc: page },
    ]);
    this.runtime = Object.assign(documents, {
      getState: () => ({
        schemaVersion: 3,
        notebooks: [{ notebookId: 'n1', documentId: NOTEBOOK, sections: [{ pageDocumentIds: [PAGE] }] }],
      }) as unknown as V2RuntimeState,
    });
  }

  private page(): Automerge.Doc<LivePageDocV2> {
    return this.runtime.doc<LivePageDocV2>(PAGE);
  }

  connect(relay: FakeRelay): void {
    this.session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'tok' },
      resyncStrategy: 'reconcile',
      docStorage: 'bytes',
      webSocketFactory: relay.factory(),
      minBackoffMs: 5,
      maxBackoffMs: 5,
      random: () => 0,
      callbacks: { onStatus: () => undefined },
    });
    this.unbind = bindEditorSession(this.session, createRuntimeEditorPort(this.runtime, 'n1'));
  }

  /** Closes the tab: the in-memory session and anything it queued are gone. */
  close(): void {
    this.unbind?.();
    this.session?.close();
    this.session = undefined;
  }

  draw(id: string, x: number): void {
    this.runtime.change<LivePageDocV2>(PAGE, (draft) => {
      applyPageElementChanges(draft, { upserts: [stroke(id, x)] }, {}, TIME, []);
    });
  }

  erase(id: string): void {
    const before = Automerge.toJS(this.page());
    this.runtime.change<LivePageDocV2>(PAGE, (draft) => {
      applyPageElementChanges(draft, { removals: [id] }, before.elementsById as never, TIME, before.zOrder);
    });
  }

  /** Brings a stroke to the front, as "In den Vordergrund" does. */
  bringToFront(id: string): void {
    const before = Automerge.toJS(this.page());
    const zOrder = [...before.zOrder.filter((entry) => entry !== id), id];
    this.runtime.change<LivePageDocV2>(PAGE, (draft) => {
      applyPageElementChanges(draft, { zOrder }, before.elementsById as never, TIME, before.zOrder);
    });
  }

  /** The strokes as the editor draws them (after the draw-order repair). */
  strokeIds(): string[] {
    return [...getAutomergeSnapshot(this.page()).zOrder].sort();
  }

  savedPage(): Uint8Array {
    return Automerge.save(this.page());
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setTimeout(resolve, 2));
}

/** The merged page still loads from its saved bytes and draws every element exactly once. */
function assertValidPage(device: Device): void {
  const loaded = loadAutomergeDocument<LivePageDocV2>(device.savedPage());
  const page = getAutomergeSnapshot(loaded);
  expect(new Set(page.zOrder).size).toBe(page.zOrder.length);
  expect([...page.zOrder].sort()).toEqual(Object.keys(page.elementsById).sort());
}

const devices: Device[] = [];
afterEach(() => {
  for (const device of devices.splice(0)) device.close();
});

async function sharedRoom(): Promise<{ relay: FakeRelay; owner: Device; peer: Device }> {
  const relay = new FakeRelay();
  const page = initialPage();
  const notebook = Automerge.from({ kind: 'notebook' });
  relay.docs.set(NOTEBOOK, { kind: 'notebook', snapshot: encodeBase64Url(Automerge.save(notebook)), covers: 0, changes: [] });
  relay.docs.set(PAGE, { kind: 'page', snapshot: encodeBase64Url(Automerge.save(page)), covers: 0, changes: [] });
  const owner = new Device(Automerge.clone(page), Automerge.clone(notebook));
  const peer = new Device(Automerge.clone(page), Automerge.clone(notebook));
  devices.push(owner, peer);
  owner.connect(relay);
  peer.connect(relay);
  await settle();
  return { relay, owner, peer };
}

describe('shared notebook offline convergence', () => {
  it('sends ink drawn offline after the connection returns, exactly once', async () => {
    const { relay, owner, peer } = await sharedRoom();
    owner.draw('online-1', 0);
    await settle();
    expect(peer.strokeIds()).toEqual(['online-1']);

    relay.online = false;
    relay.dropAll();
    owner.draw('offline-1', 10);
    owner.draw('offline-2', 20);
    await settle();
    expect(owner.strokeIds()).toEqual(['offline-1', 'offline-2', 'online-1']);

    relay.online = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(peer.strokeIds()).toEqual(['offline-1', 'offline-2', 'online-1']);
    const hashes = relay.storedChangeHashes(PAGE);
    expect(new Set(hashes).size).toBe(hashes.length);
    assertValidPage(peer);
  });

  it('keeps ink drawn offline across a reload and sends it once online again', async () => {
    const { relay, owner, peer } = await sharedRoom();
    relay.online = false;
    relay.dropAll();
    owner.draw('before-reload', 5);
    await settle();

    // Reload while still offline: the tab's session and its memory are gone,
    // only the persisted documents remain.
    owner.close();
    owner.connect(relay);
    await settle();
    expect(owner.strokeIds()).toEqual(['before-reload']);

    relay.online = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(peer.strokeIds()).toEqual(['before-reload']);
    const hashes = relay.storedChangeHashes(PAGE);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('merges concurrent offline and online edits on both sides without losing either', async () => {
    const { relay, owner, peer } = await sharedRoom();
    owner.draw('shared', 0);
    await settle();

    relay.online = false;
    relay.dropAll();
    // The owner works offline while the peer keeps editing online… (the
    // peer's socket was dropped too; it reconnects first).
    owner.draw('owner-offline', 30);
    owner.erase('shared');
    relay.online = true;
    owner.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    peer.draw('peer-online', 40);
    await settle();

    // …then the owner comes back (after a reload) and both converge.
    owner.connect(relay);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(owner.strokeIds()).toEqual(['owner-offline', 'peer-online']);
    expect(peer.strokeIds()).toEqual(['owner-offline', 'peer-online']);
    assertValidPage(owner);
    assertValidPage(peer);
  });

  it('keeps the page valid when one side erases a stroke the other side reorders offline', async () => {
    const { relay, owner, peer } = await sharedRoom();
    owner.draw('a', 0);
    owner.draw('b', 10);
    await settle();
    relay.online = false;
    relay.dropAll();
    owner.bringToFront('a');
    peer.erase('a');
    relay.online = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(owner.strokeIds()).toEqual(['b']);
    expect(peer.strokeIds()).toEqual(['b']);
    assertValidPage(owner);
    assertValidPage(peer);
  });

  it('draws an element once when both sides move it at the same time', async () => {
    const { relay, owner, peer } = await sharedRoom();
    owner.draw('a', 0);
    owner.draw('b', 10);
    owner.draw('c', 20);
    await settle();
    relay.online = false;
    relay.dropAll();
    owner.bringToFront('a');
    peer.bringToFront('a');
    relay.online = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(owner.strokeIds()).toEqual(['a', 'b', 'c']);
    assertValidPage(owner);
    assertValidPage(peer);
  });

  it('does not lose an append whose connection dropped before the acknowledgement', async () => {
    const { relay, owner, peer } = await sharedRoom();
    // Deliver the owner's append to the relay, then cut the line before the
    // ack reaches the owner.
    owner.draw('in-flight', 50);
    relay.dropAll();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(peer.strokeIds()).toEqual(['in-flight']);
    const hashes = relay.storedChangeHashes(PAGE);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});
