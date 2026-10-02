import type { MathElementV3 } from '../../domain/v3';

/** Manual correction always wins, followed by recognition and typed input. */
export function effectiveLatex(element: Pick<
  MathElementV3,
  'correctedLatex' | 'recognizedLatex' | 'typedLatex'
>): string | undefined {
  for (const candidate of [element.correctedLatex, element.recognizedLatex, element.typedLatex]) {
    if (candidate !== undefined && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}
