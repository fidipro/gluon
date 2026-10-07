import type { Cell, Screen } from "../types.ts";

/** What the readers share: slash-command names, cell text, wrapped input rows. (Each harness has its own reader; there is no generic one.) */

/** A slash command at the start of `s` ("/clear (new)" → "/clear"), or null. */
export function slashCommand(s: string): string | null {
  return /^(\/[A-Za-z0-9][\w:.-]*)/.exec(s)?.[1] ?? null;
}

/** Text of `cells` from column `from` (cell index) up to `to`, trailing spaces trimmed. */
export function textOf(cells: Cell[], from = 0, to = cells.length): string {
  return cells
    .slice(from, to)
    .map((c) => c.char)
    .join("")
    .trimEnd();
}

/** Index of the first cell whose character is one of `chars`, or -1. */
export function findCell(cells: Cell[], chars: string): number {
  return cells.findIndex((c) => chars.includes(c.char));
}

export function isBlank(cells: Cell[], from = 0): boolean {
  return textOf(cells, from).trim() === "";
}

/**
 * An input box's rows as its text: a row the terminal wrapped onto (`wrapped`) continues the one
 * above as it is; any other row starts a new line ("\n"; an agent that wraps long input itself
 * draws such rows too: the interceptor tells them apart by the keys). `text(y, wrapped)`: the
 * row's input text (a soft-wrapped row has no indent of its own).
 */
export function joinRows(screen: Screen, rows: number[], text: (y: number, wrapped: boolean) => string): string {
  let out = "";
  rows.forEach((y, i) => {
    const wrapped = i > 0 && !!screen.line(y).wrapped;
    out += (i === 0 || wrapped ? "" : "\n") + text(y, wrapped);
  });
  return out;
}

/** The index of the cell that covers screen column `x` (wide characters take two columns). */
export function cellIndexAt(cells: Cell[], x: number): number {
  let col = 0;
  for (let i = 0; i < cells.length; i++) {
    col += Math.max(1, Bun.stringWidth(cells[i]!.char));
    if (col > x) return i;
  }
  return cells.length;
}

/** The row a soft-wrapped row starts on: `y` itself, or the first of the rows `wrapped` chains it to. */
export function startOfRow(screen: Screen, y: number): number {
  while (y > 0 && screen.line(y).wrapped) y--;
  return y;
}

/**
 * The whole line `y` belongs to: the row it starts on (`start`) and the text of that row and every row
 * `wrapped` onto it, joined as the terminal wrapped it (a full row keeps its trailing space).
 */
export function logicalRow(screen: Screen, y: number): { start: number; text: string } {
  const start = startOfRow(screen, y);
  let text = "";
  for (let r = start; r < screen.rows; r++) {
    const line = screen.line(r);
    if (r > start && !line.wrapped) break;
    text += line.cells.map((c) => c.char).join("");
  }
  return { start, text: text.trimEnd() };
}
