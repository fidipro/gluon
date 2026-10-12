/**
 * How a setup menu fits a terminal's rows: whether its margins go, how much of its body shows
 * (whole lines, the first ones first) and which rows of its list are in view. Pure, so the
 * fitting rules are tested as functions; the menus in `signin.tsx` only draw what these return.
 */
import { wrap } from "./width.tsx";

/** The rows `text` takes when wrapped at `width` (never narrower than 10). */
export const lineCount = (text: string, width: number) => wrap(text, Math.max(10, width)).split("\n").length;

/**
 * How a menu fits in `rows - 1` rows: whether its margins go (`compact`), how many rows its body
 * gets (null: all), and which rows of its list show (a window around the cursor).
 */
export function fitMenu(opts: { columns: number; rows: number; title: string; body: string[]; items: number[]; cursor: number; footer: boolean }) {
  const width = opts.columns - 1;
  const titleRows = lineCount(opts.title, width - 1);
  const bodyRows = opts.body.reduce((n, l) => n + (l ? lineCount(l, width - 2) : 1), 0);
  const itemRows = opts.items.reduce((a, b) => a + b, 0);
  const avail = Math.max(3, opts.rows - 1);
  const size = (compact: boolean, body: number, items: number) =>
    (compact ? 0 : 1) + titleRows + (body ? body + (compact ? 0 : 1) : 0) + items + (compact ? 0 : 1) + (opts.footer ? (compact ? 1 : 2) : 0);
  const all = { start: 0, end: opts.items.length };
  if (size(false, bodyRows, itemRows) <= avail) return { compact: false, bodyRows: null, window: all };
  if (size(true, bodyRows, itemRows) <= avail) return { compact: true, bodyRows: null, window: all };
  // The list first (clipping the body to what's left), unless the list alone doesn't fit.
  const forBody = avail - size(true, 0, itemRows);
  if (forBody >= Math.min(bodyRows, 2)) return { compact: true, bodyRows: Math.min(bodyRows, forBody), window: all };
  const forItems = Math.max(1, avail - size(true, 0, 0) - 1);
  let start = Math.min(opts.cursor, opts.items.length - 1);
  let end = start + 1;
  let used = opts.items[start] ?? 1;
  while (true) {
    if (end < opts.items.length && used + opts.items[end]! <= forItems) used += opts.items[end++]!;
    else if (start > 0 && used + opts.items[start - 1]! <= forItems) used += opts.items[--start]!;
    else break;
  }
  return { compact: true, bodyRows: 0, window: { start, end } };
}

/** The body's first lines that fit in `rows` rows, whole: a line is never cut through (the first ones matter most). */
export function wholeLines(body: string[], rows: number | null, width: number): string[] {
  if (rows === null) return body;
  const out: string[] = [];
  let used = 0;
  for (const l of body) {
    const n = l ? lineCount(l, width) : 1;
    if (used + n > rows) break;
    out.push(l);
    used += n;
  }
  while (out.length && !out.at(-1)) out.pop();
  return out;
}
