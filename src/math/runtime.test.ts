import { describe, expect, it } from 'vitest';
import { computeEngineConstructor, holdsMathElements, isMathRuntimeLoaded, loadComputeEngine } from './runtime';

describe('math runtime', () => {
  it('refuses to hand out the engine before it is loaded and hands it out after', async () => {
    expect(isMathRuntimeLoaded()).toBe(false);
    expect(() => computeEngineConstructor()).toThrow(/not loaded/);
    const loaded = await loadComputeEngine();
    expect(computeEngineConstructor()).toBe(loaded);
    // Loading again returns the same constructor without a second import.
    expect(await loadComputeEngine()).toBe(loaded);
  });

  it('recognises the elements that need the math libraries', () => {
    expect(holdsMathElements({})).toBe(false);
    expect(holdsMathElements({ a: { kind: 'stroke' }, b: { kind: 'richText' } })).toBe(false);
    expect(holdsMathElements({ a: { kind: 'stroke' }, b: { kind: 'math' } })).toBe(true);
    expect(holdsMathElements({ a: { kind: 'graph' } })).toBe(true);
  });
});
