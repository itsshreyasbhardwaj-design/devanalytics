import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Absolute, because the web server runs with apps/web as its working
 * directory; a relative path would create a second, empty database there.
 */
const dataDir = path.resolve(process.env.E2E_DATA_DIR ?? '.e2e-pgdata');

/** Written by scripts/seed-e2e.ts, which runs before Playwright. */
function seededToken(): string {
  try {
    return readFileSync('tests/e2e/.state/token', 'utf8').trim();
  } catch {
    throw new Error('No end-to-end token found. Run `pnpm test:e2e`, which seeds before starting Playwright.');
  }
}

/**
 * End-to-end tests.
 *
 * Runs against a real instance seeded by `scripts/seed-e2e.ts` into a
 * throwaway embedded database, so the suite never touches a developer's local
 * data and never needs a database server.
 *
 * Seeding happens *before* Playwright, not in globalSetup: Playwright starts
 * its webServer first, and a globalSetup that recreated the database would
 * pull it out from under the server that had already opened it.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3218',
    // The suite authenticates with a real API token, so it exercises the same
    // authentication path a deployment uses rather than a development bypass.
    extraHTTPHeaders: { authorization: `Bearer ${process.env.E2E_TOKEN ?? seededToken()}` },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // A production build, not the dev server. The dev server recompiles
        // routes on demand, and each recompilation can construct a second
        // runtime against the same embedded database. It also means the suite
        // exercises what actually ships.
        command: 'pnpm --filter @devanalytics/web exec next build && pnpm --filter @devanalytics/web exec next start -p 3218',
        url: 'http://127.0.0.1:3218/api/v1/health',
        timeout: 480_000,
        reuseExistingServer: false,
        env: {
          // Explicit, because apps/web/.env.local carries a developer's
          // local-dev settings and this server must not inherit them.
          DEVANALYTICS_AUTH_MODE: 'clerk',
          DEVANALYTICS_LOCAL_ORG_ID: '',
          DEVANALYTICS_EMBEDDED_DATA_DIR: dataDir,
          DEVANALYTICS_BASE_URL: 'http://127.0.0.1:3218',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
