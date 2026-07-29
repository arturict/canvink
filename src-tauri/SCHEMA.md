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

## IPC surface

The application exposes two typed commands:

- `load_workspace() -> WorkspaceState`
- `save_workspace({ workspace: WorkspaceState }) -> WorkspaceState`

The save result is loaded back from SQLite, so a successful response also proves
that the committed normalized rows can be rehydrated. The capability manifest
grants Tauri core defaults plus the narrow window-destroy permission required by
the save-before-close handler. It grants no shell, filesystem, HTTP, updater, or
network plugin permission.
