#!/usr/bin/env node
/**
 * Measures pen input and ink rendering on a page shaped like the worst pages
 * of a large synthetic notebook (7,000 handwriting strokes of ten points
 * over eight printouts; synthetic data only).
 *
 *   pnpm exec vite build --config scripts/bench/vite.seed.config.mjs
 *   node node_modules/.cache/canvink-bench/seed-workspace.js --out /tmp/heavy-seed \
 *     --pages 3 --strokes 300 --images 3 --sections 1 --heavy 7000 --heavy-images 8
 *   VITE_CANVINK_ALLOW_FEATURE_OVERRIDE=1 pnpm exec vite build --outDir /tmp/canvink-dist
 *   node scripts/ink-render-bench.mjs --dist /tmp/canvink-dist --seed /tmp/heavy-seed --label after
 *
 * Every run opens the heavy page in a fresh browser profile and, once the
 * page is idle, drives these scenarios with real (CDP) input events. A pen
 * scenario sends `pointerType: "pen"` with pressure, paced like a 120 Hz pen.
 *
 * - handwriting: eight 80-sample strokes with 200 ms pauses, the way a word is written;
 * - pen-short / pen-long: a 600 and a 3,000 point stroke over dense ink;
 * - wheel-pan and drag-pan: panning the page by wheel and with the pan tool;
 * - wheel-zoom and zoom-settle: Ctrl+wheel zooming out and in, then the
 *   re-rasterisation of the tiles once zooming pauses;
 * - lasso: a loop round about a screenful of ink, then moving that selection;
 * - stroke-eraser and point-eraser: a zigzag sweep across dense ink.
 *
 * Options: `--runs N` (default 3, fresh profile each), `--only pen,lasso,eraser,pan,zoom`
 * to run some groups, `--throttle 4` for a 4x slower CPU (about a tablet next
 * to a desktop; also shows costs a fast machine hides), `--profile
 * drag-pan,handwriting` to write a V8 CPU profile of those scenarios in the
 * first run and print their hot functions (build with `--minify false` to
 * read them), `--trace drag-pan` to sum the browser's own style, layout,
 * paint and compositing work during those scenarios, `--raw` for every run's
 * numbers.
 *
 * Reported per scenario:
 * - handlerMs: time spent in the page's pointer/wheel handlers per event
 *   (a capture listener on the window to a bubble listener on the window,
 *   so React's handlers and the synchronous canvas painting are included);
 * - inputToFrameMs: from the event's timeStamp (when the browser received it)
 *   to the start of the next animation frame, that is when the frame that
 *   contains the change begins to render. Headless Chromium has no display,
 *   so it cannot include the compositor, raster and scan-out that follow, and
 *   it cannot show a real pen digitiser's or a monitor's latency;
 * - frameMs: intervals between animation frames while the scenario runs;
 *   `slow` counts frames over 33 ms and `stalls` frames over 100 ms;
 * - longTasks: main-thread tasks over 50 ms (count, longest, summed excess);
 * - commits: React commits (through the devtools hook) and commits per event;
 * - endMs: the time from the last input to the moment the result is on screen
 *   (pen-up to committed stroke, erase or selection).
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
const port = Number(args.port ?? 4414);
const label = args.label ?? 'build';
const runs = Number(args.runs ?? 3);
const only = args.only ? String(args.only).split(',') : null;
const cpuThrottle = Number(args.throttle ?? 1);
/** `--profile stroke-eraser,lasso-move` writes a V8 CPU profile of those scenarios in the first run and prints their hot functions. */
const profileScenarios = args.profile ? String(args.profile).split(',') : [];
/** `--trace drag-pan` sums the browser's own rendering work (style, layout, paint, compositing) during those scenarios in the first run. */
const traceScenarios = args.trace ? String(args.trace).split(',') : [];
/** Milliseconds between two pen samples: 120 Hz. */
const SAMPLE_INTERVAL_MS = 8;

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
 * Installed in every document before the app starts. React reports each
 * commit to this minimal devtools hook, which works in production builds.
 */
const PROBE = `(() => {
  const state = {
    commits: 0, events: [], frames: [], tasks: [], recording: false,
    pending: [], handlerStart: 0, handled: 0,
  };
  window.__bench = state;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject() { return 1; }, checkDCE() {},
    onCommitFiberRoot() { if (state.recording) state.commits += 1; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
    setStrictModesEnabled() {},
  };
  const types = ['pointermove', 'wheel'];
  for (const type of types) {
    window.addEventListener(type, () => { state.handlerStart = performance.now(); }, { capture: true, passive: true });
    window.addEventListener(type, (event) => {
      if (!state.recording) return;
      if (type === 'pointermove' && event.buttons === 0) return;
      const end = performance.now();
      state.events.push(end - state.handlerStart);
      state.pending.push(event.timeStamp);
    }, { passive: true });
  }
  let last = 0;
  const frame = (now) => {
    if (state.recording) {
      if (last) state.frames.push(now - last);
      for (const stamp of state.pending) state.inputToFrame = (state.inputToFrame ?? []).concat(now - stamp);
      state.pending = [];
    }
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.tasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
})();`;

const percentile = (values, fraction) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};
const round = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function summarize(values) {
  return { n: values.length, p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), max: round(Math.max(...values, 0)) };
}

async function waitForQuiet(cdp, cap = 300_000) {
  const started = Date.now();
  let previous;
  while (Date.now() - started < cap) {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const task = metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0;
    if (previous !== undefined && task - previous < 0.05) return;
    previous = task;
    await sleep(1000);
  }
}

async function waitForTitle(page, title) {
  await page.waitForFunction(
    (expected) => document.querySelector('input[aria-label="Seitentitel"]')?.value === expected,
    title,
    { timeout: 300_000, polling: 'raf' },
  );
}

async function waitForInk(page, strokes) {
  await page.waitForFunction(
    (expected) => document.querySelector('[data-page-loading]') === null
      && Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0) >= expected
      && document.querySelectorAll('.live-canvas-ink-tile').length > 0,
    strokes,
    { timeout: 300_000, polling: 100 },
  );
}

let cdpForProfile = null;

/** Runs `action` with the in-page recording on and returns its measurements. */
/** Total milliseconds and count of the renderer's main-thread trace events by name. */
function summarizeTrace(events) {
  const totals = new Map();
  for (const event of events) {
    if (event.ph !== 'X' || event.dur === undefined) continue;
    const entry = totals.get(event.name) ?? { ms: 0, count: 0 };
    entry.ms += event.dur / 1000;
    entry.count += 1;
    totals.set(event.name, entry);
  }
  return [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)
    .map(([name, entry]) => `${Math.round(entry.ms).toString().padStart(7)} ms  ${String(entry.count).padStart(6)} x  ${name}`);
}

async function scenario(page, name, action) {
  const tracing = traceScenarios.includes(name) && cdpForProfile;
  const traceEvents = [];
  if (tracing) {
    cdpForProfile.on('Tracing.dataCollected', (chunk) => traceEvents.push(...chunk.value));
    await cdpForProfile.send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-devtools.timeline,cc',
      transferMode: 'ReportEvents',
    });
  }
  const profiling = profileScenarios.includes(name) && cdpForProfile;
  if (profiling) {
    await cdpForProfile.send('Profiler.enable');
    await cdpForProfile.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdpForProfile.send('Profiler.start');
  }
  await page.evaluate(() => {
    const state = window.__bench;
    state.commits = 0; state.events = []; state.frames = []; state.inputToFrame = []; state.pending = [];
    state.recording = true; state.from = performance.now();
  });
  const outcome = await action();
  await sleep(150);
  if (tracing) {
    const done = new Promise((resolve) => cdpForProfile.once('Tracing.tracingComplete', resolve));
    await cdpForProfile.send('Tracing.end');
    await done;
    process.stderr.write(`\ntrace (${name}), longest first:\n${summarizeTrace(traceEvents).join('\n')}\n\n`);
  }
  if (profiling) {
    const { profile } = await cdpForProfile.send('Profiler.stop');
    await writeFile(`${name}.cpuprofile`, JSON.stringify(profile));
    const summary = summarizeProfile(profile);
    process.stderr.write(`\nself time (${name}):\n${summary.self.join('\n')}\n\ntotal time:\n${summary.total.join('\n')}\n\n`);
  }
  const data = await page.evaluate(() => {
    const state = window.__bench;
    state.recording = false;
    return {
      commits: state.commits, events: state.events, frames: state.frames, inputToFrame: state.inputToFrame ?? [],
      tasks: state.tasks.filter((task) => task.start + task.duration >= state.from),
    };
  });
  process.stderr.write(`  ${name}: ${data.events.length} events, ${data.commits} commits\n`);
  const excess = data.tasks.reduce((total, task) => total + Math.max(0, task.duration - 50), 0);
  const events = data.events.length;
  const quarter = Math.max(1, Math.floor(events / 4));
  return {
    name,
    events,
    handlerMs: summarize(data.events),
    // A cost that grows with the length of the stroke shows up here.
    handlerFirstQuarterMs: events > 0 ? summarize(data.events.slice(0, quarter)) : undefined,
    handlerLastQuarterMs: events > 0 ? summarize(data.events.slice(-quarter)) : undefined,
    inputToFrameMs: summarize(data.inputToFrame),
    frameMs: {
      ...summarize(data.frames),
      slow: data.frames.filter((frame) => frame > 33).length,
      stalls: data.frames.filter((frame) => frame > 100).length,
    },
    longTasks: { count: data.tasks.length, maxMs: round(Math.max(0, ...data.tasks.map((task) => task.duration))), excessMs: round(excess) },
    commits: data.commits,
    commitsPerEvent: events > 0 ? round(data.commits / events) : undefined,
    ...outcome,
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
  return { self: top(self, 30), total: top(total, 50) };
}

/** Sends one CDP mouse event; a pen event carries pressure like a digitiser. */
async function dispatch(cdp, type, x, y, options = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type, x, y,
    button: options.button ?? (type === 'mouseMoved' && !options.down ? 'none' : 'left'),
    buttons: options.down ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
    pointerType: options.pen ? 'pen' : 'mouse',
    force: options.pen && options.down ? options.force ?? 0.5 : 0,
    modifiers: options.modifiers ?? 0,
  });
}

/** Drives a path of points with the button down, at the pen's sample rate. */
async function drag(cdp, points, { pen, interval = SAMPLE_INTERVAL_MS }) {
  const [first, ...rest] = points;
  await dispatch(cdp, 'mouseMoved', first.x, first.y, { pen });
  await dispatch(cdp, 'mousePressed', first.x, first.y, { pen, down: true, force: first.force });
  let due = performance.now();
  for (const point of rest) {
    due += interval;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    await dispatch(cdp, 'mouseMoved', point.x, point.y, { pen, down: true, force: point.force });
  }
  const last = points[points.length - 1];
  const releasedAt = Date.now();
  await dispatch(cdp, 'mouseReleased', last.x, last.y, { pen });
  return releasedAt;
}

/** A handwriting-like path of `count` samples: loops along a line, varying pressure. */
function scribble(origin, count, width) {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const t = index / count;
    points.push({
      x: origin.x + t * width + Math.sin(index / 7) * 14,
      y: origin.y + Math.cos(index / 7) * 22 + Math.sin(t * 6) * 40,
      force: 0.25 + 0.5 * Math.abs(Math.sin(index / 23)),
    });
  }
  return points;
}

async function selectTool(page, name) {
  await page.getByRole('tab', { name: /^Zeichnen$/ }).click();
  await page.getByRole('tabpanel', { name: /^Zeichnen$/ }).getByRole('button', { name }).first().click();
}

async function strokeCount(page) {
  return page.evaluate(() => Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0));
}

/** Waits until the shown page holds more than `count` strokes. */
async function untilMoreStrokesThan(page, count, cap = 30_000) {
  const started = Date.now();
  await page.waitForFunction(
    (expected) => Number(document.querySelector('[data-ink-stroke-count]')?.getAttribute('data-ink-stroke-count') ?? 0) > expected,
    count,
    { timeout: cap, polling: 'raf' },
  );
  return Date.now() - started;
}

async function runScenarios(page, cdp, box) {
  const results = [];
  const wanted = (name) => !only || only.includes(name);
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const dense = { x: box.x + 60, y: box.y + 200 };

  if (wanted('pen')) {
    await selectTool(page, /^Stift$/);
    // Handwriting: eight strokes of 80 samples (a letter or a short word each)
    // with 200 ms between pen-up and the next pen-down, over dense ink.
    results.push(await scenario(page, 'handwriting', async () => {
      let committedMs = 0;
      for (let word = 0; word < 8; word += 1) {
        const before = await strokeCount(page);
        const path = scribble({ x: dense.x + word * 90, y: dense.y - 100 }, 80, 80);
        await drag(cdp, path, { pen: true });
        committedMs = Math.max(committedMs, await untilMoreStrokesThan(page, before));
        await sleep(200);
      }
      return { committedMs };
    }));
    await sleep(500);
    for (const [name, count] of [['pen-short', 600], ['pen-long', 3000]]) {
      const before = await strokeCount(page);
      const path = scribble({ x: dense.x, y: dense.y + (name === 'pen-long' ? 200 : 0) }, count, box.width - 200);
      results.push(await scenario(page, name, async () => {
        const releasedAt = await drag(cdp, path, { pen: true });
        const committedMs = await untilMoreStrokesThan(page, before);
        return { endMs: Date.now() - releasedAt, committedMs };
      }));
      await sleep(500);
    }
  }

  if (wanted('lasso')) {
    await selectTool(page, /^Lasso$/);
    const loop = Array.from({ length: 121 }, (_, index) => {
      const angle = (index / 120) * Math.PI * 2;
      return { x: box.x + 300 + Math.cos(angle) * 240, y: box.y + 260 + Math.sin(angle) * 180, force: 0 };
    });
    results.push(await scenario(page, 'lasso', async () => {
      const releasedAt = await drag(cdp, loop, { pen: true });
      await page.waitForFunction(() => document.querySelectorAll('.live-canvas-ink-selection').length > 0, undefined, { timeout: 60_000, polling: 'raf' });
      const selected = await page.evaluate(() => document.querySelectorAll('.live-canvas-ink-selection').length);
      return { endMs: Date.now() - releasedAt, selected };
    }));
    const inside = { x: box.x + 300, y: box.y + 260 };
    const moveTo = Array.from({ length: 60 }, (_, index) => ({ x: inside.x + index * 3, y: inside.y + index * 2, force: 0 }));
    results.push(await scenario(page, 'lasso-move', async () => {
      const releasedAt = await drag(cdp, [inside, ...moveTo], { pen: false });
      await sleep(300);
      return { endMs: Date.now() - releasedAt };
    }));
    await page.keyboard.press('Control+Z');
    await sleep(500);
    await page.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
  }

  if (wanted('eraser')) {
    for (const [name, button] of [['stroke-eraser', /^Strichradierer$/], ['point-eraser', /^Punktradierer$/]]) {
      await selectTool(page, button);
      const before = await strokeCount(page);
      const sweep = Array.from({ length: 240 }, (_, index) => ({
        x: box.x + 80 + (index / 240) * (box.width - 200),
        y: box.y + 220 + Math.sin(index / 6) * 70,
        force: 0,
      }));
      results.push(await scenario(page, name, async () => {
        const releasedAt = await drag(cdp, sweep, { pen: true });
        await sleep(400);
        return { endMs: Date.now() - releasedAt, erased: before - await strokeCount(page) };
      }));
    }
  }
  if (wanted('pan')) {
    await page.mouse.move(centre.x, centre.y);
    results.push(await scenario(page, 'wheel-pan', async () => {
      for (let step = 0; step < 240; step += 1) {
        await page.mouse.wheel(0, step < 120 ? 60 : -60);
        await sleep(SAMPLE_INTERVAL_MS);
      }
      return {};
    }));
    await selectTool(page, /^Verschieben$/);
    const start = { x: centre.x, y: centre.y + 200 };
    const path = Array.from({ length: 240 }, (_, index) => ({
      x: start.x + Math.sin((index / 239) * Math.PI * 2) * 60,
      y: start.y - Math.sin((index / 239) * Math.PI) * 200,
      force: 0,
    }));
    results.push(await scenario(page, 'drag-pan', async () => {
      await drag(cdp, path, { pen: false });
      return {};
    }));
  }

  if (wanted('zoom')) {
    await page.mouse.move(centre.x, centre.y);
    await page.keyboard.down('Control');
    results.push(await scenario(page, 'wheel-zoom', async () => {
      for (let step = 0; step < 60; step += 1) {
        await page.mouse.wheel(0, step < 30 ? 40 : -40);
        await sleep(SAMPLE_INTERVAL_MS * 2);
      }
      return {};
    }));
    await page.keyboard.up('Control');
    // Tiles are re-rasterised once zooming pauses; that is a burst of work.
    results.push(await scenario(page, 'zoom-settle', async () => {
      await page.mouse.move(centre.x, centre.y);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -80);
      await page.keyboard.up('Control');
      await sleep(900);
      return {};
    }));
  }

  return results;
}

async function run(browser, index) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(PROBE);
  try {
    const seeder = await context.newPage();
    const { pages } = await seedIndexedDb(seeder);
    await seeder.close();
    const first = pages[0];
    const heavy = pages.find((page) => page.pageId === 'bm-heavy');
    if (!heavy) throw new Error('The seed has no heavy page; generate it with --heavy 7000.');

    // First start builds the page and search indexes; measure only afterwards.
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
    if (cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    await page.goto(`http://127.0.0.1:${port}/app`);
    await waitForTitle(page, first.title);
    await waitForQuiet(cdp);
    await page.locator(`[data-page-row-id="${heavy.pageId}"] .page-row__target`).first().click();
    await waitForTitle(page, heavy.title);
    await waitForInk(page, heavy.strokes);
    await waitForQuiet(cdp);
    const view = await page.getByLabel('Ansicht der Zeichenfläche').boundingBox();
    if (!view) throw new Error('The canvas view has no box.');
    cdpForProfile = (profileScenarios.length > 0 || traceScenarios.length > 0) && index === 0 ? cdp : null;
    const scenarios = await runScenarios(page, cdp, view);
    return { scenarios, errors: errors.slice(0, 3) };
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
    process.stderr.write(`${label} run ${index + 1}: ${JSON.stringify(result.scenarios.map((entry) => ({
      name: entry.name, handler: entry.handlerMs.p95, frame: entry.frameMs.p95, longest: entry.longTasks.maxMs,
    })))}\n`);
    results.push(result);
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const names = results[0].scenarios.map((entry) => entry.name);
  const summary = names.map((name) => {
    const entries = results.map((result) => result.scenarios.find((entry) => entry.name === name)).filter(Boolean);
    const pick = (read) => round(median(entries.map(read)));
    return {
      name,
      runs: entries.length,
      events: entries[0].events,
      handlerP50: pick((entry) => entry.handlerMs.p50),
      handlerP95: pick((entry) => entry.handlerMs.p95),
      handlerMax: pick((entry) => entry.handlerMs.max),
      handlerFirstQuarterP50: entries[0].handlerFirstQuarterMs ? pick((entry) => entry.handlerFirstQuarterMs.p50) : undefined,
      handlerLastQuarterP50: entries[0].handlerLastQuarterMs ? pick((entry) => entry.handlerLastQuarterMs.p50) : undefined,
      inputToFrameP50: pick((entry) => entry.inputToFrameMs.p50),
      inputToFrameP95: pick((entry) => entry.inputToFrameMs.p95),
      frameP50: pick((entry) => entry.frameMs.p50),
      frameP95: pick((entry) => entry.frameMs.p95),
      frameMax: pick((entry) => entry.frameMs.max),
      slowFrames: pick((entry) => entry.frameMs.slow),
      stalls: pick((entry) => entry.frameMs.stalls),
      longTasks: pick((entry) => entry.longTasks.count),
      longestTaskMs: pick((entry) => entry.longTasks.maxMs),
      excessMs: pick((entry) => entry.longTasks.excessMs),
      commits: pick((entry) => entry.commits),
      commitsPerEvent: pick((entry) => entry.commitsPerEvent ?? 0),
      endMs: entries[0].endMs === undefined ? undefined : pick((entry) => entry.endMs),
      extra: { selected: entries[0].selected, erased: entries[0].erased },
    };
  });
  process.stdout.write(`${JSON.stringify({ label, throttle: cpuThrottle, runs: results.length, summary, errors: results.flatMap((result) => result.errors) })}\n`);
  if (args.raw) process.stderr.write(`${JSON.stringify(results)}\n`);
} finally {
  await browser.close();
  server.close();
}
