import type { BehaviorVerdict, SpecResult, Verdict } from './run.js';

export interface GateOptions {
  /** When true (default), tests without a @primary-assert marker fail the gate. */
  requireSentinel: boolean;
}

export interface Summary {
  killed: number;
  survived: number;
  cannotMutate: number;
  errors: number;
  unmarkedTests: number;
  strayMarkers: number;
  malformedMarkers: number;
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
   * nothing was left unverified. Any survived, cannot-mutate or error verdict
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
    unmarkedTests: 0,
    strayMarkers: 0,
    malformedMarkers: 0,
    behaviorRan: false,
    behaviorKilled: 0,
    weak: 0,
    behaviorCannotLocate: 0,
    behaviorErrors: 0,
    gatePassed: true,
  };
  for (const spec of specs) {
    for (const m of spec.results) {
      if (m.verdict === 'killed') s.killed++;
      else if (m.verdict === 'survived') s.survived++;
      else if (m.verdict === 'cannot-mutate') s.cannotMutate++;
      else s.errors++;
    }
    s.unmarkedTests += spec.unmarkedTests.length;
    s.strayMarkers += spec.strayMarkerLines.length;
    s.malformedMarkers += spec.malformedMarkerLines.length;
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
    s.strayMarkers === 0 &&
    s.malformedMarkers === 0 &&
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

  const labelWidth = 'cannot-mutate'.length;
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

  const lines: string[] = [];
  for (const spec of specs) {
    lines.push(spec.specPath);
    for (const m of spec.results) {
      const at = m.assertLine === null ? ':?' : `:${m.assertLine}`;
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
  if (s.unmarkedTests > 0) {
    counts.push(
      `${s.unmarkedTests} unmarked ${s.unmarkedTests === 1 ? 'test' : 'tests'}` +
        (opts.requireSentinel ? '' : ' (not enforced)'),
    );
  }
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
