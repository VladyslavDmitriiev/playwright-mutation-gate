import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { mutationFilePath, planSpecMutations, writeMutationFile } from '../src/mutate.js';
import type { Mutation, SpecPlan } from '../src/mutate.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

// Hard-failing narrowers, mirroring ok/cannot in invert.test.ts: a mutation of
// the wrong variant fails immediately instead of silently skipping assertions.
const okMutation = (plan: SpecPlan, i = 0): Extract<Mutation, { mutatedSource: string }> => {
  const m = plan.mutations[i];
  expect(m, `expected ok mutation, got ${JSON.stringify(m)}`).toHaveProperty('mutatedSource');
  return m as Extract<Mutation, { mutatedSource: string }>;
};

const cannotMutation = (plan: SpecPlan, i = 0): Extract<Mutation, { cannotMutate: string }> => {
  const m = plan.mutations[i];
  expect(m, `expected cannot-mutate, got ${JSON.stringify(m)}`).toHaveProperty('cannotMutate');
  return m as Extract<Mutation, { cannotMutate: string }>;
};

const changedLines = (before: string, after: string): number[] => {
  const a = before.split('\n');
  const b = after.split('\n');
  expect(b).toHaveLength(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [i + 1]));
};

describe('planSpecMutations: reference fixtures', () => {
  it('mutates exactly the marked assertion of honest.spec.ts', () => {
    const source = fixture('honest.spec.ts');
    const plan = planSpecMutations(source);
    expect(plan.unmarkedTests).toEqual([]);
    expect(plan.strayMarkerLines).toEqual([]);
    expect(plan.malformedMarkerLines).toEqual([]);
    expect(plan.mutations).toHaveLength(1);
    const m = okMutation(plan);
    expect(m.testTitle).toBe('shows an error for an invalid email');
    expect(m.testLine).toBe(5);
    expect(m.markerLine).toBe(9);
    expect(m.assertLine).toBe(10);
    expect(changedLines(source, m.mutatedSource)).toEqual([10]);
    expect(m.mutatedSource.split('\n')[9]).toContain('.not.toBeVisible()');
  });

  it('mutates exactly the marked assertion of hollow.spec.ts', () => {
    const source = fixture('hollow.spec.ts');
    const plan = planSpecMutations(source);
    expect(plan.mutations).toHaveLength(1);
    const m = okMutation(plan);
    expect(m.assertLine).toBe(11);
    expect(changedLines(source, m.mutatedSource)).toEqual([11]);
    expect(m.mutatedSource.split('\n')[10]).toContain('.not.toBeVisible()');
  });
});

describe('planSpecMutations: markers and test blocks', () => {
  it('lists runnable tests without a marker for sentinel accounting', () => {
    const plan = planSpecMutations(
      [
        "import { test, expect } from '@playwright/test';",
        "test('no marker here', async ({ page }) => {",
        '  await expect(page).toHaveTitle(/x/);',
        '});',
      ].join('\n'),
    );
    expect(plan.mutations).toEqual([]);
    expect(plan.unmarkedTests).toEqual([{ title: 'no marker here', line: 2 }]);
  });

  it('exempts unmarked test.skip/fixme/fail from sentinel accounting, not test.only', () => {
    const plan = planSpecMutations(
      [
        "test.skip('parked', async () => {});",
        "test.fixme('broken', async () => {});",
        "test.fail('expected to fail', async () => {});",
        "test.only('focused', async () => {});",
      ].join('\n'),
    );
    expect(plan.unmarkedTests).toEqual([{ title: 'focused', line: 4 }]);
    expect(plan.onlyTestLines).toEqual([4]);
  });

  it('reports test.only declaration lines so the runner can refuse the spec', () => {
    const plan = planSpecMutations(
      [
        "test('plain', async () => {});",
        "test.only('focused', async () => {});",
        "test . only('spaced', async () => {});",
      ].join('\n'),
    );
    expect(plan.onlyTestLines).toEqual([2, 3]);
  });

  it('mutates a marked test.only block', () => {
    const plan = planSpecMutations(
      [
        "test.only('focused', async ({ page }) => {",
        '  // @primary-assert',
        '  await expect(page.locator("#x")).toBeVisible();',
        '});',
      ].join('\n'),
    );
    expect(plan.mutations).toHaveLength(1);
    okMutation(plan);
  });

  it('reports a marker inside test.skip/fixme/fail as cannot-mutate, never a verdictable mutation', () => {
    const spec = (decl: string) =>
      [
        `${decl}('t', async () => {`,
        '  // @primary-assert',
        '  await expect(x).toBe(1);',
        '});',
      ].join('\n');
    expect(cannotMutation(planSpecMutations(spec('test.skip'))).cannotMutate).toContain(
      'never runs',
    );
    expect(cannotMutation(planSpecMutations(spec('test.fixme'))).cannotMutate).toContain(
      'never runs',
    );
    expect(cannotMutation(planSpecMutations(spec('test.fail'))).cannotMutate).toContain(
      'expects failure',
    );
  });

  it('recognizes the test.fail declaration form as a block (marker is not stray)', () => {
    const plan = planSpecMutations(
      [
        "test.fail('renders error page', async () => {",
        '  // @primary-assert',
        '  await expect(x).toBe(1);',
        '});',
      ].join('\n'),
    );
    expect(plan.strayMarkerLines).toEqual([]);
    expect(cannotMutation(plan).testTitle).toBe('renders error page');
  });

  it('reports two markers in one test as cannot-mutate', () => {
    const plan = planSpecMutations(
      [
        "test('greedy', async ({ page }) => {",
        '  // @primary-assert',
        '  await expect(page.locator("#a")).toBeVisible();',
        '  // @primary-assert',
        '  await expect(page.locator("#b")).toBeVisible();',
        '});',
      ].join('\n'),
    );
    expect(plan.mutations).toHaveLength(1);
    const m = cannotMutation(plan);
    expect(m.markerLine).toBe(2);
    expect(m.cannotMutate).toContain('2 @primary-assert markers');
  });

  it('reports a marker outside any test block as stray', () => {
    const plan = planSpecMutations(
      [
        '// @primary-assert',
        "test('fine', async ({ page }) => {",
        '  // @primary-assert',
        '  await expect(page.locator("#a")).toBeVisible();',
        '});',
      ].join('\n'),
    );
    expect(plan.strayMarkerLines).toEqual([1]);
    expect(plan.mutations).toHaveLength(1);
  });

  it('skips blank and comment-only lines between the marker and the assertion', () => {
    const source = [
      "test('gap', async ({ page }) => {",
      '  // @primary-assert',
      '',
      '  // expect(status).toBe(200) -- leftover comment, must not be mutated',
      '  await expect(page.locator("#a")).toBeVisible();',
      '});',
    ].join('\n');
    const plan = planSpecMutations(source);
    const m = okMutation(plan);
    expect(m.assertLine).toBe(5);
    expect(changedLines(source, m.mutatedSource)).toEqual([5]);
  });

  it('reports a marker with nothing after it as cannot-mutate', () => {
    const plan = planSpecMutations(["test('tail', async () => {});", '// @primary-assert'].join('\n'));
    expect(plan.strayMarkerLines).toEqual([2]);
    const inTest = planSpecMutations(
      ["test('tail', async () => {", '  // @primary-assert'].join('\n'),
    );
    expect(cannotMutation(inTest).cannotMutate).toContain('no code line follows');
  });

  it('propagates cannot-mutate from the inverter with the assert line', () => {
    const plan = planSpecMutations(
      [
        "test('no assert', async ({ page }) => {",
        '  // @primary-assert',
        "  await page.click('#submit');",
        '});',
      ].join('\n'),
    );
    const m = cannotMutation(plan);
    expect(m.assertLine).toBe(3);
    expect(m.cannotMutate).toContain('no expect()');
  });

  it('mutates only the marked test when several tests share a file', () => {
    const source = [
      "test('first', async ({ page }) => {",
      '  await expect(page.locator("#a")).toBeVisible();',
      '});',
      "test('second', async ({ page }) => {",
      '  // @primary-assert',
      '  await expect(page.locator("#b")).toBeVisible();',
      '});',
    ].join('\n');
    const plan = planSpecMutations(source);
    expect(plan.unmarkedTests).toEqual([{ title: 'first', line: 1 }]);
    const m = okMutation(plan);
    expect(m.testTitle).toBe('second');
    expect(m.testLine).toBe(4);
    expect(changedLines(source, m.mutatedSource)).toEqual([6]);
  });

  it('ignores test( inside strings, comments and member calls', () => {
    const plan = planSpecMutations(
      [
        'const s = "test(\'not a test\', () => {})";',
        'const t = `test(\'nor this\', () => {})`;',
        "// test('commented out', () => {})",
        'runner.test("member call", () => {});',
      ].join('\n'),
    );
    expect(plan.mutations).toEqual([]);
    expect(plan.unmarkedTests).toEqual([]);
  });

  it('attributes a marker inside a test whose title contains ")" correctly', () => {
    const plan = planSpecMutations(
      [
        "test('closes a paren ) in the title', async ({ page }) => {",
        '  // @primary-assert',
        '  await expect(page.locator("#a")).toBeVisible();',
        '});',
      ].join('\n'),
    );
    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0]!.testTitle).toBe('closes a paren ) in the title');
  });

  it('falls back to a placeholder for dynamic and interpolated titles', () => {
    const plan = planSpecMutations(
      [
        'test(`login as ${role}`, async ({ page }) => {',
        '  // @primary-assert',
        '  await expect(page.locator("#a")).toBeVisible();',
        '});',
        'test(titleVar, async ({ page }) => {',
        '  // @primary-assert',
        '  await expect(page.locator("#b")).toBeVisible();',
        '});',
        'test(`plain backtick title`, async ({ page }) => {',
        '  // @primary-assert',
        '  await expect(page.locator("#c")).toBeVisible();',
        '});',
      ].join('\n'),
    );
    expect(plan.mutations.map((m) => m.testTitle)).toEqual([
      '(dynamic title)',
      '(dynamic title)',
      'plain backtick title',
    ]);
  });
});

describe('planSpecMutations: regex literals do not corrupt the scan', () => {
  it('survives a backtick inside a regex literal before a marked test', () => {
    const source = [
      'const parts = s.split(/`/);',
      "test('later', async ({ page }) => {",
      '  // @primary-assert',
      "  await expect(page.locator('#a')).toBeVisible();",
      '});',
    ].join('\n');
    const plan = planSpecMutations(source);
    expect(plan.strayMarkerLines).toEqual([]);
    const m = okMutation(plan);
    expect(m.testTitle).toBe('later');
    expect(changedLines(source, m.mutatedSource)).toEqual([4]);
  });

  it('keeps block boundaries intact across a quote inside a regex literal', () => {
    const plan = planSpecMutations(
      [
        "test('first', async ({ page }) => {",
        "  await expect(page.getByText(/don't panic/)).toBeVisible();",
        '});',
        "test('second', async ({ page }) => {",
        '  // @primary-assert',
        "  await expect(page.locator('#b')).toBeVisible();",
        '});',
      ].join('\n'),
    );
    expect(plan.unmarkedTests).toEqual([{ title: 'first', line: 1 }]);
    expect(okMutation(plan).testTitle).toBe('second');
  });

  it('does not count an escaped paren inside a regex literal', () => {
    const plan = planSpecMutations(
      [
        "test('t', async ({ page }) => {",
        "  const clean = s.replace(/\\)/g, '');",
        '  // @primary-assert',
        "  await expect(page.locator('#a')).toBeVisible();",
        '});',
      ].join('\n'),
    );
    expect(plan.strayMarkerLines).toEqual([]);
    expect(okMutation(plan).assertLine).toBe(4);
  });
});

describe('planSpecMutations: marker hygiene', () => {
  it('ignores marker text inside a block comment but reports it as malformed', () => {
    const plan = planSpecMutations(
      [
        "test('healthy', async ({ page }) => {",
        '  /*',
        '  // @primary-assert',
        '  await expect(old).toBe(1);',
        '  */',
        '  // @primary-assert',
        "  await expect(page.locator('#a')).toBeVisible();",
        '});',
      ].join('\n'),
    );
    expect(plan.malformedMarkerLines).toEqual([3]);
    expect(okMutation(plan).assertLine).toBe(7);
  });

  it('reports near-miss markers as malformed instead of silently ignoring them', () => {
    const plan = planSpecMutations(
      [
        "test('t', async ({ page }) => {",
        '  // @primary-assert: login error',
        "  await expect(page.locator('#a')).toBeVisible();",
        '});',
      ].join('\n'),
    );
    expect(plan.malformedMarkerLines).toEqual([2]);
    expect(plan.mutations).toEqual([]);
    expect(plan.unmarkedTests.map((t) => t.title)).toEqual(['t']);
  });
});

describe('planSpecMutations: trailing markers', () => {
  it('mutates the assertion when the marker trails it on the same line', () => {
    const source = [
      "test('t', async ({ page }) => {",
      "  await expect(page.locator('#a')).toBeVisible(); // @primary-assert",
      '});',
    ].join('\n');
    const plan = planSpecMutations(source);
    const m = okMutation(plan);
    expect(m.markerLine).toBe(2);
    expect(m.assertLine).toBe(2);
    expect(plan.malformedMarkerLines).toEqual([]);
    expect(plan.unmarkedTests).toEqual([]);
    // The inverted matcher lands on the marker's own line; the marker survives.
    expect(changedLines(source, m.mutatedSource)).toEqual([2]);
    expect(m.mutatedSource.split('\n')[1]).toBe(
      "  await expect(page.locator('#a')).not.toBeVisible(); // @primary-assert",
    );
  });

  it('inverts a negated assertion carrying a trailing marker', () => {
    const plan = planSpecMutations(
      [
        "test('t', async ({ page }) => {",
        '  await expect(page).not.toHaveURL(/\\/search\\//); // @primary-assert',
        '});',
      ].join('\n'),
    );
    const m = okMutation(plan);
    expect(m.assertLine).toBe(2);
    expect(m.mutatedSource.split('\n')[1]).toBe(
      '  await expect(page).toHaveURL(/\\/search\\//); // @primary-assert',
    );
  });

  it('handles soft assertions with a trailing marker', () => {
    const plan = planSpecMutations(
      [
        "test('t', async ({ page }) => {",
        '  await expect.soft(page.locator("#a")).toHaveText("x"); // @primary-assert',
        '});',
      ].join('\n'),
    );
    const m = okMutation(plan);
    expect(m.assertLine).toBe(2);
    expect(m.mutatedSource.split('\n')[1]).toContain('.not.toHaveText');
  });

  it('cannot mutate a trailing marker on a continuation line (no expect there)', () => {
    // The natural but unmutatable case: marker trails the closing paren of a
    // multi-line assertion, so its own line holds no expect() call.
    const plan = planSpecMutations(
      [
        "test('t', async ({ page }) => {",
        '  await expect(page).toHaveURL(',
        '    /\\/dashboard/,',
        '  ); // @primary-assert',
        '});',
      ].join('\n'),
    );
    const m = cannotMutation(plan);
    expect(m.markerLine).toBe(4);
    expect(m.assertLine).toBe(4);
    expect(m.cannotMutate).toBe('no expect() call found on this line');
  });
});

describe('planSpecMutations: custom test fixtures', () => {
  it('auto-detects a local test.extend() alias', () => {
    const src = [
      "import { test as base } from '@playwright/test';",
      'const authedTest = base.extend({ session: async ({}, use) => use(1) });',
      "authedTest('sees dashboard', async ({ page }) => {",
      '  await expect(page.getByText("Hi")).toBeVisible(); // @primary-assert',
      '});',
    ].join('\n');
    const plan = planSpecMutations(src);
    expect(plan.strayMarkerLines).toEqual([]);
    expect(plan.malformedMarkerLines).toEqual([]);
    expect(plan.unmarkedTests).toEqual([]);
    const m = okMutation(plan);
    expect(m.testTitle).toBe('sees dashboard');
    expect(changedLines(src, m.mutatedSource)).toEqual([4]);
  });

  it('follows a chained extend (b = a.extend)', () => {
    const src = [
      'const a = test.extend({});',
      'const b = a.extend({});',
      "b('t', async ({ page }) => {",
      '  expect(1).toBe(1); // @primary-assert',
      '});',
    ].join('\n');
    const plan = planSpecMutations(src);
    expect(plan.mutations).toHaveLength(1);
    expect(plan.strayMarkerLines).toEqual([]);
  });

  it('recognizes a renamed import as a test builder', () => {
    const src = [
      "import { test as authedTest } from './fixtures';",
      "authedTest('t', async ({ page }) => {",
      '  expect(1).toBe(1); // @primary-assert',
      '});',
    ].join('\n');
    const plan = planSpecMutations(src);
    expect(plan.mutations).toHaveLength(1);
    expect(plan.strayMarkerLines).toEqual([]);
  });

  it('needs --test-id for a fixture imported by its own name', () => {
    const src = [
      "import { authedTest } from './fixtures';",
      "authedTest('t', async ({ page }) => {",
      '  expect(1).toBe(1); // @primary-assert',
      '});',
    ].join('\n');
    // Without the id, the call is invisible and its marker is stray.
    const blind = planSpecMutations(src);
    expect(blind.mutations).toEqual([]);
    expect(blind.strayMarkerLines).toEqual([3]);
    // With it, the block is planned like a normal test.
    const seen = planSpecMutations(src, { testIds: ['authedTest'] });
    expect(seen.mutations).toHaveLength(1);
    expect(seen.strayMarkerLines).toEqual([]);
  });

  it('handles a file mixing bare test and a custom fixture', () => {
    const src = [
      'const authedTest = test.extend({});',
      "test('anon', async ({ page }) => {",
      '  expect(1).toBe(1); // @primary-assert',
      '});',
      "authedTest('member', async ({ page }) => {",
      '  expect(2).toBe(2); // @primary-assert',
      '});',
    ].join('\n');
    const plan = planSpecMutations(src);
    expect(plan.mutations).toHaveLength(2);
    expect(plan.mutations.map((m) => m.testTitle)).toEqual(['anon', 'member']);
  });

  it('counts an unmarked custom-fixture test in the sentinel', () => {
    const src = [
      'const authedTest = test.extend({});',
      "authedTest('no marker here', async ({ page }) => {",
      '  expect(1).toBe(1);',
      '});',
    ].join('\n');
    const plan = planSpecMutations(src);
    expect(plan.mutations).toEqual([]);
    expect(plan.unmarkedTests).toEqual([{ title: 'no marker here', line: 2 }]);
  });
});

describe('planSpecMutations: runtime skip modifier vs declaration', () => {
  it('ignores a conditional skip modifier and keeps its enclosing test intact', () => {
    const src = [
      'const authedTest = test.extend({});',
      "authedTest('dormant', async ({ page }) => {",
      "  authedTest.skip(!process.env.SESSION, 'no session');",
      '  await expect(page.getByText("Hi")).toBeVisible(); // @primary-assert',
      '});',
    ].join('\n');
    const plan = planSpecMutations(src);
    // The .skip(!cond) call is not a block: one test, one marker, no strays.
    expect(plan.mutations).toHaveLength(1);
    expect(plan.strayMarkerLines).toEqual([]);
    const m = okMutation(plan);
    expect(m.testTitle).toBe('dormant');
    expect(changedLines(src, m.mutatedSource)).toEqual([4]);
  });

  it('still treats test.skip("title", fn) as a skipped declaration', () => {
    const src = [
      "test.skip('always skipped', async ({ page }) => {",
      '  expect(1).toBe(1); // @primary-assert',
      '});',
    ].join('\n');
    const plan = planSpecMutations(src);
    const m = cannotMutation(plan);
    expect(m.cannotMutate).toContain('never runs');
  });

  it('ignores a bare runtime test.skip(cond) with no enclosing marker', () => {
    const src = [
      "test('t', async ({ page }) => {",
      '  test.skip(process.env.CI === undefined);',
      '  expect(1).toBe(1); // @primary-assert',
      '});',
    ].join('\n');
    const plan = planSpecMutations(src);
    expect(plan.mutations).toHaveLength(1);
    expect(plan.unmarkedTests).toEqual([]);
  });
});

describe('mutation files', () => {
  it.each([
    { spec: 'fixtures/hollow.spec.ts', index: 1, path: 'fixtures/hollow.pmg-mutation-1.spec.ts' },
    { spec: 'checkout.test.mjs', index: 2, path: 'checkout.pmg-mutation-2.test.mjs' },
    { spec: 'checkout.e2e.ts', index: 0, path: 'checkout.pmg-mutation-0.e2e.ts' },
    { spec: 'plain.ts', index: 1, path: 'plain.pmg-mutation-1.ts' },
    { spec: 'no-extension', index: 1, path: 'no-extension.pmg-mutation-1' },
  ])('names the copy $path preserving the whole original tail', ({ spec, index, path }) => {
    expect(mutationFilePath(spec, index)).toBe(path);
  });

  it('appends the tag to the mutation segment', () => {
    expect(mutationFilePath('a.spec.ts', 3, 'zz')).toBe('a.pmg-mutation-3-zz.spec.ts');
  });

  const dir = mkdtempSync(join(tmpdir(), 'pmg-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the mutated copy next to the spec with a process-unique name', () => {
    const written = writeMutationFile(join(dir, 'sample.spec.ts'), 1, 'mutated content\n');
    expect(written).toBe(
      join(dir, `sample.pmg-mutation-1-${process.pid.toString(36)}.spec.ts`),
    );
    expect(readFileSync(written, 'utf8')).toBe('mutated content\n');
  });
});
