import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests spawn real Playwright runs; they live behind
    // `npm run test:integration` so the unit cycle stays fast.
    exclude: [...configDefaults.exclude, 'tests/**/*.int.test.ts'],
  },
});
