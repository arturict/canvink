import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { book, insertPdf, markInput, startProbe, stopProbe } from "./bigPdfProbe";
import { expect, saveStatus, test } from "./support";

/**
 * Large PDF printouts: the pictures load without moving the page, show a
 * page-shaped placeholder of exactly their final size first, and appear
 * progressively while a long book is inserted.
 */
const PAGES = 40;
/** A4 printouts are placed at their natural size, 30 px apart. */
const PITCH = 842 + 30;

function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.byteLength);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((8 * 4 + 1) * 8, 200);
  for (let y = 0; y < 8; y += 1) rows[y * 33] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function surfaceTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector(".live-canvas-surface")!.getBoundingClientRect().top);
}

async function scrollBy(page: Page, deltaY: number): Promise<void> {
  // The viewport can be absent or empty for a moment while the page reloads or loads more of the book.
  const viewport = page.locator(".live-canvas-viewport");
  await expect(viewport).toBeVisible();
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await markInput(page);
  await page.mouse.wheel(0, deltaY);
  // The viewport commits its state a moment after the last tick.
  await page.waitForTimeout(400);
}

async function openBook(page: Page, pages: number): Promise<void> {
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await insertPdf(page, await book(pages));
  await expect(page.locator('[data-element-kind="pdf"]')).toHaveCount(pages, { timeout: 120_000 });
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: 120_000 });
}

test("the page stays where it is scrolled when the workspace changes underneath it", async ({ page }) => {
  test.setTimeout(180_000);
  await openBook(page, PAGES);
  await scrollBy(page, PITCH * 15);
  const before = await surfaceTop(page);
  expect(before).toBeLessThan(-PITCH * 10);
  await startProbe(page);
  // Any workspace revision (a sync adopting downloaded assets, a saved
  // insert) used to rebuild the editor and put the page back on top.
  await page.locator('input[type="file"][accept^="image/png"]').setInputFiles({ name: "punkt.png", mimeType: "image/png", buffer: tinyPng() });
  await expect(page.locator('[data-element-kind="image"]')).toHaveCount(1);
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const probe = await stopProbe(page);
  expect(probe.jumps).toEqual([]);
  expect(Math.abs((await surfaceTop(page)) - before)).toBeLessThan(2);
});

test("pages show progressively while a long book is inserted", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await insertPdf(page, await book(PAGES));
  const pictures = page.locator('[data-element-kind="pdf"] img.asset-preview-image');
  // The first pages are on screen while the rest of the book is still being rendered.
  await expect(pictures.first()).toBeVisible({ timeout: 30_000 });
  const partial = await page.locator('[data-element-kind="pdf"]').count();
  expect(partial).toBeGreaterThan(0);
  expect(partial).toBeLessThan(PAGES);
  await expect(page.locator('[data-element-kind="pdf"]')).toHaveCount(PAGES, { timeout: 120_000 });
  await expect(saveStatus(page)).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
  // The stack keeps the order of the book.
  const tops = await page.locator('[data-element-kind="pdf"]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).offsetTop));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
});

test("a page that is not loaded yet already has its final size and nothing moves when its picture arrives", async ({ page }) => {
  test.setTimeout(180_000);
  await openBook(page, PAGES);
  await page.reload({ waitUntil: "domcontentloaded" });
  const farPage = page.locator('[data-element-kind="pdf"]').nth(30);
  await expect(farPage).toHaveCount(1);
  // Far below the visible area: a light page-shaped placeholder of the final size, no text.
  await expect(farPage.locator(".asset-preview-frame")).toHaveAttribute("data-preview-state", "placeholder");
  const placeholderBox = (await farPage.boundingBox())!;
  expect(Math.abs(placeholderBox.width - 595)).toBeLessThan(2);
  expect(Math.abs(placeholderBox.height - 842)).toBeLessThan(2);
  expect(await farPage.locator(".asset-preview-frame").innerText()).toBe("");
  expect(await farPage.locator("img").count()).toBe(0);

  await startProbe(page);
  await scrollBy(page, PITCH * 30);
  await expect(farPage.locator("img.asset-preview-image[data-quality='sharp']")).toBeVisible({ timeout: 30_000 });
  const pictureBox = (await farPage.boundingBox())!;
  expect(Math.abs(pictureBox.width - placeholderBox.width)).toBeLessThan(1);
  expect(Math.abs(pictureBox.height - placeholderBox.height)).toBeLessThan(1);
  // While the pictures arrived the page did not move on its own.
  await page.waitForTimeout(1000);
  const probe = await stopProbe(page);
  expect(probe.jumps).toEqual([]);
});

test("only pages near the visible area keep decoded pictures while scrolling through a book", async ({ page }) => {
  test.setTimeout(180_000);
  await openBook(page, PAGES);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-element-kind="pdf"]').first()).toBeVisible();
  let most = 0;
  let mostSharp = 0;
  for (let step = 0; step < 12; step += 1) {
    await scrollBy(page, PITCH * 3);
    most = Math.max(most, await page.locator("img.asset-preview-image").count());
    mostSharp = Math.max(mostSharp, await page.locator("img.asset-preview-image[data-quality='sharp']").count());
  }
  // 36 pages were passed. Sharp pictures stay within the decoded-memory budget
  // (160 MB, about 18 pages of this size), thumbnails within four screens of the view.
  expect(mostSharp).toBeGreaterThan(0);
  expect(mostSharp).toBeLessThanOrEqual(19);
  expect(most).toBeLessThan(PAGES - 4);
  await expect(page.locator('[data-element-kind="pdf"] img.asset-preview-image[data-quality="sharp"]').first()).toBeVisible();
});

test("zooming in re-renders the page on screen sharper once the zoom has settled", async ({ page }) => {
  test.setTimeout(180_000);
  await openBook(page, 6);
  const frame = page.locator('[data-element-kind="pdf"]').first();
  const sharp = frame.locator("img[data-quality='sharp']");
  await expect(sharp).toBeVisible();
  const storedWidth = await sharp.evaluate((image) => (image as HTMLImageElement).naturalWidth);
  // Pinch-zoom in (Chromium reports a trackpad pinch as Ctrl+wheel).
  const box = (await page.locator(".live-canvas-viewport").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.keyboard.down("Control");
  for (let step = 0; step < 10; step += 1) await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  const zoomed = frame.locator("img[data-quality='zoom']");
  await expect(zoomed).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(() => zoomed.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(storedWidth * 1.1);
  // Back to the natural size the stored picture serves: the extra picture is dropped.
  await page.keyboard.down("Control");
  for (let step = 0; step < 24; step += 1) await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await expect(zoomed).toHaveCount(0, { timeout: 30_000 });
});
