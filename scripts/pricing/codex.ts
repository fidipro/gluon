#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Builds the Codex windows table (issue #39, #89; the builder is `src/cost/codex-catalog.ts`) from Codex's own model catalog
 * (`codex debug models`): per model slug, the window Codex sizes a conversation by (`context`), the
 * most it allows (`max`) and the share of it a conversation may fill (`percent`), as Codex's own
 * resolution reads them (`codexCatalogWindows`, `src/cost/context.ts`).
 *   bun scripts/pricing/codex.ts --binary <codex> --out <file>
 *   bun scripts/pricing/codex.ts --catalog <catalog.json> [--codex-version v] [--generated-at date] [--note text] --out <file>
 * With `--binary` the catalog is the command's output (in a temp dir, never a model call); with
 * `--catalog` it is read from a file (a captured output, or the one bundled in the binary). Deterministic:
 * the same catalog gives the same bytes but for `generatedAt`.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildTable } from "../../src/cost/codex-catalog.ts";
import { generatedDay } from "./stable.ts";

export { buildTable } from "../../src/cost/codex-catalog.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

if (import.meta.main) {
  const out = arg("--out");
  if (!out) throw new Error("no output: pass --out <path> (Gluon's tables live in its state directory, never in the repository)");
  const file = arg("--catalog");
  let catalog: string;
  let version = arg("--codex-version") ?? "";
  if (file) catalog = readFileSync(file, "utf8");
  else {
    const binary = arg("--binary");
    if (!binary) throw new Error("no codex binary: pass --binary <path> (a binary is never looked up on PATH), or --catalog <file>");
    const real = realpathSync(binary);
    const run = (args: string[]) => Bun.spawnSync([real, ...args], { cwd: tmpdir(), stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env } });
    const r = run(["debug", "models"]);
    if (r.exitCode !== 0) throw new Error(`\`codex debug models\` failed (exit code ${r.exitCode})`);
    catalog = r.stdout.toString();
    version ||= run(["--version"]).stdout.toString().trim().split(/\s+/).pop() ?? "";
  }
  const options = { codexVersion: version, ...(arg("--note") ? { note: arg("--note")! } : {}) };
  const table = buildTable(catalog, { ...options, generatedAt: generatedDay(out, buildTable(catalog, { ...options, generatedAt: "" }), arg("--generated-at")) });
  writeFileSync(out, `${JSON.stringify(table, null, 1)}\n`);
  console.log(`${Object.keys(table.models).length} models, Codex ${version} -> ${out}`);
}
