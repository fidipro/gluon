#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Builds the Grok models table (issue #39, #89; the builder is `src/cost/grok-catalog.ts`) from Grok Build's own binary: its embedded
 * `default_models.json` (plain JSON in the binary's data: model ids, context windows, the auto-compact
 * threshold; price fields only if a future version carries any), read as bytes and parsed with
 * `JSON.parse`, never evaluated, and Grok is never run for it (but for `--version`, unless
 * `--grok-version` says it).
 *   bun scripts/pricing/grok.ts --binary <path> [--grok-version 1.0.46] --out path [--generated-at 2026-10-04] [--observed path] [--modelsdev path]
 * Models the binary lacks that models.dev has for xAI (a newer model than the installed Grok) get their
 * price seeded from models.dev, marked (`costSource`: "models.dev-seed"), as do the prices of the binary's
 * own models, which its catalog doesn't carry: the xAI server prices a request. Their window is never
 * models.dev's: it is the hand-maintained `grok-observed-windows.json`'s (`source`: "observed"), else none.
 * A model that table holds and the binary now lists gets the binary's window, and a notice says to remove
 * it from the table. Deterministic for a binary and a day (`generatedAt` is the date).
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { grokTable } from "../../src/cost/grok-catalog.ts";
import { parseTable } from "../../src/cost/table-schema.ts";
import type { GrokObservedWindowsTable, ModelsDevTable } from "../../src/cost/tables.ts";
import { generatedDay } from "./stable.ts";

export { defaultModels, grokTable, trim } from "../../src/cost/grok-catalog.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT = arg("--out") ?? "";

if (import.meta.main) {
  if (!OUT) throw new Error("no output: pass --out <path> (Gluon's tables live in its state directory, never in the repository)");
  const binary = arg("--binary");
  if (!binary) throw new Error("no grok binary: pass --binary <path>");
  const real = realpathSync(binary);
  const version = arg("--grok-version") ?? Bun.spawnSync([real, "--version"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GROK_DISABLE_AUTOUPDATER: "1" } }).stdout.toString().trim().split(/\s+/).find((w) => /^\d+\.\d+/.test(w)) ?? "";
  const bytes = readFileSync(real);
  let observed: GrokObservedWindowsTable | undefined;
  const observedPath = arg("--observed");
  if (observedPath) {
    const parsed = parseTable("grok-observed-windows", readFileSync(observedPath, "utf8"));
    if ("problem" in parsed) throw new Error(`--observed ${observedPath}: ${parsed.problem}`);
    observed = parsed.table as unknown as GrokObservedWindowsTable;
  }
  // models.dev's table seeds the prices the binary lacks (none given: no seed).
  let modelsdev: ModelsDevTable | undefined;
  const devPath = arg("--modelsdev");
  if (devPath) {
    const parsed = parseTable("modelsdev", readFileSync(devPath, "utf8"));
    if ("problem" in parsed) throw new Error(`--modelsdev ${devPath}: ${parsed.problem}`);
    modelsdev = parsed.table as unknown as ModelsDevTable;
  }
  const table = grokTable(bytes, { grokVersion: version, modelsdev, observed, notice: (line) => console.log(`notice: ${line}`), generatedAt: generatedDay(OUT, grokTable(bytes, { grokVersion: version, modelsdev, observed, generatedAt: "" }), arg("--generated-at")) });
  writeFileSync(OUT, `${JSON.stringify(table, null, 1)}\n`);
  console.log(`${Object.keys(table.models).length} models, Grok ${version} -> ${OUT}`);
}
