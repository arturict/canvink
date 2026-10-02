import {
  CURRENCY_IDS,
  MathUnitsError,
  UNIT_CONVERSION_LIMITS,
  UNIT_IDS,
  type CurrencyConversionRequest,
  type CurrencyConversionResult,
  type CurrencyId,
  type MathUnitsErrorCode,
  type MathUnitsPort,
  type UnitConversionRequest,
  type UnitConversionResult,
  type UnitId,
} from './types';

export type MathUnitsInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const unitIds: ReadonlySet<string> = new Set(UNIT_IDS);
const currencyIds: ReadonlySet<string> = new Set(CURRENCY_IDS);
const nativeErrorCodes: ReadonlySet<MathUnitsErrorCode> = new Set([
  'invalid-input', 'dimension-mismatch', 'unit-engine-unavailable', 'unit-engine-busy',
  'unit-engine-timeout', 'currency-unavailable', 'unknown-currency',
  'currency-snapshot-invalid',
]);

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

async function defaultInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<unknown>(command, args);
}

function validNumber(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximum;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function validSource(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && new TextEncoder().encode(value).byteLength <= UNIT_CONVERSION_LIMITS.maxSourceBytes
    && !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    });
}

function assertUnitRequest(request: UnitConversionRequest): UnitConversionRequest {
  if (
    !request || typeof request !== 'object'
    || !validNumber(request.value, UNIT_CONVERSION_LIMITS.maxAbsoluteInput)
    || !unitIds.has(request.sourceUnitId)
    || !unitIds.has(request.targetUnitId)
  ) throw new MathUnitsError('invalid-input');
  return {
    value: request.value,
    sourceUnitId: request.sourceUnitId,
    targetUnitId: request.targetUnitId,
  };
}

function assertCurrencyRequest(request: CurrencyConversionRequest): CurrencyConversionRequest {
  if (
    !request || typeof request !== 'object'
    || !validNumber(request.value, UNIT_CONVERSION_LIMITS.maxAbsoluteInput)
    || !currencyIds.has(request.sourceCurrencyId)
    || !currencyIds.has(request.targetCurrencyId)
  ) throw new MathUnitsError('invalid-input');
  return {
    value: request.value,
    sourceCurrencyId: request.sourceCurrencyId,
    targetCurrencyId: request.targetCurrencyId,
  };
}

function assertUnitResult(value: unknown, expectedUnit: UnitId): UnitConversionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MathUnitsError('invalid-response');
  }
  const result = value as Partial<UnitConversionResult>;
  if (
    !validNumber(result.value, UNIT_CONVERSION_LIMITS.maxAbsoluteOutput)
    || result.unitId !== expectedUnit
    || result.engine !== 'numbat-1.23.0'
    || !Number.isSafeInteger(result.durationMillis)
    || (result.durationMillis ?? -1) < 0
    || (result.durationMillis ?? Infinity) > UNIT_CONVERSION_LIMITS.maxDurationMillis
  ) throw new MathUnitsError('invalid-response');
  return structuredClone(result as UnitConversionResult);
}

function assertCurrencyResult(
  value: unknown,
  expectedCurrency: CurrencyId,
): CurrencyConversionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MathUnitsError('invalid-response');
  }
  const result = value as Partial<CurrencyConversionResult>;
  if (
    !validNumber(result.value, UNIT_CONVERSION_LIMITS.maxAbsoluteOutput)
    || result.currencyId !== expectedCurrency
    || !validSource(result.source)
    || !validDate(result.asOf)
    || (result.status !== 'current' && result.status !== 'stale')
    || result.snapshotVersion !== 1
  ) throw new MathUnitsError('invalid-response');
  return structuredClone(result as CurrencyConversionResult);
}

function opaqueNativeError(error: unknown): MathUnitsError {
  const source = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const code = typeof source.code === 'string'
    && nativeErrorCodes.has(source.code as MathUnitsErrorCode)
    ? source.code as MathUnitsErrorCode
    : 'unit-engine-unavailable';
  return new MathUnitsError(code);
}

export class NativeMathUnitsPort implements MathUnitsPort {
  readonly availability: 'available' | 'unavailable';

  constructor(
    private readonly invoke: MathUnitsInvoke = defaultInvoke,
    nativeAvailable = isTauriRuntime(),
  ) {
    this.availability = nativeAvailable ? 'available' : 'unavailable';
  }

  async convertUnit(request: UnitConversionRequest): Promise<UnitConversionResult> {
    if (this.availability === 'unavailable') throw new MathUnitsError('unit-engine-unavailable');
    const normalized = assertUnitRequest(request);
    try {
      return assertUnitResult(
        await this.invoke('math_units_convert', { request: normalized }),
        normalized.targetUnitId,
      );
    } catch (error) {
      if (error instanceof MathUnitsError) throw error;
      throw opaqueNativeError(error);
    }
  }

  async convertCurrency(request: CurrencyConversionRequest): Promise<CurrencyConversionResult> {
    if (this.availability === 'unavailable') throw new MathUnitsError('currency-unavailable');
    const normalized = assertCurrencyRequest(request);
    try {
      return assertCurrencyResult(
        await this.invoke('math_currency_convert', { request: normalized }),
        normalized.targetCurrencyId,
      );
    } catch (error) {
      if (error instanceof MathUnitsError) throw error;
      throw opaqueNativeError(error);
    }
  }
}

export class UnavailableBrowserMathUnitsPort implements MathUnitsPort {
  readonly availability = 'unavailable' as const;

  async convertUnit(_request: UnitConversionRequest): Promise<UnitConversionResult> {
    void _request;
    throw new MathUnitsError('unit-engine-unavailable');
  }

  async convertCurrency(_request: CurrencyConversionRequest): Promise<CurrencyConversionResult> {
    void _request;
    throw new MathUnitsError('currency-unavailable');
  }
}

export function createMathUnitsPort(): MathUnitsPort {
  return isTauriRuntime()
    ? new NativeMathUnitsPort()
    : new UnavailableBrowserMathUnitsPort();
}
