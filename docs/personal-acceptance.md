# Personal Windows acceptance

Canvink's automated suite proves deterministic application behavior, but it cannot establish that a particular Windows school device, personal Microsoft account, representative document set, live Appwrite project, or trusted signing identity works. This workflow makes those remaining checks executable without collecting notebook content or pretending an unrun gate passed.

## Read-only preflight

Run from the repository root in Windows PowerShell:

```powershell
pnpm acceptance:windows
```

The default phase only reads local capability and configuration metadata. It writes `test-results/windows-school-acceptance.json` and exits with:

| Exit | Meaning |
| --- | --- |
| `0` | Every preflight prerequisite and expected evidence artifact is present and valid. |
| `2` | The probe completed honestly, but one or more prerequisites or evidence artifacts are missing or invalid. |
| `3` | The invocation, checklist, or probe failed policy validation. |

The report contains Windows version/build, aggregate hardware and certificate counts, installed OCR language tags, OneNote availability, exact environment-variable presence booleans, tracked Appwrite configuration status, stable blocker codes, and fixed relative evidence paths. It never records device names, user/account names, notebook names, document text, file names, certificate subjects/thumbprints, environment values, tokens, or recovery material.

Pen detection does not search friendly names for words such as `pen` or `digitizer`. A present `HIDClass` device must expose the exact HID Digitizers usage-page identifier `HID_DEVICE_UP:000D_U:0001` or Pen identifier `HID_DEVICE_UP:000D_U:0002`. A device that does not publish either identifier remains blocked and must not be manually relabeled as detected.

Windows OCR availability is read from `Windows.Media.Ocr.OcrEngine.AvailableRecognizerLanguages`. OneNote detection reports only whether the packaged or Win32 executable registration exists; it never enumerates notebooks or recent files. Certificate inspection reports aggregate Personal-store counts and local trust/current-validity/private-key status without reporting certificate identity.

## Configuration prerequisites

The preflight reports presence, never values, for these exact variables:

- Entra public client: `VITE_MICROSOFT_CLIENT_ID`, `VITE_MICROSOFT_REDIRECT_URI`.
- Appwrite Function/runtime: `APPWRITE_FUNCTION_API_ENDPOINT`, `APPWRITE_FUNCTION_PROJECT_ID`, `CANVINK_ALLOWED_ORIGINS`.
- Windows signing: `CANVINK_WINDOWS_SIGNED`, `CANVINK_WINDOWS_SIGN_PROVIDER`, `CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT`, `CANVINK_WINDOWS_TIMESTAMP_URL`.

It also verifies that `appwrite.config.json` no longer contains the tracked project/endpoint placeholders and still references all resource files. This is configuration readiness only. The script never runs Appwrite push/deploy, creates an Entra registration, opens an OAuth consent flow, imports or creates certificates, or validates secret values. Use the dedicated signing preflight for exact certificate/provider validation.

## Optional explicit phases

These phases are opt-in and retain the same content-free report:

```powershell
# Run the existing repository check; no personal material is supplied.
pnpm acceptance:windows:automated

# Launch only src-tauri/target/release/Canvink.exe if it already exists.
pnpm acceptance:windows:launch

# Ingest the bounded personal checklist after the manual exercises.
pnpm acceptance:windows:checklist
```

Launching the built app is the only interactive phase. The script does not click UI, grant Microsoft consent, sign in, deploy infrastructure, create a certificate, or enter credentials. Stop if the displayed account, requested Graph scope, redirect URI, Appwrite project, or signing artifact is not the intended one.

## Content-free evidence contract

Every evidence file uses the same exact envelope. Unknown fields are rejected so notes, account identifiers, and document names cannot accidentally enter evidence:

```json
{
  "schemaVersion": 1,
  "kind": "personal-acceptance-checklist",
  "contentFree": true,
  "repositoryCommit": "CURRENT_40_CHARACTER_GIT_COMMIT",
  "packageVersion": "CURRENT_PACKAGE_VERSION",
  "recordedAt": "2026-08-03T12:00:00.000Z",
  "status": "passed",
  "producer": "canvink-windows-acceptance-checklist-v1",
  "results": {
    "penSampleCount": 20,
    "penP95Ms": 15.2,
    "penSessionMinutes": 45,
    "personalPdf": true,
    "personalOneNote": true,
    "personalOcr": true,
    "collaborationAccountCount": 2,
    "collaboration": true,
    "dpapiRestart": true,
    "encryptedBackupRestore": true,
    "trustedSignedArtifact": true,
    "syncSoak": true
  }
}
```

`repositoryCommit` must equal the current checkout's `git rev-parse HEAD`; `packageVersion` must equal `package.json`. `recordedAt` must be an ISO UTC timestamp no more than seven days old and no more than five minutes in the future. `contentFree` must be the boolean `true`, `status` must be `passed`, and `kind` and `producer` must match the file's definition below. Empty, malformed, stale, mismatched, manually labelled, oversized, and content-bearing artifacts are rejected. A checklist is valid only when every dependent artifact is valid and its pen and collaboration aggregates agree with those artifacts.

The pen gate requires at least 20 actual pointer-to-frame samples and a nearest-rank p95 strictly below 20 ms. The session duration is exactly 45 minutes. Do not copy the example aggregate; use the result from the real device recorder.

The boolean gates mean:

- **Personal PDF:** representative text, scan, multi-page, annotation, reload, and export behavior was visually checked without retaining the document in test artifacts.
- **Personal OneNote:** the intended account granted delegated `Notes.Read` only; representative hierarchy/content was reviewed, imported additively, reopened, and rollback checked. Do not record account or notebook names.
- **Personal OCR:** representative printed German/French/English material, rotation, boxes, queue behavior, and local-only network observation passed. Handwriting and mathematical layout remain experiments.
- **Collaboration:** at least two distinct real accounts completed encrypted edit, offline catch-up, conflict, role, revocation, and reconnect exercises against the intended Appwrite project.
- **DPAPI restart:** the target Windows identity reopened protected device material after a complete application and OS restart; another identity could not.
- **Externally encrypted backup restore:** a complete integrity-checked `.canvink` bundle was stored in a separately encrypted backup location, restored on the intended clean profile/device, and missing/tampered bundle material failed closed. The `.canvink` container itself is not application-encrypted.
- **Trusted signed artifact:** the exact built executable and installer passed Authenticode verification with a currently trusted external certificate and timestamp. A self-signed certificate is not acceptance evidence.

## Evidence paths and value gates

The report checks only these fixed paths. Each file must use the envelope above plus the exact `kind`, `producer`, and `results` properties shown here:

| Gate and path | Producer | Required `results` |
| --- | --- | --- |
| Checklist: `test-results/personal-acceptance/checklist.json` | `canvink-windows-acceptance-checklist-v1` | The exact checklist fields shown above; all booleans true, samples at least 20, p95 below 20 ms, session 45 minutes, accounts at least 2. |
| Pen p95: `test-results/personal-acceptance/pen-performance.json` | `canvink-performance-recorder` | The diagnostics export is copied unchanged from `canvink-pen-performance-YYYY-MM-DD.json`. It contains the exact repository/package binding, an exact 45-minute measured window, and at least 20 raw content-free pen-preview timing samples. To remain bounded and time-distributed during dense ink, the recorder retains the first real preview measurement in each active one-second bucket; the validator recomputes `p95Ms` from those samples and requires it below the exact `thresholdMs` of 20. It rejects missing/changed samples, aggregate mismatches, shorter windows, stale evidence, and non-commit builds. |
| Pen session: `test-results/personal-acceptance/pen-session-45m.json` | `canvink-pen-session-drill` | `durationMinutes` exactly 45 and `completedWithoutDataLoss: true`. |
| PDF: `test-results/personal-acceptance/personal-pdf.json` | `canvink-personal-pdf-drill` | Positive `filesTested` and `pageCount`; integrity, asset reload, CRDT reload, and export booleans true. |
| OneNote: `test-results/personal-acceptance/personal-onenote.json` | `canvink-personal-onenote-drill` | Positive `pagesTested`, `delegatedScope: "Notes.Read"`, additive import, rollback, and no-write-permission booleans true. |
| OCR: `test-results/personal-acceptance/personal-ocr.json` | `canvink-personal-ocr-drill` | Positive sample and installed-language counts; local-only, rotation, and bounds booleans true. |
| Collaboration: `test-results/personal-acceptance/collaboration-2-account.json` | `canvink-live-collaboration-drill` | At least 2 accounts, positive session minutes; encrypted transport, offline catch-up, roles, and revocation booleans true. |
| DPAPI: `test-results/personal-acceptance/dpapi-restart.json` | `canvink-dpapi-restart-drill` | Positive restart count; protected reopen and wrong-identity-denied booleans true. |
| Backup: `test-results/personal-acceptance/encrypted-backup-restore.json` | `canvink-schema-v2-restore-drill` | Bundle format 2, positive asset count, at least 2 CRDT documents; integrity, reload, and guarded rollback booleans true. |
| Signing: `test-results/personal-acceptance/trusted-signed-artifact.json` | `windows-authenticode-verifier` | At least 2 artifacts and exact statuses `Valid`, `Valid`, and `Trusted`. |
| Soak: `test-results/sync-soak-automerge-simulation-60m.json` | `canvink-sync-soak-runner` | Exactly 60 requested minutes, at least 3,600,000 ms elapsed, exactly 20 clients, positive changes, non-negative retries, and convergence true. |

The exact `kind` values follow the gate names: `personal-acceptance-checklist`, `pen-performance`, `pen-session`, `personal-pdf`, `personal-onenote`, `personal-ocr`, `collaboration`, `dpapi-restart`, `encrypted-backup-restore`, `trusted-signed-artifact`, and `sync-soak`.

Evidence contains only timestamps, aggregate measurements, pass/fail outcomes, stable build identifiers, and verification-tool status. Never include screenshots of notes, OCR text, document excerpts, account identifiers, URLs containing tenant/project identifiers, tokens, certificate identities, recovery codes, or local absolute paths. The script validates schema and values but does not manufacture personal-device evidence; the checklist remains an explicit owner attestation tied to separately validated artifacts. A generic or manual-only producer label is rejected.

The performance diagnostics export stays disabled until real pen-preview timestamps span the complete 45-minute window, the window contains at least 20 samples, the measured p95 is below 20 ms, and the build carries an exact 40-hex commit. It does not synthesize samples or operator outcomes. The separate `pen-session-45m.json` remains the owner's data-loss/endurance attestation; the UI timing export does not manufacture that claim.

Generate the deterministic soak artifact separately with `node scripts/run-sync-soak.mjs automerge-simulation 60`. A generated soak is not evidence of two real accounts or a live Appwrite service.

## Current-machine interpretation

A blocker report is the expected honest result until all gates are performed. In particular, `pen-digitizer-unavailable`, `trusted-code-signing-certificate-unavailable`, `environment-missing:*`, `appwrite-project-not-configured`, and `evidence-missing:*` must remain visible rather than being overridden. OCR languages or a OneNote executable being present proves only availability, not personal acceptance.
