#!/usr/bin/env node
/**
 * Records the short clips of the landing page (public/landing/) from the real
 * app, with synthetic data only, and encodes them (webm VP9, mp4 H.264, poster).
 *
 *   node scripts/record-landing-clips.mjs              # all clips
 *   node scripts/record-landing-clips.mjs --only collab,notebook
 *   node scripts/record-landing-clips.mjs --reuse      # use servers that already run
 *
 * It builds the app into node_modules/.cache/landing-clips-app (with the test
 * auth seam and the local collab-sync Worker URL baked in, like the collab e2e
 * config), starts that Worker (`wrangler dev`) and `vite preview`, seeds a
 * synthetic notebook with scripts/bench/seed-workspace.ts (the hero clip uses
 * its `--school 1` notebook), drives Chromium with
 * a CDP screencast at 2x device pixels and encodes with ffmpeg.
 * Needs ffmpeg on the PATH. Nothing here touches a real notebook.
 *
 * Each clip is one function below: it gets a page, does the setup, calls
 * `ready()` when the footage should start and `done()` when it should end.
 * Everything before `ready()` is cut away.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { generateSeed, seedWorkspace, shownStrokeCount } from '../tests/e2e/seededWorkspace.ts';

const root = join(import.meta.dirname, '..');
const outDir = join(root, 'public', 'landing');
const workDir = join(tmpdir(), 'canvink-landing-clips');
const appBuild = join(root, 'node_modules', '.cache', 'landing-clips-app');
const appPort = Number(process.env.LANDING_CLIPS_APP_PORT ?? '4591');
const workerPort = Number(process.env.LANDING_CLIPS_WORKER_PORT ?? '8799');
const authSecret = 'canvink-e2e-test-auth-secret';
const appUrl = `http://127.0.0.1:${appPort}`;

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const reuse = args.includes('--reuse');

const children = [];

async function listening(url) {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await listening(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not start.`);
}

async function startServers() {
  if (!(reuse && (await listening(`${appUrl}/app`)))) {
    execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', appBuild, '--emptyOutDir'], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        VITE_COLLAB_SYNC_URL: `http://127.0.0.1:${workerPort}`,
        VITE_CANVINK_ALLOW_FEATURE_OVERRIDE: '1',
        VITE_PERSONAL_SPACE_TEST_AUTH_SECRET: authSecret,
      },
    });
    children.push(spawn('pnpm', ['exec', 'vite', 'preview', '--outDir', appBuild, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], { cwd: root, stdio: 'ignore' }));
  }
  if (!(reuse && (await listening(`http://127.0.0.1:${workerPort}/`)))) {
    const workerDir = join(root, 'services', 'collab-sync');
    execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: workerDir, stdio: 'inherit' });
    children.push(spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(workerPort), '--var', `TEST_AUTH_SECRET:${authSecret}`, '--var', 'ALLOWED_ORIGINS:*'], { cwd: workerDir, stdio: 'ignore' }));
  }
  await waitFor(`${appUrl}/app`, 'The app preview');
  await waitFor(`http://127.0.0.1:${workerPort}/`, 'The collab-sync Worker');
}

function stopServers() {
  for (const child of children) child.kill('SIGTERM');
}

/* ------------------------------------------------------------------ encoding */

const ffmpeg = (...argv) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });

/* ----------------------------------------------------------------- recording */

const SCALE = 2;

/**
 * Playwright's own video recording keeps the page at 1x in a corner of the
 * frame, so the clips are captured with a CDP screencast instead. With the
 * browser launched at a device scale factor of 2 its frames carry real 2x
 * pixels. A screencast only sends a frame when the page changes; the encoder
 * gets each frame's duration from the time stamps. It takes every frame:
 * with every second one, the last change before a still moment (a picture
 * that finished decoding) could be skipped and never reach the clip.
 */
async function startScreencast(page, size, frameDir) {
  mkdirSync(frameDir, { recursive: true });
  const session = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  session.on('Page.screencastFrame', (frame) => {
    const file = join(frameDir, `${String(frames.length).padStart(5, '0')}.jpg`);
    frames.push({ file, time: frame.metadata.timestamp });
    writes.push(writeFile(file, Buffer.from(frame.data, 'base64')));
    session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
  });
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
  return async () => {
    await session.send('Page.stopScreencast').catch(() => undefined);
    await Promise.all(writes);
    return frames;
  };
}

/**
 * Cuts [start, end] (epoch seconds) out of the screencast frames, crops it to
 * `crop` (CSS pixels of the page) and writes webm, mp4 and a poster.
 */
async function encode(name, frames, frameDir, { start, end, crop, outWidth, posterAt }) {
  const list = join(frameDir, 'frames.txt');
  const lines = frames.map((frame, index) => {
    const next = frames[index + 1]?.time ?? Math.max(end, frame.time + 0.04);
    return `file '${frame.file}'\nduration ${Math.max(next - frame.time, 0.001).toFixed(4)}`;
  });
  await writeFile(list, `${lines.join('\n')}\nfile '${frames[frames.length - 1].file}'\n`);
  const x = Math.round(crop.x * SCALE);
  const y = Math.round(crop.y * SCALE);
  const width = Math.round(crop.width * SCALE) & ~1;
  const height = Math.round(crop.height * SCALE) & ~1;
  const filter = `fps=30,crop=${width}:${height}:${x}:${y},scale=${outWidth}:-2:flags=lanczos`;
  const offset = Math.max(start - frames[0].time, 0);
  const cut = ['-f', 'concat', '-safe', '0', '-i', list, '-ss', offset.toFixed(2), '-t', (end - start).toFixed(2), '-an', '-vf', filter];
  ffmpeg(...cut, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '1', '-pix_fmt', 'yuv420p', join(outDir, `${name}.webm`));
  ffmpeg(...cut, '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(outDir, `${name}.mp4`));
  // Through the same fps filter as the clip: the screencast has no frames
  // while the page stands still, so without it the poster would be the next
  // change after `posterAt` instead of what the clip shows at that moment.
  ffmpeg('-f', 'concat', '-safe', '0', '-i', list, '-ss', (offset + posterAt).toFixed(2), '-frames:v', '1', '-vf', filter, '-quality', '82', join(outDir, `${name}-poster.webp`));
}

/**
 * Runs `scenario` in a fresh context and encodes the part between `ready()`
 * and `done()`.
 */
async function record(browser, name, options, scenario) {
  const { viewport, crop = { x: 0, y: 0, ...viewport }, outWidth = 1100, posterAt = 0, contextOptions = {} } = options;
  const frameDir = join(workDir, name);
  rmSync(frameDir, { recursive: true, force: true });
  const context = await browser.newContext({ viewport, reducedMotion: 'no-preference', ...contextOptions });
  const page = await context.newPage();
  const stop = await startScreencast(page, { width: viewport.width * SCALE, height: viewport.height * SCALE }, frameDir);
  let start = null;
  let end = null;
  const marks = {
    ready: () => {
      start = Date.now() / 1000;
    },
    done: () => {
      end = Date.now() / 1000;
    },
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/WebSocket|ERR_INTERNET/.test(message.text())) errors.push(`console.error: ${message.text()}`);
  });
  let frames;
  try {
    await scenario(page, { ...marks, context });
  } finally {
    frames = await stop();
    await context.close();
  }
  if (errors.length > 0) throw new Error(`${name}: the app logged errors:\n${errors.join('\n')}`);
  if (start === null || end === null) throw new Error(`${name}: the scenario never marked ready/done.`);
  mkdirSync(outDir, { recursive: true });
  await encode(name, frames, frameDir, { start, end, crop, outWidth, posterAt });
  const sizes = ['webm', 'mp4'].map((ext) => `${ext} ${(statSync(join(outDir, `${name}.${ext}`)).size / 1024).toFixed(0)} KB`);
  console.log(`${name}: ${(end - start).toFixed(1)} s, ${frames.length} frames, ${sizes.join(', ')}`);
}

/* -------------------------------------------------------------- shared steps */

const waitForSaved = (page, timeout = 60_000) => expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout });
const pause = (page, ms) => page.waitForTimeout(ms);

async function selectRibbon(page, name) {
  const tab = page.getByRole('tab', { name, exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  return page.getByRole('tabpanel', { name, exact: true });
}

/* -------------------------------------------------------------------- clips */

const identity = (sub, name) => `?__canvinkSpaceTestSub=${encodeURIComponent(`${sub}-${Date.now()}`)}&__canvinkTestName=${encodeURIComponent(name)}`;

const clips = {
  /** Two people on one notebook: presence faces, jump to a person, live ink. */
  async collab(browser) {
    await record(browser, 'collab', { viewport: { width: 880, height: 580 }, crop: { x: 0, y: 0, width: 880, height: 430 }, outWidth: 1100, posterAt: 5 }, async (page, { ready, done, context }) => {
      await page.goto(`${appUrl}/app${identity('anna', 'Anna Keller')}`, { waitUntil: 'domcontentloaded' });
      await waitForSaved(page);

      // Anna's page with a short plan, then an empty sketch page she stays on.
      const more = page.locator('.app-topbar').getByRole('button', { name: /^Mehr$/, exact: true });
      const openMore = async () => {
        if (!(await page.getByRole('button', { name: 'Schnelle Notiz', exact: true }).isVisible())) await more.click();
      };
      await openMore();
      await page.getByRole('button', { name: 'Schnelle Notiz', exact: true }).click();
      const editor = page.getByRole('textbox', { name: 'Gemeinsamer Text' }).last();
      await expect(editor).toBeFocused();
      await editor.fill('Projektwoche\nMo: Recherche und Interviews\nDi: Skizzen und Prototyp\nMi: Feedbackrunde im Team');
      await page.getByLabel('Seitentitel').fill('Wochenplan');
      await waitForSaved(page);
      await page.getByRole('button', { name: /^Seite hinzufügen/ }).first().click();
      await page.getByLabel('Seitentitel').fill('Skizze');
      await waitForSaved(page);

      // Share the notebook and let Ben join as an editor.
      await openMore();
      await page.getByRole('button', { name: 'Notizbuch teilen', exact: true }).click();
      await page.getByRole('button', { name: 'Link erstellen', exact: true }).click();
      const input = page.locator('#collab-share-url');
      await expect(input).toHaveValue(/#join=/, { timeout: 15_000 });
      const url = await input.inputValue();
      await page.getByRole('button', { name: 'Teilen schliessen' }).click();

      const ben = await context.browser().newContext({ viewport: { width: 880, height: 580 } });
      try {
        const benPage = await ben.newPage();
        await benPage.goto(`${appUrl}/app${identity('ben', 'Ben Rossi')}${url.slice(url.indexOf('#'))}`, { waitUntil: 'domcontentloaded' });
        // The link adds the notebook to Ben's own workspace; its pages arrive a moment after the join.
        const pageRow = benPage.locator('.page-row__target', { hasText: 'Wochenplan' }).first();
        await expect(pageRow).toBeVisible({ timeout: 40_000 });
        await pageRow.click();
        await benPage.getByRole('tab', { name: /^Zeichnen$/ }).click();
        await benPage.getByRole('tabpanel', { name: /^Zeichnen$/ }).getByRole('button', { name: 'Stift', exact: true }).click();
        const canvas = benPage.getByRole('application', { name: 'Gemeinsame Seitenzeichenfläche' });
        const box = await canvas.boundingBox();
        const face = page.locator('.presence-person__button').filter({ has: page.locator('.presence-avatar') });
        await expect(face).toHaveAttribute('aria-label', /Ben Rossi · Seite Wochenplan/, { timeout: 20_000 });
        await benPage.mouse.move(box.x + 300, box.y + 200);

        ready();
        // Anna sees Ben in the title bar, hovers for the preview and jumps to him.
        await pause(page, 900);
        await face.hover();
        await pause(page, 1300);
        await face.click();
        await expect(page.getByLabel('Seitentitel')).toHaveValue('Wochenplan', { timeout: 15_000 });
        await page.evaluate(() => document.activeElement?.blur());
        await pause(page, 600);
        // Ben draws a loop; Anna watches the stroke grow before it is committed.
        const { x, y } = { x: box.x + 150, y: box.y + 130 };
        await benPage.mouse.move(x, y);
        await benPage.mouse.down();
        for (let step = 0; step <= 40; step += 1) {
          const angle = (step / 40) * Math.PI * 2.2;
          await benPage.mouse.move(x + 150 + Math.cos(angle) * 170, y + 50 + Math.sin(angle) * 55, { steps: 2 });
          await pause(page, 18);
        }
        await benPage.mouse.up();
        await pause(page, 1100);
        done();
      } finally {
        await ben.close();
      }
    });
  },
  /** Fast pen ink, then a lasso that picks the sketch up and moves it. */
  async ink(browser) {
    await record(browser, 'ink', { viewport: { width: 880, height: 580 }, crop: { x: 250, y: 130, width: 630, height: 440 }, outWidth: 1000, posterAt: 5.4 }, async (page, { ready, done }) => {
      await page.goto(`${appUrl}/app`, { waitUntil: 'domcontentloaded' });
      await waitForSaved(page);
      const draw = await selectRibbon(page, 'Zeichnen');
      await draw.getByRole('button', { name: 'Stift', exact: true }).click();
      const box = await page.getByRole('application', { name: 'Gemeinsame Seitenzeichenfläche' }).boundingBox();
      const at = (x, y) => ({ x: box.x + x, y: box.y + y });

      /** One stroke through `points`, quick like a pen: 2 to 3 moves per 16 ms frame. */
      const stroke = async (points, steps = 3) => {
        await page.mouse.move(points[0].x, points[0].y);
        await page.mouse.down();
        for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps });
        await page.mouse.up();
      };
      /** Block capitals drawn the way a quick hand does: a few strokes per letter. */
      const arc = (cx, cy, rx, ry, from, to, count = 10) =>
        Array.from({ length: count + 1 }, (_, i) => {
          const angle = from + ((to - from) * i) / count;
          return at(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry);
        });
      const letters = {
        I: (x, y) => [[at(x, y), at(x, y + 60)]],
        D: (x, y) => [[at(x, y), at(x, y + 60)], arc(x, y + 30, 44, 30, -Math.PI / 2, Math.PI / 2)],
        E: (x, y) => [[at(x + 36, y), at(x, y), at(x, y + 60), at(x + 36, y + 60)], [at(x, y + 30), at(x + 28, y + 30)]],
      };
      const write = async (text, x, y) => {
        let cursor = x;
        for (const letter of text) {
          for (const points of letters[letter](cursor, y)) await stroke(points, 4);
          cursor += letter === 'I' ? 34 : 64;
        }
      };
      const star = (cx, cy, r) =>
        [0, 2, 4, 1, 3, 0].map((corner) => at(cx + Math.sin((corner * 2 * Math.PI) / 5) * r, cy - Math.cos((corner * 2 * Math.PI) / 5) * r));

      ready();
      await pause(page, 300);
      await write('IDEE', 70, 40);
      await stroke(star(160, 250, 62), 5);
      await pause(page, 500);

      // Lasso around the star, then drag it to the right.
      await draw.getByRole('button', { name: 'Lasso', exact: true }).click();
      await page.mouse.move(box.x + 40, box.y + 140);
      await page.mouse.down();
      for (const [x, y] of [[290, 150], [290, 350], [40, 350], [40, 154]]) await page.mouse.move(box.x + x, box.y + y, { steps: 8 });
      await page.mouse.up();
      await pause(page, 500);
      const grab = star(160, 250, 62)[0];
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 240, grab.y - 20, { steps: 24 });
      await page.mouse.up();
      await pause(page, 1200);
      done();
    });
  },

  /**
   * The hero: a written-in school notebook in OneNote's three columns (the
   * notebook in the title bar, coloured sections, the section's pages, the
   * page), then pages and sections open at once and the notebook switcher
   * lists the other notebooks.
   */
  async notebook(browser) {
    const seedDir = generateSeed(join(workDir, 'seed'), ['--school', '1']);
    // The three-column layout needs a window of at least 1100 CSS pixels.
    const viewport = { width: 1240, height: 740 };
    await record(browser, 'notebook', { viewport, outWidth: 1800, posterAt: 0.8, contextOptions: { baseURL: appUrl } }, async (page, { ready, done }) => {
      const pages = await seedWorkspace(page, seedDir);
      // Slimmer columns than the defaults (as if dragged), so the A4 sheet fits beside them.
      await page.evaluate(() => {
        localStorage.setItem('canvink:nav-width:sections', '180');
        localStorage.setItem('canvink:nav-width:pages', '250');
      });
      await page.goto('/app');
      // After every navigation the app hands the focus to the page title, and
      // closing the notebook switcher hands it back to its button (focus rings
      // and a caret); the clip shows the notebook as a reader sees it.
      await page.evaluate(() => document.addEventListener('focusin', (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.matches('input[aria-label="Seitentitel"], .notebook-switcher__button')) target.blur();
      }));
      const info = (title) => {
        const found = pages.find((candidate) => candidate.title === title);
        if (!found) throw new Error(`The school seed has no page ${title}.`);
        return found;
      };
      const start = info('Analysis – Kurvendiskussion');
      const derivatives = info('Analysis – Ableitungen');
      const kinematics = info('Physik – Kinematik');
      const energy = info('Physik – Energieerhaltung');
      const kafka = info('Deutsch – Kafka, Die Verwandlung');
      const title = page.getByLabel('Seitentitel');
      // The first open of a seeded notebook builds its page index once.
      await expect(title).toHaveValue(start.title, { timeout: 300_000 });
      await expect(page.locator('[data-search-indexing]')).toHaveCount(0, { timeout: 120_000 });

      /** Waits until `target` shows completely: its title, no loading overlay, all its ink painted, every picture sharp. */
      const shown = async (target) => {
        await expect(title).toHaveValue(target.title);
        await expect(page.locator('[data-page-loading]')).toHaveCount(0, { timeout: 30_000 });
        await expect.poll(() => shownStrokeCount(page), { timeout: 30_000 }).toBe(target.strokes);
        await expect(page.locator('.asset-preview-frame:not([data-preview-state="sharp"])')).toHaveCount(0, { timeout: 30_000 });
      };
      const openPage = async (target) => {
        await page.locator(`[data-page-row-id="${target.pageId}"] .page-row__target`).click();
        await shown(target);
      };
      // A section opens on the page last shown in it.
      const openSection = async (target) => {
        await page.locator(`[data-section-row-id="${target.sectionId}"] button`).first().click();
        await shown(target);
      };
      const switcher = page.locator('.notebook-switcher__button');
      const switcherDialog = page.getByRole('dialog', { name: /^(Notizbuch wechseln|Switch notebook)$/ });

      // Open every page of the clip once, as in a session that has been
      // running a while: the five pages are then all in memory (the active one
      // and the four last used), and each section reopens on the clip's page.
      await shown(start);
      await openPage(derivatives);
      await openSection(kinematics);
      await openPage(energy);
      await openPage(kinematics);
      await openSection(kafka);
      await switcher.click();
      await expect(switcherDialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(switcherDialog).toBeHidden();
      await openSection(derivatives);
      await openPage(start);
      await page.mouse.move(viewport.width / 2, viewport.height - 4);
      await pause(page, 1000);

      ready();
      await pause(page, 1600);
      await openPage(derivatives);
      await pause(page, 750);
      await openSection(kinematics);
      await pause(page, 800);
      await openPage(energy);
      await pause(page, 750);
      await openSection(kafka);
      await pause(page, 900);
      await switcher.click();
      await expect(switcherDialog).toBeVisible();
      await pause(page, 1050);
      await page.keyboard.press('Escape');
      await expect(switcherDialog).toBeHidden();
      await page.mouse.move(viewport.width / 2, viewport.height - 4);
      await pause(page, 600);
      done();
    });
  },

  /** A Markdown page with slash commands and shortcuts. */
  async markdown(browser) {
    await record(browser, 'markdown', { viewport: { width: 880, height: 580 }, crop: { x: 190, y: 90, width: 690, height: 400 }, outWidth: 1000, posterAt: 5.5 }, async (page, { ready, done }) => {
      await page.goto(`${appUrl}/app`, { waitUntil: 'domcontentloaded' });
      await waitForSaved(page);
      const navigation = page.getByRole('navigation', { name: 'Notizbuchnavigation' });
      await navigation.getByRole('button', { name: 'Erstellen', exact: true }).click();
      await navigation.getByRole('button', { name: 'Markdown-Seite', exact: true }).click();
      await page.getByLabel('Seitentitel').fill('Wochenplan');
      const editor = page.getByRole('textbox', { name: 'Notiz bearbeiten' });
      await editor.click();
      await waitForSaved(page);

      ready();
      await pause(page, 600);
      const type = (text, delay = 30) => page.keyboard.type(text, { delay });
      await type('/');
      await pause(page, 700);
      await type('h1', 100);
      await pause(page, 600);
      await page.keyboard.press('Enter');
      await type('Wochenplan');
      await page.keyboard.press('Enter');
      await type('Mit **Fokus** auf `Mathe`.');
      await page.keyboard.press('Enter');
      await type('[] Mathe repetieren');
      await page.keyboard.press('Enter');
      await type('Referat planen');
      await page.keyboard.press('Enter');
      await pause(page, 1500);
      done();
    });
  },
};

/* ---------------------------------------------------------------------- main */

mkdirSync(workDir, { recursive: true });
await startServers();
// The flag gives the screencast real 2x pixels; a context-level deviceScaleFactor does not.
const browser = await chromium.launch({ args: [`--force-device-scale-factor=${SCALE}`] });
try {
  for (const [name, run] of Object.entries(clips)) {
    if (only && !only.includes(name)) continue;
    await run(browser);
  }
} finally {
  await browser.close();
  stopServers();
}
