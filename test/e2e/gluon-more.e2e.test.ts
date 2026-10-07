/**
 * Gluon, more of the frame (the coverage matrix's hand-written cases, `test/fixtures/gluon-matrix.ts`):
 * focus reports, pastes, the mouse with and without the agent's tracking, scrollback paging, the
 * Codex, Antigravity and Grok Build fakes in the frame, and the live-QA findings
 * (`qa/gluon-followups-live/REPORT.md`, #1 #2 #4 #7 #8). A case that describes the behaviour
 * wanted where the app does otherwise today is `test.failing` and titled `BUG-CANDIDATE/<case>:`
 * (`test/e2e/README.md`). On Windows the exact-bytes and mouse cases are skipped (ConPTY re-renders
 * and translates them, as in `gluon.e2e.test.ts`).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { click, FOCUS, HOME_KEY, KEYS, mouseReports, wheelDown, wheelUp, type Action } from "./actions.ts";
import { freshConfig, repo, WIN } from "./fixtures.ts";
import { EVENT_HOOK, gluon, home, launch, launchAs, openSessions, say, toChoice } from "./gluon-kit.ts";
import { assertInvariants } from "./gluon-invariants.ts";
import { type App, HOME_VIEW, SLOW, start, stopAll } from "./harness.ts";
import { GLUON_HEX } from "../../src/ui/theme.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

/** What the agents read from now on: `got()` is every agent's new bytes (`App.inputLogs`). */
function mark(app: App) {
  const at = new Map(app.inputLogs().map((a) => [a.pid, a.bytes.length]));
  return { got: () => app.inputLogs().map((a) => a.bytes.slice(at.get(a.pid) ?? 0)).join("") };
}

/** Waits for the agents to have read `want` since `m`, then compares (what lands lands after the screen). */
async function gotExactly(m: ReturnType<typeof mark>, want: string) {
  const end = performance.now() + 2000 * SLOW;
  while (m.got().length < want.length && performance.now() < end) await Bun.sleep(20);
  expect(m.got()).toBe(want);
}

/** The highlighted tab on the strip (its underlined text). */
function shownTab(app: App): string {
  const line = app.term.buffer.active.getLine(app.term.buffer.active.viewportY);
  let out = "";
  for (let x = 0; line && x < app.term.cols; x++) {
    const c = line.getCell(x);
    if (c?.isUnderline()) out += c.getChars() || " ";
  }
  return out.trim();
}

const bar = (app: App) => app.lines().at(-1) ?? "";
const at = (app: App, n: number) => app.waitFor((s) => s.includes("◆ gluon") && shownTab(app).includes(`session-${n}`));
/** The 1-based column of a tab's name on the strip. */
const tabX = (app: App, name: string) => app.lines()[0]!.indexOf(name) + 1;
const mouse = (m: Extract<Action, { mouse: unknown }>["mouse"]) => mouseReports(m);

describe("Gluon: what reaches the agent", () => {
  test.skipIf(WIN)("GLUON-20: focus reports reach an agent that asked for them, byte for byte; one that didn't gets none, and the terminal reports focus only while the asking agent is shown @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await openSessions(app, ["claude", "claude"]);
    await say(app, "!focus", "FOCUS ON");
    await app.waitFor(() => app.modes().focus);
    const m = mark(app);
    await app.press(FOCUS.in);
    await app.waitFor("FOCUS IN");
    await app.press(FOCUS.out);
    await app.waitFor("FOCUS OUT");
    await gotExactly(m, "\x1b[I\x1b[O");
    // The first session asked for none: off on the terminal, and a late report goes nowhere.
    await app.press(KEYS.left);
    await at(app, 1);
    await app.waitFor(() => !app.modes().focus);
    const m2 = mark(app);
    await app.press(FOCUS.in, FOCUS.out);
    await app.settle(200);
    expect(m2.got()).toBe("");
    assertInvariants(app);
    await home(app);
    expect(app.modes().focus).toBe(false);
  });

  test.skipIf(WIN)("GLUON-21: a paste reaches the agent whole — with its markers while the agent has bracketed paste on, without once it turned it off; a pasted /clear never asks @full", async () => {
    const app = await launchAs("claude");
    let m = mark(app);
    await app.paste("hello there");
    await app.waitFor("❯ hello there");
    await gotExactly(m, "\x1b[200~hello there\x1b[201~");
    await app.press("\x7f".repeat(11));
    m = mark(app);
    await app.paste("one\ntwo");
    await gotExactly(m, "\x1b[200~one\ntwo\x1b[201~");
    await app.press("\x7f".repeat(7));
    // A pasted /clear and a typed Enter: the agent runs it; Gluon never asks (a paste never counts).
    await app.paste("/clear");
    await app.press(KEYS.enter);
    await app.waitFor("CLEARED");
    expect(app.screen()).not.toMatch(/ends this session|End (this )?session\?/);
    // The agent turns bracketed paste off (the fake echoes a pasted `CSI ? 2004 l` as it is).
    await app.paste("\x1b[?2004l");
    await app.press(KEYS.enter);
    await app.waitFor("GOT <");
    m = mark(app);
    await app.paste("plain paste");
    await app.waitFor("❯ plain paste");
    await gotExactly(m, "plain paste");
    // The real terminal keeps bracketed paste on all the same (BUG-172): a paste is never keys.
    expect(app.modes().bracketedPaste).toBe(true);
    await app.press("\x7f".repeat(11));
    await app.paste("x\x1cy");
    await app.waitFor("❯ x");
    expect(app.screen()).toContain("◆ gluon");
    assertInvariants(app);
  });
});

describe("Gluon: the fake Codex, Antigravity and Grok Build in the frame", () => {
  test("GLUON-22, GLUON-31: three Codex sessions — ←/→ walk the ring through home on an untouched line, so do the home key's prefix and ←/→, a click on a tab shows it; Alt+←/→ are dropped; Codex gets none of these keys, CSI and SS3 arrows alike (REPORT #4, BUG-279, BUG-280) @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["codex"]);
    await openSessions(app, ["codex", "codex", "codex"]);
    await at(app, 3);
    const m = mark(app);
    // The prefix and ←: down the ring, home included; the prefix and → on again.
    await app.press(HOME_KEY, KEYS.left);
    await at(app, 2);
    await app.press(HOME_KEY, KEYS.left);
    await at(app, 1);
    await app.press(HOME_KEY, KEYS.left);
    await app.waitFor(HOME_VIEW);
    await app.press(KEYS.right);
    await at(app, 1);
    await app.press(HOME_KEY, KEYS.right);
    await at(app, 2);
    await app.press(HOME_KEY, KEYS.right);
    await at(app, 3);
    await app.press(HOME_KEY, KEYS.right);
    await app.waitFor(HOME_VIEW);
    await app.press(KEYS.right);
    await at(app, 1);
    // Plain ←/→ on an untouched line: the same ring.
    await app.press(KEYS.right);
    await at(app, 2);
    await app.press(KEYS.right);
    await at(app, 3);
    await app.press(KEYS.left);
    await at(app, 2);
    await app.press(KEYS.left);
    await at(app, 1);
    await app.press(KEYS.left);
    await app.waitFor(HOME_VIEW);
    await app.press(KEYS.right);
    await at(app, 1);
    if (!WIN) {
      await app.press(click(tabX(app, "session-3"), 1));
      await at(app, 3);
      await app.press(click(2, 1));
      await app.waitFor(HOME_VIEW);
      await app.press(KEYS.right);
      await at(app, 1);
    }
    // Alt+←/→ on an untouched line: Gluon's, dropped (Codex switches agent threads on them).
    await app.press(KEYS.altRight);
    await app.press(KEYS.altLeft);
    await app.settle(150);
    await at(app, 1);
    expect(m.got()).toBe("");
    assertInvariants(app, { tab: "session-1" });
    for (const [right, left] of [[KEYS.right, KEYS.left], ["\x1bOC", KEYS.ssLeft]] as const) {
      await app.press(right);
      await at(app, 2);
      await app.press(right);
      await at(app, 3);
      // → on the last tab is home, never Codex's.
      await app.press(right);
      await app.waitFor(HOME_VIEW);
      await app.press(KEYS.right);
      await at(app, 1);
      await app.press(left);
      await app.waitFor(HOME_VIEW);
      await app.press(KEYS.right);
      await at(app, 1);
    }
    expect(m.got()).toBe("");
    assertInvariants(app, { tab: "session-1" });
  });

  test("GLUON-23: Antigravity's reader in the frame — a typed /clear asks (and Esc keeps the session); /compact never asks, Antigravity has none to hold @full", async () => {
    const app = await launchAs("agy");
    await app.type("/clear");
    await app.press(KEYS.enter);
    await app.waitFor((s) => /^ \? (\/\S+ ends this session|End (this )?session\?)/.test(s.split("\n").at(-1)!));
    assertInvariants(app);
    await app.press(KEYS.esc);
    await app.waitFor((s) => !/ends this session|End (this )?session\?/.test(s));
    expect(app.screen()).not.toContain("CLEARED");
    await app.press("\x7f".repeat(8));
    await app.type("/compact");
    // Its menu has no such item ("No matches", as Antigravity's): the Enter goes on to it, nothing held.
    await app.waitFor("No matches");
    const m = mark(app);
    await app.press(KEYS.enter);
    await gotExactly(m, "\r");
    await app.settle(200);
    expect(app.screen()).not.toContain("instead of compacting");
    expect(app.screen()).not.toContain("COMPACTED");
    assertInvariants(app);
  });

  test("GLUON-24: Grok Build's reader (the fake) — a typed /clear and /compact ask, and so does Enter on its slash menu's highlighted /clear @full", async () => {
    const app = await launchAs("grok");
    await app.type("/clear");
    await app.press(KEYS.enter);
    await app.waitFor((s) => /^ \? (\/\S+ ends this session|End (this )?session\?)/.test(s.split("\n").at(-1)!));
    await app.press(KEYS.esc);
    await app.waitFor((s) => !/ends this session|End (this )?session\?/.test(s));
    await app.press("\x7f".repeat(8));
    await app.type("/compact");
    await app.press(KEYS.enter);
    await app.waitFor("End this session instead of compacting?");
    await app.press(KEYS.esc);
    await app.waitFor((s) => !s.includes("instead of compacting"));
    await app.press("\x7f".repeat(10));
    // `/` alone: the menu's highlighted /clear would run: asked about too.
    await app.type("/");
    await app.press(KEYS.enter);
    await app.waitFor((s) => /^ \? (\/\S+ ends this session|End (this )?session\?)/.test(s.split("\n").at(-1)!));
    await app.press(KEYS.esc);
    await app.waitFor((s) => !/ends this session|End (this )?session\?/.test(s));
    expect(app.screen()).not.toContain("CLEARED");
    assertInvariants(app);
  });
});

describe("Gluon: Kimi Code in the frame", () => {
  // Connected through OpenRouter, the key from the environment.
  const opts = { yaml: "handoff:\n  on_clear: ask\nconnections:\n  kimi-code: { auth: api, provider: openrouter }\n", env: { OPENROUTER_API_KEY: "sk-or-v1-test-0123456789abcdef" } };
  const asks = (s: string) => /^ \? (\/\S+ ends this session|End (this )?session\?)/.test(s.split("\n").at(-1)!);

  test("Kimi Code's reader (the fake, a box with its menu below): a typed /clear and /compact ask, and so does Enter on its menu's `new (clear)`; the brief's first line was typed meanwhile @full", async () => {
    const app = await launchAs("kimi", opts);
    await app.waitFor((s) => s.replace(/[│\s]+/g, "").includes("GOT<Readthesessionbriefin"));
    await app.type("/clear");
    await app.press(KEYS.enter);
    await app.waitFor(asks);
    await app.press(KEYS.esc);
    await app.waitFor((s) => !asks(s));
    await app.press("\x7f".repeat(8));
    await app.type("/compact");
    await app.press(KEYS.enter);
    await app.waitFor("End this session instead of compacting?");
    await app.press(KEYS.esc);
    await app.waitFor((s) => !s.includes("instead of compacting"));
    await app.press("\x7f".repeat(10));
    // `/cl`: the menu's one item is `new (clear)`; Enter runs it, which is /clear's alias: asked about too.
    await app.type("/cl");
    await app.waitFor("new (clear)");
    await app.press(KEYS.enter);
    await app.waitFor(asks);
    await app.press(KEYS.esc);
    await app.waitFor((s) => !asks(s));
    expect(app.screen()).not.toContain("CLEARED");
    assertInvariants(app);
  });
});

describe("Gluon: scrollback and the mouse", () => {
  test("GLUON-25: Shift+PgUp/PgDn page the frame's scrollback, the wheel scrolls 3 rows; Esc or q go back to the live screen; a typed key leaves scroll mode and reaches the agent @full", async () => {
    const app = await launchAs("claude");
    await say(app, "!lines 60", "LINE 60");
    const m = mark(app);
    await app.press(KEYS.shiftPgup);
    await app.waitFor("↑ 23 · esc back");
    await app.press(KEYS.shiftPgup);
    await app.waitFor("↑ 46 · esc back");
    await app.press(KEYS.shiftPgdn);
    await app.waitFor("↑ 23 · esc back");
    assertInvariants(app);
    await app.press("q");
    await app.waitFor((s) => !s.includes("esc back") && s.includes("LINE 60"));
    if (!WIN) {
      await app.press(wheelUp(20, 12), wheelUp(20, 12));
      await app.waitFor("↑ 6 · esc back");
      await app.press(wheelDown(20, 12));
      await app.waitFor("↑ 3 · esc back");
      await app.press(KEYS.esc);
      await app.waitFor((s) => !s.includes("esc back"));
    }
    expect(m.got()).toBe("");
    await app.press(KEYS.shiftPgup);
    await app.waitFor("esc back");
    await app.press("x");
    await app.waitFor((s) => !s.includes("esc back") && s.includes("❯ x"));
    await gotExactly(m, "x");
  });

  test.skipIf(WIN)("GLUON-26: an agent that tracks the mouse gets right and middle clicks and a drag moved into its screen; a drag that leaves the interior is held at its edge, and its release too @full", async () => {
    const app = await launchAs("claude");
    await say(app, "!mouse", "MOUSE ON");
    // The interior starts at real cell (2, 5): real (10, 10) is the agent's (9, 6).
    let m = mark(app);
    await app.press(...mouse({ op: "press", button: "right", x: 10, y: 10 }));
    await app.waitFor("MOUSE <2;9;6>M");
    await app.press(...mouse({ op: "press", button: "middle", x: 10, y: 10 }));
    await app.waitFor("MOUSE <1;9;6>M");
    await gotExactly(m, "\x1b[<2;9;6M\x1b[<1;9;6M");
    m = mark(app);
    // Dragged up onto the info line (row 2) and released there: held at the interior's first row.
    await app.press(...mouse({ op: "drag", button: "left", x: 10, y: 10, to: { x: 60, y: 2 } }));
    await app.waitFor("MOUSE <0;59;1>m");
    await gotExactly(m, "\x1b[<0;9;6M\x1b[<32;59;1M\x1b[<0;59;1m");
    assertInvariants(app);
  });

  test.skipIf(WIN)("BUG-240/GLUON-27: a click on the chrome (the bottom bar, the info line, the border) reaches a mouse-tracking agent as nothing — not as a release it never got the press of @full", async () => {
    const app = await launchAs("claude");
    await say(app, "!mouse", "MOUSE ON");
    const m = mark(app);
    for (const [x, y] of [[50, 30], [50, 2], [1, 12]] as const) await app.press(...mouse({ op: "click", button: "left", x, y }));
    await app.settle(200);
    expect(m.got()).toBe("");
    expect(app.screen()).not.toContain("MOUSE <");
  });

  test.skipIf(WIN)("GLUON-28: without the agent's mouse tracking, presses, releases, drags, right and middle clicks go nowhere; the wheel scrolls the frame @full", async () => {
    const app = await launchAs("claude");
    await say(app, "!lines 40", "LINE 40");
    const m = mark(app);
    const gestures: Extract<Action, { mouse: unknown }>["mouse"][] = [
      { op: "click", button: "left", x: 10, y: 10 },
      { op: "release", button: "left", x: 10, y: 10 },
      { op: "drag", button: "left", x: 10, y: 10, to: { x: 30, y: 12 } },
      { op: "press", button: "right", x: 10, y: 10 },
      { op: "press", button: "middle", x: 10, y: 10 },
      { op: "click", button: "left", x: 50, y: 30 },
    ];
    for (const g of gestures) await app.press(...mouse(g));
    await app.settle(200);
    expect(m.got()).toBe("");
    expect(app.screen()).not.toContain("esc back");
    expect(app.lines()[0]).toContain("◆ gluon");
    await app.press(wheelUp(10, 10));
    await app.waitFor("↑ 3 · esc back");
    await app.press(wheelDown(10, 10));
    await app.waitFor((s) => !s.includes("esc back"));
    expect(m.got()).toBe("");
    assertInvariants(app);
  });
});

describe("Gluon: the live-QA findings (qa/gluon-followups-live/REPORT.md)", () => {
  /** Idle at home, resized twice: whether the row ever reads Working over the next 4 s (the redraw, then QUIET_AWAIT_MS). */
  async function workingAfterResize(redrawDelayMs: number): Promise<string[]> {
    const app = await gluon(100, 30, redrawDelayMs ? { FAKE_RESIZE_DELAY_MS: String(redrawDelayMs) } : {}, undefined, ["claude"]);
    try {
      await launch(app, "idle task");
      await home(app);
      await app.waitFor(/Awaiting input\n.*Gluon-idle-task/, 20_000);
      app.resize(80, 24);
      await app.settle(200);
      app.resize(100, 30);
      // The redraw (1.5 s late at most), then Working for QUIET_AWAIT_MS (3 s): a flip shows within 3 s.
      const end = performance.now() + 3000 * SLOW;
      const seen: string[] = [];
      while (performance.now() < end) {
        await app.quiet();
        if (/▾ Working|● 1 working/.test(app.screen())) seen.push(app.screen());
        await Bun.sleep(100);
      }
      expect(app.screen()).toMatch(/Awaiting input\n.*Gluon-idle-task/);
      return seen.slice(0, 1);
    } finally {
      // The tries of one test (below) don't pile up: a third Gluon beside two idle ones timed out at its launch on Windows.
      app.dispose();
    }
  }

  test("GLUON-29: a resize while the sessions are idle doesn't make them Working (REPORT #1) @full", async () => {
    expect(await workingAfterResize(0)).toEqual([]);
  });

  test.skipIf(WIN)("BUG-242/GLUON-36: nor does the agent's redraw when it comes a while after the resize, as a TUI that debounces it (REPORT #1) @full", async () => {
    expect(await workingAfterResize(1500)).toEqual([]);
  });

  // ConPTY repaints at once after a resize; the agent's own, late redraw is still owed (`isRedraw`'s `late`).
  test.skipIf(!WIN)("BUG-669/QA-win-02: on Windows too an idle session's row doesn't read Working when the agent redraws a while after a resize (ConPTY's immediate repaint ends the BUG-242 wait) @full", async () => {
    // ConPTY's repaint isn't every time (a loaded machine skips it): up to three tries before the row is called clean.
    const seen: string[] = [];
    for (let i = 0; i < 3 && !seen.length; i++) seen.push(...(await workingAfterResize(1500)));
    expect(seen).toEqual([]);
  });

  for (const fake of ["codex"] as const)
    test(`GLUON-30: /clear typed after typing, arrows and erasing the line still asks (REPORT #2; the fake ${fake}) @full`, async () => {
      const app = await launchAs(fake);
      await app.type("hello");
      // The arrows move the agent's cursor (back to the end, so the Backspaces erase it all).
      const end = app.cursor().x;
      await app.press(KEYS.left, KEYS.left);
      await app.waitFor(() => app.cursor().x === end - 2);
      await app.press(KEYS.right, KEYS.right);
      await app.waitFor(() => app.cursor().x === end);
      await app.press("\x7f".repeat(5));
      await app.type("/clear");
      await app.press(KEYS.enter);
      await app.waitFor((s) => /^ \? (\/\S+ ends this session|End (this )?session\?)/.test(s.split("\n").at(-1)!));
      expect(app.screen()).not.toContain("CLEARED");
    });

  test("GLUON-32: the bottom bar names ←/→ only while they switch — on an untouched line between tabs; once a key is typed just the home key, ←/→ again after Enter (REPORT #7) @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await openSessions(app, ["claude", "claude", "claude"]);
    await app.press(KEYS.left);
    await at(app, 2);
    expect(bar(app)).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions/);
    await app.type("x");
    await app.waitFor(() => /^ ctrl\+\\ sessions/.test(bar(app)));
    expect(bar(app)).not.toContain("switch");
    // ← is the agent's: its cursor moves back over the x.
    const end = app.cursor().x;
    await app.press(KEYS.left);
    await app.waitFor(() => app.cursor().x === end - 1);
    expect(shownTab(app)).toContain("session-2");
    await app.press(KEYS.enter);
    await app.waitFor(() => /^ ←\/→ switch session · ctrl\+\\ sessions/.test(bar(app)));
    await app.press(KEYS.right);
    await at(app, 3);
  });

  test("BUG-241/GLUON-33: on the only tab the bottom bar names no switch key (there is no other session), → is home; on two tabs it names ←/→ on each, → from the last is home (REPORT #7) @full", async () => {
    const app = await launchAs("claude");
    expect(shownTab(app)).toContain("claude-task");
    expect(bar(app)).toMatch(/^ ctrl\+\\ sessions/);
    expect(bar(app)).not.toContain("switch");
    await app.press(KEYS.right);
    await app.waitFor(HOME_VIEW);
    expect(app.screen()).not.toContain("ARROW RIGHT");
    const two = await gluon(100, 30, {}, undefined, ["claude"]);
    await openSessions(two, ["claude", "claude"]);
    await at(two, 2);
    expect(bar(two)).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions/);
    await two.press(KEYS.right);
    await two.waitFor(HOME_VIEW);
    expect(two.screen()).not.toContain("ARROW RIGHT");
    await two.press(KEYS.right);
    await at(two, 1);
    expect(bar(two)).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions/);
  });

  test("GLUON-34: the home view's end question names the row it ends and its keys (enter yes · esc no); y and n don't answer it; Enter ends that row only (REPORT #8) @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await launch(app, "one task");
    await home(app);
    await launch(app, "two task");
    await home(app);
    // The row of the session left is selected (BUG-231): the second.
    await app.waitFor(() => app.bg(4, app.row("Gluon-two-task ")) === GLUON_HEX.selected);
    await app.press(KEYS.delete);
    await app.waitFor("? End Gluon-two-task?  enter yes · esc no");
    expect(app.screen()).toContain("enter ends it · esc keeps it");
    await app.press("y", "n");
    await app.settle(200);
    expect(bar(app)).toContain("End Gluon-two-task?");
    await app.press(KEYS.enter);
    await app.waitFor((s) => !s.includes("Gluon-two-task") && s.includes("Gluon-one-task"));
  });

  test("BUG-259/GLUON-41: a home question is answered only by keys pressed once it shows — Delete + Enter in one read asks and waits, so does Ctrl+C Ctrl+C Enter; an Enter after it shows still says yes @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await launch(app, "one task");
    await home(app);
    await app.waitFor(() => app.bg(4, app.row("Gluon-one-task ")) === GLUON_HEX.selected);
    app.write(KEYS.delete + KEYS.enter);
    await app.waitFor("? End Gluon-one-task?");
    await app.settle(300);
    expect(bar(app)).toContain("End Gluon-one-task?");
    expect(app.screen()).toContain("Gluon-one-task ");
    await app.press(KEYS.esc);
    await app.waitFor((s) => !s.includes("End Gluon-one-task?"));
    app.write(KEYS.ctrlC + KEYS.ctrlC + KEYS.enter);
    await app.waitFor("quit and end it?");
    await app.settle(300);
    expect(await app.exitCode(300)).toBeNull();
    expect(bar(app)).toContain("quit and end it?");
    await app.press(KEYS.esc);
    await app.waitFor((s) => !s.includes("quit and end it?"));
    // Pressed once the question shows, Enter answers it.
    await app.press(KEYS.delete);
    await app.waitFor("? End Gluon-one-task?");
    await app.press(KEYS.enter);
    await app.waitFor((s) => !s.includes("Gluon-one-task"));
  });

  test("BUG-237/GLUON-35: Shift+Enter in the home composer is a new line in each encoding — xterm's modifyOtherKeys, kitty's CSI u — as Alt+Enter is; never `[27;2;13~` typed", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await app.type("first");
    for (const [i, key] of [KEYS.shiftEnter, "\x1b[13;2u", KEYS.altEnter].entries()) {
      await app.press(key);
      await app.type(`line${i + 2}`);
    }
    await app.waitFor("line4");
    expect(app.screen()).not.toContain("[27;");
    expect(app.screen()).not.toContain("[13;");
    expect(app.screen()).toMatch(/› first\n +line2\n +line3\n +line4/);
  });

  test("BUG-238/GLUON-38: a focus report at home (a late one, from the session left) is dropped, never typed into the composer as `[I` / `[O` @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await launch(app, "one task");
    await home(app);
    await app.type("ab");
    await app.press(FOCUS.in, FOCUS.out);
    // In one chunk with text too.
    app.write(`${FOCUS.out}c${FOCUS.in}`);
    await app.waitFor("› abc");
    await app.settle(200);
    expect(app.screen()).not.toMatch(/\[[IO]/);
    expect(app.screen()).toContain("› abc");
  });

  test.skipIf(WIN)("BUG-269/GLUON-54: at home the terminal reports clicks (SGR); a click on a session's row selects it, a second opens it; the click's release never reaches the agent, nothing is typed into the composer; the wheel and clicks elsewhere do nothing to the view @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await launch(app, "one task");
    await home(app);
    await launch(app, "two task");
    await home(app);
    expect(app.modes()).toMatchObject({ mouseTracking: "drag", mouseEncoding: "sgr" });
    const m = mark(app);
    const rowY = () => app.row("Gluon-one-task ") + 1;
    const selected = (name: string) => app.bg(4, app.row(`Gluon-${name}-task `)) === GLUON_HEX.selected;
    expect(selected("two")).toBe(true);
    const fullClick = (x: number, y: number) => mouseReports({ op: "click", button: "left", x, y }).join("");
    // Elsewhere (the header, a blank row), the wheel: the home view stays, nothing typed.
    for (const bytes of [fullClick(10, 2), fullClick(10, 1), wheelUp(10, 20), wheelDown(10, 20)]) await app.press(bytes);
    await app.type("ab");
    await app.waitFor("› ab");
    await app.press("\x7f\x7f");
    // The row: selected by the first click, opened by the second (press and release in one read).
    await app.press(fullClick(12, rowY()));
    await app.waitFor(() => selected("one"));
    expect(selected("two")).toBe(false);
    expect(HOME_VIEW.test(app.screen())).toBe(true);
    app.write(fullClick(12, rowY()));
    await app.waitFor((s) => s.includes("◆ gluon"));
    expect(shownTab(app)).toContain("one-task");
    await app.settle(300);
    expect(m.got()).toBe("");
    expect(app.screen()).not.toMatch(/\[<\d/);
    assertInvariants(app, { view: "session" });
  });

  test.skipIf(WIN)("BUG-286/GLUON-61: a drag over the spec in the home chat copies its text (OSC 52) without the box's edges, highlights it and says so on the last row, and picks no option; a key ends the selection @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await toChoice(app, "fix the add bug");
    const top = app.row("spec — what the agent will get");
    expect(top).toBeGreaterThan(0);
    const rows = app.lines();
    const inside = (l: string) => l.trimEnd().replace(/^\s*│ ?/, "").replace(/\s*│$/, "");
    const want = [rows[top + 1]!, rows[top + 2]!].map(inside).join("\n").trimEnd();
    expect(want.trim()).not.toBe("");
    app.mark();
    // Press at the start of the first spec row, release at the end of the next: 1-based cells.
    await app.press(...mouseReports({ op: "drag", button: "left", x: 1, y: top + 2, to: { x: 100, y: top + 3 } }));
    await app.waitFor((s) => s.includes("Copied "));
    const osc = app.since().match(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/);
    expect(osc).not.toBeNull();
    expect(Buffer.from(osc![1]!, "base64").toString("utf8")).toBe(want);
    // The cells are reversed on the terminal (the screen's first spec row, a cell inside the box).
    const reversed = (y: number) => app.term.buffer.active.getLine(app.term.buffer.active.viewportY + y)?.getCell(10)?.isInverse() ? true : false;
    expect(reversed(top + 1)).toBe(true);
    // The spec is still on the screen, and the agent choice still open: the drag picked nothing.
    expect(app.screen()).toContain("keep talking");
    expect(app.screen()).not.toMatch(/\[<\d/);
    // A key ends the selection (the last row's note goes with the next frame or its time); the key is typed.
    await app.type("x");
    await app.waitFor((s) => s.includes("› x"));
    expect(reversed(top + 1)).toBe(false);
  });

  test.skipIf(WIN)("BUG-286/chat gutter: a drag over the intake agent's own message copies its text, without the ◆ and the gutter and page padding before each row @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await toChoice(app, "fix the add bug");
    const top = app.row("A focused change");
    expect(top).toBeGreaterThan(0);
    const rows = app.lines();
    const want = [rows[top]!, rows[top + 1]!].map((l) => l.trim().replace(/^◆\s+/, "")).join("\n");
    app.mark();
    await app.press(...mouseReports({ op: "drag", button: "left", x: 1, y: top + 1, to: { x: 100, y: top + 2 } }));
    await app.waitFor((s) => s.includes("Copied "));
    const osc = app.since().match(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/);
    expect(Buffer.from(osc![1]!, "base64").toString("utf8")).toBe(want);
  });

  test.skipIf(WIN)("BUG-272/GLUON-56: a double-click on the selected home row opens its session once; the second click never reaches the agent, which tracks the mouse @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await launch(app, "one task");
    await say(app, "!mouse", "MOUSE ON");
    await home(app);
    await app.waitFor(() => app.bg(4, app.row("Gluon-one-task ")) === GLUON_HEX.selected);
    const m = mark(app);
    const fullClick = (x: number, y: number) => mouseReports({ op: "click", button: "left", x, y }).join("");
    const y = app.row("Gluon-one-task ") + 1;
    app.write(fullClick(12, y));
    app.write(fullClick(12, y));
    await app.waitFor((s) => s.includes("◆ gluon"));
    await app.settle(500);
    expect(m.got()).toBe("");
    // A click of its own, later, is the agent's.
    await Bun.sleep(450);
    await app.press(fullClick(12, 10));
    const end = performance.now() + 2000 * SLOW;
    while (!m.got() && performance.now() < end) await Bun.sleep(20);
    expect(m.got()).toMatch(/^\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m$/);
  });

  test("BUG-235/GLUON-37: keys in the same burst as the → or Enter that opens a session reach its agent, in order, not the hidden home composer @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await launch(app, "fix the add bug");
    for (const [opener, text] of [[KEYS.right, "zq7"], [KEYS.enter, "x8w"]] as const) {
      await home(app);
      const m = mark(app);
      app.write(`${opener}${text}`);
      await app.waitFor((s) => s.includes("◆ gluon") && s.includes(`❯ ${text}`));
      await gotExactly(m, text);
      await app.press("\x7f".repeat(text.length));
    }
    await home(app);
    await app.settle(200);
    expect(app.screen()).toMatch(/› describe another session/);
  });

  test("BUG-273/GLUON-57: keys in the same read as the Enter that starts a session from the agent choice reach its agent, in order, not the hidden home composer; the home key twice among them goes home @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await toChoice(app, "fix the add bug");
    const m = mark(app);
    app.write(`${KEYS.enter}zq7`);
    await app.waitFor((s) => s.includes("◆ gluon") && s.includes("❯ zq7"), 20_000);
    await gotExactly(m, "zq7");
    await home(app);
    await app.settle(200);
    expect(app.screen()).toMatch(/› describe another session/);
    // Ctrl+\ twice with the Enter: the session starts, then the sessions home shows; nothing typed anywhere.
    await toChoice(app, "another task");
    const m2 = mark(app);
    app.write(`${KEYS.enter}\x1c\x1c`);
    await app.waitFor((s) => HOME_VIEW.test(s) && (s.match(/Gluon-/g) ?? []).length >= 2, 20_000);
    await app.settle(300);
    expect(HOME_VIEW.test(app.screen())).toBe(true);
    expect(app.screen()).toMatch(/› describe another session/);
    expect(m2.got()).toBe("");
  });
});

describe("Gluon: view changes on the wire", () => {
  const BSU = "\x1b[?2026h";
  const ESU = "\x1b[?2026l";
  /** The text the bytes draw, escape sequences left out. */
  const plain = (s: string) => s.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[78=>]/g, "");

  /** The synchronized updates in `raw` (each one's bytes), and what was written outside any. */
  function updates(raw: string) {
    const blocks: string[] = [];
    let outside = "";
    for (let i = 0; i < raw.length; ) {
      const h = raw.indexOf(BSU, i);
      if (h < 0) {
        outside += raw.slice(i);
        break;
      }
      outside += raw.slice(i, h);
      const l = raw.indexOf(ESU, h);
      blocks.push(raw.slice(h + BSU.length, l < 0 ? raw.length : l));
      i = l < 0 ? raw.length : l + ESU.length;
    }
    return { blocks, outside };
  }

  /**
   * The output since the mark: one synchronized update holds the screen's clear and the whole new
   * view (`drawn`), nested in no other; nothing outside an update clears or erases.
   */
  function oneUpdate(app: App, what: string, drawn: RegExp[]) {
    const { blocks, outside } = updates(app.since());
    expect({ what, erasedOutside: /\x1b\[\d*[JK]/.test(outside) }).toEqual({ what, erasedOutside: false });
    const clearing = blocks.filter((b) => b.includes("\x1b[2J"));
    expect({ what, clears: clearing.length }).toEqual({ what, clears: 1 });
    expect({ what, nested: clearing[0]!.includes(BSU) }).toEqual({ what, nested: false });
    for (const re of drawn) expect({ what, drawn: re.test(plain(clearing[0]!)) ? re.source : plain(clearing[0]!) }).toEqual({ what, drawn: re.source });
  }

  test.skipIf(WIN)("BUG-243/GLUON-39: each view change — session → session, session → home, home → session — is one synchronized update holding the clear and the whole new view, and nothing erases outside it (QA NF-2) @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await openSessions(app, ["claude", "claude"]);
    await at(app, 2);
    await app.settle(200);
    app.mark();
    await app.press(KEYS.left);
    await at(app, 1);
    await app.settle(200);
    oneUpdate(app, "session → session", [/◆ gluon/, /ctrl\+\\ sessions/, /claude code × /]);
    app.mark();
    await app.press(KEYS.left);
    await app.waitFor(HOME_VIEW);
    await app.settle(200);
    oneUpdate(app, "session → home", [HOME_VIEW, /Gluon-session-2/]);
    app.mark();
    await app.press(KEYS.right);
    await at(app, 1);
    await app.settle(200);
    oneUpdate(app, "home → session", [/◆ gluon/, /ctrl\+\\ sessions/, /claude code × /]);
  });

  test.skipIf(WIN)("BUG-261/GLUON-43: the sessions home's question and the hint naming its keys come and go in one synchronized update, and the last row is never painted outside one @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await launch(app, "one task");
    await home(app);
    await app.waitFor(() => app.bg(4, app.row("Gluon-one-task ")) === GLUON_HEX.selected);
    await app.settle(300);
    const lastRow = "\x1b7\x1b[30;1H";
    for (const [key, shows, hint] of [
      [KEYS.delete, true, "enter ends it · esc keeps it"],
      [KEYS.esc, false, "del ends it"],
    ] as const) {
      app.mark();
      await app.press(key);
      await app.waitFor((s) => s.includes("End Gluon-one-task?") === shows && s.includes(hint));
      await app.settle(300);
      const { blocks, outside } = updates(app.since());
      expect({ key, outside: outside.includes(lastRow) || plain(outside).trim() !== "" }).toEqual({ key, outside: false });
      // The first update that paints the last row as it is now also draws the hint that goes with it.
      const first = blocks.find((b) => b.includes(lastRow) && plain(b.slice(b.lastIndexOf(lastRow))).includes("End Gluon-one-task?") === shows);
      expect({ key, hint: !!first && plain(first).includes(hint) }).toEqual({ key, hint: true });
    }
  });
});

describe("Gluon: switching sessions (issue #47)", () => {
  /** The bar while the home key waits for the key that picks. */
  const PREFIX_BAR = /^ ←\/→ switch session · ctrl\+\\ home · esc cancel/;
  const PLAIN_BAR = /^ ctrl\+\\ sessions/;
  const SWITCH_BAR = /^ ←\/→ switch session · ctrl\+\\ sessions/;
  const QUESTION_BAR = /^ \? \/clear ends this session/;
  /** What each agent has read so far. */
  const logs = (app: App) => app.inputLogs().map((a) => a.bytes);
  const barIs = (app: App, re: RegExp) => app.waitFor(() => re.test(bar(app)));

  test.skipIf(WIN)("BUG-279/GLUON: ←/→ switch in every state through the home key's prefix — a typed line, the question up, scrolled back; Esc or another key cancels it, time doesn't (BUG-706); going home takes the home key twice @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await openSessions(app, ["claude", "claude", "claude"]);
    await at(app, 3);
    // A typed line: ← is the agent's, the prefix and ← switch.
    await app.type("x");
    await barIs(app, PLAIN_BAR);
    await app.press(KEYS.ctrlBackslash);
    await barIs(app, PREFIX_BAR);
    await app.press(KEYS.left);
    await at(app, 2);
    await barIs(app, SWITCH_BAR);
    // The question up: the prefix's bar takes its place, the question waits on its tab.
    await app.type("/clear");
    await app.press(KEYS.enter);
    await barIs(app, QUESTION_BAR);
    await app.press(KEYS.ctrlBackslash);
    await barIs(app, PREFIX_BAR);
    await app.press(KEYS.right);
    await at(app, 3);
    await app.press(KEYS.ctrlBackslash, KEYS.left);
    await at(app, 2);
    await barIs(app, QUESTION_BAR);
    // No: the line stays typed (the agent's ←/→), the prefix still switches.
    await app.press(KEYS.esc);
    await app.waitFor(() => !QUESTION_BAR.test(bar(app)));
    await app.press(KEYS.ctrlBackslash, KEYS.left);
    await at(app, 1);
    // Scrolled back: the prefix and → leave scroll mode with the switch; ← from the first tab is home.
    await say(app, "!lines 60", "LINE 60");
    await app.press(wheelUp(10, 10));
    await app.waitFor("↑ 3 · esc back");
    await app.press(KEYS.ctrlBackslash);
    await barIs(app, PREFIX_BAR);
    await app.press(KEYS.right);
    await at(app, 2);
    expect(app.screen()).not.toContain("esc back");
    await app.press(KEYS.ctrlBackslash, KEYS.left);
    await at(app, 1);
    await app.press(wheelUp(10, 10));
    await app.waitFor("↑ 3 · esc back");
    await app.press(KEYS.ctrlBackslash, KEYS.left);
    await app.waitFor(HOME_VIEW);
    await app.press(KEYS.right);
    await at(app, 1);
    expect(app.screen()).not.toContain("esc back");
    // Esc cancels the prefix and is swallowed: the session stays, the agent gets nothing.
    const before = logs(app);
    await app.press(KEYS.ctrlBackslash);
    await barIs(app, PREFIX_BAR);
    await app.press(KEYS.esc);
    await barIs(app, SWITCH_BAR);
    await at(app, 1);
    expect(logs(app)).toEqual(before);
    // One home key does not go home; the home key twice does.
    expect(viewOfHome(app)).toBe(false);
    // Another key cancels it and goes on: a letter reaches the agent.
    await app.press(KEYS.ctrlBackslash);
    await barIs(app, PREFIX_BAR);
    await app.press("a");
    await app.waitFor("❯ a");
    await at(app, 1);
    expect(logs(app)[0]).toBe(`${before[0]}a`);
    // BUG-706 (#113): no timeout; the bar is still up long after the old 1.5 s wait. Esc cancels it:
    // ← is then the agent's (the line is typed), not a switch.
    await app.press(KEYS.ctrlBackslash);
    await barIs(app, PREFIX_BAR);
    await app.settle(3200);
    expect(PREFIX_BAR.test(bar(app))).toBe(true);
    await app.press(KEYS.esc);
    await app.waitFor(() => !PREFIX_BAR.test(bar(app)));
    await app.press(KEYS.left);
    await at(app, 1);
    expect(logs(app)[0]).toBe(`${before[0]}a${KEYS.left}`);
    await app.press(KEYS.ctrlBackslash, KEYS.ctrlBackslash);
    await app.waitFor(HOME_VIEW);
    // The keys of the prefix never reached any agent as the home key's own byte.
    expect(logs(app).join("")).not.toContain(KEYS.ctrlBackslash);
  });

  /** The home view is up. */
  const viewOfHome = (app: App) => HOME_VIEW.test(app.screen());

  test("BUG-280/GLUON: Alt+←/→ on an untouched line never reach the agent; on a typed line they do; → on the last tab goes home; Alt+PgUp/PgDn reach the agent @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await openSessions(app, ["claude", "claude"]);
    await at(app, 2);
    const before = logs(app);
    // Untouched: dropped, nothing happens.
    await app.press(KEYS.altLeft);
    await app.press(KEYS.altRight);
    await app.settle(200);
    await at(app, 2);
    expect(logs(app)).toEqual(before);
    expect(app.screen()).not.toContain("ARROW");
    // → on the last tab goes home (it was the agent's once); → again opens the first.
    await app.press(KEYS.right);
    await app.waitFor(HOME_VIEW);
    await app.press(KEYS.right);
    await at(app, 1);
    await app.press(KEYS.altRight);
    await app.settle(200);
    await at(app, 1);
    expect(logs(app)).toEqual(before);
    // A typed line: Alt+←/→ are the agent's.
    await app.type("x");
    await app.press(KEYS.altLeft);
    await app.waitFor("ARROW LEFT");
    await at(app, 1);
    expect(logs(app)[0]).toBe(`${before[0]}x${KEYS.altLeft}`);
    // Alt+PgUp / Alt+PgDn are not Gluon's: the agent gets them, whatever the line, and the view stays.
    await app.press(KEYS.enter);
    await app.waitFor("GOT <x");
    await app.press(KEYS.altPgup);
    await app.press(KEYS.altPgdn);
    await app.settle(200);
    await at(app, 1);
    expect(logs(app)[0]).toBe(`${before[0]}x${KEYS.altLeft}${KEYS.enter}${KEYS.altPgup}${KEYS.altPgdn}`);
    expect(logs(app)[1]).toBe(before[1]);
  });

  test("BUG-281/GLUON: the bar names ←/→ only while the line is untouched and there is another tab, the prefix bar while the home key waits — in its shorter forms when narrow; Esc on the prefix keeps the question @full", async () => {
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await openSessions(app, ["claude", "claude"]);
    await at(app, 2);
    await barIs(app, SWITCH_BAR);
    // Typed: the home key alone; its prefix bar names the keys that pick.
    await app.type("x");
    await barIs(app, PLAIN_BAR);
    expect(bar(app)).not.toContain("switch");
    await app.press(KEYS.ctrlBackslash);
    await barIs(app, PREFIX_BAR);
    await app.press(KEYS.esc);
    await barIs(app, PLAIN_BAR);
    // Enter: untouched again.
    await app.press(KEYS.enter);
    await barIs(app, SWITCH_BAR);
    // The question: the prefix's bar replaces it, Esc ends the prefix only (the question is back), a second Esc answers.
    await app.type("/clear");
    await app.press(KEYS.enter);
    await barIs(app, QUESTION_BAR);
    await app.press(KEYS.ctrlBackslash);
    await barIs(app, PREFIX_BAR);
    await app.press(KEYS.esc);
    await barIs(app, QUESTION_BAR);
    // Narrow: the words shorten.
    await app.press(KEYS.ctrlBackslash);
    await barIs(app, PREFIX_BAR);
    app.resize(40, 24);
    await app.waitFor(() => /^ ←\/→ switch · ctrl\+\\ home · esc/.test(bar(app)));
    app.resize(100, 30);
    await barIs(app, PREFIX_BAR);
    await app.press(KEYS.esc);
    await barIs(app, QUESTION_BAR);
    await app.press(KEYS.esc);
    await app.waitFor(() => !QUESTION_BAR.test(bar(app)));
    assertInvariants(app, { tab: "session-2" });
  });
});

describe("Gluon: where a session works (issue 52)", () => {
  test("issue 52: in a git repository the agent's spec ends with where its worktree goes @full", async () => {
    const dir = repo.tiny();
    const app = await gluon(100, 30, {}, undefined, ["claude"]);
    await launch(app, "alpha task");
    const log = app.agentLog().replaceAll("\\", "/");
    const path = `${dir.replaceAll("\\", "/")}/.gluon/worktrees/gluon-alpha-task`;
    expect(log).toContain("## Where to work");
    expect(log).toContain(`git worktree add -b gluon/alpha-task "${path}" HEAD`);
    expect(log).toContain("Do nothing until the developer agrees");
    // The spec comes first and the block after it; Gluon created nothing.
    expect(log.indexOf("Where to work")).toBeGreaterThan(log.indexOf("alpha task"));
    expect(await Bun.file(`${path}/.git`).exists()).toBe(false);
  });

  test("issue 52: outside a git repository the agent gets the spec alone @full", async () => {
    const cfg = freshConfig(`kit-${process.pid}-wt-nogit`, "handoff:\n  on_clear: ask\n");
    const app = await start({ cwd: repo.noGit(), cols: 100, rows: 30, agents: ["claude"], env: { GLUON_CONFIG: cfg, FAKE_TUI: "1", FAKE_EVENT_HOOK: EVENT_HOOK } });
    await launch(app, "alpha task");
    expect(app.agentLog()).not.toContain("Where to work");
  });
});
