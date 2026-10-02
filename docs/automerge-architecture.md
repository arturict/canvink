# Automerge architecture

Canvink schema v2 stores each notebook index and each page as a separate
Automerge document. Assets remain content-addressed binary blobs outside the
CRDT. This keeps ordinary page editing from rewriting a whole notebook and
allows the opt-in encrypted-sync coordinator to exchange page changes
independently without making a remote service the local authority.

## Pinned foundation

- `@automerge/automerge` 3.4.0 provides the CRDT document, binary format,
  changes, heads, history, views, merges, and conflict inspection.
- `@automerge/automerge-repo` 2.5.6 and
  `@automerge/automerge-repo-storage-indexeddb` 2.5.6 provide the browser-local
  repository factory.
- `@automerge/prosemirror` 0.2.0 and the exact ProseMirror model, state, view,
  list, table, history, command, keymap, and input-rule packages provide the
  canonical rich-text span encoding and editor binding.

The optional native `cbor-extract` build is disabled. Automerge Repo's portable
JavaScript CBOR path is sufficient for the factory and avoids an unreviewed
native install script.

## Document boundary

`src/crdt/document.ts` accepts portable `NotebookDoc` and `PageDoc` projections
at creation time, then materializes distinct `LiveNotebookDocV2` and
`LivePageDocV2` roots. It exposes:

- notebook/page creation and binary load/save;
- immutable changes with optional expected-head guards;
- merge, full/delta change extraction, and change application;
- current heads, current and historical snapshots, and decoded history;
- recursive map/list property conflict reports with operation IDs and values;
- page-specific change, extraction, and application entry points.

`documentId` and `kind` are immutable identity fields at this boundary. A load
checks the schema version, identity fields, kind-specific root collections,
stable element-map invariants, and canonical live rich-text fields. Callers can
additionally require an expected document ID and kind.

Live roots and snapshots contain no `version` field. Heads are available only
through `getAutomergeHeads`, historical API arguments, activation metadata,
and `StoredDocumentV2.version`. Writing heads into the document would create a
new head recursively, so binary-load validation rejects such a root.

Rich-text elements have one mutable authority:
`elementsById[elementId].text`. The value is an Automerge rich-text string and
may contain block-marker object replacement characters; callers must use
`Automerge.spans` or `src/crdt/richText.ts`, not parse the raw string. A live
rich-text element never contains portable `content`.

Changes omit wall-clock time unless the caller supplies Unix seconds. This
makes controlled initialization deterministic. A caller should replace its
working document with the value returned by `change` or `merge`; Automerge may
mark older same-actor instances as outdated. Change application clones its
target so replay remains safe when an earlier snapshot was already used to
produce a local change.

## Deterministic v1 materialization

`src/crdt/migration.ts` first uses the deterministic v1-to-v2 projection. For
each document it derives a 64-character actor ID from the migration artifact
fingerprint and document ID. Portable rich text passes through
`portableToProseMirror`, official `pmNodeToSpans`, and
`Automerge.updateSpans` at the stable element path. The migration saves real
Automerge bytes, reloads them, verifies a semantic portable round trip, and
records the actual heads in a binary `StoredDocumentV2`.

Running the materialization twice for identical v1 input produces identical
document IDs, heads, and bytes. Actor IDs are scoped to this one deterministic
migration history. They must not be reused as device actors for later edits.

## Browser repository

`createBrowserAutomergeRepo` constructs a Repo with the confirmed 2.5.6
`IndexedDBStorageAdapter(databaseName, objectStoreName)` API. It installs an
empty Automerge Repo network-adapter list and sets the repository as persistent.
Optional sync does not weaken that local boundary: a separate coordinator
extracts Automerge changes, encrypts/signs them, durably enqueues them, and uses
the Appwrite transport. The Repo factory itself is not peer discovery,
authentication, authorization, presence, or cloud backup.

### Canvink storage adapter and browser database

`src/crdt/canvinkStorageAdapter.ts` implements the exact Automerge Repo 2.5.6
`StorageAdapterInterface`. The authority-aware schema-v2 runtime uses the
Canvink storage/activation boundary for migration and live workspace commits;
the smaller package adapter remains useful in isolated browser Repo factory
tests.

Repo keys remain hierarchical `string[]` values from API boundary to durable
storage. The adapter adds a configurable `['automerge-repo']` namespace as an
array segment and IndexedDB stores the complete array as the native object-store
key. It never joins components with `/`, `.`, NUL, or another delimiter, so
`['course/math', 'page']`, `['course', 'math/page']`, and
`['course', 'math', 'page']` remain distinct. Prefix operations compare complete
segments and cannot confuse `['doc']` with `['document']`.

`load`, `save`, `remove`, `loadRange`, and `removeRange` clone all keys and
bytes across the adapter boundary. Save/remove operations are idempotent.
Range results use a canonical terminal-segment-first order, with exact prefix
keys before their descendants and full-key comparison as a tie-breaker. This
makes chunk ordering stable across IndexedDB, the in-memory implementation, and
the native Tauri bridge rather than depending on write timing or a backend's
cursor behavior.

Default defensive bounds are 32 key segments, 4 KiB per segment, 16 KiB per
complete key, 32 MiB per value, 10,000/128 MiB per range, and 20,000/256 MiB per
atomic commit. Empty segments, control characters, non-binary values, duplicate
range keys, out-of-prefix bridge results, and invalid limit configurations fail
closed. Applications can lower these values, but raising them is an explicit
resource-policy decision.

The IndexedDB bridge uses one `canvink-v2` database and a
`documents-assets-repo` object store by default. A blocked open/upgrade rejects
with `CanvinkStorageBlockedError` instead of waiting indefinitely. A
`versionchange` event closes the connection immediately, calls the optional
coordination hook, and makes later operations fail until a new adapter is
created. ZIP-like upper-bound sentinels are not used for prefix scans; cursors
start at the native array prefix and stop at the first non-matching segmented
key.

### Shared atomic migration boundary

`CanvinkStorageBridge` is injectable. The browser implementation uses a single
IndexedDB transaction; `MemoryCanvinkStorageBridge` uses a copy-on-write shadow;
a native implementation must either provide the same all-or-nothing `commit`
contract or reject a plan it cannot commit atomically before applying anything.

`CanvinkStorageAdapter.commitAtomically` accepts two mutation groups:

- `repo` keys are Automerge keys and receive the configured repo namespace;
- `shared` keys are already hierarchical absolute keys, such as
  `['assets', checksum]`, `['manifest', 'current']`, and
  `['activation', 'current']`.

Both groups become one bridge commit. The migration orchestrator can therefore
publish verified Repo chunks, original assets, the manifest, and the activation
marker in one IndexedDB/native transaction. Shared mutations are forbidden from
overlapping the Repo namespace. Hashing, document validation, and serialization
must finish before entering this storage-only commit boundary.

The authority-aware browser activation store publishes verified Repo chunks,
assets, receipts/rollback data where applicable, and the replacement activation
through one guarded transaction. Operation-local asset staging refuses direct
writes so visible imports cannot publish bytes before their workspace commit.
Standalone asset-store tests remain separate from that orchestration and are
not evidence for a different backend's atomicity.

### Native Tauri bridge

`src/crdt/tauriStorageBridge.ts` implements `CanvinkStorageBridge` over only the
narrow path-free commands already registered by the desktop backend:

- `v2_repo_load({ key })`
- `v2_repo_save({ key, data })`
- `v2_repo_remove({ key })`
- `v2_repo_load_range({ prefix })`
- `v2_repo_remove_range({ prefix })`

`TauriCanvinkStorageBridge` requires the Tauri runtime marker unless an invoke
function is explicitly injected for testing or another reviewed native shell.
Keys remain cloned arrays and are validated against the same 32-segment,
4-KiB-component, and 16-KiB-total native limits. Range records must contain only
`key` and `data`, remain inside the exact segmented prefix, be unique, and stay
inside the caller and native entry/byte limits.

Rust currently serializes `Vec<u8>` command arguments and results as byte
arrays. The bridge accepts that real command shape plus canonical Base64 strings
and optimized `Uint8Array`/`ArrayBuffer` responses. Every representation is
normalized through strict RFC 4648 Base64: whitespace, URL-safe characters,
bad padding, non-zero discarded padding bits, invalid numeric bytes, and
oversized decoded values are rejected. Bytes are cloned before send and after
receive. Base64 is an IPC validation/normalization boundary, not encryption.

Each `v2_repo_save`, `v2_repo_remove`, and `v2_repo_remove_range` command opens
its own native SQLite transaction and is individually atomic and idempotent.
There is no generic native command that atomically applies several arbitrary
Repo/shared mutations. The bridge therefore rejects `commit` with more than one
mutation before issuing any IPC call. It never loops over commands and reports a
multi-write plan as atomic. A failed invoke becomes `TauriStorageBridgeError`
with the operation, command, optional native error code, and original cause.

The specialized `v2_stage_migration` command is already exposed and accepts
verified documents, assets, manifest bytes, and Repo entries in one native
staging transaction. Desktop migration must use that command followed by
`v2_commit_migration`; it must not send the same material through
`CanvinkStorageAdapter.commitAtomically`, because the generic native bridge will
correctly refuse that multi-mutation plan. `removeRange` preflights any
caller-specific lower limits, then delegates deletion to Rust's bounded single
transaction.

The visible `V2NotebookApp` now consumes these repositories through the
authority-aware workspace runtime. It never selects roots directly: startup
validates `activation:v2`, opens the notebook documents and the active page,
and only then supplies live handles to the editor. Schema v1 is retained as
checked rollback evidence and is never written after activation.

## Lazy page loading

A workspace no longer has to fit into memory. A large OneNote notebook
(398 pages, about 2.1 million ink points) could not be imported because every
page document of the workspace lived in Automerge WebAssembly memory at once:
at startup, during an import, and in every topology commit, which read,
staged and reopened the complete Repo image.

**What is in memory.** `WorkspaceV2Runtime` loads the notebook documents and
the active page into the Automerge Repo. Other pages are loaded when they are
opened and kept in a small least-recently-used set (four besides the active
one by default). A page leaves the Repo only after the Repo wrote it and its
index entry is current, and never while it is retained (an editor
subscription, a writer, a sync apply). Automerge Repo 2.5.6 stores an empty
document when a handle is unloaded (`removeFromCache`), which would delete the
page's chunks; the runtime removes the Repo's save listener before unloading.

**What the workspace state contains.** `V2RuntimeState.pages` holds a
`PageSummary` per page (title, location, parent, tags, task state, page type,
dates, heads), not page contents. Content is read with `readPage` or
`readDocument`: a loaded page in place, any other page loaded from its stored
chunks for the reader only and freed afterwards.

**Page index.** Summaries are stored as derived entries under
`['canvink-page-index', <storage id>]` next to the Repo chunks (IndexedDB and
the Tauri `repo_storage` table alike). Every Repo chunk save also writes a
marker `['canvink-dirty', <storage id>, <chunk>]` in the same atomic storage
commit. At startup an entry is trusted only when it exists, carries the
document's current activation heads and has no dirty marker; any other page
is loaded once, one at a time, to rebuild its entry. This makes a crash
between a page write and its index write harmless.

**Delta commits.** Topology changes (add, move, delete, rename, copy) write
only the documents they touch: changed documents are updated on detached
copies (loaded from storage when they are not in memory), stored as one
incremental chunk each, new documents as one snapshot chunk each; removed
documents lose all their keys. The activation (layout `repo-live`) is
published in the same compare-and-swap transaction (IndexedDB transaction,
or the native `v2_commit_workspace_delta_base64` command). Nothing is reloaded
afterwards. The first delta commit on an older workspace drops the browser's
committed chunk copies (`repo-chunk:<n>`); from then on the live Repo keys are
the only copy and each document's activation heads anchor its integrity when
it is loaded.

**Imports.** `beginAdditiveImport` stages imported pages and assets in bounded
batches as unreferenced storage entries (`stageWorkspaceEntries`), freeing each
page's WebAssembly document right after it is saved, and publishes the
notebook with one small delta commit and an import receipt. The receipt names
the imported documents' key prefixes; a rollback removes exactly those and
restores the prior activation, so edits made to existing pages after the
import survive it.

**Everything that needs all pages** works page by page: the search index is
persisted per page and only stale pages are re-read (`src/components/search`),
the notebook bundle, the whole-workspace backup and the PDF and JSON exports
read one page at a time, and sync applies remote changes to pages that are not
open with `applyRemoteDocumentChanges` (load, apply, persist, free). Sync
ports observe `subscribeToDocumentChanges`, which reports changes of any
document regardless of handle identity.

The legacy schema-v2 to v3 upgrade still uses one complete-image revision; it
runs once per workspace.

## Known limitations

- Binary-load validation checks root identity, kind-specific collections,
  stable element-map/z-order equality, element-key identity, canonical live
  rich text, and absence of embedded heads. It is not full semantic validation
  of every style, asset reference, or rich-text attribute.
- Conflict reporting exposes Automerge register conflicts. It does not detect
  semantic conflicts such as two independent elements overlapping visually or
  a deleted asset still being referenced elsewhere.
- History checkpoints, bounded retention, guarded deletion, preview, and
  copy-based restore are implemented outside the live roots. History still does
  not provide a destructive rewind, a device backup, or a server retention
  policy.
- Assets are referenced by schema-v2 checksum metadata but their bytes are not
  embedded in CRDT documents. The optional sync asset path encrypts verified
  bytes separately.
- The Canvink adapter is in-memory per operation and does not stream large
  values. Its configured byte limits are the resource boundary. A single page
  is still loaded completely when it is opened.
- IndexedDB data is plaintext and origin/profile scoped. The adapter adds
  durability and transaction semantics, not local-at-rest encryption or device
  backup. Optional encrypted sync is a distinct explicitly configured service.
- Native Repo commands are SQLite-atomic one command at a time. Cross-record
  desktop migration atomicity belongs to `v2_stage_migration` and
  `v2_commit_migration`, not the generic Repo adapter.
- Bounded ephemeral presence, encrypted change/asset transport, roles, device
  approval, outbox/catch-up, and conflict badges are implemented through the
  separate Appwrite client path. The tracked backend is undeployed, two-account
  live behavior is unrun, and no exact 60-minute soak report is present yet.
- Real-pen performance, target-Windows DPAPI restart, personal OneNote/OCR/PDF
  checks, and trusted-certificate signing remain external acceptance gates; see
  [acceptance-matrix.md](acceptance-matrix.md).
