import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { analyzeSpec } from './mutate.js';
import {
  baselineFromReport,
  DEFAULT_COMMAND,
  DEFAULT_TIMEOUT_MS,
  hasRetriesArg,
  runChild,
  type BaselineOutcome,
} from './run.js';

/**
 * verify-fix: does the PR's new test actually depend on the PR's fix?
 *
 * In a separate git worktree, every non-test file the PR changed is rolled
 * back to the merge base while the PR's tests stay. The new tests must be
 * green on HEAD and red on the rolled-back code (SWE-bench calls this
 * FAIL_TO_PASS).
 *
 * `verified`: green on HEAD, red on the rollback. `survived`: green on the
 * rollback too, so the test does not prove the fix. `baseline-failed` /
 * `flaky`: the test is red or flaky on HEAD itself. `cannot-verify`: nothing
 * to roll back, the rolled-back tree does not build, or the test was skipped.
 * `error`: a run itself failed. Only `verified` passes.
 *
 * What it cannot catch: a test that asserts exactly the literal the fix
 * introduces passes on HEAD and fails on the rollback, and still proves little.
 */
export type FixVerdict = 'verified' | 'survived' | 'flaky' | 'baseline-failed' | 'cannot-verify' | 'error';

export interface FixResult {
  spec: string;
  testTitle: string;
  testLine: number;
  verdict: FixVerdict;
  reason?: string;
}

export interface VerifyFixReport {
  base: string;
  mergeBase: string;
  /** Non-test files rolled back in the worktree, repo-relative. */
  revertedFiles: string[];
  results: FixResult[];
  /** Run-level problems (no new tests, build failure, ...). */
  notes: string[];
  passed: boolean;
}

export interface VerifyFixOptions {
  /** Git ref the PR targets; the rollback goes to merge-base(base, HEAD). */
  base: string;
  /** Spec files to check (relative to cwd); default: changed spec files. */
  specs?: string[];
  /** Directory Playwright runs from; default process.cwd(). */
  cwd?: string;
  /** Repo-relative paths matching this count as test files (kept, not rolled back). */
  testPattern?: RegExp;
  /** Shell commands run in the rolled-back worktree before the tests; default: npm build/typecheck scripts if present. */
  build?: string[];
  playwrightArgs?: string[];
  playwrightCommand?: string[];
  timeoutMs?: number;
}

export const DEFAULT_TEST_PATTERN = /(^|\/)(tests?|e2e|__tests__|specs?|fixtures)\/|\.(spec|test)\.[cm]?[jt]sx?$/;
const SPEC_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;

export class VerifyFixError extends Error {}

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new VerifyFixError(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout;
}

interface Change {
  status: string;
  path: string;
  /** For renames: the path at the merge base. */
  oldPath?: string;
}

function changedFiles(mergeBase: string, root: string): Change[] {
  const out = git(['diff', '--name-status', '-z', mergeBase, 'HEAD'], root);
  const parts = out.split('\0').filter((p) => p !== '');
  const changes: Change[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i++]!;
      changes.push({ status: status[0]!, path: parts[i++]!, oldPath });
    } else {
      changes.push({ status: status[0]!, path: parts[i++]! });
    }
  }
  return changes;
}

/** Tests in a spec source: title and declaration line, skip-mode tests excluded. */
function testsIn(source: string): { title: string; line: number }[] {
  const a = analyzeSpec(source);
  return [
    ...a.markedTests.filter((t) => t.mode === '' || t.mode === 'only').map((t) => ({ title: t.title, line: t.testLine })),
    ...a.unmarkedTests,
  ].sort((x, y) => x.line - y.line);
}

const toPosix = (p: string): string => p.split(sep).join('/');

async function runTests(
  dir: string,
  spec: string,
  lines: number[],
  opts: VerifyFixOptions,
): Promise<Map<number, BaselineOutcome>> {
  const command = opts.playwrightCommand ?? DEFAULT_COMMAND;
  const userArgs = opts.playwrightArgs ?? [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reportDir = mkdtempSync(join(tmpdir(), 'pmg-fix-'));
  const reportPath = join(reportDir, 'report.json');
  const failAll = (reason: string): Map<number, BaselineOutcome> =>
    new Map(lines.map((l) => [l, { status: 'error', reason }]));
  try {
    const outcome = await runChild(
      [
        ...command,
        ...lines.map((l) => `${spec}:${l}`),
        '--reporter=json',
        ...(hasRetriesArg(userArgs) ? [] : ['--retries=1']),
        ...userArgs,
      ],
      dir,
      { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
      timeoutMs,
    );
    if (outcome.spawnError) return failAll(`could not launch ${command.join(' ')}: ${outcome.spawnError}`);
    if (outcome.timedOut) return failAll(`Playwright run timed out after ${Math.round(timeoutMs / 1000)}s`);
    let raw: string;
    try {
      raw = readFileSync(reportPath, 'utf8');
    } catch {
      return failAll(
        `Playwright exited with code ${outcome.code ?? 'unknown'} without a report; output tail: ${outcome.output.trim().slice(-500)}`,
      );
    }
    return baselineFromReport(raw, lines, spec);
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function defaultBuild(dir: string): string[] {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return [];
  const scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  return ['build', 'typecheck'].filter((s) => scripts[s] !== undefined).map((s) => `npm run ${s}`);
}

export async function verifyFix(opts: VerifyFixOptions): Promise<VerifyFixReport> {
  const cwd = realpathSync(resolve(opts.cwd ?? process.cwd()));
  const root = realpathSync(git(['rev-parse', '--show-toplevel'], cwd).trim());
  const cwdInRoot = relative(root, cwd);
  const testPattern = opts.testPattern ?? DEFAULT_TEST_PATTERN;
  const mergeBase = git(['merge-base', opts.base, 'HEAD'], root).trim();
  const changes = changedFiles(mergeBase, root);
  const isTest = (p: string): boolean => testPattern.test(p);

  const report: VerifyFixReport = { base: opts.base, mergeBase, revertedFiles: [], results: [], notes: [], passed: false };

  // Specs: given ones, or changed spec files inside cwd. Paths are cwd-relative.
  const specs =
    opts.specs?.map((s) => toPosix(relative(cwd, resolve(cwd, s)))) ??
    changes
      .filter((c) => c.status !== 'D' && SPEC_FILE.test(c.path) && isTest(c.path))
      .map((c) => toPosix(relative(cwd, join(root, c.path))))
      .filter((p) => !p.startsWith('..'));

  // New tests: titles absent from the spec at the merge base.
  const targets: { spec: string; tests: { title: string; line: number }[] }[] = [];
  for (const spec of specs) {
    const abs = join(cwd, spec);
    if (!existsSync(abs)) throw new VerifyFixError(`spec file not found: ${spec}`);
    const headTests = testsIn(readFileSync(abs, 'utf8'));
    const rel = toPosix(relative(root, abs));
    const atBase = spawnSync('git', ['show', `${mergeBase}:${rel}`], { cwd: root, encoding: 'utf8' });
    const baseTitles = new Set(atBase.status === 0 ? testsIn(atBase.stdout).map((t) => t.title) : []);
    const fresh = headTests.filter((t) => !baseTitles.has(t.title));
    if (fresh.length > 0) targets.push({ spec, tests: fresh });
  }
  if (targets.length === 0) {
    report.notes.push(`no new tests in ${specs.length === 0 ? 'the changed spec files' : specs.join(', ')} since ${opts.base}`);
    return report;
  }

  const cannot = (reason: string): VerifyFixReport => {
    for (const t of targets) {
      for (const test of t.tests) {
        report.results.push({ spec: t.spec, testTitle: test.title, testLine: test.line, verdict: 'cannot-verify', reason });
      }
    }
    report.notes.push(reason);
    return report;
  };

  const toRevert = changes.filter((c) => !isTest(c.path) || (c.oldPath !== undefined && !isTest(c.oldPath)));
  if (toRevert.length === 0) return cannot(`the change since ${opts.base} touches only test files, so there is no fix to roll back`);

  const wt = mkdtempSync(join(tmpdir(), 'pmg-verify-fix-'));
  try {
    git(['worktree', 'add', '--detach', '--quiet', wt, 'HEAD'], root);
    for (const c of toRevert) {
      if (c.status !== 'A' && c.oldPath === undefined) {
        git(['checkout', mergeBase, '--', c.path], wt);
      } else {
        // Added in the PR (or the new side of a rename): gone at the base.
        if (!isTest(c.path) && existsSync(join(wt, c.path))) unlinkSync(join(wt, c.path));
        if (c.oldPath !== undefined && !isTest(c.oldPath)) git(['checkout', mergeBase, '--', c.oldPath], wt);
      }
      report.revertedFiles.push(c.oldPath !== undefined && c.status === 'R' ? `${c.oldPath} -> ${c.path}` : c.path);
    }
    const wtCwd = join(wt, cwdInRoot);
    // Installed dependencies are not in git; reuse the checkout's.
    for (const dir of new Set([cwd, root])) {
      const nm = join(dir, 'node_modules');
      const target = join(wt, relative(root, dir), 'node_modules');
      if (existsSync(nm) && !existsSync(target)) symlinkSync(nm, target, 'dir');
    }

    for (const cmd of opts.build ?? defaultBuild(wtCwd)) {
      const r = spawnSync(cmd, { cwd: wtCwd, shell: true, encoding: 'utf8' });
      if (r.status !== 0) {
        const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-500);
        return cannot(`\`${cmd}\` fails on the rolled-back code, so the tests cannot be judged there: ${tail}`);
      }
    }

    for (const t of targets) {
      const lines = t.tests.map((x) => x.line);
      const head = await runTests(cwd, t.spec, lines, opts);
      const pending = t.tests.filter((x) => head.get(x.line)?.status === 'passed').map((x) => x.line);
      const rolled = pending.length > 0 ? await runTests(wtCwd, t.spec, pending, opts) : new Map<number, BaselineOutcome>();
      for (const test of t.tests) {
        const h = head.get(test.line)!;
        const push = (verdict: FixVerdict, reason?: string): void => {
          report.results.push({
            spec: t.spec,
            testTitle: test.title,
            testLine: test.line,
            verdict,
            ...(reason !== undefined ? { reason } : {}),
          });
        };
        if (h.status !== 'passed') {
          if (h.status === 'baseline-failed') push('baseline-failed', `on HEAD: ${h.reason}`);
          else if (h.status === 'flaky') push('flaky', `on HEAD: ${h.reason}`);
          else if (h.status === 'skipped') push('cannot-verify', h.reason);
          else push('error', `on HEAD: ${h.reason}`);
          continue;
        }
        const r = rolled.get(test.line)!;
        if (r.status === 'baseline-failed') push('verified');
        else if (r.status === 'passed') {
          push('survived', 'the test stays green with the fix rolled back, so it does not prove the fix');
        } else if (r.status === 'flaky') {
          push('flaky', 'on the rolled-back code the test failed and then passed on retry');
        } else if (r.status === 'skipped') push('cannot-verify', r.reason);
        else push('error', `on the rolled-back code: ${r.reason}`);
      }
    }
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: root });
    rmSync(wt, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: root });
  }
  report.passed = report.results.length > 0 && report.results.every((r) => r.verdict === 'verified');
  return report;
}

export function renderFixReport(report: VerifyFixReport): string {
  const width = 'baseline-failed'.length;
  const lines = [
    `verify-fix against ${report.base} (merge base ${report.mergeBase.slice(0, 12)})`,
    `rolled back: ${report.revertedFiles.length === 0 ? 'nothing' : report.revertedFiles.join(', ')}`,
    '',
  ];
  for (const r of report.results) {
    lines.push(`  ${r.verdict.padEnd(width)}  ${r.spec}:${r.testLine}  ${r.testTitle}`);
    if (r.reason !== undefined) lines.push(`  ${' '.repeat(width)}  ${r.reason}`);
  }
  for (const n of report.notes) lines.push(`note: ${n}`);
  lines.push('');
  lines.push(
    report.passed
      ? 'verify-fix passed: every new test fails without the fix.'
      : 'verify-fix FAILED: a new test does not prove the fix, or the fix could not be checked.',
  );
  return lines.join('\n');
}
