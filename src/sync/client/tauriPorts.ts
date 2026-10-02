import { WindowsDpapiBridge, type DpapiInvoke } from '../../security/dpapiBridge';
import { createInboundSyncState } from '../inbox';
import type { OutboxState } from '../types';
import type { DurableSyncSnapshot, DurableSyncStatePort } from './types';
import { SyncClientError } from './errors';
import { pendingChangeFromJson, pendingChangeToJson } from './wire';

type TauriInvoke = DpapiInvoke;

interface NativeOutboxRecord {
  operationId: string;
  notebookId: string;
  documentId: string;
  localOrder: number;
  envelopeSha256: string;
  envelope: number[];
  createdAt: string;
}

interface NativeCursor {
  notebookId: string;
  contiguousSequence: number;
  updatedAt: string;
}

async function defaultInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export class TauriDurableSyncState implements DurableSyncStatePort {
  constructor(
    private readonly invoke: TauriInvoke = defaultInvoke,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async load(notebookId: string): Promise<DurableSyncSnapshot | undefined> {
    const [records, cursor] = await Promise.all([
      this.listAllOutbox(notebookId),
      this.invoke<unknown>('v2_get_sync_cursor', { notebookId }),
    ]);
    const parsedRecords = records;
    const parsedCursor = parseCursor(cursor, notebookId);
    if (parsedRecords.length === 0 && !parsedCursor) return undefined;
    const outbox: OutboxState = {
      nextLocalOrder: (parsedRecords.at(-1)?.localOrder ?? 0) + 1,
      pending: parsedRecords.map((record) => ({
        operationId: record.operationId,
        localOrder: record.localOrder,
        envelope: decodeEnvelope(record.envelope),
      })),
      acknowledged: [],
    };
    return {
      version: 1,
      notebookId,
      outbox,
      inbox: createInboundSyncState(notebookId, parsedCursor?.contiguousSequence ?? 0),
    };
  }

  async save(snapshot: DurableSyncSnapshot): Promise<void> {
    if (snapshot.version !== 1 || snapshot.inbox.notebookId !== snapshot.notebookId) {
      throw new SyncClientError('protocol-error', 'Native durable sync state is invalid.');
    }
    const existing = await this.listAllOutbox(snapshot.notebookId);
    const existingById = new Map(existing.map((record) => [record.operationId, record]));
    for (const entry of snapshot.outbox.pending) {
      const envelope = encodeEnvelope(entry.envelope);
      await this.invoke('v2_put_outbox', {
        request: {
          operationId: entry.operationId,
          notebookId: snapshot.notebookId,
          documentId: entry.envelope.documentId,
          localOrder: entry.localOrder,
          envelope: [...envelope],
          createdAt: existingById.get(entry.operationId)?.createdAt ?? this.now(),
        },
      });
    }

    const nativeCursor = parseCursor(
      await this.invoke<unknown>('v2_get_sync_cursor', { notebookId: snapshot.notebookId }),
      snapshot.notebookId,
    );
    if (nativeCursor && snapshot.inbox.contiguousSequence < nativeCursor.contiguousSequence) {
      if (snapshot.inbox.contiguousSequence !== 0) {
        throw new SyncClientError('protocol-error', 'Native sync cursor can only reset to zero.');
      }
      await this.invoke('v2_reset_sync_cursor', {
        request: {
          notebookId: snapshot.notebookId,
          expectedContiguousSequence: nativeCursor.contiguousSequence,
          resetAt: this.now(),
        },
      });
    } else {
      await this.invoke('v2_put_sync_cursor', {
        cursor: {
          notebookId: snapshot.notebookId,
          contiguousSequence: snapshot.inbox.contiguousSequence,
          updatedAt: this.now(),
        },
      });
    }

    const pending = new Set(snapshot.outbox.pending.map((entry) => entry.operationId));
    for (const record of existing) {
      if (!pending.has(record.operationId)) {
        await this.invoke('v2_delete_outbox', {
          request: { operationId: record.operationId, envelopeSha256: record.envelopeSha256 },
        });
      }
    }
  }

  private async listAllOutbox(notebookId: string): Promise<NativeOutboxRecord[]> {
    const records: NativeOutboxRecord[] = [];
    let afterLocalOrder: number | undefined;
    while (true) {
      const page = parseRecords(await this.invoke<unknown>('v2_list_outbox', {
        notebookId,
        ...(afterLocalOrder === undefined ? {} : { afterLocalOrder }),
        limit: 1_000,
      }), notebookId);
      if (page.length === 0) break;
      const last = page.at(-1)?.localOrder;
      if (last === undefined || (afterLocalOrder !== undefined && last <= afterLocalOrder)) {
        throw new SyncClientError('protocol-error', 'Native outbox pagination did not advance.');
      }
      records.push(...page);
      afterLocalOrder = last;
      if (page.length < 1_000) break;
    }
    return records;
  }
}

export interface ProtectedSecretKeyValuePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class TauriDpapiSecretStore {
  readonly persistence = 'windows-dpapi' as const;
  constructor(
    private readonly storage: ProtectedSecretKeyValuePort,
    private readonly dpapi = new WindowsDpapiBridge(),
    private readonly prefix = 'canvink.sync.secret.',
  ) {}

  async save(id: string, secret: Uint8Array): Promise<void> {
    if (!id) throw new SyncClientError('protocol-error', 'Secret identifier is invalid.');
    const protectedBlob = await this.dpapi.protectKeyMaterial(secret);
    this.storage.setItem(this.prefix + id, protectedBlob);
  }

  async load(id: string): Promise<Uint8Array | undefined> {
    const protectedBlob = this.storage.getItem(this.prefix + id);
    if (!protectedBlob) return undefined;
    try {
      return await this.dpapi.unprotectKeyMaterial(protectedBlob);
    } catch (error) {
      throw new SyncClientError('key-epoch-unavailable', 'Desktop key protection could not unlock this device.', { cause: error });
    }
  }

  clear(id: string): void { this.storage.removeItem(this.prefix + id); }
}

function encodeEnvelope(value: Parameters<typeof pendingChangeToJson>[0]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(pendingChangeToJson(value)));
}

function decodeEnvelope(value: number[]) {
  try {
    return pendingChangeFromJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(value))) as unknown);
  } catch (error) {
    throw new SyncClientError('protocol-error', 'Native outbox envelope is invalid.', { cause: error });
  }
}

function parseRecords(value: unknown, notebookId: string): NativeOutboxRecord[] {
  if (!Array.isArray(value)) throw new SyncClientError('protocol-error', 'Native outbox response is invalid.');
  const records = value.map((record): NativeOutboxRecord => {
    if (typeof record !== 'object' || record === null) throw new SyncClientError('protocol-error', 'Native outbox record is invalid.');
    const item = record as Partial<NativeOutboxRecord>;
    if (
      typeof item.operationId !== 'string' || item.notebookId !== notebookId ||
      typeof item.documentId !== 'string' || !Number.isSafeInteger(item.localOrder) ||
      typeof item.envelopeSha256 !== 'string' || !Array.isArray(item.envelope) ||
      !item.envelope.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ||
      typeof item.createdAt !== 'string'
    ) throw new SyncClientError('protocol-error', 'Native outbox record is invalid.');
    return item as NativeOutboxRecord;
  });
  return records.sort((left, right) => left.localOrder - right.localOrder || left.operationId.localeCompare(right.operationId));
}

function parseCursor(value: unknown, notebookId: string): NativeCursor | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || value === null) throw new SyncClientError('protocol-error', 'Native cursor response is invalid.');
  const cursor = value as Partial<NativeCursor>;
  if (cursor.notebookId !== notebookId || !Number.isSafeInteger(cursor.contiguousSequence) || typeof cursor.updatedAt !== 'string') {
    throw new SyncClientError('protocol-error', 'Native cursor response is invalid.');
  }
  return cursor as NativeCursor;
}
