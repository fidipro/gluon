/** B. The composer: typing, editing keys, paste, batched input. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { repo } from "./fixtures.ts";
import { type App, FULL_PACE, KEY, QUESTION, SLOW, start, stopAll, toQuestion } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

/** The composer's text rows, between its two rules at the bottom (the 3-column margin dropped: `› …`, then `  …`). */
const draftLines = (screen: string) => {
  const lines = screen.split("\n");
  const end = lines.length - 1;
  const start = lines.slice(0, end).findLastIndex((l) => /^ {2}─+/.test(l));
  return lines.slice(start + 1, end).map((l) => l.slice(3).trimEnd());
};

/** The composer shows exactly these rows: waits for them (a loaded machine redraws late), then checks. */
async function expectDraft(app: App, rows: string[]) {
  const same = (s: string) => JSON.stringify(draftLines(s)) === JSON.stringify(rows);
  await app.waitFor(same, 3000).catch(() => {});
  expect(draftLines(app.screen())).toEqual(rows);
}

describe("editing", () => {
  test("B1-B6: typing, backspace, arrows, home/end, ctrl+a/e/u/w @full", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("hello world");
    await app.press(KEY.backspace, KEY.left, KEY.left, "X");
    await app.press(KEY.ctrlA, "[", KEY.ctrlE, "]");
    await expectDraft(app, ["› [hello woXrl]"]);
    await app.press(KEY.ctrlW);
    await expectDraft(app, ["› [hello"]);
    await app.press(KEY.home, "<", KEY.end, ">");
    await app.press(KEY.left, KEY.ctrlU);
    await expectDraft(app, ["› >"]);
  });

  test("BUG-13: Delete removes the character after the cursor", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("Xhello worldY");
    await app.press(KEY.left, KEY.left, KEY.left, KEY.delete);
    await expectDraft(app, ["› Xhello wordY"]);
  });

  test("BUG-12: the cursor and backspace treat an emoji as one character", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("ab😀cd");
    await app.press(KEY.left, KEY.left, KEY.backspace);
    await expectDraft(app, ["› abcd"]);
    expect(app.screen()).not.toContain("�");
  });

  test("B8/BUG-14: alt+enter adds lines; ↑/↓ move between them @full", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("line one");
    await app.press(KEY.altEnter);
    await app.type("line two");
    await app.press(KEY.altEnter);
    await app.type("three");
    await app.press(KEY.up, KEY.up, "^", KEY.down, KEY.down, KEY.end, "$");
    await expectDraft(app, ["› line ^one", "  line two", "  three$"]);
  });

  test("BUG-15: esc keeps the draft; a second esc clears it @full", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("a long message");
    await app.press(KEY.esc);
    // An Esc is held a moment (it may start a late OSC reply): wait for it.
    await app.waitFor("Press esc again to clear the draft", 3000);
    expect(app.screen()).toContain("› a long message");
    await app.press(KEY.esc);
    await app.waitFor("› describe the session you want", 3000);
  });

  test("B11: an empty or whitespace-only draft sends nothing", async () => {
    const app = await start({ cwd: repo.tiny(), env: FULL_PACE });
    await app.press(KEY.enter);
    await app.type("   ");
    await app.press(KEY.enter);
    await app.settle(500);
    expect(app.screen()).not.toContain("esc to interrupt");
    expect(app.screen()).toContain("› describe the session you want");
  });
});

describe("paste", () => {
  const code = "def f(x):\r\n    if x:\r\n\treturn 1\r\n    return 2";

  test("BUG-16/17/48: pasted code keeps its indentation and tabs don't break the layout", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 60, env: FULL_PACE });
    await app.paste(code);
    await expectDraft(app, ["› def f(x):", "      if x:", "      return 1", "      return 2"]);
    await app.press(KEY.enter);
    await app.waitFor("esc to interrupt");
    const h = app.screen();
    // The user's line in the chat, hanging under its text (4 columns after the margin).
    expect(h).toContain("   ›  def f(x):\n          if x:\n          return 1\n          return 2");
    // One blank row above the message, as for any chat item (BUG-48).
    expect(h).toMatch(/─\n *\n {3}›  def f/);
  });

  test("B17/BUG-04: a huge paste is capped in the composer and typing doesn't redraw the world", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 12 });
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}: lorem ipsum dolor sit amet`).join("\n");
    await app.paste(big);
    // Windows' ConPTY takes a few seconds to pass 120 KB of input.
    await app.waitFor((s) => /↑ \d+ more lines/.test(s) && s.includes("line 2999"), 20_000);
    await app.settle(500);
    app.mark();
    await app.press("x");
    await app.settle(300);
    expect(app.clears()).toEqual({ screen: 0, scrollback: 0 });
    expect(app.since().length).toBeLessThan(5000);
  });
});

describe("batched input", () => {
  test("BUG-06: keys that arrive in one read still submit", async () => {
    const app = await start({ cwd: repo.tiny(), env: FULL_PACE });
    app.write("fix it\r");
    await app.waitFor("esc to interrupt");
  });

  test("BUG-06/B20: control keys in one read act as keys, not text", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("hello");
    app.write("\x15abc\x01X");
    await app.settle(300);
    await expectDraft(app, ["› Xabc"]);
  });

  test("B23: a double Enter sends once @full", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("fix it");
    app.write("\r\r");
    await app.waitFor(QUESTION, 20_000);
    expect(app.screen().match(/›  fix it/g)).toHaveLength(1);
  });
});

describe("while the intake agent works", () => {
  test("B21/BUG-11: Enter while working queues the message on screen; it isn't sent during the turn", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 40, env: FULL_PACE });
    await app.type("fix");
    await app.press(KEY.enter);
    await app.type("also check mul");
    await app.press(KEY.enter);
    // Wait for the redraw: a loaded runner can be slower than the key round-trip.
    await app.waitFor("› also check mul · queued:");
  });

  test("C20/BUG-11: a draft left over when a question arrives is flagged, not silently re-targeted @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 40, env: FULL_PACE });
    await app.type("fix");
    // Enter and the next draft at once: on a loaded test run, awaiting between them can let the
    // demo brain's question arrive first.
    app.write("\r");
    app.write("also check mul");
    // The note is set by an effect after the question renders: wait for both, not the first frame.
    await app.waitFor((s) => s.includes(QUESTION) && s.includes("Your draft is still below"), 20_000);
    expect(app.screen()).toContain("also check mul");
  });

  test("placeholder after a question: typing a digit only highlights, Enter picks it @full", async () => {
    const app = await start({ cwd: repo.tiny() });
    await toQuestion(app);
    await app.type("2");
    await app.waitFor(/❯ 2\. Just the fix/);
    await app.press(KEY.enter);
    await app.waitFor("keep talking", 20_000);
    // The spec box (open by default) can fill the chat at this size: folded, the answer shows.
    await app.press("\x0f");
    await app.waitFor("(ctrl+o to view)");
    await app.waitFor("›  Just the fix");
  });
});
