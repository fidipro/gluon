/**
 * Gluon's home view, laid out as text: what each line says, in which colour role, at a given
 * width. Pure (no React, no I/O), so the narrow-terminal rules are tested as functions; the Ink
 * components in `header.tsx`, `list.tsx` and `chat.tsx` only draw what these return.
 */
import type { Activity } from "../agent/tools.ts";
import type { Config } from "../config.ts";
import { HARNESS_INFO, type Harness, type Mode } from "../harnesses.ts";
import { contextLabel, costLabel, elapsed, GROUP_LABEL, GROUPS, groupOf, HARNESS_WORD, ordered, type AgentTripleView, type SessionState, type SessionView } from "../sessions.ts";
import type { GluonRole } from "./theme.ts";

/** A run of text in one colour role. */
export interface Seg {
  text: string;
  role: GluonRole;
  bold?: boolean;
}

export const sw = (s: string) => Bun.stringWidth(s);

/**
 * Two clicks this close together are a double-click: on one row of the home list they open it,
 * selected or not (`Home.tsx`); the second one, after the first opened a session, is still
 * Gluon's (`restOfClick` in src/pty/compositor.ts; BUG-272).
 */
export const DOUBLE_CLICK_MS = 400;

/** How hints and the bottom bar name a key from the config (`handoff.key`, e.g. `ctrl+\`). */
export const keyLabel = (spec: string) => spec.trim().toLowerCase();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** What a cut text never ends in before its `…`: blanks (BUG-254), dashes and separators (`—…`, `,…`, `·…`; BUG-276). */
const CUT_END = /[\s\p{Pd},;:.·×…]+$/u;

/** `s` cut to `width` columns, ending in `…` when cut (by grapheme, never inside a wide char; no blank, dash or separator before the `…`: `CUT_END`). */
export function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  if (sw(s) <= width) return s;
  let out = "";
  let used = 0;
  for (const { segment } of graphemes.segment(s)) {
    const w = sw(segment);
    if (used + w > width - 1) break;
    out += segment;
    used += w;
  }
  return `${out.replace(CUT_END, "")}…`;
}

export const padEnd = (s: string, width: number) => s + " ".repeat(Math.max(0, width - sw(s)));
export const padStart = (s: string, width: number) => " ".repeat(Math.max(0, width - sw(s))) + s;

export const segsWidth = (segs: readonly Seg[]) => segs.reduce((n, s) => n + sw(s.text), 0);

/** Segments cut to `width` columns, the last kept one ending in `…` when anything was cut. */
export function fitSegs(segs: readonly Seg[], width: number): Seg[] {
  if (segsWidth(segs) <= width) return [...segs];
  const out: Seg[] = [];
  let room = width;
  for (const s of segs) {
    if (room <= 0) break;
    if (sw(s.text) < room) {
      out.push(s);
      room -= sw(s.text);
      continue;
    }
    out.push({ ...s, text: truncate(s.text, room) });
    room = 0;
  }
  // The cut fell on a segment boundary: the ellipsis goes on the last segment kept.
  const last = out.at(-1);
  if (last && !last.text.endsWith("…")) out[out.length - 1] = { ...last, text: truncate(`${last.text}  `, sw(last.text)) };
  return out;
}

/** Segments padded with spaces (in `role`) to exactly `width` columns, cut first when longer. */
export function padSegs(segs: readonly Seg[], width: number, role: GluonRole = "dim"): Seg[] {
  const fit = fitSegs(segs, width);
  const rest = width - segsWidth(fit);
  return rest > 0 ? [...fit, { text: " ".repeat(rest), role }] : fit;
}

/** A model as the brief writes it: its catalog label in lower case (`sonnet 5.5`), else its id. */
export function modelWord(config: Pick<Config, "models"> | undefined, harness: Harness, model: string): string {
  const label = config?.models[harness]?.find((m) => m.id === model)?.label;
  return (label ?? model).toLowerCase();
}

/** A mode as shown: nothing for build; `explore`, `plan`; `explore (plan mode)` where the harness does it another way. */
export function modeWord(harness: Harness, mode: Mode | undefined): string {
  if (!mode || mode === "build") return "";
  const note = HARNESS_INFO[harness].modes[mode].note;
  return note ? `${mode} (${note})` : mode;
}

/** `harness` bright, ` × model × effort` dim, then ` · mode` unless build; `agent not chosen yet` (dim) for a draft. */
export function tripleSegs(agent: AgentTripleView | null, config?: Pick<Config, "models">): Seg[] {
  if (!agent) return [{ text: "agent not chosen yet", role: "dim" }];
  const mode = modeWord(agent.harness, agent.mode);
  return [
    { text: HARNESS_WORD[agent.harness], role: "bright" },
    { text: ` × ${modelWord(config, agent.harness, agent.model)}${agent.effort ? ` × ${agent.effort}` : ""}${mode ? ` · ${mode}` : ""}`, role: "dim" },
  ];
}

const SEP: Seg = { text: " · ", role: "dim" };
const join = (parts: Seg[][]): Seg[] => parts.flatMap((p, i) => (i ? [SEP, ...p] : p));

const COUNT_WORD: Record<SessionState, string> = { awaiting: "awaiting input", working: "working", done: "done", drafting: "drafting" };

/**
 * The header's third line: `1 awaiting input · 2 working · …` (zero groups left out, awaiting in
 * amber); with none, `no sessions yet`, or `no sessions running` once one ran (`ran`; BUG-222).
 */
export function countsSegs(counts: Record<SessionState, number>, ran = false): Seg[] {
  const parts = GROUPS.filter((g) => counts[g] > 0).map((g): Seg[] => [{ text: `${counts[g]} ${COUNT_WORD[g]}`, role: g === "awaiting" ? "amber" : "dim" }]);
  return parts.length ? join(parts) : [{ text: ran ? "no sessions running" : "no sessions yet", role: "dim" }];
}

/**
 * The repo as the header names it: `owner/name` from the remote's URL (`git@host:owner/name.git`,
 * `https://user:token@host/owner/name`, …; never the host or credentials), else the directory's name.
 */
export function repoLabel(remote: string | null | undefined, dir: string): string {
  const path = (remote ?? "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "") // scheme://[userinfo@]host[:port]
    .replace(/^[^/:]*@?[^/:]*:(?!\/)/, "") // scp-like user@host:
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (remote && parts.length >= 2) return parts.slice(-2).join("/");
  return dir.split(/[/\\]/).filter(Boolean).at(-1) ?? dir;
}

/**
 * The header's second line: `<repo> · <branch> · <n> modified` (`clean` for none; unknown parts left out),
 * then `workspace <id>` once the sessions are saved (`gluon resume <id>`).
 */
export function whereSegs(repo: string, branch: string | null | undefined, modified: number | undefined, workspace?: string): Seg[] {
  const parts: string[] = [repo];
  if (branch) parts.push(branch);
  if (modified !== undefined) parts.push(modified > 0 ? `${modified} modified` : "clean");
  if (workspace) parts.push(`workspace ${workspace}`);
  return [{ text: parts.join(" · "), role: "dim" }];
}

/** The header's first line in `width` columns: `Gluon v1.0.0`, cut with `…` when it doesn't fit. */
export function headerTop(width: number, version: string): Seg[] {
  return fitSegs(
    [
      { text: "Gluon", role: "bright", bold: true },
      { text: ` v${version}`, role: "dim" },
    ],
    width,
  );
}

// ── the session list ────────────────────────────────────────────────────────────────────────

/** Status glyphs (brief, section 4). */
export const GLYPH: Record<SessionState, Seg> = {
  awaiting: { text: "?", role: "amber", bold: true },
  working: { text: "●", role: "blue" },
  done: { text: "✓", role: "green" },
  drafting: { text: "◌", role: "amber" },
};

/** One row's cells, as text. */
export interface RowCells {
  state: SessionState;
  name: string;
  triple: Seg[];
  activity: string;
  context: string;
  /** Context use, to colour it amber at `CONTEXT_WARN`. */
  contextPct?: number;
  cost: string;
  elapsed: string;
}

export const CONTEXT_WARN = 80;

export function rowCells(s: SessionView, now: number, config?: Pick<Config, "models">): RowCells {
  return {
    state: groupOf(s),
    name: s.name,
    triple: tripleSegs(s.agent, config),
    activity: s.activity,
    context: contextLabel(s.contextPct),
    contextPct: s.contextPct,
    cost: costLabel(s.cost),
    elapsed: elapsed(now - s.startedAt),
  };
}

/** Column widths of the list; 0: hidden (with its gap). */
export interface Columns {
  name: number;
  triple: number;
  activity: number;
  context: number;
  cost: number;
  elapsed: number;
  /** Blank columns after the time: the figures sit this far in from the right edge. */
  tail: number;
}

/** The column header's words over context, cost and elapsed: each column is at least as wide (BUG-194). */
export const COLUMN_HEADS = { context: "context", cost: "cost", elapsed: "time" } as const;

/** Columns between cells; a row starts with ` <glyph>  ` and ends with `Columns.tail` spaces (`TAIL`, 1 when narrow). */
export const GAP = 2;
const LEAD = 4; // " ? " + one more space: the name starts where chat text does
const TAIL = 2; // below `TAIL_FROM` columns of room: 1
const TAIL_FROM = 40;
export const MIN_ACTIVITY = 10;
export const MIN_TRIPLE = 14;
const MIN_NAME = 6;
const MAX_NAME_COL = 24;

/** The columns a row uses at these widths (`activity` 0 counts no gap). */
export const rowWidth = (c: Columns) =>
  LEAD + c.name + GAP + c.triple + (c.activity ? GAP + c.activity : 0) + (c.context ? GAP + c.context : 0) + (c.cost ? GAP + c.cost : 0) + GAP + c.elapsed + c.tail;

/** Below this the triple shortens no further before the name does (BUG-223). */
const NAME_BEFORE_TRIPLE = 8;

/**
 * The list's columns at `width`: every cell at its natural width and activity taking the rest
 * (so cost and elapsed sit at the right edge). Which columns show and how wide the name is are
 * decided as if every row had an activity (`MIN_ACTIVITY` columns), so they never change as
 * activities come and go (BUG-223). Short of room, in order: the triple shortens (to
 * `MIN_TRIPLE`), context hides, cost hides, activity shrinks and then hides, the triple shortens
 * to `NAME_BEFORE_TRIPLE`, the name shortens (to `MIN_NAME`), the triple shortens further: the
 * name wins over the triple and over columns of `—`. Room left over goes to the triple up to its
 * natural width, then to activity; with no activity in any row it pads the triple (BUG-183/columns).
 * Nothing is ever wider than `width` (down to ~20 columns).
 */
export function listColumns(width: number, rows: readonly RowCells[]): Columns {
  const max = (f: (r: RowCells) => string, min: number) => Math.max(min, ...rows.map((r) => sw(f(r))));
  const natural = Math.max(...rows.map((r) => segsWidth(r.triple)), 8);
  const c: Columns = {
    name: Math.min(MAX_NAME_COL, max((r) => r.name, 8)),
    triple: natural,
    activity: 0,
    context: max((r) => r.context, sw(COLUMN_HEADS.context)),
    cost: max((r) => r.cost, Math.max(5, sw(COLUMN_HEADS.cost))),
    elapsed: max((r) => r.elapsed, sw(COLUMN_HEADS.elapsed)),
    tail: width >= TAIL_FROM ? TAIL : 1,
  };
  const room = () => width - rowWidth({ ...c, activity: 0 }) - GAP;
  if (room() < MIN_ACTIVITY) c.triple = Math.max(Math.min(c.triple, MIN_TRIPLE), c.triple - (MIN_ACTIVITY - room()));
  if (room() < MIN_ACTIVITY) c.context = 0;
  if (room() < MIN_ACTIVITY) c.cost = 0;
  // The activity column as reserved: shrunk, then gone.
  const reserved = room() >= 4 ? Math.min(MIN_ACTIVITY, room()) : 0;
  const over = () => rowWidth({ ...c, activity: reserved }) - width;
  if (over() > 0) c.triple = Math.max(Math.min(c.triple, NAME_BEFORE_TRIPLE), c.triple - over());
  if (over() > 0) c.name = Math.max(Math.min(c.name, MIN_NAME), c.name - over());
  if (over() > 0) c.triple = Math.max(1, c.triple - over());
  const need = Math.max(0, ...rows.map((r) => sw(r.activity)));
  if (need && reserved) {
    const grow = Math.max(0, Math.min(natural - c.triple, room() - need));
    c.triple += grow;
    c.activity = room();
  } else c.triple += Math.max(0, width - rowWidth(c));
  return c;
}

/** A cell with no figure (`—`): its columns are free for the activity beside it (BUG-265). */
const NO_FIGURE = "—";

/**
 * One row as segments at these columns (exactly `rowWidth(cols)` wide). A row with no activity
 * lends its activity column to its triple: never a cut triple beside blank columns (BUG-251).
 * An activity too long for its column takes the free columns beside it before it is cut
 * (BUG-265): the context and then the cost cell when they have no figure (their `—` goes), then
 * the blank end of the triple's column.
 */
export function rowSegs(cols: Columns, r: RowCells, selected: boolean): Seg[] {
  const g = GLYPH[r.state];
  const gap: Seg = { text: " ".repeat(GAP), role: "dim" };
  const out: Seg[] = [{ text: " ", role: "dim" }, g, { text: "  ", role: "dim" }];
  out.push({ text: padEnd(truncate(r.name, cols.name), cols.name), role: r.state === "drafting" ? "dim" : "bright", bold: selected });
  const lend = cols.activity && !r.activity.trim() ? GAP + cols.activity : 0;
  const need = lend ? 0 : sw(r.activity);
  let activity = cols.activity;
  const takeContext = cols.activity > 0 && need > activity && cols.context > 0 && r.context === NO_FIGURE;
  if (takeContext) activity += GAP + cols.context;
  const takeCost = (takeContext || !cols.context) && cols.activity > 0 && need > activity && cols.cost > 0 && r.cost === NO_FIGURE;
  if (takeCost) activity += GAP + cols.cost;
  const borrow = cols.activity > 0 && need > activity ? Math.min(need - activity, Math.max(0, cols.triple - segsWidth(r.triple))) : 0;
  activity += borrow;
  out.push(gap, ...padSegs(r.triple, cols.triple + lend - borrow));
  if (cols.activity && !lend) out.push(gap, { text: padEnd(truncate(r.activity, activity), activity), role: r.state === "drafting" ? "amber" : "dim" });
  if (cols.context && !takeContext) out.push(gap, { text: padStart(truncate(r.context, cols.context), cols.context), role: r.contextPct !== undefined && r.contextPct >= CONTEXT_WARN ? "amber" : "dim" });
  if (cols.cost && !takeCost) out.push(gap, { text: padStart(truncate(r.cost, cols.cost), cols.cost), role: "dim" });
  out.push(gap, { text: padStart(truncate(r.elapsed, cols.elapsed), cols.elapsed), role: "dim" }, { text: " ".repeat(cols.tail), role: "dim" });
  return out;
}

const GAP_TEXT = " ".repeat(GAP);

/** The column header over the rows at these columns: `context`, `cost`, `time` over their cells, dim; a hidden column's word hides with it (exactly `rowWidth(cols)` wide). */
export function columnHeadSegs(cols: Columns): Seg[] {
  const left = rowWidth({ ...cols, context: 0, cost: 0 }) - GAP - cols.elapsed - cols.tail;
  const head = (word: string, width: number) => (width ? GAP_TEXT + padStart(truncate(word, width), width) : "");
  const text = " ".repeat(left) + head(COLUMN_HEADS.context, cols.context) + head(COLUMN_HEADS.cost, cols.cost) + head(COLUMN_HEADS.elapsed, cols.elapsed) + " ".repeat(cols.tail);
  return [{ text, role: "dim" }];
}

/**
 * A line of the list: a group label (its row count; `collapsed`: its rows hidden), a session row,
 * or the blank between groups. Labels and rows are selectable (↑↓; BUG-194), by `lineKey`.
 */
export type ListLine = { kind: "label"; state: SessionState; count: number; collapsed: boolean } | { kind: "row"; session: SessionView } | { kind: "blank" };

/** A selectable line's key: `g:<state>` for a group label, `s:<id>` for a row; "" for a blank. */
export const groupKey = (state: SessionState) => `g:${state}`;
export const rowKey = (id: number) => `s:${id}`;
export const lineKey = (l: ListLine | MoreLine) => (l.kind === "label" ? groupKey(l.state) : l.kind === "row" ? rowKey(l.session.id) : "");

/** The list's lines: each non-empty group's label and rows (none when `collapsed` holds it), a blank line between groups. */
export function listLines(sessions: readonly SessionView[], collapsed: ReadonlySet<SessionState> = new Set()): ListLine[] {
  const out: ListLine[] = [];
  const all = ordered(sessions);
  for (const g of GROUPS) {
    const rows = all.filter((s) => groupOf(s) === g);
    if (!rows.length) continue;
    if (out.length) out.push({ kind: "blank" });
    const shut = collapsed.has(g);
    out.push({ kind: "label", state: g, count: rows.length, collapsed: shut }, ...(shut ? [] : rows.map((session) => ({ kind: "row" as const, session }))));
  }
  return out;
}

/** The lines ↑↓ move over, in order: labels and rows. */
export const selectable = (lines: readonly ListLine[]) => lines.filter((l) => l.kind !== "blank");

/**
 * The key the list shows selected: `key` while its line is listed; a row hidden in a collapsed
 * group selects that group's label; else the first row (the first label when every group is
 * collapsed), or null for an empty list.
 */
export function selectedKey(lines: readonly ListLine[], key: string | null, sessions: readonly SessionView[]): string | null {
  const keys = selectable(lines).map(lineKey);
  if (key && keys.includes(key)) return key;
  const hidden = key?.startsWith("s:") ? sessions.find((s) => rowKey(s.id) === key) : undefined;
  if (hidden && keys.includes(groupKey(groupOf(hidden)))) return groupKey(groupOf(hidden));
  const first = lines.find((l) => l.kind === "row");
  return first ? lineKey(first) : (keys[0] ?? null);
}

/**
 * The line to select once the list's selectable keys went from `before` to `after`: `key` while it
 * is listed; else, its row gone (deleted, or its session ended), the next row after it that is
 * still listed, or the previous one when it was the last (BUG-220); null: let `selectedKey` choose.
 */
export function selectionAfter(before: readonly string[], after: readonly string[], key: string | null): string | null {
  if (!key || after.includes(key)) return key;
  const at = before.indexOf(key);
  if (at < 0) return null;
  const rows = (keys: readonly string[]) => keys.filter((k) => k.startsWith("s:") && after.includes(k));
  return rows(before.slice(at + 1))[0] ?? rows(before.slice(0, at)).at(-1) ?? null;
}

/** `▾ Working`, or `▸ Working (2)` when collapsed. */
export const groupLabel = (l: { state: SessionState; count: number; collapsed: boolean }) => (l.collapsed ? `▸ ${GROUP_LABEL[l.state]} (${l.count})` : `▾ ${GROUP_LABEL[l.state]}`);

/** The list's last line when rows don't fit: how many are left out above and below (BUG-231). */
export type MoreLine = { kind: "more"; above: number; below: number };

/** `… 3 more`, `… 2 more above`, `… 2 more (1 above · 1 below)`. */
export const moreText = (l: MoreLine) => `… ${l.above + l.below} more${l.above && l.below ? ` (${l.above} above · ${l.below} below)` : l.above ? " above" : ""}`;

/**
 * The lines shown when the list has `max` rows: all of them when they fit; else the blanks
 * between groups go, then a window that keeps the selected line (a row with its group label
 * when it can) in view, its first row's group label kept on top when it is scrolled off, and a
 * last line saying how many rows are left out (`MoreLine`; BUG-231). `listView` keeps a window in
 * place while its selection stays in it.
 */
export function listWindow(lines: readonly ListLine[], selected: string | null, max: number): (ListLine | MoreLine)[] {
  return listView(lines, selected, max).lines;
}

/**
 * Where a window of the list is (`listView`): its first line's key, how many lines from there it
 * shows, whether its first row's group label is kept on top, and the rows it had (`max`).
 */
export type ListTop = { key: string; n: number; pinned: boolean; max: number };

/**
 * `listWindow`, kept where it was: `top` is the last window (the `top` this returned; null: none).
 * While the selected line is in it, the same window again, so a click that selects a line never
 * scrolls the list under the pointer (a double-click's second click would hit another line;
 * BUG-271). A selection above it comes first (with its label); below it, last: the window
 * scrolls just enough. With no window before, the selected line comes first.
 */
export function listView(lines: readonly ListLine[], selected: string | null, max: number, top: ListTop | null = null): { lines: (ListLine | MoreLine)[]; top: ListTop | null } {
  if (max <= 0) return { lines: [], top: null };
  if (lines.length <= max) return { lines: [...lines], top: null };
  const tight = lines.filter((l) => l.kind !== "blank");
  if (tight.length <= max) return { lines: tight, top: null };
  const at = Math.max(0, tight.findIndex((l) => lineKey(l) === selected));
  const rowsIn = (ls: readonly ListLine[]) => ls.filter((l) => l.kind === "row").length;
  const labelOf = (i: number) => {
    for (let j = i; j >= 0; j--) if (tight[j]!.kind === "label") return j;
    return -1;
  };
  /** `n` lines from `start`, an open group's label cut off from all its rows dropped (unless it is the one selected). */
  const slice = (start: number, n: number) => {
    const shown = tight.slice(start, start + n);
    const last = shown.at(-1)!;
    return { start, shown: shown.length > 1 && last.kind === "label" && !last.collapsed && lineKey(last) !== selected ? shown.slice(0, -1) : shown };
  };
  /** The `n` lines from `w`, with its first row's group label on top (`pinned`) and the line saying what is left out. */
  const view = (w: { start: number; shown: ListLine[] }, n: number, pinned: boolean) => {
    const above = rowsIn(tight.slice(0, w.start));
    const below = rowsIn(tight.slice(w.start + w.shown.length));
    const label = pinned ? [tight[labelOf(w.start)]!] : [];
    const more: MoreLine[] = max >= 2 && (above || below) ? [{ kind: "more", above, below }] : [];
    return { lines: [...label, ...w.shown, ...more], top: { key: lineKey(tight[w.start]!), n, pinned, max } };
  };
  /** Lines in the window, but the label on top and the last line: `max`, one less, or two less. */
  const room = (pinned: boolean) => (max < 2 ? max : max - 1 - (pinned ? 1 : 0));
  // The last window again while the selected line is in it (not its label on top: that scrolls up
  // to its group), the list as it is now still filling it.
  const from = top && top.max === max ? tight.findIndex((l) => lineKey(l) === top.key) : -1;
  if (top && from >= 0) {
    const start = Math.max(0, Math.min(from, tight.length - top.n));
    const fits = !top.pinned || (tight[start]?.kind === "row" && labelOf(start) >= 0);
    const v = fits && at >= start && at < start + top.n ? view(slice(start, top.n), top.n, top.pinned) : null;
    if (v && v.lines.length <= max) return v;
  }
  // Below the last window: the selected line last; else (above it, or none before) first, with
  // its label when that is the line just before.
  const last = from >= 0 && at > from;
  const window = (n: number) => {
    const own = Math.max(0, at - (tight[at]?.kind === "row" && tight[at - 1]?.kind === "label" ? 1 : 0));
    let start = Math.max(0, Math.min(last ? at - n + 1 : own, tight.length - n));
    if (at >= start + n) start = at - n + 1;
    return slice(start, n);
  };
  if (max < 2) return view(window(max), max, false);
  const w = window(room(false));
  if (max >= 4 && w.shown[0]?.kind === "row") {
    const narrower = window(room(true));
    const j = labelOf(narrower.start);
    if (narrower.shown[0]?.kind === "row" && j >= 0 && j < narrower.start) return view(narrower, room(true), true);
  }
  // No row left out: no such line, its row goes to the lines.
  if (!rowsIn(tight.slice(0, w.start)) && !rowsIn(tight.slice(w.start + w.shown.length))) return view(window(max), max, false);
  return view(w, room(false), false);
}

// ── the key list (`?`) ──────────────────────────────────────────────────────────────────────

/** A group of the key list: its title and `[key, what it does]` rows. */
export interface KeyGroup {
  title: string;
  keys: [string, string][];
}

/**
 * Every key, for the `?` key list (BUG-216): the home list's, a session's (the switch keys, the
 * clicks, scrolling back; BUG-229) and the intake chat's. `homeKey`: `handoff.key`. Without a
 * pseudo-terminal (`canOpen` false) a session can't be shown from here: no keys that open or switch one.
 * `mouse`: Gluon captures the mouse (`handoff.mouse_capture`): at home a click selects or opens a
 * row, the wheel scrolls, a drag selects text and copies it (BUG-269, BUG-286); in a session a click on the strip
 * switches and the wheel scrolls back. Without it, no clicks and no wheel named (BUG-275).
 */
export function keyGroups(homeKey: string, canOpen = true, mouse = true): KeyGroup[] {
  const sessions: [string, string][] = [
    ["↑↓", "select a row or group"],
    ["enter", canOpen ? "open it · fold a group" : "fold a group"],
    ...(canOpen ? ([["→", "open the first tab"]] as [string, string][]) : []),
    ...(mouse ? ([["click", canOpen ? "select · again opens" : "select a row"], ["drag", "select and copy text"]] as [string, string][]) : []),
    ["ctrl+d", "mark done, or not"],
    ["del", "end it (or the draft)"],
    ["ctrl+c twice", "quit"],
  ];
  const session: [string, string][] = [
    [keyLabel(homeKey), "then ←/→ · again: home"],
    [`${keyLabel(homeKey)} z`, "zoom · again: unzoom"],
    ["←/→", "switch, nothing typed"],
    // Without the mouse captured no click or wheel reaches Gluon in a session either (BUG-275).
    ...(mouse ? ([["click", "a tab, ◆ gluon, ‹ ›"]] as [string, string][]) : []),
    ["shift+pgup", mouse ? "scroll, wheel too" : "scroll"],
  ];
  const chat: [string, string][] = [
    ["enter", "send · pick an option"],
    ["↑↓ 1–9", "choose an option"],
    ["tab", "the agent's model"],
    ["shift+tab", "the agent's effort"],
    ["ctrl+t", "the mode"],
    ["pgup pgdn", mouse ? "scroll, wheel too" : "scroll"],
    ["ctrl+o", "fold the spec"],
    ["esc", "interrupt · close options"],
    ["esc esc", "clear the draft"],
    ["ctrl+j", "new line"],
  ];
  return [
    { title: "Sessions", keys: sessions },
    ...(canOpen ? [{ title: "In a session", keys: session }] : []),
    { title: "Intake chat", keys: chat },
  ];
}

/** Columns between a key and what it does, and between two columns of groups. */
const KEY_GAP = 2;
const GROUP_GAP = 3;

/** The ways to put `groups`, in order, into `n` columns (each a run of groups). */
function splits<T>(groups: readonly T[], n: number): T[][][] {
  if (n === 1) return [[[...groups]]];
  const out: T[][][] = [];
  for (let i = 1; i <= groups.length - n + 1; i++) for (const rest of splits(groups.slice(i), n - 1)) out.push([groups.slice(0, i), ...rest]);
  return out;
}

// Codex: bottom_pane/shortcut_overlay.rs — a titled key reference whose groups flow into columns.
/**
 * The `?` key list's lines at `width`: its title, then the groups in as many columns as fit (in
 * order, a column's groups one under the other, the columns as even as can be; one column when
 * two don't fit: a group is never left out, BUG-229), then a blank. The view shows a window of
 * them when they don't all fit, with the closing line (`keysClose`) saying what is left out.
 */
export function keysPanel(width: number, groups: readonly KeyGroup[]): Seg[][] {
  const lead: Seg = { text: " ", role: "dim" };
  // The groups stacked in one column share its key column, so what the keys do lines up (BUG-253).
  const column = (gs: readonly KeyGroup[]) => {
    const keyCol = Math.max(...gs.flatMap((g) => g.keys.map(([k]) => sw(k))));
    const groupLines = (g: KeyGroup): Seg[][] => [
      [{ text: g.title, role: "bright" }],
      ...g.keys.map(([k, a]): Seg[] => [
        { text: padEnd(k, keyCol + KEY_GAP), role: "bright", bold: true },
        { text: a, role: "dim" },
      ]),
    ];
    const width = Math.max(...gs.map((g) => Math.max(sw(g.title), keyCol + KEY_GAP + Math.max(...g.keys.map(([, a]) => sw(a))))));
    return { width, lines: gs.flatMap((g, i) => [...(i ? [[] as Seg[]] : []), ...groupLines(g)]) };
  };
  let cols = [column(groups)];
  let between = GROUP_GAP;
  // As many columns as fit; a column short, the gap between them narrows by one before they go.
  search: for (let n = groups.length; n > 1; n--) {
    for (const gap of [GROUP_GAP, GROUP_GAP - 1]) {
      const fit = splits(groups, n)
        .map((s) => s.map(column))
        .filter((cs) => 1 + cs.reduce((w, c) => w + c.width, 0) + gap * (cs.length - 1) <= width)
        .sort((a, b) => Math.max(...a.map((c) => c.lines.length)) - Math.max(...b.map((c) => c.lines.length)))[0];
      if (fit) {
        cols = fit;
        between = gap;
        break search;
      }
    }
  }
  const body: Seg[][] = [[lead, { text: "Keys", role: "bright", bold: true }], []];
  const height = Math.max(...cols.map((c) => c.lines.length));
  for (let i = 0; i < height; i++) {
    const line = cols.flatMap((c, j) => {
      const cell = c.lines[i] ?? [];
      return j < cols.length - 1 ? padSegs(cell, c.width + between) : cell;
    });
    body.push(line.length ? [lead, ...line] : []);
  }
  body.push([]);
  return body.map((l) => fitSegs(l, width));
}

/**
 * The key list's closing line: `? / esc close`, and what a cut left out above / below (PgUp /
 * PgDn scroll it; BUG-229), the wheel too when Gluon captures the mouse (`mouse`; BUG-276).
 */
export function keysClose(width: number, above: number, below: number, mouse = true): Seg[] {
  const more = [above ? `↑ ${above} above` : "", below ? `↓ ${below} more` : ""].filter(Boolean).join(" · ");
  return fitSegs(
    [
      { text: " ", role: "dim" },
      { text: "? / esc", role: "bright", bold: true },
      { text: " close", role: "dim" },
      ...(more ? ([{ text: " · ", role: "dim" }, { text: mouse ? "pgup pgdn / wheel" : "pgup pgdn", role: "bright", bold: true }, { text: ` ${more}`, role: "dim" }] as Seg[]) : []),
    ],
    width,
  );
}

// ── the chat ────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A listed folder by name; the repository root (".", "", "/", "./") has none (BUG-185). */
const folderName = (path: string) => (/^[.\\/\s]*$/.test(path) && !path.includes("..") ? "the repository" : path);

/**
 * An Explored group as one tool line: `Searched src/cli for "session" · read 3 files`. Kinds in
 * the order the brain first used them; failures counted at the end.
 */
export function summarizeExplored(rows: readonly Activity[]): string {
  const kinds: Activity["kind"][] = [];
  for (const r of rows) if (!kinds.includes(r.kind)) kinds.push(r.kind);
  const parts = kinds.map((k) => {
    const of = rows.filter((r) => r.kind === k);
    switch (k) {
      case "search": {
        const where = new Set(of.map((r) => r.where ?? ""));
        const place = where.size === 1 && of[0]!.where ? `${of[0]!.where} ` : "";
        return `searched ${place}for ${of.map((r) => `"${r.text}"`).join(", ")}`;
      }
      case "read":
        return of.length === 1 ? `read ${of[0]!.text}` : `read ${plural(of.length, "file")}`;
      case "list":
        return of.length === 1 ? `listed ${folderName(of[0]!.text)}` : `listed ${plural(of.length, "folder")}`;
      case "git":
        return of.length === 1 ? `ran git ${of[0]!.text}` : `ran ${plural(of.length, "git command")}`;
    }
  });
  const failed = rows.filter((r) => r.error).length;
  if (failed) parts.push(`${failed} failed`);
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// ── first run ───────────────────────────────────────────────────────────────────────────────

/** A harness's readiness on the first-run screen. */
export interface Readiness {
  harness: Harness;
  state: "ready" | "signin" | "missing" | "checking" | "nokey";
  /** `claude plan`, `api key`, `open-weight models`… (after `ready · `). */
  note?: string;
}

const READY_WORD: Record<Readiness["state"], string> = { ready: "ready", signin: "sign-in needed", missing: "not installed", checking: "checking…", nokey: "key missing" };

/** `● claude code      ready · claude plan`: glyph, name, readiness (the name column `nameWidth` wide). */
export function readinessSegs(r: Readiness, nameWidth: number): Seg[] {
  const glyph: Seg = r.state === "ready" ? { text: "●", role: "green" } : r.state === "checking" ? { text: "◌", role: "dim" } : { text: "○", role: "dim" };
  return [
    { text: " ", role: "dim" },
    glyph,
    { text: "  ", role: "dim" },
    { text: padEnd(HARNESS_WORD[r.harness], nameWidth), role: "bright" },
    { text: READY_WORD[r.state] + (r.note ? ` · ${r.note}` : ""), role: "dim" },
  ];
}

/** The readiness name column: the longest harness word plus a gap, as in the mockup (18). */
export const readinessNameWidth = (rows: readonly Readiness[], width: number) =>
  Math.min(18, Math.max(...rows.map((r) => sw(HARNESS_WORD[r.harness]) + 2), 8), Math.max(8, Math.floor(width / 3)));
