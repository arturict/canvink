# OneNote import

## Scope and safety boundary

The import core in `src/import` separates authorization, bounded read-only acquisition, neutral preview, explicit review, and additive application. It never accepts a Microsoft client secret and never requests a OneNote write permission. An approved import creates one new Canvink notebook; it does not replace the active notebook or mutate existing document roots.

Application targets the schema-v2 runtime through `WorkspaceV2Runtime.extendActiveWorkspace`. The runtime stages and reopens a complete Automerge Repo image, checks the prior activation fingerprint, atomically publishes assets, chunks, an import receipt, rollback data, and the new activation, then reopens the committed graph. A deterministic import ID makes a repeated request after a lost acknowledgement idempotent. Rollback is refused after a later workspace commit depends on the imported activation.

On desktop, that boundary is implemented by the dedicated
`v2_additive_import_base64` SQLite command. Receipt recovery uses
`v2_get_workspace_import_receipt_base64`, and the explicit guarded recovery
action uses `v2_rollback_workspace_import`; the frontend does not compose those
transaction steps from individual Repo writes.

All page HTML and resource metadata are untrusted. The converter parses them into a neutral block model rather than returning HTML. It never evaluates markup and never exposes an HTML rendering escape hatch.

The HTML converter limits each page to 5 MiB of UTF-8 HTML, 100,000 parsed nodes, 128 levels of element nesting, and one million pixels in either spatial direction. The acquisition layer adds explicit collection, request, pagination, hierarchy-depth, metadata, total HTML, per-resource, and total-resource budgets. Integrations may set smaller limits for their device and notebook selection.

## Integration gates

The host application is responsible for the consent and selection experience around the acquisition client:

1. Register a Microsoft Entra single-page/public client with an exact redirect URI. `createMicrosoftOneNoteAuth` uses the official `@azure/msal-browser` authorization-code flow with PKCE and requests delegated `Notes.Read` only. State, nonce, S256 challenge, authority, redirect, returned scope, and expiry are checked. There is no client secret.
2. Packaged Tauri builds inject the repository's native `TauriSystemBrowserCallbackBridge`. It accepts only Microsoft `authorize`/`logout` endpoints and requires an exact `http` loopback redirect with an explicit port and non-root callback path. The native command binds that address before launching the system browser, accepts only a bounded `GET` request from loopback with the exact registered authority/path, returns only its query to MSAL, times out after three minutes, and supports explicit cancellation. A normal browser continues to use MSAL redirect navigation. Tokens are acquired silently from MSAL and never copied into app persistence.
3. Inject `auth.getAccessToken` and a `fetch` implementation into `createMicrosoftGraphOneNoteClient`. The token provider receives an `AbortSignal` and must return a current token scoped for Graph; tokens are never returned in acquisitions or diagnostic errors.
4. Optionally let the user select notebook IDs, then call `acquire` or `acquirePreview`. The client enumerates direct and nested-group sections sequentially, follows bounded `@odata.nextLink` values, requests section pages with `pagelevel=true`, retrieves HTML, discovers known Graph image/file references, downloads each unique resource once into memory, and calculates SHA-256.
5. Show the complete preview and per-page fidelity report. Keep acquired resource bytes in a temporary, bounded owner-controlled scope until the user approves the exact staged artifact fingerprint.
6. Prepare and apply through the schema-v2 runtime target. The apply core revalidates every untrusted link, coordinate, identifier, MIME type, length, magic signature, byte count, and SHA-256 before the atomic commit.
7. If Graph HTML does not preserve handwriting or layout semantically, the dialog lets the user choose or remove a one-page local PDF export for each selected source page. Canvink validates the PDF, renders page one locally, records the original PDF and rendered PNG/JPEG as separate acquisition resources and bodies, and regenerates the neutral preview. Application places the rendered image behind editable semantic elements as a locked page-sized PDF background while retaining the exact original PDF bytes.

Graph is a migration source, not a complete OneNote backup/restore protocol. The client handles bounded pagination, throttling retries, cancellation, timeouts, unique resource retrieval, and opaque failures; the host still owns account/tenant policy, notebook selection, consent UX, and temporary-byte cleanup. Microsoft documents [MSAL browser initialization](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/initialization), [SPA authorization-code with PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-spa-app-registration), [MSAL logout](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/logout), [token lifetimes and silent renewal](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/token-lifetimes), the [OneNote content hierarchy and page HTML endpoints](https://learn.microsoft.com/en-us/graph/onenote-get-content), [OneNote output HTML](https://learn.microsoft.com/en-us/graph/onenote-input-output-html), [resource retrieval](https://learn.microsoft.com/en-us/graph/api/resource-get?view=graph-rest-1.0), [Graph paging](https://learn.microsoft.com/en-us/graph/paging), [throttling](https://learn.microsoft.com/en-us/graph/throttling), and [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference).

### Authorization API

```ts
const auth = createMicrosoftOneNoteAuth({
  clientId: configuredEntraApplicationId,
  redirectUri: configuredExactRedirectUri,
  systemBrowser: tauriSystemBrowserBridge,
});

await auth.initialize();
await auth.authorize(cancellation.signal);

// Passed directly to the acquisition client. Do not log or persist the return value.
const getAccessToken = (signal: AbortSignal) => auth.getAccessToken(signal);
```

`cancelPendingAuthorization()` aborts only the outstanding authorization operation. `logout({ endServerSession: false })` clears the local MSAL account without opening an end-session page; the explicit server-session option validates that navigation before it leaves the app.

### UI configuration and real-account acceptance

The schema-v2 top bar opens the German-first `OneNoteImportDialog`. It shows the exact delegated permission, sign-in and cancellation controls, one-notebook/section selection, acquisition retry, fidelity filters, PDF/resource warnings, the immutable approval fingerprint, additive commit retry, success navigation, and guarded rollback errors. No value is silently written before the fingerprint checkbox is approved.

For a personal browser validation, create a Microsoft Entra app registration as a public single-page application and provide these build-time values:

```dotenv
VITE_MICROSOFT_CLIENT_ID=11111111-1111-4111-8111-111111111111
VITE_MICROSOFT_REDIRECT_URI=https://your-exact-canvink-origin.example/app
# Optional; defaults to the redirect URI.
VITE_MICROSOFT_POST_LOGOUT_REDIRECT_URI=https://your-exact-canvink-origin.example/app
# Optional; defaults to the multi-account common authority.
VITE_MICROSOFT_AUTHORITY=https://login.microsoftonline.com/common
```

Register `VITE_MICROSOFT_REDIRECT_URI` and the optional post-logout URI exactly, including scheme, host, port, and path. Grant delegated Microsoft Graph `Notes.Read`; do not add `Notes.ReadWrite`, an application permission, or any client secret. Local validation normally uses `http://localhost:1420/app` (Vite) or the exact preview origin. The dialog also accepts the public client ID and redirect URI interactively for owner testing, but intentionally has no secret input and does not persist those fields.

Real-account acceptance checklist:

1. Open `/app`, choose **OneNote importieren**, confirm the consent explanation says `Notes.Read`, and sign in to the intended personal Microsoft account.
2. Confirm notebook and nested section discovery, cancel once during acquisition, retry, and inspect at least one `complete`, `simplified`, and PDF-backed `visual` page when the account contains them.
3. Compare image/attachment bytes and SHA-256 with the source, approve the displayed artifact fingerprint, and confirm the imported notebook opens while pre-existing notebooks and the former active page remain intact.
4. Reload and retry the same receipt to verify idempotency. Then test rollback before making a later dependent edit, and separately verify that rollback is refused after such an edit.

Tauri system-browser acceptance must register the same exact loopback URI shown in the dialog, for example `http://127.0.0.1:49152/onenote/callback`. HTTPS, wildcard, non-loopback, portless, root-path, query-bearing, fragment-bearing, and custom-scheme callbacks are rejected by the packaged bridge. The browser build remains a normal MSAL redirect flow and may use its registered HTTPS application origin. This repository does not contain an Entra tenant/application ID or a client secret. Automated acceptance assigns `window.__CANVINK_ONENOTE_IMPORT_TEST_DEPENDENCIES__` before app startup to mock MSAL and Graph while retaining the real schema-v2 browser transaction; normal builds never assign this hook.

### Acquisition API

```ts
const client = createMicrosoftGraphOneNoteClient({
  getAccessToken: (signal) => identityAdapter.getNotesReadToken(signal),
  fetch: (url, init) => window.fetch(url, init),
});

const result = await client.acquirePreview({
  signal: cancellation.signal,
  notebookIds: selectedNotebookIds,
  preview: { createdAt: new Date().toISOString() },
});

showPreview(result.preview, result.resourceBodies);
```

`resourceBodies` contains in-memory bytes plus MIME type, safe identifiers, filename metadata, and SHA-256; it is not a workspace asset store.

### Review and additive apply API

```ts
const target = createWorkspaceV2RuntimeOneNoteApplyTarget(workspaceV2Runtime);
// Desktop export: openOneNoteDesktopExport opens the export lazily (folder or ZIP).
// Graph: oneNoteImportFromPreview(result.preview, result.resourceBodies).
const { outline, source } = await oneNoteImportFromPreview(result.preview, result.resourceBodies);
const staged = await prepareOneNoteImportApplication({
  outline: selectOneNoteImportOutline(outline, notebookId, sectionIds, errorTexts),
  source,
  target,
  signal: cancellation.signal,
  onProgress: renderImportProgress,
});

showReview(staged.review); // title, counts, resource totals, warnings, exact fingerprint

const applied = await applyOneNoteImportApplication(target, staged, {
  approvalArtifactFingerprint: userApprovedFingerprint,
  signal: cancellation.signal,
  onProgress: renderImportProgress, // per page: completed/total, staged bytes, elapsed time
});
// applied.timing (per phase) and applied.stats (pages, strokes, ink points, assets)

// Explicit recovery action only; refused if a later activation depends on this import.
await rollbackOneNoteImportApplication(target, applied, renderImportProgress);
```

Preparation requires exactly one reviewed source notebook, reads only the structure (sections, page titles and levels, counts) and is durable-workspace neutral. Apply reads, converts and writes one page at a time through the runtime's streaming import writer (`beginAdditiveImport`): each page's XML, ink and resources are read, verified and converted, its new assets and the page are staged to storage, and everything is dropped before the next page, so memory is bounded by the largest page rather than the notebook. The artifact fingerprint is built incrementally from the notebook, the ordered per-page hashes and the asset list; a page file that changed after the review is refused. One small delta commit publishes the notebook with an import receipt; applying the same reviewed stage again resolves that receipt and reports "already committed". Any page failure aborts the writer and leaves the workspace unchanged. Rollback removes exactly the imported documents and restores the prior activation, so edits made to existing pages after the import survive it. A post-commit verification failure triggers immediate rollback; failure of that rollback is surfaced as a compound recovery error rather than hidden.

A bm-size synthetic export (398 pages, 204,500 strokes, 2.1 million ink points, 1,046 printout pages) imports completely; see `scripts/onenote-import-bench.mjs` and `scripts/onenote-synthetic-export.mjs`.

Desktop-export tables retain their paragraph tags and contribute to the page's
open/done task state. Checkboxes inside table cells are visible `☐`/`☑` text,
because Canvink's table cells currently hold text only. The fidelity report marks
this simplification; the markers do not become interactive checklist controls.
Synthetic browser acceptance covers a study table beside PDF printouts and ink,
reload, and finding the imported page with `is:open tag:wichtig`. This does not
establish fidelity for a private notebook or a real Microsoft account.

### Default acquisition bounds

| Boundary | Default |
| --- | ---: |
| Notebooks / sections / section groups | 100 / 1,000 / 500 |
| Section-group nesting | 16 levels |
| Pages / unique resources | 10,000 / 20,000 |
| Responses per paginated collection / all request attempts | 100 / 25,000 |
| Metadata response / all metadata | 2 MiB / 50 MiB |
| Page HTML / all page HTML | 5 MiB / 100 MiB |
| Resource / all resources | 50 MiB / 500 MiB |
| Request timeout / retries | 15 seconds / 3 retries |

Requests are sequential, below Graph's documented five-request delegated OneNote concurrency ceiling. HTTP 429 and transient 5xx responses, timeouts, and network failures use bounded retries. `Retry-After` is honored up to ten seconds; otherwise exponential delays start at 250 ms. Caller cancellation is never retried.

## Input and output model

`GraphOneNoteImportInput` contains:

- notebooks with ordered sections;
- sections with ordered pages;
- pages with title, optional hierarchy level and timestamps, and Graph HTML;
- a catalog of locally retrieved resource metadata (`id`, Graph content URL, MIME type, byte length, optional filename and SHA-256);
- optional page-to-PDF fallback associations.

`createOneNoteImportPreview(input, { createdAt })` validates identifiers and resource metadata, sorts sections and pages without mutating the input, converts each page, includes only referenced resources, and returns a serializable `onenote-import-preview` plan. The caller supplies `createdAt`, making identical inputs deterministic.

The neutral rich-content model supports:

- paragraphs, headings 1–6, block quotes, and preformatted code;
- bold, italic, underline, strikethrough, inline code, and safe `http`, `https`, `mailto`, or fragment links;
- bullet and numbered lists, including nested blocks;
- OneNote `data-tag` to-do checklists;
- normalized known OneNote tags and safe `onenote:<normalized-name>` preservation for unknown tag names;
- tables with header cells and bounded row/column spans;
- known raster image resources and downloadable attachments;
- absolute/relative `left`, `top`, `width`, `height`, and `z-index` values expressed as bounded pixels;
- Graph `data-id` values for later source diagnostics.

## Content policy

The converter drops scripts, stylesheets, iframes, forms, SVG/MathML, embedded media, canvases, and other active content with their payloads. Event attributes are never retained. Unknown structural elements can contribute plain text or supported descendants but produce a fidelity issue.

Links reject relative targets and schemes outside the explicit allowlist, including `javascript:`, `data:`, `file:`, and `onenote:`. Images and attachments resolve only against the supplied resource catalog; arbitrary remote and data URLs are not retained. Canonical Graph URL matching is limited to HTTPS Microsoft Graph/OneNote hosts. SVG is not an accepted image MIME type. Attachment filenames are display-only, stripped of path/control characters, and must never be used as an unchecked filesystem path or automatically opened.

Only a small CSS subset is interpreted. Spatial pixel properties and basic inline text marks are converted to data; all other declarations are discarded and reported. CSS text is never copied to the preview model.

The acquisition client sends bearer tokens only to `https://graph.microsoft.com/v1.0/me/onenote/` URLs that it constructs or validates. Redirects are disabled. A pagination URL must retain the original collection pathname. HTML resource references accept only exact current Graph or legacy `www.onenote.com` HTTPS resource shapes; the client extracts the opaque resource ID and downloads through a newly constructed Graph `/me/onenote/resources/{id}/content` URL. Foreign origins, credentials, fragments, query-bearing resource URLs, malformed IDs, cyclic pagination, and endpoint-pivoting next links fail closed or remain unresolved for the fidelity report.

Errors expose only a stable code, operation category, retryability, HTTP status, and optional Graph request ID. They never include access tokens, request URLs, response bodies, notebook titles, page content, or upstream exception messages.

## Fidelity reports

Every page receives one status:

| Status | Meaning |
| --- | --- |
| `complete` | All source content represented by the supported semantic model with no reported loss. |
| `visual` | A valid PDF fallback is associated, preserving a static visual reference rather than editable semantics. |
| `simplified` | Useful editable content was converted, but formatting, an unsafe target, a resource, or an unsupported construct was dropped or flattened. |
| `unsupported` | No useful editable block remains and no valid PDF fallback is available. |

Reports also retain structured issue codes, messages, source element names, converted top-level block counts, and both PDF-original and rendered-preview resource IDs plus page dimensions. A `visual` report can still contain conversion issues; the PDF is the fidelity safety net, not proof of semantic completeness.

## Known limitations

- This foundation does not parse `.one` files or request/export PDFs. Microsoft Graph exposes page HTML and resources but no supported page-to-PDF migration endpoint; the user must explicitly provide a one-page PDF export for each visual fallback.
- It does not convert handwriting, OCR, equations, audio/video, embedded web pages, OneNote-only links, arbitrary fonts/colors, or complex CSS layout.
- Acquisition holds resource bytes in memory and hashes them. Apply checks supported image/PDF signatures and image dimensions before persistence, but it does not virus-scan attachments or fully parse PDFs. Content-length and streamed-byte limits bound downloads, not every future decoder/decompression bomb.
- Personal `/me/onenote` notebooks on the global Graph v1.0 origin are supported. Group/site locations, sovereign-cloud origins, incremental resume/checkpoints, and background migration are not implemented.
- Section order is the stable Graph response order with direct sections followed by depth-first nested section groups. Graph does not expose a single total order interleaving direct sections and groups, so that cross-container ordering cannot be reconstructed.
- A 401/403 is an opaque terminal acquisition error. The auth client silently renews when MSAL can do so; interactive re-consent remains a host UI decision.
- OneNote `data-tag` values are normalized into stable page tags. To-do/task variants also produce checklist blocks and page `taskState`; recognized names use canonical tags, while other safe names use the `onenote:` prefix. Values that cannot be normalized are explicitly reported as `data-tag-unsupported`.
- Automated tests exercise mocked MSAL/Graph behavior and the real local apply, reload, search, bundle, and rollback paths. They do not prove a real Entra tenant registration, Microsoft consent, or live Graph behavior. The live-account acceptance checklist above therefore remains an open release gate.
