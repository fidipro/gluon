/**
 * A frame of Gluon's screen as the headless xterm holds it, cell by cell (`grab`), and as compact
 * golden text for `toMatchSnapshot()` (`serialize`): a header (scene, size, theme), the cursor,
 * the text grid with row numbers, a deduplicated style table and each row's style runs by column.
 *
 * Colours: `null` the terminal's default, `#rrggbb` a 24-bit colour, a number a palette colour
 * (0–255). Columns are the terminal's: a wide character takes two, its right half is a cell of
 * width 0 with no character.
 */
import type { App } from "../e2e/harness.ts";

export type Color = string | number | null;

export interface Style {
  fg: Color;
  bg: Color;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface Cell extends Style {
  /** The character ("" for the right half of a wide one; " " for an empty cell). */
  ch: string;
  /** 1, 2 (a wide character's left half) or 0 (its right half). */
  w: number;
}

export type Theme = "dark" | "light";

export interface Frame {
  scene: string;
  cols: number;
  rows: number;
  theme: Theme;
  /** Row by row, `cols` cells each. */
  cells: Cell[][];
  /** Where the hardware cursor is (0-based) and whether it is shown. */
  cursor: { x: number; y: number; visible: boolean };
  /** Whether the row continues the one above (xterm wrapped it). */
  wrapped: boolean[];
}

/** The terminal's own colours in each theme: what the harness's OSC 11 reply says, and the foreground a terminal pairs with it. */
export const DEFAULTS: Record<Theme, { fg: string; bg: string }> = {
  dark: { fg: "#cccccc", bg: "#0c0c0c" },
  light: { fg: "#1e1e1e", bg: "#ffffff" },
};

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** The screen now, every cell with its style (read straight from the xterm: no ANSI re-parse). */
export function grab(app: App, scene: string, theme: Theme): Frame {
  const { cols, rows } = app.term;
  const buf = app.term.buffer.active;
  const cells: Cell[][] = [];
  const wrapped: boolean[] = [];
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    wrapped.push(!!line?.isWrapped);
    const row: Cell[] = [];
    for (let x = 0; x < cols; x++) {
      const c = line?.getCell(x);
      if (!c) {
        row.push({ ch: " ", w: 1, fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
        continue;
      }
      const w = c.getWidth();
      row.push({
        ch: w === 0 ? "" : c.getChars() || " ",
        w,
        fg: c.isFgDefault() ? null : c.isFgRGB() ? hex(c.getFgColor()) : c.getFgColor(),
        bg: c.isBgDefault() ? null : c.isBgRGB() ? hex(c.getBgColor()) : c.getBgColor(),
        bold: !!c.isBold(),
        dim: !!c.isDim(),
        italic: !!c.isItalic(),
        underline: !!c.isUnderline(),
        inverse: !!c.isInverse(),
      });
    }
    cells.push(row);
  }
  return { scene, cols, rows, theme, cells, cursor: app.cursor(), wrapped };
}

/** A row's text: each cell's character (wide ones once), trailing blanks dropped. */
export const rowText = (row: readonly Cell[]) => row.map((c) => c.ch).join("").trimEnd();

/** Every row's text. */
export const textOf = (f: Frame) => f.cells.map(rowText);

const colorKey = (c: Color) => (c === null ? "" : typeof c === "number" ? `p${c}` : c);

/** A style as the golden's style table writes it: `fg=#… bg=#… b d i u inv` (defaults left out). */
export function styleKey(s: Style): string {
  const parts: string[] = [];
  if (s.fg !== null) parts.push(`fg=${colorKey(s.fg)}`);
  if (s.bg !== null) parts.push(`bg=${colorKey(s.bg)}`);
  if (s.bold) parts.push("b");
  if (s.dim) parts.push("d");
  if (s.italic) parts.push("i");
  if (s.underline) parts.push("u");
  if (s.inverse) parts.push("inv");
  return parts.join(" ");
}

/**
 * Each row's runs of cells in one style other than `skip` (default: the terminal's default style),
 * by column: `[from, to, key]` (`to` exclusive). A wide character's right half has its left's style.
 */
export function runsOf(row: readonly Cell[], skip = ""): [number, number, string][] {
  const runs: [number, number, string][] = [];
  row.forEach((c, x) => {
    const key = styleKey(c);
    if (key === skip) return;
    const last = runs.at(-1);
    if (last && last[1] === x && last[2] === key) last[1] = x + 1;
    else runs.push([x, x + 1, key]);
  });
  return runs;
}

/** The style most cells have (the ground Gluon paints, or the terminal's default). */
function baseStyle(f: Frame): string {
  const count = new Map<string, number>();
  for (const row of f.cells) for (const c of row) count.set(styleKey(c), (count.get(styleKey(c)) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

/**
 * The golden: the frame as text a reviewer can read in a diff. `base` is the style most cells
 * have; the runs list only cells in another style (`s0`: the terminal's default). Style numbers
 * follow first use (top-left to bottom-right), so one changed colour changes one line of the table.
 */
export function serialize(f: Frame): string {
  const base = baseStyle(f);
  const styles = new Map<string, number>([["", 0]]);
  const number = (key: string) => {
    if (!styles.has(key)) styles.set(key, styles.size);
    return styles.get(key)!;
  };
  const baseN = number(base);
  const pad = String(f.rows - 1).length;
  const textLines = f.cells.map((row, y) => `${String(y).padStart(pad)} ${f.wrapped[y] ? "↩" : "│"}${rowText(row)}`);
  const runLines: string[] = [];
  f.cells.forEach((row, y) => {
    const runs = runsOf(row, base).map(([a, b, key]) => `[${a},${b},s${number(key)}]`);
    if (runs.length) runLines.push(`${String(y).padStart(pad)} ${runs.join(" ")}`);
  });
  return [
    `scene ${f.scene} · ${f.cols}×${f.rows} · ${f.theme}`,
    `cursor ${f.cursor.x},${f.cursor.y} ${f.cursor.visible ? "shown" : "hidden"}`,
    "text",
    ...textLines,
    "styles",
    ...[...styles].filter(([key]) => key).map(([key, n]) => `s${n} ${key}`),
    `base s${baseN}`,
    "runs",
    ...runLines,
  ].join("\n");
}

/**
 * The frame as `test/visual/render.py --cells` reads it: `{cols, rows, theme, defaults, lines:
 * [{text, runs, chars}], cursor}`; runs `[from, to, flags, fg, bg]` by column (flags `i` inverse,
 * `b` bold, `d` dim, `t` italic, `u` underline; colours -1 default, `#rrggbb`, or 0–255 a palette
 * colour), `chars` each column's character ("" for a wide one's right half).
 */
export function cellsJson(f: Frame) {
  return {
    cols: f.cols,
    rows: f.rows,
    theme: f.theme,
    defaults: DEFAULTS[f.theme],
    cursor: f.cursor,
    lines: f.cells.map((row) => {
      const runs: [number, number, string, string | number, string | number][] = [];
      row.forEach((c, x) => {
        const flags = `${c.inverse ? "i" : ""}${c.bold ? "b" : ""}${c.dim ? "d" : ""}${c.italic ? "t" : ""}${c.underline ? "u" : ""}`;
        const fg = c.fg ?? -1;
        const bg = c.bg ?? -1;
        if (!flags && fg === -1 && bg === -1) return;
        const last = runs.at(-1);
        if (last && last[1] === x && last[2] === flags && last[3] === fg && last[4] === bg) last[1] = x + 1;
        else runs.push([x, x + 1, flags, fg, bg]);
      });
      return { text: rowText(row), runs, chars: row.map((c) => c.ch) };
    }),
  };
}
