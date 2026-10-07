import type { Screen, ScreenReader } from "../types.ts";
import { isBlank, joinRows, logicalRow, slashCommand, textOf } from "./generic.ts";

/**
 * Codex (fixtures: `test/fixtures/screens/codex/`). The composer is `› ` + the input
 * (continuation rows indented two spaces), on a shaded background with a blank row above and
 * below; an empty composer shows a faint placeholder. The slash menu touches the composer (only
 * the blank row between): item rows `  /name  description`, the highlighted one starting with a
 * bold `› `. Past prompts in the history also start with `› `, hence the adjacency.
 */
function composer(screen: Screen): number[] | null {
  const cur = screen.cursor().y;
  if (cur < 0 || cur >= screen.rows) return null;
  const shaded = (y: number) => (screen.line(y).cells[0]?.bg ?? -1) !== -1;
  const rows = [cur];
  if (shaded(cur)) {
    for (let y = cur - 1; y >= 0 && shaded(y) && !isBlank(screen.line(y).cells); y--) rows.unshift(y);
    for (let y = cur + 1; y < screen.rows && shaded(y) && !isBlank(screen.line(y).cells); y++) rows.push(y);
  }
  return screen.line(rows[0]!).cells[0]?.char === "›" ? rows : null;
}

const isItem = (text: string) => /^(› | {2})\/\S/.test(text);

/** Menu rows next to the composer, above or below it. */
function menu(screen: Screen, rows: number[]): number[] {
  const out: number[] = [];
  for (const [from, step] of [
    [rows[0]! - 1, -1],
    [rows.at(-1)! + 1, 1],
  ] as const) {
    let y = from;
    if (y >= 0 && y < screen.rows && isBlank(screen.line(y).cells)) y += step;
    while (y >= 0 && y < screen.rows && isItem(screen.line(y).text)) {
      out.push(y);
      y += step;
    }
  }
  return out;
}

/** A dialog's highlighted option: `› ` (a list, the trust and approval questions) or `  › ` (a question), drawn inverse. */
const HIGHLIGHT = /^( {0,2})› \S/;
/** A dialog's key hints, below its options: two spaces and `esc` named ("enter continue · esc quit", "t trust · esc back"). */
const HINTS = /^ {2}\S.*\besc\b/;

/** Plan mode's mark: the footer's first row ends with `Plan mode` in magenta (SGR 35); the switch also prints a history line. */
const PLAN_FOOTER = "Plan mode";
const MAGENTA = 5;
const PLAN_SWITCHED = /^• Model changed to .+ for Plan mode\.$/;

/** Esc's history line (`■ Conversation interrupted - use /feedback if something went wrong`, fixture `frame-interrupted`), at the row's start: a model's reply is `• `, its continuation rows and a tool's output are indented. */
const INTERRUPTED = "■ Conversation interrupted";

export const codex: ScreenReader = {
  inputLine(screen) {
    const rows = composer(screen);
    if (!rows) return null;
    return joinRows(screen, rows, (y, wrapped) => textOf(screen.line(y).cells.map((c) => (c.dim ? { ...c, char: " " } : c)), wrapped ? 0 : 2)).trim();
  },
  selectedCommand(screen) {
    const rows = composer(screen);
    if (!rows) return null;
    for (const y of menu(screen, rows)) {
      const { text, cells } = screen.line(y);
      if (cells[0]?.char === "›" && cells[0].bold) return slashCommand(text.slice(2));
    }
    return null;
  },
  /**
   * Plan mode is on (fixture `plan-mode-idle`, Codex 0.160.0): the row below the composer (a blank
   * row may come between) ends with `Plan mode`, magenta; or the history says the model changed for it.
   */
  planMode(screen) {
    const rows = composer(screen);
    if (rows) {
      for (let y = rows.at(-1)! + 1; y < Math.min(screen.rows, rows.at(-1)! + 3); y++) {
        const cells = screen.line(y).cells;
        let last = cells.length - 1;
        while (last >= 0 && cells[last]!.char.trim() === "") last--;
        const from = last - PLAN_FOOTER.length + 1;
        if (from < 0) continue;
        const tail = cells.slice(from, last + 1);
        if (tail.map((c) => c.char).join("") === PLAN_FOOTER && tail.every((c) => c.fg === MAGENTA)) return true;
      }
    }
    for (let y = 0; y < screen.rows; y++) if (PLAN_SWITCHED.test(screen.line(y).text)) return true;
    return false;
  },
  /**
   * The turn was cut off and Codex waits: the interruption's history line is the last thing above
   * the composer, only blank rows between (BUG-609; no hook comes on Esc). A newer prompt or the
   * working line under it makes it history.
   */
  interrupted(screen) {
    const rows = composer(screen);
    if (!rows) return false;
    // A narrow terminal wraps the line onto several rows: match the joined line, from the row it starts on.
    for (let y = rows[0]! - 1; y >= 0; ) {
      const { start, text } = logicalRow(screen, y);
      y = start - 1;
      if (text.startsWith(INTERRUPTED)) return true;
      if (text.trim() !== "") return false;
    }
    return false;
  },
  /**
   * A dialog of Codex's own that waits for a pick: the folder trust question, the hooks' review (a
   * hook that hasn't been approved never runs, so none can report it), a command or patch to
   * approve, a `request_user_input` question (Codex's hook says only that its tool is running), the
   * model picker. An inverse highlighted option row (`› 1. Yes, proceed`) with, below it, the
   * key hints row naming Esc (fixtures `frame-folder-trust`, `frame-hook-*`,
   * `frame-approve-*`, `frame-plan-question*`, `frame-model-picker`; issue #40). A past prompt in
   * the history starts with `› ` too, but bold and faint, not inverse.
   */
  awaitsChoice(screen) {
    let option = false;
    for (let y = 0; y < screen.rows; y++) {
      const { text, cells } = screen.line(y);
      const at = HIGHLIGHT.exec(text);
      if (at) {
        if (cells[at[1]!.length]?.inverse) option = true;
      } else if (option && HINTS.test(text)) return true;
    }
    return false;
  },
};
