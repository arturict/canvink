/**
 * Desktop sign-in through the system browser (services/collab-sync
 * PERSONAL-SYNC.md §3.7), run with `desktop-login.playwright.config.ts`.
 *
 * The browser half is the real `/desktop-login` page, signed in through the
 * e2e identity seam instead of Clerk. The desktop app's half is played here
 * over HTTP: it holds the PKCE verifier, reads the `canvink://auth` link the
 * page hands over, and exchanges code and verifier at the Worker, exactly as
 * src-tauri/src/desktop_auth.rs does.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, saveStatus, test as baseTest } from './support';

const WORKER = `http://127.0.0.1:${process.env.PLAYWRIGHT_DESKTOP_LOGIN_WORKER_PORT ?? '8791'}`;
const SHOTS = '/tmp/cv/desktop-login';

/** Chromium logs the unhandled `canvink://` launch as a console error; that is the hand-off itself. */
const test = baseTest.extend<{ runtimeGuard: void }>({
  runtimeGuard: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        if (/canvink:\/\/auth/.test(message.text())) return;
        // The revoked refresh below answers 400 by design.
        if (/Failed to load resource:.*40[01]/.test(message.text())) return;
        errors.push(`console.error: ${message.text()}`);
      });
      await use();
      expect(errors, 'The browser emitted unexpected console or page errors').toEqual([]);
    },
    { auto: true },
  ],
});

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function pkce() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(32));
  return { verifier, challenge, state };
}

function loginUrl(challenge: string, state: string, sub: string, name = 'Anna Keller'): string {
  const query = new URLSearchParams({ challenge, state, __canvinkSpaceTestSub: sub, __canvinkTestName: name });
  return `/desktop-login?${query.toString()}`;
}

async function tokenRequest(body: Record<string, unknown>) {
  return fetch(`${WORKER}/api/v1/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function accountUrl(sub: string): string {
  return `/app?__canvinkSpaceTestSub=${sub}&__canvinkTestName=Anna%20Keller&__canvinkTestEmail=anna.keller%40example.com`;
}

/** Avatar menu, "Konto und Geräte…", then the named section of the Konto page. */
async function openAccountPage(page: Page, tab: string) {
  // The app starts slowly on a busy machine; the avatar is there once it has.
  await page.getByRole('button', { name: /^Konto: / }).click({ timeout: 60_000 });
  await page.getByRole('menuitem', { name: 'Konto und Geräte…' }).click();
  await page.getByRole('tab', { name: tab }).click();
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/${name}-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('the browser hands a one-time code to the app, which exchanges it and syncs', async ({ page, browser }) => {
  const sub = `user_desktop_${Date.now()}`;
  const { challenge, state } = pkce();

  await page.goto(loginUrl(challenge, state, sub));
  await expect(page.getByRole('heading', { name: 'Canvink Desktop anmelden' })).toBeVisible();
  await expect(page.getByText('Canvink Desktop als Anna Keller anmelden?')).toBeVisible();
  await shoot(page, 'page-confirm');

  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('status')).toHaveText('Canvink Desktop wird geöffnet …');

  // What the app receives through the deep link.
  const deepLink = await page.getByTestId('desktop-login-deep-link').getAttribute('href');
  expect(deepLink).toMatch(/^canvink:\/\/auth\?/);
  const handedOver = new URL(deepLink as string);
  expect(handedOver.searchParams.get('state')).toBe(state);
  const code = handedOver.searchParams.get('code') as string;

  // Fallback for a blocked hand-off: the same code, for pasting.
  await page.getByRole('button', { name: 'Code anzeigen' }).click();
  await expect(page.getByLabel('Füge diesen Code in Canvink Desktop ein.')).toHaveValue(code);
  await shoot(page, 'page-handoff-code');

  // A different verifier (another app that caught the link) gets nothing, and burns the code.
  const intercepted = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier });
  expect(intercepted.status).toBe(400);
  await expect(page.getByRole('alert')).toHaveText('Die Anmeldung ist abgelaufen. Starte sie in Canvink Desktop neu.');

  // Start over; this time the right app redeems it.
  const second = pkce();
  await page.goto(loginUrl(second.challenge, second.state, sub));
  await page.getByRole('button', { name: 'Anmelden' }).click();
  const link = new URL(await page.getByTestId('desktop-login-deep-link').getAttribute('href') as string);
  const exchange = await tokenRequest({
    grant_type: 'authorization_code',
    code: link.searchParams.get('code'),
    code_verifier: second.verifier,
    device_name: 'E2E-DESKTOP (Windows)',
  });
  expect(exchange.status).toBe(200);
  const tokens = await exchange.json() as { access_token: string; refresh_token: string; device_id: string };
  await expect(page.getByRole('status')).toHaveText(
    'Canvink Desktop ist angemeldet. Du kannst dieses Fenster schliessen.',
  );
  await shoot(page, 'page-done');

  // The device token opens the account's personal space like the Clerk session.
  const space = await fetch(`${WORKER}/api/v1/me/space`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  expect(space.status).toBeLessThan(300);

  // The Konto page lists the desktop app with a friendly name and signs it out.
  await page.goto(accountUrl(sub));
  await openAccountPage(page, 'Geräte');
  const devices = page.getByTestId('account-devices');
  await expect(devices).toContainText('E2E-DESKTOP');
  await expect(devices).toContainText('Windows-PC · Canvink Desktop');
  await expect(devices).toContainText('Dieser Browser');
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/web-account-devices-1440.png` });
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(accountUrl(sub));
  // On a phone the section drawer starts open and would cover the topbar.
  await phone.getByRole('button', { name: 'Navigation schliessen' }).last().click();
  await openAccountPage(phone, 'Geräte');
  await expect(phone.getByTestId('account-devices')).toContainText('E2E-DESKTOP');
  await phone.screenshot({ path: `${SHOTS}/web-account-devices-390.png` });
  await phone.close();
  await devices.getByRole('button', { name: 'E2E-DESKTOP abmelden' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Abmelden' }).click();
  await expect(devices).not.toContainText('E2E-DESKTOP');

  const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  expect(refresh.status).toBe(400);
  const revokedSpace = await fetch(`${WORKER}/api/v1/me/space`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  expect(revokedSpace.status).toBe(401);
});

test('cancel requests no code; a broken link says so', async ({ page }) => {
  const { challenge, state } = pkce();
  let codeRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/device/code')) codeRequests += 1;
  });
  await page.goto(loginUrl(challenge, state, `user_cancel_${Date.now()}`));
  await page.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.getByRole('status')).toHaveText('Abgebrochen. Du kannst dieses Fenster schliessen.');
  expect(codeRequests).toBe(0);

  await page.goto(`/desktop-login?challenge=nope&state=x&__canvinkSpaceTestSub=user_x`);
  await expect(page.getByRole('alert')).toHaveText(
    'Dieser Link ist ungültig. Starte die Anmeldung in Canvink Desktop neu.',
  );
  await shoot(page, 'page-invalid');
});

test('signed out, the page asks to sign in first', async ({ page }) => {
  const { challenge, state } = pkce();
  await page.goto(`/desktop-login?challenge=${challenge}&state=${state}&__canvinkTestSignedOut=1`);
  await expect(page.getByText('Melde dich zuerst an.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
  await shoot(page, 'page-signed-out');
});

test('an Android app gets the same hand-off with its own wording', async ({ page }) => {
  const { challenge, state } = pkce();
  await page.goto(`${loginUrl(challenge, state, `user_android_${Date.now()}`)}&platform=android`);
  await expect(page.getByRole('heading', { name: 'Canvink Android anmelden' })).toBeVisible();
  await expect(page.getByText('Canvink Android als Anna Keller anmelden?')).toBeVisible();
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('status')).toHaveText('Canvink Android wird geöffnet …');
  const deepLink = new URL(await page.getByTestId('desktop-login-deep-link').getAttribute('href') as string);
  expect(`${deepLink.protocol}//${deepLink.host}`).toBe('canvink://auth');
  expect(deepLink.searchParams.get('state')).toBe(state);
});

test('one installation is one device; older duplicates fold into one entry that can be renamed and signed out', async ({ page }) => {
  const sub = `user_devices_${Date.now()}`;
  const exchange = async (fields: Record<string, unknown>) => {
    const { challenge, state, verifier } = pkce();
    await page.goto(loginUrl(challenge, state, sub));
    await page.getByRole('button', { name: 'Anmelden' }).click();
    const link = new URL(await page.getByTestId('desktop-login-deep-link').getAttribute('href') as string);
    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: link.searchParams.get('code'),
      code_verifier: verifier,
      ...fields,
    });
    expect(response.status).toBe(200);
  };
  // An Android app that signed in three times before the Worker knew installations: three rows, no computer name.
  for (let i = 0; i < 3; i += 1) await exchange({ device_name: 'Canvink Desktop (android)' });
  // A computer that signs in twice with the same installation id: the second replaces the first.
  const school = { device_name: 'Schul-Laptop', platform: 'linux', app_version: '0.3.2', install_id: 'inst_SCHOOLLAPTOP00000000' };
  await exchange(school);
  await exchange(school);

  await page.goto(accountUrl(sub));
  await openAccountPage(page, 'Geräte');
  const list = page.getByTestId('account-devices');
  const apps = list.locator('li:not(.account-dialog__device--current)');
  await expect(apps).toHaveCount(2);
  await expect(list.getByText('Schul-Laptop')).toHaveCount(1);
  await expect(list).toContainText('Linux-PC · Canvink Desktop 0.3.2');
  await expect(list).toContainText('3 Anmeldungen zusammengefasst');
  await expect(apps.filter({ hasText: 'Schul-Laptop' })).toContainText('Jetzt aktiv');
  await shoot(page, 'konto-devices');

  await list.getByRole('button', { name: 'Android umbenennen' }).click();
  await page.getByLabel('Gerätename').fill('Pixel von Anna');
  await page.getByLabel('Gerätename').press('Enter');
  await expect(list).toContainText('Pixel von Anna');
  // Reload: the name is the Worker's, on every folded row.
  await page.reload();
  await openAccountPage(page, 'Geräte');
  await expect(page.getByTestId('account-devices')).toContainText('Pixel von Anna');
  await expect(page.getByTestId('account-devices')).toContainText('3 Anmeldungen zusammengefasst');

  // Cancel keeps the device; confirming signs out all three rows at once.
  await page.getByRole('button', { name: 'Pixel von Anna abmelden' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.getByTestId('account-devices')).toContainText('Pixel von Anna');
  await page.getByRole('button', { name: 'Pixel von Anna abmelden' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Abmelden' }).click();
  await expect(page.getByTestId('account-devices')).not.toContainText('Pixel von Anna');
  await expect(page.getByTestId('account-devices')).toContainText('Schul-Laptop');
});

test('the cloud button is the sync status; the avatar menu is only the account', async ({ page }) => {
  const sub = `user_menu_${Date.now()}`;
  await page.goto(accountUrl(sub));
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  await expect(saveStatus(page)).toContainText('Synchronisiert', { timeout: 30_000 });

  await saveStatus(page).click();
  const popover = page.getByRole('region', { name: 'Alles ist synchronisiert' });
  await expect(popover).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Jetzt synchronisieren' })).toBeVisible();
  await expect(popover).toContainText('Zuletzt synchronisiert');
  await shoot(page, 'sync-popover');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  // The avatar opens the account, not the sync: name, address, one status line and four actions.
  await page.getByRole('button', { name: /^Konto: / }).click();
  const menu = page.getByRole('menu', { name: /^Konto: / });
  await expect(menu).toContainText('Anna Keller');
  await expect(menu).toContainText('anna.keller@example.com');
  await expect(page.getByTestId('account-sync-line')).toContainText('synchronisiert');
  for (const name of ['Konto und Geräte…', 'Desktop-App laden', 'Android-App laden', 'Abmelden']) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Desktop-Apps' })).toHaveCount(0);
  await expect(menu).not.toContainText('Dokumente');
  await shoot(page, 'account-menu');
});

test('without an account the same icon only reports the local save', async ({ page }) => {
  await page.goto('/app');
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  await expect(saveStatus(page)).toHaveAttribute('data-sync', 'local-saved');
  await saveStatus(page).click();
  const popover = page.getByRole('region', { name: 'Nur auf diesem Gerät gespeichert' });
  await expect(popover).toContainText('Gespeichert');
  await expect(popover.getByRole('button', { name: 'Jetzt synchronisieren' })).toHaveCount(0);
  await shoot(page, 'sync-popover-local');
});

test('the Konto page edits the profile, adds an address with a code and unlinks a provider', async ({ page }) => {
  await page.goto(accountUrl(`user_profile_${Date.now()}`));
  await openAccountPage(page, 'Profil');
  const dialog = page.getByRole('dialog', { name: 'Konto' });
  await expect(dialog.getByLabel('Vorname')).toHaveValue('Anna');
  await shoot(page, 'konto-profile');

  await dialog.getByLabel('Vorname').fill('Annika');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Gespeichert.');

  await dialog.getByRole('button', { name: 'Adresse hinzufügen' }).click();
  await dialog.getByRole('textbox', { name: 'E-Mail-Adresse' }).fill('zweit@example.com');
  await dialog.getByRole('button', { name: 'Code senden' }).click();
  await expect(dialog).toContainText('Wir haben einen Code an zweit@example.com geschickt.');
  await dialog.getByLabel('Bestätigungscode').fill('000000');
  await dialog.getByRole('button', { name: 'Bestätigen' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Das hat nicht geklappt');
  await dialog.getByLabel('Bestätigungscode').fill('123456');
  await dialog.getByRole('button', { name: 'Bestätigen' }).click();
  await expect(dialog.getByText('zweit@example.com')).toBeVisible();
  await expect(dialog.getByText('Nicht bestätigt')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'zweit@example.com als primär festlegen' }).click();
  await expect(dialog.locator('li', { hasText: 'zweit@example.com' })).toContainText('Primär');

  await dialog.getByRole('tab', { name: 'Anmeldung' }).click();
  await expect(dialog).toContainText('Clerk: Passwort');
  await shoot(page, 'konto-signin');
  await dialog.getByRole('button', { name: 'Google trennen' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Trennen' }).click();
  await expect(dialog.getByRole('button', { name: 'Google verbinden' })).toBeVisible();

  // Escape closes the page and the focus goes back to where it was.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
