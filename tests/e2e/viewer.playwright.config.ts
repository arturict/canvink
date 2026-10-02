import { defineConfig, devices } from '@playwright/test';

/**
 * The Android viewer's web half: the same bundle `pnpm build:android` ships
 * (CANVINK_VIEWER=1) in a phone-sized browser. It proves what the app must
 * never do (draw) and what it must keep (type, search). The Tauri shell, the
 * sign-in hand-off and the APK are covered on an emulator. Run with:
 *
 *   pnpm exec playwright test --config tests/e2e/viewer.playwright.config.ts
 */

const port = Number(process.env.PLAYWRIGHT_VIEWER_PORT ?? '5190');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'viewer.spec.ts',
  outputDir: '../../test-results/viewer',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: { baseURL, actionTimeout: 20_000, navigationTimeout: 30_000, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'phone',
      use: {
        ...devices['Pixel 7'],
        // The viewer reads German like the rest of Canvink.
        locale: 'de-CH',
      },
    },
  ],
  webServer: {
    // A separate output directory keeps the regular build of this checkout intact.
    command: `CANVINK_VIEWER=1 pnpm exec vite build --outDir dist-viewer --emptyOutDir && pnpm exec vite preview --outDir dist-viewer --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: '../..',
    url: `${baseURL}/app`,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVERS === '1',
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
