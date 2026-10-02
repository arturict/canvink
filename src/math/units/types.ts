export const UNIT_IDS = [
  'millimeter', 'centimeter', 'meter', 'kilometer', 'inch', 'foot', 'yard', 'mile',
  'gram', 'kilogram', 'ounce', 'pound', 'millisecond', 'second', 'minute', 'hour',
  'milliliter', 'liter', 'cubic-meter', 'square-centimeter', 'square-meter', 'hectare',
  'meter-per-second', 'kilometer-per-hour', 'mile-per-hour', 'newton', 'joule', 'watt',
  'pascal', 'kilopascal', 'bar',
] as const;

export type UnitId = typeof UNIT_IDS[number];

export const CURRENCY_IDS = ['CHF', 'EUR', 'USD', 'GBP', 'JPY', 'CAD', 'AUD'] as const;
export type CurrencyId = typeof CURRENCY_IDS[number];
export type CurrencySnapshotStatus = 'current' | 'stale';

export const UNIT_CONVERSION_LIMITS = Object.freeze({
  maxAbsoluteInput: 1e15,
  maxAbsoluteOutput: 1e18,
  maxDurationMillis: 500,
  maxSourceBytes: 128,
});

export interface UnitConversionRequest {
  readonly value: number;
  readonly sourceUnitId: UnitId;
  readonly targetUnitId: UnitId;
}

export interface UnitConversionResult {
  readonly value: number;
  readonly unitId: UnitId;
  readonly engine: 'numbat-1.23.0';
  readonly durationMillis: number;
}

export interface CurrencyConversionRequest {
  readonly value: number;
  readonly sourceCurrencyId: CurrencyId;
  readonly targetCurrencyId: CurrencyId;
}

export interface CurrencyConversionResult {
  readonly value: number;
  readonly currencyId: CurrencyId;
  readonly source: string;
  readonly asOf: string;
  readonly status: CurrencySnapshotStatus;
  readonly snapshotVersion: 1;
}

export type MathUnitsErrorCode =
  | 'invalid-input'
  | 'unknown-unit'
  | 'dimension-mismatch'
  | 'unit-engine-unavailable'
  | 'unit-engine-busy'
  | 'unit-engine-timeout'
  | 'currency-unavailable'
  | 'unknown-currency'
  | 'currency-snapshot-invalid'
  | 'invalid-response';

export class MathUnitsError extends Error {
  constructor(public readonly code: MathUnitsErrorCode) {
    super('The requested conversion could not be completed.');
    this.name = 'MathUnitsError';
  }
}

export interface MathUnitsPort {
  readonly availability: 'available' | 'unavailable';
  convertUnit(request: UnitConversionRequest): Promise<UnitConversionResult>;
  convertCurrency(request: CurrencyConversionRequest): Promise<CurrencyConversionResult>;
}
