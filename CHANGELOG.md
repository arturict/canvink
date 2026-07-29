# Changelog

All notable changes to Canvink are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Canvink uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the warning that compatibility can change during the 0.x alpha series.

## Unreleased

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
