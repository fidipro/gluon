/**
 * Checks every frame of the visual suite, whatever the scene: what no golden should ever show.
 * `lint(frame)` lists the problems (empty: clean), each `<rule>: <where>: <what>`.
 *
 * - `border`: boxes whole: the session frame where `layout` puts it; at home every box (the spec
 *   box) has its four corners and its sides.
 * - `wrap`: no chrome row continues a wrapped row (session: the strip, info line, borders, bar;
 *   home: every row).
 * - `wide`: no half-cut wide character (a right half without its left), no U+FFFD.
 * - `cut`: text cut at an edge ends with `…`: the frame's title stops short of its corner or ends
 *   in `…`; the home view keeps its 2-column right margin; across sizes (`lintAcross`), a strip,
 *   info line or bar that is a prefix of the wider frame's ends in `…` / `›`.
 * - `ground`: the home view (and `too small`) paints every cell's background: no hole of the
 *   terminal's default (`src/ui/AGENTS.md`: it paints its own ground); `ground-last` the last
 *   row, outside the rows − 1 frame (the question bar's).
 * - `selection`: at most one highlighted block at home (REPORT #5: the list's row and an option).
 * - `contrast`: text that isn't dim has a contrast ratio ≥ 3:1 with its background, in the
 *   frame's theme (default colours resolved to the theme's; a session's interior is the agent's
 *   own and isn't checked).
 */
import { layout, MIN_COLS, MIN_ROWS } from "../../src/pty/chrome.ts";
import { GLUON_HEX } from "../../src/ui/theme.ts";
import { type Cell, type Color, DEFAULTS, type Frame, rowText, type Theme } from "./frame.ts";

export type View = "home" | "session" | "tooSmall";

export function viewOf(f: Frame): View {
  const first = rowText(f.cells[0] ?? []);
  if (/^too small/.test(first)) return "tooSmall";
  if (first.includes("◆ gluon")) return "session";
  return "home";
}

/** xterm.js's default 16 colours: what a palette colour shows as (also `render.py`'s). */
export const ANSI16 = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf", "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

type Rgb = [number, number, number];
const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

/** A palette colour (0–255) as RGB: the 16, the 6×6×6 cube, the gray ramp. */
export function paletteRgb(n: number): Rgb {
  if (n < 16) return rgbOf(ANSI16[n]!);
  if (n < 232) {
    const lv = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return [lv[Math.floor(i / 36)]!, lv[Math.floor(i / 6) % 6]!, lv[i % 6]!];
  }
  const v = 8 + (n - 232) * 10;
  return [v, v, v];
}

const resolve = (c: Color, fallback: string): Rgb => (c === null ? rgbOf(fallback) : typeof c === "number" ? paletteRgb(c) : rgbOf(c));

/** A cell's colours as the terminal shows them in `theme`: defaults resolved, inverse applied. */
export function shown(c: Cell, theme: Theme): { fg: Rgb; bg: Rgb } {
  const d = DEFAULTS[theme];
  const fg = resolve(c.fg, d.fg);
  const bg = resolve(c.bg, d.bg);
  return c.inverse ? { fg: bg, bg: fg } : { fg, bg };
}

const luminance = ([r, g, b]: Rgb) => {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** WCAG contrast ratio of two colours (1–21). */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text a reader reads: not blank, not a box-drawing, block or braille glyph (the logo, rules, borders). */
const isText = (ch: string) => {
  if (!ch.trim()) return false;
  const cp = ch.codePointAt(0)!;
  return !(cp >= 0x2500 && cp <= 0x259f) && !(cp >= 0x2800 && cp <= 0x28ff);
};

const at = (f: Frame, x: number, y: number) => f.cells[y]?.[x]?.ch ?? "";

function sessionBorder(f: Frame): string[] {
  const { frame } = layout(f.cols, f.rows);
  const out: string[] = [];
  const right = frame.left + frame.cols - 1;
  const bottom = frame.top + frame.rows - 1;
  const want = (x: number, y: number, ch: string, what: string) => {
    if (at(f, x, y) !== ch) out.push(`border: ${what} at ${x},${y} is ${JSON.stringify(at(f, x, y))}, not ${ch}`);
  };
  want(frame.left, frame.top, "┌", "top-left corner");
  want(right, frame.top, "┐", "top-right corner");
  want(frame.left, bottom, "└", "bottom-left corner");
  want(right, bottom, "┘", "bottom-right corner");
  for (let y = frame.top + 1; y < bottom; y++) {
    want(frame.left, y, "│", "left side");
    want(right, y, "│", "right side");
  }
  return out;
}

const TOP = new Map([["╭", "╮"], ["┌", "┐"]]);
const BOTTOM = new Map([["╰", "╯"], ["└", "┘"]]);

/** Every box on the screen: a top-left corner, its top-right on the same row, sides down to the bottom corners. Corners with no box are reported too. */
function boxes(f: Frame): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  for (let y = 0; y < f.rows; y++) {
    for (let x = 0; x < f.cols; x++) {
      const close = TOP.get(at(f, x, y));
      if (!close) continue;
      used.add(`${x},${y}`);
      let x2 = x + 1;
      while (x2 < f.cols && at(f, x2, y) !== close) x2++;
      if (x2 >= f.cols) {
        out.push(`border: the box at ${x},${y} has no ${close} on its top row`);
        continue;
      }
      used.add(`${x2},${y}`);
      let y2 = y + 1;
      while (y2 < f.rows && at(f, x, y2) === "│" && at(f, x2, y2) === "│") y2++;
      const bl = at(f, x, y2);
      const br = at(f, x2, y2);
      if (!BOTTOM.has(bl) || BOTTOM.get(bl) !== br) out.push(`border: the box at ${x},${y}–${x2} breaks at row ${y2}: ${JSON.stringify(bl)} … ${JSON.stringify(br)}`);
      else used.add(`${x},${y2}`), used.add(`${x2},${y2}`);
    }
  }
  for (let y = 0; y < f.rows; y++)
    for (let x = 0; x < f.cols; x++) if ((BOTTOM.has(at(f, x, y)) || [...BOTTOM.values()].includes(at(f, x, y))) && !used.has(`${x},${y}`)) out.push(`border: a bottom corner ${at(f, x, y)} at ${x},${y} closes no box`);
  return out;
}

/** The rows of Gluon's own chrome (session view). */
function chromeRows(f: Frame): number[] {
  const l = layout(f.cols, f.rows);
  return [l.tabRow, l.infoRow, l.frame.top, l.frame.top + l.frame.rows - 1, l.barRow].filter((y) => y < f.rows);
}

function wraps(f: Frame, view: View): string[] {
  const rows = view === "session" ? chromeRows(f) : f.cells.map((_, y) => y);
  return rows.filter((y) => f.wrapped[y]).map((y) => `wrap: row ${y} continues a wrapped row`);
}

function wides(f: Frame): string[] {
  const out: string[] = [];
  f.cells.forEach((row, y) =>
    row.forEach((c, x) => {
      if (c.w === 0 && row[x - 1]?.w !== 2) out.push(`wide: a wide character's right half with no left at ${x},${y}`);
      if (c.w === 2 && row[x + 1]?.w !== 0) out.push(`wide: a wide character at ${x},${y} without its right half`);
      if (c.ch.includes("�")) out.push(`wide: U+FFFD at ${x},${y}`);
    }),
  );
  return out;
}

/** The last non-blank column of a row (-1: blank). */
const lastCol = (row: readonly Cell[]) => {
  for (let x = row.length - 1; x >= 0; x--) if (row[x]!.ch.trim()) return x;
  return -1;
};

function cuts(f: Frame, view: View): string[] {
  const out: string[] = [];
  if (view === "session") {
    // The frame's title: `┌─ title ─…─┐`, at least one dash before the corner unless it ends in …
    const top = rowText(f.cells[layout(f.cols, f.rows).frame.top]!);
    const m = /^┌─ (.*?) (─*)┐$/.exec(top);
    if (m && !m[2] && !m[1]!.endsWith("…")) out.push(`cut: the frame's title runs into the corner without …: ${JSON.stringify(top)}`);
  } else if (view === "home") {
    f.cells.forEach((row, y) => {
      const x = lastCol(row);
      // The home view keeps two columns of margin on the right (rules alone may span a tiny
      // terminal); a question on the last row runs to the edge.
      if (x >= f.cols - 2 && y !== f.rows - 1 && row[x]!.ch !== "…" && row.some((c) => isText(c.ch))) out.push(`cut: row ${y} runs into the right margin (column ${x}): ${JSON.stringify(rowText(row))}`);
    });
  }
  return out;
}

/**
 * Across one scene's frames (same theme, several sizes): a session's strip, info line or bar that
 * is a strict prefix of the same row at a wider size was cut, and must end in `…` (or `›`, the
 * strip's overflow marker).
 */
export function lintAcross(frames: readonly Frame[]): string[] {
  const out: string[] = [];
  const sessions = frames.filter((f) => viewOf(f) === "session" && f.cols >= MIN_COLS && f.rows >= MIN_ROWS).sort((a, b) => b.cols - a.cols);
  const widest = sessions[0];
  if (!widest) return out;
  const rowsOf = (f: Frame) => {
    const l = layout(f.cols, f.rows);
    return { "tab strip": rowText(f.cells[l.tabRow]!), "info line": rowText(f.cells[l.infoRow]!), "bottom bar": rowText(f.cells[l.barRow]!) };
  };
  const full = rowsOf(widest);
  for (const f of sessions.slice(1)) {
    for (const [what, text] of Object.entries(rowsOf(f)) as [keyof typeof full, string][]) {
      const t = text.trimEnd();
      if (t && t !== full[what].trimEnd() && full[what].startsWith(t) && !/[…›]$/.test(t)) out.push(`cut: ${f.cols}×${f.rows} ${f.theme}: the ${what} is cut without …: ${JSON.stringify(t)} (at ${widest.cols}: ${JSON.stringify(full[what].trimEnd())})`);
    }
  }
  return out;
}

function ground(f: Frame): string[] {
  const out: string[] = [];
  f.cells.forEach((row, y) => {
    const holes = row.flatMap((c, x) => (c.bg === null && !c.inverse ? [x] : []));
    // The last row, outside the home view's rows − 1 frame, apart: the question bar's row.
    if (holes.length) out.push(`${y === f.rows - 1 ? "ground-last" : "ground"}: row ${y} has ${holes.length} cell(s) on the terminal's default background (from column ${holes[0]})`);
  });
  return out;
}

const HIGHLIGHTS = new Set<string>([GLUON_HEX.selected, GLUON_HEX.bar]);

/** Highlighted rows: the list's selected row, the highlighted option. Not the user's own messages in the chat (`›`, on the same colour) nor the question on the last row. */
function selections(f: Frame): string[] {
  const rows = f.cells.flatMap((row, y) => (y < f.rows - 1 && !/^\s*›/.test(rowText(row)) && row.some((c) => typeof c.bg === "string" && HIGHLIGHTS.has(c.bg)) ? [y] : []));
  const blocks = rows.filter((y, i) => i === 0 || rows[i - 1] !== y - 1);
  return blocks.length > 1 ? [`selection: ${blocks.length} highlighted blocks (from rows ${blocks.join(", ")}), at most 1`] : [];
}

function contrasts(f: Frame, view: View): string[] {
  const out: string[] = [];
  const inner = view === "session" ? layout(f.cols, f.rows).interior : null;
  f.cells.forEach((row, y) => {
    let bad: { x: number; ratio: number; text: string } | null = null;
    const flush = () => {
      if (bad) out.push(`contrast: ${bad.ratio.toFixed(2)}:1 at ${bad.x},${y}: ${JSON.stringify(bad.text)}`);
      bad = null;
    };
    row.forEach((c, x) => {
      if (inner && y >= inner.top && y < inner.top + inner.rows && x >= inner.left && x < inner.left + inner.cols) return flush();
      if (c.dim || !isText(c.ch)) return flush();
      const { fg, bg } = shown(c, f.theme);
      const ratio = contrast(fg, bg);
      if (ratio >= 3) return flush();
      if (bad) bad.text += c.ch;
      else bad = { x, ratio, text: c.ch };
    });
    flush();
  });
  return out;
}

/** Every problem on the frame (empty: clean). */
export function lint(f: Frame): string[] {
  const view = viewOf(f);
  const small = f.cols < MIN_COLS || f.rows < MIN_ROWS;
  const out: string[] = [];
  if (view === "session" && !small) out.push(...sessionBorder(f));
  if (view === "home") out.push(...boxes(f), ...selections(f));
  if (view !== "session") out.push(...ground(f));
  out.push(...wraps(f, view), ...wides(f), ...cuts(f, view), ...contrasts(f, view));
  return out;
}

/** The rules, for grouping a frame's problems. */
export const RULES = ["border", "wrap", "wide", "cut", "ground", "ground-last", "selection", "contrast"] as const;
export type Rule = (typeof RULES)[number];

/** A problem's rule (its first word). */
export const ruleOf = (problem: string) => problem.slice(0, problem.indexOf(":")) as Rule;
