import type { Cell, Screen, ScreenReader } from "../types.ts";
import { joinRows, slashCommand, textOf } from "./generic.ts";

/**
 * Antigravity (fixtures: `test/fixtures/screens/antigravity/`). The input box is a `> ` row
 * between two `────` borders; agy word-wraps long input itself onto rows indented two spaces. An
 * empty box shows no placeholder. The slash menu sits right below the bottom border: item rows
 * `  /name   description`, the highlighted one marked `> ` (and drawn in the accent colour, which
 * the marker makes needless to read: it works without colour too); `↑ 1 more` / `↓ 11 more` and
 * `No matches` rows are no items. Tab completes the item (it doesn't run it).
 */
const isBorder = (cells: Cell[]) => cells.length > 10 && cells.slice(0, 10).every((c) => c.char === "─");

interface Box {
  rows: number[];
  /** The bottom border. */
  bottom: number;
}

function box(screen: Screen): Box | null {
  const cur = screen.cursor().y;
  const candidates: number[] = [];
  for (let y = 1; y < screen.rows; y++) {
    const cells = screen.line(y).cells;
    if (cells[0]?.char === ">" && cells[1]?.char === " " && isBorder(screen.line(y - 1).cells)) candidates.push(y);
  }
  if (!candidates.length) return null;
  // The box the cursor is in; else the lowest one.
  let start = candidates.at(-1)!;
  for (const y of candidates) if (y <= cur) start = y;
  const rows = [start];
  let y = start + 1;
  for (; y < screen.rows && !isBorder(screen.line(y).cells); y++) rows.push(y);
  return y < screen.rows ? { rows, bottom: y } : null;
}

const ITEM = /^(> | {2})\/\S/;

export const antigravity: ScreenReader = {
  inputLine(screen) {
    const b = box(screen);
    if (!b) return null;
    return joinRows(screen, b.rows, (y, wrapped) => textOf(screen.line(y).cells.map((c) => (c.dim ? { ...c, char: " " } : c)), wrapped ? 0 : 2)).trim();
  },
  selectedCommand(screen) {
    const b = box(screen);
    if (!b) return null;
    let items = 0;
    const lit: string[] = [];
    for (let y = b.bottom + 1; y < screen.rows; y++) {
      const { text } = screen.line(y);
      if (/^ {3}[↑↓] \d+ more$/.test(text)) continue;
      if (!ITEM.test(text)) break;
      items++;
      if (text.startsWith("> ")) lit.push(slashCommand(text.slice(2))!);
    }
    return lit.length === 1 ? lit[0]! : items ? "" : null;
  },
};
