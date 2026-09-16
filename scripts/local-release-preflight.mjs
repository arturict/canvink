import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

const EXIT_USAGE = 2;
const EXIT_GATE_FAILED = 3;

function usage() {
  console.log(`Usage: pnpm release:preflight:local

Runs the complete self-host preflight plus Rust formatting, Clippy with warnings
denied, and all-feature locked tests. It does not deploy, publish, tag, commit,
or push. Docker is mandatory because a skipped container smoke is not release
evidence.`);
}

function failUsage(message) {
  console.error(`Local release preflight configuration failed: ${message}`);
  usage();
  process.exit(EXIT_USAGE);
}

function parseArguments(argv) {
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    failUsage(`unknown argument: ${argument}`);
  }
}

function pnpmInvocation(arguments_) {
  const entrypoint = process.env.npm_execpath;
  if (!entrypoint || !isAbsolute(entrypoint) || !existsSync(entrypoint)) {
    console.error(
      "[preflight] FAIL pnpm lifecycle entrypoint is unavailable; run this command with pnpm",
    );
    process.exit(EXIT_GATE_FAILED);
  }
  return { command: process.execPath, arguments: [entrypoint, ...arguments_] };
}

function git(arguments_) {
  return spawnSync("git", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function assertCleanWorktree() {
  const result = git(["status", "--porcelain", "--untracked-files=all"]);
  if (result.error || result.status !== 0) {
    console.error("[preflight] FAIL Git worktree status could not be verified");
    process.exit(EXIT_GATE_FAILED);
  }
  if (result.stdout.trim()) {
    console.error(
      "[preflight] FAIL release candidates require a clean Git worktree; file names are intentionally omitted",
    );
    process.exit(EXIT_GATE_FAILED);
  }
}

function runStep(label, arguments_, options = {}) {
  console.log(`\n[preflight] START ${label}`);
  const startedAt = Date.now();
  const invocation = pnpmInvocation(arguments_);
  const result = spawnSync(invocation.command, invocation.arguments, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    console.error(`[preflight] FAIL ${label}: ${result.error.message}`);
    process.exit(options.failureCode ?? EXIT_GATE_FAILED);
  }
  if (result.status !== 0) {
    console.error(`[preflight] FAIL ${label}: exit ${result.status ?? "unknown"}`);
    process.exit(
      options.preserveExitCode
        ? result.status || (options.failureCode ?? EXIT_GATE_FAILED)
        : (options.failureCode ?? EXIT_GATE_FAILED),
    );
  }

  const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
  console.log(`[preflight] PASS ${label} (${seconds}s)`);
}

parseArguments(process.argv.slice(2));
assertCleanWorktree();

console.log("Canvink complete local release preflight");
console.log("Docker policy: required");
console.log("This command does not deploy, publish, tag, commit, or push.");

runStep("pinned release toolchain", ["release:toolchain:check"]);
runStep(
  "complete self-host preflight",
  ["self-host:preflight", "--docker", "required"],
  { preserveExitCode: true },
);
runStep("Rust formatting, Clippy, and tests", ["rust:check"]);
runStep("generated third-party notices", ["notices:check"]);
runStep("production npm vulnerability audit", ["security:npm:audit"]);
runStep("Cargo advisory and dependency policy", ["security:cargo"]);

console.log("\n[preflight] PASS all requested local release gates");
