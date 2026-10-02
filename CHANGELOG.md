# Changelog

All notable changes to Canvink are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Canvink uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the warning that compatibility can change during the 0.x alpha series.

## Unreleased

### Added

- Math Canvas schema v3 with lossless v2 migration, typed and explicit handwritten Math blocks, local exact/decimal evaluation, page variables, bounded school-level equation solving, number scrubbing, and atomic correction/conversion history
- Interactive numeric-only 2D graphs, including bounded implicit equations, persisted viewports, coordinate inspection, and reactive source references
- Native offline Numbat unit conversion, bundled dated ECB reference-rate snapshots, notebook-scoped calculator history, and current-schema JSON/PDF/PNG/Markdown export support
- Desktop BYOK recognition through Mathpix Strokes or a compatible private endpoint, Windows-DPAPI credentials, and a private TexTeller/UniMERNet benchmark service
- Manual page tags and an open/done page task state in page settings, with suggestions, a bounded tag limit, and the same normalizer OneNote acquisition uses
- `tag:`, `is:open`, `is:done`, and `is:task` search operators usable alone or with free text, matching task and tag filter controls, and a cross-page task review that lists every marked page

### Changed

- Development package version is `0.2.0-beta.1`; publication remains blocked until the commit-bound external Math acceptance artifacts pass

### Security

- Restrict the Unix desktop database directory, database, and SQLite companion files to the owning user, including repair of permissive legacy modes

### Planned

- Reliability and accessibility improvements driven by public alpha feedback

## 0.1.0 - 2026-07-29

### Added

- Initial public alpha of the Canvink local-first notebook
- Notebook, section, and page hierarchy
- Free-canvas and A4 page modes
- Mixed ink, text, image, and PDF page objects
- Pressure-aware vector ink foundation
- Basic autosave, text search, trash, and export flows
- Validated portable JSON backup and restore
- Tauri 2 desktop shell with local SQLite persistence
- Browser demo with local IndexedDB persistence
- Public landing page, project documentation, and release automation foundation

### Security

- No account requirement or application telemetry
- Documented local-storage boundaries and unsigned-build warning
- Bounded workspace, image, PDF, and text imports
- Single-writer browser locking to prevent silent multi-tab overwrites
