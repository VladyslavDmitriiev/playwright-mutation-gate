import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { planSpecMutations, type Mutation } from '../src/mutate.js';
import {
  assertSpan,
  baselineFromReport,
  createLimiter,
  runMutation,
  runSpec,
  sweepStaleMutationFiles,
  verdictFromReport,
} from '../src/run.js';

type OkMutation = Extract<Mutation, { mutatedSource: string }>;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pmg-test-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const MARKED_SPEC = [
  "import { test, expect } from '@playwright/test';",
  "test('marked', async ({ page }) => {",
  '  // @primary-assert',
  "  await expect(page.locator('#x')).toBeVisible();",
  '});',
].join('\n');

/** Write a spec into a temp dir and return its path plus its one mutation. */
function specWithMutation(): { dir: string; specPath: string; mutation: OkMutation } {
  const dir = tempDir();
  const specPath = join(dir, 'sample.spec.ts');
  writeFileSync(specPath, MARKED_SPEC);
  const mutation = planSpecMutations(MARKED_SPEC).mutations[0] as OkMutation;
  return { dir, specPath, mutation };
}

/** A fake `playwright test` binary: a node script we fully control. */
function fakePlaywright(dir: string, body: string): string[] {
  const script = join(dir, 'fake-playwright.cjs');
  writeFileSync(script, body);
  return ['node', script];
}

const report = (expected: number, unexpected: number, flaky = 0, skipped = 0): string =>
  JSON.stringify({ stats: { expected, unexpected, flaky, skipped }, errors: [] });

/**
 * A fake `playwright test` that writes a realistic JSON report. Targets are the
 * `file:line` args; a target containing `.pmg-mutation-` is a mutation run,
 * anything else the baseline run. `mutation` decides the mutated outcome:
 * killed fails on the inverted (`.not.`) line of the copy, elsewhere fails on
 * line 1, survived stays green. `baseline` decides the unmutated outcome.
 */
function fakeReport(
  mutation: 'killed' | 'killed-elsewhere' | 'survived' | 'flaky',
  baseline: 'passed' | 'failed' | 'flaky' = 'passed',
): string {
  return `
const fs = require('node:fs');
const path = require('node:path');
const targets = process.argv.slice(2).filter((a) => /:\\d+$/.test(a));
const isMutation = targets.some((t) => t.includes('.pmg-mutation-'));
const outcome = isMutation ? ${JSON.stringify(mutation)} : ${JSON.stringify(baseline)};
const specs = targets.map((t) => {
  const m = /^(.*):(\\d+)$/.exec(t);
  const file = path.resolve(m[1]);
  const line = Number(m[2]);
  let failLine = 1;
  if (outcome === 'killed') {
    const idx = fs.readFileSync(file, 'utf8').split('\\n').findIndex((l) => l.includes('.not.'));
    failLine = idx + 1;
  }
  const fail = { status: 'failed', error: { message: 'Error: boom', location: { file, line: failLine } } };
  const pass = { status: 'passed' };
  const status = { killed: 'unexpected', 'killed-elsewhere': 'unexpected', failed: 'unexpected',
    flaky: 'flaky', survived: 'expected', passed: 'expected' }[outcome];
  const results = status === 'unexpected' ? [fail] : status === 'flaky' ? [fail, pass] : [pass];
  return { line, tests: [{ status, results }] };
});
const count = (s) => specs.filter((x) => x.tests[0].status === s).length;
const report = {
  stats: { expected: count('expected'), unexpected: count('unexpected'), flaky: count('flaky'), skipped: 0 },
  errors: [],
  suites: [{ specs }],
};
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report));
process.exit(count('unexpected') > 0 ? 1 : 0);
`;
}
const WRITES_KILLED_REPORT = fakeReport('killed');
const WRITES_SURVIVED_REPORT = fakeReport('survived');
const CRASHES_WITHOUT_REPORT = `
console.error('Error: browserType.launch: something exploded');
process.exit(1);
`;
const HANGS_FOREVER = 'setTimeout(() => {}, 120000);';

const mutationFilesIn = (dir: string): string[] =>
  readdirSync(dir).filter((f) => f.includes('.pmg-mutation-'));

describe('verdictFromReport', () => {
  it('reads killed from unexpected failures', () => {
    expect(verdictFromReport(report(0, 1))).toEqual({ verdict: 'killed' });
    expect(verdictFromReport(report(2, 1))).toEqual({ verdict: 'killed' });
  });

  it('reports flaky, not killed, when the mutated run failed and then passed on retry', () => {
    const v = verdictFromReport(report(0, 0, 1));
    expect(v).toMatchObject({ verdict: 'flaky' });
    expect((v as { reason: string }).reason).toContain('passed on retry');
  });

  const target = {
    copyFile: '/x/a.pmg-mutation-0-abc.spec.ts',
    originalFile: 'a.spec.ts',
    assertLine: 10,
    assertEndLine: 12,
    matcher: 'toBeVisible',
  };
  const failedAt = (file: string | null, line: number | null, message = 'Error: boom'): string =>
    JSON.stringify({
      stats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0 },
      errors: [],
      suites: [
        {
          suites: [
            {
              specs: [
                {
                  line: 3,
                  tests: [
                    {
                      status: 'unexpected',
                      results: [
                        {
                          status: 'failed',
                          error: { message, ...(file !== null ? { location: { file, line } } : {}) },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

  it('is killed when the failure points into the inverted statement', () => {
    expect(verdictFromReport(failedAt(target.copyFile, 10), target)).toEqual({ verdict: 'killed' });
    expect(verdictFromReport(failedAt(target.copyFile, 12), target)).toEqual({ verdict: 'killed' });
  });

  it('is killed-elsewhere when the failure is on another line or file', () => {
    const v = verdictFromReport(failedAt(target.copyFile, 4, 'Error: page.goto: net::ERR_CONNECTION_REFUSED'), target);
    expect(v).toMatchObject({ verdict: 'killed-elsewhere' });
    const reason = (v as { reason: string }).reason;
    expect(reason).toContain('a.spec.ts:4');
    expect(reason).toContain('ERR_CONNECTION_REFUSED');
    expect(reason).toContain('line 10');
    expect(verdictFromReport(failedAt('/x/helpers.ts', 10), target)).toMatchObject({ verdict: 'killed-elsewhere' });
  });

  it('without a location, is killed only when the error comes from the inverted matcher', () => {
    expect(
      verdictFromReport(failedAt(null, null, 'Error: expect(locator).not.toBeVisible() failed'), target),
    ).toEqual({ verdict: 'killed' });
    expect(verdictFromReport(failedAt(null, null, 'Test timeout of 30000ms exceeded.'), target)).toMatchObject({
      verdict: 'killed-elsewhere',
    });
  });

  it('is killed when a wrapper (toPass, test.step) reports its own line for the inverted matcher', () => {
    const wrapped = { ...target, matcher: 'toEqual', negated: true, assertLine: 33, assertEndLine: 33 };
    const msg = 'Error: expect(received).not.toEqual(expected) // deep equality';
    expect(verdictFromReport(failedAt(target.copyFile, 34, msg), wrapped)).toEqual({ verdict: 'killed' });
    // Same matcher but not the inverted form: some other assertion failed.
    const other = 'Error: expect(received).toEqual(expected) // deep equality';
    expect(verdictFromReport(failedAt(target.copyFile, 40, other), wrapped)).toMatchObject({ verdict: 'killed-elsewhere' });
    // The inverted form, but in another file (a helper): not this assertion.
    expect(verdictFromReport(failedAt('/x/helper.ts', 34, msg), wrapped)).toMatchObject({ verdict: 'killed-elsewhere' });
  });

  it('strips ANSI color codes from quoted error messages', () => {
    const esc = String.fromCharCode(27);
    const v = verdictFromReport(failedAt('/x/other.ts', 1, `Error: ${esc}[2mexpect(${esc}[22mx) failed`), target);
    expect((v as { reason: string }).reason).toContain('Error: expect(x) failed');
  });

  it('reads survived from an all-green run', () => {
    expect(verdictFromReport(report(1, 0))).toEqual({ verdict: 'survived' });
  });

  it('is cannot-mutate when the matched test was skipped at runtime', () => {
    const v = verdictFromReport(report(0, 0, 0, 1));
    expect(v).toMatchObject({ verdict: 'cannot-mutate' });
    expect((v as { reason: string }).reason).toContain('skipped at runtime');
  });

  it('is an error when no tests ran, quoting the first report error', () => {
    const empty = verdictFromReport(report(0, 0));
    expect(empty).toMatchObject({ verdict: 'error' });
    expect((empty as { reason: string }).reason).toContain('no tests ran');

    const withError = verdictFromReport(
      JSON.stringify({
        stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
        errors: [{ message: 'Error: No tests found\nsecond line' }],
      }),
    );
    expect((withError as { reason: string }).reason).toContain('Error: No tests found');
    expect((withError as { reason: string }).reason).not.toContain('second line');
  });

  it('is an error on garbage or a stats-less report, never a verdict', () => {
    expect(verdictFromReport('not json at all')).toMatchObject({ verdict: 'error' });
    expect(verdictFromReport('{}')).toMatchObject({ verdict: 'error' });
    expect(verdictFromReport(JSON.stringify({ stats: { expected: 'x' } }))).toMatchObject({
      verdict: 'error',
    });
  });
});

describe('assertSpan', () => {
  it('spans a multi-line statement to where its parentheses balance and names the matcher', () => {
    const src = ['a', '  await expect(', "    page.locator('#x'),", '  ).not.toBeVisible();', 'b'].join('\n');
    expect(assertSpan(src, 2)).toEqual({ endLine: 4, matcher: 'toBeVisible', negated: true });
    expect(assertSpan("await expect(x).toHaveText('a');", 1)).toEqual({ endLine: 1, matcher: 'toHaveText', negated: false });
  });
});

describe('baselineFromReport', () => {
  const spec = (line: number, status: string, results: unknown[] = []): unknown => ({
    line,
    tests: [{ status, results }],
  });
  const raw = (specs: unknown[]): string =>
    JSON.stringify({ stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 }, suites: [{ specs }] });

  it('classifies each requested test line', () => {
    const out = baselineFromReport(
      raw([
        spec(2, 'expected'),
        spec(6, 'unexpected', [
          { status: 'failed', error: { message: 'Error: boom\nmore', location: { file: '/d/s.spec.ts', line: 7 } } },
        ]),
        spec(10, 'flaky'),
        spec(14, 'skipped'),
      ]),
      [2, 6, 10, 14, 18],
      '/d/s.spec.ts',
    );
    expect(out.get(2)).toEqual({ status: 'passed' });
    expect(out.get(6)).toMatchObject({ status: 'baseline-failed' });
    expect((out.get(6) as { reason: string }).reason).toContain('s.spec.ts:7: Error: boom');
    expect(out.get(10)).toMatchObject({ status: 'flaky' });
    expect(out.get(14)).toMatchObject({ status: 'skipped' });
    expect(out.get(18)).toMatchObject({ status: 'error' });
  });

  it('fails every line as an error on a broken report', () => {
    const out = baselineFromReport('nope', [2, 6], 's.spec.ts');
    expect(out.get(2)).toMatchObject({ status: 'error' });
    expect(out.get(6)).toMatchObject({ status: 'error' });
  });
});

describe('runMutation', () => {
  it('returns killed when the run reports an unexpected failure, and cleans up', async () => {
    const { dir, specPath, mutation } = specWithMutation();
    const result = await runMutation(specPath, 0, mutation, {
      cwd: dir,
      playwrightCommand: fakePlaywright(dir, WRITES_KILLED_REPORT),
    });
    expect(result).toEqual({ verdict: 'killed' });
    expect(mutationFilesIn(dir)).toEqual([]);
  });

  it('returns survived when the mutated run stays green', async () => {
    const { dir, specPath, mutation } = specWithMutation();
    const result = await runMutation(specPath, 0, mutation, {
      cwd: dir,
      playwrightCommand: fakePlaywright(dir, WRITES_SURVIVED_REPORT),
    });
    expect(result).toEqual({ verdict: 'survived' });
  });

  it('reports a crash without a report as an error with the output tail', async () => {
    const { dir, specPath, mutation } = specWithMutation();
    const result = await runMutation(specPath, 0, mutation, {
      cwd: dir,
      playwrightCommand: fakePlaywright(dir, CRASHES_WITHOUT_REPORT),
    });
    expect(result.verdict).toBe('error');
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('exited with code 1');
    expect(reason).toContain('something exploded');
    expect(mutationFilesIn(dir)).toEqual([]);
  });

  it('kills a hung run at the timeout and reports an error, not a verdict', async () => {
    const { dir, specPath, mutation } = specWithMutation();
    const result = await runMutation(specPath, 0, mutation, {
      cwd: dir,
      timeoutMs: 400,
      playwrightCommand: fakePlaywright(dir, HANGS_FOREVER),
    });
    expect(result.verdict).toBe('error');
    expect((result as { reason: string }).reason).toContain('timed out');
    expect(mutationFilesIn(dir)).toEqual([]);
  }, 10000);

  it('reports a launch failure when the command does not exist', async () => {
    const { dir, specPath, mutation } = specWithMutation();
    const result = await runMutation(specPath, 0, mutation, {
      cwd: dir,
      playwrightCommand: ['pmg-no-such-binary-xyz'],
    });
    expect(result.verdict).toBe('error');
    expect((result as { reason: string }).reason).toContain('could not launch');
    expect(mutationFilesIn(dir)).toEqual([]);
  });
});

describe('sweepStaleMutationFiles', () => {
  it('removes copies from dead processes, keeps live and foreign files', () => {
    const dir = tempDir();
    // A real process that has already exited: its pid is guaranteed dead.
    const dead = spawnSync('node', ['-e', '']);
    const deadToken = (dead.pid ?? 1).toString(36);
    const liveToken = process.pid.toString(36);
    const stale = `a.pmg-mutation-0-${deadToken}.spec.ts`;
    const live = `a.pmg-mutation-1-${liveToken}.spec.ts`;
    for (const f of [stale, live, 'a.spec.ts', 'unrelated.ts']) writeFileSync(join(dir, f), '');

    const removed = sweepStaleMutationFiles(dir);

    expect(removed).toEqual([join(dir, stale)]);
    expect(existsSync(join(dir, live))).toBe(true);
    expect(existsSync(join(dir, 'a.spec.ts'))).toBe(true);
    expect(existsSync(join(dir, 'unrelated.ts'))).toBe(true);
  });

  it('returns nothing for a missing directory', () => {
    expect(sweepStaleMutationFiles('/definitely/not/a/dir')).toEqual([]);
  });
});

describe('runSpec', () => {
  it('refuses the whole spec when test.only is present, without launching anything', async () => {
    const dir = tempDir();
    const specPath = join(dir, 'focused.spec.ts');
    writeFileSync(
      specPath,
      [
        "import { test, expect } from '@playwright/test';",
        "test('marked', async ({ page }) => {",
        '  // @primary-assert',
        "  await expect(page.locator('#x')).toBeVisible();",
        '});',
        "test.only('focused', async () => {});",
      ].join('\n'),
    );
    // A bogus command proves refusal happens before any spawn: launching it
    // would produce a "could not launch" reason instead.
    const result = await runSpec(specPath, { playwrightCommand: ['pmg-no-such-binary-xyz'] });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ verdict: 'error' });
    expect(result.results[0]!.reason).toContain('test.only on line 6');
    expect(result.unmarkedTests).toEqual([{ title: 'focused', line: 6 }]);
  });

  it('maps cannot-mutate plans straight to verdicts and runs the rest', async () => {
    const dir = tempDir();
    const specPath = join(dir, 'mixed.spec.ts');
    writeFileSync(
      specPath,
      [
        "import { test, expect } from '@playwright/test';",
        "test('mutable', async ({ page }) => {",
        '  // @primary-assert',
        "  await expect(page.locator('#x')).toBeVisible();",
        '});',
        "test('unmutable', async () => {",
        '  // @primary-assert',
        '  const x = 1;',
        '});',
        "test('no marker', async () => {});",
      ].join('\n'),
    );
    const result = await runSpec(specPath, {
      cwd: dir,
      playwrightCommand: fakePlaywright(dir, WRITES_KILLED_REPORT),
    });
    expect(result.results).toEqual([
      { testTitle: 'mutable', testLine: 2, assertLine: 4, verdict: 'killed' },
      {
        testTitle: 'unmutable',
        testLine: 6,
        assertLine: 8,
        verdict: 'cannot-mutate',
        reason: expect.stringContaining('expect(') as string,
      },
    ]);
    expect(result.unmarkedTests).toEqual([{ title: 'no marker', line: 10 }]);
    expect(mutationFilesIn(dir)).toEqual([]);
  });

  it('does not mutate a test that is red or flaky without mutation', async () => {
    for (const [baseline, verdict] of [
      ['failed', 'baseline-failed'],
      ['flaky', 'flaky'],
    ] as const) {
      const dir = tempDir();
      const specPath = join(dir, 'base.spec.ts');
      writeFileSync(specPath, MARKED_SPEC);
      const result = await runSpec(specPath, {
        cwd: dir,
        playwrightCommand: fakePlaywright(dir, fakeReport('killed', baseline)),
      });
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ verdict, testLine: 2, assertLine: 4 });
      expect(mutationFilesIn(dir)).toEqual([]);
    }
  });

  it('reports killed-elsewhere when the mutant fails off the inverted line', async () => {
    const dir = tempDir();
    const specPath = join(dir, 'else.spec.ts');
    writeFileSync(specPath, MARKED_SPEC);
    const result = await runSpec(specPath, {
      cwd: dir,
      playwrightCommand: fakePlaywright(dir, fakeReport('killed-elsewhere')),
    });
    expect(result.results[0]).toMatchObject({ verdict: 'killed-elsewhere' });
    expect(result.results[0]!.reason).toContain('else.spec.ts:1');
  });

  it('sweeps stale copies from dead runs before mutating', async () => {
    const dir = tempDir();
    const specPath = join(dir, 'swept.spec.ts');
    writeFileSync(specPath, MARKED_SPEC);
    const dead = spawnSync('node', ['-e', '']);
    const staleName = `swept.pmg-mutation-0-${(dead.pid ?? 1).toString(36)}.spec.ts`;
    writeFileSync(join(dir, staleName), 'left over from a crashed run');

    await runSpec(specPath, {
      cwd: dir,
      playwrightCommand: fakePlaywright(dir, WRITES_SURVIVED_REPORT),
    });

    expect(existsSync(join(dir, staleName))).toBe(false);
  });
});

describe('createLimiter', () => {
  it('keeps at most N jobs in flight and returns each result in place', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const job = (v: number) => async (): Promise<number> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return v;
    };
    const out = await Promise.all([1, 2, 3, 4, 5].map((v) => limit(job(v))));
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('propagates a rejection and keeps draining the queue', async () => {
    const limit = createLimiter(1);
    const failed = limit(() => Promise.reject(new Error('boom')));
    const after = limit(() => Promise.resolve('ok'));
    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });
});

describe('runSpec concurrency', () => {
  const THREE_TESTS = [
    "import { test, expect } from '@playwright/test';",
    ...[1, 2, 3].flatMap((i) => [
      `test('t${i}', async ({ page }) => {`,
      '  // @primary-assert',
      `  await expect(page.locator('#x${i}')).toBeVisible();`,
      '});',
    ]),
  ].join('\n');

  /** Wraps the killed fake: records how many fake runs overlap, peak in ./peak. */
  const counting = (dir: string): string => `
{
const fs = require('node:fs');
const path = require('node:path');
const live = path.join(${JSON.stringify(dir)}, 'live');
fs.mkdirSync(live, { recursive: true });
const me = path.join(live, String(process.pid));
fs.writeFileSync(me, '');
const n = fs.readdirSync(live).length;
const peakFile = path.join(${JSON.stringify(dir)}, 'peak');
const peak = fs.existsSync(peakFile) ? Number(fs.readFileSync(peakFile, 'utf8')) : 0;
if (n > peak) fs.writeFileSync(peakFile, String(n));
const until = Date.now() + 400;
while (Date.now() < until) {}
fs.unlinkSync(me);
}
${fakeReport('killed')}`;

  for (const [concurrency, expectParallel] of [
    [1, false],
    [3, true],
  ] as const) {
    it(`runs mutations ${expectParallel ? 'in parallel' : 'one at a time'} at concurrency ${concurrency}`, async () => {
      const dir = tempDir();
      const specPath = join(dir, 'three.spec.ts');
      writeFileSync(specPath, THREE_TESTS);
      const result = await runSpec(specPath, {
        cwd: dir,
        concurrency,
        playwrightCommand: fakePlaywright(dir, counting(dir)),
      });
      expect(result.results.map((r) => [r.testTitle, r.verdict])).toEqual([
        ['t1', 'killed'],
        ['t2', 'killed'],
        ['t3', 'killed'],
      ]);
      const peak = Number(readFileSync(join(dir, 'peak'), 'utf8'));
      if (expectParallel) expect(peak).toBeGreaterThanOrEqual(2);
      else expect(peak).toBe(1);
      expect(mutationFilesIn(dir)).toEqual([]);
    });
  }
});
