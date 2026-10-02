import { cpus, loadavg } from "node:os";
import type { Page } from "@playwright/test";

/** The calibration workload takes about this long in the browser on an idle 2026 laptop-class core. */
const IDLE_WORKLOAD_MS = 12.5;
/** Past this the machine is too busy for a timing to say anything, and a budget that scaled further would guard nothing. */
const MAX_SLOWDOWN = 6;

/**
 * How much slower than an idle machine the browser runs right now, from 1
 * (idle) to 6. Wall-clock budgets in the performance specs are multiplied by
 * it: the specs run next to other browsers on a shared machine, and a fixed
 * millisecond budget then measures the neighbours. A real regression is
 * several times slower than any budget, so scaling by the measured
 * contention keeps them meaningful. The probe runs for a few milliseconds and
 * sees only its own moment, while load comes in bursts, so the operating
 * system's run queue per core (a thread that shares a core with N others runs
 * N times slower) is taken into account as well. The workload runs on the page's main
 * thread, the thread the budgets are about.
 */
export async function machineSlowdown(page: Page): Promise<number> {
  const durations = await page.evaluate((runs) => {
    const measured: number[] = [];
    const values = new Float64Array(4096);
    for (let run = 0; run < runs; run += 1) {
      const start = performance.now();
      let sum = 0;
      for (let round = 0; round < 400; round += 1) {
        for (let index = 0; index < values.length; index += 1) {
          values[index] = Math.sqrt(index + round) * 1.0001;
          sum += values[index] % 7;
        }
      }
      // Keeps the loop from being optimised away.
      if (sum < 0) throw new Error("unreachable");
      measured.push(performance.now() - start);
    }
    return measured;
  }, 9);
  // The first runs include JIT warm-up; the median ignores a lucky or unlucky run.
  const settled = durations.slice(2).sort((left, right) => left - right);
  const median = settled[Math.floor(settled.length / 2)];
  const queuedPerCore = loadavg()[0] / cpus().length;
  return Math.min(MAX_SLOWDOWN, Math.max(1, median / IDLE_WORKLOAD_MS, queuedPerCore));
}

/**
 * CPU time the page's main thread has used so far, in milliseconds. Unlike
 * wall-clock time it does not grow when other processes take the core, so a
 * budget for work that is pure computation (opening a page, which holds the
 * main thread) stays meaningful on a machine that is several times
 * oversubscribed, where `machineSlowdown` has to give up at its cap.
 */
export async function mainThreadCpuMs(page: Page): Promise<number> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Performance.enable");
    const { metrics } = await session.send("Performance.getMetrics");
    const threadTime = metrics.find((metric) => metric.name === "ThreadTime");
    if (!threadTime) throw new Error("Chromium did not report ThreadTime.");
    return threadTime.value * 1000;
  } finally {
    await session.detach();
  }
}
