import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CURRENCY_IDS,
  MathUnitsError,
  UNIT_CONVERSION_LIMITS,
  UNIT_IDS,
  type CurrencyConversionResult,
  type MathUnitsPort,
  type UnitConversionResult,
} from '../../math/units';
import {
  classifyConversionError,
  convertCurrencySelection,
  convertUnitSelection,
  createConversionInsertPayload,
  CurrencyConversionMetadata,
  parseConversionValue,
  UnitConversionPanel,
  type UnitConversionPanelLabels,
  type UnitConversionInsertPayload,
} from './UnitConversionPanel';

const labels: UnitConversionPanelLabels = {
  panel: 'Umrechnungen',
  unitTab: 'Einheiten',
  currencyTab: 'Währungen',
  value: 'Wert',
  sourceUnit: 'Von Einheit',
  targetUnit: 'Nach Einheit',
  sourceCurrency: 'Von Währung',
  targetCurrency: 'Nach Währung',
  convert: 'Umrechnen',
  converting: 'Wird umgerechnet',
  insert: 'Einfügen',
  result: 'Ergebnis',
  unavailable: 'In diesem Browser nicht verfügbar',
  invalidInput: 'Ungültiger Wert',
  dimensionMismatch: 'Dimensionen passen nicht zusammen',
  error: 'Umrechnung fehlgeschlagen',
  rateSource: 'Kursquelle',
  rateAsOf: 'Kursdatum',
  rateStatus: 'Kursstatus',
  current: 'Aktuell',
  stale: 'Veraltet',
  unitName: (unitId) => unitId,
  currencyName: (currencyId) => currencyId,
  formatNumber: (value) => String(value),
};

function port(overrides: Partial<MathUnitsPort> = {}): MathUnitsPort {
  return {
    availability: 'available',
    convertUnit: async ({ targetUnitId }): Promise<UnitConversionResult> => ({
      value: 100,
      unitId: targetUnitId,
      engine: 'numbat-1.23.0',
      durationMillis: 1,
    }),
    convertCurrency: async ({ targetCurrencyId }): Promise<CurrencyConversionResult> => ({
      value: 1.1,
      currencyId: targetCurrencyId,
      source: 'European Central Bank reference snapshot',
      asOf: '2026-08-01',
      status: 'current',
      snapshotVersion: 1,
    }),
    ...overrides,
  };
}

describe('conversion value limits', () => {
  it('accepts only finite bounded decimal input', () => {
    expect(parseConversionValue(' -1.25e3 ')).toBe(-1250);
    expect(parseConversionValue(String(UNIT_CONVERSION_LIMITS.maxAbsoluteInput))).toBe(
      UNIT_CONVERSION_LIMITS.maxAbsoluteInput,
    );
    for (const input of [
      '',
      'Infinity',
      'NaN',
      '0x10',
      String(UNIT_CONVERSION_LIMITS.maxAbsoluteInput * 10),
      '1'.repeat(65),
    ]) expect(parseConversionValue(input)).toBeNull();
  });
});

describe('explicit conversion commands', () => {
  it('maps a dimension mismatch without exposing provider details', async () => {
    const conversionPort = port({
      convertUnit: async () => { throw new MathUnitsError('dimension-mismatch'); },
    });
    const error = await convertUnitSelection(conversionPort, '1', 'meter', 'second')
      .then(() => null, (reason: unknown) => reason);
    expect(classifyConversionError(error)).toBe('dimension-mismatch');
    expect(error).toEqual(new MathUnitsError('dimension-mismatch'));
  });

  it('calls only the explicitly selected port operation', async () => {
    const convertUnit = vi.fn(port().convertUnit);
    const convertCurrency = vi.fn(port().convertCurrency);
    const conversionPort = port({ convertUnit, convertCurrency });
    await convertUnitSelection(conversionPort, '2.5', 'meter', 'centimeter');
    expect(convertUnit).toHaveBeenCalledOnce();
    expect(convertUnit).toHaveBeenCalledWith({
      value: 2.5,
      sourceUnitId: 'meter',
      targetUnitId: 'centimeter',
    });
    expect(convertCurrency).not.toHaveBeenCalled();

    await convertCurrencySelection(conversionPort, '4', 'CHF', 'EUR');
    expect(convertCurrency).toHaveBeenCalledOnce();
  });

  it('classifies browser and engine unavailability clearly', () => {
    expect(classifyConversionError(new MathUnitsError('unit-engine-unavailable'))).toBe('unavailable');
    expect(classifyConversionError(new MathUnitsError('currency-unavailable'))).toBe('unavailable');
    expect(classifyConversionError(new Error('endpoint and token must remain opaque'))).toBe('error');
  });
});

describe('insert payload', () => {
  it('renders stale currency source, date and status as text', () => {
    const markup = renderToStaticMarkup(createElement(CurrencyConversionMetadata, {
      labels,
      result: {
        value: 105,
        currencyId: 'EUR',
        source: '<img src=x onerror=alert(1)>',
        asOf: '2026-07-31',
        status: 'stale',
        snapshotVersion: 1,
      },
    }));
    expect(markup).toContain('data-status="stale"');
    expect(markup).toContain(labels.rateSource);
    expect(markup).toContain('2026-07-31');
    expect(markup).toContain(labels.stale);
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img');
  });

  it('preserves stale currency provenance without inventing a live rate', () => {
    const payload = createConversionInsertPayload({
      kind: 'currency',
      inputValue: 100,
      sourceCurrencyId: 'CHF',
      targetCurrencyId: 'EUR',
      visibleResult: '105 EUR',
      result: {
        value: 105,
        currencyId: 'EUR',
        source: 'ECB reference snapshot',
        asOf: '2026-07-31',
        status: 'stale',
        snapshotVersion: 1,
      },
    }, 'decimal', 'degrees');

    expect(payload).toEqual({
      expression: {
        kind: 'currency-conversion',
        value: 100,
        sourceCurrencyId: 'CHF',
        targetCurrencyId: 'EUR',
      },
      visibleResult: '105 EUR',
      numberMode: 'decimal',
      angleMode: 'degrees',
      currencyMetadata: {
        source: 'ECB reference snapshot',
        asOf: '2026-07-31',
        status: 'stale',
        snapshotVersion: 1,
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/endpoint|token|numbat/i);
  });

  it('hands the typed unit payload to the parent insert callback', () => {
    const onInsert = vi.fn<(payload: UnitConversionInsertPayload) => void>();
    const payload = createConversionInsertPayload({
      kind: 'unit',
      inputValue: 1,
      sourceUnitId: 'meter',
      targetUnitId: 'centimeter',
      visibleResult: '100 centimeter',
      result: {
        value: 100,
        unitId: 'centimeter',
        engine: 'numbat-1.23.0',
        durationMillis: 1,
      },
    }, 'exact', 'radians');
    onInsert(payload);
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({
      expression: {
        kind: 'unit-conversion',
        value: 1,
        sourceUnitId: 'meter',
        targetUnitId: 'centimeter',
      },
      visibleResult: '100 centimeter',
      numberMode: 'exact',
      angleMode: 'radians',
    }));
  });
});

describe('UnitConversionPanel', () => {
  it('renders all closed unit IDs and never converts during render', () => {
    const convertUnit = vi.fn(port().convertUnit);
    const convertCurrency = vi.fn(port().convertCurrency);
    const markup = renderToStaticMarkup(createElement(UnitConversionPanel, {
      port: port({ convertUnit, convertCurrency }),
      labels,
      numberMode: 'exact',
      angleMode: 'radians',
      onInsert: () => undefined,
    }));

    expect(convertUnit).not.toHaveBeenCalled();
    expect(convertCurrency).not.toHaveBeenCalled();
    expect(markup.match(/<option/g)).toHaveLength(UNIT_IDS.length * 2);
    for (const unitId of UNIT_IDS) expect(markup).toContain(`value="${unitId}"`);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('maxLength="64"');
  });

  it('renders closed currency IDs without claiming a live result', () => {
    const markup = renderToStaticMarkup(createElement(UnitConversionPanel, {
      port: port(),
      labels,
      numberMode: 'decimal',
      angleMode: 'degrees',
      initialTab: 'currency',
      onInsert: () => undefined,
    }));
    expect(markup.match(/<option/g)).toHaveLength(CURRENCY_IDS.length * 2);
    for (const currencyId of CURRENCY_IDS) expect(markup).toContain(`value="${currencyId}"`);
    expect(markup).not.toContain(labels.current);
    expect(markup).not.toContain(labels.stale);
    expect(markup).not.toContain(labels.rateSource);
  });

  it('shows unavailable state and disables conversion in viewer/browser mode', () => {
    const markup = renderToStaticMarkup(createElement(UnitConversionPanel, {
      port: port({ availability: 'unavailable' }),
      labels,
      numberMode: 'exact',
      angleMode: 'radians',
      viewer: true,
      onInsert: () => undefined,
    }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain(labels.unavailable);
    expect(markup).toContain('disabled=""');
  });

  it('escapes localized option labels as text', () => {
    const markup = renderToStaticMarkup(createElement(UnitConversionPanel, {
      port: port(),
      labels: { ...labels, unitName: () => '<img src=x onerror=alert(1)>' },
      numberMode: 'exact',
      angleMode: 'radians',
      onInsert: () => undefined,
    }));
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img');
  });
});
