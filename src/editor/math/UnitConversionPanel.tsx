import { useId, useRef, useState, type FormEvent } from 'react';
import type { CalculatorAngleMode, CalculatorNumberMode } from '../../math/history';
import {
  CURRENCY_IDS,
  MathUnitsError,
  UNIT_CONVERSION_LIMITS,
  UNIT_IDS,
  type CurrencyConversionResult,
  type CurrencyId,
  type MathUnitsPort,
  type UnitConversionResult,
  type UnitId,
} from '../../math/units';
import { isolateCanvasEvent } from './canvasIsolation';
import './mathCanvas.css';

export type MathUnitConversionPort = MathUnitsPort;
export type UnitConversionTab = 'unit' | 'currency';
export type ConversionPanelFailure =
  | 'invalid-input'
  | 'dimension-mismatch'
  | 'unavailable'
  | 'error';

export type UnitConversionExpression = Readonly<{
  kind: 'unit-conversion';
  value: number;
  sourceUnitId: UnitId;
  targetUnitId: UnitId;
}>;

export type CurrencyConversionExpression = Readonly<{
  kind: 'currency-conversion';
  value: number;
  sourceCurrencyId: CurrencyId;
  targetCurrencyId: CurrencyId;
}>;

export interface CurrencyInsertMetadata {
  source: string;
  asOf: string;
  status: CurrencyConversionResult['status'];
  snapshotVersion: 1;
}

export interface UnitConversionInsertPayload {
  expression: UnitConversionExpression | CurrencyConversionExpression;
  visibleResult: string;
  numberMode: CalculatorNumberMode;
  angleMode: CalculatorAngleMode;
  currencyMetadata?: CurrencyInsertMetadata;
}

export interface UnitConversionPanelLabels {
  panel: string;
  unitTab: string;
  currencyTab: string;
  value: string;
  sourceUnit: string;
  targetUnit: string;
  sourceCurrency: string;
  targetCurrency: string;
  convert: string;
  converting: string;
  insert: string;
  result: string;
  unavailable: string;
  invalidInput: string;
  dimensionMismatch: string;
  error: string;
  rateSource: string;
  rateAsOf: string;
  rateStatus: string;
  current: string;
  stale: string;
  unitName: (unitId: UnitId) => string;
  currencyName: (currencyId: CurrencyId) => string;
  formatNumber: (value: number) => string;
}

export interface UnitConversionPanelProps {
  port: MathUnitConversionPort;
  labels: UnitConversionPanelLabels;
  numberMode: CalculatorNumberMode;
  angleMode: CalculatorAngleMode;
  viewer?: boolean;
  initialTab?: UnitConversionTab;
  onInsert: (payload: UnitConversionInsertPayload) => void;
}

interface UnitPanelResult {
  kind: 'unit';
  inputValue: number;
  sourceUnitId: UnitId;
  targetUnitId: UnitId;
  result: UnitConversionResult;
  visibleResult: string;
}

interface CurrencyPanelResult {
  kind: 'currency';
  inputValue: number;
  sourceCurrencyId: CurrencyId;
  targetCurrencyId: CurrencyId;
  result: CurrencyConversionResult;
  visibleResult: string;
}

type PanelResult = UnitPanelResult | CurrencyPanelResult;

const MAX_INPUT_CHARACTERS = 64;
const DECIMAL_INPUT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const UNIT_ID_SET: ReadonlySet<string> = new Set(UNIT_IDS);
const CURRENCY_ID_SET: ReadonlySet<string> = new Set(CURRENCY_IDS);

function isUnitId(value: string): value is UnitId {
  return UNIT_ID_SET.has(value);
}

function isCurrencyId(value: string): value is CurrencyId {
  return CURRENCY_ID_SET.has(value);
}

export function parseConversionValue(input: string): number | null {
  const normalized = input.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_INPUT_CHARACTERS
    || !DECIMAL_INPUT.test(normalized)
  ) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && Math.abs(value) <= UNIT_CONVERSION_LIMITS.maxAbsoluteInput
    ? value
    : null;
}

export function classifyConversionError(error: unknown): ConversionPanelFailure {
  if (!(error instanceof MathUnitsError)) return 'error';
  if (error.code === 'invalid-input') return 'invalid-input';
  if (error.code === 'dimension-mismatch') return 'dimension-mismatch';
  if (
    error.code === 'unit-engine-unavailable'
    || error.code === 'unit-engine-busy'
    || error.code === 'unit-engine-timeout'
    || error.code === 'currency-unavailable'
  ) return 'unavailable';
  return 'error';
}

export async function convertUnitSelection(
  port: MathUnitConversionPort,
  input: string,
  sourceUnitId: UnitId,
  targetUnitId: UnitId,
): Promise<{ inputValue: number; result: UnitConversionResult }> {
  const inputValue = parseConversionValue(input);
  if (inputValue === null) throw new MathUnitsError('invalid-input');
  return {
    inputValue,
    result: await port.convertUnit({ value: inputValue, sourceUnitId, targetUnitId }),
  };
}

export async function convertCurrencySelection(
  port: MathUnitConversionPort,
  input: string,
  sourceCurrencyId: CurrencyId,
  targetCurrencyId: CurrencyId,
): Promise<{ inputValue: number; result: CurrencyConversionResult }> {
  const inputValue = parseConversionValue(input);
  if (inputValue === null) throw new MathUnitsError('invalid-input');
  return {
    inputValue,
    result: await port.convertCurrency({ value: inputValue, sourceCurrencyId, targetCurrencyId }),
  };
}

export function createConversionInsertPayload(
  panelResult: PanelResult,
  numberMode: CalculatorNumberMode,
  angleMode: CalculatorAngleMode,
): UnitConversionInsertPayload {
  if (panelResult.kind === 'unit') {
    return {
      expression: {
        kind: 'unit-conversion',
        value: panelResult.inputValue,
        sourceUnitId: panelResult.sourceUnitId,
        targetUnitId: panelResult.targetUnitId,
      },
      visibleResult: panelResult.visibleResult,
      numberMode,
      angleMode,
    };
  }
  return {
    expression: {
      kind: 'currency-conversion',
      value: panelResult.inputValue,
      sourceCurrencyId: panelResult.sourceCurrencyId,
      targetCurrencyId: panelResult.targetCurrencyId,
    },
    visibleResult: panelResult.visibleResult,
    numberMode,
    angleMode,
    currencyMetadata: {
      source: panelResult.result.source,
      asOf: panelResult.result.asOf,
      status: panelResult.result.status,
      snapshotVersion: panelResult.result.snapshotVersion,
    },
  };
}

function failureLabel(failure: ConversionPanelFailure, labels: UnitConversionPanelLabels): string {
  if (failure === 'invalid-input') return labels.invalidInput;
  if (failure === 'dimension-mismatch') return labels.dimensionMismatch;
  if (failure === 'unavailable') return labels.unavailable;
  return labels.error;
}

export function CurrencyConversionMetadata({
  result,
  labels,
}: {
  result: CurrencyConversionResult;
  labels: UnitConversionPanelLabels;
}) {
  return (
    <dl data-status={result.status}>
      <div><dt>{labels.rateSource}</dt><dd>{result.source}</dd></div>
      <div><dt>{labels.rateAsOf}</dt><dd>{result.asOf}</dd></div>
      <div>
        <dt>{labels.rateStatus}</dt>
        <dd>{result.status === 'stale' ? labels.stale : labels.current}</dd>
      </div>
    </dl>
  );
}

export function UnitConversionPanel({
  port,
  labels,
  numberMode,
  angleMode,
  viewer = false,
  initialTab = 'unit',
  onInsert,
}: UnitConversionPanelProps) {
  const baseId = useId();
  const [tab, setTab] = useState<UnitConversionTab>(initialTab);
  const [input, setInput] = useState('1');
  const [sourceUnitId, setSourceUnitId] = useState<UnitId>('meter');
  const [targetUnitId, setTargetUnitId] = useState<UnitId>('centimeter');
  const [sourceCurrencyId, setSourceCurrencyId] = useState<CurrencyId>('CHF');
  const [targetCurrencyId, setTargetCurrencyId] = useState<CurrencyId>('EUR');
  const [result, setResult] = useState<PanelResult | null>(null);
  const [failure, setFailure] = useState<ConversionPanelFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  const unavailable = port.availability === 'unavailable';

  const clearOutcome = () => {
    operation.current += 1;
    setResult(null);
    setFailure(null);
    setBusy(false);
  };

  const selectTab = (next: UnitConversionTab) => {
    if (next === tab) return;
    clearOutcome();
    setTab(next);
  };

  const convert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (viewer || unavailable || busy) return;
    const currentOperation = operation.current + 1;
    operation.current = currentOperation;
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      if (tab === 'unit') {
        const converted = await convertUnitSelection(port, input, sourceUnitId, targetUnitId);
        if (operation.current !== currentOperation) return;
        setResult({
          kind: 'unit',
          ...converted,
          sourceUnitId,
          targetUnitId,
          visibleResult: `${labels.formatNumber(converted.result.value)} ${labels.unitName(converted.result.unitId)}`,
        });
      } else {
        const converted = await convertCurrencySelection(
          port,
          input,
          sourceCurrencyId,
          targetCurrencyId,
        );
        if (operation.current !== currentOperation) return;
        setResult({
          kind: 'currency',
          ...converted,
          sourceCurrencyId,
          targetCurrencyId,
          visibleResult: `${labels.formatNumber(converted.result.value)} ${labels.currencyName(converted.result.currencyId)}`,
        });
      }
    } catch (error) {
      if (operation.current === currentOperation) setFailure(classifyConversionError(error));
    } finally {
      if (operation.current === currentOperation) setBusy(false);
    }
  };

  const tabId = (value: UnitConversionTab) => `${baseId}-${value}-tab`;
  const panelId = (value: UnitConversionTab) => `${baseId}-${value}-panel`;

  return (
    <aside
      className="unit-conversion-panel"
      aria-label={labels.panel}
      data-tab={tab}
      onPointerDown={isolateCanvasEvent}
      onPointerMove={isolateCanvasEvent}
      onPointerUp={isolateCanvasEvent}
      onPointerCancel={isolateCanvasEvent}
      onClick={isolateCanvasEvent}
      onKeyDown={isolateCanvasEvent}
      onWheel={isolateCanvasEvent}
    >
      <div className="unit-conversion-panel__tabs" role="tablist" aria-label={labels.panel}>
        {(['unit', 'currency'] as const).map((value) => (
          <button
            id={tabId(value)}
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={panelId(value)}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => selectTab(value)}
          >
            {value === 'unit' ? labels.unitTab : labels.currencyTab}
          </button>
        ))}
      </div>

      <form
        id={panelId(tab)}
        role="tabpanel"
        aria-labelledby={tabId(tab)}
        onSubmit={(event) => { void convert(event); }}
      >
        <label>
          {labels.value}
          <input
            type="text"
            inputMode="decimal"
            value={input}
            maxLength={MAX_INPUT_CHARACTERS}
            disabled={viewer}
            aria-invalid={failure === 'invalid-input'}
            onChange={(event) => { clearOutcome(); setInput(event.target.value); }}
          />
        </label>

        {tab === 'unit' ? (
          <>
            <label>
              {labels.sourceUnit}
              <select
                value={sourceUnitId}
                disabled={viewer}
                onChange={(event) => {
                  if (!isUnitId(event.target.value)) return;
                  clearOutcome();
                  setSourceUnitId(event.target.value);
                }}
              >
                {UNIT_IDS.map((unitId) => (
                  <option key={unitId} value={unitId}>{labels.unitName(unitId)}</option>
                ))}
              </select>
            </label>
            <label>
              {labels.targetUnit}
              <select
                value={targetUnitId}
                disabled={viewer}
                onChange={(event) => {
                  if (!isUnitId(event.target.value)) return;
                  clearOutcome();
                  setTargetUnitId(event.target.value);
                }}
              >
                {UNIT_IDS.map((unitId) => (
                  <option key={unitId} value={unitId}>{labels.unitName(unitId)}</option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              {labels.sourceCurrency}
              <select
                value={sourceCurrencyId}
                disabled={viewer}
                onChange={(event) => {
                  if (!isCurrencyId(event.target.value)) return;
                  clearOutcome();
                  setSourceCurrencyId(event.target.value);
                }}
              >
                {CURRENCY_IDS.map((currencyId) => (
                  <option key={currencyId} value={currencyId}>{labels.currencyName(currencyId)}</option>
                ))}
              </select>
            </label>
            <label>
              {labels.targetCurrency}
              <select
                value={targetCurrencyId}
                disabled={viewer}
                onChange={(event) => {
                  if (!isCurrencyId(event.target.value)) return;
                  clearOutcome();
                  setTargetCurrencyId(event.target.value);
                }}
              >
                {CURRENCY_IDS.map((currencyId) => (
                  <option key={currencyId} value={currencyId}>{labels.currencyName(currencyId)}</option>
                ))}
              </select>
            </label>
          </>
        )}

        <button type="submit" disabled={viewer || unavailable || busy}>
          {busy ? labels.converting : labels.convert}
        </button>
      </form>

      {unavailable ? <p className="unit-conversion-panel__status" role="status">{labels.unavailable}</p> : null}
      {failure ? (
        <p className="unit-conversion-panel__status unit-conversion-panel__status--error" role="alert">
          {failureLabel(failure, labels)}
        </p>
      ) : null}
      {result ? (
        <section
          className="unit-conversion-panel__result"
          aria-label={labels.result}
          data-status={result.kind === 'currency' ? result.result.status : 'current'}
        >
          <output aria-live="polite">{result.visibleResult}</output>
          {result.kind === 'currency' ? (
            <CurrencyConversionMetadata result={result.result} labels={labels} />
          ) : null}
          <button
            type="button"
            disabled={viewer}
            onClick={() => onInsert(createConversionInsertPayload(result, numberMode, angleMode))}
          >
            {labels.insert}
          </button>
        </section>
      ) : null}
    </aside>
  );
}

export default UnitConversionPanel;
