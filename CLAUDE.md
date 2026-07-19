# playwright-mutation-gate

Standalone CLI that proves a green Playwright test can actually fail: it inverts
the assertion marked `// @primary-assert`, re-runs the test, and fails the run
if the test stays green (a hollow assertion). Spec and sprint plan live in the
parent workspace (`../../oss/mutation-gate-spec.md`, `mutation-gate-sprints.md`).

## Structure

- `src/` - package source (TypeScript, ESM, builds to `dist/` via tsc)
- `tests/` - vitest unit tests
- `fixtures/` - reality baseline for the gate itself:
  - `site/` + `serve.mjs` - tiny static form served as Playwright webServer.
    `serve.mjs` also serves `/profile` (value in body) and `/profile-stale`
    (value in a header the UI ignores) for the behavior fixtures.
  - `honest.spec.ts` - live assertion; inverting it must fail (killed)
  - `hollow.spec.ts` - guarded assertion that never runs; inverting it stays
    green (survived). Do not "fix" this spec - being hollow is its job.
  - `behavior-strong.spec.ts` - asserts a body-rendered value; corrupting it via
    `--behavior` kills the test.
  - `behavior-weak.spec.ts` - asserts a value the UI reconstructs client-side, so
    `--behavior` corruption leaves it green (weak). Do not "fix" it - being weak
    is its job; it is what inversion cannot catch.
  - `acknowledged-skip.spec.ts` - a `test.skip` with a `// @gate-skip owner=..
    expires=.. reason=..` marker; the gate accepts it (acknowledged) until the
    far-future expiry instead of failing. Do not "fix" it.

## Commands

- `npm test` - full gate: lint + typecheck + build + unit + e2e (Playwright fixtures)
- `npm run test:unit` / `npm run test:e2e` - the fast/slow halves separately
- `npm run build` - compile `src/` to `dist/`

## Rules

- Run `npm test` and see exit 0 before declaring any task done. The actual
  exit code is the verdict, not the summary text.
- Runtime dependencies: `commander` only. Any new runtime dep needs explicit
  owner approval first.
- Node >= 20 (matches `engines` and the CI matrix).
- Commit after every green checkpoint.
- Public-facing text (README, help output) is English; never use em-dashes.
