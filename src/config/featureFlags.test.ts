import { describe, expect, it } from 'vitest';
import {
  featureFlagEnabled,
  featureOverrideAllowed,
  mathCanvasEnabledForSession,
  resolveFeatureFlags,
} from './featureFlags';

describe('Canvink feature flags', () => {
  it('keeps future Math and AI surfaces disabled by default', () => {
    expect(resolveFeatureFlags({})).toEqual({ mathCanvas: false, aiAssist: false });
  });

  it('requires an explicit affirmative value', () => {
    expect(featureFlagEnabled('true')).toBe(true);
    expect(featureFlagEnabled('ON')).toBe(true);
    expect(featureFlagEnabled('false')).toBe(false);
    expect(resolveFeatureFlags({ VITE_CANVINK_FEATURE_MATH_CANVAS: '1' }).mathCanvas).toBe(true);
  });

  it('allows an explicit development-only test session without changing release defaults', () => {
    const flags = resolveFeatureFlags({});
    expect(mathCanvasEnabledForSession(flags, { allowFeatureOverride: true, search: '?__canvinkFeatureMath=1' })).toBe(true);
    expect(mathCanvasEnabledForSession(flags, { allowFeatureOverride: false, search: '?__canvinkFeatureMath=1' })).toBe(false);
  });

  it('permits the URL override only for a dev build or an explicit build-time opt-in, never for a loopback host', () => {
    // A real production build served on 127.0.0.1 (self-hosted or the local
    // preview) must not treat the loopback address as a development signal.
    expect(featureOverrideAllowed({ DEV: true })).toBe(true);
    expect(featureOverrideAllowed({ DEV: false })).toBe(false);
    expect(featureOverrideAllowed({ DEV: false, VITE_CANVINK_ALLOW_FEATURE_OVERRIDE: '1' })).toBe(true);
    expect(featureOverrideAllowed({ DEV: false, PROD: true })).toBe(false);
  });
});
