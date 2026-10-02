# canvink-collab-sync

Cloudflare Worker backend for Canvink notebook sharing. Implements the HTTP
room-management API and the WebSocket sync protocol defined in
[`PROTOCOL.md`](./PROTOCOL.md) — read that file first; this service is built
to match it exactly, and any protocol change must be made there first.

Standalone package: its own `package.json`, lockfile, `tsconfig.json`, and
Vitest config. Not part of any other workspace in this tree.

## Layout

- `src/index.ts` — Worker entry point: HTTP/WebSocket router, CORS, roomId
  minting. Forwards everything to the room's Durable Object.
- `src/room.ts` — `NotebookRoom`, the SQLite-backed Durable Object holding one
  room's state and WebSocket connections (via the Hibernation API).
- `src/auth/clerk.ts` — RS256 JWT verification against a cached Clerk JWKS,
  plus the `TEST_AUTH_SECRET` HMAC test shim.
- `src/util/crypto.ts` — base64url/hex encoding, random ID generation,
  constant-time comparison, HMAC.
- `src/rateLimit.ts` — per-IP rate limiting for `POST /rooms` (B3), plus the
  personal-space per-`sub` limiters for `POST /me/space` and asset `PUT`:
  prefers the Cloudflare Rate Limiting binding where one exists, falls back to
  an in-memory limiter.
- `src/space.ts` — personal-space `spaceId` derivation and the
  `POST|GET /api/v1/me/space` routes (PERSONAL-SYNC.md).
- `src/assets.ts` — personal-space R2 asset routes
  (`HEAD|PUT|GET|DELETE /api/v1/me/assets/:assetId`), proxied to the room's
  Durable Object (PERSONAL-SYNC.md).
- `test/` — Vitest (`@cloudflare/vitest-plugin`) integration tests that run
  inside the real Workers runtime.

This service also implements the **personal space** (PERSONAL-SYNC.md): a
second room kind, on the same `NotebookRoom` Durable Object class, for a
signed-in user's own cross-device workspace sync. See PROTOCOL.md's "Personal
space (v2)" section for the short version, PERSONAL-SYNC.md for the full
design.

## Dev

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in Clerk config / test secret as needed
pnpm dev                          # wrangler dev
```

## Test

```sh
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit
pnpm dry-run       # wrangler deploy --dry-run (no network deploy)
```

Tests use the `TEST_AUTH_SECRET` shim (configured in `vitest.config.ts`, never
in the deployed `vars`) to mint `test:<sub>:<hmac>` bearer tokens instead of
real Clerk JWTs.

## Deploy

```sh
pnpm deploy
```

Before deploying for real, set the following via `wrangler secret put` /
dashboard as needed:

| Var                       | Required | Notes                                                          |
|---------------------------|----------|-----------------------------------------------------------------|
| `ALLOWED_ORIGINS`          | yes      | Comma-separated list of app origins allowed for CORS. `*` allowed. |
| `CLERK_ISSUER`             | for editing via Clerk | e.g. `https://<slug>.clerk.accounts.dev`. **Fail-closed (D5)**: if this is unset, real Clerk JWTs are *always* rejected — there is no "skip issuer check" fallback. The test shim (`TEST_AUTH_SECRET`) is unaffected. |
| `CLERK_JWKS_URL`           | optional | Defaults to `${CLERK_ISSUER}/.well-known/jwks.json`             |
| `CLERK_SECRET_KEY`         | for e-mail invitations | Clerk Backend API secret key (`sk_live_…`), **set as a secret**: `wrangler secret put CLERK_SECRET_KEY`. The Worker reads the verified e-mail addresses of an account (secondary ones included) to claim invitations by address. Without it (and without an `emails` claim in the session token) invitations are never claimed: fail closed. |
| `CLERK_AUTHORIZED_PARTIES` | optional | Comma-separated allow-list checked against the JWT's `azp` claim. Unset skips the check. |
| `TEST_AUTH_SECRET`         | never in production | Local dev / test only — see `.dev.vars.example`. Setting this in any deployed environment would let anyone mint valid "editor" identities, bypassing Clerk entirely. |
| `PERSONAL_SPACE_SALT`      | for the personal space | 32 random bytes, base64. **Already set as a secret on the deployed Worker.** Derives every user's `spaceId` (PERSONAL-SYNC.md §2.1). **Write-once**: rotating it orphans every existing personal space — there is no migration path. Every `/me/space*` and `/me/assets/*` route returns `503 {"error":"personal-space-not-configured"}` while it is unset, same fail-closed spirit as `CLERK_ISSUER`. |
| `DEVICE_TOKEN_SECRET`      | for desktop sign-in | 32 random bytes, base64: the HMAC key for desktop device access tokens (PERSONAL-SYNC.md §3.7). `/api/v1/device/*` and `/api/v1/me/devices*` return `503 {"error":"device-login-not-configured"}` while it is unset. Rotating it invalidates access tokens only; devices recover on their next refresh. |

`wrangler.jsonc`'s `vars` intentionally omits `TEST_AUTH_SECRET`,
`CLERK_ISSUER`, and `PERSONAL_SPACE_SALT`; the first two exist only via
`.dev.vars` (local `wrangler dev`) or the test pool's `miniflare` bindings,
`CLERK_ISSUER` must be set via `wrangler secret put CLERK_ISSUER` (or the
dashboard) once a real Clerk instance exists — an *empty string* `CLERK_ISSUER`
is deliberately not the same as "unset" further up the config chain, so it is
never declared in `vars` at all (see the commented example in
`wrangler.jsonc`) — and `PERSONAL_SPACE_SALT` is set the same write-once way
via `wrangler secret put PERSONAL_SPACE_SALT`.

### Personal-space asset storage: R2 not yet enabled

The personal space's asset routes (`HEAD|PUT|GET|DELETE
/api/v1/me/assets/:assetId`, PERSONAL-SYNC.md §3.5, §4.2) need an R2 bucket
binding named `ASSETS`. **That bucket does not exist yet**: `wrangler r2
bucket create canvink-personal-assets` currently fails with error `10042`
("R2 is not enabled for this account"). Until R2 is enabled and the bucket is
created:

- `wrangler.jsonc`'s `r2_buckets` block is commented out (an active binding
  pointing at a nonexistent bucket would make `wrangler deploy` fail
  outright).
- `Env.ASSETS` is typed optional (`R2Bucket | undefined`).
- Every `/me/assets/*` route fails closed with
  `503 {"error":"assets-not-configured"}` while `env.ASSETS` is undefined —
  checked in both `src/assets.ts` (Worker) and `src/room.ts` (Durable
  Object), before anything touches R2.
- Everything else in the personal space — room creation/lookup
  (`/me/space`), the WebSocket doc sync, the `workspace:root` doc, reauth —
  works normally without it.
- Tests inject a local R2 simulation for the `ASSETS` binding via
  `vitest.config.ts`'s `miniflare.r2Buckets` option (Miniflare simulates R2
  entirely in-process; this needs no real Cloudflare API access and is
  unrelated to the account-level R2 enablement above), plus one test
  (`test/assets.spec.ts`) that asserts the 503 when the binding is absent.

**To enable it later**: enable R2 in the Cloudflare dashboard for this
account, run `wrangler r2 bucket create canvink-personal-assets`, then
uncomment the `r2_buckets` block in `wrangler.jsonc` and redeploy. No code
change is needed.

### Rate limiting (B3)

`POST /rooms` (unauthenticated, unbounded room creation otherwise) targets
10 room creations per 60 seconds per `CF-Connecting-IP`. **Be precise about
what's actually shipped**: the default in this checked-in config is
`src/rateLimit.ts`'s best-effort, per-isolate in-memory fallback limiter —
not the Cloudflare Rate Limiting binding. That fallback resets on cold
start and shares no state across isolates, so it's a floor under naive,
single-isolate abuse, not an accurate global "10/60s" guarantee; an abuser
spread across enough isolates or cold starts sees a materially higher
effective ceiling.

The real Cloudflare Rate Limiting binding (`ROOM_CREATE_RATE_LIMITER`,
`type: "ratelimit"`) is deliberately commented out in `wrangler.jsonc`, not
missing by oversight: it passes `wrangler deploy --dry-run` (verified), but
actually invoking `.limit()` against it in a *local* runtime crashes plain
`wrangler dev` outright (reproduced: "crash #1" after the first request) and,
at this package's own test volume, silently shares one bucket across every
unrelated Vitest case in a file (no per-request IP in that harness) — a
correctness trap for a checked-in default, not a niche edge case. Enabling
the real binding (uncomment the block, deploy to an environment with real
Cloudflare API access) is the correct upgrade path once accurate enforcement
matters at real abuse volume; until then, the in-memory fallback is what
actually protects this endpoint.

Room creation also bounds `notebookTitle` (≤200 chars, must be a string —
malformed/non-JSON bodies get a `400`, not an unhandled exception), and each
room bounds docs (≤1000), links (≤20), and registered collaborators (≤100).

Personal-space limits (PERSONAL-SYNC.md §7) are separate, per-`sub` (not
per-IP): `POST /me/space` at 30/60s, asset `PUT` at 60/60s — same best-effort,
per-isolate in-memory shape as above (`src/rateLimit.ts`). A personal room
also has its own docs-per-room ceiling (`MAX_DOCS_PER_SPACE`, 5000, vs. 1000
for a shared room) and a total change-log byte budget
(`MAX_SPACE_LOG_BYTES`, 1 GiB, tracked via the `meta.logBytes` counter) — both
non-fatal `quota-exceeded`/`payload-too-large` errors, never a fatal close.

## Security notes (D10/D4)

- **CORS is a response shield, not an authorization gate.** `ALLOWED_ORIGINS`
  only controls which browser origins are permitted to *read* a
  cross-origin response (`Access-Control-Allow-Origin`); it does nothing to
  stop a request from being sent or executed server-side (curl, another
  server, a browser extension, `no-cors` requests, or WebSocket upgrades,
  which aren't subject to CORS preflight at all). Every actual authorization
  decision in this service happens via the credentials themselves
  (`ownerToken`, `linkSecret`, Clerk JWT) checked in `room.ts`, never via
  `Origin`.
- **`ownerToken` lives in the app's `localStorage`** (see the main app's
  `ownerRoomStore.ts`), not in this service. That means it is readable by
  any script that can run in the app's origin — an XSS vulnerability
  elsewhere in the app would leak it. There is no token-rotation recovery
  path short of ending the share: `DELETE /rooms/:roomId` (full unshare)
  invalidates the compromised `ownerToken` along with everything else, and
  the notebook can be re-shared as a fresh room with a new one.

## Protocol ambiguities resolved during implementation

`PROTOCOL.md` is close to unambiguous, but a few implementation choices
weren't fully pinned down. Documented here so the frontend can be reconciled
against the same assumptions:

1. **`meta` endpoint + JWT without prior registration**: the HTTP endpoint's
   text says Bearer auth applies "for registered collaborators" — read
   literally, this means a valid Clerk JWT alone at `/meta` only grants access
   if the subject is *already* a collaborator (i.e. this endpoint cannot
   itself register a collaborator via a combined `k=<linkSecret>` +
   `Authorization: Bearer` request, unlike the WS `hello` path). Implemented
   exactly that way; if the frontend expects `/meta` to also accept
   `jwt + k` and register on the spot, that needs a protocol update.
2. **First WS frame that isn't `hello`**: the protocol says the first frame
   *must* be `hello` but doesn't specify what happens otherwise. Implemented
   as a fatal close (code `4401`, `error: "unauthorized"`) rather than a
   non-fatal `bad-frame`, since without an established role there's nothing
   safe to do with any other frame type.
3. **A second `hello` on an already-authenticated socket**: not specified.
   Implemented as a non-fatal `bad-frame` error; the connection's role is
   fixed for its lifetime (reconnect to switch credentials/role).
4. **`append`/`snapshot` for a `docId` with no prior `announce`**: `snapshot`
   is explicitly allowed to initialize a doc on its own (per the "first
   snapshot or append... initializes it" line), so `handleSnapshot` upserts
   the `docs` row itself. `append`, however, has no payload describing the
   doc's `kind`, so an `append` for a never-announced/never-snapshotted
   `docId` is rejected with `unknown-doc` rather than silently creating a
   `kind: "unknown"` row.
5. **`seq` continuity across compaction**: after a `snapshot` with `covers:
   N` deletes all `changes` rows for a doc, the *next* `append`'s `seq` must
   continue from `covers + 1`, not restart from 1 (which a naive
   `MAX(changes.seq) + 1` would do once the changes table is empty for that
   doc). Implemented by taking `MAX(docs.covers, MAX(changes.seq))` as the
   baseline. This is implied by the protocol's "seq is per-doc monotonic (max
   existing + 1)" wording but worth calling out explicitly.
6. **Snapshot catch-up baseline**: per PROTOCOL.md, `since` and `covers`
   combine as `max(covers, since[docId])`; a snapshot is sent whenever one
   exists, even if the client's `since` is already past `covers` (i.e. the
   client may receive a redundant-but-harmless full snapshot on reconnect).
   Implemented literally as written.
7. **CORS + `ALLOWED_ORIGINS`**: implemented as a comma-separated allow-list
   with an optional `*` wildcard, reflecting the matching `Origin` back
   (not a static `*`), so credentialed requests would still work if ever
   needed. WebSocket upgrades are forwarded without a CORS check (browsers
   don't apply CORS preflight to WebSocket upgrades); origin-pinning the WS
   route was considered but not implemented since PROTOCOL.md doesn't call
   for it and all authorization already happens via the `hello` frame's
   credentials.
8. **Room re-`init`**: `POST /init` (internal DO route backing `POST
   /rooms`) refuses a second call against the same Durable Object instance
   (`409 already-initialized`) rather than re-minting an `ownerToken`, since
   the worker only ever calls it once per freshly-generated `roomId`; a
   second call would indicate a bug or an exceedingly unlikely `roomId`
   collision, not a legitimate retry.

## Toolchain note

Pinned to `@cloudflare/vitest-plugin` (the successor to
`@cloudflare/vitest-pool-workers`, which required Vitest 2/3 and hit a
Windows-only file-locking bug in its isolated-storage teardown — see
[cloudflare/workers-sdk#5629](https://github.com/cloudflare/workers-sdk/issues/5629)
and [#10511](https://github.com/cloudflare/workers-sdk/issues/10511)) together
with Vitest 4 and Wrangler 4, which run cleanly on Windows and support a
current `compatibility_date`.
