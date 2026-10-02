import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ClerkProvider, useAuth, useClerk, useUser } from '@clerk/clerk-react';
import { deDE } from '@clerk/localizations/de-DE';

// Clerk's German labels the sign-up link "Anmelden", which also names signing
// in; Swiss usage is "Registrieren" for creating an account.
const GERMAN = {
  ...deDE,
  // The provider buttons name the action: "Mit Google anmelden".
  socialButtonsBlockButton: 'Mit {{provider|titleize}} anmelden',
  signIn: {
    ...deDE.signIn,
    start: { ...deDE.signIn?.start, actionText: 'Noch kein Konto?', actionLink: 'Registrieren' },
  },
  signUp: {
    ...deDE.signUp,
    start: { ...deDE.signUp?.start, actionText: 'Schon ein Konto?', actionLink: 'Anmelden' },
  },
};
import type { OptionalAuthValue } from './AuthContext';
import { createInAppRouter } from './inAppRouter';
import { clerkAppearance } from './clerkAppearance';
import { avatarInputsOf, createClerkAccountApi, resolvedAvatarOf, setProviderAvatar } from './clerkAccountApi';
import { pickProviderAvatar } from './avatar';

/**
 * Loaded only via `React.lazy` from `ClerkGate` when
 * `VITE_CLERK_PUBLISHABLE_KEY` is set. This is the only module in the app
 * that imports `@clerk/clerk-react`, so it is the only thing that pulls the
 * Clerk bundle into a chunk, and that chunk is only fetched when Clerk is
 * actually configured.
 */

export interface ClerkAuthBridgeProps {
  publishableKey: string;
  /** Receives the app's view of Clerk's state whenever it changes. */
  onStatus(value: OptionalAuthValue): void;
}

function readDocumentLanguage(): string {
  return typeof document === 'undefined' ? 'de' : document.documentElement.lang || 'de';
}

function subscribeDocumentLanguage(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  return () => observer.disconnect();
}

/**
 * The app's language as `I18nProvider` sets it on `<html lang>`. The Clerk
 * provider sits outside the i18n provider (it wraps the whole app, landing
 * page included), so it follows the document language instead of the i18n
 * context.
 */
function useDocumentLanguage(): string {
  return useSyncExternalStore(subscribeDocumentLanguage, readDocumentLanguage, () => 'de');
}

/** The first Google or GitHub sign-in of an account that has no picture yet takes the provider's, once. */
const AUTO_AVATAR_KEY = 'canvink:avatar-auto:';

function ClerkStatusReporter({ onStatus }: { onStatus(value: OptionalAuthValue): void }) {
  const { isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const account = useMemo(() => createClerkAccountApi(clerk), [clerk]);
  // Clerk mutates the user object in place, so the memo below also watches the
  // values that decide the picture, not just the object's identity.
  const avatarKey = user
    ? `${user.hasImage}|${user.imageUrl}|${String(user.unsafeMetadata?.canvinkAvatar ?? '')}|${user.externalAccounts.map((entry) => `${entry.id}:${entry.imageUrl}`).join(',')}`
    : '';
  const value = useMemo<OptionalAuthValue>(() => ({
    available: true,
    isSignedIn: isSignedIn ?? false,
    user: user
      ? {
        id: user.id,
        primaryEmailAddress: user.primaryEmailAddress?.emailAddress ?? null,
        fullName: user.fullName ?? null,
        // An uploaded or chosen image, else the picture of the Google or
        // GitHub account in use (src/auth/avatar.ts). Without either,
        // initials look better than Clerk's generated image and match the
        // presence avatars of local-only users.
        imageUrl: resolvedAvatarOf(user, clerk),
      }
      : null,
    getToken: async () => getToken(),
    // Come back to exactly this URL (including a `#join=` fragment) once the
    // modal completes, so a guest upgrading to editor keeps their room.
    openSignIn: () => clerk.openSignIn({
      forceRedirectUrl: window.location.href,
      signUpForceRedirectUrl: window.location.href,
    }),
    account,
    signOut: () => clerk.signOut({ redirectUrl: window.location.href }),
    // `avatarKey` stands in for the parts of the mutable `user` that change the picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [account, clerk, getToken, isSignedIn, user, avatarKey]);
  useEffect(() => onStatus(value), [onStatus, value]);

  useEffect(() => {
    if (!user || user.hasImage || user.unsafeMetadata?.canvinkAvatar === 'initials') return;
    const strategy = clerk.client?.lastAuthenticationStrategy;
    const pick = pickProviderAvatar(avatarInputsOf(user, strategy).externalAccounts, strategy);
    if (!pick) return;
    const key = `${AUTO_AVATAR_KEY}${user.id}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, '1');
    } catch {
      return;
    }
    // Best effort: the picture already shows without the upload. Uploading it
    // makes it the account's own, so Clerk serves it everywhere.
    void setProviderAvatar(user, pick.url).catch(() => undefined);
  }, [clerk, user]);
  return null;
}

/**
 * Renders next to the app, not around it, and reports Clerk's state through
 * `onStatus`. The app must keep its place in the tree: wrapping it in
 * `ClerkProvider` once this chunk has loaded would remount it, and the
 * workspace would open a second time.
 */
export default function ClerkAuthBridge({ publishableKey, onStatus }: ClerkAuthBridgeProps) {
  const router = useMemo(
    () => createInAppRouter(window.history, () => window.location.href, (to) => window.location.assign(to)),
    [],
  );
  const language = useDocumentLanguage();
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      routerPush={router.push}
      routerReplace={router.replace}
      // English is Clerk's built-in default; German follows the app language.
      localization={language.startsWith('de') ? GERMAN : undefined}
      appearance={clerkAppearance}
    >
      <ClerkStatusReporter onStatus={onStatus} />
    </ClerkProvider>
  );
}
