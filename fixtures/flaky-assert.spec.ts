import { test, expect } from '@playwright/test';

// Flaky spec: fails on its first attempt and passes on the retry, which is
// what a real flaky test looks like to Playwright. It is deterministic on
// purpose, so the gate's own acceptance test is not flaky. Under 0.3.x a
// flaky mutated run counted as killed. The gate must now say flaky.
// Do not "fix" it - being flaky is its job. Excluded from `npm run test:e2e`
// unless PMG_GATE_FIXTURES=1 (see playwright.config.ts).
test('shows an error for an invalid email (flaky)', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.fill('#email', testInfo.retry === 0 ? 'valid@example.com' : 'not-an-email');
  await page.click('#submit');
  // @primary-assert
  await expect(page.locator('#error')).toBeVisible({ timeout: 2_000 });
});
