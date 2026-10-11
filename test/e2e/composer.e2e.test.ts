/** B. The composer: typing, editing keys, paste, batched input. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { repo } from "./fixtures.ts";
import { assertInvariants } from "./gluon-invariants.ts";
import { type App, FULL_PACE, KEY, QUESTION, SLOW, start, stopAll } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

/** The composer's text rows, between its two rules at the bottom (the 3-column margin dropped: `› …`, then `  …`). */
const draftLines = (screen: string) => {
  const lines = screen.split("\n");
  const end = lines.length - 1;
  const start = lines.slice(0, end).findLastIndex((l) => /^ {2}─+/.test(l));
  return lines.slice(start + 1, end).map((l) => l.slice(3).trimEnd());
};

/** The character under the composer's own cursor (drawn inverse), or null. */
function cursorChar(app: App): string | null {
  const buf = app.term.buffer.active;
  for (let y = app.term.rows - 1; y >= 0; y--) {
    const line = buf.getLine(buf.viewportY + y);
    for (let x = 0; line && x < app.term.cols; x++) {
      const c = line.getCell(x);
      if (c?.isInverse()) return c.getChars() || " ";
    }
  }
  return null;
}

/** The composer shows exactly these rows: waits for them (a loaded machine redraws late), then checks. */
async function expectDraft(app: App, rows: string[]) {
  const same = (s: string) => JSON.stringify(draftLines(s)) === JSON.stringify(rows);
  await app.waitFor(same, 3000).catch(() => {});
  expect(draftLines(app.screen())).toEqual(rows);
}

describe("editing", () => {
  test("composer/editing: typing, backspace, arrows, home/end, ctrl+a/e/u/w edit at the cursor @full", async () => {
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

  test("composer/editing: Delete removes the character after the cursor #BUG-13", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("Xhello worldY");
    await app.press(KEY.left, KEY.left, KEY.left, KEY.delete);
    await expectDraft(app, ["› Xhello wordY"]);
  });

  test("composer/graphemes: the cursor and backspace treat an emoji as one character #BUG-12", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("ab😀cd");
    await app.press(KEY.left, KEY.left, KEY.backspace);
    await expectDraft(app, ["› abcd"]);
    expect(app.screen()).not.toContain("�");
  });

  test("composer/newline: alt+enter and ctrl+j add lines; ↑/↓ move between them #BUG-14 @full", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("line one");
    await app.press(KEY.altEnter);
    await app.type("line two");
    await app.press(KEY.ctrlJ);
    await app.type("three");
    await app.press(KEY.up, KEY.up, "^", KEY.down, KEY.down, KEY.end, "$");
    await expectDraft(app, ["› line ^one", "  line two", "  three$"]);
  });

  test("composer/esc-esc-clears: esc keeps the draft; a second esc clears it #BUG-15 @full", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("a long message");
    await app.press(KEY.esc);
    // An Esc is held a moment (it may start a late OSC reply): wait for it.
    await app.waitFor("Press esc again to clear the draft", 3000);
    expect(app.screen()).toContain("› a long message");
    await app.press(KEY.esc);
    await app.waitFor("› describe the session you want", 3000);
  });

  test("composer/wrap: a draft wraps at words, a word longer than a row is broken there; the cursor and an insert stay where the user types #BUG-266/GLUON-48", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 40 });
    const draft = "fix the flaky test in the parser module so that it passes on every run of the suite";
    await app.enter(draft);
    const rows = () => draftLines(app.screen()).map((l) => l.replace(/^(› | {2})/, ""));
    await app.waitFor(() => rows().join(" ") === draft, 3000);
    // Every row ends at a word's end and the next starts a word: the words in order, none split.
    expect(rows().length).toBeGreaterThan(1);
    expect(rows().join(" ").split(/ +/)).toEqual(draft.split(" "));
    for (const r of rows()) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(40 - 5);
    assertInvariants(app, { view: "home" });
    // The cursor after the last word; three ← put it on the `i` of `suite`, and an insert lands there, by grapheme.
    expect(cursorChar(app)).toBe(" ");
    await app.press(KEY.left, KEY.left, KEY.left);
    expect(cursorChar(app)).toBe("i");
    await app.enter("👍🏽");
    await app.waitFor(() => rows().join(" ").includes("of the su👍🏽ite"), 3000);
    // A word longer than a row is cut where the row ends; nothing is lost.
    await app.press(KEY.ctrlE, KEY.ctrlU);
    app.resize(30, 30);
    const word = "x".repeat(60);
    await app.enter(`see ${word}`);
    await app.waitFor(() => rows()[0] === "see" && rows().slice(1).join("") === word, 3000);
    assertInvariants(app, { view: "home" });
  });

  test("intake-chat/send: an empty or whitespace-only draft sends nothing", async () => {
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

  test("composer/paste: pasted code keeps its indentation and tabs don't break the layout #BUG-16 #BUG-17 #BUG-48", async () => {
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

  test("composer/tall-draft: a huge paste is capped in the composer around the cursor, saying how many more lines, and typing doesn't redraw the world #BUG-04", async () => {
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

  test("composer/paste: a paste drops escape sequences and control characters as typing does, keeps its line breaks (CRLF and CR too) and tabs, and never sends by itself #BUG-722", async () => {
    // Tall enough that the sent line stays on screen when the question comes after it.
    const app = await start({ cwd: repo.tiny(), cols: 60, rows: 60 });
    await app.paste("a\x1cb\x00\x7f\x1b[Ac");
    await expectDraft(app, ["› abc"]);
    expect(app.screen()).not.toContain("›  abc");
    await app.press(KEY.enter);
    await app.waitFor("›  abc");
    await app.paste("one\r\n\ttwo\rthree");
    await expectDraft(app, ["› one", "      two", "  three"]);
  });
});

describe("batched input", () => {
  test("composer/batched-keys: keys that arrive in one read still submit #BUG-06", async () => {
    const app = await start({ cwd: repo.tiny(), env: FULL_PACE });
    app.write("fix it\r");
    await app.waitFor("esc to interrupt");
  });

  test("composer/batched-keys: control keys in one read act as keys, not text #BUG-06", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("hello");
    app.write("\x15abc\x01X");
    await app.settle(300);
    await expectDraft(app, ["› Xabc"]);
  });

  test("composer/batched-keys: a double Enter sends once @full", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("fix it");
    app.write("\r\r");
    await app.waitFor(QUESTION, 20_000);
    expect(app.screen().match(/›  fix it/g)).toHaveLength(1);
  });
});

describe("while the intake agent works", () => {
  test("intake-chat/queue: Enter while working queues the message on screen; it isn't sent during the turn #BUG-11", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 40, env: FULL_PACE });
    await app.type("fix");
    await app.press(KEY.enter);
    await app.type("also check mul");
    await app.press(KEY.enter);
    // Wait for the redraw: a loaded runner can be slower than the key round-trip.
    await app.waitFor("› also check mul · queued:");
  });

  test("intake-chat/queue: esc cancels a queued message before it interrupts the intake agent; a second esc interrupts it, the message never sent #BUG-716", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 40, env: FULL_PACE });
    await app.enter("fix");
    await app.press(KEY.enter);
    await app.waitFor("esc to interrupt");
    await app.enter("also check mul");
    await app.press(KEY.enter);
    await app.waitFor("queued: sent when the intake agent is done");
    await app.press(KEY.esc);
    await app.waitFor((x) => !x.includes("queued:"), 3000);
    expect(app.screen()).toContain("esc to interrupt");
    expect(app.screen()).not.toContain("Interrupted");
    await app.press(KEY.esc);
    await app.waitFor("Interrupted — tell the intake agent what to do instead.");
    expect(app.screen()).not.toContain("›  also check mul");
  });

  test("intake-chat/queue: a question at the turn's end keeps the queued message, says Enter sends it as the answer, and only Enter sends it #BUG-716", async () => {
    // A third of the demo's pace: a turn long enough to queue in, short enough for the fast tier.
    const app = await start({ cwd: repo.tiny(), rows: 40, env: { GLUON_TEST_DEMO_PACE: "0.3" } });
    await app.enter("fix the add bug");
    await app.press(KEY.enter);
    await app.waitFor("esc to interrupt");
    await app.enter("the second one");
    await app.press(KEY.enter);
    await app.waitFor("queued:");
    await app.waitFor((x) => x.includes(QUESTION) && x.includes("queued: enter sends it as your answer"), 10_000);
    expect(app.screen()).not.toContain("›  the second one");
    await app.press(KEY.enter);
    await app.waitFor("›  the second one");
    expect(app.screen()).not.toContain("queued:");
    const s = app.screen();
    expect(s.indexOf("›  the second one")).toBeGreaterThan(s.indexOf(QUESTION));
  });

  test("intake-chat/queue: a draft left over when a question arrives is flagged, not silently re-targeted #BUG-11 @full", async () => {
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
});
