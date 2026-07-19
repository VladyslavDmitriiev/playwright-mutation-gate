import { test, expect } from '@playwright/test';

// Weak behavior spec: the plan the test names lives in a response header the UI
// ignores; the visible text is reconstructed client-side. Corrupting the
// response leaves the assertion green even though the backend value is broken,
// so the assertion is hollow at the layer that matters (verdict: weak under
// --behavior). Inversion cannot see this - the assertion can still fail, it
// just does not fail for the right reason. Do not "fix" this spec; being weak
// is its job.
test('the Premium plan is reported', async ({ page }) => {
  await page.goto('/profile-stale');
  // @primary-assert
  await expect(page.locator('#plan')).toContainText('Premium');
});
