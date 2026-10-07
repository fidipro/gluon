#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Builds the Claude catalog table (issue #39, #89; the builder is `src/cost/claude-catalog.ts`) from Claude Code's own binary: its
 * baked-in model catalog ("Hand-maintained baked-in model catalog", the source of its prices and
 * windows): per-model id, family, provider ids (Bedrock, Vertex, …), the context window, whether
 * 1M is native or opt-in (`[1m]`), and the price tier with the 5m and 1h cache-write prices; and the
 * fast-mode prices (`fastPricing`: not in the catalog but in the binary's price function, per model, by the
 * same tier shape).
 *   bun scripts/pricing/claude.ts --binary path --out path
 * The binary is always named (never taken from PATH); it is only asked its `--version` and read as bytes:
 * the literal is parsed, never evaluated (`src/cost/jsliteral.ts`; the functions are in `src/cost/claude-catalog.ts`, which `gluon pricing update` shares). Deterministic: the same binary, the same bytes.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { ANCHOR, catalogText, claudeTable } from "../../src/cost/claude-catalog.ts";

export { catalogText, fastPrices, fastPricingOf, fastPricingText, trim, type ClaudeCatalogModel, type ClaudeTier } from "../../src/cost/claude-catalog.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT = arg("--out") ?? "";

if (import.meta.main) {
  if (!OUT) throw new Error("no output: pass --out <path> (Gluon's tables live in its state directory, never in the repository)");
  const binary = arg("--binary");
  if (!binary) throw new Error("no claude binary: pass --binary <path> (a binary is never looked up on PATH)");
  const real = realpathSync(binary);
  const text = catalogText(readFileSync(real));
  if (!text) throw new Error(`no baked catalog in ${real} (the anchor "${ANCHOR}" moved: update scripts/pricing/claude.ts)`);
  const version = Bun.spawnSync([real, "--version"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, DISABLE_AUTOUPDATER: "1" } }).stdout.toString().trim().split(" ")[0] ?? "";
  const table = claudeTable(text, { version, bytes: readFileSync(real) });
  writeFileSync(OUT, `${JSON.stringify(table, null, 1)}\n`);
  console.log(`${table.models.length} models, ${Object.keys(table.pricingTiers).length} price tiers, Claude Code ${version} -> ${OUT}`);
}
