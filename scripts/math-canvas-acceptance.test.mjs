import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { powershell, powershellTest } from "./powershell.mjs";

const repositoryRoot = process.cwd();
const scriptPath = path.join(repositoryRoot, "scripts", "math-canvas-acceptance.ps1");
const binding = {
  repositoryCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  packageVersion: "0.2.0",
};
const files = {
  recognitionCorpus: "recognition-corpus.json",
  gpuLatency: "gpu-latency.json",
  privacy: "privacy.json",
  personalWorkflows: "personal-workflows.json",
};
const metadata = {
  recognitionCorpus: ["math-recognition-corpus", "canvink-math-recognition-benchmark-v1"],
  gpuLatency: ["math-gpu-latency", "canvink-math-gpu-benchmark-v1"],
  privacy: ["math-privacy", "canvink-math-privacy-verifier-v1"],
  personalWorkflows: ["math-personal-workflows", "canvink-math-personal-workflow-drill-v1"],
};

function envelope(name, results, overrides = {}) {
  const [kind, producer] = metadata[name];
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

function validArtifacts() {
  return {
    recognitionCorpus: envelope("recognitionCorpus", {
      corpusSha256: "a".repeat(64),
      licenseManifestSha256: "b".repeat(64),
      sampleCount: 300,
      writerCount: 5,
      basicCorrect: 90,
      basicTotal: 100,
      totalCorrect: 240,
      totalCount: 300,
      basicAccuracyPercent: 90,
      overallAccuracyPercent: 80,
      provenanceReviewed: true,
      selfCreatedOrExplicitlyLicensed: true,
      restrictedResearchDatasetUsed: false,
    }),
    gpuLatency: envelope("gpuLatency", {
      modelArtifactSha256: "c".repeat(64),
      apiVersion: "v1-test",
      measurements: [
        { gpuClass: "RTX-2070", sampleCount: 30, medianMs: 1500, p95Ms: 3000 },
        { gpuClass: "RTX-5060", sampleCount: 30, medianMs: 1000, p95Ms: 2000 },
      ],
      privateServiceOnly: true,
      rawContentIncluded: false,
    }),
    privacy: envelope("privacy", {
      normalStrokeRequestCount: 0,
      explicitMathBlockRequestCount: 8,
      wholePageRequestCount: 0,
      adjacentContentRequestCount: 0,
      unexpectedRequestFieldCount: 0,
      keyLeakCount: 0,
      providerConfigLeakCount: 0,
      workspaceSecretLeakCount: 0,
      exportSecretLeakCount: 0,
      logContentLeakCount: 0,
      telemetryContentLeakCount: 0,
      selectedBlockOnly: true,
      localRawMathPersistenceVerified: true,
      networkCaptureReviewed: true,
    }),
    personalWorkflows: envelope("personalWorkflows", {
      workflowsTested: 4,
      mathematics: true,
      physics: true,
      pdfWorksheet: true,
      budget: true,
      offline: true,
      exportRoundTrip: true,
      providerFailurePendingState: true,
      completedWithoutDataLoss: true,
    }),
  };
}

function createSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "canvink-math-acceptance-"));
  const evidenceRoot = path.join(root, "evidence");
  mkdirSync(evidenceRoot);
  return { root, evidenceRoot, reportPath: path.join(root, "report.json") };
}

function writeArtifacts(evidenceRoot, artifacts) {
  for (const [name, artifact] of Object.entries(artifacts)) {
    writeFileSync(path.join(evidenceRoot, files[name]), JSON.stringify(artifact), "utf8");
  }
}

function runAcceptance(sandbox, policy = {}) {
  return spawnSync(powershell ?? "powershell", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-EvidenceRoot", sandbox.evidenceRoot,
    "-OutputPath", sandbox.reportPath,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CANVINK_MATH_ACCEPTANCE_POLICY_TEST_MODE: "1",
      CANVINK_MATH_ACCEPTANCE_TEST_REPOSITORY_COMMIT: binding.repositoryCommit,
      CANVINK_MATH_ACCEPTANCE_TEST_PACKAGE_VERSION: policy.packageVersion ?? binding.packageVersion,
      CANVINK_MATH_ACCEPTANCE_TEST_WORKTREE_STATE: policy.worktreeState ?? "clean",
    },
  });
}

function withSandbox(callback) {
  const sandbox = createSandbox();
  try { return callback(sandbox); } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
}

function reportFor(sandbox) {
  return JSON.parse(readFileSync(sandbox.reportPath, "utf8"));
}

powershellTest("accepts only a complete commit- and package-bound evidence set", () => withSandbox((sandbox) => {
  writeArtifacts(sandbox.evidenceRoot, validArtifacts());
  const result = runAcceptance(sandbox);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = reportFor(sandbox);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.blockers, []);
  assert.equal(report.repositoryCommit, binding.repositoryCommit);
  assert.equal(report.packageVersion, binding.packageVersion);
  assert.equal(report.contentFree, true);
  assert.equal(JSON.stringify(report).includes(sandbox.root), false);
}));

powershellTest("accepts a 0.2.0 beta prerelease binding", () => withSandbox((sandbox) => {
  const artifacts = validArtifacts();
  for (const artifact of Object.values(artifacts)) artifact.packageVersion = "0.2.0-beta.3";
  writeArtifacts(sandbox.evidenceRoot, artifacts);
  const result = runAcceptance(sandbox, { packageVersion: "0.2.0-beta.3" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}));

powershellTest("fails policy before evidence validation for dirty or untracked worktrees", () => withSandbox((sandbox) => {
  writeArtifacts(sandbox.evidenceRoot, validArtifacts());
  const result = runAcceptance(sandbox, { worktreeState: "dirty" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /clean worktree/);
  assert.equal(existsSync(sandbox.reportPath), false);
}));

powershellTest("rejects the 0.1 package line", () => withSandbox((sandbox) => {
  const result = runAcceptance(sandbox, { packageVersion: "0.1.0" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /0\.2\.0/);
  assert.equal(existsSync(sandbox.reportPath), false);
}));

powershellTest("missing evidence blocks without manufacturing an artifact", () => withSandbox((sandbox) => {
  const missingRoot = path.join(sandbox.root, "missing-evidence");
  sandbox.evidenceRoot = missingRoot;
  const result = runAcceptance(sandbox);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(existsSync(missingRoot), false);
  const report = reportFor(sandbox);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers, [
    "recognitionCorpus:missing", "gpuLatency:missing", "privacy:missing", "personalWorkflows:missing",
  ]);
}));

powershellTest("malformed JSON fails closed", () => withSandbox((sandbox) => {
  const artifacts = validArtifacts();
  writeArtifacts(sandbox.evidenceRoot, artifacts);
  writeFileSync(path.join(sandbox.evidenceRoot, files.recognitionCorpus), "{not-json", "utf8");
  const result = runAcceptance(sandbox);
  assert.equal(result.status, 2);
  assert.equal(reportFor(sandbox).evidence.recognitionCorpus.validation, "malformed");
}));

powershellTest("stale evidence fails closed", () => withSandbox((sandbox) => {
  const artifacts = validArtifacts();
  artifacts.gpuLatency.recordedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  writeArtifacts(sandbox.evidenceRoot, artifacts);
  const result = runAcceptance(sandbox);
  assert.equal(result.status, 2);
  assert.equal(reportFor(sandbox).evidence.gpuLatency.validation, "stale");
}));

powershellTest("content-bearing fields are rejected even when nested", () => withSandbox((sandbox) => {
  const artifacts = validArtifacts();
  artifacts.privacy.results.rawStrokes = [{ x: 1, y: 2 }];
  writeArtifacts(sandbox.evidenceRoot, artifacts);
  const result = runAcceptance(sandbox);
  assert.equal(result.status, 2);
  assert.equal(reportFor(sandbox).evidence.privacy.validation, "content-bearing");
}));

powershellTest("wrong commit binding and unknown fields fail closed", () => withSandbox((sandbox) => {
  const artifacts = validArtifacts();
  artifacts.recognitionCorpus.repositoryCommit = "0".repeat(40);
  artifacts.personalWorkflows.unexpected = true;
  writeArtifacts(sandbox.evidenceRoot, artifacts);
  const result = runAcceptance(sandbox);
  assert.equal(result.status, 2);
  const report = reportFor(sandbox);
  assert.equal(report.evidence.recognitionCorpus.validation, "binding");
  assert.equal(report.evidence.personalWorkflows.validation, "shape");
}));

const thresholdCases = [
  ["corpus sample minimum", (a) => { a.recognitionCorpus.results.sampleCount = 299; }],
  ["corpus aggregate count binding", (a) => { a.recognitionCorpus.results.totalCount = 299; }],
  ["writer minimum", (a) => { a.recognitionCorpus.results.writerCount = 4; }],
  ["basic accuracy", (a) => {
    a.recognitionCorpus.results.basicCorrect = 89;
    a.recognitionCorpus.results.basicAccuracyPercent = 89;
    a.recognitionCorpus.results.totalCorrect = 239;
    a.recognitionCorpus.results.overallAccuracyPercent = 79.6666667;
  }],
  ["overall accuracy", (a) => {
    a.recognitionCorpus.results.totalCorrect = 239;
    a.recognitionCorpus.results.overallAccuracyPercent = 79.6666667;
  }],
  ["GPU median", (a) => { a.gpuLatency.results.measurements[0].medianMs = 1500.1; }],
  ["GPU p95", (a) => { a.gpuLatency.results.measurements[0].p95Ms = 3000.1; }],
  ["GPU inventory", (a) => { a.gpuLatency.results.measurements[1].gpuClass = "RTX-4070"; }],
];

for (const [name, mutate] of thresholdCases) {
  powershellTest(`threshold violation: ${name}`, () => withSandbox((sandbox) => {
    const artifacts = validArtifacts();
    mutate(artifacts);
    writeArtifacts(sandbox.evidenceRoot, artifacts);
    const result = runAcceptance(sandbox);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const validations = Object.values(reportFor(sandbox).evidence).map((entry) => entry.validation);
    assert.equal(validations.includes("threshold"), true);
  }));
}

powershellTest("unreviewed or restricted corpus provenance is rejected", () => withSandbox((sandbox) => {
  const artifacts = validArtifacts();
  artifacts.recognitionCorpus.results.provenanceReviewed = false;
  artifacts.recognitionCorpus.results.restrictedResearchDatasetUsed = true;
  writeArtifacts(sandbox.evidenceRoot, artifacts);
  const result = runAcceptance(sandbox);
  assert.equal(result.status, 2);
  assert.equal(reportFor(sandbox).evidence.recognitionCorpus.validation, "provenance");
}));

powershellTest("nonzero privacy counters are rejected", () => withSandbox((sandbox) => {
  const artifacts = validArtifacts();
  artifacts.privacy.results.adjacentContentRequestCount = 1;
  writeArtifacts(sandbox.evidenceRoot, artifacts);
  const result = runAcceptance(sandbox);
  assert.equal(result.status, 2);
  assert.equal(reportFor(sandbox).evidence.privacy.validation, "privacy");
}));

powershellTest("an incomplete personal workflow is rejected", () => withSandbox((sandbox) => {
  const artifacts = validArtifacts();
  artifacts.personalWorkflows.results.pdfWorksheet = false;
  writeArtifacts(sandbox.evidenceRoot, artifacts);
  const result = runAcceptance(sandbox);
  assert.equal(result.status, 2);
  assert.equal(reportFor(sandbox).evidence.personalWorkflows.validation, "workflow");
}));

powershellTest("EvidenceRoot override is unavailable outside explicit policy tests", () => withSandbox((sandbox) => {
  const result = spawnSync(powershell ?? "powershell", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-EvidenceRoot", sandbox.evidenceRoot,
    "-OutputPath", sandbox.reportPath,
  ], { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, CANVINK_MATH_ACCEPTANCE_POLICY_TEST_MODE: "0" } });
  assert.equal(result.status, 3);
  assert.equal(existsSync(sandbox.reportPath), false);
}));
