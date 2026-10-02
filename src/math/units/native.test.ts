import { describe, expect, it, vi } from 'vitest';
import {
  NativeMathUnitsPort,
  UnavailableBrowserMathUnitsPort,
  type MathUnitsInvoke,
} from './native';
import {
  MathUnitsError,
  type CurrencyConversionResult,
  type UnitConversionRequest,
  type UnitId,
} from './types';

describe('native Math units bridge', () => {
  it('sends only normalized typed unit DTOs and validates native results', async () => {
    const invoke = vi.fn<MathUnitsInvoke>(async (_command, args) => ({
      value: 125,
      unitId: (args?.request as { targetUnitId: UnitId }).targetUnitId,
      engine: 'numbat-1.23.0',
      durationMillis: 4,
    }));
    const port = new NativeMathUnitsPort(invoke, true);
    await expect(port.convertUnit({
      value: 1.25, sourceUnitId: 'meter', targetUnitId: 'centimeter',
    })).resolves.toEqual({
      value: 125, unitId: 'centimeter', engine: 'numbat-1.23.0', durationMillis: 4,
    });
    expect(invoke).toHaveBeenCalledWith('math_units_convert', {
      request: { value: 1.25, sourceUnitId: 'meter', targetUnitId: 'centimeter' },
    });
  });

  it.each([
    { value: Number.NaN, sourceUnitId: 'meter', targetUnitId: 'centimeter' },
    { value: 2e15, sourceUnitId: 'meter', targetUnitId: 'centimeter' },
    { value: 1, sourceUnitId: 'meter; use evil' as UnitId, targetUnitId: 'centimeter' as const },
    { value: 1, sourceUnitId: 'meter' as const, targetUnitId: 'unknown' as UnitId },
  ])('rejects nonfinite, oversized, unknown, or injection-like unit input before IPC', async (request) => {
    const invoke = vi.fn<MathUnitsInvoke>();
    const port = new NativeMathUnitsPort(invoke, true);
    await expect(port.convertUnit(request as UnitConversionRequest))
      .rejects.toMatchObject({ code: 'invalid-input' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves dated, sourced, explicitly stale currency metadata', async () => {
    const response: CurrencyConversionResult = {
      value: 113.46, currencyId: 'USD', source: 'SNB verified snapshot',
      asOf: '2026-08-01', status: 'stale', snapshotVersion: 1,
    };
    const invoke = vi.fn<MathUnitsInvoke>(async () => response);
    const port = new NativeMathUnitsPort(invoke, true);
    await expect(port.convertCurrency({
      value: 100, sourceCurrencyId: 'EUR', targetCurrencyId: 'USD',
    })).resolves.toEqual(response);
  });

  it.each([
    { value: 1, currencyId: 'USD', source: '', asOf: '2026-08-01', status: 'current', snapshotVersion: 1 },
    { value: 1, currencyId: 'USD', source: 'trusted', asOf: '2026-02-30', status: 'current', snapshotVersion: 1 },
    { value: 1, currencyId: 'USD', source: 'trusted', asOf: '2026-08-01', status: 'live', snapshotVersion: 1 },
  ])('rejects currency results lacking trustworthy metadata', async (response) => {
    const port = new NativeMathUnitsPort(async () => response, true);
    await expect(port.convertCurrency({
      value: 1, sourceCurrencyId: 'CHF', targetCurrencyId: 'USD',
    })).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('uses opaque native errors without echoing values or formulas', async () => {
    const port = new NativeMathUnitsPort(async () => {
      throw { code: 'dimension-mismatch', message: 'secret 123 meter -> second' };
    }, true);
    const error = await port.convertUnit({
      value: 123, sourceUnitId: 'meter', targetUnitId: 'second',
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MathUnitsError);
    expect(error).toMatchObject({ code: 'dimension-mismatch' });
    expect(String(error)).not.toContain('123');
    expect(String(error)).not.toContain('meter');
  });

  it('is explicitly unavailable in the browser and never invokes native IPC', async () => {
    const browser = new UnavailableBrowserMathUnitsPort();
    expect(browser.availability).toBe('unavailable');
    await expect(browser.convertUnit({
      value: 1, sourceUnitId: 'meter', targetUnitId: 'centimeter',
    })).rejects.toMatchObject({ code: 'unit-engine-unavailable' });
    await expect(browser.convertCurrency({
      value: 1, sourceCurrencyId: 'CHF', targetCurrencyId: 'EUR',
    })).rejects.toMatchObject({ code: 'currency-unavailable' });
  });

  it('maps missing local currency snapshots to explicit offline unavailability', async () => {
    const port = new NativeMathUnitsPort(async () => {
      throw { code: 'currency-unavailable' };
    }, true);
    await expect(port.convertCurrency({
      value: 20, sourceCurrencyId: 'CHF', targetCurrencyId: 'EUR',
    })).rejects.toMatchObject({ code: 'currency-unavailable' });
  });
});
