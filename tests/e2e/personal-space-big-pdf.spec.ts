/**
 * A long PDF printout on a second, fresh device of the same account: the
 * documents arrive first and the page images follow from R2. Run against
 * tests/e2e/personal-space.playwright.config.ts. BIG_PDF_PAGES sets the page
 * count (default 30); the timings are logged for the pull request.
 */
import { book, insertPdf, markInput, percentile, startProbe, stopProbe, visiblePrintouts } from './bigPdfProbe';
import {
  addNamedNotebook,
  gotoSpaceApp,
  notebookCount,
  selectNotebookStably,
  SPACE_SYNCED_TEXT,
  test,
  trashActiveNotebook,
  trashButton,
  waitForSpaceStatus,
} from './personalSpaceSupport';
import { acceptConfirm, expect, saveStatus } from './support';

const PAGES = Number(process.env.BIG_PDF_PAGES ?? '30');
const PITCH = 842 + 30;

test('a fresh second device loads a long printout by distance and the page does not jump', async ({ page, browser }) => {
  test.setTimeout(900_000);
  const sub = `e2e-bigpdf-${test.info().workerIndex}-${Date.now()}`;
  const notebookTitle = 'Lösungsbuch';
  await gotoSpaceApp(page, sub);
  await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
  await addNamedNotebook(page, notebookTitle);
  await insertPdf(page, await book(PAGES));
  await expect(page.locator('[data-element-kind="pdf"]')).toHaveCount(PAGES, { timeout: 300_000 });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 300_000 });
  // The starter notebook shares a page id with every fresh install (see personal-space.spec.ts V5).
  await selectNotebookStably(page, 'Notizbuch');
  await trashActiveNotebook(page);
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
  await trashButton(page).click();
  await page.getByRole('button', { name: 'Dauerhaft löschen' }).click();
  await acceptConfirm(page);
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
  await waitForSpaceStatus(page, SPACE_SYNCED_TEXT, 300_000);

  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    await gotoSpaceApp(second, sub, 120_000);
    await waitForSpaceStatus(second, SPACE_SYNCED_TEXT, 90_000);
    await expect.poll(() => notebookCount(second, notebookTitle), { timeout: 90_000 }).toBe(1);
    const opened = Date.now();
    await selectNotebookStably(second, notebookTitle);
    await startProbe(second);
    await expect(second.locator('[data-element-kind="pdf"]')).toHaveCount(PAGES, { timeout: 90_000 });
    const firstShownMs = await second.waitForFunction(() => document.querySelector('[data-element-kind="pdf"] img.asset-preview-image') !== null, undefined, { timeout: 120_000, polling: 16 })
      .then(() => Date.now() - opened);
    // Read on while the rest is still coming: scroll a few pages down at once.
    const box = (await second.locator('.live-canvas-viewport').boundingBox())!;
    await second.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await markInput(second);
    await second.mouse.wheel(0, PITCH * Math.min(8, PAGES - 3));
    await second.waitForTimeout(400);
    const scrolledTop = await second.evaluate(() => document.querySelector('.live-canvas-surface')!.getBoundingClientRect().top);
    await expect.poll(async () => {
      const shown = await visiblePrintouts(second);
      return shown.inView > 0 && shown.sharp === shown.inView;
    }, { timeout: 120_000, intervals: [100] }).toBe(true);
    const sharpMs = Date.now() - opened;
    await second.waitForTimeout(3000);
    const probe = await stopProbe(second);
    const finalTop = await second.evaluate(() => document.querySelector('.live-canvas-surface')!.getBoundingClientRect().top);
    process.stdout.write(`BIGPDF-SPACE ${JSON.stringify({
      pages: PAGES,
      firstPictureMs: firstShownMs,
      sharpOnScreenMs: sharpMs,
      jumps: probe.jumps.length,
      driftPx: Math.round(Math.abs(finalTop - scrolledTop)),
      frameP95Ms: +percentile(probe.frames, 0.95).toFixed(1),
      longTasks: probe.longTasks.length,
      longTaskMaxMs: Math.round(Math.max(0, ...probe.longTasks)),
    })}\n`);
    // Assets keep arriving (batches are adopted into the workspace) without moving the page or unmounting it.
    expect(probe.jumps).toEqual([]);
    expect(Math.abs(finalTop - scrolledTop)).toBeLessThan(2);
    await expect(saveStatus(second)).not.toHaveAttribute('data-state', 'error');
  } finally {
    await secondContext.close();
  }
});
