#!/usr/bin/env node
/**
 * Measures Canvink's app shell on a synthetic workspace: cold and warm start,
 * repeat loads through the service worker, and the interactions of the
 * navigation (notebook and page switches, folding, scrolling, typing in the
 * page title, drag and drop, context menus, search box, ribbon tabs).
 *
 *   pnpm exec vite build --config scripts/bench/vite.seed.config.mjs
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/seed --pages 400 --strokes 60000 \
 *     --images 200 --sections 24 --groups 6 --extra-notebooks 2 --extra-pages 20
 *   pnpm exec vite build --outDir /tmp/dist
 *   pnpm exec vite build --minify false --outDir /tmp/dist-inst
 *   node scripts/shell-bench.mjs --dist /tmp/dist --inst /tmp/dist-inst --seed /tmp/seed --label after
 *
 * Timings come from `--dist` (a normal production build). Commit counts and the
 * names of re-rendered components come from `--inst`, an unminified production
 * build that a React DevTools-style hook observes: a component counts as
 * rendered when a commit created its fiber and React ran its function.
 *
 * The static server compresses like Cloudflare does and honours the build's
 * `_headers` file, so caching rules are part of what is measured; `--latency`
 * (ms) adds a round trip per request, `--bandwidth` (Mbit/s) caps the link all
 * responses share, and `--cache revalidate|immutable` picks the rules for
 * builds without a `_headers` file (Cloudflare's default is to revalidate every
 * asset on every load). `--only cold,warm,sw,interactions` picks scenarios.
 */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const dist = args.dist;
const instDist = args.inst;
const seedDir = args.seed;
if (!dist || !seedDir) throw new Error('--dist <vite build> and --seed <seed directory> are required');
const label = args.label ?? 'build';
const runs = Number(args.runs ?? 7);
const latencyMs = Number(args.latency ?? 0);
// Shared link speed in Mbit/s (all responses queue on it); 0 means unlimited.
const bandwidthMbps = Number(args.bandwidth ?? 0);
const cacheMode = args.cache ?? 'revalidate';
const only = args.only ? args.only.split(',') : undefined;
const wants = (name) => !only || only.includes(name);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.webmanifest']);

/** Cloudflare's `_headers` syntax: an unindented path pattern, then indented `Name: value` lines. */
function parseHeadersFile(text) {
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push({ pattern: line.trim(), headers: {} });
    else if (rules.length) {
      const [name, ...rest] = line.trim().split(':');
      rules[rules.length - 1].headers[name.trim().toLowerCase()] = rest.join(':').trim();
    }
  }
  return rules.map((rule) => ({
    ...rule,
    regex: new RegExp(`^${rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
  }));
}

async function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else files.push(relative);
  }
  return files;
}

/** Reads a build into memory with Brotli copies and ETags. */
async function loadBuild(root) {
  const files = new Map();
  for (const path of await listFiles(root)) {
    const body = await readFile(join(root, path));
    const extension = extname(path);
    const compressed = COMPRESSIBLE.has(extension)
      ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
      : undefined;
    files.set(path, {
      body, compressed, type: MIME[extension] ?? 'application/octet-stream',
      etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
    });
  }
  const headerRules = files.has('/_headers') ? parseHeadersFile(files.get('/_headers').body.toString('utf8')) : [];
  return { files, headerRules };
}

const link = { freeAt: 0 };

/** Writes a response body, paced so that all responses together stay within `--bandwidth`. */
async function send(response, payload) {
  if (!bandwidthMbps) {
    response.end(payload);
    return;
  }
  const bytesPerMs = (bandwidthMbps * 1000) / 8;
  const step = 16 * 1024;
  for (let offset = 0; offset < payload.length; offset += step) {
    const part = payload.subarray(offset, offset + step);
    const now = Date.now();
    link.freeAt = Math.max(link.freeAt, now) + part.length / bytesPerMs;
    const wait = link.freeAt - now;
    if (wait > 1) await new Promise((resolve) => setTimeout(resolve, wait));
    response.write(part);
  }
  response.end();
}

/**
 * Serves a build like Cloudflare's static assets: Brotli, ETag, SPA fallback,
 * `_headers`. One origin serves every build (`site.load` swaps it), so the
 * seeded IndexedDB stays valid for the instrumented build too.
 */
async function serve(port, seed) {
  const site = { build: undefined, served: [], load: async (root) => { site.build = await loadBuild(root); } };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://x');
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    if (url.pathname === '/__bench/blank') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>seed</title>');
      return;
    }
    if (url.pathname === '/__bench/seed.json' || url.pathname === '/__bench/seed.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(await readFile(join(seed, url.pathname.slice('/__bench/'.length))));
      return;
    }
    const { files, headerRules } = site.build;
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let key = path;
    if (!files.has(key) || key === '/') key = files.has(`${path}/index.html`) ? `${path}/index.html` : '/index.html';
    const file = files.get(key);
    const headers = { 'content-type': file.type, etag: file.etag, vary: 'accept-encoding' };
    const rule = headerRules.filter((candidate) => candidate.regex.test(path)).reduce((all, candidate) => ({ ...all, ...candidate.headers }), {});
    const hashed = /\/assets\/.*-[A-Za-z0-9_-]{8,}\.\w+$/.test(path);
    headers['cache-control'] = rule['cache-control']
      ?? (cacheMode === 'immutable' && hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
    if (request.headers['if-none-match'] === file.etag) {
      response.writeHead(304, headers);
      response.end();
      site.served.push({ path, status: 304, bytes: 0 });
      return;
    }
    const useBrotli = file.compressed && String(request.headers['accept-encoding'] ?? '').includes('br');
    if (useBrotli) headers['content-encoding'] = 'br';
    const payload = useBrotli ? file.compressed : file.body;
    response.writeHead(200, headers);
    await send(response, payload);
    site.served.push({ path, status: 200, bytes: payload.length });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  site.server = server;
  return site;
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN;
};
const round = (value, digits = 0) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value);

/**
 * Before any app code: paint and long-task observers, the timing helper the
 * interactions use, and (with the instrumented build) a React DevTools-style
 * hook that counts commits and the components each one re-rendered.
 */
const PAGE_PROBE = `(() => {
  const bench = { longTasks: [], lcp: 0, fcp: 0 };
  window.__bench = bench;
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) bench.longTasks.push({ start: entry.startTime, duration: entry.duration }); })
    .observe({ type: 'longtask', buffered: true });
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) bench.lcp = entry.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') bench.fcp = entry.startTime; })
    .observe({ type: 'paint', buffered: true });
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  bench.run = async (action, until, timeout = 30000) => {
    const t0 = performance.now();
    action();
    const sync = performance.now() - t0;
    while (!until()) {
      if (performance.now() - t0 > timeout) throw new Error('timeout: ' + until);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const cond = performance.now() - t0;
    await settle();
    const paint = performance.now() - t0;
    const blocking = bench.longTasks.filter((task) => task.start + task.duration >= t0 && task.start <= t0 + paint)
      .reduce((total, task) => total + Math.max(0, task.duration - 50), 0);
    return { sync, cond, paint, blocking };
  };
  bench.settle = settle;
  // Shell ready: the page list is there and the open page's title and ink are shown.
  const poll = () => {
    if (!bench.rowsAt && document.querySelector('.page-row')) bench.rowsAt = performance.now();
    const title = document.querySelector('input[aria-label="Seitentitel"]');
    const loading = document.querySelector('[data-page-loading]');
    const ink = document.querySelector('[data-ink-stroke-count]');
    if (!bench.readyAt && title && title.value && !loading && ink && Number(ink.getAttribute('data-ink-stroke-count')) > 0) {
      bench.readyAt = performance.now();
      return;
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
})();`;

const REACT_HOOK = `(() => {
  const RENDERING_TAGS = new Set([0, 1, 11, 14, 15]);
  const stats = { commits: 0, rendered: 0, mounted: 0, byName: {}, timeline: [], reasons: {}, mountedNames: {} };
  let previous = new WeakSet();
  const ownName = (fiber) => {
    const type = fiber.type;
    if (typeof type === 'function') return type.displayName || type.name;
    const inner = type && (type.type || type.render);
    return (type && type.displayName) || (inner && (inner.displayName || inner.name)) || '';
  };
  // Anonymous components (icons, inline arrows) are named after the nearest named ancestor.
  const nameOf = (fiber) => {
    for (let current = fiber; current; current = current.return) {
      const name = ownName(current);
      if (name) return current === fiber ? name : '(in ' + name + ')';
    }
    return 'Anonymous';
  };
  const hook = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(renderer) { const id = hook.renderers.size + 1; hook.renderers.set(id, renderer); return id; },
    checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const seen = new WeakSet();
      stats.commits += 1;
      const renderedBefore = stats.rendered;
      const mountedBefore = stats.mounted;
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        seen.add(fiber);
        if (RENDERING_TAGS.has(fiber.tag) && (fiber.flags & 1) && !previous.has(fiber)) {
          const name = nameOf(fiber);
          stats.rendered += 1;
          stats.byName[name] = (stats.byName[name] || 0) + 1;
          if (fiber.alternate === null) { stats.mounted += 1; stats.mountedNames[name] = (stats.mountedNames[name] || 0) + 1; }
          else if (fiber.tag === 0 || fiber.tag === 15 || fiber.tag === 14) {
            // Why it rendered: the props that changed, else its own state or a context.
            const before = fiber.alternate.memoizedProps || {};
            const after = fiber.memoizedProps || {};
            const changed = Object.keys(after).filter((key) => key !== 'children' && before[key] !== after[key]);
            const label = name + (changed.length ? '.' + changed.slice(0, 4).join(',') : '.(state or context)');
            stats.reasons[label] = (stats.reasons[label] || 0) + 1;
          }
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      previous = seen;
      stats.timeline.push([Math.round(performance.now()), stats.rendered - renderedBefore, stats.mounted - mountedBefore]);
    },
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true });
  window.__bench.takeCommits = () => {
    const top = Object.entries(stats.byName).sort((left, right) => right[1] - left[1]).slice(0, 8);
    const reasons = Object.entries(stats.reasons).sort((left, right) => right[1] - left[1]).slice(0, 40);
    const mountedTop = Object.entries(stats.mountedNames).sort((left, right) => right[1] - left[1]).slice(0, 12);
    const appMounts = stats.mountedNames.V2NotebookApp || 0;
    const result = { appMounts, commits: stats.commits, rendered: stats.rendered, mounted: stats.mounted, top, timeline: stats.timeline, reasons, mountedTop };
    stats.commits = 0; stats.rendered = 0; stats.mounted = 0; stats.byName = {}; stats.timeline = []; stats.reasons = {}; stats.mountedNames = {};
    return result;
  };
})();`;

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
    return { stats: seed.stats, pages: seed.pages, notebooks: seed.notebooks ?? ['bm'] };
  });
}

/** Waits until the page has done less than 5 % CPU work over a second. */
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
  return Number.NaN;
}

const metricOf = (metrics, name) => metrics.find((metric) => metric.name === name)?.value ?? Number.NaN;

/** One start of /app in a new tab until the open page is interactive; returns the load's numbers. */
async function measureStart(context, port, { clearCache, trace }) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (clearCache) await cdp.send('Network.clearBrowserCache');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const traceEvents = [];
  if (trace) {
    cdp.on('Tracing.dataCollected', (chunk) => traceEvents.push(...chunk.value));
    await cdp.send('Tracing.start', { categories: 'v8,v8.execute,devtools.timeline,disabled-by-default-v8.compile' }).catch(() => undefined);
  }
  await page.goto(`http://127.0.0.1:${port}/app`, { waitUntil: 'commit' });
  await page.waitForFunction('window.__bench && window.__bench.readyAt', undefined, { timeout: 120_000, polling: 25 });
  // Let post-ready work (search index, thumbnails) settle before reading totals.
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (trace) {
    const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end').catch(() => undefined);
    await Promise.race([complete, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  const { metrics } = await cdp.send('Performance.getMetrics');
  const result = await page.evaluate(() => {
    const bench = window.__bench;
    const resources = performance.getEntriesByType('resource');
    const sum = (predicate, field) => resources.filter(predicate).reduce((total, entry) => total + entry[field], 0);
    const isScript = (entry) => entry.name.endsWith('.js') || entry.name.endsWith('.mjs');
    const isCss = (entry) => entry.name.endsWith('.css');
    const beforeReady = bench.longTasks.filter((task) => task.start < bench.readyAt);
    return {
      readyMs: bench.readyAt, rowsMs: bench.rowsAt, fcpMs: bench.fcp, lcpMs: bench.lcp,
      longTasks: beforeReady.length, tbtMs: beforeReady.reduce((total, task) => total + Math.max(0, task.duration - 50), 0),
      jsFiles: resources.filter(isScript).length,
      jsKB: sum(isScript, 'decodedBodySize') / 1024, cssKB: sum(isCss, 'decodedBodySize') / 1024,
      wasmKB: sum((entry) => entry.name.endsWith('.wasm'), 'decodedBodySize') / 1024,
      wireKB: sum(() => true, 'transferSize') / 1024, requests: resources.length,
      swControlled: Boolean(navigator.serviceWorker?.controller),
      waterfall: resources.map((entry) => `${Math.round(entry.startTime)}-${Math.round(entry.responseEnd)} ${entry.name.split('/').pop()} ${Math.round(entry.transferSize / 1024)}KB`),
    };
  });
  let compileMs = Number.NaN;
  if (traceEvents.length) {
    // The time V8 spent compiling scripts on any thread, from its compile trace events.
    compileMs = traceEvents.filter((event) => event.ph === 'X' && /^v8\.(compile|compileModule|compileCode)$/i.test(event.name))
      .reduce((total, event) => total + event.dur / 1000, 0);
  }
  const values = {
    ...result, scriptMs: metricOf(metrics, 'ScriptDuration') * 1000, taskMs: metricOf(metrics, 'TaskDuration') * 1000,
    heapMB: metricOf(metrics, 'JSHeapUsedSize') / 1024 / 1024, compileMs, errors: errors.slice(0, 3),
  };
  await page.close();
  return values;
}

function summarize(samples) {
  const keys = Object.keys(samples[0]).filter((key) => typeof samples[0][key] === 'number' || typeof samples[0][key] === 'boolean');
  return Object.fromEntries(keys.map((key) => [key, round(median(samples.map((sample) => Number(sample[key]))), key === 'heapMB' ? 1 : 0)]));
}

/** Runs `action` (a function body) in the page `count` times and reports medians; `until` is an expression. */
async function timed(page, name, count, steps) {
  const samples = [];
  const commits = [];
  for (let index = 0; index < count; index += 1) {
    const step = steps(index);
    if (step.before) await step.before();
    await page.evaluate(() => window.__bench.takeCommits?.());
    const sample = await page.evaluate(
      ({ action, until }) => window.__bench.run(new Function(action), new Function(`return (${until});`)),
      { action: step.action, until: step.until },
    );
    samples.push(sample);
    commits.push(await page.evaluate(() => window.__bench.takeCommits?.() ?? null));
    if (step.after) await step.after();
    await page.waitForTimeout(step.pause ?? 150);
  }
  const withCommits = commits.filter(Boolean);
  const commitTotals = withCommits.length ? {
    commits: median(withCommits.map((entry) => entry.commits)),
    rendered: median(withCommits.map((entry) => entry.rendered)),
    mounted: median(withCommits.map((entry) => entry.mounted)),
    top: withCommits[Math.floor(withCommits.length / 2)].top.slice(0, 5).map(([componentName, times]) => `${componentName}x${times}`).join(' '),
    // [ms, rendered, mounted] per commit of the last run: shows double mounts and cascades.
    reasons: withCommits[Math.floor(withCommits.length / 2)].reasons.slice(0, 40).map(([label, times]) => `${label}x${times}`).join(' '),
    lastRunCommits: withCommits[withCommits.length - 1].timeline.map(([at, rendered, mounted], index, all) => [index === 0 ? 0 : at - all[0][0], rendered, mounted]),
  } : undefined;
  return {
    name, runs: count,
    syncMs: round(median(samples.map((sample) => sample.sync)), 1),
    paintMs: round(median(samples.map((sample) => sample.paint)), 1),
    worstPaintMs: round(Math.max(...samples.map((sample) => sample.paint)), 1),
    blockingMs: round(median(samples.map((sample) => sample.blocking)), 1),
    ...commitTotals,
  };
}

const ROWS = '.page-pane .page-row__target';
const SECTIONS = '.section-list .section-row > button';

async function interactionSuite(page, seeded, log) {
  const results = [];
  const record = async (name, count, steps) => {
    const result = await timed(page, name, count, steps);
    results.push(result);
    log(name, result);
  };
  const notebooks = ['bm', 'Heft 2', 'Heft 3'].slice(0, seeded.notebooks.length);
  const titleOf = (id) => (id === 'bm' ? 'bm' : id);

  // Light pages: the first section's pages, opened the first time (document
  // load from IndexedDB) and then again while they are in memory.
  const rowTitles = await page.$$eval(ROWS, (rows) => rows.map((row) => row.querySelector('.page-row__title')?.textContent ?? ''));
  const openRow = (index) => ({
    action: `document.querySelectorAll(${JSON.stringify(ROWS)})[${index}].click()`,
    until: `document.querySelector('input[aria-label="Seitentitel"]').value === ${JSON.stringify(rowTitles[index])} && !document.querySelector('[data-page-loading]')`,
  });
  const fresh = Math.min(rowTitles.length - 1, 12);
  await record('page open, first time', fresh, (index) => openRow(index + 1));
  await record('page switch, in memory', runs * 2, (index) => openRow(index % 2 === 0 ? 1 : 2));

  // Sections: switching between sections at the top level and inside groups.
  const sectionCount = await page.$$eval(SECTIONS, (rows) => rows.length);
  await record('section switch', Math.min(sectionCount, runs * 3), (index) => ({
    action: `document.querySelectorAll(${JSON.stringify(SECTIONS)})[${index % Math.max(1, sectionCount)}].click()`,
    until: `document.querySelectorAll(${JSON.stringify(SECTIONS)})[${index % Math.max(1, sectionCount)}].getAttribute('aria-current') === 'true' && !document.querySelector('[data-page-loading]')`,
  }));

  // Folding: the first section group.
  const groupSelector = '.section-group__button';
  if (await page.$(groupSelector)) {
    await record('group fold and unfold', runs * 2, (index) => ({
      action: `document.querySelector(${JSON.stringify(groupSelector)}).click()`,
      until: `document.querySelector(${JSON.stringify(groupSelector)}).getAttribute('aria-expanded') === ${JSON.stringify(index % 2 === 0 ? 'false' : 'true')}`,
    }));
  }

  // Ribbon tabs.
  const tabs = ['insert', 'draw', 'view', 'home'];
  await record('ribbon tab', tabs.length * 3, (index) => ({
    action: `document.getElementById('ribbon-tab-${tabs[index % tabs.length]}').click()`,
    until: `document.getElementById('ribbon-tab-${tabs[index % tabs.length]}').getAttribute('aria-selected') === 'true' && !document.getElementById('ribbon-panel-${tabs[index % tabs.length]}').hidden`,
  }));

  // Context menu on a page row, then closing it.
  await record('context menu open', runs, () => ({
    action: `const row = document.querySelector(${JSON.stringify(ROWS)}); const box = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 8, button: 2 }))`,
    until: `document.querySelector('[role="menu"]')`,
    after: async () => { await page.keyboard.press('Escape'); },
  }));

  // Notebook switcher: open, then pick another notebook.
  await record('notebook switcher open', runs, () => ({
    action: `document.querySelector('.notebook-switcher__button').click()`,
    until: `document.querySelector('.notebook-switcher__popover')`,
    after: async () => { await page.keyboard.press('Escape'); },
  }));
  let current = 0;
  await record('notebook switch', runs * 2, () => {
    current = (current + 1) % notebooks.length;
    const target = notebooks[current];
    return {
      before: async () => { await page.click('.notebook-switcher__button'); await page.waitForSelector('.notebook-switcher__popover'); },
      action: `[...document.querySelectorAll('.notebook-switcher__option:not(.notebook-switcher__option--page)')]
        .find((option) => option.querySelector('.notebook-switcher__option-title').textContent === ${JSON.stringify(titleOf(target))}).click()`,
      until: `document.querySelector('.notebook-switcher__title').textContent === ${JSON.stringify(titleOf(target))}
        && document.querySelector('input[aria-label="Seitentitel"]').value !== '' && !document.querySelector('[data-page-loading]')`,
      pause: 400,
    };
  });
  // Back to the first notebook so the list interactions run on the big one.
  if (notebooks.length > 1) {
    await page.click('.notebook-switcher__button');
    await page.click('.notebook-switcher__option:not(.notebook-switcher__option--page) >> nth=0');
    await page.waitForFunction(`document.querySelector('.notebook-switcher__title').textContent === 'bm' && !document.querySelector('[data-page-loading]')`);
    await page.waitForTimeout(500);
  }

  // Search box: focusing it and typing one character.
  await record('search box focus', runs, () => ({
    action: `document.querySelector('input[type="search"][aria-label="Arbeitsbereich lokal durchsuchen"]').focus()`,
    until: `document.activeElement && document.activeElement.type === 'search'`,
    after: async () => { await page.evaluate(() => document.activeElement.blur()); },
  }));

  // Scrolling the section list (24+ rows and groups): frame times of a scripted scroll.
  const scroll = await page.evaluate(async () => {
    const list = document.querySelector('.section-list');
    const frames = [];
    let last = performance.now();
    const range = Math.max(0, list.scrollHeight - list.clientHeight);
    for (let step = 0; step < 90; step += 1) {
      list.scrollTop = (range * (step % 45)) / 45;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    return { range, p95: frames.sort((left, right) => left - right)[Math.floor(frames.length * 0.95)], worst: Math.max(...frames) };
  });
  results.push({ name: 'section list scroll (frame ms)', ...scroll });
  log('scroll', scroll);

  // Typing in the page title: latency of each key to the next paint.
  await page.evaluate(() => {
    const latencies = [];
    window.__bench.keyLatencies = latencies;
    document.addEventListener('keydown', (event) => {
      if (event.key.length !== 1) return;
      const t0 = performance.now();
      requestAnimationFrame(() => setTimeout(() => latencies.push(performance.now() - t0), 0));
    }, true);
  });
  await page.click('input[aria-label="Seitentitel"]');
  await page.evaluate(() => window.__bench.takeCommits?.());
  await page.keyboard.press('End');
  const typed = 'Bench Titel 1234567';
  for (const character of typed) {
    await page.keyboard.type(character);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
  const typing = await page.evaluate(() => {
    const values = [...window.__bench.keyLatencies].sort((left, right) => left - right);
    return { keys: values.length, medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * 0.95)], worstMs: values[values.length - 1], commits: window.__bench.takeCommits?.() ?? null };
  });
  const typingCommits = typing.commits;
  results.push({
    name: 'page title typing (key to paint)', runs: typing.keys, paintMs: round(typing.medianMs, 1), p95Ms: round(typing.p95Ms, 1),
    worstPaintMs: round(typing.worstMs, 1),
    ...(typingCommits ? {
      commits: round(typingCommits.commits / typing.keys, 1), rendered: round(typingCommits.rendered / typing.keys, 1),
      top: typingCommits.top.slice(0, 5).map(([componentName, times]) => `${componentName}x${round(times / typing.keys, 1)}`).join(' '),
      reasons: typingCommits.reasons.slice(0, 12).map(([label, times]) => `${label}x${round(times / typing.keys, 1)}`).join(' '),
      lastKeyCommits: typingCommits.timeline.slice(-4).map(([at, rendered, mounted], index, all) => [index === 0 ? 0 : at - all[0][0], rendered, mounted]),
    } : {}),
  });
  log('typing', results[results.length - 1]);

  // Drag and drop in the page list: synthetic drag events at the handler level
  // (dragstart, 30 dragovers down the list, drop) so the cost per event shows.
  await page.click(SECTIONS + ' >> nth=0');
  await page.waitForFunction(`document.querySelectorAll(${JSON.stringify(ROWS)}).length > 3 && !document.querySelector('[data-page-loading]')`);
  await page.waitForTimeout(300);
  const drag = await page.evaluate(async ({ rows }) => {
    const items = [...document.querySelectorAll(rows)];
    const source = items[0];
    const pane = document.querySelector('.page-pane .page-tree, .page-pane [role="list"]') ?? document.querySelector('.page-pane');
    const transfer = new DataTransfer();
    const fire = (element, type, point) => {
      const started = performance.now();
      element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: point.x, clientY: point.y }));
      return performance.now() - started;
    };
    const first = source.getBoundingClientRect();
    const times = { start: fire(source, 'dragstart', { x: first.left + 20, y: first.top + 8 }), over: [], drop: 0, end: 0 };
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const last = items[Math.min(items.length - 1, 6)].getBoundingClientRect();
    for (let step = 0; step < 30; step += 1) {
      const y = first.top + ((last.bottom - first.top) * step) / 29;
      const target = document.elementFromPoint(first.left + 40, y) ?? pane;
      times.over.push(fire(target, 'dragover', { x: first.left + 40, y }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const target = document.elementFromPoint(first.left + 40, last.bottom - 4) ?? pane;
    times.drop = fire(target, 'drop', { x: first.left + 40, y: last.bottom - 4 });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    times.end = fire(source, 'dragend', { x: first.left + 40, y: last.bottom - 4 });
    times.over.sort((left, right) => left - right);
    return { ...times, overMedian: times.over[15], overWorst: times.over[29] };
  }, { rows: ROWS });
  results.push({
    name: 'page drag (per event ms)', dragstartMs: round(drag.start, 1), dragoverMedianMs: round(drag.overMedian, 2),
    dragoverWorstMs: round(drag.overWorst, 1), dropMs: round(drag.drop, 1), dragendMs: round(drag.end, 1),
  });
  log('drag', results[results.length - 1]);
  return results;
}

async function main() {
  const port = Number(args.port ?? 4413);
  const site = await serve(port, seedDir);
  await site.load(dist);
  const { served } = site;
  const log = (phase, value) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${label} ${phase} ${JSON.stringify(value)}\n`);
  const result = { label, dist, runs, latencyMs, bandwidthMbps, cacheMode };
  const workDir = mkdtempSync(join(tmpdir(), 'canvink-shell-bench-'));
  const baseProfile = join(workDir, 'base');
  /** A persistent context keeps IndexedDB across the tabs of a scenario; each scenario starts from a copy of the settled profile. */
  const launch = async (dir, { serviceWorkers = false, commits = false } = {}) => {
    const context = await chromium.launchPersistentContext(dir, {
      viewport: { width: 1440, height: 900 }, serviceWorkers: serviceWorkers ? 'allow' : 'block', args: ['--enable-precise-memory-info'],
    });
    await context.addInitScript(PAGE_PROBE);
    if (commits) await context.addInitScript(REACT_HOOK);
    return context;
  };
  const scenario = async (name, options, run) => {
    const dir = join(workDir, name);
    cpSync(baseProfile, dir, { recursive: true });
    const context = await launch(dir, options);
    try {
      await run(context);
    } finally {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    // Seed IndexedDB, open the app once (which builds the page index of a
    // seeded workspace) and let its background work finish.
    const base = await launch(baseProfile);
    const seeder = await base.newPage();
    const seeded = await seedIndexedDb(seeder, port);
    await seeder.close();
    result.seed = seeded.stats;
    const firstOpen = await measureStart(base, port, { clearCache: true });
    log('first open (builds the page index)', firstOpen);
    const settlePage = await base.newPage();
    const settleCdp = await base.newCDPSession(settlePage);
    await settleCdp.send('Performance.enable');
    await settlePage.goto(`http://127.0.0.1:${port}/app`);
    await settlePage.waitForFunction('window.__bench && window.__bench.readyAt', undefined, { timeout: 300_000 });
    await waitForQuiet(settleCdp);
    await settlePage.close();
    await base.close();

    if (wants('cold') || wants('warm')) {
      // With --dist2 the two builds take turns within one session, so a change in
      // the machine's load between runs hits both alike.
      const builds = [[label, dist], ...(args.dist2 ? [[args.label2 ?? 'other', args.dist2]] : [])];
      await scenario('start', {}, async (context) => {
        const measured = async (name, options) => {
          served.length = 0;
          const sample = await measureStart(context, port, options);
          sample.servedKB = served.reduce((total, entry) => total + entry.bytes, 0) / 1024;
          sample.requests = served.length;
          sample.requests304 = served.filter((entry) => entry.status === 304).length;
          return { name, sample };
        };
        if (wants('cold')) {
          const cold = new Map(builds.map(([name]) => [name, []]));
          for (let index = 0; index < runs; index += 1) {
            for (const [name, build] of builds) {
              await site.load(build);
              cold.get(name).push((await measured(name, { clearCache: true, trace: index === 0 && args.trace !== 'off' })).sample);
            }
          }
          for (const [name, samples] of cold) {
            if (args.waterfall) log(`${name} waterfall (first cold run)`, samples[0].waterfall);
            const summary = summarize(samples);
            summary.compileMsFirstRun = round(samples[0].compileMs);
            (result.coldStart ??= {})[name] = summary;
            log(`${name} cold start`, summary);
          }
        }
        if (wants('warm')) {
          // Warm: the HTTP cache is filled by the previous tab. Cloudflare's default
          // revalidates every asset here; a `_headers` rule in the build can avoid that.
          const warm = new Map(builds.map(([name]) => [name, []]));
          for (const [, build] of builds) {
            await site.load(build);
            await measureStart(context, port, { clearCache: false });
          }
          for (let index = 0; index < runs; index += 1) {
            for (const [name, build] of builds) {
              await site.load(build);
              warm.get(name).push((await measured(name, { clearCache: false })).sample);
            }
          }
          for (const [name, samples] of warm) {
            const summary = summarize(samples);
            (result.warmStart ??= {})[name] = summary;
            log(`${name} warm start`, summary);
          }
        }
        await site.load(dist);
      });
    }
    if (wants('sw')) {
      // Service worker: install it, let it warm its caches, then measure repeat loads and an offline load.
      await scenario('sw', { serviceWorkers: true }, async (context) => {
        const installer = await context.newPage();
        await installer.goto(`http://127.0.0.1:${port}/app`);
        await installer.waitForFunction('window.__bench && window.__bench.readyAt', undefined, { timeout: 120_000 });
        await installer.evaluate(() => navigator.serviceWorker.ready);
        await installer.waitForFunction(async () => (await caches.keys()).length >= 2, undefined, { timeout: 60_000 });
        await installer.waitForTimeout(3000);
        await installer.close();
        // The first load after installing is not yet controlled by the worker; reload once.
        await measureStart(context, port, { clearCache: false });
        const repeat = [];
        for (let index = 0; index < runs; index += 1) {
          served.length = 0;
          repeat.push(await measureStart(context, port, { clearCache: false }));
          repeat[repeat.length - 1].requests = served.length;
        }
        result.swRepeatStart = summarize(repeat);
        log('service worker repeat start', result.swRepeatStart);
        await context.setOffline(true);
        const offline = [];
        for (let index = 0; index < Math.min(runs, 3); index += 1) offline.push(await measureStart(context, port, { clearCache: false }));
        result.swOfflineStart = summarize(offline);
        log('service worker offline start', result.swOfflineStart);
        await context.setOffline(false);
      });
    }
    if (wants('interactions')) {
      // Timings come from the normal build; commit counts from the instrumented
      // one (unminified, otherwise the same code).
      for (const [mode, build, options] of [['timing', dist, {}], ...(instDist ? [['commits', instDist, { commits: true }]] : [])]) {
        await site.load(build);
        await scenario(`interactions-${mode}`, options, async (context) => {
          const warmup = await context.newPage();
          const warmupCdp = await context.newCDPSession(warmup);
          await warmupCdp.send('Performance.enable');
          await warmup.goto(`http://127.0.0.1:${port}/app`);
          await warmup.waitForFunction('window.__bench && window.__bench.readyAt', undefined, { timeout: 300_000 });
          await waitForQuiet(warmupCdp);
          await warmup.reload();
          await warmup.waitForFunction('window.__bench && window.__bench.readyAt', undefined, { timeout: 300_000 });
          await warmup.waitForTimeout(1500);
          if (mode === 'commits') {
            const startup = await warmup.evaluate(() => window.__bench.takeCommits());
            result.startupCommits = { timeline: startup.timeline.map(([at, rendered, mounted], index, all) => [index === 0 ? 0 : at - all[0][0], rendered, mounted]), appMounts: startup.appMounts, commits: startup.commits, rendered: startup.rendered, mounted: startup.mounted, mountedTop: startup.mountedTop.map(([name, times]) => `${name}x${times}`).join(' '), top: startup.top.map(([name, times]) => `${name}x${times}`).join(' ') };
            log('startup commits', result.startupCommits);
          }
          const suite = await interactionSuite(warmup, seeded, (name, value) => log(`${mode}: ${name}`, value));
          result[mode === 'timing' ? 'interactions' : 'interactionCommits'] = suite;
        });
      }
    }
  } finally {
    site.server.close();
    rmSync(workDir, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
