import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'fixtures',
  // Red-by-design fixtures for the gate's own baseline checks. They would fail
  // a plain `playwright test`, so they only load when the gate tests ask.
  testIgnore: process.env.PMG_GATE_FIXTURES ? [] : [/broken-setup\./, /flaky-assert\./],
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node fixtures/serve.mjs',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
