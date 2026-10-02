import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const requestedLayer = process.argv[2] ?? "automerge-simulation";
const layer =
  requestedLayer === "encrypted-coordinator"
    ? requestedLayer
    : "automerge-simulation";
const minutesArgument =
  requestedLayer === layer ? process.argv[3] : process.argv[2];
const minutes = Number(minutesArgument ?? 60);
if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1_440) {
  throw new RangeError(
    "Usage: node scripts/run-sync-soak.mjs [automerge-simulation|encrypted-coordinator] [minutes between 0 and 1440]",
  );
}

const child = spawn(
  process.execPath,
  [
    path.join("node_modules", "vitest", "vitest.mjs"),
    "run",
    layer === "encrypted-coordinator"
      ? "src/sync/client/encryptedCoordinatorSoak.test.ts"
      : "src/sync/client/convergenceHarness.test.ts",
    "--reporter=verbose",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, CANVINK_SYNC_SOAK_MINUTES: String(minutes) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let evidence;
let pending = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  pending += chunk;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() ?? "";
  for (const line of lines) captureEvidence(line);
  if (pending.length > 64 * 1_024) pending = pending.slice(-64 * 1_024);
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
captureEvidence(pending);
if (exitCode !== 0) process.exit(exitCode);
if (!evidence)
  throw new Error("The sync soak passed without emitting aggregate evidence.");
if (
  evidence.layer !== layer ||
  evidence.requestedMinutes !== minutes ||
  evidence.clients !== (layer === "encrypted-coordinator" ? 5 : 20) ||
  evidence.converged !== true
) {
  throw new Error("The sync soak evidence does not match the requested gate.");
}

const outputDirectory = path.join(process.cwd(), "test-results");
const stem = `sync-soak-${layer}-${formatMinutes(minutes)}m`;
const packageMetadata = JSON.parse(
  await readFile(path.join(process.cwd(), "package.json"), "utf8"),
);
const repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true,
}).trim();
if (!/^[0-9a-f]{40}$/.test(repositoryCommit)) {
  throw new Error("The repository commit binding is unavailable.");
}
const artifact = {
  schemaVersion: 1,
  kind: "sync-soak",
  contentFree: true,
  repositoryCommit,
  packageVersion: packageMetadata.version,
  recordedAt: evidence.endedAt,
  status: "passed",
  producer: "canvink-sync-soak-runner",
  results: {
    requestedMinutes: evidence.requestedMinutes,
    durationMs: evidence.durationMs,
    clients: evidence.clients,
    totalChanges: evidence.totalChanges ?? evidence.edits,
    totalRetries: evidence.totalRetries ?? evidence.lostAcknowledgements,
    converged: evidence.converged,
  },
};
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, `${stem}.json`),
  `${JSON.stringify(artifact, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(outputDirectory, `${stem}.md`),
  markdown(evidence),
  "utf8",
);
console.log(
  `CANVINK_SYNC_SOAK_ARTIFACT ${path.join("test-results", `${stem}.json`)}`,
);

function captureEvidence(line) {
  const marker = "CANVINK_SYNC_SOAK_EVIDENCE ";
  const index = line.indexOf(marker);
  if (index >= 0) evidence = JSON.parse(line.slice(index + marker.length));
}

function formatMinutes(value) {
  return Number.isInteger(value)
    ? String(value)
    : String(value).replace(".", "_");
}

function markdown(value) {
  return `# Canvink sync soak evidence

- Started: ${value.startedAt}
- Ended: ${value.endedAt}
- Requested minutes: ${value.requestedMinutes}
- Layer: ${value.layer}
- Exact duration: ${value.durationMs} ms
- Clients: ${value.clients}
- Changes per client and iteration: ${value.changesPerClient ?? "n/a"}
- Iterations: ${value.iterations}
- Total changes exercised: ${value.totalChanges ?? value.edits}
- Dependency retries or lost-ack replays: ${value.totalRetries ?? value.lostAcknowledgements}
- Disconnect/reconnect cycles: ${value.disconnects ?? "n/a"}/${value.reconnects ?? "n/a"}
- Coordinator restarts: ${value.coordinatorRestarts ?? "n/a"}
- Server resets: ${value.serverResets ?? "n/a"}
- Converged: ${value.converged}
${value.seed === undefined ? "" : `- Initial deterministic seed: ${value.seed}\n`}

This artifact contains aggregate test evidence only. It contains no notebook content, document heads, credentials, or encrypted payloads.
`;
}
