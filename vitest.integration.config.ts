import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.int.test.ts'],
    // Each test spawns a full Playwright run including the fixture webServer.
    testTimeout: 240_000,
    // Test files share the fixtures dir and the webServer port; running them
    // in parallel races the leftover-copy checks against live mutation runs.
    fileParallelism: false,
  },
});
