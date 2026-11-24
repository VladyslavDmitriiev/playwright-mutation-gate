# Changelog

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
