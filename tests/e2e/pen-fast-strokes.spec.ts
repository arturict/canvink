import type { CDPSession, Page } from "@playwright/test";
import { expect, expectInkCount, gotoApp, inkStrokes, ribbonTab, saveStatus, test } from "./support";

/**
 * Quick handwriting from an active pen. Windows Ink delivers ~240 samples a
 * second while the page sees one pointermove per frame, so every move carries
 * a batch of coalesced samples. Chromium's DevTools input coalesces the same
 * way when several events arrive within one frame, which these tests use: a
 * burst of pen events per frame, one stroke after the other without a pause,
 * some of them plain taps. They check what is stored and painted against the
 * path that was sent, and what the pointer handlers cost the main thread.
 *
 * The CPU runs at a quarter of its speed (a thin laptop next to this
 * machine), which is where a stroke that is written inside the pen-up handler
 * delays the next one.
 */
test.use({ hasTouch: true, trace: "off", screenshot: "off" });

const CPU_SLOWDOWN = Number(process.env.PEN_CPU_THROTTLE ?? 4);

interface Pt {
  x: number;
  y: number;
}

interface Canvas {
  client: CDPSession;
  view: { x: number; y: number; width: number; height: number };
}

async function openCanvas(page: Page): Promise<Canvas> {
  await gotoApp(page);
  await (await ribbonTab(page, "Zeichnen")).getByRole("button", { name: "Stift", exact: true }).click();
  const view = await page.getByLabel("Ansicht der Zeichenfläche").boundingBox();
  if (!view) throw new Error("The canvas view has no bounds.");
  const client = await page.context().newCDPSession(page);
  if (CPU_SLOWDOWN > 1) await client.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  return { client, view };
}

interface Probe {
  moves: number;
  coalesced: number;
  rawUpdates: number;
  moveMs: number[];
  downMs: number[];
  upMs: number[];
  longTasks: number[];
}

/** Times what the page spends on a pointer event: from the window's capture phase to its bubble phase. */
async function instrument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe: Probe = { moves: 0, coalesced: 0, rawUpdates: 0, moveMs: [], downMs: [], upMs: [], longTasks: [] };
    const timed = (type: string, sink: number[]) => {
      let started = 0;
      window.addEventListener(type, (event) => {
        started = performance.now();
        if (type === "pointermove" && (event as PointerEvent).buttons !== 0) {
          probe.moves += 1;
          probe.coalesced += (event as PointerEvent).getCoalescedEvents().length;
        }
      }, { capture: true });
      window.addEventListener(type, (event) => {
        // A hovering move is not a stroke.
        if (type !== "pointermove" || (event as PointerEvent).buttons !== 0) sink.push(performance.now() - started);
      });
    };
    timed("pointermove", probe.moveMs);
    timed("pointerdown", probe.downMs);
    timed("pointerup", probe.upMs);
    window.addEventListener("pointerrawupdate", () => { probe.rawUpdates += 1; }, { capture: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
    }).observe({ type: "longtask" });
    (window as unknown as { __penProbe: Probe }).__penProbe = probe;
  });
}

const readProbe = (page: Page): Promise<Probe> =>
  page.evaluate(() => (window as unknown as { __penProbe: Probe }).__penProbe);

function mouse(client: CDPSession, type: "mousePressed" | "mouseMoved" | "mouseReleased", point: Pt, force = 0.5) {
  return client.send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    pointerType: "pen",
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
    force: type === "mouseReleased" ? 0 : force,
    tiltX: 0,
    tiltY: 0,
  });
}

const nextFrame = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

/** Sends samples a burst per frame (4 samples are a 240 Hz digitizer on a 60 Hz display). */
async function sendMoves(page: Page, client: CDPSession, moves: readonly Pt[], burst = 4) {
  for (let at = 0; at < moves.length; at += burst) {
    await Promise.all(moves.slice(at, at + burst).map((point) => mouse(client, "mouseMoved", point)));
    await nextFrame(page);
  }
}

async function writeStroke(page: Page, client: CDPSession, path: readonly Pt[], burst = 4) {
  const [first, ...rest] = path;
  await mouse(client, "mousePressed", first);
  await sendMoves(page, client, rest.slice(0, -1), burst);
  await mouse(client, "mouseReleased", rest.length > 0 ? rest[rest.length - 1] : first);
}

const along = (from: Pt, to: Pt, steps: number): Pt[] =>
  Array.from({ length: steps + 1 }, (_, index) => ({
    x: from.x + ((to.x - from.x) * index) / steps,
    y: from.y + ((to.y - from.y) * index) / steps,
  }));

interface Written {
  /** Every sample sent for the stroke, in order. */
  path: Pt[];
  /** Whether the stroke is a tap that moves less than a pixel. */
  dot: boolean;
  /** Samples at a sharp turn: the ink has to reach exactly there. */
  tips?: Pt[];
}

/** Letters as quick as a student writes them: loops, sharp turns, a dot. About 9 px between samples. */
function handwriting(origin: Pt, letters: number): Written[] {
  const strokes: Written[] = [];
  for (let letter = 0; letter < letters; letter += 1) {
    const x = origin.x + (letter % 16) * 46;
    const y = origin.y + Math.floor(letter / 16) * 66;
    const loop: Pt[] = [];
    for (let index = 0; index <= 28; index += 1) {
      const angle = (index / 28) * Math.PI * 1.8 + 0.3;
      loop.push({ x: x + 14 + Math.cos(angle) * 14, y: y + 14 + Math.sin(angle) * 11 });
    }
    strokes.push({ path: loop, dot: false });
    strokes.push({
      path: [
        ...along({ x: x + 34, y }, { x: x + 36, y: y - 26 }, 5),
        ...along({ x: x + 36, y: y - 26 }, { x: x + 40, y: y + 22 }, 8).slice(1),
      ],
      dot: false,
    });
    if (letter % 3 === 0) strokes.push({ path: [{ x: x + 20, y: y - 36 }, { x: x + 20.4, y: y - 35.8 }], dot: true });
    if (letter % 4 === 1) {
      // An "m" written in a hurry: a sample only at every turn, 12 px apart.
      const m = [0, 1, 2, 3, 4].map((turn) => ({ x: x + turn * 11, y: y + (turn % 2 === 0 ? 30 : 0) }));
      strokes.push({ path: m, dot: false, tips: m.filter((_, turn) => turn % 2 === 1) });
    }
  }
  return strokes;
}

/**
 * The input points that are not inked: a point counts as inked when a pixel
 * within `reach` device pixels of it is painted on an ink tile, or, for `overlay`,
 * on the canvas that shows the stroke under the pen.
 */
async function uncovered(page: Page, points: readonly Pt[], layer: "tiles" | "overlay", reach = 1): Promise<Pt[]> {
  return page.evaluate(({ points: wanted, layer: where, reach: slack }) => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>(
      where === "tiles" ? ".live-canvas-ink-tile" : ".live-canvas-ink-overlay",
    )].map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect(), context: canvas.getContext("2d")! }));
    return wanted.filter((point) => {
      for (const { canvas, rect, context } of canvases) {
        if (point.x < rect.left || point.x >= rect.right || point.y < rect.top || point.y >= rect.bottom) continue;
        const px = Math.floor(((point.x - rect.left) / rect.width) * canvas.width);
        const py = Math.floor(((point.y - rect.top) / rect.height) * canvas.height);
        const { data } = context.getImageData(Math.max(0, px - slack), Math.max(0, py - slack), 2 * slack + 1, 2 * slack + 1);
        for (let index = 3; index < data.length; index += 4) if (data[index] > 0) return false;
      }
      return true;
    });
  }, { points: [...points], layer, reach });
}

function storedPoints(localPoints: string): Pt[] {
  return localPoints.split(" ").map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return { x, y };
  });
}

const percentile = (values: number[], quantile: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
};

test("fast handwriting keeps every stroke and every sample, paints the corners, and never makes the pen wait", async ({ page }) => {
  const { client, view } = await openCanvas(page);
  await instrument(page);
  const written = handwriting({ x: view.x + 80, y: view.y + 110 }, Number(process.env.PEN_LETTERS ?? 14));
  for (const { path } of written) await writeStroke(page, client, path);
  await expectInkCount(page, written.length);
  const stored = await inkStrokes(page);
  expect(stored).toHaveLength(written.length);

  // Stored against sent: every sample the pen sent is there, nothing was invented.
  for (const [index, { path, dot }] of written.entries()) {
    const points = storedPoints(stored[index].localPoints);
    const left = Math.min(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    // Samples go in as screen coordinates; the stroke keeps them relative to its frame.
    const screen = points.map((point) => ({ x: stored[index].box.x + point.x - left, y: stored[index].box.y + point.y - top }));
    for (const sent of path) {
      const nearest = Math.min(...screen.map((point) => Math.hypot(point.x - sent.x, point.y - sent.y)));
      expect(nearest, `stroke ${index} sample ${sent.x},${sent.y}`).toBeLessThan(dot ? 1 : 0.6);
    }
    for (const point of screen) {
      const nearest = Math.min(...path.map((sent) => Math.hypot(point.x - sent.x, point.y - sent.y)));
      expect(nearest, `stroke ${index} stored ${point.x},${point.y}`).toBeLessThan(dot ? 1 : 0.6);
    }
  }

  // Painted against sent: the ink reaches every sample, the sharp tips and the dots included.
  const samples = written.flatMap(({ path }) => path);
  expect(await uncovered(page, samples, "tiles")).toEqual([]);
  // At a sharp turn the pen's tip is on the sample itself, not rounded off short of it.
  expect(await uncovered(page, written.flatMap(({ tips }) => tips ?? []), "tiles", 0)).toEqual([]);

  const probe = await readProbe(page);
  test.info().annotations.push({ type: "pen-timing", description: JSON.stringify({
    strokes: written.length,
    moves: probe.moves,
    coalescedPerMove: Number((probe.coalesced / Math.max(1, probe.moves)).toFixed(2)),
    rawUpdates: probe.rawUpdates,
    moveP50: percentile(probe.moveMs, 0.5),
    moveP95: percentile(probe.moveMs, 0.95),
    moveMax: Math.max(0, ...probe.moveMs),
    downP95: percentile(probe.downMs, 0.95),
    upP50: percentile(probe.upMs, 0.5),
    upP95: percentile(probe.upMs, 0.95),
    upMax: Math.max(0, ...probe.upMs),
    longTasks: probe.longTasks.length,
    longTaskMax: Math.max(0, ...probe.longTasks),
    cpuSlowdown: CPU_SLOWDOWN,
  }) });
  expect(probe.coalesced / Math.max(1, probe.moves), "the test delivers coalesced batches").toBeGreaterThan(1.5);
  // Writing a stroke used to run inside the pen-up handler: 40 ms and more per stroke at this speed.
  // The median, because other workers share this machine and spike the tail.
  expect(percentile(probe.upMs, 0.5)).toBeLessThan(CPU_SLOWDOWN > 1 ? 8 : 3);
  expect(percentile(probe.moveMs, 0.5)).toBeLessThan(CPU_SLOWDOWN > 1 ? 6 : 2);
});

test("the stroke under the pen is painted up to the newest sample while the pen is still down", async ({ page }) => {
  const { client, view } = await openCanvas(page);
  const loop: Pt[] = [];
  for (let index = 0; index <= 40; index += 1) {
    const angle = (index / 40) * Math.PI * 2;
    loop.push({ x: view.x + 300 + Math.cos(angle) * 60, y: view.y + 260 + Math.sin(angle) * 40 });
  }
  await mouse(client, "mousePressed", loop[0]);
  const sent: Pt[] = [loop[0]];
  for (let at = 1; at < loop.length - 1; at += 10) {
    const burst = loop.slice(at, Math.min(at + 10, loop.length - 1));
    await sendMoves(page, client, burst);
    sent.push(...burst);
    // Every sample so far is inked on the overlay, the newest one included.
    expect(await uncovered(page, sent, "overlay"), `after ${sent.length} samples`).toEqual([]);
  }
  await mouse(client, "mouseReleased", loop[loop.length - 1]);
  await expectInkCount(page, 1);
  expect(await uncovered(page, sent, "tiles")).toEqual([]);
});

test("quick taps leave a dot each and none is lost", async ({ page }) => {
  const { client, view } = await openCanvas(page);
  const taps = Array.from({ length: 24 }, (_, index) => ({
    x: view.x + 120 + (index % 12) * 40,
    y: view.y + 200 + Math.floor(index / 12) * 50,
  }));
  for (const [index, tap] of taps.entries()) {
    await mouse(client, "mousePressed", tap, 0.3 + (index % 4) * 0.15);
    // Every other tap drifts half a pixel before it lifts, as a real tip does.
    if (index % 2 === 1) await mouse(client, "mouseMoved", { x: tap.x + 0.5, y: tap.y + 0.3 }, 0.4);
    await mouse(client, "mouseReleased", tap);
  }
  await expectInkCount(page, taps.length);
  expect(await uncovered(page, taps, "tiles")).toEqual([]);
});

test("a stroke the browser cancels mid-way keeps everything drawn so far", async ({ page }) => {
  await openCanvas(page);
  await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>("[data-ink-stroke-count]");
    if (!surface) throw new Error("The canvas is missing.");
    const box = surface.getBoundingClientRect();
    const fire = (type: string, x: number, y: number, buttons: number) =>
      surface.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 41, pointerType: "pen",
        isPrimary: true, clientX: x, clientY: y, button: 0, buttons, pressure: buttons === 0 ? 0 : 0.5,
      }));
    fire("pointerdown", box.left + 200, box.top + 200, 1);
    for (let step = 1; step <= 8; step += 1) fire("pointermove", box.left + 200 + step * 12, box.top + 200 + step * 3, 1);
    // A cancel carries no usable position.
    fire("pointercancel", 0, 0, 0);
  });
  await expectInkCount(page, 1);
  const [stroke] = await inkStrokes(page);
  expect(stroke.localPoints.split(" ").length).toBeGreaterThanOrEqual(9);
  expect(stroke.box.width).toBeGreaterThan(90);
  expect(stroke.box.width).toBeLessThan(110);
});

test("undo right after a quick run of strokes takes them back one by one, before they were written", async ({ page }) => {
  const { client, view } = await openCanvas(page);
  for (let index = 0; index < 3; index += 1) {
    await writeStroke(page, client, along({ x: view.x + 150, y: view.y + 200 + index * 40 }, { x: view.x + 330, y: view.y + 215 + index * 40 }, 12));
  }
  // No pause: the strokes are still waiting to be written when undo asks for the history.
  await page.keyboard.press("Control+z");
  await expectInkCount(page, 2);
  await page.keyboard.press("Control+z");
  await expectInkCount(page, 1);
  await page.keyboard.press("Control+Shift+z");
  await expectInkCount(page, 2);
});

test.describe("on a 150% display, zoomed in", () => {
  test.use({ deviceScaleFactor: 1.5 });

  test("the live stroke and the written one are inked under the pen at a fractional pixel ratio and zoom", async ({ page }) => {
    const { client, view } = await openCanvas(page);
    const centre = { x: view.x + view.width / 2, y: view.y + 260 };
    await page.mouse.move(centre.x, centre.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await page.waitForTimeout(400);
    const loop: Pt[] = [];
    for (let index = 0; index <= 36; index += 1) {
      const angle = (index / 36) * Math.PI * 1.9;
      loop.push({ x: centre.x + Math.cos(angle) * 70, y: centre.y + 20 + Math.sin(angle) * 45 });
    }
    await mouse(client, "mousePressed", loop[0]);
    const sent: Pt[] = [loop[0]];
    for (let at = 1; at < loop.length - 1; at += 9) {
      const burst = loop.slice(at, Math.min(at + 9, loop.length - 1));
      await sendMoves(page, client, burst);
      sent.push(...burst);
      expect(await uncovered(page, sent, "overlay"), `after ${sent.length} samples`).toEqual([]);
    }
    await mouse(client, "mouseReleased", loop[loop.length - 1]);
    await expectInkCount(page, 1);
    expect(await uncovered(page, sent, "tiles")).toEqual([]);
  });
});

test("a stroke is still there after an immediate reload, and the page is not called saved before", async ({ page }) => {
  const { client, view } = await openCanvas(page);
  await writeStroke(page, client, along({ x: view.x + 150, y: view.y + 200 }, { x: view.x + 330, y: view.y + 215 }, 12));
  // The stroke waits for the pen to rest; until it is written the page is not saved.
  await expect(saveStatus(page)).not.toHaveAttribute("data-state", "saved");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectInkCount(page, 1);
});
