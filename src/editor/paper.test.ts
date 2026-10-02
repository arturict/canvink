import { describe, expect, it } from 'vitest';
import {
  activeRulingPreset,
  fixedPaperDimensions,
  pagePaper,
  ruleLineColor,
  paperEdge,
  rulePatternStyle,
  rulePeriod,
  ruleSettingsForColor,
  ruleSpacing,
} from './paper';

/** The colour a translucent rule line shows over the paper. */
function shownOn(css: string, paper: [number, number, number]): number[] {
  const [red, green, blue, alpha] = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(css)!.slice(1).map(Number);
  return [red, green, blue].map((channel, index) => Math.round(channel * alpha + paper[index] * (1 - alpha)));
}

describe('page paper', () => {
  it('reads pages without paper settings as A4 portrait and free pages as unbounded', () => {
    expect(pagePaper({})).toEqual({ size: 'a4', orientation: 'portrait' });
    expect(fixedPaperDimensions({ pageType: 'a4' })).toEqual({ width: 794, height: 1123 });
    expect(fixedPaperDimensions({ pageType: 'free', paper: { size: 'a5', orientation: 'portrait' } })).toBeNull();
  });

  it('turns landscape sheets sideways', () => {
    expect(fixedPaperDimensions({ pageType: 'a4', paper: { size: 'a4', orientation: 'landscape' } }))
      .toEqual({ width: 1123, height: 794 });
    expect(fixedPaperDimensions({ pageType: 'a4', paper: { size: 'letter', orientation: 'portrait' } }))
      .toEqual({ width: 816, height: 1056 });
  });
});

describe('rule lines', () => {
  it('keeps the spacing older pages were drawn with when none is stored', () => {
    expect(ruleSpacing({ type: 'plain' })).toBeUndefined();
    expect(ruleSpacing({ type: 'lined' })).toBe(32);
    expect(ruleSpacing({ type: 'grid' })).toBe(40);
    expect(ruleSpacing({ type: 'millimeter', spacing: 40 })).toBe(10);
    expect(ruleSpacing({ type: 'grid', spacing: 19 })).toBe(19);
    expect(ruleSpacing({ type: 'grid', spacing: 1 })).toBe(8);
  });

  it('draws light blue lines by default and stronger ones on request', () => {
    expect(ruleLineColor({})).toBe('rgba(59, 130, 246, 0.22)');
    expect(ruleLineColor({ lineColor: '#111827', lineStrength: 'strong' })).toBe('rgba(17, 24, 39, 0.72)');
    expect(ruleLineColor({ lineColor: 'red', lineStrength: 'medium' })).toBe('rgba(59, 130, 246, 0.42)');
  });

  it('names the preset a page uses so the gallery can mark it', () => {
    expect(activeRulingPreset({ type: 'grid', color: '#fff' })).toBe('squares-large');
    expect(activeRulingPreset({ type: 'grid', color: '#fff', spacing: 19 })).toBe('squares-small');
    expect(activeRulingPreset({ type: 'lined', color: '#fff', spacing: 24 })).toBe('lines-narrow');
    expect(activeRulingPreset({ type: 'plain', color: '#fff' })).toBe('none');
  });

  it('scales the pattern with the zoom but keeps one-pixel lines', () => {
    const style = rulePatternStyle({ type: 'grid', color: '#fff', spacing: 40 }, 0.5, { x: 10, y: -4 });
    expect(style.backgroundSize).toBe('20px 20px');
    expect(style.backgroundPosition).toBe('10px -4px, 10px -4px');
    expect(String(style.backgroundImage)).toContain('1px, transparent 1px');
    expect(rulePatternStyle({ type: 'plain', color: '#fff' }, 1, { x: 0, y: 0 })).toEqual({});
  });
});

describe('a paper layer that pans without repainting', () => {
  it('lines its pattern up with the page origin wherever the origin has scrolled to', () => {
    const period = 15.2 * 5;
    for (const origin of [-1_000.3, -76, -75.9, -3.5, -0.001, 0, 12, 24]) {
      const edge = paperEdge(origin, period);
      if (origin >= 0) {
        expect(edge).toBe(origin);
      } else {
        // Off screen to the left, at most one period wide, and a whole number of periods from the origin.
        expect(edge).toBeLessThanOrEqual(0);
        expect(edge).toBeGreaterThanOrEqual(-period);
        const periods = (origin - edge) / period;
        expect(Math.abs(periods - Math.round(periods))).toBeLessThan(1e-9);
      }
    }
  });

  it('starts plain paper at the origin or the screen edge and repeats millimetre paper by its tenth line', () => {
    expect(paperEdge(-40, 0)).toBe(0);
    expect(paperEdge(30, 0)).toBe(30);
    expect(rulePeriod({ type: 'plain', color: '#fff' }, 1)).toBe(0);
    expect(rulePeriod({ type: 'grid', color: '#fff', spacing: 40 }, 0.5)).toBe(20);
    const millimetre = rulePeriod({ type: 'millimeter', color: '#fff' }, 1);
    expect(millimetre).toBe(rulePeriod({ type: 'millimeter', color: '#fff' }, 2) / 2);
    expect(millimetre / 5).toBeGreaterThan(0);
  });
});

describe('rule lines from another app', () => {
  it('draws the line colour OneNote shows, not a fainter version of it', () => {
    // OneNote's light blue squares (#CAEBFD), as its page XML stores them.
    const settings = ruleSettingsForColor('#caebfd');
    expect(settings.lineStrength).toBe('medium');
    expect(shownOn(ruleLineColor(settings), [255, 255, 255])).toEqual([0xca, 0xeb, 0xfd]);
    // Taking the colour as the base, as before, left a fifth of the contrast.
    expect(shownOn(ruleLineColor({ lineColor: '#caebfd' }), [255, 255, 255])).toEqual([243, 251, 255]);
  });

  it('uses a palette colour and strength that look the same', () => {
    const lightBlue = shownOn(ruleLineColor({ lineColor: '#3b82f6', lineStrength: 'light' }), [255, 255, 255]);
    const hex = `#${lightBlue.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    expect(ruleSettingsForColor(hex)).toEqual({ lineColor: '#3b82f6', lineStrength: 'light' });
  });

  it('matches the colour on coloured paper and falls back to strong for dark lines', () => {
    const onYellow = ruleSettingsForColor('#b0c8e0', '#fff4c0');
    expect(shownOn(ruleLineColor(onYellow), [0xff, 0xf4, 0xc0])).toEqual([0xb0, 0xc8, 0xe0]);
    expect(ruleSettingsForColor('#202020').lineStrength).toBe('strong');
  });
});
