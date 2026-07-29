# Contributing to Canvink

Thank you for helping build a trustworthy local-first notebook.

Canvink is an early public alpha. Small, well-tested changes are easier to review and safer for user data than broad rewrites. A contribution should leave the repository easier to understand and should not overstate what the product can do.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before starting

1. Search existing issues and pull requests.
2. Read the [architecture](docs/architecture.md), [file format](docs/file-format-v1.md), and [roadmap](ROADMAP.md).
3. Open an issue before a large change, a new dependency, a data-format change, or a security-sensitive design.
4. Keep bug reports free of private notebook content. Create a minimal synthetic reproduction instead.

Security vulnerabilities must not be reported in a public issue. Follow the private reporting process in [docs/security-model.md](docs/security-model.md).

## Development setup

You need Node.js 20.19 or newer and pnpm 11.18.0, pinned through `packageManager`. Desktop development also needs Rust stable and the platform requirements listed by Tauri.

```bash
pnpm install
pnpm dev
```

Run the desktop shell with:

```bash
pnpm tauri:dev
```

## Working on a change

- Create a focused branch from the current default branch.
- Keep unrelated formatting and refactors out of the same pull request.
- Preserve opaque IDs, array ordering, and versioned migrations in persisted data.
- Add or update tests for behavior changes and regression fixes.
- Use synthetic fixtures. Never commit personal notes, documents, database files, access tokens, signing keys, or production logs.
- Update user-facing documentation when behavior, risks, commands, or file-format details change.
- Add a changelog entry when the change is visible to users or affects compatibility.

## Quality gates

Run the same core checks expected in continuous integration:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

For Rust or Tauri changes, also run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features
```

Cargo can remove the inline `x-release-please-version` marker when it regenerates `src-tauri/Cargo.lock`. Run `pnpm release-marker:check` after every Cargo lockfile update and restore the marker on the `canvink` package version before committing.

If a command cannot run on your platform, state exactly which command was skipped and why in the pull request.

## Pull request checklist

A pull request should explain:

- The user problem and the smallest change that solves it
- How the change was tested
- Any storage, migration, privacy, security, accessibility, or performance impact
- Screenshots or a short recording for meaningful interface changes
- New dependencies and why existing code cannot reasonably provide the same result
- Known limitations and deliberate follow-up work
- Material AI assistance, including what it produced and how it was reviewed

Reviewers may ask for a smaller patch, additional tests, a migration plan, or removal of a dependency. This is normal for software that handles user data.

## AI-assisted contributions

AI tools are allowed, but accountability cannot be delegated.

- Disclose material AI assistance in the pull request.
- Read, understand, and validate every generated change.
- Verify licenses and provenance for generated or suggested material.
- Do not send private user data, secrets, unreleased vulnerabilities, or third-party confidential material to an AI service.
- Do not present generated tests as evidence unless they were actually executed.

Undisclosed bulk-generated changes may be closed when they create an unreasonable review burden.

## Data-format changes

The logical workspace schema is versioned. Any persisted-shape change must include:

1. A documented reason
2. A forward migration
3. Tests using representative older data
4. A recovery or rollback explanation
5. An update to [docs/file-format-v1.md](docs/file-format-v1.md)

Never silently reinterpret an existing field. Additive changes can still require a schema version when older clients would discard or corrupt the new data.

## Licensing

Unless a file says otherwise, contributions are accepted under the GNU Affero General Public License version 3 or any later version. By submitting a contribution, you confirm that you have the right to license it on those terms.
