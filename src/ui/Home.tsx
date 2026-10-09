/**
 * Gluon's home view (design brief 5.1/5.2): the header with the mark, the sessions grouped by
 * state (first run: the agents available), and the intake chat docked below with the
 * composer pinned to the bottom. One Ink render for the life of the process: the app enters the
 * alternate screen itself, so the frame is exactly rows − 1 tall (never the full height, or Ink
 * clears the screen each frame) and there is no `<Static>`; the chat scrolls on its own.
 *
 * Keys (the composer always has the text focus):
 * - typing, editing keys, paste → the composer; Enter sends a non-empty draft.
 * - with an open question or agent choice: ↑↓ (empty composer) move the highlight; a lone digit
 *   in the composer highlights option N and Enter picks it; anything else typed highlights the
 *   last row (own answer / keep talking) and Enter sends it, so "2 tests" is an answer (BUG-159);
 *   Tab on a question's option puts it in the composer to add your words (issue 55); Tab /
 *   Shift+Tab on an agent cycle its model / effort, Ctrl+T the whole proposal's mode, Ctrl+P the
 *   agent's permissions in build mode (`permissionLevels`: its own first), Ctrl+O folds the spec (shown in
 *   its box above the agents) to one line and back, Esc closes the options (the chat keeps them:
 *   a typed reply answers).
 * - otherwise, with an empty composer: ↑↓ move over the group labels and the sessions (BUG-194);
 *   Enter opens a session (`onOpen`), or collapses / expands a group; → the first tab (digits are
 *   always text: "2 bugs to fix" types whole, BUG-233); Ctrl+D marks the
 *   selected run done, or not (`store.toggleDone`: Done is the user's word alone; BUG-193);
 *   Delete removes any row — a run's agent is ended after asking (`onEnd`; BUG-164), the drafting
 *   row's chat discarded after asking (`onDiscard`); the hint line says which. Without a
 *   pseudo-terminal (`canOpen` false) an ended session can't be opened: Enter says so.
 * - PgUp/PgDn scroll the chat; while the agent choice is open, its spec only (when cut to fit;
 *   BUG-218), so the options never leave the screen. Enter while the intake agent works queues the
 *   message until its turn ends (`queued`; BUG-716). Esc cancels a queued message, then
 *   interrupts the intake agent, or (twice) clears the draft;
 *   Ctrl+C clears the draft, interrupts, or (twice, idle) quits (`onQuit`).
 * - `?` on an empty composer with no options open: the key list, in place of the list and the chat
 *   (BUG-216); `?` or Esc closes it, any other key closes it and does what it does.
 *
 * The mouse (`mouse`, when Gluon captures it; BUG-269): a left click on a session row selects it, on
 * the selected one (while the list's selection shows) or twice within `DOUBLE_CLICK_MS` opens it
 * as Enter does; on a group label it folds or unfolds the group (a double-click once: BUG-274);
 * anywhere else nothing; while a question or the agent choice is open, a click on one of its options
 * picks it as its digit and Enter do (BUG-277). A click never scrolls the list (`listView`), and a double-click's second
 * click is on the first's line (BUG-271). The wheel scrolls what PgUp/PgDn scroll, `WHEEL_ROWS` a
 * notch. Releases, drags and other buttons: nothing.
 */
import { Box, measureElement, Text, usePaste, useInput, useWindowSize, type DOMElement, type Key } from "ink";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cycleEffort, cycleMode, cycleModel, cyclePermissions, type AgentTriple, type ChoiceOverride } from "../agent/choices.ts";
import type { NamedChoice, Session, State } from "../agent/session.ts";
import type { AgentOption, Config, Effort } from "../config.ts";
import { HARNESS_INFO, modeUnavailable, permissionLevels, type Mode } from "../harnesses.ts";
import { ANSWERING, counts, groupOf, PICKING, tabs, TALKING, type SessionState, type SessionStore, type SessionView } from "../sessions.ts";
import { CHAT_INDENT, choiceHints, composerHeight, questionHints, FIRST_LINE, GluonComposer, openBlockRows, Rule, specRows, Transcript } from "./chat.tsx";
import * as ed from "./editor.ts";
import { Header, type HeaderInfo } from "./header.tsx";
import { markdownRows } from "./markdown.tsx";
import { pressedTwice, splitKeys, useLateOscFilter } from "./keys.ts";
import { DOUBLE_CLICK_MS, groupKey, keyGroups, keysPanel, lineKey, listLines, rowKey, selectable, selectedKey, selectionAfter, type ListTop, type Readiness } from "./layout.ts";
import { AgentsAvailable, Hint, homeHint, KeysPanel, SessionList, sessionListLines, type HintFor, type HomeQuestion } from "./list.tsx";
import type { MouseReport } from "../pty/types.ts";
import type { Theme } from "./theme.ts";
import { Width } from "./width.tsx";

export interface HomeProps {
  store: SessionStore;
  /** The intake chat of the current draft (a new one after each start: the view resets). */
  session: Session;
  theme: Theme;
  header: HeaderInfo;
  /** First run's "Agents available" rows. */
  readiness: readonly Readiness[];
  /** The agents and models the intake agent may offer: what Tab cycles through. */
  offeredAgents: AgentOption[];
  /** Model labels for the agent triples (`sonnet 5.5`); without it, model ids. */
  config?: Pick<Config, "models">;
  /** Enter on a session row, or → (the first tab): show that session. */
  onOpen: (id: number) => void;
  /** Enter on an agent option: the launch (`Session.confirm` with the Tab adjust applied). */
  onStart: (choice: NamedChoice) => void;
  /** Ctrl+C twice. The caller confirms when sessions are still running. */
  onQuit: () => void;
  /** Delete on a run's row whose agent runs: the caller asks "End <name>?" and ends it on yes. */
  onEnd?: (id: number) => void;
  /** Delete on the drafting row: the caller asks "Discard this chat?" and starts the chat over on yes. */
  onDiscard?: () => void;
  /** `handoff.key`, named in the hint (default `ctrl+\`). */
  homeKey?: string;
  /** The question up on the last row (the compositor's overlay takes every key meanwhile): the hint names its keys, the composer shows no cursor (BUG-224). */
  asking?: HomeQuestion | null;
  /**
   * The session the home view was last shown again from (a new object each time): its row is
   * selected (BUG-231). A getter: a key right after the home key comes before the render (BUG-236).
   */
  back?: () => { id: number } | null;
  /** False without a pseudo-terminal: a session that ended can't be shown again. */
  canOpen?: boolean;
  /** Whether the composer holds typed text, as it changes: Gluon's own questions wait for it to be empty (they would eat what is typed). */
  onDraft?: (typed: boolean) => void;
  /** The clock for elapsed times (tests). */
  now?: () => number;
  /** Subscribes to the mouse reports Gluon gets at home (none: the home view sees no mouse); returns the unsubscribe. */
  mouse?: (fn: (m: MouseReport) => void) => () => void;
}

/** Rows a wheel notch scrolls, as in a session's frame (`WHEEL_ROWS` in `src/pty/compositor.ts`). */
const WHEEL_ROWS = 3;

/** Rows the chat keeps however long the list is. */
const MIN_CHAT = 4;
/** Rows above the list or readiness block: a blank, the header (3), a blank. */
const TOP = 5;
const HEADER_ROWS = 3;
/** Below this many rows the frame drops its blank rows and the chat's minimum. */
const SHORT_FRAME = 20;
/** Rows the chat keeps, short of rows, before the header goes too. */
const SHORT_CHAT = 6;

/** The open question's or proposal's option count (the last row: own answer / keep talking). */
const optionCount = (p: State["pending"]) => (p?.kind === "question" ? p.question.options.length + 1 : p?.kind === "proposal" ? p.choices.length + 1 : 0);

/**
 * The option Enter acts on: the one a draft of a lone digit names, the last row (own answer / keep
 * talking) while something else is typed, else the arrow selection.
 */
export function shownOption(text: string, selected: number, count: number): number {
  const t = text.trim();
  if (/^[1-9]$/.test(t) && Number(t) <= count) return Number(t) - 1;
  return t ? count - 1 : selected;
}

/** The composer's placeholder while a chat is being drafted: what is typed goes on with it (BUG-227). */
export const REPLY_PLACEHOLDER = "reply to the intake agent";

/** No pseudo-terminal: what Enter on an ended session says. */
export const NO_REOPEN = "No pseudo-terminal here, so an ended session can't be shown again (del removes it)";

export function Home({ store, session, theme, header, readiness, offeredAgents, config, onOpen, onStart, onQuit, onEnd, onDiscard, asking = null, back = () => null, homeKey = "ctrl+\\", canOpen = true, onDraft, now = Date.now, mouse }: HomeProps) {
  const palette = theme.gluon;
  const { columns, rows } = useWindowSize();
  useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.snapshotVersion,
  );
  const sessions = store.sessions;
  const [state, setState] = useState<State>(session.snapshot);
  const [draft, setDraftState] = useState<ed.Draft>(ed.EMPTY);
  // The selected list line (`lineKey`: a group label or a session row) and the collapsed groups.
  const [listSel, setListSelState] = useState<string | null>(null);
  const [collapsed, setCollapsedState] = useState<ReadonlySet<SessionState>>(new Set());
  const [optSel, setOptSelState] = useState(0);
  const [triples, setTriplesState] = useState<AgentTriple[]>([]);
  // The proposal's mode, whole (ctrl+t): the proposal's own, build when none.
  const [mode, setModeState] = useState<Mode>("build");
  const [closed, setClosedState] = useState(false);
  const [showSpec, setShowSpec] = useState(true);
  const [specOffset, setSpecOffsetState] = useState(0);
  const [scroll, setScrollState] = useState(0);
  const [nudge, setNudge] = useState<string | null>(null);
  // A message sent while the intake agent worked: held until its turn ends (BUG-716).
  const [queued, setQueuedState] = useState<string | null>(null);
  // The `?` key list is open (BUG-216).
  const [keysOpen, setKeysOpenState] = useState(false);
  // How far the key list is scrolled, when it doesn't fit (BUG-229).
  const [keysOffset, setKeysOffsetState] = useState(0);
  const [, setTick] = useState(0);
  // The key handler reads these, not the render's values: several keys can arrive before a render.
  const draftRef = useRef(draft);
  const listSelRef = useRef(listSel);
  const collapsedRef = useRef(collapsed);
  const optSelRef = useRef(optSel);
  const triplesRef = useRef(triples);
  const modeRef = useRef(mode);
  const closedRef = useRef(closed);
  const scrollRef = useRef(scroll);
  const queuedRef = useRef(queued);
  const specOffsetRef = useRef(specOffset);
  const keysOpenRef = useRef(keysOpen);
  const keysOffsetRef = useRef(keysOffset);
  // The key list's lines and the rows it has (set by the render, read by PgUp/PgDn).
  const keysCut = useRef({ lines: 0, rows: 0 });
  // The spec's rows shown and in all, when it is cut to fit (set by the render, read by PgUp/PgDn).
  const specCut = useRef<{ rows: number; total: number } | null>(null);
  const armed = useRef<{ key: string; at: number } | null>(null);
  const viewport = useRef<DOMElement>(null);
  // The session list's box and the lines it shows (set by the render, read by a click).
  const listBox = useRef<DOMElement>(null);
  // The open question's or choice's option boxes (chat.tsx `OptionList`), for a click.
  const optionBoxes = useRef<(DOMElement | null)[]>([]);
  const listShown = useRef<ReturnType<typeof sessionListLines> | null>(null);
  // The last click on the list: its line, when, and its cell (a double-click's second click is on the first's line).
  const lastClick = useRef<{ key: string; at: number; x: number; y: number } | null>(null);
  // The list's window: its first line's key, kept while the selection stays in it (BUG-271).
  const listTopRef = useRef<ListTop | null>(null);
  const content = useRef<DOMElement>(null);
  const heights = useRef({ viewport: 0, content: 0 });

  const ref =
    <T,>(r: { current: T }, set: (v: T) => void) =>
    (v: T) => {
      r.current = v;
      set(v);
    };
  const setDraft = (next: ed.Draft | ((d: ed.Draft) => ed.Draft)) => ref(draftRef, setDraftState)(typeof next === "function" ? next(draftRef.current) : next);
  const hasDraft = draft.text !== "";
  useEffect(() => {
    onDraft?.(hasDraft);
  }, [hasDraft]);
  const setListSel = ref(listSelRef, setListSelState);
  const setCollapsed = ref(collapsedRef, setCollapsedState);
  const setOptSel = ref(optSelRef, setOptSelState);
  const setTriples = ref(triplesRef, setTriplesState);
  const setMode = ref(modeRef, setModeState);
  const setClosed = ref(closedRef, setClosedState);
  const setScroll = ref(scrollRef, setScrollState);
  const setQueued = ref(queuedRef, setQueuedState);
  const setSpecOffset = ref(specOffsetRef, setSpecOffsetState);
  const setKeysOpen = ref(keysOpenRef, setKeysOpenState);
  const setKeysOffset = ref(keysOffsetRef, setKeysOffsetState);

  // A new chat (after a start) begins empty, at the bottom. The drafting row takes the name the
  // intake agent gave the session as its proposal arrives, before the frame that shows it (BUG-258).
  useEffect(() => {
    setScroll(0);
    return session.subscribe((s) => {
      const d = store.draft();
      if (s.pending?.kind === "proposal" && d && d.name !== s.pending.name) store.rename(d.id, s.pending.name);
      setState(s);
    });
  }, [session]);
  // A new question or proposal opens with its first option highlighted and no adjustments. Reset
  // while rendering, not in an effect: a frame with the new proposal and the last one's options
  // (none: `keep talking` alone) must never be drawn (BUG-258).
  const [pendingSeen, setPendingSeen] = useState<State["pending"] | undefined>(undefined);
  if (pendingSeen !== state.pending) {
    const p = state.pending;
    setPendingSeen(p);
    setOptSel(0);
    setClosed(false);
    setShowSpec(true);
    setSpecOffset(0);
    // The agent choice opens with the chat at its bottom: PgUp/PgDn won't move it (BUG-218).
    if (p?.kind === "proposal") setScroll(0);
    setTriples(p?.kind === "proposal" ? [...p.choices] : []);
    setMode(p?.kind === "proposal" ? (p.mode ?? "build") : "build");
    // A draft typed meanwhile now answers this: say so, rather than re-target it silently (BUG-11).
    if (p && draftRef.current.text.trim()) setNudge(p.kind === "question" ? "Your draft is still below: enter sends it as your answer (esc esc clears it)" : "Your draft is still below: enter sends it as a change to the session (esc esc clears it)");
  }
  // Elapsed times move on.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  // The chat's scroll offset stays within what there is to scroll.
  useEffect(() => {
    if (!viewport.current || !content.current) return;
    heights.current = { viewport: measureElement(viewport.current).height, content: measureElement(content.current).height };
    const max = Math.max(0, heights.current.content - heights.current.viewport);
    if (scrollRef.current > max) setScroll(max);
  });

  // A row that goes (Delete, its session ended, the draft discarded) hands the selection to the
  // next row, or the previous one when it was the last (BUG-220): the list as last shown, and
  // its selection, are what the store's change is compared with.
  const shown = useRef<{ keys: string[]; sel: string | null }>({ keys: [], sel: null });
  useEffect(
    () =>
      store.subscribe(() => {
        const lines = listLines(store.sessions, collapsedRef.current);
        const keys = selectable(lines).map(lineKey);
        const next = selectionAfter(shown.current.keys, keys, shown.current.sel);
        if (next && next !== listSelRef.current) setListSel(next);
        shown.current = { keys, sel: selectedKey(lines, next ?? listSelRef.current, store.sessions) };
      }),
    [store],
  );

  // Back from a session, however (the home key twice, ←/→, a click): its row is selected
  // (BUG-231), as soon as the render or a key sees it come back: an effect, or the render alone,
  // came only after the next key, so Enter, Ctrl+D or Delete acted on the row selected before (BUG-236).
  const backSeen = useRef<{ id: number } | null>(null);
  const syncBack = (inRender: boolean) => {
    const b = back();
    if (b === backSeen.current) return;
    backSeen.current = b;
    if (!b) return;
    // Its group folded: it opens, so the row itself is selected, not the group's label, and Enter,
    // Ctrl+D and Delete act on the session just left (BUG-263).
    const left = store.get(b.id);
    if (left && collapsedRef.current.has(groupOf(left))) {
      const open = new Set(collapsedRef.current);
      open.delete(groupOf(left));
      collapsedRef.current = open;
      if (inRender) setCollapsedState(open);
      else setCollapsed(open);
    }
    listSelRef.current = rowKey(b.id);
    // What the store's next change is compared with (BUG-220): this row, not the one shown before.
    shown.current = { ...shown.current, sel: listSelRef.current };
    if (inRender) setListSelState(listSelRef.current);
    else setListSel(listSelRef.current);
  };
  syncBack(true);

  const runs = sessions.filter((s) => s.state !== "drafting");
  const lines = listLines(sessions, collapsed);
  const selected = selectedKey(lines, listSel, sessions);
  shown.current = { keys: selectable(lines).map(lineKey), sel: selected };
  const firstRun = sessions.length === 0;
  const busy = state.workingSince !== null;
  const optionsOpen = !busy && !!state.pending && !closed;
  // The drafting row waits for the user's pick while the agent choice is open (BUG-222), and only
  // then: closed (Esc, keep talking) the chat goes on (BUG-226).
  const picking = optionsOpen && state.pending?.kind === "proposal";
  // The intake agent's question waits for the user's answer, its options shown or not (Esc hides
  // them; a typed reply still answers it; BUG-239).
  const answering = !busy && state.pending?.kind === "question";
  useEffect(() => {
    const d = store.draft();
    if (d) store.update(d.id, { activity: picking ? PICKING : answering ? ANSWERING : TALKING });
  }, [picking, answering, store]);

  const send = (text: string) => {
    setDraft(ed.EMPTY);
    setScroll(0);
    store.ensureDraft(now());
    void session.submit(text.trim());
  };

  // A queued message goes once the turn ends, never during one (`Session.submit` is not for a turn in progress). A question
  // or proposal waiting then keeps it: Enter sends it as the answer, so nothing silently becomes one (BUG-11, BUG-716).
  useEffect(() => {
    const q = queuedRef.current;
    if (!q || session.busy || session.snapshot.pending) return;
    setQueued(null);
    setScroll(0);
    store.ensureDraft(now());
    void session.submit(q);
  }, [busy, state.pending, queued]);

  const confirmTwice = (key: string, message: string) => {
    if (pressedTwice(armed, key)) return true;
    setNudge(message);
    return false;
  };

  const choose = (i: number) => {
    const p = session.snapshot.pending;
    if (p?.kind === "question") {
      const opt = p.question.options[i];
      if (opt) send(opt.label);
      else setNudge("Type your answer below, then press enter");
      return;
    }
    if (p?.kind !== "proposal") return;
    if (i >= p.choices.length) {
      setClosed(true);
      setNudge("Tell the intake agent what to change, then press enter");
      return;
    }
    const base = p.choices[i]!;
    const t = triplesRef.current[i] ?? base;
    const override: ChoiceOverride = {
      ...(t.model !== base.model ? { model: t.model } : {}),
      ...(t.effort !== base.effort ? { effort: t.effort } : {}),
      ...(modeRef.current !== (p.mode ?? "build") ? { mode: modeRef.current } : {}),
      ...(t.permissions && t.permissions !== "own" ? { permissions: t.permissions } : {}),
    };
    const choice = session.confirm(i, override);
    if (choice) onStart(choice);
    else {
      // A mode the agent can't run (ctrl+t to explore on Kimi Code) is said as such, not as a model or effort problem.
      const mode = modeRef.current;
      const why = mode !== "build" ? HARNESS_INFO[t.harness].modes[mode].unavailable : undefined;
      // The advice first: the line is one row, cut at its end, and the reason is the long part (BUG-672).
      setNudge(why ? `Pick another agent or change the mode (ctrl+t). ${modeUnavailable(HARNESS_INFO[t.harness].label, mode, why)}` : "That agent can't start with this model and effort; pick another");
    }
  };

  /** The selected line's key as the list now stands (the handler's view: refs, not the render's). */
  const currentKey = () => selectedKey(listLines(store.sessions, collapsedRef.current), listSelRef.current, store.sessions);

  /** ↑↓ over the group labels and the rows, so the selection moves even with one session (BUG-194). */
  const moveList = (dir: 1 | -1) => {
    const keys = selectable(listLines(store.sessions, collapsedRef.current)).map(lineKey);
    if (!keys.length) return;
    const at = keys.indexOf(currentKey() ?? "");
    setListSel(keys[Math.max(0, Math.min(keys.length - 1, (at < 0 ? 0 : at) + dir))]!);
  };

  /** A group's label selected, the group collapsed or expanded. */
  const toggleGroup = (state: SessionState) => {
    const next = new Set(collapsedRef.current);
    if (!next.delete(state)) next.add(state);
    setListSel(groupKey(state));
    setCollapsed(next);
  };

  /** Enter on the list: a group label collapses or expands its group; a row opens its session. */
  const openSelected = () => {
    const key = currentKey();
    const label = selectable(listLines(store.sessions, collapsedRef.current)).find((l) => l.kind === "label" && lineKey(l) === key);
    if (label?.kind === "label") return toggleGroup(label.state);
    const s = selectedRow();
    if (!s) return;
    if (s.state === "drafting") setNudge("That's this chat: type below");
    else show(s);
  };

  /** Shows a session in the frame (none without a pseudo-terminal: it ended, BUG-180). */
  const show = (s: SessionView) => {
    if (canOpen) onOpen(s.id);
    else setNudge(NO_REOPEN);
  };

  /** The selected session (none while a group label is selected). */
  const selectedRow = () => rowOf(currentKey());

  /** The session a `rowKey` names. */
  function rowOf(key: string | null): SessionView | undefined {
    return key?.startsWith("s:") ? store.get(Number(key.slice(2))) : undefined;
  }

  /** The chat back (`dir` 1) or forward a page, or `rows`. */
  const scrollChat = (dir: 1 | -1, rows?: number) => {
    const page = Math.max(1, heights.current.viewport - 1);
    const max = Math.max(0, heights.current.content - heights.current.viewport);
    setScroll(Math.max(0, Math.min(max, scrollRef.current + dir * (rows ?? page))));
  };

  /**
   * PgUp / PgDn (`rows`: a wheel notch): the key list while it is open (when it doesn't fit;
   * BUG-229); while the agent choice is open, its spec only (when cut to fit), never the chat, so
   * the options stay on screen (BUG-218); else the chat.
   */
  const scrollPage = (down: boolean, rows?: number) => {
    const dir = down ? 1 : -1;
    if (keysOpenRef.current) {
      const { lines, rows: room } = keysCut.current;
      const max = Math.max(0, lines - (room - 1));
      return setKeysOffset(Math.max(0, Math.min(max, Math.min(max, keysOffsetRef.current) + dir * (rows ?? Math.max(1, room - 2)))));
    }
    const pending = session.snapshot.pending;
    if (!session.busy && pending?.kind === "proposal" && !closedRef.current) {
      const cut = specCut.current;
      if (!cut) return;
      const max = Math.max(0, cut.total - cut.rows);
      const at = Math.min(max, specOffsetRef.current);
      return setSpecOffset(Math.max(0, Math.min(max, at + dir * (rows ?? Math.max(1, cut.rows - 1)))));
    }
    scrollChat(down ? -1 : 1, rows);
  };

  /** The list's selectable line drawn at the 0-based cell `x`, `y` (none: elsewhere, or the list isn't shown). */
  const lineAt = (x: number, y: number) => {
    const box = listBox.current;
    const shown = listShown.current;
    if (!box?.yogaNode || !shown) return null;
    let top = 0;
    let left = 0;
    for (let n: DOMElement | undefined = box; n; n = n.parentNode) {
      top += n.yogaNode?.getComputedTop() ?? 0;
      left += n.yogaNode?.getComputedLeft() ?? 0;
    }
    if (x < left || x >= left + box.yogaNode.getComputedWidth()) return null;
    const line = y - top >= (shown.head ? 1 : 0) ? shown.lines[y - top - (shown.head ? 1 : 0)] : undefined;
    return line?.kind === "row" || line?.kind === "label" ? line : null;
  };

  /** The open option drawn at the 0-based cell `x`, `y` and inside the chat's viewport (none: elsewhere). */
  const optionAt = (x: number, y: number) => {
    const inside = (n: DOMElement | null | undefined) => {
      if (!n?.yogaNode) return false;
      let top = 0;
      let left = 0;
      for (let p: DOMElement | undefined = n; p; p = p.parentNode) {
        top += p.yogaNode?.getComputedTop() ?? 0;
        left += p.yogaNode?.getComputedLeft() ?? 0;
      }
      return x >= left && x < left + n.yogaNode.getComputedWidth() && y >= top && y < top + n.yogaNode.getComputedHeight();
    };
    const view = viewport.current;
    if (!inside(view) || !view?.yogaNode) return -1;
    const count = optionCount(session.snapshot.pending);
    for (let i = 0; i < count; i++) if (inside(optionBoxes.current[i])) return i;
    return -1;
  };

  /** A mouse report at home (BUG-269; the doc comment above). Never text: nothing reaches the composer. */
  const onMouse = (m: MouseReport) => {
    syncBack(false);
    if (m.wheel === "up" || m.wheel === "down") return scrollPage(m.wheel === "down", WHEEL_ROWS);
    if (m.button !== 0 || m.release || m.motion) return;
    // An open question or agent choice: a click on an option picks it, as its digit and Enter do.
    if (!session.busy && session.snapshot.pending && !closedRef.current) {
      const i = optionAt(m.x - 1, m.y - 1);
      if (i >= 0) {
        setNudge(null);
        setOptSel(i);
        return choose(i);
      }
    }
    const at = performance.now();
    const last = lastClick.current;
    // A second click on the cell of the first, within the time: on the first one's line, whatever
    // the list shows there now (BUG-271).
    const again = last && at - last.at <= DOUBLE_CLICK_MS && last.x === m.x && last.y === m.y ? selectable(listLines(store.sessions, collapsedRef.current)).find((l) => lineKey(l) === last.key) : undefined;
    const line = again ?? lineAt(m.x - 1, m.y - 1);
    if (!line) return;
    setNudge(null);
    const key = lineKey(line);
    const twice = !!last && last.key === key && at - last.at <= DOUBLE_CLICK_MS;
    lastClick.current = twice ? null : { key, at, x: m.x, y: m.y };
    // A double-click on a label folds or unfolds it once: its first click did (BUG-274).
    if (line.kind === "label") return twice ? undefined : toggleGroup(line.state);
    // While a question or the agent choice is open the selection isn't shown (BUG-217): a click selects first.
    const shownSel = !(!session.busy && !!session.snapshot.pending && !closedRef.current);
    if (twice || (shownSel && currentKey() === key)) {
      setListSel(key);
      return openSelected();
    }
    setListSel(key);
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.((m) => mouseRef.current(m)), [mouse]);

  const handleKey = (input: string, key: Key) => {
    syncBack(false);
    const d = draftRef.current;
    const blank = !d.text.trim();
    const pending = session.snapshot.pending;
    const isBusy = session.busy;
    const options = !isBusy && !!pending && !closedRef.current;
    const count = optionCount(pending);
    if (!(key.escape || (key.ctrl && input === "c"))) armed.current = null;
    setNudge(null);
    // The key list: `?` or Esc closes it; any other key closes it and does what it does (Codex's overlay).
    if (keysOpenRef.current) {
      // PgUp / PgDn scroll it when it doesn't fit (BUG-229).
      if (key.pageUp || key.pageDown) return scrollPage(key.pageDown);
      setKeysOpen(false);
      if (key.escape || (input === "?" && !key.ctrl && !key.meta)) return;
    } else if (input === "?" && !key.ctrl && !key.meta && d.text === "" && !options) {
      setKeysOffset(0);
      return setKeysOpen(true);
    }

    if (key.ctrl && input === "c") {
      if (!blank) return setDraft(ed.EMPTY);
      if (isBusy) return session.interrupt();
      if (confirmTwice("ctrl+c", "Press ctrl+c again to quit")) onQuit();
      return;
    }
    if (key.escape) {
      // A queued message is cancelled first; the next Esc interrupts.
      if (queuedRef.current) return setQueued(null);
      if (isBusy) return session.interrupt();
      if (!blank) {
        if (confirmTwice("esc", "Press esc again to clear the draft")) setDraft(ed.EMPTY);
        return;
      }
      if (options) setClosed(true);
      return;
    }
    if (key.ctrl && input === "o") {
      if (pending?.kind === "proposal") setShowSpec((v) => !v);
      return;
    }
    // Ctrl+T: the whole proposal's next mode (build, explore, plan).
    if (key.ctrl && input === "t") {
      // Skipping a mode the highlighted agent can't run (Kimi Code's explore: BUG-672).
      if (options && pending?.kind === "proposal") setMode(cycleMode(modeRef.current, triplesRef.current[shownOption(d.text, optSelRef.current, count)]?.harness));
      return;
    }
    // Ctrl+P: the highlighted agent's next permission level. Build's alone: explore and plan set their own.
    if (key.ctrl && input === "p") {
      const t = triplesRef.current[shownOption(d.text, optSelRef.current, count)];
      if (!(options && pending?.kind === "proposal" && t)) return;
      if (modeRef.current !== "build") return setNudge(`Permissions are for build mode: ${modeRef.current} sets its own (ctrl+t changes the mode)`);
      if (permissionLevels(t.harness).length < 2) return setNudge(`${HARNESS_INFO[t.harness].label} doesn't ask before every command or edit: nothing to change`);
      setTriples(triplesRef.current.map((x) => (x === t ? { ...x, permissions: cyclePermissions(x.permissions, x.harness) } : x)));
      return;
    }
    if (key.tab) {
      // Tab: the highlighted agent's next model; Shift+Tab: its next effort.
      const i = shownOption(d.text, optSelRef.current, count);
      const t = triplesRef.current[i];
      if (options && pending?.kind === "proposal" && t) {
        const next = key.shift ? cycleEffort(t, offeredAgents) : cycleModel(t, offeredAgents);
        setTriples(triplesRef.current.map((x, j) => (j === i ? next : x)));
      }
      // On a question's option: its text goes into the composer to add your own wording to it (enter sends the whole).
      const opt = options && pending?.kind === "question" && blank && !key.shift ? pending.question.options[i] : undefined;
      if (opt) setDraft(ed.insert(ed.EMPTY, `${opt.label} `));
      return;
    }
    // The spec while the agent choice is open, else the chat (Esc closes the choice; BUG-218).
    if (key.pageUp || key.pageDown) return scrollPage(key.pageDown);
    if (key.return) {
      if (key.meta || key.shift) return setDraft((x) => ed.insert(x, "\n"));
      if (isBusy) {
        // Queued, not sent: it goes when the turn ends (several Enters add to it).
        if (!blank) {
          setQueued(queuedRef.current ? `${queuedRef.current}\n${d.text.trim()}` : d.text.trim());
          setDraft(ed.EMPTY);
        }
        return;
      }
      const digit = options && /^[1-9]$/.test(d.text.trim()) && Number(d.text.trim()) <= count ? Number(d.text.trim()) - 1 : null;
      if (digit !== null) {
        setDraft(ed.EMPTY);
        setOptSel(digit);
        return choose(digit);
      }
      // Held because a question or proposal came at the turn's end: Enter sends it as the answer, with what was typed since.
      if (queuedRef.current) {
        const text = [queuedRef.current, d.text.trim()].filter(Boolean).join("\n");
        setQueued(null);
        return send(text);
      }
      if (!blank) return send(d.text);
      if (d.text) setDraft(ed.EMPTY);
      return options ? choose(optSelRef.current) : openSelected();
    }
    if ((key.upArrow || key.downArrow) && blank) {
      if (d.text) setDraft(ed.EMPTY);
      if (options) return setOptSel((optSelRef.current + (key.upArrow ? count - 1 : 1)) % count);
      return moveList(key.upArrow ? -1 : 1);
    }
    if (key.upArrow) return setDraft((x) => ed.moveLine(x, -1));
    if (key.downArrow) return setDraft((x) => ed.moveLine(x, 1));
    // → with an empty composer and no options open: the first tab (home is the strip's leftmost).
    if (key.rightArrow && d.text === "" && !options) {
      const first = tabs(store.sessions)[0];
      if (first) return show(first);
    }
    if (key.leftArrow) return setDraft((x) => ed.move(x, -1));
    if (key.rightArrow) return setDraft((x) => ed.move(x, 1));
    if (key.home || (key.ctrl && input === "a")) return setDraft(ed.home);
    if (key.end || (key.ctrl && input === "e")) return setDraft(ed.end);
    // With an empty composer and no options open, the selected row: Ctrl+D marks it done (or
    // not); Delete removes it, never without asking while its agent runs (BUG-164) or a chat is
    // being drafted (BUG-193).
    if (key.ctrl && input === "d" && d.text === "" && !options) {
      const s = selectedRow();
      if (!s) return;
      // The selection follows the row to its new group.
      setListSel(rowKey(s.id));
      store.toggleDone(s.id);
      return;
    }
    if (key.delete && d.text === "" && !options) {
      const s = selectedRow();
      if (s?.state === "drafting") onDiscard?.();
      else if (s && store.handle(s.id)?.alive) onEnd?.(s.id);
      else if (s) store.remove(s.id);
      return;
    }
    if (key.ctrl && input === "u") return setDraft(ed.killToStart);
    if (key.ctrl && input === "w") return setDraft(ed.deleteWordBack);
    if (key.ctrl && input === "d") return setDraft(ed.deleteForward);
    if (key.backspace) return setDraft(ed.backspace);
    if (key.delete) return setDraft(ed.deleteForward);
    if (key.ctrl && input === "j") return setDraft((x) => ed.insert(x, "\n"));
    if (key.ctrl || key.meta) return;
    // Control characters never go into the draft (a newline is its own key).
    const text = input === "\n" ? input : input.replace(/[\x00-\x1f\x7f]/g, "");
    if (text) setDraft((x) => ed.insert(x, text));
  };

  usePaste((text) => setDraft((d) => ed.insert(d, text)));

  // A late OSC 11 reply (the terminal's background colour) must not be typed or read as Esc.
  const onKey = useLateOscFilter((input, key) => {
    const plain = !key.ctrl && !key.meta && !key.return && !key.escape && !key.backspace && !key.delete && !key.tab;
    if (plain && input.length > 1 && /[\x00-\x1f\x7f]/.test(input)) {
      for (const [i, k] of splitKeys(input)) handleKey(i, k);
    } else handleKey(input, key);
  });
  useInput(onKey);

  // Heights: the frame is rows − 1; the list gets what the chat's minimum leaves. On a short
  // terminal the blank rows and the chat's minimum go first, then the list's rows (or the agents
  // available), then the hint line, then the header: the composer always stays (BUG-162, BUG-228).
  const frame = Math.max(1, rows - 1);
  // The side margins go on a tiny terminal: the rules and the composer must fit in what is left (BUG-181).
  const padX = columns >= 24 ? 2 : 0;
  const width = Math.max(1, columns - 2 * padX);
  const composerRows = Math.max(1, Math.min(6, Math.floor(frame / 4)));
  const bottom = composerHeight(draft, width, composerRows) + (nudge ? 1 : 0) + (queued ? 1 : 0);
  const compact = frame < SHORT_FRAME;
  // The open agent choice shows the spec in a box above the agents: the rows of its text here.
  const pending = state.pending;
  const specText = optionsOpen && showSpec && pending?.kind === "proposal" ? specRows(pending.spec, width, theme) : undefined;
  // An open question or choice keeps its lead line, spec, options and hint in view, counted in
  // rows as wrapped at this width (BUG-167).
  const block = optionsOpen ? openBlockRows(pending, triples, width, config, specText, mode) : MIN_CHAT;
  // Above the list: the header, the hint and the blank rows.
  const listAbove = TOP + 2 + 1;
  // A spec too long to sit beside even one row of the list: the list goes (its hint and the blank
  // rows too), as on a short terminal, and the spec is cut to what the chat has (BUG-197).
  const focus = !compact && specText !== undefined && frame - listAbove - 1 - block - bottom < 1;
  const tight = compact || focus;
  // Short of rows with a conversation going on, the chat wins over the list and then the header.
  const talking = focus || (compact && (state.items.length > 0 || state.live.length > 0 || !!pending || busy));
  const showHeader = talking ? frame - HEADER_ROWS - 1 - bottom >= SHORT_CHAT : frame >= HEADER_ROWS + 1 + bottom;
  // Short of rows with no conversation yet, the chat keeps the greeting whole: the list is cut
  // first (BUG-250); its blank row on top may go (the chat is cut from the top).
  const greetingRows = compact && !talking ? markdownRows(FIRST_LINE, theme, Math.max(1, width - CHAT_INDENT)) + 1 : 0;
  const minChat = focus ? 0 : compact ? greetingRows : block;
  const above = tight ? (showHeader ? HEADER_ROWS : 0) : listAbove;
  const listMax = frame - above - 1 - minChat - bottom;
  const baseRows = talking ? 0 : compact ? Math.max(0, listMax) : Math.max(1, listMax);
  // A list cut short of its column header and every label and row: the blank rows around it go
  // first (after the hint, before the rule), as a short frame's do (BUG-249, BUG-251).
  const listNeed = firstRun ? readiness.length + 1 : 1 + selectable(lines).length;
  const gapsGo = !tight && baseRows < listNeed;
  const listRows = gapsGo ? baseRows + 2 : baseRows;
  // A tight frame's chat with no row to show (a tiny terminal): no rule of its own over the composer's (BUG-256).
  const chatRule = !tight || frame - above - listRows - bottom >= 2;
  // The list's own rows: in a tight frame the hint line's row comes out of them (the hint goes
  // after the last list row, before the chat; BUG-228); otherwise it has its own (`listAbove`).
  const shownRows = tight ? Math.max(0, listRows - 1) : listRows;
  // The spec's rows: all of them; in a tight frame, what the chat (all but the header, the rule
  // and the composer) has left after the rest of the block, the top first, PgDn for the rest.
  const specShown = specText === undefined || !tight ? specText : Math.max(0, Math.min(specText, frame - bottom - 1 - (showHeader ? HEADER_ROWS : 0) - openBlockRows(pending, triples, width, config, 0, mode)));
  specCut.current = specText !== undefined && specShown !== undefined && specShown > 0 && specShown < specText ? { rows: specShown, total: specText } : null;
  const spec = specCut.current ? { rows: specShown, offset: Math.min(specOffset, specCut.current.total - specCut.current.rows) } : { rows: specShown };
  // The key list's rows, and its lines for PgUp / PgDn (BUG-229).
  const keysRows = frame - bottom - (showHeader ? HEADER_ROWS : 0) - (tight ? 0 : 2);
  keysCut.current = { lines: keysOpen ? keysPanel(width, keyGroups(homeKey, canOpen, !!mouse)).length : 0, rows: keysRows };
  // What a click reads: the list's lines as shown (none while the key list or the agents available are).
  // The window stays where it was while the selection is in it (BUG-271): the last one's top.
  const listTop = listTopRef.current;
  listShown.current = !keysOpen && listRows > 0 && shownRows > 0 && !firstRun ? sessionListLines(sessions, selected, collapsed, shownRows, listTop) : null;
  if (listShown.current) listTopRef.current = listShown.current.top;
  // A chat being drafted: the composer goes on with it (BUG-227).
  const placeholder = sessions.some((s) => s.state === "drafting") ? REPLY_PLACEHOLDER : runs.length ? "describe another session" : "describe the session you want";
  const sel = rowOf(selected);
  const label = selected?.startsWith("g:") ? (selected.slice(2) as SessionState) : undefined;
  // The hint names only the keys for what is selected (BUG-216), or the open question's or
  // choice's (BUG-217); with text typed, what Enter does with it.
  const typed = draft.text.trim();
  const picked = optionsOpen && /^[1-9]$/.test(typed) && Number(typed) <= optionCount(pending) ? Number(typed) : null;
  const rowHint: HintFor = label ? (collapsed.has(label) ? "collapsed" : "group") : sel ? (sel.state === "drafting" ? "draft" : sel.markedDone ? "done" : "run") : "empty";
  const highlighted = shownOption(draft.text, optSel, optionCount(pending));
  const talk = pending?.kind === "proposal" && highlighted >= pending.choices.length;
  const hintFor: HintFor = asking ? asking : typed ? (busy ? "working" : picked ? "pick" : "typing") : draft.text !== "" ? "typing" : optionsOpen ? (pending?.kind === "question" ? "question" : talk ? "talk" : "choice") : rowHint;
  const gap = tight ? null : <Box height={1} flexShrink={0} />;
  const listGap = gapsGo ? null : gap;
  // The hint under the open question or choice: what Enter does, as the hint line says it
  // (BUG-225); Tab / Shift+Tab only when the highlighted agent has a model / effort to switch to (BUG-221).
  const typedNow = typed ? (picked ?? "text") : null;
  const optionHints = pending?.kind === "question" ? questionHints(typedNow) : choiceHints(triples[highlighted], offeredAgents, typedNow);

  return (
    <Box flexDirection="column" width={columns} height={frame} paddingX={padX} backgroundColor={palette.ground} overflow="hidden">
      <Width columns={width}>
        {gap}
        {showHeader ? <Header info={header} counts={counts(sessions)} ran={store.ran} palette={palette} /> : null}
        {gap}
        {keysOpen ? (
          // The key list takes the list's and the chat's rows; the composer stays (BUG-216).
          <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
            <KeysPanel homeKey={homeKey} canOpen={canOpen} mouse={!!mouse} maxRows={keysRows} offset={keysOffset} palette={palette} />
          </Box>
        ) : (
          <>
            {listRows === 0 ? null : (
              <>
                {/* The one hint line: short of rows it stays, taking a row from the list (BUG-228). */}
                <Hint text={homeHint(hintFor, canOpen, picked ?? 1)} palette={palette} />
                {listGap}
                {shownRows === 0 ? null : firstRun ? <AgentsAvailable readiness={readiness} palette={palette} maxRows={shownRows} /> : <SessionList sessions={sessions} selected={selected} collapsed={collapsed} maxRows={shownRows} palette={palette} config={config} now={now()} dim={optionsOpen} boxRef={listBox} top={listTop} />}
              </>
            )}
            {listGap}
            {chatRule ? <Rule palette={palette} /> : null}
            {/* The chat takes the rows left (basis 0: it never squeezes the rest). Its content grows to
                fill it, so a short chat sits at the top; a long one is cut from the top (flex-end),
                and a scroll offset pushes it down. */}
            <Box ref={viewport} flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} justifyContent="flex-end" overflow="hidden">
              <Box flexDirection="column" flexGrow={1} flexShrink={0} marginBottom={-scroll}>
                <Box ref={content} flexDirection="column" flexShrink={0}>
                  <Transcript state={state} palette={palette} theme={theme} config={config} greeting={FIRST_LINE} choice={{ selected: highlighted, triples, mode, showSpec, spec, open: optionsOpen, hints: optionHints, rowsRef: optionBoxes }} />
                  <Box height={1} flexShrink={0} />
                </Box>
              </Box>
            </Box>
          </>
        )}
        {queued ? (
          <Text wrap="truncate-end">
            <Text color={palette.text}>{` › ${queued.replace(/\s+/g, " ")}`}</Text>
            <Text color={palette.dim}>{` · queued: ${!busy && pending ? `enter sends it as ${pending.kind === "question" ? "your answer" : "a change to the session"}` : "sent when the intake agent is done"} · esc cancels`}</Text>
          </Text>
        ) : null}
        {nudge ? (
          <Text color={palette.amber} wrap="truncate-end">
            {` ${nudge}`}
          </Text>
        ) : null}
        <GluonComposer draft={draft} placeholder={placeholder} maxRows={composerRows} palette={palette} cursor={!asking} />
      </Width>
    </Box>
  );
}
