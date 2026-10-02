#!/usr/bin/env node
/**
 * Measures the first open of a heavy page (bm's worst pages: about 7,000
 * handwriting strokes of about 10 points over printouts) and how long the
 * main thread is blocked meanwhile.
 *
 *   pnpm exec vite build --config scripts/bench/vite.seed.config.mjs
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/heavy-seed \
 *     --pages 6 --strokes 1200 --images 12 --sections 2 --heavy 7000 --heavy-images 8
 *   VITE_CANVINK_ALLOW_FEATURE_OVERRIDE=1 pnpm exec vite build --outDir /tmp/canvink-dist
 *   node scripts/heavy-page-bench.mjs --dist /tmp/canvink-dist --seed /tmp/heavy-seed --label after
 *
 * Every run uses a fresh browser profile: the seed is written into IndexedDB,
 * the app opens on a light page and settles (it builds its page and search
 * indexes), then a new tab opens on the light page and the heavy page is
 * clicked. Reported per run:
 *
 * - titleMs: until the page title shows the heavy page (with a loading state
 *   while its document loads);
 * - firstInkMs: until the first ink is painted;
 * - inkMs: until every stroke is painted (the page is complete);
 * - longestTaskMs / blockedMs: the longest main-thread task and the summed
 *   time over 50 ms of all tasks during the open (Total Blocking Time);
 * - reopenMs: switching back to the heavy page after visiting another page;
 * - rasterWrite: after the first open, how long writing the page's cached
 *   ink picture took (rasterWriteMs, idle slices included) and the longest
 *   main-thread task meanwhile;
 * - switchOpen: in a fresh tab on another page (the heavy page's document is
 *   not in memory, its ink picture is stored), clicking the heavy page:
 *   rasterMs until the cached picture shows, firstInkMs until real ink tiles
 *   show, inkMs until every stroke is painted, and the longest task;
 * - restartOpen: a fresh tab that opens on the heavy page (the page last
 *   viewed), the same times counted from navigation start;
 * - search: on the first start, how long the first search for a word on the
 *   open page and one for a word on the heavy page take while the search
 *   index is still being built, and the longest main-thread task meanwhile.
 *
 * `--profile <file>` also writes a V8 CPU profile of the first open and
 * prints the functions with the most self and total time.
 */
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const dist = args.dist;
const seedDir = args.seed;
if (!dist || !seedDir) throw new Error('--dist <vite build> and --seed <seed directory> are required');
const port = Number(args.port ?? 4413);
const label = args.label ?? 'build';
const runs = Number(args.runs ?? 3);
const profilePath = args.profile;
const searchProfilePath = args['profile-search'];
const restartProfilePath = args['profile-restart'];
const cpuThrottle = Number(args.throttle ?? 1);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2',
};

function serve(root) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/__bench/blank') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>seed</title>');
      return;
    }
    if (url.pathname === '/__bench/seed.json' || url.pathname === '/__bench/seed.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(await readFile(join(seedDir, url.pathname.slice('/__bench/'.length))));
      return;
    }
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, path);
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
    } catch {
      file = join(root, 'index.html');
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function seedIndexedDb(page) {
  await page.goto(`http://127.0.0.1:${port}/__bench/blank`);
  return page.evaluate(async () => {
    const seed = await (await fetch('/__bench/seed.json')).json();
    const binary = new Uint8Array(await (await fetch('/__bench/seed.bin')).arrayBuffer());
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(seed.database, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(seed.store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const bytes = (record) => binary.slice(record.offset, record.offset + record.length);
    for (let start = 0; start < seed.records.length; start += 200) {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(seed.store, 'readwrite');
        const store = transaction.objectStore(seed.store);
        for (const record of seed.records.slice(start, start + 200)) {
          if (record.type === 'json') store.put(record.value, record.key);
          else if (record.type === 'bytes') store.put(bytes(record), record.key);
          else if (record.type === 'asset') store.put({ ...record.value, bytes: bytes(record) }, record.key);
          else if (record.type === 'chunk') store.put({ key: record.chunkKey, bytes: bytes(record) }, record.key);
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    }
    database.close();
    // Ink segments (seeds made by the segment format) go to their own database.
    const segmentRecords = seed.records.filter((record) => record.type === 'segment');
    if (segmentRecords.length > 0) {
      const inkDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open('canvink-ink-segments', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('segments');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (let start = 0; start < segmentRecords.length; start += 100) {
        await new Promise((resolve, reject) => {
          const transaction = inkDatabase.transaction('segments', 'readwrite');
          const segmentStore = transaction.objectStore('segments');
          for (const record of segmentRecords.slice(start, start + 100)) segmentStore.put(bytes(record), `blob:${record.key}`);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      }
      inkDatabase.close();
    }
    return { pages: seed.pages, stats: seed.stats };
  });
}

/** Long tasks are collected from the start of every document. */
const LONG_TASK_PROBE = `(() => {
  const tasks = [];
  window.__benchLongTasks = tasks;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
})();`;


/**
 * Timestamps, on every animation frame from the start of a document, when a
 * page with the given title and stroke count first shows its cached ink
 * picture, its first real ink tiles and all of its ink. `__benchProbeReset`
 * restarts it for an open by click.
 */
const openProbe = ({ title, strokes }) => `(() => {
  const probe = { start: 0 };
  window.__benchProbe = probe;
  window.__benchProbeReset = (start) => {
    for (const key of Object.keys(probe)) delete probe[key];
    probe.start = start;
  };
  const tick = () => {
    const now = performance.now() - probe.start;
    const shownTitle = document.querySelector('input[aria-label="Seitentitel"]')?.value === ${JSON.stringify(title)};
    const raster = document.querySelector('[data-ink-raster="cached"]') !== null;
    const loading = document.querySelector('[data-page-loading]') !== null;
    const count = Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0);
    const tiles = document.querySelectorAll('.live-canvas-ink-tile').length > 0;
    if (raster && probe.rasterMs === undefined) probe.rasterMs = now;
    if (probe.rasterMs !== undefined && !raster && probe.rasterGoneMs === undefined) probe.rasterGoneMs = now;
    if (shownTitle && !loading && tiles && count > 0 && probe.firstInkMs === undefined) probe.firstInkMs = now;
    if (shownTitle && !loading && count >= ${strokes} && probe.inkMs === undefined) probe.inkMs = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

/** The probe's times once the page is complete, and the longest task since `from`. */
async function probeResult(page, from) {
  await page.waitForFunction(() => window.__benchProbe?.inkMs !== undefined, undefined, { timeout: 300_000, polling: 100 });
  // The picture goes a frame or two after the ink is complete.
  await page.waitForTimeout(500);
  return page.evaluate((start) => {
    const probe = window.__benchProbe;
    const tasks = (window.__benchLongTasks ?? []).filter((task) => task.start + task.duration >= start);
    const round = (value) => (value === undefined ? null : Math.round(value));
    return {
      rasterMs: round(probe.rasterMs),
      firstInkMs: round(probe.firstInkMs),
      inkMs: round(probe.inkMs),
      rasterGoneMs: round(probe.rasterGoneMs),
      longestTaskMs: Math.round(Math.max(0, ...tasks.map((task) => task.duration))),
    };
  }, from);
}

/** Opens the heavy page by click and reads the probe. */
async function openWithProbe(page, info) {
  const from = await page.evaluate(() => {
    const start = performance.now();
    window.__benchProbeReset(start);
    return start;
  });
  await page.locator(`[data-page-row-id="${info.pageId}"] .page-row__target`).first().click();
  return probeResult(page, from);
}

/**
 * Waits until the open page's cached ink picture has been written, then
 * reports how long that took and the longest main-thread task meanwhile.
 * Builds without the cache report nulls.
 */
async function measureRasterWrite(page) {
  const entry = await page.waitForFunction(
    () => performance.getEntriesByName('canvink:ink-raster').at(-1)?.toJSON() ?? null,
    undefined,
    { timeout: 15_000, polling: 250 },
  ).then((handle) => handle.jsonValue()).catch(() => null);
  if (!entry) return { rasterWriteMs: null, rasterWriteLongestTaskMs: null };
  const longest = await page.evaluate(({ start, end }) => Math.max(0, ...(window.__benchLongTasks ?? [])
    .filter((task) => task.start < end && task.start + task.duration > start)
    .map((task) => task.duration)), { start: entry.startTime, end: entry.startTime + entry.duration });
  return { rasterWriteMs: Math.round(entry.duration), rasterWriteLongestTaskMs: Math.round(longest) };
}

async function waitForQuiet(cdp, cap = 300_000) {
  const started = Date.now();
  let previous;
  while (Date.now() - started < cap) {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const task = metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0;
    if (previous !== undefined && task - previous < 0.05) return Date.now() - started;
    previous = task;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return -1;
}

async function waitForTitle(page, title) {
  await page.waitForFunction(
    (expected) => document.querySelector('input[aria-label="Seitentitel"]')?.value === expected,
    title,
    { timeout: 300_000, polling: 'raf' },
  );
}

/** Clicks a page row and times title, first ink and complete ink from the click. */
async function openPage(page, info) {
  await page.evaluate(() => { window.__benchOpenStart = performance.now(); });
  // Timestamps are taken inside the page on every animation frame, so a
  // blocked main thread shows up as a late timestamp, not as a polling delay.
  const done = page.evaluate(({ title, strokes }) => new Promise((resolve) => {
    const result = {};
    const start = window.__benchOpenStart;
    const tick = () => {
      const now = performance.now() - start;
      const shownTitle = document.querySelector('input[aria-label="Seitentitel"]')?.value === title;
      const count = Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0);
      // While a page loads, the previous page's canvas is hidden but still mounted.
      const loading = document.querySelector('[data-page-loading]') !== null;
      const painted = !loading && document.querySelectorAll('.live-canvas-ink-tile').length > 0;
      if (shownTitle && result.titleMs === undefined) result.titleMs = now;
      if (shownTitle && painted && count > 0 && result.firstInkMs === undefined) result.firstInkMs = now;
      if (shownTitle && !loading && count >= strokes) {
        result.inkMs = now;
        resolve(result);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { title: info.title, strokes: info.strokes });
  await page.locator(`[data-page-row-id="${info.pageId}"] .page-row__target`).first().click();
  const result = await done;
  const tasks = await page.evaluate(() => {
    const start = window.__benchOpenStart;
    return (window.__benchLongTasks ?? []).filter((task) => task.start + task.duration >= start);
  });
  result.longestTaskMs = Math.max(0, ...tasks.map((task) => task.duration));
  result.blockedMs = tasks.reduce((total, task) => total + Math.max(0, task.duration - 50), 0);
  for (const key of Object.keys(result)) result[key] = Math.round(result[key]);
  return result;
}

/**
 * The first searches right after the first start, while the search index is
 * still being built: a word on the open page, then a word on the heavy page
 * (found only once the index reached it). Also the longest main-thread task
 * while the index was built.
 */
async function measureSearch(page, first, heavy) {
  const started = await page.evaluate(() => performance.now());
  const begin = Date.now();
  const box = page.getByRole('searchbox', { name: 'Arbeitsbereich lokal durchsuchen' });
  const find = async (info) => {
    const typed = Date.now();
    await box.fill(info.token);
    await page.getByRole('option', { name: new RegExp(info.title) }).first().waitFor({ state: 'visible', timeout: 600_000 });
    return Date.now() - typed;
  };
  const firstSearchMs = await find(first);
  const incompleteShown = await page.locator('.search-panel__incomplete').count() > 0;
  const heavySearchMs = await find(heavy);
  // The results keep the panel open while the index completes, so the pass
  // that is still running (the page projection worker's) ends before the
  // measured open starts. Builds without the progress marker are done here.
  // Every page's own text is searchable once only PDF printouts are pending.
  await page.waitForFunction(() => document.querySelector('.search-panel[data-search-indexing]') === null
    || /PDF/.test(document.querySelector('.search-panel__incomplete')?.textContent ?? ''),
  undefined, { timeout: 900_000, polling: 250 });
  const pagesIndexedMs = Date.now() - begin;
  await page.waitForFunction(() => document.querySelector('.search-panel[data-search-indexing]') === null,
    undefined, { timeout: 900_000, polling: 1000 });
  const indexMs = Date.now() - begin;
  await box.fill('');
  const longestTaskMs = await page.evaluate((from) => Math.max(0, ...(window.__benchLongTasks ?? [])
    .filter((task) => task.start >= from).map((task) => task.duration)), started);
  return { firstSearchMs, incompleteShown, heavySearchMs, pagesIndexedMs, indexMs, longestTaskWhileIndexingMs: Math.round(longestTaskMs) };
}

/**
 * One keystroke in the page title of the open heavy page: the longest
 * main-thread task and the summed time over 50 ms during the next seconds
 * (what the app does after an edit: saving, history, search, sync).
 */
async function measureEdit(page, info) {
  const from = await page.evaluate(() => performance.now());
  const title = page.locator('input[aria-label="Seitentitel"]');
  await title.click();
  await title.press('End');
  await title.pressSequentially('x');
  await page.waitForTimeout(4000);
  const measured = await page.evaluate((start) => {
    const tasks = (window.__benchLongTasks ?? []).filter((task) => task.start >= start);
    return {
      editLongestTaskMs: Math.round(Math.max(0, ...tasks.map((task) => task.duration))),
      editBlockedMs: Math.round(tasks.reduce((total, task) => total + Math.max(0, task.duration - 50), 0)),
    };
  }, from);
  // Put the title back so that the page is found by it again.
  await title.press('Backspace');
  await waitForTitle(page, info.title);
  await page.waitForTimeout(2000);
  return measured;
}

/**
 * A search typed as soon as the app has started, against the index stored by
 * the earlier session (nothing is indexed anymore): how long the first
 * answer takes and the longest main-thread task meanwhile.
 */
async function measureRestartSearch(context, first) {
  const page = await context.newPage();
  try {
    const cdp = restartProfilePath ? await context.newCDPSession(page) : undefined;
    if (cdp) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }
    const opened = Date.now();
    await page.goto(`http://127.0.0.1:${port}/app`);
    // The app opens on the page last viewed (the heavy page), so any title will do.
    await page.waitForFunction(() => Boolean(document.querySelector('input[aria-label="Seitentitel"]')?.value),
      undefined, { timeout: 300_000, polling: 'raf' });
    const restartTitleMs = Date.now() - opened;
    if (cdp) {
      const { profile } = await cdp.send('Profiler.stop');
      await writeFile(restartProfilePath, JSON.stringify(profile));
      const summary = summarizeProfile(profile);
      process.stderr.write(`\nrestart until the title shows, self time:\n${summary.self.slice(0, 25).join('\n')}\n\ntotal time:\n${summary.total.slice(0, 45).join('\n')}\n\n`);
    }
    const from = await page.evaluate(() => performance.now());
    const begin = Date.now();
    await page.getByRole('searchbox', { name: 'Arbeitsbereich lokal durchsuchen' }).fill(first.token);
    await page.getByRole('option', { name: new RegExp(first.title) }).first().waitFor({ state: 'visible', timeout: 120_000 });
    const restartSearchMs = Date.now() - begin;
    const longest = await page.evaluate((start) => Math.max(0, ...(window.__benchLongTasks ?? [])
      .filter((task) => task.start >= start).map((task) => task.duration)), from);
    return { restartTitleMs, restartSearchMs, restartSearchLongestTaskMs: Math.round(longest) };
  } finally {
    await page.close();
  }
}

function summarizeProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const self = new Map();
  const total = new Map();
  const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length);
  const name = (node) => {
    const frame = node.callFrame;
    const file = frame.url.split('/').pop() ?? '';
    return `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`;
  };
  for (const id of profile.samples) {
    const node = nodes.get(id);
    const key = name(node);
    self.set(key, (self.get(key) ?? 0) + interval / 1000);
    const seen = new Set();
    for (let current = id; current !== undefined; current = parent.get(current)) {
      const currentKey = name(nodes.get(current));
      if (seen.has(currentKey)) continue;
      seen.add(currentKey);
      total.set(currentKey, (total.get(currentKey) ?? 0) + interval / 1000);
    }
  }
  const top = (map, count) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count)
    .map(([key, ms]) => `${Math.round(ms).toString().padStart(7)} ms  ${key}`);
  return { self: top(self, 40), total: top(total, 60) };
}

/**
 * The longest stretches of consecutive busy samples of the main thread (a
 * stretch ends at an idle sample), with the functions that took most of their
 * self time; long stretches are the long tasks.
 */
function busyStretches(profile, count = 8) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length) / 1000;
  const label = (node) => {
    const frame = node.callFrame;
    return `${frame.functionName || '(anonymous)'} ${(frame.url.split('/').pop() ?? '')}:${frame.lineNumber + 1}`;
  };
  const stretches = [];
  let current;
  let elapsedUs = 0;
  profile.samples.forEach((id, index) => {
    elapsedUs += profile.timeDeltas[index];
    const name = nodes.get(id).callFrame.functionName;
    if (name === '(idle)') {
      if (current) stretches.push(current);
      current = undefined;
      return;
    }
    current ??= { startMs: elapsedUs / 1000, samples: [] };
    current.samples.push(id);
  });
  if (current) stretches.push(current);
  return stretches
    .sort((a, b) => b.samples.length - a.samples.length)
    .slice(0, count)
    .map((stretch) => {
      const self = new Map();
      for (const id of stretch.samples) self.set(label(nodes.get(id)), (self.get(label(nodes.get(id))) ?? 0) + interval);
      const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([key, ms]) => `${Math.round(ms)}ms ${key}`).join(' | ');
      return `${Math.round(stretch.samples.length * interval).toString().padStart(6)} ms at ${Math.round(stretch.startMs)}: ${top}`;
    });
}

async function run(browser, index) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(LONG_TASK_PROBE);
  try {
    const seeder = await context.newPage();
    const { pages } = await seedIndexedDb(seeder);
    await seeder.close();
    const first = pages[0];
    const heavy = pages.find((page) => page.pageId === 'bm-heavy');
    const other = pages.find((page) => page !== first && page !== heavy && page.sectionId === first.sectionId);
    if (!heavy) throw new Error('The seed has no heavy page; generate it with --heavy 7000.');
    await context.addInitScript(openProbe(heavy));

    // First start: builds the page index and the search index, then settles.
    const warm = await context.newPage();
    const warmCdp = await context.newCDPSession(warm);
    await warmCdp.send('Performance.enable');
    await warm.goto(`http://127.0.0.1:${port}/app`);
    await waitForTitle(warm, first.title);
    const searchProfiling = searchProfilePath && index === 0;
    if (searchProfiling) {
      await warmCdp.send('Profiler.enable');
      await warmCdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await warmCdp.send('Profiler.start');
    }
    const search = await measureSearch(warm, first, heavy);
    if (searchProfiling) {
      const { profile } = await warmCdp.send('Profiler.stop');
      await writeFile(searchProfilePath, JSON.stringify(profile));
      process.stderr.write(`\nlongest busy stretches while indexing:\n${busyStretches(profile).join('\n')}\n\n`);
    }
    await waitForQuiet(warmCdp);
    await warm.close();

    // Measured: a fresh tab (nothing in memory) on the light page.
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    if (cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    await page.goto(`http://127.0.0.1:${port}/app`);
    await waitForTitle(page, first.title);
    await waitForQuiet(cdp);
    const profiling = profilePath && index === 0;
    if (profiling) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }
    const firstOpen = await openPage(page, heavy);
    const openStart = await page.evaluate(() => window.__benchOpenStart);
    await waitForQuiet(cdp);
    if (profiling) {
      // Up to the quiet moment after the open, so work the app starts once the page is shown is in it.
      const { profile } = await cdp.send('Profiler.stop');
      await writeFile(profilePath, JSON.stringify(profile));
      const summary = summarizeProfile(profile);
      process.stderr.write(`\nself time:\n${summary.self.join('\n')}\n\ntotal time:\n${summary.total.join('\n')}\n\nlongest busy stretches:\n${busyStretches(profile).join('\n')}\n\n`);
    }
    // Work the app starts once the page is shown (an automatic history checkpoint, for one).
    const afterOpen = await page.evaluate(({ from }) => {
      const tasks = (window.__benchLongTasks ?? []).filter((task) => task.start >= from);
      return {
        afterOpenLongestTaskMs: Math.round(Math.max(0, ...tasks.map((task) => task.duration))),
        afterOpenBlockedMs: Math.round(tasks.reduce((total, task) => total + Math.max(0, task.duration - 50), 0)),
      };
    }, { from: openStart + firstOpen.inkMs });
    Object.assign(firstOpen, afterOpen);
    const rasterWrite = await measureRasterWrite(page);
    Object.assign(firstOpen, await measureEdit(page, heavy));
    await page.locator(`[data-page-row-id="${other.pageId}"] .page-row__target`).first().click();
    await waitForTitle(page, other.title);
    await waitForQuiet(cdp);
    const reopen = await openPage(page, heavy);
    // Leave on the other page, so a fresh tab opens there.
    await page.locator(`[data-page-row-id="${other.pageId}"] .page-row__target`).first().click();
    await waitForTitle(page, other.title);
    await waitForQuiet(cdp);
    await page.close();

    // Switching to the heavy page in a fresh tab: its document is not in memory.
    const switchTab = await context.newPage();
    switchTab.on('pageerror', (error) => errors.push(error.message));
    const switchCdp = await context.newCDPSession(switchTab);
    await switchCdp.send('Performance.enable');
    await switchTab.goto(`http://127.0.0.1:${port}/app`);
    await waitForTitle(switchTab, other.title);
    await waitForQuiet(switchCdp);
    const switchOpen = await openWithProbe(switchTab, heavy);
    await waitForQuiet(switchCdp);
    await switchTab.close();

    // Restarting on the heavy page (the page last viewed), timed from navigation start.
    const restartTab = await context.newPage();
    restartTab.on('pageerror', (error) => errors.push(error.message));
    const restartCdp = await context.newCDPSession(restartTab);
    await restartCdp.send('Performance.enable');
    await restartTab.goto(`http://127.0.0.1:${port}/app`);
    const restartOpen = await probeResult(restartTab, 0);
    await waitForQuiet(restartCdp);
    await restartTab.close();

    Object.assign(search, await measureRestartSearch(context, first));
    return {
      firstOpen,
      reopenMs: reopen.inkMs,
      reopenLongestTaskMs: reopen.longestTaskMs,
      rasterWrite,
      switchOpen,
      restartOpen,
      search,
      errors: errors.slice(0, 3),
    };
  } finally {
    await context.close();
  }
}

const server = await serve(dist);
const browser = await chromium.launch();
try {
  const results = [];
  for (let index = 0; index < runs; index += 1) {
    const result = await run(browser, index);
    process.stderr.write(`${label} run ${index + 1}: ${JSON.stringify(result)}\n`);
    results.push(result);
  }
  const median = (values) => {
    const known = values.filter((value) => value !== null && value !== undefined);
    return known.length === 0 ? null : [...known].sort((a, b) => a - b)[Math.floor(known.length / 2)];
  };
  const pick = (key) => median(results.map((result) => result.firstOpen[key]));
  process.stdout.write(`${JSON.stringify({
    label,
    throttle: cpuThrottle,
    runs: results.length,
    median: {
      titleMs: pick('titleMs'),
      firstInkMs: pick('firstInkMs'),
      inkMs: pick('inkMs'),
      longestTaskMs: pick('longestTaskMs'),
      blockedMs: pick('blockedMs'),
      afterOpenLongestTaskMs: pick('afterOpenLongestTaskMs'),
      afterOpenBlockedMs: pick('afterOpenBlockedMs'),
      editLongestTaskMs: pick('editLongestTaskMs'),
      editBlockedMs: pick('editBlockedMs'),
      reopenMs: median(results.map((result) => result.reopenMs)),
      firstSearchMs: median(results.map((result) => result.search.firstSearchMs)),
      heavySearchMs: median(results.map((result) => result.search.heavySearchMs)),
      pagesIndexedMs: median(results.map((result) => result.search.pagesIndexedMs)),
      indexMs: median(results.map((result) => result.search.indexMs)),
      restartTitleMs: median(results.map((result) => result.search.restartTitleMs)),
      restartSearchMs: median(results.map((result) => result.search.restartSearchMs)),
      restartSearchLongestTaskMs: median(results.map((result) => result.search.restartSearchLongestTaskMs)),
      longestTaskWhileIndexingMs: median(results.map((result) => result.search.longestTaskWhileIndexingMs)),
      rasterWriteMs: median(results.map((result) => result.rasterWrite.rasterWriteMs)),
      rasterWriteLongestTaskMs: median(results.map((result) => result.rasterWrite.rasterWriteLongestTaskMs)),
      switchRasterMs: median(results.map((result) => result.switchOpen.rasterMs)),
      switchFirstInkMs: median(results.map((result) => result.switchOpen.firstInkMs)),
      switchInkMs: median(results.map((result) => result.switchOpen.inkMs)),
      switchLongestTaskMs: median(results.map((result) => result.switchOpen.longestTaskMs)),
      restartRasterMs: median(results.map((result) => result.restartOpen.rasterMs)),
      restartFirstInkMs: median(results.map((result) => result.restartOpen.firstInkMs)),
      restartInkMs: median(results.map((result) => result.restartOpen.inkMs)),
    },
    results,
  })}\n`);
} finally {
  await browser.close();
  server.close();
}
