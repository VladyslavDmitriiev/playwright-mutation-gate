#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { Command, CommanderError, InvalidArgumentError } from 'commander';

import {
  applyRatchet,
  DEFAULT_RATCHET_FILE,
  loadRatchet,
  RatchetError,
  staleRatchetEntries,
  updateRatchet,
  writeRatchet,
} from './ratchet.js';
import { githubAnnotations, jsonReport, renderTable, summarize } from './report.js';
import { createLimiter, runSpec, type SpecResult } from './run.js';
import { renderFixReport, verifyFix, VerifyFixError } from './verify-fix.js';

// Exit codes: 0 = gate passed, 1 = gate failed (survived / unverified /
// marker mistakes), 2 = usage or environment error (bad flags, missing file).

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

interface CliOptions {
  json: boolean;
  requireSentinel: boolean;
  behavior: boolean;
  playwrightArgs?: string;
  testId: string[];
  ratchet?: string | true;
  updateRatchet: boolean;
  annotations: boolean;
  concurrency: number;
}

const program = new Command()
  .name('playwright-mutation-gate')
  .description(
    'Invert each @primary-assert assertion and re-run the test.\n' +
      'A test that stays green under inversion is hollow and fails the gate.',
  )
  .version(pkg.version)
  // Options after `verify-fix` belong to it (--json and --playwright-args exist on both).
  .enablePositionalOptions()
  .argument('<specs...>', 'Playwright spec files to gate')
  .option('--json', 'print a machine-readable JSON report instead of the table', false)
  .option('--no-require-sentinel', 'do not fail the gate when a test() has no @primary-assert marker')
  .option(
    '--behavior',
    'also run behavior mutation: corrupt each @primary-assert value in the response\n' +
      'via page.route and expect red. A test that stays green is weak and fails the\n' +
      'gate. Opt-in: this roughly doubles the run cost.',
    false,
  )
  .option(
    '--playwright-args <args>',
    'extra arguments passed to `npx playwright test`, split on spaces\n' +
      '(values containing spaces are not supported)',
  )
  .option(
    '--test-id <name>',
    'treat <name> as a test builder in addition to `test` (repeatable);\n' +
      'for custom fixtures imported by name (import { authedTest } from ...).\n' +
      'Local `const x = test.extend(...)` and `test as x` renames are auto-detected',
    (value: string, acc: string[]) => acc.concat(value),
    [],
  )
  .option(
    '--ratchet [path]',
    `allow the unmarked tests listed in a ratchet file (default ${DEFAULT_RATCHET_FILE});\n` +
      'any other unmarked test still fails the gate. For adopting the gate on an existing suite',
  )
  .option(
    '--update-ratchet',
    'rewrite the ratchet file after the run: drop entries that are marked or gone, never add;\n' +
      'creates the file from the current unmarked tests if it does not exist. Run it on purpose,\n' +
      'not automatically in CI',
    false,
  )
  .option(
    '--concurrency <n>',
    'run up to <n> Playwright processes at once (baseline and mutation runs,\n' +
      'across all specs). Your webServer must tolerate parallel runs: start it\n' +
      'yourself or set reuseExistingServer. Default 1',
    (value: string) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
      return n;
    },
    1,
  )
  .option(
    '--annotations',
    'also print GitHub Actions ::error annotations, one per gate failure (not with --json)',
    false,
  )
  .showHelpAfterError()
  .addHelpText(
    'after',
    '\nMarking:\n' +
      '  Put `// @primary-assert` at the end of the primary assertion line,\n' +
      '  or on its own line right above it. One marker per test().\n' +
      '    await expect(page.getByText(\'Saved\')).toBeVisible(); // @primary-assert\n' +
      '\nModes:\n' +
      '  Default: assertion inversion (proves the test can fail at all).\n' +
      '  --behavior: also corrupt the asserted value in the response and expect\n' +
      '  red (proves the test fails when the thing it names breaks). The modes\n' +
      '  compose; weak assertions fail the gate, cannot-locate is informational.',
  )
  .action(async (specPaths: string[], opts: CliOptions) => {
    const missing = specPaths.filter((p) => !existsSync(p));
    if (missing.length > 0) {
      console.error(`spec file not found: ${missing.join(', ')}`);
      process.exit(2);
    }

    if (opts.annotations && opts.json) {
      console.error('--annotations cannot be combined with --json (both write to stdout)');
      process.exit(2);
    }
    const ratchetPath =
      typeof opts.ratchet === 'string' ? opts.ratchet : opts.ratchet || opts.updateRatchet ? DEFAULT_RATCHET_FILE : null;
    if (ratchetPath !== null && !opts.updateRatchet && !existsSync(ratchetPath)) {
      console.error(`ratchet file not found: ${ratchetPath} (create it with --update-ratchet)`);
      process.exit(2);
    }

    const playwrightArgs = (opts.playwrightArgs ?? '').split(/\s+/).filter(Boolean);
    const limiter = createLimiter(opts.concurrency);
    let results: SpecResult[];
    try {
      results = await Promise.all(
        specPaths.map(async (spec) => {
          process.stderr.write(`gating ${spec}\n`);
          try {
            return await runSpec(spec, { playwrightArgs, testIds: opts.testId, behavior: opts.behavior, limiter });
          } catch (err) {
            throw new Error(`failed to gate ${spec}: ${err instanceof Error ? err.message : String(err)}`, {
              cause: err,
            });
          }
        }),
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }

    if (ratchetPath !== null) {
      try {
        if (opts.updateRatchet) {
          const upd = updateRatchet(results, ratchetPath);
          writeRatchet(ratchetPath, upd.ratchet);
          process.stderr.write(
            upd.created
              ? `created ${ratchetPath} with ${upd.ratchet.unmarked.length} allowed unmarked tests\n`
              : `updated ${ratchetPath}: removed ${upd.removed.length}, ${upd.ratchet.unmarked.length} left\n`,
          );
        }
        const ratchet = loadRatchet(ratchetPath);
        const stale = opts.updateRatchet ? [] : staleRatchetEntries(results, ratchet, ratchetPath);
        if (stale.length > 0) {
          process.stderr.write(
            `${stale.length} ratchet entries are marked or gone now; shrink the file with --update-ratchet\n`,
          );
        }
        results = applyRatchet(results, ratchet, ratchetPath);
      } catch (err) {
        if (!(err instanceof RatchetError)) throw err;
        console.error(err.message);
        process.exit(2);
      }
    }

    const gate = { requireSentinel: opts.requireSentinel };
    if (opts.json) {
      console.log(jsonReport(results, gate));
    } else {
      const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
      console.log(renderTable(results, { color, ...gate }));
      if (opts.annotations) {
        for (const line of githubAnnotations(results, gate)) console.log(line);
      }
    }
    process.exit(summarize(results, gate).gatePassed ? 0 : 1);
  });

interface VerifyFixCliOptions {
  base: string;
  json: boolean;
  testPattern?: string;
  build: string[];
  noBuild?: boolean;
  playwrightArgs?: string;
}

program
  .command('verify-fix')
  .description(
    'Check that the tests a change adds fail without its fix: in a temporary git\n' +
      'worktree, roll back every non-test file changed since --base, then run the new\n' +
      'tests there. Green on the rollback = survived (the test does not prove the fix).\n' +
      "Needs Playwright's webServer to serve the code from the checkout.",
  )
  .argument('[specs...]', 'spec files whose new tests to check (default: changed spec files)')
  .requiredOption('--base <ref>', 'the ref the change targets (e.g. origin/main)')
  .option('--json', 'print a machine-readable JSON report', false)
  .option('--test-pattern <regex>', 'repo-relative paths matching this are test files and are kept')
  .option(
    '--build <cmd>',
    'command to run in the rolled-back tree before the tests (repeatable);\n' +
      'default: npm run build / typecheck when those scripts exist',
    (value: string, acc: string[]) => acc.concat(value),
    [],
  )
  .option('--no-build', 'skip the build step')
  .option('--playwright-args <args>', 'extra arguments passed to `npx playwright test`, split on spaces')
  .exitOverride()
  .action(async (specs: string[], o: VerifyFixCliOptions & { build: string[] | false }) => {
    try {
      const report = await verifyFix({
        base: o.base,
        ...(specs.length > 0 ? { specs } : {}),
        ...(o.testPattern !== undefined ? { testPattern: new RegExp(o.testPattern) } : {}),
        ...(o.build === false ? { build: [] } : o.build.length > 0 ? { build: o.build } : {}),
        playwrightArgs: (o.playwrightArgs ?? '').split(/\s+/).filter(Boolean),
      });
      console.log(o.json ? JSON.stringify(report, null, 2) : renderFixReport(report));
      process.exit(report.passed ? 0 : 1);
    } catch (err) {
      if (err instanceof VerifyFixError || err instanceof SyntaxError) {
        console.error(err.message);
        process.exit(2);
      }
      throw err;
    }
  });

program.exitOverride();
try {
  await program.parseAsync();
} catch (err) {
  // commander has already printed its message; map usage errors to exit 2,
  // keep 0 for --help / --version.
  const code = err instanceof CommanderError && err.exitCode === 0 ? 0 : 2;
  process.exit(code);
}
