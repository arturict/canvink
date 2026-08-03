import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const EXIT_USAGE = 2;
const EXIT_DOCKER_UNAVAILABLE = 4;
const EXIT_SMOKE_FAILED = 5;

function usage() {
  console.log(`Usage: pnpm self-host:docker-smoke -- [--mode auto|required|skip]

auto      Run when Docker and its daemon are available, otherwise print SKIP.
required  Fail with exit ${EXIT_DOCKER_UNAVAILABLE} when Docker is unavailable.
skip      Do not invoke Docker.`);
}

class SmokeFailure extends Error {
  constructor(message, exitCode = EXIT_SMOKE_FAILED) {
    super(message);
    this.exitCode = exitCode;
  }
}

function finishFailure(message, exitCode = EXIT_SMOKE_FAILED) {
  throw new SmokeFailure(message, exitCode);
}

function parseArguments(argv) {
  let mode = "auto";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    if (argument.startsWith("--mode=")) {
      mode = argument.slice("--mode=".length);
      continue;
    }
    if (argument === "--mode") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        finishFailure("--mode requires a value", EXIT_USAGE);
      }
      mode = value;
      index += 1;
      continue;
    }
    finishFailure(`unknown argument: ${argument}`, EXIT_USAGE);
  }
  if (!["auto", "required", "skip"].includes(mode)) {
    finishFailure("--mode must be one of: auto, required, skip", EXIT_USAGE);
  }
  return mode;
}

function docker(arguments_, options = {}) {
  return spawnSync("docker", arguments_, {
    cwd: process.cwd(),
    encoding: options.encoding ?? "utf8",
    env: process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function runDocker(arguments_, label) {
  const result = docker(arguments_, { stdio: "inherit", encoding: undefined });
  if (result.error) {
    finishFailure(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    finishFailure(`${label} exited with ${result.status ?? "unknown"}`);
  }
}

function dockerAvailability() {
  const result = docker(["version", "--format", "{{.Server.Version}}"]);
  if (result.error) {
    return result.error.code === "ENOENT"
      ? "Docker CLI is not installed or is not on PATH"
      : `Docker CLI failed: ${result.error.message}`;
  }
  if (result.status !== 0 || !result.stdout.trim()) {
    return "Docker daemon is unavailable";
  }
  return "";
}

function dockerCliAvailability() {
  const result = docker(["--version"]);
  if (result.error) {
    return result.error.code === "ENOENT"
      ? "Docker CLI is not installed or is not on PATH"
      : `Docker CLI failed: ${result.error.message}`;
  }
  if (result.status !== 0 || !result.stdout.trim()) {
    return "Docker CLI is unavailable";
  }
  return "";
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
    return "local-dirty";
  }
  const sha = head.stdout.trim();
  return status.stdout.trim() ? `${sha}-dirty` : sha;
}

function assertComposeConfiguration(contents) {
  let configuration;
  try {
    configuration = JSON.parse(contents);
  } catch {
    finishFailure("docker compose did not return valid JSON configuration");
  }

  const service = configuration.services?.web;
  if (!service || typeof service !== "object") {
    finishFailure("compose.yaml must define the web service");
  }
  if (service.read_only !== true) {
    finishFailure("Compose web service must use a read-only root filesystem");
  }
  if (service.privileged === true) {
    finishFailure("Compose web service must not be privileged");
  }
  if (Array.isArray(service.cap_add) && service.cap_add.length > 0) {
    finishFailure("Compose web service must not add Linux capabilities");
  }
  if (!service.cap_drop?.map(String).map((value) => value.toUpperCase()).includes("ALL")) {
    finishFailure("Compose web service must drop all Linux capabilities");
  }
  if (
    !service.security_opt?.some((value) =>
      /^no-new-privileges(?::true)?$/i.test(String(value)),
    )
  ) {
    finishFailure("Compose web service must prevent privilege escalation");
  }
  if (
    service.network_mode &&
    /^(?:host|service:|container:)/i.test(String(service.network_mode))
  ) {
    finishFailure("Compose web service uses a dangerous network_mode");
  }
  if (service.user !== undefined && !/^101(?::101)?$/.test(String(service.user))) {
    finishFailure("Compose web service contains an unexpected user override");
  }
  if (service.init !== true) {
    finishFailure("Compose web service must enable an init process");
  }
  if (
    !Number.isInteger(service.pids_limit) ||
    service.pids_limit < 1 ||
    service.pids_limit > 200
  ) {
    finishFailure("Compose web service must set a bounded pids_limit at or below 200");
  }
  const temporaryFilesystem = service.tmpfs
    ?.map((value) => (typeof value === "string" ? value : String(value?.target ?? "")))
    .find((value) => /^\/tmp(?::|$)/.test(value));
  if (!temporaryFilesystem) {
    finishFailure("Compose web service must mount /tmp as tmpfs");
  }
  const tmpfsOptions = temporaryFilesystem.toLowerCase().split(/[,:]/);
  for (const option of ["rw", "noexec", "nosuid", "nodev", "size=16m", "mode=1777"]) {
    if (!tmpfsOptions.includes(option)) {
      finishFailure(`Compose /tmp tmpfs must set ${option}`);
    }
  }

  const ports = Array.isArray(service.ports) ? service.ports : [];
  const loopbackPortsOnly = ports.length > 0 && ports.every(
    (port) =>
      port &&
      typeof port === "object" &&
      ["127.0.0.1", "::1"].includes(port.host_ip) &&
      Number(port.target) === 8080,
  );
  if (!loopbackPortsOnly) {
    finishFailure("Every Compose web service port must publish 8080 on loopback only");
  }
}

function parsePublishedPort(output) {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/(?:127\.0\.0\.1|\[::1\]):(\d+)$/);
    if (match) return Number(match[1]);
  }
  finishFailure("Docker did not report a published localhost port");
}

async function waitForHealth(port, containerName) {
  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  let lastError = "no response";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.text();
      if (response.status === 200 && body === "ok\n") {
        return;
      }
      lastError = `HTTP ${response.status} with unexpected body`;
    } catch (error) {
      lastError = error.message;
    }

    const state = docker(["inspect", "--format", "{{.State.Status}}", containerName]);
    if (state.status === 0 && state.stdout.trim() === "exited") {
      finishFailure("container exited before it became healthy");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  finishFailure(`health endpoint did not become ready: ${lastError}`);
}

function assertHeader(response, name, predicate, message) {
  const value = response.headers.get(name) ?? "";
  if (!predicate(value)) {
    finishFailure(`${message}: ${value || "(missing)"}`);
  }
}

function assertApplicationSecurityHeaders(response) {
  assertHeader(
    response,
    "content-security-policy",
    (value) => value.includes("default-src 'self'") && value.includes("frame-ancestors 'none'"),
    "homepage Content-Security-Policy is missing required restrictions",
  );
  assertHeader(
    response,
    "x-content-type-options",
    (value) => value.toLowerCase() === "nosniff",
    "homepage X-Content-Type-Options must be nosniff",
  );
  assertHeader(
    response,
    "x-frame-options",
    (value) => value.toUpperCase() === "DENY",
    "homepage X-Frame-Options must be DENY",
  );
}

async function assertRoute(port, pathname, expectedContentType) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200) {
    finishFailure(`${pathname} returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes(expectedContentType)) {
    finishFailure(`${pathname} returned unexpected Content-Type ${contentType || "(missing)"}`);
  }
  return { response, body: await response.text() };
}

async function main() {
  const mode = parseArguments(process.argv.slice(2));
  if (mode === "skip") {
    console.log("SKIP self-host Docker smoke: disabled by --mode=skip");
    return;
  }

  const cliUnavailable = dockerCliAvailability();
  if (cliUnavailable) {
    if (mode === "required") {
      finishFailure(cliUnavailable, EXIT_DOCKER_UNAVAILABLE);
    }
    console.log(`SKIP self-host Docker smoke: ${cliUnavailable}`);
    return;
  }

  for (const file of ["Dockerfile", "compose.yaml"]) {
    const path = resolve(file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      finishFailure(`required configuration is missing: ${file}`);
    }
  }

  const composeCheck = docker([
    "compose",
    "-f",
    "compose.yaml",
    "config",
    "--format",
    "json",
  ]);
  if (composeCheck.error || composeCheck.status !== 0) {
    finishFailure("docker compose configuration is invalid or Compose is unavailable");
  }
  assertComposeConfiguration(composeCheck.stdout);

  const unavailable = dockerAvailability();
  if (unavailable) {
    if (mode === "required") {
      finishFailure(unavailable, EXIT_DOCKER_UNAVAILABLE);
    }
    console.log(`SKIP self-host Docker smoke after Compose validation: ${unavailable}`);
    return;
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const imageName = `canvink-self-host-smoke:${suffix}`;
  const containerName = `canvink-self-host-smoke-${suffix}`;
  const buildCommit = sourceProvenance();
  let imageCreated = false;
  let containerCreated = false;

  let smokeError;
  const cleanupFailures = [];
  try {
    runDocker(
      [
        "build",
        "--build-arg",
        `CANVINK_COMMIT=${buildCommit}`,
        "--tag",
        imageName,
        ".",
      ],
      "docker build",
    );
    imageCreated = true;
    const imageUser = docker(["image", "inspect", "--format", "{{.Config.User}}", imageName]);
    if (
      imageUser.error ||
      imageUser.status !== 0 ||
      !/^101(?::101)?$/.test(imageUser.stdout.trim())
    ) {
      finishFailure("built image must run as the expected unprivileged user 101:101");
    }
    runDocker(
      [
        "run",
        "--detach",
        "--name",
        containerName,
        "--init",
        "--pids-limit",
        "100",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/var/cache/nginx",
        "--tmpfs",
        "/var/run",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
        "--publish",
        "127.0.0.1::8080",
        imageName,
      ],
      "docker run",
    );
    containerCreated = true;

    const portResult = docker(["port", containerName, "8080/tcp"]);
    if (portResult.error || portResult.status !== 0) {
      finishFailure("could not determine the published container port");
    }
    const port = parsePublishedPort(portResult.stdout);
    await waitForHealth(port, containerName);

    const homepage = await assertRoute(port, "/", "text/html");
    if (!/<title>\s*Canvink\s*<\/title>/i.test(homepage.body)) {
      finishFailure("homepage is missing the Canvink title");
    }
    assertApplicationSecurityHeaders(homepage.response);
    assertHeader(
      homepage.response,
      "cache-control",
      (value) => /(no-store|max-age=0)/i.test(value),
      "homepage cache policy is unsafe",
    );

    const app = await assertRoute(port, "/app", "text/html");
    if (!/<div\s+id=["']root["']\s*><\/div>/i.test(app.body)) {
      finishFailure("SPA fallback for /app is missing the React root");
    }

    const serviceWorker = await assertRoute(port, "/sw.js", "javascript");
    assertHeader(
      serviceWorker.response,
      "cache-control",
      (value) => /no-store/i.test(value) && /max-age=0/i.test(value),
      "service worker cache policy is unsafe",
    );
    const manifest = await assertRoute(port, "/manifest.webmanifest", "manifest");
    assertHeader(
      manifest.response,
      "cache-control",
      (value) => /no-cache/i.test(value) && /max-age=0/i.test(value),
      "manifest cache policy is unsafe",
    );
    const version = await assertRoute(port, "/version.json", "json");
    assertHeader(
      version.response,
      "cache-control",
      (value) => /no-store/i.test(value) && /max-age=0/i.test(value),
      "version metadata cache policy is unsafe",
    );
    let versionMetadata;
    try {
      versionMetadata = JSON.parse(version.body);
    } catch {
      finishFailure("version metadata is not valid JSON");
    }
    if (versionMetadata.commit !== buildCommit) {
      finishFailure("container version metadata does not match the tested source provenance");
    }

    const assetReferences = [...homepage.body.matchAll(/(?:src|href)=["']([^"']+)["']/gi)]
      .map((match) => new URL(match[1], `http://127.0.0.1:${port}/`))
      .filter(
        (url) => url.origin === `http://127.0.0.1:${port}` && url.pathname.startsWith("/assets/"),
      );
    if (assetReferences.length === 0) {
      finishFailure("homepage contains no same-origin built asset");
    }
    const assetResponse = await fetch(assetReferences[0], {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (assetResponse.status !== 200) {
      finishFailure(`${assetReferences[0].pathname} returned HTTP ${assetResponse.status}`);
    }
    assertHeader(
      assetResponse,
      "cache-control",
      (value) => /immutable/i.test(value) && /max-age=31536000/i.test(value),
      "hashed asset cache policy is unsafe",
    );

    const missingAsset = await fetch(
      `http://127.0.0.1:${port}/assets/__canvink-smoke-missing__.js`,
      { redirect: "error", signal: AbortSignal.timeout(5_000) },
    );
    if (missingAsset.status !== 404) {
      finishFailure(`missing built asset returned HTTP ${missingAsset.status} instead of 404`);
    }

    console.log(
      "Self-host Docker smoke passed: Compose controls, health, routes, headers, caching, and 404",
    );
  } catch (error) {
    smokeError = error;
  } finally {
    if (containerCreated) {
      const cleanup = docker(["rm", "--force", containerName]);
      if (cleanup.error || cleanup.status !== 0) {
        cleanupFailures.push("temporary container");
      }
    }
    if (imageCreated) {
      const cleanup = docker(["image", "rm", "--force", imageName]);
      if (cleanup.error || cleanup.status !== 0) {
        cleanupFailures.push("temporary image");
      }
    }
  }

  if (cleanupFailures.length > 0) {
    const message = `cleanup failed for ${cleanupFailures.join(" and ")}`;
    if (smokeError) {
      console.error(`WARNING: ${message}`);
    } else {
      finishFailure(message);
    }
  }
  if (smokeError) {
    throw smokeError;
  }
}

try {
  await main();
} catch (error) {
  console.error(`Self-host Docker smoke failed: ${error.message}`);
  process.exitCode = error.exitCode ?? EXIT_SMOKE_FAILED;
}
