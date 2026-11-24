import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  applyRatchet,
  loadRatchet,
  RatchetError,
  ratchetKeyFile,
  staleRatchetEntries,
  updateRatchet,
  writeRatchet,
} from '../src/ratchet.js';
import { summarize } from '../src/report.js';
import type { SpecResult } from '../src/run.js';

const dir = mkdtempSync(join(tmpdir(), 'pmg-ratchet-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const spec = (file: string, unmarked: string[]): SpecResult => ({
  specPath: join(dir, file),
  results: [],
  unmarkedTests: unmarked.map((title, i) => ({ title, line: i + 1 })),
  strayMarkerLines: [],
  malformedMarkerLines: [],
  malformedGateSkipLines: [],
});

describe('ratchet', () => {
  const path = join(dir, 'pmg-ratchet.json');

  it('keys spec paths relative to the ratchet file, POSIX style', () => {
    expect(ratchetKeyFile(join(dir, 'tests', 'a.spec.ts'), path)).toBe('tests/a.spec.ts');
  });

  it('creates the file from every unmarked test, then only lets it shrink', () => {
    const run1 = [spec('tests/a.spec.ts', ['one', 'two']), spec('tests/b.spec.ts', ['three'])];
    const created = updateRatchet(run1, path);
    expect(created.created).toBe(true);
    expect(created.ratchet.unmarked).toEqual([
      { file: 'tests/a.spec.ts', title: 'one' },
      { file: 'tests/a.spec.ts', title: 'two' },
      { file: 'tests/b.spec.ts', title: 'three' },
    ]);
    writeRatchet(path, created.ratchet);

    // 'one' got marked, 'new' appeared; b.spec.ts was not gated this time.
    const run2 = [spec('tests/a.spec.ts', ['two', 'new'])];
    const upd = updateRatchet(run2, path);
    expect(upd.created).toBe(false);
    expect(upd.removed).toEqual([{ file: 'tests/a.spec.ts', title: 'one' }]);
    expect(upd.ratchet.unmarked).toEqual([
      { file: 'tests/a.spec.ts', title: 'two' },
      { file: 'tests/b.spec.ts', title: 'three' },
    ]);
    expect(staleRatchetEntries(run2, loadRatchet(path), path)).toEqual([{ file: 'tests/a.spec.ts', title: 'one' }]);
  });

  it('allows listed unmarked tests and still fails on new ones', () => {
    const ratchet = loadRatchet(path);
    const applied = applyRatchet([spec('tests/a.spec.ts', ['two', 'new'])], ratchet, path);
    expect(applied[0]!.unmarkedTests.map((t) => t.title)).toEqual(['new']);
    expect(applied[0]!.ratchetedTests!.map((t) => t.title)).toEqual(['two']);
    const s = summarize(applied, { requireSentinel: true });
    expect(s).toMatchObject({ unmarkedTests: 1, ratchetedTests: 1, gatePassed: false });

    const onlyAllowed = applyRatchet([spec('tests/a.spec.ts', ['two'])], ratchet, path);
    expect(summarize(onlyAllowed, { requireSentinel: true }).gatePassed).toBe(true);
  });

  it('rejects malformed files', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"version": 2}');
    expect(() => loadRatchet(bad)).toThrow(RatchetError);
    writeFileSync(bad, '{"version": 1, "unmarked": [{"file": 1}]}');
    expect(() => loadRatchet(bad)).toThrow(RatchetError);
    expect(() => loadRatchet(join(dir, 'missing.json'))).toThrow(RatchetError);
    expect(existsSync(join(dir, 'missing.json'))).toBe(false);
  });
});
