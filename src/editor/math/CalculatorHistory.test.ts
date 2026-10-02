import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalculatorHistory } from '../../math/history';
import { CalculatorHistoryView, type CalculatorHistoryLabels } from './CalculatorHistory';

const labels: CalculatorHistoryLabels = {
  title: 'Rechenverlauf',
  empty: 'Noch keine Rechnungen',
  loading: 'Wird geladen',
  copy: 'Kopieren',
  restore: 'Wiederherstellen',
  delete: 'Löschen',
  clear: 'Alles löschen',
  exact: 'Exakt',
  decimal: 'Dezimal',
  degrees: 'Grad',
  radians: 'Bogenmass',
  copied: 'Kopiert',
  restored: 'Wiederhergestellt',
  deleted: 'Gelöscht',
  cleared: 'Verlauf gelöscht',
  error: 'Verlauf nicht verfügbar',
};

describe('CalculatorHistoryView', () => {
  it('renders an injected, accessible history without interpreting expression markup', () => {
    const markup = renderToStaticMarkup(createElement(CalculatorHistoryView, {
      history: new CalculatorHistory({ scopeId: 'notebook:test' }),
      labels,
      onCopy: () => undefined,
      onRestore: () => undefined,
      initialEntries: [{
        id: 'entry',
        expression: '<script>alert(1)</script>',
        visibleResult: '<img src=x onerror=alert(1)>',
        numberMode: 'exact',
        angleMode: 'degrees',
        createdAt: '2026-08-03T10:00:00.000Z',
      }],
    }));

    expect(markup).toContain('aria-labelledby=');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('dateTime="2026-08-03T10:00:00.000Z"');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('Kopieren');
    expect(markup).toContain('Wiederherstellen');
    expect(markup).toContain('Alles löschen');
  });
});
