import type { Screen, ScreenReader } from "../types.ts";
import { cellIndexAt, findCell, isBlank, joinRows, slashCommand, textOf } from "./generic.ts";

/**
 * OpenCode (fixtures: `test/fixtures/screens/opencode/`). The composer is a panel with a `┃` left
 * border: a blank row, the input two cells after the border, a blank row, the agent · model row.
 * An empty composer shows a muted placeholder with the cursor at its start. The slash menu is a
 * panel right above the composer: rows `┃ /name   description`, the highlighted one on an accent
 * background (the others share the composer's background). Tab, like Enter, runs that item.
 */
function composer(screen: Screen): { rows: number[]; from: number; bg: number } | null {
  const cur = screen.cursor();
  if (cur.y < 0 || cur.y >= screen.rows) return null;
  const cells = screen.line(cur.y).cells;
  const border = findCell(cells, "┃");
  if (border < 0 || border >= cellIndexAt(cells, cur.x)) return null;
  const from = border + 3;
  const inBox = (y: number) => {
    const c = screen.line(y).cells;
    return c[border]?.char === "┃" && !isBlank(c, border + 1);
  };
  const rows = [cur.y];
  for (let y = cur.y - 1; y >= 0 && inBox(y) && !isItem(screen.line(y).cells, border); y--) rows.unshift(y);
  for (let y = cur.y + 1; y < screen.rows && inBox(y); y++) rows.push(y);
  return { rows, from, bg: cells[border + 1]?.bg ?? -1 };
}

function isItem(cells: ReturnType<Screen["line"]>["cells"], border: number): boolean {
  return cells[border + 1]?.char === " " && cells[border + 2]?.char === "/" && !!slashCommand(textOf(cells, border + 2));
}

export const opencode: ScreenReader = {
  inputLine(screen) {
    const box = composer(screen);
    if (!box) return null;
    const cur = screen.cursor();
    const text = joinRows(screen, box.rows, (y) => textOf(screen.line(y).cells, box.from)).trim();
    // The placeholder: the cursor sits at the start of an "input" that isn't a command.
    const cells = screen.line(cur.y).cells;
    if (box.rows.length === 1 && cellIndexAt(cells, cur.x) === box.from && !text.startsWith("/")) return "";
    return text;
  },
  selectedCommand(screen) {
    const box = composer(screen);
    if (!box) return null;
    const border = box.from - 3;
    const lit: string[] = [];
    let items = 0;
    // The menu panel: item rows right above the composer's top padding row.
    let y = box.rows[0]! - 1;
    if (y >= 0 && isBlank(screen.line(y).cells, border + 1)) y--;
    for (; y >= 0; y--) {
      const cells = screen.line(y).cells;
      if (!isItem(cells, border)) break;
      items++;
      if (cells[border + 2]!.bg !== box.bg) lit.push(slashCommand(textOf(cells, border + 2))!);
    }
    // Without its accent background (NO_COLOR) the highlight can't be read, and OpenCode's fuzzy
    // menu may run another item than the input names ("/review" for "/compact"): unsure.
    return lit.length === 1 ? lit[0]! : items ? "" : null;
  },
};
