import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  applyMathFieldValue,
  MathBlock,
  type MathBlockLabels,
  type MathFieldDomElement,
} from './MathBlock';

const labels: MathBlockLabels = {
  idle: 'Bereit',
  typed: 'Getippt',
  ink: 'Handschrift',
  pending: 'Ausstehend',
  recognized: 'Erkannt',
  ambiguous: 'Mehrdeutig',
  error: 'Fehler',
  undefinedVariable: 'Variable nicht definiert',
  dependencyCycle: 'Zyklische Abhängigkeit',
  openCorrection: 'Korrektur öffnen',
  correction: 'Formel korrigieren',
  resultMode: 'Ergebnis',
  suggest: 'Vorschlagen',
  insert: 'Einfügen',
  off: 'Aus',
  numberMode: 'Darstellung',
  exact: 'Exakt',
  decimal: 'Dezimal',
  result: 'Resultat',
  acceptSuggestion: 'Übernehmen',
  autoRecognition: 'Automatische Erkennung',
  autoRecognitionInherit: 'Seitenstandard',
  autoRecognitionEnabled: 'Ein',
  autoRecognitionDisabled: 'Aus',
  recognizeNow: 'Jetzt erkennen',
};

describe('MathBlock', () => {
  it('uses the MathLive value and readOnly DOM API', () => {
    const field = { value: 'old', readOnly: true } as MathFieldDomElement;
    applyMathFieldValue(field, '\\frac{1}{3}', false);
    expect(field.value).toBe('\\frac{1}{3}');
    expect(field.readOnly).toBe(false);
  });

  it('renders accessible ambiguity choices without interpreting candidate markup', () => {
    const markup = renderToStaticMarkup(createElement(MathBlock, {
      latex: 'x^2',
      inputKind: 'ink',
      status: 'ambiguous',
      resultMode: 'suggest',
      numberMode: 'exact',
      autoRecognition: 'inherit',
      exactResult: '1/3',
      decimalResult: '0.333',
      candidates: ['<img src=x onerror=alert(1)>'],
      labels,
      onCorrection: () => undefined,
      onResultModeChange: () => undefined,
      onNumberModeChange: () => undefined,
      onAutoRecognitionChange: () => undefined,
      onRecognizeNow: () => undefined,
    }));

    expect(markup).toContain('data-status="ambiguous"');
    expect(markup).toContain('data-dependency-state="valid"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Korrektur öffnen: Mehrdeutig');
    expect(markup).toContain('aria-controls=');
    expect(markup).toContain('data-correction-open="false"');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('aria-label="Resultat"');
    expect(markup).toContain('data-result-mode="suggest"');
    expect(markup).toContain('Übernehmen');
    expect(markup).toContain('Jetzt erkennen');
    expect(markup).toContain('1/3');
    expect(markup).toContain('class="math-block__result-field"');
    expect(markup).toContain('data-latex="1/3"');
  });

  it.each([
    ['undefined', 'Variable nicht definiert'],
    ['cycle', 'Zyklische Abhängigkeit'],
  ] as const)('distinguishes the %s dependency state visibly', (dependencyState, label) => {
    const markup = renderToStaticMarkup(createElement(MathBlock, {
      latex: 'y=x+1',
      inputKind: 'typed',
      status: 'recognized',
      dependencyState,
      diagnostics: [`diagnostic for ${dependencyState}`],
      resultMode: 'suggest',
      numberMode: 'exact',
      autoRecognition: 'inherit',
      labels,
      onCorrection: () => undefined,
      onResultModeChange: () => undefined,
      onNumberModeChange: () => undefined,
      onAutoRecognitionChange: () => undefined,
    }));

    expect(markup).toContain(`data-dependency-state="${dependencyState}"`);
    expect(markup).toContain('data-status="error"');
    expect(markup).toContain('data-recognition-status="recognized"');
    expect(markup).toContain(`>${label}</button>`);
    expect(markup).toContain(`Korrektur öffnen: ${label}`);
    expect(markup).not.toContain(`diagnostic for ${dependencyState}`);
  });

  it('honors off mode and viewer semantics', () => {
    const markup = renderToStaticMarkup(createElement(MathBlock, {
      latex: '2+2',
      inputKind: 'typed',
      status: 'recognized',
      resultMode: 'off',
      numberMode: 'decimal',
      autoRecognition: 'inherit',
      decimalResult: '4',
      editable: false,
      labels,
      onCorrection: () => undefined,
      onResultModeChange: () => undefined,
      onNumberModeChange: () => undefined,
      onAutoRecognitionChange: () => undefined,
    }));
    expect(markup).toContain('data-read-only="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('<output');
  });
});
