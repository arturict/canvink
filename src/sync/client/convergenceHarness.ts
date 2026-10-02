import * as Automerge from "@automerge/automerge";

export interface ConvergenceSimulationOptions {
  clients: number;
  changesPerClient: number;
  seed: number;
}

export interface ConvergenceSimulationResult {
  clients: number;
  totalChanges: number;
  heads: readonly string[];
  entryCount: number;
  retries: number;
}

export interface SyncSoakProgress {
  version: 1;
  layer: "automerge-simulation";
  startedAt: string;
  observedAt: string;
  requestedMinutes: number;
  elapsedMs: number;
  clients: number;
  changesPerClient: number;
  iterations: number;
  totalChanges: number;
  totalRetries: number;
}

export interface SyncSoakEvidence extends Omit<
  SyncSoakProgress,
  "observedAt" | "elapsedMs"
> {
  endedAt: string;
  durationMs: number;
  converged: true;
  seed: number;
}

export interface SyncSoakOptions {
  minutes?: number;
  clients?: number;
  changesPerClient?: number;
  seed?: number;
  iterationPauseMs?: number;
  progressIntervalMs?: number;
  onProgress?(progress: SyncSoakProgress): void;
  signal?: AbortSignal;
}

interface SimulationDocument {
  entries: Record<string, string>;
}
interface WireChange {
  source: number;
  localOrder: number;
  bytes: Uint8Array;
}

/** A deterministic, dependency-aware Automerge network simulation. */
export function runConvergenceSimulation(
  options: ConvergenceSimulationOptions,
): ConvergenceSimulationResult {
  if (
    !Number.isSafeInteger(options.clients) ||
    options.clients < 2 ||
    options.clients > 100
  )
    throw new RangeError("clients must be between 2 and 100");
  if (
    !Number.isSafeInteger(options.changesPerClient) ||
    options.changesPerClient < 1 ||
    options.changesPerClient > 10_000
  )
    throw new RangeError("changesPerClient must be between 1 and 10000");
  const base = Automerge.change(
    Automerge.init<SimulationDocument>({ actor: actorId(0) }),
    { time: 0 },
    (document) => {
      document.entries = {};
    },
  );
  const documents = Array.from({ length: options.clients }, (_, client) =>
    Automerge.clone(base, { actor: actorId(client + 1) }),
  );
  const wire: WireChange[] = [];
  for (let client = 0; client < options.clients; client += 1) {
    for (
      let localOrder = 0;
      localOrder < options.changesPerClient;
      localOrder += 1
    ) {
      const before = documents[client];
      const after = Automerge.change(
        before,
        { time: localOrder + 1 },
        (document) => {
          document.entries[`${client}:${localOrder}`] =
            `value-${client}-${localOrder}`;
        },
      );
      const changes = Automerge.getChanges(before, after);
      if (changes.length !== 1)
        throw new Error(
          "Each simulated edit must create exactly one Automerge change.",
        );
      documents[client] = after;
      wire.push({ source: client, localOrder, bytes: changes[0] });
    }
  }

  const shuffled = deterministicShuffle(wire, options.seed);
  let retries = 0;
  for (let target = 0; target < options.clients; target += 1) {
    let pending = shuffled.filter((change) => change.source !== target);
    while (pending.length > 0) {
      let progress = false;
      const retry: WireChange[] = [];
      for (const change of pending) {
        try {
          documents[target] = Automerge.applyChanges(documents[target], [
            change.bytes,
          ])[0];
          progress = true;
        } catch {
          retry.push(change);
          retries += 1;
        }
      }
      if (!progress) {
        // Some Automerge builds defer missing dependencies instead of throwing.
        // The stable per-source order is the final dependency-safe transport path.
        retry.sort(
          (left, right) =>
            left.source - right.source || left.localOrder - right.localOrder,
        );
        documents[target] = Automerge.applyChanges(
          documents[target],
          retry.map((change) => change.bytes),
        )[0];
        pending = [];
      } else pending = retry;
    }
  }

  const expectedEntries = options.clients * options.changesPerClient;
  const canonical = canonicalEntries(documents[0].entries);
  const canonicalHeads = Automerge.getHeads(documents[0]).slice().sort();
  for (const document of documents) {
    if (Object.keys(document.entries).length !== expectedEntries)
      throw new Error("A simulated client lost changes.");
    if (canonicalEntries(document.entries) !== canonical)
      throw new Error("Simulated clients did not converge in content.");
    if (
      JSON.stringify(Automerge.getHeads(document).slice().sort()) !==
      JSON.stringify(canonicalHeads)
    )
      throw new Error("Simulated clients did not converge in heads.");
  }
  return {
    clients: options.clients,
    totalChanges: wire.length,
    heads: canonicalHeads,
    entryCount: expectedEntries,
    retries,
  };
}

/**
 * Runs a wall-clock soak without retaining document contents or busy-spinning.
 * Only aggregate counters are returned or exposed to progress observers.
 */
export async function runParameterizedSyncSoak(
  options: SyncSoakOptions = {},
): Promise<SyncSoakEvidence> {
  const minutes = options.minutes ?? 60;
  const clients = options.clients ?? 20;
  const changesPerClient = options.changesPerClient ?? 8;
  const seed = options.seed ?? 0x5eed;
  const iterationPauseMs = options.iterationPauseMs ?? 750;
  const progressIntervalMs = options.progressIntervalMs ?? 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60)
    throw new RangeError("minutes must be between 0 and 1440");
  if (
    !Number.isSafeInteger(iterationPauseMs) ||
    iterationPauseMs < 10 ||
    iterationPauseMs > 60_000
  ) {
    throw new RangeError("iterationPauseMs must be between 10 and 60000");
  }
  if (
    !Number.isSafeInteger(progressIntervalMs) ||
    progressIntervalMs < 10 ||
    progressIntervalMs > 60_000
  ) {
    throw new RangeError("progressIntervalMs must be between 10 and 60000");
  }

  const started = Date.now();
  const deadline = started + minutes * 60_000;
  const startedAt = new Date(started).toISOString();
  let nextProgressAt = started;
  let iterations = 0;
  let totalChanges = 0;
  let totalRetries = 0;

  while (Date.now() < deadline || iterations === 0) {
    throwIfAborted(options.signal);
    const result = runConvergenceSimulation({
      clients,
      changesPerClient,
      seed: seed + iterations,
    });
    iterations += 1;
    totalChanges += result.totalChanges;
    totalRetries += result.retries;
    const observed = Date.now();
    if (observed >= nextProgressAt) {
      options.onProgress?.({
        version: 1,
        layer: "automerge-simulation",
        startedAt,
        observedAt: new Date(observed).toISOString(),
        requestedMinutes: minutes,
        elapsedMs: observed - started,
        clients,
        changesPerClient,
        iterations,
        totalChanges,
        totalRetries,
      });
      nextProgressAt = observed + progressIntervalMs;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0)
      await abortableDelay(
        Math.min(iterationPauseMs, remainingMs),
        options.signal,
      );
  }

  const ended = Date.now();
  return {
    version: 1,
    layer: "automerge-simulation",
    startedAt,
    endedAt: new Date(ended).toISOString(),
    requestedMinutes: minutes,
    durationMs: ended - started,
    clients,
    changesPerClient,
    iterations,
    totalChanges,
    totalRetries,
    converged: true,
    seed,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw (
      signal.reason ?? new DOMException("The soak was aborted.", "AbortError")
    );
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  const delayMs = Math.max(
    0,
    Math.ceil(Number.isFinite(milliseconds) ? milliseconds : 0),
  );
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, delayMs);
    signal.addEventListener("abort", aborted, { once: true });
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      reject(
        signal?.reason ??
          new DOMException("The soak was aborted.", "AbortError"),
      );
    }
  });
}

function deterministicShuffle<T>(values: readonly T[], seed: number): T[] {
  const output = values.slice();
  let state = seed >>> 0;
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

function canonicalEntries(entries: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(entries).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function actorId(index: number): string {
  return index.toString(16).padStart(64, "0");
}
