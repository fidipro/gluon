import { describe, expect, test } from "bun:test";
import type { Harness } from "../src/harnesses.ts";
import { READERS } from "../src/pty/readers/index.ts";
import { createScreen } from "../src/pty/screen.ts";
import { fixture, screenOf } from "./fixtures/screens.ts";

/** state → [input line, highlighted menu item], as the real harness showed them. */
const EXPECTED: Partial<Record<Harness, Record<string, [string | null, string | null]>>> = {
  "claude-code": {
    idle: ["", null],
    hello: ["hello world", null],
    slash: ["/", "/add-dir"],
    cl: ["/cl", "/clear"],
    "cl-tab": ["/clear", null], // the grey "[name]" hint after the cursor is not input
    c: ["/c", "/cd"],
    "c-down1": ["/c", "/copy"],
    "c-down2": ["/c", "/clear"],
    "c-down3": ["/c", "/color"],
    "c-up1": ["/c", "/clear"],
    comp: ["/comp", "/compact"],
    compact: ["/compact", "/compact"],
    "compact-args": ["/compact focus on x", null],
    clear: ["/clear", "/clear"],
    "clear-edited": ["/clear", "/clear"],
    help: ["/help", "/help"],
    new: ["/new", "/clear"], // shown as "/clear (new)"
    // BUG-244: 2.1.288's first-run "trust this folder" question inside Gluon's frame: no input box.
    "frame-trust-dialog": [null, null],
    // 2.1.291, text-only captures: Esc cut a turn off (the idle empty box), and the context window full while PreCompact runs.
    "frame-interrupted": ["", null],
    "frame-precompact": ["", null],
  },
  codex: {
    idle: ["", null], // the faint placeholder is not input
    hello: ["hello world", null],
    slash: ["/", "/model"],
    cl: ["/cl", "/clear"],
    "cl-tab": ["/clear", null],
    c: ["/c", "/compact"],
    "c-down1": ["/c", "/copy"],
    "c-down2": ["/c", "/cd"],
    "c-down3": ["/c", "/clear"],
    "c-up1": ["/c", "/cd"],
    comp: ["/comp", "/compact"],
    compact: ["/compact", "/compact"],
    "compact-args": ["/compact focus on x", null],
    clear: ["/clear", "/clear"],
    "clear-edited": ["/clear", "/clear"],
    help: ["/help", null],
    new: ["/new", "/new"],
    // BUG-191: inside Gluon's frame (98x24) after a turn, while one runs, and with no OSC 11 answer
    // (no shading: the composer is the cursor's row alone).
    "frame-turn-idle": ["", null],
    "frame-turn-clear": ["/clear", "/clear"],
    "frame-turn-cl-tab": ["/clear", null],
    "frame-turn-c-down3": ["/c", "/clear"],
    "frame-turn-new": ["/new", "/new"],
    "frame-working-clear": ["/clear", "/clear"], // the status row and "tab to queue message"
    "frame-plain-clear": ["/clear", "/clear"],
    "frame-plain-cl-tab": ["/clear", null],
    // Issue #40: Codex's own dialogs, where it waits for a pick: no composer, so no input line and no menu
    // (a question's notes box has a `› ` row, but indented two spaces: not the composer).
    "frame-folder-trust": [null, null],
    "frame-hook-review": [null, null],
    "frame-hook-list": [null, null],
    "frame-hook-detail": [null, null],
    "frame-hook-list-trusted": [null, null],
    "frame-approve-command": [null, null],
    "frame-approve-patch": [null, null],
    "frame-plan-question": [null, null],
    "frame-plan-question-notes": [null, null],
    "frame-model-picker": [null, null],
    // Launch modes: Codex 0.160.0 at 120x40 after a turn, in Plan mode and in default mode (empty composer, the footer below it).
    "plan-mode-idle": ["", null],
    "default-mode-idle": ["", null],
  },
  opencode: {
    idle: ["", null], // the muted placeholder is not input
    hello: ["hello world", null],
    slash: ["/", "/agents"],
    cl: ["/cl", "/clear"],
    "cl-tab": ["", null], // Tab ran /clear
    c: ["/c", "/cd"],
    "c-down1": ["/c", "/clear"],
    "c-down2": ["/c", "/connect"],
    "c-down3": ["/c", "/continue"],
    "c-up1": ["/c", "/connect"],
    comp: ["/comp", "/review"], // no /compact outside a session: a fuzzy match
    compact: ["/compact", "/review"],
    "compact-args": ["/compact focus on x", null],
    clear: ["/clear", "/clear"],
    "clear-edited": ["/clear", "/clear"],
    help: ["/help", "/help"],
    new: ["/new", "/new"],
  },
  "grok-build": {
    idle: ["", null], // the start screen (logo animating) with the box at the bottom; no placeholder
    "idle-cleared": ["", null], // after a key: the session layout, a hint row under the box
    hello: ["hello world", null],
    // Words wrap onto continuation rows (`│   …`), one more row per wrap, a long word by characters.
    long: ["compact keep the parser changes, the failing tests and the open questions about the screen readers and also\nthe whole story of the wrapped composer line please", null],
    longer: [`compact keep the parser changes, the failing tests and the open questions about the screen readers and also\nthe whole story of the wrapped composer line please\n${"x".repeat(110)}\n${"x".repeat(90)}`, null],
    slash: ["/", "/quit"], // `/quit` first, 93 matches
    c: ["/c", "/clear"], // the grey ghost `lear` after the typed `/c` is not input
    cl: ["/cl", "/clear"],
    "cl-tab": ["/clear", "/clear"], // Tab completed it: a one-item panel
    "c-down3": ["/c", "/compact-mode"], // the composer previews the highlighted item, in grey
    "c-up1": ["/c", "/compact"],
    comp: ["/comp", "/compact"],
    compact: ["/compact", "/compact"],
    "compact-args": ["/compact focus on x", null],
    clear: ["/clear", "/clear"],
    "clear-edited": ["/clear", "/clear"],
    help: ["/help", "/help"],
    new: ["/new", "/new"],
    "cle-esc": ["/cle", null], // Esc closed the menu and kept the input (and its ghost `ar`)
    pl: ["/pl", "/plan"],
    plan: ["/plan", "/plan"],
    "plan-line": ["/plan Read the session brief in /tmp/x/session.md and start.", null],
    // Launch modes: `/plan` + Enter on Grok Build 1.0.46; the box's bottom border says ` · plan`.
    "plan-mode": ["", null],
    "plan-mode-hello": ["hello world", null],
    "mode-auto-review": ["", null],
    "explore-idle": ["", null], // --sandbox read-only: the header says so once the session layout shows
    "explore-hello": ["hello world", null],
    "explore-plan": ["", null],
    // Gluon's frame interior (98x24).
    "frame-idle": ["", null],
    "frame-long": ["compact keep the parser changes, the failing tests and the open questions about the\nscreen readers and also the story", null],
    "frame-plan": ["/plan", "/plan"],
    "frame-plan-mode": ["", null],
    "frame-plan-mode-hello": ["hello", null],
  },
  antigravity: {
    idle: ["", null], // no placeholder; the "? for shortcuts" hint is below the box
    hello: ["hello world", null],
    slash: ["/", "/add-dir"],
    cl: ["/cl", "/clear"],
    "cl-tab": ["/clear", null], // Tab completed it and closed the menu
    c: ["/c", "/changelog"],
    "c-down1": ["/c", "/clear"],
    "c-down2": ["/c", "/codesearch"], // shown as "/codesearch (cs)"
    "c-down3": ["/c", "/config"], // the menu scrolled: "↑ 1 more" above the items
    "c-up1": ["/c", "/codesearch"],
    comp: ["/comp", null], // "No matches": agy has no /compact
    compact: ["/compact", null],
    "compact-args": ["/compact focus on x", null],
    // agy word-wraps long input itself onto a row indented two spaces
    "compact-long": ["/compact keep the parser changes, the failing tests and the open questions about the screen\nreaders", null],
    clear: ["/clear", "/clear"],
    "clear-edited": ["/clear", "/clear"],
    help: ["/help", "/help"],
    new: ["/new", "/clear"], // shown as "/clear (new)"
    "cle-esc": ["/cle", null], // Esc closed the menu and kept the input
  },
  // Kimi Code 2.1.1: the menu is a panel below the composer (`→` marks the item, an alias in parentheses); the grey hint after a whole command is not input.
  "kimi-code": {
    idle: ["", null],
    hello: ["hello world", null],
    long: ["compact keep the parser changes, the failing tests and the open questions about the screen readers and also\nthe whole story of the wrapped composer line please", null],
    slash: ["/", "/yolo"],
    c: ["/c", "/compact"],
    cl: ["/cl", "/clear"], // the item is `new (clear)`: the alias the typed text begins
    "cl-tab": ["/new", null], // Tab writes the canonical name; nothing runs
    "c-down3": ["/c", "/custom-theme"],
    "c-up1": ["/c", "/check-kimi-code-docs"],
    comp: ["/comp", "/compact"],
    compact: ["/compact", "/compact"], // the grey `<instruction>` hint after it is not input
    "compact-args": ["/compact focus on x", null],
    clear: ["/clear", "/clear"],
    "clear-edited": ["/clear", "/clear"],
    help: ["/help", "/help"],
    new: ["/new", "/new"],
    "cle-esc": ["/cle", null],
    pl: ["/pl", "/plan"],
    plan: ["/plan", "/plan"],
    "plan-flag-idle": ["", null],
    "frame-idle": ["", null],
    "frame-long": ["compact keep the parser changes, the failing tests and the open questions about the\nscreen readers and also the whole story", null],
    "frame-cl": ["/cl", "/clear"],
    "frame-clear": ["/clear", "/clear"],
    "frame-cl-tab": ["/new", null],
    "frame-c-down3": ["/c", "/custom-theme"],
    "frame-compact": ["/compact", "/compact"],
    "frame-new": ["/new", "/new"],
    // The folder-trust question (a first start in a folder): no composer.
    "frame-trust-dialog": [null, null],
    // Plan mode's approval question (text-only capture of 2.1.1): no composer.
    "frame-plan-approval": [null, null],
    // Kimi's other selection prompts (text-only captures of 2.1.1): the plan with alternatives, a command to approve (also wrapped): no composer.
    "frame-plan-alternatives": [null, null],
    "frame-cmd-approval": [null, null],
    "frame-cmd-approval-wrapped": [null, null],
    "frame-question-panel": [null, null],
    "frame-question-panel-wrapped": [null, null],
    "frame-question-panel-described": [null, null],
    "frame-question-streaming": ["", null],
    "frame-explore-idle": ["", null],
    // BUG-674/F04 (text-only captures of 2.1.1): the composer drawn before Kimi has its model, with Gluon's brief typed into it, with the banner and footer, and the error that followed.
    "frame-early-composer": ["", null],
    "frame-early-composer-typed": ["Read the session brief in /tmp/gluon-spec-twsHv1/session.md and start.", null],
    "frame-ready-composer": ["", null],
    "frame-llm-not-set": ["", null],
  },
};

for (const [harness, states] of Object.entries(EXPECTED) as [Harness, Record<string, [string | null, string | null]>][]) {
  describe(`${harness} reader`, () => {
    const f = fixture(harness);
    test(`covers every captured state of ${harness} ${f.version}`, () => {
      expect(f.states.map((s) => s.name).sort()).toEqual(Object.keys(states).sort());
    });
    for (const [name, [input, selected]] of Object.entries(states))
      test(`${name.startsWith("frame-") ? "BUG-191: " : ""}${name}: input ${JSON.stringify(input)}, menu ${selected}`, async () => {
        const screen = await screenOf(f, name);
        expect(READERS[harness].inputLine(screen)).toBe(input);
        expect(READERS[harness].selectedCommand(screen)).toBe(selected);
        screen.dispose();
      });
    test("a blank screen: no input box, no menu", () => {
      const screen = createScreen(f.cols, f.rows);
      expect(READERS[harness].inputLine(screen)).toBeNull();
      expect(READERS[harness].selectedCommand(screen)).toBeNull();
    });
  });
}

test("BUG-244/GLUON-40: Claude Code's own dialog waiting for a pick (the first run's trust question) is read as such; no other captured screen is", async () => {
  const f = fixture("claude-code");
  const waiting: string[] = [];
  for (const st of f.states) {
    const screen = await screenOf(f, st);
    if (READERS["claude-code"].awaitsChoice?.(screen)) waiting.push(st.name);
    screen.dispose();
  }
  expect(waiting).toEqual(["frame-trust-dialog"]);
  // Without the footer, or without an option row above it: not a dialog.
  for (const drawn of [" ❯ No, exit\r\n   Yes, I trust this folder", " Enter to confirm · Esc to cancel\r\n ❯ No, exit"]) {
    const s = createScreen(40, 5);
    await s.write(drawn);
    expect(READERS["claude-code"].awaitsChoice?.(s)).toBe(false);
    s.dispose();
  }
});

// QA-live-01 / F10: Claude Code sends no hook when Esc cuts a turn off; its own row says so (`interrupted`, display only).
test("BUG-609/QA-live-01: Claude Code's `Interrupted · What should Claude do instead?` as the last transcript row above the idle input box is read; no other captured screen is", async () => {
  const r = READERS["claude-code"];
  const f = fixture("claude-code");
  const cut: string[] = [];
  for (const st of f.states) {
    const screen = await screenOf(f, st);
    if (r.interrupted?.(screen)) cut.push(st.name);
    screen.dispose();
  }
  // `frame-precompact` has `Context limit reached` in its history, with newer turns under it: history, not the end.
  expect(cut).toEqual(["frame-interrupted"]);
  const rule = "─".repeat(40);
  const input = `${rule}\r\n❯ \r\n${rule}\r\n  ⏸ manual mode on · ? for shortcuts`;
  // Claude draws a no-break space after the `⎿` (as the captures have it); two plain spaces read the same.
  const INTERRUPTED = "  ⎿ \u00a0Interrupted · What should Claude do instead?";
  const LIMIT = "  ⎿ \u00a0Context limit reached · /compact or /clear to continue";
  for (const [drawn, expected] of [
    [`❯ Write an essay\r\n${INTERRUPTED}\r\n\r\n${input}`, true],
    // The context window full (the rows as the capture shows them in its history: the limit, then the turn's summary line).
    [`❯ Read data01.txt\r\n${LIMIT}\r\n\r\n✻ Crunched for 2m 8s · done 9:42 PM\r\n\r\n${input}`, true],
    [`❯ Read data01.txt\r\n${LIMIT}\r\n${input}`, true],
    [`❯ Write an essay\r\n${INTERRUPTED.replace("\u00a0", " ")}\r\n\r\n${input}`, true],
    // A marker with something under it: a newer prompt, a spinner, a tip, more tool output (a file the agent printed): history.
    [`${INTERRUPTED}\r\n❯ Try again\r\n${input}`, false],
    [`${INTERRUPTED}\r\n\r\n✢ Thinking… (3s · esc to interrupt)\r\n${input}`, false],
    [`${LIMIT}\r\n  ⎿ \u00a0Tip: Use /btw to ask a quick side question\r\n${input}`, false],
    [`❯ cat notes.txt\r\n  ⎿ \u00a0Interrupted · What should Claude do instead?\r\n     the rest of the file\r\n${input}`, false],
    // The words anywhere but at the start of the agent's own row: an answer's text, a quote, a different indent.
    [`● The docs say "Interrupted · What should Claude do instead?"\r\n\r\n${input}`, false],
    [`● ⎿ \u00a0Interrupted · What should Claude do instead?\r\n\r\n${input}`, false],
    [`    ⎿ \u00a0Interrupted · What should Claude do instead?\r\n\r\n${input}`, false],
    [`  ⎿ \u00a0Interrupted\r\n\r\n${input}`, false],
    // No input box (a dialog, or the row above nothing): unsure.
    [`${INTERRUPTED}\r\n\r\n`, false],
  ] as const) {
    const s = createScreen(60, 12);
    await s.write(drawn);
    expect(r.interrupted?.(s)).toBe(expected);
    s.dispose();
  }
});

// Launch modes: Gluon types `/plan …` into Codex and checks it took (`planMode`): the footer's `Plan mode` in magenta, or the history's line.
test("Codex's planMode: the Plan mode footer or its history line; no other captured state without one, nor default mode's footer", async () => {
  const f = fixture("codex");
  const plan: string[] = [];
  for (const st of f.states) {
    const screen = await screenOf(f, st);
    if (READERS.codex.planMode?.(screen)) plan.push(st.name);
    screen.dispose();
  }
  // The question states are /plan's, with its history line still on screen.
  expect(plan.sort()).toEqual(["frame-plan-question", "frame-plan-question-notes", "plan-mode-idle"]);
  for (const [drawn, row, on] of [
    // The footer alone, magenta (SGR 35), under the composer (the cursor's row).
    ["\x1b[1m› \x1b[0mhi\r\n  gpt-5 medium · ~/p \x1b[35mPlan mode\x1b[0m", 0, true],
    // The same words in another colour, or not at the end of the footer, or above the composer (the output).
    ["\x1b[1m› \x1b[0mhi\r\n  gpt-5 medium · ~/p Plan mode", 0, false],
    ["\x1b[1m› \x1b[0mhi\r\n  \x1b[35mPlan mode\x1b[0m is on", 0, false],
    ["\x1b[35mPlan mode\x1b[0m\r\n\x1b[1m› \x1b[0mhi\r\n  gpt-5 default · ~/p", 1, false],
    ["• Model changed to gpt-5 medium for Plan mode.", 0, true],
  ] as const) {
    const s = createScreen(60, 6);
    await s.write(`${drawn}\x1b[${row + 1};3H`);
    expect(READERS.codex.planMode?.(s)).toBe(on);
    s.dispose();
  }
});

// Issue #40: Codex asks the user things that aren't its composer, and no hook reports them: the folder
// trust question and the hooks' review come before any hook runs; a `request_user_input` question only
// fires PreToolUse (Working); an approval's PermissionRequest can be overtaken by the async PreToolUse.
test("issue-40: Codex's own dialogs waiting for a pick (folder trust, hook review, approvals, a question, the model picker) are read as such; no other captured screen is", async () => {
  const f = fixture("codex");
  const waiting: string[] = [];
  for (const st of f.states) {
    const screen = await screenOf(f, st);
    if (READERS.codex.awaitsChoice?.(screen)) waiting.push(st.name);
    screen.dispose();
  }
  expect(waiting.sort()).toEqual([
    "frame-approve-command",
    "frame-approve-patch",
    "frame-folder-trust",
    "frame-hook-detail",
    "frame-hook-list",
    "frame-hook-list-trusted",
    "frame-hook-review",
    "frame-model-picker",
    "frame-plan-question",
    "frame-plan-question-notes",
  ]);
  const option = "\x1b[1;7m› 1. Yes, proceed (y)\x1b[0m\r\n  2. No\r\n\r\n";
  const hints = "  Press enter to confirm or esc to cancel";
  for (const [drawn, dialog] of [
    [option + hints, true],
    // No key hints below the options.
    [option + "  ? for shortcuts", false],
    [option, false],
    // The options without the highlight (inverse), or a past prompt (bold and faint) in the history.
    ["› 1. Yes, proceed (y)\r\n  2. No\r\n\r\n" + hints, false],
    ["\x1b[1;2m› \x1b[0mRUNLS please\r\n\r\n" + hints, false],
    // The hints above the options.
    [hints + "\r\n" + option, false],
  ] as const) {
    const s = createScreen(60, 8);
    await s.write(drawn);
    expect(READERS.codex.awaitsChoice?.(s)).toBe(dialog);
    s.dispose();
  }
});

// QA-live-01: Codex sends no hook when Esc cuts a turn off either; its history line says so (`interrupted`, display only).
test("BUG-609/QA-live-01: Codex's `■ Conversation interrupted` as the last history row above the composer is read; no other captured screen is", async () => {
  const r = READERS.codex;
  const f = fixture("codex");
  const cut: string[] = [];
  for (const st of f.states) {
    const screen = await screenOf(f, st);
    if (r.interrupted?.(screen)) cut.push(st.name);
    screen.dispose();
  }
  // The `frame-turn-*` and `frame-plain-*` states were captured after Esc cut a turn off, the line above the idle composer (with `/clear` typed in it for the last two): the same reading, from the capture with colours.
  const hasLine: string[] = [];
  for (const st of f.states) if (st.rows.some((row) => row.text.startsWith("■ Conversation interrupted"))) hasLine.push(st.name);
  // (The QA campaign's live screen of the same state, `codex-esc-stuck-working`, is text-only: these captures have the colours, and say the same.)
  expect(cut.sort()).toEqual(["frame-plain-cl-tab", "frame-turn-cl-tab", "frame-turn-idle"]);
  // The other captures of that line have the slash menu open between it and the composer (rows that aren't blank): unsure, so not read (Working stays).
  expect(hasLine.filter((n) => !cut.includes(n)).sort()).toEqual(["frame-plain-clear", "frame-turn-c-down3", "frame-turn-clear", "frame-turn-new"]);
  const composer = "\x1b[1m› \x1b[0m\x1b[2mAsk Codex to do anything\x1b[0m\x1b[1G\x1b[2C";
  const INTERRUPTED = "■ Conversation interrupted - use /feedback if something went wrong";
  const draw = (rows: string[]) => `\x1b[2J\x1b[H${rows.join("\r\n")}\r\n${composer}`;
  for (const [drawn, expected] of [
    [draw(["› Write an essay", "", INTERRUPTED, ""]), true],
    [draw([INTERRUPTED]), true],
    // Something under it: a newer prompt, the working line, a reply (a file the agent printed, a quote in a model's reply, a tool's output).
    [draw([INTERRUPTED, "", "› Try again", "", "• Working (2s • esc to interrupt)", ""]), false],
    [draw([INTERRUPTED, "", "• Working (0s • esc to interrupt)"]), false],
    [draw([INTERRUPTED, "• Sure."]), false],
    [draw(["• The file says:", `  ${INTERRUPTED}`, ""]), false],
    [draw(["• Ran cat notes.txt", `  └ ${INTERRUPTED}`, ""]), false],
    [draw(["• The log shows", `${INTERRUPTED}`.replace("■", "■·"), ""]), false],
    [draw(["Conversation interrupted", ""]), false],
  ] as const) {
    const s = createScreen(70, 12);
    await s.write(drawn);
    // The cursor is in the composer, as Codex leaves it.
    expect(r.interrupted?.(s)).toBe(expected);
    s.dispose();
  }
  // The composer can't be found (the cursor is elsewhere): unsure.
  const lost = createScreen(70, 12);
  await lost.write(draw([INTERRUPTED, ""]) + "\x1b[1;1H");
  expect(r.interrupted?.(lost)).toBe(false);
  lost.dispose();
});

// A narrow frame wraps the marker onto two or three rows: the reader joins them (`logicalRow`) before matching.
test("BUG-609/QA-live-01: the interruption markers are read when a narrow terminal (40 and 30 columns) wraps them over several rows", async () => {
  for (const cols of [40, 30]) {
    const rule = "─".repeat(cols);
    const claude = (mark: string, below = "") => `❯ Write an essay\r\n  ⎿ \u00a0${mark}\r\n${below}${rule}\r\n❯ \r\n${rule}\r\n  ⏸ manual mode on`;
    for (const [drawn, expected] of [
      [claude("Interrupted · What should Claude do instead?"), true],
      [claude("Interrupted · What should Claude do instead?", "\r\n"), true],
      [claude("Context limit reached · /compact or /clear to continue"), true],
      // The same wrapped rows with something under them, or only part of the words: not the marker.
      [claude("Interrupted · What should Claude do instead?", "● Sure.\r\n"), false],
      [claude("Interrupted · Something else entirely, long enough to wrap"), false],
    ] as const) {
      const s = createScreen(cols, 14);
      await s.write(drawn);
      // The marker really wrapped onto a second row (the narrow case under test).
      expect(s.line(2).wrapped).toBe(true);
      expect(READERS["claude-code"].interrupted?.(s)).toBe(expected);
      s.dispose();
    }
    const MARK = "■ Conversation interrupted - use /feedback if something went wrong";
    const composer = "\x1b[1m› \x1b[0m\x1b[2mAsk Codex to do anything\x1b[0m\x1b[1G\x1b[2C";
    for (const [rows, expected] of [
      [[MARK, ""], true],
      [[MARK], true],
      [[MARK, "", "• Working (0s)"], false],
      [["• The file says:", `  ${MARK}`, ""], false],
    ] as const) {
      const s = createScreen(cols, 14);
      await s.write(`${rows.join("\r\n")}\r\n${composer}`);
      expect(s.line(1).wrapped).toBe(rows[0] === MARK);
      expect(READERS.codex.interrupted?.(s)).toBe(expected);
      s.dispose();
    }
  }
});

// Launch modes: Gluon types `/plan …` into Grok Build and checks it took (`planMode`): the composer's bottom border names the mode.
test("Grok Build's planMode: ` · plan` in the box's bottom border; no other captured state (auto-review and the normal mode name another or none)", async () => {
  const f = fixture("grok-build");
  const plan: string[] = [];
  for (const st of f.states) {
    const screen = await screenOf(f, st);
    if (READERS["grok-build"].planMode?.(screen)) plan.push(st.name);
    screen.dispose();
  }
  expect(plan.sort()).toEqual(["explore-plan", "frame-plan-mode", "frame-plan-mode-hello", "plan-mode", "plan-mode-hello"]);
  const box = (label: string, input = "") => `  ╭${"─".repeat(40)}╮\r\n  │ ❯ ${input.padEnd(37)}│\r\n  ╰${"─".repeat(40 - label.length - 3)} ${label} ─╯`;
  for (const [drawn, on] of [
    [box("Grok 4.7 (low) · plan"), true],
    [box("Grok 4.7 (low)"), false],
    [box("Grok 4.7 (low) · auto-review"), false],
    // The words alone, in the output above the composer or as the user's own input: not a mode.
    [`Grok 4.7 (low) · plan ─╯\r\n${box("Grok 4.7 (low)")}`, false],
    [box("Grok 4.7 (low)", "x · plan ─╯"), false],
    // No composer (the box isn't drawn yet or a dialog covers it).
    ["  ╰───── Grok 4.7 (low) · plan ─╯", false],
  ] as const) {
    const s = createScreen(60, 8);
    await s.write(drawn);
    expect(READERS["grok-build"].planMode?.(s)).toBe(on);
    s.dispose();
  }
});

describe("Grok Build reader: the box, not the cursor", () => {
  const r = READERS["grok-build"];
  const GREY = "\x1b[38;2;108;108;108m";
  const box = (rows: string[], bottom = "  ╰───────────────────────────── Grok 4.7 (low) ─╯") =>
    ["  ╭" + "─".repeat(46) + "╮", ...rows.map((t, i) => `  │ ${i ? " " : "❯"} ${t.padEnd(41)}│`), bottom].join("\r\n");
  const draw = async (text: string, cursorAt = "\x1b[1;1H") => {
    const s = createScreen(60, 14);
    await s.write(`\x1b[?25l\x1b[6;1H${text}${cursorAt}`);
    return s;
  };

  test("BUG-411/launch-modes: the cursor is anywhere (hidden at 0,0 while the start screen draws, or mid-frame on another row): the input is still the box's", async () => {
    for (const at of ["\x1b[1;1H", "\x1b[12;40H", "\x1b[7;8H"]) {
      const s = await draw(box(["/plan Read the brief"]), at);
      expect(r.inputLine(s)).toBe("/plan Read the brief");
      s.dispose();
    }
  });

  test("an empty box is an empty line (no placeholder); a screen with no composer is null (null: it can't tell, the first line waits)", async () => {
    const empty = await draw(box([""]));
    expect(r.inputLine(empty)).toBe("");
    empty.dispose();
    // The start screen's big box (a logo, a menu) has no `❯` row; a box missing its bottom border is a frame half drawn.
    const welcome = await draw("  ╭" + "─".repeat(46) + "╮\r\n  │   Grok Build  1.0.46" + " ".repeat(22) + "│\r\n  ╰" + "─".repeat(46) + "╯");
    expect(r.inputLine(welcome)).toBeNull();
    const half = await draw(box(["hi"], ""));
    expect(r.inputLine(half)).toBeNull();
    const none = await draw("");
    expect(r.inputLine(none)).toBeNull();
    expect(r.selectedCommand(none)).toBeNull();
    for (const s of [empty, welcome, half, none]) s.dispose();
  });

  test("a completion ghost (grey 108,108,108 after the typed part) is not input; the typed part is", async () => {
    const s = await draw(box([`/c${GREY}lear\x1b[39m`]));
    expect(r.inputLine(s)).toBe("/c");
    s.dispose();
    // The same letters in the text colour are the user's.
    const typed = await draw(box(["/clear"]));
    expect(r.inputLine(typed)).toBe("/clear");
    typed.dispose();
  });

  test("rows under the first are the same line wrapped: joined by a newline, the `│   ` indent and the right border dropped", async () => {
    const s = await draw(box(["first words wrap", "and go on", "to a third"]));
    expect(r.inputLine(s)).toBe("first words wrap\nand go on\nto a third");
    s.dispose();
  });

  test("the lowest composer wins (a past prompt drawn like one stays above it)", async () => {
    const s = createScreen(60, 14);
    await s.write(`\x1b[1;1H${box(["old prompt"])}\x1b[8;1H${box(["new"])}`);
    expect(r.inputLine(s)).toBe("new");
    s.dispose();
  });

  test("the menu: the row marked `❯ /` between the two rules above the box; none highlighted: unsure (\"\"); no rule: no menu", async () => {
    const rule = "  " + "─".repeat(30);
    const panel = (lit: string) => [rule, ...["/clear", "/compact", "/config"].map((c) => (c === lit ? `    ❯ ${c}  about` : `      ${c}  about`)), rule].join("\r\n");
    const at = async (menu: string, input = "/c") => {
      const s = createScreen(60, 14);
      await s.write(`\x1b[1;1H${menu}\r\n${box([input])}`);
      return s;
    };
    const second = await at(panel("/compact"));
    expect(r.selectedCommand(second)).toBe("/compact");
    expect(r.inputLine(second)).toBe("/c");
    const none = await at(panel(""));
    expect(r.selectedCommand(none)).toBe("");
    // Rows that look like items but sit above a rule that isn't the box's neighbour (the output): not the menu.
    const output = await at(panel("/clear") + "\r\nsome output");
    expect(r.selectedCommand(output)).toBeNull();
    const bare = await at("");
    expect(r.selectedCommand(bare)).toBeNull();
    for (const s of [second, none, output, bare]) s.dispose();
  });
});


describe("Kimi Code reader", () => {
  const r = READERS["kimi-code"];
  const draw = async (text: string) => {
    const s = createScreen(70, 30);
    await s.write(`\x1b[2;1H${text}`);
    return s;
  };
  const box = (rows: string[], bottom = true) => [" ╭" + "─".repeat(60) + "╮", ...rows.map((t, i) => ` │ ${i ? " " : ">"} ${t.padEnd(55)}│`), ...(bottom ? [" ╰" + "─".repeat(60) + "╯"] : [])].join("\r\n");

  test("the folder-trust question and Kimi's selection prompts (plan approval, a command to approve) and `question` panel are choices the user must make (display only); no other captured screen is", async () => {
    const f = fixture("kimi-code");
    const waiting: string[] = [];
    for (const st of f.states) {
      const screen = await screenOf(f, st);
      if (r.awaitsChoice?.(screen)) waiting.push(st.name);
      screen.dispose();
    }
    expect(waiting).toEqual(["frame-trust-dialog", "frame-plan-approval", "frame-plan-alternatives", "frame-cmd-approval", "frame-cmd-approval-wrapped", "frame-question-panel", "frame-question-panel-wrapped", "frame-question-panel-described"]);
    // The title alone, or the hints alone: not the dialog; the title with a composer on the screen (a repo's text) is not either.
    for (const drawn of [" Trust this folder?", " ↑↓ navigate · Enter select · Esc exit", `${box([""])}\r\n Trust this folder?\r\n ↑↓ navigate · Enter select · Esc exit`]) {
      const s = await draw(drawn);
      expect(r.awaitsChoice?.(s)).toBe(false);
      s.dispose();
    }
  });

  test("BUG-674/F04: Kimi is ready (it has applied its model) once the banner's `Model:` line or the footer shows; its composer drawn before that, with or without text in it, and the error screen are not", async () => {
    const f = fixture("kimi-code");
    const ready: string[] = [];
    for (const st of f.states) {
      const screen = await screenOf(f, st);
      if (r.ready?.(screen)) ready.push(st.name);
      screen.dispose();
    }
    for (const name of ["frame-early-composer", "frame-early-composer-typed", "frame-llm-not-set", "frame-trust-dialog"]) expect([name, ready.includes(name)]).toEqual([name, false]);
    for (const name of ["idle", "hello", "slash", "frame-idle", "frame-ready-composer", "frame-explore-idle", "plan-flag-idle", "frame-question-streaming"]) expect([name, ready.includes(name)]).toEqual([name, true]);
    // What the reader reads of the early composer is unchanged: it is the composer, empty or with the typed text.
    const early = await screenOf(f, "frame-early-composer");
    expect(r.inputLine(early)).toBe("");
    early.dispose();
  });

  test("BUG-674/F04: the model marker is the banner's `Model:` row or the footer under the composer; a composer alone, an empty model or the word quoted outside the banner is not it", async () => {
    const banner = ["", "  Welcome to Kimi Code!", "  Directory: ~/repo", "  Session:", "  Model:     moonshotai/kimi-k2.7-code", "  Version:   2.1.1"].map((t) => ` │${t.padEnd(68)}│`);
    const welcome = [" ╭" + "─".repeat(68) + "╮", ...banner, " ╰" + "─".repeat(68) + "╯"].join("\r\n");
    const footer = " moonshotai/kimi-k2.7-code thinking  ~/repo  master";
    const cases: [string, string, boolean][] = [
      ["a composer alone", box([""]), false],
      ["a composer with text and nothing else", box(["Read the brief"]), false],
      ["the banner above the composer", `${welcome}\r\n${box([""])}`, true],
      ["the footer under the composer", `${box([""])}\r\n${footer}`, true],
      ["the footer after `plan`", `${box([""])}\r\n plan  moonshotai/kimi-k2.7-code thinking  ~/repo  master`, true],
      ["a footer cut with an ellipsis", `${box([""])}\r\n plan  moonshotai/kimi-k2.7-code thinking  /tmp/gluonliv…`, true],
      ["a banner with an empty model", `${welcome.replace("moonshotai/kimi-k2.7-code", "")}\r\n${box([""])}`, false],
      ["the error screen", `   Error: LLM not set, send "/login" to login\r\n${box([""])}`, false],
      ["`Model:` quoted in a message above the composer", ` Model: x\r\n${box([""])}`, false],
    ];
    for (const [what, drawn, expected] of cases) {
      const s = await draw(drawn);
      expect([what, r.ready?.(s)]).toEqual([what, expected]);
      s.dispose();
    }
  });

  /** Kimi's selection prompt as the captures show it: a rule, the title, a body, the options, the hints, a rule, the footer. */
  const rule = " " + "─".repeat(66);
  const FOOTER = [" plan  moonshotai/kimi-k2.7-code thinking  ~/repo  master", "                          context: 9% (21k/256k)"];
  const hintsOf = (n: number) => `   ↑/↓ select · ${Array.from({ length: n }, (_, i) => i + 1).join("/")} choose · ↵ confirm`;
  const optionRows = (labels: string[], marked = 0) => labels.map((l, i) => `${i === marked ? "   ▶ " : "     "}${i + 1}. ${l}`);
  const prompt = (title: string, body: string[], labels: string[], over: { hints?: string; marked?: number } = {}) =>
    [rule, `   ▶ ${title}`, ...body, "", ...optionRows(labels, over.marked), "", over.hints ?? hintsOf(labels.length), rule, ...FOOTER].join("\r\n");
  const PLAN = prompt("Ready to build with this plan?", [""], ["Approve", "Reject", "Revise"]);
  const ALTERNATIVES = prompt("Ready to build with this plan?", [""], ["Usage section (Recommended)", "API reference section", "Installation + Usage section", "Reject", "Revise"]);
  const COMMAND = prompt("Run this command?", ["", "   cwd: ~/repo", "   $ git status && git log --oneline -5"], ["Approve once", "Approve for this session", "Reject", "Reject with feedback"]);

  test("BUG-611/QA-live-03: Kimi's plan-mode approval (Ready to build with this plan? Approve / Reject / Revise, seen live on 2.1.1) is a choice the user must make: the row reads awaiting, not Working", async () => {
    // Live: Kimi waited on this prompt and Gluon's info row said Working for over a minute (no hooks, and `awaitsChoice` knew only the trust dialog).
    const f = fixture("kimi-code");
    const captured = await screenOf(f, "frame-plan-approval");
    expect(r.inputLine(captured)).toBeNull();
    expect(r.awaitsChoice?.(captured)).toBe(true);
    captured.dispose();
    // A choice moved down the list (the arrow marks the highlighted one) is the same prompt.
    for (const drawn of [PLAN, prompt("Ready to build with this plan?", [""], ["Approve", "Reject", "Revise"], { marked: 1 }), prompt("Ready to build with this plan?", [""], ["Approve", "Reject", "Revise"], { marked: 2 })]) {
      const s = await draw(drawn);
      expect(r.awaitsChoice?.(s)).toBe(true);
      s.dispose();
    }
    const withComposer = await draw(`${PLAN}\r\n${box([""])}`);
    expect(r.awaitsChoice?.(withComposer)).toBe(false);
    expect(r.inputLine(withComposer)).toBe("");
    withComposer.dispose();
  });

  test("BUG-611/alternatives: the plan approval that offers alternatives (five options, `1/2/3/4/5 choose`, seen live on 2.1.1) reads awaiting", async () => {
    const f = fixture("kimi-code");
    const captured = await screenOf(f, "frame-plan-alternatives");
    expect(r.inputLine(captured)).toBeNull();
    expect(r.awaitsChoice?.(captured)).toBe(true);
    captured.dispose();
    for (const drawn of [ALTERNATIVES, prompt("Ready to build with this plan?", [""], ["A", "B", "C", "Reject", "Revise"], { marked: 4 })]) {
      const s = await draw(drawn);
      expect(r.awaitsChoice?.(s)).toBe(true);
      s.dispose();
    }
  });

  test("BUG-611/command-approval: `Run this command?` (Approve once … Reject with feedback, seen live on 2.1.1), also with a wrapped command and after plan mode ended, reads awaiting", async () => {
    const f = fixture("kimi-code");
    for (const name of ["frame-cmd-approval", "frame-cmd-approval-wrapped"]) {
      const captured = await screenOf(f, name);
      expect(r.inputLine(captured)).toBeNull();
      expect(r.awaitsChoice?.(captured)).toBe(true);
      captured.dispose();
    }
    const s = await draw(COMMAND);
    expect(r.awaitsChoice?.(s)).toBe(true);
    s.dispose();
  });

  test("BUG-611/not-a-prompt: a numbered list quoted in the transcript, a list without its hints, hints that don't match the options, a composer, or a prompt out of shape is not awaiting", async () => {
    const quoted = [" ● Kimi wrote:", "   1. Approve", "   2. Reject", "   3. Revise", "", hintsOf(3)].join("\r\n");
    const optionsOnly = prompt("Run this command?", [""], ["Approve once", "Reject"]).replace(/\r\n {3}↑\/↓ select[^\r]*/, "");
    const cases: [string, string][] = [
      // The transcript quoting the list and a hint-like line, the composer under it (the usual screen of a turn).
      ["quoted list above the composer", `${quoted}\r\n${box([""])}`],
      ["quoted list, hint-like line, no composer and no rules", quoted],
      ["quoted prompt above the composer", `${COMMAND}\r\n${box([""])}`],
      ["the prompt with a composer above it", `${box([""])}\r\n${COMMAND}`],
      // A list without the hints; hints that name another count (fewer, more, not from 1, not in order).
      ["options without hints", optionsOnly],
      ["hints for three over four options", prompt("Run this command?", [""], ["a", "b", "c", "d"], { hints: hintsOf(3) })],
      ["hints for five over three options", prompt("Run this command?", [""], ["a", "b", "c"], { hints: hintsOf(5) })],
      ["hints from 2", prompt("Run this command?", [""], ["a", "b", "c"], { hints: "   ↑/↓ select · 2/3/4 choose · ↵ confirm" })],
      ["hints out of order", prompt("Run this command?", [""], ["a", "b", "c"], { hints: "   ↑/↓ select · 1/3/2 choose · ↵ confirm" })],
      ["a single number", prompt("Run this command?", [""], ["a", "b"], { hints: "   ↑/↓ select · 1 choose · ↵ confirm" })],
      ["another hint text", prompt("Run this command?", [""], ["a", "b"], { hints: "   ↑/↓ select · 1/2 choose · Enter confirm" })],
      // The shape: no title under the top rule, no option marked, an option out of place, the rule under the hints missing, text under the footer.
      ["no title", prompt("Run this command?", [""], ["a", "b"]).replace("▶ Run this command?", "Run this command?")],
      ["no top rule", prompt("Run this command?", [""], ["a", "b"]).replace(rule + "\r\n", "")],
      ["no option marked", prompt("Run this command?", [""], ["a", "b"], { marked: -1 })],
      ["two options marked", prompt("Run this command?", [""], ["a", "b"]).replace("     2. b", "   ▶ 2. b")],
      ["options not in one column", prompt("Run this command?", [""], ["a", "b"]).replace("     2. b", "      2. b")],
      ["an option missing", prompt("Run this command?", [""], ["a", "b", "c"]).replace("     2. b\r\n", "")],
      ["options numbered from 0", prompt("Run this command?", [""], ["a", "b"]).replace("1. a", "0. a").replace("2. b", "1. b")],
      ["no rule under the hints", prompt("Run this command?", [""], ["a", "b"]).replace(`${rule}\r\n ${FOOTER[0]!.trim()}`, FOOTER[0]!)],
      ["text under the footer", [prompt("Run this command?", [""], ["a", "b"]), " one", " two", " three"].join("\r\n")],
    ];
    for (const [why, drawn] of cases) {
      const s = await draw(drawn);
      expect([why, r.awaitsChoice?.(s)]).toEqual([why, false]);
      s.dispose();
    }
    // The control: the same prompt, shaped as the captures are, reads awaiting.
    const ok = await draw(prompt("Run this command?", [""], ["a", "b"]));
    expect(r.awaitsChoice?.(ok)).toBe(true);
    ok.dispose();
  });

  /**
   * Kimi's `question` panel (QA-live-04; plan mode, 2.1.1): a tab bar, a `? <question>` row, options `[1]`…`[N]` (`→` on the highlighted one), the hints row.
   * The `frame-question-*` states are captured from Kimi Code 2.1.1 via OpenRouter on 2026-10-07 (text only; their notes in `2.1.1.json`).
   */
  const QHINTS = " ↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel";
  const qOptions = (labels: string[], marked = 0) => labels.map((l, i) => `${i === marked ? " → " : "   "}[${i + 1}] ${l}`);
  const question = (labels: string[], over: { hints?: string; marked?: number; title?: string[]; below?: string[] } = {}) =>
    [" ● Need ask whether the plan includes tests.", "", " question  Tests  Submit", "", ...(over.title ?? [" ? Should the plan include a minimal test?"]), "", ...qOptions(labels, over.marked), "", over.hints ?? QHINTS, "", ...(over.below ?? FOOTER)].join("\r\n");
  const QUESTION = question(["README only", "README + minimal test", "Other"]);

  test("BUG-663/QA-live-04: Kimi's `question` panel (a tab bar, `[1] README only` / `[2] README + minimal test` / `[3] Other`, `↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel`, seen live on 2.1.1) is a choice the user must make: the row reads awaiting, not Working", async () => {
    // Live: the panel waited for over four minutes and Gluon's row said Working: `awaitsChoice` knew `1. Approve`-style prompts under rules, not `[n]` options.
    const f = fixture("kimi-code");
    for (const name of ["frame-question-panel", "frame-question-panel-wrapped", "frame-question-panel-described"]) {
      const captured = await screenOf(f, name);
      expect([name, r.inputLine(captured)]).toEqual([name, null]);
      expect([name, r.awaitsChoice?.(captured)]).toEqual([name, true]);
      captured.dispose();
    }
    // The same turn a few seconds in: the composer is on screen, nothing to pick.
    const streaming = await screenOf(f, "frame-question-streaming");
    expect(r.inputLine(streaming)).toBe("");
    expect(r.awaitsChoice?.(streaming)).toBe(false);
    streaming.dispose();
    // The highlighted option moved down (the arrow marks it) is the same panel.
    for (const drawn of [QUESTION, question(["README only", "README + minimal test", "Other"], { marked: 1 }), question(["README only", "README + minimal test", "Other"], { marked: 2 })]) {
      const s = await draw(drawn);
      expect(r.awaitsChoice?.(s)).toBe(true);
      s.dispose();
    }
    // With a composer (the panel gone, or drawn above one) it is not a pick any more.
    const withComposer = await draw(`${QUESTION}\r\n${box([""])}`);
    expect(r.awaitsChoice?.(withComposer)).toBe(false);
    expect(r.inputLine(withComposer)).toBe("");
    withComposer.dispose();
  });

  test("BUG-663/variants: two to nine options, a question and an option wrapped on a narrow terminal, a blank row or none above the hints, no footer, a rule under it: all read awaiting", async () => {
    const hints = (n: number) => ` ↑↓ select  1-${n} / ↵ choose  ←/→/tab switch  esc cancel`;
    const labels = (n: number) => Array.from({ length: n }, (_, i) => `option ${i + 1}`);
    const cases: [string, string][] = [
      ["two options", question(labels(2), { hints: hints(2) })],
      ["nine options", question(labels(9), { hints: hints(9) })],
      ["no footer", question(["a", "b", "c"], { below: [] })],
      ["a rule and the footer under it", question(["a", "b", "c"], { below: [rule, ...FOOTER] })],
      ["no blank row above the hints", question(["a", "b", "c"]).replace(`\r\n\r\n${QHINTS}`, `\r\n${QHINTS}`)],
      ["no blank row under the title", question(["a", "b", "c"]).replace(" ? Should the plan include a minimal test?\r\n\r\n", " ? Should the plan include a minimal test?\r\n")],
      ["the question wrapped over three rows", question(["a", "b", "c"], { title: [" ? There are currently no test files in the repo. Should", "   the plan include a minimal test for the README example,", "   or only the README section itself?"] })],
      ["an option wrapped", question(["a", "b", "c"]).replace("[2] b", "[2] b and a long label that Kimi wraps\r\n       onto a second row")],
      ["the hints without the tab switch (one question, no tab bar)", question(["a", "b", "c"], { hints: " ↑↓ select  1-3 / ↵ choose  esc cancel" })],
    ];
    for (const [why, drawn] of cases) {
      const s = await draw(drawn);
      expect([why, r.awaitsChoice?.(s)]).toEqual([why, true]);
      s.dispose();
    }
  });

  test("BUG-663/not-a-prompt: `[1]` lists and hint-like words in the agent's own output, options without their hints or the hints without options, a count that doesn't match, a composer, or a panel out of shape is not awaiting", async () => {
    const quoted = [" ● Kimi wrote:", "   [1] README only", "   [2] README + minimal test", "   [3] Other", "", QHINTS].join("\r\n");
    const references = [" ● See the references:", "", " ? Which one", "", "   [1] Smith 2020", "   [2] Jones 2021", "   [3] Lee 2022", "", " ↑↓ select  1-3 / ↵ choose  esc cancel is what the docs say"].join("\r\n");
    const noHints = question(["a", "b", "c"]).replace(`\r\n\r\n${QHINTS}`, "");
    const cases: [string, string][] = [
      // The transcript quoting the options and the hint row, the composer under it (the usual screen of a turn) or nothing under it.
      ["quoted options above the composer", `${quoted}\r\n${box([""])}`],
      ["quoted options and hints, no title, nothing else", quoted],
      ["the panel above the composer", `${QUESTION}\r\n${box([""])}`],
      ["the panel with a composer above it", `${box([""])}\r\n${QUESTION}`],
      ["a reference list with the hint words in a sentence", references],
      ["a plain list of `[n]` rows", [" ? Which one", "", " → [1] a", "   [2] b", "   [3] c"].join("\r\n")],
      // The pieces missing or not matching.
      ["options without the hints", noHints],
      ["the hints without options", [" ● done", "", " ? Should the plan include a minimal test?", "", QHINTS, "", ...FOOTER].join("\r\n")],
      ["hints for 1-3 over four options", question(["a", "b", "c", "d"])],
      ["hints for 1-4 over three options", question(["a", "b", "c"], { hints: " ↑↓ select  1-4 / ↵ choose  ←/→/tab switch  esc cancel" })],
      ["hints from 2", question(["a", "b"], { hints: " ↑↓ select  2-3 / ↵ choose  ←/→/tab switch  esc cancel" })],
      ["a single option", question(["a"], { hints: " ↑↓ select  1-1 / ↵ choose  esc cancel" })],
      ["another hint text", question(["a", "b", "c"], { hints: " ↑↓ select  1-3 / ↵ pick  ←/→/tab switch  esc cancel" })],
      ["the hint row inside a sentence", question(["a", "b", "c"], { hints: " Use ↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel to answer" })],
      // The shape: no question row, no option marked, two marked, options out of order or out of column, text under the panel.
      ["no question row", question(["a", "b", "c"], { title: [" Should the plan include a minimal test?"] })],
      ["a blank where the question row is", question(["a", "b", "c"], { title: [""] })],
      ["no option marked", question(["a", "b", "c"], { marked: -1 })],
      ["two options marked", question(["a", "b", "c"]).replace("   [2] b", " → [2] b")],
      ["options not in one column", question(["a", "b", "c"]).replace("   [2] b", "    [2] b")],
      ["an option missing", question(["a", "b", "c"]).replace("   [2] b\r\n", "")],
      ["options out of order", question(["a", "b", "c"]).replace("[2] b", "[3] b").replace("[3] c", "[2] c")],
      ["options numbered from 0", question(["a", "b", "c"]).replace("[1] a", "[0] a").replace("[2] b", "[1] b").replace("[3] c", "[2] c")],
      ["a blank row between the options", question(["a", "b", "c"]).replace("   [2] b\r\n", "   [2] b\r\n\r\n")],
      ["text under the panel", question(["a", "b", "c"], { below: [" one", " two", " three", " four"] })],
    ];
    for (const [why, drawn] of cases) {
      const s = await draw(drawn);
      expect([why, r.awaitsChoice?.(s)]).toEqual([why, false]);
      s.dispose();
    }
    // The control: the same panel, shaped as above, reads awaiting.
    const ok = await draw(question(["a", "b", "c"]));
    expect(r.awaitsChoice?.(ok)).toBe(true);
    ok.dispose();
  });

  test("a screen with no composer is null (the first line waits); a box missing its bottom border is a frame half drawn; the welcome box has no `>` row", async () => {
    const welcome = await draw(" ╭" + "─".repeat(60) + "╮\r\n │  Welcome to Kimi Code!" + " ".repeat(37) + "│\r\n ╰" + "─".repeat(60) + "╯");
    expect(r.inputLine(welcome)).toBeNull();
    const half = await draw(box(["hi"], false));
    expect(r.inputLine(half)).toBeNull();
    expect(r.selectedCommand(half)).toBeNull();
    const ok = await draw(box(["hi"]));
    expect(r.inputLine(ok)).toBe("hi");
    for (const s of [welcome, half, ok]) s.dispose();
  });

  test("the grey hint after a whole command is not input; the same words in the text colour are the user's", async () => {
    const HINT = "\x1b[38;2;136;136;136m";
    const s = await draw(box([`/compact${HINT}  <instruction>\x1b[39m`]));
    expect(r.inputLine(s)).toBe("/compact");
    s.dispose();
    const typed = await draw(box(["/compact  <instruction>"]));
    expect(r.inputLine(typed)).toBe("/compact  <instruction>");
    typed.dispose();
  });

  test("a menu whose highlight can't be found (no arrow, or two) is \"\": Enter may run any item; no menu is null", async () => {
    const menu = (rows: string[]) => `${box(["/c"])}\r\n${rows.map((t) => ` │ ${t.padEnd(59)}│`).join("\r\n")}`;
    const none = await draw(menu(["    compact       Compact", "    copy          Copy"]));
    expect(r.selectedCommand(none)).toBe("");
    const two = await draw(menu(["  → compact       Compact", "  → copy          Copy"]));
    expect(r.selectedCommand(two)).toBe("");
    const one = await draw(menu(["    compact       Compact", "  → new (clear)   Start a fresh session", "    (2/9)"])); // typed "/c": the alias it begins
    expect(r.selectedCommand(one)).toBe("/clear");
    const noMenu = await draw(box(["/c"]));
    expect(r.selectedCommand(noMenu)).toBeNull();
    for (const s of [none, two, one, noMenu]) s.dispose();
  });
});
