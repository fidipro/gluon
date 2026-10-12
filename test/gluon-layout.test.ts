/**
 * Gluon's home view as pure layout: the palette, the list's columns at every width, the header's
 * lines, the tool-activity summary. The Ink components only draw what these return.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { ordered, SessionStore, tabs } from "../src/sessions.ts";
import {
  columnHeadSegs,
  fitSegs,
  keyGroups,
  keysClose,
  keysPanel,
  lineKey,
  listColumns,
  listLines,
  listView,
  type ListTop,
  listWindow,
  moreText,
  MIN_ACTIVITY,
  MIN_TRIPLE,
  rowCells,
  rowKey,
  rowSegs,
  rowWidth,
  segsWidth,
  selectable,
  summarizeExplored,
  sw,
  truncate,
  tripleSegs,
} from "../src/ui/layout.ts";
import { GLUON_HEX, gluonPalette, makeTheme, nearest256, truecolorSupported } from "../src/ui/theme.ts";
import { mockupStore, NOW } from "./fixtures/gluon.ts";

const config = loadConfig();
const text = (segs: { text: string }[]) => segs.map((s) => s.text).join("");

describe("Gluon palette", () => {
  test("home/theme: truecolor from COLORTERM, Windows Terminal, or a terminal that answered OSC 11; never Apple Terminal or the Linux console", () => {
    expect(truecolorSupported({ COLORTERM: "truecolor" })).toBe(true);
    expect(truecolorSupported({ COLORTERM: "24bit" })).toBe(true);
    expect(truecolorSupported({ WT_SESSION: "x" })).toBe(true);
    expect(truecolorSupported({})).toBe(false);
    expect(truecolorSupported({}, true)).toBe(true);
    expect(truecolorSupported({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false);
    expect(truecolorSupported({ TERM: "linux" }, true)).toBe(false);
  });

  test("home/theme: without truecolor every role maps to the nearest xterm-256 colour", () => {
    expect(nearest256("#000000")).toBe(16);
    expect(nearest256("#ffffff")).toBe(231);
    expect(nearest256(GLUON_HEX.ground)).toBe(233); // near-black gray
    expect(nearest256(GLUON_HEX.amber)).toBe(179);
    expect(gluonPalette(true).amber).toBe("#e6b450");
    expect(gluonPalette(false).amber).toBe("ansi256(179)");
    expect(makeTheme(null, { COLORTERM: "truecolor" }).gluon.truecolor).toBe(true);
    expect(makeTheme(null, {}).gluon.ground).toMatch(/^ansi256\(\d+\)$/);
  });

});

describe("text fitting", () => {
  test("home/cut-marked: truncate cuts by display width, never inside a wide character", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("日本語テキスト", 6)).toBe("日本…");
    expect(Bun.stringWidth(truncate("日本語テキスト", 6))).toBeLessThanOrEqual(6);
    expect(truncate("abc", 0)).toBe("");
  });

  test("home/cut-marked: a cut never leaves a dash, a separator or a blank before its `…`; the key list's closing line names the wheel with pgup pgdn when Gluon captures the mouse #BUG-276/GLUON-60", () => {
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

  test("home/cut-marked: fitSegs keeps colours and ends in … when it cut", () => {
    const segs = tripleSegs({ harness: "claude-code", model: "sonnet", effort: "medium" }, config);
    expect(text(segs)).toBe("claude code × sonnet 5.5 × medium");
    expect(text(fitSegs(segs, 18))).toBe("claude code × son…");
    expect(fitSegs(segs, 18).map((s) => s.role)).toEqual(["bright", "dim"]);
    expect(text(fitSegs(segs, 11))).toBe("claude cod…");
    expect(text(tripleSegs(null))).toBe("agent not chosen yet");
  });

  test("sessions-list/row-columns: launch modes: a mode ends the triple, build shows nothing, and a harness that does it another way says so", () => {
    const t = { harness: "claude-code" as const, model: "sonnet", effort: "medium" as const };
    expect(text(tripleSegs({ ...t, mode: "build" }, config))).toBe("claude code × sonnet 5.5 × medium");
    expect(text(tripleSegs({ ...t, mode: "explore" }, config))).toBe("claude code × sonnet 5.5 × medium · explore");
    expect(text(tripleSegs({ ...t, mode: "plan" }, config))).toBe("claude code × sonnet 5.5 × medium · plan");
    expect(text(tripleSegs({ harness: "antigravity", model: "flash", mode: "explore" }))).toBe("antigravity × flash · explore (plan mode)");
    expect(text(tripleSegs({ harness: "antigravity", model: "flash", mode: "plan" }))).toBe("antigravity × flash · plan");
  });
});

describe("header lines", () => {
});

describe("the session list's columns", () => {
  const store = mockupStore();
  const cells = store.sessions.map((s) => rowCells(s, NOW, config));
  const natural = (f: (r: (typeof cells)[number]) => number) => Math.max(...cells.map(f));

  for (const columns of [60, 80, 110, 160]) {
    test(`sessions-list/groups: ${columns} columns: no row is wider than the list`, () => {
      const width = columns - 4; // the view's side padding
      const cols = listColumns(width, cells);
      expect(rowWidth(cols)).toBeLessThanOrEqual(width);
      for (const r of cells) for (const selected of [false, true]) expect(segsWidth(rowSegs(cols, r, selected))).toBe(rowWidth(cols));
    });
  }

  test("sessions-list/row-columns: wide: every cell whole, activity takes the rest so cost and elapsed sit at the right edge", () => {
    const cols = listColumns(156, cells);
    expect(cols.triple).toBe(natural((r) => segsWidth(r.triple)));
    expect(cols.activity).toBeGreaterThanOrEqual(natural((r) => r.activity.length));
    expect(rowWidth(cols)).toBe(156);
    const row = text(rowSegs(cols, cells[0]!, false));
    expect(row).toMatch(/^ \?  pty-return-flow +claude code × opus 5\.5 × high +Keep the session resumable\? +84% +\$4\.12 +25m {2}$/);
  });

  test("sessions-list/row-columns: activity truncates first, then the triple shortens, then context and cost hide", () => {
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

  test("sessions-list/row-columns: no activity in any row takes no room — the triple stays whole at 84 columns, cost and elapsed at the right edge", () => {
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

  test("sessions-list/groups: the column header names context, cost and time over their cells; each column is as wide as its word; a hidden column hides its word #BUG-194/columns", () => {
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

  test("sessions-list/row-columns: the narrower activity column lets the context column fit at 80 columns (76 for the list) beside the name, a triple and activity", () => {
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

  test("sessions-list/row-columns: at 60–70 columns the name wins over the triple and empty columns; activities coming and going never flip the columns #BUG-223/columns", () => {
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

  test("sessions-list/row-columns: an activity too long for its column takes the free columns beside it — empty context and cost cells, then the triple's blank end — before it is cut #BUG-265/GLUON-47", () => {
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

  test("sessions-list/select: rows that don't fit leave a `… N more` line; scrolled, the first row's group label stays on top", () => {
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

  test("sessions-list/select: a window stays where it was while its selection is in it — selecting a line it shows (a click) never scrolls it; a selection that leaves it scrolls it just enough #BUG-271/GLUON-55", () => {
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

  test("tabs/strip: tabs keep launch order whatever a session's state; the list stays grouped #BUG-157/tabs", () => {
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

test("intake-chat/working: listing the repository root is named, not an empty folder #BUG-185/live", () => {
  for (const root of [".", "", "/", "./"]) {
    expect(summarizeExplored([{ kind: "list", text: root }, { kind: "search", text: "TODO" }])).toBe('Listed the repository · searched for "TODO"');
  }
  expect(summarizeExplored([{ kind: "list", text: ".." }])).toBe("Listed ..");
  expect(summarizeExplored([{ kind: "list", text: "." }, { kind: "list", text: "src" }])).toBe("Listed 2 folders");
});

test("sessions-list/unique-names: two sessions with the same name — the newer is numbered (the draft too), unique among the sessions listed #BUG-219/store", () => {
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

test("sessions-list/row-columns: a row with no activity lends its activity column to its triple — no cut triple beside blank columns #BUG-251/row", () => {
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
  test("home/key-list: groups stacked in one column share its key column: what the keys do starts in one column", () => {
    expect(new Set(starts(46)).size).toBe(1);
  });
  test("home/key-list: at 76 columns two columns still fit, each aligned within itself", () => {
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
  test("home/readable: what Enter acts on stands out from the user's messages (`bar`); dim text on it stays readable #BUG-252/selection", () => {
    expect(ratio(GLUON_HEX.selected, GLUON_HEX.bar)).toBeGreaterThanOrEqual(1.45);
    expect(ratio(GLUON_HEX.dim, GLUON_HEX.selected)).toBeGreaterThanOrEqual(3);
    expect(nearest256(GLUON_HEX.selected)).not.toBe(nearest256(GLUON_HEX.bar));
  });
  test("home/readable: box borders are ≥ 3:1 against the ground #BUG-255/frame", () => {
    expect(ratio(GLUON_HEX.frame, GLUON_HEX.ground)).toBeGreaterThanOrEqual(3);
  });
});
