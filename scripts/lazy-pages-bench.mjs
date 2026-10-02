#!/usr/bin/env node
/**
 * Measures how Canvink opens and uses a large workspace, for comparing builds
 * before and after lazy page loading.
 *
 *   pnpm exec vite build --config scripts/bench/vite.seed.config.mjs
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/seed --pages 400 --strokes 200000 --images 1000
 *   VITE_CANVINK_ALLOW_FEATURE_OVERRIDE=1 pnpm exec vite build --outDir /tmp/canvink-dist
 *   node scripts/lazy-pages-bench.mjs --dist /tmp/canvink-dist --seed /tmp/seed --label after
 *
 * The seed is written straight into IndexedDB (the records a migration
 * writes), then the app is opened in fresh tabs of the same browser profile:
 *
 * - firstOpenMs: the first open of the seeded workspace (a lazy build also
 *   builds its page index then);
 * - coldOpenMs: a new tab after the first open settled, until the active
 *   page's title and ink are shown (median of --opens runs);
 * - memory after opening: JS heap after a forced GC, the size of every
 *   WebAssembly memory the page created, and the renderer's resident size;
 * - openPageMs: switching to a page that was not open (a normal and a heavy
 *   one) and back to the first page;
 * - searchMs: typing a word that occurs only on a page never opened in this
 *   session until its result shows;
 * - exportMs: the whole-workspace backup (or, in builds without one, the
 *   notebook bundle) until the download starts.
 *
 * Every phase has a time cap; a capped phase is reported as a timeout.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
const port = Number(args.port ?? 4412);
const label = args.label ?? 'build';
const opens = Number(args.opens ?? 3);
const phaseCapMs = Number(args.cap ?? 600_000);

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

async function withCap(labelText, promise, cap = phaseCapMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: `${labelText} exceeded ${Math.round(cap / 1000)} s` }), cap);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN;
};
const round = (value) => (Number.isFinite(value) ? Math.round(value) : value);
const mib = (bytes) => (Number.isFinite(bytes) ? Math.round((bytes / 1024 / 1024) * 10) / 10 : bytes);

/** Records every WebAssembly memory the page instantiates, before any app code runs. */
const WASM_PROBE = `(() => {
  const memories = [];
  window.__benchWasmMemories = memories;
  const remember = (result) => {
    const instance = result && (result.instance || result);
    const exports = instance && instance.exports;
    if (exports) for (const value of Object.values(exports)) if (value instanceof WebAssembly.Memory) memories.push(value);
    return result;
  };
  const instantiate = WebAssembly.instantiate.bind(WebAssembly);
  WebAssembly.instantiate = (...args) => instantiate(...args).then(remember);
  if (WebAssembly.instantiateStreaming) {
    const streaming = WebAssembly.instantiateStreaming.bind(WebAssembly);
    WebAssembly.instantiateStreaming = (...args) => streaming(...args).then(remember);
  }
  const Instance = WebAssembly.Instance;
  WebAssembly.Instance = function (...args) { return remember(new Instance(...args)); };
  WebAssembly.Instance.prototype = Instance.prototype;
})();`;

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
    return { records: seed.records.length, bytes: binary.length, stats: seed.stats, pages: seed.pages, firstPage: seed.firstPage };
  });
}

function inkReady(expected) {
  return `(() => {
    const surface = document.querySelector('[data-ink-stroke-count]');
    const count = surface ? Number(surface.getAttribute('data-ink-stroke-count')) : document.querySelectorAll('[data-element-kind="stroke"]').length;
    return count >= ${expected} && (document.querySelector('[data-ink-ready]')?.getAttribute('data-ink-ready') ?? 'true') === 'true';
  })()`;
}

async function waitForPage(page, info, cap) {
  const started = Date.now();
  const result = await withCap(`opening ${info.title}`, page.waitForFunction(
    `document.querySelector('input[aria-label="Seitentitel"]')?.value === ${JSON.stringify(info.title)} && ${inkReady(info.strokes)}`,
    undefined,
    { timeout: 0, polling: 50 },
  ), cap);
  return result?.timeout ? result : Date.now() - started;
}

/** Waits until the page has done less than 5 % CPU work over a second (background indexing done). */
async function waitForQuiet(cdp, cap = 600_000) {
  const started = Date.now();
  let previous;
  while (Date.now() - started < cap) {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const task = metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0;
    if (previous !== undefined && task - previous < 0.05) return Date.now() - started;
    previous = task;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { timeout: 'page never settled' };
}

/** Resident size of the largest renderer process, from the browser's process list and ps. */
async function rendererRss(browserCdp) {
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const renderers = processInfo.filter((entry) => entry.type === 'renderer').map((entry) => entry.id);
    if (renderers.length === 0) return Number.NaN;
    const rows = execFileSync('ps', ['-o', 'rss=', '-p', renderers.join(',')], { encoding: 'utf8' })
      .split('\n').map((row) => Number(row.trim()) * 1024).filter(Number.isFinite);
    return Math.max(0, ...rows);
  } catch {
    return Number.NaN;
  }
}

async function measureMemory(page, cdp, browserCdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const heap = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? Number.NaN;
  const wasm = await page.evaluate(() => (window.__benchWasmMemories ?? []).reduce((total, memory) => total + memory.buffer.byteLength, 0));
  return { jsHeapMiB: mib(heap), wasmMiB: mib(wasm), rendererRssMiB: mib(await rendererRss(browserCdp)) };
}

async function openApp(context, info) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const started = Date.now();
  await page.goto(`http://127.0.0.1:${port}/app`, { waitUntil: 'commit' });
  const ready = await waitForPage(page, info, phaseCapMs);
  const openMs = ready?.timeout ? ready : Date.now() - started;
  return { page, cdp, openMs, errors };
}

async function clickPage(page, info) {
  const row = page.locator(`[data-page-row-id="${info.pageId}"] .page-row__target`).first();
  const started = Date.now();
  await row.click();
  const ready = await waitForPage(page, info, phaseCapMs);
  return ready?.timeout ? ready : Date.now() - started;
}

async function main() {
  const server = await serve(dist);
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const browserCdp = await browser.newBrowserCDPSession();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  await context.addInitScript(WASM_PROBE);
  const result = { label, dist };
  // Progress goes to stderr, so a capped or crashed run still shows how far it got.
  const log = (phase, value) => process.stderr.write(`${new Date().toISOString()} ${label} ${phase} ${JSON.stringify(value)}\n`);
  try {
    const seeder = await context.newPage();
    const seedStarted = Date.now();
    const seeded = await seedIndexedDb(seeder);
    await seeder.close();
    result.seed = { ...seeded.stats, records: seeded.records, seedMs: Date.now() - seedStarted };
    const pages = seeded.pages;
    const first = pages[0];
    const normal = pages.find((page, index) => index > 0 && page.sectionId === first.sectionId && page.strokes < 1000);
    const heavy = pages.filter((page) => page.sectionId === first.sectionId && page !== first && page !== normal)
      .sort((left, right) => right.strokes - left.strokes)[0] ?? normal;
    const hidden = [...pages].reverse().find((page) => page.sectionId !== first.sectionId);

    const firstOpen = await openApp(context, first);
    result.firstOpenMs = firstOpen.openMs;
    log('firstOpen', firstOpen.openMs);
    result.firstOpenSettleMs = await waitForQuiet(firstOpen.cdp);
    log('firstOpenSettle', result.firstOpenSettleMs);
    log('memoryAfterFirstOpen', await measureMemory(firstOpen.page, firstOpen.cdp, browserCdp));
    result.firstOpenErrors = firstOpen.errors.slice(0, 5);
    await firstOpen.page.close();

    const coldOpens = [];
    let measured;
    for (let run = 0; run < opens; run += 1) {
      const opened = await openApp(context, first);
      coldOpens.push(opened.openMs);
      log('coldOpen', opened.openMs);
      if (run < opens - 1) {
        await waitForQuiet(opened.cdp, 120_000);
        await opened.page.close();
      } else measured = opened;
    }
    result.coldOpenMs = coldOpens.map((value) => (typeof value === 'number' ? value : value?.timeout));
    result.coldOpenMedianMs = median(coldOpens.filter((value) => typeof value === 'number'));
    if (!measured || typeof measured.openMs !== 'number') throw new Error(`cold open failed: ${JSON.stringify(result.coldOpenMs)}`);
    const { page, cdp } = measured;
    await waitForQuiet(cdp, 300_000);
    result.memoryAfterOpen = await measureMemory(page, cdp, browserCdp);
    log('memoryAfterOpen', result.memoryAfterOpen);

    result.openPageMs = {
      normal: { title: normal.title, strokes: normal.strokes, ms: await clickPage(page, normal) },
      heavy: { title: heavy.title, strokes: heavy.strokes, ms: await clickPage(page, heavy) },
      back: { title: first.title, strokes: first.strokes, ms: await clickPage(page, first) },
    };
    log('openPage', result.openPageMs);
    await waitForQuiet(cdp, 120_000);
    result.memoryAfterNavigation = await measureMemory(page, cdp, browserCdp);

    const search = page.getByRole('searchbox', { name: 'Arbeitsbereich lokal durchsuchen' });
    await search.fill('');
    const searchStarted = Date.now();
    await search.fill(hidden.token);
    const found = await withCap('search', page.getByRole('option', { name: new RegExp(hidden.title) }).first()
      .waitFor({ state: 'visible', timeout: 0 }).then(() => Date.now() - searchStarted), 120_000);
    result.search = { token: hidden.token, title: hidden.title, ms: found };
    log('search', result.search);
    await search.fill('');

    const fileMenu = page.locator('.asset-workspace-controls__menu > summary').first();
    await fileMenu.click();
    const backup = page.getByRole('button', { name: 'Alle Notizbücher sichern (.zip)' });
    const hasBackup = await backup.count() > 0;
    const exportButton = hasBackup ? backup : page.getByRole('button', { name: 'Notizbuch .canvink' });
    const exportStarted = Date.now();
    const download = page.waitForEvent('download', { timeout: 0 });
    await exportButton.click();
    const downloaded = await withCap('export', download.then(async (file) => ({
      ms: Date.now() - exportStarted,
      bytes: (await stat(await file.path())).size,
    })));
    result.export = { kind: hasBackup ? 'workspace backup' : 'notebook bundle', ...downloaded };
    log('export', result.export);
    result.memoryAfterExport = await measureMemory(page, cdp, browserCdp);
    result.errors = measured.errors.slice(0, 5);
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error);
  } finally {
    await browser.close().catch(() => undefined);
    server.close();
  }
  for (const key of ['firstOpenMs', 'coldOpenMedianMs']) result[key] = round(result[key]);
  console.log(JSON.stringify(result));
}

await main();
