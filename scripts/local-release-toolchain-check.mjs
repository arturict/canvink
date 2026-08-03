import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const EXIT_TOOLCHAIN_INVALID = 3;
const expectedCargoTools = {
  "cargo-audit": "0.22.2",
  "cargo-deny": "0.20.2",
};

function fail(message) {
  console.error(`Release toolchain check failed: ${message}`);
  process.exit(EXIT_TOOLCHAIN_INVALID);
}

function command(commandName, arguments_) {
  const result = spawnSync(commandName, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail(`${commandName} is missing or could not report its version`);
  }
  return result.stdout.trim();
}

const nodeVersionPath = resolve(".node-version");
const packagePath = resolve("package.json");
const rustToolchainPath = resolve("rust-toolchain.toml");
if (!existsSync(nodeVersionPath) || !existsSync(packagePath) || !existsSync(rustToolchainPath)) {
  fail(".node-version, package.json, or rust-toolchain.toml is missing");
}

const expectedNode = readFileSync(nodeVersionPath, "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(expectedNode)) {
  fail(".node-version must contain an exact semantic version");
}
if (process.versions.node !== expectedNode) {
  fail(`Node ${process.versions.node} does not match required ${expectedNode}`);
}

const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const packageManager = /^(pnpm)@(\d+\.\d+\.\d+)$/.exec(
  packageJson.packageManager ?? "",
);
if (!packageManager) {
  fail("package.json must pin pnpm to an exact version");
}

const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint || !isAbsolute(pnpmEntrypoint) || !existsSync(pnpmEntrypoint)) {
  fail("pnpm lifecycle entrypoint is unavailable; run this command with pnpm");
}
const actualPnpm = command(process.execPath, [pnpmEntrypoint, "--version"]);
if (actualPnpm !== packageManager[2]) {
  fail(`pnpm ${actualPnpm || "unknown"} does not match required ${packageManager[2]}`);
}

const rustToolchain = readFileSync(rustToolchainPath, "utf8");
const expectedRust = /^\s*channel\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m.exec(
  rustToolchain,
)?.[1];
if (!expectedRust) {
  fail("rust-toolchain.toml must pin an exact stable channel");
}
const actualRust = /^rustc (\d+\.\d+\.\d+)(?:\s|$)/.exec(
  command("rustc", ["--version"]),
)?.[1];
if (actualRust !== expectedRust) {
  fail(`rustc ${actualRust ?? "unknown"} does not match required ${expectedRust}`);
}

for (const [tool, expectedVersion] of Object.entries(expectedCargoTools)) {
  const cargoSubcommand = tool.slice("cargo-".length);
  const output = command("cargo", [cargoSubcommand, "--version"]);
  const version = new RegExp(`^${tool} (\\d+\\.\\d+\\.\\d+)(?:\\s|$)`).exec(output)?.[1];
  if (version !== expectedVersion) {
    fail(`${tool} ${version ?? "unknown"} does not match required ${expectedVersion}`);
  }
}

console.log(
  `Release toolchain verified: Node ${expectedNode}, pnpm ${packageManager[2]}, rustc ${expectedRust}, cargo-audit ${expectedCargoTools["cargo-audit"]}, cargo-deny ${expectedCargoTools["cargo-deny"]}`,
);
