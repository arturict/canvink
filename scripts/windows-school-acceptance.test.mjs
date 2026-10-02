import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { powershell, powershellTest } from "./powershell.mjs";

const requiredKeys = [
  "VITE_MICROSOFT_CLIENT_ID", "VITE_MICROSOFT_REDIRECT_URI",
  "APPWRITE_FUNCTION_API_ENDPOINT", "APPWRITE_FUNCTION_PROJECT_ID", "CANVINK_ALLOWED_ORIGINS",
  "CANVINK_WINDOWS_SIGNED", "CANVINK_WINDOWS_SIGN_PROVIDER",
  "CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT", "CANVINK_WINDOWS_TIMESTAMP_URL",
];
const binding = {
  repositoryCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
};
const definitions = {
  checklist: ["checklist.json", "personal-acceptance-checklist", "canvink-windows-acceptance-checklist-v1"],
  penPerformance: ["pen-performance.json", "pen-performance", "canvink-performance-recorder"],
  penSession: ["pen-session-45m.json", "pen-session", "canvink-pen-session-drill"],
  personalPdf: ["personal-pdf.json", "personal-pdf", "canvink-personal-pdf-drill"],
  personalOneNote: ["personal-onenote.json", "personal-onenote", "canvink-personal-onenote-drill"],
  personalOcr: ["personal-ocr.json", "personal-ocr", "canvink-personal-ocr-drill"],
  collaboration: ["collaboration-2-account.json", "collaboration", "canvink-live-collaboration-drill"],
  dpapiRestart: ["dpapi-restart.json", "dpapi-restart", "canvink-dpapi-restart-drill"],
  encryptedBackupRestore: ["encrypted-backup-restore.json", "encrypted-backup-restore", "canvink-schema-v2-restore-drill"],
  trustedSignedArtifact: ["trusted-signed-artifact.json", "trusted-signed-artifact", "windows-authenticode-verifier"],
  syncSoak: ["sync-soak-automerge-simulation-60m.json", "sync-soak", "canvink-sync-soak-runner"],
};

function environment(overrides = {}) {
  const value = { ...process.env, CANVINK_ACCEPTANCE_POLICY_TEST_MODE: "1" };
  for (const key of requiredKeys) delete value[key];
  return { ...value, ...overrides };
}

function fixture(overrides = {}) {
  return {
    windows: { productName: "Windows test fixture", version: "10.0", build: "1" },
    pnpDevices: [],
    ocr: { runtimeAvailable: false, languageTags: [] },
    oneNote: { available: false, appx: false, win32: false },
    certificates: {
      personalStoreCertificateCount: 0, codeSigningCertificateCount: 0,
      validCodeSigningWithPrivateKeyCount: 0, locallyTrustedCodeSigningCount: 0,
      configuredCertificateMatchCount: 0, ready: false,
    },
    appwriteConfig: { filePresent: true, projectConfigured: false, endpointConfigured: false, resourceFilesPresent: true },
    ...overrides,
  };
}

function readyFixture() {
  return fixture({
    pnpDevices: [{ present: true, pnpClass: "HIDClass", hardwareIds: ["HID_DEVICE_UP:000D_U:0002"] }],
    ocr: { runtimeAvailable: true, languageTags: ["de-CH", "en-US"] },
    oneNote: { available: true, appx: true, win32: false },
    certificates: {
      personalStoreCertificateCount: 1, codeSigningCertificateCount: 1,
      validCodeSigningWithPrivateKeyCount: 1, locallyTrustedCodeSigningCount: 1,
      configuredCertificateMatchCount: 1, ready: true,
    },
    appwriteConfig: { filePresent: true, projectConfigured: true, endpointConfigured: true, resourceFilesPresent: true },
  });
}

function envelope(name, results, overrides = {}) {
  const [, kind, producer] = definitions[name];
  return {
    schemaVersion: 1,
    kind,
    contentFree: true,
    repositoryCommit: binding.repositoryCommit,
    packageVersion: binding.packageVersion,
    recordedAt: new Date().toISOString(),
    status: "passed",
    producer,
    results,
    ...overrides,
  };
}

function validPenPerformance(overrides = {}) {
  const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
  const samples = Array.from({ length: 19 }, (_, index) => ({
    durationMs: 11.9,
    recordedAt: new Date(startedAt + index * 1_000).toISOString(),
  }));
  samples.push({ durationMs: 11.9, recordedAt: "2026-08-03T12:45:00.000Z" });
  return {
    sampleCount: 20,
    p95Ms: 11.9,
    thresholdMs: 20,
    durationMinutes: 45,
    sessionStartedAt: "2026-08-03T12:00:00.000Z",
    sessionEndedAt: "2026-08-03T12:45:00.000Z",
    sessionObservedThrough: "2026-08-03T12:45:00.000Z",
    samples,
    ...overrides,
  };
}

function validArtifacts() {
  const results = {
    penPerformance: validPenPerformance(),
    penSession: { durationMinutes: 45, completedWithoutDataLoss: true },
    personalPdf: { filesTested: 2, pageCount: 8, integrityVerified: true, assetsReloaded: true, crdtReloaded: true, exportVerified: true },
    personalOneNote: { pagesTested: 3, delegatedScope: "Notes.Read", additiveImportVerified: true, rollbackVerified: true, noWritePermission: true },
    personalOcr: { samplesTested: 4, installedLanguageCount: 2, localOnlyVerified: true, rotationVerified: true, boundsVerified: true },
    collaboration: { accountCount: 2, sessionMinutes: 10, encryptedTransportVerified: true, offlineCatchupVerified: true, rolesVerified: true, revocationVerified: true },
    dpapiRestart: { restartCount: 1, protectedReopenVerified: true, wrongIdentityDenied: true },
    encryptedBackupRestore: { bundleFormatVersion: 2, assetCount: 1, crdtDocumentCount: 2, integrityVerified: true, reloadVerified: true, guardedRollbackVerified: true },
    trustedSignedArtifact: { artifactCount: 2, authenticodeStatus: "Valid", timestampStatus: "Valid", signerTrustStatus: "Trusted" },
    syncSoak: { requestedMinutes: 60, durationMs: 3_600_000, clients: 20, totalChanges: 200, totalRetries: 0, converged: true },
    checklist: {
      penSampleCount: 20, penP95Ms: 11.9, penSessionMinutes: 45,
      personalPdf: true, personalOneNote: true, personalOcr: true,
      collaborationAccountCount: 2, collaboration: true, dpapiRestart: true,
      encryptedBackupRestore: true, trustedSignedArtifact: true, syncSoak: true,
    },
  };
  return Object.fromEntries(Object.entries(results).map(([name, value]) => [name, envelope(name, value)]));
}

function run({ probe, artifacts = {}, env = environment(), mode = "Preflight" }) {
  const directory = mkdtempSync(path.join(tmpdir(), "canvink-acceptance-policy-"));
  const fixturePath = path.join(directory, "fixture.json");
  const outputPath = path.join(directory, "report.json");
  writeFileSync(fixturePath, JSON.stringify(probe), "utf8");
  for (const [name, artifact] of Object.entries(artifacts)) {
    const [fileName] = definitions[name];
    writeFileSync(path.join(directory, fileName), typeof artifact === "string" ? artifact : JSON.stringify(artifact), "utf8");
  }
  const result = spawnSync(powershell ?? "powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", "scripts/windows-school-acceptance.ps1",
    "-Mode", mode,
    "-ProbeFixturePath", fixturePath,
    "-EvidenceRoot", directory,
    "-OutputPath", outputPath,
  ], { cwd: process.cwd(), encoding: "utf8", env, windowsHide: true });
  let report;
  try { report = JSON.parse(readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "")); } catch { report = undefined; }
  rmSync(directory, { recursive: true, force: true });
  return { result, report };
}

const presentEnvironment = () => environment(Object.fromEntries(requiredKeys.map((name) => [name, "SECRET-CANARY-VALUE"])));

powershellTest("friendly-name pen substrings cannot satisfy the exact HID digitizer gate", () => {
  const canary = "CANVINK-PRIVATE-PEN-CANARY";
  const { result, report } = run({
    probe: fixture({ pnpDevices: [{
      present: true, pnpClass: "HIDClass", hardwareIds: ["HID\\VID_1234&PID_5678"],
      friendlyName: `${canary} Pen Digitizer Tablet`,
    }] }),
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(report.system.penDigitizer.present, false);
  assert.equal(report.acceptanceEvidence, false);
  assert.doesNotMatch(`${result.stdout}${result.stderr}${JSON.stringify(report)}`, new RegExp(canary));
});

powershellTest("complete schema-validated evidence is commit/version bound and passes every gate", () => {
  const canary = "SECRET-CANARY-VALUE";
  const { result, report } = run({ probe: readyFixture(), artifacts: validArtifacts(), env: presentEnvironment(), mode: "Checklist" });
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(report)}`);
  assert.equal(report.summary.status, "test-only");
  assert.equal(report.checklist.valid, true);
  assert.equal(report.checklist.sampleCount, 20);
  assert.equal(report.checklist.p95Ms, 11.9);
  assert.deepEqual(report.repositoryBinding, binding);
  assert.ok(Object.values(report.expectedEvidence).every((entry) => entry.valid && entry.validation === "validated"));
  assert.doesNotMatch(`${result.stdout}${result.stderr}${JSON.stringify(report)}`, new RegExp(canary));
});

powershellTest("empty, malformed, stale, mismatched, non-content-free, and manual-only artifacts fail closed", () => {
  const cases = [
    ["empty", "", "size"],
    ["malformed", "{not-json", "malformed"],
    ["stale", { recordedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }, "stale"],
    ["commit mismatch", { repositoryCommit: "0".repeat(40) }, "binding"],
    ["version mismatch", { packageVersion: "999.0.0" }, "binding"],
    ["not content free", { contentFree: false }, "status"],
    ["manual only", { producer: "manual" }, "manual-or-kind"],
  ];
  for (const [label, mutation, reason] of cases) {
    const artifacts = validArtifacts();
    artifacts.personalPdf = typeof mutation === "string" ? mutation : { ...artifacts.personalPdf, ...mutation };
    const { result, report } = run({ probe: readyFixture(), artifacts, env: presentEnvironment(), mode: "Checklist" });
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.equal(report.expectedEvidence.personalPdf.valid, false, label);
    assert.equal(report.expectedEvidence.personalPdf.validation, reason, label);
    assert.ok(report.summary.blockers.some((value) => value.startsWith("evidence-invalid:personalPdf") || value === "evidence-missing:personalPdf"), label);
  }
});

powershellTest("threshold, duration, signature, account, soak, and checklist cross-bindings are exact", () => {
  const cases = [
    ["penPerformance", { p95Ms: 20 }, "value"],
    ["penPerformance", { sampleCount: 19 }, "value"],
    ["penPerformance", { durationMinutes: 44 }, "value"],
    ["penPerformance", { p95Ms: 11.8 }, "value"],
    ["penSession", { durationMinutes: 44.99 }, "value"],
    ["trustedSignedArtifact", { timestampStatus: "Unknown" }, "value"],
    ["collaboration", { accountCount: 1 }, "value"],
    ["syncSoak", { requestedMinutes: 59 }, "value"],
    ["syncSoak", { durationMs: 3_599_999 }, "value"],
  ];
  for (const [name, mutation, reason] of cases) {
    const artifacts = validArtifacts();
    artifacts[name] = { ...artifacts[name], results: { ...artifacts[name].results, ...mutation } };
    const { result, report } = run({ probe: readyFixture(), artifacts, env: presentEnvironment(), mode: "Checklist" });
    assert.equal(result.status, 2, `${name}: ${result.stderr}`);
    assert.equal(report.expectedEvidence[name].validation, reason);
  }
  const artifacts = validArtifacts();
  artifacts.checklist.results.penSampleCount = 21;
  const { result, report } = run({ probe: readyFixture(), artifacts, env: presentEnvironment(), mode: "Checklist" });
  assert.equal(result.status, 2);
  assert.equal(report.expectedEvidence.checklist.validation, "dependency-mismatch");
});

powershellTest("content-bearing unknown fields are rejected without printing their values", () => {
  const canary = "PRIVATE-NOTE-NAME-MUST-NOT-PRINT";
  const artifacts = validArtifacts();
  artifacts.personalOneNote.results.notebookName = canary;
  const { result, report } = run({ probe: readyFixture(), artifacts, env: presentEnvironment(), mode: "Checklist" });
  assert.equal(result.status, 2);
  assert.equal(report.expectedEvidence.personalOneNote.validation, "shape");
  assert.doesNotMatch(`${result.stdout}${result.stderr}${JSON.stringify(report)}`, new RegExp(canary));
});

powershellTest("probe and evidence-root overrides are rejected outside explicit policy-test mode", () => {
  const { result } = run({ probe: fixture(), env: environment({ CANVINK_ACCEPTANCE_POLICY_TEST_MODE: "0" }) });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /no values were printed/i);
});

test("optional phases are narrowly limited to tests or the existing built executable", () => {
  const script = readFileSync("scripts/windows-school-acceptance.ps1", "utf8");
  assert.match(script, /ValidateSet\('Preflight', 'AutomatedTests', 'LaunchBuiltApp', 'Checklist', 'ValidatePenPerformance'\)/);
  assert.match(script, /& pnpm check/);
  assert.match(script, /src-tauri\\target\\release\\Canvink\.exe/);
  assert.doesNotMatch(script, /appwrite\s+(?:push|deploy)|az\s+login|Connect-AzAccount|New-SelfSignedCertificate/i);
});
