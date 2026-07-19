import { test, expect } from '@playwright/test';

// Acknowledged skip: the test is disabled, which normally reports cannot-mutate
// and fails the gate. The acknowledgement marker below records an owner, a
// deadline and a reason, so the gate accepts it as a time-boxed loan until the
// expiry (a far future date here so the fixture stays acknowledged). Do not
// "fix" this spec; the acknowledged skip is what it demonstrates.
// @gate-skip owner=vlad expires=2099-01-01 reason="checkout redesign in flight"
test.skip('shows an error for an invalid email', async ({ page }) => {
  await page.goto('/');
  // @primary-assert
  await expect(page.locator('#error')).toBeVisible();
});
