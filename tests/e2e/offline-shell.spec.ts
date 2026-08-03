import {
  createQuickNote,
  editSelectedText,
  expect,
  gotoApp,
  test,
  waitForSaved,
} from './support';

test('cached app shell reopens offline and restores the last IndexedDB save', async ({
  context,
  page,
}) => {
  await gotoApp(page);

  await expect
    .poll(() =>
      page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const registration = await navigator.serviceWorker.ready;
        return Boolean(registration.active && navigator.serviceWorker.controller);
      }),
    )
    .toBe(true);

  const title = 'Offline self-host proof';
  const body = 'This saved note must survive a complete offline reload.';
  await createQuickNote(page, { title, body });

  await context.setOffline(true);
  try {
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSaved(page);

    await expect(page.getByLabel('Page title')).toHaveValue(title);
    await page.getByLabel('Select a canvas object').selectOption({ index: 1 });
    await expect(await editSelectedText(page)).toHaveValue(body);
  } finally {
    await context.setOffline(false);
  }
});
