import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { mutationFilePath, planSpecMutations, writeMutationFile } from '../src/mutate.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

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
    expect(plan.mutations).toHaveLength(1);
    const m = plan.mutations[0]!;
    expect(m.testTitle).toBe('shows an error for an invalid email');
    expect(m).toHaveProperty('mutatedSource');
    if (!('mutatedSource' in m)) return;
    expect(m.markerLine).toBe(9);
    expect(m.assertLine).toBe(10);
    expect(changedLines(source, m.mutatedSource)).toEqual([10]);
    expect(m.mutatedSource.split('\n')[9]).toContain('.not.toBeVisible()');
  });

  it('mutates exactly the marked assertion of hollow.spec.ts', () => {
    const source = fixture('hollow.spec.ts');
    const plan = planSpecMutations(source);
    expect(plan.mutations).toHaveLength(1);
    const m = plan.mutations[0]!;
    expect(m).toHaveProperty('mutatedSource');
    if (!('mutatedSource' in m)) return;
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

  it('exempts test.skip and test.fixme from sentinel accounting, not test.only', () => {
    const plan = planSpecMutations(
      [
        "test.skip('parked', async () => {});",
        "test.fixme('broken', async () => {});",
        "test.only('focused', async () => {});",
      ].join('\n'),
    );
    expect(plan.unmarkedTests).toEqual([{ title: 'focused', line: 3 }]);
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
    expect(plan.mutations[0]).toHaveProperty('mutatedSource');
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
    const m = plan.mutations[0]!;
    expect(m.markerLine).toBe(2);
    expect(m).toHaveProperty('cannotMutate');
    if ('cannotMutate' in m) expect(m.cannotMutate).toContain('2 @primary-assert markers');
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

  it('skips blank lines between the marker and the assertion', () => {
    const plan = planSpecMutations(
      [
        "test('gap', async ({ page }) => {",
        '  // @primary-assert',
        '',
        '  await expect(page.locator("#a")).toBeVisible();',
        '});',
      ].join('\n'),
    );
    const m = plan.mutations[0]!;
    expect(m).toHaveProperty('mutatedSource');
    expect(m.assertLine).toBe(4);
  });

  it('reports a marker with nothing after it as cannot-mutate', () => {
    const plan = planSpecMutations(["test('tail', async () => {});", '// @primary-assert'].join('\n'));
    expect(plan.strayMarkerLines).toEqual([2]);
    const inTest = planSpecMutations(
      ["test('tail', async () => {", '  // @primary-assert'].join('\n'),
    );
    const m = inTest.mutations[0]!;
    expect(m).toHaveProperty('cannotMutate');
    if ('cannotMutate' in m) expect(m.cannotMutate).toContain('no code line follows');
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
    const m = plan.mutations[0]!;
    expect(m.assertLine).toBe(3);
    expect(m).toHaveProperty('cannotMutate');
    if ('cannotMutate' in m) expect(m.cannotMutate).toContain('no expect()');
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
    const m = plan.mutations[0]!;
    expect(m.testTitle).toBe('second');
    if ('mutatedSource' in m) expect(changedLines(source, m.mutatedSource)).toEqual([6]);
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

  it('falls back to a placeholder for dynamic titles', () => {
    const plan = planSpecMutations(
      [
        'test(`template ${kind}`, async () => {});',
        'test(titleVar, async ({ page }) => {',
        '  // @primary-assert',
        '  await expect(page.locator("#a")).toBeVisible();',
        '});',
      ].join('\n'),
    );
    expect(plan.mutations[0]!.testTitle).toBe('(dynamic title)');
  });
});

describe('mutation files', () => {
  it.each([
    { spec: 'fixtures/hollow.spec.ts', index: 1, path: 'fixtures/hollow.pmg-mutation-1.spec.ts' },
    { spec: 'checkout.test.mjs', index: 2, path: 'checkout.pmg-mutation-2.test.mjs' },
    { spec: 'plain.ts', index: 1, path: 'plain.pmg-mutation-1.ts' },
    { spec: 'no-extension', index: 1, path: 'no-extension.pmg-mutation-1' },
  ])('names the copy $path', ({ spec, index, path }) => {
    expect(mutationFilePath(spec, index)).toBe(path);
  });

  const dir = mkdtempSync(join(tmpdir(), 'pmg-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the mutated copy next to the spec and returns its path', () => {
    const written = writeMutationFile(join(dir, 'sample.spec.ts'), 1, 'mutated content\n');
    expect(written).toBe(join(dir, 'sample.pmg-mutation-1.spec.ts'));
    expect(readFileSync(written, 'utf8')).toBe('mutated content\n');
  });
});
