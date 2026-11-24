# Changelog

## 0.5.1

### Fixed

- False `killed-elsewhere` when the marked assertion sits inside a wrapper
  such as `expect(async () => { ... }).toPass()` or `test.step`: Playwright
  reports the wrapper's line, not the assertion's. A failure in the mutated
  file whose error comes from the inverted matcher (for example
  `expect(received).not.toEqual(expected)`) now counts as `killed`. The
  no-location fallback also checks the negation, not only the matcher name.

## 0.5.0

Adoption on existing suites and machine-readable output. No verdict or exit
code changes.

### Added

- Ratchet file for gradual adoption: `--ratchet [path]` (default
  `pmg-ratchet.json`) allows the listed unmarked tests, any other unmarked test
  still fails the gate. `--update-ratchet` creates the file, or shrinks it by
  dropping entries that are marked or gone; it never adds entries. Summary
  counter `ratchetedTests`.
- `--annotations`: one GitHub Actions `::error file=..,line=..` line per gate
  failure, printed after the table (not with `--json`).
- `--json` gains a flat `mutations` array: `{ mode, verdict, spec, testTitle,
  testLine, assertLine, reason }` per mutation, inversion and behavior.
- Library exports: `mutationRecords`, `gateFailures`, `githubAnnotations`, and
  the ratchet functions.

### Fixed

- README: own retries go through `--playwright-args "--retries=N"`, not `--`.

## 0.4.0

The gate stops reporting optimistic kills. Verdicts are only added; existing
verdicts and exit codes keep their meaning. See "Migrating to 0.4.0" in the
README.

### Added

- Baseline run: every marked test runs once unmodified before it is mutated
  (one Playwright run per spec, `--retries=1` unless you pass your own
  `--retries`). A test that is red on its own reports `baseline-failed`; one
  that passes only on retry reports `flaky`. Neither is mutated.
- `killed-elsewhere`: the mutated test went red, but the first failure in the
  report is not inside the inverted statement (or, without a location, not
  raised by the inverted matcher). The reason names where it failed.
- `Summary` counters `baselineFailed`, `flaky`, `killedElsewhere`; all three
  fail the gate. Same fields in `--json`.
- Fixtures `broken-setup.spec.ts` and `flaky-assert.spec.ts` (red by design,
  loaded only with `PMG_GATE_FIXTURES=1`) as the acceptance check.

### Changed

- A mutated run that failed and then passed on retry is `flaky`, no longer
  `killed`. In `--behavior` mode it is an `error` with a `flaky:` reason.
- In `--behavior` mode a test whose baseline is red or flaky is not mutated and
  reports `error` naming the baseline outcome.
