# Beta readiness

## Status

The current source tree is a beta candidate, not a published beta. The public product language remains `public alpha` until the candidate has passed review, exact-source release gates, and an explicitly approved release. This document separates product readiness from publication status.

## Daily-use outcomes covered

- A blank Quick note opens as the first value path, with an optional guide that can be skipped and resumed.
- Notebook, section, page, and nested-page organization work on desktop and focused mobile layouts.
- Pages and text are searchable without a network service.
- Autosave reports loading, saving, saved, and actionable error states honestly.
- A failed authoritative save keeps the in-memory edit available for retry and portable rescue download.
- A temporary versioned recovery journal protects edits during the autosave window. Startup validates a differing draft and requires an explicit restore, download, or discard decision.
- The browser writer lock prevents two tabs from silently overwriting the same origin-scoped workspace and explains the conflict directly.
- The cached browser shell can reopen after a successful online visit, while note data remains local to IndexedDB. This is offline use, not sync.
- Trash restore, JSON workspace backup and restore, Markdown import and export, page image and PDF export, and bounded image and PDF preview import are present.
- The same static browser artifact can run from the documented rootless container without a Canvink backend or account.

## Evidence required for the candidate

Run from a clean exact-source snapshot with the pinned toolchain:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:scripts
pnpm build
pnpm test:e2e
pnpm self-host:preflight
pnpm rust:fmt:check
pnpm rust:clippy
pnpm rust:test
pnpm licenses:check
pnpm security:npm:audit
pnpm security:cargo:audit
pnpm security:cargo:deny
```

The browser suite must cover first start, note capture, hierarchy, search, reload and resume, save failure and recovery, invalid import, offline shell, two-tab writer conflict, desktop and mobile layout, console errors, and unintended overflow. The self-host smoke test must verify health, routes, version metadata, security headers, cache behavior, and non-success for missing paths.

## Honest beta limitations

- No cross-device sync, collaboration, or merge model
- No page history or scheduled backup system
- No end-to-end or application-level encryption
- No complete OneNote importer, OCR, or handwriting recognition
- Snapshot persistence and embedded data URLs are not proven for very large notebooks
- Desktop installers remain unsigned until sustainable signing is in place
- No independent security audit has been completed

These limitations do not block a narrowly described beta, but they must remain visible in release notes and product copy.

## Publication gates

Before changing `public alpha` copy or publishing a beta:

1. Review the complete persistence and recovery diff, including temporary plaintext duplication in webview IndexedDB.
2. Pass the repository's security and Codex review gates against the exact candidate source.
3. Synchronize package, Cargo, Tauri, changelog, release metadata, and UI versions to a new immutable version. Do not reuse or move an existing tag.
4. Run the local release pipeline and exact-source browser, desktop, and self-host verification.
5. Obtain Artur's explicit approval for merge, release publication, and production promotion.

Until those gates are complete, this repository may be tested as a beta candidate but must not be marketed as a released beta.
