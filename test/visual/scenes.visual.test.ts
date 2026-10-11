/**
 * Gluon's visual goldens (by hand, for a redesign: `bun run test:visual`; never in regression or CI). Every scene
 * (`test/e2e/scenes.ts`) at a few sizes (`goldenSizes`: 80×24 dark, 120×40 light for the home and session chains, the tiny
 * chains at their own) against its committed golden (`__snapshots__/`; `bun run test:visual -u` rewrites them after an
 * intended change). `GLUON_REVIEW=1` also renders every frame to PNG with contact sheets and an index (`render.py`, into
 * `test/visual/out/`) and prints the review checklist (`checklist.ts`).
 *
 * What can be checked without a golden is the standard tests': the screen lints run on every e2e invariant check and on
 * every scene, and the resizes against a fresh start (test/e2e/screens.e2e.test.ts).
 *
 * Snapshot matchers don't run in concurrent tests: the tests are serial, the apps run in a pool of their own
 * (`GLUON_VISUAL_CONCURRENCY`, default 8) ahead of the test that reads them.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stopAll } from "../e2e/harness.ts";
import { cellsJson, serialize } from "../e2e/frame.ts";
import { mask } from "../e2e/mask.ts";
import { OUT, sizeName } from "../e2e/scenes.ts";
import { goldenSizes, jobsOf, prefetch, runChain, runs } from "../e2e/scene-runs.ts";
import { lint } from "../e2e/screen-lint.ts";
import { CHECKLIST } from "./checklist.ts";

const REVIEW = process.env.GLUON_REVIEW === "1";
/** A test may wait for the pool before its own chain runs. */
const TEST_TIMEOUT_MS = 15 * 60_000;
const JOBS = jobsOf(goldenSizes);

afterAll(() => stopAll());

JOBS.forEach((job, i) => {
  const { chain, size, theme } = job;
  test.serial(
    `${chain.id} ${sizeName(size)} ${theme}`,
    async () => {
      prefetch(JOBS, i);
      const run = await runChain(chain, size, theme);
      for (const scene of chain.shots) {
        const f = run.frames.get(scene);
        if (!f) break;
        expect(serialize(mask(f))).toMatchSnapshot(scene);
      }
      if (run.error) throw run.error;
    },
    TEST_TIMEOUT_MS,
  );
});

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
