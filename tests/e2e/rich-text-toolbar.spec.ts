import { expect, gotoApp, openTopbarMore, test, waitForSaved } from './support';

test('rich-text formatting survives reload and successive collaborative sessions', async ({ page, context }) => {
  await gotoApp(page);
  await openTopbarMore(page);
  await page.getByRole('menuitem', { name: /^(Quick note|Schnelle Notiz)$/ }).click();

  let editor = page.getByRole('textbox', { name: 'Gemeinsamer Text' }).last();
  await expect(editor).toBeFocused();
  await editor.fill('Gemeinsamer Laborbericht');
  await editor.selectText();

  // The focused text container docks its formatting controls into the canvas toolbar.
  const toolbar = page.getByRole('toolbar', { name: 'Text formatieren' });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Link bearbeiten' })).toBeEnabled();
  await toolbar.getByRole('button', { name: 'Fett' }).click();
  await expect(editor.locator('strong')).toContainText('Gemeinsamer Laborbericht');
  await expect(toolbar.getByRole('button', { name: 'Fett' })).toHaveAttribute('aria-pressed', 'true');
  await toolbar.getByLabel('Absatzformat').selectOption('heading2');
  await expect(editor.locator('h2 strong')).toContainText('Gemeinsamer Laborbericht');

  await toolbar.getByRole('button', { name: 'Link bearbeiten' }).click();
  const linkForm = toolbar.getByRole('form', { name: 'Link bearbeiten' });
  await linkForm.getByLabel('Link-Adresse').fill('javascript:alert(1)');
  await linkForm.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(toolbar.getByRole('status')).toContainText('Unsicherer Link abgelehnt');
  await linkForm.getByLabel('Link-Adresse').fill('https://example.ch/labor');
  await linkForm.getByLabel('Link-Titel (optional)').fill('Labor');
  await linkForm.getByRole('button', { name: 'Übernehmen' }).click();

  await expect(editor.locator('h2 strong')).toContainText('Gemeinsamer Laborbericht');
  await expect(editor.locator('a[href="https://example.ch/labor"]')).toContainText('Gemeinsamer Laborbericht');

  await toolbar.getByRole('button', { name: 'Tabelle einfügen' }).click();
  const firstCell = editor.locator('td, th').first();
  await firstCell.click();
  await toolbar.getByRole('button', { name: 'Zeile danach einfügen' }).click();
  await toolbar.getByRole('button', { name: 'Spalte danach einfügen' }).click();
  await expect(editor.locator('table tr')).toHaveCount(3);
  await expect(editor.locator('table tr').first().locator('td, th')).toHaveCount(3);
  await editor.locator('td, th').first().click();
  await page.keyboard.type('Kraft');
  await editor.locator('td, th').last().click();
  await page.keyboard.type('Messwert');
  await waitForSaved(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  editor = page.getByRole('textbox', { name: 'Gemeinsamer Text' }).filter({
    hasText: 'Gemeinsamer Laborbericht',
  });
  await expect(editor.locator('h2 strong')).toContainText('Gemeinsamer Laborbericht');
  await expect(editor.locator('a[href="https://example.ch/labor"]')).toBeVisible();
  await expect(editor.locator('table tr')).toHaveCount(3);
  await expect(editor.locator('table tr').first().locator('td, th')).toHaveCount(3);
  await expect(editor.locator('table')).toContainText('Kraft');
  await expect(editor.locator('table')).toContainText('Messwert');

  await editor.click();
  await editor.press('Control+End');
  await editor.type(' Alice');
  await waitForSaved(page);
  await page.close();

  const collaborator = await context.newPage();
  await gotoApp(collaborator);
  const collaboratorEditor = collaborator.getByRole('textbox', { name: 'Gemeinsamer Text' }).filter({
    hasText: 'Gemeinsamer Laborbericht',
  });
  await expect(collaboratorEditor).toContainText('Alice');
  await collaboratorEditor.click();
  await collaboratorEditor.press('Control+End');
  await collaboratorEditor.type(' Bob');
  await waitForSaved(collaborator);
  await collaborator.close();

  const verifier = await context.newPage();
  await gotoApp(verifier);
  const merged = verifier.getByRole('textbox', { name: 'Gemeinsamer Text' }).filter({
    hasText: 'Gemeinsamer Laborbericht',
  });
  await expect(merged).toContainText('Alice');
  await expect(merged).toContainText('Bob');
  await expect(merged.locator('h2 strong')).toContainText('Gemeinsamer Laborbericht');
  await expect(merged.locator('table tr')).toHaveCount(3);
  await expect(merged.locator('table tr').first().locator('td, th')).toHaveCount(3);
  await expect(merged.locator('table')).toContainText('Kraft');
  await expect(merged.locator('table')).toContainText('Messwert');
});
