import { defineConfig, devices } from '@playwright/test';

/**
 * Dedicated Playwright config for the notebook-sharing e2e specs
 * (`collab-sync.spec.ts`, `collab-presence.spec.ts`, `collab-join.spec.ts`, `collab-sharing.spec.ts`). Kept
 * separate from `playwright.config.ts` (which drives the other ~51 specs)
 * because this spec needs two web servers — the `collab-sync` Worker via
 * `wrangler dev`, and the app built with `VITE_COLLAB_SYNC_URL` baked in at
 * build time (a Vite env var, so it can't be injected after the fact the way
 * the main config's `VITE_CANVINK_ALLOW_FEATURE_OVERRIDE` is). Run with:
 *
 *   pnpm exec playwright test --config tests/e2e/collab-sync.playwright.config.ts
 *
 * The Worker's own dependencies are installed by the web server command
 * (services/collab-sync is a separate pnpm workspace). Both ports can be
 * moved with PLAYWRIGHT_COLLAB_APP_PORT / PLAYWRIGHT_COLLAB_WORKER_PORT when
 * another checkout already uses the defaults. Servers are only reused with
 * PLAYWRIGHT_REUSE_SERVERS=1: a server that happens to listen on the port
 * may be another checkout's build without the env this suite needs.
 */

const appPort = Number(process.env.PLAYWRIGHT_COLLAB_APP_PORT ?? '4174');
const workerPort = Number(process.env.PLAYWRIGHT_COLLAB_WORKER_PORT ?? '8799');
const workerOrigin = `http://127.0.0.1:${workerPort}`;
const baseURL = `http://127.0.0.1:${appPort}`;
const testAuthSecret = process.env.COLLAB_E2E_TEST_AUTH_SECRET ?? 'canvink-e2e-test-auth-secret';

export default defineConfig({
  testDir: '.',
  testMatch: /collab-(sync|presence|join|sharing)\.spec\.ts/,
  outputDir: '../../test-results/collab-sync',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    locale: 'de-CH',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: [
        'pnpm install --frozen-lockfile --prefer-offline &&',
        'pnpm exec wrangler dev',
        `--port ${workerPort}`,
        `--var TEST_AUTH_SECRET:${testAuthSecret}`,
        '--var ALLOWED_ORIGINS:*',
      ].join(' '),
      cwd: '../../services/collab-sync',
      // `port` (not `url`) readiness: every route on this worker requires a
      // specific method/credential and returns a non-2xx status on a bare
      // GET, so Playwright's default 2xx `url` poll would never succeed.
      // Waiting for the TCP port to accept connections is the accurate
      // "is the dev server up" signal here.
      port: workerPort,
      reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVERS === '1',
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `pnpm build && pnpm preview --host 127.0.0.1 --port ${appPort} --strictPort`,
      cwd: '../..',
      url: `${baseURL}/app`,
      reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVERS === '1',
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        VITE_COLLAB_SYNC_URL: workerOrigin,
        // The ink test hook (`window.__canvinkInk`) and the e2e auth seam that
        // lets a context join as an editor (`src/auth/e2eTestAuth.ts`); the
        // secret must equal the Worker's TEST_AUTH_SECRET above.
        VITE_CANVINK_ALLOW_FEATURE_OVERRIDE: '1',
        VITE_PERSONAL_SPACE_TEST_AUTH_SECRET: testAuthSecret,
      },
    },
  ],
});
