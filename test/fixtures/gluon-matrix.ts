/**
 * Gluon's coverage matrix: every state a user can be in × everything a user (or their terminal)
 * can send, and what should happen. Data, not tests: the runners check its cells (`route` unit
 * tier, the e2e table, regression's smoke subset), `test/gluon-matrix.test.ts` checks it is whole.
 *
 * Cells come from ordered rules (`RULES`; a later rule overrides an earlier one), never one
 * literal per cell. A cell is an expectation and the cheapest tier that can check it (`unit`:
 * `route()` is pure; `e2e`: needs the real app; `smoke`: e2e, also in regression), a hand-written
 * test's id (`case`), or not applicable with the reason (`na`). The expectations restate the doc
 * comments of `route` (`src/pty/compositor.ts`) and the home view's keys (`src/ui/Home.tsx`).
 *
 * States are reached at `REF` size with the TUI fakes (`test/e2e/gluon-kit.ts`): `SESSION_STATES`
 * and `HOME_STATES` say how. Inputs are `test/e2e/actions.ts` actions (`inputAction`).
 */
import type { Harness } from "../../src/harnesses.ts";
import { layout, tabSpans, type TabSpans } from "../../src/pty/chrome.ts";
import { shiftMouse } from "../../src/pty/compositor.ts";
import type { ModesState } from "../../src/pty/modes.ts";
import type { Rect } from "../../src/pty/paint.ts";
import type { Key } from "../../src/pty/types.ts";
import { KEYS, REPLIES, type Action, type KeyName, type MouseEncodingName } from "../e2e/actions.ts";

/** The size every state is reached at (and inputs aimed at). */
export const REF = { cols: 100, rows: 30 } as const;

/** One fake per reader: Claude Code, Codex, OpenCode, Antigravity, Grok Build. */
export const HARNESS_IDS = ["cc", "codex", "oc", "agy", "grok"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export const HARNESS_OF_ID: Record<HarnessId, Harness> = { cc: "claude-code", codex: "codex", oc: "opencode", agy: "antigravity", grok: "grok-build" };
export const FAKE_OF_ID = { cc: "claude", codex: "codex", oc: "opencode", agy: "agy", grok: "grok" } as const;

/** A session's states, and how each is reached from a fresh launch of one session. */
export const SESSION_STATES = {
  idle: "launched, nothing typed: the line is untouched",
  typed: "`hello` typed, not sent: the line is touched",
  slashMenu: "`/` typed: the agent's slash menu open, its first item (/clear) highlighted",
  alt: "launched with FAKE_ALT=1: the agent on its alternate screen (no scrollback, no wheel capture)",
  mouse: "`!mouse` run: the agent tracks the mouse (SGR)",
  focus: "`!focus` run: the agent asked for focus reports",
  kitty: "`!kitty` run: the agent pushed the kitty keyboard flags",
  scrolled: "`!lines 60` run, then one wheel notch up: the frame scrolled back 3 rows",
  questionClear: "`/clear` typed and Enter: “/clear ends this session in Gluon — end it?” in the bottom bar",
  questionCompact: "`/compact` typed and Enter: “End this session instead of compacting?” in the bottom bar",
  working: "`!tick` run: the agent prints every 200 ms",
  firstTab: "three sessions, the first shown",
  midTab: "three sessions, the second shown",
  lastTab: "three sessions, the last shown",
  overflow: "five sessions at 60 columns, the third shown: the strip scrolled both ways (‹n and n›)",
  tooSmall: "resized to 19×5: only `too small` is drawn",
} as const;
export type SessionState = keyof typeof SESSION_STATES;

/** The home view's states. */
export const HOME_STATES = {
  "h.empty": "a fresh start: no sessions, the composer empty",
  "h.sessions": "one session launched and the home key: its row selected",
  "h.sessions.overflow": "more sessions than the list has rows (80×16, six sessions)",
  "h.question": "a task sent: the intake agent's question and its options open",
  "h.proposal": "the question answered: the agent choice (proposal) open, its spec shown",
  "h.spec": "the proposal with its spec folded (ctrl+o)",
  "h.keys": "one session, then `?`: the key list open",
  "h.endQ": "one session, Delete on its row: “End Gluon-…?” on the last row",
  "h.discardQ": "a chat drafted and Esc, Delete on its row: “Discard this chat?” on the last row",
  "h.quitQ": "one live session, Ctrl+C twice: “1 session running — quit and end it?” on the last row",
  "h.working": "a task sent: the intake agent working (esc to interrupt), its drafting row listed",
  "h.tooSmall": "resized to 19×5 at home: the composer alone",
} as const;
export type HomeState = keyof typeof HOME_STATES;

/** The setup menus (`pick`, `pickMany`, `askText` in `src/ui/signin.tsx`): separate Ink renders, before Gluon's frame or in `gluon connect`. */
export const MENU_STATES = {
  "m.pick": "a picker (onboarding's agent or connection choice)",
  "m.pickMany": "the checklist (onboarding's agents)",
  "m.askText": "a key prompt",
} as const;
export type MenuState = keyof typeof MENU_STATES;

export type StateId = HomeState | `s.${HarnessId}.${SessionState}` | MenuState;
export const STATES: StateId[] = [
  ...(Object.keys(HOME_STATES) as HomeState[]),
  ...HARNESS_IDS.flatMap((h) => (Object.keys(SESSION_STATES) as SessionState[]).map((s): StateId => `s.${h}.${s}`)),
  ...(Object.keys(MENU_STATES) as MenuState[]),
];

/** Pastes (bracketed, as Gluon keeps the real terminal's paste mode on). */
export const PASTES = { plain: "hello there", multiline: "one\ntwo\nthree", clear: "/clear", homeKey: "a\x1cb", esc: "a\x1b[Ab" } as const;
/** Resizes from `REF`: bigger, smaller, below the frame's minimum (20×6), and back to `REF`. */
export const RESIZES = { grow: { cols: 120, rows: 40 }, shrink: { cols: 60, rows: 20 }, tiny: { cols: 19, rows: 5 }, restore: REF } as const;
export const SIGNALS = ["TERM", "HUP", "INT"] as const;
/** Where a mouse input aims, on the session view's layout (`layout`, `tabSpans`). */
export const TARGETS = ["diamond", "tab", "prev", "next", "info", "border", "interior", "bar"] as const;
export const GESTURES = ["leftPress", "leftRelease", "leftDrag", "leftClick", "rightPress", "middlePress", "wheelUp", "wheelDown"] as const;
export const ENCODINGS = ["x10", "utf8", "sgr", "urxvt", "sgr-pixels"] as const satisfies readonly MouseEncodingName[];
export type Target = (typeof TARGETS)[number];
export type Gesture = (typeof GESTURES)[number];

export type InputId =
  | `k.${KeyName}`
  | `p.${keyof typeof PASTES}`
  | `m.${Target}.${Gesture}.${(typeof ENCODINGS)[number]}`
  | `r.${keyof typeof RESIZES}`
  | "f.in"
  | "f.out"
  | `sig.${(typeof SIGNALS)[number]}`
  | `reply.${keyof typeof REPLIES}`;

export const INPUTS: InputId[] = [
  ...(Object.keys(KEYS) as KeyName[]).map((k): InputId => `k.${k}`),
  ...(Object.keys(PASTES) as (keyof typeof PASTES)[]).map((p): InputId => `p.${p}`),
  ...TARGETS.flatMap((t) => GESTURES.flatMap((g) => ENCODINGS.map((e): InputId => `m.${t}.${g}.${e}`))),
  ...(Object.keys(RESIZES) as (keyof typeof RESIZES)[]).map((r): InputId => `r.${r}`),
  "f.in",
  "f.out",
  ...SIGNALS.map((s): InputId => `sig.${s}`),
  ...(Object.keys(REPLIES) as (keyof typeof REPLIES)[]).map((r): InputId => `reply.${r}`),
];

/** What the home view does with a key (`src/ui/Home.tsx`). */
export type HomeAction =
  | "type"
  | "nothing"
  | "newline"
  | "list"
  | "open"
  | "firstTab"
  | "markDone"
  | "end"
  | "discard"
  | "keys"
  | "closeKeys"
  | "scrollKeys"
  | "scrollChat"
  | "scrollSpec"
  | "options"
  | "pick"
  | "closeOptions"
  | "cycleModel"
  | "cycleEffort"
  | "cycleMode"
  | "foldSpec"
  | "quitArm"
  | "interrupt";

/**
 * What should happen. `toAgent`: the agent gets bytes — `same` the input's own, `shifted` a mouse
 * report moved into the frame's interior (`shiftMouse`; a report it drops goes nowhere), else
 * exactly these. Leaving scroll mode first (scrolled back) is implied. `switch`: the next (1) or
 * previous (-1) on the ring of tabs, home included (`neighbour`); `prefix`: the home key waits
 * for the key that picks (←/→ switch, the home key again goes home, Esc cancels; `route`);
 * `show`: a clicked tab's session;
 * `scroll`: rows back (`page`: the interior's rows − 1); `answer`: the question up takes it;
 * `asks`: Gluon holds the key and asks this; `resized`: every PTY and the view take the new size;
 * `exit`: Gluon ends every agent and exits with this code.
 */
export type Expect =
  | { toAgent: string | "same" | "shifted" }
  | { dropped: true }
  | { home: true }
  | { prefix: true }
  | { switch: 1 | -1 }
  | { show: "tab" | "hidden" }
  | { scroll: number | "page" | "-page" }
  | { unscroll: true }
  | { answer: true }
  | { asks: string }
  | { homeAction: HomeAction }
  | { resized: true }
  | { exit: number };

export type Tier = "unit" | "e2e" | "smoke";
export type Cell = { expect: Expect; tier: Tier } | { case: string } | { na: string };

/** A state or input selector: ids, globs (`*` any run of characters), or a predicate. */
export type Sel = string | readonly string[] | ((id: string) => boolean);
/** A rule's cell, or a change of tier for the expectation already there. */
export type Rule = { states: Sel; inputs: Sel; cell: Cell | { tier: Tier } };

const RULES: Rule[] = [];
const rule = (states: Sel, inputs: Sel, cell: Cell) => void RULES.push({ states, inputs, cell });
/** The expectation already resolved there, checked in another tier. */
const tier = (states: Sel, inputs: Sel, t: Tier) => void RULES.push({ states, inputs, cell: { tier: t } });
const unit = (expect: Expect): Cell => ({ expect, tier: "unit" });
const e2e = (expect: Expect): Cell => ({ expect, tier: "e2e" });
const homeDoes = (a: HomeAction): Cell => e2e({ homeAction: a });

/** Session states `s.<harness>.<state>` for these states, every harness. */
const ss = (...states: SessionState[]) => (id: string) => id.startsWith("s.") && (states as string[]).includes(id.split(".")[2]!);
/** Every input of these kinds of key. */
const k = (...names: KeyName[]) => names.map((n) => `k.${n}`);

const S = "s.*";
const H = "h.*";
/** The line is untouched (nothing but Enter since the last Enter): plain ←/→ are Gluon's, Alt+←/→ dropped. */
const UNTOUCHED: SessionState[] = ["idle", "alt", "mouse", "focus", "kitty", "scrolled", "working", "firstTab", "midTab", "lastTab", "overflow", "tooSmall"];
/** One session open: it is the first tab and the last. */
const SINGLE: SessionState[] = ["idle", "typed", "slashMenu", "alt", "mouse", "focus", "kitty", "scrolled", "questionClear", "questionCompact", "working", "tooSmall"];
const QUESTIONS: SessionState[] = ["questionClear", "questionCompact"];
const HOME_KEY = k("ctrlBackslash", "kittyCtrlBackslash");
const LEFT = k("left", "ssLeft", "kittyLeft");
const RIGHT = k("right", "kittyRight");
const ENTER = k("enter", "kittyEnter");
/** What says no to a question: Esc, Ctrl+C (`isCtrlC`). */
const NO = k("esc", "kittyEsc", "ctrlC", "kittyCtrlC");
const PRINTABLE = k("a", "x", "space", "slash", "q", "y", "n", "question", "percent", "digit1", "digit2", "digit9", "digit0", "eAcute", "wide");
const UP_DOWN = k("up", "down", "ssUp");
const PAGE = k("pgup", "pgdn", "shiftPgup", "shiftPgdn", "ctrlPgup", "altPgup", "altPgdn");
const NEWLINE = k("ctrlJ", "altEnter", "shiftEnter");
const KITTY = (id: string) => id.startsWith("k.kitty");
/** A mouse input's gesture, target or encoding. */
const mouse = (target: string, gesture: string, enc = "*") => `m.${target}.${gesture}.${enc}`;
const LEFT_HIT = ["leftPress", "leftClick", "leftDrag"].map((g) => mouse("*", g));

// ── Every session state: the agent gets what it isn't Gluon's ──────────────────────────────────
rule(S, "k.*", unit({ toAgent: "same" }));
// The fakes turn bracketed paste on: the paste goes on with its markers (BUG-172 strips them for an agent that hasn't).
rule(S, "p.*", unit({ toAgent: "same" }));
rule(S, "f.*", unit({ dropped: true }));
rule(ss("focus"), "f.*", unit({ toAgent: "same" }));
rule(S, "reply.*", unit({ dropped: true }));
rule(S, "r.*", e2e({ resized: true }));
rule(S, "sig.TERM", e2e({ exit: 143 }));
rule(S, "sig.HUP", e2e({ exit: 129 }));
rule(S, "sig.INT", e2e({ exit: 130 }));

// ── A question up: Enter yes, Esc / Ctrl+C no, other keys and pastes dropped ───────────────────
rule(ss(...QUESTIONS), "k.*", unit({ dropped: true }));
rule(ss(...QUESTIONS), "p.*", unit({ dropped: true }));
rule(ss(...QUESTIONS), [...ENTER, ...NO], unit({ answer: true }));

// ── Gluon's keys, in every state, a question up included ───────────────────────────────────────
// The home key is the prefix of the keys that switch or go home (issue #47); Alt+PgUp/PgDn are the agent's (issue #47).
rule(S, HOME_KEY, unit({ prefix: true }));
rule(S, "k.shiftPgup", unit({ scroll: "page" }));
rule(ss("alt"), "k.shiftPgup", unit({ toAgent: "same" }));
rule(ss("scrolled"), "k.shiftPgdn", unit({ scroll: "-page" }));
rule(ss("scrolled"), k("esc", "kittyEsc", "q"), unit({ unscroll: true }));

// ── Plain ←/→ on an untouched line: the tabs, wrapping through home (BUG-195, BUG-206); Alt+←/→ there: dropped ──
rule(ss(...UNTOUCHED), LEFT, unit({ switch: -1 }));
rule(ss(...UNTOUCHED), RIGHT, unit({ switch: 1 }));
rule(ss(...UNTOUCHED), k("altLeft", "altRight"), unit({ dropped: true }));

// ── The mouse ──────────────────────────────────────────────────────────────────────────────────
rule(S, "m.*", unit({ dropped: true }));
// Gluon captures the wheel for the frame's scrollback when the agent tracks no mouse.
rule(S, mouse("*", "wheelUp"), unit({ scroll: 3 }));
rule(ss("scrolled"), mouse("*", "wheelDown"), unit({ scroll: -3 }));
// An agent that tracks the mouse gets it, moved into its screen (a release or drag held at the edge).
rule(ss("mouse"), "m.*", unit({ toAgent: "shifted" }));
// The tab strip's left press is Gluon's whatever the agent asked; the rest of that click goes nowhere.
rule(S, LEFT_HIT.map((g) => g.replace("*", "diamond")), unit({ home: true }));
rule(ss("firstTab", "midTab", "lastTab", "overflow"), LEFT_HIT.map((g) => g.replace("*", "tab")), unit({ show: "tab" }));
rule(ss(...SINGLE), LEFT_HIT.map((g) => g.replace("*", "tab")), unit({ dropped: true }));
rule(ss("overflow"), [...LEFT_HIT.map((g) => g.replace("*", "prev")), ...LEFT_HIT.map((g) => g.replace("*", "next"))], unit({ show: "hidden" }));
rule((id) => id.startsWith("s.") && !id.endsWith(".overflow"), [mouse("prev", "*"), mouse("next", "*")], { na: "no tab is hidden: the strip draws no ‹ ›" });
rule(S, mouse("*", "*", "sgr-pixels"), { na: "the terminal reports pixels only while an agent asked for them (1016); no state's agent does" });
rule(ss("alt"), "m.*", { na: "the real terminal tracks no mouse here: the agent asked for none and Gluon leaves the wheel to an alternate-screen agent (BUG-175)" });
rule(ss("tooSmall"), "m.*", { na: "below 20×6 only `too small` is drawn: no strip, frame or interior to aim at" });

// ── Kitty keys: the real terminal sends them only to an agent that pushed the flags ───────────
// Elsewhere they can't come from a terminal, but `route` reads them all the same: unit only.
tier((id) => id.startsWith("s.") && !id.endsWith(".kitty"), KITTY, "unit");

// ── The slash menu: an Enter on its /clear is held and asked about (the interceptor) ──────────
rule(ss("slashMenu"), "k.enter", e2e({ asks: "/clear ends this session in Gluon — end it?" }));
// OpenCode's Tab runs the highlighted item (`TAB_RUNS`).
rule("s.oc.slashMenu", "k.tab", e2e({ asks: "/clear ends this session in Gluon — end it?" }));
rule(ss("slashMenu"), "k.kittyEnter", { na: "the terminal sends a kitty Enter only to an agent that pushed the flags (s.*.kitty), which has no menu open" });

// ── States that can't be reached ───────────────────────────────────────────────────────────────
rule("s.agy.questionCompact", "*", { na: "Antigravity has no /compact to hold (`COMMANDS` in src/pty/readers/index.ts)" });

// ── The home view: Ink's composer, the list, the chat (`Home.tsx`) ─────────────────────────────
const SESSIONS = ["h.sessions", "h.sessions.overflow", "h.keys", "h.endQ", "h.quitQ"];
const OPTIONS = ["h.question", "h.proposal", "h.spec"];
const BLANK_NO_OPTIONS = ["h.empty", "h.sessions", "h.sessions.overflow", "h.keys", "h.working", "h.tooSmall"];
const OVERLAY = ["h.endQ", "h.discardQ", "h.quitQ"];
rule(H, "k.*", homeDoes("nothing"));
// The key list: any key closes it and does what it does (`Home.tsx`; Codex's overlay); the rules below say what.
rule("h.keys", "k.*", homeDoes("closeKeys"));
rule(H, PRINTABLE, homeDoes("type"));
rule(H, NEWLINE, homeDoes("newline"));
rule(H, PAGE, homeDoes("scrollChat"));
rule(H, k("ctrlC"), homeDoes("quitArm"));
rule(H, "p.*", homeDoes("type"));
rule(H, "f.*", e2e({ dropped: true }));
rule(H, "reply.*", e2e({ dropped: true }));
rule(H, "r.*", e2e({ resized: true }));
rule(H, "sig.TERM", e2e({ exit: 143 }));
rule(H, "sig.HUP", e2e({ exit: 129 }));
rule(H, "sig.INT", e2e({ exit: 130 }));
// The mouse (BUG-269): SGR reports while Gluon captures it. A click on the list selects or opens
// (BUG-269/GLUON-52, GLUON-54); the info, border and bar targets are, at home, the header, blank
// rows and the last row: nothing happens, nothing is typed (BUG-238). The wheel scrolls what
// PgUp / PgDn scroll. The strip's targets (◆, a tab, ‹ ›) don't exist at home: `na` below.
rule(H, "m.*", e2e({ dropped: true }));
rule(H, [mouse("*", "wheelUp"), mouse("*", "wheelDown")], homeDoes("scrollChat"));
rule(H, mouse("*", "*", "sgr-pixels"), { na: "the home view asks for SGR cell reports (1006), never pixels (1016)" });
// At 80×16 the list starts higher: the interior target is on its first line.
rule("h.sessions.overflow", mouse("interior", "*"), { case: "BUG-269/GLUON-52" });
rule("h.sessions.overflow", [mouse("interior", "wheelUp"), mouse("interior", "wheelDown")], homeDoes("scrollChat"));
rule(BLANK_NO_OPTIONS, "k.question", homeDoes("keys"));
rule(["h.working", ...SESSIONS], UP_DOWN, homeDoes("list"));
rule(SESSIONS, ENTER, homeDoes("open"));
// Ink reads Shift/Alt/Ctrl+→ as → too: in an empty composer there is nothing to move over, so they open the first tab as → does.
rule(SESSIONS, k("right", "shiftRight", "altRight", "ctrlRight"), homeDoes("firstTab"));
rule(SESSIONS, "k.ctrlD", homeDoes("markDone"));
rule(SESSIONS, "k.delete", homeDoes("end"));
rule(["h.working"], "k.delete", homeDoes("discard"));
rule(["h.working"], NO, homeDoes("interrupt"));
rule(OPTIONS, UP_DOWN, homeDoes("options"));
rule(OPTIONS, ENTER, homeDoes("pick"));
rule(OPTIONS, "k.esc", homeDoes("closeOptions"));
// Tab on a question's option puts its text in the composer, to add your own words (home.test.tsx `issue-55/tab`).
rule("h.question", "k.tab", { case: "issue-55/tab" });
rule(["h.proposal", "h.spec"], "k.tab", homeDoes("cycleModel"));
rule(["h.proposal", "h.spec"], "k.shiftTab", homeDoes("cycleEffort"));
rule(["h.proposal", "h.spec"], "k.ctrlT", homeDoes("cycleMode"));
rule(["h.proposal", "h.spec"], "k.ctrlO", homeDoes("foldSpec"));
rule(["h.proposal", "h.spec"], PAGE, homeDoes("scrollSpec"));
rule("h.keys", k("esc", "question"), homeDoes("closeKeys"));
rule("h.keys", PAGE, homeDoes("scrollKeys"));
// A question on the last row: Enter yes, Esc / Ctrl+C no, nothing else (BUG-213).
rule(OVERLAY, "k.*", e2e({ dropped: true }));
rule(OVERLAY, "p.*", e2e({ dropped: true }));
rule(OVERLAY, [...ENTER, ...NO], e2e({ answer: true }));
rule(OVERLAY, (id) => id.startsWith("m.") && !id.endsWith(".sgr-pixels"), e2e({ dropped: true }));
rule(H, ["diamond", "tab", "prev", "next"].map((t) => mouse(t, "*")), { na: "the home view draws no tab strip: ◆ gluon, the tabs and ‹ › are a session's chrome (`layout` in src/pty/chrome.ts), nothing to aim at here" });
rule(H, KITTY, { na: "the home view has the kitty keyboard flags off (`HOME_MODES`): the terminal sends legacy keys there" });

// ── Setup menus: their own keys, covered where they live (test/e2e/auth.e2e.test.ts) ──────────
rule("m.*", "*", { na: "a setup menu (`pick`, `pickMany`, `askText`) runs before Gluon's frame or in `gluon connect`: no sessions, no frame, no mouse; only its own keys apply" });
rule(["m.pick", "m.pickMany"], k("digit1", "digit2"), { case: "BUG-50/4.2" });
rule("m.pick", ENTER, { case: "BUG-50/2.9" });
rule("m.pick", "k.ctrlC", { case: "BUG-57/2.10" });
rule("m.askText", "k.ctrlC", { case: "BUG-57/2.10" });
rule(["m.pick", "m.pickMany"], ["reply.osc11", "reply.osc11Light"], { case: "BUG-49/I1" });
rule("m.askText", ["reply.osc11", "reply.osc11Light"], { case: "BUG-54/3.2" });
rule(["m.pick", "m.pickMany"], "k.esc", { case: "BUG-63/3.1" });
rule(["m.pick", "m.pickMany"], ["r.shrink", "r.tiny"], { case: "BUG-58/4.4" });

// ── Hand-written cases, where a cell's story is longer than one expectation ─────────────────────
rule("s.cc.questionClear", ["k.esc", "k.enter"], { case: "GLUON-5" });
rule("s.codex.slashMenu", "k.enter", { case: "BUG-191" });
rule("s.cc.working", "k.ctrlBackslash", { case: "GLUON-3" });
rule("s.cc.lastTab", "k.left", { case: "GLUON-9" });
rule("s.cc.idle", "m.interior.wheelUp.sgr", { case: "GLUON-11" });
rule("s.cc.scrolled", "k.esc", { case: "GLUON-11" });
rule("s.cc.idle", "sig.TERM", { case: "GLUON-14" });
rule("s.cc.overflow", ["m.diamond.leftPress.sgr", "m.tab.leftPress.sgr"], { case: "BUG-196/GLUON" });
rule("s.cc.typed", ["k.altLeft", "k.altRight"], { case: "BUG-210/GLUON" });
rule("s.cc.questionClear", "k.y", { case: "BUG-213/question" });
rule("h.empty", "k.ctrlC", { case: "GLUON-15" });
rule("h.sessions", "k.ctrlC", { case: "GLUON-13" });
rule("h.quitQ", ["k.esc", "k.enter", "k.y"], { case: "GLUON-13" });
rule("h.endQ", ["k.esc", "k.enter", "k.y", "k.n"], { case: "BUG-164/GLUON-yes" });
rule("h.sessions", "k.ctrlD", { case: "BUG-193/GLUON" });
rule("h.discardQ", "k.enter", { case: "BUG-193/GLUON" });
rule("h.sessions", "k.right", { case: "BUG-231/E" });
rule("s.codex.midTab", ["k.altLeft", "k.altRight", "k.left", "k.right", "m.tab.leftClick.sgr", "m.diamond.leftClick.sgr"], { case: "GLUON-22" });
rule("s.cc.scrolled", ["k.shiftPgup", "k.shiftPgdn", "k.q", "m.interior.wheelDown.sgr"], { case: "GLUON-25" });
rule("s.cc.mouse", ["m.bar.leftClick.sgr", "m.info.leftClick.sgr", "m.border.leftClick.sgr"], { case: "BUG-240/GLUON-27" });
rule("h.sessions", ["r.shrink", "r.restore"], { case: "GLUON-29" });
rule(["s.codex.idle", "s.codex.lastTab"], "k.right", { case: "GLUON-31" });
rule("h.empty", "k.shiftEnter", { case: "BUG-237/GLUON-35" });
rule("h.sessions", ["f.in", "f.out"], { case: "BUG-238/GLUON-38" });

// ── Regression's smoke subset: each state once, each kind of input once ───────────────────────
// Each state once in the real app (GLUON_FULL); regression (its budget: a session takes seconds
// to open) the states one or three sessions reach: every home state but the overflowing list,
// every Claude Code state but the overflowing strip, Codex's and OpenCode's one-session states
// (Antigravity's and Grok Build's: the QA-frame intercept tests, test/e2e/gluon-qa-frame.e2e.test.ts).
tier("*", "k.x", "e2e");
const ONE_SESSION = (id: string) => /^s\.(codex|oc)\./.test(id) && !["alt", "firstTab", "midTab", "lastTab", "overflow"].includes(id.split(".")[2]!);
tier((id) => (id.startsWith("h.") && id !== "h.sessions.overflow") || (id.startsWith("s.cc.") && id !== "s.cc.overflow") || ONE_SESSION(id), "k.x", "smoke");
tier("s.cc.idle", ["k.left", "k.enter", "p.plain", "m.diamond.leftClick.sgr", "r.shrink", "f.in", "reply.da1", "k.ctrlBackslash"], "smoke");
// The prefix where the bar is the question's, in scroll mode and with a typed line; Alt+←/→ dropped on an untouched line.
tier(["s.cc.typed", "s.cc.scrolled", "s.cc.questionClear"], "k.ctrlBackslash", "e2e");
tier("s.cc.idle", k("altLeft", "altRight"), "e2e");
// A signal ends the app: on the last state Claude Code's regression run reaches.
tier("s.cc.working", "sig.HUP", "smoke");
tier("h.sessions", ["k.pgdn", "p.multiline", "r.tiny", "reply.osc11", "m.interior.leftClick.sgr", "m.interior.wheelUp.sgr"], "smoke");
tier("s.oc.slashMenu", "k.tab", "smoke");
tier("s.agy.slashMenu", "k.enter", "smoke");
tier("s.cc.mouse", "m.interior.leftClick.sgr", "smoke");

/** Hand-written cases about what the agent does (its output, events, exit), which the grid has no input for. */
export const BEYOND: Record<string, string> = {
  "GLUON-1": "a launch opens the frame: tab strip, info line, the triple in the border",
  "GLUON-2": "the agent's emoji and CJK keep the border in place",
  "GLUON-4": "the agent's own queries are answered by its screen model",
  "GLUON-6": "an agent that exits closes its session",
  "GLUON-7": "the agent's `back` event shows home",
  "GLUON-8": "a status event shows in the info line and the counts",
  "GLUON-16": "the harness's cost and context figures",
  "GLUON-17": "Claude Code's OpenTelemetry export",
  "GLUON-19": "on_exit: quit exits with the agent's code",
  "GM-home-selection": "the monkey's find: back home, even in the home key's burst, the list's keys act on the session left's row (BUG-236)",
  "GLUON-37": "keys in the same burst as the → / Enter that opens a session reach its agent (BUG-235)",
  "GLUON-33": "on the only tab the bottom bar names no switch key (REPORT #7; BUG-241)",
  "GLUON-34": "the home view's end question names its row and keys; y and n don't answer (REPORT #8)",
  "GLUON-36": "an agent's redraw a while after a resize doesn't make it Working (REPORT #1; BUG-242)",
  "GLUON-39": "each view change is one synchronized update: the clear and the whole new view, no erase outside it (QA NF-2; BUG-243)",
  "GLUON-40": "Claude Code's first-run trust question reads as awaiting the user, not Working (BUG-244)",
  "GLUON-41": "a home question is answered only by keys pressed once it shows, not an Enter in the same read as Delete (BUG-259)",
  "GLUON-42": "at home, Esc and a key in a later read within the decoder's wait are Esc and that key, not Alt+key (BUG-260)",
  "GLUON-43": "the home question and its hint come and go in one synchronized update; the last row never outside one (BUG-261)",
  "GLUON-44": "an agent that exits while its End question is up at home closes the question with its row (BUG-262)",
  "GLUON-45": "back home from a session in a folded group, the group opens and its row is selected (BUG-263)",
  "GLUON-46": "a narrow question bar keeps what the question is about; its keys shrink, then go (QA R2-6; BUG-264)",
  "GLUON-47": "a cut activity takes the free columns beside it in the list (QA R2-7; BUG-265)",
  "GLUON-48": "the home composer wraps at words; cursor and height exact (QA R2-8; BUG-266)",
  "GLUON-49": "a wrapped option never ends a line in its `·` or `×` (QA R2-9; BUG-267)",
  "GLUON-50": "printables and as many Backspaces leave the line untouched again: ←/→ switch, the bar names them; any other key keeps it the agent's until Enter (BUG-268)",
  "GLUON-51": "at home the terminal reports SGR clicks (none without mouse_capture); they reach the home view, never its input; none while a question is up; the rest of a click that opened a session never reaches its agent (BUG-269)",
  "GLUON-53": "a held /clear or /new asks “<command> ends this session in Gluon — end it?”; shorter forms keep the command, then what a yes does (BUG-270)",
  "GLUON-54": "in the real app a click on a home row selects it, a second opens it; nothing typed, nothing reaches the agent (BUG-269)",
  "GLUON-55": "a click never scrolls a windowed home list; a double-click opens the row under it; a selection leaving the window scrolls it just enough (QA R3-1; BUG-271)",
  "GLUON-56": "a double-click on the selected home row opens it once; its second click never reaches the agent (QA R3-4; BUG-272)",
  "GLUON-57": "keys in the same read as the agent choice's Enter reach the session it starts; a home key among them goes home (QA R3-2; BUG-273)",
  "GLUON-58": "a double-click on a group label folds or unfolds it once (QA R3-3; BUG-274)",
  "GLUON-59": "without mouse_capture the `?` key list names no click or wheel, at home or in a session (QA R3-5; BUG-275)",
  "GLUON-60": "a cut text ends in no dash, separator or blank before its `…`; the key list's closing line names the wheel (QA R3-7; BUG-276)",
  "GLUON-61": "a drag over the home view's text selects it and the release copies it (OSC 52); a click without a drag is still the home view's; a key, a press or changed text ends the selection (BUG-286, #62)",
};

/** The `?` key list's labels (`keyGroups` in src/ui/layout.ts) and the inputs that are those keys. */
export const KEY_GROUP_INPUTS: Record<string, InputId[]> = {
  "↑↓": ["k.up", "k.down"],
  enter: ["k.enter"],
  "→": ["k.right"],
  "ctrl+d": ["k.ctrlD"],
  del: ["k.delete"],
  "ctrl+c twice": ["k.ctrlC"],
  "ctrl+\\": ["k.ctrlBackslash"],
  // The pick after the prefix isn't a matrix input (no state has the prefix pending): `route`'s unit tests cover `z` (BUG-284).
  "ctrl+\\ z": ["k.ctrlBackslash"],
  "←/→": ["k.left", "k.right"],
  click: ["m.tab.leftClick.sgr", "m.diamond.leftClick.sgr", "m.prev.leftClick.sgr", "m.next.leftClick.sgr"],
  "shift+pgup": ["k.shiftPgup", "m.interior.wheelUp.sgr"],
  "↑↓ 1–9": ["k.up", "k.down", "k.digit1", "k.digit9"],
  tab: ["k.tab"],
  "shift+tab": ["k.shiftTab"],
  "pgup pgdn": ["k.pgup", "k.pgdn"],
  "ctrl+t": ["k.ctrlT"],
  "ctrl+o": ["k.ctrlO"],
  esc: ["k.esc"],
  "esc esc": ["k.esc"],
  "ctrl+j": ["k.ctrlJ"],
  drag: ["m.interior.leftDrag.sgr"],
};

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
const matcher = (sel: Sel): ((id: string) => boolean) => {
  if (typeof sel === "function") return sel;
  const res = (typeof sel === "string" ? [sel] : sel).map(glob);
  return (id) => res.some((r) => r.test(id));
};

/** Every state × input cell (`undefined`: no rule covers it), the rules applied in order. */
export function resolve(rules: readonly Rule[] = RULES): Map<StateId, Map<InputId, Cell | undefined>> {
  const table = new Map<StateId, Map<InputId, Cell | undefined>>(STATES.map((s) => [s, new Map(INPUTS.map((i) => [i, undefined]))]));
  for (const r of rules) {
    const states = STATES.filter(matcher(r.states));
    const inputs = INPUTS.filter(matcher(r.inputs));
    for (const s of states) {
      const row = table.get(s)!;
      for (const i of inputs) {
        const cur = row.get(i);
        if (!("tier" in r.cell) || "expect" in r.cell) row.set(i, r.cell as Cell);
        else if (cur && "expect" in cur) row.set(i, { expect: cur.expect, tier: r.cell.tier });
      }
    }
  }
  return table;
}

/** The rules, for the meta-test (a selector that matches nothing is a typo). */
export const rules = (): readonly Rule[] => RULES;
export const matches = (sel: Sel, ids: readonly string[]) => ids.filter(matcher(sel));

/** A session state's tabs: how many sessions are open and which one (1-based) is shown. */
export function sessionTabs(state: SessionState): { n: number; current: number } {
  const multi: Partial<Record<SessionState, [number, number]>> = { firstTab: [3, 1], midTab: [3, 2], lastTab: [3, 3], overflow: [5, 3] };
  const [n, current] = multi[state] ?? [1, 1];
  return { n, current };
}

/**
 * A state's screen as its inputs are aimed at it (`inputAction`'s `at`): its size and the tab strip
 * drawn (the sessions named as `openSessions` names them). The home view draws no strip: ◆, the
 * tabs and ‹ › are a session's chrome; nor does a terminal below 20×6. Null for a setup menu.
 */
export function screenOf(state: StateId): { cols: number; rows: number; strip: TabSpans | null; current?: number } | null {
  if (state.startsWith("m.")) return null;
  if (state.startsWith("h.")) return { ...(state === "h.tooSmall" ? RESIZES.tiny : state === "h.sessions.overflow" ? { cols: 80, rows: 16 } : REF), strip: null };
  const s = state.split(".")[2] as SessionState;
  const { n, current } = sessionTabs(s);
  const cols = s === "overflow" ? 60 : s === "tooSmall" ? RESIZES.tiny.cols : REF.cols;
  const rows = s === "tooSmall" ? RESIZES.tiny.rows : REF.rows;
  const sessions = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: n === 1 ? "Gluon-task" : `Gluon-session-${i + 1}`, state: "awaiting" as const }));
  return { cols, rows, current, strip: layout(cols, rows).small ? null : tabSpans(sessions, current, cols) };
}

/** The 1-based cell a mouse input aims at on the session view (`layout`, the strip's `tabSpans`); null when there is none. */
export function targetCell(target: Target, cols: number, rows: number, strip: TabSpans | null, current?: number): { x: number; y: number } | null {
  const lay = layout(cols, rows);
  const mid = (a: number, b: number) => Math.floor((a + b - 1) / 2) + 1;
  switch (target) {
    case "diamond":
      return strip ? { x: strip.home[0] + 2, y: lay.tabRow + 1 } : null;
    case "tab": {
      const t = strip?.tabs.find((t) => t.id !== current) ?? strip?.tabs[0];
      return t ? { x: mid(t.x0, t.x1), y: lay.tabRow + 1 } : null;
    }
    case "prev":
      return strip?.prev ? { x: strip.prev.x0 + 1, y: lay.tabRow + 1 } : null;
    case "next":
      return strip?.next ? { x: strip.next.x1, y: lay.tabRow + 1 } : null;
    case "info":
      return { x: Math.floor(cols / 2), y: lay.infoRow + 1 };
    case "border":
      return { x: 1, y: lay.frame.top + 2 };
    case "interior":
      return { x: lay.interior.left + 10, y: lay.interior.top + 3 };
    case "bar":
      return { x: Math.floor(cols / 2), y: lay.barRow + 1 };
  }
}

/** A mouse gesture at a cell as an action (a drag moves two cells right). */
export function gestureAction(g: Gesture, at: { x: number; y: number }): Action {
  const button = g.startsWith("right") ? "right" : g.startsWith("middle") ? "middle" : g === "wheelUp" ? "up" : g === "wheelDown" ? "down" : "left";
  const op = g === "leftRelease" ? "release" : g === "leftDrag" ? "drag" : g === "leftClick" ? "click" : g.startsWith("wheel") ? "wheel" : "press";
  return { mouse: { op, button, ...at, ...(op === "drag" ? { to: { x: at.x + 2, y: at.y } } : {}) } };
}

/**
 * An input as an action (a mouse input aimed with `targetCell` at `size`; its encoding is the
 * id's last part, for `apply`'s `encoding`). Null for a mouse input with no target there.
 */
export function inputAction(id: InputId, at: { cols: number; rows: number; strip: TabSpans | null; current?: number } = { ...REF, strip: null }): { action: Action; encoding?: MouseEncodingName } | null {
  const [kind, a, b, c] = id.split(".") as [string, string, string?, string?];
  switch (kind) {
    case "k":
      return { action: { key: a as KeyName } };
    case "p":
      return { action: { paste: PASTES[a as keyof typeof PASTES] } };
    case "r":
      return { action: { resize: { ...RESIZES[a as keyof typeof RESIZES] } } };
    case "f":
      return { action: { focus: a as "in" | "out" } };
    case "sig":
      return { action: { signal: `SIG${a}` as "SIGTERM" } };
    case "reply":
      return { action: { reply: a as keyof typeof REPLIES } };
  }
  const cell = targetCell(a as Target, at.cols, at.rows, at.strip, at.current);
  // `sgr-pixels` splits on the dot: `m.<target>.<gesture>.sgr-pixels`.
  return cell ? { action: gestureAction(b as Gesture, cell), encoding: c as MouseEncodingName } : null;
}

/**
 * What `shifted` means for these keys: each mouse report moved into `interior` in `encoding`
 * (`shiftMouse`; null: dropped), past the interior a release or a drag held at its edge only after
 * a press the agent got (`pressed`: one before these keys; BUG-240); other keys as they are.
 */
export function shiftedReports(keys: readonly Key[], interior: Rect, encoding: ModesState["mouseEncoding"], pressed = false): string {
  let down = pressed;
  return keys
    .map((k) => {
      const m = k.mouse;
      if (!m) return k.raw;
      const bytes = shiftMouse(m, interior, encoding, down) ?? "";
      if (m.release) down = false;
      else if (bytes && !m.motion && !m.wheel) down = true;
      return bytes;
    })
    .join("");
}
