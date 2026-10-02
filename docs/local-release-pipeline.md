# Local and self-host release pipeline

This pipeline verifies a release candidate without consuming GitHub Actions
minutes and without deploying or publishing anything. It is safe to run on a
developer machine or an authorized self-hosted build machine.

## Prerequisites

- Node.js matching `.node-version`
- the exact pnpm version from `package.json#packageManager`
- dependencies installed with `pnpm install --frozen-lockfile`
- Playwright Chromium installed with `pnpm exec playwright install chromium`
- optional: Docker with the Compose plugin for the container smoke
- for the complete release gate: the pinned Rust toolchain and native linker
  prerequisites for the host platform, including MSVC Build Tools on Windows
- for the complete release gate: preinstalled `cargo-audit` 0.22.2 and
  `cargo-deny` 0.20.2; the gate never installs tools automatically

Do not pass secrets to these commands. The web application is a static build and
the container gate does not require credentials.

## Self-host preflight

```shell
pnpm self-host:preflight
```

This is the normal full self-host gate. By default it runs:

1. `pnpm check`, including lint, TypeScript, unit and script tests, release
   marker, npm license policy, and a production build
2. the complete Playwright E2E suite against that prebuilt output
3. the static `dist` artifact check
4. the Docker smoke when Docker is available, with a clean development `SKIP`
   when the CLI or daemon is unavailable

When the Docker CLI and Compose are available but the daemon is stopped, `auto`
still validates the rendered Compose security controls before reporting `SKIP`.
`required` blocks with exit 4 when either the CLI or daemon is unavailable.

The Docker policy can be selected explicitly:

```shell
pnpm self-host:preflight -- --docker=required
pnpm self-host:preflight -- --docker=skip
```

## Complete release preflight

```shell
pnpm release:preflight:local
```

The complete release preflight first runs the entire self-host preflight above.
For this command Docker is always `required`. A missing daemon or skipped
container smoke blocks the candidate. A dirty Git worktree also blocks before
any build so a release cannot claim provenance from a different clean commit.
Before any gate, it requires exact Node, pnpm, and rustc versions from the
repository and exact `cargo-audit` 0.22.2 and `cargo-deny` 0.20.2. Version
mismatches or missing tools are hard failures and nothing is installed
automatically. It then runs the existing Rust release gates with the same
arguments as CI:

1. `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
2. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings`
3. `cargo test --manifest-path src-tauri/Cargo.toml --all-features --locked`
4. `pnpm notices:check`
5. `pnpm audit --prod --audit-level high`
6. `cargo audit --file src-tauri/Cargo.lock`
7. `cargo deny --manifest-path src-tauri/Cargo.toml --config
   .github/cargo-deny.toml check advisories bans licenses sources`

Missing Cargo security tools are hard failures. There is no automatic install
and no security-gate SKIP.

CodeQL and GitHub Dependency Review remain GitHub-only review gates. This local
pipeline does not claim to run or replace them.

`auto` and `skip` belong only to the development-oriented
`self-host:preflight`. A `SKIP` result is never release evidence and must not be
recorded as a passing release container gate.

Individual gates are also available:

```shell
pnpm check
pnpm test:e2e
pnpm self-host:check
pnpm self-host:docker-smoke -- --mode auto
pnpm self-host:docker-smoke -- --mode required
pnpm self-host:docker-smoke -- --mode skip
pnpm rust:check
```

The static artifact gate reuses `scripts/smoke-site.mjs`. It verifies referenced
assets, the manifest, release markers, version metadata, the self-host
configuration, offline/PWA files, and that no common key or environment-file
formats are present in `dist`.

The Docker smoke validates `compose.yaml`, builds `Dockerfile`, launches a
temporary read-only container on an ephemeral localhost port, drops all Linux
capabilities, prevents privilege escalation, mounts a bounded
`noexec,nosuid,nodev` `/tmp`, and checks:

- rendered Compose controls for loopback publishing, read-only root, dropped
  capabilities, no-new-privileges, bounded PIDs, and `/tmp` tmpfs
- `GET /healthz` returns HTTP 200 and exactly `ok\n`
- `/` returns the Canvink page
- `/app` is served by the SPA fallback
- CSP, `nosniff`, and frame denial headers
- non-cacheable HTML/service-worker metadata and immutable hashed assets
- container version metadata matches the exact tested clean or dirty source
- a missing `/assets/` file returns 404 instead of the SPA shell

The smoke attempts to remove its temporary container and image after success or
failure. Cleanup results are checked. A cleanup failure is reported visibly and
turns an otherwise successful smoke into a failure. If the smoke already failed,
cleanup failure is emitted as an additional warning.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | All requested gates passed; only `self-host:preflight` may also return 0 after an explicit/development Docker SKIP |
| 2 | Invalid command-line configuration |
| 3 | A local project or static artifact gate failed |
| 4 | Docker was required but its CLI or daemon was unavailable |
| 5 | Docker, Compose, the image build, or the running container failed its smoke test |

Child commands can return a more specific non-zero exit code. Any non-zero code
blocks the candidate.

## Boundary

These commands only produce local build output and temporary Docker resources.
They never create commits or tags, push to GitHub, publish packages, sign desktop
artifacts, create releases, or deploy production. Those operations remain
separate approval gates.
