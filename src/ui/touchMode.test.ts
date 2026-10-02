import { describe, expect, it } from 'vitest';
import {
  parseTouchModePreference,
  pointerKind,
  resolveTouchMode,
  type TouchSignals,
} from './touchMode';

const idle: TouchSignals = { coarsePrimary: false, coarseOnly: false, hoverNone: false, lastPointer: null };

describe('touch mode', () => {
  it('follows the input hardware when automatic', () => {
    expect(resolveTouchMode('auto', idle)).toBe(false);
    expect(resolveTouchMode('auto', { ...idle, coarsePrimary: true })).toBe(true);
    expect(resolveTouchMode('auto', { ...idle, coarseOnly: true })).toBe(true);
    expect(resolveTouchMode('auto', { ...idle, hoverNone: true })).toBe(true);
  });

  it('treats a finger or pen as tablet use until the mouse is back', () => {
    expect(resolveTouchMode('auto', { ...idle, lastPointer: 'touch' })).toBe(true);
    expect(resolveTouchMode('auto', { ...idle, lastPointer: 'pen' })).toBe(true);
    expect(resolveTouchMode('auto', { ...idle, lastPointer: 'mouse' })).toBe(false);
  });

  it('lets a forced choice win over every signal', () => {
    expect(resolveTouchMode('on', idle)).toBe(true);
    expect(resolveTouchMode('off', { ...idle, coarsePrimary: true, lastPointer: 'touch' })).toBe(false);
  });

  it('reads stored preferences defensively', () => {
    expect(parseTouchModePreference('on')).toBe('on');
    expect(parseTouchModePreference('off')).toBe('off');
    expect(parseTouchModePreference('yes')).toBe('auto');
    expect(parseTouchModePreference(null)).toBe('auto');
    expect(pointerKind('pen')).toBe('pen');
    expect(pointerKind('')).toBeNull();
  });
});
