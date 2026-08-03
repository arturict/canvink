import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";

const EXIT_USAGE = 2;
const EXIT_GATE_FAILED = 3;

function usage() {
  console.log(`Usage: pnpm self-host:preflight -- [--docker=auto|required|skip]

Runs the web quality/build gate, Playwright E2E, static self-host artifact check,
and the optional Docker smoke. It does not deploy or modify Git history.`);
}

function failUsage(message) {
  console.error(`Self-host preflight configuration failed: ${message}`);
  usage();
  process.exit(EXIT_USAGE);
}

function parseArguments(argv) {
  let docker = "auto";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    if (argument.startsWith("--docker=")) {
      docker = argument.slice("--docker=".length);
      continue;
    }
    if (argument === "--docker") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        failUsage("--docker requires a value");
      }
      docker = value;
      index += 1;
      continue;
    }
    failUsage(`unknown argument: ${argument}`);
  }
  if (!["auto", "required", "skip"].includes(docker)) {
    failUsage("--docker must be one of: auto, required, skip");
  }
  return { docker };
}

function pnpmInvocation(arguments_) {
  const entrypoint = process.env.npm_execpath;
  if (!entrypoint || !isAbsolute(entrypoint) || !existsSync(entrypoint)) {
    console.error(
      "[self-host] FAIL pnpm lifecycle entrypoint is unavailable; run this command with pnpm",
    );
    process.exit(EXIT_GATE_FAILED);
  }
  return { command: process.execPath, arguments: [entrypoint, ...arguments_] };
}

function sourceProvenance() {
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (head.error || status.error || head.status !== 0 || status.status !== 0) {
    return { commit: "local-dirty", display: "local-dirty" };
  }

  const sha = head.stdout.trim();
  const dirty = status.stdout.trim().length > 0;
  return {
    commit: dirty ? `${sha}-dirty` : sha,
    display: `${sha.slice(0, 12)}${dirty ? "-dirty" : ""}`,
  };
}

async function availablePlaywrightPort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  if (!address || typeof address === "string") {
    console.error("[self-host] FAIL could not reserve a Playwright port");
    process.exit(EXIT_GATE_FAILED);
  }
  return String(address.port);
}

function runStep(label, arguments_, options = {}) {
  console.log(`\n[self-host] START ${label}`);
  const startedAt = Date.now();
  const invocation = pnpmInvocation(arguments_);
  const result = spawnSync(invocation.command, invocation.arguments, {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    console.error(`[self-host] FAIL ${label}: ${result.error.message}`);
    process.exit(options.failureCode ?? EXIT_GATE_FAILED);
  }
  if (result.status !== 0) {
    console.error(`[self-host] FAIL ${label}: exit ${result.status ?? "unknown"}`);
    process.exit(
      options.preserveExitCode
        ? result.status || (options.failureCode ?? EXIT_GATE_FAILED)
        : (options.failureCode ?? EXIT_GATE_FAILED),
    );
  }

  const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
  console.log(`[self-host] PASS ${label} (${seconds}s)`);
}

const { docker } = parseArguments(process.argv.slice(2));
const provenance = sourceProvenance();

console.log("Canvink self-host preflight");
console.log(`Docker policy: ${docker}`);
console.log(`Source provenance: ${provenance.display}`);
console.log("This command does not deploy, publish, tag, commit, or push.");

runStep("project checks and production build", ["check"], {
  env: { GITHUB_SHA: provenance.commit, VERCEL_GIT_COMMIT_SHA: "" },
});
const playwrightPort = await availablePlaywrightPort();
runStep("Playwright end-to-end tests", ["test:e2e"], {
  env: { PLAYWRIGHT_PREBUILT: "true", PLAYWRIGHT_PORT: playwrightPort },
});
runStep("static self-host artifact", ["self-host:check"]);
runStep(
  "self-host container",
  ["self-host:docker-smoke", "--mode", docker],
  { preserveExitCode: true },
);

console.log("\n[self-host] PASS all requested self-host gates");
