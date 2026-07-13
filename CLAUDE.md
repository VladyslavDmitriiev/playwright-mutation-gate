# playwright-mutation-gate

Standalone CLI that proves a green Playwright test can actually fail: it inverts
the assertion marked `// @primary-assert`, re-runs the test, and fails the run
if the test stays green (a hollow assertion). Spec and sprint plan live in the
parent workspace (`../../oss/mutation-gate-spec.md`, `mutation-gate-sprints.md`).

## Structure

- `src/` - package source (TypeScript, ESM, builds to `dist/` via tsc)
- `tests/` - vitest unit tests
- `fixtures/` - reality baseline for the gate itself:
  - `site/` + `serve.mjs` - tiny static form served as Playwright webServer
  - `honest.spec.ts` - live assertion; inverting it must fail (killed)
  - `hollow.spec.ts` - guarded assertion that never runs; inverting it stays
    green (survived). Do not "fix" this spec - being hollow is its job.

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
