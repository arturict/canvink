import { defineConfig, devices } from '@playwright/test';

/**
 * Dedicated Playwright config for the personal-space e2e spec only, modelled
 * on `tests/e2e/collab-sync.playwright.config.ts` (PERSONAL-SYNC.md §9
 * Wave 5 task 5). Needs its own worker (`wrangler dev`, this time with a
 * local R2 binding for the asset routes — see `../../services/collab-sync
 * /wrangler.e2e.jsonc` for why a config file is used instead of a `--r2` CLI
 * flag) and an app build with `VITE_PERSONAL_SPACE=1` baked in. Run with:
 *
 *   pnpm exec playwright test --config tests/e2e/personal-space.playwright.config.ts
 */

const appPort = Number(process.env.PLAYWRIGHT_SPACE_APP_PORT ?? '4175');
const workerPort = Number(process.env.PLAYWRIGHT_SPACE_WORKER_PORT ?? '8798');
const workerOrigin = `http://127.0.0.1:${workerPort}`;
const baseURL = `http://127.0.0.1:${appPort}`;
const testAuthSecret = process.env.SPACE_E2E_TEST_AUTH_SECRET ?? 'canvink-space-e2e-test-auth-secret';
const personalSpaceSalt = process.env.SPACE_E2E_PERSONAL_SPACE_SALT ?? 'canvink-space-e2e-personal-space-salt';

export default defineConfig({
  testDir: '.',
  testMatch: /personal-space(-big-pdf|-first-open|-shared)?\.spec\.ts$/,
  outputDir: '../../test-results/personal-space',
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
        '-c wrangler.e2e.jsonc',
        `--port ${workerPort}`,
        `--var TEST_AUTH_SECRET:${testAuthSecret}`,
        `--var PERSONAL_SPACE_SALT:${personalSpaceSalt}`,
        '--var ALLOWED_ORIGINS:*',
      ].join(' '),
      cwd: '../../services/collab-sync',
      // Same reasoning as `collab-sync.playwright.config.ts`: every route on this
      // worker requires a specific method/credential, so a bare GET never returns
      // 2xx — wait for the TCP port instead of a URL health check.
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
        VITE_PERSONAL_SPACE: '1',
        VITE_COLLAB_SYNC_URL: workerOrigin,
        // Deliberately NOT `VITE_CLERK_PUBLISHABLE_KEY`: real Clerk is never
        // configured for this e2e build (no network dependency on Clerk), and
        // no Clerk bundle loads. Both browser contexts instead authenticate
        // through `src/auth/e2eTestAuth.ts`'s seam, gated
        // on this build-time secret, which must equal the Worker's
        // `TEST_AUTH_SECRET` above so the HMAC matches.
        VITE_PERSONAL_SPACE_TEST_AUTH_SECRET: testAuthSecret,
      },
    },
  ],
});
