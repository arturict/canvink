import { createContext, useContext } from 'react';
import type { AccountApi } from './accountApi';

/**
 * Minimal, Clerk-agnostic view of authentication state consumed by the rest
 * of the app. Nothing in this module imports `@clerk/clerk-react`, so
 * consuming it never pulls the Clerk bundle in — only `ClerkAuthBridge.tsx`
 * (loaded lazily by `ClerkGate`) does that.
 */
export interface OptionalAuthUser {
  id: string;
  primaryEmailAddress: string | null;
  fullName: string | null;
  /** Clerk profile picture, only when the user uploaded one (no generated placeholder). */
  imageUrl?: string | null;
}

/**
 * The desktop app's browser sign-in (PERSONAL-SYNC.md §3.7) while it waits
 * for the browser. Present only in the Tauri app.
 */
export interface DesktopLoginControls {
  /** The browser was opened and the app waits for its answer. */
  pending: boolean;
  error: 'failed' | 'expired' | 'browserFailed' | null;
  reopenBrowser(): void;
  /** The fallback: a code (or `canvink://` link) copied from the browser page. */
  submitCode(code: string): Promise<boolean>;
  cancel(): void;
  /** Refreshes the device credential now. After the Worker refused a sync
   * connection this finds out whether the device was signed out on the web;
   * if so the app shows itself signed out. */
  recheck(): void;
}

export type OptionalAuthValue =
  | {
    available: false;
  }
  | {
    available: true;
    isSignedIn: boolean;
    user: OptionalAuthUser | null;
    getToken(): Promise<string | null>;
    openSignIn(): void;
    /** The profile, sign-in methods and security of the account (web, through Clerk). Absent in the desktop app. */
    account?: AccountApi;
    /** Ends the Clerk session. Absent in test seams. */
    signOut?(): Promise<void>;
    /** Set by the desktop app's sign-in instead of Clerk. */
    desktop?: DesktopLoginControls;
  };

export const UNAVAILABLE_AUTH: OptionalAuthValue = { available: false };

export const AuthStatusContext = createContext<OptionalAuthValue>(UNAVAILABLE_AUTH);

/**
 * Reads the current optional-auth state. When Clerk is not configured
 * (`VITE_CLERK_PUBLISHABLE_KEY` absent) this always returns
 * `{ available: false }` and no Clerk code has been loaded.
 */
export function useOptionalAuth(): OptionalAuthValue {
  return useContext(AuthStatusContext);
}
