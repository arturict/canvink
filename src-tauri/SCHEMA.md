# Canvink local database

Canvink stores its local workspace at
`<Tauri app data>/canvink/notebook.sqlite`. The Rust backend is the only code
that receives this path. IPC callers cannot choose a database or filesystem
path.

## Durability

Every connection enables foreign keys, a 10 second busy timeout, WAL journal
mode, `synchronous=FULL`, `fullfsync=ON`, and
`checkpoint_fullfsync=ON`. A save validates the complete input, starts an
`IMMEDIATE` transaction, replaces the normalized workspace rows, rebuilds the
search index, and commits once. Any serialization, constraint, trigger, I/O, or
commit error rolls the entire replacement back.

`PRAGMA user_version` is the authoritative database schema version. Migrations
run serially in `IMMEDIATE` transactions and refuse to open a database created
by a newer Canvink schema.

## Schema version 1

| Table | Purpose and relationships |
| --- | --- |
| `meta` | Small workspace-wide values such as state schema version, current selection, trash JSON, and forward-compatible root fields. |
| `notebooks` | Notebook identity, title, stable ordering, timestamps, and forward-compatible JSON fields. |
| `sections` | Ordered children of `notebooks`; deletion cascades from the owning notebook. |
| `pages` | Ordered children of `sections`, with `free` or `a4` mode and an optional deferred self-reference for subpages. |
| `elements` | Ordered canvas children of `pages`; common geometry is typed, while tool-specific payloads remain lossless JSON. |
| `search_fts` | FTS5 index for notebook, section, page, and element text. IDs and kinds are unindexed filter columns. |

Entity tables are SQLite `STRICT` tables. IDs are primary keys, ownership is
enforced by foreign keys, numeric dimensions are constrained, and every JSON
extension column must satisfy `json_valid`. Ordering is stored separately from
entity payloads so loading deterministically rehydrates the nested
`WorkspaceState`.

Image and PDF data URLs are deliberately not copied into FTS. Search extraction
only indexes textual fields such as text, title, alternative text, captions,
Markdown, and tags, with a per-entity size limit.

## Additive schema version 2

Database schema version 2 adds document, asset, Automerge Repo, migration,
snapshot, and sync persistence. Existing schema-v1 workspace rows remain the
authoritative read path while `documents.activeVersion` is `1`; the schema
upgrade itself never deletes or rewrites them.

| Table | Purpose |
| --- | --- |
| `crdt_documents` | Bounded document metadata, complete SHA-256, encoding, heads, and chunk count. |
| `crdt_document_chunks` | Ordered, individually hashed chunks. A complete-blob write is split into the same representation. |
| `repo_storage` | Automerge Repo `StorageAdapter` values addressed by hierarchical `string[]` keys. |
| `assets` | Deduplicated original bytes addressed by a verified SHA-256 and MIME type. |
| `sync_outbox` / `sync_cursors` | Durable pending envelopes and monotonic notebook sequence cursors. |
| `document_snapshots` | Named, checksum-verified point-in-time document bytes and heads. |
| `migration_runs` | Durable prepared/committed/rolled-back marker and fingerprints. |
| `migration_stage_*` | Inactive document chunks, Repo values, and assets awaiting atomic activation. |
| `search_v2` | Rebuildable derived search projection. |

Repo keys use an unambiguous canonical encoding: every UTF-8 component is
lowercase hex followed by `/`. Therefore `['ab']`, `['a', 'b']`, and prefix
`['a']` cannot collide. Exact reads use the primary key; range reads compare the
complete encoded prefix and return canonical encoded-key order. Returned BLOBs
are owned Rust vectors, so an IPC caller cannot mutate the stored value.

All BLOB writes are bounded before opening their transaction. Documents are at
most 64 MiB with 4 MiB chunks, Automerge Repo values are at most 32 MiB, assets
and snapshots are at most 64 MiB, outbox envelopes are at most 8 MiB, and
identifiers, heads, MIME types, timestamps, range sizes, and JavaScript-visible
integers have independent limits. External checksums use only canonical
`sha256:<64 lowercase hex>` values. SHA-256 is
recomputed before every write and after every BLOB read; SQLite also enforces
stored byte counts and lowercase hash shapes.

Migration staging verifies every supplied document, asset, Repo key/value, and
manifest before writing inactive staging tables. Commit opens one `IMMEDIATE`
transaction, re-verifies staged bytes, writes documents, Repo chunks, and
assets, records `documents.activeMigrationId`, flips
`documents.activeVersion` to `2`, marks the run committed, and clears staging.
Any trigger, constraint, hash, I/O, or commit failure rolls all of those changes
back and leaves the prepared stage retryable. Rolling back a prepared run only
clears its staging rows and records `rolled-back`; it never changes v1 data.

## Authority schema version 3

Database schema version 3 adds `migration_stage_workspace_authority` and the
singleton `workspace_v2_authority` row selected by `activation:v2`. The staged
row contains the full activation JSON and checked v1 rollback backup with
independent SHA-256 hashes. The migration commit publishes that row in the same
`IMMEDIATE` transaction as assets and Repo chunks. Startup treats a present but
unreadable authority row as corruption; it never falls back to schema v1.

## Atomic revision schema version 4

Database schema version 4 adds `workspace_v2_imports` and
`workspace_v2_import_backup_repo`. A dedicated additive-import transaction
compares the caller's complete expected activation to the current authority,
verifies the proposed complete Repo image and every referenced asset, stores an
immutable receipt plus the exact prior Repo image, and publishes the new
activation. Repeating the same committed import is idempotent.

Import rollback is equally guarded: it succeeds only while the current
activation is exactly the activation committed by that import. A later graph
revision therefore prevents an older import from deleting data on which the
new revision may depend. Successful rollback restores the complete prior Repo
image and prior activation in one `IMMEDIATE` transaction. Content-addressed
asset blobs remain immutable and may be shared by other revisions.

Ordinary live graph edits use the same activation compare-and-swap rule through
the generic workspace-revision transaction. They replace the complete physical
Repo image and publish its checked activation atomically, so removed Repo keys
cannot survive as stale data.

## Delta revisions (no schema change)

Workspaces written since lazy page loading use two further commands on the
existing tables; `PRAGMA user_version` stays 5.

- `v2_commit_workspace_delta_base64` compares the caller's complete expected
  activation to the current authority, stores new assets, deletes the given
  key prefixes (each naming one document inside `automerge-repo`,
  `canvink-page-index` or `canvink-dirty`), upserts the given Repo entries and
  publishes the new activation, in one `IMMEDIATE` transaction. It never
  replaces the complete Repo image. With a receipt it records an additive
  import in `workspace_v2_imports` without a backup image; the receipt's
  `rollback.prefixes` name what a rollback removes.
- `v2_stage_workspace_entries_base64` writes unreferenced Repo entries and
  assets ahead of a delta commit (large imports stage pages in batches).

`v2_rollback_workspace_import` restores such an import by deleting the
receipt's prefixes and republishing the prior activation, leaving every other
Repo row untouched; complete-image imports keep the previous behaviour. The
`canvink-page-index` and `canvink-dirty` rows are derived data: a
complete-image publish may delete them, and the app rebuilds them.

## History schema version 5

Database schema version 5 keeps the existing checksum-verified
`document_snapshots` records but removes their legacy foreign key to
`crdt_documents`. Active graph revisions are authoritative through
`activation:v2` and the complete Automerge Repo image, so imported, duplicated,
or history-restored pages may legitimately have no legacy document row. The
snapshot document ID remains bounded and indexed; reads verify stored size,
heads, and SHA-256 before returning bytes.

## IPC surface

The application preserves the two schema-v1 commands:

- `load_workspace() -> WorkspaceState`
- `save_workspace({ workspace: WorkspaceState }) -> WorkspaceState`

The schema-v2 IPC surface is path-free and record-scoped:

- documents: `v2_put_document`, `v2_get_document`,
  `v2_get_document_chunk`, `v2_list_documents`, `v2_delete_document`;
- Automerge Repo storage: `v2_repo_save`, `v2_repo_load`, `v2_repo_remove`,
  `v2_repo_load_range`, `v2_repo_remove_range`, plus the production Base64
  bridge commands `v2_repo_load_base64`, `v2_repo_load_range_base64`, and
  `v2_repo_commit_base64`;
- assets: `v2_put_asset`, `v2_get_asset`, `v2_get_asset_metadata`;
- migration: `v2_stage_migration`, `v2_commit_migration`,
  `v2_rollback_migration`, `v2_get_migration_marker`,
  `v2_stage_workspace_migration_base64`, and
  `v2_get_workspace_authority_base64`;
- active graph transactions: `v2_additive_import_base64`,
  `v2_get_workspace_import_receipt_base64`,
  `v2_rollback_workspace_import`,
  `v2_commit_workspace_revision_base64`,
  `v2_commit_workspace_delta_base64`, and
  `v2_stage_workspace_entries_base64`;
- Windows key protection: `protect_key_material` and
  `unprotect_key_material` use current-user DPAPI as documented in
  `docs/key-protection.md`;
- sync: `v2_put_outbox`, cursor-paginated `v2_list_outbox` (`afterLocalOrder`), `v2_delete_outbox`,
  `v2_put_sync_cursor`, `v2_get_sync_cursor`, and the authenticated-reset-only
  compare-and-swap command `v2_reset_sync_cursor`; and
- snapshots: `v2_put_snapshot`, `v2_get_snapshot`, `v2_list_snapshots`,
  `v2_delete_snapshot`, and checksum-guarded history rotation through
  `v2_delete_snapshot_guarded`.

The save result is loaded back from SQLite, so a successful response also proves
that the committed normalized rows can be rehydrated. The capability manifest
grants Tauri core defaults plus the narrow window-destroy permission required by
the save-before-close handler. It grants no shell, filesystem, HTTP, updater, or
network plugin permission.
