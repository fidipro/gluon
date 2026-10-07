import { Box, Text, type DOMElement } from "ink";
import type { Ref } from "react";
import type { Config } from "../config.ts";
import type { SessionState, SessionView } from "../sessions.ts";
import { CHOICE_HINTS, choiceHints, hintText, questionHints } from "./chat.tsx";
import { Segs } from "./header.tsx";
import { truncate, columnHeadSegs, groupLabel, keyGroups, keysClose, keysPanel, lineKey, listColumns, listLines, listView, type ListTop, moreText, readinessNameWidth, readinessSegs, rowCells, rowKey, rowSegs, type Readiness } from "./layout.ts";
import type { GluonPalette } from "./theme.ts";
import { useWidth } from "./width.tsx";

/**
 * What the hint line is about: the selected line (with an empty composer) — a run (`done`: one
 * marked done), the drafting row, a group label (`collapsed`: its rows hidden) — or an empty
 * list; an open question or agent choice (`question`, `choice`); text in the composer
 * (`typing`; `pick`: a lone digit naming an option; `working`: the intake agent is busy).
 */
export type HintFor = "run" | "done" | "draft" | "group" | "collapsed" | "empty" | "question" | "choice" | "talk" | "typing" | "pick" | "working" | HomeQuestion;

/** The home view's own question on its last row: ending a run, discarding the draft, quitting, a saved session that can't be resumed. */
export type HomeQuestion = "end" | "discard" | "quit" | "resume" | "again";

/** Ends every hint `?` opens the key list from. */
export const KEYS_HINT = "? for keys";

// Codex: bottom_pane/footer.rs — a short contextual hint ending in `? for shortcuts`.
/**
 * The hint line above the list: only the keys for what is selected, then `? for keys` (the full
 * list, with the home key and quitting; BUG-216). A run: Enter opens it, Ctrl+D marks it done or
 * not (BUG-193), Delete ends it (after asking, BUG-164); the drafting row: Delete discards the chat;
 * a group label: what Enter does to it (BUG-194). The open question's or choice's keys are the
 * essential ones of the hint under it, in the same words (`talk`: `keep talking` highlighted; BUG-225). Without a pseudo-terminal (`canOpen` false) a
 * session can't be shown again once it ended: no Enter for a run. While a question or the agent
 * choice is open, its keys (BUG-217). With text typed (or options open) `?` is text: no `? for keys`.
 * `option`: the option a lone digit names (`pick`). While the home view's own question is up
 * (`end`, `discard`, `quit`, `resume`), what Enter and Esc do to it (BUG-224).
 */
export function homeHint(about: HintFor, canOpen = true, option = 1): string {
  switch (about) {
    case "typing":
      return hintText(questionHints("text"));
    case "pick":
      return hintText(questionHints(option));
    case "working":
      return "still working · esc interrupts";
    case "question":
      return hintText(questionHints());
    case "choice":
      return hintText(CHOICE_HINTS);
    case "talk":
      return hintText(choiceHints(undefined, []));
    case "group":
    case "collapsed":
      return [`enter ${about === "group" ? "collapses" : "expands"} the group`, KEYS_HINT].join(" · ");
    case "draft":
      return ["del discards it", KEYS_HINT].join(" · ");
    case "run":
    case "done":
      return [...(canOpen ? ["enter opens it"] : []), `ctrl+d ${about === "done" ? "unmarks" : "marks"} done`, "del ends it", KEYS_HINT].join(" · ");
    case "empty":
      return KEYS_HINT;
    case "end":
      return "enter ends it · esc keeps it";
    case "discard":
      return "enter discards it · esc keeps it";
    case "quit":
      return "enter quits · esc stays";
    case "resume":
      return "enter yes · esc no";
    case "again":
      return "enter starts it again · esc drops it · ctrl+c keeps it";
  }
}

/** The hint on a run's row. */
export const HOME_HINT = homeHint("run");

/**
 * A hint cut to `width` by whole keys (BUG-228): `? for keys` stays; the other keys go from the
 * right, Enter's and Esc's last (so `↑↓ choose` goes before them); one key left is cut with `…`.
 */
export function fitHint(text: string, width: number): string {
  const parts = text.split(" · ");
  const essential = (p: string) => p === KEYS_HINT || /^(enter|esc) /.test(p);
  while (parts.length > 1 && Bun.stringWidth(parts.join(" · ")) > width) {
    const i = parts.findLastIndex((p) => !essential(p));
    parts.splice(i >= 0 ? i : parts.findLastIndex((p) => p !== KEYS_HINT), 1);
  }
  const out = parts.join(" · ");
  return Bun.stringWidth(out) > width ? truncate(out, width) : out;
}

/** The hint line above the list (dim), fitted to the width by whole keys (`fitHint`). */
export function Hint({ text, palette }: { text: string; palette: GluonPalette }) {
  const width = useWidth();
  return (
    <Text color={palette.dim} wrap="truncate-end">
      {fitHint(text, width)}
    </Text>
  );
}

/** From this many rows the list has its column header line (`context`, `cost`, `time`). */
const HEAD_FROM = 3;

/**
 * What `SessionList` shows in `maxRows`, top to bottom: its column header line (`head`), then the
 * lines of the window that keeps the selected one in view, where it was (`listView`: `top` is the
 * last window's, as this returned it). The home view reads a click's row from it (BUG-269).
 */
export function sessionListLines(sessions: readonly SessionView[], selected: string | null, collapsed: ReadonlySet<SessionState> | undefined, maxRows: number, top: ListTop | null = null) {
  const head = maxRows >= HEAD_FROM;
  return { head, ...listView(listLines(sessions, collapsed), selected, maxRows - (head ? 1 : 0), top) };
}

/**
 * The sessions, grouped (Awaiting input, Working, Done, Drafting; empty groups hidden, a group in
 * `collapsed` shows its label only), under a column header line, at most `maxRows` lines in all
 * (`listView` keeps the selected line in view, the window where it was: `top`; the header goes
 * first when short of rows).
 * `selected`: a `lineKey` (a group label or a row). Columns from `listColumns`; the selected line
 * is a full-width `selected` bar, or (`dim`: the keys are a question's or the agent choice's) not
 * highlighted at all: only what Enter acts on is (BUG-217, BUG-247).
 */
export function SessionList({ sessions, selected, collapsed, maxRows, palette, config, now, dim = false, boxRef, top = null }: { sessions: readonly SessionView[]; selected: string | null; collapsed?: ReadonlySet<SessionState>; maxRows: number; palette: GluonPalette; config?: Pick<Config, "models">; now: number; dim?: boolean; boxRef?: Ref<DOMElement>; top?: ListTop | null }) {
  const barColor = dim ? undefined : palette.selected;
  const width = useWidth();
  const { head, lines } = sessionListLines(sessions, selected, collapsed, maxRows, top);
  const cells = new Map(sessions.map((s) => [s.id, rowCells(s, now, config)]));
  const cols = listColumns(width, [...cells.values()]);
  return (
    <Box ref={boxRef} flexDirection="column" flexShrink={0}>
      {head ? <Segs key="head" segs={columnHeadSegs(cols)} palette={palette} /> : null}
      {lines.map((l, i) => {
        if (l.kind === "blank") return <Text key={`b${i}`}> </Text>;
        if (l.kind === "more")
          return (
            <Text key="more" color={palette.dim} wrap="truncate-end">
              {`    ${moreText(l)}`}
            </Text>
          );
        if (l.kind === "label") {
          const on = lineKey(l) === selected;
          return (
            <Box key={`l${l.state}`} width="100%" backgroundColor={on ? barColor : undefined}>
              <Text color={palette.bright} bold={on && !dim} wrap="truncate-end">
                {` ${groupLabel(l)}`}
              </Text>
            </Box>
          );
        }
        const on = rowKey(l.session.id) === selected;
        return (
          <Box key={l.session.id} width="100%" backgroundColor={on ? barColor : undefined}>
            <Segs segs={rowSegs(cols, cells.get(l.session.id)!, on && !dim)} palette={palette} />
          </Box>
        );
      })}
    </Box>
  );
}

export const EMPTY_NOTE = "Every session you start shows up here. Switch between them any time.";

/** First run: `Agents available`, one readiness row per harness, then the dim note; at most `maxRows` (the rest is cut). */
export function AgentsAvailable({ readiness, palette, maxRows = Infinity }: { readiness: readonly Readiness[]; palette: GluonPalette; maxRows?: number }) {
  const width = useWidth();
  const nameWidth = readinessNameWidth(readiness, width);
  const label = (
    <Text key="label" color={palette.bright} wrap="truncate-end">
      {" Agents available"}
    </Text>
  );
  const note = (
    <Text key="note" color={palette.dim} wrap="truncate-end">
      {EMPTY_NOTE}
    </Text>
  );
  const rows = [label, ...readiness.map((r) => <Segs key={r.harness} segs={readinessSegs(r, nameWidth)} palette={palette} />)];
  // One row short: the blank above the note goes first, then the note (BUG-216: the hint's row).
  const all = maxRows >= rows.length + 2 ? [...rows, <Text key="blank"> </Text>, note] : maxRows === rows.length + 1 ? [...rows, note] : rows;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {all.slice(0, Math.max(0, maxRows))}
    </Box>
  );
}

/**
 * The `?` key list (BUG-216), in place of the list and the chat: every key, at most `maxRows`
 * lines, the closing line kept; cut, it shows the lines from `offset` and says what is left out
 * (BUG-229).
 */
export function KeysPanel({ homeKey, canOpen, mouse = true, maxRows, offset = 0, palette }: { homeKey: string; canOpen: boolean; mouse?: boolean; maxRows: number; offset?: number; palette: GluonPalette }) {
  const width = useWidth();
  const body = keysPanel(width, keyGroups(homeKey, canOpen, mouse));
  const room = Math.max(0, maxRows - 1);
  const from = Math.max(0, Math.min(offset, body.length - room));
  const shown = body.slice(from, from + room);
  const lines = maxRows <= 0 ? [] : [...shown, keysClose(width, from, Math.max(0, body.length - from - shown.length), mouse)];
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((segs, i) => (segs.length ? <Segs key={i} segs={segs} palette={palette} /> : <Text key={i}> </Text>))}
    </Box>
  );
}
