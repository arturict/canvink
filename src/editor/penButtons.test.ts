import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PEN_BUTTON_MAPPING,
  parsePenButtonMapping,
  penButtonAction,
  penSlotsPressed,
  pressedButtonBits,
  type PenButtonMapping,
} from './penButtons';

const pen = { pointerType: 'pen', button: 0, buttons: 1 };
const mapping: PenButtonMapping = { barrel: 'lasso', secondary: 'screenshot', eraserEnd: 'eraser' };

describe('pen button to action mapping', () => {
  it('leaves a plain tip alone', () => {
    expect(penButtonAction(pen, mapping)).toBeNull();
  });

  it('maps the barrel button in contact and while hovering', () => {
    expect(penButtonAction({ ...pen, buttons: 3 }, mapping)).toBe('lasso');
    expect(penButtonAction({ pointerType: 'pen', button: 2, buttons: 2 }, mapping)).toBe('lasso');
    expect(penButtonAction({ pointerType: 'pen', button: -1, buttons: 2 }, mapping)).toBe('lasso');
  });

  it('maps the eraser end by button 5 or buttons & 32, with or without contact', () => {
    expect(penButtonAction({ ...pen, button: 5, buttons: 33 }, mapping)).toBe('eraser');
    expect(penButtonAction({ pointerType: 'pen', button: -1, buttons: 32 }, mapping)).toBe('eraser');
  });

  it('maps a second barrel button reported as middle, back or forward', () => {
    expect(penButtonAction({ ...pen, button: 1, buttons: 5 }, mapping)).toBe('screenshot');
    expect(penButtonAction({ ...pen, buttons: 9 }, mapping)).toBe('screenshot');
    expect(penButtonAction({ ...pen, buttons: 17 }, mapping)).toBe('screenshot');
  });

  it('lets the eraser end win over a barrel button held at the same time', () => {
    expect(penSlotsPressed({ ...pen, buttons: 1 | 2 | 32 })).toEqual(['eraserEnd', 'barrel']);
    expect(penButtonAction({ ...pen, buttons: 1 | 2 | 32 }, { ...mapping, eraserEnd: 'rectangleSelect' }))
      .toBe('rectangleSelect');
  });

  it('treats a button mapped to none as no button', () => {
    expect(penButtonAction({ ...pen, buttons: 3 }, { ...mapping, barrel: 'none' })).toBeNull();
  });

  it('ignores mouse and touch buttons', () => {
    expect(penButtonAction({ pointerType: 'mouse', button: 2, buttons: 2 }, mapping)).toBeNull();
    expect(penButtonAction({ pointerType: 'touch', button: 0, buttons: 33 }, mapping)).toBeNull();
  });

  it('lists the raw bits for the button test readout', () => {
    expect(pressedButtonBits(0)).toEqual([]);
    expect(pressedButtonBits(35)).toEqual([1, 2, 32]);
  });
});

describe('stored pen button mapping', () => {
  it('defaults to OneNote: barrel erases, second button selects, eraser end erases', () => {
    expect(parsePenButtonMapping(null)).toEqual({ barrel: 'eraser', secondary: 'lasso', eraserEnd: 'eraser' });
    expect(DEFAULT_PEN_BUTTON_MAPPING.eraserEnd).toBe('eraser');
  });

  it('reads a stored mapping and replaces unknown values with the defaults', () => {
    expect(parsePenButtonMapping(JSON.stringify({ barrel: 'screenshot', secondary: 'bogus' }))).toEqual({
      barrel: 'screenshot',
      secondary: 'lasso',
      eraserEnd: 'eraser',
    });
    expect(parsePenButtonMapping('{not json')).toEqual(DEFAULT_PEN_BUTTON_MAPPING);
  });

  it('keeps an earlier lasso choice for the barrel button', () => {
    expect(parsePenButtonMapping(null, 'lasso')).toEqual({ barrel: 'lasso', secondary: 'eraser', eraserEnd: 'eraser' });
    expect(parsePenButtonMapping(null, 'eraser')).toEqual(DEFAULT_PEN_BUTTON_MAPPING);
  });
});
