/**
 * Pure helper so the publishable-key resolution can be unit tested without
 * touching the real `import.meta.env` (mirrors `resolveFeatureFlags` in
 * `src/config/featureFlags.ts`).
 */
export function resolveClerkPublishableKey(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = environment.VITE_CLERK_PUBLISHABLE_KEY;
  return value && value.trim().length > 0 ? value : undefined;
}
