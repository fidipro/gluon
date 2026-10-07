/**
 * What must hold on Gluon's screen after every step, whatever the step was: the frame's chrome
 * where `layout` (`src/pty/chrome.ts`) puts it, whole and unwrapped; the home view one frame
 * rows − 1 tall with no session's terminal modes left on (its own SGR clicks only: BUG-269); the cursor where the user types; the
 * agent given exactly the user's bytes. `checkInvariants` lists what doesn't hold (empty: all
 * good); `assertInvariants` throws with that list and the screen.
 */
import { keyLabel } from "../../src/ui/layout.ts";
import { layout, MIN_COLS, MIN_ROWS } from "../../src/pty/chrome.ts";
import { WIN } from "./fixtures.ts";
import { type App, HOME_VIEW } from "./harness.ts";

/** Which view is up, as the screen shows it. */
export type View = "home" | "session" | "tooSmall";

export interface Expect {
  /** The view that should be up (default: whichever the screen shows). */
  view?: View;
  /** `handoff.key` (default `ctrl+\`): the bottom bar names it. */
  homeKey?: string;
  /** The shown session's tab name (part of it): the highlighted tab is that one. */
  tab?: string;
  /** Everything the fake agents read so far (`App.inputLog`), exactly. */
  inputLog?: string;
  /** At most this many full-screen clears since `app.mark()` (`App.clears`). */
  clears?: number;
  /** `handoff.mouse_capture` (default true): the home view tracks clicks (SGR), else no mouse (BUG-269). */
  capture?: boolean;
}

/** Below this many rows the home view has given its header up for the composer (BUG-162, BUG-228). */
const HEADER_MIN_ROWS = 10;

/** The view the screen shows. */
export function viewOf(app: App): View | null {
  const { cols, rows } = app.term;
  const lines = app.lines();
  if ((cols < MIN_COLS || rows < MIN_ROWS) && /^too small/.test(lines[0] ?? "")) return "tooSmall";
  if (lines[0]?.includes("◆ gluon")) return "session";
  if (HOME_VIEW.test(app.screen()) || lines.some((l) => /^\s*›( |$)/.test(l))) return "home";
  // A short composer scrolled to a draft's last lines shows no `›`: its two rules are the home view's.
  if (lines.filter((l) => /^\s*─{3,}\s*$/.test(l)).length >= 2) return "home";
  return null;
}

/** The visible row `y` of the screen. */
const lineAt = (app: App, y: number) => app.term.buffer.active.getLine(app.term.buffer.active.viewportY + y);
/** The character at column `x` of row `y` ("" for the right half of a wide one). */
const charAt = (app: App, x: number, y: number) => lineAt(app, y)?.getCell(x)?.getChars() ?? "";
const text = (app: App, y: number) => (lineAt(app, y)?.translateToString(true) ?? "").trimEnd();

/** The frame's border: whole, its corners and sides where `layout` puts them. */
function frameProblems(app: App): string[] {
  const { frame } = layout(app.term.cols, app.term.rows);
  const out: string[] = [];
  const right = frame.left + frame.cols - 1;
  const bottom = frame.top + frame.rows - 1;
  const want = (x: number, y: number, ch: string, what: string) => {
    if (charAt(app, x, y) !== ch) out.push(`frame: ${what} at ${x},${y} is ${JSON.stringify(charAt(app, x, y))}, not ${ch}`);
  };
  want(frame.left, frame.top, "┌", "top-left corner");
  want(right, frame.top, "┐", "top-right corner");
  want(frame.left, bottom, "└", "bottom-left corner");
  want(right, bottom, "┘", "bottom-right corner");
  for (let y = frame.top + 1; y < bottom; y++) {
    want(frame.left, y, "│", "left side");
    want(right, y, "│", "right side");
  }
  // The top border: `┌─ triple ─…─┐`, dashes up to the corner; the bottom one dashes (and the scroll footer).
  if (!/─┐$/.test(text(app, frame.top))) out.push(`frame: the top border doesn't end in ─┐: ${JSON.stringify(text(app, frame.top))}`);
  if (!/^└─.*─┘$/.test(text(app, bottom))) out.push(`frame: the bottom border isn't └─…─┘: ${JSON.stringify(text(app, bottom))}`);
  return out;
}

/** The highlighted tab on the strip: the one underlined run of row 0, its text. */
function highlighted(app: App): string[] {
  const line = lineAt(app, 0);
  const runs: string[] = [];
  let cur: string | null = null;
  for (let x = 0; line && x < app.term.cols; x++) {
    const c = line.getCell(x);
    if (c?.isUnderline()) cur = (cur ?? "") + (c.getChars() || (c.getWidth() ? " " : ""));
    else if (cur !== null) runs.push(cur.trim()), (cur = null);
  }
  if (cur !== null) runs.push(cur.trim());
  return runs;
}

function sessionProblems(app: App, e: Expect): string[] {
  const { cols, rows } = app.term;
  const lay = layout(cols, rows);
  const lines = Array.from({ length: rows }, (_, y) => text(app, y));
  const out: string[] = [];
  if (!lines[lay.tabRow]!.startsWith(" ◆ gluon")) out.push(`tab strip: row ${lay.tabRow} doesn't start with ◆ gluon: ${JSON.stringify(lines[lay.tabRow])}`);
  const bar = lines[lay.barRow]!;
  const question = /^ \? /.test(bar);
  const home = keyLabel(e.homeKey ?? "ctrl+\\");
  if (!question && !bar.includes(`${home} `) && !bar.endsWith(home)) out.push(`bottom bar: the last row is neither the bar (naming ${home}) nor a question: ${JSON.stringify(bar)}`);
  out.push(...frameProblems(app));
  // Chrome is written row by row, padded to the width: a row that wrapped pushed the next one down.
  // Not on Windows: ConPTY hands on a full-width row followed by another as one wrapped line (every such row reads `isWrapped`, measured
  // on Windows 11); the rows' text, checked above and below, is where a real wrap shows.
  if (!WIN)
    for (const y of [lay.tabRow, lay.infoRow, lay.frame.top, lay.frame.top + lay.frame.rows - 1, lay.barRow, lay.barRow + 1])
      if (y < rows && lineAt(app, y)?.isWrapped) out.push(`chrome: row ${y} continues a wrapped row above`);
  const tabs = highlighted(app);
  if (tabs.length !== 1) out.push(`tab strip: ${tabs.length} highlighted tabs (${JSON.stringify(tabs)}), not 1`);
  else if (e.tab && !tabs[0]!.includes(e.tab)) out.push(`tab strip: the highlighted tab is ${JSON.stringify(tabs[0])}, not ${e.tab}`);
  // The info line and the frame's title name the same session's triple (the info line's may be cut: BUG-257; cut at a segment, it ends before a " × ").
  const info = lines[lay.infoRow]!.trim().split(" · ")[0]!;
  const title = /^┌─ (.*?) ─+┐$/.exec(lines[lay.frame.top]!)?.[1];
  const same = info === title || (info.endsWith("…") && !!title?.startsWith(info.slice(0, -1))) || !!title?.startsWith(`${info} × `);
  if (info.includes(" × ") && title && !title.includes("…") && !same) out.push(`info line: its triple ${JSON.stringify(info)} isn't the frame's ${JSON.stringify(title)}`);
  const cur = app.cursor();
  const r = lay.interior;
  if (cur.visible && (cur.x < r.left || cur.x >= r.left + r.cols || cur.y < r.top || cur.y >= r.top + r.rows)) out.push(`cursor: shown at ${cur.x},${cur.y}, outside the interior (${r.left},${r.top} ${r.cols}×${r.rows})`);
  return out;
}

function homeProblems(app: App, capture: boolean): string[] {
  const { rows } = app.term;
  const out: string[] = [];
  const lines = Array.from({ length: rows }, (_, y) => text(app, y));
  if (rows >= HEADER_MIN_ROWS && !lines.slice(0, 4).some((l) => /Gluon v\d/.test(l))) out.push("home: no header (Gluon v…) at the top");
  // The composer: its `›` row, or the count of the rows a short one scrolled out of view.
  const composer = lines.findIndex((l) => /^\s*›( |$)/.test(l) || /^\s*↑ \d+ more lines?$/.test(l));
  if (composer < 0) out.push("home: no composer (› …)");
  // One frame rows − 1 tall: it reaches row rows − 2 (the composer's rule), the last row is free
  // (for the quit or end question).
  if (!lines[rows - 2]!.trim()) out.push(`home: row ${rows - 2} is blank: the frame isn't rows − 1 tall`);
  const last = lines[rows - 1]!;
  // A drag over the home view's text copies it and says so there for a moment (BUG-286): ` Copied 12 characters`.
  if (last.trim() && !/^ \? /.test(last) && !/^ Copied\b/.test(last)) out.push(`home: the last row isn't free or a question: ${JSON.stringify(last)}`);
  // No session's modes left on the real terminal: Gluon's own clicks and drags only, in SGR (BUG-269, BUG-286).
  const m = app.modes();
  const mouse = capture ? "drag/sgr" : "none/default";
  if (`${m.mouseTracking}/${m.mouseEncoding}` !== mouse) out.push(`home: mouse ${m.mouseTracking}/${m.mouseEncoding}, not ${mouse}`);
  // ConPTY turns focus reports on itself (`?1004h` at its start) and keeps a program's `?1004l` to itself: on Windows they are always on.
  if (m.focus && !WIN) out.push("home: focus reports left on");
  if (m.kittyFlags) out.push(`home: kitty flags left on (${m.kittyFlags})`);
  const depth = app.kittyDepth();
  if (depth) out.push(`home: ${depth} kitty keyboard entr${depth === 1 ? "y" : "ies"} left pushed`);
  // The composer draws its own cursor; the terminal's stays hidden or on the composer.
  const cur = app.cursor();
  if (cur.visible && !/^\s*›( |$)/.test(lines[cur.y] ?? "")) out.push(`cursor: shown at ${cur.x},${cur.y}, off the composer`);
  return out;
}

/** Everything that doesn't hold on the screen now (empty: all good). */
export function checkInvariants(app: App, e: Expect = {}): string[] {
  const out: string[] = [];
  const { cols, rows } = app.term;
  const small = cols < MIN_COLS || rows < MIN_ROWS;
  const view = viewOf(app);
  if (e.view && view !== e.view) out.push(`view: ${view ?? "unknown"}, not ${e.view}`);
  if (view === "session" && small) out.push(`view: the frame drawn at ${cols}×${rows}, below ${MIN_COLS}×${MIN_ROWS}`);
  else if (view === "session") out.push(...sessionProblems(app, e));
  else if (view === "home") out.push(...homeProblems(app, e.capture ?? true));
  else if (view === "tooSmall") {
    const home = keyLabel(e.homeKey ?? "ctrl+\\");
    // Narrower than the whole line, it is cut (`render`).
    if (cols >= Bun.stringWidth(`too small · ${home} home`) && !(app.lines()[0] ?? "").includes(`${home} home`)) out.push(`too small: the line doesn't name ${home}: ${JSON.stringify(app.lines()[0])}`);
  } else if (!small) out.push("view: neither the home view nor a session's frame");
  if (e.inputLog !== undefined && app.inputLog() !== e.inputLog) out.push(`input: the agents got ${JSON.stringify(app.inputLog())}, not ${JSON.stringify(e.inputLog)}`);
  if (e.clears !== undefined && app.clears().screen > e.clears) out.push(`clears: ${app.clears().screen} full-screen clears since the mark, more than ${e.clears}`);
  return out;
}

/** Throws when an invariant doesn't hold: each problem on a line, then the screen. */
export function assertInvariants(app: App, e: Expect = {}): void {
  const problems = checkInvariants(app, e);
  if (problems.length) throw new Error(`Gluon's invariants broke:\n${problems.map((p) => `  - ${p}`).join("\n")}\nscreen (${app.term.cols}×${app.term.rows}):\n${app.screen()}`);
}
