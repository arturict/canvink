import type { DurableSyncSnapshot, DurableSyncStatePort, NetworkStatePort } from './types';

export class MemoryDurableSyncState implements DurableSyncStatePort {
  private readonly snapshots = new Map<string, DurableSyncSnapshot>();

  async load(notebookId: string): Promise<DurableSyncSnapshot | undefined> {
    const value = this.snapshots.get(notebookId);
    return value ? structuredClone(value) : undefined;
  }

  async save(snapshot: DurableSyncSnapshot): Promise<void> {
    this.snapshots.set(snapshot.notebookId, structuredClone(snapshot));
  }
}

export class BrowserNetworkState implements NetworkStatePort {
  isOnline(): boolean {
    return typeof navigator === 'undefined' ? true : navigator.onLine;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    if (typeof globalThis.addEventListener !== 'function') return () => undefined;
    const online = () => listener(true);
    const offline = () => listener(false);
    globalThis.addEventListener('online', online);
    globalThis.addEventListener('offline', offline);
    return () => {
      globalThis.removeEventListener('online', online);
      globalThis.removeEventListener('offline', offline);
    };
  }
}
