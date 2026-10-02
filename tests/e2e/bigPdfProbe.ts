import { readdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { bookPdf } from "../../scripts/bench/syntheticPdf";

/** A synthetic solution book, generated once per worker and reused. */
const books = new Map<number, Promise<Buffer>>();
export function book(pages: number): Promise<Buffer> {
  let existing = books.get(pages);
  if (!existing) {
    existing = bookPdf(pages).then((bytes) => Buffer.from(bytes));
    books.set(pages, existing);
  }
  return existing;
}

/** Inserts a PDF as a printout through the ribbon's file input, as a user does. */
export async function insertPdf(page: Page, bytes: Buffer, name = "loesungen.pdf"): Promise<void> {
  await page.locator('input[type="file"][accept*="application/pdf"]').setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
}

export interface Probe {
  /** Frame-to-frame movement of the paper's on-screen top edge, in CSS px, that no input caused. */
  jumps: number[];
  /** Largest distance the paper's top edge moved from where it was when the probe started. */
  maxDrift: number;
  frames: number[];
  longTasks: number[];
}

/**
 * Installs a sampler in the page: every frame it records where the page's
 * paper sits on screen and how long the frame took. `stop` returns the
 * samples. Movement while the page gets no wheel input, and a short while
 * (in time and in frames) after the last, is a jump.
 */
export async function startProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = {
      running: true,
      last: 0,
      lastTop: NaN,
      firstTop: NaN,
      frames: [] as number[],
      jumps: [] as number[],
      maxDrift: 0,
      longTasks: [] as number[],
      inputSince: 0,
      // Frames painted since the probe started, and the count when input last arrived.
      frameCount: 0,
      inputFrame: -1_000,
    };
    const w = window as unknown as { __probe: typeof state; __probeInput: () => void };
    w.__probe = state;
    // The test calls this right before it sends a wheel event.
    w.__probeInput = () => {
      state.inputSince = performance.now();
      state.inputFrame = state.frameCount;
    };
    // The wheel event itself, when the page receives it: on a busy machine it
    // arrives long after the test sent it.
    window.addEventListener("wheel", () => w.__probeInput(), { capture: true, passive: true });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: false });
    } catch { /* long task API missing */ }
    const tick = (now: number) => {
      if (!state.running) return;
      state.frameCount += 1;
      if (state.last) state.frames.push(now - state.last);
      state.last = now;
      const surface = document.querySelector(".live-canvas-surface");
      const top = surface ? surface.getBoundingClientRect().top : NaN;
      if (Number.isFinite(top)) {
        if (Number.isNaN(state.firstTop)) state.firstTop = top;
        // Time alone cannot say whether the page is still answering input: a
        // busy machine answers late, and its frames are late too. A few dozen
        // frames must have passed as well.
        const quiet = now - state.inputSince > 400 && state.frameCount - state.inputFrame > 30;
        if (quiet && Number.isFinite(state.lastTop) && Math.abs(top - state.lastTop) > 1.5) state.jumps.push(top - state.lastTop);
        if (quiet) state.maxDrift = Math.max(state.maxDrift, Math.abs(top - state.firstTop));
        state.lastTop = top;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function markInput(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __probeInput?: () => void }).__probeInput?.());
}

export async function stopProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const state = (window as unknown as { __probe: { running: boolean; frames: number[]; jumps: number[]; maxDrift: number; longTasks: number[] } }).__probe;
    state.running = false;
    return { frames: state.frames, jumps: state.jumps, maxDrift: state.maxDrift, longTasks: state.longTasks };
  });
}

/** Printout elements that are on screen, and how many of them already show a picture. */
export async function visiblePrintouts(page: Page): Promise<{ inView: number; withPicture: number; sharp: number }> {
  return page.evaluate(() => {
    const viewport = document.querySelector(".live-canvas-viewport")?.getBoundingClientRect();
    if (!viewport) return { inView: 0, withPicture: 0, sharp: 0 };
    let inView = 0;
    let withPicture = 0;
    let sharp = 0;
    for (const node of document.querySelectorAll<HTMLElement>('[data-element-kind="pdf"]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue;
      inView += 1;
      const image = node.querySelector<HTMLImageElement>("img");
      if (image?.complete && image.naturalWidth > 0) {
        withPicture += 1;
        if (image.dataset.quality !== "thumb") sharp += 1;
      }
    }
    return { inView, withPicture, sharp };
  });
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/** Resident memory of the browser processes a Playwright run started, in MB (Linux only). */
export function browserResidentMb(): number {
  let kilobytes = 0;
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!command.includes("playwright_chromiumdev_profile")) continue;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const match = /VmRSS:\s+(\d+) kB/.exec(status);
      if (match) kilobytes += Number(match[1]);
    } catch { /* process ended */ }
  }
  return Math.round(kilobytes / 1024);
}
