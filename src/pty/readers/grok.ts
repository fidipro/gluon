import type { Cell, Screen, ScreenReader } from "../types.ts";
import { isBlank, joinRows, slashCommand } from "./generic.ts";

/**
 * Grok Build (fixtures: `test/fixtures/screens/grok-build/`). The composer is a rounded box:
 * `╭──╮`, a first row `│ ❯ <input> │`, continuation rows `│   <input> │` (words wrap onto them), and
 * `╰──── Grok 4.7 (low) ─╯` below, whose label gains ` · plan` in plan mode. The box and its
 * `❯` are what to read, not the cursor's row: the cursor is hidden while the start screen draws and
 * moves around as it animates, so mid-draw it isn't on the composer (BUG-411; once drawn it is).
 * An empty composer has no placeholder; a completion ghost (`/c` shows `/clear`) is the rest in
 * grey, drawn after the typed text. The slash menu is a panel right above the composer, between
 * two rules: item rows `    ❯ /name  description` (the highlighted one) and six spaces for the others.
 */
interface Box {
  /** Cell index of the `│` the rows start with; the input starts four cells after it. */
  border: number;
  /** The input rows, first to last; the top border is the row above the first, the bottom border the row below the last. */
  rows: number[];
  /** Cell index of the right `│` (each row's input ends before it). */
  right: number[];
}

/** The ghost of a completion: grey 108,108,108 (typed text is 225,225,225, a command blue). */
const GHOST = (108 << 16) | (108 << 8) | 108;

const charAt = (cells: Cell[], i: number) => cells[i]?.char;
const lastBar = (cells: Cell[]) => {
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i]!.char === "│") return i;
  return -1;
};

/** The lowest composer on the screen: a `│ ❯ ` row under a `╭` border and over a `╰` one. */
function composer(screen: Screen): Box | null {
  for (let y = screen.rows - 2; y >= 1; y--) {
    const cells = screen.line(y).cells;
    const border = cells.findIndex((c) => c.char !== " ");
    if (border < 0 || cells[border]!.char !== "│" || charAt(cells, border + 1) !== " " || charAt(cells, border + 2) !== "❯") continue;
    if (charAt(screen.line(y - 1).cells, border) !== "╭") continue;
    const rows = [y];
    const right = [lastBar(cells)];
    let end = y + 1;
    for (; end < screen.rows; end++) {
      const c = screen.line(end).cells;
      if (charAt(c, border) !== "│" || charAt(c, border + 1) !== " ") break;
      rows.push(end);
      right.push(lastBar(c));
    }
    if (end < screen.rows && charAt(screen.line(end).cells, border) === "╰" && right.every((r) => r > border + 4)) return { border, rows, right };
  }
  return null;
}

const itemText = (screen: Screen, y: number) => screen.line(y).text;
const RULE = /^ {2}─{10}/;
const SELECTED = /^ {4}❯ \/\S/;
const ITEM = /^ {4}(?:❯ | {2})\/\S/;

export const grok: ScreenReader = {
  inputLine(screen) {
    const box = composer(screen);
    if (!box) return null;
    return joinRows(screen, box.rows, (y) => {
      const i = box.rows.indexOf(y);
      const cells = screen.line(y).cells.slice(box.border + 4, box.right[i]).map((c) => (c.dim || c.fg === GHOST ? { ...c, char: " " } : c));
      return cells.map((c) => c.char).join("").trimEnd();
    }).trim();
  },
  /** The panel above the composer: its bottom rule is the row above the box's top border, its highlighted row starts `❯ /`. */
  selectedCommand(screen) {
    const box = composer(screen);
    if (!box) return null;
    let y = box.rows[0]! - 2;
    if (y < 0 || !RULE.test(itemText(screen, y))) return null;
    let items = 0;
    let lit: string | null = null;
    for (y--; y >= 0 && !RULE.test(itemText(screen, y)); y--) {
      const text = itemText(screen, y);
      if (!ITEM.test(text)) continue;
      items++;
      if (SELECTED.test(text)) lit = slashCommand(text.slice(6));
    }
    // A panel with items and no highlight we can find: Enter may run any: unsure.
    return lit ?? (items ? "" : null);
  },
  /**
   * Plan mode is on (fixture `plan-mode`, Grok Build 1.0.46): the composer's bottom border names it
   * (`╰── Grok 4.7 (low) · plan ─╯`; normal mode names only the model). The `✓ Plan mode: on`
   * notice is gone after a few seconds, so it isn't read. A mode switch is the user's too
   * (Shift+Tab): display only.
   */
  planMode(screen) {
    const box = composer(screen);
    if (!box) return false;
    const below = screen.line(box.rows.at(-1)! + 1);
    return !isBlank(below.cells) && below.text.endsWith(" · plan ─╯");
  },
};
