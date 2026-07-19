import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { planBehaviorMutations, type BehaviorMutation } from './behavior.js';
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

/**
 * Behavior mutation verdicts. `killed`: the test caught the corrupted value
 * (or the flow broke around it). `weak`: the test stayed green while the value
 * it names was broken - a hollow assertion. `cannot-locate`: the value never
 * appeared in a rewritable response, reported honestly and NOT a gate failure.
 * `error`: the run itself failed (spawn, timeout, no report).
 */
export type BehaviorVerdict = 'killed' | 'weak' | 'cannot-locate' | 'error';

export interface BehaviorResult {
  testTitle: string;
  testLine: number;
  /** 1-based line of the assertion whose value was corrupted; null when none. */
  assertLine: number | null;
  verdict: BehaviorVerdict;
  /** The corrupted value, when one was located. */
  value?: string;
  /** Explanation for weak / cannot-locate / error, and the flow-breakage caveat on killed. */
  reason?: string;
}

export interface SpecResult {
  specPath: string;
  results: MutationResult[];
  unmarkedTests: SpecPlan['unmarkedTests'];
  strayMarkerLines: number[];
  malformedMarkerLines: number[];
  /** Behavior mutation results, present only when the behavior pass ran. */
  behavior?: BehaviorResult[];
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
  /** Extra identifiers to treat as test builders (custom fixtures). */
  testIds?: string[];
  /** When true, also run the behavior mutation pass (page.route value corruption). */
  behavior?: boolean;
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
  | { verdict: 'cannot-mutate'; reason: string }
  | { verdict: 'error'; reason: string };

/**
 * Decide a verdict from a Playwright JSON report. The exit code alone cannot
 * be trusted: Playwright exits 1 for a failed test, for "no tests found" and
 * for many crashes alike, and only the report tells those apart.
 */
export function verdictFromReport(raw: string): RunVerdict {
  let report: {
    stats?: { expected?: unknown; unexpected?: unknown; flaky?: unknown; skipped?: unknown };
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
  const skipped = typeof stats?.skipped === 'number' ? stats.skipped : 0;
  if (expected === null || unexpected === null || flaky === null) {
    return { verdict: 'error', reason: 'Playwright JSON report has no stats block' };
  }
  if (expected + unexpected + flaky === 0) {
    // A test that matched the filter but was skipped at runtime (a conditional
    // test.skip, e.g. a fixture with no captured session) never executed the
    // inverted assertion. Reporting survived would be a lie; it is cannot-mutate.
    if (skipped > 0) {
      return {
        verdict: 'cannot-mutate',
        reason: 'the test was skipped at runtime (conditional test.skip), so the inverted assertion never ran',
      };
    }
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

type BehaviorRunVerdict =
  | { verdict: 'killed' | 'weak' | 'cannot-locate'; reason?: string }
  | { verdict: 'error'; reason: string };

/**
 * Decide a behavior verdict from a Playwright JSON report and whether the
 * injected handler recorded a hit (the named value was found and corrupted).
 * Mirrors verdictFromReport's stats reading, then layers the behavior
 * semantics: no hit means the value never reached a rewritable response
 * (cannot-locate); a hit plus a red test is killed; a hit plus a green test is
 * a hollow assertion (weak).
 */
export function behaviorVerdictFromReport(raw: string, hit: boolean): BehaviorRunVerdict {
  let report: {
    stats?: { expected?: unknown; unexpected?: unknown; flaky?: unknown; skipped?: unknown };
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
  const skipped = typeof stats?.skipped === 'number' ? stats.skipped : 0;
  if (expected === null || unexpected === null || flaky === null) {
    return { verdict: 'error', reason: 'Playwright JSON report has no stats block' };
  }
  if (expected + unexpected + flaky === 0) {
    if (skipped > 0) {
      return {
        verdict: 'cannot-locate',
        reason: 'the test was skipped at runtime, so its behavior could not be observed',
      };
    }
    const message = report.errors?.map((e) => e.message).find((m) => typeof m === 'string');
    const detail = message ? `: ${(message as string).split('\n', 1)[0]}` : '';
    return { verdict: 'error', reason: `no tests ran under the mutation filter${detail}` };
  }
  if (!hit) {
    return {
      verdict: 'cannot-locate',
      reason: 'the named value never appeared in an intercepted response, so nothing was corrupted',
    };
  }
  if (unexpected + flaky > 0) {
    return {
      verdict: 'killed',
      reason: 'the test failed once the named value was corrupted (a red here could also be flow breakage, not the assertion)',
    };
  }
  return { verdict: 'weak', reason: 'the test stayed green while the value it names was broken' };
}

/**
 * Run one behavior mutation: write the injected copy (route interception on top
 * of the intact assertion), run Playwright against exactly that test, and read
 * the verdict from the JSON report plus the hit-file the handler writes when it
 * corrupts a response. The copy, the report dir and the hit-file are always
 * removed.
 */
export async function runBehaviorMutation(
  specPath: string,
  index: number,
  mutation: Extract<BehaviorMutation, { mutatedSource: string }>,
  opts: RunOptions = {},
): Promise<BehaviorRunVerdict> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = opts.playwrightCommand ?? DEFAULT_COMMAND;
  const copyPath = writeMutationFile(specPath, index, mutation.mutatedSource);
  const reportDir = mkdtempSync(join(tmpdir(), 'pmg-'));
  const reportPath = join(reportDir, 'report.json');
  const hitPath = join(reportDir, 'hit');
  try {
    const target = `${relative(cwd, copyPath) || copyPath}:${mutation.testLine}`;
    const outcome = await runChild(
      [...command, target, '--reporter=json', ...(opts.playwrightArgs ?? [])],
      cwd,
      { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath, PMG_HIT_FILE: hitPath },
      timeoutMs,
    );
    if (outcome.spawnError) {
      return { verdict: 'error', reason: `could not launch ${command.join(' ')}: ${outcome.spawnError}` };
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
    const hit = existsSync(hitPath) && statSync(hitPath).size > 0;
    return behaviorVerdictFromReport(raw, hit);
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
  const plan = planSpecMutations(source, { testIds: opts.testIds });
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
        ...('reason' in run ? { reason: run.reason } : {}),
      });
    }
  }

  const result: SpecResult = {
    specPath,
    results,
    unmarkedTests: plan.unmarkedTests,
    strayMarkerLines: plan.strayMarkerLines,
    malformedMarkerLines: plan.malformedMarkerLines,
  };

  if (opts.behavior) {
    result.behavior = await runBehaviorPass(specPath, source, plan.onlyTestLines, opts);
  }

  return result;
}

/**
 * Run the behavior mutation pass for one spec: plan the route-interception
 * mutations and run each one that can be located. A spec containing test.only
 * is refused (same reason as inversion: .only makes every verdict fiction).
 */
async function runBehaviorPass(
  specPath: string,
  source: string,
  onlyTestLines: number[],
  opts: RunOptions,
): Promise<BehaviorResult[]> {
  const plan = planBehaviorMutations(source, { testIds: opts.testIds });
  const results: BehaviorResult[] = [];

  if (onlyTestLines.length > 0) {
    const reason =
      `test.only on line ${onlyTestLines.join(', ')} of ${basename(specPath)} ` +
      'filters out every other test, so no behavior verdict would be honest; remove .only first';
    for (const m of plan) {
      results.push({ testTitle: m.testTitle, testLine: m.testLine, assertLine: m.assertLine, verdict: 'error', reason });
    }
    return results;
  }

  for (const [index, m] of plan.entries()) {
    if ('cannotLocate' in m) {
      results.push({
        testTitle: m.testTitle,
        testLine: m.testLine,
        assertLine: m.assertLine,
        verdict: 'cannot-locate',
        reason: m.cannotLocate,
      });
      continue;
    }
    const run = await runBehaviorMutation(specPath, index, m, opts);
    results.push({
      testTitle: m.testTitle,
      testLine: m.testLine,
      assertLine: m.assertLine,
      verdict: run.verdict,
      value: m.value,
      ...('reason' in run && run.reason !== undefined ? { reason: run.reason } : {}),
    });
  }

  return results;
}
