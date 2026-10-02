import { describe, expect, it } from "vitest";
import {
  runConvergenceSimulation,
  runParameterizedSyncSoak,
} from "./convergenceHarness";

describe("sync convergence simulation", () => {
  it("converges deterministically across five clients", () => {
    const first = runConvergenceSimulation({
      clients: 5,
      changesPerClient: 12,
      seed: 42,
    });
    const second = runConvergenceSimulation({
      clients: 5,
      changesPerClient: 12,
      seed: 42,
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      clients: 5,
      totalChanges: 60,
      entryCount: 60,
    });
  });

  it("converges under a twenty-client shuffled simulation", () => {
    expect(
      runConvergenceSimulation({
        clients: 20,
        changesPerClient: 8,
        seed: 0xc0ffee,
      }),
    ).toMatchObject({ clients: 20, totalChanges: 160, entryCount: 160 });
  });
});

const testProcess = (
  globalThis as {
    process?: {
      env?: Record<string, string | undefined>;
      stdout?: { write(value: string): void };
    };
  }
).process;
const soakMinutes = Number(testProcess?.env?.CANVINK_SYNC_SOAK_MINUTES ?? 0);
function emitSoakRecord(kind: "PROGRESS" | "EVIDENCE", value: unknown): void {
  testProcess?.stdout?.write(
    `CANVINK_SYNC_SOAK_${kind} ${JSON.stringify(value)}\n`,
  );
}
describe.skipIf(!(soakMinutes > 0))("parameterized sync soak", () => {
  it(
    `converges for ${soakMinutes} minute(s); production gate is 60`,
    async () => {
      const evidence = await runParameterizedSyncSoak({
        minutes: soakMinutes,
        clients: 20,
        onProgress: (progress) => emitSoakRecord("PROGRESS", progress),
      });
      emitSoakRecord("EVIDENCE", evidence);
      expect(evidence).toMatchObject({
        clients: 20,
        changesPerClient: 8,
        converged: true,
      });
      expect(evidence.durationMs).toBeGreaterThanOrEqual(soakMinutes * 60_000);
      expect(evidence.totalChanges).toBe(evidence.iterations * 160);
    },
    Math.max(10_000, soakMinutes * 60_000 + 30_000),
  );
});
