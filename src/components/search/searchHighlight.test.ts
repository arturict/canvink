import { describe, expect, it } from 'vitest';
import { highlightParts, highlightRanges } from './searchHighlight';

describe('highlightParts', () => {
  it('marks every word of the query in the text, ignoring case and accents', () => {
    expect(highlightParts('Die Prüfung zur Kinematik', 'pruefung kinematik').filter((part) => part.match).map((part) => part.text))
      .toEqual(['Kinematik']);
    expect(highlightParts('Die Prüfung zur Kinematik', 'prufung KINEMA').filter((part) => part.match).map((part) => part.text))
      .toEqual(['Prüfung', 'Kinema']);
  });

  it('keeps the text intact and merges overlapping words', () => {
    const parts = highlightParts('Impulserhaltung im Impuls', 'impuls impulserh');
    expect(parts.map((part) => part.text).join('')).toBe('Impulserhaltung im Impuls');
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(['Impulserh', 'Impuls']);
  });

  it('does not mark operators such as tag: and is:', () => {
    expect(highlightRanges('Hausaufgabe offen', 'is:open tag:hausaufgabe')).toEqual([]);
    expect(highlightRanges('Hausaufgabe offen', 'is:open Hausaufgabe')).toEqual([[0, 11]]);
  });

  it('returns the text unmarked for an empty query', () => {
    expect(highlightParts('Physik', '  ')).toEqual([{ text: 'Physik', match: false }]);
  });
});
