import type { BehaviorVerdict, SpecResult, Verdict } from './run.js';

export interface GateOptions {
  /** When true (default), tests without a @primary-assert marker fail the gate. */
  requireSentinel: boolean;
  /** "Today" for @gate-skip expiry checks; defaults to the current date. */
  now?: Date;
}

/** Format a date as YYYY-MM-DD in local time, so expiry compares lexically. */
function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface Summary {
  killed: number;
  survived: number;
  cannotMutate: number;
  errors: number;
  /**
   * Added in 0.4.0, each fails the gate. `baselineFailed`: the test is red
   * without any mutation. `flaky`: the unmutated or the mutated run failed and
   * then passed on retry. `killedElsewhere`: the mutated test went red, but not
   * on the inverted assertion.
   */
  baselineFailed: number;
  flaky: number;
  killedElsewhere: number;
  unmarkedTests: number;
  strayMarkers: number;
  malformedMarkers: number;
  /**
   * @gate-skip tallies. `acknowledgedSkips`: cannot-mutate verdicts covered by
   * a valid, unexpired acknowledgement - accepted, does NOT fail the gate.
   * `expiredSkips`: the acknowledgement's expires date has passed, so the skip
   * fails closed again. `malformedGateSkip`: a @gate-skip that does not parse or
   * is misplaced - fails the gate, like a malformed @primary-assert.
   */
  acknowledgedSkips: number;
  expiredSkips: number;
  malformedGateSkip: number;
  /**
   * Behavior mutation tallies, present only when the behavior pass ran.
   * `behaviorKilled`: the test caught the corrupted value. `weak`: the test
   * stayed green while the value it names was broken (a hollow assertion) -
   * this fails the gate. `behaviorCannotLocate`: the value could not be found
   * in a rewritable response - reported honestly and, unlike inversion's
   * cannot-mutate, does NOT fail the gate (a value not living in an
   * interceptable response is expected, not a defect). `behaviorErrors`: the
   * behavior run itself failed - fails the gate.
   */
  behaviorRan: boolean;
  behaviorKilled: number;
  weak: number;
  behaviorCannotLocate: number;
  behaviorErrors: number;
  /**
   * Green means proven: every marked assertion was killed under inversion and
   * nothing was left unverified. Any survived, cannot-mutate, error,
   * baseline-failed, flaky or killed-elsewhere verdict
   * fails the gate, as do marker mistakes (stray or malformed markers) and,
   * under require-sentinel, tests with no marker at all. When the behavior pass
   * ran, any weak or behavior-error verdict also fails the gate.
   */
  gatePassed: boolean;
}

export function summarize(specs: SpecResult[], opts: GateOptions): Summary {
  const s: Summary = {
    killed: 0,
    survived: 0,
    cannotMutate: 0,
    errors: 0,
    baselineFailed: 0,
    flaky: 0,
    killedElsewhere: 0,
    unmarkedTests: 0,
    strayMarkers: 0,
    malformedMarkers: 0,
    acknowledgedSkips: 0,
    expiredSkips: 0,
    malformedGateSkip: 0,
    behaviorRan: false,
    behaviorKilled: 0,
    weak: 0,
    behaviorCannotLocate: 0,
    behaviorErrors: 0,
    gatePassed: true,
  };
  const today = ymd(opts.now ?? new Date());
  for (const spec of specs) {
    for (const m of spec.results) {
      if (m.verdict === 'killed') s.killed++;
      else if (m.verdict === 'survived') s.survived++;
      else if (m.verdict === 'baseline-failed') s.baselineFailed++;
      else if (m.verdict === 'flaky') s.flaky++;
      else if (m.verdict === 'killed-elsewhere') s.killedElsewhere++;
      else if (m.verdict === 'cannot-mutate') {
        // A cannot-mutate covered by a valid @gate-skip is accepted until it
        // expires; expired ones fail closed again. Uncovered ones fail as before.
        if (m.gateSkip === undefined) s.cannotMutate++;
        else if (today > m.gateSkip.expires) s.expiredSkips++;
        else s.acknowledgedSkips++;
      } else s.errors++;
    }
    s.unmarkedTests += spec.unmarkedTests.length;
    s.strayMarkers += spec.strayMarkerLines.length;
    s.malformedMarkers += spec.malformedMarkerLines.length;
    s.malformedGateSkip += spec.malformedGateSkipLines.length;
    if (spec.behavior !== undefined) {
      s.behaviorRan = true;
      for (const b of spec.behavior) {
        if (b.verdict === 'killed') s.behaviorKilled++;
        else if (b.verdict === 'weak') s.weak++;
        else if (b.verdict === 'cannot-locate') s.behaviorCannotLocate++;
        else s.behaviorErrors++;
      }
    }
  }
  s.gatePassed =
    s.survived === 0 &&
    s.cannotMutate === 0 &&
    s.errors === 0 &&
    s.baselineFailed === 0 &&
    s.flaky === 0 &&
    s.killedElsewhere === 0 &&
    s.strayMarkers === 0 &&
    s.malformedMarkers === 0 &&
    s.expiredSkips === 0 &&
    s.malformedGateSkip === 0 &&
    (!opts.requireSentinel || s.unmarkedTests === 0) &&
    s.weak === 0 &&
    s.behaviorErrors === 0;
  return s;
}

const BEHAVIOR_VERDICT_COLOR: Record<BehaviorVerdict, string> = {
  killed: '\x1b[32m',
  weak: '\x1b[31m',
  'cannot-locate': '\x1b[33m',
  error: '\x1b[33m',
};

export function jsonReport(specs: SpecResult[], opts: GateOptions): string {
  return JSON.stringify({ specs, summary: summarize(specs, opts) }, null, 2);
}

const RESET = '\x1b[0m';
const VERDICT_COLOR: Record<Verdict, string> = {
  killed: '\x1b[32m',
  survived: '\x1b[31m',
  'cannot-mutate': '\x1b[33m',
  error: '\x1b[33m',
  'baseline-failed': '\x1b[31m',
  flaky: '\x1b[33m',
  'killed-elsewhere': '\x1b[31m',
};

const TITLE_WIDTH = 48;

function clip(title: string): string {
  return title.length <= TITLE_WIDTH ? title : title.slice(0, TITLE_WIDTH - 3) + '...';
}

export interface RenderOptions extends GateOptions {
  color: boolean;
}

/**
 * Human-readable report: per spec, one row per verdict plus sentinel findings,
 * then a one-line summary and the gate outcome.
 */
export function renderTable(specs: SpecResult[], opts: RenderOptions): string {
  const paint = (color: string, text: string): string =>
    opts.color ? color + text + RESET : text;

  const labelWidth = 'killed-elsewhere'.length;
  const titleWidth = Math.min(
    TITLE_WIDTH,
    Math.max(
      4,
      ...specs.flatMap((spec) => [
        ...spec.results.map((m) => clip(m.testTitle).length),
        ...spec.unmarkedTests.map((t) => clip(t.title).length),
        ...(spec.behavior ?? []).map((b) => clip(b.testTitle).length),
      ]),
    ),
  );
  const row = (label: string, color: string, title: string, line: string): string =>
    '  ' + paint(color, label.padEnd(labelWidth)) + '  ' + clip(title).padEnd(titleWidth) + '  ' + line;

  const today = ymd(opts.now ?? new Date());
  const lines: string[] = [];
  for (const spec of specs) {
    lines.push(spec.specPath);
    for (const m of spec.results) {
      const at = m.assertLine === null ? ':?' : `:${m.assertLine}`;
      // An acknowledged (unexpired) @gate-skip reads as accepted, not failing;
      // an expired one reads as a failure that fell back closed.
      if (m.verdict === 'cannot-mutate' && m.gateSkip !== undefined) {
        const expired = today > m.gateSkip.expires;
        const label = expired ? 'expired-skip' : 'acknowledged';
        const color = expired ? '\x1b[31m' : '\x1b[32m';
        lines.push(row(label, color, m.testTitle, at));
        const gs = m.gateSkip;
        const detail =
          `owner=${gs.owner} expires=${gs.expires}` +
          (gs.reason !== undefined ? ` reason="${gs.reason}"` : '') +
          (expired ? ' (EXPIRED)' : '');
        lines.push('  ' + ' '.repeat(labelWidth) + '  ' + detail);
        continue;
      }
      lines.push(row(m.verdict, VERDICT_COLOR[m.verdict], m.testTitle, at));
      if (m.reason !== undefined) {
        lines.push('  ' + ' '.repeat(labelWidth) + '  ' + m.reason);
      }
    }
    for (const t of spec.unmarkedTests) {
      lines.push(row('unmarked', VERDICT_COLOR['cannot-mutate'], t.title, `:${t.line}`));
    }
    for (const line of spec.strayMarkerLines) {
      lines.push(`  marker outside any test() block at line ${line}`);
    }
    for (const line of spec.malformedMarkerLines) {
      lines.push(`  malformed @primary-assert marker at line ${line}`);
    }
    for (const line of spec.malformedGateSkipLines) {
      lines.push(`  malformed @gate-skip marker at line ${line} (needs owner= and a valid expires=YYYY-MM-DD on a test)`);
    }
    if (spec.behavior !== undefined && spec.behavior.length > 0) {
      lines.push('  behavior:');
      for (const b of spec.behavior) {
        const at = b.assertLine === null ? ':?' : `:${b.assertLine}`;
        lines.push(row(b.verdict, BEHAVIOR_VERDICT_COLOR[b.verdict], b.testTitle, at));
        if (b.reason !== undefined) {
          lines.push('  ' + ' '.repeat(labelWidth) + '  ' + b.reason);
        }
      }
    }
    lines.push('');
  }

  const s = summarize(specs, opts);
  const counts = [
    `${s.killed} killed`,
    `${s.survived} survived`,
    `${s.cannotMutate} cannot-mutate`,
    `${s.errors} errors`,
  ];
  if (s.baselineFailed > 0) counts.push(`${s.baselineFailed} baseline-failed`);
  if (s.flaky > 0) counts.push(`${s.flaky} flaky`);
  if (s.killedElsewhere > 0) counts.push(`${s.killedElsewhere} killed-elsewhere`);
  if (s.unmarkedTests > 0) {
    counts.push(
      `${s.unmarkedTests} unmarked ${s.unmarkedTests === 1 ? 'test' : 'tests'}` +
        (opts.requireSentinel ? '' : ' (not enforced)'),
    );
  }
  if (s.acknowledgedSkips > 0) counts.push(`${s.acknowledgedSkips} acknowledged`);
  if (s.expiredSkips > 0) counts.push(`${s.expiredSkips} expired-skip`);
  lines.push(counts.join(', '));
  if (s.behaviorRan) {
    lines.push(
      'behavior: ' +
        [
          `${s.behaviorKilled} killed`,
          `${s.weak} weak`,
          `${s.behaviorCannotLocate} cannot-locate`,
          `${s.behaviorErrors} errors`,
        ].join(', '),
    );
  }
  lines.push(
    s.gatePassed
      ? paint('\x1b[1;32m', 'Gate passed: every marked assertion can fail.')
      : paint('\x1b[1;31m', 'Gate FAILED: hollow, unverified or broken assertions above.'),
  );
  return lines.join('\n');
}
