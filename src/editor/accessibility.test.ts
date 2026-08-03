import { describe, expect, it } from 'vitest';
import type { ChecklistElement, ImageElement, TextElement } from '../domain/types';
import { accessibleElementSummary } from './accessibility';

function textElement(text: string): TextElement {
  return {
    id: 'text-1',
    kind: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    text,
    color: '#000000',
    fontSize: 16,
    fontFamily: 'sans-serif',
    fontWeight: 400,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('canvas accessibility summaries', () => {
  it('collapses whitespace and keeps short note summaries readable', () => {
    expect(accessibleElementSummary(textElement('  First\n\nuseful\tthought  '))).toBe(
      'Text: First useful thought',
    );
    expect(accessibleElementSummary(textElement(' \n\t '))).toBe('Empty text note');
  });

  it('bounds large note summaries without splitting Unicode characters', () => {
    const summary = accessibleElementSummary(
      textElement(`${'a'.repeat(159)}😀${'b'.repeat(2_000_000)}`),
    );

    expect(summary).toBe(`Text: ${'a'.repeat(159)}😀…`);
    expect([...summary.replace(/^Text: /, '').replace(/…$/, '')]).toHaveLength(160);
    expect(summary.length).toBeLessThan(180);
  });

  it('does not split combining sequences or joined emoji at the boundary', () => {
    const combined = accessibleElementSummary(
      textElement(`${'a'.repeat(159)}e\u0301tail`),
    );
    const joined = accessibleElementSummary(
      textElement(`${'a'.repeat(159)}👩‍💻tail`),
    );

    expect(combined).toBe(`Text: ${'a'.repeat(159)}e\u0301…`);
    expect(joined).toBe(`Text: ${'a'.repeat(159)}👩‍💻…`);
  });

  it('uses a bounded scan for notes with very long leading whitespace', () => {
    const summary = accessibleElementSummary(
      textElement(`${' '.repeat(2_000_000)}TAIL-SENTINEL`),
    );

    expect(summary).toBe('Text: …');
    expect(summary).not.toContain('TAIL-SENTINEL');
  });

  it('does not emit a partial grapheme at the scan boundary', () => {
    const joined = accessibleElementSummary(
      textElement(`${' '.repeat(4_093)}👩‍💻tail`),
    );
    const combined = accessibleElementSummary(
      textElement(`${' '.repeat(4_095)}e\u0301tail`),
    );

    expect(joined).toBe('Text: …');
    expect(joined).not.toContain('👩‍');
    expect(combined).toBe('Text: …');
  });

  it('also bounds user-provided image labels', () => {
    const image: ImageElement = {
      id: 'image-1',
      kind: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      dataUrl: 'data:image/png;base64,AA==',
      name: 'image.png',
      alt: 'x'.repeat(1_000),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(accessibleElementSummary(image)).toBe(
      `Image: ${'x'.repeat(160)}…. File: image.png`,
    );
  });

  it('summarizes checklist progress and bounds item text', () => {
    const checklist: ChecklistElement = {
      id: 'checklist-1',
      kind: 'checklist',
      x: 0,
      y: 0,
      width: 240,
      height: 120,
      color: '#000000',
      fontSize: 16,
      items: [
        { id: 'item-1', text: 'Finished task', checked: true },
        { id: 'item-2', text: 'x'.repeat(1_000), checked: false },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const summary = accessibleElementSummary(checklist);
    expect(summary).toContain('Checklist: 1 of 2 complete');
    expect(summary).toContain('Finished task');
    expect(summary.length).toBeLessThan(400);
  });
});
