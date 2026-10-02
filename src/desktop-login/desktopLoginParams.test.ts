import { describe, expect, it } from 'vitest';
import { desktopDeepLink, parseDesktopLoginParams } from './desktopLoginParams';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('desktop login parameters', () => {
  it('accepts an S256 challenge and a state value', () => {
    expect(parseDesktopLoginParams(`?challenge=${CHALLENGE}&state=abcdefghijklmnop`))
      .toEqual({ challenge: CHALLENGE, state: 'abcdefghijklmnop', platform: 'desktop' });
  });

  it('reads the optional platform and ignores unknown values', () => {
    expect(parseDesktopLoginParams(`?challenge=${CHALLENGE}&state=abcdefghijklmnop&platform=android`)?.platform)
      .toBe('android');
    expect(parseDesktopLoginParams(`?challenge=${CHALLENGE}&state=abcdefghijklmnop&platform=ios`)?.platform)
      .toBe('desktop');
  });

  it('rejects missing, short or foreign values', () => {
    expect(parseDesktopLoginParams('')).toBeNull();
    expect(parseDesktopLoginParams(`?challenge=${CHALLENGE}`)).toBeNull();
    expect(parseDesktopLoginParams(`?challenge=${CHALLENGE}&state=short`)).toBeNull();
    expect(parseDesktopLoginParams(`?challenge=abc&state=abcdefghijklmnop`)).toBeNull();
    expect(parseDesktopLoginParams(`?challenge=${CHALLENGE}&state=${encodeURIComponent('<script>alert(1)</script>')}`)).toBeNull();
  });

  it('builds the canvink:// hand-off link', () => {
    expect(desktopDeepLink('space.secret', 'abcdefghijklmnop'))
      .toBe('canvink://auth?code=space.secret&state=abcdefghijklmnop');
  });
});
