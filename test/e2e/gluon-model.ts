/**
 * A model of Gluon for the monkey test (`gluon-monkey.e2e.test.ts`): what a user's action should
 * do, as a pure function of the state, written from the spec and never from the code that
 * implements it — the doc comment on `route()` (`src/pty/compositor.ts`), the home view's keys
 * (`src/ui/Home.tsx`), the interceptor's rules (`src/pty/intercept.ts`), `src/pty/AGENTS.md` and
 * the CHANGELOG's BUG entries. Nothing here imports the router, the compositor or the interceptor:
 * only the strip's geometry (`tabSpans`, `layout`), which says where a click lands, not what it does.
 *
 * It also models the fake agents' TUI (`test/fixtures/fake-tui.ts`) as far as it matters: their
 * input line and slash menu (an Enter on a typed `/clear` asks), their `!` commands (mouse, focus,
 * kitty, lines) and their Ctrl+C count (two in a row exit, which the model never lets happen).
 *
 * `step` answers `{ unsupported }` where the spec leaves the outcome open or the model doesn't
 * know it (an unknown scrollback, a selection the list moved, a key that would quit, the fake's
 * menu running another command): the monkey never takes such a step, and a shrunk replay that
 * would is not tried. Restrict, don't guess.
 */
import { layout, tabSpans, type TabSpans } from "../../src/pty/chrome.ts";
import { KEYS, type Action, type KeyName } from "./actions.ts";
import type { FakeAgent } from "./fixtures.ts";

/** Rows a wheel notch scrolls the frame. */
export const WHEEL_ROWS = 3;
/** Rows of scrollback a session keeps at most. */
export const SCROLLBACK_MAX = 5000;
/** The question a typed `/clear` asks (`handoff.on_clear: ask`; BUG-270). */
export const END_Q = "/clear ends this session in Gluon — end it?";
/** The bar's last row asking it, in any of its forms (narrower: `End this session?`, `End session?`). */
export const END_Q_BAR = /^ \? (\/\S+ ends this session|End (this )?session\?)/;

/** The `handoff.key` values the model knows, and the key each is. */
export const HOME_KEYS = { "ctrl+\\": "ctrlBackslash", "ctrl+]": "ctrlBracket" } as const satisfies Record<string, KeyName>;
export type HomeKey = keyof typeof HOME_KEYS;

/** What an agent asked of the terminal. */
export interface Modes {
  mouse: boolean;
  focus: boolean;
  kitty: boolean;
  alt: boolean;
  bracketed: boolean;
}

/** The interceptor's view of a line: the keys since the last Enter (the rules atop `src/pty/intercept.ts`). */
export interface Typed {
  /** The first printable key was a typed `/`. */
  started: boolean;
  /** A paste went into the line: it never asks. */
  pasted: boolean;
  /** Nothing typed yet (or erased back to nothing before it started). */
  empty: boolean;
}

export interface Tab {
  /** Launch order, from 0: also its place in `App.inputLogs()`. */
  id: number;
  fake: FakeAgent;
  name: string;
  /**
   * The typed line since the last Enter, from the user's keys: 0 untouched (plain ←/→ are Gluon's),
   * n printables not backspaced, Infinity once any other key went to it (BUG-268).
   */
  touched: number;
  /** `END_Q` pending on it: the held Enter's bytes. */
  question: string | null;
  /** Focus reports sent during the question: queued behind the held Enter (sent on a no, dropped on a yes). */
  queued: string;
  /** The fake's input line. */
  line: string;
  /** The fake's cursor: how many characters (code points) of its line are after it (←/→ move it). */
  back: number;
  typed: Typed;
  /** Ctrl+C the fake read in a row (a second one exits it). */
  ctrlC: number;
  modes: Modes;
  /** Rows of scrollback there certainly are. */
  sbLow: number;
  /** Whether the scrollback is known (none on the alternate screen; some after `!lines`). */
  sbKnown: boolean;
}

export type View = "home" | { session: number };

export interface ModelState {
  cols: number;
  rows: number;
  homeKey: HomeKey;
  /** `handoff.mouse_capture`. */
  capture: boolean;
  view: View;
  tabs: Tab[];
  /** Everything each agent read, by launch order (ended ones too). */
  agents: string[];
  /** The shown session's scroll offset, between `lo` and `hi` rows (0, 0: the live screen; never 0 to more). */
  offset: { lo: number; hi: number };
  /**
   * The home key was pressed in the session view and the next key picks (←/→ switch, the home key
   * again goes home, Esc cancels, any other key cancels and goes on). The 1.5 s timeout isn't
   * modelled: the monkey presses the next key within milliseconds.
   */
  prefix: boolean;
  /** The home view's composer and its cursor (in code points). */
  draft: string;
  cursor: number;
  /** The home list's selected session: the one last left (undefined: not known). */
  homeSel: number | undefined;
  /** The home view's question (“End <name>?”), about this session. */
  overlay: number | null;
  /** A press on the strip was Gluon's: the rest of that click is too. */
  clickTaken: boolean;
}

export interface StepResult {
  next: ModelState;
  /** Bytes each agent (by id) gets from this action. */
  agentBytes: Map<number, string>;
  expectedView: View;
  /** What happened, in words (for failure reports). */
  notes: string[];
}
export type Step = StepResult | { unsupported: string };

export interface ModelConfig {
  cols: number;
  rows: number;
  homeKey: HomeKey;
  /** The tabs in launch order: each fake and its session's name. */
  tabs: { fake: FakeAgent; name: string }[];
  /** The fakes draw on the alternate screen (`FAKE_ALT`). */
  alt?: boolean;
  /** The fakes push the kitty keyboard flags at start (`FAKE_KITTY`). */
  kitty?: boolean;
  capture?: boolean;
}

/** The state once the sessions are open: the last one shown, every line untouched. */
export function initialState(c: ModelConfig): ModelState {
  return {
    cols: c.cols,
    rows: c.rows,
    homeKey: c.homeKey,
    capture: c.capture ?? true,
    view: c.tabs.length ? { session: c.tabs.length - 1 } : "home",
    tabs: c.tabs.map((t, id) => ({
      id,
      fake: t.fake,
      name: t.name,
      touched: 0,
      question: null,
      queued: "",
      line: "",
      back: 0,
      typed: { started: false, pasted: false, empty: true },
      ctrlC: 0,
      modes: { mouse: false, focus: false, kitty: !!c.kitty, alt: !!c.alt, bracketed: true },
      sbLow: 0,
      sbKnown: !!c.alt,
    })),
    agents: c.tabs.map(() => ""),
    offset: { lo: 0, hi: 0 },
    prefix: false,
    draft: "",
    cursor: 0,
    homeSel: undefined,
    overlay: null,
    clickTaken: false,
  };
}

/** The session shown, or null at home. */
export function shown(s: ModelState): Tab | null {
  const v = s.view;
  return v === "home" ? null : (s.tabs.find((t) => t.id === v.session) ?? null);
}

/** Where the strip's parts are in this state (the shown tab current). */
export function strip(s: ModelState): TabSpans {
  return tabSpans(
    s.tabs.map((t) => ({ id: t.id, name: t.name, state: "awaiting" as const, markedDone: false })),
    shown(s)?.id ?? null,
    s.cols,
  );
}

/** The frame's interior: the agent's terminal (0-based on the real one). */
export const interior = (s: ModelState) => layout(s.cols, s.rows).interior;

/** What a key means, to Gluon and to the fake. */
type Sem =
  | { k: "return"; key: KeyName }
  | { k: "scrollUp" | "scrollDown" | "left" | "right" | "altLeft" | "altRight" | "enter" | "esc" | "ctrlC" | "backspace" | "erase" | "kill" | "tab" | "up" | "down" | "report" | "none" }
  | { k: "text"; ch: string };

/** Keys the model knows; `kitty`: a form only a terminal speaking the kitty protocol sends. */
const KEY_SEM: Partial<Record<KeyName, Sem & { kitty?: true }>> = {
  ...Object.fromEntries((["a", "x", "space", "slash", "q", "y", "n", "question", "percent", "digit1", "digit2", "digit9", "digit0", "eAcute", "wide"] as const).map((k) => [k, { k: "text", ch: KEYS[k] }])),
  kittyA: { k: "text", ch: "a", kitty: true },
  enter: { k: "enter" },
  kittyEnter: { k: "enter", kitty: true },
  esc: { k: "esc" },
  kittyEsc: { k: "esc", kitty: true },
  ctrlC: { k: "ctrlC" },
  kittyCtrlC: { k: "ctrlC", kitty: true },
  backspace: { k: "backspace" },
  kittyBackspace: { k: "backspace", kitty: true },
  delete: { k: "erase" },
  ctrlU: { k: "kill" },
  ctrlW: { k: "erase" },
  tab: { k: "tab" },
  kittyTab: { k: "tab", kitty: true },
  up: { k: "up" },
  down: { k: "down" },
  kittyUp: { k: "up", kitty: true },
  kittyDown: { k: "down", kitty: true },
  left: { k: "left" },
  right: { k: "right" },
  kittyLeft: { k: "left", kitty: true },
  kittyRight: { k: "right", kitty: true },
  // Modified arrows: the agent's (the fake prints them as arrows); Alt+←/→ are Gluon's to drop on an untouched line.
  shiftLeft: { k: "report" },
  shiftRight: { k: "report" },
  altLeft: { k: "altLeft" },
  altRight: { k: "altRight" },
  ctrlLeft: { k: "report" },
  ctrlRight: { k: "report" },
  // Keys the fake ignores.
  home: { k: "none" },
  end: { k: "none" },
  pgup: { k: "none" },
  pgdn: { k: "none" },
  ctrlPgup: { k: "none" },
  ctrlA: { k: "none" },
  ctrlE: { k: "none" },
  ctrlO: { k: "none" },
  ctrlT: { k: "none" },
  shiftTab: { k: "none" },
  shiftPgup: { k: "scrollUp" },
  shiftPgdn: { k: "scrollDown" },
  // Alt+PgUp / Alt+PgDn are no longer Gluon's: the agent gets them (the fake ignores them).
  altPgup: { k: "none" },
  altPgdn: { k: "none" },
  ctrlBackslash: { k: "return", key: "ctrlBackslash" },
  ctrlBracket: { k: "return", key: "ctrlBracket" },
  ctrlCaret: { k: "return", key: "ctrlCaret" },
  ctrlUnderscore: { k: "return", key: "ctrlUnderscore" },
  kittyCtrlBackslash: { k: "return", key: "ctrlBackslash", kitty: true },
};

/** The keys the model knows (the monkey's alphabet draws from them). */
export const MODEL_KEYS = Object.keys(KEY_SEM) as KeyName[];
/** A form only a terminal speaking the kitty protocol sends. */
export const isKittyKey = (k: KeyName) => !!KEY_SEM[k]?.kitty;

/** The fake's commands, in its menu's order; the fake `agy` has no /compact (Antigravity's menu says `No matches`). */
const FAKE_COMMANDS = ["/clear", "/compact", "/help", "/new", "/exit"];
const commandsOf = (t: Tab) => (t.fake === "agy" ? FAKE_COMMANDS.filter((c) => c !== "/compact") : FAKE_COMMANDS);

/** Nothing typed since the last Enter, by the user's keys (`Tab.touched`): plain ←/→ are Gluon's. */
export const untouched = (t: Tab) => t.touched === 0;

/**
 * The fake's slash menu is open: its line is a `/` word some command starts with (Enter runs the
 * highlighted one); the fake `agy`'s for any `/` word (`No matches`: Enter runs nothing).
 */
export function menuOpen(t: Tab): boolean {
  return t.line.startsWith("/") && !t.line.includes(" ") && (t.fake === "agy" || commandsOf(t).some((c) => c.startsWith(t.line)));
}

/** The fake's line with `text` put in at its cursor. */
function insertAt(t: Tab, text: string) {
  const chars = [...t.line];
  const at = chars.length - t.back;
  t.line = [...chars.slice(0, at), ...text, ...chars.slice(at)].join("");
}

/** An SGR mouse report (the fakes ask for SGR, 1006). */
const sgr = (code: number, x: number, y: number, release: boolean) => `\x1b[<${code};${x};${y}${release ? "m" : "M"}`;
const BUTTON = { left: 0, middle: 1, right: 2, up: 64, down: 65 } as const;

const fresh = (): Typed => ({ started: false, pasted: false, empty: true });

class Stepper {
  s: ModelState;
  bytes = new Map<number, string>();
  notes: string[] = [];
  bad: string | null = null;

  constructor(s: ModelState) {
    this.s = structuredClone(s);
  }

  unsupported(why: string) {
    this.bad ??= why;
  }

  note(n: string) {
    this.notes.push(n);
  }

  tab(id: number): Tab {
    return this.s.tabs.find((t) => t.id === id)!;
  }

  /** Bytes into an agent. */
  send(t: Tab, data: string) {
    if (!data) return;
    this.bytes.set(t.id, (this.bytes.get(t.id) ?? "") + data);
    this.s.agents[t.id] += data;
  }

  // ---- views ----

  goHome(why: string) {
    const cur = shown(this.s);
    if (!cur) return;
    this.note(`${why}: home`);
    this.s.view = "home";
    this.s.offset = { lo: 0, hi: 0 };
    // However home is reached, the session left is selected in the list (BUG-231).
    this.s.homeSel = cur.id;
  }

  open(id: number, why: string) {
    const fromHome = this.s.view === "home";
    if (shown(this.s)?.id === id) return this.note(`${why}: already shown`);
    this.note(`${why}: ${this.tab(id).name}`);
    // Leaving home answers its question no (BUG-210).
    if (fromHome && this.s.overlay !== null) {
      this.note("the home question answered no");
      this.s.overlay = null;
    }
    // Leaving a session for another goes through no home: the list's selection stays.
    this.s.view = { session: id };
    this.s.offset = { lo: 0, hi: 0 };
  }

  /** The ring ←/→ walk: home, then the tabs in launch order, wrapping both ways. */
  switchTo(dir: 1 | -1, why: string) {
    const ring: (number | null)[] = [null, ...this.s.tabs.map((t) => t.id)];
    const cur = shown(this.s);
    const i = cur ? ring.indexOf(cur.id) : 0;
    const next = ring[(i + dir + ring.length) % ring.length]!;
    if (next === null) this.goHome(why);
    else this.open(next, why);
  }

  /** A session ends (a yes): its tab goes; home shows if it was up. */
  remove(id: number) {
    const cur = shown(this.s);
    this.s.tabs = this.s.tabs.filter((t) => t.id !== id);
    if (cur?.id === id) {
      this.s.view = "home";
      this.s.offset = { lo: 0, hi: 0 };
    }
    // Which row the list selects then isn't the spec's.
    this.s.homeSel = undefined;
    this.note(`${this.s.tabs.length} tab(s) left`);
  }

  // ---- scrolling ----

  /** Scrolls the frame `by` rows back (negative: forward), clamped to the scrollback. */
  scrollBy(t: Tab, by: number) {
    const o = this.s.offset;
    if (by > 0) {
      if (!t.sbKnown && o.lo === 0) return this.unsupported("scrolling back with an unknown scrollback");
      this.s.offset = { lo: Math.min(o.lo + by, t.sbLow), hi: Math.min(SCROLLBACK_MAX, o.hi + by) };
    } else this.s.offset = { lo: Math.max(0, o.lo + by), hi: Math.max(0, o.hi + by) };
    const n = this.s.offset;
    if (n.lo === 0 && n.hi > 0) return this.unsupported("a scroll offset not known to be 0 or not");
    this.note(n.lo > 0 ? `scrolled back (${n.lo}–${n.hi} rows)` : "back on the live screen");
  }

  unscroll() {
    if (this.s.offset.hi === 0) return;
    this.s.offset = { lo: 0, hi: 0 };
    this.note("left scroll mode");
  }

  // ---- the session view ----

  /** A key (or a paste: `pasted`) in the session view of `t`. */
  sessionKey(t: Tab, sem: Sem, raw: string, kittyForm: boolean, pasted = false) {
    // A terminal sends the kitty protocol's forms only once the agent asked for it.
    if (kittyForm && !t.modes.kitty) return this.unsupported("a kitty key to an agent that didn't ask for it");
    const isHomeKey = !pasted && sem.k === "return" && sem.key === HOME_KEYS[this.s.homeKey];
    // The prefix is pending: ←/→ switch (the ring, in every state: scrolled, the question up, a typed
    // line; the question stays pending on its tab), the home key again goes home, Esc cancels and is
    // swallowed; any other key cancels it and is routed as if there had been none.
    if (this.s.prefix) {
      this.s.prefix = false;
      if (!pasted && sem.k === "left") return this.switchTo(-1, "the prefix and ←");
      if (!pasted && sem.k === "right") return this.switchTo(1, "the prefix and →");
      if (isHomeKey) return this.goHome("the home key twice");
      if (!pasted && sem.k === "esc") return this.note("Esc cancels the prefix");
      this.note("another key cancels the prefix");
    } else if (isHomeKey) {
      this.s.prefix = true;
      return this.note("the home key: the next key picks (←/→, the home key again, Esc)");
    }
    // Shift+PgUp scrolls a page back when there is something to scroll back to; else it is the agent's.
    if (!pasted && sem.k === "scrollUp") {
      if (this.s.offset.hi > 0 || (t.sbKnown && t.sbLow > 0)) return this.scrollBy(t, interior(this.s).rows - 1);
      if (!t.sbKnown) return this.unsupported("Shift+PgUp with an unknown scrollback");
    }
    if (!pasted && sem.k === "scrollDown" && this.s.offset.hi > 0) return this.scrollBy(t, -(interior(this.s).rows - 1));
    // The question up: Enter, Esc, Ctrl+C answer it; anything else (a paste too) is dropped.
    if (t.question !== null) {
      if (pasted) return this.note("a paste during the question: dropped");
      if (sem.k === "enter") {
        this.note("the question answered yes: the agent gets its held Enter, the session ends");
        this.send(t, t.question);
        if (t.queued) this.note("the focus reports queued behind it: dropped (the session is ending)");
        t.question = null;
        t.queued = "";
        return this.remove(t.id);
      }
      if (sem.k === "esc" || sem.k === "ctrlC") {
        this.note("the question answered no: the line stays typed, so ←/→ are the agent's (BUG-234)");
        t.question = null;
        t.touched = Infinity;
        this.send(t, t.queued);
        t.queued = "";
        return;
      }
      return this.note(`${sem.k} during the question: dropped`);
    }
    // Plain ←/→ on an untouched line: ← the previous tab, → the next one (home from the first / last).
    if (!pasted && sem.k === "left" && untouched(t)) return this.switchTo(-1, "← on an untouched line");
    if (!pasted && sem.k === "right" && untouched(t)) return this.switchTo(1, "→ on an untouched line");
    // Alt+←/→ there are dropped: the agent never gets them and nothing else happens (scroll mode stays).
    if (!pasted && (sem.k === "altLeft" || sem.k === "altRight") && untouched(t)) return this.note("Alt+←/→ on an untouched line: dropped");
    // Scrolled back: Esc or q leave scroll mode; anything else leaves it and goes on.
    if (this.s.offset.hi > 0) {
      if (!pasted && (sem.k === "esc" || (sem.k === "text" && sem.ch === "q"))) return this.unscroll();
      this.unscroll();
    }
    this.input(t, sem, raw, pasted);
  }

  /** A key for the agent: the untouched line, the interceptor, the agent's bytes, the fake. */
  input(t: Tab, sem: Sem, raw: string, pasted: boolean) {
    // Enter resets the line to untouched; Esc and Ctrl+C keep an untouched one untouched and touch
    // a typed one; a printable counts its code points up and Backspace one down, never below 0
    // (BUG-268); anything else (an arrow, Ctrl+U, a paste) touches it until the next Enter.
    if (!pasted && sem.k === "enter") t.touched = 0;
    else if (!pasted && (sem.k === "esc" || sem.k === "ctrlC")) t.touched = t.touched === 0 ? 0 : Infinity;
    else if (!pasted && sem.k === "text") t.touched += [...sem.ch].length;
    else if (!pasted && sem.k === "backspace") t.touched = Math.max(0, t.touched - 1);
    else t.touched = Infinity;
    if (pasted) {
      // Bracketed for an agent that asked for it, the markers dropped for one that didn't (BUG-172).
      t.typed.pasted = true;
      this.send(t, t.modes.bracketed ? raw : raw.slice(6, -6));
      t.ctrlC = 0;
      insertAt(t, raw.slice(6, -6).replace(/[\r\n]+/g, " "));
      return;
    }
    const ty = t.typed;
    if (sem.k === "enter") {
      if (menuOpen(t) && t.line !== "/clear") return this.unsupported(`Enter on the fake's menu for ${t.line}`);
      // The command is the line's first word (`/clear name` clears too).
      const word = t.line.trim().split(/\s+/)[0]!;
      if (word === "/clear" && !ty.started && !ty.pasted) return this.unsupported("/clear on the line, not typed from its start");
      if (["/new", "/reset", "/compact"].includes(word)) return this.unsupported(`${word}: another command that asks`);
      // A typed /clear (no paste in its line) asks before ending the session; its Enter is held.
      if (word === "/clear" && ty.started && !ty.pasted) {
        this.note(`Enter on a typed /clear: “${END_Q}”, the Enter held`);
        t.question = raw;
        t.ctrlC = 0;
        return;
      }
      t.typed = fresh();
    } else if (sem.k === "ctrlC") t.typed = fresh();
    else if (sem.k === "esc") {
      if (!ty.started) t.typed = fresh();
    } else if (sem.k === "backspace" || sem.k === "erase" || sem.k === "kill") {
      if (!ty.started) ty.empty = true;
    } else if (sem.k === "text") {
      if (ty.empty) ty.started = sem.ch === "/";
      ty.empty = false;
    }
    this.send(t, raw);
    this.fakeKey(t, sem);
  }

  /** The fake reads a key: its line, its Ctrl+C count, its `!` commands. */
  fakeKey(t: Tab, sem: Sem) {
    // Arrows leave its Ctrl+C count as it is: a modified one is printed, so is a plain one on an
    // empty line; else a plain one moves its cursor.
    if (sem.k === "report" || sem.k === "altLeft" || sem.k === "altRight") return;
    if (sem.k === "left" || sem.k === "right") {
      if (t.line) t.back = Math.max(0, Math.min([...t.line].length, t.back + (sem.k === "left" ? 1 : -1)));
      return;
    }
    if (sem.k === "ctrlC") {
      if (t.ctrlC >= 1) return this.unsupported("a second Ctrl+C in a row exits the fake");
      t.ctrlC++;
      t.line = "";
      t.back = 0;
      return;
    }
    t.ctrlC = 0;
    // Its slash menu open: Esc closes it, Tab completes or runs, ↑/↓ move its highlight.
    if (menuOpen(t) && ["esc", "tab", "up", "down"].includes(sem.k)) return this.unsupported(`${sem.k} on the fake's slash menu`);
    switch (sem.k) {
      case "text":
        insertAt(t, sem.ch);
        return;
      case "backspace": {
        const chars = [...t.line];
        const at = chars.length - t.back;
        if (at > 0) t.line = [...chars.slice(0, at - 1), ...chars.slice(at)].join("");
        return;
      }
      // Esc clears a line with no menu up; Ctrl+U clears it (`fake-tui.ts`).
      case "esc":
      case "kill":
        t.line = "";
        t.back = 0;
        return;
      case "enter":
        return this.run(t);
    }
  }

  /** The fake runs its line (an Enter Gluon let through). */
  run(t: Tab) {
    const line = t.line;
    t.line = "";
    t.back = 0;
    const [cmd, arg] = line.split(" ");
    if (line === "/clear") this.note(`${t.name} runs its own /clear`);
    else if (cmd === "!mouse") t.modes.mouse = true;
    else if (cmd === "!focus") t.modes.focus = true;
    else if (cmd === "!kitty") t.modes.kitty = true;
    else if (cmd === "!lines") {
      if (t.modes.alt) return;
      // Its lines, then SIZE, the ready line and the prompt at least, in an interior of `rows`.
      const n = Number(arg || 10);
      t.sbLow = Math.min(SCROLLBACK_MAX, t.sbKnown ? t.sbLow + n : Math.max(0, n + 3 - interior(this.s).rows));
      t.sbKnown = t.sbLow > 0;
    } else if (["!compact", "!menu", "!tick", "!da", "!kq", "!otel", "!event"].includes(cmd!) || commandsOf(t).includes(line)) this.unsupported(`the fake's ${cmd}`);
  }

  /** A mouse report in the session view. */
  sessionMouse(t: Tab, code: number, x: number, y: number, release: boolean) {
    // Any mouse report ends a pending prefix (the click then does what it does).
    this.s.prefix = false;
    // A left press on the strip: ◆ gluon home, a tab that session, ‹ / › the nearest hidden one.
    if (code === 0 && !release && y === 1) {
      const sp = strip(this.s);
      const cx = x - 1;
      if (cx >= sp.home[0] && cx < sp.home[1]) {
        this.s.clickTaken = true;
        return this.goHome("a click on ◆ gluon");
      }
      const hit = [...sp.tabs, sp.prev, sp.next].find((h) => h && cx >= h.x0 && cx < h.x1);
      if (hit) {
        this.s.clickTaken = true;
        const marker = hit === sp.prev || hit === sp.next;
        if (hit.id !== t.id) this.open(hit.id, marker ? "a click on an overflow marker" : "a click on a tab");
        else this.note("a click on the shown tab");
        return;
      }
    }
    const r = interior(this.s);
    if (t.modes.mouse) {
      // The agent's: moved into the interior; outside it dropped. A release there is held at its edge
      // only after a press the agent got, and a click's press is where its release is (BUG-240).
      const ix = x - r.left;
      const iy = y - r.top;
      const inside = ix >= 1 && ix <= r.cols && iy >= 1 && iy <= r.rows;
      if (!inside) return this.note("a mouse report outside the interior: dropped");
      if (t.question !== null) return this.note("a mouse report during the question: dropped");
      this.send(t, sgr(code, Math.min(r.cols, Math.max(1, ix)), Math.min(r.rows, Math.max(1, iy)), release));
      return;
    }
    // Gluon has the wheel (`mouse_capture`), but not over an agent on its alternate screen.
    const capture = this.s.capture && !t.modes.alt;
    if (capture && code === 64) return this.scrollBy(t, WHEEL_ROWS);
    if (capture && code === 65 && this.s.offset.hi > 0) return this.scrollBy(t, -WHEEL_ROWS);
  }

  // ---- the home view ----

  /** A key, a typed character or a paste at home. */
  homeKey(sem: Sem | null, key: KeyName | null, pasted?: string) {
    const s = this.s;
    // Alt+PgUp / Alt+PgDn at home are Ink's, and Alt+←/→ Ink's too: what they do to the composer isn't modelled.
    if (key === "altPgup" || key === "altPgdn" || key === "altLeft" || key === "altRight") return this.unsupported(`${key} at home`);
    if (s.overlay !== null) {
      // Only Enter (yes), Esc or Ctrl+C (no) answer it (BUG-213).
      if (pasted !== undefined) return this.note("a paste during the home question: ignored");
      if (sem?.k === "enter") {
        const id = s.overlay;
        s.overlay = null;
        this.note("the home question answered yes: the session ends");
        return this.remove(id);
      }
      if (sem?.k === "esc" || sem?.k === "ctrlC") {
        s.overlay = null;
        return this.note("the home question answered no");
      }
      return this.note("a key during the home question: ignored");
    }
    const blank = !s.draft.trim();
    const cps = [...s.draft];
    const insert = (text: string) => {
      const add = [...text];
      s.draft = [...cps.slice(0, s.cursor), ...add, ...cps.slice(s.cursor)].join("");
      s.cursor += add.length;
    };
    if (pasted !== undefined) {
      if (/[\x00-\x1f\x7f]/.test(pasted)) return this.unsupported("a control character pasted into the composer");
      return insert(pasted);
    }
    if (sem?.k === "text") {
      if (sem.ch === "?" && s.draft === "") return this.unsupported("? on an empty composer opens the key list");
      return insert(sem.ch);
    }
    switch (key) {
      case "enter": {
        if (!blank) return this.unsupported("Enter on a draft sends it to the intake agent");
        if (s.draft) (s.draft = ""), (s.cursor = 0);
        if (!s.tabs.length) return this.note("Enter with no sessions: nothing");
        const sel = s.homeSel;
        if (sel === undefined || !s.tabs.some((t) => t.id === sel)) return this.unsupported("Enter with the list's selection unknown");
        return this.open(sel, "Enter on the selected row");
      }
      case "right":
        // → with an empty composer: the first tab (home is the strip's leftmost).
        if (s.draft === "" && s.tabs.length) return this.open(s.tabs[0]!.id, "→ at home with an empty composer");
        s.cursor = Math.min(cps.length, s.cursor + 1);
        return;
      case "left":
        s.cursor = Math.max(0, s.cursor - 1);
        return;
      case "home":
      case "ctrlA":
        s.cursor = 0;
        return;
      case "end":
      case "ctrlE":
        s.cursor = cps.length;
        return;
      case "backspace":
        if (s.cursor > 0) (s.draft = [...cps.slice(0, s.cursor - 1), ...cps.slice(s.cursor)].join("")), s.cursor--;
        return;
      case "delete": {
        if (s.draft !== "") {
          s.draft = [...cps.slice(0, s.cursor), ...cps.slice(s.cursor + 1)].join("");
          return;
        }
        // Delete on the selected row of a running session: asked first (BUG-164).
        if (!s.tabs.length) return this.note("Delete with no sessions: nothing");
        const sel = s.homeSel;
        if (sel === undefined || !s.tabs.some((t) => t.id === sel)) return this.unsupported("Delete with the list's selection unknown");
        s.overlay = sel;
        return this.note(`Delete on ${this.tab(sel).name}'s row: “End ${this.tab(sel).name}?”`);
      }
      case "ctrlU":
        s.draft = cps.slice(s.cursor).join("");
        s.cursor = 0;
        return;
      case "ctrlC":
        if (blank) return this.unsupported("Ctrl+C on an empty composer arms quitting");
        s.draft = "";
        s.cursor = 0;
        return;
      case "esc":
        if (!blank) return this.unsupported("Esc on a draft arms clearing it (timed)");
        return;
      case "tab":
      case "shiftTab":
      case "pgup":
      case "pgdn":
      case "shiftPgup":
      case "shiftPgdn":
      case "ctrlPgup":
      case "ctrlO":
      case "ctrlT":
      case "ctrlBackslash":
      case "ctrlBracket":
      case "ctrlCaret":
      case "ctrlUnderscore":
        // No proposal open, nothing to scroll the model sees; the home key at home goes nowhere.
        return this.note(`${key} at home: nothing`);
    }
    return this.unsupported(`${key ?? "that"} at home`);
  }

  /** A mouse report, before any view reads it: the rest of a click Gluon took goes nowhere. */
  restOfClick(code: number, release: boolean): boolean {
    if (!this.s.clickTaken) return false;
    if (release) {
      this.s.clickTaken = false;
      this.note("the rest of Gluon's click: dropped");
      return true;
    }
    if (code < 64) this.s.clickTaken = false;
    return false;
  }
}

/** What `action` does in state `s`: the next state, the agents' bytes, the view; or why the model can't say. */
export function step(s: ModelState, action: Action): Step {
  const m = new Stepper(s);
  const one = (fn: () => void) => {
    if (!m.bad) fn();
  };
  const done = (): Step => {
    if (m.bad) return { unsupported: m.bad };
    // A draft of spaces only draws a composer row that trims to `›`: the screen can't tell it's home.
    if (m.s.view === "home" && m.s.draft !== "" && !m.s.draft.trim()) return { unsupported: "a draft of spaces only" };
    return { next: m.s, agentBytes: m.bytes, expectedView: m.s.view, notes: m.notes };
  };
  if ("key" in action) {
    const sem = KEY_SEM[action.key];
    if (!sem) return { unsupported: `the key ${action.key}` };
    const t = shown(m.s);
    if (t) m.sessionKey(t, sem, KEYS[action.key], !!sem.kitty);
    else if (sem.kitty) m.unsupported("a kitty key at home (Gluon popped the agent's flags)");
    else m.homeKey(sem, action.key);
  } else if ("text" in action) {
    // Typed one character at a time.
    for (const ch of action.text)
      one(() => {
        const t = shown(m.s);
        const sem: Sem = { k: "text", ch };
        if (t) m.sessionKey(t, sem, ch, false);
        else m.homeKey(sem, null);
      });
  } else if ("paste" in action) {
    const t = shown(m.s);
    if (t) m.sessionKey(t, { k: "text", ch: "" }, `\x1b[200~${action.paste}\x1b[201~`, false, true);
    else m.homeKey(null, null, action.paste);
  } else if ("mouse" in action) {
    const { op, button, x, y } = action.mouse;
    if (op !== "click" && op !== "wheel") return { unsupported: `mouse ${op}` };
    if ((op === "wheel") !== (button === "up" || button === "down")) return { unsupported: `${op} with ${button}` };
    const code = BUTTON[button];
    const reports: boolean[] = op === "click" ? [false, true] : [false];
    for (const release of reports)
      one(() => {
        if (m.restOfClick(code, release)) return;
        const t = shown(m.s);
        if (t) m.sessionMouse(t, code, x, y, release);
        // At home a press is Gluon's (the rest of its click goes nowhere); the monkey clicks only off
        // the list (its top row) and the wheel scrolls the chat: nothing the model sees (BUG-269).
        else if (!release && code < 64 && m.s.capture) {
          m.s.clickTaken = true;
          m.note("a click at home off the list: nothing");
        } else m.note("a mouse report at home: nothing the model sees");
      });
  } else if ("focus" in action) {
    // A focus report reaches the agent only if it asked for them (and the home view tracks none).
    const t = shown(m.s);
    if (!t) return { unsupported: "a focus report at home" };
    const bytes = action.focus === "in" ? "\x1b[I" : "\x1b[O";
    if (!t.modes.focus) m.note("a focus report the agent didn't ask for: dropped");
    // Bytes stay in order: one sent during the question waits behind the held Enter.
    else if (t.question !== null) {
      t.queued += bytes;
      m.note("a focus report during the question: queued behind the held Enter");
    } else m.send(t, bytes);
  } else return { unsupported: "resizes, signals, replies and waits" };
  return done();
}

/** A view in words. */
export function describeView(s: ModelState): string {
  const t = shown(s);
  return t ? `session ${t.name}` : "home";
}
