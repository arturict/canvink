/**
 * The math libraries, loaded on demand.
 *
 * The Compute Engine, JSXGraph and MathLive are about 3.5 MB of JavaScript,
 * more than everything else in the notebook together, yet only a page that
 * holds a formula or a graph (or a session with the Math Canvas switched on)
 * runs any of them. They stay out of the start-up bundle and load through
 * `loadMathRuntime()`, which the notebook shell awaits before it mounts the
 * editor for such a page. Code that runs synchronously afterwards reads the
 * loaded libraries through `mathRuntime()` and `computeEngineConstructor()`;
 * async code awaits the loaders itself.
 */
import type { ComputeEngine } from '@cortex-js/compute-engine';
import type JXG from 'jsxgraph';

export interface MathRuntime {
  readonly ComputeEngine: typeof ComputeEngine;
  readonly JXG: typeof JXG;
}

let engineConstructor: typeof ComputeEngine | undefined;
let loadingEngine: Promise<typeof ComputeEngine> | undefined;
let runtime: MathRuntime | undefined;
let loadingRuntime: Promise<MathRuntime> | undefined;

/** Loads the Compute Engine alone, for code that evaluates formulas without a browser view. */
export function loadComputeEngine(): Promise<typeof ComputeEngine> {
  loadingEngine ??= import('@cortex-js/compute-engine').then((module) => {
    engineConstructor = module.ComputeEngine;
    return module.ComputeEngine;
  }, (error: unknown) => {
    loadingEngine = undefined;
    throw error;
  });
  return loadingEngine;
}

/**
 * Loads everything the page editor needs to show formulas and graphs: the
 * engine, JSXGraph, and MathLive (which defines the `<math-field>` element and
 * brings its fonts).
 */
export function loadMathRuntime(): Promise<MathRuntime> {
  loadingRuntime ??= Promise.all([
    loadComputeEngine(),
    import('jsxgraph'),
    import('mathlive'),
    import('mathlive/fonts.css'),
  ]).then(([ComputeEngineClass, jsxGraph]) => {
    runtime = { ComputeEngine: ComputeEngineClass, JXG: jsxGraph.default };
    return runtime;
  }, (error: unknown) => {
    loadingRuntime = undefined;
    throw error;
  });
  return loadingRuntime;
}

export function isMathRuntimeLoaded(): boolean {
  return runtime !== undefined;
}

const NOT_LOADED = 'The math libraries are not loaded yet. Await loadMathRuntime() (or loadComputeEngine()) first.';

export function computeEngineConstructor(): typeof ComputeEngine {
  if (!engineConstructor) throw new Error(NOT_LOADED);
  return engineConstructor;
}

export function mathRuntime(): MathRuntime {
  if (!runtime) throw new Error(NOT_LOADED);
  return runtime;
}

/** Whether any of the elements is a formula or a graph, that is, whether the page needs the math libraries. */
export function holdsMathElements(elements: Readonly<Record<string, { readonly kind: string }>>): boolean {
  for (const id in elements) {
    const { kind } = elements[id];
    if (kind === 'math' || kind === 'graph') return true;
  }
  return false;
}
