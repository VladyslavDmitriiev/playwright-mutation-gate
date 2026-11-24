import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runSpec } from '../src/run.js';

// The package's reality baseline: verdicts are asserted against real
// Playwright exit behavior on the fixture site, not against unit fakes.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'fixtures');

const leftoverCopies = (): string[] =>
  readdirSync(fixturesDir).filter((f) => f.includes('.pmg-mutation-'));

describe('mutation gate against the fixture site', () => {
  it('kills the honest spec: the inverted live assertion fails the run', async () => {
    const result = await runSpec(join(fixturesDir, 'honest.spec.ts'), { cwd: root });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ testTitle: expect.any(String), verdict: 'killed' });
    expect(result.unmarkedTests).toEqual([]);
    expect(leftoverCopies()).toEqual([]);
  });

  it('sees the hollow spec survive: the guarded assertion never executes', async () => {
    const result = await runSpec(join(fixturesDir, 'hollow.spec.ts'), { cwd: root });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ verdict: 'survived' });
    expect(result.unmarkedTests).toEqual([]);
    expect(leftoverCopies()).toEqual([]);
  });

  it('acknowledges the gate-skipped spec without running anything', async () => {
    const result = await runSpec(join(fixturesDir, 'acknowledged-skip.spec.ts'), { cwd: root });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ verdict: 'cannot-mutate', gateSkip: expect.any(Object) });
  });
});

// Red-by-design fixtures: load only with PMG_GATE_FIXTURES (playwright.config.ts).
// The child Playwright process inherits process.env.
describe('baseline run against the fixture site', () => {
  const withGateFixtures = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env.PMG_GATE_FIXTURES = '1';
    try {
      return await fn();
    } finally {
      delete process.env.PMG_GATE_FIXTURES;
    }
  };

  it('reports baseline-failed, not killed, when the test is red before its assertion', async () => {
    const result = await withGateFixtures(() => runSpec(join(fixturesDir, 'broken-setup.spec.ts'), { cwd: root }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ verdict: 'baseline-failed' });
    expect(result.results[0]!.reason).toContain('broken-setup.spec.ts:9');
    expect(leftoverCopies()).toEqual([]);
  });

  it('reports flaky, not killed, when the test fails and then passes on retry', async () => {
    const result = await withGateFixtures(() => runSpec(join(fixturesDir, 'flaky-assert.spec.ts'), { cwd: root }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ verdict: 'flaky' });
    expect(leftoverCopies()).toEqual([]);
  });
});

describe('behavior mutation against the fixture site', () => {
  it('kills the strong spec: corrupting the rendered value fails the assertion', async () => {
    const result = await runSpec(join(fixturesDir, 'behavior-strong.spec.ts'), { cwd: root, behavior: true });
    expect(result.behavior).toHaveLength(1);
    expect(result.behavior![0]).toMatchObject({ verdict: 'killed', value: 'Premium' });
    expect(leftoverCopies()).toEqual([]);
  });

  it('flags the weak spec: the value is corrupted but the assertion stays green', async () => {
    const result = await runSpec(join(fixturesDir, 'behavior-weak.spec.ts'), { cwd: root, behavior: true });
    expect(result.behavior).toHaveLength(1);
    expect(result.behavior![0]).toMatchObject({ verdict: 'weak', value: 'Premium' });
    expect(leftoverCopies()).toEqual([]);
  });

  it('reports cannot-locate when the assertion names no rewritable value', async () => {
    const result = await runSpec(join(fixturesDir, 'honest.spec.ts'), { cwd: root, behavior: true });
    expect(result.behavior).toHaveLength(1);
    expect(result.behavior![0]!.verdict).toBe('cannot-locate');
    expect(leftoverCopies()).toEqual([]);
  });
});
