# CI efficiency

This note records the July 29, 2026 GitHub Actions baseline and the reasoning
behind the first cost-reduction pass. The reliability contract in
[`release-process.md`](release-process.md) remains authoritative.

## Measured baseline

The baseline uses successful hosted runs from the repository, not local timing.
GitHub rounds hosted-runner usage per job, so short aggregation jobs still cost
one billed minute.

| Workflow | Observed jobs | Observed wall time | Estimated billed Linux minutes |
| --- | ---: | ---: | ---: |
| CI, warm Rust cache | Frontend 47 s, Rust 73 s, required 5 s | 80 s elapsed in parallel | 4 |
| CI, cold Rust cache | Frontend 46 s, Rust 592 s, required 4 s | 606 s elapsed in parallel | 12 |
| CodeQL | Actions 46 s, JavaScript 63 s, Rust 99 s, required 3 s | 105 s elapsed in parallel | 6 |
| Dependency Review | One 6 to 15 s job | 6 to 15 s | 1 |
| OpenSSF Scorecard | One 50 s job | 50 s | 1 |

The single Rust cache was 966 MiB. It included dependency targets, installed
security-tool binaries, and, because `cache-all-crates` was enabled, build
intermediates for CI tooling.

Four GitHub Actions Dependabot pull requests were opened in the same update
window. Each independently triggered CI, CodeQL, and Dependency Review.

Transient release artifacts from one draft build are approximately 96 MB:
about 86 MB for Linux, 8 MB for Windows, and 2 MB for source, licenses, notices,
and release metadata.

## Changes

- CI uses one `required` runner for the complete frontend and Rust contract.
  This removes duplicate checkout and job setup while preserving every command.
- CodeQL keeps Rust in buildless mode and analyzes Actions plus
  JavaScript/TypeScript together. The final `CodeQL` job also verifies that the
  Rust analysis passed, so the protected check still covers all three
  languages.
- The Rust cache uses the default dependency-only policy. Installed
  `cargo-audit` and `cargo-deny` binaries remain cacheable, while their
  unnecessary build intermediates do not. A policy marker creates a new full
  key but retains the old toolchain-level restore prefix for a warm migration.
- Dependabot groups explicitly match all minor and patch updates in each
  intended group. Major updates and security updates remain separately
  reviewable.
- Scorecard runs weekly, when branch protection changes, or when manually
  requested. Running the same scan on every main push was redundant because
  CI and CodeQL already protect each commit.
- Scorecard and release handoff artifacts expire after one day. Successful
  release payloads are copied into the GitHub draft in the same workflow, so
  Actions storage is only an intra-run handoff and short failure-diagnostics
  window.

No test, license, advisory, dependency-review, CodeQL language, release
verification, package smoke, attestation, or publication gate was removed.
Superseded PR runs continue to use `cancel-in-progress`. Release and Release
Please runs deliberately remain non-cancellable because they mutate release
state.

## Estimated effect

| Event | Before | After | Expected saving |
| --- | ---: | ---: | ---: |
| Ordinary warm-cache PR | 11 min | about 7 min | about 4 min, 36% |
| Ordinary main push | 12 min | about 7 min | about 5 min, 42% |
| Four simultaneous Actions update PRs | about 44 min | about 7 min as one group | about 37 min, 84% |
| One successful draft's transient artifact retention | 96 MB for 3 days | 96 MB for 1 day | 67% fewer MB-days |
| Scorecard artifact retention | 17 KB for 5 days | 17 KB for 1 day | 80% fewer MB-days |

The first main run after merging will report the exact lean Rust-cache size.
No cache-size saving is claimed before that measurement. The new policy is
expected to remove CI-tool build intermediates while retaining the dependency
targets that reduced a cold Rust job from roughly 10 minutes to roughly
1 minute.

## Trade-offs

- Combining CI jobs increases warm wall-clock feedback from about 80 seconds to
  roughly 2 minutes, but cuts per-job rounding and avoids running Rust after an
  earlier frontend failure.
- The two CodeQL jobs run sequentially so the protected `CodeQL` result can
  include Rust without a third aggregation runner. Expected elapsed time grows,
  while billed minutes fall and coverage stays unchanged.
- One-day release handoff retention means a failed draft build must be rerun
  after a day. Successful draft assets and attestations remain on the draft
  release and are unaffected.
- Coarse `paths-ignore` rules were not added to required workflows. GitHub
  branch protection requires `required`, `CodeQL`, and `Dependency Review` for
  every pull request, and the release workflow requires exact checks on the
  current main SHA. Skipping an entire required workflow would leave checks
  pending or weaken the release proof. The safe trigger reduction in this pass
  is limited to the redundant Scorecard push event and grouped dependency
  updates.
