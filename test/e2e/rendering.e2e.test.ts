/** E. What the screen shows: layout at every width, no full-screen redraws, the chat's items. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { repo } from "./fixtures.ts";
import { KEY, QUESTION, SLOW, start, stopAll, toProposal, toQuestion } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

const CTRL_O = "\x0f";
const PG_DN = "\x1b[6~";

describe("layout", () => {
  const flowFits = async (cols: number) => {
    const app = await start({ cwd: repo.tiny(), cols, rows: 60 });
    await toProposal(app);
    for (const line of app.lines()) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
    expect(app.screen()).toContain("keep talking");
  };
  test.each([40, 60, 80, 120])("E1/E2: the whole flow fits in %i columns @full", flowFits);

  test("BUG-03: at 80×24 the agent choice shows its lead, the agent triples and keep talking @full", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 80, rows: 24 });
    await toProposal(app);
    const s = app.screen();
    expect(s).toContain("I'd start it with:");
    expect(s).toContain("❯ 1. claude code × sonnet 5.5 × high · recommended");
    expect(s).toContain("3. keep talking");
    expect(s).toContain("enter starts the session");
  });

  test("BUG-39: the user message's bar spans the full width", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("fix the add bug");
    await app.press(KEY.enter);
    await app.settle(300);
    const y = app.row("›  fix the add bug");
    expect(app.bg(2, y)).toBe("#1a1c22");
    expect(app.bg(77, y)).toBe("#1a1c22");
  });

  test("BUG-41: a wrapped option hangs under its text, not under the ❯", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 30, rows: 50 });
    await toQuestion(app);
    const y = app.row("❯ 1.");
    const label = app.lines()[y]!.indexOf("Add");
    expect(app.lines()[y + 1]).toMatch(new RegExp(`^ {${label}}\\S`));
  });
});

describe("no full-screen redraws (BUG-04)", () => {
  test("keys at a proposal on 80×24 @full", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 80, rows: 24 });
    await toProposal(app);
    app.mark();
    await app.press(KEY.down);
    await app.type("abc");
    expect(app.clears()).toEqual({ screen: 0, scrollback: 0 });
  });

  test("a turn on a 10-row terminal @full", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 80, rows: 10 });
    await app.type("fix the add bug");
    await app.press(KEY.enter);
    app.mark();
    await app.waitFor("type your own answer", 20_000);
    await app.press(KEY.down);
    expect(app.clears()).toEqual({ screen: 0, scrollback: 0 });
    // The composer is still there (BUG-162).
    expect(app.lines().at(-2)).toMatch(/^ {3}› /);
  });
});

describe("the chat's items", () => {
  test("BUG-43/BUG-44: the whole spec shows; ctrl+o folds it to one line, and shows it again @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 60 });
    await toProposal(app);
    let s = app.screen();
    expect(s).toContain("ctrl+o to hide");
    expect(s).toMatch(/│ Fix the add bug\./);
    expect(s).toContain("│ Relevant files");
    await app.press(CTRL_O);
    await app.waitFor("spec: Fix the add bug.  (ctrl+o to view)");
    expect(app.screen()).not.toContain("│ Relevant files");
    await app.press(CTRL_O);
    await app.waitFor("ctrl+o to hide");
    s = app.screen();
    expect(s).toContain("│ Relevant files");
  });

  test("BUG-197/C: at 80×24 the spec is above the agents, readable without ctrl+o; cut to fit, the agents stay, pgdn shows the rest @full", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 80, rows: 24 });
    await toProposal(app);
    const row = (needle: string) => app.lines().findIndex((l) => l.includes(needle));
    expect(row("╭─ spec — what the agent will get")).toBeGreaterThan(row("I'd start it with:"));
    expect(app.screen()).toMatch(/│ Fix the add bug\. +│/);
    expect(app.screen()).toContain("│ Relevant files");
    // The demo's spec is taller than the rows left: cut, with what's left out on its last line.
    expect(app.lines()[row("╰─")]).toMatch(/… \d+ more lines \(pgdn\) ─╯/);
    expect(row("╰─")).toBeLessThan(row("❯ 1. claude code × sonnet 5.5 × high · recommended"));
    expect(app.screen()).toContain("3. keep talking");
    expect(app.screen()).toContain("enter starts the session");
    expect(app.screen()).not.toContain("Done when");
    for (let i = 0; i < 5 && !app.screen().includes("Done when"); i++) await app.press(PG_DN);
    expect(app.screen()).toContain("Done when");
    expect(app.lines()[row("╰─")]).toMatch(/lines above \(pgup\)/);
    expect(app.screen()).toContain("3. keep talking");
    for (const line of app.lines()) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  });

  test("BUG-47: the demo's spec is built from the task and the repo @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 60 });
    await toProposal(app, "make mul handle negative zero");
    await app.waitFor("ctrl+o to hide");
    const s = app.screen();
    expect(s).toContain("│ Make mul handle negative zero.");
    expect(s).toContain("src/math.ts");
    expect(s).not.toContain("login");
  });

  test("BUG-36: a failed tool call shows in the tool line @full", async () => {
    const app = await start({ cwd: repo.noGit(), rows: 50, cols: 100 });
    await toQuestion(app);
    expect(app.screen()).toMatch(/◇ +Listed the repository · searched for "test" · read package\.json · 1 failed/);
  });

  test("BUG-19: once the intake agent speaks, its tools show as one done line @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toQuestion(app);
    expect(app.screen()).toMatch(/◇ +Listed the repository · /);
    expect(app.screen()).not.toContain("Exploring");
  });

  test("E10: the answered question stays in the chat, then the answer @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toQuestion(app);
    await app.press(KEY.enter);
    await app.waitFor("keep talking", 20_000);
    const s = app.screen();
    expect(s).toContain(`◆  ${QUESTION}, or just the change?`);
    expect(s.indexOf("›  Add a regression test")).toBeGreaterThan(s.indexOf(QUESTION));
  });
});
