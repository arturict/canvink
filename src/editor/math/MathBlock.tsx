import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { isolateCanvasEvent } from './canvasIsolation';
import './mathCanvas.css';

export type MathBlockInputKind = 'typed' | 'ink';
export type MathBlockStatus = 'idle' | 'pending' | 'recognized' | 'ambiguous' | 'error';
export type MathResultMode = 'suggest' | 'insert' | 'off';
export type MathNumberMode = 'exact' | 'decimal';
export type MathAutoRecognitionMode = 'inherit' | 'enabled' | 'disabled';
export type MathDependencyState = 'valid' | 'undefined' | 'cycle';

export interface MathCorrection {
  latex: string;
  source: 'manual' | 'candidate';
  candidateIndex?: number;
}

export interface MathBlockLabels {
  idle: string;
  typed: string;
  ink: string;
  pending: string;
  recognized: string;
  ambiguous: string;
  error: string;
  undefinedVariable?: string;
  dependencyCycle?: string;
  openCorrection?: string;
  correction: string;
  resultMode: string;
  suggest: string;
  insert: string;
  off: string;
  numberMode: string;
  exact: string;
  decimal: string;
  result: string;
  acceptSuggestion: string;
  autoRecognition: string;
  autoRecognitionInherit: string;
  autoRecognitionEnabled: string;
  autoRecognitionDisabled: string;
  recognizeNow: string;
}

export interface MathFieldDomElement extends HTMLElement {
  value: string;
  readOnly: boolean;
}

export interface MathBlockProps {
  latex: string;
  inputKind: MathBlockInputKind;
  status: MathBlockStatus;
  resultMode: MathResultMode;
  numberMode: MathNumberMode;
  autoRecognition: MathAutoRecognitionMode;
  exactResult?: string;
  decimalResult?: string;
  candidates?: readonly string[];
  dependencyState?: MathDependencyState;
  diagnostics?: readonly string[];
  inkPreview?: ReactNode;
  editable?: boolean;
  labels: MathBlockLabels;
  onTypedInput?: (latex: string) => void;
  onCorrection: (correction: MathCorrection) => void;
  onResultModeChange: (mode: MathResultMode) => void;
  onNumberModeChange: (mode: MathNumberMode) => void;
  onAutoRecognitionChange: (mode: MathAutoRecognitionMode) => void;
  onRecognizeNow?: () => void;
  onAcceptSuggestion?: () => void;
}

export function applyMathFieldValue(
  field: MathFieldDomElement,
  latex: string,
  readOnly: boolean,
): void {
  if (field.value !== latex) field.value = latex;
  field.readOnly = readOnly;
}

export function MathBlock({
  latex,
  inputKind,
  status,
  resultMode,
  numberMode,
  autoRecognition,
  exactResult,
  decimalResult,
  candidates = [],
  dependencyState = 'valid',
  diagnostics = [],
  inkPreview,
  editable = true,
  labels,
  onTypedInput,
  onCorrection,
  onResultModeChange,
  onNumberModeChange,
  onAutoRecognitionChange,
  onRecognizeNow,
  onAcceptSuggestion,
}: MathBlockProps) {
  const fieldRef = useRef<MathFieldDomElement | null>(null);
  const fieldId = useId();
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const result = numberMode === 'exact' ? exactResult : decimalResult;
  const dependencyProblem = dependencyState === 'undefined' || dependencyState === 'cycle';
  const visibleStatus: MathBlockStatus = dependencyProblem ? 'error' : status;
  const statusLabel = dependencyState === 'undefined'
    ? (labels.undefinedVariable ?? diagnostics[0] ?? 'Undefined variable')
    : dependencyState === 'cycle'
      ? (labels.dependencyCycle ?? diagnostics[0] ?? 'Dependency cycle')
      : labels[status];
  const correctionActionAvailable = editable
    && (visibleStatus === 'error' || visibleStatus === 'ambiguous');

  useEffect(() => {
    if (fieldRef.current) applyMathFieldValue(fieldRef.current, latex, !editable);
  }, [editable, latex]);

  return (
    <article
      className="math-block"
      data-input-kind={inputKind}
      data-status={visibleStatus}
      data-recognition-status={status}
      data-dependency-state={dependencyState}
      onPointerDown={isolateCanvasEvent}
      onPointerMove={isolateCanvasEvent}
      onPointerUp={isolateCanvasEvent}
      onPointerCancel={isolateCanvasEvent}
      onKeyDown={isolateCanvasEvent}
      onWheel={isolateCanvasEvent}
    >
      <header>
        <span>{inputKind === 'typed' ? labels.typed : labels.ink}</span>
        <span
          className={`math-block__status math-block__status--${visibleStatus}`}
          role={visibleStatus === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {correctionActionAvailable ? (
            <button
              type="button"
              className="math-block__status-action"
              aria-controls={fieldId}
              aria-label={`${labels.openCorrection ?? labels.correction}: ${statusLabel}`}
              onClick={() => {
                setCorrectionOpen(true);
                fieldRef.current?.focus();
              }}
            >
              {statusLabel}
            </button>
          ) : statusLabel}
        </span>
      </header>
      {inputKind === 'ink' && inkPreview ? (
        <div className="math-block__ink" aria-label={labels.ink}>{inkPreview}</div>
      ) : null}
      {inputKind === 'ink' ? (
        <button type="button" disabled={!editable} onClick={onRecognizeNow}>{labels.recognizeNow}</button>
      ) : null}
      <math-field
        id={fieldId}
        ref={(node) => { fieldRef.current = node as MathFieldDomElement | null; }}
        className="math-block__field"
        data-correction-open={correctionOpen ? 'true' : 'false'}
        data-latex={latex}
        data-read-only={!editable ? 'true' : 'false'}
        aria-label={labels.correction}
        onInput={(event) => {
          isolateCanvasEvent(event);
          const value = (event.currentTarget as MathFieldDomElement).value;
          if (inputKind === 'typed') onTypedInput?.(value);
          else onCorrection({ latex: value, source: 'manual' });
        }}
      />
      {status === 'ambiguous' && candidates.length > 0 ? (
        <ul className="math-block__candidates" aria-label={labels.ambiguous}>
          {candidates.map((candidate, index) => (
            <li key={`${index}:${candidate}`}>
              <button
                type="button"
                disabled={!editable}
                onClick={() => onCorrection({ latex: candidate, source: 'candidate', candidateIndex: index })}
              >
                <code>{candidate}</code>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="math-block__modes">
        <label>
          {labels.resultMode}
          <select
            value={resultMode}
            disabled={!editable}
            onChange={(event) => onResultModeChange(event.target.value as MathResultMode)}
          >
            <option value="suggest">{labels.suggest}</option>
            <option value="insert">{labels.insert}</option>
            <option value="off">{labels.off}</option>
          </select>
        </label>
        <label>
          {labels.numberMode}
          <select
            value={numberMode}
            disabled={!editable}
            onChange={(event) => onNumberModeChange(event.target.value as MathNumberMode)}
          >
            <option value="exact">{labels.exact}</option>
            <option value="decimal">{labels.decimal}</option>
          </select>
        </label>
        <label>
          {labels.autoRecognition}
          <select
            value={autoRecognition}
            disabled={!editable || inputKind === 'typed'}
            onChange={(event) => onAutoRecognitionChange(event.target.value as MathAutoRecognitionMode)}
          >
            <option value="inherit">{labels.autoRecognitionInherit}</option>
            <option value="enabled">{labels.autoRecognitionEnabled}</option>
            <option value="disabled">{labels.autoRecognitionDisabled}</option>
          </select>
        </label>
      </div>
      {resultMode !== 'off' && result ? (
        <div className={`math-block__result math-block__result--${resultMode}`} data-result-mode={resultMode}>
          <output aria-label={labels.result}>
            {numberMode === 'exact' ? <TypesetMathResult latex={result} /> : result}
          </output>
          {resultMode === 'suggest' ? (
            <button type="button" disabled={!editable} onClick={onAcceptSuggestion}>{labels.acceptSuggestion}</button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function TypesetMathResult({ latex }: { latex: string }) {
  const resultRef = useRef<MathFieldDomElement | null>(null);
  useEffect(() => {
    if (resultRef.current) applyMathFieldValue(resultRef.current, latex, true);
  }, [latex]);
  return (
    <>
      <math-field
        ref={(node) => { resultRef.current = node as MathFieldDomElement | null; }}
        className="math-block__result-field"
        data-latex={latex}
        data-read-only="true"
        aria-hidden="true"
      />
      <span className="sr-only">{latex}</span>
    </>
  );
}

export default MathBlock;
