/**
 * A shared notebook in two personal spaces. Run against
 * `tests/e2e/personal-space.playwright.config.ts` (a Worker with the personal
 * space and an app build with `VITE_PERSONAL_SPACE=1`): Anna and Ben are two
 * accounts, each with their own workspace; Ben opens Anna's share link and
 * the notebook joins his workspace, on every device of his account.
 */

import type { Page } from '@playwright/test';
import {
  addNamedNotebook,
  addText,
  gotoSpaceApp,
  notebookCount,
  selectNotebookStably,
  SPACE_SYNCED_TEXT,
  test,
  waitForSpaceStatus,
} from './personalSpaceSupport';
import {
  drawPenStrokesRightAway,
  expect,
  expectInkCount,
  openNotebookSwitcher,
} from './support';
import { acceptInvitation, closeShareDialog, inviteInDialog, openShareDialog, ROLE } from './collabSupport';

const NOTEBOOK = 'Gemeinsam im Konto';

/** Invites an address as an editor; nothing is sent, the person sees it once signed in. */
async function inviteEditor(page: Page, email: string): Promise<void> {
  const dialog = await openShareDialog(page);
  await inviteInDialog(dialog, email, ROLE.edit);
  await closeShareDialog(page);
}

test.describe('shared notebook in personal spaces', () => {
  test('the invited person gets the notebook next to their own, on every device, and edits sync both ways', async ({ page, browser }) => {
    test.setTimeout(240_000);
    const stamp = `${test.info().workerIndex}-${Date.now()}`;
    const benSub = `e2e-share-ben-${stamp}`;
    const benEmail = `${benSub}@canvink.test`;
    const benQuery = `__canvinkSpaceTestSub=${encodeURIComponent(benSub)}&__canvinkTestEmail=${encodeURIComponent(benEmail)}`;

    await gotoSpaceApp(page, `e2e-share-anna-${stamp}`);
    await waitForSpaceStatus(page, SPACE_SYNCED_TEXT);
    await addNamedNotebook(page, NOTEBOOK);
    await addText(page, 'Text von Anna.');
    await inviteEditor(page, benEmail);

    // Ben's first device opens the invitation: the notebook joins his workspace.

    const first = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const benOne = await first.newPage();
    const second = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await benOne.goto(`/app?${benQuery}`, { waitUntil: 'domcontentloaded' });
      await waitForSpaceStatus(benOne, SPACE_SYNCED_TEXT);
      await acceptInvitation(benOne, NOTEBOOK);
      await waitForSpaceStatus(benOne, SPACE_SYNCED_TEXT);
      const switcher = await openNotebookSwitcher(benOne);
      expect(await switcher.locator('.notebook-switcher__option:not(.notebook-switcher__option--page)').count()).toBeGreaterThanOrEqual(2);
      await benOne.keyboard.press('Escape');

      // A second, fresh device of the same account lists the shared notebook next to Ben's own.
      const benTwo = await second.newPage();
      await benTwo.goto(`/app?${benQuery}`, { waitUntil: 'domcontentloaded' });
      await waitForSpaceStatus(benTwo, SPACE_SYNCED_TEXT);
      await expect.poll(() => notebookCount(benTwo, NOTEBOOK), { timeout: 60_000 }).toBe(1);
      const names = await openNotebookSwitcher(benTwo);
      await expect(names.getByRole('img', { name: 'Geteilt' })).toHaveCount(1, { timeout: 30_000 });
      await benTwo.keyboard.press('Escape');

      // The first device leaves. What Anna writes now can only reach the second device through the
      // room, which the account's other device connected on its own.
      await first.close();
      await selectNotebookStably(benTwo, NOTEBOOK);
      await drawPenStrokesRightAway(page, 1);
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
      await expectInkCount(benTwo, 1);

      // And back: Ben's second device writes, Anna sees it.
      await drawPenStrokesRightAway(benTwo, 1);
      await expect.poll(async () => Number(await page.getByRole('application', { name: 'Gemeinsame Seitenzeichenfläche' }).getAttribute('data-ink-stroke-count')), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      await benTwo.screenshot({ path: 'test-results/collab-shots/second-device-shared.png' });
    } finally {
      await first.close().catch(() => undefined);
      await second.close();
    }
  });
});
