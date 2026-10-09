#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun run test:health`: what in the test suite has gone stale, each line with the action to take. Cheap and
 * offline: it runs no test, calls no model and needs no login (a harness is asked `--version` only, in an empty
 * temp directory with a timeout). Exit 1 only for something definitely broken (the area manifest, a malformed or
 * repeated bug-candidate title, an unreadable baseline, a quarantine past its date or without one, a fast-tier test over
 * 3 × the `@full` threshold); stale is advice.
 * `--brief` leaves out the candidate list.
 *
 * Checks: the area manifest; the visual goldens against the UI changes since; the screen fixtures against the
 * installed harness versions; the perf baseline against the perf-relevant changes since; the test times (and the
 * tests over the fast-tier threshold that lack `@full`); the quarantined (`@quarantine`) tests; the open `BUG-CANDIDATE` /
 * `MODEL-GAP` tests; the live ledger.
 * The pure parts are exported for `test/test-health.test.ts`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binPath } from "../src/detect.ts";
import { HARNESS_INFO, type Harness } from "../src/harnesses.ts";
import { ROOT, manifestProblems } from "../test/areas.ts";
import { FULL_OVER_S, TIMES, type TimesFile } from "./test-times.ts";

export type Level = "ok" | "stale" | "info" | "BROKEN";
export type Line = { level: Level; text: string; action?: string };
export type Section = { title: string; lines: Line[] };

// ——— pure parts ———

export const DAY_MS = 86_400_000;
/** Whole days from an ISO date to `now` (never negative); null when the date doesn't parse. */
export function ageDays(iso: string | null | undefined, now: Date): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}
export const ago = (days: number | null) => (days === null ? "at an unknown date" : days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`);

/** The version a `--version` output names: its first line's first `1.2.3`-like token (the way `versionOf` in `src/status.ts` reads it). */
export function parseVersion(output: string): string | null {
  const first = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return first ? (first.match(/\d+\.\d+[\w.-]*/)?.[0] ?? null) : null;
}

const parts = (v: string) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
/** Order two versions numerically, part by part. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/** How the installed version stands against the versions the screen fixtures were captured from. */
export function fixtureStatus(installed: string, fixtures: string[]): "match" | "installed-newer" | "installed-older" | "no-fixtures" {
  if (!fixtures.length) return "no-fixtures";
  if (fixtures.includes(installed)) return "match";
  const newest = [...fixtures].sort(compareVersions).at(-1)!;
  return compareVersions(installed, newest) > 0 ? "installed-newer" : "installed-older";
}

export type Candidate = { id: string; marker: "BUG-CANDIDATE" | "MODEL-GAP"; file: string; line: number; title: string };
const MARKER = /\b(BUG-CANDIDATE|MODEL-GAP)\//g;
const STRING_ARG = /\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
/** Files that mention the markers without being candidates or quarantines (the monkey writes `test("BUG-CANDIDATE/GM-…")` into its reports; the health and guard tests hold sample titles). */
const NOT_TESTS = ["test/e2e/gluon-monkey.ts", "test/test-health.test.ts", "test/test-guards.test.ts", "test/test-style.test.ts"];

/**
 * Every test title that starts `BUG-CANDIDATE/<id>:` or `MODEL-GAP/<id>:` (the first string argument of a call, so a
 * comment never counts), and what is wrong with the ones that are malformed: a title with two ids, an id not at the
 * start (`bun test -t "<id>"` selects it anyway, but the list can't tell), an id with no number, a `describe` that carries
 * an id (the tests inside do), or the same title twice in one file. One id on several tests is fine (one bug, several measurements).
 */
export function scanCandidates(files: { path: string; text: string }[]): { candidates: Candidate[]; problems: string[] } {
  const candidates: Candidate[] = [];
  const problems: string[] = [];
  for (const f of files) {
    if (NOT_TESTS.includes(f.path)) continue;
    const seen = new Set<string>();
    for (const m of f.text.matchAll(STRING_ARG)) {
      const title = m[2]!;
      const marks = [...title.matchAll(MARKER)];
      if (!marks.length) continue;
      const at = m.index!;
      const line = f.text.slice(0, at).split("\n").length;
      const lineText = f.text.split("\n")[line - 1]!.trim();
      if (/^(\/\/|\*|\/\*)/.test(lineText)) continue;
      const where = `${f.path}:${line}`;
      const label = title.length > 70 ? `${title.slice(0, 69)}…` : title;
      if (/describe(\.\w+)*$/.test(f.text.slice(Math.max(0, at - 30), at))) {
        problems.push(`${where}: a describe carries a candidate id ("${label}"); put the id on the tests inside it`);
        continue;
      }
      if (marks.length > 1) problems.push(`${where}: a title with ${marks.length} candidate ids ("${label}")`);
      if (marks[0]!.index !== 0) {
        problems.push(`${where}: the candidate id is not at the start of the title ("${label}")`);
        continue;
      }
      const head = /^(BUG-CANDIDATE|MODEL-GAP)\/(\$\{|[A-Za-z0-9][A-Za-z0-9._-]*)(:?)/.exec(title);
      if (!head) {
        problems.push(`${where}: no id after the marker ("${label}")`);
        continue;
      }
      if (head[2] === "${") continue; // a generated title (the visual lints)
      if (head[3] !== ":" || !/\d/.test(head[2]!)) {
        problems.push(`${where}: "${head[1]}/${head[2]}" is not an id of the form <area>-<nn> followed by ":"`);
        continue;
      }
      if (seen.has(title)) problems.push(`${where}: the same title twice in this file ("${label}")`);
      seen.add(title);
      candidates.push({ id: head[2]!, marker: head[1] as Candidate["marker"], file: f.path, line, title });
    }
  }
  return { candidates, problems };
}

/** The candidates grouped by id, in id order: how many tests carry it and in which files. */
export function groupCandidates(cs: Candidate[]): { id: string; marker: string; tests: number; files: string[] }[] {
  const by = new Map<string, Candidate[]>();
  for (const c of cs) by.set(`${c.marker}/${c.id}`, [...(by.get(`${c.marker}/${c.id}`) ?? []), c]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([, v]) => ({ id: v[0]!.id, marker: v[0]!.marker, tests: v.length, files: [...new Set(v.map((c) => c.file))] }));
}

export type Quarantined = { file: string; line: number; title: string; bug: string; until: string };
const QUARANTINE = /@quarantine\b/;
/** A quarantine lasts at most this long: past it, the test is fixed or deleted, not quarantined again. */
export const QUARANTINE_MAX_DAYS = 30;
/**
 * Every test title tagged `@quarantine` (a flaky test, out of the blocking runs until fixed: `scripts/regression.ts`),
 * and what is wrong with each: a quarantine names its bug and its end, `@quarantine BUG-nn until:YYYY-MM-DD`, at
 * most QUARANTINE_MAX_DAYS ahead; past that date it is a problem.
 */
export function scanQuarantines(files: { path: string; text: string }[], now: Date): { quarantined: Quarantined[]; problems: string[] } {
  const quarantined: Quarantined[] = [];
  const problems: string[] = [];
  const today = now.toISOString().slice(0, 10);
  for (const f of files) {
    if (NOT_TESTS.includes(f.path)) continue;
    for (const m of f.text.matchAll(STRING_ARG)) {
      const title = m[2]!;
      if (!QUARANTINE.test(title)) continue;
      const line = f.text.slice(0, m.index!).split("\n").length;
      if (/^(\/\/|\*|\/\*)/.test(f.text.split("\n")[line - 1]!.trim())) continue;
      const where = `${f.path}:${line}`;
      const q = /@quarantine (BUG-\d+) until:(\d{4}-\d{2}-\d{2})\b/.exec(title);
      if (!q || Number.isNaN(Date.parse(q[2]!))) {
        problems.push(`${where}: a quarantine needs its bug and its end: "@quarantine BUG-nn until:YYYY-MM-DD"`);
        continue;
      }
      const [, bug, until] = q as unknown as [string, string, string];
      if (until < today) problems.push(`${where}: ${bug}'s quarantine ended ${until}: fix the test (and drop the tag) or delete it`);
      else if ((Date.parse(until) - Date.parse(today)) / DAY_MS > QUARANTINE_MAX_DAYS) problems.push(`${where}: ${bug}'s quarantine runs to ${until}, more than ${QUARANTINE_MAX_DAYS} days`);
      quarantined.push({ file: f.path, line, title, bug, until });
    }
  }
  return { quarantined, problems };
}

/** A fast-tier test this many times over `FULL_OVER_S` is broken, not just slow. */
export const BROKEN_OVER = 3;

/** The tests of a times file over `over` seconds whose title lacks `@full` (the slowest reading of either tier). */
export function slowTests(times: TimesFile, over: number): { file: string; name: string; s: number }[] {
  const best = new Map<string, { file: string; name: string; s: number }>();
  for (const tier of Object.values(times.tiers ?? {})) {
    for (const [file, tests] of Object.entries(tier.tests ?? {})) {
      for (const [name, s] of Object.entries(tests)) {
        if (name.includes("@full") || !(s > over)) continue;
        const k = `${file}\0${name}`;
        if (!best.has(k) || best.get(k)!.s < s) best.set(k, { file, name, s });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.s - a.s);
}

/** One line for the live ledger: dollars spent per bucket, the caps and the runs. Numbers only, never anything else from the file. */
export function ledgerSummary(file: unknown): string | null {
  const f = file as { caps?: Record<string, unknown>; spent?: Record<string, unknown>; runs?: { at?: unknown }[] } | null;
  if (!f || typeof f !== "object" || !f.spent || typeof f.spent !== "object") return null;
  const usd = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : "?");
  const spent = Object.entries(f.spent).map(([b, n]) => `${b} ${usd(n)}${typeof f.caps?.[b] === "number" ? ` of ${usd(f.caps[b])}` : ""}`);
  const runs = Array.isArray(f.runs) ? f.runs : [];
  const last = typeof runs.at(-1)?.at === "string" ? `, last ${(runs.at(-1)!.at as string).slice(0, 10)}` : "";
  return `${spent.join(", ")} (${runs.length} run${runs.length === 1 ? "" : "s"}${last})`;
}

/** The platforms a baseline has no entry for. */
export const PLATFORMS = ["linux", "darwin", "win32"];
export const baselineGaps = (baseline: Record<string, unknown>): string[] => PLATFORMS.filter((p) => !baseline[p]);

// ——— git ———

const git = (args: string[]): string | null => {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, env: process.env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};
type Commit = { hash: string; iso: string; subject: string };
function lastCommit(paths: string[]): Commit | null {
  const out = git(["log", "-1", "--format=%H%x09%cI%x09%s", "--", ...paths]);
  const [hash, iso, ...subject] = (out ?? "").split("\t");
  return hash && iso ? { hash, iso, subject: subject.join("\t") } : null;
}
/** The commits after `hash` that touch `paths`. */
const commitsSince = (hash: string, paths: string[]): number | null => {
  const n = git(["rev-list", "--count", `${hash}..HEAD`, "--", ...paths]);
  return n === null ? null : Number(n);
};

// ——— the checks ———

const now = new Date();
const UI_PATHS = ["src/ui", "src/pty/chrome.ts", "src/pty/compositor.ts", "test/visual", "test/fixtures/fake-tui.ts", ":(exclude)test/visual/__snapshots__"];
const PERF_PATHS = ["src/pty", "src/gluon.ts", "src/ui", "src/sessions.ts"];

function manifest(): Section {
  const p = manifestProblems();
  return {
    title: "Area manifest (test/areas.ts)",
    lines: p.length
      ? [...p.slice(0, 15).map((text) => ({ level: "BROKEN" as Level, text })), ...(p.length > 15 ? [{ level: "BROKEN" as Level, text: `… and ${p.length - 15} more` }] : []), { level: "info", text: "fix:", action: "add or remove the files in test/areas.ts (bun test test/areas.test.ts says the same)" }]
      : [{ level: "ok", text: "every src and test file is in one area; every listed path exists" }],
  };
}

function goldens(): Section {
  const title = "Visual goldens (test/visual/__snapshots__)";
  const snap = lastCommit(["test/visual/__snapshots__"]);
  if (!snap) return { title, lines: [{ level: "info", text: "no committed goldens found (or no git history here): skipped" }] };
  const n = commitsSince(snap.hash, UI_PATHS);
  const when = `goldens last committed ${ago(ageDays(snap.iso, now))} (${snap.hash.slice(0, 7)})`;
  if (!n) return { title, lines: [{ level: "ok", text: `${when}; no UI or frame change since` }] };
  const last = lastCommit(UI_PATHS);
  return {
    title,
    lines: [{ level: "stale", text: `${when}; ${n} commit${n === 1 ? "" : "s"} since touched src/ui, the compositor, the chrome or the visual tests${last ? ` (latest: ${last.hash.slice(0, 7)} ${last.subject.slice(0, 60)})` : ""}: goldens may be stale`, action: "bun run test:visual-must; for an intended change, bun run test:visual -u and review the diff" }],
  };
}

type Probe = { harness: Harness; binary: string; path?: string; output?: string; error?: string };
async function probeVersions(): Promise<Probe[]> {
  const cwd = mkdtempSync(join(tmpdir(), "gluon-health-"));
  try {
    return await Promise.all(
      (Object.keys(HARNESS_INFO) as Harness[]).map(async (harness): Promise<Probe> => {
        const binary = HARNESS_INFO[harness].binary;
        const path = binPath(binary);
        if (!path) return { harness, binary };
        try {
          const p = Bun.spawn([path, "--version"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
          const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
          return code === 0 ? { harness, binary, path, output: out || err } : { harness, binary, path, error: `exit ${code}` };
        } catch (e) {
          return { harness, binary, path, error: String((e as Error).message ?? e).slice(0, 80) };
        }
      }),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function screens(): Promise<Section> {
  const dir = join(ROOT, "test", "fixtures", "screens");
  const lines: Line[] = [];
  for (const p of await probeVersions()) {
    const folder = join(dir, p.harness);
    const fixtures = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
    if (!p.path) {
      lines.push({ level: "info", text: `${p.harness}: not installed, skipped (fixtures: ${fixtures.join(", ") || "none"})` });
      continue;
    }
    const v = p.output ? parseVersion(p.output) : null;
    if (!v) {
      lines.push({ level: "info", text: `${p.harness}: \`${p.binary} --version\` gave no version${p.error ? ` (${p.error})` : ""}: skipped` });
      continue;
    }
    const st = fixtureStatus(v, fixtures);
    if (st === "match") lines.push({ level: "ok", text: `${p.harness}: installed ${v} = fixtures ${fixtures.join(", ")}` });
    else {
      lines.push({
        level: "stale",
        text: `${p.harness}: installed ${v}, fixtures ${fixtures.join(", ") || "none"}${st === "installed-older" ? " (the installed one is older: update it, or capture from the one you ship)" : ""}`,
        action: `bun run test:live --tier=harness --harness=${p.harness} (a paid run: it saves the screens and diffs the input line), then re-capture as the Harness update runbook says (in the maintainers' private notes)`,
      });
    }
  }
  return { title: "Screen fixtures vs installed harnesses (test/fixtures/screens)", lines };
}

function perf(): Section {
  const title = "Perf baseline (test/perf/baseline.json)";
  const file = join(ROOT, "test", "perf", "baseline.json");
  let baseline: Record<string, unknown>;
  try {
    baseline = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { title, lines: [{ level: "BROKEN", text: `baseline.json does not parse: ${(e as Error).message}` }] };
  }
  const lines: Line[] = [];
  const c = lastCommit(["test/perf/baseline.json"]);
  const have = PLATFORMS.filter((p) => baseline[p]);
  const n = c ? commitsSince(c.hash, PERF_PATHS) : null;
  const age = c ? `last committed ${ago(ageDays(c.iso, now))} (${c.hash.slice(0, 7)}; the file has no per-platform dates)` : "no git history for it";
  if (n) lines.push({ level: "stale", text: `${have.join(", ") || "no platform"}: baseline ${age}; ${n} commit${n === 1 ? "" : "s"} since touched src/pty, src/gluon.ts, src/ui or src/sessions.ts`, action: "GLUON_PERF_QUICK=1 bun run test:perf (about 1.5 min); for an intended change, GLUON_PERF_UPDATE=1 bun run test:perf on an idle machine, with the reason in the commit" });
  else lines.push({ level: "ok", text: `${have.join(", ") || "no platform"}: baseline ${age}; no perf-relevant change since` });
  const gap = baselineGaps(baseline);
  if (gap.length) lines.push({ level: "info", text: `no baseline for ${gap.join(", ")} (only the absolute ceilings hold there)`, action: "on that machine: GLUON_PERF_UPDATE=1 bun run test:perf (idle machine; commit the file)" });
  return { title, lines };
}

function times(): Section {
  const title = "Test times (qa/logs/test-times.json)";
  if (!existsSync(TIMES)) return { title, lines: [{ level: "info", text: "no times file yet", action: "bun run regression writes it (it also balances the unit shards)" }] };
  let t: TimesFile;
  try {
    t = JSON.parse(readFileSync(TIMES, "utf8"));
  } catch (e) {
    return { title, lines: [{ level: "BROKEN", text: `test-times.json does not parse: ${(e as Error).message}`, action: "delete it; the next bun run regression rewrites it" }] };
  }
  const d = ageDays(t.updated, now);
  const lines: Line[] = [];
  lines.push(d !== null && d > 14 ? { level: "stale", text: `measured ${ago(d)}`, action: "bun run regression refreshes it" } : { level: "ok", text: `measured ${ago(d)}` });
  const slow = slowTests(t, FULL_OVER_S);
  // Far over the threshold is broken, not advice: it holds every fast run back (a wait that runs to its deadline, a loop of variants in one test).
  for (const s of slow.filter((x) => x.s > FULL_OVER_S * BROKEN_OVER)) {
    lines.push({ level: "BROKEN", text: `${s.s.toFixed(1)} s, over ${FULL_OVER_S * BROKEN_OVER} s, in the fast tier: ${s.file} :: ${s.name.length > 100 ? `${s.name.slice(0, 99)}…` : s.name}`, action: "make it faster (wait for a state, not a deadline; one test per variant, so they run at once), else add @full" });
  }
  if (slow.length) {
    lines.push({ level: "stale", text: `${slow.length} test${slow.length === 1 ? "" : "s"} over ${FULL_OVER_S} s without @full (the fast tier's threshold):`, action: "make it faster, else add @full to the title" });
    for (const s of slow.slice(0, 10)) lines.push({ level: "info", text: `  ${s.s.toFixed(1)} s  ${s.file} :: ${s.name.length > 100 ? `${s.name.slice(0, 99)}…` : s.name}` });
    if (slow.length > 10) lines.push({ level: "info", text: `  … and ${slow.length - 10} more` });
  } else lines.push({ level: "ok", text: `no test over ${FULL_OVER_S} s lacks @full` });
  return { title, lines };
}

const testFiles = () => [...new Bun.Glob("test/**/*.{ts,tsx}").scanSync({ cwd: ROOT })].filter((f) => !f.includes("node_modules")).sort().map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));

function quarantine(): Section {
  const title = "Quarantined tests (@quarantine: out of the blocking runs, in regression:full)";
  const { quarantined, problems } = scanQuarantines(testFiles(), now);
  const lines: Line[] = problems.map((text) => ({ level: "BROKEN" as Level, text }));
  lines.push({ level: quarantined.length ? "info" : "ok", text: `${quarantined.length} quarantined`, action: quarantined.length ? "fix each by its date, then drop the tag" : undefined });
  for (const q of quarantined) lines.push({ level: "info", text: `  ${q.bug} until ${q.until}  ${q.file}:${q.line}` });
  return { title, lines };
}

function candidates(brief: boolean): Section {
  const title = "Open bug candidates (BUG-CANDIDATE / MODEL-GAP tests)";
  const { candidates: cs, problems } = scanCandidates(testFiles());
  const groups = groupCandidates(cs);
  const lines: Line[] = problems.map((text) => ({ level: "BROKEN" as Level, text }));
  lines.push({ level: groups.length ? "info" : "ok", text: `${groups.length} open id${groups.length === 1 ? "" : "s"} on ${cs.length} test${cs.length === 1 ? "" : "s"}`, action: groups.length ? "when a bug is fixed: drop `.failing` and rename the test to BUG-nn/<case>; bun test -t \"<id>\" runs one" : undefined });
  if (!brief) for (const g of groups) lines.push({ level: "info", text: `  ${g.marker === "MODEL-GAP" ? "MODEL-GAP/" : ""}${g.id}${g.tests > 1 ? `  (${g.tests} tests)` : ""}  ${g.files.length > 1 ? `${g.files[0]} +${g.files.length - 1} more` : g.files[0]}` });
  return { title, lines };
}

function ledger(): Section {
  const title = "Live ledger (qa/logs/live-spend.json)";
  const file = join(ROOT, "qa", "logs", "live-spend.json");
  if (!existsSync(file)) return { title, lines: [{ level: "info", text: "no ledger: no live run has been made from this checkout" }] };
  try {
    const s = ledgerSummary(JSON.parse(readFileSync(file, "utf8")));
    return { title, lines: [s ? { level: "info", text: `spent so far: ${s}` } : { level: "info", text: "the ledger has no spent figures" }] };
  } catch {
    return { title, lines: [{ level: "info", text: "the ledger does not parse (left alone)" }] };
  }
}

export function render(sections: Section[]): { text: string; stale: number; broken: number } {
  const out: string[] = [];
  let stale = 0, broken = 0;
  for (const s of sections) {
    out.push(`\n${s.title}`);
    for (const l of s.lines) {
      if (l.level === "stale") stale++;
      if (l.level === "BROKEN") broken++;
      out.push(`  ${l.level.padEnd(6)} ${l.text}`);
      if (l.action) out.push(`         -> ${l.action}`);
    }
  }
  return { text: out.join("\n"), stale, broken };
}

if (import.meta.main) {
  const brief = process.argv.includes("--brief");
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: bun run test:health [--brief]\n  what in the test suite is stale, with the action for each; runs no test, offline; exit 1 only when something is broken\n  --brief: count the open bug candidates without listing them");
    process.exit(0);
  }
  const sections = [manifest(), goldens(), await screens(), perf(), times(), quarantine(), candidates(brief), ledger()];
  const r = render(sections);
  console.log(`gluon test health, ${now.toISOString().slice(0, 10)}: runs no test, calls no model${r.text}`);
  console.log(`\n${r.broken ? `${r.broken} BROKEN` : "nothing broken"}, ${r.stale} stale`);
  process.exit(r.broken ? 1 : 0);
}
