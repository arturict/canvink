# Canvink file format v1

## Status and scope

Schema version `1` is the logical workspace format introduced by the first public alpha. It is documented so users and contributors can inspect the data model. It is not a promise that every future 0.x build will read every experimental file without migration.

The desktop application treats SQLite as the authoritative store. The browser demo stores the same logical JSON scene in IndexedDB. The nested workspace shape, rather than either storage engine, defines the v1 domain model.

## Core rules

- `schemaVersion` must be the integer `1`.
- IDs are opaque, case-sensitive strings. Consumers must not derive meaning from an ID prefix.
- Timestamps are ISO 8601 strings in UTC.
- Coordinates and dimensions are finite numbers in page-space CSS pixels.
- The origin is the top-left of the page.
- Array order is significant.
- `elements[]` order is back-to-front z-order unless a reader explicitly documents another behavior.
- Unknown element kinds must not be silently converted into known kinds.
- A writer must not report success until its durable storage adapter confirms the write.
- Readers must reject, quarantine, or explicitly migrate unsupported schema versions. They must not replace unsupported data with a blank workspace and save over it.

## Logical JSON shape

The following example is shortened but structurally complete:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-07-29T12:00:00.000Z",
  "notebooks": [
    {
      "id": "notebook-018f...",
      "title": "Research",
      "color": "#d7653b",
      "createdAt": "2026-07-29T11:00:00.000Z",
      "updatedAt": "2026-07-29T12:00:00.000Z",
      "sections": [
        {
          "id": "section-018f...",
          "title": "Reading",
          "createdAt": "2026-07-29T11:00:00.000Z",
          "updatedAt": "2026-07-29T12:00:00.000Z",
          "pages": [
            {
              "id": "page-018f...",
              "title": "Paper notes",
              "mode": "free",
              "createdAt": "2026-07-29T11:00:00.000Z",
              "updatedAt": "2026-07-29T12:00:00.000Z",
              "elements": [
                {
                  "id": "text-018f...",
                  "kind": "text",
                  "x": 96,
                  "y": 80,
                  "width": 520,
                  "height": 90,
                  "text": "A freely positioned note",
                  "color": "#1e2925",
                  "fontSize": 22,
                  "fontFamily": "Inter, ui-sans-serif, system-ui, sans-serif",
                  "fontWeight": 500,
                  "createdAt": "2026-07-29T11:01:00.000Z",
                  "updatedAt": "2026-07-29T11:01:00.000Z"
                },
                {
                  "id": "stroke-018f...",
                  "kind": "stroke",
                  "tool": "pen",
                  "x": 0,
                  "y": 0,
                  "points": [
                    {
                      "x": 120,
                      "y": 210,
                      "pressure": 0.45,
                      "tiltX": 0,
                      "tiltY": 0,
                      "time": 1785322860000,
                      "pointerType": "pen"
                    }
                  ],
                  "color": "#1e2925",
                  "size": 6,
                  "opacity": 1,
                  "createdAt": "2026-07-29T11:01:00.000Z",
                  "updatedAt": "2026-07-29T11:01:00.000Z"
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  "trash": [],
  "activeNotebookId": "notebook-018f...",
  "activeSectionId": "section-018f...",
  "activePageId": "page-018f..."
}
```

## Workspace fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Logical format version |
| `updatedAt` | timestamp | Last workspace mutation |
| `notebooks` | `Notebook[]` | Ordered notebook collection |
| `trash` | `TrashEntry[]` | Recoverable deleted items |
| `activeNotebookId` | string | Last active notebook |
| `activeSectionId` | string | Last active section |
| `activePageId` | string | Last active page |

Each notebook contains ordered sections. Each section contains ordered pages. Each page contains ordered elements and a `mode` of `free` or `a4`.

The three active IDs are interface state. A repair tool may choose the first valid nested item when an active ID no longer resolves, but it must not discard valid content.

## Element base

Every element has:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable opaque identity |
| `kind` | string | Discriminator |
| `x`, `y` | number | Page-space position |
| `createdAt` | timestamp | Creation time |
| `updatedAt` | timestamp | Last element mutation |

### Stroke

`kind` is `stroke`. `tool` is `pen` or `highlighter`.

`points` is an ordered list of `{x, y, pressure, tiltX, tiltY, time, pointerType}` samples. Pressure is normally between `0` and `1`, but readers should clamp values for rendering instead of assuming every input device behaves perfectly. `size`, `color`, and `opacity` control rendering.

### Text

`kind` is `text`. The element stores plain `text`, `width`, `height`, `color`, `fontSize`, `fontFamily`, and `fontWeight`.

Rich text is not part of schema v1. Readers must treat text as text, not trusted HTML.

### Image

`kind` is `image`. The alpha shape stores `dataUrl`, `name`, `alt`, `width`, and `height`.

Data URLs make a scene portable but are inefficient for large assets. A future normalized asset store will require a documented migration. Readers must validate media type and decoded size before rendering.

### PDF

`kind` is `pdf`. The alpha shape stores `previewDataUrl`, `sourceName`, `pageCount`, `width`, and `height`.

The preview is not a guarantee that the complete original PDF is recoverable. Export and attachment interfaces must state whether they include the original source file.

## Trash entries

A trash entry records:

- Its own `id`
- `kind`: `notebook`, `section`, `page`, or `element`
- `deletedAt`
- An `origin` containing applicable notebook, section, and page IDs
- The deleted `item`

The optional origin fields `index`, `previousSiblingId`, and `nextSiblingId`
preserve array order across deletion and restoration. Page entries can also
record `originalParentPageId` and `childPageIds` so subpage relationships
survive parent-first deletion. Readers must treat these values as untrusted
references, bound their size, and handle missing or cyclic references safely.

Schema v1 code may only restore the entry kinds it explicitly supports. Unsupported restore paths must leave the entry intact.

## Desktop SQLite representation

The v0.1 desktop adapter stores the nested workspace in normalized SQLite tables. The JSON shape above is the interchange and migration contract. SQLite is the authoritative desktop container.

`PRAGMA user_version` is the database schema version. It is separate from `WorkspaceState.schemaVersion`, although both are `1` in the initial release.

| Table | Purpose |
| --- | --- |
| `meta` | Workspace schema version, update time, active IDs, trash JSON, and forward-compatible root fields |
| `notebooks` | Notebook identity, title, explicit order, timestamps, and extra JSON |
| `sections` | Ordered notebook children with enforced ownership |
| `pages` | Ordered section children, page mode, optional future parent page, timestamps, and extra JSON |
| `elements` | Ordered page children, common geometry, and tool-specific `data_json` |
| `search_fts` | Rebuilt FTS5 text index for notebooks, sections, pages, and textual element payloads |

Entity tables are SQLite `STRICT` tables. Foreign keys enforce the nested ownership model and delete dependent rows within the replacement transaction. The desktop adapter validates the complete workspace, starts an `IMMEDIATE` transaction, replaces the normalized rows, rebuilds search data, commits once, and reloads the result.

Connections enable foreign keys, a busy timeout, WAL journal mode, and full synchronous writes. A newer `PRAGMA user_version` is rejected instead of being opened as if it were v1.

The database path is `<Tauri app data>/canvink/notebook.sqlite`. The Rust backend chooses this path. The webview cannot provide an arbitrary database or filesystem path.

WAL and SQLite temporary files are internal implementation details and must not be copied alone as a backup. Do not edit a live database with a general SQLite tool. Prefer Canvink's portable JSON export. If copying the database directly, close Canvink first and include any required SQLite sidecar state.

## Browser IndexedDB representation

The browser adapter stores one namespaced workspace value containing the same schema v1 object. The IndexedDB database name, object-store name, and key are adapter details, not cross-origin interchange identifiers.

Changing the hosted origin, browser profile, or storage partition creates a different persistence domain. Browser users should not expect the desktop database to appear automatically.

The browser adapter takes an exclusive Web Lock before loading the workspace for editing. A second tab fails closed instead of becoming another writer. This coordination is origin-scoped and does not turn IndexedDB into durable or synced storage.

## Validation and recovery

A schema v1 reader should validate:

1. Root type and `schemaVersion`
2. Nested arrays and required fields
3. Finite coordinates and dimensions
4. Element discriminators
5. Active-ID referential integrity
6. Bounded asset and scene sizes

Normalization can repair missing optional UI state. It must not turn an unsupported or malformed workspace into a default workspace and then overwrite the original without explicit user confirmation and a recoverable backup.

## Migrations

A format migration must be:

- Forward-only in normal application startup
- Transactional on desktop
- Tested from representative prior fixtures
- Documented in this file or its successor
- Preceded by a recoverable backup
- Idempotent or protected by a recorded migration version

Schema version `2` must be introduced when an older reader could lose, misread, or overwrite new information.
