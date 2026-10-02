# Social sign-in and the native hand-off

Canvink uses Clerk for browser sign-in. Native apps open the configured web
origin in the system browser and receive a one-time authorization code.
Provider connections, client credentials and account-linking outcomes are
operator configuration and are not recorded in this repository.

## Account linking

A provider account with a verified email matching an existing Clerk user may
link to that user. A different provider email can create a separate user. To
connect a provider to an existing user, sign in to that user first and use the
account dialog's "Konto verbinden" action. Verify linking on a test account
before offering it to users.

## Contract for native apps (Windows desktop, Android)

This is RFC 8252 plus PKCE and is the same for every native client. Protocol
details and server routes: `services/collab-sync/PERSONAL-SYNC.md` section 3.7.

1. The app creates a PKCE verifier, its S256 challenge (43 base64url characters)
   and a `state` value (16 to 128 characters of `A-Za-z0-9_-`).
2. The app opens this URL in the system browser (Android: a Chrome Custom Tab,
   not a WebView, because Google refuses OAuth in embedded WebViews):

   `https://<configured-web-origin>/desktop-login?challenge=<challenge>&state=<state>&platform=android`

   `platform` is optional (`desktop` or `android`, default `desktop`). It only
   changes the wording on the page ("Canvink Android"). Unknown values count as
   `desktop`.
3. On that page the user signs in with e-mail, Google or GitHub (Clerk modal,
   the OAuth round trip returns to the same URL with the query intact) and taps
   "Anmelden" once.
4. The page navigates to `canvink://auth?code=<code>&state=<state>` and offers a
   "Canvink öffnen" link and "Code anzeigen" as fallbacks. Android Chrome only
   launches a custom scheme after a user tap, so the link is a real fallback.
   Register an intent filter for the `canvink` scheme with host `auth`.
5. The app checks `state` equals its own value, then calls
   `POST https://<collab-sync worker>/api/v1/device/token` with
   `{grant_type:"authorization_code", code, code_verifier, device_name, install_id, platform, app_version}` and
   stores the returned refresh token in the platform key store (Android
   Keystore). Refresh tokens rotate on every use.

Clerk itself needs no extra setup for this flow: the hand-off does not use a
Clerk redirect to the app, so "Native applications" and extra allowed redirect
URLs are not required. If an https App Link replaces the `canvink://` scheme
later, only `DESKTOP_DEEP_LINK` in `src/desktop-login/desktopLoginParams.ts`
changes.
