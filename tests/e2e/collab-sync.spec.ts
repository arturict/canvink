import {
  activeNotebookTitle,
  addTextFromRibbon,
  contextCommand,
  expect,
  expectInkCount,
  inkCount,
  notebookOption,
  openNotebookSwitcher,
  ribbonTab,
  submitInlineRename,
  waitForSaved,
} from "./support";
import { collabTest as test, joinAs, makeIdentity, openAs, readOnlyBadge, shareActiveNotebook } from "./collabSupport";
import type { Page } from "@playwright/test";

const NOTEBOOK_TITLE = "Collab-Sync Notizbuch";
const PAGE_TITLE = "Collab-Sync Testseite";
const INITIAL_TEXT = "Inhalt für Zusammenarbeit sichtbar für Mitarbeitende.";
const UPDATED_SUFFIX = " AKTUALISIERT-LIVE";

const anna = () => makeIdentity("anna", "Anna Keller");
const ben = () => makeIdentity("ben", "Ben Rossi");

/** Renames the open notebook through the notebook switcher's context menu. */
async function renameActiveNotebook(page: Page, title: string): Promise<void> {
  const current = (await activeNotebookTitle(page).textContent()) ?? "";
  const switcher = await openNotebookSwitcher(page);
  await contextCommand(page, notebookOption(page, switcher, current.trim()), "Umbenennen");
  await submitInlineRename(page, title);
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText(title);
  if (await switcher.isVisible()) await page.keyboard.press("Escape");
}

async function addText(page: Page): Promise<void> {
  await addTextFromRibbon(page);
}

test.describe("notebook sharing", () => {
  test("a signed-in joiner gets the notebook, and a live owner edit reaches it", async ({
    page,
    browser,
  }) => {
    await openAs(page, anna());
    await renameActiveNotebook(page, NOTEBOOK_TITLE);

    await addText(page);
    const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
    await expect(editor).toBeFocused();
    await editor.fill(INITIAL_TEXT);
    await page.getByLabel("Seitentitel").fill(PAGE_TITLE);
    await waitForSaved(page);

    const hash = await shareActiveNotebook(page);
    expect(hash).toContain("#join=");

    // A second, fully isolated browser context: no cookies/local storage
    // shared with the owner's context, so this is a genuinely separate person
    // opening the invite link cold.
    const joined = await joinAs(browser, hash, ben(), NOTEBOOK_TITLE);
    try {
      const joinerEditor = joined.page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
      await expect(joinerEditor).toContainText(INITIAL_TEXT, { timeout: 15_000 });
      // Everybody with the link reads and never writes: the notebook opens read-only.
      await expect(joinerEditor).toHaveAttribute("aria-readonly", "true");
      await expect(readOnlyBadge(joined.page)).toBeVisible();

      // Live update: the owner appends text; the joiner must see it without
      // reloading.
      await editor.click();
      await editor.press("End");
      await editor.type(UPDATED_SUFFIX);
      await waitForSaved(page);

      await expect(async () => {
        await expect(joinerEditor).toContainText(INITIAL_TEXT + UPDATED_SUFFIX);
      }).toPass({ timeout: 20_000 });
    } finally {
      await joined.context.close();
    }
  });

  // B1: previously the server always resent a doc's snapshot on catch-up and
  // the client *replaced* its doc with it, so any reconnect silently
  // discarded every change made since the share started. This forces a real
  // connection drop (not a clean close) and asserts the reconnected joiner
  // still has the post-share edit.
  test("a joiner reconnecting after a dropped connection still sees edits made since the share, not the share-time state", async ({
    page,
    browser,
  }) => {
    await openAs(page, anna());
    await renameActiveNotebook(page, `${NOTEBOOK_TITLE} Reconnect`);

    await addText(page);
    const editor = page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
    await expect(editor).toBeFocused();
    await editor.fill(INITIAL_TEXT);
    await page.getByLabel("Seitentitel").fill(`${PAGE_TITLE} Reconnect`);
    await waitForSaved(page);

    const hash = await shareActiveNotebook(page);

    const joined = await joinAs(browser, hash, ben(), `${NOTEBOOK_TITLE} Reconnect`);
    try {
      const joinerEditor = joined.page.getByRole("textbox", { name: "Gemeinsamer Text" }).last();
      await expect(joinerEditor).toContainText(INITIAL_TEXT, { timeout: 15_000 });

      // Owner makes an edit *after* the joiner already has the share-time
      // state, and it must reach the joiner live before the drop.
      await editor.click();
      await editor.press("End");
      await editor.type(UPDATED_SUFFIX);
      await waitForSaved(page);
      await expect(async () => {
        await expect(joinerEditor).toContainText(INITIAL_TEXT + UPDATED_SUFFIX);
      }).toPass({ timeout: 20_000 });

      // Force-drop the joiner's connection (not a clean close) by cutting
      // network access at the browser-context level, then restore it so the
      // client's own reconnect-with-backoff logic re-establishes the socket.
      await joined.context.setOffline(true);
      await joined.context.setOffline(false);

      // A second owner edit made while the joiner is reconnecting, so the
      // assertion below can't be satisfied by stale pre-drop state alone.
      const SECOND_SUFFIX = " ZWEITES-UPDATE";
      await editor.click();
      await editor.press("End");
      await editor.type(SECOND_SUFFIX);
      await waitForSaved(page);

      await expect(async () => {
        await expect(joinerEditor).toContainText(INITIAL_TEXT + UPDATED_SUFFIX + SECOND_SUFFIX);
      }).toPass({ timeout: 30_000 });
    } finally {
      await joined.context.close();
    }
  });

  // Ink lives in segments beside the page documents; a shared room must carry them, or a member
  // sees a page without the ink the owner drew.
  test("ink the owner draws reaches a joiner who joins later and one who is already in the room", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await openAs(page, anna());
    await renameActiveNotebook(page, `${NOTEBOOK_TITLE} Tinte`);
    await page.getByLabel("Seitentitel").fill(`${PAGE_TITLE} Tinte`);
    await waitForSaved(page);

    const draw = await ribbonTab(page, "Zeichnen");
    await draw.getByRole("button", { name: "Stift", exact: true }).click();
    const surface = page.getByLabel("Ansicht der Zeichenfläche");
    const box = (await surface.boundingBox())!;
    const before = await inkCount(page);
    const strokes = async (count: number, first: number) => {
      for (let index = 0; index < count; index += 1) {
        const y = box.y + 140 + (first + index) * 45;
        await page.mouse.move(box.x + 120, y);
        await page.mouse.down();
        for (let step = 1; step <= 10; step += 1) await page.mouse.move(box.x + 120 + step * 14, y + Math.sin(step) * 8);
        await page.mouse.up();
      }
    };
    await strokes(3, 0);
    await expectInkCount(page, before + 3);
    await waitForSaved(page);
    // The pen rests, the strokes are sealed into a segment, and the segment goes to the room.
    await page.waitForTimeout(4_000);

    const hash = await shareActiveNotebook(page);
    const title = `${NOTEBOOK_TITLE} Tinte`;

    // A joiner who joins cold: the page document arrives with a segment reference and the ink is fetched.
    const cold = await joinAs(browser, hash, makeIdentity("cem", "Cem Aydin"), title);
    // A joiner who is in the room while the owner keeps drawing.
    const live = await joinAs(browser, hash, makeIdentity("dora", "Dora Meier"), title);
    try {
      await expectInkCount(cold.page, before + 3);
      await expectInkCount(live.page, before + 3);

      await strokes(2, 3);
      await expectInkCount(page, before + 5);
      await expect(async () => {
        await expectInkCount(live.page, before + 5);
      }).toPass({ timeout: 45_000 });

      // A second cold joiner sees everything the room holds by now.
      const late = await joinAs(browser, hash, makeIdentity("eli", "Eli Frei"), title);
      try {
        await expect(async () => {
          await expectInkCount(late.page, before + 5);
        }).toPass({ timeout: 45_000 });
      } finally {
        await late.context.close();
      }
    } finally {
      await cold.context.close();
      await live.context.close();
    }
  });
});
