import { defineConfig, devices } from '@playwright/test';

const isCi = process.env.CI === 'true';
const previewPort = Number(process.env.PLAYWRIGHT_PORT ?? '4173');
const requestedLocalWorkers = Number(process.env.PLAYWRIGHT_WORKERS ?? '4');
const localWorkers = Number.isSafeInteger(requestedLocalWorkers) && requestedLocalWorkers > 0
  ? requestedLocalWorkers
  : 4;
const baseURL = `http://127.0.0.1:${previewPort}`;
const webServerCommand =
  process.env.PLAYWRIGHT_PREBUILT === 'true'
    ? `pnpm preview --host 127.0.0.1 --port ${previewPort} --strictPort`
    : `pnpm build && pnpm preview --host 127.0.0.1 --port ${previewPort} --strictPort`;

export default defineConfig({
  testDir: './tests/e2e',
  // These need a local collab-sync Worker and their own app build; they run
  // under tests/e2e/collab-sync.playwright.config.ts and
  // tests/e2e/personal-space.playwright.config.ts.
  testIgnore: [/collab-(sync|presence|join|sharing)\.spec\.ts$/, /personal-space(-big-pdf|-shared)?\.spec\.ts$/, /desktop-login\.spec\.ts$/, /viewer\.spec\.ts$/],
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers: isCi ? 1 : localWorkers,
  // The ceilings are for a machine that other agents share: a wait returns as
  // soon as the app signals, so they only decide how long a real failure takes.
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  reporter: isCi
    ? [
        ['github'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
      ]
    : [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
      ],
  use: {
    baseURL,
    // The app picks its language from the browser. The suite selects by German
    // text, so it runs as a German browser; english-smoke.spec.ts opts into en-US.
    locale: 'de-CH',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        // Extra Chromium flags for a machine whose software GL crashes (dev-t15's virtual CPU).
        ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
        launchOptions: { args: (process.env.PLAYWRIGHT_CHROME_ARGS ?? '').split(' ').filter(Boolean) },
      },
    },
  ],
  webServer: {
    command: webServerCommand,
    url: `${baseURL}/app`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // The e2e suite exercises the Math Canvas through the `?__canvinkFeatureMath=1`
    // URL override against a production-mode preview build. The override is no
    // longer granted merely for being served on a loopback host, so the preview
    // build must opt in explicitly. A real release build never sets this.
    env: {
      VITE_CANVINK_ALLOW_FEATURE_OVERRIDE: '1',
    },
  },
});
