import {
  activeNotebookTitle,
  contextCommand,
  createNotebook,
  expect,
  gotoApp,
  notebookOption,
  openNotebookSwitcher,
  switchNotebook,
  test,
  waitForSaved,
} from './support';

test('reorders and copies notebooks, then copies and transfers sections with reload persistence', async ({
  page,
}) => {
  await gotoApp(page);

  await createNotebook(page);
  await waitForSaved(page);
  await expect(page.getByLabel('Seitentitel')).toHaveValue('Unbenannte Seite');
  await expect(activeNotebookTitle(page)).toHaveText('Neues Notizbuch');

  // Notebook commands live in the switcher's context menu.
  let switcher = await openNotebookSwitcher(page);
  await contextCommand(page, notebookOption(page, switcher, 'Neues Notizbuch'), 'Duplizieren');
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText('Neues Notizbuch – Kopie');

  switcher = await openNotebookSwitcher(page);
  const optionTitles = switcher.locator('.notebook-switcher__option:not(.notebook-switcher__option--page) .notebook-switcher__option-title');
  await expect(optionTitles).toHaveText(['Notizbuch', 'Neues Notizbuch', 'Neues Notizbuch – Kopie']);
  await contextCommand(page, notebookOption(page, switcher, 'Neues Notizbuch – Kopie'), 'Nach oben');
  await waitForSaved(page);
  await expect(optionTitles).toHaveText(['Notizbuch', 'Neues Notizbuch – Kopie', 'Neues Notizbuch']);
  await page.keyboard.press('Escape');

  const sectionRow = (title: RegExp) => page.locator('.section-row > button', { hasText: title });
  await contextCommand(page, sectionRow(/^Neuer Abschnitt$/), 'Duplizieren');
  await waitForSaved(page);
  const copiedSection = page.getByRole('button', { name: /^Neuer Abschnitt – Kopie$/ });
  await expect(copiedSection).toBeVisible();

  await contextCommand(page, copiedSection, 'Nach oben');
  await waitForSaved(page);
  await expect(page.locator('.section-block').first()).toContainText('Neuer Abschnitt – Kopie');

  // "Verschieben oder kopieren…" moves the section into another notebook.
  await contextCommand(page, page.getByRole('button', { name: /^Neuer Abschnitt – Kopie$/ }), 'Verschieben oder kopieren…');
  let dialog = page.getByRole('dialog', { name: 'Abschnitt verschieben oder kopieren' });
  await dialog.getByRole('option', { name: /^Neues Notizbuch$/ }).click();
  await dialog.getByRole('button', { name: 'Verschieben', exact: true }).click();
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText('Neues Notizbuch');
  await expect(page.getByRole('button', { name: /^Neuer Abschnitt – Kopie$/ })).toBeVisible();

  // Copying it back leaves the original where it is.
  await contextCommand(page, page.getByRole('button', { name: /^Neuer Abschnitt – Kopie$/ }), 'Verschieben oder kopieren…');
  dialog = page.getByRole('dialog', { name: 'Abschnitt verschieben oder kopieren' });
  await dialog.getByRole('combobox').fill('Kopie');
  await dialog.getByRole('option', { name: /^Neues Notizbuch – Kopie$/ }).click();
  await dialog.getByRole('button', { name: 'Kopieren', exact: true }).click();
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText('Neues Notizbuch – Kopie');
  await expect(page.getByRole('button', {
    name: /^Neuer Abschnitt – Kopie – Kopie$/,
  })).toBeVisible();

  await switchNotebook(page, 'Neues Notizbuch');
  await expect(page.getByRole('button', { name: /^Neuer Abschnitt – Kopie$/ })).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(activeNotebookTitle(page)).toHaveText('Neues Notizbuch');
  await expect(page.getByRole('button', { name: /^Neuer Abschnitt – Kopie$/ })).toBeVisible();
  switcher = await openNotebookSwitcher(page);
  await expect(optionTitles).toHaveText(['Notizbuch', 'Neues Notizbuch – Kopie', 'Neues Notizbuch']);
  await notebookOption(page, switcher, 'Neues Notizbuch – Kopie').click();
  await expect(page.getByRole('button', {
    name: /^Neuer Abschnitt – Kopie – Kopie$/,
  })).toBeVisible();
});
