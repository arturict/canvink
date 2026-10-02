# Math Canvas acceptance and release evidence

The Math Canvas release gate combines deterministic repository tests with four external or personal evidence artifacts. The validator is fail-closed, content-free, and bound to the exact Git commit and `package.json` version being evaluated. It refuses staged, unstaged, or untracked worktree changes, and accepts only `0.2.0` or a `0.2.0-beta` prerelease. The current `0.1.x` line cannot pass this release gate.

Run the validator from the repository root:

```powershell
pnpm acceptance:math
```

It writes `test-results/math-canvas-acceptance.json` and exits with:

| Exit | Meaning |
| --- | --- |
| `0` | All four evidence artifacts are present, fresh, exactly shaped, bound to this commit/package, and above threshold. |
| `2` | Validation completed honestly, but evidence is missing or invalid. This is the expected state before real external exercises. |
| `3` | Invocation or validator policy failed, including dirty worktree or wrong package line. |

`test-results/` is ignored and may be cleared by test tooling. Preserve signed-off private evidence outside the checkout as appropriate, then copy only the four content-free JSON artifacts into the fixed directory for validation. Do not commit raw formulas, strokes, captures, keys, account details, or private benchmark material.

## Common envelope

Each file has exactly these envelope properties; unknown properties fail validation:

```json
{
  "schemaVersion": 1,
  "kind": "KIND_FROM_TABLE_BELOW",
  "contentFree": true,
  "repositoryCommit": "CURRENT_LOWERCASE_40_HEX_COMMIT",
  "packageVersion": "CURRENT_PACKAGE_VERSION",
  "recordedAt": "CURRENT_UTC_TIMESTAMP",
  "status": "passed",
  "producer": "PRODUCER_FROM_TABLE_BELOW",
  "results": {}
}
```

The schematic object above is intentionally invalid evidence. Real evidence must be at most 1 MiB, no older than seven days, no more than five minutes in the future, and use the exact current binding. Only a producer that actually performed the named exercise may set `status` to `passed`.

| File | `kind` | `producer` |
| --- | --- | --- |
| `test-results/math-canvas-acceptance/recognition-corpus.json` | `math-recognition-corpus` | `canvink-math-recognition-benchmark-v1` |
| `test-results/math-canvas-acceptance/gpu-latency.json` | `math-gpu-latency` | `canvink-math-gpu-benchmark-v1` |
| `test-results/math-canvas-acceptance/privacy.json` | `math-privacy` | `canvink-math-privacy-verifier-v1` |
| `test-results/math-canvas-acceptance/personal-workflows.json` | `math-personal-workflows` | `canvink-math-personal-workflow-drill-v1` |

## Recognition-corpus result

The exact result properties are:

- `corpusSha256`, `licenseManifestSha256`: lowercase SHA-256 identifiers for the reviewed corpus and provenance manifest;
- `sampleCount` at least 300 and `writerCount` at least 5;
- `basicCorrect`, `basicTotal`, `totalCorrect`, `totalCount` as nonnegative integer counts, with `totalCount` equal to `sampleCount`;
- `basicAccuracyPercent` and `overallAccuracyPercent`, recomputed by the validator from the counts within 0.01 percentage point;
- `provenanceReviewed: true`, `selfCreatedOrExplicitlyLicensed: true`, and `restrictedResearchDatasetUsed: false`.

Basic accuracy must be at least 90%, overall v0.2 school-corpus accuracy at least 80%. The evidence contains aggregate counts and hashes only, not formulas, strokes, writer identifiers, file names, or notes. The private manifest retains the auditable license/consent record. Research-restricted datasets are excluded from product training and acceptance data.

## GPU-latency result

The exact properties are `modelArtifactSha256`, bounded `apiVersion`, `measurements`, `privateServiceOnly: true`, and `rawContentIncluded: false`. `measurements` contains exactly two entries, one labelled `RTX-2070` and one `RTX-5060`, with exact properties `gpuClass`, `sampleCount`, `medianMs`, and `p95Ms`.

Every GPU entry must independently have median at most 1500 ms and p95 at most 3000 ms. Aggregate results cannot hide a failing device. Evidence contains timings and a model hash, never request images, strokes, formulas, endpoint, token, or machine/account identity.

## Privacy result

Privacy evidence uses exact integer request/leak counters and three booleans. A passing result requires:

- `explicitMathBlockRequestCount` greater than zero;
- `normalStrokeRequestCount`, `wholePageRequestCount`, `adjacentContentRequestCount`, and `unexpectedRequestFieldCount` equal to zero;
- `keyLeakCount`, `providerConfigLeakCount`, `workspaceSecretLeakCount`, `exportSecretLeakCount`, `logContentLeakCount`, and `telemetryContentLeakCount` equal to zero;
- `selectedBlockOnly`, `localRawMathPersistenceVerified`, and `networkCaptureReviewed` equal to true.

`localRawMathPersistenceVerified` deliberately proves the correct boundary: selected Math-block strokes and formulas survive a lossless workspace/bundle round trip, while credentials and provider configuration do not. The evidence records only counters and booleans, not inspected content or captures.

## Personal-workflow result

The exact properties are `workflowsTested` and booleans `mathematics`, `physics`, `pdfWorksheet`, `budget`, `offline`, `exportRoundTrip`, `providerFailurePendingState`, and `completedWithoutDataLoss`. At least four workflows must be exercised and every boolean must be true. The artifact contains no worksheet name, formula, screenshot, budget value, page title, provider account, or personal identifier.

This personal exercise improves confidence in the OneNote-replacement use cases. It does not by itself reconfirm the product-wide 80% replacement target.

## Automated validator tests

Run the focused policy suite with:

```powershell
pnpm acceptance:math:test
```

It creates synthetic fixtures only under the operating-system temporary directory and uses explicit test-only commit, package, and clean/dirty simulations. It verifies successful validation plus fail-closed behavior for dirty/untracked policy, wrong package line, missing, malformed, stale, content-bearing, wrong-binding, unknown-field, provenance, privacy, workflow, and threshold violations. Test-mode variables are not consulted in a production invocation. Temporary passing fixtures are validator tests, not release evidence.

Before beta or stable tagging, also run the repository unit, type, lint, build, Rust, security, migration/recovery, export, offline, provider, graph, and interactive E2E suites applicable to the release platform. `v0.2.0-beta.1` and `v0.2.0` remain blocked whenever any applicable automated gate or any external artifact is absent or failing.
