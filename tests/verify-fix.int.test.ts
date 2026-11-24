import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyFix } from '../src/verify-fix.js';

// A throwaway git repo: the base commit has a form whose error never shows,
// the "PR" commit fixes it and adds two tests. One test depends on the fix
// (verified), the other passes either way (survived).
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = mkdtempSync(join(tmpdir(), 'pmg-vf-repo-'));
const PORT = 4191;

const page = (fixed: boolean): string => `<!doctype html>
<form id="f" novalidate><input id="email" type="email"><button id="submit" type="submit">Go</button></form>
<p id="error" hidden>Please enter a valid email address.</p>
<script>
  document.getElementById('f').addEventListener('submit', (e) => {
    e.preventDefault();
    const valid = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(document.getElementById('email').value);
    document.getElementById('error').hidden = ${fixed ? 'valid' : 'true'};
  });
</script>
`;

const SERVER = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(readFileSync(new URL('./site/index.html', import.meta.url)));
}).listen(${PORT}, '127.0.0.1');
`;

const CONFIG = `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests',
  use: { baseURL: 'http://127.0.0.1:${PORT}' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node serve.mjs', port: ${PORT}, reuseExistingServer: false },
});
`;

const SPEC = `import { test, expect } from '@playwright/test';

test('shows an error for an invalid email', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', 'nope');
  await page.click('#submit');
  await expect(page.locator('#error')).toBeVisible({ timeout: 2000 });
});

test('has an email field', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#email')).toBeVisible();
});
`;

const git = (...args: string[]): void => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
const write = (rel: string, text: string): void => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

beforeAll(() => {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'pmg@example.com');
  git('config', 'user.name', 'pmg');
  write('.gitignore', 'node_modules\ntest-results\n');
  write('site/index.html', page(false));
  write('serve.mjs', SERVER);
  write('playwright.config.ts', CONFIG);
  symlinkSync(join(pkgRoot, 'node_modules'), join(repo, 'node_modules'), 'dir');
  git('add', '.');
  git('commit', '-q', '-m', 'base: error never shows');
  git('switch', '-q', '-c', 'fix');
  write('site/index.html', page(true));
  write('tests/form.spec.ts', SPEC);
  git('add', '.');
  git('commit', '-q', '-m', 'fix: show the error, with tests');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const worktrees = (): number =>
  spawnSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').length;

describe('verify-fix against a throwaway repo', () => {
  it('verifies the test that needs the fix and flags the one that does not', async () => {
    const report = await verifyFix({ base: 'main', cwd: repo });
    expect(report.revertedFiles).toEqual(['site/index.html']);
    expect(report.results.map((r) => [r.testTitle, r.verdict])).toEqual([
      ['shows an error for an invalid email', 'verified'],
      ['has an email field', 'survived'],
    ]);
    expect(report.passed).toBe(false);
    expect(worktrees()).toBe(1);
  });

  it('reports cannot-verify when the rolled-back tree does not build', async () => {
    const report = await verifyFix({ base: 'main', cwd: repo, build: ['node -e "process.exit(3)"'] });
    expect(report.results.every((r) => r.verdict === 'cannot-verify')).toBe(true);
    expect(report.results[0]!.reason).toContain('fails on the rolled-back code');
    expect(report.passed).toBe(false);
    expect(worktrees()).toBe(1);
  });

  it('runs from the CLI: --no-build skips the build, --build makes it cannot-verify, exit 1', () => {
    const cli = (...args: string[]) =>
      spawnSync('node', [join(pkgRoot, 'dist/cli.js'), 'verify-fix', '--base', 'main', '--json', ...args], {
        cwd: repo,
        encoding: 'utf8',
      });
    const skipped = cli('--no-build');
    expect(skipped.status).toBe(1);
    const verdicts = (JSON.parse(skipped.stdout) as { results: { verdict: string }[] }).results.map((r) => r.verdict);
    expect(verdicts).toEqual(['verified', 'survived']);
    const broken = cli('--build', 'node -e "process.exit(4)"');
    expect(broken.status).toBe(1);
    expect(JSON.parse(broken.stdout).results[0].verdict).toBe('cannot-verify');
    expect(worktrees()).toBe(1);
  });

  it('reports a note, not a pass, when there are no new tests', async () => {
    const report = await verifyFix({ base: 'HEAD', cwd: repo });
    expect(report.results).toEqual([]);
    expect(report.notes[0]).toContain('no new tests');
    expect(report.passed).toBe(false);
  });
});
