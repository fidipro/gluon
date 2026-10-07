import type { Cell, Screen, ScreenReader } from "../types.ts";
import { joinRows } from "./generic.ts";

/**
 * Kimi Code (fixtures: `test/fixtures/screens/kimi-code/`). The composer is a rounded box: `╭──╮`, a first row `│ > <input> │`,
 * continuation rows `│   <input> │` (kimi wraps long input by words) and `╰──╯`, with the welcome box, notices and the
 * tip row above it and a footer below. A command typed whole is followed by a grey hint (`/compact  <instruction>`: not input).
 * The slash menu is a panel BELOW the composer, its rows right after the box's bottom border: `│   → name  description │`
 * (the highlighted one, the arrow is the marker, no colour needed) or `│     name  description │`; a name may carry its
 * aliases (`new (clear)`: /clear is /new's alias); long descriptions wrap onto rows with nothing under the name; the last
 * row is a count `(1/51)`. The folder-trust question (a full-width rule, `Trust this folder?`) has no composer.
 */
interface Box {
  /** Cell index of the `│` the rows start with; the input starts four cells after it. */
  border: number;
  /** The input rows, first to last; the bottom border is the row after the last. */
  rows: number[];
  right: number[];
}

/** The hint after a whole command: grey 136,136,136 (typed text is the default colour, a command bold blue). */
const GHOST = (0x88 << 16) | (0x88 << 8) | 0x88;

const charAt = (cells: Cell[], i: number) => cells[i]?.char;
const lastBar = (cells: Cell[]) => {
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i]!.char === "│") return i;
  return -1;
};

/** The lowest composer on the screen: a `│ > ` row under a `╭` border and over a `╰` one. */
function composer(screen: Screen): Box | null {
  for (let y = screen.rows - 2; y >= 1; y--) {
    const cells = screen.line(y).cells;
    const border = cells.findIndex((c) => c.char !== " ");
    if (border < 0 || cells[border]!.char !== "│" || charAt(cells, border + 1) !== " " || charAt(cells, border + 2) !== ">" || charAt(cells, border + 3) !== " ") continue;
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

const text = (cells: Cell[], from: number, to?: number) => cells.slice(from, to).map((c) => c.char).join("").trimEnd();

/** A menu row's name and aliases (`new (clear)`), or null for a row that isn't an item (a wrapped description, the count). */
function item(cells: Cell[], border: number): { name: string; aliases: string[]; lit: boolean } | null {
  if (charAt(cells, border) !== "│" || charAt(cells, border + 1) !== " " || charAt(cells, border + 2) !== " " || charAt(cells, border + 3) !== " ") return null;
  const mark = charAt(cells, border + 4);
  if ((mark !== "→" && mark !== " ") || charAt(cells, border + 5) !== " ") return null;
  const m = /^(\S+)(?: \(([^)]*)\))?(?: {2}|$)/.exec(text(cells, border + 6, lastBar(cells)));
  if (!m || /^\(\d+\/\d+\)$/.test(m[1]!)) return null;
  return { name: m[1]!, aliases: m[2] ? m[2].split(",").map((a) => a.trim()).filter(Boolean) : [], lit: mark === "→" };
}

function input(screen: Screen, box: Box): string {
  return joinRows(screen, box.rows, (y) => {
    const i = box.rows.indexOf(y);
    return text(screen.line(y).cells.slice(box.border + 4, box.right[i]).map((c) => (c.fg === GHOST && !c.inverse ? { ...c, char: " " } : c)), 0);
  }).trim();
}

/** A full-width rule: Kimi's own prompt sits under one and above another. */
const isRule = (t: string) => t.length >= 20 && /^─+$/.test(t);

/** `↑/↓ select · 1/2/3 choose · ↵ confirm`: the number of options its `1/…/N` names, or 0 for any other row. */
function hintedOptions(t: string): number {
  const m = /^↑\/↓ select · (\d(?:\/\d)+) choose · ↵ confirm$/.exec(t);
  const nums = m ? m[1]!.split("/").map(Number) : [];
  return nums.every((n, i) => n === i + 1) ? nums.length : 0;
}

/**
 * Kimi's selection prompt (BUG-611), from the bottom up: the hints row (the anchor; N its numbers), a rule under it and
 * only the footer below that, a blank row above it, the options `1.`…`N.` (one marked `▶`, all in one column), a blank
 * row, the body (a plan, a command), and the `▶ <question>` title directly under a rule. Any other shape is not it.
 */
function selectionPrompt(screen: Screen): boolean {
  const rows = Array.from({ length: screen.rows }, (_, y) => screen.line(y).text);
  const t = rows.map((r) => r.trim());
  let y = rows.length - 1;
  while (y >= 0 && !hintedOptions(t[y]!)) y--;
  if (y < 0) return false;
  const count = hintedOptions(t[y]!);
  if (!isRule(t[y + 1] ?? "") || t.slice(y + 2).filter(Boolean).length > 3 || t[y - 1] !== "") return false;
  let marked = 0;
  let column = -1;
  for (let k = 1; k <= count; k++) {
    const m = /^( *)(▶ )?(\d)\. \S/.exec(rows[y - 2 - count + k] ?? "");
    if (!m || Number(m[3]) !== k) return false;
    if (m[2]) marked++;
    const at = m[1]!.length + (m[2] ? 2 : 0);
    if (column >= 0 && at !== column) return false;
    column = at;
  }
  if (marked !== 1 || t[y - 2 - count] !== "") return false;
  let rule = y - 3 - count;
  while (rule >= 0 && !isRule(t[rule]!)) rule--;
  return rule >= 0 && t[rule + 1]!.startsWith("▶ ") && t[rule + 1]!.length > 2;
}

/** `↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel` (the tab switch only with several questions): the number of options, or 0 for any other row. */
function questionHints(t: string): number {
  const m = /^↑↓ select\s+1-(\d)\s*\/\s*↵ choose(?:\s+←\/→\/tab switch)?\s+esc cancel$/.exec(t);
  const n = m ? Number(m[1]) : 0;
  return n >= 2 ? n : 0;
}

/** An option of the question panel: `→ [1] label` (the highlighted one) or `   [2] label`; the label may wrap onto rows indented under it. */
const QUESTION_OPTION = /^( *)(→ )?\[(\d)\] \S/;

/**
 * Kimi's `question` panel (BUG-663; plan mode asks the user something), from the bottom up: the hints row (the anchor; N
 * its `1-N`) with only the footer below it, a blank row or none, the options `[1]`…`[N]` (one marked `→`, all in one
 * column, no blank between), a blank row or none, and the `? <question>` row (wrapped rows indented under it). The tab
 * bar above (`question  Tests  Submit`) is not read. Any other shape is not it: the agent's own output may hold `[1]`
 * lists and these words.
 */
function questionPanel(screen: Screen): boolean {
  const rows = Array.from({ length: screen.rows }, (_, y) => screen.line(y).text);
  const t = rows.map((r) => r.trim());
  let y = rows.length - 1;
  while (y >= 0 && !questionHints(t[y]!)) y--;
  if (y < 0) return false;
  const count = questionHints(t[y]!);
  if (t.slice(y + 1).filter(Boolean).length > 3) return false;
  let at = y - 1;
  if (t[at] === "") at--;
  let marked = 0;
  let column = -1;
  for (let k = count; k >= 1; k--) {
    const wrapped: number[] = [];
    let m = QUESTION_OPTION.exec(rows[at] ?? "");
    while (!m) {
      if (at < 0 || !t[at] || wrapped.length >= 3) return false;
      wrapped.push(at--);
      m = QUESTION_OPTION.exec(rows[at] ?? "");
    }
    const bracket = m[1]!.length + (m[2] ? 2 : 0);
    if (Number(m[3]) !== k || (column >= 0 && bracket !== column)) return false;
    // A wrapped label sits under its option, further in than the bracket.
    if (wrapped.some((w) => rows[w]!.length - rows[w]!.trimStart().length <= bracket)) return false;
    if (m[2]) marked++;
    column = bracket;
    at--;
  }
  if (marked !== 1) return false;
  if (t[at] === "") at--;
  const wrapped: number[] = [];
  while (at >= 0 && !t[at]!.startsWith("? ")) {
    if (!t[at] || wrapped.length >= 3) return false;
    wrapped.push(at--);
  }
  if (at < 0 || t[at]!.length <= 2) return false;
  const indent = rows[at]!.length - rows[at]!.trimStart().length;
  return wrapped.every((w) => rows[w]!.length - rows[w]!.trimStart().length > indent);
}

/** The footer under the composer: `[plan  ]<model> [thinking  ]<folder>  <branch>` (the folder may be cut with an ellipsis). */
const FOOTER = /^ *(?:plan {2})?\S+ +(?:thinking +)?(?:~|\/|[A-Za-z]:[\\/])/;

/**
 * Kimi has applied its model (BUG-674). The composer is drawn first, empty, at the top; 0.1 to 1 s later the welcome
 * banner (its `Model:     <name>` row inside the box) is drawn above it and the footer (model, folder, branch) under it,
 * both at once. A line sent into the early composer can reach Kimi before the env model is set: `Error: LLM not set,
 * send "/login" to login`, and the line is dropped. Either mark means ready; a repo's text can draw them too, which at
 * worst types the line early (the screen decides when, never what).
 */
function modelShown(screen: Screen): boolean {
  const box = composer(screen);
  for (let y = 0; y < screen.rows; y++) {
    const t = screen.line(y).text;
    if (/^ *│ +Model: {5}\S/.test(t)) return true;
    if (box && y > box.rows.at(-1)! + 1 && FOOTER.test(t)) return true;
  }
  return false;
}

export const kimiCode: ScreenReader = {
  ready: modelShown,
  inputLine(screen) {
    const box = composer(screen);
    return box ? input(screen, box) : null;
  },
  selectedCommand(screen) {
    const box = composer(screen);
    if (!box) return null;
    let items = 0;
    const lit: ReturnType<typeof item>[] = [];
    for (let y = box.rows.at(-1)! + 2; y < screen.rows; y++) {
      const cells = screen.line(y).cells;
      if (charAt(cells, box.border) !== "│") break;
      const it = item(cells, box.border);
      if (!it) continue;
      items++;
      if (it.lit) lit.push(it);
    }
    // A panel with items and no single highlight we can find: Enter may run any: unsure.
    if (lit.length !== 1) return items ? "" : null;
    // Enter runs the item whatever name was typed: the name the typed text begins (`/cl` for `new (clear)` is /clear), else the item's own.
    const typed = input(screen, box);
    const names = [lit[0]!.name, ...lit[0]!.aliases].map((n) => `/${n}`);
    return (typed && names.find((n) => n.startsWith(typed))) || names[0]!;
  },
  /**
   * Kimi's own questions that wait for a pick, display only, no composer: the folder-trust question
   * (`frame-trust-dialog`: its title and `↑↓ navigate · Enter select`) and its selection prompts (`selectionPrompt`: the
   * plan approval, `frame-plan-approval` and `frame-plan-alternatives`, and a command to approve, `frame-cmd-approval`;
   * BUG-611: each showed Working for minutes), and its `question` panel (`questionPanel`, `frame-question-panel`; BUG-663).
   */
  awaitsChoice(screen) {
    let title = false;
    let hints = false;
    for (let y = 0; y < screen.rows; y++) {
      const t = screen.line(y).text.trim();
      if (t === "Trust this folder?") title = true;
      else if (t.startsWith("↑↓ navigate") && t.includes("Enter select")) hints = true;
    }
    return ((title && hints) || selectionPrompt(screen) || questionPanel(screen)) && composer(screen) === null;
  },
};
