import { expect, gotoApp, test, waitForSaved } from './support';

test('benannter Verlauf stellt eine neue Seitenkopie her und erhält spätere Änderungen', async ({ page }) => {
  await gotoApp(page);
  const title = page.getByLabel('Seitentitel');
  const originalTitle = await title.inputValue();

  await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Verlauf', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Seitenverlauf' });
  await expect(history).toBeVisible();
  await expect(history).toContainText('Nichts wird überschrieben.');
  await history.getByLabel('Prüfpunkt benennen').fill('Vor Zusammenarbeit');
  await history.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(history.getByRole('status')).toContainText('lokal gespeichert');
  await history.getByRole('button', { name: 'Verlauf schliessen' }).click();

  await title.fill('Spätere Änderung von Mia');
  await waitForSaved(page);
  await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Verlauf', exact: true }).click();
  await history.locator('.history-entry', { hasText: 'Vor Zusammenarbeit' }).click();
  await expect(history).toContainText('Spätere Änderungen');
  await history.getByRole('button', { name: 'Als neue Seite wiederherstellen' }).click();

  await expect(title).toHaveValue(`${originalTitle} (wiederhergestellt)`);
  await expect(page.getByRole('button', { name: /Spätere Änderung von Mia/ })).toBeVisible();
  await waitForSaved(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(page.getByLabel('Seitentitel')).toHaveValue(`${originalTitle} (wiederhergestellt)`);
});
