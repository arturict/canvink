import type { MathElementV3 } from '../../domain/v3';

export function applyMathCorrection(
  element: MathElementV3,
  correctedLatex: string | undefined,
  updatedAt: string,
): MathElementV3 {
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) throw new Error('A valid correction timestamp is required.');
  const normalized = correctedLatex?.trim().length ? correctedLatex : undefined;
  return {
    ...element,
    updatedAt,
    ...(normalized === undefined ? {} : { correctedLatex: normalized }),
    ...(normalized === undefined && element.correctedLatex !== undefined ? { correctedLatex: undefined } : {}),
    // Derived state is intentionally invalidated. Raw ink is retained by exact
    // reference and is never rewritten by a formula correction.
    result: { state: 'none', diagnostics: [] },
    dependencies: {
      defines: [],
      references: [],
      dependsOnElementIds: [],
      state: 'valid',
    },
  };
}
