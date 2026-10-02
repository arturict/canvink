export type CalculatorNumberMode = 'exact' | 'decimal';
export type CalculatorAngleMode = 'degrees' | 'radians';
export type CalculatorHistoryCopyKind = 'expression' | 'result' | 'expression-and-result';
export type CalculatorHistoryScopeId = `notebook:${string}` | `page:${string}`;

export interface CalculatorHistoryInput {
  expression: string;
  visibleResult: string;
  numberMode: CalculatorNumberMode;
  angleMode: CalculatorAngleMode;
}

export interface CalculatorHistoryEntry extends CalculatorHistoryInput {
  id: string;
  createdAt: string;
}

export interface CalculatorHistoryStorage {
  read(scopeId: CalculatorHistoryScopeId): Promise<unknown>;
  replace(scopeId: CalculatorHistoryScopeId, entries: readonly CalculatorHistoryEntry[]): Promise<void>;
}

export interface CalculatorHistoryLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxExpressionBytes: number;
  maxResultBytes: number;
  maxIdBytes: number;
}
