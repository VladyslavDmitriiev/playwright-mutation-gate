import { CODE, findCloseMasked, lex } from './lex.js';

export type InvertResult = { ok: string } | { cannotMutate: string };

// Built-in toXxx methods that look like matchers but are not assertions.
const NOT_MATCHERS = new Set([
  'toString',
  'toLocaleString',
  'toJSON',
  'toISOString',
  'toFixed',
  'toExponential',
  'toPrecision',
  'toDateString',
  'toTimeString',
  'toUTCString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toUpperCase',
  'toReversed',
  'toSorted',
  'toSpliced',
]);

const isWord = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);

/**
 * Invert the assertion on a single line of a Playwright spec:
 * `expect(x).toY()` <-> `expect(x).not.toY()`.
 *
 * Purely string-based. Supported chain shape:
 * `[await] expect[.soft|.poll](...) [.resolves|.rejects] [.not] .toXxx(`
 * The matcher call must start on this line; its arguments may continue on
 * following lines. Everything else returns `cannotMutate` with a reason
 * rather than guessing.
 */
export function invertAssertLine(line: string): InvertResult {
  const kind = lex(line);
  // First CODE index at or after j: skips whitespace, comments and other
  // non-code chars (so a comment inside the chain does not break the walk).
  const skip = (j: number): number => {
    while (j < line.length && (kind[j] !== CODE || /\s/.test(line[j]!))) j++;
    return j;
  };

  const anchors = [...line.matchAll(/\bexpect\s*[.(]/g)].filter((m) => kind[m.index] === CODE);
  if (anchors.length === 0) {
    return { cannotMutate: 'no expect() call found on this line' };
  }
  if (anchors.length > 1) {
    return { cannotMutate: 'multiple expect calls on one line' };
  }

  // Position of the `.` or `(` right after the `expect` token.
  let i = anchors[0]!.index + anchors[0]![0].length - 1;

  if (line[i] === '.') {
    i = skip(i + 1);
    const start = i;
    while (isWord(line[i])) i++;
    const form = line.slice(start, i);
    if (form !== 'soft' && form !== 'poll') {
      return { cannotMutate: `unsupported expect form "expect.${form}"` };
    }
    i = skip(i);
    if (line[i] !== '(') {
      return { cannotMutate: `expect.${form} is not called on this line` };
    }
  }

  const close = findCloseMasked(line, kind, i);
  if (close === -1) {
    return { cannotMutate: 'expect(...) does not close on this line (multi-line expect)' };
  }

  // Walk the chain after expect(...): modifiers, optional .not, then the matcher.
  i = skip(close + 1);
  let notStart = -1;
  let notEnd = -1;
  for (;;) {
    if (i >= line.length) {
      return { cannotMutate: 'no matcher call after expect(...) on this line' };
    }
    if (line[i] !== '.') {
      return { cannotMutate: `unexpected "${line[i]}" after expect(...) chain` };
    }
    const dot = i;
    i = skip(i + 1);
    const start = i;
    while (isWord(line[i])) i++;
    const id = line.slice(start, i);
    if (id === '') {
      return { cannotMutate: 'unexpected character in expect(...) chain' };
    }

    const lookahead = skip(i);
    if (line[lookahead] === '(') {
      if (!/^to[A-Z]/.test(id) || NOT_MATCHERS.has(id)) {
        return { cannotMutate: `".${id}" does not look like an assertion matcher` };
      }
      const inverted =
        notStart !== -1
          ? line.slice(0, notStart) + line.slice(notEnd)
          : line.slice(0, dot) + '.not' + line.slice(dot);
      return { ok: inverted };
    }
    if (id === 'not') {
      if (notStart !== -1) {
        return { cannotMutate: 'double .not in expect(...) chain' };
      }
      notStart = dot;
      notEnd = i;
      i = skip(i);
      continue;
    }
    if (id === 'resolves' || id === 'rejects') {
      i = skip(i);
      continue;
    }
    return { cannotMutate: `unsupported chain segment ".${id}"` };
  }
}
