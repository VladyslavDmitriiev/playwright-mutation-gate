import { test, expect } from '@playwright/test';

// Hollow spec: the classic guarded assertion. The form is never submitted,
// so the guard is always false and the assertion never runs. The test stays
// green no matter what the page does, inverted or not (verdict: survived).
test('shows an error for an invalid email', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', 'not-an-email');
  if (await page.locator('#error').isVisible()) {
    // @primary-assert
    await expect(page.locator('#error')).toBeVisible();
  }
});
