import {
  createQuickNote,
  escapeRegExp,
  expect,
  gotoApp,
  renameViaPrompt,
  saveStatus,
  test,
  waitForAutosave,
  waitForSaved,
} from './support';

test('first start is skippable, resumable, and leads directly to a useful note', async ({
  page,
}) => {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');

  const guideControl = page.getByRole('button', { name: /Guide and display/i });
  const dismiss = page.getByRole('button', { name: /Skip for now/i });
  await expect(guideControl).toBeVisible();
  await expect(dismiss).toBeVisible();
  await dismiss.focus();
  await dismiss.press('Enter');
  await expect(dismiss).toBeHidden();
  await expect(guideControl).toBeFocused();

  const note = {
    title: 'First value note',
    body: 'The first useful thought is captured locally.',
  };
  await createQuickNote(page, note);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeHidden();

  const search = page.getByLabel('Search workspace');
  await search.fill(note.body);
  await page
    .getByRole('option', {
      name: new RegExp(escapeRegExp(note.title), 'i'),
    })
    .click();
  await expect(page.getByRole('listbox', { name: /Search results/i })).toBeHidden();
  await expect(page.getByLabel('Page title')).toBeFocused();
  await expect(page.getByPlaceholder('Write your note')).toHaveValue(note.body);

  await guideControl.click();
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeVisible();
  await page.getByRole('button', { name: /Open an example/i }).click();
  await expect(page.getByLabel('Page title')).toHaveValue('Start here');
  await expect(page.getByLabel('Page title')).toBeFocused();
  await expect(page.getByRole('button', { name: /Skip for now/i })).toBeHidden();
});

test('a note can be organized into a named notebook and section, then found again', async ({
  page,
}) => {
  await gotoApp(page);

  await page.getByRole('button', { name: /New notebook/i }).click();
  await renameViaPrompt(
    page,
    page.getByRole('button', { name: /Rename notebook/i }),
    'Product notebook',
  );

  await page.getByRole('button', { name: 'New section', exact: true }).click();
  await renameViaPrompt(
    page,
    page.getByRole('button', { name: /Rename New section/i }).last(),
    'Research section',
  );

  await page.getByRole('button', { name: 'New page', exact: true }).last().click();
  const emptyPage = page.locator('[data-empty-kind="page"]');
  await expect(emptyPage).toBeVisible();
  const startWriting = emptyPage.getByRole('button').first();
  await expect(startWriting).toBeEnabled();
  await startWriting.click();

  const noteTitle = 'Interview synthesis';
  const noteBody = 'Customers want capture before categorization.';
  await expect(page.getByPlaceholder('Write your note')).toBeFocused();
  await page.getByPlaceholder('Write your note').fill(noteBody);
  await page.getByLabel('Page title').fill(noteTitle);
  await waitForAutosave(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);

  const navigation = page.getByRole('navigation', { name: /Notebook navigation/i });
  await expect(navigation.getByLabel('Notebook').locator('option:checked')).toHaveText(
    'Product notebook',
  );
  await expect(
    navigation.getByRole('button', { name: /^Research section \d+$/i }),
  ).toBeVisible();
  const activePage = navigation.locator('button[aria-current="page"]');
  await expect(activePage).toContainText(noteTitle);

  const search = page.getByLabel('Search workspace');
  await search.fill(noteBody);
  await page
    .getByRole('option', {
      name: new RegExp(escapeRegExp(noteTitle), 'i'),
    })
    .click();
  await expect(page.getByLabel('Page title')).toHaveValue(noteTitle);
  await expect(page.getByPlaceholder('Write your note')).toHaveValue(noteBody);
});
