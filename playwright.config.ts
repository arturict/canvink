import { defineConfig, devices } from '@playwright/test';

const isCi = process.env.CI === 'true';
const previewPort = Number(process.env.PLAYWRIGHT_PORT ?? '4173');
const baseURL = `http://127.0.0.1:${previewPort}`;
const webServerCommand =
  process.env.PLAYWRIGHT_PREBUILT === 'true'
    ? `pnpm preview --host 127.0.0.1 --port ${previewPort} --strictPort`
    : `pnpm build && pnpm preview --host 127.0.0.1 --port ${previewPort} --strictPort`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers: isCi ? 1 : undefined,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
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
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: webServerCommand,
    url: `${baseURL}/app`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
