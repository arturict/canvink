import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalculatorPalette, DEFAULT_CALCULATOR_COMMANDS } from './CalculatorPalette';

describe('CalculatorPalette', () => {
  it('offers basic, scientific and conversion insertions with viewer semantics', () => {
    expect(new Set(DEFAULT_CALCULATOR_COMMANDS.map((command) => command.category))).toEqual(
      new Set(['basic', 'scientific', 'conversion']),
    );
    const markup = renderToStaticMarkup(createElement(CalculatorPalette, {
      labels: {
        palette: 'Rechnerpalette', basic: 'Basis', scientific: 'Wissenschaftlich', conversion: 'Umrechnen',
        result: 'Ergebnis', insertResult: 'Ergebnis einfügen',
      },
      result: { insertText: '\\frac{1}{3}', label: '⅓' },
      viewer: true,
      onInsert: () => undefined,
      onInsertResult: () => undefined,
    }));
    expect(markup).toContain('aria-label="Rechnerpalette"');
    expect(markup).toContain('Wissenschaftlich');
    expect(markup).toContain('Umrechnen');
    expect(markup).toContain('Ergebnis');
    expect(markup).toContain('Ergebnis einfügen');
    expect(markup).toContain('⅓');
    expect(markup).toContain('disabled=""');
  });

  it('does not offer a result action without both a current result and handler', () => {
    const markup = renderToStaticMarkup(createElement(CalculatorPalette, {
      labels: {
        palette: 'Calculator palette', basic: 'Basic', scientific: 'Scientific', conversion: 'Convert',
        result: 'Current result',
      },
      result: { insertText: '4' },
      onInsert: () => undefined,
    }));

    expect(markup).not.toContain('Current result');
  });
});
