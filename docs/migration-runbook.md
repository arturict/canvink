# Schema v1 to Automerge v2 migration runbook

## Authority boundary

`src/storage/v2WorkspaceStorage.ts` implements the migration and activation
state machine. `V2NotebookApp` invokes it at product startup.

There is one v2 startup selector: the separate `activation:v2` record. The
older `migration:v1-to-v2:committed` JSON marker is not an activation record and
must never cause startup to select v2.

- No `activation:v2`: schema v1 remains authoritative. Prepared projections or
  an interrupted in-memory Repo stage do not change authority.
- Valid `activation:v2`: schema v2 is authoritative. Startup must load the
  listed Automerge URLs from the committed Repo chunks.
- Present but corrupt activation, backup, asset, chunk, or document: v2 is
  authoritative but unavailable. Fail closed and enter repair/restore. Never
  fall back to stale v1 and never synthesize a blank workspace.

The activation record contains the migration/source/artifact fingerprints, v2
manifest, stable document-ID to Automerge-URL mapping, expected heads, Repo
chunk descriptors, and asset IDs. It does not contain notebook content.

## Preconditions

Before enabling activation in a release:

1. Hold the existing browser Web Lock for the entire operation. Desktop must
   provide an equivalent exclusive writer boundary.
2. Resolve any recovery draft that differs from the saved v1 workspace. Restore,
   download, or discard it explicitly before retrying.
3. Confirm enough local quota for v1, a full rollback backup, extracted assets,
   Automerge Repo chunks, and the activation record.
4. Use the platform `V2WorkspaceActivationStore` whose `commit` is one real
   transaction. Browser uses IndexedDB; desktop uses the SQLite-backed Tauri
   activation store and Repo bridge.
5. Keep page content addressable by stable IDs. Live page documents must use the
   schema-v2 `elementsById` plus `zOrder` model, and rich text edits must target
   stable paths such as `[elementsById, elementId, text]`. Activation code treats
   documents as opaque Automerge roots and does not assume array positions.

## Migration procedure

Create one orchestrator for the exclusively opened workspace and record its
content-free progress events.

```ts
const migration = createBrowserV2WorkspaceMigrationOrchestrator({
  onProgress: (progress) => migrationLog.write(progress),
});

const result = await migration.run();
```

The orchestrator performs these gates in order:

1. Load and validate the authoritative v1 workspace. Refuse a source with no
   usable live page.
2. Read the recovery journal and stop on a divergent draft.
3. Clone the complete v1 workspace into a rollback backup, validate its shape,
   recompute its source fingerprint, and compare its canonical bytes to source.
4. Prepare and verify deterministic schema-v2 projections and checksum assets.
5. Materialize every projection as a real Automerge binary document through the
   injectable CRDT materializer.
6. Import those binaries into a memory-backed Automerge Repo, flush its real
   storage chunks, and capture each Repo-generated Automerge URL.
7. Construct the proposed `activation:v2` record. Reopen a new Repo from only
   the staged chunks and validate every URL, document ID, kind, active notebook,
   active page, and expected heads.
8. Verify the backup fingerprint, every asset SHA-256, and every Repo chunk
   descriptor.
9. Atomically commit the checked v1 backup, assets, Repo chunks, and
   `activation:v2`. The activation record is the final transaction entry but is
   in the same transaction as all data it references.
10. Read the activation and committed payload back, reopen the Repo again, and
    return v2 only after that verification succeeds.

The in-memory Repo stage is disposable. A pre-commit interruption restarts the
deterministic preparation and creates a fresh set of URLs; because no activation
exists, v1 remains authoritative. A retry after a lost commit acknowledgement
reconciles against `activation:v2`. A retry for the same active source returns
`already-active` without another transaction.

## Failure matrix

| Observation | Authority | Action |
| --- | --- | --- |
| Divergent recovery draft | v1 | Resolve the draft explicitly, then retry. |
| Backup clone/fingerprint check fails | v1 | Stop before materialization. Investigate source or runtime corruption. |
| Projection or asset verification fails | v1 | Preserve v1; repair through an explicit import/recovery path. |
| Automerge materialization is incomplete | v1 | Stop. Do not activate JSON projections as live documents. |
| Staged Repo chunks cannot reopen | v1 | Discard the memory stage, diagnose the CRDT adapter, and retry. |
| Atomic transaction aborts with no activation | v1 | Retry; no partial record may be visible. |
| Commit call fails but matching activation exists | v2 | Reopen and validate committed v2; treat as lost acknowledgement. |
| Activation exists but payload or document validation fails | v2, unavailable | Fail closed; use v2 repair/restore. Never load v1 automatically. |
| Abort before activation | v1 | Safe: abandon the in-memory stage. |
| Abort after activation | v2 | Refuse. Rollback requires a separately tested restore migration. |

## Startup

`src/storage/workspaceV2Runtime.ts` is the startup/runtime facade. The browser
factory acquires the shared writer boundary and uses the Canvink IndexedDB Repo
adapter. Native callers inject a `CanvinkStorageBridge`-backed persistent Repo
factory plus the Tauri activation store; the runtime itself does not treat a
native Repo as browser IndexedDB.

```ts
const runtime = createBrowserWorkspaceV2Runtime();
const state = await runtime.startup();
```

Desktop uses the production native composition and never substitutes browser
IndexedDB:

```ts
const runtime = createTauriWorkspaceV2Runtime({
  onMigrationProgress: (progress) => migrationLog.write(progress),
});
const state = await runtime.startup();
```

After activation, desktop graph changes use
`v2_commit_workspace_revision_base64`. The command compares the complete prior
activation, validates the proposed complete Repo image and referenced assets,
then replaces the physical Repo rows and publishes the new activation in one
SQLite transaction. OneNote additive imports use the separate receipt-bearing
`v2_additive_import_base64` transaction and its guarded rollback command.

Startup order is fixed:

1. Acquire exclusive workspace write access without initializing v1.
2. Read and validate `activation:v2`.
3. When activation exists, verify the committed backup/assets/chunks, open the
   persistent Repo, find every root/page URL, prove the activation heads belong
   to each document, validate all stable-map roots and notebook-page references,
   and resolve the active context.
4. Only when activation is absent call the schema-v1 loader.

An unreadable or malformed activation, corrupt committed payload, unavailable
URL, invalid live root, or broken notebook/page graph raises
`WorkspaceV2RecoveryRequiredError` with a typed code. The v1 loader is not
consulted in those cases.

The runtime exposes live `LiveNotebookDocV2` and `LivePageDocV2` snapshots,
navigation, persistent page handles, and page-change subscriptions. Automerge
heads remain metadata outside the roots. Page subscriptions expose canonical
`elementsById[elementId].text`; portable rich-text `content` is not reconstructed
inside a live root.

Public runtime operations are:

- `startup()` and `getState()` for authority-aware opening;
- `getActiveContext()` and `navigateTo(...)` for validated navigation;
- `getPageHandle(pageId)` for advanced bindings;
- `changePage(pageId, { message, time? }, callback)` for one named Automerge
  change through the facade;
- `subscribeToPageChanges(pageId, listener)` with an unsubscribe callback;
- `migrateV1ToV2()` for the explicit migration/reopen transition;
- `flush()` and `shutdown()` for lifecycle durability; and
- `getV1Backup()` and `createV1RollbackCopy()` for read-only recovery copies.

When startup returns v1, the visible application triggers migration before
rendering an editable workspace:

```ts
await runtime.migrateV1ToV2();
```

The call runs the checked orchestrator only from v1 mode, then discards its
temporary in-memory Repo and reopens every URL through the persistent Repo. A
failed migration leaves the runtime in v1 mode. Calling it in already-active v2
is idempotent.

Before closing a task/window, call `flush()` for an explicit durability point or
`shutdown()` to unsubscribe listeners, flush, stop the Repo, and close its
storage bridge. `getV1Backup()` and `createV1RollbackCopy()` return detached
copies only. They never delete activation, overwrite live data, or perform a
rollback.

The lower-level `loadActiveV2OrV1` remains useful for migration conformance
tests, but product startup should use the lifecycle-aware runtime.

`createTauriWorkspaceV2Runtime` composes `TauriV2WorkspaceActivationStore` and
`TauriCanvinkStorageBridge`. The native migration stages the checked v1 backup,
assets, physical Automerge Repo keys, and `activation:v2`; SQLite publishes all
of them in the existing migration commit transaction. Binary IPC uses bounded,
canonical padded Base64. A lost stage or commit acknowledgement is reconciled
against the durable migration marker and authority row. A prepared native stage
can be rolled back; a published activation cannot be removed through that API.

`createBridgeBackedWorkspaceV2Runtime` remains the injectable composition seam
for tests and other native stores. It deliberately requires both a bridge and
an activation store.

- It checks `activation:v2` first.
- If activation exists, it opens the notebook documents and the active page,
  checks the workspace graph against the page index (rebuilding stale entries
  one page at a time), and verifies every other page, asset and the v1 backup
  when they are first read. Any error is surfaced.
- If activation is absent, it loads the real v1 workspace and rejects an empty
  result. It ignores the old JSON migration marker.

Do not catch an active-v2 load failure by creating a default workspace. That
would hide corruption and make later writes destructive.

## Progress and diagnostics

Safe diagnostic fields are phase, completed, total, authority, resumed flag,
migration ID, source fingerprint, artifact fingerprint, and storage error
name/code. Do not log workspace backups, titles, document roots, asset bytes,
recovery drafts, or Repo chunk bytes.

Expected phases are `loading-v1`, `checking-recovery`, `backing-up-v1`,
`preparing-v2`, `staging-assets`, `staging-documents`, `verifying-stage`,
`activating-v2`, and `active-v2`. A `failed` state does not itself identify
authority; inspect the `authoritative` field.

## Product activation and remaining release gates

The visible product now uses automatic startup migration. Focused browser tests
prove first-run activation, verified reopen, continued v1 immutability, and
fail-closed behavior after activation corruption. This is an integration
milestone, not a claim that every release gate is complete.

Before broad release, complete these remaining gates:

- browser and desktop stores pass the same atomic commit and corruption suite;
- startup and autosave route only by `activation:v2` and cannot write v1 after
  activation;
- stable-map page documents and stable rich-text paths pass concurrent edit,
  merge, reopen, and history tests;
- crash tests cover every phase boundary and both sides of transaction commit;
- rollback backups have a documented retention, restore, and pruning policy;
- close/reopen proves notebooks, pages, trash, assets, active selection, and
  preview-only PDF warnings; and
- support diagnostics expose fingerprints and record status without content.

Unit and Rust tests cover the migration transaction adapters. Browser root
creation and hierarchy/trash revisions use a full-Repo atomic activation CAS;
the matching native revision command remains a release gate until its SQLite
transaction and corruption suite pass. Asset-backed image/PDF rendering,
history recovery UI, v2 portable export/import, and real collaborative
transport remain product gates.
