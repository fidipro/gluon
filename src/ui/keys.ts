/**
 * Key handling shared by the session UI (App.tsx) and the sign-in menus (signin.tsx): splitting a
 * batch of keys Ink delivered as one string, and ignoring a late reply to the terminal's
 * background-colour query (OSC 11), which would otherwise arrive as keys — an Esc that closes a
 * menu, then "]11;rgb:…" and a "\" (the ESC \ terminator of light terminals) typed as text.
 */
import type { Key } from "ink";
import { useEffect, useRef } from "react";
import { lateReplyExpected, replySeen } from "./theme.ts";

export const NO_KEY: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
  super: false, hyper: false, capsLock: false, numLock: false,
};

/**
 * Ink hands over a chunk of keys that arrived in one read (fast typing, a blocked event loop,
 * automation) as one string, so "fix it\r" would be text with a carriage return in it. Splits it
 * back into keys: text runs, Enter, Backspace, Tab and Ctrl+letter.
 */
export function splitKeys(input: string): [string, Key][] {
  const out: [string, Key][] = [];
  let run = "";
  const flush = () => {
    if (run) out.push([run, NO_KEY]);
    run = "";
  };
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (ch === "\r") (flush(), out.push(["", { ...NO_KEY, return: true }]));
    else if (ch === "\n") (flush(), out.push(["\n", NO_KEY]));
    else if (ch === "\t") (flush(), out.push(["", { ...NO_KEY, tab: true }]));
    else if (ch === "\x7f" || ch === "\b") (flush(), out.push(["", { ...NO_KEY, backspace: true }]));
    else if (code >= 1 && code <= 26) (flush(), out.push([String.fromCharCode(code + 96), { ...NO_KEY, ctrl: true }]));
    else if (code < 32) flush();
    else run += ch;
  }
  flush();
  return out;
}

/**
 * How long an Esc and a lone "]" are held to tell a late OSC 11 reply from a key press. A reply
 * split across reads reaches Ink as an Esc (after Ink's own ~25 ms escape timeout) and then
 * "]11;rgb:…" later; the "]" of a whole reply is followed at once by the rest. While a reply is
 * still expected (the terminal didn't answer in time, a few seconds ago) an Esc is held longer,
 * since the rest of a split reply can come later over SSH or tmux.
 */
export const ESC_HOLD_MS = 150;
export const ESC_HOLD_EXPECTING_MS = 1000;
export const BRACKET_HOLD_MS = 30;
/** How long the rest of a reply (its colour digits, its BEL or ESC \ terminator) is waited for once it started. */
export const REPLY_TAIL_MS = 1000;

const WHOLE = /^(11;)?rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}$/i;
const PREFIX = /^(1(1(;(r(g(b(:[0-9a-f/]*)?)?)?)?)?)?|r(g(b(:[0-9a-f/]*)?)?)?)$/i;
const TERMINATOR = /(\x07|\x1b\\)$/;

/**
 * What a piece of input is, as part of an OSC 11 reply: all of it ("done"), all but the
 * terminator ("tail": an ESC \ or BEL is due), the start of one ("open": more digits are due), or
 * not a reply (null). A lone "1" or "r" is never taken for one unless a "]" came first.
 */
export function replyPart(input: string, afterBracket = false): { phase: "done" | "tail" | "open"; text: string } | null {
  const bracket = input.startsWith("]");
  const terminated = TERMINATOR.test(input);
  const text = input.replace(/^\]/, "").replace(TERMINATOR, "");
  if (WHOLE.test(text)) return { phase: terminated ? "done" : "tail", text };
  if (terminated || !text) return null;
  if (PREFIX.test(text) && (bracket || afterBracket || text.length >= 3)) return { phase: "open", text };
  return null;
}

/**
 * Filters a late OSC 11 reply out of the keys, as a state machine fed one key at a time (so it can
 * be tested without a terminal). The reply's ESC can arrive as an Esc key (or Alt+"]"), followed
 * by "]11;rgb:…" in one or several pieces, then its terminator: BEL (Ctrl+G) or ESC \ (which Ink
 * delivers as a lone "\"). An Esc and a lone "]" are held briefly and dropped when the rest of a
 * reply follows; otherwise they go through, late. The body is recognised whenever it arrives.
 */
export class LateOscFilter {
  private held: { input: string; key: Key; timer: ReturnType<typeof setTimeout> } | null = null;
  private reply: { phase: "tail" | "open"; text: string; until: number } | null = null;

  constructor(
    private deliver: (input: string, key: Key) => void,
    private escHold: () => number = () => (lateReplyExpected() ? ESC_HOLD_EXPECTING_MS : ESC_HOLD_MS),
  ) {}

  /** Feeds one key; the ones that aren't part of a reply reach `deliver`, possibly later. */
  feed(input: string, key: Key): void {
    const h = this.held;
    if (h) {
      clearTimeout(h.timer);
      this.held = null;
      if (this.swallow(input, key, h.input === "]")) return;
      if (!(h.input === "]" && h.key.meta)) this.deliver(h.input, h.key);
    }
    if (this.swallow(input, key, false)) return;
    const bracket = input === "]" && !key.ctrl;
    if ((key.escape && !input.replace(/\x1b/g, "")) || bracket) {
      this.held = {
        input,
        key,
        timer: setTimeout(() => {
          const held = this.held;
          this.held = null;
          // Alt+"]" is never a key Gluon uses: a held one is dropped.
          if (held && !(held.input === "]" && held.key.meta)) this.deliver(held.input, held.key);
        }, bracket ? BRACKET_HOLD_MS : this.escHold()),
      };
      return;
    }
    this.deliver(input, key);
  }

  /** Whether this key is (part of) a reply, and if so takes it. */
  private swallow(input: string, key: Key, afterBracket: boolean): boolean {
    const r = this.reply && Date.now() <= this.reply.until ? this.reply : null;
    this.reply = null;
    if (r?.phase === "tail") {
      if (input === "\\" || input === "\x07" || (key.ctrl && input === "g")) return true;
      // An Esc may be the start of ESC \: keep waiting for the "\".
      if (key.escape && !input) this.reply = r;
      // The colour's last digits, when the reply was split inside them ("…/0c" then "0c\x07").
      const more = input.match(/^([0-9a-f]{1,3})(\x07|\x1b\\)?$/i);
      if (more && WHOLE.test(`${r.text}${more[1]}`)) return this.took({ phase: more[2] ? "done" : "tail", text: `${r.text}${more[1]}` });
    }
    if (r?.phase === "open") {
      if (key.ctrl && input === "g") return true;
      const more = replyPart(`]${r.text}${input}`);
      if (more) return this.took(more);
    }
    const part = replyPart(input, afterBracket);
    return part ? this.took(part) : false;
  }

  private took(part: { phase: "done" | "tail" | "open"; text: string }): true {
    replySeen();
    this.reply = part.phase === "done" ? null : { phase: part.phase, text: part.text, until: Date.now() + REPLY_TAIL_MS };
    return true;
  }

  dispose() {
    clearTimeout(this.held?.timer);
    this.held = null;
  }
}

/** How long a first Esc / Ctrl+C waits for the second press. */
export const CONFIRM_MS = 2000;

/**
 * Whether `key` was pressed twice within `CONFIRM_MS` (Ctrl+C twice quits, Esc twice clears the
 * draft). The first press arms `armed`; any other key should reset it to null.
 */
export function pressedTwice(armed: { current: { key: string; at: number } | null }, key: string, now = Date.now()): boolean {
  if (armed.current?.key === key && now - armed.current.at < CONFIRM_MS) {
    armed.current = null;
    return true;
  }
  armed.current = { key, at: now };
  return false;
}

/** Wraps a key handler so that a late OSC 11 reply never reaches it (see LateOscFilter). */
export function useLateOscFilter(handle: (input: string, key: Key) => void): (input: string, key: Key) => void {
  const latest = useRef(handle);
  latest.current = handle;
  const filter = useRef<LateOscFilter | null>(null);
  filter.current ??= new LateOscFilter((input, key) => latest.current(input, key));
  useEffect(() => () => filter.current?.dispose(), []);
  return (input, key) => filter.current!.feed(input, key);
}
