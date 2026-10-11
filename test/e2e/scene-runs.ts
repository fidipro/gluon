/**
 * Walking the scenes (`scenes.ts`) and keeping their frames, for the two suites that read them: the screens tests
 * (`screens.e2e.test.ts`: every frame through the lints, and resizes against a fresh start; golden-free, in the full tier)
 * and the visual goldens (`test/visual/scenes.visual.test.ts`: by hand, for a redesign).
 *
 * A chain is walked once per size and theme (memoized), at most `GLUON_VISUAL_CONCURRENCY` (8) apps at once.
 */
import { layout } from "../../src/pty/chrome.ts";
import { type Frame, grab, serialize, type Theme } from "./frame.ts";
import { unscoped } from "./harness.ts";
import { mask } from "./mask.ts";
import { CHAIN_TIMEOUT_MS, type Chain, CHAINS, redrawn, type ResizeCheck, SIZES, type Size, sizeName, startGluon, steady } from "./scenes.ts";
import { viewOf } from "./screen-lint.ts";

const LIMIT = Number(process.env.GLUON_VISUAL_CONCURRENCY) || 8;

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

export interface Run {
  frames: Map<string, Frame>;
  error?: unknown;
}

/** Every walk so far, by `chain|size|theme`. */
export const runs = new Map<string, Promise<Run>>();

/** Walks `chain` at `size` in `theme` once (memoized): its frames, and the error that stopped it, if any. */
export function runChain(chain: Chain, size: Size, theme: Theme): Promise<Run> {
  const key = `${chain.id}|${sizeName(size)}|${theme}`;
  let run = runs.get(key);
  if (!run) {
    // Out of the test's scope: a prefetch starts the next chains inside the running test, and its end must not kill them.
    run = unscoped(() =>
      pooled(async () => {
        const frames = new Map<string, Frame>();
        let app: Awaited<ReturnType<typeof startGluon>> | undefined;
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
      }),
    );
    runs.set(key, run);
  }
  return run;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

/** The chains whose light theme is checked (where Gluon's own ground meets the terminal's). */
export const LIGHT_CHAINS = new Set(["home-chat", "home-sessions", "session-claude"]);

/** The sizes the visual goldens keep: 80×24 dark, and 120×40 light for `LIGHT_CHAINS` (a chain with sizes of its own keeps them). */
export function goldenSizes(chain: Chain, theme: Theme): Size[] {
  if (chain.sizes) return chain.sizes[theme];
  return theme === "dark" ? [SIZES[1]!] : LIGHT_CHAINS.has(chain.id) ? [SIZES[2]!] : [];
}

/** The sizes the screens tests lint: the goldens' and the narrowest (50×20), so `lintAcross` compares two widths. */
export function lintSizes(chain: Chain, theme: Theme): Size[] {
  if (chain.sizes) return chain.sizes[theme];
  return theme === "dark" ? [SIZES[0]!, SIZES[1]!] : goldenSizes(chain, theme);
}

export interface Job {
  chain: Chain;
  size: Size;
  theme: Theme;
}
export const jobsOf = (sizes: (c: Chain, t: Theme) => Size[]): Job[] => CHAINS.flatMap((chain) => (["dark", "light"] as const).flatMap((theme) => sizes(chain, theme).map((size) => ({ chain, size, theme }))));

/** Starts the jobs after `from` ahead of the test that reads them (the pool keeps its apps busy). */
export function prefetch(jobs: Job[], from: number): void {
  for (const j of jobs.slice(from, from + 2 * LIMIT)) void runChain(j.chain, j.size, j.theme);
}

/** The frame's rows to compare: all of them, or for a session only Gluon's chrome (the interior is the agent's). */
export function comparable(f: Frame): string {
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
export function resized(check: ResizeCheck, theme: Theme = "dark"): Promise<Frame> {
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
