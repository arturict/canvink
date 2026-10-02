# Original assets and PDF pipeline

## Scope and trust boundary

`src/assets` stores user-selected PDFs, images, screenshots, and attachments as immutable original bytes. Callers inject an `AssetRepository`; the browser, native shell, workspace runtime, and sync layers can implement that interface without the asset module depending on any one store.

Every asset ID and checksum is `sha256:<hex>`. Storage is content-addressed, so importing identical bytes deduplicates them. Reads re-hash the stored bytes and verify the reference size and checksum before returning a defensive copy. A repository that reports a raced deduplication must expose the retained bytes for the same verification.

The pipeline enforces the shared limits in `src/domain/limits.ts`:

- PDFs: 32 MiB and at most 500 pages.
- Images: 12 MiB and at most 40 million decoded pixels.
- Attachments: 64 MiB.
- Extracted PDF text: 2 MiB of UTF-8 text per page.
- Export: 1 to 500 ordered pages and at most 32 MiB of output. Page area, unique reopened source/image bytes, element count, text, and stroke-point work are bounded before or during composition; inserted image decoding is capped at 16 million pixels per page.

MIME types are canonicalized and checked against known PDF/image magic. PNG, GIF, JPEG, and the VP8/VP8L/VP8X WebP variants have bounded dimension parsing. File names are reduced to a control-character-free basename.

Attachments are passive data. `accessAttachment` reopens the content-addressed asset, verifies its size and SHA-256 identity, and returns defensive bytes plus metadata with an `open` or `download` disposition; it never invokes a process, handler, URL, or embedded file. Browser and Tauri webviews share the same fail-closed adapter:

- exact canonical `application/pdf`, PNG/JPEG/GIF/WebP, and `text/plain` values may open as a blob URL in a separate `noopener,noreferrer` preview;
- a blocked preview reports an error and never silently falls back to download;
- every other or non-canonical MIME type, including HTML, SVG, JavaScript, executables, and macro-enabled Office files, opens an in-app passive inspection showing only the React-escaped file name, MIME type, verified byte size, and verified SHA-256 reference;
- the inspection never creates a blob URL, renders the attachment bytes, invokes an OS handler, or starts a download;
- download remains a separate explicit button for the user-selected original bytes.

Native OS-shell integration and platform malware scanning remain future responsibilities. Active attachment types must not be added to the preview allowlist even if a platform claims to have a handler for them.

Clipboard screenshot ingestion accepts PNG, JPEG, or WebP and passes through the same content-addressed validation path.

## PDF import

`inspectPdf` gives PDF.js only a copied in-memory byte array. Network streaming and automatic fetching are disabled. It does not call PDF JavaScript actions, URLs, launch actions, or embedded-file APIs. Password-protected, corrupt, truncated, oversized, page-heavy, or unsafe-dimension PDFs fail closed before an import plan is returned.

All pages are opened and validated locally. Text is extracted only from the PDF's existing text layer and is bounded per page. No OCR or cloud processing occurs. A scan-only page is valid and reports `hasExtractableText: false`.

`importOriginalPdf` first validates the complete document, stores its original bytes, then returns an ordered plan:

- one page and page-document ID per source PDF page;
- one locked PDF background element referencing the original asset;
- the source page number and dimensions;
- a lazy preview descriptor;
- optional blank pages appended after all source pages.

Preview rendering is explicit. `materializePdfPreview` reopens and verifies the original, asks an injected renderer for one bounded page preview, stores that image content-addressed, and returns an updated planned element. The visible multi-page import validates the whole PDF first and then materializes each preview with progress before atomically adding all source and appended pages. A failed preview or commit leaves the prior workspace authoritative. The caller reads and verifies the PDF once and passes the same bytes for every page, so the browser renderer keeps the pdf.js document open across pages and closes it through `release()`.

## Showing images and printouts

The editor never renders a PDF: a printout is its stored preview image, shown like any other picture. `AssetElementPreview` asks `imageSourceCache` for a blob URL instead of reading the asset itself.

- An asset is read, size- and SHA-256-verified once per asset and asset repository; concurrent elements share the read, and a page revisit finds the URL again. Unused entries are kept up to 96 MB of encoded bytes, least recently used first, and every URL is revoked when its entry is dropped. The shell must keep its asset repository's identity stable, because the cache is scoped to it.
- An element loads only once it is within one viewport of the canvas, so a page of eight printouts reads and decodes the ones in view first.
- Nothing about the stored asset or the document format changes. Downscaled copies of large pictures were tried and dropped: re-encoding delayed the first paint by the decode, resize and encode (about 300 ms per printout), and showing the original first and swapping in a copy did not lower the renderer's resident memory in the benchmark.

## PDF export

`exportComposedPdf` consumes pages in the caller's order. For a source page, it verifies the original asset and copies the selected original PDF page into the output without rasterizing it. It then composes a separate annotation overlay in `zOrder`. Locked PDF backgrounds are not painted a second time. Appended blank pages are emitted in the same ordered output PDF.

Overlay placement is derived from the copied page's `CropBox`, normalized quarter-turn `Rotate`, and uniform `UserUnit` scale. This keeps editor coordinates aligned to the visible page instead of stretching them over the raw `MediaBox`. Frame rotation is retained for shapes, rich text, images/PDF previews, and attachment cards; line/arrow point arrays and ink remain in their already-transformed page coordinates.

Ink color, width, and opacity are retained. Shape outlines, fills, basic geometry, axes, and arrowheads are emitted as vector PDF operations. Rich text is emitted with the built-in Helvetica fallback; characters outside the built-in encoding become `?` instead of making export fail. Verified PNG/JPEG/GIF/WebP elements are composited through the bounded image rasterizer, PDF previews are composited when they are not already the source background, and attachments become visible labeled cards instead of being silently omitted.

The visible export menu supports page, section, and notebook PDF scopes in canonical notebook order, plus current-page PNG and Markdown. The `.canvink` path packages Automerge notebook/page binaries and all referenced verified assets with checksums. Import is additive, remaps graph IDs, never replaces the active workspace, and exposes explicit rollback while no later commit depends on that import.

The original source PDF and other originals remain in the asset repository and in a complete `.canvink` bundle. The exported PDF preserves the copied source page's page box, rotation, selectable text, and vector content while adding Canvink annotations above it. The complete original document bytes remain in Canvink's asset store because constructing a new annotated PDF necessarily rewrites the output container.

Exported PDFs are passive documents. Before a source page is copied, page additional actions (`AA`), annotations (`Annots`), and associated files (`AF`) are removed from the source object graph. The new catalog does not retain open actions, name trees/embedded files, forms, or catalog additional actions. Removing these roots before copying also prevents their indirect action, file-specification, and embedded-stream objects from surviving as serialized orphans. This deliberately removes passive annotation appearances such as highlights, ink annotations, and stamps too: generic appearance flattening is not considered safe enough yet, so those appearances are preserved only when they already exist as ordinary page content or as Canvink elements.

## Verification and remaining gates

Unit coverage includes multi-page PDFs, scan-like pages with no text, corrupt and truncated files, explicit password errors, byte/pixel/page limits, SHA-256 dedupe and corrupt-reopen failure, lazy previews, annotation z-order, appended pages, missing-font fallback, and original asset bytes surviving a `.canvink` create/read round trip.

Before calling the end-user pipeline release-ready:

- render representative exported PDFs with independent viewers and visually compare all pages, especially transparency, rotations, complex source PDFs, and non-Latin text;
- test large documents and preview cancellation on target school hardware;
- add OCR only as a separate, explicit local-first feature with its own resource and privacy limits;
- evaluate platform security scanning without ever launching active attachment types; any future native-open boundary must remain narrower than the passive in-app inspector;
- add embedded fonts or a broader fallback strategy when faithful non-Latin export is required.
