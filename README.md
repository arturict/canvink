# Canvink

Canvink is an open source, local-first notebook for handwriting, freely positioned text, images, PDFs, and editable mathematics on the same page.

The project is for people who like the freedom of a spatial notebook but want understandable storage, no required account, and a path away from proprietary lock-in.

> [!WARNING]
> Canvink's published 0.x line remains a public alpha. Keep backups of important work. The current source tree is not an approved beta or release, its data format can still change, and it has not received an independent security audit. The normal desktop build is unsigned; trusted Windows signing is only an opt-in release path and has not yet produced a verified signed Canvink build.

## What the current source implements

- A notebook, section, page, and subpage hierarchy with persisted notebook/section drag-and-drop, equivalent arrow/menu controls, and cycle-safe duplication, move, and copy operations
- A blank Quick note start, optional resumable guide, and keyboard-accessible text capture
- Free-canvas and A4 page modes
- Pressure-aware vector ink built with `perfect-freehand`, plus a movable and freely rotatable on-canvas ruler that guides pen and straight tools
- Freely positioned ink, ProseMirror rich text, checklists, shapes, images, PDFs, attachments, Math blocks, and linked 2D graphs rendered on the live schema-v3 canvas
- Typed and explicitly selected handwritten mathematics with MathLive correction, local exact/decimal evaluation, ordered variables, bounded equation solving, safe numeric scrubbing, calculator history, and a scientific/conversion palette
- Numeric-only JSXGraph rendering from locally validated expressions; graph sources, visibility, viewport, and equal-axis state remain linked to their Math elements without compiling expression strings
- Native offline Numbat unit conversion and dated/source-labelled currency snapshots; browser builds fail closed when the native unit bridge or a trusted local rate snapshot is unavailable
- Optional desktop BYOK recognition through Mathpix Strokes or a compatible private endpoint, with Windows-DPAPI credentials and an explicit local-Math-selection network boundary; the browser keeps typed/local mathematics and stores no provider key
- Manual page tags and an open/done page task state, sharing one normalizer with OneNote import
- A local derived search index across titles, rich text, tags, tasks, checklists, PDF text, and accepted OCR text, with explicit rebuild behavior
- `tag:`, `is:open`, `is:done`, and `is:task` search operators, matching filter controls, and a cross-page task review
- Named, automatic, and trash history snapshots that restore to a verified copy instead of destructively rewinding the active page
- Local autosave, fail-closed schema-v1 migration, recovery reporting, save retry, trash, original-preserving assets, `.canvink` bundles, and page/section/notebook export paths; source-backed PDF pages are copied structurally, stripped of interactive entries, and overlaid with current Canvink content
- A Tauri 2 desktop shell whose schema-v3 authority stores Automerge Repo chunks, activation metadata, assets, history, search projections, and optional sync state in SQLite
- An installable browser app whose schema-v3 authority persists in origin-scoped IndexedDB
- An explicit optional encrypted-sync client with Appwrite adapters, account/device approval, roles, durable outbox/catch-up, and conflict visibility; its backend configuration is intentionally undeployed
- Local Windows OCR and a bounded, additive OneNote Graph importer. Packaged OneNote sign-in uses a strict Microsoft system-browser/loopback bridge, the browser keeps redirect navigation, source tags/tasks/checklists are normalized, and users can attach a validated local one-page PDF fallback per source page. Real Entra consent, Graph responses, installed OCR languages, and representative private material remain external/personal gates
- Content-free navigation/storage diagnostics and a pen-performance evidence path that stays disabled until a real 45-minute, 20-sample, `<20 ms` p95 session is observed
- A public landing page and web demo built with React, TypeScript, and Vite
- A hardened, rootless container for self-hosting the static browser build
- Accountless local mode by default and no application telemetry

The order of objects on a page is meaningful. Text, ink, images, and PDF previews share one coordinate system and can be layered together instead of being isolated in separate editors.

## What is not included yet

Canvink does not yet have a public recognition service, completed real-writer handwriting corpus, accepted target-GPU benchmarks, deployed and live-accepted sync service, broad OneNote parity, mobile apps, application-level encryption for the local notebook store, an independently audited security posture, or a trusted-certificate signed build. Math recognition is opt-in BYOK and limited to explicit Math blocks; 3D graphs, matrices/vectors, general differential equations, step-by-step symbolic explanations, and AI word-problem solving are outside v0.2. Sync payload encryption and Windows DPAPI key protection are implemented, but they do not encrypt the ordinary local SQLite/IndexedDB notebook authority. PDF, OCR, Math, and OneNote behavior remains bounded by the documented formats and still needs representative personal acceptance. See the [acceptance matrix](docs/acceptance-matrix.md) for the exact evidence boundary and the [roadmap](ROADMAP.md) for direction, not promises or dates.

## Try it

The hosted browser build starts in accountless local mode, not as a cloud notebook. In that mode its content stays in that browser profile's IndexedDB. Clearing site data, using private browsing, or changing browsers can remove or hide that content. Only an explicit sync configuration and sign-in may send end-to-end encrypted envelopes and encrypted assets to the configured Appwrite service; the tracked Appwrite project still contains placeholders and has not been deployed or accepted with real accounts.

For durable use, prefer the desktop build and maintain backups. Desktop data is stored locally in SQLite. It is not encrypted by Canvink in the current alpha.

After one successful online load, the production browser build caches its application shell. An activated service worker can reopen the interface offline, while notebook content continues to come only from that origin's IndexedDB. A first visit still needs the site, browser storage can still be cleared, and offline support is not sync. A failed save remains visible with a retry action and a JSON rescue-copy download. During the autosave window, Canvink also keeps a separate temporary recovery draft. After an interrupted session, a valid draft is offered for review, download, restoration, or discard and never silently replaces the last successful save.

To host the browser build on your own machine or server, follow the [self-hosting guide](docs/self-hosting.md). The container serves static application files only and is not itself a notebook backend. Accountless content remains in the browser; optional sync still requires a separately configured Appwrite service.

## Build from source

### Prerequisites

- Node.js 22 or newer
- pnpm 11.18.0, pinned through the `packageManager` field
- Rust stable and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/) for desktop development

Install dependencies and run the web app:

```bash
pnpm install
pnpm exec playwright install chromium
pnpm dev
```

The Playwright command installs the local Chromium binary used by `pnpm test:e2e`. On a supported Linux development or CI host, use `pnpm exec playwright install --with-deps chromium` to install its operating-system dependencies too.

The landing page is served at `/` and the notebook at `/app`.

Run the desktop app:

```bash
pnpm tauri:dev
```

Run the quality gates:

```bash
pnpm check
pnpm test
pnpm test:e2e
pnpm build
```

Build the unsigned Windows NSIS and MSI packages through the dedicated locked script:

```bash
pnpm tauri:build:windows
```

The exact commands used by a release are documented in the [release process](docs/release-process.md). `pnpm tauri:build:windows` only produces unsigned package candidates; it does not prove launch behavior, physical-pen performance, personal OneNote/OCR/PDF fidelity, or release approval. Trusted Windows signing readiness is documented separately in [Windows code-signing readiness](docs/windows-code-signing.md); it requires an external certificate and an explicit signed run. A successful local build does not mean an installer is signed, notarized, released, or suitable for storing the only copy of important notes.

## Architecture

| Concern | Technology | Role |
| --- | --- | --- |
| Desktop shell | Tauri 2 and Rust | Native window, constrained commands, and desktop persistence |
| Interface | React and TypeScript | Notebook navigation, editing, and state flow |
| Build | Vite | Development server and production web bundle |
| Spatial canvas | Konva and React Konva | Mixed-object page rendering and interaction |
| Ink geometry | perfect-freehand | Pressure-aware stroke outlines |
| Formula editing | MathLive | Accessible typed input and explicit handwriting correction |
| Local mathematics | Cortex Compute Engine | Bounded parsing, exact/decimal evaluation, variables, equations, and safe graph sampling |
| Native units | Numbat | Dimensions-safe offline unit conversion behind typed Tauri commands |
| 2D graphs | JSXGraph | Interactive rendering from precomputed numeric point arrays only |
| PDF handling | PDF.js | Local PDF parsing and preview rendering |
| CRDT and rich text | Automerge and ProseMirror | Per-notebook/page documents and canonical rich-text paths |
| Desktop storage | SQLite | Schema-v3 Repo, activation, asset, history, search, and optional sync state |
| Web demo storage | IndexedDB | Origin-scoped schema-v3 persistence and derived local indexes |
| Optional sync | Encrypted protocol and Appwrite adapters | Explicit E2EE transport; local authority remains usable without an account |

The mounted application reads schema v2 and v3 and writes schema v3. A notebook index and each page are separate Automerge documents; page elements live in a stable `elementsById` map with explicit `zOrder`, while verified binary assets remain content-addressed outside the CRDT. Opening v2 is non-mutating; the first current-schema write upgrades the complete activation/document graph atomically to v3. Schema v1 is retained only as migration input and checked rollback evidence.

Read more:

- [Architecture](docs/architecture.md)
- [Schema v2](docs/schema-v2.md)
- [Schema v3 and Math Canvas](docs/schema-v3.md)
- [Math Canvas architecture](docs/math-canvas.md)
- [Math recognition boundary](docs/math-recognition.md)
- [Math acceptance](docs/math-acceptance.md)
- [Automerge architecture](docs/automerge-architecture.md)
- [Acceptance matrix](docs/acceptance-matrix.md)
- [Security model](docs/security-model.md)
- [Release process](docs/release-process.md)
- [Self-hosting](docs/self-hosting.md)
- [Local release pipeline](docs/local-release-pipeline.md)
- [Beta readiness](docs/beta-readiness.md)
- [OneNote use-case coverage](docs/onenote-use-case-coverage.md)
- [Community and marketing rules](docs/community-and-marketing.md)

## Privacy

Canvink does not require an account and the application does not include product analytics or telemetry. In local mode, notebook content remains in the selected local authority. Local OCR uses the installed Windows OCR runtime. Ordinary strokes never trigger Math recognition. If a desktop user explicitly activates a local Math block or converts a selection and has configured BYOK recognition, only normalized strokes from that block are sent through the selected provider; credentials remain in the native Windows credential boundary. If a user explicitly enables the optional sync client, Canvink sends encrypted changes, wrapped keys, bounded presence, and encrypted assets to the configured Appwrite service; clear notebook titles, page text, handwriting, OCR text, file names, and MIME types are not part of that server protocol.

Local-first does not automatically mean encrypted. Anyone who can access your operating-system account, browser profile, or unencrypted disk may be able to read the local notebook store. Windows DPAPI protects desktop sync-device and private notebook key material, not all note content. The hosted landing page and web demo are also subject to ordinary infrastructure request logs from the hosting provider. The [security model](docs/security-model.md) explains these boundaries.

## AI assistance

AI-assisted tools helped with code, tests, documentation, and project research for the initial alpha. This disclosure is about provenance, not a quality guarantee. AI-assisted contributions receive the same review, testing, licensing, and security requirements as other contributions. Contributors must disclose material AI assistance and remain accountable for every submitted line.

## Contributing

Canvink is early enough that careful bug reports, reproducible input problems, storage reviews, accessibility feedback, and focused patches are especially valuable. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

Security-sensitive reports should not be opened as public issues. Follow the private reporting guidance in the [security model](docs/security-model.md).

## License

Canvink is free software licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
