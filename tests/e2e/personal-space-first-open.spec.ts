/**
 * First open of a big notebook on a fresh device of the same account: the main
 * thread must stay free while the account is adopted in the background. Needs
 * a seed from scripts/bench/seed-workspace.ts (synthetic data only) and
 * tests/e2e/personal-space.playwright.config.ts:
 *
 *   FIRST_OPEN_SEED=/tmp/seed pnpm exec playwright test --config tests/e2e/personal-space.playwright.config.ts first-open
 *
 * Logs every long task and the click latency; with FIRST_OPEN_BUDGET_MS set it
 * also fails when one long task is longer than that.
 */
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { seedWorkspace } from './seededWorkspace';
import { SPACE_SYNCED_TEXT, test, waitForSpaceStatus } from './personalSpaceSupport';
import { expect, saveStatus } from './support';

const seedDir = process.env.FIRST_OPEN_SEED;

interface Task { start: number; duration: number }
interface TimedEvent { name: string; start: number; duration: number; delay: number }

async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tasks: Task[] = [];
    const frames: Task[] = [];
    const events: TimedEvent[] = [];
    const w = window as unknown as { __longTasks: Task[]; __frames: Task[]; __events: TimedEvent[] };
    w.__longTasks = tasks;
    w.__frames = frames;
    w.__events = events;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* unsupported */ }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) frames.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch { /* unsupported */ }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) events.push({ name: entry.name, start: entry.startTime, duration: entry.duration, delay: (entry as PerformanceEventTiming).processingStart - entry.startTime });
      }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
    } catch { /* unsupported */ }
  });
}

test('first open of a big notebook on a fresh device keeps the page responsive', async ({ page, browser }) => {
  test.skip(!seedDir, 'Set FIRST_OPEN_SEED to a seed made by scripts/bench/seed-workspace.ts.');
  test.setTimeout(1_200_000);
  if (!seedDir) return;
  const reuse = Boolean(process.env.FIRST_OPEN_SUB);
  const sub = process.env.FIRST_OPEN_SUB ?? `e2e-firstopen-${Date.now()}`;
  process.stdout.write(`FIRST_OPEN_SUB ${sub}\n`);
  const pages = await seedWorkspace(page, seedDir);
  if (!reuse) {
  // The first device uploads the whole account; the second one must not start before it is done.
    let lastUpload = Date.now();
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/api/v1/me/assets/')) lastUpload = Date.now();
    });
    page.on('websocket', (socket) => {
      socket.on('framesent', () => { lastUpload = Date.now(); });
    });
    await page.goto(`/app?__canvinkSpaceTestSub=${encodeURIComponent(sub)}`, { waitUntil: 'domcontentloaded' });
    await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 600_000 });
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT, 900_000);
    while (Date.now() - lastUpload < 20_000) await page.waitForTimeout(1_000);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT, 300_000);
  }

  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    await installProbes(second);
    const throttle = Number(process.env.FIRST_OPEN_THROTTLE ?? '1');
    if (throttle > 1) {
      const cdp = await secondContext.newCDPSession(second);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    }
    const profilePath = process.env.FIRST_OPEN_PROFILE;
    const profiler = profilePath ? await secondContext.newCDPSession(second) : undefined;
    if (profiler) {
      await profiler.send('Profiler.enable');
      await profiler.send('Profiler.setSamplingInterval', { interval: 500 });
      await profiler.send('Profiler.start');
    }
    const pageFrames: number[] = [];
    second.on('websocket', (socket) => {
      socket.on('framereceived', (frame) => {
        const text = typeof frame.payload === 'string' ? frame.payload : '';
        if (text.startsWith('{"t":"snapshot"')) pageFrames.push(Date.now() - started);
      });
    });
    const started = Date.now();
    await second.goto(`/app?__canvinkSpaceTestSub=${encodeURIComponent(sub)}`, { waitUntil: 'commit' });
    const rowTimeline: Array<{ at: number; rows: number }> = [];
    const clicks: Array<{ at: number; target: string; ms: number }> = [];
    const roundTrips: number[] = [];
    let synced = false;
    const firstSection = pages.filter((candidate) => candidate.sectionId === pages[0].sectionId);
    let clickIndex = 1;
    let lastClick = 0;
    let lastRowChange = Date.now();
    while (Date.now() - started < 120_000) {
      const t0 = Date.now();
      const rows = await second.locator('[data-page-row-id]').count().catch(() => -1);
      if (rowTimeline.at(-1)?.rows !== rows) {
        rowTimeline.push({ at: Date.now() - started, rows });
        lastRowChange = Date.now();
      }
      const status = await second.locator('[aria-label^="Synchronisierungsstatus"]').textContent({ timeout: 1000 }).catch(() => null);
      roundTrips.push(Date.now() - t0);
      if (status?.includes(SPACE_SYNCED_TEXT)) {
        synced = true;
        if (Date.now() - lastRowChange > 10_000 && Date.now() - lastClick > 4_000) break;
      }
      if (Date.now() - lastClick > 1500) {
        const target = firstSection[clickIndex % firstSection.length];
        const row = second.locator(`[data-page-row-id="${target.pageId}"] .page-row__target`);
        if (await row.count()) {
          lastClick = Date.now();
          const c0 = Date.now();
          const ok = await row.click({ timeout: 8_000 }).then(() => true, () => false);
          if (ok) {
            await expect(second.locator('input[aria-label="Seitentitel"]')).toHaveValue(target.title, { timeout: 8_000 }).catch(() => undefined);
            clicks.push({ at: c0 - started, target: target.pageId, ms: Date.now() - c0 });
            clickIndex += 1;
          } else {
            clicks.push({ at: c0 - started, target: target.pageId, ms: -1 });
          }
        }
      }
      await second.waitForTimeout(100);
    }
    if (profiler && profilePath) {
      const { profile } = await profiler.send('Profiler.stop');
      writeFileSync(profilePath, JSON.stringify(profile));
    }
    const metrics = await second.evaluate(() => {
      const w = window as unknown as { __longTasks: Task[]; __frames: Task[]; __events: TimedEvent[] };
      return { tasks: w.__longTasks, frames: w.__frames, events: w.__events };
    });
    const longest = metrics.tasks.reduce((max, task) => Math.max(max, task.duration), 0);
    const totalBlocked = metrics.tasks.reduce((sum, task) => sum + task.duration, 0);
    // Everything before the last downloaded page (plus a moment for its adoption) counts as
    // the load; what the click loop did afterwards (opening pages) is interaction, not load.
    const loadEnd = (pageFrames.at(-1) ?? 0) + 2_000;
    const inLoad = metrics.tasks.filter((task) => task.start < loadEnd);
    const summary = {
      synced,
      loadEndMs: loadEnd,
      load: {
        longTasks: inLoad.length,
        longest: Math.round(inLoad.reduce((max, task) => Math.max(max, task.duration), 0)),
        over100: inLoad.filter((task) => task.duration > 100).length,
        blockedMs: Math.round(inLoad.reduce((sum, task) => sum + task.duration, 0)),
        clickMs: clicks.filter((click) => click.at < loadEnd).map((click) => click.ms),
      },
      longTasks: metrics.tasks.length,
      longest: Math.round(longest),
      totalBlockedMs: Math.round(totalBlocked),
      over100: metrics.tasks.filter((task) => task.duration > 100).length,
      loafLongest: Math.round(metrics.frames.reduce((max, task) => Math.max(max, task.duration), 0)),
      slowEvents: metrics.events.filter((event) => event.duration >= 100).length,
      // Time an input waited for the main thread before its handler started, while the account loaded.
      inputDelayMax: Math.round(metrics.events.filter((event) => event.start < loadEnd).reduce((max, event) => Math.max(max, event.delay), 0)),
      rowTimeline: rowTimeline.slice(0, 12),
      snapshotFrames: pageFrames.length,
      lastSnapshotAt: pageFrames.at(-1) ?? 0,
      maxRoundTrip: Math.max(...roundTrips),
      clicks,
      topTasks: [...metrics.tasks].sort((a, b) => b.duration - a.duration).slice(0, 12).map((task) => ({ at: Math.round(task.start), ms: Math.round(task.duration) })),
    };
    process.stdout.write(`FIRST_OPEN ${JSON.stringify(summary)}\n`);
    test.info().annotations.push({ type: "first open", description: `load: longest task ${summary.load.longest} ms, ${summary.load.over100} over 100 ms, longest input delay ${summary.inputDelayMax} ms, clicks ${summary.load.clickMs.join("/")} ms` });
    if (process.env.FIRST_OPEN_OUT) writeFileSync(process.env.FIRST_OPEN_OUT, JSON.stringify({ ...summary, tasks: metrics.tasks, frames: metrics.frames }, null, 1));
    const budget = Number(process.env.FIRST_OPEN_BUDGET_MS ?? '0');
    if (budget > 0) expect(longest).toBeLessThanOrEqual(budget);
  } finally {
    await secondContext.close();
  }
});
