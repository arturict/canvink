import { describe, expect, it } from 'vitest';
import { caretOverflow, viewportKeyboardInset } from './keyboardInset';

describe('keyboard inset', () => {
  it('measures the keyboard as the part of the layout viewport the visual viewport lost', () => {
    expect(viewportKeyboardInset(800, { height: 500, offsetTop: 0, scale: 1 })).toBe(300);
    expect(viewportKeyboardInset(800, { height: 450, offsetTop: 50, scale: 1 })).toBe(300);
  });

  it('ignores small changes and pinch zoom', () => {
    expect(viewportKeyboardInset(800, { height: 760, offsetTop: 0, scale: 1 })).toBe(0);
    expect(viewportKeyboardInset(800, { height: 400, offsetTop: 0, scale: 2 })).toBe(0);
  });

  it('reports how far a caret reaches below the visible area', () => {
    expect(caretOverflow(300, 500)).toBe(0);
    expect(caretOverflow(490, 500)).toBe(6);
    expect(caretOverflow(600, 500, 0)).toBe(100);
  });
});
