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
});
