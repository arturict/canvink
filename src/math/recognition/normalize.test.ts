import { describe, expect, it, vi } from 'vitest';
import { normalizeExplicitMathSelection } from './normalize';
import type { ExplicitMathRecognitionSelection } from './types';

function fixture(
  overrides: Partial<ExplicitMathRecognitionSelection> = {},
): ExplicitMathRecognitionSelection {
  return {
    kind: 'explicitMathSelection',
    trigger: 'activeLocalMathBlock',
    userInitiated: true,
    operationId: 'operation_1234567890',
    requestId: 'request_1234567890',
    provider: 'compatible',
    bounds: { x: 100, y: 200, width: 200, height: 100 },
    strokes: [{ points: [
      { x: 100, y: 200, pressure: 0.2 },
      { x: 200, y: 250, pressure: 0.5 },
      { x: 300, y: 300, pressure: 1 },
    ] }],
    locale: 'de-CH',
    settings: { angleMode: 'degree', decimalSeparator: 'comma' },
    ...overrides,
  };
}

describe('normalizeExplicitMathSelection', () => {
  it('emits only local normalized selected ink and a deterministic revision hash', async () => {
    const first = await normalizeExplicitMathSelection(fixture());
    const second = await normalizeExplicitMathSelection(fixture({
      operationId: 'operation_abcdefghij',
      requestId: 'request_abcdefghij',
    }));

    expect(first.strokes).toEqual([{ points: [
      { x: 0, y: 0, pressure: 0.2 },
      { x: 0.5, y: 0.5, pressure: 0.5 },
      { x: 1, y: 1, pressure: 1 },
    ] }]);
    expect(first.boundingBox).toEqual({ width: 200, height: 100 });
    expect(first.revisionSha256).toBe(second.revisionSha256);
    expect(JSON.stringify(first)).not.toMatch(/notebook|page|element|pointer|tilt|timestamp/i);
    expect(first.strokes.flatMap((stroke) => stroke.points).every(
      (point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1,
    )).toBe(true);
  });

  it('rejects restored-style and non-user initiated values before hashing', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    await expect(normalizeExplicitMathSelection({
      ...fixture(),
      userInitiated: false,
    } as unknown as ExplicitMathRecognitionSelection)).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(normalizeExplicitMathSelection({
      ...fixture(),
      trigger: 'remoteSync',
    } as unknown as ExplicitMathRecognitionSelection)).rejects.toMatchObject({ code: 'invalid-input' });
    expect(digest).not.toHaveBeenCalled();
  });

  it('rejects points outside the explicit selection, non-finite values, and count limits', async () => {
    await expect(normalizeExplicitMathSelection(fixture({
      strokes: [{ points: [{ x: 99, y: 200 }] }],
    }))).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(normalizeExplicitMathSelection(fixture({
      strokes: [{ points: [{ x: Number.NaN, y: 200 }] }],
    }))).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(normalizeExplicitMathSelection(fixture({
      strokes: Array.from({ length: 257 }, () => ({ points: [{ x: 100, y: 200 }] })),
    }))).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(normalizeExplicitMathSelection(fixture({
      strokes: [{ points: Array.from({ length: 4_097 }, () => ({ x: 100, y: 200 })) }],
    }))).rejects.toMatchObject({ code: 'payload-too-large' });
  });
});
