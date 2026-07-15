#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';

import { jsonReport, renderTable, summarize } from './report.js';
import { runSpec, type SpecResult } from './run.js';

// Exit codes: 0 = gate passed, 1 = gate failed (survived / unverified /
// marker mistakes), 2 = usage or environment error (bad flags, missing file).

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

interface CliOptions {
  json: boolean;
  requireSentinel: boolean;
  playwrightArgs?: string;
}

const program = new Command()
  .name('playwright-mutation-gate')
  .description(
    'Invert each @primary-assert assertion and re-run the test.\n' +
      'A test that stays green under inversion is hollow and fails the gate.',
  )
  .version(pkg.version)
  .argument('<specs...>', 'Playwright spec files to gate')
  .option('--json', 'print a machine-readable JSON report instead of the table', false)
  .option('--no-require-sentinel', 'do not fail the gate when a test() has no @primary-assert marker')
  .option(
    '--playwright-args <args>',
    'extra arguments passed to `npx playwright test`, split on spaces\n' +
      '(values containing spaces are not supported)',
  )
  .showHelpAfterError()
  .addHelpText(
    'after',
    '\nMarking:\n' +
      '  Put `// @primary-assert` at the end of the primary assertion line,\n' +
      '  or on its own line right above it. One marker per test().\n' +
      '    await expect(page.getByText(\'Saved\')).toBeVisible(); // @primary-assert',
  )
  .action(async (specPaths: string[], opts: CliOptions) => {
    const missing = specPaths.filter((p) => !existsSync(p));
    if (missing.length > 0) {
      console.error(`spec file not found: ${missing.join(', ')}`);
      process.exit(2);
    }

    const playwrightArgs = (opts.playwrightArgs ?? '').split(/\s+/).filter(Boolean);
    const results: SpecResult[] = [];
    for (const spec of specPaths) {
      process.stderr.write(`gating ${spec}\n`);
      try {
        results.push(await runSpec(spec, { playwrightArgs }));
      } catch (err) {
        console.error(`failed to gate ${spec}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
      }
    }

    const gate = { requireSentinel: opts.requireSentinel };
    if (opts.json) {
      console.log(jsonReport(results, gate));
    } else {
      const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
      console.log(renderTable(results, { color, ...gate }));
    }
    process.exit(summarize(results, gate).gatePassed ? 0 : 1);
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
