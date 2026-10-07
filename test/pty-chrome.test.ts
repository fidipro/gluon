/** Gluon's chrome (`src/pty/chrome.ts`): drawn into a headless terminal and read back, at several widths. */
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { bottomBar, frameBox, infoLine, layout, noteRows, prefixBar, questionBar, scrollFooter, switchKey, tabSpans, tabStrip, tooSmall, zoomBar, zoomLayout } from "../src/pty/chrome.ts";
import { END_COMPACT_QUESTION, END_QUESTION, endQuestion } from "../src/pty/types.ts";
import { homeQuestions } from "../src/gluon.ts";
import { truncate } from "../src/ui/layout.ts";
import { createScreen, type TermScreen } from "../src/pty/screen.ts";
import type { SessionState, SessionView } from "../src/sessions.ts";
import { GLUON_HEX } from "../src/ui/theme.ts";

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
  test("the chrome takes two columns and five rows: tabs, info, the frame's borders, the bottom bar; from 24 rows a blank row before the frame", () => {
    expect(layout(100, 23)).toEqual({ cols: 100, rows: 23, small: false, tabRow: 0, infoRow: 1, frame: { top: 2, left: 0, cols: 100, rows: 20 }, interior: { top: 3, left: 1, cols: 98, rows: 18 }, barRow: 22 });
    expect(layout(100, 30)).toEqual({ cols: 100, rows: 30, small: false, tabRow: 0, infoRow: 1, frame: { top: 3, left: 0, cols: 100, rows: 26 }, interior: { top: 4, left: 1, cols: 98, rows: 24 }, barRow: 29 });
  });

  test("BUG-181/E: below 20×6 the frame isn't drawn (laid out for 20×6, for the PTYs); one line names the home key", async () => {
    expect(layout(1, 2)).toMatchObject({ small: true, interior: { top: 3, left: 1, cols: 18, rows: 1 }, barRow: 5 });
    expect(layout(20, 5).small).toBe(true);
    expect(layout(19, 6).small).toBe(true);
    expect(layout(20, 6).small).toBe(false);
    // It clears the screen (ED) on purpose: nothing of the frame may stay.
    const shown = async (cols: number) => {
      const t = createScreen(cols, 3);
      await t.write(`x\r\nleftover${tooSmall("ctrl+\\", cols, true)}`);
      const lines = [0, 1, 2].map((y) => t.viewLine(y).text);
      t.dispose();
      return lines;
    };
    expect(await shown(40)).toEqual(["too small · ctrl+\\ home", "", ""]);
  });

  test("BUG-248/V-04: `too small` is on Gluon's ground, every cell; narrower than its line, the home key and its word go on a line of their own", async () => {
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
  const sessions = [
    { id: 1, name: "pty-return-flow", state: "awaiting" as const },
    { id: 2, name: "flaky-launcher-test", state: "working" as const },
    { id: 3, name: "config-docs-scan", state: "working" as const },
    { id: 4, name: "spawn-tty-explainer", state: "done" as const },
  ];

  test("◆ gluon, then glyph and name per session; the current tab on `selected`, bold and underlined; the rest on the bar", async () => {
    const t = await row(tabStrip(sessions, 1, 110, true), 110);
    expect(t.viewLine(0).text).toBe(" ◆ gluon  ? pty-return-flow   ● flaky-launcher-test   ● config-docs-scan   ✓ spawn-tty-explainer");
    const cells = t.cells(0);
    const at = (s: string) => t.viewLine(0).text.indexOf(s);
    expect(hex(cells[at("pty")]!.bg)).toBe(GLUON_HEX.selected);
    expect(cells[at("pty")]!.underline && cells[at("pty")]!.bold).toBe(true);
    // BUG-183/tab: the underline runs under the glyph too, not under the tab's outer padding.
    expect(cells[at("? pty")]!.underline).toBe(true);
    expect(cells[at("? pty") + 1]!.underline).toBe(true);
    expect(cells[at("? pty") - 1]!.underline).toBe(false);
    expect(hex(cells[at("flaky")]!.bg)).toBe(GLUON_HEX.bar);
    expect(cells[at("flaky")]!.underline).toBe(false);
    expect(hex(cells[at("flaky")]!.fg)).toBe(GLUON_HEX.dim);
    // The bar runs to the right edge.
    expect(hex(cells[109]!.bg)).toBe(GLUON_HEX.bar);
  });

  test("too many tabs: the strip scrolls to keep the current one whole, ‹ › mark the hidden ones", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `session-number-${i + 1}`, state: "working" as const }));
    for (const cols of [40, 60, 80]) {
      for (const cur of [1, 5, 9]) {
        const line = await text(tabStrip(many, cur, cols, true), cols);
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
        expect(line).toStartWith(" ◆ gluon");
        expect(line).toContain(`session-number-${cur}`);
        expect(line.includes("‹")).toBe(cur !== 1);
        expect(line.endsWith("›")).toBe(cur !== 9);
      }
    }
  });

  test("BUG-196/spans: the click spans are where the strip draws ◆ gluon and each tab, scrolled and cut as drawn", async () => {
    expect(tabSpans(sessions, 1, 110)).toEqual({
      home: [0, 9],
      tabs: [
        { id: 1, x0: 9, x1: 28 },
        { id: 2, x0: 29, x1: 52 },
        { id: 3, x0: 53, x1: 73 },
        { id: 4, x0: 74, x1: 97 },
      ],
    });
    const many = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `session-number-${i + 1}`, state: "working" as const }));
    for (const cols of [30, 40, 60, 80, 200]) {
      for (const cur of [1, 5, 9]) {
        // Padded back to the width (the row is read with its trailing blanks trimmed).
        const line = (await text(tabStrip(many, cur, cols, true), cols)).padEnd(cols);
        const spans = tabSpans(many, cur, cols);
        expect(line.slice(...spans.home)).toBe(" ◆ gluon ");
        // Every tab drawn has its span, and the span holds that tab (whole, or cut at the right marker).
        expect(spans.tabs.length).toBe(line.match(/●/g)!.length);
        expect(spans.tabs.map((t) => t.id)).toContain(cur);
        for (const t of spans.tabs) {
          const shown = line.slice(t.x0, t.x1);
          expect(shown === ` ● session-number-${t.id} ` || (` ● session-number-${t.id} `.startsWith(shown.replace(/…$/, "")) && t.x1 >= cols - 3)).toBe(true);
        }
        // The markers are no tab's.
        for (const mark of ["‹", "›"]) {
          const x = line.indexOf(mark);
          if (x >= 0) expect(spans.tabs.some((t) => x >= t.x0 && x < t.x1)).toBe(false);
        }
      }
    }
    expect(tabSpans([], null, 80)).toEqual({ home: [0, 9], tabs: [] });
  });

  test("BUG-232/markers: ‹N and N› count the hidden tabs, bright and bold; the whole marker is the click target", async () => {
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

  test("BUG-212/spans: ‹ and › have click spans where they're drawn, naming the nearest hidden tab on their side", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `session-number-${i + 1}`, state: "working" as const }));
    let both = 0;
    for (const cols of [30, 40, 60, 80, 200]) {
      for (const cur of [1, 5, 9]) {
        const line = (await text(tabStrip(many, cur, cols, true), cols)).padEnd(cols);
        const spans = tabSpans(many, cur, cols);
        const ids = spans.tabs.map((t) => t.id);
        const prev = line.indexOf("‹");
        const next = line.lastIndexOf("›");
        if (prev < 0) expect(spans.prev).toBeUndefined();
        else {
          expect(spans.prev).toMatchObject({ id: Math.min(...ids) - 1 });
          expect(prev >= spans.prev!.x0 && prev < spans.prev!.x1).toBe(true);
        }
        if (next < 0) expect(spans.next).toBeUndefined();
        else {
          expect(spans.next).toEqual({ id: Math.max(...ids) + 1, x0: cols - ` ${9 - Math.max(...ids)}›`.length, x1: cols });
          expect(next).toBe(cols - 1);
        }
        if (prev >= 0 && next >= 0) both++;
      }
    }
    expect(both).toBeGreaterThan(0);
  });

  test("a name longer than the strip is cut with …; nothing is current at home", async () => {
    const line = await text(tabStrip([{ id: 1, name: "a-very-long-session-name-indeed", state: "working" }], 1, 30, false), 30);
    expect(line).toMatch(/^ ◆ gluon {2}● a-very-long-.*…/);
    expect(await text(tabStrip(sessions.slice(0, 1), null, 60, false), 60)).toContain("? pty-return-flow");
  });
});

describe("the info line", () => {
  test("the triple, elapsed, cost, context, files changed and the state; amber where it needs the user", async () => {
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

  test("unknown figures are left out; a working session shows its activity; one the user marked done says done (BUG-193); cut to the width", async () => {
    expect(await text(infoLine(view({ id: 1, name: "x", activity: "Bash: bun test" }), 0, 100, true), 100)).toBe(" claude code × opus × high · now · Bash: bun test");
    const marked = await row(infoLine(view({ id: 1, name: "x", state: "awaiting", markedDone: true, filesChanged: 1 }), 3 * 60_000, 100, true), 100);
    expect(marked.viewLine(0).text.trimEnd()).toBe(" claude code × opus × high · 3m · 1 file changed · done");
    expect(hex(marked.cells(0)[marked.viewLine(0).text.indexOf("done")]!.fg)).toBe(GLUON_HEX.green);
    const cut = await text(infoLine(view({ id: 1, name: "x", activity: "a long activity line that goes on" }), 0, 40, true), 40);
    // A column of margin at the right (BUG-257).
    expect(Bun.stringWidth(cut)).toBe(39);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("BUG-178/E: short of room the figures go first and the state last; no file changed says nothing", async () => {
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

  test("BUG-257/info: one rule whatever the harness — the figures go, then the triple is cut, never dropped while it fits cut; a column of margin at the right", async () => {
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

describe("the frame", () => {
  test("a one-cell box with the title in its top border; nothing inside is written", async () => {
    const outer = createScreen(40, 10);
    await outer.write(`\x1b[H${"x".repeat(400)}`);
    const rect = { top: 2, left: 0, cols: 40, rows: 7 };
    const bytes = frameBox(rect, [{ text: "claude code", role: "bright" }, { text: " × opus × high", role: "dim" }], "", true);
    expect(bytes).not.toMatch(EL_ED);
    await outer.write(bytes);
    expect(outer.viewLine(2).text).toBe(`┌─ claude code × opus × high ${"─".repeat(10)}┐`);
    for (let y = 3; y < 8; y++) expect(outer.viewLine(y).text).toBe(`│${"x".repeat(38)}│`);
    expect(outer.viewLine(8).text).toBe(`└${"─".repeat(38)}┘`);
    // Rows outside the rectangle are untouched.
    expect(outer.viewLine(1).text).toBe("x".repeat(40));
    expect(outer.viewLine(9).text).toBe("x".repeat(40));
    expect(hex(outer.cells(3)[0]!.fg)).toBe(GLUON_HEX.frame);
  });

  test("a narrow frame cuts the title; the scroll indicator sits in the bottom border", async () => {
    const outer = createScreen(24, 6);
    await outer.write(frameBox({ top: 0, left: 0, cols: 24, rows: 6 }, [{ text: "claude code × opus × high", role: "bright" }], scrollFooter(12), true));
    expect(outer.viewLine(0).text).toMatch(/^┌─ claude code ×.*…\s?─*┐$/);
    expect(Bun.stringWidth(outer.viewLine(0).text)).toBe(24);
    expect(outer.viewLine(5).text).toBe("└──── ↑ 12 · esc back ─┘");
    expect(scrollFooter(0)).toBe("");
  });
});

describe("zoom", () => {
  test("BUG-284/zoom: the zoomed layout has no frame: the interior is the whole terminal but the last row, which is the bar's", () => {
    expect(zoomLayout(80, 24)).toEqual({ cols: 80, rows: 24, interior: { top: 0, left: 0, cols: 80, rows: 23 }, barRow: 23 });
    // Clamped like layout(): below 20×6 the PTY keeps a sane size.
    expect(zoomLayout(1, 2)).toEqual({ cols: 20, rows: 6, interior: { top: 0, left: 0, cols: 20, rows: 5 }, barRow: 5 });
    // The same last row as the framed layout's bar.
    for (const [c, r] of [[80, 24], [100, 30], [20, 6]] as const) expect(zoomLayout(c, r).barRow).toBe(layout(c, r).barRow);
    // What the frame took: 80×24 gave the agent 78×18, zoomed it has 80×23.
    expect(layout(80, 24).interior.rows).toBe(18);
  });

  test("BUG-284/zoom: the zoom bar says zoomed and how to leave, with the other sessions' counts; shorter forms in less room (the home key stays)", async () => {
    expect(await text(zoomBar("ctrl+\\", none, 100, true), 100)).toBe(" zoomed · ctrl+\\ z back · ctrl+\\ sessions");
    expect((await text(zoomBar("ctrl+\\", { ...none, awaiting: 1, working: 2 }, 100, true), 100)).replace(/ +/g, " ")).toBe(" zoomed · ctrl+\\ z back · ctrl+\\ sessions ? 1 awaiting · ● 2 working");
    const at = async (cols: number) => (await text(zoomBar("ctrl+\\", { ...none, working: 2 }, cols, true), cols)).trimEnd();
    expect(await at(44)).toBe(" zoomed · ctrl+\\ z back · ctrl+\\ sessions");
    expect(await at(30)).toBe(" zoomed · ctrl+\\ z back");
    expect(await at(22)).toBe(" ctrl+\\ sessions");
    expect(await at(10)).toBe(" ctrl+\\");
    expect(zoomBar("ctrl+\\", none, 100, true)).not.toMatch(EL_ED);
  });

  test("BUG-284/zoom: scrolled back, the bar carries `↑ 12 · esc back` (the frame's border, where it lives otherwise, is gone) and keeps it before the counts", async () => {
    const counts = { ...none, working: 1 };
    expect((await text(zoomBar("ctrl+\\", counts, 100, true, 12), 100)).replace(/ +/g, " ")).toBe(" zoomed · ctrl+\\ z back · ctrl+\\ sessions ↑ 12 · esc back · ● 1 working");
    for (const cols of [60, 40, 30, 24]) expect(await text(zoomBar("ctrl+\\", counts, cols, true, 12), cols)).toContain("↑ 12 · esc back");
    expect(await text(zoomBar("ctrl+\\", counts, 100, true, 0), 100)).not.toContain("↑");
  });

  test("BUG-284/zoom: the prefix bar names z: `z zoom` normally, `z unzoom` while zoomed", async () => {
    expect((await text(prefixBar("ctrl+\\", 100, true), 100)).trimEnd()).toMatch(/ · z zoom$/);
    expect((await text(prefixBar("ctrl+\\", 100, true, true), 100)).trimEnd()).toMatch(/ · z unzoom$/);
  });
});

describe("the bottom bar", () => {
  test("keys on the left (caps bold), the other sessions' counts on the right (awaiting amber)", async () => {
    const t = await row(bottomBar("ctrl+\\", { ...none, awaiting: 1, working: 2, done: 1 }, 100, true), 100);
    const line = t.viewLine(0).text;
    // BUG-183/bar: the brief's order, the switch key first.
    expect(line).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions +\? 1 awaiting · ● 2 working · ✓ 1 done$/);
    expect(t.cells(0)[1]!.bold).toBe(true);
    expect(hex(t.cells(0)[line.indexOf("? 1")]!.fg)).toBe(GLUON_HEX.amber);
    expect(await text(bottomBar("ctrl+]", none, 100, true), 100)).toBe(" ←/→ switch session · ctrl+] sessions");
  });

  test("BUG-230/bar: short of room the words shorten first, then the counts go, then the switch key (the home key stays)", async () => {
    const counts = { ...none, working: 2, done: 1 };
    expect(await text(bottomBar("ctrl+\\", counts, 50, true), 50)).toBe(" ←/→ switch · ctrl+\\ sessions");
    expect(await text(bottomBar("ctrl+\\", counts, 30, true), 30)).toBe(" ←/→ switch · ctrl+\\ sessions");
    expect(await text(bottomBar("ctrl+\\", counts, 28, true), 28)).toBe(" ctrl+\\ sessions");
    // The home key and a count, once the switch key has gone (typed: no switch key at all).
    expect(await text(bottomBar("ctrl+\\", { ...none, awaiting: 1 }, 40, true, null), 40)).toMatch(/^ ctrl\+\\ sessions +\? 1 awaiting$/);
    expect(await text(bottomBar("ctrl+\\", { ...none, awaiting: 1 }, 20, true, null), 20)).toBe(" ctrl+\\ sessions");
  });

  test("BUG-241/GLUON-33: no switch key on the only tab; none on a touched line (the home key then ←/→ switches); ←/→ on an untouched line with more than one tab", async () => {
    expect(switchKey({ untouched: true, onlyTab: false })).toBe("←/→");
    expect(switchKey({ untouched: false, onlyTab: false })).toBeNull();
    expect(switchKey({ untouched: true, onlyTab: true })).toBeNull();
    expect(switchKey({ untouched: false, onlyTab: true })).toBeNull();
    expect(await text(bottomBar("ctrl+\\", none, 100, true, null), 100)).toBe(" ctrl+\\ sessions");
    expect(await text(bottomBar("ctrl+\\", none, 20, true, null), 20)).toBe(" ctrl+\\ sessions");
  });

  test("BUG-281/bar: the bar names ←/→ only with a switch key; its words are `switch session · ctrl+\\ sessions`, never alt+pgup/pgdn or `home`", async () => {
    const t = await row(bottomBar("ctrl+\\", { ...none, working: 1 }, 100, true, switchKey({ untouched: true, onlyTab: false })), 100);
    expect(t.viewLine(0).text).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions +● 1 working$/);
    expect(t.cells(0)[1]!.bold).toBe(true);
    for (const cols of [100, 60, 40, 30, 20]) {
      const shown = await text(bottomBar("ctrl+\\", { ...none, awaiting: 1, working: 1 }, cols, true, switchKey({ untouched: false, onlyTab: false })), cols);
      expect(shown).not.toMatch(/alt|pg|←|home/);
    }
  });

  test("BUG-281/bar: the prefix bar (the home key waits): ←/→ switch session · ctrl+\\ home · esc cancel, shorter forms in less room, selected-coloured to the edge", async () => {
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

  test("the question bar takes its place: question, enter yes · esc no", async () => {
    const t = await row(questionBar("End this session?", 60, true), 60);
    expect(t.viewLine(0).text).toBe(" ? End this session?  enter yes · esc no");
    expect(hex(t.cells(0)[59]!.bg)).toBe(GLUON_HEX.selected);
    // A question with no shorter form: the keys go before it is cut, and a cut keeps its `?`.
    expect(await text(questionBar("Quit Gluon and end the 2 sessions still running?", 40, false), 40)).toBe(" ? Quit Gluon and end the 2 sessions…?");
  });

  test("BUG-254/bar: short of room a question takes its shorter form, its keys stay; a cut leaves no blank before the …", async () => {
    const at = async (cols: number) => (await text(questionBar(END_COMPACT_QUESTION, cols, false), cols)).trimEnd();
    expect(await at(80)).toBe(" ? End this session instead of compacting?  enter yes · esc no");
    expect(await at(50)).toBe(" ? End instead of compacting?  enter yes · esc no");
    expect(await at(40)).toBe(" ? End instead?  enter yes · esc no");
    expect(truncate("Talking it through", 12)).toBe("Talking it…");
    expect(truncate("Talking it through", 11)).toBe("Talking it…");
    expect(truncate("Talking it through", 18)).toBe("Talking it through");
  });

  test("BUG-270/GLUON-53: a held /clear's question says what happens in Gluon; narrower, it keeps the command, then says what a yes does", async () => {
    const at = async (q: string, cols: number) => (await text(questionBar(q, cols, false), cols)).trimEnd();
    expect(await at(END_QUESTION, 100)).toBe(" ? /clear ends this session in Gluon — end it?  enter yes · esc no");
    expect(await at(endQuestion("/new"), 80)).toBe(" ? /new ends this session in Gluon — end it?  enter yes · esc no");
    expect(await at(END_QUESTION, 60)).toBe(" ? /clear ends this session — end it?  enter yes · esc no");
    expect(await at(END_QUESTION, 41)).toBe(" ? End this session?  enter yes · esc no");
    expect(await at(END_QUESTION, 36)).toBe(" ? End session?  enter yes · esc no");
  });

  test("BUG-264/GLUON-46: on a narrow bar the question keeps what it is about — the session, the verb, the count — and the keys shrink, then go; never `End G…`", async () => {
    const at = async (q: string | readonly string[], cols: number) => (await text(questionBar(q, cols, false), cols)).trimEnd();
    const end = homeQuestions.end("Gluon-golf-task-number-6");
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
    expect(await at(homeQuestions.quit(1), 50)).toBe(" ? Quit and end 1 session?  enter yes · esc no");
    expect(await at(homeQuestions.quit(3), 30)).toBe(" ? Quit and end 3 sessions?");
    expect(await at(homeQuestions.quit(2), 19)).toBe(" ? End 2 and quit?");
    expect(await at(homeQuestions.discard(), 30)).toBe(" ? Discard chat?  enter · esc");
    // A saved session that can't be resumed keeps its name and what it asks at every width.
    const again = homeQuestions.again("Gluon-fix-add-bug", "Codex", "it never reported its session id");
    expect(await at(again, 200)).toBe(" ? Gluon-fix-add-bug (Codex) can't be resumed (it never reported its session id). Start it again with its saved spec?  enter yes · esc no");
    expect(await at(again, 120)).toBe(" ? fix-add-bug can't be resumed. Start it again?  enter yes · esc no");
    expect(await at(again, 60)).toBe(" ? Start fix-add-bug again?  enter yes · esc no");
    expect(await at(again, 30)).toBe(" ? Start fix-add-bug again?");
    // Every width from the tiny terminal up: the question is never cut to its first word.
    for (const q of [end, again, homeQuestions.now("Gluon-fix-add-bug", "Codex"), END_QUESTION, END_COMPACT_QUESTION, homeQuestions.quit(1), homeQuestions.discard()])
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
  test("wrapped to the width, never cut: the whole line is there at 100, 60 and 40 columns, then what hides the note", async () => {
    for (const cols of [100, 60, 40, 24]) {
      const rows = await text(cols, [line]);
      expect(rows.at(-1)).toBe(" esc hides this note");
      for (const r of rows) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(cols);
      expect(rows.slice(0, -1).map((r) => r.trim()).join("").replaceAll(" ", "")).toBe(line.replaceAll(" ", ""));
    }
  });
  test("short of rows the hint goes first, then the note's end; notes are separate paragraphs; control characters are blanks", async () => {
    expect((await text(40, [line], 3)).join("\n")).not.toContain("esc hides");
    expect(await text(40, [line], 3)).toHaveLength(3);
    const two = await text(100, ["first note", "second\x1b[31m note"]);
    expect(two.map((r) => r.trim())).toEqual(["first note", "second [31m note", "esc hides this note"]);
    expect(await text(100, [])).toEqual([" esc hides this note"]);
  });
});
