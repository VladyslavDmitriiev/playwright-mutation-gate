import { describe, expect, it } from 'vitest';

import * as api from '../src/index.js';

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
        },
      ],
      { requireSentinel: true },
    );
    expect(summary.killed).toBe(1);
    expect(summary.gatePassed).toBe(true);
  });
});
