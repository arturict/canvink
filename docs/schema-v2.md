# Canvink schema v2 foundation

## Status

The visible application now opens through the schema-v2 runtime. Startup checks
`activation:v2` first; when it is absent, the UI automatically runs the checked
v1-to-v2 migration, displays content-free progress, and renders the workspace
only after the committed Automerge roots reopen successfully. A corrupt v2
activation fails closed into recovery instead of falling back to v1 or creating
a blank workspace.

Schema v1 remains migration input and rollback evidence only. Once activation
succeeds, editor changes, navigation, subscriptions, flush, and shutdown use the
v2 runtime. The old v1 application component is no longer mounted. Local search,
history, the asset/PDF pipeline, OneNote import, and the opt-in encrypted-sync
client are wired to this runtime. The Appwrite backend configuration is still
intentionally undeployed, so integration does not imply a live sync service.

## Document model

V2 separates the nested workspace snapshot into records:

- `NotebookDoc` owns notebook metadata, ordered section records, ordered page-document references, and settings.
- `PageDoc` owns page metadata, background, a stable `elementsById` map, and explicit back-to-front `zOrder`. The map keeps Automerge and ProseMirror paths stable when elements are reordered concurrently.
- `PageElementV2` is a closed union of `richText`, `stroke`, `shape`, `image`, `pdf`, and `attachment`.
- Live rich text is canonical Automerge text at `elementsById[elementId].text`; ProseMirror edits this stable path. Portable block/span data remains an import, export, and migration projection rather than a second live authority.

Automerge heads are recorded outside live document roots by persistence and
activation metadata. The roots themselves contain no embedded version field.

## Assets

An `AssetRef` contains a SHA-256 checksum, checksum-derived asset ID, MIME type, decoded byte size, role, and optional file name. `AssetBlob` stores the bytes once under that checksum. Equal byte sequences are deduplicated even when several elements reference them.

Schema-v1 image `dataUrl` values become original asset references. A v1 PDF contains only a rendered preview, not the source PDF. Migration therefore creates a preview asset and sets `sourceAvailability: "preview-only"`; it does not claim the original is recoverable. New v2 PDF and attachment records can reference original assets when an importer actually has those bytes.

## V1 to v2 preparation

`prepareV1ToV2Migration` is a pure, asynchronous preparation step:

1. Clone and validate the complete v1 workspace.
2. Convert notebooks, sections, pages, elements, and trash records.
3. Decode inline assets and address them by SHA-256.
4. Re-hash all resulting blobs and verify every asset reference.
5. Compute deterministic source and artifact fingerprints.
6. Return the manifest, all documents, all blobs, and a preview count as one result.

It does not write storage and does not mutate its input. `preparedAt` is the source workspace timestamp rather than the wall clock, document IDs derive from stable v1 IDs, and assets are checksum-sorted. Repeating preparation for identical v1 input therefore produces an equal result. Malformed data URLs, checksum mismatches, duplicate document IDs, or missing asset references reject the whole result.

Deleted notebooks, sections, pages, and elements are retained through manifest trash descriptors. Their page/notebook documents use a `trash:<entry-id>:` namespace to avoid collisions with live document IDs. Assets referenced only from trash are extracted and verified too.

Legacy pages without an explicit background render as grid in v1, so the migration records `grid`; explicit `blank` becomes v2 `plain`.

## Browser repository and activation

The browser activation store uses dedicated IndexedDB storage and commits the
verified v1 backup, checksum assets, Automerge Repo chunks, and
`activation:v2` in one transaction. The activation record is the only startup
authority selector. The older `migration:v1-to-v2:committed` marker is not an
activation record.

The source v1 storage key is retained and never changed by the v2 runtime. A
successful activation can therefore expose a detached rollback copy without
making v1 writable or silently switching authority.

`AtomicKeyValueStore` is injectable. Tests use an in-memory transaction adapter to prove abort behavior without relying on an IndexedDB mock. Any alternate adapter must uphold the documented all-or-nothing `setMany` contract.

## Integrated projections and services

Schema-v2 documents and verified assets remain the local authority. Features
attached to that authority have different durability and trust roles:

- Search and accepted OCR text are rebuildable local projections. Browser uses
  IndexedDB; Windows uses the local SQLite FTS5 commands.
- History stores checksummed Automerge snapshots with heads. Manual, automatic,
  and trash checkpoints can be previewed and restored as a new page copy.
- Asset operations stage originals and previews with the workspace revision;
  image/PDF/attachment display, bounded PDF import, PDF/PNG/Markdown export, and
  additive `.canvink` bundle import/export are mounted in the shell. PDF export
  structurally copies available original source pages, strips interactive
  catalog/page entries, and adds the current Canvink overlay; source-less or
  placed visual elements continue through bounded raster inputs.
- OneNote import stages one new notebook through the additive revision path.
  Packaged authentication uses the strict native Microsoft/loopback bridge,
  while browser authentication remains a redirect flow. Source `data-tag`
  values project into page tags/task state/checklists, and an optional local
  one-page PDF fallback carries separate original and rendered-preview asset
  references for its locked page background.
- Optional sync extracts Automerge changes, encrypts and signs them, writes them
  to the durable local outbox, and then calls the Appwrite transport. Sync can be
  disabled without changing the local authority.
- Windows DPAPI protects sync-device and private notebook key material. It does
  not encrypt the ordinary local notebook store.

## Sidebar structure transfers

Notebook and section ordering is part of the persisted schema-v2 graph, not a
device-local UI preference. Notebook order follows
`manifest.notebookDocumentIds`; section order follows `NotebookDoc.sections`.
The sidebar exposes the same operations to pointer and keyboard users:

- Dropping before or after a notebook/section uses the corresponding ordered
  insertion position. Dropping a section on a notebook uses `inside`, meaning
  append to that notebook. Arrow/menu controls provide the same reorder,
  duplicate, move, and copy operations without drag-and-drop.
- Ctrl or Alt during a drag requests a copy. Notebook copies receive new
  notebook, section, and page IDs. Section copies receive a new section ID and
  new page IDs. Parent-page links are remapped only within the copied set, so a
  copy cannot retain a pointer into its source hierarchy.
- A cross-notebook section move updates both notebook roots and every contained
  page document in one checked workspace graph revision. Moving the last
  section out of a notebook is rejected so every notebook retains a section.
- Viewer mode disables every structural drag and keyboard mutation. German and
  English labels plus a polite live region announce pickup and move/copy intent.

Every successful operation is validated, committed, reopened, and then
navigated. A reload therefore projects the same notebook/section order and
active location from the activation manifest.

## Canvas ruler and performance evidence

The movable ruler is device-local page UI state, not a `PageElementV2` or
collaborative document field. It persists locally per page, supports pointer and
keyboard movement plus free rotation, and supplies the snapping edge used by
pen and straight tools. Automated browser coverage verifies its behavior across
zoom, pan, reload, and language changes; physical-pen ergonomics remain outside
that proof.

Performance samples contain only metric name, duration, and timestamp. The
strict pen exporter cannot produce acceptance evidence until a real session has
at least 20 samples, spans 45 minutes, and stays below the p95 threshold; its
output is additionally bound to the exact repository commit and package
version. Automated serializer/validator tests are contract evidence, not a
replacement for the still-open physical session.

## Known limits and remaining acceptance work

- Browser hierarchy operations stage a complete Repo image and atomically
  compare-and-swap the activation. The visible shell supports notebook,
  section, page, and subpage creation; cycle-safe hierarchy changes;
  cross-section/notebook move and copy; duplicate; trash; restore; and
  permanent deletion. A platform without the dedicated atomic revision store
  fails these commands closed.
- History checkpointing, bounded retention, integrity checks, copy-based restore,
  and the history UI are implemented. A personal encrypted backup/restore drill
  is still required because local history is not a device backup.
- Assets and v2 bundle/PDF/PNG/Markdown paths are wired into the shell. Target
  school-hardware limits and representative personal PDF fidelity remain unrun.
- The encrypted sync client, Appwrite adapters, outbox/cursors, accounts, roles,
  device approval, key envelopes, and bounded presence are implemented. The
  backend has not been pushed, two real accounts have not been exercised, and
  the exact 60-minute soak artifact is not yet present.
- Windows OCR is implemented as a local derived-text path, but representative
  personal scans and installed German/English language packs remain untested.
- DPAPI key protection is implemented and automatically tested; a real packaged
  restart/unlock on target Windows remains outstanding.
- The v1 PDF representation cannot supply original PDF bytes; only its preview can be migrated.
- Browser persistence remains origin/profile scoped and is not a backup or sync service.
- Corrupt-start recovery currently offers diagnosis/retry and never opens v1;
  verified rollback-copy download is available after a healthy v2 open.
- No trusted certificate has been configured and no verified signed build has
  been produced. Normal builds remain unsigned unless signed mode is explicit.

See [acceptance-matrix.md](acceptance-matrix.md) for commands, evidence paths,
and the distinction between automated implementation evidence and live gates.
