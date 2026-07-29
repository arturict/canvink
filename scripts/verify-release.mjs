import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { extractReleaseNotes } from "./extract-release-notes.mjs";

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const result = {
    tag: "",
    sha: "",
    mainMode: "none",
    unsigned: false,
    githubOutput: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--unsigned") {
      result.unsigned = true;
      continue;
    }
    if (argument === "--github-output") {
      result.githubOutput = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${argument}`);
    }

    if (argument === "--tag") {
      result.tag = value;
    } else if (argument === "--sha") {
      result.sha = value;
    } else if (argument === "--main-mode") {
      result.mainMode = value;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
    index += 1;
  }

  if (!["none", "exact", "ancestor"].includes(result.mainMode)) {
    fail("--main-mode must be one of: none, exact, ancestor");
  }
  return result;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Cannot parse ${path}: ${error.message}`);
  }
}

function readCargoPackageVersion(path) {
  const contents = readFileSync(path, "utf8");
  const packageHeader = /^[ \t]*\[package\][ \t]*(?:#.*)?$/m.exec(contents);
  if (!packageHeader) {
    fail(`${path} does not contain a [package] table`);
  }

  const afterHeader = contents.slice(packageHeader.index + packageHeader[0].length);
  const nextHeader = /^[ \t]*\[[^\]\r\n]+\][ \t]*(?:#.*)?$/m.exec(afterHeader);
  const packageTable = afterHeader.slice(0, nextHeader?.index ?? afterHeader.length);
  const versionMatch = packageTable.match(
    /^[ \t]*version[ \t]*=[ \t]*["']([^"']+)["'][ \t]*(?:#.*)?$/m,
  );
  if (!versionMatch) {
    fail(`${path} does not contain package.version`);
  }
  return versionMatch[1];
}

function readCargoLockPackageVersion(path, packageName) {
  const contents = readFileSync(path, "utf8");
  const packages = contents.split(/^\[\[package\]\]\s*$/m);
  for (const packageTable of packages) {
    const name = packageTable.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
    if (name !== packageName) continue;
    const version = packageTable.match(
      /^\s*version\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m,
    )?.[1];
    if (!version) fail(`${path} does not contain a version for ${packageName}`);
    if (!packageTable.includes("x-release-please-version")) {
      fail(`${path} is missing the release-please version marker for ${packageName}`);
    }
    return version;
  }
  fail(`${path} does not contain package ${packageName}`);
}

function git(...arguments_) {
  return execFileSync("git", arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitSucceeds(...arguments_) {
  try {
    execFileSync("git", arguments_, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function assertCleanTrackedFiles() {
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty) {
    fail(`Tracked files are not clean:\n${dirty}`);
  }
}

function assertMainRelationship(head, mode) {
  if (mode === "none") {
    return;
  }

  const main = git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
  if (mode === "exact" && head !== main) {
    fail(`Release commit ${head} is not the current origin/main commit ${main}`);
  }
  if (
    mode === "ancestor" &&
    !gitSucceeds("merge-base", "--is-ancestor", head, main)
  ) {
    fail(`Release commit ${head} is not reachable from origin/main`);
  }
}

function assertUnsignedTauriConfiguration(config) {
  const updaterConfigured =
    config.plugins?.updater !== undefined ||
    config.bundle?.createUpdaterArtifacts === true;
  if (updaterConfigured) {
    fail(
      "Unsigned releases cannot enable the Tauri updater or updater artifacts",
    );
  }
}

function writeGithubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    fail("GITHUB_OUTPUT is not set");
  }
  for (const [key, value] of Object.entries(outputs)) {
    if (/[\r\n]/.test(value)) {
      fail(`Unsafe multiline GitHub output for ${key}`);
    }
    appendFileSync(outputPath, `${key}=${value}\n`, "utf8");
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = process.cwd();
  const packagePath = resolve(root, "package.json");
  const cargoPath = resolve(root, "src-tauri", "Cargo.toml");
  const tauriPath = resolve(root, "src-tauri", "tauri.conf.json");
  const cargoLockPath = resolve(root, "src-tauri", "Cargo.lock");
  const changelogPath = resolve(root, "CHANGELOG.md");
  const releaseManifestPath = resolve(root, ".release-please-manifest.json");

  for (const path of [
    packagePath,
    cargoPath,
    tauriPath,
    cargoLockPath,
    changelogPath,
    releaseManifestPath,
  ]) {
    if (!existsSync(path)) {
      fail(`Required release file is missing: ${path}`);
    }
  }

  const packageJson = readJson(packagePath);
  const tauriConfig = readJson(tauriPath);
  const versions = {
    package: packageJson.version,
    cargo: readCargoPackageVersion(cargoPath),
    cargoLock: readCargoLockPackageVersion(cargoLockPath, "canvink"),
    tauri: tauriConfig.version,
  };

  for (const [source, version] of Object.entries(versions)) {
    if (typeof version !== "string" || !semverPattern.test(version)) {
      fail(`${source} has an invalid semantic version: ${String(version)}`);
    }
  }

  const uniqueVersions = new Set(Object.values(versions));
  if (uniqueVersions.size !== 1) {
    fail(`Release versions disagree: ${JSON.stringify(versions)}`);
  }

  const version = versions.package;
  const releaseManifest = readJson(releaseManifestPath);
  if (
    releaseManifest === null ||
    typeof releaseManifest !== "object" ||
    Array.isArray(releaseManifest) ||
    Object.keys(releaseManifest).length !== 1 ||
    releaseManifest["."] !== version
  ) {
    fail(
      `.release-please-manifest.json must contain only the root version ${version}`,
    );
  }
  extractReleaseNotes(readFileSync(changelogPath, "utf8"), version);
  const tag = options.tag || `v${version}`;
  if (!/^v[0-9A-Za-z.+-]+$/.test(tag) || tag !== `v${version}`) {
    fail(`Release tag ${tag} must exactly match v${version}`);
  }

  if (packageJson.private !== true) {
    fail("package.json must remain private because Canvink is not published to npm");
  }
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageJson.packageManager ?? "")) {
    fail("package.json must pin an exact pnpm packageManager version");
  }

  if (options.unsigned) {
    assertUnsignedTauriConfiguration(tauriConfig);
  }

  assertCleanTrackedFiles();
  const head = git("rev-parse", "HEAD");
  if (options.sha && options.sha !== head) {
    fail(`Checked out commit ${head} does not match expected commit ${options.sha}`);
  }
  assertMainRelationship(head, options.mainMode);

  const tagRef = `refs/tags/${tag}^{commit}`;
  if (gitSucceeds("rev-parse", "--verify", tagRef)) {
    const taggedCommit = git("rev-parse", "--verify", tagRef);
    if (taggedCommit !== head) {
      fail(`Existing tag ${tag} points to ${taggedCommit}, not ${head}`);
    }
  }

  const outputs = { tag, version, sha: head, signing: "unsigned" };
  if (options.githubOutput) {
    writeGithubOutputs(outputs);
  }

  console.log(
    `Release verified: ${tag} at ${head} (${options.unsigned ? "unsigned, updater disabled" : "signing not checked"})`,
  );
}

try {
  main();
} catch (error) {
  console.error(`Release verification failed: ${error.message}`);
  process.exitCode = 1;
}
