import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import type { SpecResult } from './run.js';

/**
 * A ratchet file lets an existing suite adopt the gate gradually: it lists the
 * unmarked tests that are allowed for now. Unmarked tests in the list do not
 * fail the gate; any other unmarked test still does. The list can only shrink:
 * `updateRatchet` drops entries that are no longer unmarked and never adds
 * new ones (except when it creates the file for the first time).
 *
 * Entries key on the spec path relative to the ratchet file's directory
 * (POSIX separators) plus the test title.
 */
export interface RatchetEntry {
  file: string;
  title: string;
}

export interface Ratchet {
  version: 1;
  unmarked: RatchetEntry[];
}

export const DEFAULT_RATCHET_FILE = 'pmg-ratchet.json';

export class RatchetError extends Error {}

export function loadRatchet(path: string): Ratchet {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new RatchetError(`cannot read ratchet file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const d = data as { version?: unknown; unmarked?: unknown };
  if (d.version !== 1 || !Array.isArray(d.unmarked)) {
    throw new RatchetError(`ratchet file ${path} must be {"version": 1, "unmarked": [...]}`);
  }
  const unmarked: RatchetEntry[] = [];
  for (const e of d.unmarked as unknown[]) {
    const entry = e as { file?: unknown; title?: unknown };
    if (typeof entry.file !== 'string' || typeof entry.title !== 'string') {
      throw new RatchetError(`ratchet file ${path} has an entry without a string file and title`);
    }
    unmarked.push({ file: entry.file, title: entry.title });
  }
  return { version: 1, unmarked };
}

/** Spec path as stored in the ratchet: relative to the ratchet file, POSIX. */
export function ratchetKeyFile(specPath: string, ratchetPath: string): string {
  return relative(dirname(resolve(ratchetPath)), resolve(specPath)).split(sep).join('/');
}

const key = (file: string, title: string): string => `${file}\u0000${title}`;

/**
 * Move unmarked tests listed in the ratchet from `unmarkedTests` to
 * `ratchetedTests`, so they no longer fail the gate. Returns new SpecResults;
 * the inputs are not modified.
 */
export function applyRatchet(specs: SpecResult[], ratchet: Ratchet, ratchetPath: string): SpecResult[] {
  const allowed = new Set(ratchet.unmarked.map((e) => key(e.file, e.title)));
  return specs.map((spec) => {
    const file = ratchetKeyFile(spec.specPath, ratchetPath);
    const ratcheted = spec.unmarkedTests.filter((t) => allowed.has(key(file, t.title)));
    if (ratcheted.length === 0) return spec;
    return {
      ...spec,
      unmarkedTests: spec.unmarkedTests.filter((t) => !allowed.has(key(file, t.title))),
      ratchetedTests: ratcheted,
    };
  });
}

export interface RatchetUpdate {
  ratchet: Ratchet;
  /** Entries dropped because the test is marked now or gone. */
  removed: RatchetEntry[];
  /** True when the file did not exist and was created from the current state. */
  created: boolean;
}

/**
 * Compute the tightened ratchet after a run over `specs` (their unmarked
 * tests BEFORE applyRatchet). Entries for specs not in this run are kept
 * untouched: only gated files can be judged. Without an existing file, the
 * ratchet is created from every unmarked test seen.
 */
export function updateRatchet(specs: SpecResult[], ratchetPath: string): RatchetUpdate {
  const current = specs.flatMap((spec) => {
    const file = ratchetKeyFile(spec.specPath, ratchetPath);
    return spec.unmarkedTests.map((t) => ({ file, title: t.title }));
  });
  const sort = (list: RatchetEntry[]): RatchetEntry[] =>
    [...list].sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title));

  if (!existsSync(ratchetPath)) {
    const seen = new Set<string>();
    const unique = current.filter((e) => !seen.has(key(e.file, e.title)) && seen.add(key(e.file, e.title)));
    return { ratchet: { version: 1, unmarked: sort(unique) }, removed: [], created: true };
  }
  const existing = loadRatchet(ratchetPath);
  const gatedFiles = new Set(specs.map((s) => ratchetKeyFile(s.specPath, ratchetPath)));
  const stillUnmarked = new Set(current.map((e) => key(e.file, e.title)));
  const kept: RatchetEntry[] = [];
  const removed: RatchetEntry[] = [];
  for (const e of existing.unmarked) {
    if (gatedFiles.has(e.file) && !stillUnmarked.has(key(e.file, e.title))) removed.push(e);
    else kept.push(e);
  }
  return { ratchet: { version: 1, unmarked: sort(kept) }, removed, created: false };
}

export function writeRatchet(path: string, ratchet: Ratchet): void {
  writeFileSync(path, JSON.stringify(ratchet, null, 2) + '\n');
}

/**
 * Ratchet entries for gated specs that no longer match an unmarked test: the
 * test was marked or removed, so the entry should go (`--update-ratchet`).
 * Reported, not a gate failure.
 */
export function staleRatchetEntries(specs: SpecResult[], ratchet: Ratchet, ratchetPath: string): RatchetEntry[] {
  return updateRatchet(specs, ratchetPath).removed.filter((r) =>
    ratchet.unmarked.some((e) => e.file === r.file && e.title === r.title),
  );
}
