#!/usr/bin/env node
/**
 * Measures handwriting at school-page scale in a production build.
 *
 *   pnpm exec vite build --outDir /tmp/canvink-dist
 *   node scripts/ink-scale-bench.mjs --dist /tmp/canvink-dist --counts 500,2000,6000
 *
 * For every stroke count it opens a fresh browser profile, seeds a free page
 * with synthetic handwriting through the canvas clipboard format (Ctrl+V, at
 * most 1,000 elements per paste), and reports:
 *
 * - persisted: pen-up until the new stroke is part of the committed page
 *   (the editor re-rendered from the Automerge change) and until the save
 *   indicator reports "saved" (includes the app's 250 ms flush debounce);
 * - latency: pointermove timestamp until the first animation frame whose
 *   rendering already contains that sample (SVG preview polyline, or the live
 *   stroke through the test hook of builds with the feature override);
 * - open: switching back to the seeded page, and a cold reload of the app;
 * - memory: JS heap after a forced GC and the DOM node count;
 * - scroll: animation-frame intervals while wheel-panning the page.
 *
 * Each phase has a time cap; a capped phase is reported as a timeout.
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
if (!dist) throw new Error('--dist <vite build output> is required');
const port = Number(args.port ?? 4410);
const counts = String(args.counts ?? '500,2000,6000').split(',').map(Number);
const strokesToDraw = Number(args.strokes ?? 8);
const phaseCapMs = Number(args.cap ?? 180_000);
const seedCapMs = Number(args['seed-cap'] ?? 900_000);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2',
};

function serve(root) {
  const server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
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

const percentile = (values, fraction) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};
const round = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : value);

async function withCap(label, promise, cap = phaseCapMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: `${label} exceeded ${Math.round(cap / 1000)} s` }), cap);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Works for the per-stroke DOM renderer and for the canvas renderer. */
function inkCountSource() {
  return `(() => {
    const surface = document.querySelector('[data-ink-stroke-count]');
    if (surface) return Number(surface.getAttribute('data-ink-stroke-count'));
    return document.querySelectorAll('[data-element-kind="stroke"]').length;
  })()`;
}

function syntheticPayload(start, count) {
  const elements = [];
  const zOrder = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = start + offset;
    // Handwriting rows: 70 short words per 1,500-unit row, 34 units apart.
    const column = index % 70;
    const row = Math.floor(index / 70);
    const x0 = 40 + column * 21;
    const y0 = 60 + row * 34;
    const points = [];
    for (let step = 0; step < 48; step += 1) {
      const t = step / 47;
      points.push({
        x: Math.round((x0 + t * 16 + Math.sin(t * 9 + index) * 3) * 100) / 100,
        y: Math.round((y0 + Math.cos(t * 7 + index) * 9) * 100) / 100,
        pressure: Math.round((0.35 + 0.4 * Math.sin(t * Math.PI)) * 1000) / 1000,
        tiltX: 0,
        tiltY: 0,
        time: step * 8,
        pointerType: 'pen',
      });
    }
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const id = `bench-${index}`;
    elements.push({
      id,
      kind: 'stroke',
      frame: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, rotation: 0 },
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
      locked: false,
      tool: index % 97 === 0 ? 'highlighter' : 'pen',
      points,
      color: index % 97 === 0 ? '#facc15' : '#1d4ed8',
      size: index % 97 === 0 ? 14 : 3,
      opacity: index % 97 === 0 ? 0.36 : 1,
    });
    zOrder.push(id);
  }
  return JSON.stringify({ format: 'canvink-elements-v1', elements, zOrder });
}

async function waitForInk(page, expected, cap) {
  const started = Date.now();
  return withCap('waiting for ink', page.waitForFunction(
    `${inkCountSource()} >= ${expected}
      && (document.querySelector('[data-ink-ready]')?.getAttribute('data-ink-ready') ?? 'true') === 'true'`,
    undefined,
    { timeout: 0, polling: 50 },
  ).then(() => Date.now() - started), cap);
}

async function waitForSaved(page, cap = phaseCapMs) {
  return withCap('waiting for save', page.waitForFunction(
    `document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') === 'saved'`,
    undefined,
    { timeout: 0, polling: 50 },
  ), cap);
}

async function measure(browser, count, result) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const errors = [];
  result.pageErrors = errors;
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`http://127.0.0.1:${port}/app`, { waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  const canvas = page.getByRole('application', { name: /Gemeinsame Seitenzeichenfläche|Shared page canvas/ });
  await canvas.waitFor();
  const title = page.getByLabel(/Seitentitel|Page title/);
  const seededTitle = await title.inputValue();
  // The second page for the page-switch measurement is created first: adding
  // a page is a workspace topology commit, which reloads every document.
  await page.getByRole('button', { name: /^(Erstellen|Create)$/ }).click();
  await page.getByRole('button', { name: /^(Canvas-Seite|Canvas page)$/ }).click();
  await waitForSaved(page);
  const otherTitle = await title.inputValue();
  const seededRow = page.locator('.page-row__target').filter({ hasText: seededTitle }).first();
  const otherRow = page.locator('.page-row__target').filter({ hasText: otherTitle }).first();
  await seededRow.click();
  for (let attempt = 0; attempt < 100 && (await title.inputValue()) !== seededTitle; attempt += 1) {
    await page.waitForTimeout(100);
  }

  // Seed through the real paste path, 1,000 elements at a time.
  const seedStarted = Date.now();
  for (let start = 0; start < count; start += 1000) {
    const chunk = Math.min(1000, count - start);
    const payload = syntheticPayload(start, chunk);
    await page.evaluate((text) => navigator.clipboard.writeText(text), payload);
    await canvas.focus();
    await page.keyboard.press('Control+V');
    const seeded = await waitForInk(page, start + chunk, seedCapMs);
    if (typeof seeded === 'object') {
      result.seed = seeded;
      await context.close();
      return result;
    }
  }
  const saved = await waitForSaved(page, seedCapMs);
  result.seedSeconds = round((Date.now() - seedStarted) / 1000);
  if (saved && typeof saved === 'object' && 'timeout' in saved) result.seedSave = saved;


  // Memory after GC.
  await cdp.send('HeapProfiler.collectGarbage');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  result.heapMB = round(metrics.JSHeapUsedSize / 1024 / 1024);
  result.domNodes = await page.evaluate(() => document.getElementsByTagName('*').length);

  // Pen strokes: latency and persistence.
  await page.evaluate(() => {
    // Latency: from the pointermove's timestamp to the first animation frame
    // whose DOM (per-stroke renderer: the SVG preview polyline) or live ink
    // (canvas renderer, via the test hook) already contains that sample.
    // rAF callbacks run right before the frame is painted.
    const state = { latency: [], ups: [], pending: [], moves: 0 };
    window.__inkBench = state;
    window.addEventListener('pointerdown', () => { state.moves = 0; state.pending = []; });
    window.addEventListener('pointermove', (event) => {
      if (event.buttons === 0) return;
      state.moves += 1;
      state.pending.push({ t0: event.timeStamp, n: state.moves });
    });
    window.addEventListener('pointerup', (event) => state.ups.push(event.timeStamp));
    const shown = () => {
      const hook = window.__canvinkInk;
      if (hook?.livePointCount) return hook.livePointCount() - 1;
      const polyline = document.querySelector('.live-canvas-preview polyline');
      return polyline ? polyline.points.length - 1 : -1;
    };
    const frame = () => {
      const now = performance.now();
      const visible = shown();
      state.pending = state.pending.filter((sample) => {
        if (visible >= sample.n || now - sample.t0 > 2000) {
          state.latency.push(now - sample.t0);
          return false;
        }
        return true;
      });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  // The pen lives in the ribbon's Draw tab.
  await page.getByRole('tab', { name: /^(Zeichnen|Draw)$/ }).click();
  await page.getByRole('tabpanel', { name: /^(Zeichnen|Draw)$/ })
    .getByRole('button', { name: /^(Stift|Pen)$/ }).click();
  const box = await canvas.boundingBox();
  const viewportBox = await page.getByLabel(/Ansicht der Zeichenfläche|Canvas view/).boundingBox();
  const persisted = [];
  const savedAfter = [];
  for (let stroke = 0; stroke < strokesToDraw; stroke += 1) {
    const before = await page.evaluate(inkCountSource());
    const x = Math.max(box.x, viewportBox.x) + 200 + stroke * 60;
    const y = Math.max(box.y, viewportBox.y) + 200 + (stroke % 3) * 40;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y + 25, { steps: 30 });
    await page.mouse.up();
    const committed = await withCap('stroke commit', page.waitForFunction(
      `${inkCountSource()} > ${before}`, undefined, { timeout: 0, polling: 'raf' },
    ).then(() => page.evaluate(() => performance.now() - window.__inkBench.ups.at(-1))));
    if (typeof committed === 'object') {
      result.persisted = committed;
      break;
    }
    persisted.push(committed);
    const savedResult = await waitForSaved(page);
    if (savedResult && typeof savedResult === 'object' && 'timeout' in savedResult) {
      result.saved = savedResult;
      break;
    }
    savedAfter.push(await page.evaluate(() => performance.now() - window.__inkBench.ups.at(-1)));
  }
  const latency = await page.evaluate(() => window.__inkBench.latency);
  if (!result.persisted) {
    result.persistedMs = { p50: round(percentile(persisted, 0.5)), max: round(Math.max(...persisted)) };
    result.savedMs = { p50: round(percentile(savedAfter, 0.5)), max: round(Math.max(...savedAfter)) };
  }
  result.latencyMs = { samples: latency.length, p50: round(percentile(latency, 0.5)), p95: round(percentile(latency, 0.95)) };

  // Scroll: wheel-pan the page and record frame intervals.
  await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + viewportBox.height / 2);
  await page.evaluate(() => {
    const frames = [];
    window.__inkFrames = frames;
    let last = performance.now();
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (!window.__inkFramesStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let step = 0; step < 90; step += 1) {
    await page.mouse.wheel(0, step < 45 ? 40 : -40);
  }
  await page.waitForTimeout(200);
  const frames = await page.evaluate(() => {
    window.__inkFramesStop = true;
    return window.__inkFrames.slice(1);
  });
  result.scrollFrameMs = { frames: frames.length, p50: round(percentile(frames, 0.5)), p95: round(percentile(frames, 0.95)), max: round(Math.max(...frames)) };

  // Page open: switch away and back, then a cold reload.
  await otherRow.click();
  await waitForSaved(page);
  const switchStarted = Date.now();
  await seededRow.click();
  const switched = await waitForInk(page, count, phaseCapMs);
  result.switchOpenMs = typeof switched === 'object' ? switched : Date.now() - switchStarted;
  await waitForSaved(page);

  const reloadStarted = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  const reopened = await waitForInk(page, count, phaseCapMs);
  result.coldOpenMs = typeof reopened === 'object' ? reopened : Date.now() - reloadStarted;
  await context.close();
  return result;
}

const server = await serve(dist);
const browser = await chromium.launch();
try {
  for (const count of counts) {
    const started = Date.now();
    const result = { count };
    try {
      await measure(browser, count, result);
    } catch (error) {
      result.aborted = String(error?.message ?? error).split('\n')[0];
    }
    result.pageErrors = result.pageErrors?.slice(0, 3);
    if (result.pageErrors?.length === 0) delete result.pageErrors;
    result.totalSeconds = round((Date.now() - started) / 1000);
    console.log(JSON.stringify(result));
  }
} finally {
  await browser.close();
  server.close();
}
