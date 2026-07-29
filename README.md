# Canvink

Canvink is an open source, local-first notebook for handwriting, freely positioned text, images, and PDFs on the same page.

The project is for people who like the freedom of a spatial notebook but want understandable storage, no required account, and a path away from proprietary lock-in.

> [!WARNING]
> Canvink 0.x is a public alpha. Keep backups of important work. Desktop packages are currently unsigned, the data format can still change during the 0.x series, and the project has not received an independent security audit.

## What the alpha includes

- A notebook, section, and page hierarchy
- A blank Quick note start, optional resumable guide, and keyboard-accessible text capture
- Free-canvas and A4 page modes
- Pressure-aware vector ink built with `perfect-freehand`
- Freely positioned ink, text, image, and PDF objects rendered with Konva
- Basic text search, local autosave, persistent save retry, rescue export, trash, and page export foundations
- A Tauri 2 desktop shell with SQLite as the authoritative desktop store
- A browser demo that persists locally in IndexedDB
- A public landing page and web demo built with React, TypeScript, and Vite
- No account requirement and no application telemetry

The order of objects on a page is meaningful. Text, ink, images, and PDF previews share one coordinate system and can be layered together instead of being isolated in separate editors.

## What is not included yet

Canvink does not yet provide device sync, collaboration, end-to-end encryption, OCR, handwriting recognition, a complete OneNote importer, mobile apps, or signed and notarized desktop installers. PDF and document workflows are intentionally narrow in this first release. See the [roadmap](ROADMAP.md) for direction, not promises or dates.

## Try it

The hosted browser build is a demo, not a cloud notebook. Its content stays in that browser profile's IndexedDB. Clearing site data, using private browsing, or changing browsers can remove or hide that content.

For durable use, prefer the desktop build and maintain backups. Desktop data is stored locally in SQLite. It is not encrypted by Canvink in the current alpha.

An already open browser tab can keep editing and saving to IndexedDB while the browser reports offline. Canvink does not ship a service worker in this alpha, so reopening or reloading the hosted demo while offline is not promised. A failed save remains visible with a retry action and a JSON rescue-copy download. Reload restores the last successful save, not an unsaved crash draft.

## Build from source

### Prerequisites

- Node.js 20.19 or newer
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

Build an unsigned desktop package:

```bash
pnpm tauri:build
```

The exact commands used by a release are documented in the [release process](docs/release-process.md). A successful local build does not mean an installer is signed, notarized, or suitable for storing the only copy of important notes.

## Architecture

| Concern | Technology | Role |
| --- | --- | --- |
| Desktop shell | Tauri 2 and Rust | Native window, constrained commands, and desktop persistence |
| Interface | React and TypeScript | Notebook navigation, editing, and state flow |
| Build | Vite | Development server and production web bundle |
| Spatial canvas | Konva and React Konva | Mixed-object page rendering and interaction |
| Ink geometry | perfect-freehand | Pressure-aware stroke outlines |
| PDF handling | PDF.js | Local PDF parsing and preview rendering |
| Desktop storage | SQLite | Authoritative normalized workspace store with JSON element payloads |
| Web demo storage | IndexedDB | Origin-scoped browser persistence |

The domain model is deliberately independent of either storage adapter. A workspace contains notebooks, sections, pages, and ordered page elements. The desktop adapter validates the versioned scene, stores hierarchy and geometry in normalized SQLite tables, and preserves tool-specific element data as JSON. The browser adapter stores the same logical scene in IndexedDB.

Read more:

- [Architecture](docs/architecture.md)
- [File format v1](docs/file-format-v1.md)
- [Security model](docs/security-model.md)
- [Release process](docs/release-process.md)
- [Community and marketing rules](docs/community-and-marketing.md)

## Privacy

Canvink does not require an account and the application does not include product analytics or telemetry in the current alpha. Notebook content is not intentionally sent to Canvink or an AI service.

Local-first does not automatically mean encrypted. Anyone who can access your operating-system account, browser profile, or unencrypted disk may be able to read your notes. The hosted landing page and web demo are also subject to ordinary infrastructure request logs from the hosting provider. The [security model](docs/security-model.md) explains these boundaries.

## AI assistance

AI-assisted tools helped with code, tests, documentation, and project research for the initial alpha. This disclosure is about provenance, not a quality guarantee. AI-assisted contributions receive the same review, testing, licensing, and security requirements as other contributions. Contributors must disclose material AI assistance and remain accountable for every submitted line.

## Contributing

Canvink is early enough that careful bug reports, reproducible input problems, storage reviews, accessibility feedback, and focused patches are especially valuable. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

Security-sensitive reports should not be opened as public issues. Follow the private reporting guidance in the [security model](docs/security-model.md).

## License

Canvink is free software licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
