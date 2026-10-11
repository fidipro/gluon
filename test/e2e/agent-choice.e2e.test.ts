/**
 * The intake agent's question and its agent choice, end to end on the demo brain: picking, the model, effort, mode and
 * permissions keys, the spec box and its scrolling, clicks on options, and how the chat draws Markdown. A task's words
 * reach the demo's other turns (`demoExtras`, src/agent/clients.ts): `questions` asks three at once, `history` reads the
 * git log.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { GLUON_HEX } from "../../src/ui/theme.ts";
import { mouseReports } from "./actions.ts";
import { repo } from "./fixtures.ts";
import { type App, KEY, QUESTION, SLOW, start, stopAll, toProposal, toQuestion } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

/** The hint under the open question or agent choice (indented under its options). */
const hint = (app: App) => app.lines().find((l) => /^ {6,}(↑↓ choose|enter) /.test(l))?.trim() ?? "";

/** The rows inside the spec box, between its top and bottom edges. */
const specRows = (app: App) => {
  const ls = app.lines();
  const top = ls.findIndex((l) => l.includes("╭─ spec"));
  const end = ls.findIndex((l, i) => i > top && l.includes("╰─"));
  return ls.slice(top + 1, end);
};

/** The cells (0-based x, y) showing `ch`. */
function cellsOf(app: App, ch: string): [number, number][] {
  const buf = app.term.buffer.active;
  const out: [number, number][] = [];
  for (let y = 0; y < app.term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    for (let x = 0; line && x < app.term.cols; x++) if (line.getCell(x)?.getChars() === ch) out.push([x, y]);
  }
  return out;
}

/** Whether the first cell of `text` on the screen is bold (the row's text has no wide characters before it). */
function boldAt(app: App, text: string): boolean {
  const y = app.row(text);
  const x = app.lines()[y]!.indexOf(text);
  return !!app.term.buffer.active.getLine(app.term.buffer.active.viewportY + y)?.getCell(x)?.isBold();
}

/** A left click (press and release) on the first cell of `text`, as an SGR terminal reports it (1-based). */
function clickOn(app: App, text: string): string {
  const y = app.row(text);
  expect(y).toBeGreaterThanOrEqual(0);
  return mouseReports({ op: "click", button: "left", x: app.lines()[y]!.indexOf(text) + 1, y: y + 1 }).join("");
}

/** The fake agent is up in Gluon's frame (the line-mode fake's prompt). */
const STARTED = "type a line>";

describe("the agent choice's keys", () => {
  test("agent-choice/model-effort: Tab cycles the highlighted option's model and Shift+Tab its effort, the others keep theirs, and the agent starts with them; the hint names them only on an agent, ↑↓ wrap; the choice's first frame already lists the agents and names the drafting row #BUG-221 #BUG-258", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 140, rows: 40, agents: ["claude", "codex", "opencode"] });
    await toQuestion(app);
    // Every screen read with the choice on it, from its first (BUG-258): the options listed, the drafting row named.
    const early: string[] = [];
    await app.press("1");
    app.write(KEY.enter);
    await app.waitFor((s) => {
      if (s.includes("keep talking") && (!s.includes("1. claude code × sonnet 5.5 × high · recommended") || s.includes("(untitled)"))) early.push(s);
      return s.includes("keep talking");
    }, 20_000);
    expect(early).toEqual([]);
    await app.idle();
    expect(hint(app)).toContain("tab model · shift+tab effort");
    await app.press(KEY.up);
    await app.waitFor(/❯ 4\. keep talking/);
    expect(hint(app)).toBe("↑↓ choose · enter keeps talking · esc cancels");
    await app.press(KEY.down, KEY.down);
    await app.waitFor(/❯ 2\. codex × gpt-6\.1 sol × medium/);
    expect(hint(app)).toContain("tab model · shift+tab effort");
    await app.press(KEY.tab);
    await app.waitFor(/❯ 2\. codex × gpt-6 astra × medium/);
    await app.press(KEY.shiftTab);
    await app.waitFor(/❯ 2\. codex × gpt-6 astra × high/);
    expect(app.screen()).toContain("1. claude code × sonnet 5.5 × high · recommended");
    expect(app.screen()).toContain("3. opencode × deepseek flash × max");
    await app.press(KEY.enter);
    await app.waitFor(STARTED, 20_000);
    expect(app.agentLog()).toMatch(/ARG1=<-m>\s+ARG2=<gpt-6-astra>\s+ARG3=<-c>\s+ARG4=<model_reasoning_effort="high">/);
  });

  test("agent-choice/recommended-mark: `· recommended` leaves the first option once its model is changed, and comes back once it is the intake agent's own again #BUG-183", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 40 });
    await toProposal(app);
    await app.press(KEY.tab);
    await app.waitFor((s) => /❯ 1\. claude code × (?!sonnet 5\.5)/.test(s));
    expect(app.screen()).not.toContain("recommended");
    for (let i = 0; i < 6 && !/❯ 1\. claude code × sonnet 5\.5 × high/.test(app.screen()); i++) await app.press(KEY.tab);
    await app.waitFor("❯ 1. claude code × sonnet 5.5 × high · recommended");
  });

  test("agent-choice/mode: ctrl+t does nothing with no choice open; at the choice it cycles build → explore → plan → build on every option, and Enter starts the agent in that mode", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 40 });
    app.write(KEY.ctrlT);
    await app.settle();
    expect(app.screen()).not.toMatch(/explore|plan/);
    expect(app.lines().at(-2)).toMatch(/^ {3}› describe the session you want/);
    await toProposal(app);
    expect(app.screen()).not.toMatch(/· (explore|plan)/);
    await app.press(KEY.ctrlT);
    await app.waitFor("❯ 1. claude code × sonnet 5.5 × high · explore · recommended");
    expect(app.screen()).toContain("2. opencode × deepseek flash × max · explore");
    await app.press(KEY.ctrlT);
    await app.waitFor("❯ 1. claude code × sonnet 5.5 × high · plan · recommended");
    expect(app.screen()).toContain("2. opencode × deepseek flash × max · plan");
    await app.press(KEY.ctrlT);
    await app.waitFor((s) => s.includes("❯ 1. claude code × sonnet 5.5 × high · recommended") && !/· (explore|plan)/.test(s));
    await app.press(KEY.ctrlT, KEY.enter);
    await app.waitFor(STARTED, 20_000);
    // Claude Code's explore: no edits, no asking.
    expect(app.agentLog()).toMatch(/ARG5=<--permission-mode>\s+ARG6=<dontAsk>\s+ARG7=<--disallowedTools>\s+ARG8=<Edit>/);
  });

  test("agent-choice/mode: a proposal's own mode shows on every option from its first frame; ctrl+t goes on from it", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 40 });
    await toProposal(app, "plan the add fix");
    expect(app.screen()).toContain("❯ 1. claude code × sonnet 5.5 × high · plan · recommended");
    expect(app.screen()).toContain("2. opencode × deepseek flash × max · plan");
    await app.press(KEY.ctrlT);
    await app.waitFor((s) => s.includes("keep talking") && !/· (explore|plan)/.test(s));
  });

  test("agent-choice/permissions: ctrl+p cycles Claude Code's permissions (accept edits, auto) on its row alone, and Enter starts it with them", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 40 });
    await toProposal(app);
    expect(app.screen()).not.toMatch(/accept edits|· auto/);
    await app.press(KEY.ctrlP);
    await app.waitFor("❯ 1. claude code × sonnet 5.5 × high · accept edits · recommended");
    expect(app.screen()).not.toMatch(/2\. opencode .*accept edits/);
    await app.press(KEY.ctrlP);
    await app.waitFor("❯ 1. claude code × sonnet 5.5 × high · auto · recommended");
    await app.press(KEY.enter);
    await app.waitFor(STARTED, 20_000);
    expect(app.agentLog()).toMatch(/ARG5=<--permission-mode>\s+ARG6=<auto>/);
  });

  test("agent-choice/permissions: an agent with no levels, or explore, says why and changes nothing; the hint names ctrl+p only where it acts; back to its own, the agent starts with no level", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 160, rows: 40, agents: ["claude", "codex", "opencode"] });
    await toProposal(app);
    expect(hint(app)).toContain("ctrl+p permissions");
    await app.press(KEY.down);
    await app.waitFor(/❯ 2\. codex/);
    expect(hint(app)).not.toContain("ctrl+p");
    await app.press(KEY.ctrlP);
    await app.waitFor("Codex doesn't ask before every command or edit");
    expect(app.screen()).not.toMatch(/2\. codex .*(accept edits|· auto)/);
    await app.press(KEY.up, KEY.ctrlP);
    await app.waitFor("❯ 1. claude code × sonnet 5.5 × high · accept edits · recommended");
    // Explore sets its own: the row drops the level, and ctrl+p there only says so.
    await app.press(KEY.ctrlT);
    await app.waitFor("❯ 1. claude code × sonnet 5.5 × high · explore · recommended");
    await app.press(KEY.ctrlP);
    await app.waitFor("Permissions are for build mode");
    await app.press(KEY.ctrlT, KEY.ctrlT);
    await app.waitFor("❯ 1. claude code × sonnet 5.5 × high · accept edits · recommended");
    // Accept edits → auto → its own.
    await app.press(KEY.ctrlP, KEY.ctrlP);
    await app.waitFor((s) => s.includes("❯ 1. claude code × sonnet 5.5 × high · recommended"));
    await app.press(KEY.enter);
    await app.waitFor(STARTED, 20_000);
    expect(app.agentLog()).not.toContain("--permission-mode");
  });

  test("agent-choice/fits: at 50 columns a wrapped option starts its next line with `· recommended`, and no line ends in `·` or `×`; the hint drops whole keys from its end, never `enter starts the session` #BUG-225", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 50, rows: 40 });
    await toProposal(app);
    const at = app.row("❯ 1.");
    expect(app.lines().slice(at, at + 2)).toEqual(["      ❯ 1. claude code × sonnet 5.5 × high", "           · recommended"]);
    for (const l of app.lines()) expect(l).not.toMatch(/ [·×]$/);
    const full = "↑↓ choose · enter starts the session · esc cancels · tab model · shift+tab effort · ctrl+t mode".split(" · ");
    for (const cols of [50, 56, 76]) {
      app.resize(cols, 40);
      await app.waitFor((s) => s.split("\n").every((l) => Bun.stringWidth(l) <= cols) && hint(app).length > 0);
      await app.settle();
      const keys = hint(app).split(" · ");
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(keys).toEqual(full.slice(0, keys.length));
      expect(hint(app)).not.toContain("…");
      for (const l of app.lines()) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(cols);
    }
    expect(hint(app)).toBe("↑↓ choose · enter starts the session · esc cancels · tab model");
  });
});

describe("the spec box", () => {
  test("agent-choice/spec-scroll: with the whole box in view pgup/pgdn change nothing and its borders are on the ground; with no row for its text the spec is one line saying why; after esc pgup scrolls the chat #BUG-199 #BUG-218 #BUG-246 #BUG-197", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 110, rows: 40 });
    await toProposal(app);
    expect(app.screen()).toContain("Done when");
    const before = app.screen();
    // Keys that draw nothing: written, then the screen read once it settles (`press` would wait for an answer).
    for (const keys of [KEY.pgup + KEY.pgup, KEY.pgdn + KEY.pgup]) {
      app.write(keys);
      await app.settle();
      expect(app.screen()).toBe(before);
    }
    const sides = cellsOf(app, "│");
    expect(sides.length).toBeGreaterThan(8);
    expect(sides.filter(([x, y]) => app.bg(x, y) !== GLUON_HEX.ground)).toEqual([]);
    // No row for the spec's text: one line that says so; the options stay.
    app.resize(80, 14);
    await app.waitFor("spec: Fix the add bug.  (a taller terminal shows it)");
    expect(app.screen()).toContain("❯ 1. claude code × sonnet 5.5 × high · recommended");
    expect(app.screen()).toContain("3. keep talking");
    // Closed, pgup scrolls the chat back to the task; the composer stays.
    app.resize(100, 30);
    await app.waitFor("╭─ spec");
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("❯ 1."));
    expect(app.screen()).not.toContain("›  fix the add bug");
    await app.press(KEY.pgup);
    await app.waitFor("›  fix the add bug");
    expect(app.lines().at(-2)).toMatch(/^ {3}› reply to the intake agent/);
  });
});

describe("the question", () => {
  test("question/tab-adds-words: Tab on an option puts it in the composer to add words to, and Enter sends the whole; with text typed Tab does nothing issue-55/tab", async () => {
    // Tall enough for the answer and the proposal after it.
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 60 });
    await toQuestion(app);
    await app.type("x");
    app.write(KEY.tab);
    await app.settle();
    expect(app.lines().at(-2)).toMatch(/^ {3}› x$/);
    await app.press(KEY.backspace, KEY.down, KEY.tab);
    // The option and a space after it, the cursor there.
    await app.waitFor((s) => s.split("\n").at(-2) === "   › Just the fix");
    await app.type("but safely");
    await app.press(KEY.enter);
    await app.waitFor("›  Just the fix but safely", 20_000);
  });

  test("question/batch-step: several questions asked together come one at a time, `(1/3)`, `(2/3)`, `(3/3)`, and the answers go back together", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 60 });
    await app.enter("ask me questions about the add bug");
    await app.press(KEY.enter);
    await app.waitFor(`(1/3) ${QUESTION}`, 20_000);
    await app.idle();
    await app.press("1", KEY.enter);
    await app.waitFor("(2/3) Which tests should cover it?");
    await app.press("2", KEY.enter);
    await app.waitFor("(3/3) Should it ship behind a flag?");
    await app.press("1", KEY.enter);
    await app.waitFor("keep talking", 20_000);
    await app.idle();
    const spec = specRows(app).join("\n");
    expect(spec).toContain("• Should the fix include a regression test, or just the change? → Add a regression test");
    expect(spec).toContain("• Which tests should cover it? → An end-to-end test");
    expect(spec).toContain("• Should it ship behind a flag? → Yes, behind a flag");
  });

  test("mouse/click-option: a click on an option of the question answers with it, on `keep talking` closes the agent choice, on an agent starts it #BUG-277", async () => {
    // Tall enough that the answer stays on screen under the proposal that comes after it.
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 70 });
    await toQuestion(app);
    // The hint line's row picks nothing.
    app.write(clickOn(app, "enter answers"));
    await app.settle();
    expect(app.screen()).toContain("❯ 1. Add a regression test");
    await app.press(clickOn(app, "Just the fix"));
    await app.waitFor("›  Just the fix", 20_000);
    await app.waitFor("keep talking", 20_000);
    await app.idle();
    await app.press(clickOn(app, "keep talking"));
    await app.waitFor((s) => !s.includes("❯ 1."));
    expect(app.screen()).not.toContain("◆ gluon");
    await app.type("go on");
    await app.press(KEY.enter);
    await app.waitFor("cheaper setup", 20_000);
    await app.waitFor("keep talking", 20_000);
    await app.idle();
    await app.press(clickOn(app, "opencode × deepseek flash"));
    await app.waitFor(STARTED, 20_000);
    expect(app.agentLog()).toContain("FAKE-OPENCODE");
    expect(app.screen()).not.toMatch(/\[<\d/);
  });
});

describe("the chat's text", () => {
  test("intake-chat/working: a git command the intake agent runs is counted in its tool line (issue #17)", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 40 });
    await toQuestion(app, "fix the add bug from its recent history");
    expect(app.screen()).toContain('◇  Listed the repository · searched for "test" · read package.json · ran git log');
  });

  test("markdown/inline: the intake agent's own Markdown shows styled, without its `**`, backtick or `_` markers", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 40 });
    await app.enter("ask me questions about the add bug");
    await app.press(KEY.enter);
    await app.waitFor("(1/3)", 20_000);
    await app.idle();
    const line = "◆  I found the test setup in package.json. A few things I can't tell from the code:";
    expect(app.screen()).toContain(line);
    expect(boldAt(app, "test setup")).toBe(true);
    expect(boldAt(app, "I found")).toBe(false);
  });

  test("markdown/fits: at 60 columns the intake agent's wrapped lines hang under its text, inside the terminal", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 60, rows: 40 });
    await app.enter("ask me questions about the add bug");
    await app.press(KEY.enter);
    await app.waitFor((s) => s.includes("(1/3)"), 20_000);
    await app.idle();
    const at = app.row("◆  I found the test setup");
    expect(at).toBeGreaterThan(0);
    expect(app.lines()[at + 1]).toMatch(/^ {6}\S/);
    expect(app.lines().filter((l) => Bun.stringWidth(l) > 60)).toEqual([]);
  });

  /** A task in Markdown: its first lines are the spec's, so the spec box draws every construct. */
  const MD = [
    "# Fix the add bug",
    "Make **the `add` function** handle _negative_ zero.",
    "- check the inputs",
    "  - both signs, nested under it",
    "1. write the test first",
    "- [ ] keep the old name",
    "> a quote that runs long enough to wrap at narrow widths, and then some more words",
    "---",
    "| case | want |",
    "|---|---|",
    "| -0 + 0 | 0 |",
    "```",
    "const sum = add(-0, 0); // a long line of code that is wrapped at the box, never cut short: END",
    "```",
    "Done.",
  ].join("\n");

  async function toMarkdownSpec(cols: number, rows: number): Promise<App> {
    const app = await start({ cwd: repo.tiny(), cols, rows });
    await app.paste(MD);
    await app.press(KEY.enter);
    await app.waitFor(QUESTION, 20_000);
    await app.idle();
    await app.press("1", KEY.enter);
    await app.waitFor("keep talking", 20_000);
    await app.idle();
    return app;
  }

  test("markdown/blocks: in the spec box a heading, bold code, italic, nested bullets, a numbered item, a task, a quote, a rule, a table and a code block render without their markers, the code wrapped, never cut", async () => {
    const app = await toMarkdownSpec(100, 80);
    const spec = specRows(app).map((l) => l.replace(/^ *│ ?/, "").replace(/ *│$/, ""));
    expect(spec.slice(0, 13)).toEqual([
      "# Fix the add bug",
      "Make the add function handle negative zero.",
      "• check the inputs",
      "   • both signs, nested under it",
      "1. write the test first",
      "☐ keep the old name",
      "│ a quote that runs long enough to wrap at narrow widths, and then some more words",
      expect.stringMatching(/^─{10,}$/),
      "case    want",
      "-0 + 0  0",
      expect.stringMatching(/^const sum = add\(-0, 0\); \/\/ a long line of code .* never cut$/),
      "short: END",
      "Done.",
    ]);
    // Bold code inside bold, styled (markdown/inline).
    expect(boldAt(app, "the add function")).toBe(true);
    expect(app.lines().filter((l) => Bun.stringWidth(l) > 100)).toEqual([]);
  });

  test("markdown/blocks: at 60×24 the Markdown spec is cut to its rows: the box's bottom sits right above the options, pgdn walks every row to `Done when`, the code wrapped, nothing wider than the terminal #BUG-197", async () => {
    const app = await toMarkdownSpec(60, 24);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const ls = app.lines();
      expect(ls.findIndex((l) => l.includes("╰─")) + 1).toBe(ls.findIndex((l) => l.includes("❯ 1.")));
      expect(ls.filter((l) => Bun.stringWidth(l) > 60)).toEqual([]);
      for (const r of specRows(app)) seen.add(r.replace(/^ *│ ?/, "").replace(/ *│$/, "").trim());
      if (app.screen().includes("• the change works and the existing tests pass")) break;
      await app.press(KEY.pgdn);
    }
    expect(app.lines()[app.row("╰─")]).toMatch(/lines above \(pgup\) ─╯$/);
    expect(seen).toContain("Done when");
    expect([...seen].join("\n")).toMatch(/END/);
    expect([...seen].join("\n")).not.toMatch(/\*\*|`|\|---/);
  });
});
