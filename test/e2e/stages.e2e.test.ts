/** C. Keys at each stage of the intake chat: questions, the agent choice, interrupting, quitting. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { repo } from "./fixtures.ts";
import { FULL_PACE, KEY, QUESTION, SLOW, start, stopAll, toProposal, toQuestion } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

describe("question", () => {
  test("question/pick: a digit then Enter answers with that option @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toQuestion(app);
    await app.press("2", KEY.enter);
    await app.waitFor("keep talking", 20_000);
    expect(app.screen()).toContain("›  Just the fix");
  });

  test("question/own-words: an answer that starts with a digit is sent whole @full #BUG-01", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toQuestion(app);
    await app.type("2 tests, one for negatives");
    expect(app.screen()).toMatch(/❯ 3\. type your own answer/);
    await app.press(KEY.enter);
    await app.waitFor("keep talking", 20_000);
    expect(app.screen()).toContain("›  2 tests, one for negatives");
  });

  test("question/pick: ↑ wraps to the last option, ↓ moves down @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toQuestion(app);
    await app.press(KEY.up);
    await app.waitFor(/❯ 3\. type your own answer/);
    await app.press(KEY.down, KEY.down);
    await app.waitFor(/❯ 2\. Just the fix/);
  });

  test("question/own-words: Enter on 'type your own answer' says to type the answer @full #BUG-10", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toQuestion(app);
    await app.press(KEY.up, KEY.enter);
    await app.waitFor("Type your answer below, then press enter");
    expect(app.screen()).toContain(QUESTION);
  });

  test("question/own-words: an out-of-range digit is just text @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toQuestion(app);
    await app.type("9");
    expect(app.screen()).toMatch(/❯ 3\. type your own answer/);
    expect(app.lines().at(-2)).toMatch(/^ {3}› 9/);
  });
});

describe("the agent choice", () => {
  test("agent-choice/typed-reply: a reply that starts with a digit revises instead of launching @full #BUG-01 #BUG-159", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toProposal(app);
    await app.type("1 more thing: use haiku");
    await app.press(KEY.enter);
    await app.waitFor("cheaper setup", 20_000);
    await app.idle();
    expect(app.screen()).not.toContain("◆ gluon");
    expect(app.screen()).toContain("›  1 more thing: use haiku");
  });

  test("agent-choice/typed-reply: with only spaces typed, the highlight and Enter agree @full #BUG-05", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toProposal(app);
    await app.press(KEY.down, KEY.down);
    await app.type("   ");
    await app.waitFor(/❯ 3\. keep talking/);
    await app.press(KEY.enter);
    await app.waitFor("Tell the intake agent what to change, then press enter");
    expect(app.screen()).not.toContain("◆ gluon");
  });

  test("agent-choice/keep-talking: keep talking + Enter says to type the change; the choice closes @full #BUG-10", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50 });
    await toProposal(app);
    await app.press("3", KEY.enter);
    await app.waitFor("Tell the intake agent what to change, then press enter");
    expect(app.screen()).not.toContain("❯ 1.");
    expect(app.screen().replace(/\s+/g, " ")).toContain("I'd start it with: claude code × sonnet 5.5 × high");
  });

  test("agent-choice/typed-reply: a typed reply gets a revised proposal @full", async () => {
    // Tall enough for both proposals with the revised one's spec box open (BUG-197).
    const app = await start({ cwd: repo.tiny(), rows: 80 });
    await toProposal(app);
    await app.type("cheaper please");
    await app.press(KEY.enter);
    await app.waitFor("❯ 1. opencode × deepseek flash × max", 20_000);
    await app.idle();
    expect(app.screen().replace(/\s+/g, " ").match(/I'd start it with/g)).toHaveLength(2);
  });
});

describe("interrupting", () => {
  test("intake-chat/interrupt: esc interrupts the intake agent, and the chat continues @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 50, env: FULL_PACE });
    await app.type("fix the add bug");
    await app.press(KEY.enter);
    await app.waitFor("esc to interrupt");
    await app.press(KEY.esc);
    await app.waitFor("Interrupted — tell the intake agent what to do instead.");
    await app.idle();
    await app.type("go on");
    await app.press(KEY.enter);
    await app.waitFor(/Should the fix include|keep talking/, 20_000);
  });
});

describe("ctrl+c (BUG-20)", () => {
  test("home/quit: ctrl+c clears the draft first, then asks, then quits with 130 and leaves no live UI @full #BUG-20", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("some draft");
    await app.press(KEY.ctrlC);
    // The redraw may come a frame after the key: wait for it rather than read at once.
    await app.waitFor("› describe the session you want");
    await app.press(KEY.ctrlC);
    await app.waitFor("Press ctrl+c again to quit");
    await app.press(KEY.ctrlC);
    expect(await app.exitCode()).toBe(130);
    await app.settle();
    expect(app.screen()).not.toContain("describe the session");
    expect(app.screen()).not.toContain("ctrl+c");
  });

  test("intake-chat/interrupt: ctrl+c interrupts the intake agent while it works instead of quitting #BUG-20", async () => {
    const app = await start({ cwd: repo.tiny(), env: FULL_PACE });
    await app.type("fix it");
    await app.press(KEY.enter);
    await app.settle(300);
    await app.press(KEY.ctrlC);
    await app.waitFor("Interrupted");
    expect(await app.exitCode(300)).toBeNull();
  });

  test("home/quit: the terminal is restored after quitting", async () => {
    const app = await start({ cwd: repo.tiny() });
    app.mark();
    await app.press(KEY.ctrlC, KEY.ctrlC);
    expect(await app.exitCode()).toBe(130);
    const out = app.since();
    expect(out).toContain("\x1b[?25h");
    expect(out).toContain("\x1b[?2004l");
    expect(out).toContain("\x1b[?1049l");
  });
});
