#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Validates generated price tables (issue #39, #89): the check of a fresh table (`--shape-only`: Gluon accepts a big move and logs it, so
 * only a table it would refuse is a failure) and, with a baseline, the change guard of a table kept by hand:
 *   bun scripts/pricing/validate.ts [--shape-only | --accept-large | --report-large <file>] [--baseline <dir>] <table.json>…
 * Each file is one of `modelsdev.json`, `claude-catalog.json`, `codex-windows.json`, `grok-models.json`,
 * `grok-observed-windows.json` (by its name; the last is written by hand: its shape only is checked). Two checks (`src/cost/table-schema.ts`, shared with `gluon pricing update`):
 *  - the shape: a per-file allowlist of keys and value shapes; an unknown key or a string that is no id is refused;
 *  - the change from the baseline table (`--baseline <dir>`, default `test/fixtures/tables/`: the frozen fixtures): more than 15% of the
 *    prices changed, one price more than 3x, a model gone, a new zero price on a model the committed table had are refused unless
 *    `--accept-large`, which prints what moved. The shape is never overridable.
 *  - `--shape-only` (a table just built from the live sources): no change check at all, the shape alone.
 *  - `--report-large <file>`: the change problems do not fail the run; they are written to <file>, one per
 *    line (`<table>: <problem>`, a model that disappeared first; the file is always written, empty when nothing moved too far),
 *    for a human to read. A shape problem still exits 1. Without a flag the change guard is strict.
 * Exits 1 with the reason; never runs anything it reads.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeProblems, openRouterDisagreements, parseTable, tableFile, tableNameOf } from "../../src/cost/table-schema.ts";

/** The frozen fixture tables: the baseline when none is given (no table is committed under `src/`: issue #89). */
const COMMITTED = join(import.meta.dir, "..", "..", "test", "fixtures", "tables");

/** Checks one table's text against the committed one in `baseline`; the lines it prints and whether it passes. */
export function validateFile(file: string, text: string, { baseline = COMMITTED, acceptLarge = false, reportLarge = false, shapeOnly = false }: { baseline?: string; acceptLarge?: boolean; reportLarge?: boolean; shapeOnly?: boolean } = {}): { ok: boolean; lines: string[]; large: string[] } {
  const name = tableNameOf(file);
  if (!name) return { ok: false, lines: [`pricing table refused: ${file} is not one of the tables`], large: [] };
  const parsed = parseTable(name, text);
  if ("problem" in parsed) return { ok: false, lines: [`pricing table refused: ${parsed.problem}`], large: [] };
  if (shapeOnly) return { ok: true, lines: [`ok: ${name}, shape only`], large: [] };
  const committed = join(baseline, tableFile(name));
  let previous: Record<string, unknown> | undefined;
  if (existsSync(committed)) {
    const old = parseTable(name, readFileSync(committed, "utf8"));
    // A committed table that no longer passes (the allowlist grew) is no baseline.
    if ("table" in old) previous = old.table;
  }
  const change = changeProblems(name, previous, parsed.table);
  const { moved } = change;
  // models.dev against OpenRouter's own listing: reported, never refused; the price used is OpenRouter's.
  const disagree = name === "modelsdev" ? openRouterDisagreements(previous, parsed.table) : [];
  const problems = change.problems;
  const lines: string[] = [];
  if (disagree.length) lines.push(`${name}: ${disagree.length} OpenRouter price${disagree.length === 1 ? "" : "s"} disagree with models.dev, reported:`, ...disagree.slice(0, 20).map((d) => `  ${d}`));
  if (problems.length && reportLarge) {
    lines.push(`${name}: ${problems.length} large change${problems.length === 1 ? "" : "s"}, reported for review (not refused):`, ...problems.slice(0, 20).map((p) => `  ${p}`), ...(problems.length > 20 ? [`  … ${problems.length - 20} more`] : []));
    lines.push(`ok: ${name}${previous ? `, ${moved.length} price${moved.length === 1 ? "" : "s"} moved` : ", a first table"}`);
    return { ok: true, lines, large: [...problems, ...disagree].map((p) => `${name}: ${p}`) };
  }
  if (problems.length && !acceptLarge) return { ok: false, large: [], lines: [`pricing table refused: ${name} moved too far from the committed table (--accept-large to take it):`, ...problems.slice(0, 20).map((p) => `  ${p}`), ...(problems.length > 20 ? [`  … ${problems.length - 20} more`] : [])] };
  if (problems.length) lines.push(`${name}: accepted with --accept-large:`, ...problems.map((p) => `  ${p}`), ...moved.slice(0, 200).map((m) => `  moved ${m}`));
  lines.push(`ok: ${name}${previous ? `, ${moved.length} price${moved.length === 1 ? "" : "s"} moved` : ", a first table"}`);
  return { ok: true, lines, large: reportLarge ? disagree.map((p) => `${name}: ${p}`) : [] };
}

/** The report's lines: a model that disappeared first (the likeliest to be a vendor's mistake), then the rest in order. */
export const reportOrder = (large: string[]): string[] => [...large.filter((l) => l.includes(" disappeared")), ...large.filter((l) => !l.includes(" disappeared"))];

if (import.meta.main) {
  const args = process.argv.slice(2);
  const acceptLarge = args.includes("--accept-large");
  const shapeOnly = args.includes("--shape-only");
  const b = args.indexOf("--baseline");
  const baseline = b >= 0 ? args[b + 1] : undefined;
  const r = args.indexOf("--report-large");
  const reportFile = r >= 0 ? args[r + 1] : undefined;
  const files = args.filter((a, i) => a !== "--accept-large" && a !== "--shape-only" && a !== "--baseline" && a !== "--report-large" && !(b >= 0 && i === b + 1) && !(r >= 0 && i === r + 1));
  if (!files.length || (b >= 0 && !baseline) || (r >= 0 && !reportFile) || (acceptLarge && r >= 0) || (shapeOnly && (acceptLarge || r >= 0 || b >= 0))) {
    console.error("usage: validate.ts [--shape-only | --accept-large | --report-large <file>] [--baseline <dir>] <table.json>…");
    process.exit(1);
  }
  let bad = false;
  const large: string[] = [];
  for (const file of files) {
    const res = validateFile(file, readFileSync(file, "utf8"), { acceptLarge, shapeOnly, reportLarge: r >= 0, ...(baseline ? { baseline } : {}) });
    for (const l of res.lines) (res.ok ? console.log : console.error)(l);
    large.push(...res.large);
    bad ||= !res.ok;
  }
  if (reportFile) writeFileSync(reportFile, reportOrder(large).map((l) => `${l}\n`).join(""));
  process.exit(bad ? 1 : 0);
}
