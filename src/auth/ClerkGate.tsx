import { useState, type ReactNode } from 'react';
import { retryableLazy } from '../components/retryableLazy';
import { AuthStatusContext, UNAVAILABLE_AUTH, type OptionalAuthValue } from './AuthContext';
import DesktopAuthProvider from './DesktopAuthProvider';
import { resolveClerkPublishableKey } from './clerkConfig';
import { resolveE2ETestAuth } from './e2eTestAuth';

// Clerk only adds sign-in state: without its chunk (offline) the app runs signed out.
const ClerkAuthBridge = retryableLazy(() => import('./ClerkAuthBridge'), { layout: 'silent' });


export interface ClerkGateProps {
  children: ReactNode;
  /** Test/integrator seam; defaults to `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY`. */
  publishableKey?: string;
}

/**
 * Mounts Clerk only when a publishable key is configured, and only ever
 * loads the Clerk bundle (via `ClerkAuthBridge`, dynamically imported) in
 * that case. Without a key, children render directly and `useOptionalAuth()`
 * reports `{ available: false }` everywhere.
 */
export default function ClerkGate({ children, publishableKey }: ClerkGateProps) {
  // e2e builds only (a build-time secret gates it): a synthetic signed-in
  // identity instead of Clerk, for the whole app.
  const [testAuth] = useState(() => resolveE2ETestAuth());
  const resolvedKey = publishableKey ?? resolveClerkPublishableKey(import.meta.env);
  if (testAuth) {
    return <AuthStatusContext.Provider value={testAuth}>{children}</AuthStatusContext.Provider>;
  }

  // The desktop app never loads Clerk; it signs in through the system browser.
  // Imported statically (it is small) so the app is not remounted after a
  // lazy load, as the Suspense fallback below would do.
  if (typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined') {
    return <DesktopAuthProvider>{children}</DesktopAuthProvider>;
  }

  if (!resolvedKey) {
    return <>{children}</>;
  }

  return <ClerkGateWithBridge publishableKey={resolvedKey}>{children}</ClerkGateWithBridge>;
}

/**
 * The children keep their place in the tree while Clerk's chunk loads and
 * after it arrives: wrapping them in the provider once it is there would
 * remount the whole app and open the workspace a second time. The bridge is
 * their sibling and reports Clerk's state, which reaches them through the
 * auth context; until then they see "unavailable", as before.
 */
function ClerkGateWithBridge({ publishableKey, children }: { publishableKey: string; children: ReactNode }) {
  const [status, setStatus] = useState<OptionalAuthValue>(UNAVAILABLE_AUTH);
  return (
    <AuthStatusContext.Provider value={status}>
      {children}
      <ClerkAuthBridge publishableKey={publishableKey} onStatus={setStatus} />
    </AuthStatusContext.Provider>
  );
}
