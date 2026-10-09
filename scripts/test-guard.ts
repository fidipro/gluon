#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun scripts/test-guard.ts [base]` (CI's `test-guard` on a pull request): what the branch did to weaken the tests since the
 * merge-base with `base`: tests gone (a title no longer in `test/`), assertions removed (an `expect(` line removed and not
 * re-added), and tests switched off or out of the blocking run (`.skip`, `.todo`, `skipIf`, `test.failing`, `@full`,
 * `@quarantine` added). Any of these fails the check until a person agrees: the pull request's `tests-reviewed` label
 * (CI passes it as TESTS_REVIEWED=true). An agent never weakens a test to get green (test/AGENTS.md).
 */
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TEST = /^test\/.*\.(ts|tsx)$/;
const TITLE = /\b(?:test|it|describe)(?:\.\w+)*(?:\([^)]*\))?\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;
/** What switches a test off or out of the blocking run. */
const OFF: [string, RegExp][] = [[".skip", /\.skip\(/g], [".todo", /\.todo\(/g], [".skipIf", /\.skipIf\(/g], ["test.failing", /\btest\.failing\b/g], ["@full", /@full\b/g], ["@quarantine", /@quarantine\b/g]];
/** The tests of these checks: their samples weaken tests on purpose. */
const SAMPLES = ["test/test-guards.test.ts", "test/test-style.test.ts", "test/test-health.test.ts"];

export type Finding = { kind: "test gone" | "assertion removed" | "switched off or out"; file: string; text: string };

/** Every test / describe title in a set of files' text, by file. */
export function titles(files: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, text] of Object.entries(files)) for (const m of text.matchAll(TITLE)) if (!m[2]!.includes("${")) out.set(m[2]!, file);
  return out;
}

/** What a unified diff of `test/` does to weaken the tests; `before` / `after`: the titles on each side (a moved test isn't gone). */
export function weakened(diff: string, before: Map<string, string>, after: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  const removed: { file: string; line: string }[] = [];
  const added = new Map<string, number>();
  const addedExpects: { file: string; line: string }[] = [];
  // Per file and marker: how many the diff adds and removes (an edited line that keeps its `@full` adds none net).
  const off = new Map<string, { n: number; example: string }>();
  const count = (file: string, body: string, d: number) => {
    // A comment, or a sample inside an assertion (a test of these rules), switches nothing off.
    if (/^\s*(\/\/|\*)/.test(body) || /\bexpect\(/.test(body)) return;
    for (const [m, re] of OFF) {
      const k = body.match(re)?.length ?? 0;
      if (!k) continue;
      const e = off.get(`${file}\0${m}`) ?? { n: 0, example: "" };
      e.n += d * k;
      if (d > 0 && !e.example) e.example = body;
      off.set(`${file}\0${m}`, e);
    }
  };
  let file = "";
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/.exec(line) ?? /^--- a\/(.*)$/.exec(line);
    if (f) {
      if (f[1]) file = f[1];
      continue;
    }
    if (!TEST.test(file) || SAMPLES.includes(file)) continue;
    const body = line.slice(1).trim();
    if (line.startsWith("-")) {
      if (/\bexpect\(/.test(body)) removed.push({ file, line: body });
      count(file, body, -1);
    }
    if (line.startsWith("+")) {
      added.set(body, (added.get(body) ?? 0) + 1);
      if (/\bexpect\(/.test(body)) addedExpects.push({ file, line: body });
      count(file, body, 1);
    }
  }
  for (const [k, e] of off) if (e.n > 0) out.push({ kind: "switched off or out", file: k.split("\0")[0]!, text: `${k.split("\0")[1]} ×${e.n} (${e.example})` });
  // An assertion is kept when the same line comes back, or the same file still checks the same subject with the same matcher
  // (`expect(x).toBeLessThan(1500)` → `expect(x).toBeLessThan(1500 * SLOW)` is an edit the diff shows; a matcher swapped isn't).
  const shape = (l: string) => /expect\((.*?)\)\s*(?:\.(?:not|resolves|rejects))*\.(\w+)\(/.exec(l)?.slice(1).join(" ⟶ ") ?? l;
  const byFile = new Map<string, Map<string, number>>();
  for (const a of addedExpects) {
    const m = byFile.get(a.file) ?? new Map<string, number>();
    m.set(shape(a.line), (m.get(shape(a.line)) ?? 0) + 1);
    byFile.set(a.file, m);
  }
  for (const r of removed) {
    const n = added.get(r.line) ?? 0;
    if (n > 0) {
      added.set(r.line, n - 1);
      continue;
    }
    const m = byFile.get(r.file);
    const k = shape(r.line);
    if (m && (m.get(k) ?? 0) > 0) m.set(k, m.get(k)! - 1);
    else out.push({ kind: "assertion removed", file: r.file, text: r.line });
  }
  // A test is gone when its title is, unless the same file still tests the same bug (a test renamed, or split into variants).
  const bug = (t: string) => /^BUG-\d+/.exec(t)?.[0];
  const afterBugs = new Set([...after].map(([t, f]) => `${f}\0${bug(t)}`).filter((k) => !k.endsWith("\0undefined")));
  for (const [t, f] of before) if (!after.has(t) && !(bug(t) && afterBugs.has(`${f}\0${bug(t)}`))) out.push({ kind: "test gone", file: f, text: t });
  return out;
}

const git = (args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
};

if (import.meta.main) {
  const ref = process.argv[2] ?? "origin/main";
  const base = git(["merge-base", ref, "HEAD"]).trim();
  const changed = git(["diff", "--name-only", "--no-renames", base, "HEAD", "--", "test/"]).split("\n").filter((f) => TEST.test(f));
  const side = (rev: string) => Object.fromEntries(changed.flatMap((f) => {
    try {
      return [[f, git(["show", `${rev}:${f}`])]];
    } catch {
      return []; // not on that side (added or deleted)
    }
  }));
  const findings = weakened(git(["diff", "--unified=0", "--no-renames", base, "HEAD", "--", "test/"]), titles(side(base)), titles({ ...side("HEAD") }));
  // A title that moved to another test file is still there.
  const everywhere = new Set(titles(Object.fromEntries(git(["ls-files", "test/"]).split("\n").filter((f) => TEST.test(f)).map((f) => [f, git(["show", `HEAD:${f}`])]))).keys());
  const real = findings.filter((x) => x.kind !== "test gone" || !everywhere.has(x.text));
  if (!real.length) {
    console.log(`test-guard: no test weakened since ${base.slice(0, 9)}`);
    process.exit(0);
  }
  const reviewed = process.env.TESTS_REVIEWED === "true";
  for (const x of real) console.log(`${reviewed ? "::notice" : "::error"} file=${x.file}::${x.kind}: ${x.text.length > 160 ? `${x.text.slice(0, 159)}…` : x.text}`);
  console.log(reviewed ? `test-guard: ${real.length} change(s) that weaken the tests, reviewed (tests-reviewed)` : `test-guard: ${real.length} change(s) that weaken the tests: a person reviews them and labels the pull request tests-reviewed`);
  process.exit(reviewed ? 0 : 1);
}
