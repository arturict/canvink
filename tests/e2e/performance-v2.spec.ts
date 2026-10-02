import { chooseLanguage, expect, gotoApp, test, waitForSaved } from './support';

test('records 20+ cached page switches and keeps strict 45-minute evidence fail-closed', async ({ page }) => {
  await gotoApp(page);
  await waitForSaved(page);
  const title = page.getByLabel('Seitentitel');
  const originalTitle = await title.inputValue();

  await page.getByRole('button', { name: 'Erstellen', exact: true }).click();
  await page.getByRole('button', { name: 'Canvas-Seite', exact: true }).click();
  await expect(title).toHaveValue('Unbenannte Seite');
  await title.fill('Leistungsmessung B');
  await waitForSaved(page);

  const originalPage = page.locator('.page-row__target').filter({ hasText: originalTitle }).first();
  const secondPage = page.locator('.page-row__target').filter({ hasText: 'Leistungsmessung B' }).first();
  await expect(originalPage).toBeVisible();
  await expect(secondPage).toBeVisible();

  for (let index = 0; index < 24; index += 1) {
    const target = index % 2 === 0 ? originalPage : secondPage;
    const expectedTitle = index % 2 === 0 ? originalTitle : 'Leistungsmessung B';
    await target.click();
    await expect(title).toHaveValue(expectedTitle);
    await expect(title).toBeFocused();
  }

  await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Diagnose', exact: true }).click();
  const germanDiagnostics = page.getByRole('region', { name: 'Leistungsdiagnose' });
  await expect(germanDiagnostics).toBeVisible();
  await expect(germanDiagnostics.getByTestId('performance-cached-navigation')).toContainText('Bestanden');
  await expect(germanDiagnostics.getByTestId('performance-storage-flush')).toContainText('p95');
  await germanDiagnostics.getByRole('button', { name: 'Leistungsdiagnose schliessen' }).click();

  await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
  await chooseLanguage(page, 'en');
  await page.locator('.app-topbar').getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Diagnostics', exact: true }).click();
  const diagnostics = page.getByRole('region', { name: 'Performance diagnostics' });
  await expect(diagnostics).toContainText('Timing values only; no IDs, titles or content.');
  const cachedNavigation = diagnostics.getByTestId('performance-cached-navigation');
  await expect(cachedNavigation).toContainText('Passed');
  const cachedNavigationText = await cachedNavigation.textContent();
  expect(Number(/(\d+) samples/.exec(cachedNavigationText ?? '')?.[1] ?? 0)).toBeGreaterThanOrEqual(20);
  await expect(diagnostics.getByTestId('performance-storage-flush')).toContainText('p95');
  await expect(diagnostics.getByTestId('performance-pen-preview')).toContainText('Collecting');
  await expect(diagnostics.getByRole('button', { name: 'Export content-free evidence' })).toBeDisabled();
});
