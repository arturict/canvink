import { chromium, expect } from '@playwright/test';
import { isIP } from 'node:net';

const target = process.argv[2];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function productionUrl(value) {
  const url = new URL(value);
  const local =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1';
  if (local) {
    assert(
      process.env.ALLOW_LOCALHOST === 'true',
      'Localhost browser smoke requires ALLOW_LOCALHOST=true',
    );
    assert(
      url.protocol === 'http:' || url.protocol === 'https:',
      'Unsupported localhost protocol',
    );
    return new URL('/', url);
  }

  const allowedHosts = (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLocaleLowerCase())
    .filter(Boolean);
  assert(url.protocol === 'https:', 'Remote browser smoke requires HTTPS');
  assert(url.username === '' && url.password === '', 'URL credentials are forbidden');
  assert(isIP(url.hostname) === 0, 'IP-address browser targets are forbidden');
  assert(allowedHosts.length > 0, 'ALLOWED_HOSTS must name the production host');
  assert(
    allowedHosts.includes(url.hostname.toLocaleLowerCase()),
    `Browser smoke host is not allowlisted: ${url.hostname}`,
  );
  return new URL('/', url);
}

function watchPage(page, label, errors) {
  page.on('pageerror', (error) => errors.push(`${label} page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`${label} console error: ${message.text()}`);
    }
  });
}

async function smokeDesktop(browser, baseUrl, errors) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  watchPage(page, 'desktop', errors);

  await page.goto(baseUrl.href, { waitUntil: 'networkidle' });
  await expect(page).toHaveTitle('Canvink — Local-first ink and PDF notebook');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Your notes. Your files. Your canvas.',
    }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Try the local web demo/i })).toHaveAttribute(
    'href',
    '/app',
  );

  await page.goto(new URL('/app', baseUrl).href, { waitUntil: 'networkidle' });
  await expect(page.locator('.notebook-app')).toBeVisible();
  await expect(page.getByLabel('Page title')).toHaveValue('Start here');
  await expect(page.getByRole('toolbar', { name: 'Canvas tools' })).toBeVisible();

  await page.getByLabel('Page title').fill('Release browser smoke');
  await page.waitForTimeout(1_000);
  await expect(page.locator('.save-indicator')).toContainText('Saved locally');

  await page.getByLabel('Search workspace').fill('local-first');
  await expect(page.locator('.search-results button').first()).toBeVisible();
  await page.getByLabel('Search workspace').fill('');

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByLabel('Page title')).toHaveValue('Release browser smoke');

  await page.getByRole('button', { name: 'New page' }).first().click();
  await expect(page.getByLabel('Page title')).toHaveValue('Untitled page');
  await page.getByRole('button', { name: 'A4', exact: true }).click();
  await expect(page.locator('.canvas-page')).toHaveAttribute('data-page-mode', 'a4');
  await page.getByTitle('Text (T)').click();
  await page.locator('.canvas-page .konvajs-content').click({
    position: { x: 180, y: 180 },
  });
  const objectPicker = page.getByLabel('Select a canvas object');
  await expect(objectPicker.locator('option')).toHaveCount(2);
  await expect(objectPicker.locator('option').nth(1)).toContainText('Start typing');
  await page.waitForTimeout(1_000);
  await expect(page.locator('.save-indicator')).toContainText('Saved locally');
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByLabel('Page title')).toHaveValue('Untitled page');
  await expect(page.locator('.canvas-page')).toHaveAttribute('data-page-mode', 'a4');
  await expect(page.getByLabel('Select a canvas object').locator('option')).toHaveCount(2);
  await page.getByLabel('Select a canvas object').selectOption({ index: 1 });
  await expect(page.locator('.inspector')).toBeVisible();
  await page.getByText('Export', { exact: true }).click();
  const pdfDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Vector PDF' }).click();
  const pdfDownload = await pdfDownloadPromise;
  expect(pdfDownload.suggestedFilename()).toMatch(/\.pdf$/i);
  await pdfDownload.delete();

  const conflictingTab = await context.newPage();
  watchPage(conflictingTab, 'second tab', errors);
  await conflictingTab.goto(new URL('/app', baseUrl).href, {
    waitUntil: 'networkidle',
  });
  await expect(conflictingTab.getByRole('alert')).toContainText(
    'already open in another browser tab',
  );
  await conflictingTab.close();
  await context.close();
}

async function smokeMobile(browser, baseUrl, errors) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  watchPage(page, 'mobile', errors);

  await page.goto(new URL('/app', baseUrl).href, { waitUntil: 'networkidle' });
  await expect(page.locator('.notebook-app')).toBeVisible();
  await expect(page.locator('.notebook-sidebar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show notebook navigation' }).click();
  await expect(page.locator('.notebook-sidebar')).toBeVisible();
  await page.getByRole('button', { name: 'Close notebook navigation' }).first().click();
  await expect(page.locator('.notebook-sidebar')).toHaveCount(0);
  await expect(page.locator('.brush-controls')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Free' })).toBeVisible();

  await context.close();
}

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  assert(target, 'Usage: node scripts/smoke-browser.mjs <production-url>');
  const baseUrl = productionUrl(target);
  await smokeDesktop(browser, baseUrl, errors);
  await smokeMobile(browser, baseUrl, errors);
  assert(errors.length === 0, errors.join('\n'));
  console.log(`Real-browser production smoke passed: ${baseUrl}`);
} finally {
  await browser.close();
}
