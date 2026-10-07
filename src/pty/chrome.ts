/**
 * Gluon's chrome around an open session (design brief 5.3): the tab strip, the info line, the frame
 * with the agent triple set into its top border, and the bottom bar (or the question bar in its
 * place). Pure functions from state to bytes; the compositor (`compositor.ts`) places them. Colours
 * are the home view's (`GLUON_HEX`, `fg`/`bg` in `src/ui/theme.ts`), on the ground like the home.
 *
 * Every row is written whole, from an SGR reset, padded to the width: never EL/ED, which would
 * erase with whatever colour is current. Text from an agent (names, activity) arrives already made
 * safe (`safeLine`); widths are cells, cut by grapheme (`truncate`).
 */
import type { Config } from "../config.ts";
import { contextLabel, costLabel, elapsed, groupOf, type SessionState, type SessionView } from "../sessions.ts";
import { CONTEXT_WARN, fitSegs, GLYPH, keyLabel, segsWidth, sw, tripleSegs, truncate, type Seg } from "../ui/layout.ts";
import { bg, fg, GLUON_HEX, nearest256, SGR_RESET, type GluonRole } from "../ui/theme.ts";
import type { Rect } from "./paint.ts";
import { shorterQuestions } from "./types.ts";

/** A run of chrome text: a layout segment on a background, maybe underlined in amber. */
export interface Run extends Seg {
  bg?: GluonRole;
  underline?: boolean;
}

/** The underline colour (SGR 58; terminals without it underline in the text's colour). */
const underlineColour = (hex: string, truecolor: boolean) => {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return truecolor ? `\x1b[58;2;${rgb.join(";")}m` : `\x1b[58;5;${nearest256(hex)}m`;
};

const style = (r: Run, truecolor: boolean) =>
  `${SGR_RESET}${r.bold ? "\x1b[1m" : ""}${r.underline ? `\x1b[4m${underlineColour(GLUON_HEX.amber, truecolor)}` : ""}${fg(GLUON_HEX[r.role], truecolor)}${r.bg ? bg(GLUON_HEX[r.bg], truecolor) : ""}`;

/** Runs as bytes: exactly `cols` cells (cut with `…`, then padded on `fill`), ending with a reset. */
export function render(runs: readonly Run[], cols: number, truecolor: boolean, fill: GluonRole = "ground"): string {
  let out = "";
  let used = 0;
  for (const r of runs) {
    if (used >= cols) break;
    const room = cols - used;
    // Cut only the run that overflows; one that fits exactly stays whole.
    const text = sw(r.text) <= room ? r.text : truncate(r.text, room);
    if (!text) continue;
    out += style(r, truecolor) + text;
    used += sw(text);
  }
  if (used < cols) out += style({ text: "", role: "text", bg: fill }, truecolor) + " ".repeat(cols - used);
  return out + SGR_RESET;
}

/** Where everything goes on a `cols` × `rows` terminal (0-based rows). */
export interface Layout {
  cols: number;
  rows: number;
  /** Below `MIN_COLS` × `MIN_ROWS`: only `tooSmall` is drawn. */
  small: boolean;
  tabRow: number;
  infoRow: number;
  /** The frame box, border included. */
  frame: Rect;
  /** Inside the border: the agent's terminal. */
  interior: Rect;
  barRow: number;
}

/** From this many rows, a blank row separates the info line from the frame (the brief's breathing room). */
export const GAP_MIN_ROWS = 24;

/** Below this size the frame isn't drawn: one line says the terminal is too small (BUG-181). */
export const MIN_COLS = 20;
export const MIN_ROWS = 6;

/**
 * The chrome takes 5 rows (tabs, info, top and bottom border, bottom bar; 6 with the gap) and 2
 * columns. `small`: the terminal is below `MIN_COLS` × `MIN_ROWS` (the rest is laid out for that
 * minimum, so the sessions' PTYs keep a sane size, but nothing of it is drawn).
 */
export function layout(cols: number, rows: number): Layout {
  const c = Math.max(MIN_COLS, cols);
  const r = Math.max(MIN_ROWS, rows);
  const gap = r >= GAP_MIN_ROWS ? 1 : 0;
  return { cols: c, rows: r, small: cols < MIN_COLS || rows < MIN_ROWS, tabRow: 0, infoRow: 1, frame: { top: 2 + gap, left: 0, cols: c, rows: r - 3 - gap }, interior: { top: 3 + gap, left: 1, cols: c - 2, rows: r - 5 - gap }, barRow: r - 1 };
}

/**
 * The zoomed session view (`z` after the home key): no tab strip, info line, gap or frame; the
 * agent's terminal is the whole screen but its last row, which stays Gluon's (`barRow`). Clamped
 * like `layout`, so the PTY keeps a sane size when the terminal is below the minimum. Why it exists:
 * the frame takes 5-6 rows and 2 columns, and a harness sizes its dialogs from the rows it gets
 * (Claude Code's plan viewport and subagent panel), so framed they can show next to nothing.
 */
export interface ZoomLayout {
  cols: number;
  rows: number;
  interior: Rect;
  barRow: number;
}

export function zoomLayout(cols: number, rows: number): ZoomLayout {
  const c = Math.max(MIN_COLS, cols);
  const r = Math.max(MIN_ROWS, rows);
  return { cols: c, rows: r, interior: { top: 0, left: 0, cols: c, rows: r - 1 }, barRow: r - 1 };
}

/**
 * The whole screen of a terminal too small for the frame: cleared to the ground, `too small · ctrl+\
 * home` on the ground (BUG-248); narrower than that, `too small` and the home key on lines of
 * their own, so the key and its word stay whole (one row: the key alone).
 */
export function tooSmall(homeKey: string, cols: number, truecolor: boolean, rows = MIN_ROWS): string {
  const width = Math.max(1, cols);
  const said: Run = { text: "too small", role: "amber", bg: "ground" };
  const key: Run[] = [
    { text: keyLabel(homeKey), role: "bright", bold: true, bg: "ground" },
    { text: " home", role: "dim", bg: "ground" },
  ];
  const one = [said, { text: " · ", role: "dim", bg: "ground" } as Run, ...key];
  const lines = segsWidth(one) <= width ? [one] : rows >= 2 ? [[said], key] : [key];
  return `\x1b[?25l${SGR_RESET}${bg(GLUON_HEX.ground, truecolor)}\x1b[2J${lines.map((l, i) => `\x1b[${i + 1};1H${render(l, width, truecolor)}`).join("")}`;
}

/** Longest tab name shown (cells). */
const TAB_NAME_MAX = 24;

type TabSession = Pick<SessionView, "id" | "name" | "state" | "markedDone">;

/** Where the tab strip's parts are on row 0: 0-based columns, `x1` exclusive (what a click hits). */
export interface TabSpans {
  home: [number, number];
  /** The tabs shown (scrolled into view), each without the gap after it. */
  tabs: { id: number; x0: number; x1: number }[];
  /** The `‹2` / `3›` markers, when drawn, whole: a click opens the nearest hidden tab on that side (BUG-212, BUG-232). */
  prev?: { id: number; x0: number; x1: number };
  next?: { id: number; x0: number; x1: number };
}

/**
 * Row 0, on the bar: `◆ gluon`, then one tab per session (`glyph name`); the current one on the
 * `selected` background, its name bright and bold, glyph and name underlined in amber; the others dim. When they
 * don't fit, the strip scrolls to keep the current tab in view; `‹2` / `3›`, bright, mark and count
 * the hidden tabs on each side (BUG-232).
 */
export function tabStrip(sessions: readonly TabSession[], current: number | null, cols: number, truecolor: boolean): string {
  const { left, right } = stripLayout(sessions, current, cols);
  // The right marker stays at the right edge, whatever is cut before it.
  return render(left, cols - segsWidth(right), truecolor, "bar").slice(0, -SGR_RESET.length) + render(right, segsWidth(right), truecolor, "bar");
}

/** Where `◆ gluon`, each tab shown and the `‹` / `›` markers are on the strip `tabStrip` draws with the same arguments. */
export function tabSpans(sessions: readonly TabSession[], current: number | null, cols: number): TabSpans {
  return stripLayout(sessions, current, cols).spans;
}

/**
 * The tab strip's runs (left of the right marker, and the marker) and the spans they cover: the one
 * place its widths and scrolling are worked out, for drawing and for clicks.
 */
function stripLayout(sessions: readonly TabSession[], current: number | null, cols: number): { left: Run[]; right: Run[]; spans: TabSpans } {
  const home: Run[] = [
    { text: " ", role: "dim", bg: "bar" },
    { text: "◆", role: "amber", bold: true, bg: "bar" },
    { text: " gluon ", role: "bright", bold: true, bg: "bar" },
  ];
  const tab = (s: TabSession): Run[] => {
    const on = s.id === current;
    const back: GluonRole = on ? "selected" : "bar";
    const g = GLYPH[groupOf(s)];
    // The current tab's amber underline runs under its glyph and its name.
    return [
      { text: " ", role: "dim", bg: back },
      { ...g, bg: back, underline: on },
      { text: " ", role: "dim", bg: back, underline: on },
      on ? { text: truncate(s.name, TAB_NAME_MAX), role: "bright", bold: true, underline: true, bg: back } : { text: truncate(s.name, TAB_NAME_MAX), role: "dim", bg: back },
      { text: " ", role: "dim", bg: back },
      { text: " ", role: "dim", bg: "bar" },
    ];
  };
  const all = sessions.map(tab);
  const widths = all.map(segsWidth);
  const avail = cols - segsWidth(home);
  let first = 0;
  let last = all.length - 1;
  if (widths.reduce((a, b) => a + b, 0) > avail && all.length) {
    const cur = Math.max(0, sessions.findIndex((s) => s.id === current));
    // A marker takes at most its glyph, a space and the count's digits.
    const mark = 2 + String(all.length).length;
    const span = (a: number, b: number) => widths.slice(a, b + 1).reduce((x, y) => x + y, 0) + (a > 0 ? mark : 0) + (b < all.length - 1 ? mark : 0);
    while (first < cur && span(first, cur) > avail) first++;
    last = cur;
    while (last + 1 < all.length && span(first, last + 1) <= avail) last++;
  }
  const marker = (text: string): Run => ({ text, role: "bright", bold: true, bg: "bar" });
  const right = last < all.length - 1 ? [marker(` ${all.length - 1 - last}›`)] : [];
  const leftMarker = first > 0 ? [marker(`‹${first} `)] : [];
  // What `render` cuts before the right marker is cut from the spans too.
  const clip = (x: number) => Math.max(0, Math.min(x, cols - segsWidth(right)));
  const spans: TabSpans = { home: [0, clip(segsWidth(home))], tabs: [] };
  if (leftMarker.length) {
    const x0 = clip(segsWidth(home));
    const x1 = clip(segsWidth(home) + segsWidth(leftMarker));
    if (x0 < x1) spans.prev = { id: sessions[first - 1]!.id, x0, x1 };
  }
  if (right.length) spans.next = { id: sessions[last + 1]!.id, x0: Math.max(0, cols - segsWidth(right)), x1: cols };
  let x = segsWidth(home) + segsWidth(leftMarker);
  for (let i = first; i <= last; i++) {
    // A tab's last cell is the gap before the next one.
    const x1 = clip(x + widths[i]! - 1);
    if (x < x1) spans.tabs.push({ id: sessions[i]!.id, x0: x, x1 });
    x += widths[i]!;
  }
  return { left: [...home, ...leftMarker, ...all.slice(first, last + 1).flat()], right, spans };
}

/** The fewest columns a working session's activity keeps in the info line before it goes. */
const MIN_ACTIVITY = 10;

/**
 * Row 1: `claude code × opus × high · 25m · ~$4.12 · 38% context · 4 files changed · awaiting your
 * input` — the triple as the home list writes it, the rest dim, the state amber when it needs the
 * user, context amber from `CONTEXT_WARN`. A figure that isn't known (or no file changed) is left
 * out. A column of margin on each side. Short of room, a working session's activity, then the
 * triple, are cut to fit (down to `MIN_ACTIVITY` columns, and to the harness's name), whatever the
 * harness (BUG-257); then parts go in this order (BUG-178): files changed, context, cost, elapsed,
 * the activity, the triple; the state (awaiting your input, or done when the user marked it) goes last.
 */
export function infoLine(s: SessionView, now: number, cols: number, truecolor: boolean, config?: Pick<Config, "models">): string {
  // `drop`: lower goes first; `min`: cut to fit, down to this many columns, rather than dropped while it can.
  const parts: { runs: Run[]; drop: number; min?: number }[] = [];
  if (s.agent) {
    const triple = tripleSegs(s.agent, config);
    parts.push({ runs: triple, drop: 5, min: sw(triple[0]!.text) + 1 });
  }
  parts.push({ runs: [{ text: elapsed(now - s.startedAt), role: "dim" }], drop: 3 });
  if (s.cost) parts.push({ runs: [{ text: costLabel(s.cost), role: "dim" }], drop: 2 });
  if (s.contextPct !== undefined) parts.push({ runs: [{ text: `${contextLabel(s.contextPct)} context`, role: s.contextPct >= CONTEXT_WARN ? "amber" : "dim" }], drop: 1 });
  if (s.filesChanged) parts.push({ runs: [{ text: `${s.filesChanged} file${s.filesChanged === 1 ? "" : "s"} changed`, role: "dim" }], drop: 0 });
  if (groupOf(s) === "done") parts.push({ runs: [{ text: "done", role: "green" }], drop: 6 });
  else if (s.state === "awaiting") parts.push({ runs: [{ text: "awaiting your input", role: "amber" }], drop: 6 });
  else if (s.activity) parts.push({ runs: [{ text: s.activity, role: "dim" }], drop: 4, min: MIN_ACTIVITY });
  // The columns between the margins.
  const room = cols - 2;
  const TRIPLE = 5;
  // Parts at the widths they may be cut to: the activity's always, the triple's once only it and the state are left.
  const width = (ps: typeof parts, triple: boolean) => ps.reduce((n, p, i) => n + (i ? 3 : 0) + (p.min !== undefined && (p.drop !== TRIPLE || triple) ? Math.min(p.min, segsWidth(p.runs)) : segsWidth(p.runs)), 0);
  const dropLowest = (ps: typeof parts) => parts.splice(parts.indexOf(ps.reduce((a, b) => (b.drop < a.drop ? b : a))), 1);
  while (width(parts, false) > room && parts.some((p) => p.drop < TRIPLE)) dropLowest(parts.filter((p) => p.drop < TRIPLE));
  while (parts.length > 1 && width(parts, true) > room) dropLowest(parts);
  // What is still over: cut from the activity, then from the triple.
  let over = parts.reduce((n, p, i) => n + (i ? 3 : 0) + segsWidth(p.runs), 0) - room;
  for (const p of [...parts].sort((a, b) => a.drop - b.drop)) {
    if (over <= 0 || p.min === undefined) continue;
    const w = segsWidth(p.runs);
    const cut = Math.min(over, w - Math.min(p.min, w));
    if (cut > 0) p.runs = fitSegs(p.runs, w - cut);
    over -= cut;
  }
  const runs: Run[] = [{ text: " ", role: "dim" }];
  parts.forEach((p, i) => runs.push(...(i ? [{ text: " · ", role: "dim" as const }] : []), ...p.runs));
  return render(runs.map((r) => ({ ...r, bg: "ground" })), cols, truecolor);
}

const cup = (row: number, col: number) => `\x1b[${row + 1};${col + 1}H`;

/**
 * The frame's border (`frame` colour, one cell, on the ground): the agent triple set into the top
 * border, `footer` (the scroll indicator) into the bottom one at its right. Only border cells are
 * written.
 */
export function frameBox(rect: Rect, title: readonly Seg[], footer: string, truecolor: boolean): string {
  const line = (text: string): Run => ({ text, role: "frame", bg: "ground" });
  const inner = Math.max(0, rect.cols - 2);
  // `┌─ title ───┐`: the title gets what's left after `┌─ ` and ` ─┐`.
  const room = inner - 4;
  const t = room >= 6 ? fitSegs(title, Math.min(segsWidth(title), room)).map((s) => ({ ...s, bg: "ground" as const })) : [];
  const top = t.length ? [line("┌─ "), ...t, line(` ${"─".repeat(Math.max(0, rect.cols - segsWidth(t) - 5))}┐`)] : [line(`┌${"─".repeat(inner)}┐`)];
  const topRow = render(top, rect.cols, truecolor);
  const foot = footer && inner >= sw(footer) + 4 ? ` ${footer} ` : "";
  const bottom = render([line(`└${"─".repeat(Math.max(0, inner - sw(foot) - 1))}`), { text: foot, role: "text", bg: "ground" }, line("─┘")], rect.cols, truecolor);
  let out = cup(rect.top, rect.left) + topRow;
  const side = style(line(""), truecolor);
  for (let y = 1; y < rect.rows - 1; y++) out += `${cup(rect.top + y, rect.left)}${side}│${cup(rect.top + y, rect.left + rect.cols - 1)}│${SGR_RESET}`;
  if (rect.rows > 1) out += cup(rect.top + rect.rows - 1, rect.left) + bottom;
  return out;
}

/**
 * The switch key the bottom bar names: ←/→ only while they will really switch — the shown session's
 * line is `untouched` (`route`); none once something is typed (they are the agent's then; the home
 * key's prefix switches) and none on the only tab, where there is no other session (BUG-241).
 */
export function switchKey(o: { untouched: boolean; onlyTab: boolean }): string | null {
  return o.untouched && !o.onlyTab ? "←/→" : null;
}

/** Live counts of the other sessions as groups (`? 1 awaiting` amber, `● 2 working`, `✓ 1 done`). */
function countGroups(others: Record<SessionState, number>): Run[][] {
  const dim = (text: string): Run => ({ text, role: "dim" });
  const counts: Run[][] = [];
  if (others.awaiting) counts.push([{ text: `? ${others.awaiting} awaiting`, role: "amber" }]);
  if (others.working) counts.push([{ text: "●", role: "blue" }, dim(` ${others.working} working`)]);
  if (others.done) counts.push([{ text: "✓", role: "green" }, dim(` ${others.done} done`)]);
  return counts;
}

/** Groups of runs separated by a dim ` · `. */
const joinGroups = (groups: Run[][]): Run[] => groups.flatMap((g, i) => [...(i ? [{ text: " · ", role: "dim" } as Run] : []), ...g]);

/**
 * The last row: left, the keys (`←/→ switch session · ctrl+\ sessions`, the brief's
 * order: key caps bold and bright, labels dim); right, live counts of the other sessions
 * (`? 1 awaiting` amber, `● 2 working`, `✓ 1 done`). `swap` is the switch key (`switchKey`; null:
 * none). Short of room the words shorten first (`switch`), then the counts go, then the
 * switch key (the home key stays; BUG-230).
 */
export function bottomBar(homeKey: string, others: Record<SessionState, number>, cols: number, truecolor: boolean, swapKey: string | null = "←/→"): string {
  const dim = (text: string): Run => ({ text, role: "dim" });
  const key = (text: string): Run => ({ text, role: "bright", bold: true });
  const home = (): Run[] => [key(keyLabel(homeKey)), dim(" sessions")];
  const swap = (short: boolean): Run[][] => (swapKey ? [[key(swapKey), dim(short ? " switch" : " switch session")]] : []);
  const counts = countGroups(others);
  const join = joinGroups;
  const right = counts.length ? [...join(counts), dim(" ")] : [];
  // From the whole bar to the home key alone: the first that fits.
  const tries: [Run[][], Run[]][] = [
    [[...swap(false), home()], right],
    [[...swap(true), home()], []],
    [[home()], right],
    [[home()], []],
  ];
  const fits = ([keys, r]: [Run[][], Run[]]) => 1 + segsWidth(join(keys)) + segsWidth(r) + (r.length ? 1 : 0) <= cols;
  const [keys, r] = tries.find(fits) ?? tries.at(-1)!;
  const left = [dim(" "), ...join(keys)];
  const runs = [...left, dim(" ".repeat(Math.max(0, cols - segsWidth(left) - segsWidth(r)))), ...r];
  return render(runs.map((x) => ({ ...x, bg: "ground" })), cols, truecolor);
}

/**
 * The last row of a zoomed session (`zoomLayout`): `zoomed · ctrl+\ z back · ctrl+\ sessions`, on
 * the right the scroll indicator while scrolled back (`↑ 12 · esc back`: the frame's border, where it
 * lives otherwise, is gone) and the other sessions' counts. Short of room the counts go first, then
 * words; the scroll indicator and the home key stay as long as they fit.
 */
export function zoomBar(homeKey: string, others: Record<SessionState, number>, cols: number, truecolor: boolean, scrollOffset = 0): string {
  const dim = (text: string): Run => ({ text, role: "dim" });
  const key = (text: string): Run => ({ text, role: "bright", bold: true });
  const home = key(keyLabel(homeKey));
  const sessions: Run[] = [home, dim(" sessions")];
  const zoomed: Run[] = [{ text: "zoomed", role: "amber" }];
  const back: Run[] = [home, dim(" "), key("z"), dim(" back")];
  const scroll: Run[] = scrollOffset > 0 ? [{ text: scrollFooter(scrollOffset), role: "text" }, dim(" ")] : [];
  const counts = countGroups(others);
  const all = scroll.length ? [...scroll.slice(0, -1), ...(counts.length ? [dim(" · "), ...joinGroups(counts)] : []), dim(" ")] : counts.length ? [...joinGroups(counts), dim(" ")] : [];
  const tries: [Run[][], Run[]][] = [
    [[zoomed, back, sessions], all],
    [[zoomed, back, sessions], scroll],
    [[zoomed, back], scroll],
    [[sessions], scroll],
    [[[home]], scroll],
    [[[home]], []],
  ];
  const fits = ([keys, r]: [Run[][], Run[]]) => 1 + segsWidth(joinGroups(keys)) + segsWidth(r) + (r.length ? 1 : 0) <= cols;
  const [keys, r] = tries.find(fits) ?? tries.at(-1)!;
  const left = [dim(" "), ...joinGroups(keys)];
  const runs = [...left, dim(" ".repeat(Math.max(0, cols - segsWidth(left) - segsWidth(r)))), ...r];
  return render(runs.map((x) => ({ ...x, bg: "ground" })), cols, truecolor);
}

/**
 * The bar while the home key waits for the key that picks (`route`'s prefix), in the bottom bar's
 * place: `←/→ switch session · ctrl+\ home · esc cancel · z zoom`. Short of room the words shorten, then go.
 */
export function prefixBar(homeKey: string, cols: number, truecolor: boolean, zoomed = false): string {
  const on = (r: Run): Run => ({ ...r, bg: "selected" });
  const key = (text: string): Run => ({ text, role: "bright", bold: true });
  const dim = (text: string): Run => ({ text, role: "dim" });
  const home = keyLabel(homeKey);
  const forms: Run[][] = [
    [dim(" "), key("←/→"), dim(" switch session · "), key(home), dim(" home · "), key("esc"), dim(" cancel · "), key("z"), dim(zoomed ? " unzoom " : " zoom ")],
    [dim(" "), key("←/→"), dim(" switch session · "), key(home), dim(" home · "), key("esc"), dim(" cancel ")],
    [dim(" "), key("←/→"), dim(" switch · "), key(home), dim(" home · "), key("esc"), dim(" ")],
    [dim(" "), key("←/→"), dim(" · "), key(home), dim(" home ")],
    [dim(" "), key(home), dim(" home ")],
  ];
  const runs = forms.find((f) => segsWidth(f) <= cols) ?? forms.at(-1)!;
  return render(runs.map(on), cols, truecolor, "selected");
}

/**
 * The question bar, in the bottom bar's place: `? /clear ends this session in Gluon — end it?  enter yes · esc no`.
 * `question`: its text (its shorter forms from `shorterQuestions`), or its forms longest first, each
 * saying what a yes does. Short of room what it says goes last (BUG-264): first a shorter form,
 * then the keys shrink (`enter · esc`), then they go; only then is the shortest form cut, keeping
 * its `?` (BUG-254).
 */
export function questionBar(question: string | readonly string[], cols: number, truecolor: boolean): string {
  const on = (r: Run): Run => ({ ...r, bg: "selected" });
  const key = (text: string): Run => ({ text, role: "bright", bold: true });
  const dim = (text: string): Run => ({ text, role: "dim" });
  const hints: Run[][] = [
    [dim("  "), key("enter"), dim(" yes · "), key("esc"), dim(" no ")],
    [dim("  "), key("enter"), dim(" · "), key("esc"), dim(" ")],
    [dim(" ")],
  ];
  const head: Run[] = [dim(" "), { text: "?", role: "amber", bold: true }, dim(" ")];
  const forms = typeof question === "string" ? [question, ...shorterQuestions(question)] : question;
  const room = (hint: Run[]) => cols - segsWidth(head) - segsWidth(hint);
  let said = "";
  let hint = hints.at(-1)!;
  const found = hints.some((h) => {
    const f = forms.find((x) => sw(x) <= room(h));
    if (f !== undefined) [said, hint] = [f, h];
    return f !== undefined;
  });
  if (!found) said = cutQuestion(forms.at(-1) ?? "", room(hint));
  return render([...head, key(said), ...hint].map(on), cols, truecolor, "selected");
}

/**
 * A note about the session (the launch's first line couldn't be typed: the note says the line), as the
 * rows drawn over the top of the agent's frame: wrapped to `cols`, never cut (a line to type is useless
 * cut), then what hides it. At most `maxRows` rows: the hint goes first, then the note's end.
 */
export function noteRows(notes: readonly string[], cols: number, truecolor: boolean, maxRows: number): string[] {
  const width = Math.max(1, cols - 2);
  const lines: string[] = [];
  let line = "";
  const push = () => {
    lines.push(line);
    line = "";
  };
  for (const text of notes) {
    for (const word of text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").split(/ +/).filter(Boolean)) {
      // A word wider than a row (a long path) is broken by grapheme; the rest goes on from there.
      let rest = word;
      while (sw(rest) > width) {
        if (line) push();
        let cut = "";
        for (const g of rest) {
          if (sw(cut + g) > width) break;
          cut += g;
        }
        cut ||= [...rest][0]!;
        line = cut;
        push();
        rest = rest.slice(cut.length);
      }
      if (line && sw(line) + 1 + sw(rest) > width) push();
      line = line ? `${line} ${rest}` : rest;
    }
    if (line) push();
  }
  const rows: Run[][] = lines.slice(0, Math.max(0, maxRows)).map((t) => [{ text: ` ${t}`, role: "bright" }]);
  if (lines.length < maxRows) rows.push([{ text: " esc hides this note", role: "dim" }]);
  return rows.map((r) => render(r.map((x) => ({ ...x, bg: "selected" as const })), cols, truecolor, "selected"));
}

/** A question cut to `width`, keeping its `?`: `End golf-tas…?`. */
function cutQuestion(q: string, width: number): string {
  return q.endsWith("?") && width >= 3 ? `${truncate(q.slice(0, -1), width - 1)}?` : truncate(q, Math.max(1, width));
}

/** The frame's bottom-border indicator while scrolled back: `↑ 12 · esc back`. */
export const scrollFooter = (offset: number) => (offset > 0 ? `↑ ${offset} · esc back` : "");
