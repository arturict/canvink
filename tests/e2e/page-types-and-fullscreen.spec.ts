import { expect, gotoApp, test, waitForSaved } from './support';

test('the single create menu makes durable Markdown and Canvas pages while Math stays off', async ({ page }) => {
  await gotoApp(page);

  const navigation = page.getByRole('navigation', { name: 'Notizbuchnavigation' });
  await expect(navigation.getByRole('button', { name: 'Erstellen', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Mathe', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mathe-Seitenleiste', exact: true })).toHaveCount(0);

  await navigation.getByRole('button', { name: 'Erstellen', exact: true }).click();
  await navigation.getByRole('button', { name: 'Markdown-Seite', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Notiz bearbeiten' })).toBeVisible();
  await expect(page.getByRole('application', { name: 'Gemeinsame Seitenzeichenfläche' })).toHaveCount(0);
  await page.getByLabel('Seitentitel').fill('Markdown Algebra');
  // The raw source stays reachable behind the "Markdown" toggle.
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown bearbeiten' }).fill('# Algebra\n\n- Lineare Gleichungen\n\n`x = 4`');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Algebra' })).toBeVisible();
  await waitForSaved(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await navigation.getByRole('button', { name: /Markdown Algebra/ }).click();
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Markdown Algebra');
  await expect(page.getByRole('textbox', { name: 'Notiz bearbeiten' }).getByRole('listitem')).toHaveText('Lineare Gleichungen');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown bearbeiten' })).toHaveValue(/Lineare Gleichungen/);

  await navigation.getByRole('button', { name: 'Erstellen', exact: true }).click();
  await navigation.getByRole('button', { name: 'Canvas-Seite', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Gemeinsame Seitenzeichenfläche' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Markdown bearbeiten' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Notiz bearbeiten' })).toHaveCount(0);
  await waitForSaved(page);
});

test('fullscreen is app-wide and can be entered and left from the top bar', async ({ page }) => {
  await gotoApp(page);
  const enter = page.getByRole('button', { name: 'Vollbild öffnen', exact: true });
  await enter.click();
  await expect(page.getByRole('button', { name: 'Vollbild verlassen', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.getByRole('button', { name: 'Vollbild verlassen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Vollbild öffnen', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
});
