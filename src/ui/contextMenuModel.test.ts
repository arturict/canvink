import { describe, expect, it } from 'vitest';
import { nextEnabledIndex, placeBelow, placeMenu, placeSubmenu, typeaheadIndex } from './contextMenuModel';

const viewport = { width: 1000, height: 700 };
const size = { width: 220, height: 300 };

describe('placeMenu', () => {
  it('opens down and to the right of the pointer when there is room', () => {
    expect(placeMenu({ x: 100, y: 120 }, size, viewport)).toEqual({ x: 100, y: 120 });
  });

  it('flips to the left of the pointer at the right edge', () => {
    expect(placeMenu({ x: 900, y: 120 }, size, viewport)).toEqual({ x: 680, y: 120 });
  });

  it('flips above the pointer at the bottom edge', () => {
    expect(placeMenu({ x: 100, y: 650 }, size, viewport)).toEqual({ x: 100, y: 350 });
  });

  it('stays inside a window that is smaller than the menu', () => {
    const placed = placeMenu({ x: 10, y: 10 }, { width: 220, height: 900 }, { width: 390, height: 600 });
    expect(placed.x).toBeGreaterThanOrEqual(6);
    expect(placed.y).toBe(6);
  });
});

describe('placeBelow', () => {
  const button = { left: 800, right: 900, top: 10, bottom: 44 };

  it('aligns the right edge with the button and sits below it', () => {
    expect(placeBelow(button, size, viewport, 'end')).toEqual({ x: 680, y: 50 });
  });

  it('aligns the left edge with the button for a start-aligned menu', () => {
    expect(placeBelow({ ...button, left: 20, right: 90 }, size, viewport, 'start').x).toBe(20);
  });

  it('flips above the button near the bottom edge and stays in the window', () => {
    const low = { left: 800, right: 900, top: 650, bottom: 680 };
    expect(placeBelow(low, size, viewport, 'end').y).toBe(344);
    expect(placeBelow({ left: 0, right: 40, top: 10, bottom: 40 }, size, viewport, 'end').x).toBe(6);
  });
});

describe('placeSubmenu', () => {
  it('opens to the right of its item when it fits and to the left otherwise', () => {
    expect(placeSubmenu({ left: 100, right: 320, top: 200 }, size, viewport).x).toBe(318);
    expect(placeSubmenu({ left: 700, right: 920, top: 200 }, size, viewport).x).toBe(482);
  });
});

describe('menu keyboard helpers', () => {
  it('skips disabled items and wraps around', () => {
    const enabled = [true, false, true, true];
    expect(nextEnabledIndex(enabled, 0, 1)).toBe(2);
    expect(nextEnabledIndex(enabled, 3, 1)).toBe(0);
    expect(nextEnabledIndex(enabled, 0, -1)).toBe(3);
    expect(nextEnabledIndex([false, false], 0, 1)).toBe(-1);
  });

  it('jumps to the next item starting with a typed letter', () => {
    const labels = ['Umbenennen', 'Abschnittsfarbe', 'Neuer Abschnitt', 'Löschen'];
    const enabled = [true, true, true, true];
    expect(typeaheadIndex(labels, enabled, 0, 'n')).toBe(2);
    expect(typeaheadIndex(labels, enabled, 2, 'u')).toBe(0);
    expect(typeaheadIndex(labels, enabled, 0, 'x')).toBe(-1);
  });
});
