/**
 * The monkey test's runner (`gluon-monkey.e2e.test.ts`): a seeded run's setup (which fakes, how
 * many tabs, the terminal's size, the home key, the agents' modes), its random actions drawn from
 * a weighted alphabet the model (`gluon-model.ts`) can predict, the run against the real Gluon —
 * after every action the view, the tab, the question, the scroll mode, the untouched line, the
 * composer and every agent's input are compared with the model, plus `checkInvariants` — and, on a
 * failure, the actions shrunk (delta debugging, replaying from scratch) to a ready-to-paste test.
 */
import { layout } from "../../src/pty/chrome.ts";
import { keyLabel } from "../../src/ui/layout.ts";
import { KEYS, bytesOf, describeAction, mouseReports, type Action, type KeyName } from "./actions.ts";
import type { FakeAgent } from "./fixtures.ts";
import { ASK_YAML, EVENT_HOOK, FAKES, gluon, HARNESS_OF, LABEL, optionOf, toChoice } from "./gluon-kit.ts";
import { checkInvariants, viewOf } from "./gluon-invariants.ts";
import * as M from "./gluon-model.ts";
import { type App, HOME_VIEW, SLOW } from "./harness.ts";

/** One seeded run's setup. */
export interface MonkeyConfig {
  /** The tabs' fakes, in launch order. */
  tabs: FakeAgent[];
  /** The fakes on PATH. */
  path: FakeAgent[];
  cols: number;
  rows: number;
  homeKey: M.HomeKey;
  /** `FAKE_ALT`: the agents draw on the alternate screen. */
  alt: boolean;
  /** `FAKE_KITTY`: the agents push the kitty keyboard flags at start. */
  kitty: boolean;
}

/**
 * Patterns the monkey leaves out: each a Gluon bug a `test.failing("BUG-CANDIDATE/GM-…")` repro
 * pins in `gluon-monkey.e2e.test.ts`. Set one to false once its bug is fixed.
 */
export const KNOWN: Record<string, boolean> = {};

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [v, w] of items) if ((x -= w) < 0) return v;
  return items.at(-1)![0];
}

/** The three fakes the demo offers side by side (agy and grok only alone). */
const MIXABLE: FakeAgent[] = ["claude", "codex", "opencode"];

/** The setup of seed `seed` for `fake`: deterministic. */
export function configFor(fake: FakeAgent, seed: number): MonkeyConfig {
  const r = rng(seed * 7919 + FAKES.indexOf(fake) * 104729 + 1);
  const n = pick(r, [[1, 0.25], [2, 0.35], [3, 0.25], [4, 0.15]] as const);
  const mix = MIXABLE.includes(fake);
  const tabs: FakeAgent[] = Array.from({ length: n }, (_, i) => (i === 0 || !mix || r() < 0.7 ? fake : MIXABLE.filter((f) => f !== fake)[Math.floor(r() * 2)]!));
  // The first tab is `fake`'s; shuffle where it lands.
  const at = Math.floor(r() * n);
  [tabs[0], tabs[at]] = [tabs[at]!, tabs[0]!];
  return {
    tabs,
    path: mix ? MIXABLE : [fake],
    cols: pick(r, [[100, 0.5], [72, 0.25], [50, 0.25]] as const),
    rows: pick(r, [[30, 0.6], [24, 0.4]] as const),
    homeKey: r() < 0.2 ? "ctrl+]" : "ctrl+\\",
    alt: r() < 0.15,
    kitty: r() < 0.2,
  };
}

/** The task each session is started with, and the name the demo gives it. */
const task = (i: number) => `t ${i + 1}`;
export const tabName = (i: number) => `Gluon-t-${i + 1}`;

export function modelConfig(c: MonkeyConfig): M.ModelConfig {
  return { cols: c.cols, rows: c.rows, homeKey: c.homeKey, tabs: c.tabs.map((fake, i) => ({ fake, name: tabName(i) })), alt: c.alt, kitty: c.kitty };
}

// ---- the alphabet ----

type Candidate = [Action[], number];

/** Pastes a session gets: plain, multi-line, `/clear`, the home key's byte, an ESC. */
const pastes = (homeByte: string) => ["pasted text", "one\ntwo", "/clear", `a${homeByte}b`, "x\x1b[Dy"];

/** What the monkey may do now, weighted. */
function candidates(s: M.ModelState): Candidate[] {
  const out: Candidate[] = [];
  const add = (w: number, ...acts: Action[]) => w > 0 && out.push([acts, w]);
  const key = (k: KeyName): Action => ({ key: k });
  const homeKey = M.HOME_KEYS[s.homeKey];
  const others = (["ctrlBackslash", "ctrlBracket", "ctrlCaret", "ctrlUnderscore"] as const).filter((k) => k !== homeKey);
  const sp = M.strip(s);
  const stripClicks = (w: number) => {
    const at = (x0: number, x1: number): Action => ({ mouse: { op: "click", button: "left", x: Math.floor((x0 + x1 - 1) / 2) + 1, y: 1 } });
    add(1.2 * w, at(sp.home[0], sp.home[1]));
    for (const t of sp.tabs) add(0.6 * w, at(t.x0, t.x1));
    if (sp.prev) add(1.2 * w, at(sp.prev.x0, sp.prev.x1));
    if (sp.next) add(1.2 * w, at(sp.next.x0, sp.next.x1));
  };
  const t = M.shown(s);
  if (!t) {
    if (s.overlay !== null) {
      add(1.2, key("enter"));
      add(2, key("esc"));
      add(0.5, key("ctrlC"));
      add(0.4, { text: "a" });
      add(0.2, { paste: "hi there" });
      add(0.3, key("left"));
      return out;
    }
    if ([...s.draft].length < 16) for (const x of ["a", "hi", " ", "q", "é"]) add(0.6, { text: x });
    add(2, key("enter"));
    add(2, key("right"));
    add(0.8, key("left"));
    add(1, key("backspace"));
    for (const k of ["home", "end", "ctrlA", "ctrlE"] as const) add(0.2, key(k));
    add(0.3, key("ctrlU"));
    add(0.4, key("ctrlC"));
    add(0.3, key("esc"));
    add(0.6, key("delete"));
    add(0.4, key(homeKey));
    for (const k of others) add(0.1, key(k));
    for (const k of ["tab", "pgup", "pgdn", "shiftPgup", "ctrlO"] as const) add(0.1, key(k));
    add(0.3, { paste: "hi there" });
    add(0.2, { mouse: { op: "click", button: "left", x: 3, y: 1 } });
    return out;
  }
  const lastTab = s.tabs.length === 1;
  // The home key waits for a key that picks: mostly one that does (any other cancels it and goes on).
  if (s.prefix) {
    add(6, key("left"));
    add(6, key("right"));
    add(4, key(homeKey));
    add(3, key("esc"));
  }
  const room = [...t.line].length < 24;
  if (room) for (const x of ["a", "hi", "é", "你", "x y", "q", "/"]) add(0.5, { text: x });
  if (t.line === "") {
    add(1.5, { text: "/clear" });
    add(2, { text: "/clear" }, key("enter"));
    if (!t.modes.alt) add(0.8, { text: "!lines 40" }, key("enter"));
    if (!t.modes.mouse) add(0.7, { text: "!mouse" }, key("enter"));
    if (!t.modes.focus) add(0.5, { text: "!focus" }, key("enter"));
    if (!t.modes.kitty) add(0.4, { text: "!kitty" }, key("enter"));
  }
  add(t.question !== null && lastTab ? 0.3 : 3, key("enter"));
  add(t.question !== null ? 3 : 1.5, key("esc"));
  add(0.6, key("ctrlC"));
  add(1.5, key("backspace"));
  add(5, key("left"));
  add(5, key("right"));
  for (const k of ["shiftLeft", "shiftRight", "ctrlLeft", "ctrlRight"] as const) add(0.2, key(k));
  // Alt+←/→ are dropped on an untouched line, the agent's otherwise; Alt+PgUp/PgDn always the agent's.
  for (const k of ["altLeft", "altRight"] as const) add(1.2, key(k));
  for (const k of ["altPgup", "altPgdn"] as const) add(0.3, key(k));
  for (const k of ["up", "down", "tab"] as const) add(0.3, key(k));
  for (const k of ["home", "end", "pgup", "pgdn", "delete", "ctrlU", "ctrlW", "ctrlA", "ctrlE", "ctrlO", "shiftTab", "ctrlPgup"] as const) add(0.1, key(k));
  for (const k of ["space", "slash", "y", "n", "question", "percent", "digit1", "digit0"] as const) add(0.15, key(k));
  add(2.5, key(homeKey));
  for (const k of others) add(0.2, key(k));
  add(1.2, key("shiftPgup"));
  add(1.2, key("shiftPgdn"));
  if (t.modes.kitty) for (const k of M.MODEL_KEYS.filter(M.isKittyKey)) add(0.3, key(k));
  stripClicks(1);
  const r = M.interior(s);
  const cell = (i: number) => ({ x: r.left + 1 + ((i * 7) % r.cols), y: r.top + 1 + ((i * 5) % r.rows) });
  const m = t.modes.mouse ? 2.5 : 1;
  add(0.6 * m, { mouse: { op: "click", button: "left", ...cell(s.agents[t.id]!.length) } });
  add(0.15 * m, { mouse: { op: "click", button: "right", ...cell(3) } });
  add(0.15 * m, { mouse: { op: "click", button: "middle", ...cell(4) } });
  add(0.8, { mouse: { op: "wheel", button: "up", ...cell(1) } });
  add(0.8, { mouse: { op: "wheel", button: "down", ...cell(2) } });
  add(0.4, { focus: "in" });
  add(0.4, { focus: "out" });
  if (room) for (const p of pastes(KEYS[homeKey])) add(0.3, { paste: p });
  return out;
}

/** Runs the model over `actions`; null if a step isn't one it can predict. */
export function modelRun(s0: M.ModelState, actions: readonly Action[]): M.StepResult[] | null {
  const out: M.StepResult[] = [];
  let s = s0;
  for (const a of actions) {
    const r = M.step(s, a);
    if ("unsupported" in r) return null;
    out.push(r);
    s = r.next;
  }
  return out;
}

/** `steps` random actions the model can predict, drawn from seed `seed`'s stream. */
export function generate(s0: M.ModelState, seed: number, steps: number): Action[] {
  const r = rng(seed ^ 0x5bd1e995);
  const out: Action[] = [];
  let s = s0;
  while (out.length < steps) {
    let cands = candidates(s);
    for (;;) {
      if (!cands.length) throw new Error(`the monkey has nothing to do in ${M.describeView(s)}`);
      const choice = pick(r, cands);
      const run = modelRun(s, choice);
      if (run) {
        out.push(...choice);
        s = run.at(-1)!.next;
        break;
      }
      cands = cands.filter(([a]) => a !== choice);
    }
  }
  return out.slice(0, steps);
}

// ---- the run ----

/**
 * Starts Gluon for `c` and opens its sessions (the last one shown). On a loaded machine an agent's
 * model list may not load in time and the demo doesn't offer it: up to two more tries, from scratch.
 */
export async function setUp(c: MonkeyConfig): Promise<App> {
  for (let tries = 1; ; tries++) {
    try {
      return await openAll(c);
    } catch (e) {
      if (tries >= 3 || !/the demo offers no/.test((e as Error).message)) throw e;
    }
  }
}

async function openAll(c: MonkeyConfig): Promise<App> {
  const yaml = `${ASK_YAML}  key: '${c.homeKey}'\n`;
  const env: Record<string, string> = { FAKE_EVENT_HOOK: EVENT_HOOK, ...(c.alt ? { FAKE_ALT: "1" } : {}), ...(c.kitty ? { FAKE_KITTY: "1" } : {}) };
  const app = await gluon(c.cols, c.rows, env, yaml, c.path);
  for (const [i, fake] of c.tabs.entries()) {
    if (i > 0) {
      await app.press(KEYS[M.HOME_KEYS[c.homeKey]], KEYS[M.HOME_KEYS[c.homeKey]]);
      await app.waitFor(HOME_VIEW);
      await app.settle(150);
    }
    await toChoice(app, task(i));
    let option = optionOf(app, fake);
    if (option === null) {
      // `keep talking` with a reply naming the agent: the demo routes again, pinned to it.
      await app.type(`use ${HARNESS_OF[fake]} please`);
      await app.press(KEYS.enter);
      await app.waitFor((s) => s.includes("cheaper setup") && s.includes("keep talking"), 20_000);
      await app.idle();
      option = optionOf(app, fake);
    }
    if (option === null) {
      const screen = app.screen();
      app.kill();
      throw new Error(`the demo offers no ${fake}; screen:\n${screen}`);
    }
    await app.type(String(option));
    await app.press(KEYS.enter);
    await app.waitFor((s) => s.includes("TUI ready") && s.includes("◆ gluon"), 20_000);
    await app.waitFor((s) => s.split("\n")[1]?.startsWith(` ${LABEL[fake]} × `) ?? false);
    await app.settle(200);
  }
  return app;
}

/** Does `a` to the app the way a user's terminal would: keys and reports as they come, text typed. */
async function perform(app: App, a: Action): Promise<void> {
  if ("key" in a) {
    // A lone ESC: wait for its answer (the decoder waits for more first), so the next key isn't read as Alt+key.
    if (KEYS[a.key] === "\x1b") return app.press(KEYS.esc);
    return app.write(KEYS[a.key]);
  }
  if ("text" in a) return app.type(a.text);
  if ("mouse" in a) {
    for (const r of mouseReports(a.mouse)) app.write(r);
    return;
  }
  app.write(bytesOf(a));
}

/** The highlighted tab on the strip: its text (the underlined run of row 0). */
function highlighted(app: App): string[] {
  const buf = app.term.buffer.active;
  const line = buf.getLine(buf.viewportY);
  const runs: string[] = [];
  let cur: string | null = null;
  for (let x = 0; line && x < app.term.cols; x++) {
    const c = line.getCell(x);
    if (c?.isUnderline()) cur = (cur ?? "") + (c.getChars() || (c.getWidth() ? " " : ""));
    else if (cur !== null) runs.push(cur.trim()), (cur = null);
  }
  if (cur !== null) runs.push(cur.trim());
  return runs;
}

/** The home composer's text starts after the view's side padding and ` › ` (or its indent); the padding again at the right. */
const COMPOSER_LEFT = 5;
const COMPOSER_RIGHT = 2;

/**
 * Whether `rows` (the composer's rows, its indent off, trimmed at the right) show `draft` wrapped
 * at words to `width` (BUG-266): the draft's text in order, a row ending only where the blank
 * after a word was (trimmed off) or — in a row with no blank — where a word too long for a row
 * is cut. A draft longer than the composer shows (`↑ 2 more lines`) isn't checked. Null: it is.
 */
export function wrapProblem(rows: readonly string[], draft: string, width: number): string | null {
  if (rows.some((r) => /^ *[↑↓] \d+ more lines?$/.test(r))) return null;
  let rest = draft;
  for (const [i, r] of rows.entries()) {
    if (Bun.stringWidth(r) > width) return `row ${i + 1} is wider than the composer`;
    if (i === rows.length - 1) return rest.trimEnd() === r ? null : `the last row should be ${show(rest.trimEnd())}`;
    if (!rest.startsWith(r)) return `row ${i + 1} should start ${show(rest.slice(0, r.length))}`;
    rest = rest.slice(r.length);
    const blank = /^\s*/.exec(rest)![0];
    if (!blank && rest !== "" && /\s/.test(r)) return `row ${i + 1} cuts a word that fits the next row`;
    // A blank that didn't fit the row starts the next one, shown there.
    const next = rows[i + 1]!;
    rest = rest.slice(blank.length - Math.min(blank.length, /^\s*/.exec(next)![0].length));
  }
  return rest === "" ? null : "text missing";
}

const row = (app: App, y: number) => (app.term.buffer.active.getLine(app.term.buffer.active.viewportY + y)?.translateToString(true) ?? "").trimEnd();
const show = (s: string) => JSON.stringify(s);

/** Where the app differs from the model's state (empty: it matches). */
export function compare(app: App, s: M.ModelState): string[] {
  const out: string[] = [];
  const logs = app.inputLogs();
  for (const [i, want] of s.agents.entries()) {
    const got = logs[i]?.bytes ?? "";
    if (got !== want) out.push(`agent ${tabName(i)}: got ${show(got)}, expected ${show(want)}`);
  }
  if (logs.length > s.agents.length) out.push(`${logs.length} agents started, expected ${s.agents.length}`);
  const view = viewOf(app);
  const t = M.shown(s);
  const { rows } = app.term;
  const last = row(app, rows - 1);
  if (!t) {
    if (view !== "home") return [...out, `view: ${view ?? "unknown"}, expected home`];
    const ask = /^ \? End /.test(last);
    if (s.overlay !== null && !ask) out.push(`home question: expected “End ${s.tabs.find((x) => x.id === s.overlay)?.name}?” on the last row, got ${show(last)}`);
    if (s.overlay === null && ask) out.push(`home question: none expected, got ${show(last)}`);
    const lines = app.lines();
    const at = lines.findLastIndex((l) => /^\s*› /.test(l));
    if (at < 0) return [...out, "home: no composer"];
    // The whole composer: the `› ` row and the rows under it, down to its lower rule (BUG-266).
    const end = lines.findIndex((l, i) => i > at && /^\s*─+\s*$/.test(l));
    const rows = lines.slice(at, end < 0 ? undefined : end).map((l) => l.trimEnd());
    if (s.draft === "") {
      if (!HOME_VIEW.test(rows[0]!)) out.push(`composer: ${show(rows[0]!.trim())}, expected the placeholder`);
    } else {
      const problem = HOME_VIEW.test(rows[0]!) ? "the placeholder" : wrapProblem(rows.map((r) => r.slice(COMPOSER_LEFT)), s.draft, s.cols - COMPOSER_LEFT - COMPOSER_RIGHT);
      if (problem) out.push(`composer: ${show(rows.join("⏎"))}, expected ${show(`› ${s.draft}`)} wrapped at words: ${problem}`);
    }
    return out;
  }
  if (view !== "session") return [...out, `view: ${view ?? "unknown"}, expected session ${t.name}`];
  const lay = layout(s.cols, s.rows);
  const hi = highlighted(app);
  if (hi.length !== 1 || !hi[0]!.includes(t.name)) out.push(`tab: ${show(hi.join(" | "))} highlighted, expected ${t.name}`);
  // The strip where the model clicks: each tab's name in its span, the markers in theirs.
  const top = row(app, lay.tabRow);
  const sp = M.strip(s);
  for (const span of sp.tabs) {
    const name = s.tabs.find((x) => x.id === span.id)!.name;
    if (!top.slice(span.x0, span.x1).includes(name.slice(0, Math.max(1, span.x1 - span.x0 - 4)))) out.push(`strip: ${name} isn't at ${span.x0}–${span.x1}: ${show(top)}`);
  }
  if (sp.prev && !/‹\d/.test(top.slice(sp.prev.x0, sp.prev.x1))) out.push(`strip: no ‹ marker at ${sp.prev.x0}: ${show(top)}`);
  if (sp.next && !/\d›/.test(top.slice(sp.next.x0, sp.next.x1))) out.push(`strip: no › marker at ${sp.next.x0}: ${show(top)}`);
  // The home key waiting for the key that picks: its bar takes the place of the question's and the bottom bar.
  const prefixBar = last.startsWith(" ←/→ ") && last.includes(` ${keyLabel(s.homeKey)} home`);
  if (s.prefix !== prefixBar) out.push(`prefix: ${s.prefix ? "expected" : "none expected,"} the prefix bar, the bar is ${show(last)}`);
  const asking = M.END_Q_BAR.test(last);
  if (!s.prefix && t.question !== null && !asking) out.push(`question: expected “${M.END_Q}” in the bar, got ${show(last)}`);
  if (t.question === null && asking) out.push(`question: none expected, the bar is ${show(last)}`);
  const bottom = row(app, lay.frame.top + lay.frame.rows - 1);
  const footer = /↑ (\d+) · esc back/.exec(bottom);
  if (s.offset.lo > 0 && !footer) out.push(`scroll: expected scrolled back ${s.offset.lo}–${s.offset.hi} rows, the frame's bottom is ${show(bottom)}`);
  else if (s.offset.lo > 0 && (Number(footer![1]) < s.offset.lo || Number(footer![1]) > s.offset.hi)) out.push(`scroll: ${footer![1]} rows back, expected ${s.offset.lo}–${s.offset.hi}`);
  if (s.offset.hi === 0 && footer) out.push(`scroll: expected the live screen, the frame's bottom is ${show(bottom)}`);
  // The bar names ←/→ only while they switch: the line untouched and another tab to go to (BUG-241);
  // else just the home key.
  if (t.question === null && !s.prefix) {
    const want = s.tabs.length > 1 && M.untouched(t) ? "←/→" : null;
    const got = /^ ←\/→ switch/.exec(last) ? "←/→" : null;
    if (got !== want) out.push(`untouched: the bar offers ${got ?? "no switch key"}, expected ${want ?? "no switch key"} (the line ${M.untouched(t) ? "untouched" : "touched"}, ${s.tabs.length} tab(s)): ${show(last)}`);
  }
  return out;
}

/** Waits until the app matches the model (or the wait runs out), then checks once more with the invariants. */
async function settleOn(app: App, s: M.ModelState): Promise<string[]> {
  const end = performance.now() + 5000 * SLOW;
  while (compare(app, s).length && performance.now() < end) await Bun.sleep(20);
  await app.quiet();
  const t = M.shown(s);
  return [...compare(app, s), ...checkInvariants(app, { view: t ? "session" : "home", tab: t?.name, homeKey: s.homeKey })];
}

export interface Failure {
  /** The failing step's index (−1: the setup). */
  at: number;
  problems: string[];
  notes: string[];
  screen: string;
}

/**
 * Runs `actions` on a fresh Gluon set up as `c`, checking the model after each; the first step
 * that doesn't match, or null. The actions must be ones the model can predict (`modelRun`).
 */
export async function play(c: MonkeyConfig, actions: readonly Action[]): Promise<Failure | null> {
  let app: App | undefined;
  try {
    app = await setUp(c);
    let s = M.initialState(modelConfig(c));
    const first = await settleOn(app, s);
    if (first.length) return { at: -1, problems: first, notes: ["after opening the sessions"], screen: app.screen() };
    for (const [i, a] of actions.entries()) {
      const r = M.step(s, a);
      if ("unsupported" in r) throw new Error(`step ${i} (${describeAction(a)}) isn't one the model can predict: ${r.unsupported}`);
      await perform(app, a);
      s = r.next;
      const problems = await settleOn(app, s);
      if (problems.length) return { at: i, problems, notes: r.notes, screen: app.screen() };
    }
    return null;
  } catch (e) {
    return { at: -1, problems: [`the run failed: ${(e as Error).message}`], notes: [], screen: app?.screen() ?? "" };
  } finally {
    app?.kill();
  }
}

/** Replays `actions` (a shrunk failure's test): the first failing step's problems, or none. */
export async function replay(c: MonkeyConfig, actions: readonly Action[]): Promise<string[]> {
  const f = await play(c, actions);
  return f ? [`step ${f.at}${f.at >= 0 ? ` (${describeAction(actions[f.at]!)})` : ""}: ${f.notes.join("; ")}`, ...f.problems] : [];
}

/**
 * Delta debugging (ddmin) over `actions`, which fail: the smallest list found that still fails
 * (replayed from scratch each time), within `budgetMs`. Lists the model can't predict aren't tried.
 */
export async function shrink(c: MonkeyConfig, actions: Action[], budgetMs: number): Promise<{ actions: Action[]; failure: Failure; replays: number }> {
  const s0 = M.initialState(modelConfig(c));
  const end = performance.now() + budgetMs;
  const tried = new Set<string>();
  let replays = 0;
  let best = actions;
  let failure: Failure | null = null;
  const fails = async (cand: Action[]): Promise<boolean> => {
    const k = JSON.stringify(cand);
    if (tried.has(k) || !modelRun(s0, cand)) return false;
    tried.add(k);
    replays++;
    const f = await play(c, cand);
    if (!f || f.at < 0) return false;
    best = cand.slice(0, f.at + 1);
    failure = f;
    return true;
  };
  // First the failing step with fewer and fewer of the steps before it (most failures need only a
  // recent few): short replays are cheap.
  for (let k = 1; k < best.length && performance.now() < end; k *= 2) if (await fails(best.slice(-k))) break;
  let n = 2;
  while (best.length >= 2 && performance.now() < end) {
    const size = Math.ceil(best.length / n);
    let reduced = false;
    for (let i = 0; i < n && !reduced && performance.now() < end; i++) {
      const cur = best;
      if (await fails([...cur.slice(0, i * size), ...cur.slice((i + 1) * size)])) {
        reduced = true;
        n = Math.max(2, n - 1);
      }
    }
    if (!reduced) {
      if (n >= best.length) break;
      n = Math.min(best.length, n * 2);
    }
  }
  return { actions: best, failure: failure ?? (await play(c, best)) ?? { at: -1, problems: ["did not fail again"], notes: [], screen: "" }, replays };
}

/** An action as source text for a test. */
const source = (a: Action) => JSON.stringify(a).replace(/"(\w+)":/g, "$1: ").replace(/,(?=\w+: )/g, ", ").replace(/\{/g, "{ ").replace(/\}/g, " }");

/** The ready-to-paste test for a shrunk failure. */
export function snippet(c: MonkeyConfig, actions: readonly Action[], f: Failure): string {
  const title = (f.problems[0] ?? "the model and Gluon disagree").replace(/["\\`]/g, "'").slice(0, 100);
  return [
    `test("BUG-CANDIDATE/GM-…: ${title}", async () => {`,
    `  const problems = await replay(${JSON.stringify(c).replace(/"(\w+)":/g, "$1: ").replace(/,(?=\w+: )/g, ", ")}, [`,
    ...actions.map((a) => `    ${source(a)}, // ${describeAction(a)}`),
    "  ]);",
    "  expect(problems).toEqual([]);",
    "}, 180_000);",
  ].join("\n");
}

/** A failure for the report: where, what, the screen. */
export function describeFailure(actions: readonly Action[], f: Failure): string {
  const step = f.at >= 0 ? `step ${f.at + 1} of ${actions.length} (${describeAction(actions[f.at]!)})` : "the setup";
  return [`at ${step}: ${f.notes.join("; ") || "-"}`, ...f.problems.map((p) => `  - ${p}`), "screen:", f.screen].join("\n");
}

