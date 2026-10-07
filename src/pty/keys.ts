/**
 * The user's input, split into keys on its way to the agent's PTY (`proxy.ts`). Knows the legacy
 * encodings (plain bytes, CSI / SS3), the kitty keyboard protocol (`CSI code;mods u`, when the agent
 * asked the terminal for it), Windows Terminal's win32-input-mode (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`, which
 * ConPTY asks for), rxvt's Alt (an ESC before the key's sequence), bracketed paste (one opaque,
 * `pasted` text key), and what is not typed: mouse reports (`mouse`, parsed), focus reports
 * (`focus`), terminal replies (`reply`: OSC, DCS, APC, `CSI ? … c`, `CSI ? … u`, `CSI … R`, …).
 *
 * Every key keeps its exact bytes (`raw`): what goes on to the agent, unchanged, unless it is held
 * or consumed. The configured return key (`handoff.key`) is `return-key` in every encoding, never
 * inside a paste; Shift+PgUp/PgDn are `scroll-up`/`scroll-down`; plain arrows (no modifier) are
 * `up`/`down`/`left`/`right` and Alt+←/→ `alt-left`/`alt-right` (the router decides whether they
 * are Gluon's). Keys are never logged or written anywhere.
 */
import type { Key, KeyDecoder, MouseEncoding, MouseReport } from "./types.ts";

/** The return keys `handoff.key` may name, and the control byte each sends. */
export const RETURN_KEYS: Record<string, number> = { "ctrl+]": 0x1d, "ctrl+\\": 0x1c, "ctrl+^": 0x1e, "ctrl+_": 0x1f };
/** The return key when `handoff.key` names none of `RETURN_KEYS` (`DEFAULT_KEY` in `handoff.ts`). */
const DEFAULT_RETURN = 0x1c;

/** How long a lone ESC (or an unfinished sequence) waits for the rest before `flush()` (the caller's timer). */
export const ESC_TIMEOUT_MS = 50;
/**
 * How long a CSI already started (`ESC [` and more: `ESC [ 6 ;`) waits for the rest: over SSH a
 * key's sequence can arrive in two reads far apart, and flushing it early would give the agent
 * `ESC [ 6 ;` and then `3~` typed (BUG-170). A lone ESC (or `ESC [`, Alt+[) keeps ESC_TIMEOUT_MS.
 */
export const CSI_TIMEOUT_MS = 400;

/**
 * Ctrl+C in any encoding: the byte, the kitty protocol (`CSI 99;5u`, Caps/Num Lock allowed, not a
 * key release), win32-input-mode (a key-down whose character is 3).
 */
export function isCtrlC(k: Key): boolean {
  if (k.raw === "\x03") return true;
  const kitty = /^\x1b\[99(?::\d*)*;(\d+)(?::(\d+))?u$/.exec(k.raw);
  if (kitty) return ((Number(kitty[1]) - 1) & ~(64 | 128)) === 4 && kitty[2] !== "3";
  return /^\x1b\[\d*;\d*;3;1;\d*;\d*_$/.test(k.raw);
}

/** Ctrl+H, Ctrl+K, Ctrl+U, Ctrl+W, DEL: the control bytes that erase in a line editor. */
const ERASE_BYTES = [0x08, 0x0b, 0x15, 0x17, 0x7f];
/** The same as kitty key codes: h, k, u, w (with Ctrl). */
const ERASE_LETTERS = [104, 107, 117, 119];
const VK_DELETE = 0x2e;

/**
 * A key that may erase some of the agent's typed line, in any encoding: Backspace (any modifier),
 * Delete, Ctrl+U / Ctrl+W / Ctrl+K / Ctrl+H, Alt+Backspace. Not a key release. What it erased is
 * the agent's business: only its input line on screen says what is left (BUG-205).
 */
export function erases(k: Key): boolean {
  if (k.name === "backspace") return true;
  if (k.name !== "other" || k.pasted) return false;
  const legacy = k.raw.replace(/^\x1b(?=[\x08\x7f]$)/, "");
  if (legacy.length === 1 && ERASE_BYTES.includes(legacy.charCodeAt(0))) return true;
  // Delete: `CSI 3 ~`, with modifiers (and, in kitty, an event that isn't a release).
  const del = /^\x1b\[3(?:;\d+(?::(\d+))?)?~$/.exec(k.raw);
  if (del) return del[1] !== "3";
  const kitty = /^\x1b\[(\d+)(?::\d*)*(?:;(\d+)(?::(\d+))?)?u$/.exec(k.raw);
  if (kitty) {
    if (kitty[3] === "3") return false;
    const code = Number(kitty[1]);
    const ctrl = ((Number(kitty[2] || 1) - 1) & 4) !== 0;
    return code === 127 || code === 8 || (ctrl && ERASE_LETTERS.includes(code));
  }
  const w = WIN32_KEY.exec(k.raw);
  return !!w && w[4] === "1" && (Number(w[1]) === VK_DELETE || ERASE_BYTES.includes(Number(w[3])));
}

/** The control byte of a `handoff.key` value, or null when it isn't one of `RETURN_KEYS`. */
export function returnKeyByte(spec: string): number | null {
  return RETURN_KEYS[spec.trim().toLowerCase()] ?? null;
}

/**
 * The keyboard keys (kitty codes) that send a return key's byte with Ctrl: `]`, `\` or `4`, `^` or
 * `6`, `_` or `-` (a legacy terminal sends the byte itself for Ctrl+4 and Ctrl+6).
 */
const KITTY_CODES: Record<number, number[]> = { 0x1d: [93], 0x1c: [92, 52], 0x1e: [94, 54], 0x1f: [95, 45] };
/** Windows virtual-key codes for the same keys (VK_OEM_6 `]`, VK_OEM_5 `\`, `4`, `6`, VK_OEM_MINUS). */
const WIN32_VKS: Record<number, number[]> = { 0x1d: [0xdd], 0x1c: [0xdc, 0x34], 0x1e: [0x36], 0x1f: [0xbd] };

/** PgUp / PgDn: legacy `CSI 5~` / `CSI 6~`, kitty keypad codes, Windows virtual keys (VK_PRIOR, VK_NEXT). */
const KP_PAGE_UP = 57421;
const KP_PAGE_DOWN = 57422;
const VK_PRIOR = 0x21;
const VK_NEXT = 0x22;
/** The arrows' final bytes (`CSI A` … `CSI D`, `ESC O A` … `ESC O D`). */
const ARROWS: Record<string, "up" | "down" | "right" | "left"> = { A: "up", B: "down", C: "right", D: "left" };
/** Kitty's keypad arrows (`CSI 57417u` …, reported as keys of their own once an agent asks for kitty keys). */
const KITTY_KP_ARROWS: Record<number, "up" | "down" | "right" | "left"> = { 57417: "left", 57418: "right", 57419: "up", 57420: "down" };
/** Windows virtual keys VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN. */
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;

/**
 * A plain arrow (no modifier) as a CSI: legacy `CSI D` / `CSI 1D`, or kitty's `CSI 1;1D` with an
 * event type (1 press, 2 repeat; Caps/Num Lock allowed). A release (`:3`) or a modifier: null.
 */
function arrow(params: string, final: string): Key["name"] | null {
  const name = ARROWS[final];
  if (!name) return null;
  if (params === "" || params === "1") return name;
  const m = /^1;(\d+)(?::([12]))?$/.exec(params);
  return m && ((Number(m[1]) - 1) & ~LOCKS) === 0 ? name : null;
}

/**
 * Alt+← / Alt+→ as a CSI (`CSI 1;3D`, kitty's `CSI 1;3:1D` with an event type 1 press or 2 repeat;
 * locks allowed): Codex switches agent threads on them, so on an untouched line they are Gluon's to
 * drop (`route`). Another modifier or a release: null.
 */
function altArrow(params: string, final: string): Key["name"] | null {
  if (final !== "C" && final !== "D") return null;
  const m = /^1;(\d+)(?::([12]))?$/.exec(params);
  return m && ((Number(m[1]) - 1) & ~LOCKS) === ALT ? (final === "D" ? "alt-left" : "alt-right") : null;
}

/** Gluon's key for PgUp (`up`) or PgDn with exactly Shift (kitty modifier bits, locks off); null otherwise. */
function pageKey(up: boolean, m: number): Key["name"] | null {
  if (m === SHIFT) return up ? "scroll-up" : "scroll-down";
  return null;
}

const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/**
 * A paste whose end marker hasn't come after this long without input is over: the next key is read
 * as typed again, so a lost end marker can't swallow the return key and every later key.
 */
export const PASTE_IDLE_MS = 1000;
/**
 * A paste's end marker lost while the user goes on typing (no PASTE_IDLE_MS pause) mustn't swallow
 * the return key either (BUG-171). An open paste also ends when, after PASTE_KEY_GAP_MS without
 * input, a read is exactly the return key (a key pressed on its own: a paste's bytes come in
 * bursts), or any read comes once the paste is PASTE_MAX_MS old (no paste streams that long with
 * pauses). What was held goes on as the paste's last piece; the read is decoded as typed.
 */
export const PASTE_KEY_GAP_MS = 200;
export const PASTE_MAX_MS = 10_000;
/** Longer than this, an unterminated string sequence (OSC, DCS, …) is given up and passed on. */
const MAX_SEQ = 8192;

/** Kitty modifier bits (the value sent is 1 + these). */
const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const SUPER = 8;
const HYPER = 16;
const META = 32;
/** Caps Lock and Num Lock don't make a key a shortcut. */
const LOCKS = 64 | 128;

/** Windows control-key state bits. */
const W_RIGHT_ALT = 0x1;
const W_LEFT_ALT = 0x2;
const W_RIGHT_CTRL = 0x4;
const W_LEFT_CTRL = 0x8;
const W_SHIFT = 0x10;

const isPrintable = (cp: number) => cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp < 0xa0) && !(cp >= 0xe000 && cp <= 0xf8ff);

/** Mouse button-value bits (xterm). */
const M_SHIFT = 4;
const M_ALT = 8;
const M_CTRL = 16;
const M_MOTION = 32;
const M_WHEEL = 64;
const M_EXTRA = 128;
const WHEELS = ["up", "down", "left", "right"] as const;

/** A mouse report from its button value and cell; `release` as SGR says it (elsewhere: button 3 pressed with no motion or wheel). */
function mouseReport(code: number, x: number, y: number, encoding: MouseEncoding, sgrRelease: boolean): MouseReport {
  const low = code & 3;
  const wheel = code & M_WHEEL && !(code & M_EXTRA) ? WHEELS[low]! : null;
  const motion = (code & M_MOTION) !== 0;
  const release = encoding === "sgr" ? sgrRelease : low === 3 && !motion && !(code & (M_WHEEL | M_EXTRA));
  return {
    code,
    button: low + (code & M_WHEEL ? 4 : 0) + (code & M_EXTRA ? 8 : 0),
    x,
    y,
    release,
    motion,
    wheel,
    shift: (code & M_SHIFT) !== 0,
    alt: (code & M_ALT) !== 0,
    ctrl: (code & M_CTRL) !== 0,
    encoding,
  };
}

/** Largest value (button, column or row) each encoding carries; beyond it a report can't be written. */
const MOUSE_MAX: Record<MouseEncoding, number> = {
  sgr: Infinity,
  urxvt: Infinity,
  // One character each, value + 32, as UTF-8 (two bytes at most, mode 1005).
  utf8: 2047 - 32,
  // One byte each, value + 32. xterm goes up to 255, but bytes from 0x80 would reach the agent's PTY
  // as UTF-8 (two bytes, not one): only 7-bit values are written.
  x10: 0x7f - 32,
};

/**
 * `ev` again, in `encoding` (the one the agent asked for), at cell (`ev.x + dx`, `ev.y + dy`): the
 * bytes to write to the agent, or null when the cell is off the agent's screen (below 1) or the
 * encoding can't carry it (`MOUSE_MAX`). A release keeps its button in SGR; elsewhere it is button 3
 * (X10 doesn't say which), and an X10 release written as SGR is the left button's.
 */
export function encodeMouse(ev: MouseReport, encoding: MouseEncoding, dx: number, dy: number): string | null {
  const x = ev.x + dx;
  const y = ev.y + dy;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1) return null;
  let code = ev.code;
  const releaseBits = ev.release && !(code & (M_WHEEL | M_MOTION));
  if (encoding === "sgr") {
    if (releaseBits && ev.encoding !== "sgr" && (code & 3) === 3) code &= ~3;
    return `\x1b[<${code};${x};${y}${ev.release ? "m" : "M"}`;
  }
  if (releaseBits) code |= 3;
  const max = MOUSE_MAX[encoding];
  if (code > max || x > max || y > max) return null;
  if (encoding === "urxvt") return `\x1b[${code + 32};${x};${y}M`;
  return `\x1b[M${String.fromCodePoint(code + 32, x + 32, y + 32)}`;
}

/**
 * A terminal's answer to a query, never a key: anything with a private marker (`CSI ? … c` device
 * attributes, `CSI > … c`, `CSI ? … u` kitty flags, `CSI ? … $y`, `CSI ? … R`, `CSI ? 997;… n`),
 * `CSI … $y` (mode report), `CSI … n` (status), `CSI … t` (window reports) and `CSI row;col R`
 * (cursor position). Except `CSI 1;2R` … `CSI 1;16R`: xterm sends Shift/Alt/Ctrl+F3 that way, the
 * same bytes as the cursor at row 1, column 2–16, so it stays a key (unsure: forward it). Kitty
 * sends F3 as `CSI 13~` for this reason.
 */
function isReply(params: string, final: string): boolean {
  if (/^[?>=]/.test(params)) return true;
  if (final === "y") return /^\d*(;\d*)*\$$/.test(params);
  if (final === "n") return /^\d+$/.test(params);
  if (final === "t") return /^\d+(;\d+)*$/.test(params);
  if (final !== "R") return false;
  const cpr = /^(\d+);(\d+)$/.exec(params);
  return !!cpr && !(Number(cpr[1]) === 1 && Number(cpr[2]) >= 2 && Number(cpr[2]) <= 16);
}

/** A CSI sequence that isn't kitty, win32-input-mode or a plain arrow: `params` with its intermediates. */
function csi(params: string, final: string, raw: string): Key {
  // SGR mouse: CSI < b;x;y M (press, motion, wheel) or m (release).
  if (params[0] === "<") {
    const m = /^<(\d+);(\d+);(\d+)$/.exec(params);
    if (m && (final === "M" || final === "m") && Number(m[2]) >= 1 && Number(m[3]) >= 1)
      return { name: "mouse", raw, mouse: mouseReport(Number(m[1]), Number(m[2]), Number(m[3]), "sgr", final === "m") };
    return { name: "other", raw };
  }
  // urxvt mouse (mode 1015): CSI b+32;x;y M.
  const urxvt = final === "M" ? /^(\d+);(\d+);(\d+)$/.exec(params) : null;
  if (urxvt && Number(urxvt[1]) >= 32 && Number(urxvt[2]) >= 1 && Number(urxvt[3]) >= 1)
    return { name: "mouse", raw, mouse: mouseReport(Number(urxvt[1]) - 32, Number(urxvt[2]), Number(urxvt[3]), "urxvt", false) };
  if (params === "" && (final === "I" || final === "O")) return { name: "focus", raw, focus: final === "I" ? "in" : "out" };
  // PgUp/PgDn with modifiers: `CSI 5;mods~`, `CSI 6;mods~`; kitty adds `:event` (1 press, 2 repeat,
  // 3 release). A release goes on as `other`, like the return key's kitty release.
  const page = final === "~" ? /^([56]);(\d+)(?::(\d+))?$/.exec(params) : null;
  if (page && page[3] !== "3") {
    const name = pageKey(page[1] === "5", (Number(page[2]) - 1) & ~LOCKS);
    if (name) return { name, raw };
  }
  // Ctrl/Shift/Alt + Enter or Tab as xterm's modifyOtherKeys reports them, other keys: not keys
  // Gluon reads.
  return { name: isReply(params, final) ? "reply" : "other", raw };
}

/** A VT decoder, and whether it is inside a paste or holds the start of a sequence. */
interface VtDecoder extends KeyDecoder {
  wait(): number;
  pasting(): boolean;
  /** Ends a paste idle for `PASTE_IDLE_MS` (its held bytes as the paste's last piece). */
  expire(): Key[];
  /** The return key came on its own: ends a paste idle for `PASTE_KEY_GAP_MS` (BUG-171). */
  closeForKey(): Key[];
  holding(): boolean;
}

function vtDecoder(returnKey: string, now: () => number): VtDecoder {
  const rk = returnKeyByte(returnKey) ?? DEFAULT_RETURN;
  const rkChar = String.fromCharCode(rk);
  let buf = "";
  let inPaste = false;
  /** The paste's opening bytes, until its first content is emitted. */
  let pasteOpen = "";
  /** When the open paste last had input, and when it began. */
  let pasteAt = 0;
  let pasteStart = 0;

  function expire(): Key[] {
    if (!inPaste || now() - pasteAt < PASTE_IDLE_MS) return [];
    return close();
  }

  /** Ends the open paste: what it holds goes on as its last piece. */
  function close(): Key[] {
    inPaste = false;
    const rest = pasteOpen + buf;
    const text = buf;
    buf = "";
    pasteOpen = "";
    return rest ? [{ name: "text", raw: rest, text, pasted: true }] : [];
  }

  /** A control byte (or DEL) outside any sequence. */
  function control(ch: string): Key {
    if (ch === rkChar) return { name: "return-key", raw: ch };
    if (ch === "\r") return { name: "enter", raw: ch };
    if (ch === "\x7f" || ch === "\b") return { name: "backspace", raw: ch };
    if (ch === "\t") return { name: "tab", raw: ch };
    return { name: "other", raw: ch };
  }

  /** `CSI <code>[:shifted[:base]][;mods[:event]][;text] u`. */
  function kitty(params: string, raw: string): Key {
    const [codes = "", modField = "", textField = ""] = params.split(";");
    const [code = NaN, shifted] = codes.split(":").map((n) => (n === "" ? NaN : Number(n)));
    const [modsRaw, eventRaw] = modField.split(":");
    const mods = (modsRaw ? Number(modsRaw) : 1) - 1;
    const event = eventRaw ? Number(eventRaw) : 1;
    if (!Number.isFinite(code) || !Number.isFinite(mods) || event === 3) return { name: "other", raw };
    const m = mods & ~LOCKS;
    if (code === KP_PAGE_UP || code === KP_PAGE_DOWN) {
      const page = pageKey(code === KP_PAGE_UP, m);
      if (page) return { name: page, raw };
    }
    if (m & CTRL && !(m & (ALT | SUPER | HYPER | META)) && (KITTY_CODES[rk]!.includes(code) || (shifted !== undefined && KITTY_CODES[rk]!.includes(shifted))))
      return { name: "return-key", raw };
    if (m === 0) {
      if (KITTY_KP_ARROWS[code]) return { name: KITTY_KP_ARROWS[code]!, raw };
      if (code === 13) return { name: "enter", raw };
      if (code === 9) return { name: "tab", raw };
      if (code === 27) return { name: "escape", raw };
      if (code === 127 || code === 8) return { name: "backspace", raw };
    }
    if ((m & ~SHIFT) === 0) {
      const fromText = textField ? textField.split(":").map(Number).filter(Number.isFinite) : [];
      const cps = fromText.length ? fromText : [m & SHIFT && shifted !== undefined && Number.isFinite(shifted) ? shifted : code];
      if (cps.every(isPrintable)) return { name: "text", raw, text: String.fromCodePoint(...cps) };
    }
    return { name: "other", raw };
  }

  /**
   * win32-input-mode: `CSI Vk;Sc;Uc;Kd;Cs;Rc _`. Key-ups are not keys; the key-up of a key Gluon
   * always consumes (the return key) or may consume (plain and Alt ←/→) is dropped, so the
   * agent never gets half a key.
   */
  function win32(params: string, raw: string): Key {
    const [vk = 0, , uc = 0, kd = 0, cs = 0] = params.split(";").map((n) => (n === "" ? 0 : Number(n)));
    const ctrl = (cs & (W_LEFT_CTRL | W_RIGHT_CTRL)) !== 0;
    // AltGr is Ctrl + right Alt: a character typed with it is text, not a shortcut.
    const alt = (cs & (W_LEFT_ALT | W_RIGHT_ALT)) !== 0 && !(ctrl && cs & W_RIGHT_ALT);
    const isReturn = uc === rk || (ctrl && !alt && WIN32_VKS[rk]!.includes(vk) && (uc === 0 || uc === rk));
    const page = vk === VK_PRIOR || vk === VK_NEXT ? pageKey(vk === VK_PRIOR, (alt ? ALT : 0) | (ctrl ? CTRL : 0) | (cs & W_SHIFT ? SHIFT : 0)) : null;
    const plain = !ctrl && !alt && !(cs & W_SHIFT);
    const leftRight = plain && (vk === VK_LEFT || vk === VK_RIGHT);
    const altLeftRight = alt && !ctrl && !(cs & W_SHIFT) && (vk === VK_LEFT || vk === VK_RIGHT);
    const consumed = isReturn || leftRight || altLeftRight;
    if (!kd) return consumed ? { name: "other", raw: "" } : { name: "other", raw };
    if (isReturn) return { name: "return-key", raw };
    if (page) return { name: page, raw };
    if (altLeftRight) return { name: vk === VK_LEFT ? "alt-left" : "alt-right", raw };
    // Shift/Ctrl/Alt + Enter inserts a newline in most agents: not the Enter that runs a line.
    if (uc === 13) return { name: ctrl || alt || cs & W_SHIFT ? "other" : "enter", raw };
    if (uc === 9) return { name: "tab", raw };
    if (uc === 27) return { name: "escape", raw };
    if (uc === 8 || uc === 0x7f) return { name: "backspace", raw };
    if (vk === VK_UP && !ctrl && !alt) return { name: "up", raw };
    if (vk === VK_DOWN && !ctrl && !alt) return { name: "down", raw };
    if (leftRight) return { name: vk === VK_LEFT ? "left" : "right", raw };
    if (isPrintable(uc) && !alt && !(ctrl && uc < 0x80 && !(cs & W_RIGHT_ALT))) return { name: "text", raw, text: String.fromCodePoint(uc) };
    return { name: "other", raw };
  }

  /**
   * One escape sequence at the start of `s` (which starts with ESC): the key and its length, or
   * null when `s` ends before the sequence does.
   */
  function escape(s: string): { key: Key; len: number; alt?: true } | null {
    if (s.length < 2) return null;
    const c = s[1]!;
    if (c === "[") {
      // X10 (or UTF-8, mode 1005) mouse: CSI M and three characters.
      if (s[2] === "M") {
        if (s.length < 6) return null;
        const [b, x, y] = [3, 4, 5].map((i) => s.charCodeAt(i) - 32) as [number, number, number];
        const raw = s.slice(0, 6);
        // A byte from 0x80 (X10 past column 95) isn't UTF-8: it arrives as U+FFFD, its value lost.
        if (b < 0 || x < 1 || y < 1 || raw.slice(3).includes("�")) return { key: { name: "other", raw }, len: 6 };
        return { key: { name: "mouse", raw, mouse: mouseReport(b, x, y, Math.max(b, x, y) > 255 - 32 ? "utf8" : "x10", false) }, len: 6 };
      }
      let i = 2;
      while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x3f) i++;
      while (i < s.length && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x2f) i++;
      if (i >= s.length) return s.length > MAX_SEQ ? { key: { name: "other", raw: s }, len: s.length } : null;
      const final = s[i]!;
      const len = i + 1;
      const raw = s.slice(0, len);
      const params = s.slice(2, i);
      const fc = final.charCodeAt(0);
      // Not a valid final byte: pass the ESC [ on as is, the rest is read again.
      if (fc < 0x40 || fc > 0x7e) return { key: { name: "other", raw: s.slice(0, 2) }, len: 2 };
      if (final === "u" && /^[\d:;]*$/.test(params)) return { key: kitty(params, raw), len };
      if (final === "_" && /^[\d;]*$/.test(params)) return { key: win32(params, raw), len };
      const arrowKey = arrow(params, final);
      if (arrowKey) return { key: { name: arrowKey, raw }, len };
      const altKey = altArrow(params, final);
      if (altKey) return { key: { name: altKey, raw }, len };
      return { key: csi(params, final, raw), len };
    }
    if (c === "O") {
      if (s.length < 3) return null;
      const raw = s.slice(0, 3);
      return { key: { name: ARROWS[raw[2]!] ?? (raw === "\x1bOM" ? "enter" : "other"), raw }, len: 3 };
    }
    if (c === "]" || c === "P" || c === "_" || c === "^" || c === "X") {
      // String sequences (OSC, DCS, APC, PM, SOS), up to BEL (OSC) or ST: only terminals send
      // them. (Alt+] or Alt+P alone starts one too: it never ends, and goes on as `other` at the
      // caller's flush.)
      for (let i = 2; i < s.length; i++) {
        if (s[i] === "\x07" && c === "]") return { key: { name: "reply", raw: s.slice(0, i + 1) }, len: i + 1 };
        if (s[i] === ESC) {
          if (i + 1 >= s.length) return null;
          if (s[i + 1] === "\\") return { key: { name: "reply", raw: s.slice(0, i + 2) }, len: i + 2 };
        }
      }
      return s.length > MAX_SEQ ? { key: { name: "other", raw: s }, len: s.length } : null;
    }
    if (c === ESC) {
      // ESC ESC is Escape, then what follows.
      return { key: { name: "escape", raw: ESC }, len: 1 };
    }
    // Alt + a key: ESC and its bytes. Alt + the return key is still not the return key.
    const cp = s.codePointAt(1)!;
    const len = 1 + (cp > 0xffff ? 2 : 1);
    return { key: { name: "other", raw: s.slice(0, len) }, len, alt: true };
  }

  /** One character outside any sequence (`ch`: one code point, not ESC). */
  function plain(ch: string): Key {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) return control(ch);
    return isPrintable(cp) ? { name: "text", raw: ch, text: ch } : { name: "other", raw: ch };
  }

  /** Paste content up to its end marker (or up to what might be the start of it); leaves the rest in `buf`. */
  function paste(out: Key[]) {
    const end = buf.indexOf(PASTE_END);
    let content: string;
    let closing = "";
    if (end >= 0) {
      content = buf.slice(0, end);
      closing = PASTE_END;
      buf = buf.slice(end + PASTE_END.length);
      inPaste = false;
    } else {
      // Keep a trailing partial end marker for the next chunk.
      let keep = 0;
      for (let k = Math.min(PASTE_END.length - 1, buf.length); k > 0; k--)
        if (PASTE_END.startsWith(buf.slice(buf.length - k))) {
          keep = k;
          break;
        }
      content = buf.slice(0, buf.length - keep);
      buf = buf.slice(buf.length - keep);
    }
    if (content || closing || pasteOpen) out.push({ name: "text", raw: pasteOpen + content + closing, text: content, pasted: true });
    pasteOpen = "";
  }

  /** `chunk` is the return key and nothing else (in any encoding). */
  function isReturnKey(chunk: string): boolean {
    if (chunk === rkChar) return true;
    if (chunk[0] !== ESC) return false;
    const seq = escape(chunk);
    return !!seq && seq.len === chunk.length && seq.key.name === "return-key";
  }

  function feed(chunk: string): Key[] {
    const out: Key[] = expire();
    // A lost end marker: the return key pressed on its own, or a paste that has gone on too long.
    if (inPaste && now() - pasteAt >= PASTE_KEY_GAP_MS && (isReturnKey(chunk) || now() - pasteStart >= PASTE_MAX_MS)) out.push(...close());
    // A lone ESC left from an earlier read: a key after it (within ESC_TIMEOUT_MS) reads as Alt+key,
    // but the Esc key was pressed on its own first (BUG-260).
    let lone = !inPaste && buf === ESC;
    buf += chunk;
    while (buf.length) {
      const carried = lone;
      lone = false;
      if (inPaste) {
        paste(out);
        if (inPaste) break;
        continue;
      }
      const ch = buf[0]!;
      if (ch === ESC) {
        if (buf.startsWith(PASTE_START)) {
          buf = buf.slice(PASTE_START.length);
          inPaste = true;
          pasteOpen = PASTE_START;
          pasteStart = now();
          continue;
        }
        if (PASTE_START.startsWith(buf)) break;
        const seq = escape(buf);
        if (!seq) break;
        out.push(carried && seq.alt ? { ...seq.key, apart: [{ name: "escape", raw: ESC }, plain(buf.slice(1, seq.len))] } : seq.key);
        buf = buf.slice(seq.len);
        continue;
      }
      const len = buf.codePointAt(0)! > 0xffff ? 2 : 1;
      out.push(plain(buf.slice(0, len)));
      buf = buf.slice(len);
    }
    if (inPaste) pasteAt = now();
    return out;
  }

  /**
   * What is left after `ESC_TIMEOUT_MS` without more input: a lone ESC is the Esc key; an unfinished
   * sequence goes on as it is. An open paste waits for its end (or `PASTE_IDLE_MS`, at the next key).
   */
  function flush(): Key[] {
    if (inPaste || !buf) return [];
    // Escapes in a row (the start of a sequence that didn't come): Escape, then the rest as usual.
    const out: Key[] = [];
    while (buf.length > 1 && buf[1] === ESC) {
      out.push({ name: "escape", raw: ESC });
      buf = buf.slice(1);
    }
    const rest = buf;
    buf = "";
    if (rest === ESC) return [...out, { name: "escape", raw: ESC }];
    // ESC + an unfinished sequence: the ESC was the Esc key only if nothing followed it.
    return [...out, { name: "other", raw: rest }];
  }

  /** How long `flush` should wait for more: longer for a CSI already under way (BUG-170). */
  function wait(): number {
    if (inPaste) return ESC_TIMEOUT_MS;
    const seq = buf.replace(/^\x1b+(?=\x1b\[)/, "");
    return seq.startsWith("\x1b[") && seq.length > 2 ? CSI_TIMEOUT_MS : ESC_TIMEOUT_MS;
  }

  const closeForKey = () => (inPaste && now() - pasteAt >= PASTE_KEY_GAP_MS ? close() : []);

  return { feed, flush, expire, closeForKey, wait, pasting: () => inPaste, holding: () => buf.length > 0 };
}

const WIN32_KEY = /^\x1b\[(\d*);(\d*);(\d*);(\d*);(\d*);(\d*)_$/;
/** One or more win32-input-mode sequences and nothing else. */
const WIN32_KEYS = /^(?:\x1b\[\d*;\d*;\d*;\d*;\d*;\d*_)+$/;

/**
 * A key let go, not pressed: a win32-input-mode key-up (or the empty key a dropped one leaves) or a
 * kitty release (`:3`). It changes nothing the user typed.
 */
export function isKeyUp(k: Key): boolean {
  if (k.raw === "") return true;
  const w = WIN32_KEY.exec(k.raw);
  if (w) return Number(w[4] || 0) === 0;
  return /^\x1b\[\d*(?::\d*)*;\d+:3(?:;[\d:]*)?[u~A-Z]$/.test(k.raw);
}

/**
 * A modifier pressed on its own, not a key anything reads: win32-input-mode's Shift / Ctrl / Alt /
 * Caps Lock down (no character), kitty's modifier keys (`CSI 57441..57454 u`, once the agent asks
 * for every key). It changes nothing the user typed, and doesn't pick in the home key's prefix.
 */
export function isModifierOnly(k: Key): boolean {
  if (k.raw !== "" && asVt(k) === "") return true;
  return /^\x1b\[5744[1-9](?::\d*)*(?:;[\d:]*)*u$|^\x1b\[5745[0-4](?::\d*)*(?:;[\d:]*)*u$/.test(k.raw);
}

/**
 * The user's input as keys. In win32-input-mode (which Gluon's own console turns on once the
 * agent's ConPTY asks for it) a terminal that speaks plain VT (SSH, the e2e harness, terminals
 * without win32-input-mode) has every character of a sequence conhost didn't read as a key — an
 * arrow, a kitty key, a paste's brackets — sent as its own key-down with no virtual key. Those
 * characters are put back together and read as VT, so `ESC [ B` is Down, one key forwarded in one
 * write (conhost does the same for a VT client), never an Esc and "[B" (BUG-153). A paste's text in
 * between (real keys) belongs to the paste.
 */
export function createKeyDecoder(returnKey: string, now: () => number = Date.now): KeyDecoder {
  const outer = vtDecoder(returnKey, now);
  const synth = vtDecoder(returnKey, now);
  /** The win32 sequences behind each character `synth` holds (key-ups go with the key before). */
  let raws: string[] = [];
  /** Characters (and their sequences) not yet fed to `synth`. */
  let chars = "";

  /** `synth`'s keys with their exact bytes: the sequences of the characters each one used. */
  const mapped = (keys: Key[]) => keys.map((k) => ({ ...k, raw: raws.splice(0, k.raw.length).join("") }));
  function drain(): Key[] {
    if (!chars) return [];
    const c = chars;
    chars = "";
    return mapped(synth.feed(c));
  }

  /** Adjacent paste pieces as one key (one write to the agent). */
  function joined(keys: Key[]): Key[] {
    const out: Key[] = [];
    for (const k of keys) {
      const last = out.at(-1);
      if (k.pasted && last?.pasted) out[out.length - 1] = { ...last, raw: last.raw + k.raw, text: (last.text ?? "") + (k.text ?? "") };
      else out.push(k);
    }
    return out;
  }

  function feed(chunk: string): Key[] {
    const out: Key[] = mapped(synth.expire());
    for (const k of outer.feed(chunk)) {
      const m = WIN32_KEY.exec(k.raw);
      const vk = Number(m?.[1] || 0);
      const uc = Number(m?.[3] || 0);
      const down = Number(m?.[4] || 0) !== 0;
      if (m && down && uc && vk === 0) {
        chars += String.fromCharCode(uc);
        raws.push(k.raw);
        continue;
      }
      out.push(...drain());
      // The return key pressed on its own (a real key, not one of the paste's characters) after a
      // pause ends a paste whose end marker was lost (BUG-171).
      if (m && down && k.name === "return-key" && synth.pasting()) {
        out.push(...mapped(synth.closeForKey()));
        if (!synth.pasting()) {
          out.push(k);
          continue;
        }
      }
      if (m && synth.pasting()) {
        // A paste's text, typed by the terminal as real keys: part of the paste.
        if (down && uc) {
          chars += String.fromCharCode(uc);
          raws.push(k.raw);
        } else if (raws.length) raws[raws.length - 1] += k.raw;
        else out.push({ name: "text", raw: k.raw, text: "", pasted: true });
        continue;
      }
      // The key-up of a character `synth` still holds goes with it.
      if (m && !down && raws.length) {
        raws[raws.length - 1] += k.raw;
        continue;
      }
      // Anything else ends what `synth` held (an unfinished sequence goes on as it is).
      if (synth.holding() && !synth.pasting()) out.push(...mapped(synth.flush()));
      out.push(k);
    }
    out.push(...drain());
    return joined(out);
  }

  function flush(): Key[] {
    return joined([...drain(), ...mapped(synth.flush()), ...outer.flush()]);
  }

  return { feed, flush, wait: () => Math.max(outer.wait(), synth.wait()) };
}

/** Virtual keys with no character that VT sends as a CSI: final byte, or the number before `~`. */
const VK_CSI: Record<number, string> = { 0x25: "D", 0x26: "A", 0x27: "C", 0x28: "B", 0x24: "H", 0x23: "F" };
const VK_TILDE: Record<number, number> = { 0x21: 5, 0x22: 6, 0x2d: 2, 0x2e: 3, 0x74: 15, 0x75: 17, 0x76: 18, 0x77: 19, 0x78: 20, 0x79: 21, 0x7a: 23, 0x7b: 24 };
/** F1–F4: SS3 P–S. */
const VK_SS3: Record<number, string> = { 0x70: "P", 0x71: "Q", 0x72: "R", 0x73: "S" };
const VK_BACK = 0x08;
const VK_TAB = 0x09;
const VK_RETURN = 0x0d;

/** One win32-input-mode sequence as plain VT: nothing for a key-up or a key with no character (Shift, Ctrl, Caps Lock, …). */
function win32AsVt(vk: number, uc: number, kd: number, cs: number, rc: number): string {
  if (!kd) return "";
  // A character with no virtual key: a VT byte conhost didn't read as a key (BUG-153).
  if (!vk) return uc ? String.fromCharCode(uc) : "";
  const ctrl = (cs & (W_LEFT_CTRL | W_RIGHT_CTRL)) !== 0;
  const altGr = ctrl && (cs & W_RIGHT_ALT) !== 0;
  const alt = (cs & (W_LEFT_ALT | W_RIGHT_ALT)) !== 0 && !altGr;
  const shift = (cs & W_SHIFT) !== 0;
  const mods = 1 + (shift ? SHIFT : 0) + (alt ? ALT : 0) + (ctrl && !altGr ? CTRL : 0);
  let s: string;
  if (VK_CSI[vk]) s = mods > 1 ? `\x1b[1;${mods}${VK_CSI[vk]}` : `\x1b[${VK_CSI[vk]}`;
  else if (VK_TILDE[vk]) s = mods > 1 ? `\x1b[${VK_TILDE[vk]};${mods}~` : `\x1b[${VK_TILDE[vk]}~`;
  else if (VK_SS3[vk]) s = mods > 1 ? `\x1b[1;${mods}${VK_SS3[vk]}` : `\x1bO${VK_SS3[vk]}`;
  else if (vk === VK_BACK) s = (alt ? ESC : "") + (ctrl ? "\b" : "\x7f");
  else if (vk === VK_TAB && shift) s = "\x1b[Z";
  // Enter with Shift or Ctrl (VT has no byte for them): xterm's modifyOtherKeys, which `forInk` turns into kitty's form, as a VT
  // terminal's Shift+Enter is read (BUG-237). Its character (13, or 10 with Ctrl) dropped the modifier: Shift+Enter sent the draft (BUG-655).
  // Alt alone stays ESC + Enter, as VT sends it.
  else if (vk === VK_RETURN && (shift || (ctrl && !altGr))) s = `\x1b[27;${mods};13~`;
  else if (!uc) return "";
  else {
    // Ctrl + a letter the terminal reported as the letter: its control byte, as VT sends it.
    const letter = ctrl && !altGr && /^[a-z]$/i.test(String.fromCharCode(uc));
    s = (alt ? ESC : "") + (letter ? String.fromCharCode(uc & 0x1f) : String.fromCharCode(uc));
  }
  return s.repeat(Math.max(1, rc));
}

/**
 * The key as a reader of plain VT gets it (Gluon's home view: Ink knows no win32-input-mode). Each
 * win32-input-mode sequence becomes its VT bytes — a character (Alt: ESC before it), Enter (with Shift
 * or Ctrl: modifyOtherKeys' `CSI 27;mods;13~`, which `forInk` turns into kitty's form), Tab,
 * Esc, Backspace as DEL, the CSI of an arrow, Home/End, PgUp/PgDn, Insert/Delete, F1–F12 — and a
 * key-up or a key with no character (Shift, Ctrl, Alt, Caps Lock, …) nothing (BUG-208). A key
 * that isn't win32-input-mode sequences only (VT, a VT paste) is left as it is.
 */
export function asVt(k: Key): string {
  if (!WIN32_KEYS.test(k.raw)) return k.raw;
  return k.raw.replace(/\x1b\[(\d*);(\d*);(\d*);(\d*);(\d*);(\d*)_/g, (_m, vk, _sc, uc, kd, cs, rc) =>
    win32AsVt(Number(vk || 0), Number(uc || 0), Number(kd || 0), Number(cs || 0), Number(rc || 1)),
  );
}

/**
 * The key as Gluon's home view (Ink) reads it: `asVt`, and a key xterm's modifyOtherKeys reports
 * (`CSI 27;mods;code~`: Shift+Enter, Ctrl+Tab, …), which Ink doesn't know and would type as
 * `[27;2;13~`, in the kitty protocol's form (`CSI code;mods u`), which it reads: Shift+Enter is a
 * new line (BUG-237). The Esc key (a lone ESC, already told apart from a sequence here) goes in
 * kitty's form too: Ink would wait 20 ms for more after a lone ESC and read a key in that time as
 * Alt+key, so `a` right after Esc was lost. A paste is left as it is. A paste's end marker with no
 * paste before it (a terminal glitch, an end the user's own text carried) is nothing: Ink would type
 * it as `[201~` (BUG-656); an agent still gets it as it is, being the user's byte.
 */
export function forInk(k: Key): string {
  const vt = asVt(k);
  if (k.pasted) return vt;
  if (vt === PASTE_END) return "";
  if (vt === "\x1b") return "\x1b[27u";
  if (k.name !== "other") return vt;
  // One or more (a win32 key's repeat count repeats it), each in kitty's form.
  return /^(?:\x1b\[27;\d+;\d+~)+$/.test(vt) ? vt.replace(/\x1b\[27;(\d+);(\d+)~/g, "\x1b[$2;$1u") : vt;
}

/**
 * What a pasted key writes into an agent that hasn't turned bracketed paste on (Gluon keeps it on
 * on the real terminal, so a paste is never read as keys: BUG-172): its bytes without the markers,
 * the user's bytes otherwise unchanged. A key whose bytes aren't the markers around its text
 * (win32-input-mode sequences) goes as it is.
 */
export function unbracketed(k: Key): string {
  if (!k.pasted || k.text === undefined) return k.raw;
  const open = k.raw.startsWith(PASTE_START) ? PASTE_START : "";
  const close = k.raw.endsWith(PASTE_END) ? PASTE_END : "";
  return open + k.text + close === k.raw ? k.text : k.raw;
}
