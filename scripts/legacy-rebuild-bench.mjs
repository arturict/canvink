#!/usr/bin/env node
/**
 * Measures the automatic rebuild of a heavy legacy page (a page whose 7,000 strokes live inside its
 * Automerge document, as every page did before ink segments): how long the first open takes, how long
 * the rebuild that starts by itself takes, and how long the same page takes to open afterwards.
 *
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/legacy-seed \
 *     --pages 6 --strokes 1200 --images 0 --sections 2 --heavy 7000 --heavy-images 0 --ink packed
 *   VITE_CANVINK_ALLOW_FEATURE_OVERRIDE=1 pnpm exec vite build --outDir /tmp/legacy-dist
 *   node scripts/legacy-rebuild-bench.mjs --dist /tmp/legacy-dist --seed /tmp/legacy-seed
 *
 * The seed is written into IndexedDB of a fresh profile. The page is opened (the app rebuilds a legacy
 * page the user opens as soon as the pen is still), the script waits for `data-ink-rebuilt` on the
 * document element, then opens the same page again in a fresh tab. Times are medians over `--runs`.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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
if (!dist || !seedDir) throw new Error('--dist and --seed are required');
const port = Number(args.port ?? 4431);
const runs = Number(args.runs ?? 3);
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
    return { pages: seed.pages };
  });
}

const LONG_TASK_PROBE = `(() => {
  const tasks = [];
  window.__benchLongTasks = tasks;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
})();`;

async function waitForTitle(page, title) {
  await page.waitForFunction(
    (expected) => document.querySelector('input[aria-label="Seitentitel"]')?.value === expected,
    title,
    { timeout: 300_000, polling: 'raf' },
  );
}

/** Clicks the page row; times until every stroke is painted, and the longest task meanwhile. */
async function openPage(page, info) {
  await page.evaluate(() => { window.__benchOpenStart = performance.now(); });
  const done = page.evaluate(({ title, strokes }) => new Promise((resolve) => {
    const start = window.__benchOpenStart;
    const tick = () => {
      const shown = document.querySelector('input[aria-label="Seitentitel"]')?.value === title;
      const count = Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0);
      const loading = document.querySelector('[data-page-loading]') !== null;
      if (shown && !loading && count >= strokes) {
        resolve(performance.now() - start);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { title: info.title, strokes: info.strokes });
  await page.locator(`[data-page-row-id="${info.pageId}"] .page-row__target`).first().click();
  const inkMs = await done;
  return { inkMs: Math.round(inkMs) };
}

const longest = (page, from) => page.evaluate((start) => Math.round(Math.max(0,
  ...(window.__benchLongTasks ?? []).filter((task) => task.start + task.duration >= start).map((task) => task.duration))), from);

async function run(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(LONG_TASK_PROBE);
  try {
    const seeder = await context.newPage();
    const { pages } = await seedIndexedDb(seeder);
    await seeder.close();
    const first = pages[0];
    const heavy = pages.find((page) => page.pageId === 'bm-heavy');
    const other = pages.find((page) => page !== first && page !== heavy && page.sectionId === first.sectionId);

    // Before: the legacy page opens from its own document, and the app starts to rebuild it.
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/app`);
    await waitForTitle(page, first.title);
    await page.waitForTimeout(3000);
    const beforeOpen = await openPage(page, heavy);
    const openedAt = await page.evaluate(() => window.__benchOpenStart);
    const beforeLongest = await longest(page, openedAt);
    // Until the rebuilt document replaces it, seen from the page's own state.
    const rebuildStarted = Date.now();
    await page.waitForFunction(() => Number(document.documentElement.dataset.inkRebuilt ?? '0') >= 1, undefined, { timeout: 240_000, polling: 250 });
    const rebuildMs = Date.now() - rebuildStarted;
    const rebuildLongest = await longest(page, openedAt + beforeOpen.inkMs);
    // The page stays usable and complete after the swap.
    const strokesAfterSwap = await page.evaluate(() => Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0));
    await page.waitForTimeout(3000);
    await page.locator(`[data-page-row-id="${other.pageId}"] .page-row__target`).first().click();
    await waitForTitle(page, other.title);
    await page.close();

    // After: a fresh tab, the page is not in memory, and its document is the rebuilt one.
    const tab = await context.newPage();
    await tab.goto(`http://127.0.0.1:${port}/app`);
    await waitForTitle(tab, other.title);
    await tab.waitForTimeout(2000);
    const afterOpen = await openPage(tab, heavy);
    const afterOpenedAt = await tab.evaluate(() => window.__benchOpenStart);
    const afterLongest = await longest(tab, afterOpenedAt);
    await tab.close();
    return {
      beforeInkMs: beforeOpen.inkMs, beforeLongestTaskMs: beforeLongest,
      rebuildMs, rebuildLongestTaskMs: rebuildLongest, strokesAfterSwap,
      afterInkMs: afterOpen.inkMs, afterLongestTaskMs: afterLongest,
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
    const result = await run(browser);
    process.stderr.write(`run ${index + 1}: ${JSON.stringify(result)}\n`);
    results.push(result);
  }
  const median = (key) => [...results.map((result) => result[key])].sort((a, b) => a - b)[Math.floor(results.length / 2)];
  process.stdout.write(`${JSON.stringify({
    runs: results.length,
    median: Object.fromEntries(Object.keys(results[0]).map((key) => [key, median(key)])),
  })}\n`);
} finally {
  await browser.close();
  server.close();
}
