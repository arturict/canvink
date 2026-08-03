import {
  createQuickNote,
  expect,
  expectNoDocumentOverflow,
  gotoApp,
  test,
  waitForAutosave,
  waitForSaved,
} from './support';

test('formats, tags, finds, resumes, duplicates, and reorders a working page', async ({
  page,
}) => {
  await gotoApp(page);

  const editor = await createQuickNote(page, {
    title: 'Launch plan',
    body: 'Research\nPrototype',
  });
  await editor.press('Escape');

  const properties = page.getByRole('complementary', {
    name: /Object properties/i,
  });
  await properties.getByLabel('Weight').selectOption('700');
  await properties.getByLabel('Style').selectOption('italic');
  await properties.getByLabel('Decoration').selectOption('underline');
  await properties.getByLabel('Align').selectOption('center');
  await properties.getByLabel('List').selectOption('bullet');

  await page.getByRole('button', { name: /^Checklist/ }).click();
  await expect(page.locator('[data-empty-kind="page"]')).toBeHidden();
  await page.locator('#page-editor .konvajs-content').click({
    position: { x: 720, y: 280 },
  });

  await expect(properties.getByLabel('Checklist items')).toBeVisible();
  await properties
    .getByRole('textbox', { name: 'Checklist item 1', exact: true })
    .fill('Invite pilot users');
  await properties.getByRole('button', { name: 'Add item' }).click();
  await properties
    .getByRole('textbox', { name: 'Checklist item 2', exact: true })
    .fill('Review feedback');
  await properties
    .getByRole('checkbox', { name: 'Mark item 1 complete', exact: true })
    .check();

  await page.getByLabel('Page tags').click();
  await page.getByRole('button', { name: 'To do', exact: true }).click();
  const taskState = page.getByRole('button', { name: 'Open', exact: true });
  await expect(taskState).toBeVisible();
  await taskState.click();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await waitForAutosave(page);

  const search = page.getByRole('searchbox', { name: 'Search workspace' });
  await search.fill('Review feedback');
  const results = page.getByRole('region', { name: 'Search results' });
  await expect(results.getByRole('button', { name: /Launch plan/i })).toContainText(
    'Open: Review feedback',
  );
  await results.getByRole('button', { name: /Launch plan/i }).click();
  await expect(
    properties.getByRole('textbox', {
      name: 'Checklist item 2',
      exact: true,
    }),
  ).toHaveValue('Review feedback');

  await search.fill('tag:todo is:done');
  await expect(results.getByRole('button', { name: /Launch plan/i })).toBeVisible();
  await results.getByRole('button', { name: /Launch plan/i }).click();
  await expect(page.getByLabel('Page title')).toHaveValue('Launch plan');
  await expectNoDocumentOverflow(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  await expect(page.locator('.page-tag--todo')).toHaveText('To do');
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();

  const objectPicker = page.getByLabel('Select a canvas object');
  await objectPicker.selectOption({ index: 1 });
  await expect(properties.getByLabel('Weight')).toHaveValue('700');
  await expect(properties.getByLabel('Style')).toHaveValue('italic');
  await expect(properties.getByLabel('Decoration')).toHaveValue('underline');
  await expect(properties.getByLabel('Align')).toHaveValue('center');
  await expect(properties.getByLabel('List')).toHaveValue('bullet');

  await objectPicker.selectOption({ index: 2 });
  await expect(
    properties.getByRole('textbox', {
      name: 'Checklist item 1',
      exact: true,
    }),
  ).toHaveValue('Invite pilot users');
  await expect(
    properties.getByRole('checkbox', {
      name: 'Mark item 1 complete',
      exact: true,
    }),
  ).toBeChecked();

  await page.locator('.page-row').filter({ hasText: 'Launch plan' }).first().hover();
  await page.getByLabel('Actions for Launch plan').click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await waitForAutosave(page);
  await expect(page.getByLabel('Page title')).toHaveValue('Launch plan copy');

  await page
    .locator('.page-row')
    .filter({ hasText: 'Launch plan copy' })
    .first()
    .hover();
  await page.getByLabel('Actions for Launch plan copy').click();
  await page.getByRole('button', { name: 'Move up', exact: true }).click();
  await waitForAutosave(page);

  const pageTitles = await page
    .locator('.page-row__target > span')
    .evaluateAll((elements) => elements.map((element) => element.textContent?.trim()));
  expect(pageTitles.indexOf('Launch plan copy')).toBeLessThan(
    pageTitles.indexOf('Launch plan'),
  );
});

test.describe('mobile core workflows', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('keeps the core organization controls usable in the mobile journey', async ({ page }) => {
    await gotoApp(page);

    await page.getByRole('button', { name: /^Checklist/ }).click();
    const stage = page.locator('#page-editor .konvajs-content');
    const stageBounds = await stage.boundingBox();
    expect(stageBounds).not.toBeNull();
    if (!stageBounds) return;
    await page.touchscreen.tap(stageBounds.x + 70, stageBounds.y + 110);

    const properties = page.getByRole('complementary', {
      name: /Object properties/i,
    });
    await properties
      .getByRole('textbox', { name: 'Checklist item 1', exact: true })
      .fill('Mobile task');
    await properties.getByRole('button', { name: 'Close properties' }).click();
    await page.touchscreen.tap(stageBounds.x + 91, stageBounds.y + 135);
    await page.getByLabel('Select a canvas object').selectOption({ index: 1 });
    await expect(
      properties.getByRole('checkbox', {
        name: 'Mark item 1 complete',
        exact: true,
      }),
    ).toBeChecked();

    await page.getByLabel('Page tags').click();
    await page.getByRole('button', { name: 'Important', exact: true }).click();
    await expectNoDocumentOverflow(page);

    await page.getByRole('button', { name: /Show notebook navigation/i }).click();
    const navigation = page.getByRole('dialog', { name: /Notebook navigation/i });
    await expect(navigation).toBeVisible();
    await navigation.getByLabel('Actions for Quick note').click();
    await expect(
      navigation.getByRole('button', { name: 'Add subpage' }),
    ).toBeVisible();
    await expect(
      navigation.getByRole('button', { name: 'Duplicate' }),
    ).toBeVisible();
    await expectNoDocumentOverflow(page);
  });
});
