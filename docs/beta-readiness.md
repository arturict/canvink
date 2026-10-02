# Beta readiness

## Status

The current source tree is under beta-readiness evaluation. It is not a beta, a release, or publication evidence. Public product language remains `public alpha` until exact-source automation, live and personal acceptance, security review, release packaging, and explicit approval all complete. The [consolidated acceptance matrix](acceptance-matrix.md) is the status authority for those gates.

## Implemented outcomes with automated evidence

The source and deterministic tests currently cover:

- schema-v2 startup, fail-closed v1 migration, activation/reopen, additive revisions, and recovery reporting;
- notebook, section, page, and nested-page organization, including persisted notebook/section drag-and-drop plus equivalent arrow/menu operations, move/copy/duplicate/trash/restore, and the live mixed-object canvas;
- canonical Automerge/ProseMirror rich text, local editor operations, a movable/freely rotatable ruler that guides pen and straight tools, accessible German/English controls, and conflict-aware device-local undo/redo;
- content-addressed images, PDFs, attachments, `.canvink` bundles, and page/section/notebook export paths, including structural reuse and sanitization of original PDF source pages beneath Canvink overlays;
- manual page tags and open/done page task state that share one normalizer with OneNote acquisition;
- local derived search across schema-v2 metadata, rich text, tags/tasks/checklists, PDF text, and accepted OCR text, including `tag:`/`is:` query operators, a cross-page task review, and corrupt-index rebuild;
- Windows local OCR plumbing with bounded queues and no browser/cloud fallback;
- verified manual, automatic, and trash history checkpoints with copy-based restore;
- bounded additive OneNote acquisition/conversion/application with packaged loopback system-browser authorization, browser redirect authorization, normalized source tags/tasks/checklists, optional per-source-page local PDF fallback, explicit review, per-page fidelity, receipt, and guarded rollback;
- content-free cached-navigation/storage diagnostics and a pen-evidence exporter that remains disabled until the strict 45-minute, 20-sample, `<20 ms` p95 contract is actually satisfied;
- an opt-in encrypted-sync client and undeployed Appwrite backend definition with roles, device approval/recovery, encrypted changes/assets, durable outbox/catch-up, Realtime wakeups, presence, and conflict badges;
- Windows DPAPI protection for sync-device/private notebook keys;
- default-unsigned release behavior plus a separate fail-closed trusted Authenticode path.

This list means code and automated coverage exist. It does not say that Graph, Appwrite, Windows OCR language packs, physical pens, personal documents, DPAPI across a real packaged restart, or a trusted signing certificate have been exercised.

## Exact local automated and build commands

Run from a clean exact-source snapshot with the pinned toolchain:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
pnpm self-host:preflight
pnpm rust:check
pnpm tauri:build:windows
pnpm notices:check
pnpm security:npm:audit
pnpm security:cargo
```

`pnpm check` runs lint, typecheck, the Vitest and `scripts/*.test.mjs` suites, release-marker validation, npm license policy, and the production build. `pnpm rust:check` runs Rust formatting, Clippy with warnings denied, and Rust tests. `pnpm tauri:build:windows` is the dedicated locked, unsigned NSIS/MSI build command; it does not satisfy launch, physical-device, signing, or publication gates. CI/CodeQL, exact release-commit checks, native package launch smokes, attestations, and manual draft promotion remain separate release gates.

Focused evidence can be reproduced with:

```bash
pnpm exec vitest run src/security/adversarial.test.ts
pnpm exec playwright test tests/e2e/security-v2.spec.ts
pnpm exec vitest run src/history src/search src/sync src/components/sync
pnpm exec vitest run src/import src/io/pdf src/components/assets
node scripts/run-sync-soak.mjs 60
```

The final command is intentionally long-running and writes `test-results/sync-soak-60m.json` plus `test-results/sync-soak-60m.md` only after the exact 60-minute, 20-client gate succeeds. Until both files land and are reviewed, shorter convergence tests do not satisfy that gate.

## Live and personal gates still open

These gates cannot be replaced by mocks or unit tests:

1. Use a real target pen for exactly 45 minutes, export `canvink-pen-performance-YYYY-MM-DD.json` from the canvas, and require at least 20 pen-preview samples with p95 below 20 ms. Review ergonomics, palm rejection, memory, and save behavior as well as the number.
2. Complete the exact 60-minute sync soak and retain the generated JSON/Markdown report.
3. Deploy the placeholder Appwrite resources to a dedicated non-production project after reviewing the CLI plan, then exercise two real accounts, two devices, roles, invitations, approval/recovery, offline catch-up, Realtime wakeups, conflicts, revocation, key rotation, encrypted assets, and server restoration.
4. On a packaged Windows build, create protected sync identity material, close the app, restart under the same user, unlock it through DPAPI, and prove wrong-user/tampered recovery fails closed without replacing keys.
5. Register the exact browser or loopback redirect in a real Microsoft Entra public client, then import representative personal OneNote notebooks with actual consent and Graph responses. Exercise system-browser cancellation/timeout where packaged, review normalized tags/tasks/checklists and every page fidelity report, missing resource, selected/removed local PDF fallback, hierarchy, attachment, receipt, idempotent retry, and guarded rollback. Keep private content, tokens, and tenant details out of public evidence.
6. Run local OCR on representative personal German/English scans with installed language packs; verify text, rotation, boxes, resource bounds, and that no request leaves the device.
7. Import and export representative personal PDFs, then visually compare every page, structurally copied source content, sanitized interactive entries, Canvink overlay order, original preservation, transparency, rotation, scan-only pages, non-Latin fallback, and `.canvink` round-trip.
8. Supply a publicly trusted Code Signing certificate and RFC 3161 service, pass `pnpm release:preflight:signed`, build with the signing overlay, and pass `pnpm release:verify:signed`. No certificate or signed Canvink artifact currently exists.

## Honest remaining limitations

- The local SQLite/IndexedDB notebook authority is not application-encrypted at rest; DPAPI protects sync keys only.
- The Appwrite backend is undeployed and live two-account behavior is unaccepted.
- History is not an external or device-level backup.
- OneNote support is bounded import, not broad parity; handwriting recognition is not implemented.
- Native malware scanning, mobile applications, and an independent security audit are absent.
- Real hardware/resource limits and trusted signed-package behavior remain open as listed above.

## Publication gates

Before changing `public alpha` copy or publishing any beta:

1. Freeze and identify the exact clean source commit.
2. Pass all automated commands and record CI, CodeQL, dependency, packaging, launch-smoke, SBOM, checksum, and provenance results for that commit.
3. Complete every applicable live/personal row in [acceptance-matrix.md](acceptance-matrix.md), recording private evidence without committing personal notes, credentials, tokens, recovery material, or certificate material.
4. Review the complete persistence, migration, crypto, sync, import, recovery, and signing diff and threat boundaries.
5. Synchronize package, Cargo, Tauri, changelog, release metadata, and UI versions to a new immutable version; never move or reuse a tag.
6. Obtain Artur's separate explicit approvals for merge, draft acceptance, release publication, and production promotion.

Until then, describe the work only as implemented source with automated evidence and outstanding live gates.
