import { describe, expect, it } from 'vitest';
import { accountMenuViewModel, appFlavour, formatAssetSize } from './AccountMenu';
import { UNAVAILABLE_AUTH, type OptionalAuthValue } from '../../auth';

function signedIn(overrides: Partial<Extract<OptionalAuthValue, { available: true }>> = {}): OptionalAuthValue {
  return {
    available: true,
    isSignedIn: true,
    user: { id: 'user-1', primaryEmailAddress: 'ada@example.com', fullName: 'Ada' },
    getToken: async () => 'jwt',
    openSignIn: () => undefined,
    ...overrides,
  };
}

describe('formatAssetSize', () => {
  it('formats bytes, kilobytes, megabytes and gigabytes', () => {
    expect(formatAssetSize(0)).toBe('0 B');
    expect(formatAssetSize(512)).toBe('512 B');
    expect(formatAssetSize(2_048)).toBe('2.0 KB');
    expect(formatAssetSize(5_242_880)).toBe('5.0 MB');
    expect(formatAssetSize(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('never returns a negative or non-finite size', () => {
    expect(formatAssetSize(-10)).toBe('0 B');
    expect(formatAssetSize(Number.NaN)).toBe('0 B');
  });
});

describe('accountMenuViewModel', () => {
  it('is signed-out when auth is unavailable', () => {
    expect(accountMenuViewModel(UNAVAILABLE_AUTH)).toEqual({ signedIn: false, canSignIn: false });
  });

  it('is signed-out (but can sign in) when Clerk is available and the user is not signed in', () => {
    const auth: OptionalAuthValue = { available: true, isSignedIn: false, user: null, getToken: async () => null, openSignIn: () => undefined };
    expect(accountMenuViewModel(auth)).toEqual({ signedIn: false, canSignIn: true });
  });

  it('reports only who is signed in; counts and devices live on the account page', () => {
    expect(accountMenuViewModel(signedIn())).toEqual({
      signedIn: true,
      name: 'Ada',
      email: 'ada@example.com',
      imageUrl: null,
    });
  });

  it('shows only a Clerk-hosted profile picture', () => {
    const clerk = accountMenuViewModel(signedIn({
      user: { id: 'u', primaryEmailAddress: null, fullName: 'Ada', imageUrl: 'https://img.clerk.com/ada' },
    }));
    expect(clerk.signedIn && clerk.imageUrl).toBe('https://img.clerk.com/ada');
    const other = accountMenuViewModel(signedIn({
      user: { id: 'u', primaryEmailAddress: null, fullName: 'Ada', imageUrl: 'https://example.com/ada.png' },
    }));
    expect(other.signedIn && other.imageUrl).toBeNull();
  });

  it('handles a signed-in user with no known e-mail address', () => {
    const model = accountMenuViewModel(signedIn({ user: { id: 'u', primaryEmailAddress: null, fullName: null } }));
    expect(model.signedIn && model.email).toBeNull();
  });
});

describe('appFlavour', () => {
  it('is the web app without the desktop controls, so both downloads are offered', () => {
    expect(appFlavour(signedIn())).toBe('web');
    expect(appFlavour(UNAVAILABLE_AUTH)).toBe('web');
  });

  it('is the desktop app when the desktop sign-in controls are present, so only the Android app is offered', () => {
    const desktop = { pending: false, error: null, reopenBrowser: () => undefined, submitCode: async () => true, cancel: () => undefined, recheck: () => undefined };
    expect(appFlavour(signedIn({ desktop }))).toBe('desktop');
  });
});
