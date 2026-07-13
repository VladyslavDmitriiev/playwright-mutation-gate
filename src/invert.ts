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

const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
const isWord = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);

/**
 * Find the `)` that closes the `(` at `open`, skipping string literals
 * (including template literals with `${}` expressions). Returns -1 when the
 * paren does not close on this line.
 */
function findClose(line: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < line.length; i++) {
    const c = line[i]!;
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === '\\') i++;
      else if (c === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && line[i + 1] === '{') {
        stack.push('{');
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') stack.push(c);
    else if (c === '(' || c === '{') stack.push(c);
    else if (c === ')' || c === '}') {
      if (top !== (c === ')' ? '(' : '{')) return -1;
      stack.pop();
      if (stack.length === 0 && c === ')') return i;
    }
  }
  return -1;
}

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
  const anchors = [...line.matchAll(/\bexpect\s*[.(]/g)];
  if (anchors.length === 0) {
    return { cannotMutate: 'no expect() call found on this line' };
  }
  if (anchors.length > 1) {
    return { cannotMutate: 'multiple expect calls on one line' };
  }

  // Position of the `.` or `(` right after the `expect` token.
  let i = anchors[0]!.index + anchors[0]![0].length - 1;

  if (line[i] === '.') {
    i++;
    while (isWs(line[i])) i++;
    const start = i;
    while (isWord(line[i])) i++;
    const form = line.slice(start, i);
    if (form !== 'soft' && form !== 'poll') {
      return { cannotMutate: `unsupported expect form "expect.${form}"` };
    }
    while (isWs(line[i])) i++;
    if (line[i] !== '(') {
      return { cannotMutate: `expect.${form} is not called on this line` };
    }
  }

  const close = findClose(line, i);
  if (close === -1) {
    return { cannotMutate: 'expect(...) does not close on this line (multi-line expect)' };
  }

  // Walk the chain after expect(...): modifiers, optional .not, then the matcher.
  i = close + 1;
  let notStart = -1;
  let notEnd = -1;
  for (;;) {
    while (isWs(line[i])) i++;
    if (i >= line.length) {
      return { cannotMutate: 'no matcher call after expect(...) on this line' };
    }
    if (line[i] !== '.') {
      return { cannotMutate: `unexpected "${line[i]}" after expect(...) chain` };
    }
    const dot = i;
    i++;
    while (isWs(line[i])) i++;
    const start = i;
    while (isWord(line[i])) i++;
    const id = line.slice(start, i);
    if (id === '') {
      return { cannotMutate: 'unexpected character in expect(...) chain' };
    }

    let lookahead = i;
    while (isWs(line[lookahead])) lookahead++;
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
      continue;
    }
    if (id === 'resolves' || id === 'rejects') continue;
    return { cannotMutate: `unsupported chain segment ".${id}"` };
  }
}
