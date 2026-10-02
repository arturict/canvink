import { chooseLanguage, expect, gotoApp, openTopbarMore, test, waitForSaved } from './support';

test('German is the local default and English persists across reloads', async ({ page }) => {
  await gotoApp(page);
  await waitForSaved(page);

  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByLabel('Seitentitel')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Notizbuchnavigation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Menüband' })).toBeVisible();
  await expect(page.getByLabel('Dateien und Exporte')).toBeVisible();
  await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Deutsch', exact: true })).toBeChecked();

  await chooseLanguage(page, 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByLabel('Page title')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Notebook navigation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ribbon' })).toBeVisible();
  await expect(page.getByLabel('Files and exports')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Search workspace locally' })).toBeVisible();
  await page.locator('.app-topbar').getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Import OneNote' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'History', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: 'English', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await openTopbarMore(page);
  await page.getByRole('menuitem', { name: 'Quick note', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Shared text' }).last()).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Format text' }).last()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('canvink:language:v1'))).toBe('en');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByLabel('Page title')).toBeVisible();
  await page.locator('.app-topbar').getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'English', exact: true })).toBeChecked();
});
