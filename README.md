# playwright-mutation-gate

> A passing test only means something if it can fail.

`playwright-mutation-gate` inverts the assertion you marked as primary and
re-runs the test. If it stays green, the assertion is hollow and the gate
fails your CI run instead of reporting a lie.

<p align="center">
  <img src="media/demo.svg" alt="Terminal recording: 3 killed, 1 survived, gate fails" width="840">
</p>

```
fixtures/honest.spec.ts
  killed         shows an error for an invalid email  :10

fixtures/hollow.spec.ts
  survived       shows an error for an invalid email  :11

1 killed, 1 survived, 0 cannot-mutate, 0 errors
Gate FAILED: hollow, unverified or broken assertions above.
```

## Quick start

```bash
npm install -D playwright-mutation-gate
```

Mark the primary assertion in each test with `// @primary-assert`:

```ts
test('checkout shows confirmation', async ({ page }) => {
  // ...
  // @primary-assert
  await expect(page.getByText('Order confirmed')).toBeVisible();
});
```

Run the gate:

```bash
npx playwright-mutation-gate "tests/**/*.spec.ts"
```

## How marking works

Add `// @primary-assert` on the line immediately above the assertion you
consider the single most important check in the test. The gate inverts that
assertion (`expect(x).toBeVisible()` becomes `expect(x).not.toBeVisible()`)
in a temporary copy of the spec and re-runs the test in isolation.

- **killed** -- the test failed under inversion. The assertion is alive.
- **survived** -- the test still passed. The assertion checks nothing useful.
- **cannot-mutate** -- the assertion shape could not be inverted safely. The
  gate reports it instead of guessing.

One marker per `test()` block. Tests without a marker fail the gate by
default (sentinel mode), so nothing slips through unmarked. Disable with
`--no-require-sentinel` while you're marking an existing suite.

## CI recipe

```yaml
# .github/workflows/mutation-gate.yml
name: mutation-gate

on: [push, pull_request]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright-mutation-gate "tests/**/*.spec.ts"
```

The gate exits 0 only when every marked assertion is killed and sentinel
mode is satisfied. Any other outcome exits 1.

## CLI reference

```
npx playwright-mutation-gate [options] <specs...>

Options:
  --json                    machine-readable JSON report
  --no-require-sentinel     do not fail on tests without a marker
  --playwright-args <args>  extra arguments for playwright test
  -V, --version             output the version number
  -h, --help                display help for command
```

## Limitations

String-based inversion, not AST. This keeps the tool small and dependency-free
but means some assertion shapes report `cannot-mutate` instead of inverting:

- **Single line only.** `expect(...)` and its matcher must start on the marked
  line. Matcher arguments may continue on following lines, but the expect call
  itself may not. Multi-line chains report cannot-mutate.
- **One assertion per line.** A second `expect` call in code on the marked line
  reports cannot-mutate rather than guessing which one to invert. This includes
  asymmetric matchers (`expect.objectContaining`) in arguments and nested
  expects inside `toPass`.
- **No aliases.** Assertions wrapped in helper functions or using a
  re-exported/aliased `expect` are not recognized.
- **Custom matchers** must follow the `toXxx` naming convention. Built-in
  method names (`toString`, `toFixed`, `toSorted`, ...) are denylisted to avoid
  false matches.
- **Supported chain shape:**
  `[await] expect[.soft|.poll](...)[.resolves|.rejects][.not].toXxx(`
  Anything outside this shape (e.g. `expect.extend`) reports cannot-mutate.

`cannot-mutate` is always safe: the gate tells you it could not verify the
assertion, never silently skips it.

## Why

AI code generators write tests fast. The tests look right: good names, proper
selectors, green checkmarks. But the assertions are often hollow. They check
conditions that are always true, guard assertions behind branches that never
execute, or assert against selectors that do not exist on the page.

Stryker and friends mutate your *application code* to score unit tests. E2E
suites have the opposite blind spot: the *assertion itself* is often the weak
link. It passes against a broken app. `playwright-mutation-gate` mutates the
assertions, not the app.

If a green test cannot turn red when its assertion is inverted, it was never
testing anything. The gate catches that before it reaches production.

## License

MIT
