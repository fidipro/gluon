/**
 * Gluon: the terminal modes one agent session has set, as its screen model saw them. Only the
 * active session's modes are on the real terminal; a switch applies `modeTransition(from, to)`,
 * and leaving for home applies `modeTransition(from, HOME_MODES)` (or `MODES_RESET` when the real
 * terminal's state is unknown).
 *
 * xterm's own `modes` give DECCKM, the keypad, bracketed paste, focus, mouse tracking and ?2026;
 * the rest xterm doesn't expose is watched with parser handlers that return false, so xterm still
 * handles each sequence as before: mouse encoding (?1005/?1006/?1015/?1016), the kitty keyboard
 * flags (`CSI > f u` push, `CSI < n u` pop, `CSI = f ; m u` set; one stack per screen, as kitty
 * keeps), DECSCUSR cursor shape and ?9001 win32-input-mode.
 */
import type xterm from "@xterm/headless";

export type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any";
export type MouseEncoding = "default" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";

export interface ModesState {
  /** DECCKM (`?1`): arrows send `ESC O A`. */
  cursorKeys: boolean;
  /** DECKPAM (`ESC =`, `?66`). */
  keypad: boolean;
  /** `?2004`. */
  bracketedPaste: boolean;
  /** `?1004`. */
  focus: boolean;
  mouseTracking: MouseTracking;
  mouseEncoding: MouseEncoding;
  /** The kitty keyboard flags in effect (top of the active screen's stack); 0 = legacy keys. */
  kittyFlags: number;
  /** DECSCUSR `CSI Ps SP q`, 0 = the terminal's default. */
  cursorShape: number;
  /** `?9001` (Windows Terminal / ConPTY). */
  win32Input: boolean;
  /** `?2026` synchronized output: transient, never part of a transition (`syncPending`). */
  syncOutput: boolean;
}

/** The real terminal's modes on Gluon's home view: everything off. */
export const HOME_MODES: Readonly<ModesState> = Object.freeze({
  cursorKeys: false,
  keypad: false,
  bracketedPaste: false,
  focus: false,
  mouseTracking: "none",
  mouseEncoding: "default",
  kittyFlags: 0,
  cursorShape: 0,
  win32Input: false,
  syncOutput: false,
});

/**
 * Bytes that bring a real terminal in any state to `HOME_MODES` (and a visible cursor): the cursor,
 * mouse tracking, bracketed paste, kitty keys, focus and win32-input-mode first (what a reset after
 * a handoff always wrote: `TERMINAL_RESET` in `src/ui/rawmode.ts` has it too), then X10 mouse,
 * the other mouse encodings, DECCKM, the keypad and the cursor shape. One kitty pop: a transition
 * pushes at most one entry on the real terminal.
 */
export const MODES_RESET =
  "\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[?1004l\x1b[?9001l\x1b[?9l\x1b[?1005l\x1b[?1015l\x1b[?1016l\x1b[?1l\x1b>\x1b[0 q";

const TRACKING: Record<Exclude<MouseTracking, "none">, number> = { x10: 9, vt200: 1000, drag: 1002, any: 1003 };
const ENCODING: Record<Exclude<MouseEncoding, "default">, number> = { utf8: 1005, sgr: 1006, urxvt: 1015, "sgr-pixels": 1016 };
const ENCODING_OF = new Map(Object.entries(ENCODING).map(([k, v]) => [v, k as MouseEncoding]));
/** Kitty's flags are 5 bits; its stack is bounded (the oldest entry goes). */
const KITTY_MASK = 31;
const KITTY_DEPTH = 64;

const priv = (n: number, on: boolean) => `\x1b[?${n}${on ? "h" : "l"}`;

/**
 * The bytes that switch the real terminal from one session's modes to another's. Pure; changes
 * only what differs. The real terminal holds at most one kitty entry of Gluon's: push from 0, set
 * between non-zero flags, pop back to 0.
 */
export function modeTransition(from: Readonly<ModesState>, to: Readonly<ModesState>): string {
  let out = "";
  if (from.cursorKeys !== to.cursorKeys) out += priv(1, to.cursorKeys);
  if (from.keypad !== to.keypad) out += to.keypad ? "\x1b=" : "\x1b>";
  if (from.bracketedPaste !== to.bracketedPaste) out += priv(2004, to.bracketedPaste);
  if (from.focus !== to.focus) out += priv(1004, to.focus);
  if (from.mouseTracking !== to.mouseTracking) {
    if (from.mouseTracking !== "none") out += priv(TRACKING[from.mouseTracking], false);
    if (to.mouseTracking !== "none") out += priv(TRACKING[to.mouseTracking], true);
  }
  if (from.mouseEncoding !== to.mouseEncoding) {
    if (from.mouseEncoding !== "default") out += priv(ENCODING[from.mouseEncoding], false);
    if (to.mouseEncoding !== "default") out += priv(ENCODING[to.mouseEncoding], true);
  }
  if (from.kittyFlags !== to.kittyFlags) {
    if (!from.kittyFlags) out += `\x1b[>${to.kittyFlags}u`;
    else if (!to.kittyFlags) out += "\x1b[<u";
    else out += `\x1b[=${to.kittyFlags};1u`;
  }
  if (from.cursorShape !== to.cursorShape) out += `\x1b[${to.cursorShape} q`;
  if (from.win32Input !== to.win32Input) out += priv(9001, to.win32Input);
  return out;
}

export interface ModeTracker {
  state(): ModesState;
  dispose(): void;
}

/** Watches `term`'s parser for the modes xterm doesn't expose; `state()` merges them with `term.modes`. */
export function trackModes(term: xterm.Terminal): ModeTracker {
  let encoding: MouseEncoding = "default";
  let cursorShape = 0;
  let win32Input = false;
  // Per screen, kitty keeps the flags in effect and a stack of saved ones.
  const kitty = { normal: { flags: 0, stack: [] as number[] }, alternate: { flags: 0, stack: [] as number[] } };
  const k = () => kitty[term.buffer.active.type];
  const first = (params: (number | number[])[], dflt: number) => {
    const p = params[0];
    return typeof p === "number" ? p : (p?.[0] ?? dflt);
  };

  const decset = (on: boolean) => (params: (number | number[])[]) => {
    for (const p of params) {
      if (typeof p !== "number") continue;
      const enc = ENCODING_OF.get(p);
      // xterm resets to the default encoding on any of them going off; so do we when it's the active one.
      if (enc) encoding = on ? enc : encoding === enc ? "default" : encoding;
      if (p === 9001) win32Input = on;
    }
    return false;
  };
  const disposables = [
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, decset(true)),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, decset(false)),
    term.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
      const n = first(params, 0);
      if (n >= 0 && n <= 6) cursorShape = n;
      return false;
    }),
    term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      const s = k();
      s.stack.push(s.flags);
      if (s.stack.length > KITTY_DEPTH) s.stack.shift();
      s.flags = first(params, 0) & KITTY_MASK;
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
      const s = k();
      for (let n = Math.max(1, first(params, 1)); n > 0; n--) s.flags = s.stack.pop() ?? 0;
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      const s = k();
      const f = first(params, 0) & KITTY_MASK;
      const mode = typeof params[1] === "number" ? params[1] : 1;
      if (mode === 1) s.flags = f;
      else if (mode === 2) s.flags |= f;
      else if (mode === 3) s.flags &= ~f;
      return true;
    }),
    // RIS: xterm resets its own modes; ours go too.
    term.parser.registerEscHandler({ final: "c" }, () => {
      encoding = "default";
      cursorShape = 0;
      win32Input = false;
      for (const s of Object.values(kitty)) {
        s.flags = 0;
        s.stack = [];
      }
      return false;
    }),
  ];

  return {
    state() {
      const m = term.modes;
      return {
        cursorKeys: m.applicationCursorKeysMode,
        keypad: m.applicationKeypadMode,
        bracketedPaste: m.bracketedPasteMode,
        focus: m.sendFocusMode,
        mouseTracking: m.mouseTrackingMode,
        mouseEncoding: encoding,
        kittyFlags: k().flags,
        cursorShape,
        win32Input,
        syncOutput: !!m.synchronizedOutputMode,
      };
    },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
