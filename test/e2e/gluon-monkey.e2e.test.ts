/**
 * Gluon's model-based monkey test: per fake and seed, Gluon on the demo with the TUI fakes, 1–4
 * sessions open, then random actions the model (`gluon-model.ts`) predicts — after each, the app
 * must match it (view, tab, question, scroll mode, untouched line, composer, every agent's input)
 * and `checkInvariants` must hold. A failure is shrunk to a minimal list of actions and printed as
 * a ready-to-paste test. How to run, replay and read it: "Monkey test" in `test/e2e/README.md`.
 *
 * GLUON_MONKEY_SEEDS (default 1) seeds per fake, GLUON_MONKEY_STEPS (default 60) actions each,
 * GLUON_MONKEY_SEED=n only seed n, GLUON_MONKEY_SHRINK_MS (default 240000) the shrinking budget.
 */
import { afterAll, expect, test } from "bun:test";
import { describeAction, KEYS } from "./actions.ts";
import { FAKES } from "./gluon-kit.ts";
import * as M from "./gluon-model.ts";
import { configFor, describeFailure, generate, modelConfig, play, setUp, shrink, snippet } from "./gluon-monkey.ts";
import { HOME_VIEW, SLOW, stopAll } from "./harness.ts";
import { GLUON_HEX } from "../../src/ui/theme.ts";

afterAll(stopAll);

// Bugs the monkey found, each left out of its alphabet by a `KNOWN` flag (`gluon-monkey.ts`) until
// fixed, then pinned here. A race is pinned with a burst (keys in one write), which makes it certain.

test("BUG-236/GM-home-selection: back home from a session, Ctrl+D marks that session's row (BUG-231), not the one selected before — also in the same burst as the home key @full", async () => {
  // Two sessions; Gluon-t-1 was left for home once (its row selected then), Gluon-t-2 is shown.
  for (const burst of [true, false]) {
    const app = await setUp({ tabs: ["claude", "claude"], path: ["claude", "codex", "opencode"], cols: 100, rows: 30, homeKey: "ctrl+\\", alt: false, kitty: false });
    if (burst) app.write(KEYS.ctrlBackslash + KEYS.ctrlBackslash + KEYS.ctrlD);
    else {
      await app.press(KEYS.ctrlBackslash, KEYS.ctrlBackslash);
      await app.waitFor(HOME_VIEW);
      await app.press(KEYS.ctrlD);
    }
    await app.waitFor(/✓\s+Gluon-t-\d/);
    const marked = /✓\s+(Gluon-t-\d)/.exec(app.screen())![1];
    // The selection follows that row to Done (and Ctrl+D again takes the mark off it).
    await app.settle(200);
    const selected = (name: string) => app.bg(4, app.row(`${name} `)) === GLUON_HEX.selected;
    const sel = { t1: selected("Gluon-t-1"), t2: selected("Gluon-t-2") };
    app.kill();
    expect({ burst, marked, sel }).toEqual({ burst, marked: "Gluon-t-2", sel: { t1: false, t2: true } });
  }
}, 120_000 * SLOW);

const SEEDS = Number(process.env.GLUON_MONKEY_SEEDS) || 1;
const STEPS = Number(process.env.GLUON_MONKEY_STEPS) || 60;
const SHRINK_MS = Number(process.env.GLUON_MONKEY_SHRINK_MS) || 240_000;
const seeds = process.env.GLUON_MONKEY_SEED ? [Number(process.env.GLUON_MONKEY_SEED)] : Array.from({ length: SEEDS }, (_, i) => i + 1);

for (const seed of seeds)
  for (const fake of FAKES) {
    // `@full`: only claude's walk is in `bun run regression`; `regression:full` runs every fake.
    const name = `monkey: ${fake} seed ${seed}${fake === "claude" ? "" : " @full"}`;
    test(
      name,
      async () => {
        const c = configFor(fake, seed);
        const actions = generate(M.initialState(modelConfig(c)), seed, STEPS);
        const f = await play(c, actions);
        if (!f) return;
        const head = `${name} (${JSON.stringify(c)}) failed ${describeFailure(actions, f)}`;
        if (f.at < 0) throw new Error(head);
        const small = await shrink(c, actions.slice(0, f.at + 1), SHRINK_MS);
        throw new Error(
          [
            head,
            "",
            `replay: GLUON_MONKEY_SEED=${seed} GLUON_MONKEY_STEPS=${STEPS} bun test test/e2e/gluon-monkey.e2e.test.ts -t "${name}$"`,
            `shrunk to ${small.actions.length} of ${f.at + 1} actions in ${small.replays} replays (${small.actions.map(describeAction).join(" · ")}); it fails ${describeFailure(small.actions, small.failure)}`,
            "",
            snippet(c, small.actions, small.failure),
          ].join("\n"),
        );
      },
      (60_000 + STEPS * 2_000) * SLOW + SHRINK_MS,
    );
  }
