#!/usr/bin/env node
/**
 * Imports a OneNote desktop export through the real app in headless Chromium
 * and measures import time and peak memory.
 *
 *   pnpm exec vite build --outDir /tmp/canvink-dist
 *   node scripts/onenote-import-bench.mjs --dist /tmp/canvink-dist                 # bm size (398 pages)
 *   node scripts/onenote-import-bench.mjs --dist /tmp/canvink-dist --pages 40 --strokes 20000 --points 200000 --printouts 100
 *   node scripts/onenote-import-bench.mjs --dist /tmp/canvink-dist --export /path/to/export-folder
 *
 * Without --export it writes a synthetic export (scripts/onenote-synthetic-export.mjs)
 * with the given --pages, --strokes, --points, --printouts (defaults: the size
 * of the notebook "bm"). The export is picked through the dialog's folder
 * input exactly like a user does, in a persistent browser profile so that
 * IndexedDB lives on disk as in the installed app.
 *
 * Memory, sampled every --sample seconds (default 2):
 * - JS heap: CDP Performance.getMetrics (JSHeapUsedSize/JSHeapTotalSize) of the page.
 * - WASM: the byte length of every live WebAssembly.Memory of the page, found
 *   with CDP Runtime.queryObjects on WebAssembly.Memory.prototype (Automerge's
 *   module memory; it only grows). This walks the heap, so it is sampled
 *   every --wasm-sample seconds (default 10) and once at the end.
 * - RSS: the summed resident memory of all Chromium processes of the profile
 *   (/proc, Linux only).
 * Timing comes from the app's own measurement (data-timing on the import
 * report): total and per phase. The script also records wall-clock time from
 * the click on "import" until the report appears, and --cap minutes (default
 * 45) stops a run that takes too long and reports how far it got.
 *
 * Output: a JSON summary on stdout (and --out <file>).
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';
import { BM_SCALE, writeSyntheticExport } from './onenote-synthetic-export.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1]]);
    return pairs;
  }, []),
);
const dist = args.dist;
if (!dist && !args.url) throw new Error('--dist <vite build output> or --url <running app> is required');
const port = Number(args.port ?? 5187);
const capMs = Number(args.cap ?? 45) * 60_000;
const sampleMs = Number(args.sample ?? 2) * 1000;
const wasmSampleMs = Number(args['wasm-sample'] ?? 10) * 1000;
const headed = args.headed === 'true';

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

/** Resident memory of every process whose command line names the profile directory. */
async function profileRss(profileDir) {
  let total = 0;
  for (const entry of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8');
      if (!cmdline.includes(profileDir)) continue;
      const status = await readFile(`/proc/${entry}/status`, 'utf8');
      const rss = /VmRSS:\s+(\d+) kB/.exec(status);
      if (rss) total += Number(rss[1]) * 1024;
    } catch {
      // The process ended between listing and reading.
    }
  }
  return total;
}

async function wasmBytes(cdp) {
  const prototype = await cdp.send('Runtime.evaluate', { expression: 'WebAssembly.Memory.prototype' });
  const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId,
    functionDeclaration: 'function () { return this.map((memory) => memory.buffer.byteLength); }',
    returnByValue: true,
  });
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'console' }).catch(() => undefined);
  const sizes = result.value ?? [];
  return { total: sizes.reduce((sum, size) => sum + size, 0), memories: sizes.length };
}

async function heap(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const value = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { used: value('JSHeapUsedSize'), total: value('JSHeapTotalSize') };
}

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'canvink-onenote-bench-'));
  const profileDir = join(work, 'profile');
  const exportDir = args.export ?? join(work, 'export');
  let server;
  let context;
  const summary = { startedAt: new Date().toISOString() };
  try {
    if (!args.export) {
      const generation = performance.now();
      summary.export = await writeSyntheticExport(exportDir, {
        pages: Number(args.pages ?? BM_SCALE.pages),
        strokes: Number(args.strokes ?? BM_SCALE.strokes),
        points: Number(args.points ?? BM_SCALE.points),
        printouts: Number(args.printouts ?? BM_SCALE.printouts),
        seed: Number(args.seed ?? 1),
        ...(args['printout-size'] ? { printoutSize: args['printout-size'] } : {}),
        ...(args['pdf-kb'] ? { pdfKb: Number(args['pdf-kb']) } : {}),
      });
      summary.export.generationMs = Math.round(performance.now() - generation);
    } else {
      summary.export = { directory: exportDir };
    }
    const baseUrl = args.url ?? `http://127.0.0.1:${port}`;
    if (!args.url) server = await serve(dist);
    context = await chromium.launchPersistentContext(profileDir, {
      headless: !headed,
      viewport: { width: 1440, height: 900 },
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
    });
    const page = context.pages()[0] ?? await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('crash', () => errors.push('renderer crashed'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');

    const opened = performance.now();
    await page.goto(`${baseUrl}/app`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('save-status').and(page.locator('[data-state="saved"]')).waitFor({ timeout: 120_000 });
    summary.appOpenMs = Math.round(performance.now() - opened);
    const baseline = { heap: await heap(cdp), wasm: await wasmBytes(cdp), rss: await profileRss(profileDir) };

    await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
    await page.getByRole('button', { name: 'OneNote importieren' }).click();
    const dialog = page.getByRole('dialog', { name: 'OneNote sicher importieren' });
    await dialog.getByRole('radio', { name: 'OneNote Desktop-Export (Ordner)' }).click();
    const reviewStarted = performance.now();
    await dialog.getByLabel('Exportordner wählen').setInputFiles(exportDir);
    await dialog.getByRole('button', { name: 'Auswahl prüfen' }).waitFor({ timeout: 600_000 });
    await dialog.getByRole('button', { name: 'Auswahl prüfen' }).click();
    await dialog.getByRole('checkbox', { name: /Ich bestätige genau diesen Fingerabdruck/ }).waitFor({ timeout: 600_000 });
    summary.reviewMs = Math.round(performance.now() - reviewStarted);
    await dialog.getByRole('checkbox', { name: /Ich bestätige genau diesen Fingerabdruck/ }).check();

    const peak = { heapUsed: baseline.heap.used, heapTotal: baseline.heap.total, wasm: baseline.wasm.total, rss: baseline.rss };
    const samples = [];
    let lastWasm = 0;
    let lastLog = 0;
    const started = performance.now();
    await dialog.getByRole('button', { name: 'Additiv importieren' }).click();
    const report = dialog.getByTestId('onenote-import-timing');
    let finished = false;
    let failure;
    while (!finished) {
      const elapsed = performance.now() - started;
      if (elapsed > capMs) {
        failure = `time cap of ${capMs / 60_000} min reached`;
        break;
      }
      const sample = { t: Math.round(elapsed) };
      try {
        const current = await heap(cdp);
        sample.heapUsed = current.used;
        peak.heapUsed = Math.max(peak.heapUsed, current.used);
        peak.heapTotal = Math.max(peak.heapTotal, current.total);
        if (elapsed - lastWasm >= wasmSampleMs) {
          lastWasm = elapsed;
          sample.wasm = (await wasmBytes(cdp)).total;
          peak.wasm = Math.max(peak.wasm, sample.wasm);
        }
      } catch (error) {
        failure = `browser stopped responding: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
      sample.rss = await profileRss(profileDir);
      peak.rss = Math.max(peak.rss, sample.rss);
      sample.progress = (await dialog.locator('.onenote-import-progress span').textContent({ timeout: 1000 }).catch(() => null)) ?? undefined;
      samples.push(sample);
      if (elapsed - lastLog >= 15_000) {
        lastLog = elapsed;
        console.error(`[${Math.round(elapsed / 1000)} s] ${sample.progress ?? ''} heap ${mb(sample.heapUsed)} MB, rss ${mb(sample.rss)} MB${sample.wasm ? `, wasm ${mb(sample.wasm)} MB` : ''}`);
      }
      const alert = await dialog.getByRole('alert').textContent({ timeout: 200 }).catch(() => null);
      if (alert) {
        failure = `import failed: ${alert}`;
        break;
      }
      if (errors.some((error) => error === 'renderer crashed')) {
        failure = 'renderer crashed';
        break;
      }
      finished = await report.isVisible().catch(() => false);
      if (!finished) await page.waitForTimeout(sampleMs);
    }
    summary.wallClockMs = Math.round(performance.now() - started);
    if (finished) {
      summary.timing = JSON.parse(await report.getAttribute('data-timing'));
      summary.stats = JSON.parse(await report.getAttribute('data-stats'));
      await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
      summary.afterImport = { heap: await heap(cdp), wasm: await wasmBytes(cdp), rss: await profileRss(profileDir) };
      peak.wasm = Math.max(peak.wasm, summary.afterImport.wasm.total);
      await dialog.getByRole('button', { name: 'Zum neuen Notizbuch' }).click();
      // Reopen the app with the imported notebook in the workspace.
      const reopened = performance.now();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('save-status').and(page.locator('[data-state="saved"]')).waitFor({ timeout: 300_000 });
      summary.reopenMs = Math.round(performance.now() - reopened);
      await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
      summary.afterReopen = { heap: await heap(cdp), wasm: await wasmBytes(cdp), rss: await profileRss(profileDir) };
    } else {
      summary.failure = failure;
      summary.lastProgress = samples.at(-1)?.progress;
    }
    summary.baseline = baseline;
    summary.peak = peak;
    summary.peakMb = { heapUsed: mb(peak.heapUsed), heapTotal: mb(peak.heapTotal), wasm: mb(peak.wasm), rss: mb(peak.rss) };
    summary.pageErrors = errors.slice(0, 10);
    summary.samples = samples;
  } finally {
    await context?.close().catch(() => undefined);
    server?.close();
    if (args.keep !== 'true') await rm(work, { recursive: true, force: true });
  }
  const json = JSON.stringify(summary, null, 2);
  if (args.out) await writeFile(args.out, json);
  console.log(JSON.stringify({ ...summary, samples: `${summary.samples?.length ?? 0} samples (see --out)` }, null, 2));
  if (summary.failure) process.exitCode = 1;
}

await main();
