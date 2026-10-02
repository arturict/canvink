import { expect, saveStatus, test } from './support';

test('opens active attachment types only as verified passive metadata without execution or download', async ({
  page,
  context,
}) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  const initialPageCount = context.pages().length;
  let downloadCount = 0;
  page.on('download', () => { downloadCount += 1; });

  await page.locator('input[type="file"]:not([accept])').setInputFiles({
    name: 'unsafe-active.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<script>window.__CANVINK_ATTACHMENT_EXECUTED__ = true</script>'),
  });
  const attachment = page.getByLabel('Anhang unsafe-active.html');
  await expect(attachment).toBeVisible();
  await attachment.getByRole('button', { name: 'Öffnen' }).click();

  const inspection = page.getByRole('dialog', { name: 'Passive Dateiprüfung' });
  await expect(inspection).toBeVisible();
  await expect(inspection.getByRole('status')).toContainText('nicht angezeigt oder ausgeführt');
  await expect(inspection).toContainText('unsafe-active.html');
  await expect(inspection).toContainText('text/html');
  await expect(inspection).toContainText(/sha256:[0-9a-f]{64}/);
  await expect(inspection.getByRole('button', { name: 'Laden' })).toBeVisible();
  expect(context.pages()).toHaveLength(initialPageCount);
  expect(downloadCount).toBe(0);
  expect(await page.evaluate(() => '__CANVINK_ATTACHMENT_EXECUTED__' in window)).toBe(false);

  await inspection.getByRole('button', { name: 'Prüfung schliessen' }).click();
  await expect(inspection).toBeHidden();
  await expect(attachment.getByRole('button', { name: 'Öffnen' })).toBeVisible();
});
