/**
 * Opening a share link: the shared notebook lands in the normal app, in the
 * workspace of whoever opens it. Two (or three) browser contexts against a
 * local collab-sync Worker; see `collabSupport.ts` for the identities.
 */

import type { Page } from "@playwright/test";
import {
  activeNotebookTitle,
  addTextFromRibbon,
  contextCommand,
  expect,
  notebookOption,
  openNotebookSwitcher,
  submitInlineRename,
  waitForSaved,
} from "./support";
import {
  canvas,
  collabTest as test,
  drawWave,
  joinAs,
  joinAsInvited,
  makeIdentity,
  openAs,
  openPageByTitle,
  pageTitle,
  pickPen,
  shareActiveNotebook,
  readOnlyBadge,
  strokeCount,
} from "./collabSupport";

const SHOTS = "test-results/collab-shots";
const NOTEBOOK = "Gemeinsames Heft";
const TEXT = "Inhalt für die Mitarbeit.";

async function renameActiveNotebook(page: Page, title: string): Promise<void> {
  const current = ((await activeNotebookTitle(page).textContent()) ?? "").trim();
  const switcher = await openNotebookSwitcher(page);
  await contextCommand(page, notebookOption(page, switcher, current), "Umbenennen");
  await submitInlineRename(page, title);
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText(title);
  if (await switcher.isVisible()) await page.keyboard.press("Escape");
}

async function notebookNames(page: Page): Promise<string[]> {
  const switcher = await openNotebookSwitcher(page);
  const names = await switcher.locator(".notebook-switcher__option:not(.notebook-switcher__option--page) .notebook-switcher__option-title").allTextContents();
  await page.keyboard.press("Escape");
  return names.map((name) => name.trim());
}

async function setUpSharedNotebook(page: Page, owner: ReturnType<typeof makeIdentity>): Promise<string> {
  await openAs(page, owner);
  await renameActiveNotebook(page, NOTEBOOK);
  await addTextFromRibbon(page);
  const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
  await expect(editor).toBeFocused();
  await editor.fill(TEXT);
  await page.getByLabel("Seitentitel").fill("Erste Seite");
  await waitForSaved(page);
  return shareActiveNotebook(page);
}

test.describe("opening a share link", () => {
  test("a signed-in joiner gets the notebook in the normal app next to their own, and edits sync both ways", async ({ page, browser }) => {
    test.setTimeout(150_000);
    const anna = makeIdentity("anna", "Anna Keller");
    const ben = makeIdentity("ben", "Ben Rossi");
    await setUpSharedNotebook(page, anna);

    // Ben is invited by e-mail address as an editor (a link would make him a reader).
    const joined = await joinAsInvited(browser, page, ben, NOTEBOOK);
    try {
      const guest = joined.page;
      await waitForSaved(guest);
      await expect(readOnlyBadge(guest)).toHaveCount(0);

      // The normal shell: ribbon, section sidebar, page list and a full-width canvas, not a card.
      for (const tab of ["Start", "Einfügen", "Zeichnen", "Ansicht"] as const) {
        await expect(guest.getByRole("tab", { name: new RegExp(`^${tab}$`) })).toBeVisible();
      }
      await expect(guest.locator(".page-row__title", { hasText: "Erste Seite" })).toBeVisible();
      await expect(guest.locator(".collab-join-surface, .collab-join-surface__card, .collab-join-surface__page-picker")).toHaveCount(0);
      await expect(guest.getByRole("dialog")).toHaveCount(0);
      expect(guest.url()).not.toContain("#join");
      const surface = await canvas(guest).boundingBox();
      expect(surface?.width ?? 0).toBeGreaterThan(600);
      // No nested scrolling: the page itself does not scroll, only the canvas inside the shell.
      expect(await guest.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
      await expect(canvas(guest).getByRole("textbox", { name: "Gemeinsamer Text" }).last()).toContainText(TEXT, { timeout: 20_000 });
      await guest.screenshot({ path: `${SHOTS}/joiner-shell.png` });

      // The shared notebook sits next to the joiner's own notebook, marked as shared.
      const names = await notebookNames(guest);
      expect(names).toContain(NOTEBOOK);
      expect(names.length).toBeGreaterThanOrEqual(2);
      await expect(guest.locator(".notebook-switcher__button [data-shared-notebook]")).toBeVisible();
      const switcher = await openNotebookSwitcher(guest);
      await expect(notebookOption(guest, switcher, NOTEBOOK).getByRole("img", { name: "Geteilt" })).toBeVisible();
      await guest.screenshot({ path: `${SHOTS}/joiner-switcher.png` });
      await guest.keyboard.press("Escape");

      // Presence works in the normal shell.
      await expect(page.locator(".presence-person__button")).toHaveAttribute("aria-label", /Ben Rossi/, { timeout: 15_000 });
      await expect(guest.locator(".presence-person__button")).toHaveAttribute("aria-label", /Anna Keller/, { timeout: 15_000 });

      // Edits sync both ways.
      await pickPen(page);
      await drawWave(page, { x: 140, y: 300 });
      await expect.poll(() => strokeCount(guest), { timeout: 20_000 }).toBe(1);
      await pickPen(guest);
      await drawWave(guest, { x: 140, y: 420 });
      await expect.poll(() => strokeCount(page), { timeout: 20_000 }).toBe(2);

      // A page the joiner adds reaches the owner's notebook.
      await guest.getByRole("button", { name: /^Seite hinzufügen/ }).first().click();
      await guest.getByLabel("Seitentitel").fill("Von Ben");
      await waitForSaved(guest);
      await expect(page.locator(".page-row__title", { hasText: "Von Ben" })).toBeVisible({ timeout: 30_000 });

      // A reload of the joiner keeps the notebook and its connection to the room.
      await guest.reload({ waitUntil: "domcontentloaded" });
      await waitForSaved(guest);
      expect(await notebookNames(guest)).toContain(NOTEBOOK);
      await openPageByTitle(guest, "Erste Seite");
      await expect.poll(() => strokeCount(guest)).toBe(2);
      await pickPen(page);
      await drawWave(page, { x: 140, y: 520 });
      await expect.poll(() => strokeCount(guest), { timeout: 30_000 }).toBe(3);
    } finally {
      await joined.context.close();
    }
  });

  test("the owner opening their own link lands in their notebook without a second copy", async ({ page, context }) => {
    const anna = makeIdentity("anna", "Anna Keller");
    const hash = await setUpSharedNotebook(page, anna);
    const before = await notebookNames(page);

    // A browser profile opens the app in one tab only, so the link opens where the first tab was.
    await page.close();
    const again = await context.newPage();
    try {
      await again.goto(`/app${anna.query}${hash}`, { waitUntil: "domcontentloaded" });
      await expect(activeNotebookTitle(again)).toHaveText(NOTEBOOK, { timeout: 30_000 });
      await expect(again.getByRole("dialog")).toHaveCount(0);
      expect(again.url()).not.toContain("#join");
      expect(await notebookNames(again)).toEqual(before);
      await again.screenshot({ path: `${SHOTS}/owner-own-link.png` });
    } finally {
      await again.close();
    }
  });

  test("a signed-out visitor is asked to sign in first", async ({ browser, page }) => {
    const anna = makeIdentity("anna", "Anna Keller");
    const hash = await setUpSharedNotebook(page, anna);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const visitor = await context.newPage();
    try {
      await visitor.goto(`/app?__canvinkTestSignedOut=1${hash}`, { waitUntil: "domcontentloaded" });
      const dialog = visitor.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByRole("heading", { name: NOTEBOOK })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Anmelden" })).toBeVisible();
      await visitor.screenshot({ path: `${SHOTS}/signed-out-prompt.png` });
    } finally {
      await context.close();
    }
  });

  test("a joiner can leave the notebook; the owner keeps it", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const anna = makeIdentity("anna", "Anna Keller");
    const ben = makeIdentity("ben", "Ben Rossi");
    const hash = await setUpSharedNotebook(page, anna);
    const joined = await joinAs(browser, hash, ben, NOTEBOOK);
    try {
      const guest = joined.page;
      const switcher = await openNotebookSwitcher(guest);
      await contextCommand(guest, notebookOption(guest, switcher, NOTEBOOK), "Freigabe verlassen");
      await guest.getByRole("alertdialog").or(guest.getByRole("dialog", { name: "Freigabe verlassen" })).getByRole("button", { name: "Verlassen" }).click();
      await expect.poll(() => notebookNames(guest), { timeout: 20_000 }).not.toContain(NOTEBOOK);
      await expect(activeNotebookTitle(page)).toHaveText(NOTEBOOK);
      expect(await pageTitle(page)).toBe("Erste Seite");
    } finally {
      await joined.context.close();
    }
  });

  test("another device of the same account is listed once, as the person themselves", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const anna = makeIdentity("anna", "Anna Keller");
    const ben = makeIdentity("ben", "Ben Rossi");
    const hash = await setUpSharedNotebook(page, anna);
    const first = await joinAs(browser, hash, ben, NOTEBOOK);
    const second = await joinAs(browser, hash, ben, NOTEBOOK);
    try {
      const faces = first.page.locator(".presence-person__button");
      await expect(faces).toHaveCount(2, { timeout: 20_000 });
      await expect(first.page.locator('.presence-person__button[aria-label^="Du (anderes Gerät)"]')).toHaveCount(1);
      await expect(first.page.locator('.presence-person__button[aria-label^="Anna Keller"]')).toHaveCount(1);
      // The owner sees Ben once, although two devices of his are in the room.
      await expect(page.locator(".presence-stack")).toHaveAttribute("data-presence-count", "1", { timeout: 20_000 });
      await first.page.locator('.presence-person__button[aria-label^="Du (anderes Gerät)"]').hover();
      await expect(first.page.locator(".presence-preview__name")).toHaveText("Du (anderes Gerät)");
      await first.page.screenshot({ path: `${SHOTS}/own-other-device.png`, clip: { x: 900, y: 0, width: 540, height: 340 } });
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });
});

test.describe("presence preview", () => {
  test("paints the ink around the other person's pointer, also on a page that is not open here", async ({ page, browser }) => {
    test.setTimeout(150_000);
    const anna = makeIdentity("anna", "Anna Keller");
    const ben = makeIdentity("ben", "Ben Rossi");
    await openAs(page, anna);
    await renameActiveNotebook(page, NOTEBOOK);
    await addTextFromRibbon(page);
    const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
    await editor.fill("Vorschau Text");
    await page.getByLabel("Seitentitel").fill("Skizzenseite");
    await waitForSaved(page);
    await pickPen(page);
    for (const y of [180, 230, 280]) await drawWave(page, { x: 120, y });
    await expect.poll(() => strokeCount(page)).toBe(3);
    await waitForSaved(page);
    // The pen rests, the strokes are sealed into a segment, and the segment goes to the room.
    await page.waitForTimeout(4_500);
    const joined = await joinAsInvited(browser, page, ben, NOTEBOOK);
    try {
      const guest = joined.page;
      // Ben stays on another page, so the page Anna is on is not open at his end.
      await guest.getByRole("button", { name: /^Seite hinzufügen/ }).first().click();
      await guest.getByLabel("Seitentitel").fill("Leere Seite");
      await waitForSaved(guest);
      expect(await pageTitle(guest)).toBe("Leere Seite");

      // Anna points at her ink.
      const box = await canvas(page).boundingBox();
      if (!box) throw new Error("The canvas has no bounds.");
      await page.mouse.move(box.x + 200, box.y + 230);
      await page.mouse.move(box.x + 210, box.y + 235);

      const face = guest.locator('.presence-person__button[aria-label^="Anna Keller"]');
      await expect(face).toBeVisible({ timeout: 20_000 });
      await face.hover();
      const preview = guest.locator(".presence-preview");
      await expect(preview.locator("canvas")).toHaveAttribute("data-presence-preview-ready", "true", { timeout: 30_000 });
      await expect(preview.locator(".presence-preview__page")).toContainText("Seite Skizzenseite");

      await preview.screenshot({ path: `${SHOTS}/preview-with-ink.png` });
      const stats = await preview.locator("canvas").evaluate((element) => {
        const canvasElement = element as HTMLCanvasElement;
        const context = canvasElement.getContext("2d");
        if (!context) throw new Error("No 2d context.");
        const { width, height } = canvasElement;
        const data = context.getImageData(0, 0, width, height).data;
        let dark = 0;
        let inside = 0;
        let minX = width;
        let maxX = 0;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            if (data[offset + 3] === 0) continue;
            inside += 1;
            const luminance = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
            // Ink at the preview's scale is a thin, antialiased line; paper and ruling are lighter than this.
            if (luminance < 185) {
              dark += 1;
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
            }
          }
        }
        return { dark, inside, minX, maxX, width, height };
      });
      // The circle holds real content: handwriting-coloured pixels spread across it, not a blank sheet.
      expect(stats.dark).toBeGreaterThan(60);
      expect(stats.dark / stats.inside).toBeGreaterThan(0.003);
      expect(stats.maxX - stats.minX).toBeGreaterThan(stats.width * 0.25);
    } finally {
      await joined.context.close();
    }
  });
});
