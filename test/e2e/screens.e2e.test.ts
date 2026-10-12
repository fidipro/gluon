/**
 * Every visually distinct state of Gluon (`scenes.ts`), checked without a golden (issue #31): each frame through the screen
 * lints (`screen-lint.ts`: whole boxes, no wrapped chrome, no cut wide character, cut text ends in `…`, the home view's ground
 * painted, one selection, readable contrast), at two widths dark and one light (`lintSizes`), and the same text cut alike
 * across widths (`lintAcross`); and a scene reached at one size and resized to another, against a fresh start there
 * (`RESIZE_CHECKS`). The full tier runs it (`@full`: a chain walks for seconds). How Gluon looks, pinned to the cell, is the
 * visual goldens' (test/visual/, by hand, for a redesign).
 */
import { afterAll, expect, test } from "bun:test";
import type { Frame, Theme } from "./frame.ts";
import { stopAll } from "./harness.ts";
import { type Chain, CHAINS, RESIZE_CHECKS, sizeName, STALE_FRAMES } from "./scenes.ts";
import { comparable, jobsOf, lintSizes, prefetch, resized, runChain } from "./scene-runs.ts";
import { lint, lintAcross } from "./screen-lint.ts";

const TEST_TIMEOUT_MS = 15 * 60_000;
const JOBS = jobsOf(lintSizes);

afterAll(() => {
  stopAll();
  if (STALE_FRAMES.length) console.log(`BUG-258 again: the home view kept rows of an earlier frame ${STALE_FRAMES.length} time(s) (redrawn with ctrl+o twice); the first:\n${STALE_FRAMES[0]}`);
});

/** Every lint problem of `scene` at its sizes and themes, each `<rule>: <size> <theme>: …`. */
async function sceneProblems(chain: Chain, scene: string): Promise<string[]> {
  const problems: string[] = [];
  const byTheme: Record<Theme, Frame[]> = { dark: [], light: [] };
  for (const job of JOBS.filter((j) => j.chain === chain)) {
    const run = await runChain(chain, job.size, job.theme);
    const f = run.frames.get(scene);
    if (!f) throw run.error ?? new Error(`${chain.id} never reached ${scene} at ${sizeName(job.size)} ${job.theme}`);
    byTheme[job.theme].push(f);
    for (const p of lint(f)) problems.push(p.replace(": ", `: ${sizeName(job.size)} ${job.theme}: `));
  }
  return [...problems, ...lintAcross(byTheme.dark), ...lintAcross(byTheme.light)];
}

for (const chain of CHAINS) {
  for (const scene of chain.shots) {
    test.serial(
      `whole-app/screens-lint: lint ${scene} (${chain.id}) @full`,
      async () => {
        prefetch(JOBS, JOBS.findIndex((j) => j.chain === chain));
        const problems = await sceneProblems(chain, scene);
        expect([scene, problems.slice(0, 40)]).toEqual([scene, []]);
      },
      TEST_TIMEOUT_MS,
    );
  }
}

for (const check of RESIZE_CHECKS) {
  const name = `screens: ${check.bug ? `${check.bug}: ` : ""}resize ${check.scene} ${sizeName(check.from)} → ${sizeName(check.to)} equals a fresh start at ${sizeName(check.to)} @full`;
  const body = async () => {
    const chain = CHAINS.find((c) => c.id === check.chain)!;
    const [after, fresh] = await Promise.all([resized(check), runChain(chain, check.to, "dark")]);
    const f = fresh.frames.get(check.scene);
    if (!f) throw fresh.error ?? new Error(`no fresh ${check.scene} at ${sizeName(check.to)}`);
    expect(comparable(after)).toBe(comparable(f));
  };
  // The entry in the title as written: test/catalog.ts reads titles from the source.
  if (check.bug) test.serial.failing(`frame/resize: ${name}`, body, TEST_TIMEOUT_MS);
  else test.serial(`frame/resize: ${name}`, body, TEST_TIMEOUT_MS);
}
