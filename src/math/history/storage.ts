import { createStore, get, set } from 'idb-keyval';
import type {
  CalculatorHistoryEntry,
  CalculatorHistoryScopeId,
  CalculatorHistoryStorage,
} from './types';

const DATABASE_NAME = 'canvink-math-local-v1';
const STORE_NAME = 'calculator-history-scoped-v2';
const SCOPED_KEY_PREFIX = 'entries-v2:';
const MAX_SCOPE_ID_BYTES = 512;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryCalculatorHistoryStorage implements CalculatorHistoryStorage {
  private readonly entriesByScope = new Map<CalculatorHistoryScopeId, unknown>();

  constructor(initialByScope: Readonly<Partial<Record<CalculatorHistoryScopeId, unknown>>> = {}) {
    for (const [scopeId, entries] of Object.entries(initialByScope)) {
      const validated = assertScopeId(scopeId);
      this.entriesByScope.set(validated, clone(entries));
    }
  }

  async read(scopeId: CalculatorHistoryScopeId): Promise<unknown> {
    return clone(this.entriesByScope.get(assertScopeId(scopeId)) ?? []);
  }

  async replace(
    scopeId: CalculatorHistoryScopeId,
    entries: readonly CalculatorHistoryEntry[],
  ): Promise<void> {
    this.entriesByScope.set(assertScopeId(scopeId), clone(entries));
  }
}

export class IndexedDbCalculatorHistoryStorage implements CalculatorHistoryStorage {
  private readonly store = createStore(DATABASE_NAME, STORE_NAME);

  async read(scopeId: CalculatorHistoryScopeId): Promise<unknown> {
    return clone(await get<unknown>(calculatorHistoryStorageKey(scopeId), this.store) ?? []);
  }

  async replace(
    scopeId: CalculatorHistoryScopeId,
    entries: readonly CalculatorHistoryEntry[],
  ): Promise<void> {
    await set(calculatorHistoryStorageKey(scopeId), clone(entries), this.store);
  }
}

/** Permanently switches to memory after the first unavailable IndexedDB operation. */
export class FallbackCalculatorHistoryStorage implements CalculatorHistoryStorage {
  private failedOver = false;

  constructor(
    private readonly primary: CalculatorHistoryStorage,
    private readonly fallback: CalculatorHistoryStorage = new MemoryCalculatorHistoryStorage(),
  ) {}

  async read(scopeId: CalculatorHistoryScopeId): Promise<unknown> {
    if (this.failedOver) return this.fallback.read(scopeId);
    try {
      return await this.primary.read(scopeId);
    } catch {
      this.failedOver = true;
      return this.fallback.read(scopeId);
    }
  }

  async replace(
    scopeId: CalculatorHistoryScopeId,
    entries: readonly CalculatorHistoryEntry[],
  ): Promise<void> {
    if (!this.failedOver) {
      try {
        await this.primary.replace(scopeId, entries);
        return;
      } catch {
        this.failedOver = true;
      }
    }
    await this.fallback.replace(scopeId, entries);
  }
}

export function createPlatformCalculatorHistoryStorage(): CalculatorHistoryStorage {
  if (typeof globalThis.indexedDB === 'undefined') return new MemoryCalculatorHistoryStorage();
  return new FallbackCalculatorHistoryStorage(new IndexedDbCalculatorHistoryStorage());
}

/**
 * The legacy global `entries-v1` key is deliberately never read or migrated:
 * assigning it to any page/notebook would disclose one scope's calculations in
 * another. Users can safely discard it through normal browser data controls.
 */
export function calculatorHistoryStorageKey(scopeId: CalculatorHistoryScopeId): string {
  const validated = assertScopeId(scopeId);
  return `${SCOPED_KEY_PREFIX}${validated.length}:${validated}`;
}

function assertScopeId(value: unknown): CalculatorHistoryScopeId {
  if (
    typeof value !== 'string'
    || (!value.startsWith('page:') && !value.startsWith('notebook:'))
    || value.endsWith(':')
    || value.includes('\0')
    || new TextEncoder().encode(value).byteLength > MAX_SCOPE_ID_BYTES
  ) throw new Error('Calculator history scopeId must be a bounded page or notebook scope.');
  return value as CalculatorHistoryScopeId;
}
