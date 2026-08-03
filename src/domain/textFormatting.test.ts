import { describe, expect, it } from 'vitest';
import type { TextElement } from './types';
import { formattedText, markdownText } from './textFormatting';

function element(text: string, listStyle?: TextElement['listStyle']): TextElement {
  return {
    id: 'text-1',
    kind: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    text,
    listStyle,
    color: '#000000',
    fontSize: 16,
    fontFamily: 'sans-serif',
    fontWeight: 400,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('formatted text', () => {
  it('adds bullet and numbered prefixes without filling blank lines', () => {
    expect(formattedText(element('Alpha\n\nBeta', 'bullet'))).toBe(
      '• Alpha\n\n• Beta',
    );
    expect(formattedText(element('Alpha\n\nBeta', 'numbered'))).toBe(
      '1. Alpha\n\n2. Beta',
    );
  });

  it('uses Markdown list markers for portable text export', () => {
    expect(markdownText(element('Alpha\n\nBeta', 'bullet'))).toBe(
      '- Alpha\n\n- Beta',
    );
    expect(markdownText(element('Alpha\n\nBeta', 'numbered'))).toBe(
      '1. Alpha\n\n2. Beta',
    );
  });

  it('keeps plain text byte-for-byte unchanged', () => {
    expect(formattedText(element('  Alpha\nBeta  ', 'none'))).toBe(
      '  Alpha\nBeta  ',
    );
  });
});
