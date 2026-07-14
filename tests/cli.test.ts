import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Fast CLI surface tests: they spawn the built bin but never reach Playwright.
// A spec whose tests all lack markers yields zero mutations, so the sentinel
// and JSON paths run in milliseconds. Real mutation runs live in cli.int.test.ts.

const cli = (...args: string[]) =>
  spawnSync('node', ['dist/cli.js', ...args], { encoding: 'utf8' });

const dir = mkdtempSync(join(tmpdir(), 'pmg-cli-'));
const unmarkedSpec = join(dir, 'unmarked.spec.ts');
writeFileSync(
  unmarkedSpec,
  [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('has no marker', async () => {",
    '  expect(1).toBe(1);',
    '});',
    '',
  ].join('\n'),
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('cli surface', () => {
  it('--help exits 0 and documents the flags', () => {
    const r = cli('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('--no-require-sentinel');
    expect(r.stdout).toContain('--playwright-args');
  });

  it('--version exits 0 with the package version', () => {
    const r = cli('--version');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits 2 without spec arguments', () => {
    const r = cli();
    expect(r.status).toBe(2);
  });

  it('exits 2 on an unknown option', () => {
    const r = cli('--frobnicate', unmarkedSpec);
    expect(r.status).toBe(2);
  });

  it('exits 2 when a spec file does not exist', () => {
    const r = cli('no/such/file.spec.ts');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no/such/file.spec.ts');
  });

  it('fails the gate on an unmarked test under the default sentinel', () => {
    const r = cli(unmarkedSpec);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('unmarked');
    expect(r.stdout).toContain('has no marker');
    expect(r.stdout).toContain('Gate FAILED');
  });

  it('passes the same spec with --no-require-sentinel', () => {
    const r = cli('--no-require-sentinel', unmarkedSpec);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('(not enforced)');
    expect(r.stdout).toContain('Gate passed');
  });

  it('--json emits a machine-readable report and keeps stdout parseable', () => {
    const r = cli('--json', unmarkedSpec);
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      specs: { specPath: string; unmarkedTests: { title: string }[] }[];
      summary: { unmarkedTests: number; gatePassed: boolean };
    };
    expect(parsed.specs[0]?.specPath).toBe(unmarkedSpec);
    expect(parsed.summary).toMatchObject({ unmarkedTests: 1, gatePassed: false });
  });

  it('never colors piped output', () => {
    const r = cli(unmarkedSpec);
    expect(r.stdout).not.toContain('\x1b[');
  });
});
