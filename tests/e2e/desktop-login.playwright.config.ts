import { defineConfig, devices } from '@playwright/test';

/**
 * Desktop sign-in e2e (services/collab-sync/PERSONAL-SYNC.md §3.7): drives the
 * browser half (`/desktop-login`) with the e2e test identity against a local
 * `wrangler dev` Worker, captures the `canvink://auth` hand-off and plays the
 * desktop app's part (code + verifier exchange, refresh) over HTTP. The Tauri
 * half is covered by Rust unit tests and a manual run on Windows. Run with:
 *
 *   pnpm exec playwright test --config tests/e2e/desktop-login.playwright.config.ts
 */

const appPort = Number(process.env.PLAYWRIGHT_DESKTOP_LOGIN_APP_PORT ?? '5188');
const workerPort = Number(process.env.PLAYWRIGHT_DESKTOP_LOGIN_WORKER_PORT ?? '8791');
const workerOrigin = `http://127.0.0.1:${workerPort}`;
const baseURL = `http://127.0.0.1:${appPort}`;
const testAuthSecret = 'canvink-desktop-login-e2e-test-auth-secret';

export default defineConfig({
  testDir: '.',
  testMatch: 'desktop-login.spec.ts',
  outputDir: '../../test-results/desktop-login',
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
  metadata: { workerOrigin },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: [
        'pnpm exec wrangler dev',
        '-c wrangler.e2e.jsonc',
        `--port ${workerPort}`,
        `--inspector-port ${workerPort + 1}`,
        `--var TEST_AUTH_SECRET:${testAuthSecret}`,
        '--var PERSONAL_SPACE_SALT:canvink-desktop-login-e2e-salt',
        '--var DEVICE_TOKEN_SECRET:canvink-desktop-login-e2e-device-secret',
        '--var ALLOWED_ORIGINS:*',
      ].join(' '),
      cwd: '../../services/collab-sync',
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
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        VITE_PERSONAL_SPACE: '1',
        VITE_COLLAB_SYNC_URL: workerOrigin,
        // The e2e identity seam replaces Clerk (src/auth/e2eTestAuth.ts); it
        // must match the Worker's TEST_AUTH_SECRET above.
        VITE_PERSONAL_SPACE_TEST_AUTH_SECRET: testAuthSecret,
      },
    },
  ],
});
