/**
 * What a user can do to Gluon, as data: one vocabulary for the e2e scenarios, the coverage matrix
 * (`test/fixtures/gluon-matrix.ts`), generated and random runs, and replays. `bytesOf` gives the
 * bytes a terminal would send for an action; `apply` does it to an `App` and waits for the answer.
 *
 * Keys are legacy VT bytes (what xterm sends with no keyboard protocol asked for), plus the kitty
 * protocol's forms (`kitty…`), which an agent gets once it asked for them.
 */
import { encodeMouse } from "../../src/pty/keys.ts";
import type { MouseReport } from "../../src/pty/types.ts";
import type { App } from "./harness.ts";
import { SLOW } from "./harness.ts";

/** Every named key, as the terminal sends it. */
export const KEYS = {
  // Printable samples: a letter, a space, the slash a command starts with, keys Gluon's views read.
  a: "a",
  x: "x",
  space: " ",
  slash: "/",
  q: "q",
  y: "y",
  n: "n",
  question: "?",
  percent: "%",
  digit1: "1",
  digit2: "2",
  digit9: "9",
  digit0: "0",
  /** Outside ASCII: two bytes in UTF-8, one cell. */
  eAcute: "é",
  /** A wide character: two cells. */
  wide: "你",
  enter: "\r",
  esc: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  tab: "\t",
  shiftTab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  /** The arrows in application mode (DECCKM), as a terminal sends them when an agent asked for it. */
  ssUp: "\x1bOA",
  ssLeft: "\x1bOD",
  shiftLeft: "\x1b[1;2D",
  shiftRight: "\x1b[1;2C",
  /** Alt+←/→: dropped by Gluon on an untouched line in a session, the agent's otherwise. */
  altLeft: "\x1b[1;3D",
  altRight: "\x1b[1;3C",
  ctrlLeft: "\x1b[1;5D",
  ctrlRight: "\x1b[1;5C",
  home: "\x1b[H",
  end: "\x1b[F",
  pgup: "\x1b[5~",
  pgdn: "\x1b[6~",
  shiftPgup: "\x1b[5;2~",
  shiftPgdn: "\x1b[6;2~",
  /** Not Gluon's any more (issue #47): the agent gets them as typed. */
  altPgup: "\x1b[5;3~",
  altPgdn: "\x1b[6;3~",
  ctrlPgup: "\x1b[5;5~",
  ctrlA: "\x01",
  ctrlC: "\x03",
  ctrlD: "\x04",
  ctrlE: "\x05",
  ctrlJ: "\n",
  ctrlO: "\x0f",
  ctrlT: "\x14",
  ctrlP: "\x10",
  ctrlU: "\x15",
  ctrlW: "\x17",
  /** Shift+Enter as xterm's modifyOtherKeys reports it (a plain terminal sends Enter's `\r`). */
  shiftEnter: "\x1b[27;2;13~",
  altEnter: "\x1b\r",
  /** The four keys `handoff.key` may name (`RETURN_KEYS`); Ctrl+\ is the default. */
  ctrlBackslash: "\x1c",
  ctrlBracket: "\x1d",
  ctrlCaret: "\x1e",
  ctrlUnderscore: "\x1f",
  kittyA: "\x1b[97u",
  kittyEnter: "\x1b[13u",
  kittyShiftEnter: "\x1b[13;2u",
  kittyEsc: "\x1b[27u",
  kittyBackspace: "\x1b[127u",
  kittyTab: "\x1b[9u",
  kittyUp: "\x1b[1;1A",
  kittyDown: "\x1b[1;1B",
  kittyRight: "\x1b[1;1C",
  kittyLeft: "\x1b[1;1D",
  /** An arrow's release (event 3): never a key Gluon acts on. */
  kittyLeftRelease: "\x1b[1;1:3D",
  kittyCtrlC: "\x1b[99;5u",
  kittyCtrlBackslash: "\x1b[92;5u",
} as const;

/** A named key (`KEYS`). Not the decoder's `KeyName` (`src/pty/types.ts`): what a key is once read. */
export type KeyName = keyof typeof KEYS;

/**
 * The terminal's own answers, arriving late (after the query's wait, or to an agent's query):
 * never keys. The background colour (dark: BEL-terminated; light: ST), device attributes, a
 * cursor position, the kitty keyboard flags.
 */
export const REPLIES = {
  osc11: "\x1b]11;rgb:0c0c/0c0c/0c0c\x07",
  osc11Light: "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
  da1: "\x1b[?62;22c",
  cpr: "\x1b[12;40R",
  kittyFlags: "\x1b[?0u",
} as const;

/** The default `handoff.key` (Ctrl+\): in a session the prefix of the keys that switch or go home. */
export const HOME_KEY = KEYS.ctrlBackslash;
/** Going home from a session: the home key, then the home key again (`app.press(...HOME_TWICE)`). */
export const HOME_TWICE = [HOME_KEY, HOME_KEY] as const;

export type MouseOp = "press" | "release" | "drag" | "click" | "wheel";
export type MouseButton = "left" | "middle" | "right" | "up" | "down";
/** How the terminal reports the mouse (`sgr-pixels`: SGR with the coordinates as given, pixels). */
export type MouseEncodingName = "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";

/**
 * One thing a user does. Mouse cells are 1-based, as the terminal sends them; `drag` presses at
 * (x, y), moves to `to` and releases there, `click` presses and releases, `wheel` is one notch
 * (button `up` or `down`). `reply`: the terminal's late answer to a query (`REPLIES`). `wait` is a
 * pause in ms (scaled by `SLOW`), the only bare sleep.
 */
export type Action =
  | { key: KeyName }
  | { text: string }
  | { paste: string }
  | { mouse: { op: MouseOp; button: MouseButton; x: number; y: number; to?: { x: number; y: number } } }
  | { resize: { cols: number; rows: number } }
  | { focus: "in" | "out" }
  | { signal: "SIGTERM" | "SIGHUP" | "SIGINT" }
  | { reply: keyof typeof REPLIES }
  | { wait: number };

const BUTTON: Record<MouseButton, number> = { left: 0, middle: 1, right: 2, up: 64, down: 65 };
/** Motion (xterm's button-value bit 32). */
const MOTION = 32;

/** One mouse report's bytes; null when the encoding can't carry it (X10 past column 95). */
function report(code: number, x: number, y: number, release: boolean, encoding: MouseEncodingName): string | null {
  const ev: MouseReport = { code, button: code & 3, x, y, release, motion: (code & MOTION) !== 0, wheel: null, shift: false, alt: false, ctrl: false, encoding: "sgr" };
  return encodeMouse(ev, encoding === "sgr-pixels" ? "sgr" : encoding, 0, 0);
}

/**
 * The bytes a terminal sends for a mouse action, one string per report (a drag is a press, a
 * motion and a release, which reach the program in separate reads).
 */
export function mouseReports(m: Extract<Action, { mouse: unknown }>["mouse"], encoding: MouseEncodingName = "sgr"): string[] {
  const code = BUTTON[m.button];
  const to = m.to ?? { x: m.x, y: m.y };
  const parts: [number, number, number, boolean][] =
    m.op === "press" || m.op === "wheel"
      ? [[code, m.x, m.y, false]]
      : m.op === "release"
        ? [[code, m.x, m.y, true]]
        : m.op === "click"
          ? [[code, m.x, m.y, false], [code, m.x, m.y, true]]
          : [[code, m.x, m.y, false], [code | MOTION, to.x, to.y, false], [code, to.x, to.y, true]];
  return parts.map(([c, x, y, release]) => {
    const bytes = report(c, x, y, release, encoding);
    if (bytes === null) throw new Error(`${encoding} can't carry a report at ${x},${y}`);
    return bytes;
  });
}

/** Bytes for a focus report. */
export const FOCUS = { in: "\x1b[I", out: "\x1b[O" } as const;

/**
 * The bytes a terminal sends for `action` (a paste bracketed, as Gluon asks the terminal to);
 * resizes, signals and waits send none.
 */
export function bytesOf(action: Action, encoding: MouseEncodingName = "sgr"): string {
  if ("key" in action) return KEYS[action.key];
  if ("text" in action) return action.text;
  if ("paste" in action) return `\x1b[200~${action.paste}\x1b[201~`;
  if ("mouse" in action) return mouseReports(action.mouse, encoding).join("");
  if ("focus" in action) return FOCUS[action.focus];
  if ("reply" in action) return REPLIES[action.reply];
  return "";
}

/** A left-button press at a 1-based cell, SGR: what Gluon acts on (a tab, `◆ gluon`, the agent's click). */
export const click = (x: number, y: number) => bytesOf({ mouse: { op: "press", button: "left", x, y } });
/** One wheel notch up at a 1-based cell, SGR. */
export const wheelUp = (x: number, y: number) => bytesOf({ mouse: { op: "wheel", button: "up", x, y } });
/** One wheel notch down at a 1-based cell, SGR. */
export const wheelDown = (x: number, y: number) => bytesOf({ mouse: { op: "wheel", button: "down", x, y } });

/**
 * Does `action` to the app and waits for its answer (`press` / `type` / `paste` wait for the
 * screen; a resize or a signal waits for the redraw). `encoding`: how the terminal reports the mouse.
 */
export async function apply(app: App, action: Action, { encoding = "sgr" }: { encoding?: MouseEncodingName } = {}): Promise<void> {
  if ("key" in action) return app.press(KEYS[action.key]);
  if ("text" in action) return app.type(action.text);
  if ("paste" in action) return app.paste(action.paste);
  if ("mouse" in action) return app.press(...mouseReports(action.mouse, encoding));
  if ("focus" in action) return app.press(FOCUS[action.focus]);
  if ("reply" in action) return app.press(REPLIES[action.reply]);
  if ("resize" in action) {
    app.resize(action.resize.cols, action.resize.rows);
    return app.settle(150);
  }
  if ("signal" in action) {
    app.signal(action.signal);
    return app.settle(150);
  }
  await Bun.sleep(action.wait * SLOW);
  await app.quiet();
}

/** An action as one short line (a replay's step, a failure's report). */
export function describeAction(a: Action): string {
  if ("key" in a) return a.key;
  if ("text" in a) return `type ${JSON.stringify(a.text)}`;
  if ("paste" in a) return `paste ${JSON.stringify(a.paste)}`;
  if ("mouse" in a) return `${a.mouse.op} ${a.mouse.button} ${a.mouse.x},${a.mouse.y}${a.mouse.to ? ` → ${a.mouse.to.x},${a.mouse.to.y}` : ""}`;
  if ("resize" in a) return `resize ${a.resize.cols}×${a.resize.rows}`;
  if ("focus" in a) return `focus ${a.focus}`;
  if ("signal" in a) return a.signal;
  if ("reply" in a) return `reply ${a.reply}`;
  return `wait ${a.wait} ms`;
}
