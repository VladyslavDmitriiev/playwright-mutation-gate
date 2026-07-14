import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// End-to-end CLI runs against the fixture site: verdicts and exit codes are
// asserted on the built bin driving real Playwright, the same command a user
// would put in CI.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const cli = (...args: string[]) =>
  spawnSync('node', [join(root, 'dist/cli.js'), ...args], { cwd: root, encoding: 'utf8' });

describe('cli against the fixture site', () => {
  it('passes on the honest spec: table shows killed, exit 0', () => {
    const r = cli('fixtures/honest.spec.ts');
    expect(r.stdout).toContain('fixtures/honest.spec.ts');
    expect(r.stdout).toContain('killed');
    expect(r.stdout).toContain('Gate passed');
    expect(r.status).toBe(0);
  });

  it('fails on honest + hollow together: both verdicts in one table, exit 1', () => {
    const r = cli('fixtures/honest.spec.ts', 'fixtures/hollow.spec.ts');
    expect(r.stdout).toContain('killed');
    expect(r.stdout).toContain('survived');
    expect(r.stdout).toContain('1 killed, 1 survived');
    expect(r.stdout).toContain('Gate FAILED');
    expect(r.status).toBe(1);
  });
});
