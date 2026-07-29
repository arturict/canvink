# Release process

## Purpose

This process is the release contract for Canvink. It aims to make every public artifact traceable to one reviewed commit and to prevent marketing or automation from getting ahead of verified software.

Canvink 0.x releases are public alphas. The `0.x` version does not imply stable storage compatibility, and unsigned packages must always be labeled as unsigned.

## Versioning

- Package, Cargo, Cargo lockfile, Tauri, Release Please manifest, tag, changelog, and displayed application versions must agree.
- Tags use `vMAJOR.MINOR.PATCH`, such as `v0.1.0`.
- The changelog uses the same version without the `v` prefix.
- A release tag is never moved or reused. A correction receives a new version.
- During `0.x`, incompatible schema changes still require an explicit migration and changelog notice. Breaking conventional commits advance the alpha minor version instead of implicitly declaring 1.0.

## Pull-request gates

The protected default branch should require:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features
```

Workflow controls:

- Minimal top-level permissions, normally `contents: read`
- Explicit write permissions only in the release job that needs them
- Action references pinned to immutable commit SHAs
- No repository secrets exposed to code from forks
- Dependency installation from the committed lockfile
- Concurrency cancellation for superseded branch checks
- Build logs that never print secrets or full private filesystem paths
- Artifact retention long enough for release review, but not indefinite

Static analysis and dependency scanning supplement tests. They do not replace review or runtime smoke testing.

Release Please is limited to preparing version and changelog pull requests. Both its configuration and action input disable GitHub Release creation. When no dedicated `RELEASE_PLEASE_TOKEN` is configured, the workflow uses the repository token and explicitly dispatches CI, CodeQL, and Dependency Review against the verified release pull request head. This avoids depending on approval-gated pull-request events created by the repository token. A dedicated token may be added later only with narrowly scoped repository access.

Because tagging and publication happen in the separate protected workflow, Release Please does not perform its normal lifecycle-label transition. Before preparing another release pull request, the workflow inspects every merged `autorelease: pending` pull request. It changes a pull request to `autorelease: tagged` only when the expected version files are present, its merged commit equals the exact tag target, and that tag already has a published GitHub Release. An unpublished or draft release leaves the pull request pending and pauses new release preparation without bypassing the publication gate.

## Release preparation

1. Choose the exact commit after required checks pass.
2. Confirm the worktree is clean.
3. Update `CHANGELOG.md`.
4. Confirm versions match in `package.json`, Cargo metadata, Tauri configuration, and the interface.
5. Review storage migrations and verify an older fixture can open without data loss.
6. Run the complete local gate where practical.
7. Dispatch the release workflow with the exact `vX.Y.Z` tag and `publish: false`.
8. Let the workflow verify the exact default-branch commit, create the tag if absent, build packages, launch-smoke them, and create a verified draft.

The workflow has no tag-push trigger. Its default is draft-only. A later `publish: true` dispatch does not rebuild or replace that draft: it requires the exact draft database ID and SHA-256 of the draft's `SHA256SUMS` file. Setting `publish: true` and approving the protected `release` environment are separate release authorizations. A marketing draft, successful local build, automated launch smoke, or Vercel preview is not publication approval.

The `release` environment must require a trusted reviewer and should prevent administrators from bypassing approval. The draft job can create and verify an unpublished draft, but only the environment-gated promotion job can publish it.

Actions artifacts used to hand source, legal files, metadata, and native
packages between jobs expire after one day. A successful run copies the exact
payload into the unpublished GitHub draft before that handoff expires. If a
failed run is not resumed within the retention window, dispatch a fresh draft
build rather than treating missing intermediate artifacts as release evidence.

## Desktop artifacts

Desktop builds should be produced on maintained hosted runners for each supported platform. A matrix entry must not be advertised as supported until its package installs and starts in a clean environment.

For each artifact:

- Record the exact tag and commit SHA
- Use the lockfile and Cargo lock data from that commit
- Preserve build logs
- Launch the packaged payload in an isolated profile before staging it
- Generate SHA-256 checksums
- Upload only the final package type, not temporary build directories
- Label unsigned packages prominently
- Do not imply notarization, code signing, or antivirus reputation that was not verified

The current 0.x release can provide unsigned alpha artifacts. Users must be told that the operating system may warn and that checksums do not provide the same identity assurance as a signed package.

### Automated packaged launch smoke

The release workflow performs a bounded launch smoke before any package becomes a draft asset:

- Linux AppImage: runs with extraction enabled under `xvfb`, D-Bus, an isolated home directory, and no elevated application process.
- Linux deb: installation is the only `sudo` operation; the installed application is launched afterward as the ordinary Actions runner under `xvfb` with isolated XDG directories.
- Windows NSIS: installs silently in Tauri's `currentUser` mode with `/S` and an isolated `/D=` destination, then launches the installed executable without `RunAs`.
- Windows MSI: installs on the disposable runner with `/i`, `/quiet`, and `/norestart`, then launches the registered installed executable.
- Both installed Windows applications must expose a `Canvink` window, accept a normal `CloseMainWindow` request, and exit cleanly. NSIS must then pass its silent uninstaller and MSI must pass `/x`, `/quiet`, and `/norestart`.

The Linux checks prove that each package can reach its initial window. The Windows checks additionally prove silent installation, a clean normal-window close through the packaged application, and silent uninstall on the disposable runner. They do not prove editing, dirty-close behavior, persistence, import/export, upgrade behavior, or that every file and registry entry is removed. Those behaviors belong to the exact-draft manual synthetic test below.

## Landing page deployment

Production deployment is separate from a successful build.

1. Build the exact release commit.
2. Deploy through the connected Vercel project with a protected production environment.
3. Configure the required repository variables:
   - `VERCEL_PRODUCTION_URL`: the canonical HTTPS production URL
   - `VERCEL_ALLOWED_HOSTS`: an exact comma-separated hostname allowlist with no wildcards
4. Accept an automatic landing smoke only for a successful Vercel `Production` deployment created by `vercel[bot]`.
5. Check `/`, `/app`, assets, the manifest, cache policy, and security headers over HTTP.
6. Require `/version.json` to equal the deployment's full commit SHA.
7. Run the locked Playwright Chromium smoke against the same canonical URL on desktop and mobile.
8. Verify rendered navigation, IndexedDB persistence, search, second-tab protection, and the absence of browser console errors.
9. Record the canonical URL and deployed commit SHA.

Preview deployment URLs are never implicitly allowlisted and cannot satisfy the production check. Do not call a local preview, Vercel preview, or an unverified deployment URL the public release.

## Exact-draft manual synthetic promotion

Automated launch smoke is intentionally shallow. A `publish: false` run records the unpublished draft database ID and SHA-256 of its `SHA256SUMS` file in the workflow summary. Before promotion:

- Download the assets from that exact GitHub draft, not a previous run or a local rebuild.
- Verify `SHA256SUMS`, the tag SHA, and GitHub attestations.
- Launch the exact AppImage or deb and the exact NSIS or MSI payload intended for publication.
- Create a synthetic notebook, section, and page.
- Add ink, text, an image, and a small test PDF.
- Make an unsaved or recently edited change, close the window normally, and verify the dirty-close path completes.
- Reopen the application and verify the synthetic content persisted.
- Search for synthetic text.
- Move or delete an item and check supported trash recovery.
- Exercise available export paths.
- Verify no network request contains notebook content.
- Open the web demo in a fresh browser profile and confirm its storage is isolated from desktop data.

Record the draft database ID, `SHA256SUMS` digest, asset checksums, tested platforms, and result. Then dispatch the same workflow with the exact tag, `publish: true`, `draft_id`, and `manifest_sha256`. Build and draft jobs are skipped, so the tested draft cannot be clobbered by a rebuild. Approve the protected environment only after that exact draft passes.

The checksummed asset set includes `RELEASE-METADATA.json` with the exact tag, version, and original 40-character release commit SHA. The independent promotion job requires the tag still to be the exact default-branch head, re-downloads the prior draft, checks its exact database ID and manifest digest, verifies every listed checksum and the complete asset set, and requires that metadata to match during draft creation and both promotion passes. It also performs a fresh strict request to the exact allowlisted canonical `/version.json` and requires both the deployed version and commit to match the release. Only then can it publish.

Do not treat an older or rebuilt draft's manual result as evidence for different bytes. If the tag, draft assets, manifest, or default-branch head changes, create and manually test a new draft.

Use only synthetic content in CI and public evidence. Never use personal notebooks, customer documents, credentials, or private PDFs in release testing.

## Release notes

Every release note should include:

- One-sentence purpose
- User-visible additions and fixes
- Data-format or migration impact
- Known limitations
- Supported and actually tested platforms
- Unsigned-build warning where applicable
- Checksums
- Link to the exact source tag
- Thanks and contributor credit

Roadmap work must not appear under shipped features.

## Rollback and incident response

Never delete or replace a published tag to hide a bad release.

For a severe defect:

1. Mark the affected release and download as problematic.
2. Pause marketing and automated distribution.
3. Preserve logs and the exact artifact for investigation.
4. Publish a concise warning with safe user actions.
5. Fix forward with a new version.
6. Explain data-recovery steps before asking users to reopen affected data.

For a landing-page issue, roll back to the last verified Vercel deployment while preserving evidence of the faulty deployment.

## Future signing

Signing keys must live in protected secret storage, never in the repository or ordinary CI artifacts. Signing and notarization jobs should require explicit environment approval and should consume already-tested artifacts where the platform supports that pattern.
