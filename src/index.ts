// Programmatic entry point.
//
// The CLI (`dist/cli.js`) is one consumer of this library; another is any tool
// that wants to run the gate in-process and inspect the report itself — e.g. a
// custom test-pipeline that already knows which specs changed and wants the
// structured `SpecResult`/`Summary` without shelling out and parsing `--json`.
//
// Curated surface: run a spec, summarize/render the results, and (advanced) plan
// or invert individual mutations. The tokenizer (`lex.ts`) and the on-disk
// mutant-file mechanics stay internal — `runSpec` orchestrates them for you.

export {
  runSpec,
  sweepStaleMutationFiles,
  DEFAULT_TIMEOUT_MS,
  type SpecResult,
  type MutationResult,
  type Verdict,
  type RunOptions,
} from './run.js';

export {
  summarize,
  jsonReport,
  renderTable,
  type Summary,
  type GateOptions,
  type RenderOptions,
} from './report.js';

// Advanced: build or inspect the mutation plan directly.
export {
  planSpecMutations,
  MARKER,
  type SpecPlan,
  type Mutation,
  type PlanOptions,
} from './mutate.js';

export { invertAssertLine, type InvertResult } from './invert.js';
