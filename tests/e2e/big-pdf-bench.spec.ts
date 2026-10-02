import type { Page } from "@playwright/test";
import { book, browserResidentMb, insertPdf, percentile, startProbe, stopProbe, visiblePrintouts } from "./bigPdfProbe";
import { expect, saveStatus, test } from "./support";

/**
 * Numbers for a large PDF printout, on the machine this runs on. Only runs
 * with BIG_PDF_BENCH=1 (the numbers in the pull request come from dev-t15):
 * BIG_PDF_PAGES sets the book's page count (default 300).
 */
const PAGES = Number(process.env.BIG_PDF_PAGES ?? "300");
test.skip(process.env.BIG_PDF_BENCH !== "1", "benchmark: set BIG_PDF_BENCH=1");
test.setTimeout(600_000);

async function firstPicture(page: Page, since: number, timeout = 240_000): Promise<number> {
  await page.waitForFunction(() => {
    const viewport = document.querySelector(".live-canvas-viewport")?.getBoundingClientRect();
    if (!viewport) return false;
    for (const node of document.querySelectorAll<HTMLElement>('[data-element-kind="pdf"]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
      const image = node.querySelector<HTMLImageElement>("img");
      if (image?.complete && image.naturalWidth > 0) return true;
    }
    return false;
  }, undefined, { timeout, polling: 16 });
  return Date.now() - since;
}

async function allVisibleSharp(page: Page, since: number): Promise<number> {
  await expect.poll(async () => {
    const state = await visiblePrintouts(page);
    return state.inView > 0 && state.sharp === state.inView;
  }, { timeout: 120_000, intervals: [50] }).toBe(true);
  return Date.now() - since;
}

test(`bench: ${PAGES}-page printout`, async ({ page }) => {
  const result: Record<string, unknown> = { pages: PAGES };
  const bytes = await book(PAGES);
  result.pdfMb = +(bytes.byteLength / 872576).toFixed(2);
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

  // Insert.
  await page.evaluate(() => {
    const tasks: number[] = [];
    (window as unknown as { __tasks: number[] }).__tasks = tasks;
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) tasks.push(entry.duration); }).observe({ type: "longtask" });
  });
  const start = Date.now();
  await insertPdf(page, bytes);
  result.firstPageVisibleMs = await firstPicture(page, start);
  await expect(page.locator('[data-element-kind="pdf"]')).toHaveCount(PAGES, { timeout: 300_000 });
  result.allElementsMountedMs = Date.now() - start;
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: 300_000 });
  result.insertSavedMs = Date.now() - start;
  const tasks = await page.evaluate(() => (window as unknown as { __tasks: number[] }).__tasks);
  result.insertLongTasks = { count: tasks.length, totalMs: Math.round(tasks.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...tasks)) };
  result.insertResidentMb = browserResidentMb();
  process.stdout.write(`BIGPDF-PARTIAL ${JSON.stringify(result)}\n`);
  await page.waitForTimeout(1500);

  // Reopen at the top: how long until the first page shows and until the screen is sharp.
  const reopen = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await startProbe(page);
  result.reopenFirstPageMs = await firstPicture(page, reopen);
  result.reopenSharpMs = await allVisibleSharp(page, reopen);
  await page.waitForTimeout(3000);
  const idle = await stopProbe(page);
  result.reopenJumps = idle.jumps.length;
  result.reopenMaxDriftPx = Math.round(idle.maxDrift);
  result.reopenResidentMb = browserResidentMb();
  process.stdout.write(`BIGPDF-PARTIAL ${JSON.stringify(result)}\n`);

  // Scroll: steady reading speed, then a fling to the end.
  await page.mouse.move(700, 450);
  await startProbe(page);
  await page.evaluate(async (pages) => {
    const viewport = document.querySelector(".live-canvas-viewport") as HTMLElement;
    const send = (deltaY: number) => {
      (window as unknown as { __probeInput: () => void }).__probeInput();
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, clientX: 700, clientY: 450 }));
    };
    const steady = Math.min(pages, 60) * 872;
    let sent = 0;
    await new Promise<void>((resolve) => {
      const step = () => {
        send(120);
        sent += 120;
        if (sent >= steady) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, PAGES);
  const steady = await stopProbe(page);
  const frames = steady.frames;
  result.scroll = {
    frames: frames.length,
    p50Ms: +percentile(frames, 0.5).toFixed(1),
    p95Ms: +percentile(frames, 0.95).toFixed(1),
    over33ms: frames.filter((value) => value > 33).length,
    over100ms: frames.filter((value) => value > 100).length,
    avgFps: +(1000 / (frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length))).toFixed(1),
    longTasks: steady.longTasks.length,
    longTaskMaxMs: Math.round(Math.max(0, ...steady.longTasks)),
  };
  result.scrollResidentMb = browserResidentMb();
  process.stdout.write(`BIGPDF-PARTIAL ${JSON.stringify(result)}\n`);
  // Fling to the end and let it settle.
  await page.evaluate((distance) => {
    const viewport = document.querySelector(".live-canvas-viewport") as HTMLElement;
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: distance, bubbles: true, cancelable: true, clientX: 700, clientY: 450 }));
  }, Math.max(0, PAGES - 3 - Math.min(PAGES, 60)) * 872);
  const fling = Date.now();
  result.flingFirstPictureMs = await firstPicture(page, fling);
  result.flingSharpMs = await allVisibleSharp(page, fling);
  await page.waitForTimeout(2000);
  result.endResidentMb = browserResidentMb();
  const heap = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  result.jsHeapMb = Math.round(heap / 872576);
  const imagesInDom = await page.locator("img.asset-preview-image").count();
  result.imgElementsInDom = imagesInDom;
  process.stdout.write(`BIGPDF ${JSON.stringify(result)}\n`);
  test.info().annotations.push({ type: "big-pdf", description: JSON.stringify(result) });
});
