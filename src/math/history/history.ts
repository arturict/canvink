import type {
  CalculatorHistoryCopyKind,
  CalculatorHistoryEntry,
  CalculatorHistoryInput,
  CalculatorHistoryLimits,
  CalculatorHistoryScopeId,
  CalculatorHistoryStorage,
} from './types';
import { createPlatformCalculatorHistoryStorage } from './storage';

export const CALCULATOR_HISTORY_LIMITS: Readonly<CalculatorHistoryLimits> = Object.freeze({
  maxEntries: 500,
  maxTotalBytes: 1024 * 1024,
  maxExpressionBytes: 16 * 1024,
  maxResultBytes: 16 * 1024,
  maxIdBytes: 256,
});

const INPUT_KEYS = ['angleMode', 'expression', 'numberMode', 'visibleResult'] as const;
const ENTRY_KEYS = [...INPUT_KEYS, 'createdAt', 'id'].sort();
const encoder = new TextEncoder();

export interface CalculatorHistoryOptions {
  scopeId: CalculatorHistoryScopeId;
  storage?: CalculatorHistoryStorage;
  createId?: () => string;
  now?: () => string;
  /** Tests may lower limits, but production hard limits cannot be raised. */
  limits?: Partial<CalculatorHistoryLimits>;
}

export class CalculatorHistory {
  private readonly storage: CalculatorHistoryStorage;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly limits: CalculatorHistoryLimits;
  private readonly scopeId: CalculatorHistoryScopeId;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CalculatorHistoryOptions) {
    this.scopeId = assertScopeId(options.scopeId);
    this.storage = options.storage ?? createPlatformCalculatorHistoryStorage();
    this.createId = options.createId ?? secureId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.limits = resolveLimits(options.limits);
  }

  list(): Promise<CalculatorHistoryEntry[]> {
    return this.enqueue(async () => this.readValidated());
  }

  add(input: CalculatorHistoryInput): Promise<CalculatorHistoryEntry> {
    return this.enqueue(async () => {
      assertInput(input, this.limits);
      const current = await this.readValidated();
      const id = this.createId();
      assertBoundedString(id, this.limits.maxIdBytes, 'History ID');
      if (current.some((entry) => entry.id === id)) throw new Error('Calculator history ID collision.');
      const createdAt = this.now();
      assertTimestamp(createdAt);
      const entry: CalculatorHistoryEntry = { ...structuredClone(input), id, createdAt };
      let next = sortEntries([entry, ...current]).slice(0, this.limits.maxEntries);
      while (serializedBytes(next) > this.limits.maxTotalBytes && next.length > 1) next = next.slice(0, -1);
      if (serializedBytes(next) > this.limits.maxTotalBytes) {
        throw new Error('Calculator history entry exceeds the local byte limit.');
      }
      await this.storage.replace(this.scopeId, next);
      return structuredClone(entry);
    });
  }

  copyPayload(id: string, kind: CalculatorHistoryCopyKind = 'expression-and-result'): Promise<string> {
    return this.enqueue(async () => {
      const entry = await this.find(id);
      if (kind === 'expression') return entry.expression;
      if (kind === 'result') return entry.visibleResult;
      if (kind !== 'expression-and-result') throw new Error('Unsupported calculator history copy kind.');
      return `${entry.expression} = ${entry.visibleResult}`;
    });
  }

  restore(
    id: string,
    callback: (input: CalculatorHistoryInput) => void | Promise<void>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const entry = await this.find(id);
      await callback({
        expression: entry.expression,
        visibleResult: entry.visibleResult,
        numberMode: entry.numberMode,
        angleMode: entry.angleMode,
      });
    });
  }

  delete(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const current = await this.readValidated();
      const next = current.filter((entry) => entry.id !== id);
      if (next.length === current.length) return false;
      await this.storage.replace(this.scopeId, next);
      return true;
    });
  }

  clear(): Promise<number> {
    return this.enqueue(async () => {
      const current = await this.readValidated();
      if (current.length > 0) await this.storage.replace(this.scopeId, []);
      return current.length;
    });
  }

  private async find(id: string): Promise<CalculatorHistoryEntry> {
    assertBoundedString(id, this.limits.maxIdBytes, 'History ID');
    const entry = (await this.readValidated()).find((candidate) => candidate.id === id);
    if (!entry) throw new Error('Calculator history entry was not found.');
    return entry;
  }

  private async readValidated(): Promise<CalculatorHistoryEntry[]> {
    const value = await this.storage.read(this.scopeId);
    if (!Array.isArray(value) || value.length > this.limits.maxEntries) {
      throw new Error('Calculator history storage is invalid or exceeds its count limit.');
    }
    const entries = value.map((entry) => assertEntry(entry, this.limits));
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error('Calculator history contains duplicate IDs.');
    }
    if (serializedBytes(entries) > this.limits.maxTotalBytes) {
      throw new Error('Calculator history storage exceeds its byte limit.');
    }
    return sortEntries(entries);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function assertEntry(value: unknown, limits: CalculatorHistoryLimits): CalculatorHistoryEntry {
  if (!isRecord(value) || !sameKeys(value, ENTRY_KEYS)) {
    throw new Error('Calculator history entry has unsupported fields.');
  }
  assertInput(value, limits, false);
  assertBoundedString(value.id, limits.maxIdBytes, 'History ID');
  assertTimestamp(value.createdAt);
  return structuredClone(value) as unknown as CalculatorHistoryEntry;
}

function assertInput(
  value: unknown,
  limits: CalculatorHistoryLimits,
  requireExactKeys = true,
): asserts value is CalculatorHistoryInput {
  if (!isRecord(value) || (requireExactKeys && !sameKeys(value, INPUT_KEYS))) {
    throw new Error('Calculator history input has unsupported fields.');
  }
  assertBoundedString(value.expression, limits.maxExpressionBytes, 'Expression');
  assertBoundedString(value.visibleResult, limits.maxResultBytes, 'Visible result');
  if (value.numberMode !== 'exact' && value.numberMode !== 'decimal') {
    throw new Error('Calculator history number mode is invalid.');
  }
  if (value.angleMode !== 'degrees' && value.angleMode !== 'radians') {
    throw new Error('Calculator history angle mode is invalid.');
  }
}

function assertBoundedString(value: unknown, maximumBytes: number, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || encoder.encode(value).byteLength > maximumBytes) {
    throw new Error(`${label} must be a non-empty bounded string.`);
  }
  if (value.includes('\0')) throw new Error(`${label} contains a forbidden null character.`);
}

function assertTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 64) throw new Error('History timestamp is invalid.');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error('History timestamp is invalid.');
  }
}

function sortEntries(entries: readonly CalculatorHistoryEntry[]): CalculatorHistoryEntry[] {
  return [...entries]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    .map((entry) => structuredClone(entry));
}

function serializedBytes(entries: readonly CalculatorHistoryEntry[]): number {
  return encoder.encode(JSON.stringify(entries)).byteLength;
}

function resolveLimits(overrides: Partial<CalculatorHistoryLimits> = {}): CalculatorHistoryLimits {
  const result = { ...CALCULATOR_HISTORY_LIMITS, ...overrides };
  for (const key of Object.keys(CALCULATOR_HISTORY_LIMITS) as Array<keyof CalculatorHistoryLimits>) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > CALCULATOR_HISTORY_LIMITS[key]) {
      throw new Error(`Calculator history limit ${key} is invalid.`);
    }
  }
  return result;
}

function secureId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `calculation-${globalThis.crypto.randomUUID()}`;
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure randomness is unavailable for calculator history IDs.');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `calculation-${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function assertScopeId(value: unknown): CalculatorHistoryScopeId {
  if (
    typeof value !== 'string'
    || (!value.startsWith('page:') && !value.startsWith('notebook:'))
    || value.endsWith(':')
    || value.includes('\0')
    || encoder.encode(value).byteLength > 512
  ) throw new Error('Calculator history scopeId must be a bounded page or notebook scope.');
  return value as CalculatorHistoryScopeId;
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
