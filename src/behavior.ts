import { extractAssertValue } from './extract.js';
import { CODE } from './lex.js';
import { analyzeSpec, UNGATEABLE_MODES, type PlanOptions } from './mutate.js';

/**
 * A behavior mutation for one marked test: either an injected copy that
 * corrupts the asserted value in transit, or a cannot-locate reason. Unlike
 * inversion (which rewrites the assertion), behavior mutation keeps the
 * assertion intact and injects a `page.route()` preamble that rewrites the
 * value the assertion names in the response, then expects the test to go red.
 */
export type BehaviorMutation =
  | {
      testTitle: string;
      testLine: number;
      markerLine: number;
      /** 1-based line of the assertion whose value is corrupted. */
      assertLine: number;
      /** The string value corrupted in the response. */
      value: string;
      /** Full spec source with the route-interception preamble injected. */
      mutatedSource: string;
    }
  | {
      testTitle: string;
      testLine: number;
      markerLine: number;
      assertLine: number | null;
      cannotLocate: string;
    };

/**
 * The token the injected handler substitutes for the asserted value. Distinct
 * enough that it will not collide with real content and will fail any equality
 * or substring assertion on the original value.
 */
const REPLACE = 'PMG_MUTATED_VALUE';

/**
 * Plan behavior mutations for a spec: for each marked test, extract the value
 * its `@primary-assert` names, confirm the test can be routed (a `page`
 * fixture is destructured), and inject a response-corrupting preamble. Every
 * test the gate cannot mutate this way is reported with a reason, never
 * skipped silently. Marker-level findings (unmarked, stray, malformed) are the
 * inversion pass's job and are not repeated here.
 */
export function planBehaviorMutations(source: string, opts: PlanOptions = {}): BehaviorMutation[] {
  const analysis = analyzeSpec(source, opts);
  const { lines, kind } = analysis;
  const mutations: BehaviorMutation[] = [];

  for (const t of analysis.markedTests) {
    const base = { testTitle: t.title, testLine: t.testLine, markerLine: t.markerLine };
    if (UNGATEABLE_MODES.has(t.mode)) {
      const why =
        t.mode === 'fail'
          ? 'test.fail() expects failure, so a behavior verdict would be meaningless'
          : `test.${t.mode}() never runs, so behavior cannot be observed`;
      mutations.push({ ...base, assertLine: t.assertLine, cannotLocate: why });
      continue;
    }
    if (t.markerCount > 1) {
      mutations.push({
        ...base,
        assertLine: t.assertLine,
        cannotLocate: `found ${t.markerCount} @primary-assert markers in one test, expected exactly one`,
      });
      continue;
    }
    if (t.assertLine === null) {
      mutations.push({ ...base, assertLine: null, cannotLocate: t.resolveError ?? 'assertion line not found' });
      continue;
    }

    const extracted = extractAssertValue(lines[t.assertLine - 1]!);
    if ('cannotLocate' in extracted) {
      mutations.push({ ...base, assertLine: t.assertLine, cannotLocate: extracted.cannotLocate });
      continue;
    }

    const callback = findCallback(source, kind, t.open, t.close);
    if ('error' in callback) {
      mutations.push({ ...base, assertLine: t.assertLine, cannotLocate: callback.error });
      continue;
    }
    if (!callback.fixtures.includes('page')) {
      mutations.push({
        ...base,
        assertLine: t.assertLine,
        cannotLocate: 'no page fixture destructured; route interception is unsupported for this test in v1',
      });
      continue;
    }

    const preamble = buildPreamble(extracted.value);
    const mutatedSource = source.slice(0, callback.bodyOpen + 1) + '\n' + preamble + source.slice(callback.bodyOpen + 1);
    mutations.push({ ...base, assertLine: t.assertLine, value: extracted.value, mutatedSource });
  }

  return mutations;
}

interface Callback {
  /** Fixture names destructured in the callback params (`{ page, request }`). */
  fixtures: string[];
  /** Char offset of the callback body's opening `{`. */
  bodyOpen: number;
}

/**
 * Locate the test callback inside a test() call: its destructured fixtures and
 * the `{` that opens its body. Supports the arrow-function form Playwright
 * tests use (`async ({ page }) => { ... }`); other forms are reported so the
 * caller can fall back to cannot-locate rather than inject blindly.
 */
function findCallback(src: string, kind: Uint8Array, open: number, close: number): Callback | { error: string } {
  // The callback's `=>` is the first arrow in code context within the call.
  let arrow = -1;
  for (let i = open; i < close; i++) {
    if (kind[i] === CODE && src[i] === '=' && src[i + 1] === '>') {
      arrow = i;
      break;
    }
  }
  if (arrow === -1) return { error: 'could not locate the test callback (arrow function expected)' };

  // The `)` closing the params sits just before the arrow.
  let j = arrow - 1;
  while (j > open && /\s/.test(src[j]!)) j--;
  if (src[j] !== ')') return { error: 'unexpected test callback parameter form' };
  let depth = 0;
  let paramOpen = -1;
  for (let k = j; k > open; k--) {
    if (kind[k] !== CODE) continue;
    if (src[k] === ')') depth++;
    else if (src[k] === '(' && --depth === 0) {
      paramOpen = k;
      break;
    }
  }
  if (paramOpen === -1) return { error: 'could not parse test callback parameters' };

  const fixtures = parseDestructuredFixtures(src.slice(paramOpen + 1, j));

  // The body opens at the first `{` in code context after the arrow.
  let bodyOpen = -1;
  for (let i = arrow + 2; i < close; i++) {
    if (kind[i] === CODE && src[i] === '{') {
      bodyOpen = i;
      break;
    }
  }
  if (bodyOpen === -1) return { error: 'test callback has no block body' };

  return { fixtures, bodyOpen };
}

/** Read fixture names from a destructured params string like `{ page, request }`. */
function parseDestructuredFixtures(params: string): string[] {
  const trimmed = params.trim();
  if (!trimmed.startsWith('{')) return []; // `(arg)` form: fixtures not detectable
  const end = trimmed.lastIndexOf('}');
  if (end <= 0) return [];
  return trimmed
    .slice(1, end)
    .split(',')
    .map((part) => part.split(':')[0]!.trim()) // `page: p` -> the source fixture name `page`
    .filter(Boolean);
}

/**
 * Build the route-interception preamble injected at the top of the test body.
 * It fetches each response, replaces every occurrence of the asserted value in
 * the headers and body with a sentinel, and records via PMG_HIT_FILE whether
 * any occurrence was found. `await import('node:fs')` keeps the preamble
 * self-contained, with no top-level import that could clash with the spec.
 */
function buildPreamble(value: string): string {
  const needle = JSON.stringify(value);
  const replace = JSON.stringify(REPLACE);
  return [
    `  await page.route('**/*', async (route) => {`,
    `    const resp = await route.fetch();`,
    `    const headers = resp.headers();`,
    `    const NEEDLE = ${needle};`,
    `    const REPLACE = ${replace};`,
    `    let hit = false;`,
    `    for (const k of Object.keys(headers)) {`,
    `      if (typeof headers[k] === 'string' && headers[k].includes(NEEDLE)) {`,
    `        headers[k] = headers[k].split(NEEDLE).join(REPLACE);`,
    `        hit = true;`,
    `      }`,
    `    }`,
    `    let body = null;`,
    `    try { body = await resp.text(); } catch {}`,
    `    if (body !== null && body.includes(NEEDLE)) {`,
    `      body = body.split(NEEDLE).join(REPLACE);`,
    `      hit = true;`,
    `    }`,
    `    if (hit && process.env.PMG_HIT_FILE) {`,
    `      const fs = await import('node:fs');`,
    `      fs.appendFileSync(process.env.PMG_HIT_FILE, '1');`,
    `    }`,
    `    await route.fulfill({ response: resp, headers, ...(body !== null ? { body } : {}) });`,
    `  });`,
  ].join('\n');
}
