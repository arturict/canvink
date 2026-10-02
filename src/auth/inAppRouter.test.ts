import { describe, expect, it, vi } from 'vitest';
import { createInAppRouter, isSameDocument } from './inAppRouter';

const HREF = 'https://notes.example/app#join=room-1.secret';

describe('isSameDocument', () => {
  it('treats hash-only differences as the same document', () => {
    expect(isSameDocument('https://notes.example/app#join=room-1.secret', HREF)).toBe(true);
    expect(isSameDocument('https://notes.example/app', HREF)).toBe(true);
    expect(isSameDocument('/app#other', HREF)).toBe(true);
  });

  it('treats a different path, search, or origin as a different document', () => {
    expect(isSameDocument('https://notes.example/', HREF)).toBe(false);
    expect(isSameDocument('/app?x=1', HREF)).toBe(false);
    expect(isSameDocument('https://accounts.notes.example/sign-in', HREF)).toBe(false);
    expect(isSameDocument('not a url at all', 'also not a url')).toBe(false);
  });
});

describe('createInAppRouter', () => {
  it('uses the history API for same-document targets and never hard-navigates', () => {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    const hard = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('HashChangeEvent', class { constructor(public type: string) {} });
    const router = createInAppRouter(history, () => HREF, hard);

    router.push(HREF);
    router.replace('/app#join=room-1.secret');

    expect(history.pushState).toHaveBeenCalledWith(null, '', HREF);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/app#join=room-1.secret');
    expect(hard).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('falls back to a real navigation for a different document', () => {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    const hard = vi.fn();
    const router = createInAppRouter(history, () => HREF, hard);

    router.push('https://accounts.notes.example/user');

    expect(hard).toHaveBeenCalledWith('https://accounts.notes.example/user');
    expect(history.pushState).not.toHaveBeenCalled();
  });
});
