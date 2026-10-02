import { chooseLanguage, expect, gotoApp, openFileMenu, ribbonTab, test } from './support';

test('the More menu is a compact keyboard menu without a dialog header', async ({ page }) => {
  await gotoApp(page);
  const more = page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true });
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  await more.click();
  const menu = page.getByRole('menu', { name: 'Mehr' });
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('button')).toHaveCount(0);
  await expect(menu.getByRole('heading')).toHaveCount(0);
  await expect(menu.getByRole('menuitem')).toHaveText(['Schnelle Notiz', 'OneNote importieren', 'Notizbuch-Einstellungen', 'Verlauf', 'Rollback-Kopie', 'Diagnose']);

  // The first command has the focus; the arrow keys walk the commands and the
  // language row, wrapping at the ends.
  await expect(menu.getByRole('menuitem', { name: 'Schnelle Notiz' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'OneNote importieren' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Diagnose' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitemradio', { name: 'Deutsch' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(menu.getByRole('menuitemradio', { name: 'English' })).toBeFocused();

  // Escape closes the menu and gives the focus back to the button.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  // The button opens it again from the keyboard, and a click elsewhere closes it.
  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeVisible();
  await page.getByLabel('Seitentitel').click();
  await expect(menu).toBeHidden();

  // A second click on the button closes the open menu instead of reopening it.
  await more.click();
  await expect(menu).toBeVisible();
  await more.click();
  await expect(menu).toBeHidden();
});

test('the language is a DE | EN choice inside the More menu', async ({ page }) => {
  await gotoApp(page);
  await page.locator('.app-topbar').getByRole('button', { name: 'Mehr', exact: true }).click();
  const german = page.getByRole('menuitemradio', { name: 'Deutsch', exact: true });
  await expect(german).toBeChecked();
  await expect(german).toHaveText('DE');
  await chooseLanguage(page, 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('menu')).toBeHidden();
});

test('Datei holds export and backup; Word is an export format, not a button of its own', async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByRole('button', { name: /^Word$/ })).toHaveCount(0);

  await openFileMenu(page);
  const file = page.getByRole('menu', { name: 'Datei' });
  await expect(file.getByRole('menuitem')).toHaveText([
    'Export',
    'Notizbuch .canvink',
    'Alle Notizbücher sichern (.zip)',
    '.canvink importieren',
    'Erweitert',
  ]);
  // Inserting belongs to the Einfügen tab and is not repeated here.
  for (const name of ['Bild', 'Screenshot', 'Anhang', 'PDF-Ausdruck']) {
    await expect(file.getByRole('menuitem', { name })).toHaveCount(0);
  }

  await file.getByRole('menuitem', { name: 'Export' }).click();
  const exports = page.getByRole('menu', { name: 'Export' });
  await expect(exports.getByRole('menuitem')).toHaveText([
    'Seite PDF',
    'Abschnitt PDF',
    'Notizbuch PDF',
    'Seite PNG',
    'Seite Markdown',
    'Seite als Word (.docx)',
  ]);
  await expect(exports.getByRole('menuitem', { name: 'Seite PDF' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(exports).toBeHidden();
  await expect(file.getByRole('menuitem', { name: 'Export' })).toBeFocused();
  await file.getByRole('menuitem', { name: 'Erweitert' }).click();
  const advanced = page.getByRole('menu', { name: 'Erweitert' });
  await expect(advanced.getByRole('menuitem')).toHaveText([
    'Aktuelles Schema JSON',
    'Schema JSON importieren',
  ]);
  await expect(advanced.getByRole('menuitem', { name: 'Aktuelles Schema JSON' })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(file).toBeHidden();
  await expect(page.locator('.ribbon__tabs').getByRole('button', { name: 'Datei' })).toBeFocused();

  // Everything the file menu used to offer for inserting is on the Einfügen tab.
  const insert = await ribbonTab(page, 'Einfügen');
  for (const name of ['Bild', 'Screenshot', 'PDF-Ausdruck', 'Anhang']) {
    await expect(insert.getByRole('button', { name, exact: true })).toBeVisible();
  }
});

test('the Word export of the page still downloads a .docx from the Datei menu', async ({ page }) => {
  await gotoApp(page);
  await openFileMenu(page);
  await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('menuitem', { name: 'Seite als Word (.docx)', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.docx$/);
});
