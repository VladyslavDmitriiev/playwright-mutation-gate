import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'fixtures',
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
