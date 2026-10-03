import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(repoRoot, '.data', 'e2e');
// Ports come from the environment so a run never collides with a running `npm run dev` or with a port
// assigned to somebody else (E2E_API_PORT, E2E_WEB_PORT); the defaults are the project's usual ones.
const SERVER_PORT = Number(process.env.E2E_API_PORT ?? 8787);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);

/*
 * Global section K: workers 1, one project per viewport, both servers started by Playwright with
 * reuseExistingServer false so a test never talks to somebody else's stack. The API server uses an embedded
 * PGlite database in .data/e2e (wiped on every start); scratch files stay under .data, never in the
 * RAM-backed /tmp. Run it under the heavy lock (global section M): it starts Chromium and a database.
 */
const softwareWebGL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  testDir: './journeys',
  outputDir: path.join(repoRoot, 'test-results'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(repoRoot, 'playwright-report') }]],
  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: softwareWebGL },
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-chromium',
      grep: /@mobile/,
      use: { ...devices['Pixel 7'] },
    },
    // Informational suites against a real provider and performance runs (later tasks fill the directories).
    {
      name: 'live-chromium',
      testDir: './live',
      grep: /@live/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'perf-chromium',
      testDir: './perf',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      name: 'api',
      command: `sh -c 'rm -rf "${dataDir}" && mkdir -p "${dataDir}/tmp" && exec npx tsx --conditions=source apps/server/test/e2e-server.ts'`,
      cwd: repoRoot,
      env: {
        NODE_ENV: 'development',
        // Hermetic: a developer's own .env (a real database, an API key) must never leak into a test run.
        ENV_FILE: '',
        HOST: '127.0.0.1',
        PORT: String(SERVER_PORT),
        LOG_LEVEL: 'warn',
        // The deterministic server (ScriptedLlm + FakeEmbeddings) sends nothing to Gemini; the notice is off.
        GEMINI_FREE_TIER: 'false',
        // Every request comes from 127.0.0.1, so the per-IP limits must not trip.
        RATE_LIMIT_PER_MINUTE: '100000',
        UPLOADS_PER_HOUR: '100000',
        UPLOADS_PER_HOUR_PER_IP: '100000',
        QUESTIONS_PER_MINUTE: '100000',
        PGLITE_DATA_DIR: path.join(dataDir, 'pglite'),
        TMP_DIR: path.join(dataDir, 'tmp'),
        STORAGE_DIR: path.join(dataDir, 'uploads'),
      },
      url: `http://127.0.0.1:${String(SERVER_PORT)}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      name: 'web',
      command: `npm run dev -w @enchanted/web -- --host 127.0.0.1 --port ${String(WEB_PORT)} --strictPort`,
      cwd: repoRoot,
      // The Vite dev server proxies /api to the API server started above, wherever that listens.
      env: { VITE_API_PROXY: `http://127.0.0.1:${String(SERVER_PORT)}` },
      url: `http://127.0.0.1:${String(WEB_PORT)}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
