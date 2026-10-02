/**
 * Test-only fake of the collab-sync relay (PROTOCOL.md, reduced to what the
 * sync tests need): seq assignment, acks, broadcast to the other sockets and
 * catch-up by `since`. Not a `*.test.ts` file, so vitest never runs it as a
 * suite.
 */

import * as Automerge from '@automerge/automerge';
import { decodeBase64Url } from './protocol';
import type { WebSocketFactory } from './session';
import { MockWebSocket } from './testMocks';

export type Frame = Record<string, unknown>;

/** The relay's behaviour from PROTOCOL.md, reduced to what these tests need. */
export class FakeRelay {
  readonly docs = new Map<string, { kind: string; snapshot?: string; covers: number; changes: Array<{ seq: number; payload: string }> }>();
  private readonly sockets = new Set<RelaySocket>();
  online = true;

  factory(): WebSocketFactory {
    return (url) => {
      const socket = new RelaySocket(url, this);
      if (this.online) queueMicrotask(() => socket.open());
      else queueMicrotask(() => socket.serverClose(1006));
      return socket;
    };
  }

  /** Cuts every connection, as losing Wi-Fi does. */
  dropAll(): void {
    for (const socket of [...this.sockets]) {
      this.sockets.delete(socket);
      socket.serverClose(1006);
    }
  }

  handle(socket: RelaySocket, frame: Frame): void {
    if (!this.sockets.has(socket) && frame.t !== 'hello') return;
    switch (frame.t) {
      case 'hello': {
        this.sockets.add(socket);
        const since = (frame.since ?? {}) as Record<string, number>;
        socket.deliver({ t: 'welcome', role: 'owner', notebookTitle: 'N', docs: [...this.docs].map(([docId, doc]) => ({ docId, kind: doc.kind })) });
        for (const [docId, doc] of this.docs) {
          const has = Object.prototype.hasOwnProperty.call(since, docId);
          if (doc.snapshot && (!has || since[docId] < doc.covers)) {
            socket.deliver({ t: 'snapshot', docId, payload: doc.snapshot, covers: doc.covers });
          }
          const baseline = Math.max(doc.covers, since[docId] ?? 0);
          for (const change of doc.changes) {
            if (change.seq > baseline) socket.deliver({ t: 'append', docId, payload: change.payload, seq: change.seq });
          }
        }
        socket.deliver({ t: 'synced' });
        return;
      }
      case 'announce': {
        const docId = String(frame.docId);
        if (!this.docs.has(docId)) this.docs.set(docId, { kind: String(frame.kind), covers: 0, changes: [] });
        this.broadcast(socket, frame);
        return;
      }
      case 'snapshot': {
        const docId = String(frame.docId);
        const doc = this.docs.get(docId) ?? { kind: 'page', covers: 0, changes: [] };
        doc.snapshot = String(frame.payload);
        doc.covers = Number(frame.covers);
        doc.changes = doc.changes.filter((change) => change.seq > doc.covers);
        this.docs.set(docId, doc);
        this.broadcast(socket, frame);
        return;
      }
      case 'append': {
        const docId = String(frame.docId);
        const doc = this.docs.get(docId);
        if (!doc) return;
        const seq = Math.max(doc.covers, ...doc.changes.map((change) => change.seq), 0) + 1;
        doc.changes.push({ seq, payload: String(frame.payload) });
        this.broadcast(socket, { t: 'append', docId, payload: frame.payload, seq });
        socket.deliver({ t: 'seq', docId, seq });
        return;
      }
      default:
    }
  }

  private broadcast(sender: RelaySocket, frame: Frame): void {
    for (const socket of this.sockets) if (socket !== sender) socket.deliver(frame);
  }

  /** Change hashes stored for a doc, snapshot history included. */
  storedChangeHashes(docId: string): string[] {
    const doc = this.docs.get(docId);
    if (!doc) return [];
    const hashes: string[] = [];
    if (doc.snapshot) {
      for (const change of Automerge.getAllChanges(Automerge.load(decodeBase64Url(doc.snapshot)))) {
        hashes.push(Automerge.decodeChange(change).hash!);
      }
    }
    for (const change of doc.changes) {
      for (const chunk of changeChunks(decodeBase64Url(change.payload))) hashes.push(Automerge.decodeChange(chunk).hash!);
    }
    return hashes;
  }
}

/**
 * Splits an incremental save (`saveSince` output) into its change chunks:
 * 4 magic bytes, 4 checksum bytes, a type byte and a LEB128 length.
 */
export function changeChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let cursor = offset + 9;
    let length = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[cursor];
      cursor += 1;
      length |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    const end = cursor + length;
    chunks.push(bytes.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export class RelaySocket extends MockWebSocket {
  constructor(url: string, private readonly relay: FakeRelay) {
    super(url);
  }

  override send(data: string): void {
    super.send(data);
    const frame = JSON.parse(data) as Frame;
    queueMicrotask(() => this.relay.handle(this, frame));
  }

  deliver(frame: Frame): void {
    queueMicrotask(() => { if (this.readyState === 1) this.receive(frame); });
  }
}

