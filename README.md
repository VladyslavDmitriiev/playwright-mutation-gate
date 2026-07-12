# playwright-mutation-gate

> A passing test only means something if it can fail.

**Status: v0.0.1 is a name reservation.** The actual CLI is in development and ships as v0.1.0.

## What it will do

`playwright-mutation-gate` checks that your green Playwright tests are green for a reason.
You mark the primary assertion in each test:

```ts
test('checkout shows order confirmation', async ({ page }) => {
  // ...
  // @primary-assert
  await expect(page.getByText('Order confirmed')).toBeVisible();
});
```

The gate then inverts that assertion (`expect(x).toBeVisible()` → `expect(x).not.toBeVisible()`)
in a temporary copy of the spec and re-runs the test:

- test fails → the assertion is alive (**killed** mutation, good)
- test still passes → the assertion checks nothing (**survived**, a hollow test), so the
  gate exits 1 and fails your CI run

Tests without a `@primary-assert` marker also fail the gate by default, so nothing slips
through unmarked.

## Why

Stryker and friends mutate your application code to score unit tests. E2E suites have the
opposite blind spot: the assertion itself is often hollow. It passes against a broken app.
This tool mutates the assertions, not the app.

v0.1.0 coming soon.

## License

MIT
