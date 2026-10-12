/** Gluon's chrome (`src/pty/chrome.ts`): drawn into a headless terminal and read back, at several widths. */
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { bottomBar, frameBox, infoLine, noteRows, prefixBar, questionBar, scrollFooter, switchKey, tabSpans, tabStrip, tooSmall, zoomBar } from "../src/pty/chrome.ts";
import { truncate } from "../src/ui/layout.ts";
import { createScreen, type TermScreen } from "../src/pty/screen.ts";
import type { SessionState, SessionView } from "../src/sessions.ts";
import { GLUON_HEX } from "../src/ui/theme.ts";
import { tripleProblem } from "./e2e/gluon-invariants.ts";
import { tripleSegs } from "../src/ui/layout.ts";

/** The questions the bar is given, as Gluon asks them (a session's own, then the home view's: its forms, longest first). */
const END_QUESTION = "/clear ends this session in Gluon — end it?";
const END_COMPACT_QUESTION = "End this session instead of compacting?";
const QUIT = (n: number) => [`${n} session${n === 1 ? "" : "s"} running — quit and end ${n === 1 ? "it" : "them"}?`, `Quit and end ${n} session${n === 1 ? "" : "s"}?`, `End ${n} and quit?`];
const DISCARD = ["Discard this chat?", "Discard chat?"];

const EL_ED = /\x1b\[[0-9;?]*[JK]/;

/** One row's bytes drawn at the top of a `cols`-wide terminal. */
async function row(bytes: string, cols: number): Promise<TermScreen> {
  expect(bytes).not.toMatch(EL_ED);
  const t = createScreen(cols, 1);
  await t.write(`\x1b[H${bytes}`);
  return t;
}
const text = async (bytes: string, cols: number) => (await row(bytes, cols)).viewLine(0).text;
const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

const view = (o: Partial<SessionView> & { id: number; name: string }): SessionView => ({ state: "working", agent: { harness: "claude-code", model: "opus", effort: "high" }, activity: "", startedAt: 0, ...o });
const none: Record<SessionState, number> = { awaiting: 0, working: 0, done: 0, drafting: 0 };

describe("layout", () => {
  test("frame/too-small: `too small` is on Gluon's ground, every cell; narrower than its line, the home key and its word go on a line of their own #BUG-248/V-04", async () => {
    const shown = async (cols: number, rows = 3) => {
      const t = createScreen(cols, rows);
      await t.write(`x\r\nleftover${tooSmall("ctrl+\\", cols, true, rows)}`);
      const lines = Array.from({ length: rows }, (_, y) => t.viewLine(y).text);
      const ground = Array.from({ length: rows }, (_, y) => t.cells(y).every((c) => c.bgMode === "rgb" && hex(c.bg) === GLUON_HEX.ground));
      t.dispose();
      return { lines, ground };
    };
    for (const cols of [40, 19, 12]) expect((await shown(cols)).ground).toEqual([true, true, true]);
    expect((await shown(19)).lines).toEqual(["too small", "ctrl+\\ home", ""]);
    expect((await shown(10)).lines).toEqual(["too small", "ctrl+\\ ho…", ""]);
    // One row: the key, what gets the user out.
    expect((await shown(19, 1)).lines).toEqual(["ctrl+\\ home"]);
  });
});

describe("the tab strip", () => {
  test("tabs/strip: ‹N and N› count the hidden tabs, bright and bold; the whole marker is the click target #BUG-232/markers", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `session-number-${i + 1}`, state: "working" as const }));
    for (const cols of [40, 60, 80, 120]) {
      for (const cur of [1, 6, 12]) {
        const t = await row(tabStrip(many, cur, cols, true), cols);
        const line = t.viewLine(0).text.padEnd(cols);
        const spans = tabSpans(many, cur, cols);
        expect(Bun.stringWidth(line.trimEnd())).toBeLessThanOrEqual(cols);
        const ids = spans.tabs.map((x) => x.id);
        const left = Math.min(...ids) - 1;
        const right = 12 - Math.max(...ids);
        if (left) {
          const at = line.indexOf(`‹${left} `);
          expect(at).toBeGreaterThan(0);
          expect(spans.prev).toEqual({ id: left, x0: at, x1: at + `‹${left} `.length });
          expect(t.cells(0)[at]!.bold).toBe(true);
          expect(hex(t.cells(0)[at]!.fg)).toBe(GLUON_HEX.bright);
        } else expect(line).not.toContain("‹");
        if (right) {
          expect(line.endsWith(` ${right}›`)).toBe(true);
          expect(spans.next).toEqual({ id: Math.max(...ids) + 1, x0: cols - ` ${right}›`.length, x1: cols });
          expect(hex(t.cells(0)[cols - 1]!.fg)).toBe(GLUON_HEX.bright);
        } else expect(line).not.toContain("›");
      }
    }
  });

});

describe("the info line", () => {
  test("frame/info-line: the triple, elapsed, cost, context, files changed and the state; amber where it needs the user", async () => {
    const v = view({ id: 1, name: "x", state: "awaiting", startedAt: 0, cost: { usd: 4.12, approx: true }, contextPct: 85, filesChanged: 4 });
    const t = await row(infoLine(v, 25 * 60_000, 120, true), 120);
    expect(t.viewLine(0).text).toBe(" claude code × opus × high · 25m · ~$4.12 · 85% context · 4 files changed · awaiting your input");
    const cells = t.cells(0);
    const at = (s: string) => t.viewLine(0).text.indexOf(s);
    expect(hex(cells[at("claude")]!.fg)).toBe(GLUON_HEX.bright);
    expect(hex(cells[at("opus")]!.fg)).toBe(GLUON_HEX.dim);
    expect(hex(cells[at("85%")]!.fg)).toBe(GLUON_HEX.amber);
    expect(hex(cells[at("awaiting")]!.fg)).toBe(GLUON_HEX.amber);
  });

  test("frame/info-line: unknown figures are left out; a working session shows its activity; one the user marked done says done; cut to the width", async () => {
    expect(await text(infoLine(view({ id: 1, name: "x", activity: "Bash: bun test" }), 0, 100, true), 100)).toBe(" claude code × opus × high · now · Bash: bun test");
    const marked = await row(infoLine(view({ id: 1, name: "x", state: "awaiting", markedDone: true, filesChanged: 1 }), 3 * 60_000, 100, true), 100);
    expect(marked.viewLine(0).text.trimEnd()).toBe(" claude code × opus × high · 3m · 1 file changed · done");
    expect(hex(marked.cells(0)[marked.viewLine(0).text.indexOf("done")]!.fg)).toBe(GLUON_HEX.green);
    const cut = await text(infoLine(view({ id: 1, name: "x", activity: "a long activity line that goes on" }), 0, 40, true), 40);
    // A column of margin at the right (BUG-257).
    expect(Bun.stringWidth(cut)).toBe(39);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("frame/info-line: short of room the figures go first and the state last; no file changed says nothing #BUG-178/E", async () => {
    const v = view({ id: 1, name: "x", state: "awaiting", startedAt: 0, cost: { usd: 4.12, approx: true }, contextPct: 85, filesChanged: 4 });
    const at = async (cols: number) => (await text(infoLine(v, 25 * 60_000, cols, true), cols)).trimEnd();
    expect(await at(90)).toBe(" claude code × opus × high · 25m · ~$4.12 · 85% context · awaiting your input");
    expect(await at(75)).toBe(" claude code × opus × high · 25m · ~$4.12 · awaiting your input");
    expect(await at(55)).toBe(" claude code × opus × high · 25m · awaiting your input");
    expect(await at(50)).toBe(" claude code × opus × high · awaiting your input");
    // The triple is cut before it goes (BUG-257).
    expect(await at(40)).toBe(" claude code × o… · awaiting your input");
    expect(await at(30)).toBe(" awaiting your input");
    expect(await at(12)).toBe(" awaiting y…");
    expect(await text(infoLine(view({ id: 1, name: "x", state: "done", filesChanged: 0 }), 0, 100, true), 100)).toBe(" claude code × opus × high · now · done");
  });

  test("frame/info-line: one rule whatever the harness — the figures go, then the triple is cut, never dropped while it fits cut; a column of margin at the right #BUG-257/info", async () => {
    const config = { models: { "claude-code": [{ id: "sonnet", label: "Sonnet 5.5" }], codex: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }] } } as unknown as Pick<Config, "models">;
    const line = async (agent: SessionView["agent"], cols: number) => (await text(infoLine(view({ id: 1, name: "x", state: "awaiting", agent }), 180_000, cols, true, config), cols)).trimEnd();
    const claude = await line({ harness: "claude-code", model: "sonnet", effort: "medium" }, 50);
    const codex = await line({ harness: "codex", model: "gpt-6-luna", effort: "low" }, 50);
    expect(claude).toBe(" claude code × sonnet 5.5… · awaiting your input");
    expect(codex).toBe(" codex × gpt-6 luna × low · awaiting your input");
    for (const l of [claude, codex]) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(49);
    // Room for it all: the age too, still short of the last column.
    expect(await line({ harness: "codex", model: "gpt-6-luna", effort: "low" }, 53)).toBe(" codex × gpt-6 luna × low · 3m · awaiting your input");
    expect(await line({ harness: "codex", model: "gpt-6-luna", effort: "low" }, 52)).toBe(" codex × gpt-6 luna × low · awaiting your input");
  });
});

describe("the info line against the frame's title", () => {
  test("frame/info-line: a mode or permissions after the triple are part of it for the e2e invariant, whole or cut, and a different one is still found #BUG-724/mode", async () => {
    const config = { models: { "claude-code": [{ id: "sonnet", label: "Sonnet 5.5" }] } } as unknown as Pick<Config, "models">;
    const t = { harness: "claude-code" as const, model: "sonnet", effort: "medium" as const };
    // The frame's title is the same segments the info line draws (`tripleSegs`); the invariant reads both from the screen.
    const title = (agent: SessionView["agent"]) => tripleSegs(agent, config).map((s) => s.text).join("");
    const info = async (agent: SessionView["agent"], cols: number) => (await text(infoLine(view({ id: 1, name: "x", agent, activity: "Working" }), 0, cols, true, config), cols)).trimEnd();
    expect(title({ ...t, mode: "explore" })).toBe("claude code × sonnet 5.5 × medium · explore");
    for (const agent of [t, { ...t, mode: "explore" as const }, { ...t, mode: "plan" as const }, { ...t, permissions: "accept-edits" as const }]) {
      const row = await info(agent, 120);
      expect(row).toContain(title(agent));
      expect(tripleProblem(row, title(agent))).toBeUndefined();
      // Cut: in the mode, at the triple's end, in the model.
      for (const cols of [60, 50, 45, 40]) expect(tripleProblem(await info(agent, cols), title(agent))).toBeUndefined();
    }
    // The real differences are still found: another model, another mode, a mode the info line lacks.
    const explore = title({ ...t, mode: "explore" });
    expect(tripleProblem(" claude code × opus × medium · explore · now", explore)).toContain("isn't the frame's");
    expect(tripleProblem(" claude code × sonnet 5.5 × medium · plan · now", explore)).toContain("isn't the frame's");
    expect(tripleProblem(" claude code × sonnet 5.5 × medium · now · Working", explore)).toContain("isn't the frame's");
  });
});

describe("the frame", () => {
  test("frame/scrollback: a narrow frame cuts the title; the scroll indicator sits in the bottom border", async () => {
    const outer = createScreen(24, 6);
    await outer.write(frameBox({ top: 0, left: 0, cols: 24, rows: 6 }, [{ text: "claude code × opus × high", role: "bright" }], scrollFooter(12), true));
    expect(outer.viewLine(0).text).toMatch(/^┌─ claude code ×.*…\s?─*┐$/);
    expect(Bun.stringWidth(outer.viewLine(0).text)).toBe(24);
    expect(outer.viewLine(5).text).toBe("└──── ↑ 12 · esc back ─┘");
    expect(scrollFooter(0)).toBe("");
  });
});

describe("zoom", () => {
  test("frame/zoom: the zoom bar says zoomed and how to leave, with the other sessions' counts; shorter forms in less room (the home key stays) #BUG-284/zoom", async () => {
    expect(await text(zoomBar("ctrl+\\", none, 100, true), 100)).toBe(" zoomed · ctrl+\\ z back · ctrl+\\ sessions");
    expect((await text(zoomBar("ctrl+\\", { ...none, awaiting: 1, working: 2 }, 100, true), 100)).replace(/ +/g, " ")).toBe(" zoomed · ctrl+\\ z back · ctrl+\\ sessions ? 1 awaiting · ● 2 working");
    const at = async (cols: number) => (await text(zoomBar("ctrl+\\", { ...none, working: 2 }, cols, true), cols)).trimEnd();
    expect(await at(44)).toBe(" zoomed · ctrl+\\ z back · ctrl+\\ sessions");
    expect(await at(30)).toBe(" zoomed · ctrl+\\ z back");
    expect(await at(22)).toBe(" ctrl+\\ sessions");
    expect(await at(10)).toBe(" ctrl+\\");
    expect(zoomBar("ctrl+\\", none, 100, true)).not.toMatch(EL_ED);
  });

  test("frame/zoom: scrolled back, the bar carries `↑ 12 · esc back` (the frame's border, where it lives otherwise, is gone) and keeps it before the counts #BUG-284/zoom", async () => {
    const counts = { ...none, working: 1 };
    expect((await text(zoomBar("ctrl+\\", counts, 100, true, 12), 100)).replace(/ +/g, " ")).toBe(" zoomed · ctrl+\\ z back · ctrl+\\ sessions ↑ 12 · esc back · ● 1 working");
    for (const cols of [60, 40, 30, 24]) expect(await text(zoomBar("ctrl+\\", counts, cols, true, 12), cols)).toContain("↑ 12 · esc back");
    expect(await text(zoomBar("ctrl+\\", counts, 100, true, 0), 100)).not.toContain("↑");
  });

  test("frame/zoom: the prefix bar names z: `z zoom` normally, `z unzoom` while zoomed #BUG-284/zoom", async () => {
    expect((await text(prefixBar("ctrl+\\", 100, true), 100)).trimEnd()).toMatch(/ · z zoom$/);
    expect((await text(prefixBar("ctrl+\\", 100, true, true), 100)).trimEnd()).toMatch(/ · z unzoom$/);
  });
});

describe("the bottom bar", () => {
  test("tabs/bar: short of room the words shorten first, then the counts go, then the switch key (the home key stays) #BUG-230/bar", async () => {
    const counts = { ...none, working: 2, done: 1 };
    expect(await text(bottomBar("ctrl+\\", counts, 50, true), 50)).toBe(" ←/→ switch · ctrl+\\ sessions");
    expect(await text(bottomBar("ctrl+\\", counts, 30, true), 30)).toBe(" ←/→ switch · ctrl+\\ sessions");
    expect(await text(bottomBar("ctrl+\\", counts, 28, true), 28)).toBe(" ctrl+\\ sessions");
    // The home key and a count, once the switch key has gone (typed: no switch key at all).
    expect(await text(bottomBar("ctrl+\\", { ...none, awaiting: 1 }, 40, true, null), 40)).toMatch(/^ ctrl\+\\ sessions +\? 1 awaiting$/);
    expect(await text(bottomBar("ctrl+\\", { ...none, awaiting: 1 }, 20, true, null), 20)).toBe(" ctrl+\\ sessions");
  });

  test("tabs/bar: no switch key on the only tab; none on a touched line (the home key then ←/→ switches); ←/→ on an untouched line with more than one tab #BUG-241/GLUON-33", async () => {
    expect(switchKey({ untouched: true, onlyTab: false })).toBe("←/→");
    expect(switchKey({ untouched: false, onlyTab: false })).toBeNull();
    expect(switchKey({ untouched: true, onlyTab: true })).toBeNull();
    expect(switchKey({ untouched: false, onlyTab: true })).toBeNull();
    expect(await text(bottomBar("ctrl+\\", none, 100, true, null), 100)).toBe(" ctrl+\\ sessions");
    expect(await text(bottomBar("ctrl+\\", none, 20, true, null), 20)).toBe(" ctrl+\\ sessions");
  });

  test("tabs/bar: the bar names ←/→ only with a switch key; its words are `switch session · ctrl+\\ sessions`, never alt+pgup/pgdn or `home` #BUG-281/bar", async () => {
    const t = await row(bottomBar("ctrl+\\", { ...none, working: 1 }, 100, true, switchKey({ untouched: true, onlyTab: false })), 100);
    expect(t.viewLine(0).text).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions +● 1 working$/);
    expect(t.cells(0)[1]!.bold).toBe(true);
    for (const cols of [100, 60, 40, 30, 20]) {
      const shown = await text(bottomBar("ctrl+\\", { ...none, awaiting: 1, working: 1 }, cols, true, switchKey({ untouched: false, onlyTab: false })), cols);
      expect(shown).not.toMatch(/alt|pg|←|home/);
    }
  });

  test("tabs/home-key: the prefix bar (the home key waits): ←/→ switch session · ctrl+\\ home · esc cancel, shorter forms in less room, selected-coloured to the edge #BUG-281/bar", async () => {
    const t = await row(prefixBar("ctrl+\\", 100, true), 100);
    expect(t.viewLine(0).text.trimEnd()).toBe(" ←/→ switch session · ctrl+\\ home · esc cancel · z zoom");
    expect(t.cells(0)[1]!.bold).toBe(true);
    expect(hex(t.cells(0)[99]!.bg)).toBe(GLUON_HEX.selected);
    const at = async (cols: number) => (await text(prefixBar("ctrl+\\", cols, false), cols)).trimEnd();
    // The zoom key goes first when room is short: the older forms are unchanged.
    expect(await at(52)).toBe(" ←/→ switch session · ctrl+\\ home · esc cancel");
    expect(await at(45)).toBe(" ←/→ switch · ctrl+\\ home · esc");
    expect(await at(30)).toBe(" ←/→ · ctrl+\\ home");
    expect(await at(12)).toBe(" ctrl+\\ hom…");
    expect(await text(prefixBar("ctrl+]", 100, true), 100)).toMatch(/^ ←\/→ switch session · ctrl\+\] home · esc cancel/);
    // It is not the normal bar: the question bar and the bottom bar are replaced, not drawn over.
    expect(prefixBar("ctrl+\\", 100, true)).not.toMatch(EL_ED);
  });

  test("clear-compact/bar: short of room a question takes its shorter form, its keys stay; a cut leaves no blank before the … #BUG-254/bar", async () => {
    const at = async (cols: number) => (await text(questionBar(END_COMPACT_QUESTION, cols, false), cols)).trimEnd();
    expect(await at(80)).toBe(" ? End this session instead of compacting?  enter yes · esc no");
    expect(await at(50)).toBe(" ? End instead of compacting?  enter yes · esc no");
    expect(await at(40)).toBe(" ? End instead?  enter yes · esc no");
    expect(truncate("Talking it through", 12)).toBe("Talking it…");
    expect(truncate("Talking it through", 11)).toBe("Talking it…");
    expect(truncate("Talking it through", 18)).toBe("Talking it through");
  });

  test("clear-compact/bar: a held /clear's question says what happens in Gluon; narrower, it keeps the command, then says what a yes does #BUG-270/GLUON-53", async () => {
    const at = async (q: string, cols: number) => (await text(questionBar(q, cols, false), cols)).trimEnd();
    expect(await at(END_QUESTION, 100)).toBe(" ? /clear ends this session in Gluon — end it?  enter yes · esc no");
    expect(await at("/new ends this session in Gluon — end it?", 80)).toBe(" ? /new ends this session in Gluon — end it?  enter yes · esc no");
    expect(await at(END_QUESTION, 60)).toBe(" ? /clear ends this session — end it?  enter yes · esc no");
    expect(await at(END_QUESTION, 41)).toBe(" ? End this session?  enter yes · esc no");
    expect(await at(END_QUESTION, 36)).toBe(" ? End session?  enter yes · esc no");
  });

  test("clear-compact/bar: on a narrow bar the question keeps what it is about — the session, the verb, the count — and the keys shrink, then go; never `End G…` #BUG-264/GLUON-46", async () => {
    const at = async (q: string | readonly string[], cols: number) => (await text(questionBar(q, cols, false), cols)).trimEnd();
    const end = ["End Gluon-golf-task-number-6?", "End golf-task-number-6?"];
    expect(await at(end, 80)).toBe(" ? End Gluon-golf-task-number-6?  enter yes · esc no");
    expect(await at(end, 50)).toBe(" ? End golf-task-number-6?  enter yes · esc no");
    expect(await at(end, 40)).toBe(" ? End golf-task-number-6?  enter · esc");
    expect(await at(end, 30)).toBe(" ? End golf-task-number-6?");
    expect(await at(end, 19)).toBe(" ? End golf-task…?");
    // A session's own questions: the shorter verb form and the shorter keys at 30 columns (was `End t…`, `End i…`).
    expect(await at(END_QUESTION, 30)).toBe(" ? End session?  enter · esc");
    expect(await at(END_COMPACT_QUESTION, 30)).toBe(" ? End instead?  enter · esc");
    expect(await at(END_QUESTION, 19)).toBe(" ? End session?");
    // Quitting keeps its count (was `1 session running — quit…` at 50), discarding its object.
    expect(await at(QUIT(1), 50)).toBe(" ? Quit and end 1 session?  enter yes · esc no");
    expect(await at(QUIT(3), 30)).toBe(" ? Quit and end 3 sessions?");
    expect(await at(QUIT(2), 19)).toBe(" ? End 2 and quit?");
    expect(await at(DISCARD, 30)).toBe(" ? Discard chat?  enter · esc");
    // A saved session that can't be resumed keeps its name and what it asks at every width.
    const again = ["Gluon-fix-add-bug (Codex) can't be resumed (it never reported its session id). Start it again with its saved spec?", "fix-add-bug can't be resumed. Start it again?", "Start fix-add-bug again?"];
    expect(await at(again, 200)).toBe(" ? Gluon-fix-add-bug (Codex) can't be resumed (it never reported its session id). Start it again with its saved spec?  enter yes · esc no");
    expect(await at(again, 120)).toBe(" ? fix-add-bug can't be resumed. Start it again?  enter yes · esc no");
    expect(await at(again, 60)).toBe(" ? Start fix-add-bug again?  enter yes · esc no");
    expect(await at(again, 30)).toBe(" ? Start fix-add-bug again?");
    // Every width from the tiny terminal up: the question is never cut to its first word.
    for (const q of [end, again, ["Resume Gluon-fix-add-bug (Codex) now? Sessions run one at a time here.", "Resume Gluon-fix-add-bug?"], END_QUESTION, END_COMPACT_QUESTION, QUIT(1), DISCARD])
      for (let cols = 19; cols <= 100; cols++) {
        const shown = await at(q, cols);
        expect(shown).not.toMatch(/^ \? \S+ \S{0,2}…/);
        expect(Bun.stringWidth(shown)).toBeLessThanOrEqual(cols);
      }
  }, 60_000); // ~600 renders through the screen model: bun's 5 s default fails it on a loaded machine
});

describe("BUG-409/launch-modes: a session's note over the frame (noteRows)", () => {
  const line = "type this yourself: /plan Read the session brief in /tmp/gluon-abcdef/0123456789abcdef/spec.md and start.";
  const text = async (cols: number, notes: string[], max = 20) => {
    const rows = noteRows(notes, cols, true, max);
    const t = createScreen(cols, rows.length);
    await t.write(rows.map((r, i) => `\x1b[${i + 1};1H${r}`).join(""));
    expect(rows.join("")).not.toMatch(EL_ED);
    return Array.from({ length: rows.length }, (_, y) => t.viewLine(y).text.trimEnd());
  };
  test("frame/note: wrapped to the width, never cut: the whole line is there at 100, 60 and 40 columns, then what hides the note", async () => {
    for (const cols of [100, 60, 40, 24]) {
      const rows = await text(cols, [line]);
      expect(rows.at(-1)).toBe(" esc hides this note");
      for (const r of rows) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(cols);
      expect(rows.slice(0, -1).map((r) => r.trim()).join("").replaceAll(" ", "")).toBe(line.replaceAll(" ", ""));
    }
  });
  test("frame/note: short of rows the hint goes first, then the note's end; notes are separate paragraphs; control characters are blanks", async () => {
    expect((await text(40, [line], 3)).join("\n")).not.toContain("esc hides");
    expect(await text(40, [line], 3)).toHaveLength(3);
    const two = await text(100, ["first note", "second\x1b[31m note"]);
    expect(two.map((r) => r.trim())).toEqual(["first note", "second [31m note", "esc hides this note"]);
    expect(await text(100, [])).toEqual([" esc hides this note"]);
  });
});
