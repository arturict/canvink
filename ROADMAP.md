# Canvink roadmap

This roadmap separates implemented source from future direction. It is not a
promise, schedule, beta-readiness claim, or evidence that external services and
personal acceptance gates have passed.

Canvink will prioritize data integrity and excellent pen-and-page fundamentals before accounts, collaboration, or a large plugin ecosystem.

## Implemented v3 Math Canvas alpha foundation

The current source tree implements:

- A Tauri 2 desktop application and a limited browser demo
- Schema-v2/v3 Automerge readers with lazy atomic v2-to-v3 migration, current-schema v3 writers, activation checks, and guarded rollback
- Notebook, section, page, and subpage organization, including persisted notebook/section drag-and-drop, equivalent keyboard/menu controls, and cycle-safe move/copy across roots
- Free-canvas and A4 page modes
- Mixed ink, durable rich text and tables, checklist, shapes, images, attachments, PDF objects, Math blocks, linked interactive 2D graphs, and a movable/freely rotatable ruler that guides pen and straight tools
- Typed and explicitly selected handwritten mathematics with local exact/decimal evaluation, ordered variables, bounded school-level equation solving, safe graph sampling, MathLive correction, number scrubbing, calculator palette/history, and native offline unit conversion
- Native-only BYOK recognition adapters with DPAPI secrets plus a private compatible reference-service implementation; no public service or model/data-rights approval is implied
- Local autosave with SQLite on desktop and IndexedDB in the browser demo
- Bounded page history with integrity checks and copy-based recovery
- Content-addressed assets, multi-page PDF import/annotation/export with structurally copied and sanitized original source pages, and checksummed `.canvink` bundles
- Manual page tags and page task state, plus rebuildable local search with `tag:`/`is:` operators, a cross-page task review, and opt-in Windows OCR for printed and typed text
- Bounded OneNote acquisition with packaged Microsoft/loopback browser bridge, normal web redirects, normalized tags/tasks/checklists, per-page local PDF fallbacks, review, approval, rollback, and additive import
- Content-free performance diagnostics and a fail-closed exact 45-minute pen-evidence contract; the real target-hardware session remains open
- A transport-neutral encrypted sync protocol, durable client, Appwrite Function definitions, roles, device approval, key rotation, and recovery-code flows
- Windows DPAPI protection for desktop sync key material
- An optional, explicit-opt-in personal-space cross-device sync surface (own notebooks/pages/assets between the desktop app and the browser build for a signed-in user), built on the deployed sharing backend under a separate room kind, plaintext (not end-to-end encrypted) on the server, with a user-choice first-contact flow instead of an automatic merge
- A documented schema, security model, and release process

These are implemented source capabilities with automated tests, not proof of a
deployed sync service, personal migration fidelity, target-hardware performance,
trusted signing, or beta readiness. The v0.x series remains unstable; users
should expect explicit migrations and maintain independent backups.

## Reliability next

- Additional crash-recovery and transaction testing
- Backup scheduling and recovery diagnostics beyond the portable JSON workflow
- Database integrity checks and recovery guidance
- Large-document performance work beyond the current safety limits
- Scheduled external backups and packaged restore drills beyond local history and portable bundles
- Deeper accessibility and keyboard-navigation passes
- Signed desktop installers when sustainable signing infrastructure exists
- Reproducible launch and acceptance evidence for the dedicated unsigned `pnpm tauri:build:windows` NSIS/MSI output

## Ink and documents

- Better pen, highlighter, eraser, and lasso behavior
- Improved pressure/device behavior, palm rejection, and long-session pen performance on target hardware
- Broader PDF rendering fidelity for transparency, rotation, complex documents, and non-Latin fonts
- Predictable printing and additional page-layout controls
- Image cropping and attachment management
- Additional bounded importers and representative personal OneNote acceptance, without claiming broad parity

## Search and portability

- Search and OCR quality/performance work on representative large personal corpora
- Recognition quality, exponent/physics-notation ambiguity handling, and representative school-corpus expansion after the real-writer and licensing gates pass
- Loss-aware Markdown and document export
- Import and repair diagnostics
- A CLI for inspection, migration, and backup

## Sync activation and validation

The repository implements Automerge CRDT documents, encrypted envelopes and
assets, X25519/Ed25519 identities, XChaCha20-Poly1305, durable inbox/outbox and
cursors, Appwrite client/Function boundaries, roles, device approval, presence,
key epochs, rotation, and recovery. Those mechanics are not a deployed or
live-accepted collaboration service.

Before sync can be shipped, the remaining gates include:

- an explicitly authorized Appwrite deployment with reviewed resource permissions, quotas, backup, and restoration;
- two-account/two-device acceptance covering offline retry, Realtime catch-up, roles, approval, revocation, rotation, and recovery;
- a packaged Windows DPAPI close/restart/unlock drill;
- the exact 60-minute convergence artifact and target-size encrypted asset exercises; and
- an independent security review plus exact-source release approval.

Alternative transports such as WebDAV or S3 remain research options. Automerge
and the Appwrite adapter are current implementation choices, not promises that
the undeployed service is production-ready.

## Personal-space sync validation

The repository implements the personal-space cross-device sync surface
(`services/collab-sync/PERSONAL-SYNC.md`): a per-user Durable Object room,
workspace-topology CRDT document, lazy batched asset adoption, and a
first-contact user choice instead of automatic merge. Automated coverage
includes worker-side unit tests, a repo-root unit-test suite for the sync
hook, and end-to-end tests for a cold second device seeing a synced
notebook/page/image and for a different identity seeing an empty, isolated
space.

Before this surface can be considered reliable, the remaining gates include:

- resolving an observed, intermittent delay in a brand-new second device's
  first catch-up (the notebook a first device just created is not always
  visible within the current bounded retry-and-reconnect window; see
  `docs/architecture.md`'s "Known limitations" and the Wave 5 integration
  report for detail) — most plausibly a server/Worker-side durability-timing
  issue rather than something fixable from the client alone;
- end-to-end coverage for offline edit convergence on reconnect and for a
  delete-on-one-device/edit-on-another conflict, which this integration pass
  did not reach;
- exercising the known `BUNDLED_START_PAGE_ID` cross-device id-collision gap
  (two independently bootstrapped devices' bundled starter notebooks share a
  fixed page id; `commitWorkspaceGraphRevision` cannot both adopt and discard
  the same documentId in one transaction) with a real fix rather than a
  test-level workaround; and
- real two-device (desktop + browser) manual acceptance beyond the automated
  suite.

## Math Canvas validation

Before a Math Canvas beta or stable tag, the exact commit still requires:

- at least 300 self-created or explicitly licensed formulas from at least five
  writers, with the documented basic and overall semantic-accuracy thresholds;
- content-free latency evidence for both intended private GPUs, independently
  meeting the median and p95 targets;
- completed TexTeller code, model, training-data, and commercial-use review;
- a real BYOK/provider-failure and network-capture privacy exercise; and
- personal mathematics, physics, PDF worksheet, budget, offline, and export
  round-trip workflows without data loss.

The repository validator intentionally reports these gates as missing until real,
fresh, commit-bound evidence is supplied. Synthetic fixtures test the policy but
cannot satisfy release acceptance.

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
