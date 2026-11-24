import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { planBehaviorMutations, type BehaviorMutation } from './behavior.js';
import { planSpecMutations, writeMutationFile, type GateSkip, type Mutation, type SpecPlan } from './mutate.js';

/**
 * Inversion verdicts. `killed`: the mutated test failed on the inverted
 * assertion itself. `survived`: it stayed green (a hollow assertion).
 * `cannot-mutate` / `error`: unchanged from 0.3.x.
 * Added in 0.4.0, all of which fail the gate:
 * `baseline-failed`: the UNmutated test is already red, so a red mutation run
 * proves nothing. `flaky`: the unmutated test, or the mutated run, failed and
 * then passed on retry, so its outcome is not proof either way.
 * `killed-elsewhere`: the mutated test went red, but not on the inverted
 * assertion (setup, import, fixture, a later step), so the marked assertion was
 * never shown to fail.
 */
export type Verdict =
  | 'killed'
  | 'survived'
  | 'cannot-mutate'
  | 'error'
  | 'baseline-failed'
  | 'flaky'
  | 'killed-elsewhere';

export interface MutationResult {
  testTitle: string;
  testLine: number;
  /** 1-based line of the mutated assertion; null when none was located. */
  assertLine: number | null;
  verdict: Verdict;
  /** Present for every verdict except killed and survived. */
  reason?: string;
  /** A valid @gate-skip acknowledgement on this test, for cannot-mutate verdicts. */
  gateSkip?: GateSkip;
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
  /** Unmarked tests allowed by a ratchet file (see ratchet.ts); never fail the gate. */
  ratchetedTests?: SpecPlan['unmarkedTests'];
  strayMarkerLines: number[];
  malformedMarkerLines: number[];
  malformedGateSkipLines: number[];
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
  | { verdict: 'cannot-mutate' | 'error' | 'baseline-failed' | 'flaky' | 'killed-elsewhere'; reason: string };

interface ReportLocation {
  file?: unknown;
  line?: unknown;
}
interface ReportResult {
  status?: unknown;
  error?: { message?: unknown; location?: ReportLocation };
  errorLocation?: ReportLocation;
}
interface ReportTest {
  status?: unknown;
  results?: ReportResult[];
}
interface ReportSpec {
  line?: unknown;
  tests?: ReportTest[];
}
interface ReportSuite {
  specs?: ReportSpec[];
  suites?: ReportSuite[];
}
interface PlaywrightReport {
  stats?: { expected?: unknown; unexpected?: unknown; flaky?: unknown; skipped?: unknown };
  errors?: { message?: unknown }[];
  suites?: ReportSuite[];
}

interface Stats {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
}

type Parsed = { report: PlaywrightReport; stats: Stats } | { error: string };

function parseReport(raw: string): Parsed {
  let report: PlaywrightReport;
  try {
    report = JSON.parse(raw) as PlaywrightReport;
  } catch {
    return { error: 'Playwright JSON report is not valid JSON' };
  }
  const st = report.stats;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const expected = num(st?.expected);
  const unexpected = num(st?.unexpected);
  const flaky = num(st?.flaky);
  if (expected === null || unexpected === null || flaky === null) {
    return { error: 'Playwright JSON report has no stats block' };
  }
  return { report, stats: { expected, unexpected, flaky, skipped: num(st?.skipped) ?? 0 } };
}

function firstReportError(report: PlaywrightReport): string {
  const message = report.errors?.map((e) => e.message).find((m) => typeof m === 'string');
  return message ? `: ${stripAnsi(message as string).split('\n', 1)[0]}` : '';
}

const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function allSpecs(suites: ReportSuite[] | undefined, out: ReportSpec[] = []): ReportSpec[] {
  for (const suite of suites ?? []) {
    out.push(...(suite.specs ?? []));
    allSpecs(suite.suites, out);
  }
  return out;
}

/** The first failed attempt in the report: where it failed and why. */
interface Failure {
  file: string | null;
  line: number | null;
  message: string;
}

function firstFailure(tests: ReportTest[]): Failure | null {
  for (const t of tests) {
    for (const r of t.results ?? []) {
      if (r.status === 'passed' || r.status === 'skipped') continue;
      const loc = r.error?.location ?? r.errorLocation;
      const message = typeof r.error?.message === 'string' ? stripAnsi(r.error.message) : String(r.status ?? 'failed');
      return {
        file: typeof loc?.file === 'string' ? loc.file : null,
        line: typeof loc?.line === 'number' ? loc.line : null,
        message: message.split('\n', 1)[0]!.trim(),
      };
    }
  }
  return null;
}

function describeFailure(f: Failure | null, displayName: (file: string) => string): string {
  if (f === null) return 'no failure details in the report';
  const at = f.file !== null && f.line !== null ? `${displayName(f.file)}:${f.line}` : 'an unknown location';
  return `at ${at}: ${f.message}`;
}

/**
 * Where the inverted assertion lives in the mutated copy, so a red run can be
 * checked against it. `copyFile` is the mutated copy, `assertLine`..`assertEndLine`
 * the inverted statement (1-based, inclusive), `matcher` its matcher name (e.g.
 * `toBeVisible`) for reports that carry no location.
 */
export interface AssertTarget {
  copyFile: string;
  originalFile: string;
  assertLine: number;
  assertEndLine: number;
  matcher: string | null;
}

/**
 * Decide a verdict from a Playwright JSON report. The exit code alone cannot
 * be trusted: Playwright exits 1 for a failed test, for "no tests found" and
 * for many crashes alike, and only the report tells those apart.
 *
 * With a `target`, a red run is only `killed` when the first failure points at
 * the inverted statement (or, if the report has no location, its error comes
 * from the inverted matcher); any other red run is `killed-elsewhere`.
 */
export function verdictFromReport(raw: string, target?: AssertTarget): RunVerdict {
  const parsed = parseReport(raw);
  if ('error' in parsed) return { verdict: 'error', reason: parsed.error };
  const { report, stats } = parsed;
  const { expected, unexpected, flaky, skipped } = stats;
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
    return { verdict: 'error', reason: `no tests ran under the mutation filter${firstReportError(report)}` };
  }
  if (unexpected > 0) {
    if (target === undefined) return { verdict: 'killed' };
    const tests = allSpecs(report.suites).flatMap((s) => s.tests ?? []);
    const failure = firstFailure(tests.filter((t) => t.status === 'unexpected'));
    const display = (file: string): string =>
      basename(file) === basename(target.copyFile) ? basename(target.originalFile) : file;
    if (failure !== null && failure.file !== null && failure.line !== null) {
      const sameFile = basename(failure.file) === basename(target.copyFile);
      if (sameFile && failure.line >= target.assertLine && failure.line <= target.assertEndLine) {
        return { verdict: 'killed' };
      }
    } else if (
      failure !== null &&
      failure.message.includes('expect(') &&
      (target.matcher === null || failure.message.includes(target.matcher))
    ) {
      // No location in the report: accept only an error raised by the inverted matcher.
      return { verdict: 'killed' };
    }
    return {
      verdict: 'killed-elsewhere',
      reason:
        `the mutated test failed ${describeFailure(failure, display)}, not on the inverted ` +
        `assertion at line ${target.assertLine}, so the marked assertion was never shown to fail`,
    };
  }
  // A flaky run failed and then passed on retry. That is not proof the
  // inverted assertion fails; it is noise, reported as such.
  if (flaky > 0) {
    return {
      verdict: 'flaky',
      reason: 'the mutated test failed and then passed on retry, so its outcome proves nothing',
    };
  }
  return { verdict: 'survived' };
}

/** Outcome of the unmutated (baseline) run for one test. */
export type BaselineOutcome =
  | { status: 'passed' }
  | { status: 'baseline-failed' | 'flaky' | 'skipped' | 'error'; reason: string };

/**
 * Read per-test baseline outcomes from the JSON report of one unmutated run
 * over the given test lines. A test passes the baseline only when every
 * project ran it green on the first attempt.
 */
export function baselineFromReport(raw: string, testLines: number[], specFile: string): Map<number, BaselineOutcome> {
  const out = new Map<number, BaselineOutcome>();
  const parsed = parseReport(raw);
  if ('error' in parsed) {
    for (const line of testLines) out.set(line, { status: 'error', reason: `baseline run: ${parsed.error}` });
    return out;
  }
  const specs = allSpecs(parsed.report.suites);
  const display = (file: string): string => (basename(file) === basename(specFile) ? basename(specFile) : file);
  for (const line of testLines) {
    const tests = specs.filter((s) => s.line === line).flatMap((s) => s.tests ?? []);
    if (tests.length === 0) {
      out.set(line, {
        status: 'error',
        reason: `the baseline run did not include this test${firstReportError(parsed.report)}`,
      });
      continue;
    }
    const failed = tests.filter((t) => t.status === 'unexpected');
    if (failed.length > 0) {
      out.set(line, {
        status: 'baseline-failed',
        reason:
          `the test fails without any mutation (${describeFailure(firstFailure(failed), display)}), ` +
          'so a red mutation run would prove nothing',
      });
    } else if (tests.some((t) => t.status === 'flaky')) {
      out.set(line, {
        status: 'flaky',
        reason: 'the unmutated test failed and then passed on retry, so a red mutation run would prove nothing',
      });
    } else if (tests.every((t) => t.status === 'skipped')) {
      out.set(line, {
        status: 'skipped',
        reason: 'the test was skipped at runtime (conditional test.skip), so the inverted assertion never ran',
      });
    } else {
      out.set(line, { status: 'passed' });
    }
  }
  return out;
}

/** True when the user already chose a retry count for Playwright. */
function hasRetriesArg(args: string[]): boolean {
  return args.some((a) => a === '--retries' || a.startsWith('--retries='));
}

/**
 * Run the UNmutated spec once for the given test lines and report, per test,
 * whether it is green on its own. Without the user's own --retries the run
 * uses --retries=1: a test that fails and passes on retry is reported flaky,
 * one that fails twice is baseline-failed.
 */
export async function runBaseline(
  specPath: string,
  testLines: number[],
  opts: RunOptions = {},
): Promise<Map<number, BaselineOutcome>> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = opts.playwrightCommand ?? DEFAULT_COMMAND;
  const userArgs = opts.playwrightArgs ?? [];
  const reportDir = mkdtempSync(join(tmpdir(), 'pmg-'));
  const reportPath = join(reportDir, 'report.json');
  const failAll = (reason: string): Map<number, BaselineOutcome> =>
    new Map(testLines.map((l) => [l, { status: 'error', reason: `baseline run: ${reason}` }]));
  try {
    const rel = relative(cwd, specPath) || specPath;
    const outcome = await runChild(
      [
        ...command,
        ...testLines.map((l) => `${rel}:${l}`),
        '--reporter=json',
        ...(hasRetriesArg(userArgs) ? [] : ['--retries=1']),
        ...userArgs,
      ],
      cwd,
      { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
      timeoutMs,
    );
    if (outcome.spawnError) return failAll(`could not launch ${command.join(' ')}: ${outcome.spawnError}`);
    if (outcome.timedOut) {
      return failAll(`Playwright run timed out after ${Math.round(timeoutMs / 1000)}s and was killed`);
    }
    let raw: string;
    try {
      raw = readFileSync(reportPath, 'utf8');
    } catch {
      const tail = outcome.output.trim();
      return failAll(
        `Playwright exited with code ${outcome.code ?? 'unknown'} without producing a report` +
          (tail === '' ? '' : `; output tail: ${tail.slice(-500)}`),
      );
    }
    return baselineFromReport(raw, testLines, specPath);
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

/**
 * Locate the inverted statement in the mutated source: from its first line to
 * the line where its parentheses balance (capped), plus its matcher name.
 */
export function assertSpan(source: string, assertLine: number): { endLine: number; matcher: string | null } {
  const lines = source.split('\n');
  let depth = 0;
  let opened = false;
  let endLine = assertLine;
  let text = '';
  for (let i = assertLine - 1; i < lines.length && i < assertLine - 1 + 50; i++) {
    const line = lines[i]!;
    text += line + '\n';
    for (const ch of line) {
      if (ch === '(') {
        depth++;
        opened = true;
      } else if (ch === ')') depth--;
    }
    endLine = i + 1;
    if (opened && depth <= 0) break;
  }
  const matchers = [...text.matchAll(/\.(to[A-Z]\w*)\s*\(/g)];
  return { endLine, matcher: matchers.length > 0 ? matchers[matchers.length - 1]![1]! : null };
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
    const span = assertSpan(mutation.mutatedSource, mutation.assertLine);
    return verdictFromReport(raw, {
      copyFile: copyPath,
      originalFile: specPath,
      assertLine: mutation.assertLine,
      assertEndLine: span.endLine,
      matcher: span.matcher,
    });
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
  if (unexpected === 0 && flaky > 0) {
    return {
      verdict: 'error',
      reason: 'flaky: the test failed and then passed on retry once the value was corrupted, so its outcome proves nothing',
    };
  }
  if (unexpected > 0) {
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
  let baseline = new Map<number, BaselineOutcome>();

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
    // One unmutated run over every test that will be mutated (inversion and,
    // when enabled, behavior). A test that is red or flaky on its own would
    // turn any red mutation run into a false "killed".
    const behaviorPlan = opts.behavior ? planBehaviorMutations(source, { testIds: opts.testIds }) : [];
    const baselineLines = [
      ...new Set([
        ...plan.mutations.filter((m) => 'mutatedSource' in m).map((m) => m.testLine),
        ...behaviorPlan.filter((m) => 'mutatedSource' in m).map((m) => m.testLine),
      ]),
    ].sort((a, b) => a - b);
    baseline = baselineLines.length > 0 ? await runBaseline(specPath, baselineLines, opts) : new Map();
    for (const [index, m] of plan.mutations.entries()) {
      if ('cannotMutate' in m) {
        results.push({
          testTitle: m.testTitle,
          testLine: m.testLine,
          assertLine: m.assertLine,
          verdict: 'cannot-mutate',
          reason: m.cannotMutate,
          ...(m.gateSkip !== undefined ? { gateSkip: m.gateSkip } : {}),
        });
        continue;
      }
      const base = baseline.get(m.testLine);
      if (base !== undefined && base.status !== 'passed') {
        results.push({
          testTitle: m.testTitle,
          testLine: m.testLine,
          assertLine: m.assertLine,
          verdict: base.status === 'skipped' ? 'cannot-mutate' : base.status,
          reason: base.reason,
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
    malformedGateSkipLines: plan.malformedGateSkipLines,
  };

  if (opts.behavior) {
    result.behavior = await runBehaviorPass(specPath, source, plan.onlyTestLines, opts, baseline);
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
  baseline: Map<number, BaselineOutcome>,
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
    const base = baseline.get(m.testLine);
    if (base !== undefined && base.status !== 'passed') {
      // Same rule as inversion: a red mutation run over a test that is red or
      // flaky on its own proves nothing. Skipped maps to cannot-locate, as a
      // runtime skip already does in this pass.
      results.push({
        testTitle: m.testTitle,
        testLine: m.testLine,
        assertLine: m.assertLine,
        verdict: base.status === 'skipped' ? 'cannot-locate' : 'error',
        value: m.value,
        reason: base.status === 'skipped' ? base.reason : `${base.status}: ${base.reason}`,
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
