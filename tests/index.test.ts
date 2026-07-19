import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as api from '../src/index.js';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { exports: { '.': { types?: string; default?: string; import?: string } } };

// The barrel is the package's public contract. This test fails the moment a
// re-export is renamed or dropped, so a breaking change to the programmatic API
// cannot ship unnoticed (it must be a deliberate semver bump).
describe('programmatic API surface', () => {
  it('exports the run + report + plan callables', () => {
    for (const name of [
      'runSpec',
      'sweepStaleMutationFiles',
      'summarize',
      'jsonReport',
      'renderTable',
      'planSpecMutations',
      'invertAssertLine',
    ] as const) {
      expect(typeof api[name], name).toBe('function');
    }
  });

  it('exports the value constants', () => {
    expect(typeof api.DEFAULT_TIMEOUT_MS).toBe('number');
    expect(api.MARKER).toBe('// @primary-assert');
  });

  it('summarize consumes a runSpec-shaped result', () => {
    const summary = api.summarize(
      [
        {
          specPath: 'fixtures/demo.spec.ts',
          results: [{ testTitle: 't', testLine: 1, assertLine: 2, verdict: 'killed' }],
          unmarkedTests: [],
          strayMarkerLines: [],
          malformedMarkerLines: [],
          malformedGateSkipLines: [],
        },
      ],
      { requireSentinel: true },
    );
    expect(summary.killed).toBe(1);
    expect(summary.gatePassed).toBe(true);
  });

  // Regression guard for 0.2.1: the `.` export must resolve for CommonJS/ts-node
  // consumers too. An `import`-only condition makes a `require()` of this ESM
  // package throw ERR_PACKAGE_PATH_NOT_EXPORTED; `default` resolves under any
  // module system. Do not narrow this back to `import`.
  it('main export resolves for CJS consumers (default condition)', () => {
    const dot = pkg.exports['.'];
    expect(dot.default ?? dot.import).toBe('./dist/index.js');
    expect(dot.import, 'use "default", not "import" — import-only breaks require()').toBeUndefined();
  });
});
