import { expect, gotoApp, test, waitForSaved } from './support';

test('a second browser tab explains the writer conflict and opens after the first tab leaves', async ({
  context,
  page,
}) => {
  await gotoApp(page);
  const secondTab = await context.newPage();
  await secondTab.goto('/app', { waitUntil: 'domcontentloaded' });

  const conflict = secondTab.locator('[data-failure-kind="writer-conflict"]');
  await expect(conflict).toBeVisible();
  await expect(conflict.getByRole('heading')).toHaveText(
    'Canvink is already open in another tab.',
  );
  await expect(conflict).toContainText(/stored notes were not changed/i);
  await expect(conflict.getByRole('button', { name: 'Try again' })).toBeEnabled();

  await page.goto('about:blank');
  await conflict.getByRole('button', { name: 'Try again' }).click();
  await waitForSaved(secondTab);
  await expect(secondTab.getByRole('button', { name: 'Quick note', exact: true })).toBeVisible();
  await secondTab.close();
});
