import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { analyzeSpec, isValidYmd, parseGateSkip, planSpecMutations } from '../src/mutate.js';
import { summarize } from '../src/report.js';
import { runSpec, type SpecResult } from '../src/run.js';

describe('parseGateSkip', () => {
  it('parses owner, expires and reason', () => {
    expect(parseGateSkip('// @gate-skip owner=vlad expires=2026-08-15 reason="redesign in flight"')).toEqual({
      owner: 'vlad',
      expires: '2026-08-15',
      reason: 'redesign in flight',
    });
  });
  it('parses without a reason', () => {
    expect(parseGateSkip('// @gate-skip owner=vlad expires=2026-08-15')).toEqual({
      owner: 'vlad',
      expires: '2026-08-15',
    });
  });
  it('rejects a missing owner', () => {
    expect(parseGateSkip('// @gate-skip expires=2026-08-15')).toBeNull();
  });
  it('rejects a missing expires', () => {
    expect(parseGateSkip('// @gate-skip owner=vlad')).toBeNull();
  });
  it('rejects an unparseable date', () => {
    expect(parseGateSkip('// @gate-skip owner=vlad expires=soon')).toBeNull();
    expect(parseGateSkip('// @gate-skip owner=vlad expires=2026-13-40')).toBeNull();
  });
  it('rejects a comment that is not a @gate-skip', () => {
    expect(parseGateSkip('// @primary-assert')).toBeNull();
  });
});

describe('isValidYmd', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isValidYmd('2026-02-28')).toBe(true);
    expect(isValidYmd('2026-02-30')).toBe(false);
    expect(isValidYmd('2026-1-1')).toBe(false);
    expect(isValidYmd('not-a-date')).toBe(false);
  });
});

const skipSpec = (marker: string): string =>
  `import { test, expect } from '@playwright/test';\n` +
  `${marker}\n` +
  `test.skip('t', async ({ page }) => {\n  // @primary-assert\n  await expect(el).toBeVisible();\n});\n`;

describe('analyzeSpec / planSpecMutations: @gate-skip attachment', () => {
  it('attaches a valid marker above the test to its cannot-mutate mutation', () => {
    const plan = planSpecMutations(skipSpec('// @gate-skip owner=vlad expires=2026-08-15 reason="x"'));
    expect(plan.mutations).toHaveLength(1);
    const m = plan.mutations[0]!;
    expect('cannotMutate' in m).toBe(true);
    expect((m as { gateSkip?: unknown }).gateSkip).toEqual({ owner: 'vlad', expires: '2026-08-15', reason: 'x' });
    expect(plan.malformedGateSkipLines).toEqual([]);
  });
  it('attaches a trailing marker on the declaration line', () => {
    const src =
      `import { test, expect } from '@playwright/test';\n` +
      `test.skip('t', async ({ page }) => { // @gate-skip owner=v expires=2030-01-01\n  // @primary-assert\n  await expect(el).toBeVisible();\n});\n`;
    const a = analyzeSpec(src);
    expect(a.markedTests[0]!.gateSkip).toEqual({ owner: 'v', expires: '2030-01-01' });
    expect(a.malformedGateSkipLines).toEqual([]);
  });
  it('flags a malformed marker (bad date)', () => {
    const a = analyzeSpec(skipSpec('// @gate-skip owner=vlad expires=nope'));
    expect(a.markedTests[0]!.gateSkip).toBeUndefined();
    expect(a.malformedGateSkipLines).toEqual([2]);
  });
  it('flags an orphan marker that decorates no test', () => {
    const src = `import { test } from '@playwright/test';\n// @gate-skip owner=v expires=2030-01-01\nconst x = 1;\n`;
    expect(analyzeSpec(src).malformedGateSkipLines).toEqual([2]);
  });
});

const cmResult = (gateSkip?: SpecResult['results'][number]['gateSkip']): SpecResult => ({
  specPath: 'f.spec.ts',
  results: [{ testTitle: 't', testLine: 3, assertLine: 5, verdict: 'cannot-mutate', reason: 'skip', gateSkip }],
  unmarkedTests: [],
  strayMarkerLines: [],
  malformedMarkerLines: [],
  malformedGateSkipLines: [],
});

describe('summarize: @gate-skip gate policy', () => {
  const now = new Date('2026-07-19T00:00:00Z');
  it('an unexpired acknowledgement passes the gate', () => {
    const s = summarize([cmResult({ owner: 'v', expires: '2026-08-15' })], { requireSentinel: true, now });
    expect(s.acknowledgedSkips).toBe(1);
    expect(s.cannotMutate).toBe(0);
    expect(s.gatePassed).toBe(true);
  });
  it('an expired acknowledgement fails the gate', () => {
    const s = summarize([cmResult({ owner: 'v', expires: '2026-07-01' })], { requireSentinel: true, now });
    expect(s.expiredSkips).toBe(1);
    expect(s.gatePassed).toBe(false);
  });
  it('the expiry day itself is still acknowledged', () => {
    const s = summarize([cmResult({ owner: 'v', expires: '2026-07-19' })], { requireSentinel: true, now });
    expect(s.acknowledgedSkips).toBe(1);
    expect(s.gatePassed).toBe(true);
  });
  it('an uncovered cannot-mutate still fails', () => {
    const s = summarize([cmResult()], { requireSentinel: true, now });
    expect(s.cannotMutate).toBe(1);
    expect(s.gatePassed).toBe(false);
  });
  it('a malformed @gate-skip fails the gate', () => {
    const spec = { ...cmResult(), malformedGateSkipLines: [7] };
    expect(summarize([spec], { requireSentinel: true, now }).gatePassed).toBe(false);
  });
});

describe('runSpec: acknowledged-skip fixture (no Playwright spawn)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  it('reports the skipped test as cannot-mutate carrying its @gate-skip', async () => {
    const result = await runSpec(join(root, 'fixtures', 'acknowledged-skip.spec.ts'), { cwd: root });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      verdict: 'cannot-mutate',
      gateSkip: { owner: 'vlad', expires: '2099-01-01', reason: 'checkout redesign in flight' },
    });
    expect(result.malformedGateSkipLines).toEqual([]);
    // With the far-future expiry, the gate accepts it.
    expect(summarize([result], { requireSentinel: true }).gatePassed).toBe(true);
  });
});
