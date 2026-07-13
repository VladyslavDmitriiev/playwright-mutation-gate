/**
 * Shared single-pass lexer for the string-based spec analysis. Classifies
 * every char of a source (a whole file or a single line) so the scanners in
 * invert.ts and mutate.ts agree about what is code. One implementation on
 * purpose: two hand-rolled lexers had already diverged once.
 */

/** Char inside a string, template literal, block comment or regex literal. */
export const NON_CODE = 0;
/** Executable source. */
export const CODE = 1;
/** Char of a `//` comment that starts in code context. */
export const LINE_COMMENT = 2;

// Keywords after which a `/` starts a regex literal, not division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'do',
  'else',
  'case',
  'yield',
  'await',
]);

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);

/**
 * A `/` in code context is a regex literal when the last significant code
 * token cannot end an expression: after a value (identifier, `)`, `]`,
 * string) it is division.
 */
function startsRegex(lastSig: string, lastWord: string): boolean {
  if (lastSig === '') return true;
  if (isWordChar(lastSig)) return REGEX_PRECEDING_KEYWORDS.has(lastWord);
  return lastSig !== ')' && lastSig !== ']' && lastSig !== '"' && lastSig !== "'" && lastSig !== '`';
}

/**
 * Classify every char of `src` as CODE, LINE_COMMENT or NON_CODE. Handles
 * strings with escapes, template literals with nested `${}` expressions,
 * `//` and block comments, and regex literals (heuristic: see startsRegex).
 */
export function lex(src: string): Uint8Array {
  const kind = new Uint8Array(src.length).fill(CODE);
  // '`' = inside a template literal, '{' = inside a `${}` expression.
  const stack: ('`' | '{')[] = [];
  // Last significant code char, its index, and the word it ends, for regex detection.
  let lastSig = '';
  let lastSigIndex = -2;
  let lastWord = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (stack[stack.length - 1] === '`') {
      kind[i] = NON_CODE;
      if (c === '\\') {
        if (i + 1 < src.length) kind[i + 1] = NON_CODE;
        i++;
      } else if (c === '`') {
        stack.pop();
        lastSig = '`';
        lastWord = '';
      } else if (c === '$' && src[i + 1] === '{') {
        kind[i + 1] = NON_CODE;
        stack.push('{');
        lastSig = '';
        lastWord = '';
        i++;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      kind[i] = NON_CODE;
      i++;
      while (i < src.length && src[i] !== '\n') {
        kind[i] = NON_CODE;
        if (src[i] === '\\' && i + 1 < src.length) {
          kind[i + 1] = NON_CODE;
          i += 2;
          continue;
        }
        i++;
        if (src[i - 1] === c) break;
      }
      lastSig = c;
      lastWord = '';
      continue;
    }
    if (c === '`') {
      kind[i] = NON_CODE;
      stack.push('`');
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') kind[i++] = LINE_COMMENT;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      kind[i] = NON_CODE;
      kind[i + 1] = NON_CODE;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) kind[i++] = NON_CODE;
      if (i < src.length) {
        kind[i] = NON_CODE;
        kind[i + 1] = NON_CODE;
        i += 2;
      }
      continue;
    }
    if (c === '/' && startsRegex(lastSig, lastWord)) {
      kind[i] = NON_CODE;
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        kind[i] = NON_CODE;
        if (src[i] === '\\' && i + 1 < src.length) {
          kind[i + 1] = NON_CODE;
          i += 2;
          continue;
        }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) {
          i++;
          break;
        }
        i++;
      }
      while (i < src.length && /[a-z]/.test(src[i]!)) kind[i++] = NON_CODE; // flags
      lastSig = '/';
      lastWord = '';
      continue;
    }
    if (!/\s/.test(c)) {
      if (isWordChar(c)) {
        lastWord = isWordChar(lastSig) && lastSigIndex === i - 1 ? lastWord + c : c;
      } else {
        lastWord = '';
      }
      lastSig = c;
      lastSigIndex = i;
      if (stack.length > 0) {
        if (c === '{') stack.push('{');
        else if (c === '}') stack.pop();
      }
    }
    i++;
    continue;
  }
  return kind;
}

/**
 * Find the `)` matching the `(` at `open`, counting only CODE chars.
 * Returns -1 when it does not close within `src`.
 */
export function findCloseMasked(src: string, kind: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (kind[i] !== CODE) continue;
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return -1;
}
