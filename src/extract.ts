import { CODE, findCloseMasked, lex } from './lex.js';

/**
 * The value a `@primary-assert` assertion names, extracted for behavior
 * mutation. `string` is a plain string literal the gate can locate in a
 * response body/header and corrupt in transit. Everything the gate cannot
 * honestly turn into a response mutation is `cannotLocate` with a reason,
 * never guessed.
 */
export type AssertValue = { kind: 'string'; value: string } | { cannotLocate: string };

// Matchers whose first argument, when a plain string literal, is the observed
// value the assertion depends on. Corrupting that string in the response is a
// meaningful behavior mutation. Others (toBeVisible, toHaveCount, toHaveURL
// with a regex, numeric toBe) do not carry a locatable string value in v1.
const STRING_MATCHERS = new Set(['toContain', 'toContainText', 'toHaveText', 'toHaveValue', 'toBe']);

const isWord = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

/**
 * Extract the string value a single assertion line names, for behavior
 * mutation. Purely string-based, reusing the same chain walk as invert.ts:
 * `[await] expect[.soft|.poll](...) [.resolves|.rejects] .toXxx(<string>)`.
 * A negated matcher (`.not`) has inverted semantics that behavior mutation
 * does not model in v1, so it is reported as cannot-locate rather than guessed.
 */
export function extractAssertValue(line: string): AssertValue {
  const kind = lex(line);
  // First CODE index at or after j: skips whitespace, comments and other
  // non-code chars, matching invert.ts's walk.
  const skip = (j: number): number => {
    while (j < line.length && (kind[j] !== CODE || /\s/.test(line[j]!))) j++;
    return j;
  };

  const anchors = [...line.matchAll(/\bexpect\s*[.(]/g)].filter((m) => kind[m.index!] === CODE);
  if (anchors.length === 0) return { cannotLocate: 'no expect() call on this line' };
  if (anchors.length > 1) return { cannotLocate: 'multiple expect calls on one line' };

  let i = anchors[0]!.index! + anchors[0]![0].length - 1;
  if (line[i] === '.') {
    i = skip(i + 1);
    const start = i;
    while (isWord(line[i])) i++;
    const form = line.slice(start, i);
    if (form !== 'soft' && form !== 'poll') return { cannotLocate: `unsupported expect form "expect.${form}"` };
    i = skip(i);
    if (line[i] !== '(') return { cannotLocate: `expect.${form} is not called on this line` };
  }

  const close = findCloseMasked(line, kind, i);
  if (close === -1) return { cannotLocate: 'expect(...) does not close on this line (multi-line expect)' };

  i = skip(close + 1);
  for (;;) {
    if (i >= line.length || line[i] !== '.') return { cannotLocate: 'no matcher call after expect(...) on this line' };
    i = skip(i + 1);
    const start = i;
    while (isWord(line[i])) i++;
    const id = line.slice(start, i);
    if (id === '') return { cannotLocate: 'unexpected character in expect(...) chain' };

    const lookahead = skip(i);
    if (line[lookahead] === '(') {
      if (!STRING_MATCHERS.has(id)) {
        return { cannotLocate: `matcher .${id}() does not carry a locatable string value` };
      }
      return readFirstStringArg(line, lookahead);
    }
    if (id === 'not') return { cannotLocate: 'negated matcher (.not); behavior mutation semantics undefined in v1' };
    if (id === 'resolves' || id === 'rejects') {
      i = skip(i);
      continue;
    }
    return { cannotLocate: `unsupported chain segment ".${id}"` };
  }
}

/** Read a plain string literal as the first argument at the matcher's `(`. */
function readFirstStringArg(line: string, open: number): AssertValue {
  let i = open + 1;
  while (i < line.length && /\s/.test(line[i]!)) i++;
  const quote = line[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return { cannotLocate: 'asserted value is not a plain string literal (number, variable, or expression)' };
  }
  let value = '';
  for (i++; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && i + 1 < line.length) {
      const next = line[i + 1]!;
      value += ESCAPES[next] ?? next;
      i++;
    } else if (quote === '`' && c === '$' && line[i + 1] === '{') {
      return { cannotLocate: 'asserted value is an interpolated template literal' };
    } else if (c === quote) {
      if (value === '') return { cannotLocate: 'asserted value is an empty string' };
      return { kind: 'string', value };
    } else {
      value += c;
    }
  }
  return { cannotLocate: 'unterminated string literal in assertion' };
}
