import { spawnSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

// Real-browser smoke tests. A tiny static server (tests/e2e/serve.cjs) serves the
// built package + a fixture page; the suite renders a chart and exercises the
// interactions/feed paths that unit tests (fake canvas) can't catch.
//
// The yfinance demo (examples/yfinance, the reference host) is driven through
// its own server in --fixture mode: synthetic bars, no network, no yfinance.
// That server is Python, which not every machine has, so it is started only
// when a Python 3 answers on PATH; tests/e2e/yfinance.spec.ts probes for it
// and skips itself when it is absent, rather than failing a run that never
// asked for Python.

const DEMO_PORT = 8124;
const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`;

/** The first Python 3 on PATH, as the command to run it by, or null. */
function pythonOnPath(): string | null {
  // Windows ships a `python` stub that opens the Store and exits non-zero;
  // the version check rules it out along with a Python 2 (which prints its
  // version on stderr, so stdout stays empty).
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const py of candidates) {
    const r = spawnSync(py, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0 && /^Python 3\./.test(r.stdout.trim())) return py;
  }
  return null;
}

const python = pythonOnPath();

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: [
    {
      command: 'node tests/e2e/serve.cjs',
      url: 'http://127.0.0.1:4173/dist/openalgo-charts.mjs',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    ...(python
      ? [{
          command: `${python} examples/yfinance/server.py --fixture --quiet --port ${DEMO_PORT}`,
          url: `${DEMO_URL}/examples/yfinance/index.html`,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        }]
      : []),
  ],
  projects: [
    // The engine suite, against the static server. The demo spec is not in
    // it: that page needs /api/history, which serve.cjs does not answer.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /yfinance\.spec\.ts/ },
    // The demo, against its own server. Kept in the list even with no
    // Python, so the spec is found and can report itself skipped.
    { name: 'yfinance-demo', testMatch: /yfinance\.spec\.ts/, use: { ...devices['Desktop Chrome'], baseURL: DEMO_URL } },
  ],
});
