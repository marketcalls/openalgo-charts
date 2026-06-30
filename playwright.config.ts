import { defineConfig, devices } from '@playwright/test';

// Real-browser smoke tests. A tiny static server (tests/e2e/serve.cjs) serves the
// built package + a fixture page; the suite renders a chart and exercises the
// interactions/feed paths that unit tests (fake canvas) can't catch.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'node tests/e2e/serve.cjs',
    url: 'http://127.0.0.1:4173/dist/openalgo-charts.mjs',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
