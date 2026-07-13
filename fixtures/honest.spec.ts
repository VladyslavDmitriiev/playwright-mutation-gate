import { test, expect } from '@playwright/test';

// Honest spec: the assertion observes the real outcome of the flow.
// Inverting it must fail the test (verdict: killed).
test('shows an error for an invalid email', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', 'not-an-email');
  await page.click('#submit');
  // @primary-assert
  await expect(page.locator('#error')).toBeVisible();
});
