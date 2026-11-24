import { describe, expect, it } from 'vitest';

import { gateFailures, githubAnnotations, jsonReport, mutationRecords, renderTable, summarize } from '../src/report.js';
import type { SpecResult } from '../src/run.js';

const spec = (over: Partial<SpecResult> = {}): SpecResult => ({
  specPath: 'fixtures/demo.spec.ts',
  results: [],
  unmarkedTests: [],
  strayMarkerLines: [],
  malformedMarkerLines: [],
  malformedGateSkipLines: [],
  ...over,
});

const killed = { testTitle: 'live assert', testLine: 3, assertLine: 5, verdict: 'killed' as const };
const survived = {
  testTitle: 'hollow assert',
  testLine: 10,
  assertLine: 12,
  verdict: 'survived' as const,
};

const STRICT = { requireSentinel: true };
const LAX = { requireSentinel: false };

describe('summarize / gate verdict', () => {
  it('passes when every mutation is killed and nothing is unverified', () => {
    const s = summarize([spec({ results: [killed] })], STRICT);
    expect(s).toMatchObject({ killed: 1, survived: 0, gatePassed: true });
  });

  it.each([
    ['survived', { results: [survived] }],
    [
      'cannot-mutate',
      {
        results: [
          { testTitle: 't', testLine: 1, assertLine: 2, verdict: 'cannot-mutate' as const, reason: 'multi-line' },
        ],
      },
    ],
    [
      'error',
      {
        results: [
          { testTitle: 't', testLine: 1, assertLine: 2, verdict: 'error' as const, reason: 'timed out' },
        ],
      },
    ],
    ['stray marker', { strayMarkerLines: [4] }],
    ['malformed marker', { malformedMarkerLines: [7] }],
  ])('fails on %s even when other mutations are killed', (_name, over) => {
    const s = summarize([spec({ results: [killed] }), spec(over as Partial<SpecResult>)], STRICT);
    expect(s.gatePassed).toBe(false);
  });

  it.each([
    ['baseline-failed', 'baselineFailed'],
    ['flaky', 'flaky'],
    ['killed-elsewhere', 'killedElsewhere'],
  ] as const)('counts %s separately and fails the gate on it', (verdict, counter) => {
    const r = { testTitle: 't', testLine: 1, assertLine: 2, verdict, reason: 'why' };
    const s = summarize([spec({ results: [killed, r] })], STRICT);
    expect(s[counter]).toBe(1);
    expect(s.killed).toBe(1);
    expect(s.errors).toBe(0);
    expect(s.gatePassed).toBe(false);
    const table = renderTable([spec({ results: [r] })], { ...STRICT, color: false });
    expect(table).toContain(verdict);
    expect(table).toContain('why');
    expect(table).toContain(`1 ${verdict}`);
  });

  it('fails on unmarked tests only under require-sentinel', () => {
    const specs = [spec({ results: [killed], unmarkedTests: [{ title: 'bare', line: 20 }] })];
    expect(summarize(specs, STRICT).gatePassed).toBe(false);
    expect(summarize(specs, LAX).gatePassed).toBe(true);
  });

  it('counts across multiple specs', () => {
    const s = summarize(
      [spec({ results: [killed, survived] }), spec({ results: [killed] })],
      STRICT,
    );
    expect(s).toMatchObject({ killed: 2, survived: 1, gatePassed: false });
  });
});

describe('renderTable', () => {
  const specs = [
    spec({
      results: [
        killed,
        survived,
        { testTitle: 'stuck', testLine: 20, assertLine: null, verdict: 'error' as const, reason: 'timed out' },
      ],
      unmarkedTests: [{ title: 'bare', line: 30 }],
      strayMarkerLines: [2],
      malformedMarkerLines: [40],
    }),
  ];

  it('lists spec, tests, lines, verdicts, reasons and sentinel findings', () => {
    const out = renderTable(specs, { color: false, requireSentinel: true });
    expect(out).toContain('fixtures/demo.spec.ts');
    expect(out).toContain('killed');
    expect(out).toContain('survived');
    expect(out).toContain('hollow assert');
    expect(out).toContain(':12');
    expect(out).toContain(':?');
    expect(out).toContain('timed out');
    expect(out).toContain('unmarked');
    expect(out).toContain('bare');
    expect(out).toContain('marker outside any test() block at line 2');
    expect(out).toContain('malformed @primary-assert marker at line 40');
    expect(out).toContain('1 killed, 1 survived, 0 cannot-mutate, 1 errors');
    expect(out).toContain('Gate FAILED');
  });

  it('emits no ANSI codes when color is off and does when on', () => {
    const plain = renderTable(specs, { color: false, requireSentinel: true });
    expect(plain).not.toContain('\x1b[');
    const colored = renderTable(specs, { color: true, requireSentinel: true });
    expect(colored).toContain('\x1b[32mkilled');
    expect(colored).toContain('\x1b[31msurvived');
  });

  it('reports a passing gate', () => {
    const out = renderTable([spec({ results: [killed] })], { color: false, requireSentinel: true });
    expect(out).toContain('Gate passed');
  });

  it('marks unmarked tests as not enforced without sentinel', () => {
    const out = renderTable(
      [spec({ results: [killed], unmarkedTests: [{ title: 'bare', line: 9 }] })],
      { color: false, requireSentinel: false },
    );
    expect(out).toContain('1 unmarked test (not enforced)');
    expect(out).toContain('Gate passed');
  });

  it('clips very long test titles', () => {
    const long = 'x'.repeat(120);
    const out = renderTable(
      [spec({ results: [{ ...killed, testTitle: long }] })],
      { color: false, requireSentinel: true },
    );
    expect(out).not.toContain(long);
    expect(out).toContain('x'.repeat(45) + '...');
  });
});

describe('jsonReport', () => {
  it('round-trips the spec results plus a summary', () => {
    const specs = [spec({ results: [killed, survived], unmarkedTests: [{ title: 'bare', line: 30 }] })];
    const parsed = JSON.parse(jsonReport(specs, STRICT)) as {
      specs: SpecResult[];
      summary: { killed: number; survived: number; unmarkedTests: number; gatePassed: boolean };
    };
    expect(parsed.specs).toEqual(specs);
    expect(parsed.summary).toMatchObject({
      killed: 1,
      survived: 1,
      unmarkedTests: 1,
      gatePassed: false,
    });
  });
});

describe('machine output', () => {
  const failing = {
    testTitle: 'boot',
    testLine: 3,
    assertLine: 9,
    verdict: 'killed-elsewhere' as const,
    reason: 'the mutated test failed at a.spec.ts:4: Error: x, y',
  };

  it('lists one flat record per mutation, invert and behavior', () => {
    const specs = [
      spec({
        specPath: 'tests/a.spec.ts',
        results: [killed, failing],
        behavior: [{ testTitle: 'live assert', testLine: 3, assertLine: 5, verdict: 'weak', value: 'P', reason: 'green' }],
      }),
    ];
    expect(mutationRecords(specs)).toEqual([
      { mode: 'invert', verdict: 'killed', spec: 'tests/a.spec.ts', testTitle: 'live assert', testLine: 3, assertLine: 5, reason: null },
      { mode: 'invert', verdict: 'killed-elsewhere', spec: 'tests/a.spec.ts', testTitle: 'boot', testLine: 3, assertLine: 9, reason: failing.reason },
      { mode: 'behavior', verdict: 'weak', spec: 'tests/a.spec.ts', testTitle: 'live assert', testLine: 3, assertLine: 5, reason: 'green' },
    ]);
    const parsed = JSON.parse(jsonReport(specs, STRICT)) as { mutations: unknown[] };
    expect(parsed.mutations).toHaveLength(3);
  });

  it('gate failures match the gate verdict', () => {
    expect(gateFailures([spec({ results: [killed] })], STRICT)).toEqual([]);
    const f = gateFailures(
      [spec({ results: [killed, survived], unmarkedTests: [{ title: 'bare', line: 20 }], strayMarkerLines: [30] })],
      STRICT,
    );
    expect(f.map((x) => x.line)).toEqual([survived.assertLine, 20, 30]);
    expect(f[0]!.message).toContain('survived');
    expect(gateFailures([spec({ unmarkedTests: [{ title: 'bare', line: 20 }] })], LAX)).toEqual([]);
  });

  it('prints escaped GitHub ::error annotations with a cwd-relative path', () => {
    const lines = githubAnnotations([spec({ specPath: '/repo/tests/a,b.spec.ts', results: [failing] })], STRICT, '/repo');
    expect(lines).toEqual([
      '::error file=tests/a%2Cb.spec.ts,line=9,title=mutation gate::killed-elsewhere: the mutated test failed at a.spec.ts:4: Error: x, y',
    ]);
    const nl = githubAnnotations([spec({ results: [{ ...failing, reason: '50%\nsecond' }] })], STRICT, '/');
    expect(nl[0]).toContain('50%25%0Asecond');
  });
});
