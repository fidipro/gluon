#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun run regression` (the fast tier) and `bun run regression:full` (`--full`): typecheck, then
 * the unit tests in shards (separate processes: `--parallel` can't run Ink's Yoga twice), then the
 * e2e scenarios. The fast tier leaves out the tests whose title carries `@full` and keeps its
 * memory low (3 unit shards, `GLUON_E2E_CONCURRENCY` apps at once); the full tier runs everything
 * with 4 shards. `GLUON_UNIT_SHARDS` overrides the shards.
 *
 * Narrower runs (areas: `test/areas.ts`; same `@full` rule, `--full` lifts it): `--area a,b` (also
 * `bun run test:area a,b`), `--changed [ref]` (the files changed since the merge-base with `ref`,
 * default origin/main, plus uncommitted ones; a core or unknown file means the fast tier), and
 * `--list` (print what would run and stop).
 *
 * After a run: the slowest files, the non-`@full` tests over 3 s (candidates for `@full`), and the
 * peak memory of the whole process tree (Linux). Test times are kept in `qa/logs/test-times.json`
 * and balance the next run's shards.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { AREAS, ROOT, selectAreas, selectChanged, unitTestFiles, type Selection } from "../test/areas.ts";
import { defaultApps } from "./e2e-concurrency.ts";
import { FULL_OVER_S, readTimes, saveTimes, unitShards } from "./test-times.ts";

const HELP = `usage: bun run regression [--full] [--area a,b | --changed [ref]] [--stages a,b] [--list]
  (none)           the fast tier: typecheck + unit + e2e without the tests titled @full
  --full           also the @full tests (bun run regression:full)
  --area a,b       only those areas' unit and e2e tests (bun run test:area a,b); areas: ${Object.keys(AREAS).join(", ")}
  --changed [ref]  the areas of the files changed since merge-base(ref or origin/main, HEAD), uncommitted ones too
  --stages a,b     only those stages (typecheck, unit, e2e), to time or meter one of them
  --list           print what would run, then stop
env: GLUON_UNIT_SHARDS (unit processes), GLUON_E2E_CONCURRENCY (apps at once), GLUON_TEST_CASES (a file: every test run, as JSON)`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const full = argv.includes("--full");
const list = argv.includes("--list");
let areaArg: string | undefined;
let changedArg: string | true | undefined;
let stagesArg: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const next = argv[i + 1];
  if (a === "--full" || a === "--list" || a === "--") continue;
  else if (a === "--area") areaArg = next && !next.startsWith("--") ? (i++, next) : "";
  else if (a.startsWith("--area=")) areaArg = a.slice(7);
  else if (a === "--changed") changedArg = next && !next.startsWith("--") ? (i++, next) : true;
  else if (a.startsWith("--changed=")) changedArg = a.slice(10) || true;
  else if (a === "--stages") stagesArg = next && !next.startsWith("--") ? (i++, next) : "";
  else if (a.startsWith("--stages=")) stagesArg = a.slice(9);
  else {
    console.error(`unknown argument: ${a}\n${HELP}`);
    process.exit(2);
  }
}
if (areaArg !== undefined && changedArg !== undefined) {
  console.error("--area and --changed don't combine\n" + HELP);
  process.exit(2);
}

const STAGES = ["typecheck", "unit", "e2e"];
const stages = stagesArg === undefined ? STAGES : stagesArg.split(",").map((x) => x.trim()).filter(Boolean);
if (!stages.length || stages.some((x) => !STAGES.includes(x))) {
  console.error(`--stages takes some of: ${STAGES.join(", ")}\n${HELP}`);
  process.exit(2);
}
const wanted = Math.floor(Number(process.env.GLUON_UNIT_SHARDS));
const shards = wanted >= 1 ? wanted : full ? 4 : 3;
const bun = process.execPath;
const filter = full ? [] : ["-t", "^(?!.*@full)"];
const tier = full ? "full" : "fast";

const apps = defaultApps();

const git = (args: string[]): string | null => {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, env: process.env, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString() : null;
};

/** The files changed since the merge-base with `ref`, plus uncommitted and untracked ones. */
function changedFiles(ref: string | undefined): { files: string[]; base: string } | { error: string } {
  const bases = ref ? [ref] : ["origin/main", "main", "master"];
  let base: string | undefined;
  for (const b of bases) {
    const mb = git(["merge-base", b, "HEAD"])?.trim();
    if (mb) {
      base = mb;
      break;
    }
  }
  if (!base) return { error: `no merge-base with ${bases.join(" / ")}` };
  const diff = git(["diff", "--no-renames", "--name-only", base]);
  const fresh = git(["ls-files", "--others", "--exclude-standard"]);
  if (diff === null || fresh === null) return { error: "git diff failed" };
  return { files: [...new Set([...diff.split("\n"), ...fresh.split("\n")].filter(Boolean))], base: base.slice(0, 9) };
}

// What to run. `sel === undefined` is the whole tier.
let sel: (Selection & { kind: "areas" }) | undefined;
let title = full ? "full tier" : "fast tier";
let notes: string[] = [];
if (areaArg !== undefined) {
  const names = areaArg.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !(n in AREAS));
  if (!names.length || bad.length) {
    console.error(`${bad.length ? `unknown area: ${bad.join(", ")}` : "--area needs a name"}\nareas: ${Object.keys(AREAS).join(", ")}`);
    process.exit(2);
  }
  sel = selectAreas(names);
  title = `${tier} tier, area ${names.join(", ")}`;
} else if (changedArg !== undefined) {
  const c = changedFiles(changedArg === true ? undefined : changedArg);
  if ("error" in c) {
    title = `${tier} tier (--changed: ${c.error}, so everything)`;
  } else {
    const s = selectChanged(c.files);
    notes = s.why;
    if (s.kind === "areas") {
      sel = s;
      title = `${tier} tier, changed since ${c.base} (${c.files.length} files): ${s.areas.join(", ") || "test files only"}`;
    } else if (s.kind === "none") {
      title = `${tier} tier, changed since ${c.base} (${c.files.length} files): nothing a test reads`;
      sel = selectAreas([]);
    } else {
      title = `${tier} tier (changed since ${c.base}: ${s.why[0]})`;
    }
  }
}

const unitAll = sel ? sel.unit : unitTestFiles();
const e2eFiles = sel?.e2e.map((f) => `./${f}`);

type Result = { label: string; code: number; out: string };
const tmp = mkdtempSync(join(tmpdir(), "gluon-regression-"));
const junits: { file: string; kind: "unit" | "e2e" }[] = [];

const children = new Set<ReturnType<typeof Bun.spawn>>();
// A killed regression ends its runs: each `bun test` sweeps its own processes on a signal (test/preload.ts), and would otherwise run on, orphaned (BUG-573).
for (const [signal, n] of [["SIGINT", 2], ["SIGHUP", 1], ["SIGTERM", 15]] as const) {
  process.on(signal, async () => {
    for (const c of children) {
      try {
        c.kill(signal);
      } catch {}
    }
    await Promise.race([Promise.all([...children].map((c) => c.exited)), Bun.sleep(8000)]);
    for (const c of children) c.kill(9);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(128 + n);
  });
}

/** Run `argv`; for a `bun test` run, with Bun's JUnit reporter so the durations can be read after. */
async function run(label: string, argv: string[], junit?: "unit" | "e2e"): Promise<Result> {
  const out = junit ? join(tmp, `${junits.length + 1}.xml`) : "";
  if (junit) junits.push({ file: out, kind: junit });
  const p = Bun.spawn(junit ? [...argv, "--reporter=junit", `--reporter-outfile=${out}`] : argv, { stdout: "pipe", stderr: "pipe", env: process.env });
  children.add(p);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  children.delete(p);
  return { label, code, out: stdout + stderr };
}

function report(rs: Result[]) {
  for (const r of rs) {
    // Bun prints each failure as `(fail) …` and its totals last; a passing shard prints only its totals.
    const lines = r.out.split("\n");
    const shown = r.code === 0 ? lines.filter((l) => /^\s*\d+ (pass|fail|skip)|^Ran /.test(l)) : lines;
    console.log(`── ${r.label}: ${r.code === 0 ? "ok" : "FAILED"}\n${shown.join("\n").trimEnd()}`);
  }
  return rs.every((r) => r.code === 0);
}

const times = readTimes();
const groups = unitShards(times, tier, unitAll, shards);

// ── memory meter (Linux: /proc; the whole process tree, every ~250 ms) ───────
type Peak = { rss: number; pss: number; procs: number; stages: Record<string, number> };
function startMeter(): { stage(name: string): void; stop(): Peak | string } {
  if (process.platform !== "linux") return { stage() {}, stop: () => `peak memory not measured on ${process.platform} (needs /proc)` };
  let peakRss = 0;
  let peakPss = 0;
  let peakProcs = 0;
  let stage = "start";
  const stages: Record<string, number> = {};
  const kb = (s: string, key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(s)?.[1] ?? 0);
  const sample = () => {
    const kids = new Map<number, number[]>();
    const rss = new Map<number, number>();
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = readFileSync(`/proc/${d}/status`, "utf8");
        const ppid = Number(/^PPid:\s+(\d+)/m.exec(st)?.[1] ?? 0);
        kids.set(ppid, [...(kids.get(ppid) ?? []), Number(d)]);
        rss.set(Number(d), kb(st, "VmRSS"));
      } catch {} // gone already
    }
    const tree: number[] = [];
    for (const todo = [process.pid]; todo.length; ) {
      const p = todo.pop()!;
      tree.push(p);
      todo.push(...(kids.get(p) ?? []));
    }
    const r = tree.reduce((a, p) => a + (rss.get(p) ?? 0), 0);
    stages[stage] = Math.max(stages[stage] ?? 0, r);
    if (r >= peakRss) {
      // Proportional set size: pages the processes share (the Bun binary) counted once across the tree.
      const pss = tree.reduce((a, p) => {
        try {
          return a + kb(readFileSync(`/proc/${p}/smaps_rollup`, "utf8"), "Pss");
        } catch {
          return a;
        }
      }, 0);
      peakPss = Math.max(peakPss, pss);
      peakRss = r;
    }
    peakProcs = Math.max(peakProcs, tree.length);
  };
  sample();
  const timer = setInterval(sample, 250);
  return {
    stage(name) {
      sample();
      stage = name;
    },
    stop() {
      clearInterval(timer);
      sample();
      return { rss: peakRss * 1024, pss: peakPss * 1024, procs: peakProcs, stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v * 1024])) };
    },
  };
}

// ── JUnit → durations ───────────────────────────────────────────────────────
type Case = { file: string; name: string; s: number; kind: "unit" | "e2e" };
const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([0-9a-f]+));/gi, (_, n, d, h) => (n ? ENTITY[n.toLowerCase()]! : String.fromCodePoint(d ? Number(d) : parseInt(h, 16))));
function readCases(): Case[] {
  const cases: Case[] = [];
  for (const j of junits) {
    let xml = "";
    try {
      xml = readFileSync(j.file, "utf8");
    } catch {
      continue; // a run that never wrote its report (killed)
    }
    for (const m of xml.matchAll(/<testcase\b([^>]*?)\/?>/g)) {
      const a: Record<string, string> = {};
      for (const kv of m[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) a[kv[1]!] = unxml(kv[2]!); // (Bun escapes a classname twice: unxml'd again below)
      if (a.file) cases.push({ file: a.file.replaceAll("\\", "/"), name: [a.classname && unxml(a.classname), a.name].filter(Boolean).join(" "), s: Number(a.time) || 0, kind: j.kind });
    }
  }
  return cases;
}

const dur = (s: number) => (s >= 90 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s.toFixed(1)}s`);
const gb = (b: number) => `${(b / 2 ** 30).toFixed(2)} GB`;

function summarize(cases: Case[], wallS: number, mem: Peak | string) {
  console.log(`── wall time by stage: ${walls.map(([k, v]) => `${k} ${dur(v)}`).join(", ")}`);
  const perFile = new Map<string, { s: number; kind: Case["kind"] }>();
  for (const c of cases) perFile.set(c.file, { s: (perFile.get(c.file)?.s ?? 0) + c.s, kind: c.kind });
  const top = [...perFile].sort((a, b) => b[1].s - a[1].s).slice(0, 10);
  if (top.length) {
    console.log("── slowest files (sum of their tests' times; e2e tests overlap, so theirs read high)");
    for (const [f, v] of top) console.log(`  ${v.s.toFixed(1).padStart(6)} s  ${v.kind.padEnd(4)}  ${f}`);
  }
  if (!full) {
    const slow = cases.filter((c) => c.s > FULL_OVER_S && !c.name.includes("@full")).sort((a, b) => b.s - a.s);
    if (slow.length) {
      console.log(`── candidates for @full: ${slow.length} test(s) over ${FULL_OVER_S} s without it (e2e measured with ${apps} apps at once)`);
      for (const c of slow) console.log(`  ${c.s.toFixed(1).padStart(6)} s  ${c.file} :: ${c.name.length > 150 ? `${c.name.slice(0, 149)}…` : c.name}`);
    }
  }
  const m = typeof mem === "string" ? mem : `peak memory of the process tree: ${gb(mem.rss)} RSS (${gb(mem.pss)} PSS, shared pages once), up to ${mem.procs} processes; RSS by stage: ${Object.entries(mem.stages).filter(([k]) => k !== "start").map(([k, v]) => `${k} ${gb(v)}`).join(", ")}`;
  console.log(`── ${dur(wallS)} total · ${m}`);
}

// ── the run ─────────────────────────────────────────────────────────────────
if (list) {
  console.log(`regression: ${title}`);
  for (const n of notes) console.log(`  ${n}`);
  console.log("typecheck: yes");
  const left = full ? "" : ", @full tests left out";
  console.log(`unit: ${unitAll.length} file(s) in ${groups.length} process(es)${left}`);
  if (sel || unitAll.length <= 12) for (const f of unitAll) console.log(`  ${f}`);
  if (!sel) console.log(`e2e: every file in test/e2e, ${apps} apps at once${left}`);
  else console.log(`e2e: ${e2eFiles!.length} file(s), ${apps} apps at once${left}`);
  for (const f of sel?.e2e ?? []) console.log(`  ${f}`);
  for (const h of sel?.hooks ?? []) console.log(`by hand (${h.area}/${h.name}): ${h.cmd}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

console.log(`regression: ${title}; ${groups.length || "no"} unit process(es), e2e ${apps} apps at once`);
const started = performance.now();
const meter = startMeter();
const walls: [string, number][] = [];
/** Run one stage and note its wall time (printed at the end with the peak memory). */
async function timed<T>(name: string, f: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await f();
  } finally {
    walls.push([name, (performance.now() - t0) / 1000]);
  }
}

async function main(): Promise<number> {
  meter.stage("typecheck");
  if (stages.includes("typecheck") && !report([await timed("typecheck", () => run("typecheck", [bun, "run", "typecheck"]))])) return 1;
  meter.stage("unit");
  if (stages.includes("unit") && groups.length && !report(await timed("unit", () => Promise.all(groups.map((files, i) => run(`unit ${i + 1}/${groups.length}`, [bun, "test", ...filter, ...files], "unit")))))) return 1;
  meter.stage("e2e");
  if (stages.includes("e2e") && (!e2eFiles || e2eFiles.length)) {
    const target = e2eFiles ?? ["test/e2e"];
    if (!report([await timed("e2e", () => run("e2e", [bun, "test", "--concurrent", `--max-concurrency=${apps}`, ...filter, ...target], "e2e"))])) return 1;
  }
  if (!groups.length && !e2eFiles?.length) console.log("nothing to run after the typecheck: no test file selected");
  return 0;
}
const code = await main();
const cases = readCases();
summarize(cases, (performance.now() - started) / 1000, meter.stop());
saveTimes(times, tier, cases);
// GLUON_TEST_CASES=<file>: every test of the run (file, title, seconds) as JSON, for counting a tier per area.
if (process.env.GLUON_TEST_CASES) await Bun.write(process.env.GLUON_TEST_CASES, JSON.stringify(cases));
for (const h of sel?.hooks ?? []) console.log(`by hand (${h.area}/${h.name}): ${h.cmd}`);
rmSync(tmp, { recursive: true, force: true });
process.exit(code);
