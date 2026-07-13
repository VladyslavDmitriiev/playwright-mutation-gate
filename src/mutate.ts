import { writeFileSync } from 'node:fs';

import { invertAssertLine } from './invert.js';

export const MARKER = '// @primary-assert';

export type Mutation =
  | {
      testTitle: string;
      /** 1-based line of the `// @primary-assert` marker. */
      markerLine: number;
      /** 1-based line of the assertion that was inverted. */
      assertLine: number;
      /** Full spec source with exactly this one assertion inverted. */
      mutatedSource: string;
    }
  | {
      testTitle: string;
      markerLine: number;
      /** 1-based line of the assertion candidate; null when none was located. */
      assertLine: number | null;
      cannotMutate: string;
    };

export interface SpecPlan {
  /** One entry per marked test: either a mutated copy or a cannot-mutate reason. */
  mutations: Mutation[];
  /** Runnable tests with no marker (sentinel accounting). test.skip/fixme are exempt. */
  unmarkedTests: { title: string; line: number }[];
  /** 1-based lines of markers that sit outside every test() block. */
  strayMarkerLines: number[];
}

interface TestBlock {
  title: string;
  mode: '' | 'only' | 'skip' | 'fixme';
  /** Char offset of the `test` token. */
  anchor: number;
  /** Char offsets of the call's `(` and its matching `)` (source end when unclosed). */
  open: number;
  close: number;
}

/**
 * Mark every char of `src` as code (1) or not (0): string literals, template
 * literals (minus their `${}` expressions) and comments are not code. Keeps
 * the block scan from matching `test(` or counting parens inside them.
 */
function codeMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length).fill(1);
  // '`' = inside a template literal, '{' = inside a `${}` expression.
  const stack: ('`' | '{')[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (stack[stack.length - 1] === '`') {
      mask[i] = 0;
      if (c === '\\') {
        if (i + 1 < src.length) mask[i + 1] = 0;
        i++;
      } else if (c === '`') {
        stack.pop();
      } else if (c === '$' && src[i + 1] === '{') {
        mask[i + 1] = 0;
        stack.push('{');
        i++;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      mask[i] = 0;
      i++;
      while (i < src.length && src[i] !== '\n') {
        mask[i] = 0;
        if (src[i] === '\\' && i + 1 < src.length) {
          mask[i + 1] = 0;
          i += 2;
          continue;
        }
        i++;
        if (src[i - 1] === c) break;
      }
      continue;
    }
    if (c === '`') {
      mask[i] = 0;
      stack.push('`');
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') mask[i++] = 0;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      mask[i] = 0;
      mask[i + 1] = 0;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) mask[i++] = 0;
      if (i < src.length) {
        mask[i] = 0;
        mask[i + 1] = 0;
        i += 2;
      }
      continue;
    }
    if (stack.length > 0) {
      if (c === '{') stack.push('{');
      else if (c === '}') stack.pop();
    }
    i++;
  }
  return mask;
}

/** Find the `)` matching the `(` at `open`, counting only code chars. */
function findCloseMasked(src: string, mask: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (!mask[i]) continue;
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Read the test title: the first argument when it is a plain string literal. */
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
    } else if (c === quote) {
      return title;
    } else {
      title += c;
    }
  }
  return title;
}

const TEST_ANCHOR = /\btest\s*(?:\.\s*(only|skip|fixme)\s*)?\(/g;

function findTestBlocks(src: string, mask: Uint8Array): TestBlock[] {
  const blocks: TestBlock[] = [];
  for (const m of src.matchAll(TEST_ANCHOR)) {
    if (!mask[m.index]) continue;
    // Excludes member calls like `t.test(...)`; `test.describe(` and
    // `test.step(` never match the regex in the first place.
    if (m.index > 0 && src[m.index - 1] === '.') continue;
    const open = m.index + m[0].length - 1;
    const close = findCloseMasked(src, mask, open);
    blocks.push({
      title: readTitle(src, open),
      mode: (m[1] ?? '') as TestBlock['mode'],
      anchor: m.index,
      open,
      close: close === -1 ? src.length : close,
    });
  }
  return blocks;
}

/**
 * Parse a spec source and plan its mutations: one inverted copy per marked
 * test. Anything the gate cannot honestly mutate is reported with a reason,
 * never skipped silently.
 */
export function planSpecMutations(source: string): SpecPlan {
  const mask = codeMask(source);
  const blocks = findTestBlocks(source, mask);
  const lines = source.split('\n');

  // Char offset of each line start, to map offsets to 1-based line numbers.
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let n = 0;
    while (n + 1 < starts.length && starts[n + 1]! <= offset) n++;
    return n + 1;
  };

  const markersByBlock = new Map<TestBlock, number[]>(blocks.map((b) => [b, []]));
  const strayMarkerLines: number[] = [];
  for (let n = 0; n < lines.length; n++) {
    if (lines[n]!.trim() !== MARKER) continue;
    const offset = starts[n]!;
    const block = blocks.find((b) => offset > b.open && offset < b.close);
    if (block) markersByBlock.get(block)!.push(n + 1);
    else strayMarkerLines.push(n + 1);
  }

  const mutations: Mutation[] = [];
  const unmarkedTests: SpecPlan['unmarkedTests'] = [];
  for (const block of blocks) {
    const markers = markersByBlock.get(block)!;
    if (markers.length === 0) {
      if (block.mode !== 'skip' && block.mode !== 'fixme') {
        unmarkedTests.push({ title: block.title, line: lineOf(block.anchor) });
      }
      continue;
    }
    if (markers.length > 1) {
      mutations.push({
        testTitle: block.title,
        markerLine: markers[0]!,
        assertLine: null,
        cannotMutate: `found ${markers.length} @primary-assert markers in one test, expected exactly one`,
      });
      continue;
    }
    const markerLine = markers[0]!;
    // The assertion is the next non-blank line after the marker.
    let target = markerLine; // 0-based index of the line after the marker
    while (target < lines.length && lines[target]!.trim() === '') target++;
    if (target >= lines.length) {
      mutations.push({
        testTitle: block.title,
        markerLine,
        assertLine: null,
        cannotMutate: 'no code line follows the marker',
      });
      continue;
    }
    const inverted = invertAssertLine(lines[target]!);
    if ('cannotMutate' in inverted) {
      mutations.push({
        testTitle: block.title,
        markerLine,
        assertLine: target + 1,
        cannotMutate: inverted.cannotMutate,
      });
      continue;
    }
    const mutatedLines = lines.slice();
    mutatedLines[target] = inverted.ok;
    mutations.push({
      testTitle: block.title,
      markerLine,
      assertLine: target + 1,
      mutatedSource: mutatedLines.join('\n'),
    });
  }

  return { mutations, unmarkedTests, strayMarkerLines };
}

// Playwright only picks up files matching its testMatch glob, so the mutated
// copy must keep the `.spec.ts`-style suffix of the original.
const SPEC_SUFFIX = /(?:\.(?:spec|test))?\.[cm]?[jt]sx?$/;

export function mutationFilePath(specPath: string, index: number): string {
  const m = SPEC_SUFFIX.exec(specPath);
  if (!m) return `${specPath}.pmg-mutation-${index}`;
  return `${specPath.slice(0, m.index)}.pmg-mutation-${index}${m[0]}`;
}

/**
 * Write the mutated copy next to the original spec (same dir keeps relative
 * imports and the Playwright testDir working) and return its path. The
 * caller owns cleanup.
 */
export function writeMutationFile(specPath: string, index: number, mutatedSource: string): string {
  const path = mutationFilePath(specPath, index);
  writeFileSync(path, mutatedSource);
  return path;
}
