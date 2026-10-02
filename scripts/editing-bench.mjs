#!/usr/bin/env node
/**
 * Measures editing responsiveness, the save path and memory on synthetic
 * seeded workspaces (scripts/bench/seed-workspace.ts): key-to-paint latency
 * while typing in a text box, storage writes per keystroke, selecting, moving
 * and resizing a text box, lasso-moving strokes, undo/redo of large
 * operations, pasting, and memory after many page switches.
 *
 *   pnpm exec vite build --config scripts/bench/vite.seed.config.mjs
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/edit-seed \
 *     --pages 8 --strokes 800 --images 6 --sections 2 --heavy 7000 --heavy-images 8 --heavy-pages 10
 *   VITE_CANVINK_ALLOW_FEATURE_OVERRIDE=1 pnpm exec vite build --outDir /tmp/edit-dist
 *   node scripts/editing-bench.mjs --dist /tmp/edit-dist --seed /tmp/edit-seed --label after
 *
 * `--scenarios typing,math,ink,interaction,lasso,paste,memory` picks scenarios (all by
 * default), `--runs` repeats each one in a new tab of the same browser profile
 * (`--profiles` repeats the whole thing on fresh profiles). `--profile <file>`
 * writes a V8 CPU profile of `--profile-scenario` (typing by default; on
 * `--profile-page light|heavy` for typing) and prints its hottest functions.
 * The summary line takes medians over runs.
 */
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
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
const port = Number(args.port ?? 4421);
const label = args.label ?? 'build';
const runs = Number(args.runs ?? 3);
const profiles = Number(args.profiles ?? 1);
const scenarios = (args.scenarios ?? 'typing,math,ink,interaction,lasso,paste,memory').split(',');
const profilePath = args.profile;
const profileScenario = args['profile-scenario'] ?? 'typing';
const profilePage = args['profile-page'] ?? 'heavy';
/** Paragraphs already in the text box before typing starts (`--preload-paragraphs`). */
const preloadParagraphs = Number(args['preload-paragraphs'] ?? 0);
const switches = Number(args.switches ?? 30);
const sampleEvery = Number(args['sample-every'] ?? 10);

/** V8 CPU profile of the part of a scenario between `start()` and `stop()`. */
const profiler = {
  active: false,
  cdp: undefined,
  async start(cdp) {
    if (!this.active) return;
    this.cdp = cdp;
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  },
  async stop() {
    if (!this.cdp) return;
    const { profile } = await this.cdp.send('Profiler.stop');
    this.cdp = undefined;
    await writeFile(profilePath, JSON.stringify(profile));
    const summary = summarizeProfile(profile);
    process.stderr.write(`\nself time:\n${summary.self.join('\n')}\n\ntotal time:\n${summary.total.join('\n')}\n\n`);
  },
};

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

/**
 * Probes installed before the app starts:
 * - long tasks;
 * - key-to-paint latency: from the moment the browser received a keydown
 *   (`event.timeStamp`, so main-thread queueing counts) to a message task
 *   posted from the next animation frame, which runs after that frame paints;
 * - the same for pointer moves during a drag;
 * - frame intervals while `__benchFrames.start()` runs;
 * - IndexedDB writes (transactions, puts and their bytes, by kind);
 * - live object URLs.
 */
const PROBE = `(() => {
  const tasks = [];
  window.__benchLongTasks = tasks;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}

  const afterPaint = (callback) => requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => callback(performance.now());
    channel.port2.postMessage(0);
  });
  const keys = [];
  window.__benchKeys = keys;
  addEventListener('keydown', (event) => {
    const entry = { key: event.key, start: event.timeStamp, ms: -1 };
    keys.push(entry);
    afterPaint((now) => { entry.ms = now - entry.start; });
  }, true);
  const downs = [];
  window.__benchDowns = downs;
  addEventListener('pointerdown', (event) => {
    const entry = { start: event.timeStamp, ms: -1 };
    downs.push(entry);
    afterPaint((now) => { entry.ms = now - entry.start; });
  }, true);
  const ups = [];
  window.__benchUps = ups;
  addEventListener('pointerup', (event) => {
    const entry = { start: event.timeStamp, ms: -1 };
    ups.push(entry);
    afterPaint((now) => { entry.ms = now - entry.start; });
  }, true);
  const moves = [];
  window.__benchMoves = moves;
  addEventListener('pointermove', (event) => {
    if (event.buttons === 0) return;
    const entry = { start: event.timeStamp, ms: -1 };
    moves.push(entry);
    afterPaint((now) => { entry.ms = now - entry.start; });
  }, true);

  const frames = { times: [], running: false };
  window.__benchFrames = {
    start() {
      frames.times = [];
      frames.running = true;
      let last = performance.now();
      const tick = (now) => {
        if (!frames.running) return;
        frames.times.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    stop() {
      frames.running = false;
      return frames.times.slice(2);
    },
  };

  const idb = { transactions: 0, puts: 0, deletes: 0, bytes: 0, saves: 0, compactions: 0, markers: 0, index: 0, history: 0, other: 0 };
  window.__benchIdb = idb;
  const sizeOf = (value) => {
    if (value instanceof Uint8Array) return value.byteLength;
    if (value && value.bytes instanceof Uint8Array) return value.bytes.byteLength;
    try { return JSON.stringify(value).length; } catch { return 0; }
  };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    idb.puts += 1;
    idb.bytes += sizeOf(value);
    // Repo chunks are [namespace, documentId, 'incremental' | 'snapshot', hash];
    // their dirty markers [namespace, documentId, 'incremental:hash'].
    const parts = Array.isArray(key) ? key.map(String) : [String(key ?? '')];
    const kind = parts[parts.length - 2];
    if (kind === 'incremental') idb.saves += 1;
    else if (kind === 'snapshot') idb.compactions += 1;
    else if (/^(incremental|snapshot):/.test(parts[parts.length - 1])) idb.markers += 1;
    else if (parts[0].includes('page-index') || parts[0].includes('index')) idb.index += 1;
    else if (parts[0].startsWith('history-snapshot')) idb.history += 1;
    else idb.other += 1;
    return put.call(this, value, key);
  };
  const del = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function (key) {
    idb.deletes += 1;
    return del.call(this, key);
  };
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    if (mode === 'readwrite') idb.transactions += 1;
    return transaction.call(this, stores, mode, options);
  };

  const urls = { created: 0, revoked: 0 };
  window.__benchUrls = urls;
  const create = URL.createObjectURL;
  URL.createObjectURL = function (blob) { urls.created += 1; return create.call(this, blob); };
  const revoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) { urls.revoked += 1; return revoke.call(this, url); };
})();`;

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};
const percentile = (values, fraction) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : NaN;
};
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForQuiet(cdp, cap = 300_000) {
  const started = Date.now();
  let previous;
  while (Date.now() - started < cap) {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const task = metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0;
    if (previous !== undefined && task - previous < 0.05) return Date.now() - started;
    previous = task;
    await sleep(1000);
  }
  return -1;
}

async function taskDuration(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { task: get('TaskDuration'), script: get('ScriptDuration'), layout: get('LayoutDuration'), style: get('RecalcStyleDuration') };
}

async function waitForTitle(page, title) {
  await page.waitForFunction(
    (expected) => document.querySelector('input[aria-label="Seitentitel"]')?.value === expected,
    title,
    { timeout: 300_000, polling: 'raf' },
  );
}

/** Clicks a page row and waits until the page is loaded and every stroke is painted. */
async function openPage(page, info) {
  await page.locator(`[data-page-row-id="${info.pageId}"] .page-row__target`).first().click();
  await page.waitForFunction(({ title, strokes }) => {
    if (document.querySelector('input[aria-label="Seitentitel"]')?.value !== title) return false;
    if (document.querySelector('[data-page-loading]')) return false;
    return Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0) >= strokes;
  }, { title: info.title, strokes: info.strokes }, { timeout: 300_000, polling: 'raf' });
}

async function settle(page, cdp) {
  await waitForQuiet(cdp);
  await page.waitForFunction(() => document.querySelectorAll('[data-search-indexing]').length === 0, null, { timeout: 300_000 });
}

async function resetProbes(page) {
  await page.evaluate(() => {
    window.__benchKeys.length = 0;
    window.__benchMoves.length = 0;
    window.__benchDowns.length = 0;
    window.__benchUps.length = 0;
    for (const key of Object.keys(window.__benchIdb)) window.__benchIdb[key] = 0;
    window.__benchMark = performance.now();
  });
}

async function readProbes(page) {
  return page.evaluate(() => {
    const from = window.__benchMark;
    const tasks = window.__benchLongTasks.filter((task) => task.start + task.duration >= from);
    return {
      keys: window.__benchKeys.filter((entry) => entry.ms >= 0).map((entry) => entry.ms),
      moves: window.__benchMoves.filter((entry) => entry.ms >= 0).map((entry) => entry.ms),
      downs: window.__benchDowns.filter((entry) => entry.ms >= 0).map((entry) => entry.ms),
      ups: window.__benchUps.filter((entry) => entry.ms >= 0).map((entry) => entry.ms),
      idb: { ...window.__benchIdb },
      longTasks: tasks.map((task) => task.duration),
    };
  });
}

function latencySummary(values) {
  return { n: values.length, p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), max: round(Math.max(0, ...values)) };
}

function frameSummary(times) {
  return {
    frames: times.length,
    p50: round(percentile(times, 0.5)),
    p95: round(percentile(times, 0.95)),
    max: round(Math.max(0, ...times)),
    over33: times.filter((time) => time > 33.4).length,
  };
}

const TYPED = 'Die Ableitung der Funktion beschreibt die lokale Steigung des Graphen und wird mit dem Differenzenquotienten hergeleitet. ';

/**
 * Types into the first text box of the open page (one click selects and
 * focuses it), like a person at a steady pace.
 */
async function typingScenario(page, cdp, options = {}) {
  const box = page.locator('.live-canvas-element .canvink-rich-text-content').first();
  await box.click({ position: { x: 120, y: 12 } });
  await page.keyboard.press('Control+End');
  if (preloadParagraphs > 0) {
    await page.evaluate((paragraphs) => {
      const words = 'Algebra Vektor Funktion Ableitung Integral Matrix Gleichung Parabel'.split(' ');
      const text = Array.from({ length: paragraphs }, (_, index) => Array.from({ length: 24 }, (_, word) => words[(index + word) % words.length]).join(' ')).join('\n');
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.querySelector('.canvink-rich-text-content.ProseMirror-focused').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, preloadParagraphs);
    await sleep(1000);
  }
  await sleep(500);
  await waitForQuiet(cdp, 30_000);
  await resetProbes(page);
  const before = await taskDuration(cdp);
  const started = Date.now();
  if (options.profiled) await profiler.start(cdp);
  await page.keyboard.type(TYPED, { delay: 60 });
  const typingMs = Date.now() - started;
  const during = await taskDuration(cdp);
  if (options.profiled) await profiler.stop();
  const typed = await readProbes(page);
  // Let the debounced saves finish, then count what reached IndexedDB.
  await sleep(1500);
  const settled = await readProbes(page);
  const characters = TYPED.length;
  const result = {
    keyToPaintMs: latencySummary(typed.keys),
    longTasksMs: typed.longTasks.map((task) => round(task, 0)),
    mainThreadMsPerKey: round(((during.task - before.task) * 1000) / characters),
    scriptMsPerKey: round(((during.script - before.script) * 1000) / characters),
    idbPerKey: {
      transactions: round(settled.idb.transactions / characters, 2),
      puts: round(settled.idb.puts / characters, 2),
      kbPerKey: round(settled.idb.bytes / 1024 / characters, 2),
      saves: settled.idb.saves,
      compactions: settled.idb.compactions,
      historyWrites: settled.idb.history,
      indexWrites: settled.idb.index,
    },
    typingMs,
  };

  // The slash menu: opening it, filtering and choosing an entry. First let the
  // history check that follows a pause in editing finish.
  await waitForQuiet(cdp, 20_000);
  await resetProbes(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/', { delay: 60 });
  await page.getByRole('listbox', { name: 'Block einfügen' }).waitFor({ state: 'visible' });
  await page.keyboard.type('ueber', { delay: 60 });
  await page.keyboard.press('Enter');
  await sleep(600);
  const slash = await readProbes(page);
  result.slashMenuMs = latencySummary(slash.keys);
  // Deleting: backspace over the last typed characters.
  await page.keyboard.press('End');
  await waitForQuiet(cdp, 20_000);
  await resetProbes(page);
  const deleteBefore = await taskDuration(cdp);
  await page.keyboard.press('Backspace', { delay: 0 });
  for (let index = 0; index < 40; index += 1) {
    await sleep(60);
    await page.keyboard.press('Backspace');
  }
  const deleted = await readProbes(page);
  const deleteAfter = await taskDuration(cdp);
  result.backspaceMs = latencySummary(deleted.keys);
  result.mainThreadMsPerBackspace = round(((deleteAfter.task - deleteBefore.task) * 1000) / 41);
  await page.keyboard.press('Escape');
  return result;
}

/** Selecting strokes and text boxes, then moving and resizing a text box, on the open page. */
async function interactionScenario(page) {
  await page.keyboard.press('Escape');
  const click = async (point) => {
    await resetProbes(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
    await sleep(400);
    return (await readProbes(page)).downs[0] ?? -1;
  };
  // Selecting: a stroke (hit test among the page's strokes), then a text box.
  const strokes = await page.evaluate(() => window.__canvinkInk.strokes().slice(0, 40).map((stroke) => stroke.samplePoint));
  const strokeClicks = [];
  for (const point of strokes.filter((_, index) => index % 8 === 0).slice(0, 4)) strokeClicks.push(await click(point));
  await page.keyboard.press('Escape');
  const box = page.locator('.live-canvas-element .canvink-rich-text-content').first();
  const boxBounds = await box.boundingBox();
  const boxClick = await click({ x: boxBounds.x + 120, y: boxBounds.y + 12 });

  const drag = async (from, to, steps) => {
    await resetProbes(page);
    await page.evaluate(() => window.__benchFrames.start());
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= steps; step += 1) {
      await page.mouse.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
      await sleep(16);
    }
    await page.mouse.up();
    await sleep(400);
    const frames = await page.evaluate(() => window.__benchFrames.stop());
    const probes = await readProbes(page);
    return { frameMs: frameSummary(frames), pointerToPaintMs: latencySummary(probes.moves), longTasksMs: probes.longTasks.map((task) => round(task, 0)), idbKb: round(probes.idb.bytes / 1024, 1) };
  };
  // The move handle is the dotted strip above a selected text box.
  const element = page.locator('.live-canvas-element.is-selected').first();
  const bounds = await element.boundingBox();
  const handle = { x: bounds.x + bounds.width / 2, y: bounds.y - 3 };
  const moved = await drag(handle, { x: handle.x + 160, y: handle.y + 90 }, 30);
  const after = await element.boundingBox();
  const corner = { x: after.x + after.width, y: after.y + after.height };
  const resized = await drag(corner, { x: corner.x + 90, y: corner.y + 60 }, 30);
  return {
    selectStrokeMs: latencySummary(strokeClicks),
    selectTextBoxMs: round(boxClick),
    move: moved,
    resize: resized,
    movedBy: { x: round(after.x - bounds.x, 0), y: round(after.y - bounds.y, 0) },
  };
}

/** Lasso over the strokes of a zoomed-out page, dragging them, then undo, redo, delete and undo. */
async function lassoScenario(page, cdp) {
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /^Zeichnen$/ }).click();
  await page.getByRole('tabpanel', { name: /^Zeichnen$/ }).getByRole('button', { name: /^Lasso$/ }).click();
  const surface = page.getByLabel('Ansicht der Zeichenfläche');
  const area = await surface.boundingBox();
  // Zoom out to the minimum so that about 2,500 strokes are in view.
  await page.mouse.move(area.x + area.width / 2, area.y + 40);
  await page.keyboard.down('Control');
  for (let step = 0; step < 6; step += 1) {
    await page.mouse.wheel(0, 100);
    await sleep(120);
  }
  await page.keyboard.up('Control');
  await sleep(1500);
  const strokeCount = () => page.evaluate(() => Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0));
  const total = await strokeCount();
  const left = area.x + 10;
  const right = area.x + area.width - 10;
  const top = area.y + 10;
  const bottom = area.y + area.height - 10;
  await resetProbes(page);
  await page.evaluate(() => window.__benchFrames.start());
  await page.mouse.move(left, top);
  await page.mouse.down();
  for (const [x, y] of [[right, top], [right, bottom], [left, bottom], [left, top + 2]]) {
    await page.mouse.move(x, y, { steps: 6 });
  }
  const lassoStart = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.live-canvas-ink-selection') !== null, null, { timeout: 60_000, polling: 'raf' });
  const selectedMs = await page.evaluate((from) => performance.now() - from, lassoStart);
  const lassoFrames = frameSummary(await page.evaluate(() => window.__benchFrames.stop()));
  const lassoProbes = await readProbes(page);
  const selected = await page.locator('.live-canvas-ink-selection').count();

  if (process.env.BENCH_SHOTS) await page.screenshot({ path: `${process.env.BENCH_SHOTS}-lasso.png` });
  // The middle of the selection's bounds (its resize handles sit on the corners).
  const corners = await page.locator('.live-canvas-selection-resize__handle').evaluateAll((handles) => handles.map((handle) => {
    const box = handle.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }));
  const inside = {
    x: (Math.min(...corners.map((corner) => corner.x)) + Math.max(...corners.map((corner) => corner.x))) / 2,
    y: (Math.min(...corners.map((corner) => corner.y)) + Math.max(...corners.map((corner) => corner.y))) / 2,
  };
  await profiler.start(cdp);
  await resetProbes(page);
  await page.evaluate(() => window.__benchFrames.start());
  await page.mouse.move(inside.x, inside.y);
  await page.mouse.down();
  for (let step = 1; step <= 30; step += 1) {
    await page.mouse.move(inside.x + step * 2, inside.y + step);
    await sleep(16);
  }
  const dropAt = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await sleep(1200);
  const moveFrames = frameSummary(await page.evaluate(() => window.__benchFrames.stop()));
  const moveProbes = await readProbes(page);
  const dropTask = await page.evaluate((from) => Math.max(0, ...window.__benchLongTasks.filter((task) => task.start + task.duration >= from).map((task) => task.duration)), dropAt);

  // Undo and redo of the whole move (one operation over the selection), then
  // the largest operation: deleting the selection and bringing it back.
  const timeKey = async (combo, wait = 1500) => {
    await resetProbes(page);
    await page.keyboard.press(combo);
    await sleep(wait);
    const probes = await readProbes(page);
    return { keyToPaintMs: round(Math.max(0, ...probes.keys)), longestTaskMs: round(Math.max(0, ...probes.longTasks), 0), idbKb: round(probes.idb.bytes / 1024, 0) };
  };
  const undo = await timeKey('Control+z');
  const redo = await timeKey('Control+y');
  const before = await strokeCount();
  const del = await timeKey('Delete');
  const afterDelete = await strokeCount();
  const undoDelete = await timeKey('Control+z', 3000);
  const restored = await strokeCount();
  await profiler.stop();
  return {
    zoomedOutStrokes: total,
    selected,
    lasso: { frameMs: lassoFrames, selectedAfterMs: round(selectedMs, 0), longTasksMs: lassoProbes.longTasks.map((task) => round(task, 0)) },
    move: { frameMs: moveFrames, pointerToPaintMs: latencySummary(moveProbes.moves), dropLongestTaskMs: round(dropTask, 0), idbKb: round(moveProbes.idb.bytes / 1024, 0) },
    undo, redo, delete: del, undoDelete,
    strokes: { before, afterDelete, restored },
  };
}

/** A large text paste into the text box and a large image paste onto the canvas. */
async function pasteScenario(page, cdp) {
  await page.keyboard.press('Escape');
  const box = page.locator('.live-canvas-element .canvink-rich-text-content').first();
  await box.click({ position: { x: 120, y: 12 } });
  await page.keyboard.press('Control+End');
  await sleep(500);
  await resetProbes(page);
  await profiler.start(cdp);
  const chars = await page.evaluate(() => {
    const words = 'Algebra Vektor Funktion Ableitung Integral Matrix Gleichung Parabel'.split(' ');
    const paragraphs = Array.from({ length: 400 }, (_, index) => Array.from({ length: 24 }, (_, word) => words[(index + word) % words.length]).join(' '));
    const text = paragraphs.join('\n');
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const started = performance.now();
    document.querySelector('.canvink-rich-text-content.ProseMirror-focused').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    window.__benchPasteSync = performance.now() - started;
    window.__benchMark = started;
    return text.length;
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(); c.port2.postMessage(0); })));
  const textSync = await page.evaluate(() => window.__benchPasteSync);
  await sleep(1500);
  await profiler.stop();
  const text = await readProbes(page);
  const textResult = { chars, syncMs: round(textSync), longTasksMs: text.longTasks.map((task) => round(task, 0)), idb: text.idb };
  // Undo the paste so the page is as found.
  await page.keyboard.press('Control+z');
  await sleep(500);

  // Images come in through "Bild" in the insert ribbon (there is no image
  // paste on the canvas): a noisy 1600 x 1200 PNG of about 5 MB, like a photo.
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /^Einfügen$/ }).click();
  const imageCount = () => page.locator('.live-canvas-element[data-element-kind="image"]:not(.is-background)').count();
  const imagesBefore = await imageCount();
  await resetProbes(page);
  const startedAt = await page.evaluate(() => performance.now());
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: noisyPng(1600, 1200) });
  const paintedAt = await page.waitForFunction((count) => (
    document.querySelectorAll('.live-canvas-element[data-element-kind="image"]:not(.is-background)').length > count ? performance.now() : false
  ), imagesBefore, { timeout: 120_000, polling: 'raf' }).then((handle) => handle.jsonValue());
  await sleep(1500);
  const image = await readProbes(page);
  return {
    text: textResult,
    image: { toPaintMs: round(paintedAt - startedAt, 0), longTasksMs: image.longTasks.map((task) => round(task, 0)), idbKb: round(image.idb.bytes / 1024, 0) },
  };
}

/** A PNG of random noise (incompressible, like a photo). */
function noisyPng(width, height) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  let seed = 12345;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width * 3; x += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      raw[y * row + 1 + x] = seed >> 16;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    return Buffer.concat([length, body, Buffer.from(crc32(body))]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return out;
}

/** Drawing pen strokes on the open page: what pointer-up costs (the stroke is committed there). */
async function inkScenario(page, cdp) {
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /^Zeichnen$/ }).click();
  await page.getByRole('tabpanel', { name: /^Zeichnen$/ }).getByRole('button', { name: /^Stift$/, exact: true }).click();
  const surface = page.getByLabel('Ansicht der Zeichenfläche');
  const area = await surface.boundingBox();
  await waitForQuiet(cdp, 30_000);
  await resetProbes(page);
  const strokesBefore = await page.evaluate(() => Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0));
  const before = await taskDuration(cdp);
  const count = 8;
  for (let stroke = 0; stroke < count; stroke += 1) {
    const y = area.y + 120 + stroke * 40;
    await page.mouse.move(area.x + 700, y);
    await page.mouse.down();
    for (let step = 1; step <= 30; step += 1) {
      await page.mouse.move(area.x + 700 + step * 8, y + Math.sin(step / 3) * 12);
      await sleep(8);
    }
    await page.mouse.up();
    await sleep(350);
  }
  const during = await taskDuration(cdp);
  const probes = await readProbes(page);
  await sleep(1500);
  const settled = await readProbes(page);
  const strokesAfter = await page.evaluate(() => Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0));
  return {
    strokesDrawn: strokesAfter - strokesBefore,
    pointerUpToPaintMs: latencySummary(probes.ups),
    pointerToPaintMs: latencySummary(probes.moves),
    longTasksMs: probes.longTasks.map((task) => round(task, 0)),
    mainThreadMsPerStroke: round(((during.task - before.task) * 1000) / count),
    savesPerStroke: round(settled.idb.saves / count, 2),
    kbPerStroke: round(settled.idb.bytes / 1024 / count, 1),
  };
}

/**
 * Typing a formula into a Math block (MathLive): each input is one edit of
 * the block, after which the page's mathematics are recomputed.
 */
async function mathScenario(page, cdp) {
  await page.getByRole('tab', { name: /^Einfügen$/ }).click();
  await page.getByRole('tabpanel', { name: /^Einfügen$/ }).getByRole('button', { name: /^Mathe$/ }).click();
  const surface = page.getByLabel('Ansicht der Zeichenfläche');
  const area = await surface.boundingBox();
  await page.mouse.click(area.x + 140, area.y + 260);
  const field = page.locator('math-field.math-block__field').last();
  await field.waitFor({ state: 'visible' });
  const formula = '\\frac{x^2+3x-5}{2}=\\sqrt{x+1}';
  await sleep(800);
  await waitForQuiet(cdp, 30_000);
  await resetProbes(page);
  const before = await taskDuration(cdp);
  const started = Date.now();
  await profiler.start(cdp);
  const latencies = [];
  for (let end = 1; end <= formula.length; end += 1) {
    const latency = await field.evaluate((node, latex) => new Promise((resolve) => {
      const begin = performance.now();
      node.value = latex;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText' }));
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve(performance.now() - begin);
        channel.port2.postMessage(0);
      });
    }), formula.slice(0, end));
    latencies.push(latency);
    await sleep(60);
  }
  await profiler.stop();
  const during = await taskDuration(cdp);
  const typed = await readProbes(page);
  await sleep(2000);
  const settled = await readProbes(page);
  return {
    inputToPaintMs: latencySummary(latencies),
    longTasksMs: typed.longTasks.map((task) => round(task, 0)),
    mainThreadMsPerInput: round(((during.task - before.task) * 1000) / formula.length),
    idbPerInput: {
      transactions: round(settled.idb.transactions / formula.length, 2),
      puts: round(settled.idb.puts / formula.length, 2),
      saves: settled.idb.saves,
    },
    durationMs: Date.now() - started,
  };
}

/** Heap, DOM and renderer memory after garbage collection. */
async function memorySample(page, cdp, browserCdp) {
  // Objects held by weak references and finalizers go a task after a collection.
  for (let pass = 0; pass < 3; pass += 1) {
    await cdp.send('HeapProfiler.collectGarbage');
    await sleep(300);
  }
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  // `Nodes` counts every live DOM node, attached or not; the difference to
  // the nodes reachable from the document is what JavaScript still holds.
  const attached = await page.evaluate(() => {
    let count = 0;
    const visit = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
      for (let node = walker.currentNode; node; node = walker.nextNode()) {
        count += 1;
        if (node instanceof Element && node.shadowRoot) visit(node.shadowRoot);
      }
    };
    visit(document);
    return count;
  });
  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length);
  let liveCanvases = -1;
  try {
    const prototype = await cdp.send('Runtime.evaluate', { expression: 'HTMLCanvasElement.prototype' });
    const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
    const length = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true });
    liveCanvases = length.result.value;
    await cdp.send('Runtime.releaseObject', { objectId: objects.objects.objectId });
  } catch { /* not available */ }
  let rssMb = -1;
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const renderers = processInfo.filter((info) => info.type === 'renderer');
    const sizes = await Promise.all(renderers.map(async (info) => {
      const status = await readFile(`/proc/${info.id}/status`, 'utf8');
      return Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0) / 1024;
    }));
    rssMb = Math.max(0, ...sizes);
  } catch { /* not Linux */ }
  const page$ = await page.evaluate(() => ({ urls: { ...window.__benchUrls }, listeners: 0 }));
  return {
    heapMb: round(get('JSHeapUsedSize') / 1048576),
    nodes: get('Nodes'),
    detachedNodes: get('Nodes') - attached,
    listeners: get('JSEventListeners'),
    documents: get('Documents'),
    canvasesInDom: canvases,
    canvasesLive: liveCanvases,
    liveObjectUrls: page$.urls.created - page$.urls.revoked,
    rendererRssMb: round(rssMb, 0),
  };
}

async function memoryScenario(page, cdp, browserCdp, pages) {
  const heavy = pages.filter((info) => info.pageId.startsWith('bm-heavy'));
  const light = pages.find((info) => info.pageId === 'bm-page-0');
  const samples = { start: await memorySample(page, cdp, browserCdp) };
  await openPage(page, heavy[0]);
  await waitForQuiet(cdp, 60_000);
  samples.firstHeavy = await memorySample(page, cdp, browserCdp);
  for (let step = 0; step < switches; step += 1) {
    await openPage(page, heavy[step % heavy.length]);
    await sleep(150);
    if ((step + 1) % sampleEvery === 0) {
      await waitForQuiet(cdp, 60_000);
      samples[`after${step + 1}`] = await memorySample(page, cdp, browserCdp);
    }
  }
  await openPage(page, light);
  await waitForQuiet(cdp, 60_000);
  samples.backOnLight = await memorySample(page, cdp, browserCdp);
  return samples;
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
  return { self: top(self, 30), total: top(total, 50) };
}

/**
 * A fresh browser profile with the seed loaded and the first start done (page
 * and search indexes built), so scenarios measure editing and not indexing.
 */
async function startProfile(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(PROBE);
  const seeder = await context.newPage();
  const { pages } = await seedIndexedDb(seeder);
  await seeder.close();
  const warm = await context.newPage();
  const warmCdp = await context.newCDPSession(warm);
  await warmCdp.send('Performance.enable');
  await warm.goto(`http://127.0.0.1:${port}/app`);
  await waitForTitle(warm, pages[0].title);
  await waitForQuiet(warmCdp);
  await warm.close();
  return { context, pages };
}

/** A new tab on the first page; nothing of an earlier scenario stays in memory. */
async function openTab(context, pages, query = '') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(`http://127.0.0.1:${port}/app${query}`);
  // The app reopens the page last viewed on this device, so a new tab does
  // not necessarily open on the first page.
  try {
    await page.waitForFunction(() => Boolean(document.querySelector('input[aria-label="Seitentitel"]')?.value), null, { timeout: 60_000, polling: 'raf' });
  } catch (error) {
    const shown = await page.locator('body').innerText().catch(() => '');
    throw new Error(`The app did not open a page: ${shown.slice(0, 300).replace(/\s+/g, ' ')}`, { cause: error });
  }
  await settle(page, cdp);
  return { page, cdp, errors };
}

async function runScenario(browser, context, pages, name) {
  const { page, cdp, errors } = await openTab(context, pages, name === 'math' ? '?__canvinkFeatureMath=1' : '');
  profiler.active = Boolean(profilePath) && name === profileScenario;
  const browserCdp = await browser.newBrowserCDPSession();
  try {
    const light = pages.find((info) => info.pageId === 'bm-page-0');
    const heavy = pages.find((info) => info.pageId === 'bm-heavy');
    const output = {};
    await openPage(page, light);
    await settle(page, cdp);
    if (name === 'typing') {
      output.light = await typingScenario(page, cdp, { profiled: profilePage === 'light' });
      await openPage(page, heavy);
      await settle(page, cdp);
      output.heavy = await typingScenario(page, cdp, { profiled: profilePage === 'heavy' });
    } else if (name === 'interaction' || name === 'lasso') {
      await openPage(page, heavy);
      await settle(page, cdp);
      output.heavy = await (name === 'lasso' ? lassoScenario : interactionScenario)(page, cdp);
    } else if (name === 'paste') {
      await openPage(page, light);
      await settle(page, cdp);
      output.light = await pasteScenario(page, cdp);
      await openPage(page, heavy);
      await settle(page, cdp);
      output.heavy = await pasteScenario(page, cdp);
    } else if (name === 'ink') {
      output.light = await inkScenario(page, cdp);
      await openPage(page, heavy);
      await settle(page, cdp);
      output.heavy = await inkScenario(page, cdp);
    } else if (name === 'math') {
      output.light = await mathScenario(page, cdp);
      await openPage(page, heavy);
      await settle(page, cdp);
      output.heavy = await mathScenario(page, cdp);
    } else if (name === 'memory') {
      output.samples = await memoryScenario(page, cdp, browserCdp, pages);
    }
    output.errors = errors.slice(0, 3);
    return output;
  } finally {
    // The next tab reopens the page last viewed: leave the light one.
    await openPage(page, pages.find((info) => info.pageId === 'bm-page-0')).catch(() => undefined);
    await browserCdp.detach().catch(() => undefined);
    await page.close();
  }
}

/** Every number of a result by its path; a list of durations becomes its maximum and count. */
function flatten(value, path = '', out = {}) {
  if (typeof value === 'number') out[path] = value;
  else if (Array.isArray(value)) {
    out[`${path}.max`] = Math.max(0, ...value);
    out[`${path}.count`] = value.length;
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) flatten(item, path ? `${path}.${key}` : key, out);
  }
  return out;
}

function medianOfRuns(results) {
  const flat = results.map((result) => flatten(result));
  return Object.fromEntries(Object.keys(flat[0] ?? {}).map((key) => [key, round(median(flat.map((entry) => entry[key])), 2)]));
}

const server = await serve(dist);
const browser = await chromium.launch();
try {
  const summary = { label, profiles, runs, scenarios: Object.fromEntries(scenarios.map((name) => [name, []])) };
  for (let profileIndex = 0; profileIndex < profiles; profileIndex += 1) {
    const { context, pages } = await startProfile(browser);
    try {
      // Every run is a new tab on the same profile: the seed is loaded and
      // indexed once, and nothing of an earlier run stays in memory.
      for (let run = 1; run <= runs; run += 1) {
        for (const name of scenarios) {
          const started = Date.now();
          const result = await runScenario(browser, context, pages, name);
          process.stderr.write(`${label} ${name} profile ${profileIndex + 1} run ${run} (${Math.round((Date.now() - started) / 1000)} s): ${JSON.stringify(result)}\n`);
          summary.scenarios[name].push(result);
        }
      }
    } finally {
      await context.close();
    }
  }
  summary.median = Object.fromEntries(Object.entries(summary.scenarios).map(([name, results]) => [name, medianOfRuns(results)]));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  await browser.close();
  server.close();
}
