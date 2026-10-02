import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { powershell, powershellTest } from "./powershell.mjs";

const signingEnvironmentKeys = [
  "CANVINK_WINDOWS_SIGNED",
  "CANVINK_WINDOWS_SIGN_PROVIDER",
  "CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT",
  "CANVINK_WINDOWS_TIMESTAMP_URL",
  "CANVINK_SIGNTOOL_PATH",
];

function cleanSigningEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of signingEnvironmentKeys) delete environment[key];
  return { ...environment, ...overrides };
}

function runPreflight(environment = {}) {
  return spawnSync(
    powershell ?? "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/windows-signing.ps1",
      "-Mode",
      "Preflight",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: cleanSigningEnvironment(environment),
      windowsHide: true,
    },
  );
}

test("the normal Tauri configuration remains unsigned", () => {
  const base = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const signing = JSON.parse(readFileSync("src-tauri/tauri.signing.conf.json", "utf8"));
  assert.equal(base.bundle?.windows?.signCommand, undefined);
  assert.match(signing.bundle.windows.signCommand, /windows-signing\.ps1.+-Mode Sign.+%1/);
});

powershellTest("signed preflight fails closed when signed mode was not explicitly requested", () => {
  const result = runPreflight();
  assert.equal(result.status, 3);
  assert.match(result.stderr, /signed mode was not explicitly requested/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /certificate password|private key material/i);
});

powershellTest("signed preflight rejects incomplete provider configuration without printing secrets", () => {
  const canary = "CANVINK-SECRET-CANARY-DO-NOT-PRINT";
  const result = runPreflight({
    CANVINK_WINDOWS_SIGNED: "1",
    CANVINK_WINDOWS_SIGN_PROVIDER: "windows-store",
    WINDOWS_SIGNING_PFX_PASSWORD: canary,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /thumbprint is required/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(canary));
});

powershellTest("signed preflight rejects malformed thumbprints before certificate discovery", () => {
  const result = runPreflight({
    CANVINK_WINDOWS_SIGNED: "1",
    CANVINK_WINDOWS_SIGN_PROVIDER: "windows-store",
    CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT: "not-a-thumbprint",
    CANVINK_WINDOWS_TIMESTAMP_URL: "https://timestamp.invalid",
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /40 hexadecimal characters/i);
});

powershellTest("signed preflight requires an HTTPS RFC 3161 timestamp endpoint", () => {
  const result = runPreflight({
    CANVINK_WINDOWS_SIGNED: "1",
    CANVINK_WINDOWS_SIGN_PROVIDER: "windows-store",
    CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
    CANVINK_WINDOWS_TIMESTAMP_URL: "http://timestamp.invalid",
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /absolute HTTPS URL/i);
});

powershellTest("signed preflight blocks when the requested certificate is missing", () => {
  const result = runPreflight({
    CANVINK_WINDOWS_SIGNED: "1",
    CANVINK_WINDOWS_SIGN_PROVIDER: "windows-store",
    CANVINK_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
    CANVINK_WINDOWS_TIMESTAMP_URL: "https://timestamp.invalid",
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /exactly one matching certificate is required/i);
});

test("the signing policy checks certificate validity, EKU, timestamp, and nested binaries", () => {
  const script = readFileSync("scripts/windows-signing.ps1", "utf8");
  assert.match(script, /NotBefore[\s\S]+not valid yet/i);
  assert.match(script, /NotAfter[\s\S]+expired/i);
  assert.match(script, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(script, /TimeStamperCertificate[\s\S]+timestamp is missing/i);
  assert.match(script, /Status -ne 'Valid'/);
  assert.match(script, /ApplicationExecutable = 'src-tauri\/target\/release\/Canvink\.exe'/);
});

test("the release workflow defaults to unsigned and requires explicit signed mode", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(workflow, /sign_windows:\s+[\s\S]*?default: false[\s\S]*?type: boolean/);
  assert.match(workflow, /Build unsigned Windows bundles\s+if: \$\{\{ !inputs\.sign_windows \}\}/);
  assert.match(workflow, /Build Authenticode-signed Windows bundles[\s\S]*?if: \$\{\{ inputs\.sign_windows \}\}[\s\S]*?tauri\.signing\.conf\.json/);
  assert.match(workflow, /Verify signed executable and installer artifacts[\s\S]*?release:verify:signed/);
  assert.match(workflow, /Require-PackagedSignature -Executable \$nsisAppPath/);
  assert.match(workflow, /Require-PackagedSignature -Executable \$msiAppPath/);
});
