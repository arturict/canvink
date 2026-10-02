# Canvink Personal Space — cross-device sync for a signed-in user's own notebooks

Hostnames under `example.com` in this document are configuration examples.
Replace them with the deployment origins; they do not describe a live service.

Design specification, implementation-ready. Status: **proposal, not yet built.**
Companion to [`PROTOCOL.md`](./PROTOCOL.md) (notebook *sharing*, v1).
This document adds a second product surface to the same backend service; it
does not change any behaviour described in `PROTOCOL.md`. Where the two
interact, this file is authoritative for the personal surface and `PROTOCOL.md`
stays authoritative for sharing.

Product requirement (owner, verbatim intent): *"meine eigenen Notizbücher sind
zwischen Desktop-App und Web-Version synchron, inkl. Bilder/PDFs"*.

Deployment targets: Tauri desktop app, `https://canvink.example.com` (browser,
desktop + phone). Backend: `https://canvink-sync.example.com`.

---

## 0. Decision log (read this first)

Every decision below is binding. Builders must not re-open them; they may only
report a decision as *unimplementable* with evidence.

| # | Decision | Rejected alternative | Why |
|---|----------|----------------------|-----|
| **P1** | Reuse the `NotebookRoom` Durable Object class with a new **room kind** (`shared` \| `personal`). One personal room per Clerk `sub`. | A second DO class `PersonalSpace`. | The change log, `seq` assignment past `covers`, the catch-up skip rule, ack-driven compaction, hibernation and the B1a/B1b/B1c correctness fixes are identical for both surfaces (`services/collab-sync/src/room.ts:602-635`, `:699-727`). A second class would fork all of that. Reuse also means **no `wrangler` DO migration** is needed — only new bindings/secrets. |
| **P2** | New auth kind `{"kind":"personal","jwt":"..."}` yields role `owner` iff `verifyBearerToken(jwt).sub === meta.personalSub`. No `ownerToken`, no `linkSecret`, ever, in a personal room. | Minting an `ownerToken` per user and storing it in `localStorage`. | `ownerToken` in `localStorage` is the one credential the sharing design already flags as XSS-readable (`services/collab-sync/README.md:111-117`). A personal space holds *everything*; it must be gated by a short-lived Clerk token, not a long-lived bearer secret. |
| **P3** | Personal-space topology (notebook list, order, trash, asset manifest) lives in **one dedicated Automerge doc**, `docId: "workspace:root"`, `kind: "workspace"`, which is **not** part of the local activation/Repo. It is materialised into the local manifest through `commitWorkspaceGraphRevision`. | Putting the manifest itself in the activation and diffing activations. | The activation is a fingerprint-chained, single-writer artefact (`src/storage/workspaceV2Runtime.ts:1003-1005`, `:1057-1076`); it cannot merge concurrently. A CRDT doc can. Keeping it out of the Repo also leaves `assertCanvinkAutomergeDocument` (`src/crdt/document.ts:58-70`, which only accepts `notebook`/`page`) untouched. |
| **P4** | Assets go to **Cloudflare R2, proxied through the Worker**, keyed `spaces/<spaceId>/<sha256hex>`; integrity enforced by R2's `sha256` put option; per-space dedupe only. | Presigned S3-compatible R2 URLs; global content-addressed dedupe. | Presigning needs an R2 access key plus SigV4 in the Worker — a new long-lived credential, and a URL that authorises by possession rather than identity. Global dedupe across users is a cross-tenant existence oracle. Proxying keeps exactly one auth path (Clerk JWT) and one isolation rule (`spaceId` prefix, derived server-side, never client-supplied). |
| **P5** | Asset download is **lazy** (on render demand, or an explicit "offline verfügbar machen"), never eager on materialisation. Downloaded bytes are adopted into the activation in **batched** `commitWorkspaceGraphRevision({ assets })` transactions. | Eager download; or a shadow asset cache outside the activation. | `readCommitted` loads *every* asset's bytes into memory at every startup (`src/storage/v2WorkspaceStorage.ts:917-922`; Tauri: `src/storage/tauriV2WorkspaceStorage.ts:414-430`), so each adopted asset is a permanent RAM cost — a phone browser must not pull the whole library. A shadow cache would need a new Tauri command (Rust work) and a second asset truth; the activation path already works identically on both platforms. Batching is *mandatory*, because each commit rewrites the whole Repo image. |
| **P6** | JWT refresh on a live socket uses an in-band `reauth` frame, with a server-side write gate at `attachment.authExpiresAt + 120 s` grace. | Reconnecting with a fresh JWT every ~50 s. | Clerk session tokens live ~60 s. Reconnecting once a minute re-runs the whole `welcome` + snapshot-decision + N-append catch-up per device (`room.ts:566-634`) and repeatedly re-exercises the `since`/`covers` edge cases that B1a exists to fix. A refresh frame keeps one socket and one catch-up per connection. |
| **P7** | On reconnect, a personal session discards its queued `append` frames and sends **one `snapshot` per dirty doc** with `covers = since[docId] ?? 0`. | Flushing the queued appends (today's behaviour, `src/collab/session.ts:153-170`). | `outQueue` drops the **oldest** frame past 1000 entries (`session.ts:161-170`). For sharing that is a cosmetic hiccup; for an offline-first personal workspace a dropped incremental change is *permanent divergence* — it is never resent. A snapshot is self-sufficient, is merged rather than replaced by peers (`session.ts:204-219`), and is cheaper than a week of appends. |
| **P8** | First contact between a local workspace and an account is a **user choice**, never an automatic merge, when both sides hold data. Options: *add the local notebooks to the account* (additive), or *load the account workspace and keep the local one as a downloadable backup*. There is no "replace" option. | Auto-merging both workspaces. | Two independently created workspaces have disjoint Automerge histories for logically identical documents; `Automerge.merge` of those duplicates content instead of reconciling it. Silent merge is the data-loss failure mode. |
| **P9** | The new module tree is **`src/personal-space/`** (transport, workspace doc, materialiser, assets) and **`src/components/personal-space/`** (UI). Wire/UX term: *space* / *persönlicher Bereich*. i18n key prefix `space.*`. | `src/sync-personal/`, `src/sync2/`. | `src/sync/` is the undeployed E2EE Appwrite design and already owns the `sync.*` i18n namespace (`src/i18n/catalog.ts:117-135`) and `src/components/sync/`. `src/collab/` owns sharing. A third distinct noun prevents both collisions. |
| **P10** | Only `src/personal-space/**` may write the local workspace from a network trigger (`commitWorkspaceGraphRevision` / `extendActiveWorkspace`). Enforced by an ESLint `no-restricted-imports` rule over `src/collab/**` and `src/components/collab/**`. | Convention only. | This is the machine-checkable form of the "a shared session never writes the local workspace" invariant (`PROTOCOL.md:269-271`). Personal sync is the single, named exception. |
| **P11** | A fresh device lists the account from page summaries published in the workspace doc and downloads page documents afterwards. `workspace:root` page entries carry an optional `summary` (title, place, tags, dates, assets, heads), written by any device that holds the page (`src/personal-space/summaryPublishing.ts`). A `hello` with `lazy: true` replays only workspace and notebook docs plus resumed pages; `fetch` frames (PROTOCOL.md) request the rest. The client lists such pages as *placeholder pages* (activation document, page-index entry flagged `placeholder`, no chunks), fetches the opened page first and the others in the background in batches of 8 (default: keep every page offline; `canvink:personal-space:offline-copies:v1 = opened` limits it to opened pages). Adoption commits carry at most 2 MB of documents. | Loading every page to read its summary on adoption; one giant adoption commit. | Loading 398 pages cost about 24 s of worker CPU and 40 MB of transfer before the sidebar showed a title, and one 30 MB IndexedDB transaction blocked every local save behind it for as long as it ran. A summary is a few hundred bytes; a bounded commit is a short transaction. |
| **P12** | The first open of a big account keeps the main thread free. A published summary is **one immutable string of JSON** (`parsePublishedSummary`, `publishSummaries`), not nested text fields: every character of a plain Automerge string is an operation, so a map of fields made the 450-page `workspace:root` several times slower to load than the same data as one value per page. A map from an older build is still read and is converted by the rewrite. The adoption commit does work in proportion to what it changes (a fingerprint that chains from the prior one, shared frozen activation entries, a storage-id cache, structural activation comparison); notebooks and page ids for the plan come from the adoption workers or the summary, never from loading them on the main thread; the background download waits for idle time between batches and shows a progress bar; the first-start jobs (materializing, staging and reopening the start workspace, the schema v2 to v3 upgrade) run in a worker (`automergeTaskClient.ts`). | Loading documents on the main thread to plan; one commit that re-validates and re-hashes every page of the activation; a status chip that shows the download only as text. | With 400 listed pages every commit canonicalised and copied every page entry, and each catch-up loaded the same 400-page notebook up to four times on the main thread. Measured with `tests/e2e/personal-space-first-open.spec.ts` (long tasks, click latency, 4x CPU throttle). |
| **P13** | Amends P10 for exactly one module, `src/components/collab/adoptSharedDocuments.ts` (ESLint override): opening a share link adds the shared notebook to the opener's workspace, and a page a collaborator adds later is adopted into it, both as topology transactions with `adoptedDocuments` (Automerge history intact). The joined notebook is an ordinary notebook of the workspace, so the personal space syncs it like any other; the room binding (`useSharedNotebookSync`) authenticates a member with the account token alone (the Worker registered the account on the first join) and the account's workspace doc records the room per joined notebook (`SpaceNotebookEntry.sharedRoomId`), so the account's other devices connect it too. The old join surface that rendered a session read-only from memory is gone. | A separate shared-session editor with in-memory documents; a copy of the notebook with its own history. | A second person needs a fully working Canvink (own notebooks, switcher, search, sync, offline) plus the shared notebook, not a reduced guest view; a copy with a new history could not merge with the room. The topology write stays in one named file instead of spreading over `src/collab/**`. |

---

## 1. Goals and non-goals

### 1.1 Goals

1. A signed-in Clerk user sees **one workspace** — the same notebooks, sections,
   pages, page content, images and PDFs — on the Tauri desktop app, on
   `https://canvink.example.com` in a desktop browser, and in a phone browser.
2. **Local-first.** Every device keeps a complete local copy of the documents it
   has adopted. Editing works fully offline; changes converge when a connection
   returns. The app never blocks an edit on the network.
3. **CRDT merge.** Concurrent edits on two devices merge via Automerge without a
   "which version do you want" prompt at the page-content level.
4. Topology changes (create/rename/reorder/delete a notebook, section or page)
   propagate and converge under a defined, non-destructive conflict rule.
5. Assets (images, PDF originals and previews) are available on every device, on
   demand, addressed by the sha256 they already carry
   (`src/domain/v2/types.ts:13-27`).
6. **Sharing keeps working, byte-for-byte unchanged**: anonymous read-only links,
   Clerk-upgraded editors, link rotation, unshare. No behavioural change to any
   route or frame described in `PROTOCOL.md`.
7. German-first UI with `en` parity (the catalog parity check in
   `src/i18n/core.ts:38-49` must stay green).

### 1.2 Non-goals (v1 of this feature)

- **No end-to-end encryption.** Personal-space content is stored plaintext in the
  DO and in R2, exactly like sharing (`PROTOCOL.md:288-290`). The separate
  `src/sync/` E2EE design stays untouched and unused; if E2EE is later wanted, it
  replaces this transport rather than layering on it.
- **No multi-user personal spaces.** One space, one `sub`. Team/family sharing
  remains the `PROTOCOL.md` room feature.
- **No presence/cursors** in the personal space. Two of the owner's own devices
  rarely edit the same page simultaneously; presence would be pure cost.
- **No server-side Automerge.** The Worker stays a dumb, opaque change relay.
- **No sync of per-device state**: the active navigation target
  (`manifest.active`), UI state, favourites, recent pages, feature overrides and
  the writer lock stay local. Syncing the cursor across devices is a misfeature,
  not a missing feature.
- **No history/snapshot sync.** `src/history/` snapshots stay device-local.
- **No conflict UI for page content.** Automerge merge is the answer. The only
  user-facing conflict decisions are P8 (first link) and hard-delete-versus-edit
  (§6.3).
- **No Rust/Tauri changes.** Everything routes through existing `v2_*` commands.

---

## 2. Architecture overview

### 2.1 Component map

```
+- Device A (Tauri desktop) ----------+   +- Device B (browser, phone) --------+
| WorkspaceV2Runtime                  |   | WorkspaceV2Runtime                 |
|  |- activation + manifest (local)   |   |  |- activation + manifest (local)  |
|  |- Repo: notebook:*/page:* handles |   |  |- Repo: notebook:*/page:* handles|
|  +- assets in SQLite via v2_* cmds  |   |  +- assets in IndexedDB            |
|            ^  ^                     |   |            ^  ^                    |
|  src/personal-space/                |   |  src/personal-space/               |
|   |- spaceSession  (WS)             |   |   |- spaceSession  (WS)            |
|   |- workspaceDoc  (Automerge)      |   |   |- workspaceDoc  (Automerge)     |
|   |- materialize   (-> runtime)     |   |   |- materialize   (-> runtime)    |
|   +- assets        (HTTPS)          |   |   +- assets        (HTTPS)         |
+----------+------------------+-------+   +--------+-----------------+---------+
           | WSS              | HTTPS              | WSS             | HTTPS
           v                  v                    v                 v
+-----------------------------------------------------------------------------+
| Cloudflare Worker  canvink-collab-sync                                      |
|  /api/v1/rooms/*      -> NotebookRoom  (kind = "shared")    [unchanged]     |
|  /api/v1/me/space*    -> NotebookRoom  (kind = "personal")  [new]           |
|  /api/v1/me/assets/*  -> R2 bucket ASSETS                   [new]           |
+-----------------------------------------------------------------------------+
```

The personal room is the **same Durable Object class**, instantiated under a
different name. Room identity:

```
spaceId = base64url( HMAC-SHA256( key = PERSONAL_SPACE_SALT,
                                  msg = "canvink-space-v1:" + sub ) ).slice(0, 22)
DO id   = env.NOTEBOOK_ROOM.idFromName(spaceId)
```

`spaceId` is deterministic (a fresh device derives the same one with no index
lookup and no extra storage), unguessable without the salt, and **not a
credential**: knowing it grants nothing, because every personal route still
verifies the Clerk JWT and compares `sub` against `meta.personalSub`. It is
derived server-side only; a client-supplied `spaceId` is never trusted for
authorization or for an R2 key.

The WebSocket endpoint is the existing `GET /api/v1/rooms/:roomId/ws` with
`roomId = spaceId`. This is deliberate: no secret ever travels in a WebSocket
URL (browsers cannot set headers on an upgrade, and Workers observability logs
request URLs but not headers — the same reasoning that produced the
`X-Link-Secret` rule, `PROTOCOL.md:121-126`). The credential still travels only
inside the `hello` frame.

### 2.2 The three synchronised layers

| Layer | Transport | Merge | Local landing place |
|-------|-----------|-------|---------------------|
| Page/notebook document content | WS change log, `docId = page:<id>` / `notebook:<id>` | Automerge | live `DocHandle` in the Repo (`workspaceV2Runtime.getPageHandle` / `getNotebookHandle`) |
| Workspace topology + asset manifest | WS change log, `docId = workspace:root`, `kind = "workspace"` | Automerge (map of records, fractional order keys, tombstones) | the activation manifest, via `commitWorkspaceGraphRevision` |
| Asset bytes | HTTPS `PUT`/`GET`/`HEAD` to R2 through the Worker | content-addressed, immutable | activation assets, via batched `commitWorkspaceGraphRevision({ assets })` |

Separating layer 2 from layer 1 is the crux of the design. Content merges
continuously and cheaply into live handles; topology merges into a
compare-and-swap-guarded activation transaction that can only run one at a time
(`src/storage/workspaceV2Runtime.ts:469-482`, `:1003-1005`). Mixing them would
force an activation rewrite on every keystroke.

### 2.3 Sequence: first sign-in on a device that already has a workspace, account empty (bootstrap A / push)

```
User            App (personal-space)         Worker/DO                    R2
 |  sign in ------>|
 |                 | POST /api/v1/me/space   -----> derive spaceId from sub
 |                 |   Authorization: Bearer        DO: meta.kind absent
 |                 |                                 => init kind=personal,
 |                 |                                    personalSub=sub
 |                 |<-- 201 { spaceId, kind:"personal", docCount:0, assetBytes:0 }
 |                 |
 |                 | docCount = 0 and no local link record => PUSH, no dialog
 |                 | WS connect /api/v1/rooms/<spaceId>/ws
 |                 | hello { auth:{kind:"personal",jwt}, since:{} }
 |                 |<-- welcome { role:"owner", docs:[], notebookTitle:"" }
 |                 |<-- synced
 |                 |
 |                 | build workspace:root from the local manifest
 |                 | announce workspace:root (kind "workspace")
 |                 | snapshot workspace:root  covers 0
 |                 | for each notebook/page document in activation.documents:
 |                 |   announce <docId>; snapshot <docId> covers 0
 |                 |     (Automerge.save of the live handle)
 |                 |<-- seq acks
 |                 | persist link record { spaceId, sub, linkedAt }
 |                 | upload assets (2.5) in the background ----> PUT --> store
 |<- "Synchronisiert"
```

`Automerge.save(handle.doc())` is exactly what the sharing path already uploads
(`src/components/collab/realCollabGateway.ts:122-130`), so the initial upload is
a known-good operation, applied to the whole workspace instead of one notebook.

### 2.4 Sequence: fresh device pulls the account workspace (bootstrap C / pull)

```
App start        runtime                    personal-space                Worker/DO
 | startup() -----> no activation
 |                  => V1RuntimeState (empty v1 workspace)
 | sign in ----------------------------------> POST /api/v1/me/space
 |                                             <-- 200 { spaceId, docCount: 137 }
 |                                             no link record + docCount>0 + the
 |                                             local workspace is the untouched
 |                                             default  => PULL, no dialog
 | migrateV1ToV2() -> activation v2
 | ensureSchemaV3() -> activation v3 (1 starter notebook, 1 section, 1 page)
 |                                             WS connect, hello since:{}
 |                                             <-- welcome docs[137]
 |                                             <-- snapshot/append x 137
 |                                             <-- synced
 |                                             build the target plan from
 |                                             workspace:root (5.4)
 |<-----------------  commitWorkspaceGraphRevision({
 |                      operationId: "space-adopt-<n>",
 |                      adoptedDocuments: [ ...136 docs with their bytes... ],
 |                      removedDocumentIds: [ starter notebook + starter page ],
 |                      updateManifest: rewrite notebookDocumentIds /
 |                                      pageDocumentIds / trash,
 |                    })
 |  reopen activation, render
 |  assets: NOT downloaded; previews render a placeholder until demanded
```

The starter notebook and page created by the v1-to-v3 migration are purged **in
the same transaction** iff they are still pristine (single section, single page,
`Object.keys(elementsById).length === 0`, title equal to the freshly generated
default). If the user typed anything into them before the pull, they are kept and
simply become one more notebook in the account, and are pushed up.

### 2.5 Sequence: a live edit on A reaches B, with an image

```
Device A                         DO (personal room)                 Device B
 | user draws on page:p1
 | handle.change(...)  (PageWriteSession.change, workspaceV2Runtime.ts:603-614)
 | port.subscribe onChange -> Automerge.saveSince(doc, lastSyncedHeads)
 | append { docId:"page:p1", payload } ----> seq = N
 |                                 |-- broadcast append(seq N) ------> applyAppend
 |<-- seq ack N                    |                                  -> port.applyRemote
 |  (every 64 acks => snapshot)    |                                  -> handle.update(loadIncremental)
 |                                 |                                  -> debounced runtime.flush()
 |
 | user inserts photo.jpg
 | AssetWorkspaceControls stages the blob,
 |   commitTopology({ assets:[blob], changes:[...] })
 |   => the local activation now holds sha256:abc... and page:p1 references it
 | uploader diff: activation.assetIds minus workspaceDoc.assets
 | HEAD /api/v1/me/assets/sha256:abc...  --> 404
 | PUT  /api/v1/me/assets/sha256:abc...  --> R2 put(key, body, { sha256 }) => 201
 | workspaceDoc.assets["sha256:abc..."] = { size, mimeType, addedAt }
 | append { docId:"workspace:root", ... } --> broadcast --------------> B merges
 |                                                                     B shows the
 |                                                                     element with
 |                                                                     a placeholder
 |                                                              user scrolls to it
 |                                             <-- GET /api/v1/me/assets/sha256:abc...
 |                                             --> 200 bytes
 |                                             B batches for ~2 s, then
 |                                             commitWorkspaceGraphRevision({assets})
 |                                             image renders
```

### 2.6 Sequence: token refresh on a long-lived socket

```
t=0     hello { kind:"personal", jwt(exp=t+60) }  => attachment.authExpiresAt = t+60
t=45    client timer fires: getToken() -> fresh jwt
        reauth { jwt }                            => verify, authExpiresAt = t+105
        <-- reauthed { expiresAt: t+105 }
t=45..  writes accepted
...
device sleeps; laptop wakes at t=4000
        client 'visibilitychange'/'online' => immediate reauth with a fresh token
        if the socket was actually dead, onclose already scheduled a reconnect
        that uses the P7 snapshot-resync path
server  any append/snapshot/announce/remove on a personal socket with
        now > authExpiresAt + 120 => error unauthorized + close 4401
```

---

## 3. Protocol additions

All additions are **additive**. Every existing frame and route keeps its exact
current shape and semantics.

### 3.1 Room kinds

`meta.kind` is a new row in the DO's `meta` table with value `"shared"` or
`"personal"`.

- Rooms created through `POST /api/v1/rooms` set `kind = "shared"` (and
  `ownerTokenHash`, as today).
- Rooms created through `POST /api/v1/me/space` set `kind = "personal"` and
  `personalSub = <sub>`, and **never** store an `ownerTokenHash`.
- `roomExists()` becomes
  `getMetaValue("ownerTokenHash") !== null || getMetaValue("personalSub") !== null`
  (today it is only the former, `room.ts:171-173`).
- **Cross-kind refusal, both directions, no exceptions:**
  - In a room with `kind === "personal"`: `POST|DELETE /links`,
    `DELETE /collaborators`, `DELETE /` (unshare), and any `hello.auth.kind` of
    `owner` / `link` / `user`, return `403 {"error":"not-a-shared-room"}` or
    `unauthorized` + close `4401`.
  - In a room with `kind === "shared"` (or a legacy room with no `kind` row,
    which is treated as `"shared"`): `hello.auth.kind === "personal"` and every
    `/me/space*` route are rejected the same way.
  - Consequence: a personal space can never be link-shared, never be deleted by
    a bearer token, and never be reached without a live Clerk session.

### 3.2 New auth kind

```jsonc
// client -> server, inside hello
{ "kind": "personal", "jwt": "<clerk session token>" }
```

Resolution in `resolveWsRole` (extends `room.ts:514-547`):

```
kind === "personal":
  if meta.kind !== "personal"             -> null (unauthorized)
  identity = verifyBearerToken(jwt, env)   // throws => null
  if identity.sub !== meta.personalSub     -> null
  return { role: "owner", sub: identity.sub, authExpiresAt: identity.exp }
```

`verifyBearerToken` must also return `exp`. Change in
`services/collab-sync/src/auth/clerk.ts`:

```ts
export interface VerifiedIdentity { sub: string; exp: number }
```

- `verifyClerkJwt` already requires a numeric `exp` (`clerk.ts:121-122`); return it.
- `verifyTestShim` returns a synthetic `exp = Math.floor(Date.now()/1000) + 3600`.
  The shim token format stays `test:<sub>:<hmac>`, so every existing test keeps
  passing unmodified.

`SocketAttachment` gains `authExpiresAt?: number` (Unix seconds). It is absent on
shared-room sockets, and its absence means "no expiry gate" — i.e. sharing
behaviour is unchanged. That asymmetry is intentional and accepted: a registered
collaborator's socket still outlives its JWT, exactly as today.

### 3.3 New document kind

`DocKind` becomes `"notebook" | "page" | "workspace"`.

- Server: `isValidAnnounceFrame` (`room.ts:93-95`) accepts `"workspace"`.
  `docs.kind` is already a free-form `TEXT` column (`room.ts:127`), so there is
  no SQL schema change.
- Client: `src/collab/protocol.ts:6` and the `welcome`/`announce` parsers
  (`:151`, `:176`) accept `"workspace"`.
- A `workspace` doc is only legal in a personal room. An `announce`/`snapshot`
  with `kind === "workspace"` or `docId === "workspace:root"` in a shared room is
  rejected with a non-fatal `bad-frame`, so a buggy or hostile client cannot
  smuggle a personal-shaped doc into a shared notebook.
- Exactly one workspace doc per personal room: the `docId` must equal
  `"workspace:root"`; any other `kind:"workspace"` docId is a `bad-frame`.

### 3.4 New frames

**Client -> server**

```jsonc
{ "t": "reauth", "jwt": "<fresh clerk session token>" }
```

- Valid only on a socket whose attachment has `role === "owner"` and
  `authExpiresAt !== undefined` (i.e. a personal socket). On a shared socket it
  is a non-fatal `bad-frame`.
- The server verifies it; the resolved `sub` **must equal** the socket's existing
  `attachment.sub`. A different `sub` is a fatal `unauthorized` + close `4401` —
  a socket never changes identity, the same rule that refuses a second `hello`
  (`README.md:138-140`).
- On success the DO rewrites the attachment with the new `authExpiresAt` and
  answers `reauthed`.

**Server -> client**

```jsonc
{ "t": "reauthed", "expiresAt": 1788888888 }
```

Client parser addition in `parseServerFrame`: `expiresAt` must be a finite number.

**New error code**

`ErrorCode` gains `"quota-exceeded"` (used by the asset routes and by the
per-space byte budget, §7). On a WebSocket it is **non-fatal**: the frame is
dropped, the socket stays open, and the client shows a persistent warning.

### 3.5 New HTTP routes

All under `/api/v1`, all requiring `Authorization: Bearer <clerk jwt>`, all
CORS-shielded by the existing `ALLOWED_ORIGINS` mechanism — which is a response
shield, not an authorization gate (`README.md:102-110`).

#### `POST /api/v1/me/space`

Idempotent: creates the personal room on the first call, returns its descriptor
on every call. No request body.

```jsonc
// 201 (created) or 200 (already existed)
{
  "spaceId": "b7Qk3xJm2pL9wR4tYc0nZa",
  "kind": "personal",
  "docCount": 137,
  "logBytes": 4823991,
  "assetCount": 42,
  "assetBytes": 118374625,
  "quota": { "logBytes": 1073741824, "assetBytes": 2147483648, "maxAssetBytes": 67108864 },
  "createdAt": "2026-09-02T10:00:00.000Z"
}
```

Errors: `401 {"error":"unauthorized"}` (missing or invalid JWT);
`409 {"error":"space-owned-by-another-subject"}` (impossible given the
derivation, but the DO fails closed if `personalSub` disagrees);
`503 {"error":"personal-space-not-configured"}` when `PERSONAL_SPACE_SALT` is
unset.

Rate limit: `checkRoomCreationRateLimit` keyed on the **`sub`**, not the IP —
30 calls / 60 s, with the same best-effort per-isolate caveat as
`README.md:71-94`.

#### `GET /api/v1/me/space`

The same response body, no side effects. `404 {"error":"not-found"}` if the space
was never created.

#### `HEAD /api/v1/me/assets/:assetId`

`assetId` is the canonical `sha256:<64 hex>` form used throughout the app
(`src/domain/v2/types.ts:4`), URL-encoded as `sha256%3A<hex>`; the Worker also
accepts a bare 64-hex form. Anything else is `400 {"error":"bad-asset-id"}`.

- `200` with `content-length` and `content-type` when present.
- `404` when absent.

#### `PUT /api/v1/me/assets/:assetId`

Body: raw bytes. Headers: `content-type` (stored as `httpMetadata.contentType`)
and `content-length` (required).

```ts
const key = "spaces/" + spaceId + "/" + hexPart;
await env.ASSETS.put(key, request.body, {
  sha256: hexPart,                 // R2 verifies server-side; a mismatch fails the put
  httpMetadata: { contentType, cacheControl: "private, max-age=31536000, immutable" },
  customMetadata: { size: String(contentLength) },
});
```

- `201 {"assetId":"sha256:...","size":n}` on a fresh store;
  `200 {"assetId":"sha256:...","size":n,"deduplicated":true}` when a preceding
  `head` shows it already exists.
- `400 {"error":"checksum-mismatch"}` when R2 rejects the checksum. The bytes are
  not stored.
- `413 {"error":"asset-too-large"}` when `content-length > 64 MiB`.
- `413 {"error":"quota-exceeded"}` when the space's stored bytes would exceed the
  asset quota.
- `411 {"error":"length-required"}` when `content-length` is missing.

`request.body` is streamed straight into `env.ASSETS.put`; the Worker never
buffers the asset. That is precisely why the checksum is delegated to R2's
`sha256` option instead of being computed in the Worker — computing it would
require buffering the whole object in isolate memory.

#### `GET /api/v1/me/assets/:assetId`

`200` with the bytes, `content-type` from `httpMetadata`, and
`cache-control: private, max-age=31536000, immutable` (content-addressed, hence
genuinely immutable). `404` when absent. A `Range` request is forwarded to R2's
`range` option so a large PDF can resume.

#### `DELETE /api/v1/me/assets/:assetId`

Used only by the explicit "Papierkorb endgültig leeren" flow. `204` always
(idempotent). It is never called automatically: an asset may still be referenced
by a page whose change another device has not uploaded yet, so automatic GC is a
data-loss hazard and is deliberately out of scope for v1.

### 3.6 Space accounting

The DO keeps counters in `meta` so quota checks are O(1) instead of a `SUM` over
the whole `changes` table:

- `logBytes`: incremented by `payload.byteLength` on every accepted
  `append`/`snapshot`; decremented by the byte length of the rows a snapshot's
  compaction deletes and of everything a `remove` deletes. Recomputed lazily
  (a full `SUM`) if the row is missing.
- `assetBytes` / `assetCount`: updated by the asset routes.

The asset routes and the room share the same DO instance (both are routed to
`idFromName(spaceId)`), so these updates are serialised with the WebSocket
handlers and need no extra locking. That is a second, quieter reason to route
assets through the DO's namespace rather than straight from the Worker to R2.

### 3.7 Desktop sign-in through the system browser

Added 2026-09-25. The Tauri desktop app never loads Clerk (Clerk's production
Frontend API rejects the WebView origin `http://tauri.localhost`). It signs in
the way Slack or Spotify do: the default browser opens
`https://canvink.example.com/desktop-login`, Clerk runs there, and the browser
hands a one-time code back to the app through the `canvink://` URL scheme. The
app exchanges the code for its own device credential. This is OAuth 2.0 for
native apps (RFC 8252) with PKCE (RFC 7636, S256 only); the Worker is the
authorization server and the Clerk session is the user authentication.

1. The app (Rust side) creates a PKCE verifier, its S256 challenge and a
   `state` value, and opens
   `/desktop-login?challenge=<43 chars>&state=<16..128 chars>` in the default browser
   (an Android app adds `&platform=android`, which only changes the page's wording;
   see `docs/social-sign-in.md`).
2. The page requires a Clerk session (the existing sign-in modal), then asks
   for one click on "Anmelden" (no silent issue, so a link someone sends cannot
   sign a desktop in unnoticed) and calls `POST /api/v1/device/code` with the
   Clerk JWT and the challenge.
3. The Worker stores a one-time code in the caller's personal-space DO:
   SHA-256 of the secret, the challenge, the verified `name`/`picture` claims,
   expiry 120 s. It returns `code = <spaceId>.<secret>`.
4. The page navigates to `canvink://auth?code=…&state=…` and polls
   `POST /api/v1/device/code/status` until the code reads `used` (the app has
   it: "Canvink Desktop ist angemeldet") or `expired`. It always offers
   "Code anzeigen" as a fallback for a blocked or declined scheme prompt.
5. The app checks `state`, then calls `POST /api/v1/device/token`
   `{grant_type:"authorization_code", code, code_verifier, device_name, install_id?, platform?, app_version?}`.
   The DO burns the code on the first attempt whatever the outcome, checks
   expiry and `base64url(SHA-256(verifier)) == challenge`, creates a device row
   and returns the credential.

**Tokens.** The refresh token `cvr1.<spaceId>.<deviceId>.<secret>` is stored by
the app (Windows DPAPI, see `src-tauri/src/desktop_auth.rs`) and rotates on
every refresh. The access token is an HS256 JWS (`kid:"canvink-device-v1"`,
key `DEVICE_TOKEN_SECRET`) with `sub`, `did`, `exp` (10 min) and the `name` and
`picture` captured at sign-in, so presence keeps showing them
(`stampVerifiedProfile`). `verifySpaceToken` accepts it wherever a route
accepted a Clerk JWT: `/me/space`, `/me/assets/*`, the personal `hello` and
`reauth`, and in shared notebooks the `user` hello and the bearer `meta` check,
so a signed-in desktop can edit a shared notebook like the web app. A socket
authenticated by a device keeps that device on `reauth`. Each of these checks
also confirms the device is still signed in; a shared room asks the owner's
personal-space DO (`GET /devices/active/:id`).

**Routes.**

| Route | Credential | Result |
|---|---|---|
| `POST /api/v1/device/code` `{challenge, method?:"S256"}` | Clerk JWT only | `201 {code, expires_in:120}`; `409 too-many-devices` at 20 devices; 10 per minute per account |
| `POST /api/v1/device/code/status` `{code}` | Clerk JWT only | `{status: pending \| used \| expired \| unknown}` |
| `POST /api/v1/device/token` | none (code + verifier, or refresh token) | `{token_type, access_token, expires_in, refresh_token, device_id, user}`; `400 invalid_grant`; 30 per minute per IP |
| `GET /api/v1/me/devices` | Clerk JWT only | `{devices:[{id, label, createdAt, lastUsedAt}]}` |
| `PATCH /api/v1/me/devices/:id` `{label}` | Clerk JWT only | `200 {id, label}`; `404` for a device of another account |
| `DELETE /api/v1/me/devices/:id` | Clerk JWT, or the device's own access token | `204`, idempotent; `403` for another device's token |

**One installation, one device.** The app keeps a random `install_id` next to
(not inside) its credential and sends it with `platform`
(`windows|macos|linux|android|ios`) and `app_version`. A code exchange with a
known `install_id` revokes that installation's older rows first, so signing in
again (a sign-out that never reached the Worker, a reset credential) no longer
adds an entry. Without it (older apps) every sign-in stays its own device. A
refresh may carry a newer `app_version`. `GET /me/devices` adds `platform` and
`appVersion` when known; rows from before have neither, and the web app derives
platform and name from the old `"HOST (Windows)"` label.

**Revocation.** Deleting the device row closes that device's personal-space
sockets with `4401` at once (an open shared-notebook socket stays until it
reconnects, as after a Clerk sign-out; a new `hello` is refused). Its refresh token stops working, and because the Worker passes
the verified device id to the DO (`X-Canvink-Device-Id`, built by the Worker
only), `/me/space`, `/me/assets/*`, `hello` and `reauth` refuse its remaining
access token too. A device that has not refreshed for 90 days counts as signed
out. A replayed code signs out the device it issued; an old refresh token that
comes back more than 30 s after its rotation signs the device out (inside those
30 s one retry after a lost response is allowed).

**Device limits.** A device token can neither request a code nor list devices,
so a stolen device credential cannot mint new devices or survive its own
revocation.

---

## 4. Storage schema

### 4.1 Durable Object SQLite

The existing schema (`PROTOCOL.md:226-233`, `room.ts:120-132`) is unchanged. Only
new `meta` keys are added:

```sql
-- unchanged
CREATE TABLE IF NOT EXISTS meta         (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS links        (secretHash TEXT PRIMARY KEY, createdAt TEXT);
CREATE TABLE IF NOT EXISTS collaborators(sub TEXT PRIMARY KEY, addedAt TEXT);
CREATE TABLE IF NOT EXISTS docs         (docId TEXT PRIMARY KEY, kind TEXT, snapshot BLOB, covers INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS changes      (docId TEXT, seq INTEGER, payload BLOB, PRIMARY KEY (docId, seq));
```

`meta` keys:

| key | shared room | personal room |
|-----|-------------|---------------|
| `kind` | `"shared"` (absent in legacy rooms, treated as shared) | `"personal"` |
| `notebookTitle` | as today | absent; `welcome.notebookTitle` is `""` |
| `ownerTokenHash` | as today | **must never exist** |
| `createdAt` | as today | as today |
| `personalSub` | absent | the Clerk `sub` |
| `logBytes` | absent | decimal string |
| `assetCount`, `assetBytes` | absent | decimal string |

In a personal room `links` and `collaborators` stay permanently empty; a row in
either is a bug, and the DO asserts emptiness when it initialises a personal room.

`welcome.notebookTitle: ""` needs no client parser change — `parseServerFrame`
only requires a string (`src/collab/protocol.ts:145`).

### 4.2 R2 bucket layout

Binding name `ASSETS`, bucket `canvink-personal-assets`.

```
spaces/<spaceId>/<sha256hex>          <- asset bytes, immutable
```

- No other prefix exists. A request can never address an object outside its own
  `spaces/<spaceId>/` prefix: `spaceId` is derived from the verified JWT inside
  the Worker, and the `assetId` path segment is validated to be exactly 64
  lowercase hex characters *before* concatenation. No `/`, `.` or `%` survives
  that validation, so there is no traversal surface.
- Objects are never overwritten with different content (content-addressed plus an
  R2-verified checksum), so `cache-control: immutable` is honest.
- `customMetadata.size` mirrors `content-length`, so `HEAD` answers without a
  range read.
- Deleting a space (not implemented in v1) would be a `list(prefix)` + `delete`
  loop; noted so the eventual "Konto löschen" flow has a defined shape.

### 4.3 The workspace CRDT document

An Automerge document with `docId "workspace:root"`, `kind "workspace"`. It lives
only in the personal-space session's in-memory doc set plus one persisted cache
copy (§5.6). It is **never** added to the activation, never enters the Repo, and
therefore never has to satisfy `assertCanvinkAutomergeDocument`.

```ts
/** src/personal-space/contract.ts */
export interface SpaceWorkspaceDocV1 {
  v: 1;
  /** Notebook roots, keyed by their canonical documentId `notebook:<notebookId>`. */
  notebooks: Record<string, SpaceNotebookEntry>;
  /** Page documents, keyed by `page:<pageId>`. */
  pages: Record<string, SpacePageEntry>;
  /** Asset manifest: which content hashes exist in this space's R2 prefix. */
  assets: Record<string, SpaceAssetEntry>;
}

export interface SpaceNotebookEntry {
  /** Fractional index; sort ascending, tie-break by documentId. */
  order: string;
  addedAt: string;          // ISO 8601
  /** Soft delete (trash). Never removed from the map while soft-deleted. */
  deletedAt?: string;
  /** Hard delete. Set only by an explicit confirmed purge; see 6.3. */
  purgedAt?: string;
}

export interface SpacePageEntry {
  /** Owning notebook root documentId. A page never changes notebooks in place;
   *  a move is remove-here + add-there inside the notebook docs' `sections`. */
  notebookDocumentId: string;
  addedAt: string;
  deletedAt?: string;
  purgedAt?: string;
}

export interface SpaceAssetEntry {
  size: number;
  mimeType: string;
  addedAt: string;
}
```

Deliberate omissions, and why:

- **Section and page *order* are not here.** They already live inside the notebook
  document (`NotebookDoc.sections[].pageDocumentIds`,
  `src/domain/v2/types.ts:183-197`), which is itself an Automerge doc syncing
  through layer 1. Duplicating them would create two orderings that can disagree.
  The workspace doc only answers "does this page belong to this space, and to
  which notebook root" — which the notebook doc cannot answer for a *deleted*
  notebook.
- **Notebook order is here**, because notebook ordering lives in the manifest
  (`manifest.notebookDocumentIds`, reordered by `transferNotebook` in
  `src/components/V2NotebookApp.tsx` via `moveIdByPlacement`), and the manifest is
  not a CRDT.
- `order` is a **fractional index string** (`"a0"`, `"a0V"`, `"a1"`, ...), not a
  list position. A reorder rewrites exactly one scalar, which is a
  last-writer-wins register under Automerge merge: deterministic and
  duplication-free. Concurrent reorders can produce an unexpected but *valid*
  order; a concurrent Automerge list insert can produce a *duplicated or lost*
  entry, which is why the list form is rejected.
- Tombstones (`deletedAt`) are never removed while the entry is soft-deleted, so
  "delete on A, edit on B" cannot resurrect as a duplicate (§6.3).

---

## 5. Client architecture

### 5.1 Module tree

```
src/personal-space/
  contract.ts            # types only: SpaceWorkspaceDocV1, status, ports, config.
                         # Wave-0 seed; every other wave imports from here.
  http.ts                # POST/GET /me/space, HEAD/PUT/GET/DELETE /me/assets
  spaceSession.ts        # wrapper over openRoomSession: personal auth,
                         # reauth timer, P7 snapshot-resync, status machine
  workspaceDoc.ts        # pure: build/read/mutate SpaceWorkspaceDocV1
  fractionalOrder.ts     # pure: keyBetween(a, b) + sort helpers
  manifestProjection.ts  # pure: (SpaceWorkspaceDocV1, activation) -> SpacePlan
  materialize.ts         # applies a SpacePlan through WorkspaceV2Runtime
  runtimeSpacePort.ts    # EditorLocalDocsPort over the *whole* workspace
  assets/
    assetSyncQueue.ts    # upload diff, lazy download, batched adoption
  linkStore.ts           # localStorage record { spaceId, sub, linkedAt }
  index.ts

src/components/personal-space/
  usePersonalSpaceSync.ts     # the single React binding
  SpaceStatusIndicator.tsx    # topbar chip
  AccountMenu.tsx             # sign in / sign out / space info
  SpaceLinkDialog.tsx         # the P8 first-contact choice
  index.ts
```

### 5.2 `contract.ts` (wave-0 seed: write this file first)

Beyond `SpaceWorkspaceDocV1` (§4.3) it declares:

```ts
export type SpaceStatus =
  | { kind: 'disabled' }        // no VITE_PERSONAL_SPACE / no Clerk / no sync URL
  | { kind: 'signed-out' }
  | { kind: 'link-required'; localHasData: boolean; remoteDocCount: number }
  | { kind: 'bootstrapping'; phase: 'push' | 'pull' | 'adopt' }
  | { kind: 'synced'; lastSyncedAt: string }
  | { kind: 'offline'; pendingDocs: number }
  | { kind: 'reconnecting' }
  | { kind: 'quota-exceeded'; scope: 'log' | 'assets' }
  | { kind: 'error'; message: string };

export interface SpaceDescriptor {
  spaceId: string; kind: 'personal'; docCount: number; logBytes: number;
  assetCount: number; assetBytes: number; createdAt: string;
  quota: { logBytes: number; assetBytes: number; maxAssetBytes: number };
}

export interface SpaceLinkRecord { spaceId: string; sub: string; linkedAt: string }

/** Everything materialize.ts must apply to the local workspace. */
export interface SpacePlan {
  adoptedDocuments: Array<{ documentId: string; kind: 'notebook' | 'page'; bytes: Uint8Array }>;
  removedDocumentIds: string[];
  notebookDocumentIds: string[];   // full replacement order for the manifest
  pageDocumentIds: string[];       // full replacement list for the manifest
  trashAdditions: Array<{ documentId: string; kind: 'notebook' | 'page'; deletedAt: string }>;
  trashRemovals: string[];
}

export const SPACE_WORKSPACE_DOC_ID = 'workspace:root';
export const SPACE_ADOPT_BATCH_MS = 2_000;
export const SPACE_ASSET_BATCH_MS = 2_000;
export const SPACE_MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const SPACE_MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const SPACE_REAUTH_MARGIN_S = 15;
export const SPACE_WORKSPACE_DOC_COMPACT_EVERY = 32;
```

### 5.3 `spaceSession.ts`

Wraps `openRoomSession` (`src/collab/session.ts:103`) rather than replacing it.
Required additions to `src/collab/session.ts` (owned by wave 2, additive only):

1. `AuthCredential` gains `PersonalAuth = { kind: 'personal'; jwt: string }`
   (`src/collab/protocol.ts:27`).
2. `OpenRoomSessionOptions` gains:
   - `getAuth?(): Promise<AuthCredential>` — called before **every** connect
     attempt, so a reconnect after a long sleep uses a fresh JWT instead of the
     expired one captured at construction. When absent, `options.auth` is used,
     which is today's behaviour, so sharing is unaffected.
   - `resyncStrategy?: 'queue' | 'snapshot'` — default `'queue'` (today's
     behaviour). `'snapshot'` implements P7.
   - `getFullSnapshotBytes?(docId): Uint8Array | undefined` — required when
     `resyncStrategy === 'snapshot'`.
3. `RoomSession` gains `sendReauth(jwt: string): void` and
   `subscribeReauthed(listener: (expiresAt: number) => void): () => void`.
4. `'snapshot'` resync behaviour: while `status !== 'live'`, `sendLocalChange`
   records `docId` in a `dirtyDocIds` set and does **not** enqueue the payload. On
   `synced`, for each `docId` in `dirtyDocIds` it sends
   `snapshot(docId, getFullSnapshotBytes(docId), since[docId] ?? 0)` and clears the
   set. `announce`/`remove` frames still queue normally — they are tiny and
   order-sensitive — and are flushed *before* the snapshots.

Why `covers = since[docId] ?? 0` is sound: `since[docId]` is by definition the
highest seq this client has already merged, so its full save genuinely covers
everything up to that seq. The server keeps every change with a higher seq
(`room.ts:762`), so a change another device made while this one was offline is
still delivered afterwards, and peers *merge* rather than replace an incoming
snapshot (`session.ts:204-219`). This is the same argument that makes ack-driven
compaction sound (`PROTOCOL.md:211-222`), applied at reconnect time.

Before sending any snapshot the session asserts
`bytes.byteLength <= SPACE_MAX_SNAPSHOT_BYTES`; see §7 for what happens when a
single page exceeds the frame limit.

`spaceSession.ts` itself owns:

- The reauth timer: a `setTimeout` at
  `(expiresAt - now - SPACE_REAUTH_MARGIN_S)` seconds, minimum 5 s, rescheduled on
  every `reauthed`; plus an immediate reauth on
  `document.visibilitychange -> visible` and on `window.online`.
- The `SpaceStatus` machine, mapping `ConnectionStatus` plus
  `quota-exceeded`/`unauthorized` errors onto `SpaceStatus`.
- A `PersonalSpaceSession` facade, so no UI file imports `src/collab/` directly.

### 5.4 `manifestProjection.ts` (pure; the heart of the merge)

```ts
export function projectSpacePlan(input: {
  workspaceDoc: SpaceWorkspaceDocV1;
  /** Full Automerge saves for the docs the session holds, keyed by docId. */
  remoteDocBytes: ReadonlyMap<string, Uint8Array>;
  activation: V2ActivationRecord;
}): SpacePlan;
```

Rules, in order:

1. **Adopt**: for every `notebooks`/`pages` entry without `purgedAt` whose
   `documentId` is absent from `activation.documents`, emit an `adoptedDocuments`
   entry using `remoteDocBytes`. If the bytes are missing (catch-up still
   running), the entry is skipped this round and retried on the next
   `docsChanged`; a plan is always internally consistent, never partial.
2. **Referential integrity**: a page is adopted only if its `notebookDocumentId`
   is adopted or already local. A notebook is adopted only if every page its
   sections reference is available, because a dangling reference fails
   `validateWorkspaceGraph` (`workspaceV2Runtime.ts:290-312`) and would abort the
   whole transaction. Unsatisfied entries are deferred, never dropped.
3. **Purge**: for every entry with `purgedAt` whose `documentId` is present in
   `activation.documents`, emit `removedDocumentIds`.
4. **Order**: `notebookDocumentIds` is every non-purged notebook entry sorted by
   `(order, documentId)`, followed by any purely local notebook not yet in the
   workspace doc, in its current manifest order. `pageDocumentIds` is the union of
   every adopted and local page; order is irrelevant there because the manifest
   uses it as a set (`workspaceV2Runtime.ts:271-278`).
5. **Trash**: `deletedAt` entries become `TrashRecordV3` additions
   (`kind: 'notebook' | 'page'`, `notebookDocumentId`/`pageDocumentId`,
   `origin: { source: 'personal-space' }`); entries whose `deletedAt` was cleared
   remotely become `trashRemovals`.
6. The function is **total and deterministic**: the same inputs always produce the
   same plan. No I/O, no clock, no randomness — timestamps come from the doc. That
   is what makes it unit-testable without a runtime, and it is why it is a
   separate file from `materialize.ts`.

### 5.5 `materialize.ts`

```ts
export async function applySpacePlan(
  runtime: WorkspaceV2Runtime,
  plan: SpacePlan,
  options: { operationId: string; message: string },
): Promise<V2RuntimeState | null>;
```

- Returns `null` (no-op) when the plan is empty in every field.
- Otherwise calls `runtime.commitWorkspaceGraphRevision` **once**, with
  `adoptedDocuments`, `removedDocumentIds`, and an `updateManifest` that replaces
  `notebookDocumentIds`/`pageDocumentIds` and applies the trash delta.
- Catches the "activation changed" conflict (`workspaceV2Runtime.ts:1003-1005`),
  re-reads `runtime.getState()`, re-projects, and retries **once**; a second
  conflict defers to the next `docsChanged` tick. It never loops.
- Debounced by `SPACE_ADOPT_BATCH_MS`, so a 137-document catch-up produces one
  transaction rather than 137.

**The only required runtime change in this whole design.**
`WorkspaceGraphRevisionRequest` (`src/storage/workspaceV2Runtime.ts:191-202`)
gains:

```ts
  /**
   * Documents adopted from a remote peer WITH their Automerge history intact.
   * Unlike `newDocuments` (JSON projections re-materialised into brand-new
   * Automerge documents by `materializeImportedDocuments`), these bytes are
   * handed to `stageAutomergeWorkspaceRevision` as-is, which imports them via
   * `repo.import(bytes)` (`src/storage/v2WorkspaceStorage.ts:642`) and thereby
   * preserves the shared history that makes later merges converge.
   */
  adoptedDocuments?: Array<{
    documentId: string;
    kind: 'notebook' | 'page';
    bytes: Uint8Array;
  }>;
```

Implementation, inside `commitWorkspaceGraphRevisionInternal`, between the
existing `materializeImportedDocuments` call and `stageAutomergeWorkspaceRevision`
(`workspaceV2Runtime.ts:1021-1036`):

```ts
const adopted: StoredCanvinkDocument[] = (request.adoptedDocuments ?? []).map((entry) => {
  const document = loadAutomergeDocument(entry.bytes, {
    expectedDocumentId: entry.documentId,
    expectedKind: entry.kind,
    expectedSchemaVersion: open.activation.schemaVersion,
  });
  return {
    documentId: entry.documentId,
    kind: entry.kind,
    schemaVersion: open.activation.schemaVersion,
    documentFormat: 'automerge',
    encoding: 'binary',
    version: { protocol: 'automerge', heads: getAutomergeHeads(document) },
    bytes: entry.bytes,
  } as StoredCanvinkDocument;
});
const staged = await stageAutomergeWorkspaceRevision(
  chunks,
  currentDocuments,
  (request.changes ?? []).map((change) => ({ ...change, message: request.message })),
  [...newDocuments, ...adopted],
  request.removedDocumentIds,
);
```

Everything downstream — chunk descriptors, the artefact fingerprint,
`validateWorkspaceGraph`, the atomic commit, the reopen-and-verify — is
unchanged, so an adopted document gets exactly the same safety guarantees as an
imported one.

**Why `extendActiveWorkspace` cannot be reused instead:** it demands a whole
notebook plus every one of its pages, refuses ID collisions with the active
workspace (`workspaceV2Runtime.ts:357-362`), is receipt- and import-scoped, and
re-materialises from projections — losing exactly the history that makes CRDT
convergence work.

**Why remote *edits to existing docs* need no transaction at all:** they land via
`handle.update(doc => Automerge.loadIncremental(doc, bytes))`
(`src/components/collab/runtimeEditorPort.ts:86-97`), and reopening the activation
later still validates, because `openActivatedV2` only requires that the recorded
heads are still *reachable* (`getAutomergeSnapshotAt` -> `Automerge.hasHeads`,
`workspaceV2Runtime.ts:1198-1205`, `src/crdt/document.ts:327-331`). Merging remote
changes only ever extends history, so the recorded heads stay reachable. A
debounced `runtime.flush()` (`workspaceV2Runtime.ts:742-744`) persists them.

### 5.6 `runtimeSpacePort.ts`

`createRuntimeEditorPort` (`src/components/collab/runtimeEditorPort.ts:54`) is
scoped to one notebook, and its `onRemoteDocAdded` is a deliberate no-op
(`:110-120`). The personal port is the whole-workspace variant:

- `listDocs()` returns every `activation.documents` entry, not just one
  notebook's.
- `subscribe` / `applyRemote` / `getSnapshotBytes` behave exactly like the
  notebook port, including the "`getSnapshotBytes` must be side-effect free" rule
  (`runtimeEditorPort.ts:99-108`) — violating it silently drops local edits.
- `onRemoteDocAdded(docId, kind, bytes)` is **implemented**: it hands the bytes to
  the `materialize.ts` batcher instead of discarding them. This is the single
  behavioural difference from the sharing port, and the reason it is a separate
  file rather than a flag on the existing one.
- The workspace doc is handled outside the port, because it has no runtime
  handle. `spaceSession` exposes it directly, and it is persisted separately under
  `canvink:personal-space:workspace-doc:v1`. That copy is only a cache; losing it
  merely forces a full re-catch-up.

**No double-apply with sharing.** A notebook that is both shared and in the
personal space has two independent ports over the same `DocHandle`s, each with its
own `lastSyncedHeads` map. A change arriving from the personal room is merged into
the handle; the handle's `change` event then makes the *sharing* port compute a
diff against *its own* baseline and forward it to the shared room — which is the
correct fan-out, and it terminates, because `applyRemote` advances only its own
port's baseline (`runtimeEditorPort.ts:92-96`) and an Automerge `loadIncremental`
of already-known changes is a no-op. No extra guard is required; this is asserted
by an explicit test (wave 5, V9).

### 5.7 `assets/assetSyncQueue.ts`

- **Upload diff**, recomputed after every local topology commit and on reconnect:
  `activation.assetIds` minus `Object.keys(workspaceDoc.assets)`. For each entry,
  `HEAD` first (cheap dedupe across a reinstall), then `PUT` if absent, then record
  the entry in the workspace doc. Serialised, at most two concurrent, retried with
  the same exponential-backoff shape as the session.
- **Download**, on demand only. `requestAsset(assetId)` returns a promise;
  duplicate requests coalesce. Downloaded blobs join a batch flushed after
  `SPACE_ASSET_BATCH_MS`, or immediately at 16 blobs / 32 MiB, through one
  `commitWorkspaceGraphRevision({ operationId, message, assets })`.
- **Rendering integration**: `runtimeAssetRepository`
  (`src/components/assets/runtimeAssetRepository.ts:37-44`) currently returns
  `undefined` for an unknown asset. Add `personalSpaceAssetRepository(runtime,
  queue)`, whose `getAsset` returns `await runtime.getAsset(id)` and, on a miss,
  calls `queue.requestAsset(id)` before returning `undefined`; the UI re-renders
  when the batch commits. `putAsset` keeps throwing — direct asset writes stay
  disabled (`runtimeAssetRepository.ts:40-43`).
- **"Notizbuch offline verfügbar machen"**: an explicit per-notebook action that
  enqueues every asset referenced by that notebook's pages. It is the only
  bulk-download path.

### 5.8 `usePersonalSpaceSync.ts`: integration points, exact names

Mounted once from `src/components/V2NotebookApp.tsx`, next to the existing
`useOwnerCollabSync({ runtime, workspace, syncUrl, bindTrigger })` call.

```ts
usePersonalSpaceSync({
  runtime,                       // WorkspaceV2Runtime | null  (V2NotebookApp)
  workspace,                     // V2RuntimeState | null
  syncUrl: collabSyncUrl,        // VITE_COLLAB_SYNC_URL
  auth: useOptionalAuth(),       // src/auth/AuthContext.ts:38
  enabled: personalSpaceEnabled, // VITE_PERSONAL_SPACE === '1'
  onWorkspaceReplaced: setWorkspaceOverride,  // existing state setter
  onNotice: setNotice,
  onStatus: setSpaceStatus,
});
```

Preconditions the hook enforces, in this order, before opening any socket:

1. `enabled && syncUrl && auth.available && auth.isSignedIn`.
2. `runtime` has started **and** holds write access. Because
   `acquireWorkspaceWriteAccess` is a precondition of `startup()`
   (`workspaceV2Runtime.ts:1118-1120`) and a second browser tab fails it with
   `writer-conflict` (`src/storage/workspaceStorage.ts:41-101`), a tab without the
   lock never reaches a non-null `runtime` and therefore never syncs. Multi-tab
   safety is inherited, not re-implemented. On the desktop the equivalent
   guarantee is `tauri-plugin-single-instance` (`src-tauri/src/lib.rs:936`).
3. `workspace.schemaVersion === 3` — call `runtime.ensureSchemaV3()` first.
4. A `SpaceLinkRecord` exists for `auth.user.id`, or the P8 dialog was resolved.

Ordering guarantee: a `SpacePlan` is applied only while no other workspace
mutation is in flight. Both paths go through `WorkspaceV2Runtime`'s serial
`mutationQueue` (`workspaceV2Runtime.ts:469-482`), so this is already enforced; the
hook must simply not hold a lock of its own and must tolerate the
"activation changed" error (§5.5).

Local edits reach the room through the port's `subscribe` callbacks, which are
driven by `DocHandle` `change` events — the same events the editor already emits
via `PageWriteSession.change` (`workspaceV2Runtime.ts:603-614`) and
`commitTopology` (`V2NotebookApp.tsx:463`). No editor code changes.

### 5.9 UI

| Surface | File | Behaviour |
|---------|------|-----------|
| Status chip in the topbar | `SpaceStatusIndicator.tsx` | Renders `SpaceStatus`; icons from `lucide-react` (`Cloud`, `CloudOff`, `RefreshCw`, `TriangleAlert`). Clicking it opens the account menu. |
| Account menu | `AccountMenu.tsx` | Signed out: "Anmelden" (`auth.openSignIn()`). Signed in: e-mail, space stats (`docCount`, `assetBytes`), "Jetzt synchronisieren", "Abmelden". Sign-out stops the session and keeps both the link record and the local workspace. |
| First-contact dialog | `SpaceLinkDialog.tsx` | Shown only for `status.kind === 'link-required'` with data on both sides. Two buttons (P8), no destructive third option, plus "Lokale Kopie herunterladen" wired to the existing backup export. |
| Quota warning | inline in the chip | `quota-exceeded` shows a persistent warning naming the scope. |
| Asset placeholder | reuse `AssetElementPreview` | `space.asset.pending` while downloading, `space.asset.unavailable` when offline. |

i18n keys, German first. `en` parity is mandatory: `src/i18n/catalog.ts` holds
both objects and `catalogKeyDifference` guards them (`src/i18n/core.ts:38-49`).

```
space.status.disabled / signedOut / linkRequired / bootstrapping
space.status.synced / offline / reconnecting / quotaExceeded / error
space.status.pending            '{count} Änderungen warten auf Übertragung'
space.account.title             'Konto'
space.account.signIn            'Anmelden'
space.account.signOut           'Abmelden'
space.account.signedOutNote     'Deine Notizen bleiben auf diesem Gerät.'
space.account.syncNow           'Jetzt synchronisieren'
space.stats.documents           '{count} Dokumente'
space.stats.assets              '{count} Dateien ({size})'
space.link.title                'Arbeitsbereich mit dem Konto verbinden'
space.link.explain              'Auf diesem Gerät und in deinem Konto liegen unterschiedliche Notizbücher.'
space.link.addLocal             'Lokale Notizbücher zum Konto hinzufügen'
space.link.addLocalHint         'Nichts wird gelöscht; deine lokalen Notizbücher kommen zusätzlich ins Konto.'
space.link.loadRemote           'Konto-Arbeitsbereich laden'
space.link.loadRemoteHint       'Der lokale Arbeitsbereich bleibt als Sicherung erhalten und wird nicht gelöscht.'
space.link.downloadBackup       'Lokale Kopie herunterladen'
space.bootstrap.push            'Arbeitsbereich wird hochgeladen…'
space.bootstrap.pull            'Arbeitsbereich wird geladen…'
space.bootstrap.adopt           'Notizbücher werden übernommen…'
space.asset.pending             'Datei wird geladen…'
space.asset.unavailable         'Diese Datei ist auf diesem Gerät noch nicht verfügbar.'
space.asset.makeOffline         'Notizbuch offline verfügbar machen'
space.quota.log                 'Das Synchronisationskontingent ist erschöpft.'
space.quota.assets              'Der Dateispeicher ist voll.'
space.error.reauth              'Die Anmeldung ist abgelaufen. Melde dich erneut an.'
```

---

## 6. Edge cases and conflict rules

### 6.1 Concurrent content edits on the same page

Automerge merge; no user-visible conflict. Rich text uses the existing
ProseMirror/Automerge binding (`src/crdt/richText.ts`); strokes and elements are
keyed by id in `elementsById` (`src/domain/v2/types.ts:170`), so concurrent
inserts never collide.

### 6.2 Concurrent topology edits

- **Create on A + create on B**: both exist. Local ids are random
  (`createLocalId`); a collision would be caught by
  `stageAutomergeWorkspaceRevision`'s "collides with an existing root" check
  (`v2WorkspaceStorage.ts:636-641`) and surface as a deferred plan, never as
  corruption.
- **Reorder on A + reorder on B**: fractional-index LWW. The result is one of the
  two orders, or an interleaving — always a valid total order, never a duplicate
  or a lost notebook.
- **Rename on A + rename on B**: the title lives in the notebook doc (layer 1);
  Automerge LWW on the `title` field.
- **Add a page on A + reorder its section on B**: both land in the notebook doc's
  `sections[].pageDocumentIds`, an Automerge list — concurrent list inserts are
  exactly what Automerge is for. The workspace doc only records that the page
  belongs to the space.

### 6.3 Delete on A, edit on B (the named requirement)

Rule: **soft delete wins for visibility; content is never destroyed.**

1. A deletes a notebook: `deletedAt` is set on its workspace-doc entry and A's
   local manifest gets a `TrashRecordV3`. The notebook and page *documents stay*
   in both the space and A's activation.
2. B, offline, edits a page of that notebook: ordinary appends.
3. On convergence, B's edits merge into the page doc — they are not lost — and B's
   manifest also moves the notebook to trash. B sees "Notizbuch im Papierkorb"
   with its newest content intact, and can restore it; restoring clears
   `deletedAt`, which propagates back to A.
4. **Hard delete (`purgedAt`)** is reachable only from the trash view, behind an
   explicit confirmation, and only for entries that were already soft-deleted. It
   emits a `remove` frame plus `removedDocumentIds`, which drops the Automerge
   chunks from every device's Repo image (`v2WorkspaceStorage.ts:615-620`). If B
   has unsynced edits to a page that A purges, those edits are lost. This is the
   one irreversible path, which is exactly why it is manual, confirmed, and never
   automatic.
5. Asset bytes are **never** deleted by a purge (§3.5 `DELETE`), because another
   device may still reference them from a change it has not uploaded yet.

### 6.4 Offline and reconnect

- Edits apply locally and persist through the normal Repo/activation path; the
  network is never on the write path.
- While disconnected the session records dirty doc ids; on reconnect it sends one
  snapshot per dirty doc (P7) instead of replaying a queue that may have silently
  dropped its oldest frames.
- `announce` frames for documents created while offline are queued and flushed
  *before* the snapshots, because the server rejects an `append` for an unknown
  doc (`unknown-doc`, `room.ts:685-691`), and a `snapshot` for an unannounced doc
  self-initialises it with `kind = 'unknown'` (`room.ts:753-761`) — which would
  then poison `welcome.docs` on every other device.
- A device whose local activation was reset falls back to bootstrap C (§2.4).

### 6.5 Multi-tab

Inherited from the Web Lock (§5.8, precondition 2). A second tab shows the
existing `writer-conflict` recovery screen and never opens a personal socket. No
new lock, no new failure mode.

### 6.6 Tauri desktop versus browser

Identical code path. The differences and how they are absorbed:

| | Browser | Tauri |
|---|---|---|
| Repo chunks | IndexedDB `canvink-v2/documents-assets` (`workspaceV2Runtime.ts:1312-1318`) | SQLite via `v2_repo_*` (`src/crdt/tauriStorageBridge.ts`) |
| Asset read | `adapter.get(asset:<id>)` (`v2WorkspaceStorage.ts:917-922`) | `v2_get_asset_base64`, 64 MiB decode cap (`tauriV2WorkspaceStorage.ts:425`) |
| Asset write | `commitActiveWorkspaceRevision` (IndexedDB transaction) | `v2_commit_workspace_revision_base64` |
| Single writer | Web Locks | `tauri-plugin-single-instance` |

Both platforms implement `commitActiveWorkspaceRevision`, so the asset adoption
path (P5) is literally the same call on both. The 64 MiB native decode cap is why
`SPACE_MAX_ASSET_BYTES` is 64 MiB: a larger asset would sync to the browser and
then fail to open on the desktop.

### 6.7 Who may write the workspace from the network

Restated precisely, and enforced by P10 as amended by P13:

- `src/collab/` and `src/components/collab/` do not write the workspace from a network
  trigger, with one named exception: `adoptSharedDocuments.ts` (P13) adopts the documents of a
  shared notebook when a share link is opened and a page a collaborator adds. The room binding
  otherwise reads local handles and forwards diffs into handles the workspace already holds.
- `src/personal-space/` remains the writer for everything the account's own space delivers. It is
  the single writer-into-workspace session per app instance for that channel.
- If the same notebook is both shared and personal, the two channels merge into the same
  Automerge documents, so a change arriving through one is forwarded once through the other and
  stops there (`pingPongGuard.test.ts`).

### 6.8 Sign-out, account switch, revocation

- **Sign-out**: close the socket, keep the local workspace and the link record,
  status `signed-out`. Nothing is deleted. Signing back in with the same `sub`
  resumes using the persisted resume (`since`) map.
- **A different `sub` signs in on the same device**: the link record disagrees, so
  the status is `link-required` and the P8 dialog appears. Never auto-adopt
  someone else's workspace into an existing local one.
- **Clerk session revoked**: the next `reauth` fails, producing `unauthorized` +
  close `4401`, which the session treats as fatal (`session.ts:302-305`, `:329`).
  Status becomes `error` with `space.error.reauth`; local editing continues
  normally.

### 6.9 Failure modes that must not corrupt anything

- A malformed remote payload is already handled non-fatally
  (`session.ts:258-283`).
- A plan that would fail `validateWorkspaceGraph` throws *before* the activation
  is replaced — the staged reopen happens pre-commit
  (`workspaceV2Runtime.ts:1077-1084`) — and `materialize.ts` defers.
- A commit that fails mid-way falls into the existing reconcile-or-restore path
  (`workspaceV2Runtime.ts:1093-1110`).
- Quota exceeded: local writes keep working; only the upload stalls.

---

## 7. Limits

| Limit | Value | Where enforced | Rationale |
|---|---|---|---|
| WS frame | 16 MiB | `types.ts` | raised 2026-09-30; payloads over 1 MB are stored in chunk rows |
| Per-doc log | 50 MiB | existing (`types.ts:80`) | unchanged |
| Docs per personal room | 5 000 | `MAX_DOCS_PER_SPACE` in `room.ts` | 1 000 (shared) is too low for a real notebook library; 5 000 pages is far beyond current use and keeps `welcome.docs` inside one frame. |
| Docs per shared room | 1 000 | existing | unchanged |
| Total log bytes per space | 1 GiB | `meta.logBytes` counter (§3.6) | DO SQLite allows roughly 10 GB; 1 GiB leaves headroom and is about 50x a realistic workspace. Over budget yields a non-fatal `quota-exceeded`. |
| Workspace-doc save | 1 MiB | client-side assert before `snapshot` | around 5 000 entries at ~120 B each. Exceeding it means the schema is wrong, not that the user has too many notebooks. |
| Workspace-doc compaction | every **32** acked appends | `attachAckCompaction(session, ..., { everyAckedAppends: 32 })` | it is small and hot; 64 would keep a longer log for no benefit. |
| Content-doc compaction | every 64 acked appends | existing helper (`session.ts:398-417`) | unchanged |
| Asset object | 64 MiB | Worker `content-length` check | matches the native base64 decode cap (`tauriV2WorkspaceStorage.ts:425`) and stays well under the 100 MB Worker request-body ceiling. |
| Assets per space | 2 GiB | `meta.assetBytes` counter | the R2 free tier is 10 GB in total; 2 GiB per space leaves room to grow and makes the ceiling explicit in the UI instead of a surprise 500. |
| `POST /me/space` | 30 / 60 s per `sub` | `rateLimit.ts`, same best-effort caveat as `README.md:71-94` | |
| Asset `PUT` | 600 / 60 s per `sub` | same | an upload burst after a large import is legitimate; this only stops a runaway loop. |
| `reauth` | at least 5 s between accepted frames per socket | `room.ts` | stops a broken client from hammering JWKS verification. |

**Bootstrap interacts with compaction.** A fresh device's `hello` carries an empty
`since`, so it receives each doc's snapshot plus the retained tail
(`room.ts:594-631`). With compaction running, that tail is at most 64 changes per
doc, so a 137-document workspace bootstraps in roughly 137 snapshots —
comfortably one WebSocket session, each frame bounded by 16 MiB.

**The one hard limit a real workspace can hit.** A page whose full Automerge save
exceeds 10 MiB (for example a page with a large PDF printout plus heavy ink) cannot
be snapshotted at all. The client **must** check `bytes.byteLength` against
`SPACE_MAX_SNAPSHOT_BYTES` before sending a `snapshot` and, when it is over,
surface `space.quota.log` and stop syncing that single document rather than
looping on a rejected frame. Builders must implement this check; it is not
optional.

---

## 8. Migration and rollout

### 8.1 Backend

1. `wrangler r2 bucket create canvink-personal-assets`.
2. Add to `services/collab-sync/wrangler.jsonc`:
   ```jsonc
   "r2_buckets": [{ "binding": "ASSETS", "bucket_name": "canvink-personal-assets" }]
   ```
   **No `migrations` entry is needed** — there is no new Durable Object class (P1).
3. `wrangler secret put PERSONAL_SPACE_SALT` (32 random bytes, base64). When the
   secret is absent, every `/me/space*` and `/me/assets/*` route returns
   `503 {"error":"personal-space-not-configured"}` — fail closed, in the same
   spirit as the `CLERK_ISSUER` rule (`clerk.ts:109-114`). **Rotating this salt
   orphans every existing space**, so it is write-once; document that next to the
   `CLERK_ISSUER` note in the README.
4. `CLERK_ISSUER` must already be set: the personal space is reachable *only* with
   a real Clerk JWT, so without it nothing works (`README.md:58`).
5. Deploy. Existing rooms are untouched — they have no `kind` row and are treated
   as `"shared"` (§3.1).

### 8.2 Frontend

- New env var: `VITE_PERSONAL_SPACE=1`. Absent means the whole feature is
  `{ kind: 'disabled' }`: no module loads and no route is called. This is the kill
  switch.
- It also requires `VITE_COLLAB_SYNC_URL` and `VITE_CLERK_PUBLISHABLE_KEY`; if
  either is missing the feature stays disabled and the account menu is hidden —
  the same gating shape as the existing sharing and sign-in gates
  (`PROTOCOL.md:280-282`).
- The root `wrangler.jsonc` builds `dist` for `canvink.example.com`; that build must
  run with all three vars set, because Vite bakes them in at build time. This is
  exactly why `tests/e2e/collab-sync.playwright.config.ts` needs its own web
  server.

### 8.3 Rollout order (each step independently revertible)

1. Deploy the Worker with the personal routes present but `PERSONAL_SPACE_SALT`
   **unset**: the routes answer 503 and sharing is unaffected. Verify the sharing
   e2e suite still passes against the deployed worker.
2. Set the salt. Verify `POST /api/v1/me/space` with a real Clerk token.
3. Ship the app with `VITE_PERSONAL_SPACE` **unset**: dead code, no behaviour
   change. Verify `pnpm check` and the sharing e2e config.
4. Enable `VITE_PERSONAL_SPACE=1` on the desktop build first, push one device's
   workspace, then enable it on the web build and verify the pull on a second
   device.
5. Only then enable it in a phone browser, which exercises the lazy-asset path
   hardest.

### 8.4 Backout

Unset `VITE_PERSONAL_SPACE` and rebuild. Local workspaces are unaffected — they
remain the source of truth on every device — and the DO and R2 data can be left in
place. No local data migration was performed that a backout would have to undo.
That is a property the design deliberately preserves: **the personal space is a
replica, never the primary.**

### 8.5 Documentation to update in the same change

- `services/collab-sync/PROTOCOL.md`: a "Personal space (v2)" section
  cross-referencing this file, plus the `kind` discriminator in the room and roles
  tables.
- `services/collab-sync/README.md`: new env-var rows, the R2 binding, and the
  salt-is-write-once warning.
- `docs/architecture.md`; `docs/security-model.md` (plaintext-on-server for the
  personal space, the isolation argument in §4.2, and why the asset key cannot be
  traversed); `ROADMAP.md`.

---

## 9. Wave plan

Four builder waves run **in parallel** after a small seed step, then one
sequential integration wave. Every wave owns a disjoint set of files; a wave must
not edit a file it does not own, even trivially.

### Wave 0 — seed (one agent, ~20 minutes, blocking)

**Owns:** `src/personal-space/contract.ts`, `src/personal-space/index.ts`
(re-exports only), `services/collab-sync/src/types.ts`.

**Task:** create the type-only contract from §4.3 and §5.2, and add to the
worker's `types.ts`: `RoomKind`, the `HelloAuth` personal variant,
`SocketAttachment.authExpiresAt`, `ClientFrameReauth`, the `ErrorCode`
`"quota-exceeded"`, `MAX_DOCS_PER_SPACE`, `MAX_SPACE_LOG_BYTES`,
`MAX_ASSET_BYTES`, `SPACE_ASSET_QUOTA_BYTES`.

**Gate:** `pnpm typecheck` at the repo root and `pnpm typecheck` in
`services/collab-sync` both pass. No runtime code, no behaviour change. Waves 1
through 4 start only after this lands.

---

### Wave 1 — Worker: personal rooms, reauth, assets

**Owns:** `services/collab-sync/src/room.ts`, `src/index.ts`, `src/auth/clerk.ts`,
`src/rateLimit.ts`, new `src/space.ts` and `src/assets.ts`,
`services/collab-sync/test/**`, `wrangler.jsonc`, `PROTOCOL.md`, `README.md`.
**Must not touch:** anything under the repo-root `src/`.

**Tasks**

1. The `meta.kind` discriminator, the `roomExists()` update, and cross-kind
   refusal on every existing route and on `hello` (§3.1).
2. `VerifiedIdentity.exp` in `clerk.ts`, plus the test shim (§3.2).
3. `hello.auth.kind === "personal"` resolution, the `authExpiresAt` attachment,
   the write gate with its 120 s grace, and the `reauth`/`reauthed` frames (§3.4).
4. `kind: "workspace"` acceptance, `workspace:root` docId pinning, and refusal in
   shared rooms (§3.3).
5. `POST|GET /api/v1/me/space` (§3.5), with `spaceId` derived from
   `PERSONAL_SPACE_SALT`, and 503 when the salt is unset.
6. R2 asset routes `HEAD`/`PUT`/`GET`/`DELETE`, with the streaming put, the R2
   `sha256` option, and size and quota checks (§3.5, §4.2).
7. The `meta.logBytes` / `assetBytes` / `assetCount` counters (§3.6).
8. `MAX_DOCS_PER_SPACE`, for personal rooms only.

**Tests** (in-package Vitest, real Workers runtime)

- A personal room refuses `POST /links`, `DELETE /collaborators`, `DELETE /`, and
  every non-personal `hello` kind.
- A shared room refuses `hello.kind = "personal"` and
  `announce kind:"workspace"`.
- **Isolation, the security-critical case:** two different `sub`s get two
  different `spaceId`s and cannot read each other's docs or assets, including a
  direct attempt with a forged `spaceId` in the URL.
- `reauth` with a different `sub` closes `4401`; with the same `sub` it extends
  the deadline; an expired socket's `append` past the grace window closes `4401`.
- A `PUT` whose bytes do not match the claimed hash yields
  `400 checksum-mismatch`, and the object is absent afterwards.
- A `PUT` over 64 MiB yields `413`; over quota it yields `413 quota-exceeded`.
- Every existing `rooms.spec.ts`, `ws-protocol.spec.ts` and `clerk.spec.ts` case
  passes **unmodified**. If a change requires editing an existing sharing test,
  stop and escalate — that is a regression, not test maintenance.

**Gate:** `pnpm test && pnpm typecheck && pnpm dry-run` in
`services/collab-sync`, with `PROTOCOL.md` and `README.md` updated in the same
commit.

---

### Wave 2 — Client transport: session extensions and `spaceSession`

**Owns:** `src/collab/protocol.ts`, `src/collab/session.ts`,
`src/collab/protocol.test.ts`, `src/collab/session.test.ts`,
`src/personal-space/http.ts`, `spaceSession.ts`, `linkStore.ts`, and their tests.
**Must not touch:** `src/collab/ownerBridge.ts`, `src/collab/http.ts`,
`src/components/**`, `src/storage/**`.

**Tasks**

1. The `PersonalAuth` credential, the `"workspace"` DocKind, the
   `reauth`/`reauthed` frames, and the `quota-exceeded` error code — all additive
   in `protocol.ts`.
2. `openRoomSession` options `getAuth`, `resyncStrategy` and
   `getFullSnapshotBytes`; `sendReauth` and `subscribeReauthed` (§5.3). **The
   defaults must reproduce today's behaviour exactly**; existing `session.test.ts`
   cases must pass unmodified.
3. The P7 snapshot-resync: dirty-doc tracking, announce-before-snapshot ordering,
   `covers = since[docId] ?? 0`, and the `SPACE_MAX_SNAPSHOT_BYTES` pre-check
   from §7.
4. `http.ts`: `createOrGetSpace`, `getSpace`, `headAsset`, `putAsset`, `getAsset`
   and `deleteAsset`, each with an injectable `fetchImpl` in the same shape as
   `src/collab/http.ts:7-13`.
5. `spaceSession.ts`: the reauth timer, the visibility and online triggers, the
   `SpaceStatus` machine, and the `PersonalSpaceSession` facade.
6. `linkStore.ts`: a `SpaceLinkRecord` in `localStorage` under
   `canvink:personal-space:link:v1`, with the same defensive-parse shape as
   `src/components/collab/ownerRoomStore.ts:19-45`.

**Tests** (node Vitest, mocked WebSocket via `src/collab/testMocks.ts`)

- A reconnect with `resyncStrategy: 'snapshot'` sends one snapshot per dirty doc
  and zero replayed appends; with the default it still replays the queue.
- Queue overflow no longer loses data under `'snapshot'`.
- The reauth timer fires before expiry and reschedules on `reauthed`.
- `getAuth` is called on **every** connect attempt, not once.

**Gate:** root `pnpm test`, `pnpm lint`, `pnpm typecheck`. Any diff to an existing
`session.test.ts` assertion is a stop-and-escalate.

---

### Wave 3 — Runtime adoption and workspace-doc projection

**Owns:** `src/storage/workspaceV2Runtime.ts` (the `adoptedDocuments` addition
only), `src/storage/workspaceV2Runtime.test.ts`,
`src/personal-space/workspaceDoc.ts`, `fractionalOrder.ts`,
`manifestProjection.ts`, `materialize.ts`, `runtimeSpacePort.ts`, and their tests.
**Must not touch:** `src/collab/**`, `services/**`, `src/components/**`, or
`src/storage/v2WorkspaceStorage.ts` — no change is needed there, because
`stageAutomergeWorkspaceRevision` already imports raw bytes
(`v2WorkspaceStorage.ts:642`).

**Tasks**

1. `WorkspaceGraphRevisionRequest.adoptedDocuments`, plus the ~15 lines in
   `commitWorkspaceGraphRevisionInternal` (§5.5, exact code given).
2. `fractionalOrder.ts`: `keyBetween(a?: string, b?: string): string` producing
   lexicographically ordered keys; pure, exhaustively tested.
3. `workspaceDoc.ts`: build an initial `SpaceWorkspaceDocV1` from a
   `V2ActivationRecord`; mutators `addNotebook`, `addPage`, `softDelete`,
   `restore`, `purge`, `reorderNotebook`, `recordAsset`. All are
   `Automerge.change` callbacks, all free of I/O.
4. `manifestProjection.ts`: `projectSpacePlan` (§5.4), pure and total.
5. `materialize.ts`: `applySpacePlan`, with the debounce, the single retry, and
   the empty-plan no-op.
6. `runtimeSpacePort.ts` (§5.6).

**Tests** (node Vitest, in-memory activation store and Repo, following the
existing `workspaceV2Runtime.test.ts` harness)

- **The regression this mechanism exists to prevent:** a document adopted via
  `adoptedDocuments` keeps its Automerge history — after adoption
  `Automerge.getHeads` includes the remote heads and a *later* remote change
  merges cleanly, whereas the same document routed through `newDocuments`
  diverges.
- Adoption round-trips through a real `commitActiveWorkspaceRevision`, and the
  activation reopens and validates.
- `projectSpacePlan` defers a page whose notebook is missing and emits it on the
  next call once the notebook is available.
- Delete-on-A / edit-on-B produces a trash record **and** preserves the edited
  content (§6.3).
- A concurrent reorder converges to a valid total order with no duplicates.

**Gate:** `pnpm test`, `pnpm lint`, `pnpm typecheck`. The existing
`workspaceV2Runtime.test.ts` suite must pass unmodified.

---

### Wave 4 — Assets, UI and i18n

**Owns:** `src/personal-space/assets/**`, `src/components/personal-space/**`,
`src/i18n/catalog.ts`, `src/components/assets/runtimeAssetRepository.ts` (the new
wrapper only), and their tests.
**Must not touch:** `src/storage/**`, `src/collab/**`, `services/**`, or
`src/components/V2NotebookApp.tsx`.

**Tasks**

1. `assetSyncQueue.ts` (§5.7): the upload diff, HEAD-dedupe, bounded concurrency,
   coalesced download requests, and batched adoption. The runtime and the HTTP
   client are injected as constructor ports, so it is testable with fakes.
2. `personalSpaceAssetRepository(runtime, queue)` — an additive export in
   `runtimeAssetRepository.ts`; the existing exports stay unchanged.
3. `SpaceStatusIndicator.tsx`, `AccountMenu.tsx` and `SpaceLinkDialog.tsx` (§5.9),
   each with a pure exported presenter (`statusLabelKey(status)`,
   `linkDialogOptions(state)`), so they can be unit-tested under the repo's
   `environment: 'node'` Vitest config (`vite.config.ts`) — which is why existing
   component tests are `.test.ts` over pure helpers rather than render tests.
4. Every `space.*` key in **both** `de` and `en` (§5.9).

**Tests**

- `catalogKeyDifference(de, en)` reports no missing or extra keys; the existing
  `src/i18n/i18n.test.ts` assertion must stay green.
- The upload diff computes exactly the missing hashes and skips ones the
  workspace doc already lists.
- A download batch flushes once for N assets, not N times.
- `statusLabelKey` covers every `SpaceStatus` variant (an exhaustiveness test).

**Gate:** `pnpm test`, `pnpm lint`, `pnpm typecheck`.

---

### Wave 5 — Integration and verification (sequential, after waves 1 to 4)

**Owns:** `src/components/personal-space/usePersonalSpaceSync.ts`,
`src/components/V2NotebookApp.tsx`, `eslint.config.js` (the P10 rule),
`tests/e2e/personal-space.spec.ts`,
`tests/e2e/personal-space.playwright.config.ts`, `docs/**`, `ROADMAP.md`.

**Tasks**

1. `usePersonalSpaceSync` (§5.8), wiring session, port, projection, materialise
   and assets, with the preconditions enforced in the stated order.
2. Mount it in `V2NotebookApp.tsx` next to `useOwnerCollabSync`; render the status
   chip and the account menu; wire `SpaceLinkDialog`.
3. The three bootstrap flows (§2.3, §2.4, P8), including the pristine-starter
   purge rule.
4. The ESLint `no-restricted-imports` rule implementing P10.
5. An e2e config modelled on `tests/e2e/collab-sync.playwright.config.ts`: a
   `wrangler dev` worker with `TEST_AUTH_SECRET`, `PERSONAL_SPACE_SALT` and a
   local R2 binding, plus an app build with `VITE_PERSONAL_SPACE=1`. Two browser
   contexts share one test identity by injecting the same `test:<sub>:<hmac>`
   token through the auth seam.
6. Documentation (§8.5).

**Verification criteria — all must pass before this is "done"**

| # | Criterion |
|---|-----------|
| V1 | `pnpm check` at the repo root is green: lint, typecheck, unit tests, release marker, licences, build. |
| V2 | `pnpm test && pnpm typecheck && pnpm dry-run` in `services/collab-sync` is green. |
| V3 | The **existing** sharing e2e config passes unchanged: `pnpm exec playwright test --config tests/e2e/collab-sync.playwright.config.ts`. This is the non-regression gate for the entire sharing feature. |
| V4 | The main Playwright suite passes: `pnpm test:e2e`. |
| V5 | New e2e: context A creates a notebook and a page and inserts an image; context B, on the same test identity with a cold profile, sees the notebook, the page text, and — once the asset loads — the image. |
| V6 | New e2e: B edits the page while A is offline (`context.setOffline(true)`); on reconnect both converge and neither edit is lost. |
| V7 | New e2e: A soft-deletes a notebook while B edits a page inside it; B ends with the notebook in the trash and the edited content intact after restore (§6.3). |
| V8 | New e2e: a context signed in as a *different* test `sub` sees an empty space and cannot read any of the first identity's documents or assets. |
| V9 | New unit test: a notebook that is simultaneously shared and personal does not ping-pong — one remote change produces exactly one forwarded frame per room, and it terminates (§5.6). |
| V10 | Manual: the desktop Tauri build and `https://canvink.example.com` converge on the same account, including a PDF over 10 MB. |
| V11 | Manual: signing out on one device leaves the local workspace fully editable, with nothing removed. |

---

## 10. Open questions for the owner (do not guess)

1. **R2 ceiling.** The free tier is 10 GB in total; this design caps one space at
   2 GiB. Is that the right first ceiling, and should the UI warn at 80 %?
2. **Trash retention.** Should soft-deleted entries auto-purge after N days —
   with the §6.3 caveat that a purge can lose an offline device's unsynced
   edits — or only ever be purged manually?
3. **Per-notebook opt-out.** Should every notebook sync, or should there be a
   "nur auf diesem Gerät" flag? The design supports it cheaply (a `local: true`
   flag on the workspace-doc entry) but it is not specified above.
