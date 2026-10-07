/**
 * Gluon's home view as pure layout: the palette, the list's columns at every width, the header's
 * lines, the tool-activity summary. The Ink components only draw what these return.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { AGENT_STATES } from "../src/events.ts";
import { counts, GROUPS, groupOf, ordered, runState, SessionStore, tabs } from "../src/sessions.ts";
import {
  columnHeadSegs,
  countsSegs,
  fitSegs,
  groupKey,
  groupLabel,
  keyGroups,
  keysClose,
  keysPanel,
  headerTop,
  lineKey,
  listColumns,
  listLines,
  listView,
  type ListTop,
  listWindow,
  moreText,
  MIN_ACTIVITY,
  MIN_TRIPLE,
  readinessSegs,
  repoLabel,
  rowCells,
  rowKey,
  rowSegs,
  rowWidth,
  segsWidth,
  selectable,
  selectedKey,
  selectionAfter,
  summarizeExplored,
  sw,
  truncate,
  tripleSegs,
  whereSegs,
} from "../src/ui/layout.ts";
import { REPO_SLUG } from "../src/repo.ts";
import { MARK, MARK_WIDTH } from "../src/ui/mark.tsx";
import { bg, fg, GLUON_HEX, gluonPalette, makeTheme, nearest256, truecolorSupported } from "../src/ui/theme.ts";
import { mockupStore, NOW } from "./fixtures/gluon.ts";

const config = loadConfig();
const text = (segs: { text: string }[]) => segs.map((s) => s.text).join("");

describe("Gluon palette", () => {
  test("truecolor from COLORTERM, Windows Terminal, or a terminal that answered OSC 11; never Apple Terminal or the Linux console", () => {
    expect(truecolorSupported({ COLORTERM: "truecolor" })).toBe(true);
    expect(truecolorSupported({ COLORTERM: "24bit" })).toBe(true);
    expect(truecolorSupported({ WT_SESSION: "x" })).toBe(true);
    expect(truecolorSupported({})).toBe(false);
    expect(truecolorSupported({}, true)).toBe(true);
    expect(truecolorSupported({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false);
    expect(truecolorSupported({ TERM: "linux" }, true)).toBe(false);
  });

  test("without truecolor every role maps to the nearest xterm-256 colour", () => {
    expect(nearest256("#000000")).toBe(16);
    expect(nearest256("#ffffff")).toBe(231);
    expect(nearest256(GLUON_HEX.ground)).toBe(233); // near-black gray
    expect(nearest256(GLUON_HEX.amber)).toBe(179);
    expect(gluonPalette(true).amber).toBe("#e6b450");
    expect(gluonPalette(false).amber).toBe("ansi256(179)");
    expect(makeTheme(null, { COLORTERM: "truecolor" }).gluon.truecolor).toBe(true);
    expect(makeTheme(null, {}).gluon.ground).toMatch(/^ansi256\(\d+\)$/);
  });

  test("SGR helpers for the compositor's chrome", () => {
    expect(fg(GLUON_HEX.amber, true)).toBe("\x1b[38;2;230;180;80m");
    expect(bg(GLUON_HEX.bar, true)).toBe("\x1b[48;2;26;28;34m");
    expect(fg(GLUON_HEX.amber, false)).toBe("\x1b[38;5;179m");
    expect(bg(GLUON_HEX.ground, false)).toBe("\x1b[48;5;233m");
  });
});

test("the mark: three rows, a stem, a junction a third across, three branches ending in dots", () => {
  expect(MARK).toHaveLength(3);
  expect(MARK_WIDTH).toBe(6);
  expect(MARK.join("").match(/●/g)).toHaveLength(3);
  expect(MARK[1]!.startsWith("──")).toBe(true); // the stem
  expect(MARK[1]!.indexOf("⢎")).toBe(2); // the junction, 2 of 5 columns to the middle dot
  expect(MARK[1]!.endsWith("●")).toBe(true);
  // the diagonals leave the junction's right dot column (rows 0 and 3) and reach the dots
  expect(MARK[0]).toBe("   ⡠●");
  expect(MARK[2]).toBe("   ⠑●");
  // the middle dot sits one column further right than the top and bottom ones, as in the logo
  expect(MARK[1]!.indexOf("●") - MARK[0]!.indexOf("●")).toBe(1);
  expect(MARK[0]!.indexOf("●")).toBe(MARK[2]!.indexOf("●"));
});

describe("text fitting", () => {
  test("truncate cuts by display width, never inside a wide character", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("日本語テキスト", 6)).toBe("日本…");
    expect(Bun.stringWidth(truncate("日本語テキスト", 6))).toBeLessThanOrEqual(6);
    expect(truncate("abc", 0)).toBe("");
  });

  test("BUG-276/GLUON-60: a cut never leaves a dash, a separator or a blank before its `…`; the key list's closing line names the wheel with pgup pgdn when Gluon captures the mouse", () => {
    const q = "/new ends this session in Gluon — end it?";
    for (let w = 2; w < sw(q); w++) {
      const cut = truncate(q, w);
      expect(cut).toEndWith("…");
      expect(cut).not.toMatch(/[\s—,;:.·×]…$/);
      expect(sw(cut)).toBeLessThanOrEqual(w);
    }
    expect(truncate(q, 33)).toBe("/new ends this session in Gluon…");
    expect(truncate("claude code × sonnet 5.5 × medium", 15)).toBe("claude code…");
    expect(truncate("one, two, three", 6)).toBe("one…");
    expect(truncate("a-b", 2)).toBe("a…");
    expect(truncate("———", 2)).toBe("…");
    const footer = (mouse: boolean) => keysClose(80, 0, 5, mouse).map((s) => s.text).join("");
    expect(footer(true)).toBe(" ? / esc close · pgup pgdn / wheel ↓ 5 more");
    expect(footer(false)).toBe(" ? / esc close · pgup pgdn ↓ 5 more");
  });

  test("fitSegs keeps colours and ends in … when it cut", () => {
    const segs = tripleSegs({ harness: "claude-code", model: "sonnet", effort: "medium" }, config);
    expect(text(segs)).toBe("claude code × sonnet 5.5 × medium");
    expect(text(fitSegs(segs, 18))).toBe("claude code × son…");
    expect(fitSegs(segs, 18).map((s) => s.role)).toEqual(["bright", "dim"]);
    expect(text(fitSegs(segs, 11))).toBe("claude cod…");
    expect(text(tripleSegs(null))).toBe("agent not chosen yet");
  });

  test("launch modes: a mode ends the triple, build shows nothing, and a harness that does it another way says so", () => {
    const t = { harness: "claude-code" as const, model: "sonnet", effort: "medium" as const };
    expect(text(tripleSegs({ ...t, mode: "build" }, config))).toBe("claude code × sonnet 5.5 × medium");
    expect(text(tripleSegs({ ...t, mode: "explore" }, config))).toBe("claude code × sonnet 5.5 × medium · explore");
    expect(text(tripleSegs({ ...t, mode: "plan" }, config))).toBe("claude code × sonnet 5.5 × medium · plan");
    expect(text(tripleSegs({ harness: "antigravity", model: "flash", mode: "explore" }))).toBe("antigravity × flash · explore (plan mode)");
    expect(text(tripleSegs({ harness: "antigravity", model: "flash", mode: "plan" }))).toBe("antigravity × flash · plan");
  });
});

describe("header lines", () => {
  test("counts: awaiting in amber, zero groups left out, or `no sessions yet`", () => {
    const c = { awaiting: 1, working: 2, done: 1, drafting: 1 };
    expect(text(countsSegs(c))).toBe("1 awaiting input · 2 working · 1 done · 1 drafting");
    expect(countsSegs(c)[0]!.role).toBe("amber");
    expect(text(countsSegs({ awaiting: 0, working: 2, done: 0, drafting: 0 }))).toBe("2 working");
    expect(text(countsSegs({ awaiting: 0, working: 0, done: 0, drafting: 0 }))).toBe("no sessions yet");
  });

  test("BUG-222/counts: once a session ran and every one ended, `no sessions running`; `no sessions yet` only before the first", () => {
    const none = { awaiting: 0, working: 0, done: 0, drafting: 0 };
    expect(text(countsSegs(none, true))).toBe("no sessions running");
    expect(text(countsSegs({ ...none, drafting: 1 }, true))).toBe("1 drafting");
    const st = new SessionStore();
    expect(st.ran).toBe(false);
    const a = st.launched("a", { harness: "codex", model: "m" }, { alive: false, end: async () => {} }, 1);
    st.remove(a.id);
    expect(st.ran).toBe(true);
  });

  test("repo: owner/name from the remote, never its host or credentials; else the directory", () => {
    expect(repoLabel(`git@github.com:${REPO_SLUG}.git`, "/x/y")).toBe(REPO_SLUG);
    expect(repoLabel(`https://github.com/${REPO_SLUG}.git`, "/x/y")).toBe(REPO_SLUG);
    expect(repoLabel(`https://user:ghp_secret@github.com/${REPO_SLUG}`, "/x/y")).toBe(REPO_SLUG);
    expect(repoLabel("ssh://git@host:2222/team/proj.git/", "/x/y")).toBe("team/proj");
    expect(repoLabel(null, "/home/me/projects/tiny")).toBe("tiny");
    expect(repoLabel("/srv/git/solo", "C:\\work\\tiny")).toBe("git/solo");
    expect(repoLabel("", "C:\\work\\tiny")).toBe("tiny");
  });

  test("where: repo · branch · n modified; unknown parts left out", () => {
    expect(text(whereSegs("fidius/gluon", "issue-13-return", 2))).toBe("fidius/gluon · issue-13-return · 2 modified");
    expect(text(whereSegs("tiny", null, undefined))).toBe("tiny");
    expect(text(whereSegs("tiny", "main", 0))).toBe("tiny · main · clean");
    // Once the sessions are saved the header names the workspace (`gluon resume <id>`); before, nothing.
    expect(text(whereSegs("tiny", "main", 2, "abcdef"))).toBe("tiny · main · 2 modified · workspace abcdef");
    expect(text(whereSegs("tiny", null, undefined, "abcdef"))).toBe("tiny · workspace abcdef");
  });

  test("the first line is `Gluon v<version>`, cut to a narrow width", () => {
    expect(text(headerTop(100, "1.0.0"))).toBe("Gluon v1.0.0");
    expect(segsWidth(headerTop(8, "1.0.0"))).toBeLessThanOrEqual(8);
  });
});

describe("the session list's columns", () => {
  const store = mockupStore();
  const cells = store.sessions.map((s) => rowCells(s, NOW, config));
  const natural = (f: (r: (typeof cells)[number]) => number) => Math.max(...cells.map(f));

  for (const columns of [60, 80, 110, 160]) {
    test(`${columns} columns: no row is wider than the list`, () => {
      const width = columns - 4; // the view's side padding
      const cols = listColumns(width, cells);
      expect(rowWidth(cols)).toBeLessThanOrEqual(width);
      for (const r of cells) for (const selected of [false, true]) expect(segsWidth(rowSegs(cols, r, selected))).toBe(rowWidth(cols));
    });
  }

  test("wide: every cell whole, activity takes the rest so cost and elapsed sit at the right edge", () => {
    const cols = listColumns(156, cells);
    expect(cols.triple).toBe(natural((r) => segsWidth(r.triple)));
    expect(cols.activity).toBeGreaterThanOrEqual(natural((r) => r.activity.length));
    expect(rowWidth(cols)).toBe(156);
    const row = text(rowSegs(cols, cells[0]!, false));
    expect(row).toMatch(/^ \?  pty-return-flow +claude code × opus 5\.5 × high +Keep the session resumable\? +84% +\$4\.12 +25m {2}$/);
  });

  test("activity truncates first, then the triple shortens, then context and cost hide", () => {
    const tripleNatural = natural((r) => segsWidth(r.triple));
    // Activity is cut while the triple is whole.
    const mid = listColumns(95, cells);
    expect(mid.triple).toBe(tripleNatural);
    expect(mid.activity).toBeLessThan(natural((r) => r.activity.length));
    expect(text(rowSegs(mid, cells.find((r) => r.state === "done")!, false))).toContain("…");
    // Narrower: activity holds at its minimum and the triple gives way.
    const narrow = listColumns(80, cells);
    expect(narrow.activity).toBe(MIN_ACTIVITY);
    expect(narrow.triple).toBeLessThan(tripleNatural);
    expect(narrow.triple).toBeGreaterThanOrEqual(MIN_TRIPLE);
    expect(narrow.context && narrow.cost).toBeTruthy();
    // Very narrow: context, then cost, go.
    const tight = listColumns(56, cells);
    expect(tight.context).toBe(0);
    expect(tight.cost).toBe(0);
    expect(tight.elapsed).toBeGreaterThan(0);
    for (const w of [20, 30, 40]) expect(rowWidth(listColumns(w, cells))).toBeLessThanOrEqual(w);
  });

  test("BUG-183/columns: no activity in any row takes no room — the triple stays whole at 84 columns, cost and elapsed at the right edge", () => {
    const quiet = cells.map((r) => ({ ...r, activity: "" }));
    const cols = listColumns(84, quiet);
    expect(cols.activity).toBe(0);
    expect(cols.triple).toBeGreaterThanOrEqual(natural((r) => segsWidth(r.triple)));
    expect(rowWidth(cols)).toBe(84);
    expect(text(rowSegs(cols, quiet[0]!, false))).toMatch(/claude code × opus 5\.5 × high +84% +\$4\.12 +25m {2}$/);
    // A short activity reserves only what it needs (at 90 columns: the column header widens context and time, BUG-194).
    const short = cells.map((r, i) => ({ ...r, activity: i === 0 ? "ok" : "" }));
    expect(listColumns(86, short).triple).toBe(natural((r) => segsWidth(r.triple)));
  });

  test("context is amber from 80%; unknown context and cost are —; the drafting row's activity is amber", () => {
    const cols = listColumns(156, cells);
    const ctx = (r: (typeof cells)[number]) => rowSegs(cols, r, false).find((s) => /%|—/.test(s.text) && s.text.trim().length <= 4)!;
    expect(ctx(cells.find((r) => r.name === "pty-return-flow")!).role).toBe("amber");
    expect(ctx(cells.find((r) => r.name === "flaky-launcher-test")!).role).toBe("dim");
    const draft = rowSegs(cols, cells.find((r) => r.state === "drafting")!, false);
    expect(text(draft)).toMatch(/◌  \(untitled\) +agent not chosen yet +Talking it through +— +— +now {2}$/);
    expect(draft.find((s) => s.text.startsWith("Talking"))!.role).toBe("amber");
    expect(text(rowSegs(cols, cells.find((r) => r.state === "done")!, false))).toContain("~$0.21");
  });

  test("groups in order with labels; empty groups hidden; a window keeps the selected row in view", () => {
    const lines = listLines(store.sessions);
    const labels = lines.filter((l) => l.kind === "label").map((l) => (l as { state: string }).state);
    expect(labels).toEqual(["awaiting", "working", "done", "drafting"]);
    expect(lines).toHaveLength(4 + 5 + 3);
    expect(listLines(new SessionStore().sessions)).toEqual([]);
    expect(listWindow(lines, null, 20)).toHaveLength(12);
    expect(listWindow(lines, null, 9).some((l) => l.kind === "blank")).toBe(false);
    const last = ordered(store.sessions).at(-1)!.id;
    const w = listWindow(lines, rowKey(last), 4);
    expect(w).toHaveLength(4);
    expect(w.some((l) => l.kind === "row" && l.session.id === last)).toBe(true);
    expect(w.at(-1)!.kind).not.toBe("label");
  });

  test("BUG-194/columns: the column header names context, cost and time over their cells; each column is as wide as its word; a hidden column hides its word", () => {
    const end = (s: string, word: string) => s.indexOf(word) + word.length;
    for (const w of [156, 80, 56]) {
      const cols = listColumns(w, cells);
      const head = text(columnHeadSegs(cols));
      const row = text(rowSegs(cols, cells[0]!, false));
      expect(Bun.stringWidth(head)).toBe(rowWidth(cols));
      expect(head).toMatch(/^ +(context  +)?(cost  +)?time {2}$/);
      if (cols.context) expect(end(head, "context")).toBe(end(row, "84%"));
      else expect(head).not.toContain("context");
      if (cols.cost) expect(end(head, "cost")).toBe(end(row, "$4.12"));
      else expect(head).not.toContain("cost");
      expect(end(head, "time")).toBe(end(row, "25m"));
    }
    expect(listColumns(156, cells)).toMatchObject({ context: 7, cost: 6, elapsed: 4 });
    expect(listColumns(56, cells)).toMatchObject({ context: 0, cost: 0 });
  });

  test("BUG-222/columns: the narrower activity column lets the context column fit at 80 columns (76 for the list) beside the name, a triple and activity", () => {
    // The home view at 80×24 gives the list 76 columns: name, triple, activity, context, cost and time all shown.
    const cols = listColumns(76, cells);
    expect(cols.context).toBeGreaterThan(0);
    expect(cols.cost).toBeGreaterThan(0);
    expect(cols.activity).toBeGreaterThanOrEqual(MIN_ACTIVITY);
    expect(cols.triple).toBeGreaterThanOrEqual(MIN_TRIPLE);
    expect(cols.name).toBe(19);
    expect(rowWidth(cols)).toBeLessThanOrEqual(76);
    expect(text(rowSegs(cols, cells[0]!, false))).toMatch(/pty-return-flow +claude code.+ +Keep the.+ +84% +\$4\.12 +25m {2}$/);
  });

  test("BUG-223/columns: at 60–70 columns the name wins over the triple and empty columns; activities coming and going never flip the columns", () => {
    const runs = (activity: string) =>
      ["Gluon-alpha-task", "Gluon-bravo-task"].map((name) => ({ state: "awaiting" as const, name, triple: tripleSegs({ harness: "claude-code", model: "sonnet 5.5", effort: "medium" }), activity, context: "—", cost: "—", elapsed: "now" }));
    for (const w of [56, 60, 66, 70]) {
      const quiet = listColumns(w, runs(""));
      const busy = listColumns(w, runs("Working"));
      for (const cols of [quiet, busy]) {
        expect(cols.name).toBe("Gluon-alpha-task".length);
        expect(rowWidth(cols)).toBeLessThanOrEqual(w);
      }
      // The same columns either way: only the triple and activity share their room differently.
      expect({ ...quiet, triple: 0, activity: 0 }).toEqual({ ...busy, triple: 0, activity: 0 });
      expect(busy.activity).toBeGreaterThanOrEqual("Working".length);
      expect(text(rowSegs(quiet, runs("")[0]!, false))).toContain("Gluon-alpha-task  claude code");
    }
  });

  test("BUG-265/GLUON-47: an activity too long for its column takes the free columns beside it — empty context and cost cells, then the triple's blank end — before it is cut", () => {
    const sonnet = tripleSegs({ harness: "claude-code", model: "sonnet 5.5", effort: "medium" });
    const draft = (name: string, activity: string) => ({ state: "drafting" as const, name, triple: [{ text: "agent not chosen yet", role: "dim" as const }], activity, context: "—", cost: "—", elapsed: "now" });
    const run = (name: string, activity: string) => ({ state: "awaiting" as const, name, triple: sonnet, activity, context: "—", cost: "—", elapsed: "31m" });
    // 80×24 (76 for the list): a done row beside the drafting row; its activity was `Waiting for…`, `Talking it…`.
    for (const activity of ["Waiting for your answer", "Talking it through", "Waiting for your pick"]) {
      const rows = [{ ...run("Gluon-fix-add-bug", ""), state: "done" as const }, draft("(untitled)", activity)];
      const cols = listColumns(76, rows);
      const shown = text(rowSegs(cols, rows[1]!, false));
      expect(shown).toContain(` ${activity} `);
      expect(shown).toMatch(/ now {2}$/);
      expect(segsWidth(rowSegs(cols, rows[1]!, false))).toBe(rowWidth(cols));
      // The activity still starts in its column: only free columns to its right were taken.
      const head = text(rowSegs(cols, { ...rows[1]!, activity: "x" }, false));
      expect(shown.indexOf(activity)).toBe(head.indexOf(" x ") + 1);
    }
    // 100 columns: long triples elsewhere leave the drafting row's triple column half blank.
    const rows = [run("Gluon-echo-task-number-4", "Waiting for your input"), run("Gluon-foxtrot-task", "Waiting"), draft("Gluon-x", "Talking it through")];
    const cols = listColumns(96, rows);
    for (const r of rows) {
      const segs = rowSegs(cols, r, false);
      expect(segsWidth(segs)).toBe(rowWidth(cols));
      expect(text(segs)).toContain(r.activity);
    }
    // A figure keeps its cell: the activity is cut beside it, as before.
    const busy = { ...run("Gluon-golf", "Running the whole test suite again"), context: "42%", cost: "$1.20" };
    const shown = text(rowSegs(listColumns(76, [busy]), busy, false));
    expect(shown).toMatch(/… +42% +\$1\.20 +31m {2}$/);
  });

  test("BUG-231/window: rows that don't fit leave a `… N more` line; scrolled, the first row's group label stays on top", () => {
    const st = new SessionStore();
    const handle = { alive: true, end: async () => {} };
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    for (const n of names) st.update(st.launched(n, { harness: "codex", model: "m" }, handle, 1).id, { state: "awaiting" });
    const golf = st.launched("golf", { harness: "codex", model: "m" }, handle, 1);
    const lines = listLines(st.sessions);
    const shown = (sel: string | null, max: number) =>
      listWindow(lines, sel, max).map((l) => (l.kind === "more" ? moreText(l) : l.kind === "label" ? `[${l.state}]` : l.kind === "row" ? l.session.name : ""));
    const id = (n: string) => rowKey(st.sessions.find((s) => s.name === n)!.id);
    expect(shown(id("alpha"), 6)).toEqual(["[awaiting]", "alpha", "bravo", "charlie", "delta", "… 3 more"]);
    expect(shown(rowKey(golf.id), 6)).toEqual(["[awaiting]", "echo", "foxtrot", "[working]", "golf", "… 4 more above"]);
    expect(shown(id("delta"), 6)).toEqual(["[awaiting]", "delta", "echo", "foxtrot", "… 4 more (3 above · 1 below)"]);
    // Everything fits: no such line.
    expect(shown(id("alpha"), 9)).not.toContain(expect.stringMatching(/more/));
    for (const max of [1, 2, 3, 4, 5, 6, 7, 8]) for (const sel of [...names.map(id), rowKey(golf.id)]) expect(listWindow(lines, sel, max).length).toBeLessThanOrEqual(max);
  });

  test("BUG-271/GLUON-55: a window stays where it was while its selection is in it — selecting a line it shows (a click) never scrolls it; a selection that leaves it scrolls it just enough", () => {
    const st = new SessionStore();
    const handle = { alive: true, end: async () => {} };
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    for (const n of names) st.update(st.launched(n, { harness: "codex", model: "m" }, handle, 1).id, { state: "awaiting" });
    st.launched("golf", { harness: "codex", model: "m" }, handle, 1);
    st.launched("hotel", { harness: "codex", model: "m" }, handle, 1);
    st.update(st.launched("india", { harness: "codex", model: "m" }, handle, 1).id, { state: "done" });
    st.ensureDraft(1);
    const lines = listLines(st.sessions);
    const keys = selectable(lines).map(lineKey);
    const id = (n: string) => rowKey(st.sessions.find((s) => s.name === n)!.id);
    const text = (ls: ReturnType<typeof listView>["lines"]) => ls.map((l) => (l.kind === "more" ? moreText(l) : l.kind === "label" ? `[${l.state}]` : l.kind === "row" ? l.session.name : ""));
    // ↓ from delta to echo: one line on, not echo on top.
    const first = listView(lines, id("alpha"), 6);
    expect(text(first.lines)).toEqual(["[awaiting]", "alpha", "bravo", "charlie", "delta", "… 6 more"]);
    expect(text(listView(lines, id("delta"), 6, first.top).lines)).toEqual(text(first.lines));
    const down = listView(lines, id("echo"), 6, first.top);
    expect(text(down.lines)).toEqual(["[awaiting]", "bravo", "charlie", "delta", "echo", "… 6 more (1 above · 5 below)"]);
    // Back up past its top: the selected line comes first again.
    expect(text(listView(lines, id("alpha"), 6, down.top).lines)).toEqual(text(first.lines));
    // Any window, any line in it selected (a click; but a group label kept on top, which may scroll
    // up to its group): every line above the last keeps its row.
    for (const max of [2, 3, 4, 5, 6, 7, 8]) {
      // Every window the selection can leave behind: from none, then from each of those.
      const tops = new Map<string, ListTop | null>([["null", null]]);
      for (let round = 0; round < 2; round++) for (const top of [...tops.values()]) for (const sel of keys) tops.set(JSON.stringify(listView(lines, sel, max, top).top), listView(lines, sel, max, top).top);
      for (const top of tops.values()) {
        for (const sel of keys) {
          const w = listView(lines, sel, max, top);
          expect(w.lines.length).toBeLessThanOrEqual(max);
          expect(w.lines.some((l) => lineKey(l) === sel)).toBe(true);
          // The next render (the same selection, this window): the same lines.
          expect(listView(lines, sel, max, w.top)).toEqual(w);
          for (const [i, l] of w.lines.entries()) {
            if (l.kind !== "row" && l.kind !== "label") continue;
            if (i === 0 && w.top?.pinned) continue;
            const after = listView(lines, lineKey(l), max, w.top).lines;
            const kept = (ls: typeof after) => ls.slice(0, w.lines.length - 2).map((x) => lineKey(x));
            expect({ max, top, sel, click: lineKey(l), rows: kept(after) }).toEqual({ max, top, sel, click: lineKey(l), rows: kept(w.lines) });
          }
        }
      }
    }
  });

  test("BUG-194/groups: labels are selectable lines; a collapsed group shows `▸ Label (n)` and no rows; a row hidden in it selects its label", () => {
    const id = (name: string) => store.sessions.find((s) => s.name === name)!.id;
    const lines = listLines(store.sessions, new Set(["working"]));
    const label = (state: string) => lines.find((l) => l.kind === "label" && l.state === state) as Parameters<typeof groupLabel>[0];
    expect(groupLabel(label("working"))).toBe("▸ Working (2)");
    expect(groupLabel(label("awaiting"))).toBe("▾ Awaiting input");
    expect(selectable(lines).map(lineKey)).toEqual(["g:awaiting", rowKey(id("pty-return-flow")), "g:working", "g:done", rowKey(id("spawn-tty-explainer")), "g:drafting", rowKey(store.draft()!.id)]);
    expect(selectedKey(lines, rowKey(id("flaky-launcher-test")), store.sessions)).toBe(groupKey("working"));
    expect(selectedKey(lines, groupKey("done"), store.sessions)).toBe(groupKey("done"));
    // Gone, or nothing chosen yet: the first row; every group collapsed: the first label.
    expect(selectedKey(lines, rowKey(999), store.sessions)).toBe(rowKey(id("pty-return-flow")));
    expect(selectedKey(lines, null, store.sessions)).toBe(rowKey(id("pty-return-flow")));
    expect(selectedKey(listLines(store.sessions, new Set(GROUPS)), null, store.sessions)).toBe(groupKey("awaiting"));
    // A short window keeps a selected label in view.
    expect(listWindow(listLines(store.sessions), groupKey("drafting"), 3).map(lineKey)).toContain(groupKey("drafting"));
  });

  test("BUG-157/tabs: tabs keep launch order whatever a session's state; the list stays grouped", () => {
    const st = new SessionStore();
    const handle = { alive: true, end: async () => {} };
    const a = st.launched("a", { harness: "codex", model: "m" }, handle, 1);
    const b = st.launched("b", { harness: "codex", model: "m" }, handle, 2);
    const c = st.launched("c", { harness: "codex", model: "m" }, handle, 3);
    st.ensureDraft(4);
    st.update(c.id, { state: "awaiting" });
    st.toggleDone(a.id);
    expect(tabs(st.sessions).map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(ordered(st.sessions).map((s) => s.name)).toEqual(["c", "b", "a", "(untitled)"]);
  });
});

test("BUG-192/store: an ended session closes — remove takes any row (a live run's, the draft's) with its handle", () => {
  const st = new SessionStore();
  const handle = { alive: true, end: async () => {} };
  const a = st.launched("a", { harness: "codex", model: "m" }, handle, 1);
  const b = st.launched("b", { harness: "codex", model: "m" }, handle, 2);
  const d = st.ensureDraft(3);
  st.remove(a.id);
  expect(st.get(a.id)).toBeUndefined();
  expect(st.handle(a.id)).toBeUndefined();
  st.remove(d.id);
  expect(st.sessions.map((s) => s.name)).toEqual(["b"]);
  expect(st.live().map((s) => s.id)).toEqual([b.id]);
});

test("tool activity is one line: searches, then reads, counted", () => {
  expect(
    summarizeExplored([
      { kind: "search", text: "session", where: "src/cli" },
      { kind: "read", text: "a.ts" },
      { kind: "read", text: "b.ts" },
      { kind: "read", text: "c.ts" },
    ]),
  ).toBe('Searched src/cli for "session" · read 3 files');
  expect(summarizeExplored([{ kind: "read", text: "README.md" }])).toBe("Read README.md");
  expect(summarizeExplored([{ kind: "list", text: "src" }, { kind: "git", text: "log", error: "no git" }])).toBe("Listed src · ran git log · 1 failed");
});

test("BUG-185/live: listing the repository root is named, not an empty folder", () => {
  for (const root of [".", "", "/", "./"]) {
    expect(summarizeExplored([{ kind: "list", text: root }, { kind: "search", text: "TODO" }])).toBe('Listed the repository · searched for "TODO"');
  }
  expect(summarizeExplored([{ kind: "list", text: ".." }])).toBe("Listed ..");
  expect(summarizeExplored([{ kind: "list", text: "." }, { kind: "list", text: "src" }])).toBe("Listed 2 folders");
});

test("readiness rows: green dot when ready, hollow when sign-in is needed", () => {
  expect(text(readinessSegs({ harness: "claude-code", state: "ready", note: "claude plan" }, 13))).toBe(" ●  claude code  ready · claude plan");
  const signin = readinessSegs({ harness: "antigravity", state: "signin" }, 13);
  expect(text(signin)).toBe(" ○  antigravity  sign-in needed");
  expect(signin[1]!.role).toBe("dim");
  expect(text(readinessSegs({ harness: "codex", state: "missing" }, 13))).toContain("not installed");
});

test("BUG-220/selection: a row that goes hands the selection to the next row (labels skipped), or the previous one when it was the last", () => {
  const before = ["g:awaiting", "s:1", "g:working", "s:2", "s:3", "g:drafting", "s:4"];
  expect(selectionAfter(before, before, "s:2")).toBe("s:2");
  expect(selectionAfter(before, ["g:awaiting", "s:1", "g:working", "s:3", "g:drafting", "s:4"], "s:2")).toBe("s:3");
  // The last of its group: the next group's first row (its label and the group itself may go too).
  expect(selectionAfter(before, ["g:working", "s:2", "s:3", "g:drafting", "s:4"], "s:1")).toBe("s:2");
  expect(selectionAfter(before, ["g:awaiting", "s:1", "g:working", "s:2", "s:3"], "s:4")).toBe("s:3");
  // Two gone at once: the first still listed.
  expect(selectionAfter(before, ["g:awaiting", "s:1", "g:drafting", "s:4"], "s:2")).toBe("s:4");
  // Nothing left, or nothing known: `selectedKey` decides.
  expect(selectionAfter(before, [], "s:2")).toBeNull();
  expect(selectionAfter([], ["s:9"], "s:2")).toBeNull();
  expect(selectionAfter(before, before, null)).toBeNull();
  // A label that goes isn't a row: the next row after it.
  expect(selectionAfter(before, ["g:awaiting", "s:1", "s:4"], "g:working")).toBe("s:4");
});

test("BUG-219/store: two sessions with the same name — the newer is numbered (the draft too), unique among the sessions listed", () => {
  const st = new SessionStore();
  const handle = { alive: true, end: async () => {} };
  const a = st.launched("Gluon-fix-add-bug", { harness: "codex", model: "m" }, handle, 1);
  // The drafting row takes the proposal's name, numbered; launched, it keeps it.
  const d = st.ensureDraft(2);
  st.rename(d.id, "Gluon-fix-add-bug");
  expect(st.get(d.id)!.name).toBe("Gluon-fix-add-bug-2");
  const b = st.launched("Gluon-fix-add-bug", { harness: "codex", model: "m" }, handle, 3);
  expect(b.id).toBe(d.id);
  expect(b.name).toBe("Gluon-fix-add-bug-2");
  // No draft: a new run.
  const c = st.launched("Gluon-fix-add-bug", { harness: "codex", model: "m" }, handle, 4);
  expect(c.name).toBe("Gluon-fix-add-bug-3");
  // A renamed row keeps a name it already has.
  st.rename(c.id, "Gluon-fix-add-bug-3");
  expect(st.get(c.id)!.name).toBe("Gluon-fix-add-bug-3");
  // Once the first ended, its name is free again.
  st.remove(a.id);
  expect(st.launched("Gluon-fix-add-bug", { harness: "codex", model: "m" }, handle, 5).name).toBe("Gluon-fix-add-bug");
});

test("BUG-193/store: Done is the user's word — Ctrl+D's toggle moves a run to Done and back, whatever its state; never the draft", () => {
  const st = new SessionStore();
  const handle = { alive: true, end: async () => {} };
  const a = st.launched("a", { harness: "codex", model: "m" }, handle, 1);
  const b = st.launched("b", { harness: "codex", model: "m" }, handle, 2);
  const d = st.ensureDraft(3);
  st.update(a.id, { state: "awaiting" });
  st.toggleDone(b.id);
  expect(groupOf(st.get(b.id)!)).toBe("done");
  expect(ordered(st.sessions).map((s) => s.name)).toEqual(["a", "b", "(untitled)"]);
  expect(counts(st.sessions)).toEqual({ awaiting: 1, working: 0, done: 1, drafting: 1 });
  expect(rowCells(st.get(b.id)!, 2, config).state).toBe("done");
  // Its state goes on changing underneath; the group stays Done until the user says otherwise.
  st.update(b.id, { state: "awaiting" });
  expect(groupOf(st.get(b.id)!)).toBe("done");
  st.toggleDone(b.id);
  expect(groupOf(st.get(b.id)!)).toBe("awaiting");
  st.toggleDone(d.id);
  expect(groupOf(st.get(d.id)!)).toBe("drafting");
});

test("BUG-193/status: what an agent reports reads working or awaiting input, never Done; Gluon's own question is awaiting whatever it reports", () => {
  // The agent's `done` is its turn ending (Stop, an idle prompt, OpenCode's idle), not the Done group.
  expect(runState("working")).toBe("working");
  expect(runState("awaiting")).toBe("awaiting");
  expect(runState("done")).toBe("awaiting");
  for (const reported of AGENT_STATES) {
    expect(runState(reported, "/clear ends this session in Gluon — end it?")).toBe("awaiting");
    expect(runState(reported, null)).toBe(runState(reported));
    expect(runState(reported, "")).toBe(runState(reported));
  }
  // Through the store: whatever it reports, a run lands in the Awaiting or Working group; only Ctrl+D makes it Done.
  const st = new SessionStore();
  const run = st.launched("a", { harness: "codex", model: "m" }, { alive: true, end: async () => {} }, 1);
  for (const reported of AGENT_STATES) {
    st.update(run.id, { state: runState(reported) });
    expect(groupOf(st.get(run.id)!)).toBe(reported === "working" ? "working" : "awaiting");
  }
  st.toggleDone(run.id);
  expect(groupOf(st.get(run.id)!)).toBe("done");
});

test("BUG-251/row: a row with no activity lends its activity column to its triple — no cut triple beside blank columns", () => {
  const st = new SessionStore();
  const a = st.launched("Gluon-group-1", { harness: "claude-code", model: "sonnet", effort: "medium" }, { alive: true, end: async () => {} }, NOW);
  const b = st.launched("Gluon-group-2", { harness: "opencode", model: "muse-spark-1.3" }, { alive: true, end: async () => {} }, NOW);
  st.update(a.id, { state: "awaiting", activity: "" });
  st.update(b.id, { state: "working", activity: "Working" });
  const cells = st.sessions.map((s) => rowCells(s, NOW, config));
  const cols = listColumns(80, cells);
  const idle = text(rowSegs(cols, cells.find((r) => r.name === a.name)!, false));
  const busy = text(rowSegs(cols, cells.find((r) => r.name === b.name)!, false));
  expect(idle).toContain("claude code × sonnet 5.5 × medium");
  expect(busy).toMatch(/opencode × muse spark 1\.3 +Working/);
  for (const r of cells) expect(segsWidth(rowSegs(cols, r, false))).toBe(rowWidth(cols));
  // The columns after the triple stay where they are.
  expect(idle.lastIndexOf("—")).toBe(busy.lastIndexOf("—"));
});

describe("BUG-253/keys: the key list", () => {
  /** The column where what a key does starts, per row of a group's keys. */
  const starts = (width: number) =>
    keysPanel(width, keyGroups("ctrl+\\"))
      .map((l) => text(l))
      .filter((l) => /^ \S.* {2}\S/.test(l))
      .map((l) => l.slice(1).search(/ {2}\S/) + 1 + l.slice(1).slice(l.slice(1).search(/ {2}\S/)).search(/\S/));
  test("groups stacked in one column share its key column: what the keys do starts in one column", () => {
    expect(new Set(starts(46)).size).toBe(1);
  });
  test("at 76 columns two columns still fit, each aligned within itself", () => {
    const lines = keysPanel(76, keyGroups("ctrl+\\")).map((l) => text(l));
    expect(lines.some((l) => /Sessions +Intake chat/.test(l))).toBe(true);
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(76);
    const left = lines.filter((l) => /^ (↑↓|enter|→|ctrl\+d|del|ctrl\+c twice|ctrl\+\\|alt\+pgup\/pgdn|←\/→|click|shift\+pgup) /.test(l)).map((l) => l.slice(1).search(/(?<= {2})\S/) + 1);
    expect(new Set(left).size).toBe(1);
  });
});

describe("BUG-252/BUG-255: the palette's steps", () => {
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  test("BUG-252/selection: what Enter acts on stands out from the user's messages (`bar`); dim text on it stays readable", () => {
    expect(ratio(GLUON_HEX.selected, GLUON_HEX.bar)).toBeGreaterThanOrEqual(1.45);
    expect(ratio(GLUON_HEX.dim, GLUON_HEX.selected)).toBeGreaterThanOrEqual(3);
    expect(nearest256(GLUON_HEX.selected)).not.toBe(nearest256(GLUON_HEX.bar));
  });
  test("BUG-255/frame: box borders are ≥ 3:1 against the ground", () => {
    expect(ratio(GLUON_HEX.frame, GLUON_HEX.ground)).toBeGreaterThanOrEqual(3);
  });
});
