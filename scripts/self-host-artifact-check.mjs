import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const EXIT_USAGE = 2;
const EXIT_VALIDATION_FAILED = 3;
const target = process.argv[2];

function fail(message, exitCode = EXIT_VALIDATION_FAILED) {
  console.error(`Self-host artifact check failed: ${message}`);
  process.exit(exitCode);
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      fail(`symbolic links are not allowed in dist: ${relative(directory, path)}`);
    }
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

if (!target) {
  fail("Usage: node scripts/self-host-artifact-check.mjs <dist-directory>", EXIT_USAGE);
}

const root = resolve(target);
if (!existsSync(root) || !statSync(root).isDirectory()) {
  fail(`${root} is not a directory`);
}

for (const configuration of ["Dockerfile", "compose.yaml"]) {
  const path = resolve(configuration);
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`required self-host configuration is missing: ${configuration}`);
  }
}

for (const artifact of ["sw.js", "manifest.webmanifest", "canvink-mark.svg"]) {
  const path = join(root, artifact);
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    fail(`required PWA artifact is missing or empty: dist/${artifact}`);
  }
}

const smoke = spawnSync(
  process.execPath,
  [resolve("scripts", "smoke-site.mjs"), root],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (smoke.error) {
  fail(`could not run the existing site smoke: ${smoke.error.message}`);
}
if (smoke.status !== 0) {
  fail(`existing site smoke exited with ${smoke.status ?? "unknown"}`);
}

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const versionPath = join(root, "version.json");
if (!existsSync(versionPath)) {
  fail("dist/version.json is missing");
}

const version = JSON.parse(readFileSync(versionPath, "utf8"));
if (version.version !== packageJson.version) {
  fail(
    `dist version ${String(version.version)} does not match package version ${packageJson.version}`,
  );
}
if (
  typeof version.commit !== "string" ||
  version.commit.length === 0 ||
  version.commit.length > 128 ||
  /[\r\n]/.test(version.commit)
) {
  fail("dist/version.json contains an invalid commit identifier");
}

const forbiddenNames = [
  /(^|[\\/])\.env(?:\.|$)/i,
  /\.(?:key|p12|pfx|pem)$/i,
];
for (const file of listFiles(root)) {
  const relativePath = relative(root, file);
  if (forbiddenNames.some((pattern) => pattern.test(relativePath))) {
    fail(`sensitive file type found in dist: ${relativePath}`);
  }
  if (statSync(file).size === 0) {
    fail(`empty file found in dist: ${relativePath}`);
  }
}

console.log(`Self-host artifact passed: ${root}`);
