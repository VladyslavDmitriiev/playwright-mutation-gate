import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { planSpecMutations, type Mutation } from '../src/mutate.js';
import { runMutation, runSpec, sweepStaleMutationFiles, verdictFromReport } from '../src/run.js';

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

const report = (expected: number, unexpected: number, flaky = 0): string =>
  JSON.stringify({ stats: { expected, unexpected, flaky, skipped: 0 }, errors: [] });

const WRITES_KILLED_REPORT = `
require('node:fs').writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, ${JSON.stringify(report(0, 1))});
process.exit(1);
`;
const WRITES_SURVIVED_REPORT = `
require('node:fs').writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, ${JSON.stringify(report(1, 0))});
process.exit(0);
`;
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

  it('treats flaky as killed: the assertion failed at least once', () => {
    expect(verdictFromReport(report(0, 0, 1))).toEqual({ verdict: 'killed' });
  });

  it('reads survived from an all-green run', () => {
    expect(verdictFromReport(report(1, 0))).toEqual({ verdict: 'survived' });
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
