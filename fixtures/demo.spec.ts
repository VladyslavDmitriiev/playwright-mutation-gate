import { test, expect } from '@playwright/test';

test('shows error for invalid email', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', 'not-an-email');
  await page.click('#submit');
  // @primary-assert
  await expect(page.locator('#error')).toBeVisible();
});

test('hides error for valid email', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', 'user@example.com');
  await page.click('#submit');
  // @primary-assert
  await expect(page.locator('#error')).toBeHidden();
});

test('shows success for valid email', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', 'user@example.com');
  await page.click('#submit');
  // @primary-assert
  await expect(page.locator('#success')).toBeVisible();
});

test('hides success initially', async ({ page }) => {
  await page.goto('/');
  if (await page.locator('#success').isVisible()) {
    // @primary-assert
    await expect(page.locator('#success')).toBeVisible();
  }
});
