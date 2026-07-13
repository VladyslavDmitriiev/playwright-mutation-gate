import { describe, expect, it } from 'vitest';
import { invertAssertLine } from '../src/invert.js';

/*
 * KNOWN LIMITATIONS of string-based inversion (source for README "Limitations"):
 *
 * - Single line only: `expect(...)` and its matcher must start on the marked
 *   line. Matcher ARGUMENTS may continue on following lines; the expect
 *   argument may not. Multi-line chains report cannot-mutate.
 * - String-based, no AST: assertions wrapped in helper functions or an
 *   aliased/re-exported `expect` are not recognized.
 * - Over-strict on the word "expect": a second `expect` call shape on the
 *   marked line (even inside a string literal like 'expect (x)') reports
 *   cannot-mutate instead of guessing which call to mutate.
 * - Custom matchers must follow the `toXxx` naming convention to be
 *   recognized as matchers, and must not shadow built-in method names
 *   (toString, toFixed, toSorted, ...) which are denylisted.
 * - Supported chain shape is exactly:
 *   [await] expect[.soft|.poll](...)[.resolves|.rejects][.not].toXxx(
 *   Anything else (e.g. expect.extend, .toString) reports cannot-mutate.
 */

const ok = (line: string) => {
  const result = invertAssertLine(line);
  expect(result, `expected ok, got ${JSON.stringify(result)}`).toHaveProperty('ok');
  return (result as { ok: string }).ok;
};

const cannot = (line: string) => {
  const result = invertAssertLine(line);
  expect(result, `expected cannotMutate, got ${JSON.stringify(result)}`).toHaveProperty(
    'cannotMutate',
  );
  return (result as { cannotMutate: string }).cannotMutate;
};

describe('invertAssertLine: adds .not', () => {
  it.each([
    {
      name: 'basic matcher',
      input: 'expect(sum).toBe(3);',
      expected: 'expect(sum).not.toBe(3);',
    },
    {
      name: 'await + locator, indent preserved',
      input: "  await expect(page.locator('#error')).toBeVisible();",
      expected: "  await expect(page.locator('#error')).not.toBeVisible();",
    },
    {
      name: 'soft assertion',
      input: 'expect.soft(res.status).toBe(200);',
      expected: 'expect.soft(res.status).not.toBe(200);',
    },
    {
      name: 'poll',
      input: 'await expect.poll(() => count(), { timeout: 5000 }).toBeGreaterThan(2);',
      expected: 'await expect.poll(() => count(), { timeout: 5000 }).not.toBeGreaterThan(2);',
    },
    {
      name: 'resolves modifier',
      input: "await expect(fetchUser()).resolves.toHaveProperty('id');",
      expected: "await expect(fetchUser()).resolves.not.toHaveProperty('id');",
    },
    {
      name: 'method call inside expect argument (toString is not a matcher)',
      input: "expect(x.toString()).toBe('1');",
      expected: "expect(x.toString()).not.toBe('1');",
    },
    {
      name: 'parens and quotes inside string argument',
      input: "await expect(page.getByText('a (b)')).toBeVisible();",
      expected: "await expect(page.getByText('a (b)')).not.toBeVisible();",
    },
    {
      name: 'template literal with expression in expect argument',
      input: 'await expect(page.locator(`#item-${id(3)}`)).toBeVisible();',
      expected: 'await expect(page.locator(`#item-${id(3)}`)).not.toBeVisible();',
    },
    {
      name: 'call inside matcher argument',
      input: "expect(name).toContain(prefix('x'));",
      expected: "expect(name).not.toContain(prefix('x'));",
    },
    {
      name: 'trailing comment preserved',
      input: 'expect(total).toBe(1); // main check',
      expected: 'expect(total).not.toBe(1); // main check',
    },
    {
      name: 'matcher arguments continue on the next line',
      input: "    await expect(page.locator('#x')).toHaveText(",
      expected: "    await expect(page.locator('#x')).not.toHaveText(",
    },
    {
      name: 'no semicolon',
      input: 'expect(flag).toBeTruthy()',
      expected: 'expect(flag).not.toBeTruthy()',
    },
    {
      name: 'toPass with options object',
      input: 'await expect(check).toPass({ intervals: [1000] });',
      expected: 'await expect(check).not.toPass({ intervals: [1000] });',
    },
  ])('$name', ({ input, expected }) => {
    expect(ok(input)).toBe(expected);
  });
});

describe('invertAssertLine: removes .not', () => {
  it.each([
    {
      name: 'already negated',
      input: 'expect(sum).not.toBe(3);',
      expected: 'expect(sum).toBe(3);',
    },
    {
      name: 'negated web-first assertion',
      input: "  await expect(page.locator('#error')).not.toBeVisible();",
      expected: "  await expect(page.locator('#error')).toBeVisible();",
    },
    {
      name: 'rejects + not',
      input: 'await expect(fn()).rejects.not.toThrow();',
      expected: 'await expect(fn()).rejects.toThrow();',
    },
  ])('$name', ({ input, expected }) => {
    expect(ok(input)).toBe(expected);
  });
});

describe('invertAssertLine: round trip', () => {
  it.each([
    'expect(sum).toBe(3);',
    "  await expect(page.locator('#error')).toBeVisible();",
    'expect.soft(res.status).not.toBe(200);',
  ])('invert twice returns the original: %s', (line) => {
    expect(ok(ok(line))).toBe(line);
  });
});

describe('invertAssertLine: cannot-mutate', () => {
  it.each([
    {
      name: 'no expect on the line',
      input: "await page.click('#submit');",
      reason: 'no expect',
    },
    {
      name: 'multi-line expect: argument does not close',
      input: 'await expect(',
      reason: 'does not close',
    },
    {
      name: 'matcher on the next line',
      input: "await expect(page.locator('#e'))",
      reason: 'no matcher call',
    },
    {
      name: 'two expect calls on one line',
      input: 'expect(a).toBe(1); expect(b).toBe(2);',
      reason: 'multiple expect calls',
    },
    {
      name: 'nested expect inside toPass',
      input: 'await expect(async () => expect(x).toBe(1)).toPass();',
      reason: 'multiple expect calls',
    },
    {
      name: 'unsupported expect form',
      input: 'expect.extend({ toBeInside });',
      reason: 'unsupported expect form',
    },
    {
      name: 'chain method that is not a matcher',
      input: 'expect(a).toString();',
      reason: 'does not look like an assertion matcher',
    },
    {
      name: 'unsupported chain segment',
      input: 'expect(a).stuff.toBe(1);',
      reason: 'unsupported chain segment',
    },
    {
      name: 'double .not',
      input: 'expect(a).not.not.toBe(1);',
      reason: 'double .not',
    },
  ])('$name', ({ input, reason }) => {
    expect(cannot(input)).toContain(reason);
  });
});
