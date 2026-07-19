import { describe, expect, it } from 'vitest';
import { planBehaviorMutations, type BehaviorMutation } from '../src/behavior.js';

const only = (source: string): BehaviorMutation => {
  const plan = planBehaviorMutations(source);
  expect(plan).toHaveLength(1);
  return plan[0]!;
};

const spec = (body: string, params = '{ page }'): string =>
  `import { test, expect } from '@playwright/test';\n` +
  `test('a test', async (${params}) => {\n${body}\n});\n`;

describe('planBehaviorMutations: injection', () => {
  it('injects a route preamble and keeps the assertion, carrying the value', () => {
    const m = only(spec("  await page.goto('/');\n  // @primary-assert\n  await expect(page.locator('#x')).toContainText('Premium');"));
    expect(m).not.toHaveProperty('cannotLocate');
    const hit = m as Extract<BehaviorMutation, { mutatedSource: string }>;
    expect(hit.value).toBe('Premium');
    expect(hit.mutatedSource).toContain("await page.route('**/*'");
    expect(hit.mutatedSource).toContain('const NEEDLE = "Premium";');
    // Binary resources are passed through, never decoded as text.
    expect(hit.mutatedSource).toContain("resourceType === 'image'");
    expect(hit.mutatedSource).toContain('route.continue()');
    // The original assertion survives untouched.
    expect(hit.mutatedSource).toContain("await expect(page.locator('#x')).toContainText('Premium');");
  });

  it('injects right after the callback body opening brace', () => {
    const m = only(spec("  // @primary-assert\n  await expect(page.locator('#x')).toHaveText('Hi');")) as Extract<
      BehaviorMutation,
      { mutatedSource: string }
    >;
    const bodyStart = m.mutatedSource.indexOf('=> {') + '=> {'.length;
    expect(m.mutatedSource.slice(bodyStart, bodyStart + 20)).toContain('await page.route');
  });

  it('JSON-escapes a value with quotes', () => {
    const m = only(spec('  // @primary-assert\n  await expect(el).toContainText(\'say "hi"\');')) as Extract<
      BehaviorMutation,
      { mutatedSource: string }
    >;
    expect(m.mutatedSource).toContain('const NEEDLE = "say \\"hi\\"";');
  });
});

describe('planBehaviorMutations: cannot-locate', () => {
  it('reports a request-only test (no page fixture)', () => {
    const m = only(spec("  const res = await request.get('/');\n  // @primary-assert\n  expect(res.headers()['x']).toContain('json');", '{ request }'));
    expect(m).toHaveProperty('cannotLocate');
    expect((m as { cannotLocate: string }).cannotLocate).toMatch(/no page fixture/);
  });

  it('reports a valueless matcher', () => {
    const m = only(spec('  // @primary-assert\n  await expect(el).toBeVisible();'));
    expect((m as { cannotLocate: string }).cannotLocate).toMatch(/locatable string value/);
  });

  it('reports a skipped test', () => {
    const source =
      `import { test, expect } from '@playwright/test';\n` +
      `test.skip('skipped', async ({ page }) => {\n  // @primary-assert\n  await expect(el).toContainText('x');\n});\n`;
    const m = only(source);
    expect((m as { cannotLocate: string }).cannotLocate).toMatch(/never runs/);
  });

  it('reports multiple markers in one test', () => {
    const m = only(
      spec("  // @primary-assert\n  await expect(a).toContainText('x');\n  // @primary-assert\n  await expect(b).toContainText('y');"),
    );
    expect((m as { cannotLocate: string }).cannotLocate).toMatch(/expected exactly one/);
  });
});
