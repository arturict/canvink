export interface CanvinkFeatureFlags {
  /** Future Math Canvas release. Kept off in the current notebook-focused build. */
  mathCanvas: boolean;
  /** Reserved for future opt-in assistance. No AI surface ships in this release. */
  aiAssist: boolean;
}

export function featureFlagEnabled(value: string | boolean | undefined): boolean {
  return value === true || (typeof value === 'string' && /^(1|true|on|yes)$/i.test(value.trim()));
}

export function resolveFeatureFlags(
  environment: Readonly<Record<string, string | boolean | undefined>>,
): CanvinkFeatureFlags {
  return {
    mathCanvas: featureFlagEnabled(environment.VITE_CANVINK_FEATURE_MATH_CANVAS),
    aiAssist: featureFlagEnabled(environment.VITE_CANVINK_FEATURE_AI_ASSIST),
  };
}

export const CANVINK_FEATURE_FLAGS: Readonly<CanvinkFeatureFlags> = Object.freeze(
  resolveFeatureFlags(import.meta.env),
);

/**
 * Whether this session may honor a `?__canvinkFeatureMath=1` style URL override.
 * Only a genuine dev build or an explicit build-time opt-in qualifies. A
 * loopback hostname must never count: a self-hosted or previewed production
 * build is still production even when it is served on 127.0.0.1 or localhost.
 */
export function featureOverrideAllowed(
  environment: Readonly<Record<string, string | boolean | undefined>>,
): boolean {
  return featureFlagEnabled(environment.DEV)
    || featureFlagEnabled(environment.VITE_CANVINK_ALLOW_FEATURE_OVERRIDE);
}

export function mathCanvasEnabledForSession(
  flags: Readonly<CanvinkFeatureFlags>,
  options: { allowFeatureOverride: boolean; search: string },
): boolean {
  if (flags.mathCanvas) return true;
  if (!options.allowFeatureOverride) return false;
  return new URLSearchParams(options.search).get('__canvinkFeatureMath') === '1';
}
