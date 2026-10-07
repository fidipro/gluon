/**
 * The visual suite's scenes: every visually distinct state of Gluon, reached offline on the demo
 * brain with the TUI fakes. A chain is one app walked through several states; each `shot` is a
 * scene (a golden per size and theme). Shots wait for idle states (a session `awaiting your
 * input`, the intake agent done) so frames are the same every run; `mask.ts` covers the rest.
 *
 * Every chain runs fresh at each of its sizes (`SIZES`, dark; `LIGHT_SIZES`, light), except the
 * tiny ones: a session's frame can't be reached below the frame's minimum, so `s.claude.tiny`
 * launches at 80×24 and resizes. `RESIZE_CHECKS` reach a scene at one size, resize, and compare
 * with the fresh frame at the other.
 */
import { join } from "node:path";
import { KEYS, wheelUp } from "../e2e/actions.ts";
import { GLUON_HEX } from "../../src/ui/theme.ts";
import { freshConfig, repo, type FakeAgent } from "../e2e/fixtures.ts";
import { ASK_YAML, EVENT_HOOK, FAKES, HARNESS_OF, home, LABEL, optionOf, say } from "../e2e/gluon-kit.ts";
import { App, FULL_PACE, HOME_VIEW, QUESTION, SLOW } from "../e2e/harness.ts";
import { grab, serialize, type Theme } from "./frame.ts";
import { mask } from "./mask.ts";

export interface Size {
  cols: number;
  rows: number;
}

export const sizeName = (s: Size) => `${s.cols}x${s.rows}`;

/** The sizes every chain runs at (dark). */
export const SIZES: Size[] = [
  { cols: 50, rows: 20 },
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
  { cols: 160, rows: 50 },
];
/** The light theme's sizes: Gluon paints its own colours, so the light theme differs only where it doesn't; two sizes check that. */
export const LIGHT_SIZES: Size[] = [SIZES[0]!, SIZES[2]!];
/** Below the frame's minimum (20×6) and just above it. */
export const TINY: Size[] = [
  { cols: 30, rows: 8 },
  { cols: 19, rows: 5 },
];

/** Takes a frame of the screen as scene `name` (the suite grabs, masks and keeps it). */
export type Shot = (name: string) => Promise<void> | void;

export interface Chain {
  id: string;
  /** The scenes it shoots, in order. */
  shots: string[];
  /** Its sizes per theme (default `SIZES` dark, `LIGHT_SIZES` light). */
  sizes?: Record<Theme, Size[]>;
  /** Which fakes are on PATH (default: claude and opencode). */
  agents?: FakeAgent[];
  env?: Record<string, string>;
  /** The size it starts at when it isn't the size shot (a session can't open below 20×6). */
  startAt?: Size;
  run(app: App, shot: Shot, size: Size): Promise<void>;
}

let n = 0;

/**
 * Gluon on the demo brain with the TUI fakes, its own config, the terminal answering OSC 11 in
 * `theme`. Waits for the composer only: below 10 rows the header is gone, below 24 the greeting.
 */
export async function startGluon(size: Size, theme: Theme, { agents, env = {} }: Pick<Chain, "agents" | "env"> = {}): Promise<App> {
  const cfg = freshConfig(`visual-${process.pid}-${++n}`, ASK_YAML);
  const app = new App({
    cwd: repo.tiny(),
    cols: size.cols,
    rows: size.rows,
    agents,
    osc11: theme,
    // The demo at its own pace: the scenes catch it mid-turn (its first 700 ms of thinking).
    env: { ...FULL_PACE, GLUON_CONFIG: cfg, FAKE_TUI: "1", FAKE_EVENT_HOOK: EVENT_HOOK, ...env },
  });
  await app.waitFor((s) => HOME_VIEW.test(s) || /^\s*› /m.test(s) || (size.cols < 20 || size.rows < 6 ? s.trim().length > 0 : false), 15_000);
  // The header's repo line gets its git state (`· clean`) a moment after the first frame.
  if (/Gluon v\d/.test(app.screen())) await app.waitFor((s) => /──⢎──●\s+\S+ · \S+ · \S/.test(s), 15_000);
  await app.settle(200);
  return app;
}

/**
 * After a resize: waits for Gluon's redraw at the new size, not a fixed time (it comes a moment
 * later, later under load; meanwhile the terminal shows its own reflow of the old frame): no row
 * wrapped, and the view drawn to the new width — the session's frame border, or the home view's
 * composer rule — and height (the bar, or the composer's rule, on its last rows).
 */
export async function redrawn(app: App) {
  const fits = () => {
    const { cols, rows } = app.term;
    const buf = app.term.buffer.active;
    for (let y = 0; y < rows; y++) if (buf.getLine(buf.viewportY + y)?.isWrapped) return false;
    const lines = Array.from({ length: rows }, (_, y) => (buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "").trimEnd());
    if (cols < 20 || rows < 6) return lines.some((l) => l.trim());
    if (lines[0]?.includes("◆ gluon")) return lines.some((l) => l.startsWith("┌") && l.length === cols) && !!lines[rows - 1]?.trim();
    const rule = (l: string) => l === `  ${"─".repeat(cols - 4)}` || l === "─".repeat(cols);
    return rule(lines[rows - 2] ?? "");
  };
  await app.settle(100);
  await app.waitFor(fits, 10_000);
}

/** Where the suite saw BUG-258 again (printed at the end of the run): the screens it saw. */
export const STALE_FRAMES: string[] = [];

const optionsListed = (s: string) => /❯ 1\. .+ × .*recommended/.test(s.replace(/\n\s*/g, " "));

/**
 * The demo's agent choice with its agents listed (`· recommended`). Until BUG-258 the home view
 * drew one frame with the new choice and the last one's options (`keep talking` alone, the drafting
 * row unnamed) and, under load, sometimes showed it for seconds. Should it come back, the suite
 * notes it and redraws the block (Ctrl+O twice: fold the spec and back), so the golden is the frame
 * Gluon meant; still missing, it fails with that id.
 */
async function optionsShown(app: App) {
  await app.waitFor("keep talking", 20_000);
  await app.idle();
  try {
    await app.waitFor(optionsListed, 3_000);
    return;
  } catch {}
  STALE_FRAMES.push(app.screen());
  await app.press(KEYS.ctrlO);
  await app.press(KEYS.ctrlO);
  try {
    await app.waitFor(optionsListed, 3_000);
  } catch {
    throw new Error(`BUG-258: the agent choice shows no agent, only keep talking:\n${app.screen()}`);
  }
}

/** Walks the demo to its agent choice for `task`, the agents listed. */
async function toChoice(app: App, task: string) {
  await toQuestion(app, task);
  await app.press(KEYS.enter);
  await optionsShown(app);
}

/**
 * Opens a session of each fake in turn (as `openSessions` in `gluon-kit.ts`, with the BUG-258 check):
 * the option for `fake` in the first proposal, or after a reply naming it (the demo routes again, pinned).
 */
async function openAll(app: App, fakes: readonly FakeAgent[], task: string) {
  for (const [i, fake] of fakes.entries()) {
    if (i > 0) await home(app);
    await toChoice(app, `${task} ${i + 1}`);
    let option = optionOf(app, fake);
    if (option === null) {
      await app.type(`use ${HARNESS_OF[fake]} please`);
      await app.press(KEYS.enter);
      await app.waitFor((s) => s.includes("cheaper setup"), 20_000);
      await optionsShown(app);
      option = optionOf(app, fake);
    }
    if (option === null) throw new Error(`the demo offers no ${fake}:\n${app.screen()}`);
    await app.type(String(option));
    await app.press(KEYS.enter);
    await app.waitFor((s) => s.includes("TUI ready") && s.includes("◆ gluon"), 20_000);
    await app.waitFor((s) => (s.split("\n")[1] ?? "").startsWith(` ${LABEL[fake]} × `));
    await sessionIdle(app);
  }
}

/**
 * Waits until the frame (masked, so blinking and clocks don't count) stays the same for 300 ms: a
 * state's parts can arrive in separate writes (the home view's hint after the question on the
 * last row, an agent's echo after Gluon's), further apart than the harness's quiet moment.
 * Gives up after 5 s (× SLOW): the golden then shows what changes.
 */
export async function steady(app: App) {
  const now = () => serialize(mask(grab(app, "", "dark")));
  const end = performance.now() + 5_000 * SLOW;
  let last = now();
  while (performance.now() < end) {
    await app.settle(300);
    const next = now();
    if (next === last) return;
    last = next;
  }
}

/** The shown session is idle: its info line says `awaiting your input` (3 s of quiet after its last output). */
export async function sessionIdle(app: App) {
  await app.waitFor((s) => /awaiting your input|awaiting/.test(s.split("\n")[1] ?? ""), 15_000);
  await app.settle(100);
}

/** At home, every session's status settled: no row reads Working or Starting (unless `working` rows are meant to). */
async function homeSettled(app: App, working = 0) {
  await app.waitFor((s) => HOME_VIEW.test(s) && (s.match(/ Working {2,}| Starting /g)?.length ?? 0) <= working, 15_000);
  await app.settle(150);
}

/** The demo's question is up and the intake agent idle. */
async function toQuestion(app: App, task: string) {
  await app.type(task);
  await app.press(KEYS.enter);
  await app.waitFor((s) => s.replace(/\s+/g, " ").includes(QUESTION), 20_000);
  await app.idle();
}

/** Gluon with `fake` alone on PATH, its session open and idle. */
async function launchOnly(app: App, fake: FakeAgent, task: string) {
  await toChoice(app, task);
  await app.press(KEYS.enter);
  await app.waitFor((s) => s.includes("TUI ready") && s.includes("◆ gluon"), 20_000);
  await app.waitFor((s) => (s.split("\n")[1] ?? "").startsWith(` ${LABEL[fake]} × `));
  await sessionIdle(app);
}

/** Erases `count` characters from the agent's line (the fakes read Backspace, not Ctrl+U). */
async function erase(app: App, count: number) {
  for (let i = 0; i < count; i++) await app.press(KEYS.backspace);
}

/** One fake's session: idle, a line typed, its slash menu, the /clear question. */
function sessionChain(fake: FakeAgent, extra?: (app: App, shot: Shot) => Promise<void>, extraShots: string[] = []): Chain {
  return {
    id: `session-${fake}`,
    shots: ["idle", "typed", "slashMenu", "questionClear", ...extraShots].map((s) => `s.${fake}.${s}`),
    agents: [fake],
    async run(app, shot) {
      await launchOnly(app, fake, `${fake} task`);
      await shot(`s.${fake}.idle`);
      await app.type("hello");
      await shot(`s.${fake}.typed`);
      await erase(app, 5);
      await app.type("/");
      // The fake `agy` lists no /compact (Antigravity has none), as the matrix's slashMenu waits for /help.
      await app.waitFor(fake === "agy" ? "/help" : "/compact");
      await shot(`s.${fake}.slashMenu`);
      await app.type("clear");
      await app.press(KEYS.enter);
      await app.waitFor((s) => /^ \? (\/\S+ ends this session|End (this )?session)/.test(s.split("\n").at(-1) ?? ""));
      await shot(`s.${fake}.questionClear`);
      await app.press(KEYS.esc);
      await app.waitFor((s) => !/ends this session|End (this )?session/.test(s));
      await erase(app, "/clear".length);
      await app.settle(100);
      await extra?.(app, shot);
    },
  };
}

export const CHAINS: Chain[] = [
  {
    id: "home-chat",
    shots: ["home.first", "home.typed", "home.question", "home.proposal", "home.specFolded", "home.specPgdn", "home.specPgup", "home.discardQ"],
    async run(app, shot) {
      await shot("home.first");
      await app.type("fix the add bug");
      await shot("home.typed");
      await app.press(KEYS.enter);
      await app.waitFor((s) => s.replace(/\s+/g, " ").includes(QUESTION), 20_000);
      await app.idle();
      await shot("home.question");
      await app.press(KEYS.enter);
      await optionsShown(app);
      await shot("home.proposal");
      await app.press(KEYS.ctrlO);
      await shot("home.specFolded");
      await app.press(KEYS.ctrlO);
      await app.press(KEYS.pgdn);
      await shot("home.specPgdn");
      await app.press(KEYS.pgup, KEYS.pgup, KEYS.pgup);
      await shot("home.specPgup");
      await app.press(KEYS.esc);
      await app.waitFor((s) => !s.includes("keep talking"));
      await app.press(KEYS.delete);
      await app.waitFor((s) => /^ \? Discard this chat\?/.test(s.split("\n").at(-1) ?? "") && !s.includes("del discards it"));
      await shot("home.discardQ");
    },
  },
  {
    // The intake agent's first turn: 700 ms of thinking before its first words (`demoClient`).
    id: "home-working",
    shots: ["home.working"],
    async run(app, shot) {
      await app.type("fix the add bug");
      await app.press(KEYS.enter);
      await app.waitFor((s) => s.includes("esc to interrupt") && !s.includes("Let me look"), 5_000);
      await shot("home.working");
    },
  },
  {
    id: "home-sessions",
    shots: ["home.sessions", "home.keys", "home.endQ", "home.quitQ", "home.done", "home.questionWithSessions"],
    agents: ["claude"],
    async run(app, shot) {
      await launchOnly(app, "claude", "fix the add bug");
      await home(app);
      await homeSettled(app);
      await shot("home.sessions");
      await app.press(KEYS.question);
      await app.waitFor((s) => /esc closes|\? closes|keys/i.test(s));
      await shot("home.keys");
      await app.press(KEYS.esc);
      await app.waitFor((s) => !/esc closes/.test(s));
      await app.press(KEYS.delete);
      await app.waitFor((s) => /^ \? End Gluon-/.test(s.split("\n").at(-1) ?? "") && s.includes("enter ends it"));
      await shot("home.endQ");
      await app.press(KEYS.esc);
      await app.waitFor((s) => !/End Gluon-/.test(s));
      await app.press(KEYS.ctrlC, KEYS.ctrlC);
      await app.waitFor((s) => /^ \? .*\bquit/i.test(s.split("\n").at(-1) ?? "") && s.includes("enter quits"));
      await shot("home.quitQ");
      await app.press(KEYS.esc);
      await app.waitFor((s) => !/^ \? .*\bquit/i.test(s.split("\n").at(-1) ?? ""));
      await app.press(KEYS.ctrlD);
      await app.waitFor((s) => /Done/.test(s));
      await shot("home.done");
      await toQuestion(app, "add a readme");
      await shot("home.questionWithSessions");
    },
  },
  {
    id: "home-groups",
    shots: ["home.groups", "home.collapsed"],
    agents: ["claude", "opencode"],
    async run(app, shot) {
      await openAll(app, ["claude", "opencode"], "group");
      await say(app, "!event status working", "EVENT status working");
      await home(app);
      await homeSettled(app, 1);
      await shot("home.groups");
      // ↑ from the selected row onto its group's label (the selected row is the one on the selection colour), Enter folds it.
      const label = () => app.lines().findIndex((l) => /▾ Working/.test(l));
      for (let i = 0; i < 6 && app.bg(4, label()) !== GLUON_HEX.bar; i++) await app.press(KEYS.up);
      await app.press(KEYS.enter);
      await app.waitFor((s) => /▸ /.test(s));
      await shot("home.collapsed");
    },
  },
  {
    id: "many",
    shots: ["tabs.overflow", "home.many", "home.proposalCrowded"],
    // The demo offers the recommended agent and two others: four sessions of the three it offers.
    agents: ["claude", "opencode", "codex"],
    async run(app, shot) {
      await openAll(app, ["claude", "opencode", "codex", "claude"], "many");
      await sessionIdle(app);
      await app.press(KEYS.left);
      await app.waitFor((s) => (s.split("\n")[1] ?? "").startsWith(` ${LABEL.codex} × `));
      await sessionIdle(app);
      await shot("tabs.overflow");
      await home(app);
      await homeSettled(app);
      await shot("home.many");
      // A fifth task: the agent choice with four sessions listed above it.
      await toChoice(app, "many 5");
      await shot("home.proposalCrowded");
    },
  },
  ...FAKES.map((fake) =>
    fake === "claude"
      ? sessionChain(
          "claude",
          async (app, shot) => {
            await app.type("/compact");
            await app.press(KEYS.enter);
            await app.waitFor((s) => /^ \? End (this session )?instead/.test(s.split("\n").at(-1) ?? ""));
            await shot("s.claude.questionCompact");
            await app.press(KEYS.esc);
            await app.waitFor((s) => !/ends this session|End (this )?session/.test(s));
            await erase(app, "/compact".length);
            await say(app, "!wide", "WIDE");
            await sessionIdle(app);
            await shot("s.claude.wide");
            await say(app, "!lines 60", "LINE 60");
            await sessionIdle(app);
            await app.press(wheelUp(10, 10));
            await app.waitFor((s) => /↑ \d+ · esc back/.test(s));
            await shot("s.claude.scrolled");
            await app.press(KEYS.esc);
            await app.waitFor((s) => !/esc back/.test(s));
            await say(app, "!event status working", "EVENT status working");
            await app.waitFor((s) => /Working/.test(s.split("\n")[1] ?? ""));
            await shot("s.claude.working");
          },
          ["questionCompact", "wide", "scrolled", "working"],
        )
      : sessionChain(fake),
  ),
  ...(["claude", "codex"] as const).map(
    (fake): Chain => ({
      id: `alt-${fake}`,
      shots: [`s.${fake}.alt`],
      agents: [fake],
      env: { FAKE_ALT: "1" },
      async run(app, shot) {
        await launchOnly(app, fake, `${fake} alt`);
        await shot(`s.${fake}.alt`);
      },
    }),
  ),
  {
    id: "tiny-home",
    shots: ["home.tiny"],
    sizes: { dark: TINY, light: TINY },
    async run(_app, shot) {
      await shot("home.tiny");
    },
  },
  {
    id: "tiny-session",
    shots: ["s.claude.tiny"],
    sizes: { dark: TINY, light: TINY },
    agents: ["claude"],
    startAt: { cols: 80, rows: 24 },
    async run(app, shot, size) {
      await launchOnly(app, "claude", "tiny task");
      app.resize(size.cols, size.rows);
      await redrawn(app);
      if (size.cols >= 20 && size.rows >= 6) await sessionIdle(app);
      else await app.waitFor((s) => /too small/.test(s));
      await shot("s.claude.tiny");
    },
  },
];

/** Every scene, in chain order. */
export const SCENES: string[] = CHAINS.flatMap((c) => c.shots);

/**
 * Scenes reached at `from`, then resized to `to`: the frame must be the one a fresh start at `to`
 * shows (after masking; a session's interior is the agent's own and may print its new size, so
 * only Gluon's chrome is compared there). `bug`: a known mismatch, its candidate id.
 */
export interface ResizeCheck {
  chain: string;
  scene: string;
  from: Size;
  to: Size;
  bug?: string;
  /** In the must batch too (`test:visual-must`): it guards a fixed bug. */
  must?: boolean;
}

export const RESIZE_CHECKS: ResizeCheck[] = [
  { chain: "home-chat", scene: "home.first", from: SIZES[2]!, to: SIZES[1]! },
  { chain: "home-chat", scene: "home.question", from: SIZES[2]!, to: SIZES[1]! },
  { chain: "home-chat", scene: "home.proposal", from: SIZES[0]!, to: SIZES[3]! },
  // After the resize the last row keeps the ground a fresh start paints (BUG-245).
  { chain: "home-sessions", scene: "home.sessions", from: SIZES[2]!, to: SIZES[1]!, must: true },
  { chain: "home-sessions", scene: "home.keys", from: SIZES[0]!, to: SIZES[2]! },
  { chain: "session-claude", scene: "s.claude.idle", from: SIZES[2]!, to: SIZES[1]! },
  { chain: "session-codex", scene: "s.codex.idle", from: SIZES[0]!, to: SIZES[3]! },
  { chain: "many", scene: "tabs.overflow", from: SIZES[3]!, to: SIZES[0]! },
];

/** How long a chain may take (it waits for every session to go idle). */
export const CHAIN_TIMEOUT_MS = 180_000 * SLOW;

/** Where PNGs, sheets and the review index go (gitignored). */
export const OUT = join(import.meta.dir, "out");
