import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.int.test.ts'],
    // Each test spawns a full Playwright run including the fixture webServer.
    testTimeout: 240_000,
  },
});
