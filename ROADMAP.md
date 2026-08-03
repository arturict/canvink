# Canvink roadmap

This roadmap communicates direction. It is not a promise, schedule, or claim that listed work already exists.

Canvink will prioritize data integrity and excellent pen-and-page fundamentals before accounts, collaboration, or a large plugin ecosystem.

## v0.1 foundation

The public alpha establishes:

- A Tauri 2 desktop application and a limited browser demo
- Notebook, section, page, and subpage organization, including page duplication and sibling reordering
- Free-canvas and A4 page modes
- Mixed ink, formatted text, checklist, image, and PDF objects
- Local autosave with SQLite on desktop and IndexedDB in the browser demo
- Text, checklist, tag, and task search, plus trash and export foundations
- A documented schema, security model, and release process

The v0.1 series remains unstable. Compatibility work will be explicit and migrations will be tested, but users should expect changes and maintain backups.

## Reliability next

- Additional crash-recovery and transaction testing
- Backup scheduling and recovery diagnostics beyond the portable JSON workflow
- Database integrity checks and recovery guidance
- Page history and clearer deletion recovery
- Large-document performance work beyond the current safety limits
- Stable asset handling that avoids large data URLs in scene JSON
- Deeper accessibility and keyboard-navigation passes
- Signed desktop installers when sustainable signing infrastructure exists

## Ink and documents

- Better pen, highlighter, eraser, and lasso behavior
- Shape tools and improved pressure and device handling
- Multi-page PDF import and annotation workflows
- Predictable page layout, printing, and PDF export
- Image cropping and attachment management
- A documented importer framework
- Careful experiments for OneNote migration, without promising full-fidelity import

## Search and portability

- Search indexing that scales beyond a single snapshot
- Optional local OCR and handwriting indexing
- Loss-aware Markdown and document export
- Full-workspace export with checksums
- Import and repair diagnostics
- A CLI for inspection, migration, and backup

## Sync research

Sync will not ship merely because two devices can exchange files. A credible design needs:

- Offline edits without silent overwrites
- Understandable conflict handling
- Version history and recovery
- End-to-end encryption with a documented key model
- Attachment integrity and selective transfer
- A self-hostable option
- Migration and protocol compatibility tests

WebDAV, S3, CRDTs, and a dedicated sync service are research options, not commitments.

## Longer-term possibilities

- Linux and macOS release hardening
- Android and iPad clients with real editing and pen support
- Collaboration and controlled sharing
- Plugin and importer APIs
- Local semantic search that is optional and never required for ordinary search

## Explicit non-goals for the early alpha

- Advertising
- Mandatory accounts
- Training models on notebook content
- Cloud-only storage
- Claiming feature parity with OneNote
- Shipping opaque sync that users cannot inspect or recover
