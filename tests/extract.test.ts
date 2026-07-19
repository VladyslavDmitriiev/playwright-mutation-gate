import { describe, expect, it } from 'vitest';
import { extractAssertValue } from '../src/extract.js';

const value = (line: string): string => {
  const r = extractAssertValue(line);
  expect(r, `expected a value, got ${JSON.stringify(r)}`).toHaveProperty('kind', 'string');
  return (r as { value: string }).value;
};

const cannot = (line: string): string => {
  const r = extractAssertValue(line);
  expect(r, `expected cannotLocate, got ${JSON.stringify(r)}`).toHaveProperty('cannotLocate');
  return (r as { cannotLocate: string }).cannotLocate;
};

describe('extractAssertValue: string matchers', () => {
  it('reads toContainText', () => {
    expect(value("await expect(page.locator('#plan')).toContainText('Premium');")).toBe('Premium');
  });
  it('reads toHaveText', () => {
    expect(value("await expect(el).toHaveText('Saved');")).toBe('Saved');
  });
  it('reads toContain on a header', () => {
    expect(value('expect(res.headers()["content-type"]).toContain("image/png");')).toBe('image/png');
  });
  it('reads toBe with a string', () => {
    expect(value("expect(res.statusText()).toBe('OK');")).toBe('OK');
  });
  it('reads toHaveValue', () => {
    expect(value("await expect(input).toHaveValue('draft');")).toBe('draft');
  });
  it('unescapes common escapes', () => {
    expect(value("expect(x).toContain('a\\tb');")).toBe('a\tb');
  });
  it('sees through soft and modifiers', () => {
    expect(value("await expect.soft(page).toContainText('Hi');")).toBe('Hi');
    expect(value("await expect(p).resolves.toContain('done');")).toBe('done');
  });
});

describe('extractAssertValue: cannot-locate', () => {
  it('rejects a numeric argument', () => {
    expect(cannot('expect(res.status()).toBe(200);')).toMatch(/not a plain string literal/);
  });
  it('rejects toBeVisible (no value)', () => {
    expect(cannot('await expect(el).toBeVisible();')).toMatch(/does not carry a locatable string value/);
  });
  it('rejects toHaveCount', () => {
    expect(cannot('await expect(rows).toHaveCount(3);')).toMatch(/does not carry a locatable string value/);
  });
  it('rejects a regex toHaveURL', () => {
    expect(cannot('await expect(page).toHaveURL(/pricing/);')).toMatch(/does not carry a locatable string value/);
  });
  it('rejects a negated matcher', () => {
    expect(cannot("await expect(el).not.toContainText('x');")).toMatch(/negated matcher/);
  });
  it('rejects an interpolated template literal', () => {
    expect(cannot('await expect(el).toContainText(`hi ${name}`);')).toMatch(/interpolated template literal/);
  });
  it('rejects a variable argument', () => {
    expect(cannot('await expect(el).toContainText(expected);')).toMatch(/not a plain string literal/);
  });
  it('rejects an empty string', () => {
    expect(cannot("await expect(el).toContainText('');")).toMatch(/empty string/);
  });
  it('rejects a line with no expect', () => {
    expect(cannot('const x = 1;')).toMatch(/no expect/);
  });
});
