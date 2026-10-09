#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun run test:value <area> [--file src/x.ts] [--max 30] [--seed 1] [--e2e]`: what an area's tests are worth, to prune on
 * evidence (docs/contributing/testing.md). Local and on demand, never part of the regression; it takes minutes.
 *
 * - Overlap: the bugs the area tests at both layers (unit and e2e), and the bugs with more than five tests.
 * - Cost: each test's seconds, from a clean run.
 * - Mutation kills: up to `--max` small bugs put into the area's `src` files one at a time (a comparison or a logical
 *   operator flipped, a `!` dropped, a boolean literal swapped), sampled by `--seed`; after each, the area's tests
 *   (unit; `--e2e` adds its e2e files) run, and every test that fails "kills" it. A mutant nothing kills is a gap in
 *   the tests; a test that kills nothing no other test kills is a candidate for deletion, the slow ones first.
 *
 * It works in a temporary git worktree of HEAD (the checkout is never touched) and writes `qa/logs/test-value/<area>.json`.
 * No dependency of its own: the TypeScript compiler's parser finds the mutation sites.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { AREAS, ROOT, matches, srcFiles } from "../test/areas.ts";
import { defaultApps } from "./e2e-concurrency.ts";

export type Mutant = { file: string; line: number; start: number; end: number; from: string; to: string };

const SWAP: Record<string, string> = { "===": "!==", "!==": "===", "==": "!=", "!=": "==", "<": "<=", "<=": "<", ">": ">=", ">=": ">", "&&": "||", "||": "&&" };

/** Every mutation site of a source file: binary operators that decide (SWAP), a `!` dropped, `true` ↔ `false`. Type positions aren't code: none there. */
export function mutationSites(source: string, file: string): Mutant[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Mutant[] = [];
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isTypeNode(n)) return;
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken;
      const text = op.getText(sf);
      if (SWAP[text]) out.push({ file, line: line(op.getStart(sf)), start: op.getStart(sf), end: op.getEnd(), from: text, to: SWAP[text]! });
    } else if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
      const s = n.getStart(sf);
      out.push({ file, line: line(s), start: s, end: s + 1, from: "!", to: "" });
    } else if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) {
      const t = n.getText(sf);
      out.push({ file, line: line(n.getStart(sf)), start: n.getStart(sf), end: n.getEnd(), from: t, to: t === "true" ? "false" : "true" });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export const applyMutant = (source: string, m: Mutant) => source.slice(0, m.start) + m.to + source.slice(m.end);

/** `n` of `xs`, the same ones for the same seed (a small LCG: reproducible, no dependency). */
export function sample<T>(xs: T[], n: number, seed: number): T[] {
  if (xs.length <= n) return xs;
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/** Per test: how many mutants it killed, and how many only it killed. `kills`: for each mutant, the tests that failed under it. */
export function killTable(kills: Set<string>[], tests: string[]): { test: string; kills: number; unique: number }[] {
  return tests.map((t) => ({ test: t, kills: kills.filter((k) => k.has(t)).length, unique: kills.filter((k) => k.size === 1 && k.has(t)).length }));
}

/** From Bun's JUnit report: every test's full name, its seconds, and whether it failed. */
export function junitCases(xml: string): { name: string; s: number; failed: boolean }[] {
  const un = (x: string) => x.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e as string]!);
  return [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => {
    const a = Object.fromEntries([...m[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((x) => [x[1]!, un(un(x[2]!))]));
    return { name: [a.file, a.classname, a.name].filter(Boolean).join(" › "), s: Number(a.time) || 0, failed: /<failure\b/.test(m[2] ?? "") };
  });
}

// ——— the run ———

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const area = argv.find((a) => !a.startsWith("--") && !["--file", "--max", "--seed"].includes(argv[argv.indexOf(a) - 1] ?? ""));
  if (!area || !(area in AREAS)) {
    console.error(`usage: bun run test:value <area> [--file src/x.ts] [--max 30] [--seed 1] [--e2e]\nareas: ${Object.keys(AREAS).join(", ")}`);
    process.exit(2);
  }
  const A = AREAS[area]!;
  const max = Number(opt("--max")) || 30;
  const seed = Number(opt("--seed")) || 1;
  const withE2e = argv.includes("--e2e");
  const only = opt("--file");
  const src = (only ? [only] : srcFiles().filter((f) => matches(A.src, f))).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
  const unit = A.unit;
  const e2e = withE2e ? A.e2e : [];
  if (!unit.length && !e2e.length) {
    console.error(`${area}: no tests to run${A.e2e.length ? " (its tests are e2e: add --e2e)" : ""}`);
    process.exit(2);
  }

  // Overlap, from the test files alone.
  const ids = (fs: string[]) => {
    const m = new Map<string, number>();
    for (const f of fs) for (const x of readFileSync(join(ROOT, f), "utf8").matchAll(/\b(?:test|it)(?:\.\w+)*(?:\([^)]*\))?\(\s*["'`](BUG-\d+)\b/g)) m.set(x[1]!, (m.get(x[1]!) ?? 0) + 1);
    return m;
  };
  const u = ids(A.unit);
  const e = ids(A.e2e);
  const bothLayers = [...u.keys()].filter((k) => e.has(k));
  const many = [...new Set([...u.keys(), ...e.keys()])].map((k) => [k, (u.get(k) ?? 0) + (e.get(k) ?? 0)] as const).filter(([, n]) => n > 5);

  const dir = mkdtempSync(join(tmpdir(), "gluon-test-value-"));
  const sh = (cmd: string[], cwd = ROOT) => Bun.spawnSync(cmd, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  try {
    if (sh(["git", "worktree", "add", "--detach", dir, "HEAD"]).exitCode !== 0) throw new Error("git worktree add failed");
    if (sh([process.execPath, "install", "--frozen-lockfile"], dir).exitCode !== 0) throw new Error("bun install failed in the worktree");
    const report = join(dir, "value.xml");
    const apps = defaultApps();
    /** One run of the area's tests; null when it ran past `limitMs` (a mutant that loops). */
    const runTests = async (limitMs: number) => {
      rmSync(report, { force: true });
      const runs = [
        ...(unit.length ? [[process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}.unit`, ...unit.map((f) => `./${f}`)]] : []),
        ...(e2e.length ? [[process.execPath, "test", "--concurrent", `--max-concurrency=${apps}`, "--reporter=junit", `--reporter-outfile=${report}.e2e`, ...e2e.map((f) => `./${f}`)]] : []),
      ];
      const procs = runs.map((cmd) => Bun.spawn(cmd, { cwd: dir, env: process.env, stdout: "ignore", stderr: "ignore" }));
      const timer = setTimeout(() => procs.forEach((p) => p.kill(9)), limitMs);
      await Promise.all(procs.map((p) => p.exited));
      clearTimeout(timer);
      if (procs.some((p) => p.signalCode === "SIGKILL")) return null;
      return [".unit", ".e2e"].flatMap((x) => (existsSync(report + x) ? junitCases(readFileSync(report + x, "utf8")) : []));
    };

    console.log(`test:value ${area}: a clean run of ${unit.length} unit${e2e.length ? ` and ${e2e.length} e2e` : ""} file(s)…`);
    const t0 = performance.now();
    const clean = await runTests(30 * 60_000);
    const cleanMs = performance.now() - t0;
    if (!clean) throw new Error("the clean run never ended");
    const broken = clean.filter((c) => c.failed).map((c) => c.name);
    if (broken.length) console.log(`  ${broken.length} test(s) fail without any mutant: left out\n${broken.slice(0, 5).map((b) => `    ${b}`).join("\n")}`);
    const tests = clean.filter((c) => !c.failed);
    const seconds = new Map(tests.map((c) => [c.name, c.s]));

    const sites = src.flatMap((f) => mutationSites(readFileSync(join(dir, f), "utf8"), f));
    const chosen = sample(sites, max, seed);
    console.log(`  clean run ${(cleanMs / 1000).toFixed(1)} s, ${tests.length} test(s); ${chosen.length} of ${sites.length} mutation site(s) in ${src.length} file(s)`);
    const kills: Set<string>[] = [];
    const survivors: Mutant[] = [];
    let hung = 0;
    for (const [i, m] of chosen.entries()) {
      const path = join(dir, m.file);
      const original = readFileSync(path, "utf8");
      writeFileSync(path, applyMutant(original, m));
      const r = await runTests(Math.max(60_000, cleanMs * 3));
      writeFileSync(path, original);
      const failed = new Set((r ?? []).filter((c) => c.failed && seconds.has(c.name)).map((c) => c.name));
      if (r === null) hung++;
      if (r !== null && !failed.size) survivors.push(m);
      kills.push(failed);
      console.log(`  ${String(i + 1).padStart(3)}/${chosen.length} ${m.file}:${m.line} ${m.from || "·"} → ${m.to || "·"}: ${r === null ? "killed (the run hung)" : failed.size ? `killed by ${failed.size}` : "SURVIVED"}`);
    }

    const table = killTable(kills, [...seconds.keys()]).map((r) => ({ ...r, s: seconds.get(r.test) ?? 0 }));
    const candidates = table.filter((r) => r.unique === 0).sort((a, b) => b.s - a.s);
    const score = chosen.length ? (chosen.length - survivors.length) / chosen.length : 1;
    const out = { area, at: new Date().toISOString(), seed, mutants: chosen.length, sites: sites.length, score, hung, survivors, bothLayers, many, tests: table, candidates: candidates.map((c) => c.test) };
    mkdirSync(join(ROOT, "qa", "logs", "test-value"), { recursive: true });
    writeFileSync(join(ROOT, "qa", "logs", "test-value", `${area}.json`), JSON.stringify(out, null, 1));

    console.log(`\n── ${area}: mutation score ${(score * 100).toFixed(0)} % (${chosen.length - survivors.length} of ${chosen.length} killed${hung ? `, ${hung} by a hang` : ""})`);
    if (survivors.length) console.log(`── survivors (a change no test noticed: a gap):\n${survivors.map((m) => `  ${m.file}:${m.line} ${m.from || "·"} → ${m.to || "·"}`).join("\n")}`);
    if (bothLayers.length) console.log(`── bugs tested at both layers: ${bothLayers.join(", ")}`);
    if (many.length) console.log(`── bugs with more than five tests: ${many.map(([k, n]) => `${k} (${n})`).join(", ")}`);
    const shown = candidates.slice(0, 25);
    console.log(`── tests that killed no mutant only they killed: ${candidates.length} of ${table.length} (slowest first; candidates, not verdicts: a sample of mutants, and a test may guard what no mutant touched)`);
    for (const c of shown) console.log(`  ${c.s.toFixed(2).padStart(7)} s  kills ${String(c.kills).padStart(3)}  ${c.test.length > 140 ? `${c.test.slice(0, 139)}…` : c.test}`);
    console.log(`── qa/logs/test-value/${area}.json`);
  } finally {
    if (sh(["git", "worktree", "remove", "--force", dir]).exitCode !== 0) rmSync(dir, { recursive: true, force: true });
  }
}
