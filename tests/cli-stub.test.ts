import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Guards the bin wiring: `npm run build` must produce an executable entry
// point. Replaced by real CLI tests once the CLI lands.
describe('cli stub', () => {
  it('builds to an executable that exits 1 with a development notice', () => {
    const result = spawnSync('node', ['dist/cli.js'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('in development');
  });
});
