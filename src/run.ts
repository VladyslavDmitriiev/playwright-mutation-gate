import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { planSpecMutations, writeMutationFile, type Mutation, type SpecPlan } from './mutate.js';

export type Verdict = 'killed' | 'survived' | 'cannot-mutate' | 'error';

export interface MutationResult {
  testTitle: string;
  testLine: number;
  /** 1-based line of the mutated assertion; null when none was located. */
  assertLine: number | null;
  verdict: Verdict;
  /** Present for cannot-mutate and error verdicts. */
  reason?: string;
}

export interface SpecResult {
  specPath: string;
  results: MutationResult[];
  unmarkedTests: SpecPlan['unmarkedTests'];
  strayMarkerLines: number[];
  malformedMarkerLines: number[];
}

export interface RunOptions {
  /** Directory Playwright is spawned from; defaults to process.cwd(). */
  cwd?: string;
  /** Hard cap for one mutation run; the child is killed past it. Default 5 min. */
  timeoutMs?: number;
  /** Extra args appended to every `playwright test` invocation. */
  playwrightArgs?: string[];
  /** Command that launches Playwright; default ['npx', 'playwright', 'test']. */
  playwrightCommand?: string[];
}

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_COMMAND = ['npx', 'playwright', 'test'];

/** Matches the copy names produced by mutationFilePath, pid token included. */
const MUTATION_FILE_RE = /\.pmg-mutation-\d+-([a-z0-9]+)\./;

interface ChildOutcome {
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
  /** Tail of interleaved stdout+stderr, for error messages. */
  output: string;
}

const OUTPUT_TAIL_LIMIT = 4000;

function runChild(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    // A detached child gets its own process group, so on timeout the kill
    // reaches Playwright's browser and web-server descendants too.
    const detached = process.platform !== 'win32';
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_LIMIT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, spawnError: err.message, output });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
  });
}

type RunVerdict =
  | { verdict: 'killed' | 'survived' }
  | { verdict: 'error'; reason: string };

/**
 * Decide a verdict from a Playwright JSON report. The exit code alone cannot
 * be trusted: Playwright exits 1 for a failed test, for "no tests found" and
 * for many crashes alike, and only the report tells those apart.
 */
export function verdictFromReport(raw: string): RunVerdict {
  let report: {
    stats?: { expected?: unknown; unexpected?: unknown; flaky?: unknown };
    errors?: { message?: unknown }[];
  };
  try {
    report = JSON.parse(raw) as typeof report;
  } catch {
    return { verdict: 'error', reason: 'Playwright JSON report is not valid JSON' };
  }
  const stats = report.stats;
  const expected = typeof stats?.expected === 'number' ? stats.expected : null;
  const unexpected = typeof stats?.unexpected === 'number' ? stats.unexpected : null;
  const flaky = typeof stats?.flaky === 'number' ? stats.flaky : null;
  if (expected === null || unexpected === null || flaky === null) {
    return { verdict: 'error', reason: 'Playwright JSON report has no stats block' };
  }
  if (expected + unexpected + flaky === 0) {
    const message = report.errors?.map((e) => e.message).find((m) => typeof m === 'string');
    const detail = message ? `: ${(message as string).split('\n', 1)[0]}` : '';
    return { verdict: 'error', reason: `no tests ran under the mutation filter${detail}` };
  }
  // A flaky test failed at least once under the inversion, so the assertion
  // demonstrably can fail; retries just masked it. That counts as killed.
  if (unexpected + flaky > 0) return { verdict: 'killed' };
  return { verdict: 'survived' };
}

/**
 * Run one planned mutation: write the inverted copy next to the spec, run
 * Playwright against exactly that copy and test line, and read the verdict
 * from the JSON report. The copy and the report directory are always removed.
 */
export async function runMutation(
  specPath: string,
  index: number,
  mutation: Extract<Mutation, { mutatedSource: string }>,
  opts: RunOptions = {},
): Promise<RunVerdict> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = opts.playwrightCommand ?? DEFAULT_COMMAND;
  const copyPath = writeMutationFile(specPath, index, mutation.mutatedSource);
  const reportDir = mkdtempSync(join(tmpdir(), 'pmg-'));
  const reportPath = join(reportDir, 'report.json');
  try {
    // The copy replaces a single line, so line numbers match the original
    // and the test declaration line targets exactly the mutated test.
    const target = `${relative(cwd, copyPath) || copyPath}:${mutation.testLine}`;
    const outcome = await runChild(
      [...command, target, '--reporter=json', ...(opts.playwrightArgs ?? [])],
      cwd,
      { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
      timeoutMs,
    );
    if (outcome.spawnError) {
      return {
        verdict: 'error',
        reason: `could not launch ${command.join(' ')}: ${outcome.spawnError}`,
      };
    }
    if (outcome.timedOut) {
      return {
        verdict: 'error',
        reason: `Playwright run timed out after ${Math.round(timeoutMs / 1000)}s and was killed`,
      };
    }
    let raw: string;
    try {
      raw = readFileSync(reportPath, 'utf8');
    } catch {
      const tail = outcome.output.trim();
      return {
        verdict: 'error',
        reason:
          `Playwright exited with code ${outcome.code ?? 'unknown'} without producing a report` +
          (tail === '' ? '' : `; output tail: ${tail.slice(-500)}`),
      };
    }
    return verdictFromReport(raw);
  } finally {
    try {
      unlinkSync(copyPath);
    } catch {
      // Already gone.
    }
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else: alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Delete leftover mutation copies in a directory: files whose pid token
 * points at a process that no longer exists. Copies of live concurrent gate
 * runs are left alone. Returns the paths that were removed.
 */
export function sweepStaleMutationFiles(dir: string): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const token = MUTATION_FILE_RE.exec(entry)?.[1];
    if (token === undefined) continue;
    const pid = parseInt(token, 36);
    if (Number.isNaN(pid) || pidIsAlive(pid)) continue;
    const path = join(dir, entry);
    try {
      unlinkSync(path);
      removed.push(path);
    } catch {
      // Raced with another sweep.
    }
  }
  return removed;
}

/**
 * Gate one spec file end to end: plan its mutations, sweep stale copies from
 * earlier crashed runs, run every mutable mutation and collect verdicts.
 * A spec containing test.only is refused outright: .only filters out every
 * other test, so verdicts from such a run would be fiction.
 */
export async function runSpec(specPath: string, opts: RunOptions = {}): Promise<SpecResult> {
  const source = readFileSync(specPath, 'utf8');
  const plan = planSpecMutations(source);
  const results: MutationResult[] = [];

  if (plan.onlyTestLines.length > 0) {
    const reason =
      `test.only on line ${plan.onlyTestLines.join(', ')} of ${basename(specPath)} ` +
      'filters out every other test, so no mutation verdict would be honest; remove .only first';
    for (const m of plan.mutations) {
      results.push({
        testTitle: m.testTitle,
        testLine: m.testLine,
        assertLine: m.assertLine,
        verdict: 'error',
        reason,
      });
    }
  } else {
    sweepStaleMutationFiles(dirname(specPath));
    for (const [index, m] of plan.mutations.entries()) {
      if ('cannotMutate' in m) {
        results.push({
          testTitle: m.testTitle,
          testLine: m.testLine,
          assertLine: m.assertLine,
          verdict: 'cannot-mutate',
          reason: m.cannotMutate,
        });
        continue;
      }
      const run = await runMutation(specPath, index, m, opts);
      results.push({
        testTitle: m.testTitle,
        testLine: m.testLine,
        assertLine: m.assertLine,
        verdict: run.verdict,
        ...(run.verdict === 'error' ? { reason: run.reason } : {}),
      });
    }
  }

  return {
    specPath,
    results,
    unmarkedTests: plan.unmarkedTests,
    strayMarkerLines: plan.strayMarkerLines,
    malformedMarkerLines: plan.malformedMarkerLines,
  };
}
