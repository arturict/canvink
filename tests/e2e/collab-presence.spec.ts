/**
 * Live presence and offline convergence in a shared notebook, with two
 * browser contexts against a local collab-sync Worker. Runs under
 * `tests/e2e/collab-sync.playwright.config.ts`, whose app build carries the
 * e2e auth seam (`src/auth/e2eTestAuth.ts`): `?__canvinkSpaceTestSub=` signs
 * a context in as a test identity the Worker accepts. The second person opens
 * the share link signed in, and the shared notebook lands in their own
 * workspace like any other notebook.
 */

import type { Page } from "@playwright/test";
import { activeNotebookTitle, expect, waitForSaved } from "./support";
import {
  canvas,
  collabTest as test,
  drawWave,
  joinAsInvited,
  joinAs,
  makeIdentity,
  openAs,
  openPageByTitle,
  pageTitle,
  pageView,
  pickPen,
  shareActiveNotebook,
  strokeCount,
} from "./collabSupport";

const anna = () => makeIdentity("anna", "Anna Keller");
const ben = () => makeIdentity("ben", "Ben Rossi");

async function notebookTitleOf(page: Page): Promise<string> {
  return ((await activeNotebookTitle(page).textContent()) ?? "").trim();
}

const SHOTS = "test-results/collab-shots";

test.describe("shared notebook presence", () => {
  test("shows who is on the page, their pointer and their stroke before it is committed", async ({ page, browser }) => {
    await openAs(page, anna());
    const joined = await joinAsInvited(browser, page, ben(), await notebookTitleOf(page));
    try {
      // Faces: each side sees the other on the current page, with a name.
      await expect(page.locator(".presence-person__button")).toHaveAttribute("aria-label", /Ben Rossi/, { timeout: 15_000 });
      await expect(joined.page.locator(".presence-person__button")).toHaveAttribute("aria-label", /Anna Keller/, { timeout: 15_000 });
      await expect(page.locator(".page-row.is-active .page-presence")).toHaveAttribute("aria-label", /Ben Rossi/);

      // Ben writes and keeps the pen down: Anna already sees the stroke and
      // Ben's labelled pointer, while nothing is committed yet.
      const before = await strokeCount(page);
      await pickPen(joined.page);
      await drawWave(joined.page, { x: 180, y: 220 }, true);
      await expect(page.locator("[data-presence-ink]")).toHaveCount(1, { timeout: 10_000 });
      await expect(page.locator(".canvas-presence__label", { hasText: "Ben Rossi" })).toBeVisible();
      expect(await strokeCount(page)).toBe(before);

      // Lifting the pen commits the stroke through the document.
      await joined.page.mouse.up();
      await expect.poll(() => strokeCount(page), { timeout: 15_000 }).toBe(before + 1);
      // The work region stays highlighted for a while after the stroke.
      await expect(page.locator(".canvas-presence__focus")).toHaveCount(1);

      // Leaving removes Ben's face.
      await joined.context.close();
      await expect(page.locator(".presence-stack")).toHaveCount(0, { timeout: 20_000 });
    } finally {
      await joined.context.close().catch(() => undefined);
    }
  });
});

test.describe("shared notebook jump and follow", () => {
  test("hover shows a round preview, a click jumps to the person's page and position, Folgen keeps following", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await openAs(page, anna());
    const firstTitle = await pageTitle(page);
    await page.getByRole("button", { name: /^Seite hinzufügen/ }).first().click();
    await page.getByLabel("Seitentitel").fill("Skizze");
    await waitForSaved(page);
    const joined = await joinAsInvited(browser, page, ben(), await notebookTitleOf(page));
    try {
      // Ben opens the first page, scrolls down and keeps his pointer over the paper.
      await openPageByTitle(joined.page, firstTitle);
      await pickPen(joined.page);
      await drawWave(joined.page, { x: 150, y: 520 });
      const box = await canvas(joined.page).boundingBox();
      if (!box) throw new Error("The canvas has no bounds.");
      await joined.page.mouse.move(box.x + 400, box.y + 300);
      await joined.page.mouse.wheel(0, 320);
      await expect.poll(async () => (await pageView(joined.page)).y, { timeout: 10_000 }).toBeGreaterThan(200);
      await joined.page.mouse.move(box.x + 260, box.y + 210);

      // Anna is on "Skizze" and sees Ben in the topbar with the page he is on.
      const benFace = page.locator(".presence-person__button").filter({ has: page.locator(".presence-avatar") });
      await expect(benFace).toHaveAttribute("aria-label", new RegExp(`Ben Rossi · Seite ${firstTitle}`), { timeout: 15_000 });
      expect(await pageTitle(page)).toBe("Skizze");

      // Hovering shows a round preview of the area around Ben's pointer.
      await benFace.hover();
      const preview = page.locator(".presence-preview");
      await expect(preview).toBeVisible();
      await expect(preview.locator("canvas")).toHaveAttribute("data-presence-preview-ready", "true");
      await expect(preview.locator(".presence-preview__page")).toContainText(`Seite ${firstTitle}`);
      await page.screenshot({ path: `${SHOTS}/hover-preview.png`, clip: { x: 900, y: 0, width: 540, height: 340 } });

      // A click takes Anna to Ben's page and to the part of it he looks at.
      await benFace.click();
      await expect.poll(() => pageTitle(page), { timeout: 15_000 }).toBe(firstTitle);
      const benView = await pageView(joined.page);
      await expect.poll(async () => {
        const view = await pageView(page);
        return Math.abs(view.y + view.height / 2 - (benView.y + benView.height / 2));
      }, { timeout: 10_000 }).toBeLessThan(4);
      await page.screenshot({ path: `${SHOTS}/jumped.png` });

      // Folgen: Ben changes page and scrolls, Anna's window follows until she moves it herself.
      await page.mouse.move(600, 500);
      await benFace.hover();
      await page.getByRole("button", { name: "Folgen", exact: true }).click();
      await expect(page.locator(".presence-follow-chip")).toContainText("Ben");
      await openPageByTitle(joined.page, "Skizze");
      await expect.poll(() => pageTitle(page), { timeout: 15_000 }).toBe("Skizze");
      const skizze = await canvas(joined.page).boundingBox();
      if (!skizze) throw new Error("The canvas has no bounds.");
      await joined.page.mouse.move(skizze.x + 400, skizze.y + 300);
      await joined.page.mouse.wheel(0, 500);
      await expect.poll(async () => {
        const [mine, theirs] = [await pageView(page), await pageView(joined.page)];
        return Math.abs(mine.y + mine.height / 2 - (theirs.y + theirs.height / 2));
      }, { timeout: 10_000 }).toBeLessThan(4);
      await page.screenshot({ path: `${SHOTS}/following.png` });

      // Moving her own canvas ends following.
      // The paper is taller than the window and was scrolled to Ben's view, so aim at the visible viewport.
      const mine = await page.locator(".live-canvas-viewport").boundingBox();
      if (!mine) throw new Error("The canvas viewport has no bounds.");
      await page.mouse.move(mine.x + mine.width / 2, mine.y + mine.height / 2);
      await page.mouse.wheel(0, 200);
      await expect(page.locator(".presence-follow-chip")).toHaveCount(0);
    } finally {
      await joined.context.close();
    }
  });

  test("dims a person who stopped moving and lights them up again on movement", async ({ page, browser }) => {
    await page.addInitScript(() => {
      (window as unknown as { __canvinkPresenceIdleMs: number }).__canvinkPresenceIdleMs = 2_000;
    });
    await openAs(page, anna());
    const hash = await shareActiveNotebook(page);
    const joined = await joinAs(browser, hash, ben(), await notebookTitleOf(page));
    try {
      const face = page.locator(".presence-person__button");
      await expect(face).toHaveAttribute("aria-label", /Ben Rossi/, { timeout: 15_000 });
      await expect(face).toHaveAttribute("data-presence-dimmed", "true", { timeout: 15_000 });
      await page.screenshot({ path: `${SHOTS}/idle-dimmed.png`, clip: { x: 900, y: 0, width: 540, height: 60 } });
      const box = await canvas(joined.page).boundingBox();
      if (!box) throw new Error("The canvas has no bounds.");
      await joined.page.mouse.move(box.x + 200, box.y + 200);
      await joined.page.mouse.move(box.x + 260, box.y + 240);
      await expect(face).not.toHaveAttribute("data-presence-dimmed", "true");
    } finally {
      await joined.context.close();
    }
  });

  test("shows three faces and +N, and the list jumps to the person", async ({ page, browser }) => {
    test.setTimeout(150_000);
    await openAs(page, anna());
    const hash = await shareActiveNotebook(page);
    const title = await notebookTitleOf(page);
    const others = [];
    try {
      for (const name of ["Ben Rossi", "Cem Aydin", "Dora Meier", "Eli Frei"]) {
        others.push(await joinAs(browser, hash, makeIdentity(name.split(" ")[0].toLowerCase(), name), title));
      }
      await expect(page.locator(".presence-stack")).toHaveAttribute("data-presence-count", "4", { timeout: 20_000 });
      await expect(page.locator(".presence-person__button")).toHaveCount(3);
      const more = page.locator(".presence-stack__more");
      await expect(more).toHaveText("+1");
      await more.click();
      await expect(page.locator(".presence-more__row")).toHaveCount(1);
      await page.screenshot({ path: `${SHOTS}/stack-more.png`, clip: { x: 900, y: 0, width: 540, height: 240 } });
      await page.locator(".presence-more__row").click();
      await expect(page.locator(".presence-more__popover")).toHaveCount(0);
    } finally {
      for (const other of others) await other.context.close().catch(() => undefined);
    }
  });
});

test.describe("shared notebook offline", () => {
  test("ink drawn offline survives a reload and converges with the other side once online", async ({ page, context, browser }) => {
    test.setTimeout(120_000);
    const who = anna();
    await openAs(page, who);
    // Let the service worker take control so the app shell reopens offline.
    await expect.poll(() => page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active && navigator.serviceWorker.controller);
    })).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSaved(page);

    const joined = await joinAsInvited(browser, page, ben(), await notebookTitleOf(page));
    try {
      await pickPen(page);
      await drawWave(page, { x: 120, y: 120 });
      await expect.poll(() => strokeCount(joined.page), { timeout: 15_000 }).toBe(1);

      // Anna loses the connection, keeps writing, and even reloads the app.
      await context.setOffline(true);
      await drawWave(page, { x: 120, y: 260 });
      await waitForSaved(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSaved(page);
      await expect.poll(() => strokeCount(page)).toBe(2);

      // Meanwhile Ben writes on the same page.
      await pickPen(joined.page);
      await drawWave(joined.page, { x: 120, y: 400 });
      await expect.poll(() => strokeCount(joined.page)).toBe(2);

      // Back online: both sides end up with all three strokes, each once.
      await context.setOffline(false);
      await expect.poll(() => strokeCount(page), { timeout: 30_000 }).toBe(3);
      await expect.poll(() => strokeCount(joined.page), { timeout: 30_000 }).toBe(3);
      await page.waitForTimeout(1_500);
      expect(await strokeCount(page)).toBe(3);
      expect(await strokeCount(joined.page)).toBe(3);
    } finally {
      await context.setOffline(false);
      await joined.context.close();
    }
  });
});
