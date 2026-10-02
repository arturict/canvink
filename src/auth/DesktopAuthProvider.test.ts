import { describe, expect, it, vi } from 'vitest';
import { UNAVAILABLE_AUTH } from './AuthContext';
import { desktopAuthValue, type DesktopAuthBridge, type DesktopAuthStatus } from './DesktopAuthProvider';

function bridge(results: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (...call: [command: string, args?: unknown]) => {
    const [command] = call;
    const result = results[command];
    if (result instanceof Error) throw result;
    return result;
  });
  return { invoke: invoke as unknown as DesktopAuthBridge['invoke'], listen: vi.fn(), calls: invoke };
}

const signedOut: DesktopAuthStatus = { configured: true, signedIn: false, user: null, pending: false, error: null };

describe('desktop sign-in auth value', () => {
  it('is unavailable until the build has sign-in endpoints', () => {
    expect(desktopAuthValue({ ...signedOut, configured: false }, bridge())).toBe(UNAVAILABLE_AUTH);
    expect(desktopAuthValue(null, bridge())).toBe(UNAVAILABLE_AUTH);
  });

  it('signs in through the browser instead of Clerk', () => {
    const b = bridge();
    const value = desktopAuthValue(signedOut, b);
    expect(value).toMatchObject({ available: true, isSignedIn: false, user: null });
    if (!value.available) throw new Error('unreachable');
    value.openSignIn();
    expect(b.calls).toHaveBeenCalledWith('desktop_login_start');
  });

  it('exposes the verified name and picture and the device access token when signed in', async () => {
    const b = bridge({ desktop_access_token: { token: 'device-token', expiresAt: 1 } });
    const value = desktopAuthValue({
      ...signedOut,
      signedIn: true,
      user: { id: 'user_1', name: 'Anna Keller', picture: 'https://img.clerk.com/a.png' },
    }, b);
    if (!value.available) throw new Error('unreachable');
    expect(value.user).toEqual({
      id: 'user_1',
      fullName: 'Anna Keller',
      imageUrl: 'https://img.clerk.com/a.png',
      primaryEmailAddress: null,
    });
    await expect(value.getToken()).resolves.toBe('device-token');
  });

  it('returns no token once signed out, and reports a refused pasted code', async () => {
    const b = bridge({ desktop_access_token: null, desktop_login_submit: new Error('invalidCode') });
    const value = desktopAuthValue({ ...signedOut, pending: true }, b);
    if (!value.available || !value.desktop) throw new Error('unreachable');
    await expect(value.getToken()).resolves.toBeNull();
    await expect(value.desktop.submitCode('nope')).resolves.toBe(false);
    expect(value.desktop.pending).toBe(true);
  });

  it('forces a refresh when asked to recheck after a refused connection', () => {
    const b = bridge({ desktop_access_token: null });
    const value = desktopAuthValue({ ...signedOut, signedIn: true, user: { id: 'user_1' } }, b);
    if (!value.available || !value.desktop) throw new Error('unreachable');
    value.desktop.recheck();
    expect(b.calls).toHaveBeenCalledWith('desktop_access_token', { force: true });
  });
});
