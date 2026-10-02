# Collaboration, presence and offline sync

Hostnames under `example.com` in this document are configuration examples.
Replace them with the deployment origins; they do not describe a live service.

How pages move between devices and between people, how live presence works,
and what happens offline. Written 2026-09-25 against branch `ux/presence`.

## Three sync paths

| Path | Code | Transport | Encryption | Status |
| --- | --- | --- | --- | --- |
| Notebook sharing (owner + people with a link) | `src/collab`, `src/components/collab`, `services/collab-sync` | WebSocket to a Cloudflare Worker, one SQLite Durable Object (`NotebookRoom`) per shared notebook | TLS only; content is plaintext in the Durable Object (PROTOCOL.md, by design for anonymous read links) | Deployed Worker, in the web build |
| Personal space (one user, several devices) | `src/personal-space`, `src/components/personal-space`, same Worker | Same WebSocket protocol, room kind `personal`, one room per Clerk user; assets through the Worker to R2 | TLS only | In the web build when `VITE_PERSONAL_SPACE=1`; R2 not enabled yet |
| Encrypted team sync | `src/sync`, `src/components/sync`, `functions/canvink-sync` (Appwrite) | Appwrite Functions + Realtime, durable outbox/inbox, device approval, epoch keys (`src/sync/crypto`) | End-to-end (libsodium) | Implemented and tested, not deployed (placeholder project) |

None of them runs an automerge-repo network adapter. The local Repo only has
a storage adapter (IndexedDB in the browser, SQLite through Tauri); sync code
extracts Automerge changes from the local handles and ships them itself.

### Sharing in detail

- The owner shares a notebook (`ShareNotebookDialog` → `createRoomFromDocs`):
  the Worker creates a room and the notebook and page documents are uploaded as
  snapshots. The room starts **restricted**: nobody gets in until the owner (or
  an admin) invites a person or switches the read-only link on. The owner keeps
  `roomId` + `ownerToken` in `localStorage` (`ownerRoomStore.ts`).
- **Who may do what** is decided per person by the Worker (PROTOCOL.md "Sharing
  roles"): *Lesen* (read), *Bearbeiten* (edit), *Admin* (edit plus invite,
  change roles, remove people, manage the link); the owner is implicitly the top
  admin and cannot be removed or demoted. A role change applies to an open
  session at once (a `role` frame), and a removal closes it.
- **Share dialog** (OneNote/Google Docs style): an e-mail field with a role
  menu and "Einladen"; the people with access (avatar, name, address, role menu
  with "Entfernen"); pending invitations (role menu, "Einladung zurückziehen",
  "Link kopieren" for an `#open=<roomId>` link that carries no secret);
  "Allgemeiner Zugriff": "Nur eingeladene Personen" or "Alle mit dem Link —
  Lesen", with "Link kopieren" and "Link neu erstellen". Everything asks the
  Worker; the dialog never decides. Destructive steps use the app's
  `ConfirmDialog`.
- **Invitations by e-mail** send nothing. The Worker lists them for the signed-in
  account's *verified* Clerk addresses (secondary ones too; it reads them with
  the Clerk Backend API, secret `CLERK_SECRET_KEY`), and the app shows them under
  "Mit dir geteilt" in the notebook switcher with a badge on its button
  (`useInvitations`). Opening one connects with the account alone: the room
  recognises the verified address, claims the invitation and lets the account in
  with the invited role.
- **Everybody with the link is a reader**, always, enforced by the room. Turning
  the link off, or regenerating it, ends the access of the people who came in
  through it and never of people invited by name.
- The owner's app binds each shared notebook's live runtime handles to a room
  session (`useSharedNotebookSync` → `bindEditorSession` + `runtimeEditorPort`):
  local changes go out as `append` frames, remote ones are merged into the
  local handles and so persisted locally like any edit. A signed-in owner also
  tells the room who they are (`PUT /owner-profile`).
- Opening the link (`#join=…`) or an invitation (`#open=<roomId>` or the
  switcher) adds the shared notebook to the **opener's own workspace** and shows
  it in the normal app. This needs a signed-in account: signed out, a dialog asks
  to sign in first. Signed in, the room is read with the account (and the link, if
  there is one), the notebook and its pages are adopted with their Automerge
  history (`adoptSharedDocuments.ts`, one topology transaction, PERSONAL-SYNC.md
  P13), and the notebook appears next to the person's own ones with a small
  "shared" mark in the switcher (a lock for a reader's notebook). The owner who
  opens their own link lands in the notebook they already have, without any
  network. A page a collaborator adds later is adopted on arrival, so structure
  changes (pages, sections) reach everyone like text and ink.
- **Read-only notebooks.** The role the room grants is kept per notebook
  (`notebookAccess.ts`, remembered in the joined-room record). For a reader the
  shell shows the "Nur lesen" badge and switches the editing UI off with the same
  switch the page-history viewer uses (`viewerMode` in `V2NotebookApp`; the
  other notebooks of the workspace stay editable, and creating, moving or leaving
  a notebook still works). Search, viewing and copying keep working. Below the
  UI, the notebook's documents are registered in `src/storage/readOnlyDocuments.ts`:
  `PageWriteSession.change`, topology commits that change those documents, ink
  sealing and `applyPageElementChanges` (the same lowest-level guard the Android
  viewer uses, here per document) refuse local edits, and the room session
  never sends a reader's writes. Remote changes are not edits of this device
  and still apply. A joined notebook whose role is not known yet (an older record,
  or one that arrived from another device) is read-only until the room confirms
  it.
- From then on a joined notebook syncs through the account alone
  (`joinedRoomStore.ts` keeps only the room id and the last role, never the link
  secret). With the personal space on, the room id is written into the account's
  workspace document (`sharedRoomId`), so the account's other devices connect the
  same notebook to the same room. "Freigabe verlassen" in the switcher takes the
  notebook out of the workspace (into the trash), tells the room (`POST /leave`)
  and cuts the connection; the others keep their copy. If the Worker stops
  accepting the account (the person was removed, or the link they came through was
  turned off), the notebook stays as a local copy that no longer syncs, and a
  notice says so.
- **Migration.** Members of a room from before roles existed became
  *Bearbeiten* (`via = migrated`) when the Worker first woke the room; an old link
  keeps working, now as a read-only link.
- The Worker stores per document the latest snapshot plus the change log,
  assigns a `seq` per append, acknowledges it to the sender and broadcasts it
  to the others. Reconnects resume from `since`. Clients compact every 64
  acknowledged appends.

### Clerk

`ClerkGate` (`src/auth`) lazily mounts Clerk only when
`VITE_CLERK_PUBLISHABLE_KEY` is set and exposes a Clerk-free
`useOptionalAuth()`: availability, sign-in state, user id, e-mail, full name,
Clerk profile picture (only if the user uploaded one), `getToken()`,
`openSignIn()`, `openUserProfile()` and `signOut()`. Clerk's modals follow the
app language (`@clerk/localizations` German) and the app's colours. The same
context feeds the share link (sign-in, registering as a collaborator), the personal space and the
presence identity. e2e builds replace Clerk with a test identity
(`src/auth/e2eTestAuth.ts`, gated by a build-time secret).

The Tauri desktop app never loads Clerk. `ClerkGate` mounts
`DesktopAuthProvider` there instead: "Anmelden" opens
`canvink.example.com/desktop-login` in the default browser, Clerk runs on that
page, and a one-time code comes back through `canvink://auth`. The app
exchanges it (PKCE) for a device credential; the Rust side
(`src-tauri/src/desktop_auth.rs`) keeps the refresh token under Windows DPAPI
and hands the WebView 10-minute access tokens that the Worker accepts like the
Clerk `sub`. The web account menu lists signed-in desktop apps with
"Abmelden". Protocol, revocation and threat notes:
`services/collab-sync/PERSONAL-SYNC.md` §3.7; Google and GitHub sign-in and the contract for other native apps: `docs/social-sign-in.md`. Desktop builds read
`.env.desktop` (`pnpm build:desktop`, run by `tauri build`); put a local
Worker and web URL in `.env.desktop.local` to test against localhost.

## Live presence

What people see in a shared notebook:

- **Faces in the topbar**, left of one's own account button: everyone working
  in the notebook, on any page, at most three, then `+N` (a click lists the
  rest). The Clerk picture, otherwise initials, in a ring in the person's
  colour; a person without movement for three minutes, or with a hidden tab,
  is dimmed. People on the current page and active people come first.
- **Hover (long-press on touch)** over a face shows a round preview of the
  page around that person's pointer (their window if they have no pointer),
  their pointer and live stroke included, with their name and "Seite X". The
  page is read once when the preview opens (`previewPage.ts`, `pagePreview.ts`,
  a plain canvas drawing of ruling, ink, text, shapes and the pictures of
  images this device holds, grey boxes for the rest). A page's handwriting
  lives in ink segments that are only resident for pages that were opened, so
  the preview fetches the segments the page references (from this device or
  the room) before it paints; before, a page nobody had opened here came out
  without its ink. A page that cannot be read shows "Vorschau nicht
  verfügbar" instead of an empty circle.
- **Your own other devices** (the same account in another tab or on another
  device) are one face, named "Du (anderes Gerät)", not a stranger with your
  name: that is how Google Docs and OneNote treat the same account, and it
  stays useful, since a click jumps to the pen on the tablet. A person never
  appears twice, however many devices they have in the room.
- **Click** takes you to the person: their page opens (the workspace navigates) and the canvas shows the part
  of the page their window shows (`view`). **Folgen** in the preview keeps
  mirroring their page and window until you press, tap or scroll on your own
  canvas, press the "Folgt …" chip, or they leave. Only people in the same
  room are ever listed, so presence never crosses personal spaces.
- **Page list**: small faces next to each page where someone is.
- **On the canvas**: the other person's pointer with a name label; the stroke
  they are drawing, visible while the pen is still down (before the stroke is
  committed); a soft highlight around the region they work in (their recent
  strokes, their selection or the text box they edit) that fades after
  inactivity.
- Without an account the name is the device family ("Windows-PC", "iPad").

### Transport decision

Presence rides on the room's existing WebSocket as a new ephemeral frame
(`{"t":"presence","state":…}`, PROTOCOL.md "Presence"). The Worker relays it
to the other authenticated sockets with a per-connection id and the sender's
role, never stores it, replays the latest state to late joiners and sends
`presence-leave` when a socket closes.

- Yjs would mean replacing Automerge as the CRDT; out of scope, and awareness
  is only the small part of Yjs this needs.
- automerge-repo's ephemeral messages (`DocHandle.broadcast`) only travel over
  a Repo network adapter, which no Canvink sync path uses. Adding one would
  mean a second, parallel sync channel next to the room protocol.
- The room channel already authenticates every socket and scopes it to one
  notebook, so presence reaches exactly the people who can read the notebook.
  It is encrypted exactly like the documents of that room: TLS, not
  end-to-end. Presence for the E2EE Appwrite path already exists separately
  (`publishPresence`, encrypted with the notebook) and was not touched.

Client side, `PresenceHub` (`src/collab/presence.ts`) publishes the local
state at most every 40 ms while something changes (in-progress ink as point
deltas, so a stroke costs a few hundred bytes per frame) and a heartbeat every
5 s; peers without any frame for 16 s are dropped. A hidden tab counts as
away. Peer input is validated; only Clerk-hosted avatar URLs are rendered, so
a peer cannot make everyone's browser load an arbitrary URL. The canvas gets
presence through a small port (`src/editor/presence`), so the editor does not
depend on the transport. The Worker drops presence frames past 40 per second
per socket and refuses states over 16 KiB.

The state carries the sender's `page` (a document id inside the room, so the
notebook is implied by the room) and `view`, the visible part of the page as
`[x, y, width, height]` in page coordinates, rounded to whole units. The
Worker relays the state opaquely, so `view` needs no Worker change; clients
without it are followed to their pointer instead.

A Worker deployed before this change answers presence with `bad-frame`;
clients then stop sending presence for that session and everything else keeps
working. **Presence needs a deploy of `services/collab-sync`.**

## Offline

What is kept where:

- **Owner (and a single user without sharing)**: every edit is saved to the
  local Repo storage (IndexedDB or SQLite) before sync is involved, so ink
  drawn offline survives a reload or restart. The app shell reopens offline
  through the service worker.
- **Owner of a shared notebook** (changed here): after every catch-up the
  owner's session reconciles with the room, sending every local change the
  room has not confirmed (catch-up, broadcasts and the owner's own
  acknowledged appends). Before, offline appends sat in an in-memory queue: a
  reload while offline meant the room did not get them (until a later
  compaction snapshot), and past 1000 queued frames the oldest were dropped.
  Pages created offline are announced and uploaded the same way.
- The session reconnects as soon as the browser reports `online`, instead of
  waiting out a backoff of up to 30 s.
- **Concurrent edits** merge through Automerge. Two cases the page model did
  not survive before are repaired on read now: an element one side erases
  while the other reorders it, and two sides moving the same element. Such a
  page failed to load; the snapshot functions now yield every element exactly
  once (`pageDrawOrder`).
- Both runtime ports echoed every remote change back to the room (a
  `DocHandle` emits `change` synchronously inside `update()`); fixed, which
  halves log growth.

Tests: `src/components/collab/offlineConvergence.test.ts` (real session,
binding and port against an in-memory relay: offline ink, reload while
offline, dropped acknowledgements, concurrent and conflicting edits, no
duplicate change in the room log) and `tests/e2e/collab-presence.spec.ts`
(two browsers against a local Worker, including `context.setOffline`, a
reload while offline and convergence with concurrent ink).

### Known weaknesses and proposals

1. **Joining editors keep offline work only in memory.** Someone who joined
   by link edits in-memory documents with the 1000-frame queue; closing or
   reloading the tab while offline loses their unsent strokes. Proposal:
   persist join sessions per room in IndexedDB and reconcile like the owner,
   or offer "add to my notebooks" so a regular collaborator becomes a local
   owner-like replica.
2. **Sync runs only while the app is open.** There is no background sync; a
   phone that goes to sleep syncs when the app is opened again.
3. **Presence identity is self-asserted.** The Worker guarantees role and
   connection, not the name or picture a client sends. Editors are mutually
   trusted by design; a viewer could still pick any display name. Proposal:
   add name and image to the Clerk session token and let the Worker stamp
   them (needs a Clerk dashboard change, not done).
4. **A page the owner deletes while offline** stays in the room after a
   reload (reconcile only adds and updates).
5. **Personal space** keeps its own strategy (P7: dirty documents resent as
   snapshots after reconnect, tracked in memory). Its offline-then-reload path
   has no test yet; the reconcile approach here would fit it too.
6. **No end-to-end encryption** for sharing, personal space or their
   presence. The encrypted Appwrite design exists but is not deployed.

## Running the sync tests locally

```sh
# Worker unit and integration tests (Miniflare, no network)
cd services/collab-sync && pnpm install && pnpm test

# Sharing and presence e2e: starts wrangler dev and a preview build itself.
# Pick free ports when another checkout already listens on the defaults.
PLAYWRIGHT_COLLAB_APP_PORT=5193 PLAYWRIGHT_COLLAB_WORKER_PORT=8895 \
  pnpm exec playwright test --config tests/e2e/collab-sync.playwright.config.ts

# Personal space e2e
PLAYWRIGHT_SPACE_APP_PORT=5194 PLAYWRIGHT_SPACE_WORKER_PORT=8896 \
  pnpm exec playwright test --config tests/e2e/personal-space.playwright.config.ts

# Desktop sign-in e2e: the /desktop-login page, the canvink:// hand-off and
# the app's code exchange, refresh and revocation against a local Worker
PLAYWRIGHT_DESKTOP_LOGIN_APP_PORT=5188 PLAYWRIGHT_DESKTOP_LOGIN_WORKER_PORT=8791 \
  pnpm exec playwright test --config tests/e2e/desktop-login.playwright.config.ts
```

The main `playwright.config.ts` skips these specs; they need the Worker.
Servers are reused only with `PLAYWRIGHT_REUSE_SERVERS=1`.

For manual testing with two windows: run `wrangler dev` in
`services/collab-sync` with `--var TEST_AUTH_SECRET:<secret> --var
ALLOWED_ORIGINS:*`, start the app with `VITE_COLLAB_SYNC_URL` pointing at it
and `VITE_PERSONAL_SPACE_TEST_AUTH_SECRET=<secret>`, and open
`/app?__canvinkSpaceTestSub=anna&__canvinkTestName=Anna` in one browser
profile and the share link with `?__canvinkSpaceTestSub=ben&__canvinkTestName=Ben`
inserted before `#join=` in another.
