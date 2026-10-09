#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun scripts/red-check.ts [base]` (CI's `red-check` on a pull request): every test the branch adds for a bug that had no
 * test before (a `BUG-nn` id the base's `test/` never names; a renamed or split test of a known bug isn't new) must fail
 * without its fix. The branch's tests run against the base's `src/` (a temporary worktree: the branch, with `src/` as it was
 * at the merge-base and the files the branch added under `src/` gone). A new bug test that passes there proves nothing
 * about the fix: it fails this check. A test file that doesn't load without the fix counts as failing (red).
 * A fix that changes no `src/` file (a script, a workflow) has nothing to check: the pull request's `red-exempt` label skips it.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

export type Added = { file: string; title: string };

/**
 * The bug tests a unified diff adds: a `+` line that opens a `test(` / `it(` (any modifier) whose title is a plain string
 * starting `BUG-<n>` (a title built from `${…}` is skipped: it can't be selected by name). Files outside `test/` are ignored.
 */
export function addedBugTests(diff: string): Added[] {
  const out: Added[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    const f = /^\+\+\+ b\/(.*)$/.exec(line);
    if (f) {
      file = f[1]!;
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++") || !/^test\/.*\.test\.tsx?$/.test(file)) continue;
    const m = /\b(?:test|it)(?:\.\w+)*(?:\([^)]*\))?\(\s*(["'`])(BUG-\d+(?:(?!\1)[^\\]|\\.)*)\1/.exec(line);
    if (m && !(m[1] === "`" && m[2]!.includes("${"))) out.push({ file, title: m[2]! });
  }
  return out;
}

/** The `-t` pattern that selects exactly these titles (each test's own name, at the end of its full name). */
export const titlePattern = (titles: string[]) => `(?:^| )(?:${[...new Set(titles)].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;

/** From Bun's JUnit report: the titles that passed (a test that failed, or a file that never loaded, isn't there). */
export function passedTitles(xml: string): Set<string> {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1]!)?.[1];
    if (!name || /<(failure|skipped|error)\b/.test(m[2] ?? "")) continue;
    out.add(name.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e as string]!));
  }
  return out;
}

const git = (args: string[], cwd = ROOT) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
};

if (import.meta.main) {
  const ref = process.argv[2] ?? "origin/main";
  const base = git(["merge-base", ref, "HEAD"]).trim();
  const known = new Set(git(["grep", "-ho", "BUG-[0-9][0-9]*", base, "--", "test/"]).split("\n").map((l) => l.replace(/^[^:]*:/, "").trim()).filter(Boolean));
  const added = addedBugTests(git(["diff", "--unified=0", "--no-renames", base, "HEAD", "--", "test/"])).filter((a) => !known.has(/^BUG-\d+/.exec(a.title)![0]));
  if (!added.length) {
    console.log(`red-check: no test for a new bug since ${base.slice(0, 9)}`);
    process.exit(0);
  }
  const dir = mkdtempSync(join(tmpdir(), "gluon-red-check-"));
  let code = 1;
  try {
    git(["worktree", "add", "--detach", dir, "HEAD"]);
    // The branch's tests, the base's source: what the branch added under src/ goes, the rest goes back.
    for (const f of git(["diff", "--name-only", "--diff-filter=A", base, "HEAD", "--", "src/"], dir).split("\n").filter(Boolean)) rmSync(join(dir, f), { force: true });
    git(["checkout", base, "--", "src/"], dir);
    if (existsSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
    const files = [...new Set(added.map((a) => `./${a.file}`))];
    const report = join(dir, "red-check.xml");
    console.log(`red-check: ${added.length} new bug test(s) against the source of ${base.slice(0, 9)}:\n${added.map((a) => `  ${a.file} :: ${a.title}`).join("\n")}`);
    Bun.spawnSync([process.execPath, "test", "-t", titlePattern(added.map((a) => a.title)), "--reporter=junit", `--reporter-outfile=${report}`, ...files], { cwd: dir, env: process.env, stdout: "inherit", stderr: "inherit" });
    const passed = existsSync(report) ? passedTitles(readFileSync(report, "utf8")) : new Set<string>();
    const green = added.filter((a) => passed.has(a.title));
    for (const a of green) console.log(`::error file=${a.file}::${a.title}: passes without its fix. A bug's test must fail before the fix (test/AGENTS.md); a fix with no src/ change: label the pull request red-exempt`);
    // A file that doesn't load without the fix (it imports what the fix adds) runs none of its tests: they count as red, unjudged.
    const ran = existsSync(report) ? (readFileSync(report, "utf8").match(/<testcase\b/g) ?? []).length : 0;
    if (ran < added.length) console.log(`red-check: ${added.length - ran} of them didn't run without the fix (their file doesn't load): counted as failing`);
    console.log(green.length ? `red-check: ${green.length} of ${added.length} pass without the fix` : `red-check: all ${added.length} fail without the fix, as they should`);
    code = green.length ? 1 : 0;
  } finally {
    try {
      git(["worktree", "remove", "--force", dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  process.exit(code);
}
