import type { Cell, Screen, ScreenReader } from "../types.ts";
import { cellIndexAt, joinRows, logicalRow, slashCommand, textOf } from "./generic.ts";

/**
 * Claude Code (fixtures: `test/fixtures/screens/claude-code/`). The input box is a `❯ ` row with a
 * `────` border above and one below the last row of input (continuation rows are indented two
 * spaces). The slash menu sits right above the top border: item rows are `  /name   description`,
 * wrapped descriptions are indented rows. The highlighted item is drawn wholly in one accent
 * colour; the others are grey with the matched letters bold in the default colour.
 *
 * With NO_COLOR (or a theme without these colours) the highlight can't be read: `selectedCommand`
 * is null and the input line alone decides — a typed `/cl` picked from the menu then goes on
 * without a question (unsure → forward), never a wrong one.
 */
const isBorder = (cells: Cell[]) => cells.length > 10 && cells.slice(0, 10).every((c) => c.char === "─");

interface Box {
  top: number;
  rows: number[];
}

function box(screen: Screen): Box | null {
  const cur = screen.cursor().y;
  const candidates: number[] = [];
  for (let y = 1; y < screen.rows; y++) {
    const cells = screen.line(y).cells;
    if (cells[0]?.char === "❯" && isBorder(screen.line(y - 1).cells)) candidates.push(y);
  }
  if (!candidates.length) return null;
  // The box the cursor is in; else the lowest one.
  let start = candidates.at(-1)!;
  for (const y of candidates) if (y <= cur) start = y;
  const rows = [start];
  for (let y = start + 1; y < screen.rows && !isBorder(screen.line(y).cells); y++) rows.push(y);
  return { top: start - 1, rows };
}

interface Item {
  y: number;
  command: string;
  slashFg: number;
  /** Bold cells in the default colour (matched letters of an item that isn't highlighted). */
  boldDefault: boolean;
}

function menu(screen: Screen, top: number): Item[] {
  const items: Item[] = [];
  for (let y = top - 1; y >= 0; y--) {
    const { text, cells } = screen.line(y);
    const command = text.startsWith("  /") ? slashCommand(text.slice(2)) : null;
    if (command) {
      const name = cells.slice(2, 2 + command.length);
      items.unshift({ y, command, slashFg: cells[2]!.fg, boldDefault: name.some((c) => c.bold && c.fg === -1) });
    } else if (!/^ {8,}\S/.test(text)) break; // not a wrapped description either: the menu ended
  }
  return items;
}

/**
 * The rows Claude Code draws when a turn is cut off, under the prompt or the tool line: Esc
 * (`  ⎿ ` and a no-break space, `Interrupted · What should Claude do instead?`, fixture
 * `frame-interrupted`) or the context window full (`Context limit reached · /compact or /clear to
 * continue`, in the history of fixture `frame-precompact`); Claude draws a no-break space after the `⎿`. Anchored at the row's start: an agent's tool output is drawn the same
 * way, so a repo that prints the words can fake them; the damage is display only (`interrupted`).
 */
const CUT_OFF = /^ {2}⎿[ \u00a0]{2}(?:Interrupted · What should Claude do instead|Context limit reached · )/;
/** The turn's summary line that may follow it (`✻ Crunched for 2m 8s · done 9:42 PM`). */
const TURN_SUMMARY = /^✻ \S+ for \d/;

export const claudeCode: ScreenReader = {
  inputLine(screen) {
    const b = box(screen);
    if (!b) return null;
    const cur = screen.cursor();
    return joinRows(screen, b.rows, (y, wrapped) => {
      const cells = screen.line(y).cells;
      let end = cells.length;
      if (y === cur.y) {
        // A hint after the cursor ("[name]" after a completed command) is drawn in another colour
        // than the input itself.
        const at = cellIndexAt(cells, cur.x);
        const inputFg = cells[2]?.fg ?? -1;
        let i = at + 1;
        while (i < cells.length && cells[i]!.char === " ") i++;
        if (i < cells.length && (cells[i]!.dim || (cells[i]!.fg !== -1 && cells[i]!.fg !== inputFg))) end = i;
      }
      return textOf(cells, wrapped ? 0 : 2, end);
    }).trim();
  },
  selectedCommand(screen) {
    const b = box(screen);
    if (!b) return null;
    const items = menu(screen, b.top);
    if (!items.length) return null;
    if (items.length === 1) return items[0]!.slashFg !== -1 ? items[0]!.command : null;
    // The odd one out by colour.
    const count = new Map<number, number>();
    for (const it of items) count.set(it.slashFg, (count.get(it.slashFg) ?? 0) + 1);
    const unique = items.filter((it) => count.get(it.slashFg) === 1 && it.slashFg !== -1);
    if (unique.length === 1 && count.size === 2) return unique[0]!.command;
    // Two items in two colours: the one without default-coloured bold letters.
    const lit = unique.filter((it) => !it.boldDefault);
    return lit.length === 1 ? lit[0]!.command : null;
  },
  /**
   * The turn was cut off and Claude waits: the marker row is the last thing in the transcript, only
   * blank rows (and the turn's summary line) between it and the input box. A marker further up, with
   * a newer prompt or a spinner under it, is history (BUG-609; no hook comes on Esc).
   */
  interrupted(screen) {
    const b = box(screen);
    if (!b) return false;
    // A narrow terminal wraps the marker onto several rows: match the joined line, from the row it starts on.
    for (let y = b.top - 1; y >= 0; ) {
      const { start, text } = logicalRow(screen, y);
      y = start - 1;
      if (CUT_OFF.test(text)) return true;
      if (text.trim() !== "" && !TURN_SUMMARY.test(text)) return false;
    }
    return false;
  },
  /**
   * A dialog of Claude Code's own (the first run's "trust this folder" question; fixture
   * `frame-trust-dialog`): an option row ` ❯ No, exit` (the highlight; the others indented) and,
   * below the options, its footer: Enter to confirm, Esc to cancel (BUG-244).
   */
  awaitsChoice(screen) {
    let option = false;
    for (let y = 0; y < screen.rows; y++) {
      const text = screen.line(y).text;
      if (/^ *❯ \S/.test(text)) option = true;
      else if (option && /^ *Enter to confirm\s·\sEsc to cancel$/.test(text)) return true;
    }
    return false;
  },
};
