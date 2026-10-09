/**
 * The coverage matrix's e2e table (`test/fixtures/gluon-matrix.ts`): the real Gluon on the demo
 * brain with the TUI fakes. Each group starts one app, reaches each of its states (`SESSION_STATES`,
 * `HOME_STATES`), and for each of the state's cells applies the input (`apply`), checks the cell's
 * expectation (the screen, the view, the highlighted tab, the agents' input log) and the
 * invariants (`checkInvariants`), then brings the state back; a cell that ends the app (a signal,
 * a yes that quits) runs last, on an app of its own when the state can't be reached cleanly.
 *
 * Regression runs the `smoke` cells; `GLUON_FULL=1` every `e2e` cell too (minutes: every signal in
 * every state needs an app of its own). A cell known to fail is listed in `KNOWN_FAILING` with why:
 * it is still run, and the group fails if it starts passing (take it off the list then).
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { layout, MIN_COLS, MIN_ROWS, tabSpans } from "../../src/pty/chrome.ts";
import { createKeyDecoder } from "../../src/pty/keys.ts";
import { GLUON_HEX } from "../../src/ui/theme.ts";
import { apply, bytesOf, describeAction, KEYS, wheelUp, type Action } from "./actions.ts";
import { gluon, launch, launchAs, openSessions, say } from "./gluon-kit.ts";
import { checkInvariants, viewOf } from "./gluon-invariants.ts";
import { type App, HOME_VIEW, SLOW, stopAll } from "./harness.ts";
import { WIN, type FakeAgent } from "./fixtures.ts";
import { FAKE_OF_ID, inputAction, REF, resolve, shiftedReports, type Expect, type HarnessId, type HomeAction, type InputId, type SessionState, type StateId, type Tier } from "../fixtures/gluon-matrix.ts";

const FULL = !!process.env.GLUON_FULL;
setDefaultTimeout((FULL ? 900_000 : 240_000) * SLOW);
afterAll(stopAll);

/**
 * Cells the app gets wrong today (a Gluon bug, not the matrix's): `<state> <input>` → why. Each is
 * still run; it must keep failing until fixed (then it comes off this list).
 */
export const KNOWN_FAILING: Record<string, string> = {};

/** `on_compact: ask` too: `/compact` asks (the questionCompact states). */
const YAML = "handoff:\n  on_clear: ask\n  on_compact: ask\n";

// ── Bases: the app a group starts from ─────────────────────────────────────────────────────────

type BaseKind = "one" | "alt" | "three" | "five" | "home0" | "home1";

interface Ctx {
  app: App;
  kind: BaseKind;
  fake: FakeAgent;
  /** The size the base was reached at (the states' own, but tooSmall's). */
  size: { cols: number; rows: number };
  /** The sessions' tab names, in strip (launch) order. */
  ring: string[];
  /** Persistent modes the agent turned on (`!focus`, `!mouse`, `!kitty`, `!tick`, `!lines`). */
  dirt: Set<string>;
}

async function makeBase(kind: BaseKind, fake: FakeAgent): Promise<Ctx> {
  const ctx = (app: App, ring: string[], size = REF as { cols: number; rows: number }): Ctx => ({ app, kind, fake, size: { ...size }, ring, dirt: new Set() });
  switch (kind) {
    case "one":
      return ctx(await launchAs(fake, { yaml: YAML }), [`Gluon-${fake}-task`]);
    case "alt":
      return ctx(await launchAs(fake, { yaml: YAML, env: { FAKE_ALT: "1" } }), [`Gluon-${fake}-task`]);
    case "three":
    case "five": {
      const n = kind === "three" ? 3 : 5;
      const size = kind === "three" ? REF : { cols: 60, rows: REF.rows };
      const app = await gluon(size.cols, size.rows, {}, YAML, [fake]);
      await openSessions(app, Array(n).fill(fake));
      return ctx(app, Array.from({ length: n }, (_, i) => `Gluon-session-${i + 1}`), size);
    }
    case "home0":
      // The demo at its own pace: h.working's keys must land while it works.
      return ctx(await gluon(REF.cols, REF.rows, { GLUON_TEST_DEMO_PACE: "1" }, YAML, ["claude"]), []);
    case "home1": {
      const app = await gluon(REF.cols, REF.rows, {}, YAML, ["claude"]);
      await launch(app, "one task");
      await toHome(app);
      return ctx(app, ["Gluon-one-task"]);
    }
  }
}

// ── Reading the screen ─────────────────────────────────────────────────────────────────────────

const bar = (app: App) => {
  const buf = app.term.buffer.active;
  return (buf.getLine(buf.viewportY + app.term.rows - 1)?.translateToString(true) ?? "").trimEnd();
};
const questionUp = (app: App) => /^ \? /.test(bar(app));
/** The bar while the home key waits for the key that picks (`prefixBar`). */
const PREFIX_BAR = /^ ←\/→ switch session · ctrl\+\\ home · esc cancel/;
/** The frame's scroll footer: rows scrolled back (0: live). */
const scrolledBy = (app: App) => Number(/↑ (\d+) · esc back/.exec(app.screen())?.[1] ?? 0);

/** The highlighted tab on the strip (its underlined text), or null. */
function shownTab(app: App): string | null {
  const line = app.term.buffer.active.getLine(app.term.buffer.active.viewportY);
  let out = "";
  for (let x = 0; line && x < app.term.cols; x++) {
    const c = line.getCell(x);
    if (c?.isUnderline()) out += c.getChars() || " ";
  }
  return out.trim() ? out.trim() : null;
}

/** Which of `ring` is shown ("home" at home), by the highlighted tab. */
function shown(app: App, ring: string[]): string | null {
  const v = viewOf(app);
  if (v === "home") return "home";
  const t = shownTab(app);
  if (!t) return null;
  // The longest name the tab's text holds (session-1 is a prefix of session-10, never here).
  return ring.filter((n) => t.includes(n) || n.startsWith(t.replace(/^\S+\s+/, "").replace(/…$/, ""))).sort((a, b) => b.length - a.length)[0] ?? null;
}

const PLACEHOLDERS = ["describe the session you want", "describe another session", "reply to the intake agent"];
/** The placeholder, whole or cut to fit (`…`). */
const placeholder = (t: string) => PLACEHOLDERS.some((p) => t === p || (t.endsWith("…") && p.startsWith(t.slice(0, -1))));

/** The home view's composer: its text (between the last two rules), "" for the placeholder. */
function composer(app: App): string {
  const lines = app.lines();
  const rules = lines.flatMap((l, i) => (/^\s*─{3,}\s*$/.test(l) ? [i] : []));
  if (rules.length < 2) return "";
  // Rows scrolled out of a short composer are counted (`↑ 2 more lines`), not part of the draft.
  const body = lines.slice(rules.at(-2)! + 1, rules.at(-1)!).filter((l) => !/^\s*↑ \d+ more lines?$/.test(l));
  const text = body.map((l) => l.replace(/^\s*› ?/, "").replace(/^ {5}/, "")).join("\n").replace(/\s+$/, "");
  return placeholder(text.trim()) ? "" : text;
}

/** Rows of the home view on the selected background (the selected list row, an option). */
function selectedRows(app: App): string[] {
  const out: string[] = [];
  for (let y = 0; y < app.term.rows; y++) if (app.bg(4, y) === GLUON_HEX.selected) out.push(app.lines()[y] ?? "");
  return out;
}

interface Snap {
  view: string | null;
  shown: string | null;
  input: Map<number, number>;
  scrolled: number;
  bar: string;
  question: boolean;
  composer: string;
  composerRows: number;
  keysOpen: boolean;
  overlay: string | null;
  selected: string[];
  option: string | null;
  specFolded: boolean;
  screen: string;
}

function snap(c: Ctx): Snap {
  const app = c.app;
  const lines = app.lines();
  const rules = lines.flatMap((l, i) => (/^\s*─{3,}\s*$/.test(l) ? [i] : []));
  return {
    view: viewOf(app),
    shown: shown(app, c.ring),
    input: new Map(app.inputLogs().map((a) => [a.pid, a.bytes.length])),
    scrolled: scrolledBy(app),
    bar: bar(app),
    question: questionUp(app),
    composer: composer(app),
    composerRows: rules.length >= 2 ? rules.at(-1)! - rules.at(-2)! - 1 : 0,
    keysOpen: app.screen().includes("? / esc close"),
    overlay: /^ \? /.test(bar(app)) ? bar(app) : null,
    selected: selectedRows(app),
    option: lines.find((l) => /^\s*❯ \d\./.test(l))?.trim() ?? null,
    specFolded: /\(ctrl\+o to view\)/.test(app.screen()),
    screen: app.screen(),
  };
}

/** What the agents read since `before` (each agent's new bytes; only one should have any). */
function newInput(app: App, before: Snap): string {
  return app.inputLogs().map((a) => a.bytes.slice(before.input.get(a.pid) ?? 0)).join("");
}

/** Waits (bounded) until `ok`, for what lands after the screen settled (the agents' input log). */
async function until(ok: () => boolean, ms = 1500): Promise<boolean> {
  const end = performance.now() + ms * SLOW;
  while (!ok()) {
    if (performance.now() > end) return false;
    await Bun.sleep(20);
  }
  return true;
}

// ── Getting to a state, and back to it ─────────────────────────────────────────────────────────

async function toHome(app: App) {
  // The home key arms the prefix, the home key again goes home.
  await app.press(KEYS.ctrlBackslash, KEYS.ctrlBackslash);
  await app.waitFor(HOME_VIEW);
  await app.settle(150);
}

/** The base's size (a cell may have resized it). */
async function resized(c: Ctx, size = c.size) {
  if (c.app.term.cols === size.cols && c.app.term.rows === size.rows) return;
  c.app.resize(size.cols, size.rows);
  await c.app.settle(250);
}

/** The shown session's line emptied and untouched again (Ctrl+U and Backspaces: the cursor may be anywhere in it; then Enter on nothing). */
async function clearLine(app: App) {
  if (questionUp(app)) {
    await app.press(KEYS.esc);
    await app.waitFor(() => !questionUp(app));
  }
  if (scrolledBy(app)) {
    await app.press("q");
    await app.waitFor(() => !scrolledBy(app));
  }
  await app.press(`\x15${"\x7f".repeat(16)}`);
  // The agent has read the Enter before the next snapshot of its input.
  const before = new Map(app.inputLogs().map((a) => [a.pid, a.bytes.length]));
  await app.press(KEYS.enter);
  await until(() => app.inputLogs().some((a) => a.bytes.slice(before.get(a.pid) ?? 0).includes("\r")));
}

/** Shows the `n`th session (1-based) of a multi-session base, its line untouched. */
async function showTab(c: Ctx, n: number) {
  const app = c.app;
  if (viewOf(app) === "session") await clearLine(app);
  if (viewOf(app) !== "home") await toHome(app);
  // → at home opens the first tab; the home key's prefix and → walk on (whatever each line holds).
  await app.press(KEYS.right);
  for (let i = 1; i < n; i++) await app.press(KEYS.ctrlBackslash, KEYS.right);
  await app.waitFor(() => shown(app, c.ring) === c.ring[n - 1]);
  await clearLine(app);
}

/** Brings the single-session base to its session, line empty and untouched, at its size. */
async function sessionBase(c: Ctx) {
  const app = c.app;
  await resized(c);
  if (viewOf(app) === "home") {
    await app.press(KEYS.right);
    await app.waitFor((s) => s.includes("◆ gluon"));
  }
  await clearLine(app);
}

/** Runs `!cmd` in the agent once per app (its mode stays on). */
async function agentMode(c: Ctx, cmd: string, answer: string) {
  if (c.dirt.has(cmd)) return;
  await say(c.app, cmd, answer);
  c.dirt.add(cmd);
}

/** Gets the app to a session state (from its base, whatever the last cell left). */
async function reachSession(c: Ctx, state: SessionState) {
  const app = c.app;
  const multi = { firstTab: 1, midTab: 2, lastTab: 3, overflow: 3 } as Record<string, number>;
  await resized(c);
  if (state in multi) return showTab(c, multi[state]!);
  await sessionBase(c);
  switch (state) {
    case "idle":
    case "alt":
      return;
    case "typed":
      await app.type("hello");
      return app.waitFor("hello");
    case "slashMenu":
      await app.type("/");
      // Its menu (the fake `agy` lists no /compact: Antigravity has none).
      return app.waitFor("/help");
    case "questionClear":
    case "questionCompact":
      await app.type(state === "questionClear" ? "/clear" : "/compact");
      await app.press(KEYS.enter);
      return app.waitFor((s) => /^ \? (\/\S+ ends this session|End (this )?session)/.test(s.split("\n").at(-1) ?? ""));
    case "scrolled":
      await agentMode(c, "!lines 60", "LINE 60");
      await app.press(wheelUp(20, 12));
      return app.waitFor("↑ 3 · esc back");
    case "tooSmall":
      app.resize(19, 5);
      return app.waitFor(/^too small/);
    case "focus":
      return agentMode(c, "!focus", "FOCUS ON");
    case "mouse":
      return agentMode(c, "!mouse", "MOUSE ON");
    case "kitty":
      return agentMode(c, "!kitty", "KITTY ON");
    case "working":
      return agentMode(c, "!tick", "TICK 1");
  }
}

/** The home view: no overlay, no key list, an empty composer, the size of the base. */
async function homeBase(c: Ctx, size = c.size) {
  const app = c.app;
  await resized(c, size);
  if (viewOf(app) === "session" || viewOf(app) === "tooSmall") {
    if (viewOf(app) === "session") await clearLine(app);
    await toHome(app);
  }
  if (questionUp(app)) {
    await app.press(KEYS.esc);
    await app.waitFor(() => !questionUp(app));
  }
  if (app.screen().includes("? / esc close")) await app.press(KEYS.esc);
  // A Ctrl+C armed to quit: disarmed by another key (End moves nothing in an empty composer).
  if (app.screen().includes("Press ctrl+c again")) await app.press(KEYS.end);
  if (composer(app).trim()) await app.press(KEYS.ctrlC);
  if (composer(app)) await app.press("\x7f".repeat(12));
  // The last cell's key may land a frame late: the composer is empty before the next one.
  if (!(await until(() => composer(app) === ""))) {
    await app.press(KEYS.ctrlC);
    await app.press("\x7f".repeat(12));
  }
}

/** One session's row selected (not its group's label), not marked done. */
async function sessionRowSelected(c: Ctx) {
  const app = c.app;
  if (/▸ \w+/.test(app.screen())) {
    // A folded group: select its label, Enter unfolds it.
    for (let i = 0; i < 4 && !app.screen().includes("enter expands the group"); i++) await app.press(KEYS.up);
    await app.press(KEYS.enter);
  }
  // A key typed late into the composer (a focus report Gluon let through) hides the list's hint.
  if (composer(app).trim()) await app.press(KEYS.ctrlC);
  await selectRow(app, /enter opens it|ctrl\+d unmarks done/);
  if (app.screen().includes("ctrl+d unmarks done")) await app.press(KEYS.ctrlD);
  await app.waitFor("enter opens it");
}

/** ↓, then ↑, until the hint says the row wanted is selected (the list's ends stay put). */
async function selectRow(app: App, hint: RegExp) {
  for (const key of [KEYS.down, KEYS.up])
    for (let i = 0; i < 8 && !hint.test(app.screen()); i++) {
      await app.press(key);
      await until(() => hint.test(app.screen()), 200);
    }
  await app.waitFor((s) => hint.test(s));
}

/** The app can't get back to the state (the demo asks its question once per run): start a fresh one. */
class NeedsFresh extends Error {}

const questionShown = (app: App) => /❯ 1\. Add a regression test/.test(app.screen()) && app.screen().includes("enter answers");
const proposalShown = (app: App) => app.screen().includes("enter starts the session");

/** The demo's question up: it asks once per run (`demoClient`), so after that only a fresh app has it. */
async function questionOpen(c: Ctx) {
  const app = c.app;
  if (questionShown(app)) return;
  if (app.screen().includes("Drafting") || c.dirt.has("asked")) throw new NeedsFresh();
  c.dirt.add("asked");
  await app.type("fix the add bug");
  await app.press(KEYS.enter);
  await app.waitFor(() => questionShown(app), 20_000);
  await app.idle();
}

/** A chat with its options open: the question, or (once it was asked) a proposal; the demo proposes again at each reply. */
async function chatOpen(c: Ctx) {
  const app = c.app;
  if (questionShown(app) || proposalShown(app)) return;
  if (!app.screen().includes("Drafting") && !c.dirt.has("asked")) return questionOpen(c);
  await app.type("again");
  await app.press(KEYS.enter);
  await app.waitFor(() => proposalShown(app), 20_000);
  await app.idle();
}

async function reachHome(c: Ctx, state: StateId) {
  const app = c.app;
  await homeBase(c, state === "h.tooSmall" ? { cols: 19, rows: 5 } : state === "h.sessions.overflow" ? { cols: 80, rows: 16 } : c.size);
  switch (state) {
    case "h.empty":
    case "h.tooSmall":
      return;
    case "h.sessions":
    case "h.sessions.overflow":
      return sessionRowSelected(c);
    case "h.keys":
      await sessionRowSelected(c);
      await app.press("?");
      return app.waitFor("? / esc close");
    case "h.endQ":
      await sessionRowSelected(c);
      await app.press(KEYS.delete);
      return app.waitFor(/End Gluon-[\w-]+\?/);
    case "h.quitQ":
      await sessionRowSelected(c);
      await app.press(KEYS.ctrlC, KEYS.ctrlC);
      return app.waitFor("quit and end it?");
    case "h.discardQ":
      if (!app.screen().includes("Drafting")) await chatOpen(c);
      // Esc closes the options (↑↓ move them while they're open).
      if (questionShown(app) || proposalShown(app)) await app.press(KEYS.esc);
      await app.waitFor(() => !questionShown(app) && !proposalShown(app));
      await selectRow(app, /del discards it/);
      await app.press(KEYS.delete);
      return app.waitFor("Discard this chat?");
    case "h.question":
      return questionOpen(c);
    case "h.proposal":
    case "h.spec": {
      const open = () => proposalShown(app);
      if (!open()) await chatOpen(c);
      if (!open()) {
        await app.press(KEYS.enter);
        await app.waitFor(open, 20_000);
        await app.idle();
      }
      const folded = () => app.screen().includes("(ctrl+o to view)");
      if (folded() !== (state === "h.spec")) await app.press(KEYS.ctrlO);
      return app.waitFor(() => folded() === (state === "h.spec") && open());
    }
    case "h.working": {
      // A message to the intake agent: it works for a second or so (the input lands meanwhile).
      const ready = () => working(app) && composer(app) === "";
      if (ready()) return;
      // Still at it from the last one: an Enter now would only queue the message for the turn's end.
      if (working(app)) await app.idle(20_000);
      c.dirt.add("asked");
      await app.type("more");
      app.write(KEYS.enter);
      // Not `waitFor`: it waits for a quiet screen, and the spinner keeps it busy for most of the work.
      if (!(await until(ready, 20_000))) throw new Error(`the intake agent never worked; screen:\n${app.screen()}`);
      return;
    }
  }
}

/** The intake agent is at work (h.working). */
const working = (app: App) => app.screen().includes("esc to interrupt");

async function reach(c: Ctx, state: StateId) {
  if (state.startsWith("h.")) return reachHome(c, state);
  return reachSession(c, state.split(".")[2] as SessionState);
}

// ── Checking a cell ────────────────────────────────────────────────────────────────────────────

/** What an input's cell checks: the expectation, met or the problems. */
interface Cell {
  state: StateId;
  input: InputId;
  expect: Expect;
  tier: Tier;
}

const decode = (bytes: string) => {
  const d = createKeyDecoder("ctrl+\\");
  return [...d.feed(bytes), ...d.flush()];
};

/** The text a paste leaves in the composer: escape sequences and control characters dropped. */
const pastedText = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");

/** The neighbour on the ring of tabs (home first) of what is shown. */
function neighbourOf(ring: string[], from: string | null, dir: 1 | -1): string {
  const r = ["home", ...ring];
  const i = Math.max(0, r.indexOf(from ?? "home"));
  return r[(i + dir + r.length) % r.length]!;
}

/** The input's action, aimed on this screen (mouse inputs at the strip as drawn). */
function actionOf(c: Ctx, input: InputId): ReturnType<typeof inputAction> {
  const { cols, rows } = c.app.term;
  const current = c.ring.indexOf(shown(c.app, c.ring) ?? "") + 1;
  const small = cols < MIN_COLS || rows < MIN_ROWS;
  // At home (no tab shown) there is no strip to aim at (`screenOf`).
  const strip = small || !current ? null : tabSpans(c.ring.map((name, i) => ({ id: i + 1, name, state: "awaiting" as const })), current, cols);
  return inputAction(input, { cols, rows, strip, current: current || undefined });
}

/** What the input should have done; the problems found (empty: as expected). */
async function check(c: Ctx, cell: Cell, before: Snap, action: Action, bytes: string): Promise<string[]> {
  const app = c.app;
  const e = cell.expect;
  const out: string[] = [];
  const delta = () => newInput(app, before);
  const noInput = async () => {
    await app.settle(50);
    if (delta()) out.push(`the agent got ${JSON.stringify(delta())}`);
  };
  const view = () => viewOf(app);
  const isHome = cell.state.startsWith("h.");

  if ("exit" in e) {
    const code = await app.exitCode();
    if (code !== e.exit) out.push(`exit code ${code}, not ${e.exit}`);
    return out;
  }
  if ("toAgent" in e) {
    let want = e.toAgent === "same" ? bytes : e.toAgent;
    if (e.toAgent === "shifted") {
      const i = layout(app.term.cols, app.term.rows).interior;
      want = shiftedReports(decode(bytes), i, "sgr");
    }
    await until(() => delta().length >= want.length);
    if (delta() !== want) out.push(`the agent got ${JSON.stringify(delta())}, not ${JSON.stringify(want)}`);
    if (view() !== before.view && !(before.view === "session" && view() === "session")) out.push(`the view went ${before.view} → ${view()}`);
  } else if ("dropped" in e) {
    await noInput();
    if (view() !== before.view) out.push(`the view went ${before.view} → ${view()}`);
    if (shown(app, c.ring) !== before.shown) out.push(`the shown tab went ${before.shown} → ${shown(app, c.ring)}`);
    if (isHome) {
      const s = snap(c);
      if (s.composer !== before.composer) out.push(`the composer went ${JSON.stringify(before.composer)} → ${JSON.stringify(s.composer)}`);
      if (s.overlay !== before.overlay) out.push(`the question went ${before.overlay} → ${s.overlay}`);
    } else if (questionUp(app) !== before.question) out.push(`the question went ${before.question} → ${questionUp(app)}`);
  } else if ("home" in e) {
    if (!(await until(() => view() === "home"))) out.push(`not home: ${view()}`);
    await noInput();
  } else if ("prefix" in e) {
    // The bar says what the next key does; nothing reaches the agent, nothing moves.
    if (!(await until(() => PREFIX_BAR.test(bar(app))))) out.push(`no prefix bar: ${JSON.stringify(bar(app))}`);
    await noInput();
    if (view() !== before.view) out.push(`the view went ${before.view} → ${view()}`);
    if (shown(app, c.ring) !== before.shown) out.push(`the shown tab went ${before.shown} → ${shown(app, c.ring)}`);
    // Esc cancels it (swallowed): the bar the state had comes back.
    await app.press(KEYS.esc);
    if (!(await until(() => !PREFIX_BAR.test(bar(app))))) out.push(`Esc left the prefix bar: ${JSON.stringify(bar(app))}`);
    await noInput();
    if (bar(app) !== before.bar) out.push(`the bar went ${JSON.stringify(before.bar)} → ${JSON.stringify(bar(app))}`);
  } else if ("switch" in e) {
    const want = neighbourOf(c.ring, before.shown, e.switch);
    if (!(await until(() => shown(app, c.ring) === want))) out.push(`shows ${shown(app, c.ring)}, not ${want}`);
    await noInput();
  } else if ("show" in e) {
    if (!(await until(() => shown(app, c.ring) !== before.shown && viewOf(app) === "session"))) out.push(`still shows ${shown(app, c.ring)}`);
    await noInput();
  } else if ("scroll" in e) {
    const up = e.scroll === "page" || (typeof e.scroll === "number" && e.scroll > 0);
    if (!(await until(() => (up ? scrolledBy(app) > before.scrolled : scrolledBy(app) < before.scrolled)))) out.push(`scrolled ${before.scrolled} → ${scrolledBy(app)}`);
    await noInput();
  } else if ("unscroll" in e) {
    if (!(await until(() => scrolledBy(app) === 0))) out.push(`still scrolled back ${scrolledBy(app)}`);
    await noInput();
  } else if ("answer" in e) {
    if (!(await until(() => !questionUp(app)))) out.push("the question is still up");
  } else if ("asks" in e) {
    if (!(await until(() => questionUp(app) && bar(app).includes(e.asks)))) out.push(`the bar doesn't ask ${JSON.stringify(e.asks)}: ${JSON.stringify(bar(app))}`);
  } else if ("resized" in e) {
    const size = "resize" in action ? action.resize : c.size;
    if (app.term.cols !== size.cols || app.term.rows !== size.rows) out.push("not resized");
    const small = size.cols < MIN_COLS || size.rows < MIN_ROWS;
    // The redraw at the new size can take a moment (the home view's is Ink's).
    await until(() => checkInvariants(app).length === 0, 3000);
    if (!isHome && !small && viewOf(app) === "session" && !before.scrolled) {
      const i = layout(size.cols, size.rows).interior;
      if (!(await until(() => app.screen().includes(`SIZE ${i.cols}x${i.rows}`), 3000))) out.push(`the agent wasn't told ${i.cols}x${i.rows}`);
      if (before.question && !questionUp(app)) out.push("the question went with the resize");
    }
    if (small && !isHome && viewOf(app) !== "tooSmall") out.push(`below ${MIN_COLS}×${MIN_ROWS} the view is ${viewOf(app)}, not too small`);
    await noInput();
  } else if ("homeAction" in e) out.push(...(await checkHome(c, cell, e.homeAction, before, action)));

  out.push(...checkInvariants(app));
  return out;
}

async function checkHome(c: Ctx, cell: Cell, a: HomeAction, before: Snap, action: Action): Promise<string[]> {
  const app = c.app;
  const out: string[] = [];
  const now = () => snap(c);
  const tiny = app.term.cols < MIN_COLS || app.term.rows < MIN_ROWS;
  const same = (s: Snap, keys: (keyof Snap)[]) => {
    for (const k of keys) if (JSON.stringify(s[k]) !== JSON.stringify(before[k])) out.push(`${k} went ${JSON.stringify(before[k])} → ${JSON.stringify(s[k])}`);
  };
  await app.settle(60);
  if (newInput(app, before)) out.push(`an agent got ${JSON.stringify(newInput(app, before))}`);
  switch (a) {
    case "type": {
      const text = "key" in action ? KEYS[action.key] : "paste" in action ? pastedText(action.paste) : "";
      // A key closes the key list and does what it does; a paste isn't a key (it goes to the composer under the list).
      const closes = "key" in action;
      const flat = (s: string) => s.replace(/\s+/g, " ").trim();
      const want = flat(before.keysOpen ? text : before.composer + text);
      // A tiny composer shows the end of the draft.
      const typed = () => {
        const got = flat(now().composer);
        return (tiny ? want.endsWith(got.replace(/^…/, "")) || got.endsWith(flat(text).slice(-3)) : got.endsWith(want) || got === want) && !(closes && now().keysOpen);
      };
      // Ink may draw the key a frame later on a loaded machine.
      if (!(await until(typed))) out.push(`the composer reads ${JSON.stringify(now().composer)}, not ${JSON.stringify(want)}`);
      if (closes && now().keysOpen) out.push("the key list is still open");
      same(now(), ["view", "overlay"]);
      break;
    }
    case "nothing":
      // The intake agent goes on working meanwhile: its question may open.
      same(now(), ["view", "composer", "overlay", "keysOpen", ...(cell.state === "h.working" ? [] : (["option", "specFolded"] as const))]);
      break;
    case "newline": {
      await until(() => now().composerRows > before.composerRows || now().composer.includes("\n"));
      const s = now();
      if (s.composer.replace(/\s/g, "") !== before.composer.replace(/\s/g, "")) out.push(`the composer reads ${JSON.stringify(s.composer)}: text, not a new line`);
      else if (!tiny && s.composerRows <= before.composerRows && !s.composer.includes("\n")) out.push("no new line in the composer");
      same(s, ["view", "overlay"]);
      break;
    }
    case "list": {
      // The selection moves where there is a line to move to (the list's ends stay put).
      const s = now();
      if (s.keysOpen) out.push("the key list is still open");
      // (While the intake agent works, its question may open meanwhile and take ↑↓.)
      if (!s.selected.length && cell.state !== "h.working") out.push("nothing selected");
      same(s, ["view", "composer", "overlay"]);
      break;
    }
    case "open":
    case "firstTab":
      if (!(await until(() => viewOf(app) === "session"))) out.push(`no session shown: ${viewOf(app)}`);
      else if (a === "firstTab" && shown(app, c.ring) !== c.ring[0]) out.push(`shows ${shown(app, c.ring)}, not the first tab`);
      break;
    case "markDone":
      if (!(await until(() => app.screen().includes("ctrl+d unmarks done") && /Done/.test(app.screen())))) out.push("not marked done");
      break;
    case "end":
      if (!(await until(() => /End Gluon-[\w-]+\?/.test(bar(app))))) out.push(`no end question: ${JSON.stringify(bar(app))}`);
      break;
    case "discard":
      if (!(await until(() => bar(app).includes("Discard this chat?")))) out.push(`no discard question: ${JSON.stringify(bar(app))}`);
      break;
    case "keys":
      if (!(await until(() => now().keysOpen))) out.push("the key list isn't open");
      break;
    case "closeKeys":
      await until(() => !now().keysOpen);
      if (now().keysOpen) out.push("the key list is still open");
      same(now(), ["composer", "view"]);
      break;
    case "scrollKeys":
      if (!now().keysOpen) out.push("the key list closed");
      same(now(), ["composer", "view"]);
      break;
    case "scrollChat":
    case "scrollSpec":
      same(now(), ["view", "composer", "overlay", "keysOpen", "option"]);
      break;
    case "options":
      await until(() => now().option !== before.option);
      if (now().option === before.option) out.push(`the highlighted option didn't move: ${now().option}`);
      same(now(), ["view", "composer"]);
      break;
    case "pick":
      if (cell.state === "h.question") {
        if (!(await until(() => !app.screen().includes("enter answers"), 3000))) out.push("the question is still open");
      } else if (!(await until(() => viewOf(app) === "session", 20_000))) out.push(`no session started: ${viewOf(app)}`);
      break;
    case "closeOptions":
      if (!(await until(() => now().option === null))) out.push(`the options are still open: ${now().option}`);
      break;
    case "cycleModel":
    case "cycleEffort":
    case "cycleMode":
      await until(() => now().option !== before.option);
      if (now().option === before.option) out.push(`the highlighted agent's ${a === "cycleModel" ? "model" : a === "cycleEffort" ? "effort" : "mode"} didn't change: ${now().option}`);
      break;
    case "foldSpec":
      await until(() => now().specFolded !== before.specFolded);
      if (now().specFolded === before.specFolded) out.push("the spec didn't fold or unfold");
      break;
    case "quitArm":
      if (!(await until(() => /Press ctrl\+c agai/.test(app.screen())))) out.push("no `Press ctrl+c again to quit`");
      if ((await app.exitCode(200)) !== null) out.push("Gluon quit");
      break;
    case "interrupt":
      if (!(await until(() => !app.screen().includes("esc to interrupt"), 3000))) out.push("the intake agent is still working");
      break;
  }
  return out;
}

/**
 * Does this cell leave the app unable to reach its state again (a signal; a yes to quitting or
 * to ending the session; a pick that starts a session)? It runs last, on an app of its own.
 */
function destroys(cell: Cell): boolean {
  if ("exit" in cell.expect) return true;
  // A pick on the agent choice starts a session: the home view isn't the no-sessions one after it.
  if ("homeAction" in cell.expect && cell.expect.homeAction === "pick" && cell.state !== "h.question") return true;
  return "answer" in cell.expect && (cell.state === "h.endQ" || cell.state === "h.quitQ") && /^k\.(kitty)?[eE]nter$/.test(cell.input);
}

// ── The groups ─────────────────────────────────────────────────────────────────────────────────

const table = resolve();
/** `GLUON_MATRIX_ONLY=<regex>`: only the cells whose `<state> <input>` matches (a rerun of a few). */
const ONLY = process.env.GLUON_MATRIX_ONLY ? new RegExp(process.env.GLUON_MATRIX_ONLY) : null;
/** Windows has no SIGHUP (`kill` says ENOSYS). */
const NO_SUCH_SIGNAL = (input: string) => WIN && input === "sig.HUP";
const cellsOf = (state: StateId): Cell[] =>
  [...table.get(state)!].flatMap(([input, cell]) =>
    cell && !NO_SUCH_SIGNAL(input) && "expect" in cell && (cell.tier === "smoke" || (FULL && cell.tier === "e2e")) && (!ONLY || ONLY.test(`${state} ${input}`)) ? [{ state, input, expect: cell.expect, tier: cell.tier }] : [],
  );

interface Group {
  name: string;
  base: BaseKind;
  fake: FakeAgent;
  states: StateId[];
}

const LINE: SessionState[] = ["idle", "typed", "slashMenu", "questionClear", "questionCompact", "scrolled", "tooSmall"];
const MODES: SessionState[] = ["focus", "mouse", "kitty", "working"];

function groups(): Group[] {
  const out: Group[] = [];
  const has = (s: StateId) => cellsOf(s).length > 0;
  const add = (name: string, base: BaseKind, fake: FakeAgent, states: StateId[]) => {
    const live = states.filter(has);
    if (live.length) out.push({ name, base, fake, states: live });
  };
  const home: StateId[] = ["h.empty", "h.question", "h.proposal", "h.spec", "h.working", "h.tooSmall"];
  const home1: StateId[] = ["h.sessions", "h.keys", "h.endQ", "h.quitQ", "h.discardQ"];
  // The slowest first: they start while the rest queue.
  for (const h of ["cc", "codex", "oc", "agy", "grok"] as HarnessId[]) add(`${h}: overflow (five tabs)`, "five", FAKE_OF_ID[h], [`s.${h}.overflow`, ...(h === "cc" ? (["h.sessions.overflow"] as StateId[]) : [])]);
  for (const h of ["cc", "codex", "oc", "agy", "grok"] as HarnessId[]) add(`${h}: three tabs`, "three", FAKE_OF_ID[h], (["firstTab", "midTab", "lastTab"] as SessionState[]).map((s): StateId => `s.${h}.${s}`));
  for (const s of FULL ? home1 : [home1]) add(`home with a session: ${[s].flat().join(", ")}`, "home1", "claude", [s].flat() as StateId[]);
  for (const h of ["cc", "codex", "oc", "agy", "grok"] as HarnessId[]) {
    const line = LINE.map((s): StateId => `s.${h}.${s}`);
    const modes = MODES.map((s): StateId => `s.${h}.${s}`);
    // Regression: one app per harness for both (the modes come last, they stay on); the full run splits them.
    if (FULL) {
      add(`${h}: the line`, "one", FAKE_OF_ID[h], line);
      add(`${h}: the agent's modes`, "one", FAKE_OF_ID[h], modes);
    } else add(`${h}: the line, then the agent's modes`, "one", FAKE_OF_ID[h], [...line, ...modes]);
    add(`${h}: the alternate screen`, "alt", FAKE_OF_ID[h], [`s.${h}.alt`]);
  }
  for (const s of FULL ? home : [home]) add(`home: ${[s].flat().join(", ")}`, "home0", "claude", [s].flat() as StateId[]);
  return out;
}

/** The agent's modes that stay on once a state turned them on (`MODES`; `!lines` only fills its scrollback). */
const LASTING = new Set(["!focus", "!mouse", "!kitty", "!tick"]);

/**
 * Whether the app can still reach `state` cleanly: a line state (`LINE`) only before the agent
 * turned a mode on for good; the modes' states pile up (their cells — keys, resizes, signals, a
 * click into the interior while the mouse is on — don't depend on the modes before them).
 */
function cleanFor(c: Ctx, state: StateId): boolean {
  if (state.startsWith("h.")) return true;
  if (MODES.includes(state.split(".")[2] as SessionState)) return true;
  return ![...c.dirt].some((d) => LASTING.has(d));
}

async function runGroup(g: Group) {
  let c: Ctx | null = null;
  const t0 = performance.now();
  let apps = 0;
  let ran = 0;
  let unchecked = 0;
  const failures: string[] = [];
  const passedKnown: string[] = [];
  const fresh = async () => {
    c?.app.kill();
    // Once more if the demo walk fails: on a machine loaded past its cores the sign-in checks
    // time out and the demo offers no agent (the setup, not the cell under test).
    for (let attempt = 0; ; attempt++) {
      apps++;
      try {
        c = await makeBase(g.base, g.fake);
        return c;
      } catch (e) {
        if (attempt) throw e;
      }
    }
  };
  const record = (cell: Cell, problems: string[]) => {
    const key = `${cell.state} ${cell.input}`;
    if (KNOWN_FAILING[key]) {
      if (!problems.length) passedKnown.push(key);
    } else if (problems.length) failures.push(`${cell.state} × ${cell.input} (${JSON.stringify(cell.expect)}):\n    ${problems.join("\n    ")}\n${c?.app.screen().replace(/^/gm, "      | ") ?? ""}`);
  };
  /** The state, on a fresh app when this one can't get back to it, or once more on one when it failed (a loaded machine). */
  const reachOrFresh = async (state: StateId) => {
    try {
      await reach(c!, state);
    } catch {
      await fresh();
      await reach(c!, state);
    }
  };
  /** One cell: the input, its check; false when the app can't go on (it failed or ended). */
  const run = async (cell: Cell): Promise<boolean> => {
    const first = actionOf(c!, cell.input);
    if (!first) {
      record(cell, ["no target for this input on this screen"]);
      return true;
    }
    ran++;
    let problems: string[] = [];
    // The intake agent works for a second or so: an input sent once it was done says nothing about
    // h.working (another go, then the cell counts as unchecked). Judged as the input is sent, not
    // after: a signal ends the app, and a key's answer takes long enough for the work to end.
    const raced = (app: App) => cell.state === "h.working" && !("homeAction" in cell.expect && cell.expect.homeAction === "interrupt") && !working(app);
    for (let attempt = 0; attempt < 2; attempt++) {
      // Reaching again may have started a fresh app (`fresh` killed this one): read it anew.
      if (attempt) await reachOrFresh(cell.state);
      const ctx = c!;
      const a = actionOf(ctx, cell.input)!;
      const before = snap(ctx);
      try {
        const bytes = bytesOf(a.action, a.encoding);
        if (raced(ctx.app)) {
          problems = [];
          if (!attempt) unchecked++;
          continue;
        }
        await apply(ctx.app, a.action, { encoding: a.encoding });
        problems = await check(ctx, cell, before, a.action, bytes);
        if (cell.state === "h.working") {
          // The spinner keeps the screen busy: on a loaded machine `press` stops waiting before the
          // key is drawn. Look again a few times.
          for (let n = 0; problems.length && working(ctx.app) && n < 3; n++) {
            await Bun.sleep(200 * SLOW);
            problems = await check(ctx, cell, before, a.action, bytes);
          }
          // The work ended while the input was answered (its proposal came): that says nothing either.
          if (problems.length && raced(ctx.app)) {
            problems = [];
            if (!attempt) unchecked++;
            continue;
          }
        }
      } catch (e) {
        problems = [`threw: ${(e as Error).message.split("\n")[0]}`];
      }
      if (attempt) unchecked--;
      break;
    }
    record(cell, problems.length ? [`${describeAction(first.action)}: ${problems[0]}`, ...problems.slice(1)] : []);
    return !problems.length && !destroys(cell);
  };

  await fresh();
  const last: Cell[] = [];
  for (const state of g.states) {
    const cells = cellsOf(state);
    last.push(...cells.filter(destroys));
    for (const cell of cells.filter((x) => !destroys(x))) {
      try {
        if (!cleanFor(c!, state)) await fresh();
        await reachOrFresh(state);
      } catch (e) {
        failures.push(`${state}: couldn't reach it: ${(e as Error).message.split("\n")[0]}\n${c!.app.screen().replace(/^/gm, "      | ")}`);
        await fresh();
        break;
      }
      if (!(await run(cell))) await fresh();
    }
  }
  let dead = false;
  for (const cell of last) {
    try {
      if (dead || !cleanFor(c!, cell.state) || (await c!.app.exitCode(10)) !== null) await fresh();
      await reachOrFresh(cell.state);
    } catch (e) {
      failures.push(`${cell.state}: couldn't reach it: ${(e as Error).message.split("\n")[0]}`);
      dead = true;
      continue;
    }
    await run(cell);
    dead = true;
  }
  (c as Ctx | null)?.app.kill();
  if (process.env.GLUON_MATRIX_TIMES) console.log(`${g.name}: ${ran} cells (${unchecked} unchecked), ${apps} apps, ${Math.round(performance.now() - t0)} ms`);
  expect(failures).toEqual([]);
  expect(passedKnown.map((k) => `${k} passes now: take it off KNOWN_FAILING`)).toEqual([]);
}

// `@full`: left out of `bun run regression` (none stays: cc's line alone took 20 s of an e2e run's wall); `regression:full` runs it.
for (const g of groups())
  test(`matrix (${FULL ? "full" : "smoke"}): ${g.name}${/^((codex|oc|agy|grok): |cc: (the line|overflow|three tabs|the alternate screen)|home: |home with a session: )/.test(g.name) ? " @full" : ""}`, () => runGroup(g));

test.skipIf(!!ONLY)("every smoke cell's state is in a group", () => {
  const grouped = new Set(groups().flatMap((g) => g.states));
  const smoke = [...table].flatMap(([s, row]) => ([...row.values()].some((c) => c && "tier" in c && c.tier === "smoke") ? [s] : []));
  expect(smoke.filter((s) => !grouped.has(s))).toEqual([]);
});
