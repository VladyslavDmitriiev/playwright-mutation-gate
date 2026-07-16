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

<details><summary>Text version (if the SVG above does not render)</summary>

```
fixtures/demo.spec.ts
  killed         shows error for invalid email  :8
  killed         hides error for valid email    :16
  killed         shows success for valid email  :24
  survived       hides success initially        :31

3 killed, 1 survived, 0 cannot-mutate, 0 errors
Gate FAILED: hollow, unverified or broken assertions above.
```
</details>

## Quick start

Requires **Node >= 20** and a working **Playwright** setup (any version that
supports `playwright test`).

```bash
npm install -D playwright-mutation-gate
```

Mark the primary assertion in each test with `// @primary-assert`. Put it at
the end of the assertion line, or on its own line right above it. The assertion
itself must be a single-line `expect(...)` call.

```ts
test('checkout shows confirmation', async ({ page }) => {
  // ...
  await expect(page.getByText('Order confirmed')).toBeVisible(); // @primary-assert
});

// Also valid: the marker on its own line above the assertion.
test('cart badge updates', async ({ page }) => {
  // @primary-assert
  await expect(page.getByTestId('cart-count')).toHaveText('1');
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

## Custom test fixtures

If your tests are declared through a custom fixture instead of the bare `test`,
the gate finds it automatically in two cases: a local `.extend` chain and a
renamed import.

```ts
import { test as base } from '@playwright/test';
const authedTest = base.extend({ /* ... */ });   // auto-detected

authedTest('sees dashboard', async ({ page }) => {
  await expect(page.getByText('Welcome')).toBeVisible(); // @primary-assert
});
```

When the fixture is imported by its own name from another module, name it with
`--test-id` (repeatable):

```bash
npx playwright-mutation-gate tests/dashboard.spec.ts --test-id authedTest
```

A runtime `authedTest.skip(condition)` inside a test is respected: if the test
skips, the mutation reports `cannot-mutate` rather than a false `survived`.

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

Cost scales linearly: every marked assertion is one extra `playwright test`
run. That is fine for a handful of specs, but on a large suite you probably
do not want the full sweep on every push. Two patterns that work well:

- **Gate only what changed.** The CLI takes plain file paths, so feed it the
  spec files the PR touched:

  ```yaml
      - run: |
          SPECS=$(git diff --name-only origin/${{ github.base_ref }}... -- 'tests/**/*.spec.ts')
          [ -n "$SPECS" ] && npx playwright-mutation-gate $SPECS || echo "no specs changed"
  ```

- **Full sweep on a schedule.** Run the whole glob nightly instead of per
  commit. A hollow assertion does not get less hollow between merges;
  catching it a day later is fine. `--playwright-args` is available if you
  need to shard or point at a specific config.

## CLI reference

```
npx playwright-mutation-gate [options] <specs...>

Options:
  --json                    machine-readable JSON report
  --no-require-sentinel     do not fail on tests without a marker
  --playwright-args <args>  extra arguments for playwright test
  --test-id <name>          treat <name> as a test builder (repeatable)
  -V, --version             output the version number
  -h, --help                display help for command
```

## Programmatic API

Since v0.2 the package also exposes a library entry, so a tool can run the gate
in-process and inspect the structured report instead of shelling out to the CLI
and parsing `--json`.

```ts
import { runSpec, summarize } from 'playwright-mutation-gate';

const spec = await runSpec('tests/checkout.spec.ts', {
  testIds: ['authedTest'],            // extra test builders, same as --test-id
  playwrightArgs: ['--project=chromium', '--retries=0'],
});
const summary = summarize([spec], { requireSentinel: true });

if (!summary.gatePassed) {
  const hollow = spec.results.filter((r) => r.verdict === 'survived');
  console.error(`${hollow.length} assertion(s) do not gate the result`);
  process.exit(1);
}
```

`runSpec(specPath, opts?)` returns a `SpecResult` (per-assertion `verdict`:
`killed` / `survived` / `cannot-mutate` / `error`, plus unmarked/stray/malformed
markers). `summarize(specs, opts)` folds one or more results into a `Summary`
with the `gatePassed` verdict. `jsonReport` and `renderTable` produce the CLI's
two output formats. Advanced: `planSpecMutations` and `invertAssertLine` expose
the mutation planner and the single-line inverter directly. Full types ship with
the package.

## Limitations

**The gate proves an assertion can fail, not that it checks the right thing.**
A weak but falsifiable assertion passes: a test that asserts a site-wide header
(one that also renders on the error page) is killed by inversion and clears the
gate, even though it would not catch the feature breaking. What the gate
guarantees is narrower and mechanical: every marked assertion actually runs and
is load-bearing, so the test cannot stay green regardless of what the app does.
Judging whether the assertion is the *right* one still takes review, or
application-code mutation testing (Stryker-style), which is a different tool.

**A kill is slightly generous by construction.** `killed` means the mutated
run failed, not that the flipped assertion is what failed. Playwright actions
carry implicit assertions (`click()` fails on its own if the element never
appears), and an ordinarily flaky step also counts, so a test can die before
it ever reaches the inverted line. The asymmetry works in your favor:
`survived` has no such excuse. A test that stays green with its own primary
assertion inverted is hollow, full stop.

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

Skipped tests get the same honesty. A test disabled with `test.skip` never
executes, so there is nothing to observe when its assertion is inverted.
Rather than guess, the gate reports `cannot-mutate` with the reason ("the
test was skipped at runtime (conditional test.skip), so the inverted
assertion never ran"). In
practice this is a feature: a `test.skip(true, ...)` from months ago looks
identical to a healthy passing spec in normal CI output, and the gate is
often what surfaces it.

## Why

AI code generators write tests fast. The tests look right: good names, proper
selectors, green checkmarks. But the assertions are often hollow: a forgotten
`await` whose result nobody checks, an assertion guarded behind a branch that
never executes, a `not.toBeVisible` against a selector that never existed, a
test silently disabled with `skip`.

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
