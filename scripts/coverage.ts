#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun run test:coverage [--area a,b] [--shards N]`: the unit tests under `bun test --coverage` (lcov,
 * in `qa/logs/coverage/`), folded per area through `test/areas.ts` into a table of line and function
 * coverage per file; files under 50 % of their lines are flagged. Local and on demand, never part of
 * the regression.
 *
 * E2E tests start Gluon as a subprocess, so their coverage can't be measured here: a `src` file the
 * manifest lists as `e2eOnly` shows `e2e` where no unit test reaches it, not 0. One process by default:
 * function counts can't be merged across shards (lcov carries only their totals; a merged figure is the
 * larger shard's, a lower bound), line counts can.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AREAS, ROOT, matches, selectAreas, srcFiles, srcOwner, unitTestFiles } from "../test/areas.ts";
import { readTimes, unitShards } from "./test-times.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return argv[i]!.includes("=") ? argv[i]!.split("=")[1] : argv[i + 1];
};
const only = opt("--area")?.split(",").filter(Boolean);
if (only?.some((a) => !(a in AREAS))) {
  console.error(`unknown area: ${only.filter((a) => !(a in AREAS)).join(", ")}\nareas: ${Object.keys(AREAS).join(", ")}`);
  process.exit(2);
}
const shards = Math.max(1, Math.floor(Number(opt("--shards"))) || 1);
const dir = join(ROOT, "qa", "logs", "coverage");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const files = only ? selectAreas(only).unit : unitTestFiles();
const groups = unitShards(readTimes(), "full", files, shards);
if (!groups.length) {
  console.log("no unit tests selected");
  process.exit(0);
}

console.log(`coverage: ${files.length} unit file(s) in ${groups.length} process(es)${only ? ` (areas ${only.join(", ")})` : ""}`);
const started = performance.now();
const runs = await Promise.all(
  groups.map(async (g, i) => {
    const p = Bun.spawn([process.execPath, "test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${join(dir, String(i))}`, ...g], { cwd: ROOT, env: process.env, stdout: "pipe", stderr: "pipe" });
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: o + e, lcov: join(dir, String(i), "lcov.info") };
  }),
);
for (const r of runs) console.log(r.out.split("\n").filter((l) => r.code !== 0 || /^\s*\d+ (pass|fail|skip)|^Ran /.test(l)).join("\n").trimEnd());
if (runs.some((r) => r.code !== 0)) console.log("some unit tests failed: the figures below are for what ran");

// ── lcov → per file {lines: Map(line → hits), fnFound, fnHit} ──
type Cov = { lines: Map<number, number>; fnFound: number; fnHit: number };
const cov = new Map<string, Cov>();
for (const r of runs) {
  let text = "";
  try {
    text = readFileSync(r.lcov, "utf8");
  } catch {
    continue;
  }
  let cur: Cov | undefined;
  const seen = new Set<Cov>();
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      const f = line.slice(3).replaceAll("\\", "/").replace(`${ROOT.replaceAll("\\", "/")}/`, "");
      cur = f.startsWith("src/") ? (cov.get(f) ?? cov.set(f, { lines: new Map(), fnFound: 0, fnHit: 0 }).get(f)!) : undefined;
      if (cur) seen.add(cur);
    } else if (!cur) continue;
    else if (line.startsWith("DA:")) {
      const [n, h] = line.slice(3).split(",").map(Number);
      cur.lines.set(n!, (cur.lines.get(n!) ?? 0) + h!);
    } else if (line.startsWith("FNF:")) cur.fnFound = Math.max(cur.fnFound, Number(line.slice(4)));
    else if (line.startsWith("FNH:")) cur.fnHit = Math.max(cur.fnHit, Number(line.slice(4)));
  }
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const e2eOnly = (f: string) => Object.values(AREAS).some((a) => matches(a.e2eOnly ?? [], f));
const unmeasured = (f: string) => Object.values(AREAS).map((a) => Object.entries(a.unmeasured ?? {}).find(([g]) => matches([g], f))?.[1]).find(Boolean);
const code = srcFiles().filter((f) => /\.tsx?$/.test(f));
type Row = { f: string; lf: number; lh: number; ff: number; fh: number; loaded: boolean };
const rows = new Map<string, Row[]>();
for (const f of code) {
  const owner = srcOwner(f) ?? "(no area)";
  const c = cov.get(f);
  const lf = c?.lines.size ?? 0;
  const lh = c ? [...c.lines.values()].filter((h) => h > 0).length : 0;
  (rows.get(owner) ?? rows.set(owner, []).get(owner)!).push({ f, lf, lh, ff: c?.fnFound ?? 0, fh: c?.fnHit ?? 0, loaded: !!c });
}

const out: string[] = [];
const w = Math.max(...code.map((f) => f.length)) + 2;
let totals = { lf: 0, lh: 0, ff: 0, fh: 0 };
out.push(`${"area / file".padEnd(w)}  ${"lines".padStart(7)}  ${"".padStart(11)}  ${"funcs".padStart(7)}  ${"".padStart(9)}  note`);
const order = Object.keys(AREAS);
for (const [area, rs] of [...rows].filter(([a]) => !only || only.includes(a)).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))) {
  const s = rs.reduce((a, r) => ({ lf: a.lf + r.lf, lh: a.lh + r.lh, ff: a.ff + r.ff, fh: a.fh + r.fh }), { lf: 0, lh: 0, ff: 0, fh: 0 });
  totals = { lf: totals.lf + s.lf, lh: totals.lh + s.lh, ff: totals.ff + s.ff, fh: totals.fh + s.fh };
  out.push("", `${area.padEnd(w)}  ${pct(s.lh, s.lf).padStart(7)}  ${`${s.lh}/${s.lf}`.padStart(11)}  ${pct(s.fh, s.ff).padStart(7)}  ${`${s.fh}/${s.ff}`.padStart(9)}  ${rs.length} files`);
  for (const r of rs.sort((a, b) => a.lh / (a.lf || 1) - b.lh / (b.lf || 1))) {
    const only_e2e = e2eOnly(r.f);
    const none = !r.loaded || r.lh === 0;
    const low = r.lf > 0 && r.lh / r.lf < 0.5;
    const why = unmeasured(r.f);
    const note = why ? `unmeasured: ${why}` : only_e2e ? (none ? "e2e" : low ? "LOW unit (+e2e)" : "(+e2e)") : !r.loaded ? "LOW not loaded by any unit test" : low ? "LOW" : r.lf === 0 ? "no lines" : "";
    const cols = only_e2e && none ? `${"e2e".padStart(7)}  ${"".padStart(11)}  ${"e2e".padStart(7)}  ${"".padStart(9)}` : `${pct(r.lh, r.lf).padStart(7)}  ${`${r.lh}/${r.lf}`.padStart(11)}  ${pct(r.fh, r.ff).padStart(7)}  ${`${r.fh}/${r.ff}`.padStart(9)}`;
    out.push(`  ${r.f.padEnd(w - 2)}  ${cols}  ${note}`);
  }
}
out.push("", `${"total (unit tests only)".padEnd(w)}  ${pct(totals.lh, totals.lf).padStart(7)}  ${`${totals.lh}/${totals.lf}`.padStart(11)}  ${pct(totals.fh, totals.ff).padStart(7)}  ${`${totals.fh}/${totals.ff}`.padStart(9)}`);
const all = [...rows].filter(([a]) => !only || only.includes(a)).flatMap(([, r]) => r);
const low = (r: Row) => !r.loaded || (r.lf > 0 && r.lh / r.lf < 0.5);
out.push(
  `${all.filter((r) => low(r) && !e2eOnly(r.f) && !unmeasured(r.f)).length} file(s) under 50% of lines and not e2e-covered (LOW); ${all.filter((r) => e2eOnly(r.f) && low(r)).length} e2e-covered ones under 50% by unit tests alone; ${all.filter((r) => unmeasured(r.f)).length} unmeasured; ${((performance.now() - started) / 1000).toFixed(0)} s`,
);
console.log(out.join("\n"));
writeFileSync(join(dir, "table.txt"), out.join("\n") + "\n");
console.log(`\nlcov and this table: ${join("qa", "logs", "coverage")}/`);
process.exit(runs.every((r) => r.code === 0) ? 0 : 1);
