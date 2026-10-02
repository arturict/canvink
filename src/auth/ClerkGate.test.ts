import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { resolveClerkPublishableKey } from './clerkConfig';
import { UNAVAILABLE_AUTH } from './AuthContext';
import ClerkGate from './ClerkGate';

// ClerkGate never renders the Clerk-dependent branch in this suite (no
// publishable key is supplied), but @clerk/clerk-react is mocked anyway so
// the real SDK is never touched by any test in this file.
vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({ isSignedIn: false, getToken: async () => null }),
  useUser: () => ({ user: null }),
  useClerk: () => ({ openSignIn: vi.fn() }),
}));

describe('resolveClerkPublishableKey', () => {
  it('treats a missing or blank key as not configured', () => {
    expect(resolveClerkPublishableKey({})).toBeUndefined();
    expect(resolveClerkPublishableKey({ VITE_CLERK_PUBLISHABLE_KEY: '' })).toBeUndefined();
    expect(resolveClerkPublishableKey({ VITE_CLERK_PUBLISHABLE_KEY: '   ' })).toBeUndefined();
    expect(resolveClerkPublishableKey({ VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_x' })).toBe('pk_test_x');
  });
});

describe('ClerkGate', () => {
  it('renders children directly and reports auth unavailable when no publishable key is configured', () => {
    const markup = renderToStaticMarkup(
      createElement(ClerkGate, {
        publishableKey: undefined,
        children: createElement('span', null, 'Arbeitsbereich'),
      }),
    );
    expect(markup).toBe('<span>Arbeitsbereich</span>');
    expect(UNAVAILABLE_AUTH).toEqual({ available: false });
  });
});
