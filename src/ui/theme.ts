/**
 * Colours adapt to the terminal's background, as Codex's do: the composer and user messages are
 * the background blended toward white (dark terminals) or black (light ones).
 * Codex: style.rs, terminal_palette.rs (palette from the OSC 11 background probe).
 */
import chalk from "chalk";
import { currentStdin } from "./rawmode.ts";

export type Rgb = [number, number, number];

export interface Theme {
  dark: boolean;
  /** Gluon's palette (the home view and the compositor's chrome), as Ink colour strings. */
  gluon: GluonPalette;
  accent: string;
  composerBg: string | undefined;
  userBg: string | undefined;
  selectionBg: string;
  success: string;
  danger: string;
  code: string;
  listMarker: string;
}

const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const blend = (from: Rgb, to: Rgb, t: number): Rgb => [0, 1, 2].map((i) => from[i]! + (to[i]! - from[i]!) * t) as Rgb;

/**
 * The background from `COLORFGBG` ("fg;bg", set by rxvt, Konsole, iTerm2 and others), for
 * terminals that don't answer OSC 11. ANSI colours 7 and 9-15 are light.
 */
export function backgroundFromEnv(value = process.env.COLORFGBG): Rgb | null {
  const bg = Number(value?.split(";").at(-1));
  if (!value || !Number.isInteger(bg)) return null;
  return bg === 7 || (bg >= 9 && bg <= 15) ? [255, 255, 255] : [12, 12, 12];
}

/**
 * Gluon's palette (design brief, section 4): one accent (amber), three status colours (amber,
 * blue, green), the rest grayscale. Designed for truecolor; `gluonPalette` maps it to the nearest
 * xterm-256 colours elsewhere.
 */
export const GLUON_HEX = {
  ground: "#0f1013",
  // The user's messages and the tab strip: a step above the ground.
  bar: "#1a1c22",
  // What Enter acts on (the selected row, the highlighted option, the current tab): a clear step
  // above `bar`, so it stands out next to the user's messages (BUG-252); dim text on it ≥ 3:1.
  selected: "#363a46",
  rule: "#30333d",
  // Box borders (the session's frame, the spec box): ≥ 3:1 against the ground (BUG-255).
  frame: "#5f6472",
  text: "#d5d7dd",
  bright: "#f2f3f5",
  dim: "#8b909c",
  amber: "#e6b450",
  blue: "#7cc0ff",
  green: "#5fd0a0",
} as const;

export type GluonRole = keyof typeof GLUON_HEX;

/** Each role as a colour Ink takes (`#rrggbb`, or `ansi256(n)` without truecolor). */
export type GluonPalette = Record<GluonRole, string> & { truecolor: boolean };

/**
 * Whether the terminal takes 24-bit colour: `COLORTERM=truecolor|24bit` says so; Windows Terminal
 * does (and its ConPTY drops the OSC 11 reply); Apple Terminal and the Linux console don't;
 * otherwise a terminal that answered the background query (`answered`) is taken to.
 */
export function truecolorSupported(env: Record<string, string | undefined> = process.env, answered = false): boolean {
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return true;
  if (env.WT_SESSION) return true;
  if (env.TERM_PROGRAM === "Apple_Terminal" || env.TERM === "linux" || env.TERM === "dumb") return false;
  return answered;
}

const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const CUBE = [0, 95, 135, 175, 215, 255];

/** The xterm-256 colour nearest to `hex`: the 6×6×6 cube (16–231) or the gray ramp (232–255). */
export function nearest256(hex: string): number {
  const rgb = rgbOf(hex);
  const dist = (c: Rgb) => (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
  const level = (v: number) => CUBE.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(CUBE[best]! - v) ? i : best), 0);
  const [r, g, b] = rgb.map(level) as [number, number, number];
  let best = 16 + 36 * r + 6 * g + b;
  let bestDist = dist([CUBE[r]!, CUBE[g]!, CUBE[b]!]);
  for (let i = 0; i < 24; i++) {
    const v = 8 + 10 * i;
    const d = dist([v, v, v]);
    if (d < bestDist) [best, bestDist] = [232 + i, d];
  }
  return best;
}

export function gluonPalette(truecolor: boolean): GluonPalette {
  const roles = Object.fromEntries(Object.entries(GLUON_HEX).map(([k, hex]) => [k, truecolor ? hex : `ansi256(${nearest256(hex)})`]));
  return { ...(roles as Record<GluonRole, string>), truecolor };
}

/**
 * SGR escapes in Gluon's colours for code outside React (the compositor's tab strip, frame and
 * bottom bar): `fg(GLUON_HEX.amber)`, `bg(GLUON_HEX.bar)`, then `SGR_RESET`.
 */
export const fg = (hex: string, truecolor = truecolorSupported()): string => (truecolor ? `\x1b[38;2;${rgbOf(hex).join(";")}m` : `\x1b[38;5;${nearest256(hex)}m`);
export const bg = (hex: string, truecolor = truecolorSupported()): string => (truecolor ? `\x1b[48;2;${rgbOf(hex).join(";")}m` : `\x1b[48;5;${nearest256(hex)}m`);
export const SGR_RESET = "\x1b[0m";

/** `text` in an Ink colour string (`#rrggbb`, `ansi256(n)`, a name), as chalk styles it: for text that is wrapped before Ink sees it. */
export function paint(color: string | undefined, text: string, bold = false): string {
  let c = bold ? chalk.bold : chalk;
  const n = color?.match(/^ansi256\((\d+)\)$/);
  if (color?.startsWith("#")) c = c.hex(color);
  else if (n) c = c.ansi256(Number(n[1]));
  else if (color && color in chalk) c = (c as unknown as Record<string, typeof chalk>)[color]!;
  return c(text);
}
export const SGR_BOLD = "\x1b[1m";

/** `env`: for the truecolor check (`truecolorSupported`); a background answer counts toward it. */
export function makeTheme(bg: Rgb | null, env: Record<string, string | undefined> = process.env): Theme {
  const answered = bg !== null;
  bg ??= backgroundFromEnv();
  const luma = bg ? 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2] : 0;
  const dark = luma <= 128;
  const base: Rgb = bg ?? [12, 12, 12];
  const toward: Rgb = dark ? [255, 255, 255] : [0, 0, 0];
  return {
    dark,
    gluon: gluonPalette(truecolorSupported(env, answered)),
    accent: dark ? "#63A8F8" : "#1C64C8",
    composerBg: hex(blend(base, toward, dark ? 0.12 : 0.1)),
    userBg: hex(blend(base, toward, dark ? 0.16 : 0.07)),
    selectionBg: dark ? "#63A8F8" : "#A4CDFB",
    success: "green",
    danger: "red",
    code: dark ? "#7FC8FF" : "#1C64C8",
    listMarker: dark ? "blueBright" : "blue",
  };
}

/** Until when a late reply may still come: the query went unanswered a moment ago (0: none expected). */
let lateReplyUntil = 0;
/** How long after an unanswered query a late reply is still expected. */
export const LATE_REPLY_WINDOW_MS = 5000;

/** Whether the terminal may still answer the background query (it didn't in time, a few seconds ago). */
export const lateReplyExpected = () => Date.now() < lateReplyUntil;
/** A late reply arrived (and was dropped): no other is expected. */
export const replySeen = () => {
  lateReplyUntil = 0;
};

/**
 * Asks the terminal for its background colour (OSC 11). Resolves null if it does not answer
 * within `timeoutMs` or stdin is not a TTY. Must run before Ink takes stdin.
 */
export async function queryBackground(timeoutMs = 150): Promise<Rgb | null> {
  const stdin = currentStdin();
  const { stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return null;
  return new Promise((resolve) => {
    let buf = "";
    // Read with 'readable' + read(), as Ink does: a 'data' listener switches stdin to flowing
    // mode, and under Bun stdin then never delivers another key once Ink attaches.
    const done = (value: Rgb | null) => {
      clearTimeout(timer);
      lateReplyUntil = value ? 0 : Date.now() + LATE_REPLY_WINDOW_MS;
      stdin.off("readable", onReadable);
      resolve(value);
    };
    const onReadable = () => {
      let chunk: Buffer | string | null;
      while ((chunk = stdin.read()) !== null) buf += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      const m = buf.match(/\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
      if (!m) return;
      const scale = (h: string) => (parseInt(h, 16) / (16 ** h.length - 1)) * 255;
      done([scale(m[1]!), scale(m[2]!), scale(m[3]!)]);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    stdin.setRawMode(true);
    stdin.on("readable", onReadable);
    stdout.write("\x1b]11;?\x07");
  });
}

/** What Gluon's sessions need to know of the real terminal: their models answer the agents' queries with it. */
export interface TerminalInfo {
  /** It answered `CSI ? u`: it speaks the kitty keyboard protocol. */
  kitty: boolean;
  /** Its foreground (OSC 10) and cursor (OSC 12) colours, where it told them. */
  fg: Rgb | null;
  cursor: Rgb | null;
}

const rgbReply = (ident: number, buf: string): Rgb | null => {
  const m = buf.match(new RegExp(`\\]${ident};rgb:([0-9a-f]+)/([0-9a-f]+)/([0-9a-f]+)`, "i"));
  if (!m) return null;
  const scale = (h: string) => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255);
  return [scale(m[1]!), scale(m[2]!), scale(m[3]!)];
};

/**
 * What the terminal's answers to Gluon's probe say: OSC 10 and 12, then kitty's `CSI ? u`, all
 * before the DA1 reply every terminal sends (`CSI ? … c`). Null until the DA1 reply is in `buf`.
 */
export function parseTerminalReplies(buf: string): TerminalInfo | null {
  const da = buf.search(/\x1b\[\?[\d;]*c/);
  if (da < 0) return null;
  const before = buf.slice(0, da);
  return { kitty: /\x1b\[\?\d*u/.test(before), fg: rgbReply(10, before), cursor: rgbReply(12, before) };
}

/**
 * Probes the terminal once at startup (after the OSC 11 query, before Gluon reads stdin): its
 * foreground and cursor colours, kitty keyboard support, then DA1, which every terminal answers,
 * so the answers end there. Read with 'readable' + read() as `queryBackground` does. No DA1 within
 * `timeoutMs`: nothing is known (a late answer reaches Gluon's key decoder as a `reply`, dropped).
 */
export async function queryTerminal(timeoutMs = 150): Promise<TerminalInfo> {
  const none: TerminalInfo = { kitty: false, fg: null, cursor: null };
  const stdin = currentStdin();
  const { stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return none;
  return new Promise((resolve) => {
    let buf = "";
    const done = (value: TerminalInfo) => {
      clearTimeout(timer);
      stdin.off("readable", onReadable);
      resolve(value);
    };
    const onReadable = () => {
      let chunk: Buffer | string | null;
      while ((chunk = stdin.read()) !== null) buf += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      const info = parseTerminalReplies(buf);
      if (info) done(info);
    };
    const timer = setTimeout(() => done(none), timeoutMs);
    stdin.setRawMode(true);
    stdin.on("readable", onReadable);
    stdout.write("\x1b]10;?\x07\x1b]12;?\x07\x1b[?u\x1b[c");
  });
}
