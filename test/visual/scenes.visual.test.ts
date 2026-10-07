/**
 * Gluon's visual suite (local only: `bun run test:visual`, never in regression). Every scene
 * (`scenes.ts`) at each size and theme: its frame against the committed golden
 * (`__snapshots__/`; `bun run test:visual -u` updates them), every frame through the lints
 * (`lint.ts`), and a few scenes reached at one size and resized to another against a fresh start
 * there. `GLUON_REVIEW=1` also renders every frame to PNG with contact sheets and an index
 * (`render.py`, into `test/visual/out/`) and prints the review checklist (`checklist.ts`).
 *
 * `GLUON_VISUAL=must` (`bun run test:visual-must`) is the short batch: every chain once in the
 * dark theme at 80×24 (the tiny ones at their own sizes), the home and session chains in the light
 * theme at 120×40, and the resize checks for a fixed bug. It compares with the stored goldens and
 * never writes them (`-u` there would drop every golden it didn't run).
 *
 * Snapshot matchers don't run in concurrent tests: the tests are serial, the apps run in a pool
 * of their own (`GLUON_VISUAL_CONCURRENCY`, default 8) ahead of the test that reads them.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stopAll, unscoped, type App } from "../e2e/harness.ts";
import { CHECKLIST } from "./checklist.ts";
import { cellsJson, type Frame, grab, serialize, type Theme } from "./frame.ts";
import { lint, lintAcross, type Rule, ruleOf, viewOf } from "./lint.ts";
import { mask } from "./mask.ts";
import { CHAIN_TIMEOUT_MS, CHAINS, type Chain, LIGHT_SIZES, OUT, redrawn, RESIZE_CHECKS, type ResizeCheck, SIZES, type Size, sizeName, STALE_FRAMES, startGluon, steady } from "./scenes.ts";
import { layout } from "../../src/pty/chrome.ts";

const LIMIT = Number(process.env.GLUON_VISUAL_CONCURRENCY) || 8;
const REVIEW = process.env.GLUON_REVIEW === "1";
const MUST = process.env.GLUON_VISUAL === "must";
/** The must batch's light chains (where Gluon's own ground meets the terminal's). */
const MUST_LIGHT = new Set(["home-chat", "home-sessions", "session-claude"]);

/** The committed goldens, by snapshot name (the must batch reads them; it never writes). */
function storedGoldens(): Record<string, string> {
  const exports: Record<string, string> = {};
  new Function("exports", readFileSync(join(import.meta.dir, "__snapshots__", "scenes.visual.test.ts.snap"), "utf8"))(exports);
  return exports;
}
const STORED = MUST ? storedGoldens() : {};
/** A test may wait for the pool before its own chain runs. */
const TEST_TIMEOUT_MS = 15 * 60_000;

/**
 * Lints known to fail: real Gluon UI bugs the suite found (not fixed here): the rules they break
 * and the scenes that show them. Those rules get a `test.failing` of their own per scene: it
 * passes while the bug is there and fails once it's fixed (drop the scene, or the entry, then).
 * The scene's other rules are checked as usual.
 */
interface KnownBug {
  id: string;
  what: string;
  rules: Rule[];
  scenes: string[];
  /** Shows only some runs (timing): its rules are left out of the scenes' lints, with no `test.failing` (it would flake); the run's summary lists where it was seen. */
  flaky?: boolean;
}
// None known now (V-01…V-04 were fixed as BUG-245…BUG-248). An entry: { id: "V-…", what, rules, scenes }.
const KNOWN_BUGS: KnownBug[] = [];

/** Each scene's lint problems seen this run, by rule (printed at the end). */
const seen = new Map<string, Set<Rule>>();

// ── The pool ───────────────────────────────────────────────────────────────────────────────────

let active = 0;
const queue: (() => void)[] = [];
async function pooled<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= LIMIT) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

interface Run {
  frames: Map<string, Frame>;
  error?: unknown;
}

const runs = new Map<string, Promise<Run>>();

/** Walks `chain` at `size` in `theme` once (memoized): its frames, and the error that stopped it, if any. */
function runChain(chain: Chain, size: Size, theme: Theme): Promise<Run> {
  const key = `${chain.id}|${sizeName(size)}|${theme}`;
  let run = runs.get(key);
  if (!run) {
    // Out of the test's scope: `prefetch` starts the next chains inside the running test, and its end must not kill them.
    run = unscoped(() => pooled(async () => {
      const frames = new Map<string, Frame>();
      let app: App | undefined;
      try {
        app = await startGluon(chain.startAt ?? size, theme, chain);
        const a = app;
        await withTimeout(
          chain.run(
            a,
            async (name) => {
              await steady(a);
              frames.set(name, grab(a, name, theme));
            },
            size,
          ),
          CHAIN_TIMEOUT_MS,
          key,
        );
        return { frames };
      } catch (error) {
        return { frames, error };
      } finally {
        app?.kill();
      }
    }));
    runs.set(key, run);
  }
  return run;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

/** The sizes `chain` runs at in `theme`. */
function sizesOf(chain: Chain, theme: Theme): Size[] {
  const all = chain.sizes?.[theme] ?? (theme === "dark" ? SIZES : LIGHT_SIZES);
  if (!MUST) return all;
  if (chain.sizes) return all;
  const want = theme === "dark" ? SIZES[1]! : MUST_LIGHT.has(chain.id) ? SIZES[2]! : null;
  return all.filter((s) => s === want);
}

interface Job {
  chain: Chain;
  size: Size;
  theme: Theme;
}
const JOBS: Job[] = CHAINS.flatMap((chain) => (["dark", "light"] as const).flatMap((theme) => sizesOf(chain, theme).map((size) => ({ chain, size, theme }))));

/** Starts the next jobs ahead of the test that reads them (the pool keeps LIMIT apps running). */
function prefetch(from: number) {
  for (const j of JOBS.slice(from, from + 2 * LIMIT)) void runChain(j.chain, j.size, j.theme);
}

afterAll(async () => {
  stopAll();
  if (STALE_FRAMES.length) console.log(`BUG-258 again: the home view kept rows of an earlier frame ${STALE_FRAMES.length} time(s) (redrawn with ctrl+o twice); the first:\n${STALE_FRAMES[0]}`);
  const hits = [...seen].filter(([, rules]) => rules.size);
  if (hits.length) console.log(`lint rules broken, by scene:\n${hits.map(([scene, rules]) => `  ${scene}: ${[...rules].join(", ")}`).join("\n")}`);
});

// ── Goldens ────────────────────────────────────────────────────────────────────────────────────

JOBS.forEach((job, i) => {
  const { chain, size, theme } = job;
  test.serial(
    `${chain.id} ${sizeName(size)} ${theme}`,
    async () => {
      prefetch(i);
      const run = await runChain(chain, size, theme);
      for (const scene of chain.shots) {
        const f = run.frames.get(scene);
        if (!f) break;
        const text = serialize(mask(f));
        if (!MUST) expect(text).toMatchSnapshot(scene);
        else {
          const name = `${chain.id} ${sizeName(size)} ${theme}: ${scene} 1`;
          const stored = STORED[name];
          if (stored === undefined) throw new Error(`no golden "${name}": run bun run test:visual -u`);
          expect(text).toBe(stored.trim().replace(/^"|"$/g, ""));
        }
      }
      if (run.error) throw run.error;
    },
    TEST_TIMEOUT_MS,
  );
});

// ── Lints ──────────────────────────────────────────────────────────────────────────────────────

/** Every lint problem of `scene` at its sizes and themes, each `<rule>: <size> <theme>: …`. */
async function sceneProblems(chain: Chain, scene: string): Promise<string[]> {
  const problems: string[] = [];
  const byTheme: Record<Theme, Frame[]> = { dark: [], light: [] };
  for (const job of JOBS.filter((j) => j.chain === chain)) {
    const f = (await runChain(chain, job.size, job.theme)).frames.get(scene);
    if (!f) continue;
    byTheme[job.theme].push(f);
    for (const p of lint(f)) problems.push(p.replace(": ", `: ${sizeName(job.size)} ${job.theme}: `));
  }
  problems.push(...lintAcross(byTheme.dark), ...lintAcross(byTheme.light));
  const rules = seen.get(scene) ?? new Set<Rule>();
  for (const p of problems) rules.add(ruleOf(p));
  seen.set(scene, rules);
  return problems;
}

const report = (scene: string, problems: string[]) => `${scene}: ${problems.length} lint problem(s):\n  ${problems.slice(0, 40).join("\n  ")}`;

for (const chain of CHAINS) {
  for (const scene of chain.shots) {
    const known = KNOWN_BUGS.filter((b) => b.scenes.includes(scene));
    const skip = new Set(known.flatMap((b) => b.rules));
    test.serial(
      `lint ${scene} (every size and theme)${skip.size ? `, but ${[...skip].join(", ")}` : ""}`,
      async () => {
        const problems = (await sceneProblems(chain, scene)).filter((p) => !skip.has(ruleOf(p)));
        if (problems.length) throw new Error(report(scene, problems));
      },
      TEST_TIMEOUT_MS,
    );
    for (const bug of known.filter((b) => !b.flaky))
      test.serial.failing(
        `BUG-CANDIDATE/${bug.id}: lint ${scene}: ${bug.what}`,
        async () => {
          const problems = (await sceneProblems(chain, scene)).filter((p) => bug.rules.includes(ruleOf(p)));
          if (problems.length) throw new Error(report(scene, problems));
        },
        TEST_TIMEOUT_MS,
      );
  }
}

// ── Resizes ────────────────────────────────────────────────────────────────────────────────────

/** The frame's rows to compare: all of them, or for a session only Gluon's chrome (the interior is the agent's). */
function comparable(f: Frame): string {
  const masked = mask(f);
  if (viewOf(f) !== "session") return serialize(masked).split("\n").slice(1).join("\n");
  const { interior: r } = layout(f.cols, f.rows);
  const blank = { ch: " ", w: 1, fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
  const inside = (x: number, y: number) => y >= r.top && y < r.top + r.rows && x >= r.left && x < r.left + r.cols;
  const chrome: Frame = { ...masked, cells: masked.cells.map((row, y) => row.map((c, x) => (inside(x, y) ? blank : c))), cursor: { x: 0, y: 0, visible: false } };
  // The cursor line too: it is the agent's.
  return serialize(chrome).split("\n").slice(2).join("\n");
}

/** Reaches `check.scene` at `from`, resizes to `to` and waits for the redraw (and for a session to go idle again). */
function resized(check: ResizeCheck, theme: Theme = "dark"): Promise<Frame> {
  const chain = CHAINS.find((c) => c.id === check.chain)!;
  return pooled(async () => {
    const app = await startGluon(chain.startAt ?? check.from, theme, chain);
    const STOP = new Error("stop");
    let frame: Frame | undefined;
    try {
      await withTimeout(
        chain.run(
          app,
          async (name) => {
            if (name !== check.scene) return;
            app.resize(check.to.cols, check.to.rows);
            await redrawn(app);
            // A session's status: back to idle once its redraw has been quiet (3 s), as a fresh one.
            if (viewOf(grab(app, name, theme)) === "session") await app.waitFor((s) => /awaiting/.test(s.split("\n")[1] ?? ""), 8_000).catch(() => {});
            else await app.waitFor((s) => !/ Working {2,}/.test(s), 8_000).catch(() => {});
            await steady(app);
            frame = grab(app, name, theme);
            throw STOP;
          },
          check.from,
        ),
        CHAIN_TIMEOUT_MS,
        `resize ${check.scene}`,
      );
    } catch (e) {
      if (e !== STOP) throw e;
    } finally {
      app.kill();
    }
    if (!frame) throw new Error(`${check.chain} never reached ${check.scene}`);
    return frame;
  });
}

for (const check of RESIZE_CHECKS.filter((c) => !MUST || c.must)) {
  const name = `${check.bug ? `${check.bug}: ` : ""}resize ${check.scene} ${sizeName(check.from)} → ${sizeName(check.to)} equals a fresh start at ${sizeName(check.to)}`;
  const body = async () => {
    const chain = CHAINS.find((c) => c.id === check.chain)!;
    const [after, fresh] = await Promise.all([resized(check), runChain(chain, check.to, "dark")]);
    const f = fresh.frames.get(check.scene);
    if (!f) throw fresh.error ?? new Error(`no fresh ${check.scene} at ${sizeName(check.to)}`);
    expect(comparable(after)).toBe(comparable(f));
  };
  if (check.bug) test.serial.failing(name, body, TEST_TIMEOUT_MS);
  else test.serial(name, body, TEST_TIMEOUT_MS);
}

// ── Review (GLUON_REVIEW=1) ────────────────────────────────────────────────────────────────────

/** Writes every frame's cells and golden, renders PNGs and contact sheets (`render.py --sheet`), prints where they are and the checklist. */
async function review() {
  const dir = join(OUT, "frames");
  rmSync(dir, { recursive: true, force: true });
  for (const [key, run] of runs) {
    const { frames } = await run;
    const [, size, theme] = key.split("|");
    for (const [scene, f] of frames) {
      mkdirSync(join(dir, scene), { recursive: true });
      const base = join(dir, scene, `${size}-${theme}`);
      writeFileSync(`${base}.json`, JSON.stringify(cellsJson(f)));
      writeFileSync(`${base}.golden.txt`, serialize(mask(f)));
      writeFileSync(`${base}.lint.txt`, lint(f).join("\n"));
    }
  }
  let said: string;
  let ok = false;
  try {
    const py = Bun.spawnSync(["python3", join(import.meta.dir, "render.py"), "--sheet", dir], { stdout: "pipe", stderr: "pipe", env: process.env });
    said = `${py.stdout.toString()}${py.stderr.toString()}`.trim() || `python3 exited ${py.exitCode}`;
    ok = py.exitCode === 0;
  } catch (e) {
    said = `python3 not found (${(e as Error).message})`;
  }
  // render.py says itself when PIL is missing (exit 0, no PNGs).
  console.log(ok ? said : `visual review: no PNGs: ${said}`);
  console.log(CHECKLIST);
}

if (REVIEW) test.serial("review: PNGs, contact sheets, the index and the checklist (GLUON_REVIEW=1)", review, TEST_TIMEOUT_MS);
