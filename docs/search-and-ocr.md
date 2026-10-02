# Local search and Windows OCR

Canvink treats both search records and OCR output as disposable projections. Notebook/Page Automerge documents, rich-text documents, tags, assets, extracted PDF text, and accepted OCR text remain the local source of authority. Losing or deleting a search database must never lose notebook content.

## Search projection

`src/search/projection.ts` deterministically projects each live page into these fields:

- page, notebook, and section titles
- tags and task state
- rich-text paragraphs, headings, lists, quotes, code, tables, and check items
- locally extracted PDF text
- locally recognized OCR text

Deleted/tombstoned source records must be filtered before projection. A full rebuild sorts by document ID, rejects duplicates, and atomically replaces the derived index. Incremental upsert/remove operations use the same projector. The IndexedDB adapter validates versioned records and discards/rebuilds corrupt data; the in-memory adapter is the browser/test fallback. The Windows desktop adapter sends only the same bounded projections to the local SQLite FTS5 `search_v2` table.

Portable in-memory ranking weights titles highest, followed by tags, checklist items, notebook/section titles, rich text, PDF text, and OCR text. All normalized query tokens must match somewhere in a record. Results have deterministic score/update/page tie-breaking and snippets capped at 180 characters. SQLite returns FTS snippets using `<mark>` markers; callers must render them as text plus explicit highlight spans, never as trusted HTML.

## Query operators

A query is split into free-text terms and bounded operators before ranking:

- `tag:<name>` narrows to pages carrying that tag. The value passes through the same normalizer as manual and imported tags, so `tag:Prüfung` matches a stored `prufung`, and a tag stored before normalization existed still matches its normalized query form. At most eight tag filters per query.
- `is:open`, `is:done`, and `is:task` narrow by page task state; `is:task` means open or done.
- A term that looks like an operator but carries an unknown value stays free text. A typo such as `is:offen` therefore searches for that text instead of silently returning nothing.

Operators may be used alone. A query with only operators returns every matching page ordered by the recency tiebreaker, with no term to score or highlight. The task and tag dropdowns in the search panel compose the same syntax, so a typed operator and a selected filter can never disagree, and the cross-page task review is `is:task` under one presentation.

Limits are deliberately finite: 100,000 records, 512 KiB per field, 2 MiB per record, a 512-byte query, 24 query tokens, 96 characters per token, and at most 100 results. Text is Unicode NFKC-normalized and case-folded without a user locale. A diacritic-folded token is indexed alongside the original so German words remain searchable while `Straße` can also match `strasse`.

The index has no network transport and no sync role. Startup may load a valid IndexedDB projection; any version mismatch, malformed record, duplicate ID, or storage decode failure clears it and rebuilds it from live local documents. SQLite failures should follow the same explicit clear/full-rebuild path.

## Windows OCR

`src-tauri/src/ocr.rs` uses the installed `Windows.Media.Ocr` runtime. There is no HTTP client, cloud service, telemetry upload, or browser OCR fallback. The desktop commands are:

- `ocr_available_languages`
- `ocr_recognize_image`

The caller supplies canonical padded Base64 for decoded PNG, JPEG, BMP, or TIFF bytes. Input is capped at 32 MiB, 50 million decoded pixels, and the Windows OCR maximum side length. An optional bounded BCP-47 tag must exactly match an installed Windows OCR language; otherwise Windows chooses from the user profile. Results contain the selected language, recognized text, optional text angle, lines, words, and word bounding boxes. `Windows.Media.Ocr` does not expose per-word confidence, so confidence is intentionally absent rather than invented.

`OcrQueue` serializes work and permits at most eight active/pending jobs. Aborting a queued job removes it. Windows does not provide a reliable cross-IPC cancellation primitive for an already-running recognition call, so active cancellation discards the eventual result and prevents persistence. Image buffers are copied before enqueueing to avoid caller mutation. Only text/box projections selected by the application may be persisted; decoded image buffers are not retained by the OCR layer.

Browser builds expose an explicit unsupported adapter. They never silently upload an image or substitute a remote OCR provider.

### Personal scan diagnostic

In the Windows desktop build, first add the personal scan to the active local workspace and copy its verified `sha256:...` asset ID. The developer console then exposes a read-only smoke hook:

```js
await window.__CANVINK_LOCAL_OCR_DIAGNOSTIC__({
  assetId: 'sha256:<64 lowercase hex characters>',
  languageTag: 'de-DE',
});
```

The result reports the actual Windows engine, selected installed language, recognized text, and line count. This diagnostic does not persist OCR text or alter the source asset; the explicit **Text lokal erkennen** action is the product path that persists the derived text projection. The hook exists only while an initialized local search controller owns the workspace. Treat a browser mock as automated plumbing evidence, never as Windows OCR or language-pack acceptance.

## Verification gates

Automated gates cover deterministic projection, Unicode and German matching, ranking/snippets, incremental/full rebuild equivalence, corruption discard/rebuild, size bounds, Tauri input validation, native SQLite replace/upsert/remove/query/clear, OCR queue cancellation/backpressure, and Rust format/clippy/tests.

Before release, run a Windows 11 desktop smoke test with installed German and English OCR language packs and representative phone scans, screenshots, textbook pages, and locally rendered PDF pages. Verify rotated text, bounding boxes, memory/queue behavior, multi-megapixel limits, and that no request leaves the device. Printed/typed text is the supported baseline; handwriting and mathematical-layout recognition are quality experiments, not release claims.
