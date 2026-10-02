import { describe, expect, it } from 'vitest';
import { createInboundSyncState, type OutboxState, type PendingSyncEnvelope } from '..';
import { BrowserDurableSyncState, BrowserSessionSecretStore } from './browserPorts';
import { TauriDpapiSecretStore, TauriDurableSyncState } from './tauriPorts';
import type { DurableSyncSnapshot } from './types';

function bytes(length: number, fill: number): Uint8Array { return new Uint8Array(length).fill(fill); }

function envelope(documentId = 'document'): PendingSyncEnvelope {
  return {
    protocolVersion: 1,
    notebookId: 'notebook',
    documentId,
    deviceId: 'device',
    keyEpoch: 1,
    sequence: null,
    changeHash: bytes(32, 1),
    nonce: bytes(24, 2),
    ciphertext: bytes(20, 3),
    signature: bytes(64, 4),
  };
}

function snapshot(outbox: OutboxState, cursor = 0): DurableSyncSnapshot {
  return { version: 1, notebookId: 'notebook', outbox, inbox: createInboundSyncState('notebook', cursor) };
}

describe('browser and Tauri durable sync ports', () => {
  it('atomically round-trips the complete browser snapshot and keeps browser keys session-only', async () => {
    const values = new Map<string, unknown>();
    const durable = new BrowserDurableSyncState({
      get: async (key) => values.get(key),
      set: async (key, value) => { values.set(key, structuredClone(value)); },
    });
    const outbox: OutboxState = {
      nextLocalOrder: 2,
      pending: [{ operationId: 'operation', localOrder: 1, envelope: envelope() }],
      acknowledged: [],
    };
    await durable.save(snapshot(outbox, 7));
    await expect(durable.load('notebook')).resolves.toEqual(snapshot(outbox, 7));

    const session = new BrowserSessionSecretStore();
    const secret = bytes(32, 9);
    session.save('device', secret);
    expect(secret).toEqual(new Uint8Array(32));
    expect(session.load('device')).toEqual(bytes(32, 9));
    expect(new BrowserSessionSecretStore().load('device')).toBeUndefined();
    session.clear();
    expect(session.load('device')).toBeUndefined();
  });

  it('uses native outbox records, exact-hash deletion, and CAS cursor reset without collapsing local order', async () => {
    const records = new Map<string, Record<string, unknown>>();
    let cursor: Record<string, unknown> | null = null;
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      if (command === 'v2_list_outbox') {
        const after = typeof args?.afterLocalOrder === 'number' ? args.afterLocalOrder : -1;
        const limit = Number(args?.limit ?? 100);
        return [...records.values()]
          .filter((record) => Number(record.localOrder) > after)
          .sort((left, right) => Number(left.localOrder) - Number(right.localOrder))
          .slice(0, limit) as T;
      }
      if (command === 'v2_get_sync_cursor') return cursor as T;
      if (command === 'v2_put_outbox') {
        const request = args?.request as Record<string, unknown>;
        const stored = { ...request, envelopeSha256: `sha256:${'a'.repeat(64)}` };
        records.set(String(request.operationId), stored);
        return stored as T;
      }
      if (command === 'v2_delete_outbox') {
        const request = args?.request as Record<string, unknown>;
        records.delete(String(request.operationId));
        return true as T;
      }
      if (command === 'v2_put_sync_cursor') {
        cursor = structuredClone(args?.cursor as Record<string, unknown>);
        return cursor as T;
      }
      if (command === 'v2_reset_sync_cursor') {
        const request = args?.request as Record<string, unknown>;
        expect(request.expectedContiguousSequence).toBe(cursor?.contiguousSequence);
        cursor = { notebookId: request.notebookId, contiguousSequence: 0, updatedAt: request.resetAt };
        return cursor as T;
      }
      throw new Error(`Unexpected ${command}`);
    };
    const durable = new TauriDurableSyncState(invoke, () => '2026-08-03T12:00:00.000Z');
    const outbox: OutboxState = {
      nextLocalOrder: 3,
      pending: [{ operationId: 'operation', localOrder: 2, envelope: envelope() }],
      acknowledged: [],
    };
    await durable.save(snapshot(outbox, 5));
    const reopened = await durable.load('notebook');
    expect(reopened?.outbox.pending[0]).toMatchObject({ operationId: 'operation', localOrder: 2 });
    expect(reopened?.inbox.contiguousSequence).toBe(5);

    await durable.save(snapshot(outbox, 0));
    expect(calls.some((call) => call.command === 'v2_reset_sync_cursor')).toBe(true);
    await durable.save(snapshot({ nextLocalOrder: 3, pending: [], acknowledged: [] }, 0));
    expect(records.size).toBe(0);
    expect(calls.find((call) => call.command === 'v2_delete_outbox')?.args).toEqual({
      request: { operationId: 'operation', envelopeSha256: `sha256:${'a'.repeat(64)}` },
    });
  });

  it('pages and reopens more than 1000 native offline changes without truncation', async () => {
    const records = new Map<string, Record<string, unknown>>();
    let cursor: Record<string, unknown> | null = null;
    const listCalls: Array<Record<string, unknown> | undefined> = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'v2_list_outbox') {
        listCalls.push(args);
        const after = typeof args?.afterLocalOrder === 'number' ? args.afterLocalOrder : -1;
        const limit = Number(args?.limit ?? 100);
        return [...records.values()]
          .filter((record) => Number(record.localOrder) > after)
          .sort((left, right) => Number(left.localOrder) - Number(right.localOrder))
          .slice(0, limit) as T;
      }
      if (command === 'v2_get_sync_cursor') return cursor as T;
      if (command === 'v2_put_outbox') {
        const request = args?.request as Record<string, unknown>;
        const stored = { ...request, envelopeSha256: `sha256:${String(request.operationId).padEnd(64, '0').slice(0, 64)}` };
        records.set(String(request.operationId), stored);
        return stored as T;
      }
      if (command === 'v2_put_sync_cursor') {
        cursor = structuredClone(args?.cursor as Record<string, unknown>);
        return cursor as T;
      }
      if (command === 'v2_delete_outbox') return true as T;
      throw new Error(`Unexpected ${command}`);
    };
    const pending = Array.from({ length: 1_005 }, (_, localOrder) => ({
      operationId: `operation-${localOrder.toString().padStart(4, '0')}`,
      localOrder,
      envelope: envelope(),
    }));
    const durable = new TauriDurableSyncState(invoke, () => '2026-08-03T12:00:00.000Z');
    await durable.save(snapshot({ nextLocalOrder: 1_005, pending, acknowledged: [] }, 17));
    listCalls.length = 0;

    const reopened = await new TauriDurableSyncState(invoke).load('notebook');
    expect(reopened?.outbox.pending).toHaveLength(1_005);
    expect(reopened?.outbox.pending.at(-1)).toMatchObject({ operationId: 'operation-1004', localOrder: 1_004 });
    expect(reopened?.outbox.nextLocalOrder).toBe(1_005);
    expect(reopened?.inbox.contiguousSequence).toBe(17);
    expect(listCalls).toEqual([
      { notebookId: 'notebook', limit: 1_000 },
      { notebookId: 'notebook', afterLocalOrder: 999, limit: 1_000 },
    ]);
  });

  it('persists only a DPAPI-protected desktop blob and fails closed on unlock errors', async () => {
    const storage = new Map<string, string>();
    const values = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    };
    const dpapi = {
      protectKeyMaterial: async (material: Uint8Array) => {
        const encoded = btoa(String.fromCharCode(...material));
        material.fill(0);
        return encoded;
      },
      unprotectKeyMaterial: async (protectedBlob: string) => Uint8Array.from(atob(protectedBlob), (character) => character.charCodeAt(0)),
    };
    const secrets = new TauriDpapiSecretStore(values, dpapi as never);
    const secret = bytes(16, 7);
    await secrets.save('device', secret);
    expect(secret).toEqual(new Uint8Array(16));
    expect(storage.get('canvink.sync.secret.device')).not.toContain(String.fromCharCode(...bytes(16, 7)));
    await expect(secrets.load('device')).resolves.toEqual(bytes(16, 7));
    secrets.clear('device');
    await expect(secrets.load('device')).resolves.toBeUndefined();

    const blocked = new TauriDpapiSecretStore(values, {
      protectKeyMaterial: async () => { throw new Error('DPAPI unavailable'); },
      unprotectKeyMaterial: async () => { throw new Error('DPAPI unavailable'); },
    } as never);
    values.setItem('canvink.sync.secret.device', 'opaque');
    await expect(blocked.load('device')).rejects.toMatchObject({ code: 'key-epoch-unavailable' });
  });
});
