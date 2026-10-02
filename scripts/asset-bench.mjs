#!/usr/bin/env node
/**
 * Measures how printouts and pictures load and render (synthetic data only).
 *
 *   pnpm exec vite build --config scripts/bench/vite.seed.config.mjs
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/asset-seed \
 *     --pages 6 --strokes 1200 --images 12 --sections 2 --heavy 7000 --heavy-images 8 \
 *     --printout-size 1654x2339 --heavy-pdf 1 --photos 12 --worksheet 300
 *   VITE_CANVINK_ALLOW_FEATURE_OVERRIDE=1 pnpm exec vite build --outDir /tmp/canvink-dist
 *   node scripts/asset-bench.mjs --dist /tmp/canvink-dist --seed /tmp/asset-seed --runs 3
 *   node scripts/asset-bench.mjs --dist after=/tmp/canvink-dist,before=/tmp/old-dist --seed /tmp/asset-seed
 *
 * Every run uses a fresh browser profile: the seed is written into IndexedDB,
 * the app settles on a light page (it builds its page and search indexes),
 * then a new tab opens on that page. Reported per run:
 *
 * - sheet / heavy / photo: after clicking the page (a worksheet of eight
 *   printouts under 300 strokes, the same under 7,000 strokes, and twelve 12 MP
 *   JPEG photos): until the first picture is loaded (firstMs), until every
 *   picture in the viewport is loaded and decoded (sharpMs), until all within
 *   one viewport of it are loaded (allLoadedMs; the app loads that far ahead),
 *   the summed main-thread time over 50 ms in that window (blockedMs) and the
 *   longest task;
 * - counters: blob URLs created, SHA-256 digests and their bytes and image
 *   bitmaps created, over the open of each page;
 * - *Reopen: switching to another page and back;
 * - sheetScroll / sheetZoom / heavyScroll / photoScroll: frame intervals (p50,
 *   p95, worst; share over 33 ms) while wheel events pan and zoom the canvas;
 * - ink: a stroke drawn over the 7,000-stroke page; blob URLs created and
 *   blocking time while it is committed;
 * - pdfImport: inserting a 24-page scanned PDF (about 10 MB) as printouts (pdf.js
 *   render, PNG encode, store): total time, blocking and longest task;
 * - mem: JS heap and resident memory of the renderer and GPU processes after
 *   each step.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const seedDir = args.seed;
// One build, or several to compare: `--dist after=/tmp/a,baseline=/tmp/b`. Runs alternate between them
// so that a noisy neighbour hits every build alike.
const variants = (args.dist ?? '').split(',').filter(Boolean).map((entry, index) => {
  const [name, path] = entry.includes('=') ? entry.split('=') : [args.label ?? 'build', entry];
  return { name, dist: path, port: Number(args.port ?? 4414) + index };
});
if (variants.length === 0 || !seedDir) throw new Error('--dist <vite build> and --seed <seed directory> are required');
const runs = Number(args.runs ?? 3);
// `--profile <file>` writes a V8 CPU profile of the first open of the heavy page and prints
// where its main thread went; the run then stops there.
const profilePath = args.profile;
// `--only sheet,photos` runs some scenarios only (sheet, heavy, photos, pdf); all by default.
const only = new Set((args.only ?? 'sheet,heavy,photos,pdf').split(','));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2',
};

function serve(root, port) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/__bench/blank') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>seed</title>');
      return;
    }
    if (url.pathname === '/__bench/seed.json' || url.pathname === '/__bench/seed.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(await readFileAsync(join(seedDir, url.pathname.slice('/__bench/'.length))));
      return;
    }
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, path);
    try {
      if (!(await statAsync(file)).isFile()) throw new Error('not a file');
    } catch {
      file = join(root, 'index.html');
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    response.end(await readFileAsync(file));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function seedIndexedDb(page, port) {
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

/** Long tasks and asset counters, installed in every document. */
const PROBE = `(() => {
  const tasks = [];
  window.__benchLongTasks = tasks;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  const counters = { objectUrls: 0, revoked: 0, digests: 0, digestBytes: 0, bitmaps: 0 };
  window.__benchCounters = counters;
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object) => { counters.objectUrls += 1; return create(object); };
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => { counters.revoked += 1; return revoke(url); };
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = (algorithm, data) => {
    counters.digests += 1;
    counters.digestBytes += data.byteLength;
    return digest(algorithm, data);
  };
  const bitmap = window.createImageBitmap?.bind(window);
  if (bitmap) window.createImageBitmap = (...parameters) => { counters.bitmaps += 1; return bitmap(...parameters); };
})();`;

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

const counters = (page) => page.evaluate(() => ({ ...window.__benchCounters }));
const subtract = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));

/** Resident memory in MB of the renderer of `page`'s browser and of its GPU process, plus the JS heap. */
async function memory(browserCdp, cdp) {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  const rss = (pid) => {
    try {
      const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((row) => row.startsWith('VmRSS:'));
      return Math.round(Number(line?.split(/\s+/)[1] ?? 0) / 1024);
    } catch { return 0; }
  };
  const total = (type) => processInfo.filter((info) => info.type === type).reduce((sum, info) => sum + rss(info.id), 0);
  const { metrics } = await cdp.send('Performance.getMetrics');
  const heap = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0;
  return { rendererMb: total('renderer'), gpuMb: total('GPU'), jsHeapMb: Math.round(heap / 1024 / 1024) };
}

/**
 * Clicks a page row and, on every animation frame, watches the elements that
 * show pictures. `selector` names those elements; the picture inside is loaded
 * once it is an <img> that has its bitmap. "Near" elements are those within one
 * viewport of the visible area, which is how far ahead the app loads; "visible"
 * ones intersect it. Gives up after 40 s and says so.
 */
async function openPage(page, info, selector) {
  await page.evaluate(() => { window.__benchOpenStart = performance.now(); });
  const before = await counters(page);
  const done = page.evaluate(({ title, selector: elementSelector }) => new Promise((resolve) => {
    const result = {};
    const start = window.__benchOpenStart;
    let decoding = false;
    const loadedImage = (element) => {
      const image = element.querySelector('img.asset-preview-image');
      return image !== null && image.complete && image.naturalWidth > 0 ? image : null;
    };
    const tick = () => {
      const now = performance.now() - start;
      if (now > 40_000) {
        result.timedOut = true;
        resolve(result);
        return;
      }
      const shownTitle = document.querySelector('input[aria-label="Seitentitel"]')?.value === title;
      const loading = document.querySelector('[data-page-loading]') !== null;
      if (shownTitle && !loading) {
        const elements = [...document.querySelectorAll(elementSelector)];
        result.count = elements.length;
        const loaded = elements.filter((element) => loadedImage(element));
        if (loaded.length > 0 && result.firstMs === undefined) result.firstMs = now;
        const rect = (element) => element.getBoundingClientRect();
        const near = elements.filter((element) => {
          const box = rect(element);
          return box.bottom > -innerHeight && box.top < 2 * innerHeight && box.right > -innerWidth && box.left < 2 * innerWidth;
        });
        if (near.length > 0 && near.every((element) => loadedImage(element)) && result.allLoadedMs === undefined) {
          result.allLoadedMs = now;
          result.nearCount = near.length;
        }
        const visible = elements.filter((element) => {
          const box = rect(element);
          return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
        });
        if (!decoding && visible.length > 0 && visible.every((element) => loadedImage(element))) {
          decoding = true;
          void Promise.all(visible.map((element) => loadedImage(element)?.decode().catch(() => undefined))).then(() => {
            requestAnimationFrame(() => {
              result.sharpMs = performance.now() - start;
              result.visible = visible.length;
            });
          });
        }
        if (result.sharpMs !== undefined && result.allLoadedMs !== undefined) {
          resolve(result);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { title: info.title, selector });
  await page.locator(`[data-page-row-id="${info.pageId}"] .page-row__target`).first().click();
  const result = await done;
  const end = await page.evaluate(() => performance.now());
  const tasks = await page.evaluate(() => {
    const start = window.__benchOpenStart;
    return (window.__benchLongTasks ?? []).filter((task) => task.start + task.duration >= start);
  });
  result.longestTaskMs = Math.max(0, ...tasks.map((task) => task.duration));
  result.blockedMs = tasks.reduce((total, task) => total + Math.max(0, task.duration - 50), 0);
  result.windowMs = end - (await page.evaluate(() => window.__benchOpenStart));
  result.counters = subtract(await counters(page), before);
  for (const key of ['firstMs', 'allLoadedMs', 'sharpMs', 'longestTaskMs', 'blockedMs', 'windowMs']) {
    if (result[key] !== undefined) result[key] = Math.round(result[key]);
  }
  return result;
}

/** Frame intervals while `step(frame)` dispatches one wheel event per animation frame. */
function frames(page, kind, count) {
  return page.evaluate(({ kind: gesture, count: total }) => new Promise((resolve) => {
    const viewport = document.querySelector('.live-canvas-viewport');
    const box = viewport.getBoundingClientRect();
    const clientX = box.left + box.width / 2;
    const clientY = box.top + box.height / 2;
    const intervals = [];
    let previous;
    let frame = 0;
    const tick = (time) => {
      if (previous !== undefined) intervals.push(time - previous);
      previous = time;
      if (frame >= total) {
        const sorted = [...intervals].sort((a, b) => a - b);
        const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
        resolve({
          frames: intervals.length,
          p50: Math.round(at(0.5) * 10) / 10,
          p95: Math.round(at(0.95) * 10) / 10,
          worst: Math.round(sorted.at(-1) * 10) / 10,
          over33: Math.round((intervals.filter((value) => value > 33.4).length / intervals.length) * 100),
        });
        return;
      }
      let deltaY = 60;
      let ctrlKey = false;
      if (gesture === 'zoom') {
        ctrlKey = true;
        deltaY = frame < total / 2 ? -12 : 12;
      } else if (gesture === 'scrollUp') {
        deltaY = -60;
      }
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY, ctrlKey, clientX, clientY, bubbles: true, cancelable: true }));
      frame += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { kind, count });
}

async function drawStroke(page) {
  await page.getByRole('tab', { name: 'Zeichnen' }).click();
  await page.getByRole('tabpanel', { name: 'Zeichnen' }).getByRole('button', { name: 'Stift', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Gemeinsame Seitenzeichenfläche' });
  const box = await canvas.boundingBox();
  const viewport = page.viewportSize();
  const x = Math.max(box.x, 0) + 200;
  const y = Math.max(box.y, 120) + 200;
  const inside = (value, limit) => Math.min(value, limit - 20);
  const before = await counters(page);
  const start = await page.evaluate(() => performance.now());
  await page.mouse.move(inside(x, viewport.width), inside(y, viewport.height));
  await page.mouse.down();
  await page.mouse.move(inside(x + 220, viewport.width), inside(y + 60, viewport.height), { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const tasks = await page.evaluate((from) => (window.__benchLongTasks ?? []).filter((task) => task.start >= from), start);
  return {
    blockedMs: Math.round(tasks.reduce((total, task) => total + Math.max(0, task.duration - 50), 0)),
    longestTaskMs: Math.round(Math.max(0, ...tasks.map((task) => task.duration))),
    counters: subtract(await counters(page), before),
  };
}

const PRINTOUTS = '.live-canvas-element.is-background';
const PHOTOS = '.live-canvas-element[data-element-kind="image"]';

/** Scan-like JPEGs (text rows with grain, about 400 KB each), drawn by a spare page. */
async function scanJpegs(context, count) {
  const spare = await context.newPage();
  try {
    const encoded = await spare.evaluate(async (total) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1240;
      canvas.height = 1754;
      const drawing = canvas.getContext('2d');
      const out = [];
      for (let index = 0; index < total; index += 1) {
        drawing.fillStyle = '#fbfaf6';
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.fillStyle = '#222';
        drawing.font = '22px sans-serif';
        for (let line = 0; line < 60; line += 1) drawing.fillText(`${line + 1}. Berechne die Ableitung von f(x) = ${line + index}x^3 und skizziere den Graphen.`, 90, 120 + line * 25);
        const grain = drawing.getImageData(0, 0, canvas.width, canvas.height);
        let state = 0x1234567 + index;
        for (let offset = 0; offset < grain.data.length; offset += 4) {
          state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
          const noise = ((state >>> 0) % 25) - 12;
          grain.data[offset] += noise; grain.data[offset + 1] += noise; grain.data[offset + 2] += noise;
        }
        drawing.putImageData(grain, 0, 0);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let start = 0; start < buffer.length; start += 0x8000) binary += String.fromCharCode(...buffer.subarray(start, start + 0x8000));
        out.push(btoa(binary));
      }
      return out;
    }, count);
    return encoded.map((value) => Buffer.from(value, 'base64'));
  } finally {
    await spare.close();
  }
}

/** A scanned worksheet: one full-page JPEG per page plus a line of text, like a photocopied printout. */
async function worksheetPdf(context, pages) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const scans = await scanJpegs(context, pages);
  for (let page = 0; page < pages; page += 1) {
    const sheet = pdf.addPage([595, 842]);
    sheet.drawImage(await pdf.embedJpg(scans[page]), { x: 0, y: 0, width: 595, height: 842 });
    sheet.drawText(`Arbeitsblatt Seite ${page + 1}`, { x: 50, y: 800, size: 14, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return Buffer.from(await pdf.save());
}

/** Inserts a multi-page PDF as printouts on the open page and times the import (render, encode, store). */
async function importPdf(context, page, pages) {
  const buffer = await worksheetPdf(context, pages);
  const before = await counters(page);
  const start = await page.evaluate(() => performance.now());
  await page.locator('input[type="file"][accept*="application/pdf"]').setInputFiles({ name: 'arbeitsblatt.pdf', mimeType: 'application/pdf', buffer });
  await page.getByText(`${pages} PDF-Seiten als Ausdruck eingefügt.`).waitFor({ timeout: 180_000 });
  const end = await page.evaluate(() => performance.now());
  const tasks = await page.evaluate((from) => (window.__benchLongTasks ?? []).filter((task) => task.start + task.duration >= from), start);
  return {
    ms: Math.round(end - start),
    blockedMs: Math.round(tasks.reduce((total, task) => total + Math.max(0, task.duration - 50), 0)),
    longestTaskMs: Math.round(Math.max(0, ...tasks.map((task) => task.duration))),
    counters: subtract(await counters(page), before),
  };
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
    return `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop() ?? ''}:${frame.lineNumber + 1}`;
  };
  for (const id of profile.samples) {
    const key = name(nodes.get(id));
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
  return { self: top(self, 25), total: top(total, 40) };
}

async function run(browser, port) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(PROBE);
  const browserCdp = await browser.newBrowserCDPSession();
  try {
    const seeder = await context.newPage();
    const { pages } = await seedIndexedDb(seeder, port);
    await seeder.close();
    const first = pages[0];
    const byId = (id) => {
      const found = pages.find((page) => page.pageId === id);
      if (!found) throw new Error(`The seed has no page ${id}; see the header of this script for its options.`);
      return found;
    };
    const heavy = byId('bm-heavy');
    const worksheet = byId('bm-worksheet');
    const photos = byId('bm-photos');

    const warm = await context.newPage();
    const warmCdp = await context.newCDPSession(warm);
    await warmCdp.send('Performance.enable');
    await warm.goto(`http://127.0.0.1:${port}/app`);
    await waitForTitle(warm, first.title);
    await waitForQuiet(warmCdp);
    await warm.close();

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`http://127.0.0.1:${port}/app`);
    await waitForTitle(page, first.title);
    await waitForQuiet(cdp);
    const memoryIdle = await memory(browserCdp, cdp);

    if (profilePath) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
      const profiled = await openPage(page, heavy, PRINTOUTS);
      const { profile } = await cdp.send('Profiler.stop');
      await writeFile(profilePath, JSON.stringify(profile));
      const summary = summarizeProfile(profile);
      process.stderr.write(`\nself time:\n${summary.self.join('\n')}\n\ntotal time:\n${summary.total.join('\n')}\n\n`);
      return { profiled };
    }
    const result = { memory: { idle: memoryIdle }, errors };
    const backToFirst = async () => {
      await page.locator(`[data-page-row-id="${first.pageId}"] .page-row__target`).first().click();
      await waitForTitle(page, first.title);
      await waitForQuiet(cdp);
    };

    if (only.has('sheet')) {
      result.sheetOpen = await openPage(page, worksheet, PRINTOUTS);
      await waitForQuiet(cdp);
      result.memory.sheet = await memory(browserCdp, cdp);
      result.sheetScroll = await frames(page, 'scroll', 120);
      result.sheetZoom = await frames(page, 'zoom', 80);
      await frames(page, 'scrollUp', 200);
      await waitForQuiet(cdp);
      result.memory.sheetScrolled = await memory(browserCdp, cdp);
      await backToFirst();
      result.sheetReopen = await openPage(page, worksheet, PRINTOUTS);
      await waitForQuiet(cdp);
    }
    if (only.has('heavy')) {
      if (only.has('sheet')) await backToFirst();
      result.open = await openPage(page, heavy, PRINTOUTS);
      await waitForQuiet(cdp);
      result.memory.heavy = await memory(browserCdp, cdp);
      result.scroll = await frames(page, 'scroll', 120);
      result.ink = await drawStroke(page);
    }
    if (only.has('photos')) {
      result.photoOpen = await openPage(page, photos, PHOTOS);
      await waitForQuiet(cdp);
      result.memory.photos = await memory(browserCdp, cdp);
      result.photoScroll = await frames(page, 'scroll', 60);
      await backToFirst();
      result.memory.away = await memory(browserCdp, cdp);
      result.photoReopen = await openPage(page, photos, PHOTOS);
    }
    if (only.has('pdf')) {
      if (only.has('photos')) await backToFirst();
      result.pdfImport = await importPdf(context, page, 24);
    }
    result.errors = errors.slice(0, 3);
    return result;
  } finally {
    await context.close();
  }
}

const servers = await Promise.all(variants.map((variant) => serve(variant.dist, variant.port)));
const browser = await chromium.launch();

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function summarize(results) {
  const pick = (path) => {
    const values = results.map((result) => path.reduce((value, key) => value?.[key], result));
    return values.every((value) => typeof value === 'number') ? median(values) : undefined;
  };
  const table = {};
  for (const [prefix, key] of [['sheet', 'sheetOpen'], ['sheetReopen', 'sheetReopen'], ['heavy', 'open'], ['photo', 'photoOpen'], ['photoReopen', 'photoReopen']]) {
    for (const metric of ['firstMs', 'sharpMs', 'allLoadedMs', 'blockedMs', 'longestTaskMs']) table[`${prefix}.${metric}`] = [key, metric];
    for (const counter of ['objectUrls', 'digests', 'digestBytes', 'bitmaps']) table[`${prefix}.${counter}`] = [key, 'counters', counter];
  }
  for (const [prefix, key] of [['sheetScroll', 'sheetScroll'], ['sheetZoom', 'sheetZoom'], ['heavyScroll', 'scroll'], ['photoScroll', 'photoScroll']]) {
    for (const metric of ['p50', 'p95', 'worst', 'over33']) table[`${prefix}.${metric}`] = [key, metric];
  }
  for (const metric of ['ms', 'blockedMs', 'longestTaskMs']) table[`pdfImport.${metric}`] = ['pdfImport', metric];
  table['pdfImport.digests'] = ['pdfImport', 'counters', 'digests'];
  table['pdfImport.digestMb'] = ['pdfImport', 'counters', 'digestBytes'];
  table['ink.blockedMs'] = ['ink', 'blockedMs'];
  table['ink.objectUrls'] = ['ink', 'counters', 'objectUrls'];
  for (const stage of ['idle', 'sheet', 'sheetScrolled', 'heavy', 'photos', 'away']) {
    for (const [metric, field] of [['rendererMb', 'rendererMb'], ['gpuMb', 'gpuMb'], ['heapMb', 'jsHeapMb']]) table[`mem.${stage}.${metric}`] = ['memory', stage, field];
  }
  const summary = {};
  for (const [name, path] of Object.entries(table)) {
    const value = pick(path);
    if (value === undefined) continue;
    summary[name] = name.endsWith('digestBytes') || name.endsWith('digestMb') ? Math.round(value / 1024 / 1024) : value;
  }
  return summary;
}

try {
  const results = new Map(variants.map((variant) => [variant.name, []]));
  for (let index = 0; index < runs; index += 1) {
    for (const variant of variants) {
      const result = await run(browser, variant.port);
      process.stderr.write(`${variant.name} run ${index + 1}: ${JSON.stringify(result)}\n`);
      results.get(variant.name).push(result);
    }
  }
  if (profilePath) {
    process.stdout.write(`${JSON.stringify(results.get(variants[0].name)[0])}\n`);
    process.exit(0);
  }
  const out = {};
  for (const variant of variants) {
    const own = results.get(variant.name);
    out[variant.name] = { runs: own.length, median: summarize(own), results: own };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
} finally {
  await browser.close();
  for (const server of servers) server.close();
}
