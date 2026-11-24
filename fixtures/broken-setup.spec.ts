import { test, expect } from '@playwright/test';

// Broken-setup spec: the test is red before its assertion ever runs (the
// navigation targets a closed port). Under 0.3.x the inverted run also went
// red and was reported killed. The gate must now say baseline-failed.
// Do not "fix" it - being broken is its job. Excluded from `npm run test:e2e`
// unless PMG_GATE_FIXTURES=1 (see playwright.config.ts).
test('shows an error for an invalid email (setup is broken)', async ({ page }) => {
  await page.goto('http://127.0.0.1:1/', { timeout: 5_000 });
  await page.fill('#email', 'not-an-email');
  await page.click('#submit');
  // @primary-assert
  await expect(page.locator('#error')).toBeVisible();
});
