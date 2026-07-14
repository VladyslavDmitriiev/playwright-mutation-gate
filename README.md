# playwright-mutation-gate

[![npm version](https://img.shields.io/npm/v/playwright-mutation-gate)](https://www.npmjs.com/package/playwright-mutation-gate)
[![CI](https://github.com/VladyslavDmitriiev/playwright-mutation-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/VladyslavDmitriiev/playwright-mutation-gate/actions)
[![license](https://img.shields.io/npm/l/playwright-mutation-gate)](./LICENSE)

> A passing test only means something if it can fail.

`playwright-mutation-gate` inverts the assertion you marked as primary and
re-runs the test. If it stays green, the assertion is hollow and the gate
fails your CI run instead of reporting a lie.

<p align="center">
  <img src="media/demo.svg" alt="Terminal recording: 3 killed, 1 survived, gate fails" width="840">
</p>

## Quick start

Requires **Node >= 20** and a working **Playwright** setup (any version that
supports `playwright test`).

```bash
npm install -D playwright-mutation-gate
```

Mark the primary assertion in each test with `// @primary-assert`.
The marker goes on its own line, right above the assertion. The assertion
itself must be a single-line `expect(...)` call.

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

The gate inverts the marked assertion
(`expect(x).toBeVisible()` becomes `expect(x).not.toBeVisible()`) in a
temporary copy of the spec and re-runs the test in isolation.

- **killed** -- the test failed under inversion. The assertion is alive.
- **survived** -- the test still passed. The assertion checks nothing useful.
- **cannot-mutate** -- the assertion shape could not be inverted safely. The
  gate reports it instead of guessing.

One marker per `test()` block. Markers inside `test.describe` or `test.use`
callbacks work the same way -- the gate scans each `test()` individually,
nesting does not matter.

By default, tests without a marker fail the gate (sentinel mode). This means
a newly added test without `// @primary-assert` shows up as:

```
  unmarked       adds item to cart  :42
```

Pass `--no-require-sentinel` to opt out while you're marking an existing suite.

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

The package is CLI-only for now. Programmatic API is planned for v0.2.

## Limitations

String-based inversion, not AST. This keeps the tool small and dependency-free
but means some shapes report `cannot-mutate`:

- **Single line only.** `expect(...)` and its matcher must start on the marked
  line. Multi-line chains report cannot-mutate.
- **One assertion per line.** Two `expect` calls on the same line (including
  asymmetric matchers in arguments, nested expects inside `toPass`) report
  cannot-mutate.
- **No aliases.** Assertions using a re-exported or aliased `expect` are not
  recognized.
- **Custom matchers** must follow the `toXxx` convention. Names that shadow
  built-ins (`toString`, `toFixed`, ...) are denylisted.
- **Supported chain:**
  `[await] expect[.soft|.poll](...)[.resolves|.rejects][.not].toXxx(`

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

## Contributing

Issues and PRs are welcome. Run `npm test` before submitting -- it covers
lint, typecheck, unit, e2e and integration tests in one pass.

## License

MIT
