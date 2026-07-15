import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { invertAssertLine } from './invert.js';
import { CODE, LINE_COMMENT, findCloseMasked, lex } from './lex.js';

export const MARKER = '// @primary-assert';

export type Mutation =
  | {
      testTitle: string;
      /** 1-based line of the test() declaration, for file:line targeting. */
      testLine: number;
      /** 1-based line of the `// @primary-assert` marker. */
      markerLine: number;
      /** 1-based line of the assertion that was inverted. */
      assertLine: number;
      /** Full spec source with exactly this one assertion inverted. */
      mutatedSource: string;
    }
  | {
      testTitle: string;
      testLine: number;
      markerLine: number;
      /** 1-based line of the assertion candidate; null when none was located. */
      assertLine: number | null;
      cannotMutate: string;
    };

export interface PlanOptions {
  /**
   * Extra identifiers to treat as test builders, on top of `test` and the
   * auto-detected `.extend` chains and renamed imports. For custom fixtures
   * imported by their own name from another module (`import { authedTest }
   * from './fixtures'`), which cannot be detected without resolving the import.
   */
  testIds?: string[];
}

export interface SpecPlan {
  /** One entry per marked test: either a mutated copy or a cannot-mutate reason. */
  mutations: Mutation[];
  /** Runnable tests with no marker (sentinel accounting). skip/fixme/fail are exempt. */
  unmarkedTests: { title: string; line: number }[];
  /** 1-based lines of valid markers that sit outside every test() block. */
  strayMarkerLines: number[];
  /**
   * 1-based lines of test.only() declarations. Any .only filters out every
   * other test in the file, so the runner refuses the whole spec.
   */
  onlyTestLines: number[];
  /** 1-based lines mentioning @primary-assert that do not form a valid marker. */
  malformedMarkerLines: number[];
}

/**
 * A valid `// @primary-assert` marker. `sameLine` is true when the marker
 * trails the assertion on its own line (`expect(x).toY(); // @primary-assert`),
 * false when it sits on its own line above the assertion.
 */
interface Marker {
  line: number;
  sameLine: boolean;
}

interface TestBlock {
  title: string;
  mode: '' | 'only' | 'skip' | 'fixme' | 'fail';
  /** Char offset of the `test` token. */
  anchor: number;
  /** Char offsets of the call's `(` and its matching `)` (source end when unclosed). */
  open: number;
  close: number;
  /** Valid markers inside this block. */
  markers: Marker[];
}

/** Read the test title: the first argument when it is a literal without interpolation. */
function readTitle(src: string, open: number): string {
  let i = open + 1;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  const quote = src[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return '(dynamic title)';
  let title = '';
  for (i++; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\' && i + 1 < src.length) {
      title += src[i + 1];
      i++;
    } else if (quote === '`' && c === '$' && src[i + 1] === '{') {
      return '(dynamic title)';
    } else if (c === quote) {
      return title;
    } else {
      title += c;
    }
  }
  return title;
}

const IDENT = '[A-Za-z_$][\\w$]*';

/** True when the first argument at `open` (the call's `(`) is a string literal. */
function firstArgIsStringLiteral(src: string, open: number): boolean {
  let i = open + 1;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  const c = src[i];
  return c === "'" || c === '"' || c === '`';
}

/**
 * The set of identifiers that declare a test in this file. Always `test`, plus
 * any passed in explicitly (`--test-id`), plus auto-detected custom fixtures:
 * a local `const X = <known>.extend(...)` chain, or a renamed import
 * (`import { test as X }`). Resolved to a fixpoint so chained extends and
 * renames of just-discovered ids are picked up too.
 */
function collectTestIds(src: string, kind: Uint8Array, extra: string[]): Set<string> {
  const ids = new Set<string>(['test', ...extra]);
  const renameRe = new RegExp(`\\b(${IDENT})\\s+as\\s+(${IDENT})`, 'g');
  const extendRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(${IDENT})\\s*\\.\\s*extend\\s*\\(`, 'g');
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of src.matchAll(renameRe)) {
      if (kind[m.index] !== CODE) continue;
      if (ids.has(m[1]!) && !ids.has(m[2]!)) {
        ids.add(m[2]!);
        changed = true;
      }
    }
    for (const m of src.matchAll(extendRe)) {
      if (kind[m.index] !== CODE) continue;
      if (ids.has(m[2]!) && !ids.has(m[1]!)) {
        ids.add(m[1]!);
        changed = true;
      }
    }
  }
  return ids;
}

function findTestBlocks(src: string, kind: Uint8Array, ids: Set<string>): TestBlock[] {
  const alt = [...ids].sort((a, b) => b.length - a.length).join('|');
  const anchor = new RegExp(`\\b(?:${alt})\\s*(?:\\.\\s*(only|skip|fixme|fail)\\s*)?\\(`, 'g');
  const blocks: TestBlock[] = [];
  for (const m of src.matchAll(anchor)) {
    if (kind[m.index] !== CODE) continue;
    // Excludes member calls like `t.test(...)`; `test.describe(` and
    // `test.step(` never match the regex in the first place.
    if (m.index > 0 && src[m.index - 1] === '.') continue;
    const mode = (m[1] ?? '') as TestBlock['mode'];
    const open = m.index + m[0].length - 1;
    // `test.skip('title', fn)` declares a skipped test; `test.skip(!cond)` is a
    // runtime modifier statement inside a test body. Only the declaration form
    // (string title) is a block; the modifier is left to sit inside its test.
    if (UNGATEABLE_MODES.has(mode) && !firstArgIsStringLiteral(src, open)) continue;
    const close = findCloseMasked(src, kind, open);
    blocks.push({
      title: readTitle(src, open),
      mode,
      anchor: m.index,
      open,
      close: close === -1 ? src.length : close,
      markers: [],
    });
  }
  return blocks;
}

// test.skip/fixme never run and test.fail inverts pass/fail semantics, so a
// mutation verdict on them would be a lie; they are also exempt from sentinel
// accounting. test.only runs and is treated like a plain test.
const UNGATEABLE_MODES = new Set(['skip', 'fixme', 'fail']);

/**
 * Parse a spec source and plan its mutations: one inverted copy per marked
 * test. Anything the gate cannot honestly mutate is reported with a reason,
 * never skipped silently.
 */
export function planSpecMutations(source: string, opts: PlanOptions = {}): SpecPlan {
  const kind = lex(source);
  const ids = collectTestIds(source, kind, opts.testIds ?? []);
  const blocks = findTestBlocks(source, kind, ids);
  const lines = source.split('\n');

  // Char offset of each line start, to map offsets to 1-based line numbers.
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let n = 0;
    while (n + 1 < starts.length && starts[n + 1]! <= offset) n++;
    return n + 1;
  };
  // A line "has code" when any of its chars is CODE and not whitespace;
  // blank, comment-only and string-interior lines do not.
  const lineHasCode = (n: number): boolean => {
    for (let j = starts[n]!, end = starts[n]! + lines[n]!.length; j < end; j++) {
      if (kind[j] === CODE && !/\s/.test(source[j]!)) return true;
    }
    return false;
  };

  // The `//` line comment on a line (in code context), or null when the line
  // has none. `codeBefore` distinguishes a trailing marker (assertion code
  // precedes the comment) from a whole-line one.
  const lineComment = (n: number): { codeBefore: boolean; text: string } | null => {
    const start = starts[n]!;
    const end = start + lines[n]!.length;
    let c = -1;
    for (let j = start; j < end; j++) {
      if (kind[j] === LINE_COMMENT) {
        c = j;
        break;
      }
    }
    if (c === -1) return null;
    let codeBefore = false;
    for (let j = start; j < c; j++) {
      if (kind[j] === CODE && !/\s/.test(source[j]!)) {
        codeBefore = true;
        break;
      }
    }
    return { codeBefore, text: source.slice(c, end).trim() };
  };

  const strayMarkerLines: number[] = [];
  const malformedMarkerLines: number[] = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (!line.includes('@primary-assert')) continue;
    // A valid marker is a `// @primary-assert` line comment in code context,
    // either on its own line (assertion is the next code line) or trailing the
    // assertion. The same text inside a block comment, string, template, or as
    // a near-miss (`// @primary-assert: foo`) is not a marker.
    const lc = lineComment(n);
    if (!lc || lc.text !== MARKER) {
      malformedMarkerLines.push(n + 1);
      continue;
    }
    const firstNonWs = starts[n]! + (line.length - line.trimStart().length);
    const block = blocks.find((b) => firstNonWs > b.open && firstNonWs < b.close);
    if (block) block.markers.push({ line: n + 1, sameLine: lc.codeBefore });
    else strayMarkerLines.push(n + 1);
  }

  const mutations: Mutation[] = [];
  const unmarkedTests: SpecPlan['unmarkedTests'] = [];
  const onlyTestLines: number[] = [];
  for (const block of blocks) {
    const testLine = lineOf(block.anchor);
    if (block.mode === 'only') onlyTestLines.push(testLine);
    if (block.markers.length === 0) {
      if (!UNGATEABLE_MODES.has(block.mode)) {
        unmarkedTests.push({ title: block.title, line: testLine });
      }
      continue;
    }
    const marker = block.markers[0]!;
    const base = { testTitle: block.title, testLine, markerLine: marker.line };
    if (UNGATEABLE_MODES.has(block.mode)) {
      const why =
        block.mode === 'fail'
          ? 'test.fail() expects failure, so a mutation verdict would be meaningless'
          : `test.${block.mode}() never runs, so a mutation cannot be observed`;
      mutations.push({ ...base, assertLine: null, cannotMutate: why });
      continue;
    }
    if (block.markers.length > 1) {
      mutations.push({
        ...base,
        assertLine: null,
        cannotMutate: `found ${block.markers.length} @primary-assert markers in one test, expected exactly one`,
      });
      continue;
    }
    // A trailing marker sits on the assertion itself; a whole-line marker
    // points at the next line that contains code (blank and comment-only lines
    // are skipped, not mutated).
    let target: number; // 0-based index of the assertion line
    if (marker.sameLine) {
      target = marker.line - 1;
    } else {
      target = marker.line; // 0-based index of the line after the marker
      while (target < lines.length && !lineHasCode(target)) target++;
      if (target >= lines.length) {
        mutations.push({ ...base, assertLine: null, cannotMutate: 'no code line follows the marker' });
        continue;
      }
    }
    const inverted = invertAssertLine(lines[target]!);
    if ('cannotMutate' in inverted) {
      mutations.push({ ...base, assertLine: target + 1, cannotMutate: inverted.cannotMutate });
      continue;
    }
    const mutatedLines = lines.slice();
    mutatedLines[target] = inverted.ok;
    mutations.push({ ...base, assertLine: target + 1, mutatedSource: mutatedLines.join('\n') });
  }

  return { mutations, unmarkedTests, strayMarkerLines, malformedMarkerLines, onlyTestLines };
}

/**
 * Name for a mutated copy: the marker segment goes right after the first
 * dot-segment of the basename, so the ENTIRE original tail is preserved and
 * the copy matches whatever testMatch convention picked up the original
 * (`checkout.e2e.ts` -> `checkout.pmg-mutation-0.e2e.ts`).
 */
export function mutationFilePath(specPath: string, index: number, tag = ''): string {
  const base = basename(specPath);
  const dot = base.indexOf('.', 1); // a leading dot (dotfile) stays with the stem
  const stem = dot === -1 ? base : base.slice(0, dot);
  const tail = dot === -1 ? '' : base.slice(dot);
  const marker = tag === '' ? `pmg-mutation-${index}` : `pmg-mutation-${index}-${tag}`;
  return join(dirname(specPath), `${stem}.${marker}${tail}`);
}

/**
 * Write the mutated copy next to the original spec (same dir keeps relative
 * imports and the Playwright testDir working) and return its path. The name
 * carries the process id so overlapping gate runs in one checkout cannot
 * collide. The caller owns cleanup.
 */
export function writeMutationFile(specPath: string, index: number, mutatedSource: string): string {
  const path = mutationFilePath(specPath, index, process.pid.toString(36));
  writeFileSync(path, mutatedSource);
  return path;
}
