/**
 * Gluon: dragging over the home view's text selects it, and releasing copies it (issue #62). Gluon
 * captures the mouse at home, so the terminal's own drag-select is off (Shift+drag still works);
 * this is Gluon's. It works on the home view's screen model (what Ink last wrote, as cells) — never
 * on an agent's screen — and in memory only: the text goes to the terminal as an OSC 52 copy, to
 * nowhere else.
 *
 * The selection ends at the next key or press, or when the text under it changes (Ink has already
 * drawn over the highlight, which is painted again only when the text is the same).
 *
 * A selection is a stream between two cells, as a terminal's own: the first row from its start
 * column, whole rows between, the last row up to its end column.
 */
import type { PaintCell, TermScreen } from "./screen.ts";

/** 0-based cell. */
export interface Pos {
  x: number;
  y: number;
}

export interface Selection {
  anchor: Pos;
  head: Pos;
}

/** One row's part of a selection: cells `[x0, x1)`, its text (trailing spaces trimmed), and whether it covers all of the row's text (`full`). */
export interface Span {
  y: number;
  x0: number;
  x1: number;
  text: string;
  full: boolean;
}

type Source = Pick<TermScreen, "cols" | "rows" | "cells">;

/** The selection's cells in reading order, ends included. */
export function spans(screen: Source, sel: Selection): Span[] {
  const [a, b] = [sel.anchor, sel.head].sort((p, q) => p.y - q.y || p.x - q.x) as [Pos, Pos];
  const out: Span[] = [];
  for (let y = Math.max(0, a.y); y <= Math.min(screen.rows - 1, b.y); y++) {
    const cells = screen.cells(y);
    let x0 = y === a.y ? a.x : 0;
    let x1 = y === b.y ? b.x + 1 : screen.cols;
    // Whole characters: a wide one's right half pulls its left half in, its left half its right.
    if (cells[x0]?.width === 0 && x0 > 0) x0--;
    if (x1 > 0 && cells[x1 - 1]?.width === 2) x1++;
    x0 = Math.max(0, Math.min(screen.cols, x0));
    x1 = Math.max(x0, Math.min(screen.cols, x1));
    const blank = (c?: PaintCell) => !c || c.width === 0 || !c.char.trim();
    const first = cells.findIndex((c) => !blank(c));
    const last = cells.findLastIndex((c) => !blank(c));
    out.push({ y, x0, x1, text: textOf(cells, x0, x1), full: first < 0 || (x0 <= first && x1 > last) });
  }
  return out;
}

function textOf(cells: readonly PaintCell[], x0: number, x1: number): string {
  let s = "";
  for (let x = x0; x < x1; x++) {
    const c = cells[x];
    if (!c || c.width === 0) continue;
    s += c.char || " ";
  }
  return s.trimEnd();
}

/**
 * What the spans copy: the chat's own dressing left out. A row that has both box edges (the spec's
 * `│ … │`) loses them, a box's top and bottom edge rows go; the rows selected whole (from before
 * their text to past it, wherever the drag began) lose the page's padding and the chat's gutter (a
 * `◆`, `›` or `◇` is a blank there) as far as they all share it — the home view's padding is not
 * Gluon's to hard-code here; a partly selected row keeps its text as it is. Trailing blank rows go.
 */
export function copyText(sp: readonly Span[]): string {
  const rows: { text: string; whole: boolean; indent: number }[] = [];
  for (const s of sp) {
    let t = s.text;
    if (/^\s*[╭╰]─.*[╮╯]$/.test(t)) continue;
    const boxed = t.match(/^(\s*)│ ?(.*?)\s*│$/);
    if (boxed) rows.push({ text: boxed[2]!, whole: false, indent: 0 });
    else {
      if (s.full) t = t.replace(/^(\s*)[◆›◇](?= )/, "$1 ");
      // The column its text starts in, on the screen (the span may begin inside the padding).
      rows.push({ text: s.full ? t.trimStart() : t, whole: s.full, indent: s.x0 + t.length - t.trimStart().length });
    }
  }
  const shared = Math.min(...rows.filter((r) => r.whole && r.text).map((r) => r.indent));
  const lines = rows.map((r) => (r.whole && Number.isFinite(shared) && r.text ? " ".repeat(r.indent - shared) + r.text : r.text));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.join("\n");
}

const cup = (y: number, x: number) => `\x1b[${y + 1};${x + 1}H`;

/**
 * Bytes that paint the spans on the real terminal: `on` — the cells reversed (a reversed cell
 * un-reversed, so it shows either way); off — as the screen model has them. Cursor and attributes
 * are left as they were.
 */
export function paintSpans(screen: Source, sp: readonly Span[], on: boolean): string {
  let out = "";
  for (const s of sp) {
    const cells = screen.cells(s.y);
    out += cup(s.y, s.x0);
    let sgr = "";
    for (let x = s.x0; x < s.x1; x++) {
      const c = cells[x];
      if (!c || c.width === 0) continue;
      // Each starts from a reset, so a cell with the same attributes as the one before needs none.
      const now = `${c.sgr}${on ? (c.inverse ? ";27" : ";7") : ""}`;
      if (now !== sgr) out += `\x1b[${now}m`;
      sgr = now;
      out += c.char || " ";
      // A character that is one cell in one terminal and two in another must not shift the rest.
      if (c.char.length > 1 && x + 1 < s.x1) out += cup(s.y, x + c.width);
    }
  }
  return out ? `\x1b7${out}\x1b[0m\x1b8` : "";
}

/** The cells to paint as they are (`off`) and reversed (`on`) to go from the spans shown (`old`) to `next`: only what changed. */
export function diffSpans(old: readonly Span[], next: readonly Span[]): { off: Span[]; on: Span[] } {
  const at = (sp: readonly Span[]) => new Map(sp.map((s) => [s.y, s]));
  const [o, n] = [at(old), at(next)];
  const cut = (a: Span, b?: Span): Span[] => (!b || b.x1 <= a.x0 || b.x0 >= a.x1 ? [a] : [...(a.x0 < b.x0 ? [{ ...a, x1: b.x0 }] : []), ...(b.x1 < a.x1 ? [{ ...a, x0: b.x1 }] : [])]);
  return { off: old.flatMap((a) => cut(a, n.get(a.y))), on: next.flatMap((b) => cut(b, o.get(b.y))) };
}

/** The terminal's clipboard gets `text` (OSC 52; terminals without it ignore it). */
export const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

/** The text in the spans, as the screen shows it now: what a repaint compares to see the screen changed under a selection. */
export const spansKey = (sp: readonly Span[]) => sp.map((s) => `${s.y}:${s.x0}:${s.text}`).join("\n");
