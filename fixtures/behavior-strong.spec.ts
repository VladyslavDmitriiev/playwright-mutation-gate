import { test, expect } from '@playwright/test';

// Strong behavior spec: the asserted plan is rendered into the response body,
// so corrupting it in transit turns the assertion red (verdict: killed under
// --behavior). As a normal Playwright run it stays green.
test('shows the Premium plan', async ({ page }) => {
  await page.goto('/profile');
  // @primary-assert
  await expect(page.locator('#plan')).toContainText('Premium');
});
