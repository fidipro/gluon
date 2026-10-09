/**
 * Gluon: agent sessions in a frame, several at once, the compositor's keys. The TUI fake's `!`
 * commands drive the agent side (`test/fixtures/fake-tui.ts`). On Windows every test runs but
 * these: exact bytes (ConPTY re-renders output, `src/pty/AGENTS.md`), wide characters (ConPTY
 * re-renders them with its own widths), kitty flags and mouse reports (ConPTY drops or
 * translates the sequences between an agent and Gluon), signals (none on Windows).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDir, freshConfig, repo, WIN } from "./fixtures.ts";
import { App, cli, HOME_VIEW, KEY, SLOW, start, stopAll } from "./harness.ts";
import { click, HOME_KEY, HOME_TWICE, KEYS, wheelUp } from "./actions.ts";
import { GLUON_HEX } from "../../src/ui/theme.ts";
import type { ContextEntry } from "../../src/cost/ledger.ts";
import { readLedger } from "../../src/cost/ledger-file.ts";
import { priceEntry } from "../../src/cost/tables.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

/** Polls until the condition holds (the ledger is written by another process). */
async function waitUntil(ok: () => boolean, ms = 10_000 * SLOW) {
  for (const end = Date.now() + ms; !ok(); await Bun.sleep(50)) if (Date.now() > end) throw new Error("timed out waiting for the ledger");
}

/** The 1-based column of a tab's name on the tab strip. */
const tabX = (app: App, name: string) => app.lines()[0]!.indexOf(name) + 1;

/** The fake's `!event` hook: writes an event as `gluon signal` / a status hook does. */
const eventHook = `"${process.execPath}" --no-env-file "${join(import.meta.dir, "../fixtures/write-event.ts")}"`;

let n = 0;
/** Gluon on the demo brain with the TUI fakes (`claude` and `opencode` on PATH). */
async function gluon(env: Record<string, string> = {}, size: { cols?: number; rows?: number } = {}, yaml = "handoff:\n  on_clear: ask\n") {
  const cfg = freshConfig(`gluon-${++n}`, yaml);
  return start({ cwd: repo.tiny(), cols: size.cols ?? 100, rows: size.rows ?? 30, env: { GLUON_CONFIG: cfg, FAKE_TUI: "1", FAKE_EVENT_HOOK: eventHook, ...env } });
}

/** Walks the demo intake agent to its proposal and starts the recommended agent: resolves with the agent's TUI in the frame. */
async function launch(app: App, task: string) {
  await app.type(task);
  await app.press(KEY.enter);
  await app.waitFor("Should the fix include a regression test", 20_000);
  await app.idle();
  await app.press(KEY.enter);
  await app.waitFor("keep talking", 20_000);
  await app.idle();
  await app.press(KEY.enter);
  await app.waitFor((s) => s.includes("TUI ready") && s.includes("◆ gluon"), 20_000);
}

/** Types a line into the agent and waits for its answer. */
async function say(app: App, line: string, answer: string | RegExp = `GOT <${line}>`) {
  await app.type(line);
  await app.press(KEY.enter);
  await app.waitFor(answer);
}

/** Back home from a session: the home key arms the prefix, the home key again goes home. */
async function home(app: App) {
  await app.press(...HOME_TWICE);
  await app.waitFor(/describe (the|another) session/);
}

/** The sizes the fake printed (`SIZE colsxrows`), on screen. */
const sizes = (app: App) => [...app.screen().matchAll(/SIZE (\d+)x(\d+)/g)].map((m) => `${m[1]}x${m[2]}`);

describe("Gluon: a session in the frame", () => {
  test("GLUON-1: a launch opens the frame — tab strip, info line, the triple in the border; the PTY is the interior; keys reach the agent @full", async () => {
    const app = await gluon();
    await launch(app, "alpha task");
    const lines = app.lines();
    expect(lines[0]).toMatch(/^ ◆ gluon +[●?] Gluon-alpha-task/);
    expect(lines[1]).toMatch(/^ claude code × sonnet 5\.5 × high · now/);
    // A blank row between the info line and the frame (from 24 rows).
    expect(lines[2]).toBe("");
    expect(lines[3]).toMatch(/^┌─ claude code × sonnet 5\.5 × high ─+┐$/);
    // The only tab: no switch key, home has its own (BUG-241).
    expect(lines.at(-1)).toMatch(/^ ctrl\+\\ sessions/);
    expect(lines.at(-1)).not.toContain("switch");
    // 100 × 30 minus the chrome: 2 columns, 6 rows.
    expect(sizes(app).at(-1)).toBe("98x24");
    await say(app, "hello");
    // The agent draws inside the border, which stays put.
    expect(app.lines()[3]).toMatch(/^┌─ claude code/);
    expect(app.lines().find((l) => l.includes("GOT <hello>"))).toMatch(/^│GOT <hello> +│$/);
  });

  test.skipIf(WIN)("GLUON-2: emoji and CJK are drawn in the interior without moving the border @full", async () => {
    const app = await gluon();
    await launch(app, "wide task");
    await say(app, "!wide", "WIDE");
    const y = app.row("WIDE");
    const line = app.term.buffer.active.getLine(app.term.buffer.active.viewportY + y)!;
    expect(line.translateToString(true)).toContain("WIDE 你好世界 🙂");
    // Each cell where a real terminal has it: the painter moves the cursor after a wide character,
    // so a terminal that draws an emoji narrower (as this test's xterm does) doesn't shift the rest.
    expect(line.getCell(0)!.getChars()).toBe("│");
    expect(line.getCell(6)!.getChars()).toBe("你");
    expect(line.getCell(15)!.getChars()).toBe("🙂");
    expect(line.getCell(17)!.getChars()).toBe("👍");
    expect(line.getCell(20)!.getChars()).toBe("e");
    expect(line.getCell(99)!.getChars()).toBe("│");
  });

  test("GLUON-3: the home key shows home while the agent keeps running; reopening shows what it printed meanwhile @full", async () => {
    const app = await gluon();
    await launch(app, "tick task");
    await say(app, "!tick", "TICK 1");
    await home(app);
    expect(app.screen()).toContain("tick-task");
    expect(app.screen()).not.toContain("TICK");
    await Bun.sleep(1000);
    await app.press(KEY.right);
    await app.waitFor("◆ gluon");
    const ticks = () => Math.max(...[...app.screen().matchAll(/TICK (\d+)/g)].map((m) => Number(m[1])));
    expect(ticks()).toBeGreaterThanOrEqual(5);
  });

  test("GLUON-4: the screen model answers the agent's queries (DA1), and only the agent sees the answer @full", async () => {
    const app = await gluon();
    await launch(app, "query task");
    app.mark();
    await say(app, "!da", /DA1 \?\d/);
    // The query never reached the real terminal: the frame is painted from the model.
    if (!WIN) expect(app.since()).not.toContain("\x1b[c");
  });

  test("BUG-201/GLUON-5: keys typed right after the yes to “/clear ends this session in Gluon — end it?” go to the sessions home's composer, also in the same read as the Enter @full", async () => {
    // The agent takes its time over /clear: the session would still be up meanwhile.
    const app = await gluon({ FAKE_CLEAR_DELAY_MS: "3000" });
    for (const [task, keys] of [["first task", ["\rhello"]], ["second task", ["\r", "world"]]] as const) {
      await launch(app, task);
      await app.type("/clear");
      await app.press(KEY.enter);
      await app.waitFor("ends this session in Gluon — end it?");
      for (const k of keys) app.write(k);
      const word = keys.join("").slice(1);
      await app.waitFor((s) => s.split("\n").some((l) => l.trim() === `› ${word}`));
      // Clear the composer for the next round.
      for (const _ of word) await app.press(KEY.backspace);
    }
  });

  test("BUG-192/GLUON-6: an agent that exits closes its session: the sessions home shows, its row gone, the other sessions kept; the chat says how it ended @full", async () => {
    const app = await gluon({ FAKE_EXIT: "7" });
    await launch(app, "stay task");
    await home(app);
    await launch(app, "exit task");
    await app.type("/exit");
    await app.press(KEY.enter);
    await app.waitFor((s) => /describe (the|another) session/.test(s) && s.includes("exit-task exited (code 7)"));
    expect(app.screen()).not.toMatch(/exit-task +claude code/);
    expect(app.screen()).toMatch(/stay-task +claude code/);
    expect(app.screen()).not.toContain("Done");
    // The first tab (→) is the session left.
    await app.press(KEY.right);
    await app.waitFor((s) => s.includes("◆ gluon") && s.includes("stay-task"));
    expect(app.screen()).not.toContain("exit-task");
  });

  test("GLUON-7: `back` from inside the agent shows home; the agent keeps running @full", async () => {
    const app = await gluon();
    await launch(app, "back task");
    await app.type("!event back");
    await app.press(KEY.enter);
    await app.waitFor(/describe (the|another) session/);
    expect(app.screen()).toMatch(/Working|Awaiting input/);
    await app.press(KEY.right);
    await app.waitFor("EVENT back");
    await say(app, "still here");
  });

  test("BUG-193/GLUON-8: a status event shows in the info line, and in the other sessions' counts; the agent's done (its turn finished) reads awaiting input, never Done @full", async () => {
    const app = await gluon();
    await launch(app, "first task");
    await say(app, "!event status done", "EVENT status done");
    await app.waitFor((s) => s.split("\n")[1]!.includes("· awaiting your input"));
    await home(app);
    await app.waitFor(/Awaiting input[\s\S]*first-task/);
    expect(app.screen()).not.toContain("Done");
    await launch(app, "second task");
    await app.waitFor((s) => /\? 1 awaiting/.test(s.split("\n").at(-1)!));
    expect(app.lines().at(-1)).not.toContain("done");
    await say(app, "!event status awaiting", "EVENT status awaiting");
    await app.waitFor((s) => s.split("\n")[1]!.includes("awaiting your input"));
  });
});

describe("Gluon: cost, context and the agent's own questions", () => {
  test("GLUON-16: a Claude Code status event's own figures (cost, tokens, window) are audited only: no cost is shown for them, and never a context % @full", async () => {
    const app = await gluon();
    await launch(app, "figures task");
    await say(app, "!event figures cost=0.5 tokens=100000 window=200000", "EVENT figures");
    // Gluon has no request of its own to price, and Claude's reported total is never the figure (issue #39); the context % is Gluon's own too (BUG-321).
    await app.idle();
    expect(app.lines()[1]).not.toContain("$0.50");
    expect(app.lines()[1]).not.toContain("% context");
  });

  test("BUG-320/step-priced-by-gluon: a step's counts (OpenCode's plugin) are priced from Gluon's table, unmarked; the harness's own total is only audited @full", async () => {
    const app = await gluon();
    await launch(app, "steps task");
    await say(app, "!event figures cost=0.5", "EVENT figures");
    // 1M input + 100k output of deepseek-v4-flash at the bundled table's price (the daily refresh moves it: BUG-413): ours, so no marker; the harness's $0.50 is only audited against it.
    const price = priceEntry("openrouter/deepseek/deepseek-v4-flash")!.cost;
    const ours = ((1_000_000 * price.input! + 100_000 * price.output!) / 1e6).toFixed(2);
    await say(app, "!event step openrouter/deepseek/deepseek-v4-flash 1000000 100000 0.5", "EVENT step");
    await app.waitFor((s) => s.split("\n")[1]!.includes(`· ~$${ours}`) && !s.split("\n")[1]!.includes(`~$${ours}*`));
    expect(app.lines()[1]).not.toContain("$0.50");
  });

  test("GLUON-17: Claude Code's OpenTelemetry export (cost metric, api_request tokens) reaches the info line @full", async () => {
    const app = await gluon();
    await launch(app, "otel task");
    await say(app, "!otel 1.23 380000", "OTEL 200,200");
    // A 1M-window Sonnet: 380k tokens is 38%.
    await app.waitFor((s) => /· ~?\$1\.23 · 38% context/.test(s.split("\n")[1]!));
    // BUG-314: a /compact empties it, as in Claude Code's own status line: no figure until the next request.
    await say(app, "!otel 1.30 compact", "OTEL 200,200");
    // The cost shown is Gluon's own, from the requests it priced; the metric's higher running total is only audited against it.
    await app.waitFor((s) => /· ~?\$1\.23/.test(s.split("\n")[1]!) && !s.split("\n")[1]!.includes("% context"));
    await say(app, "!otel 1.30 100000", "OTEL 200,200");
    await app.waitFor((s) => /· ~?\$2\.53 · 10% context/.test(s.split("\n")[1]!));
  });

  test("BUG-321/plugin-window-is-only-audited: Claude Code's plugin (session.measure) says 380k tokens of a 2M window, and the % stays Gluon's own (38% of 1M; 10% on the next request); the ledger records both (BUG-322) @full", async () => {
    const state = mkdtempSync(join(tmpdir(), "gluon-ledger-"));
    try {
      const app = await gluon({ XDG_STATE_HOME: state });
      await launch(app, "measure task");
      await say(app, "!otel 1.23 380000", "OTEL 200,200");
      await app.waitFor((s) => /· ~?\$1\.23 · 38% context/.test(s.split("\n")[1]!));
      // The plugin's figure is a status like any other: a later status in order (done) shows once it has been handled.
      await say(app, "!event figures tokens=380000 window=2000000", "EVENT figures");
      // A reading that disagrees with ours waits for ours to catch up (BUG-472); the next one (a changed figure: an unchanged one is not sent on) judges it, against what ours is now (38%, not the 10% after the next request).
      await say(app, "!event figures tokens=380001 window=2000000", "EVENT figures");
      await say(app, "!event status done", "EVENT status done");
      await app.waitFor((s) => s.split("\n")[1]!.includes("· awaiting your input"));
      expect(app.lines()[1]).toContain("38% context");
      expect(app.lines()[1]).not.toContain("19% context");
      await say(app, "!otel 1.30 100000", "OTEL 200,200");
      await app.waitFor((s) => /· ~?\$2\.53 · 10% context/.test(s.split("\n")[1]!));
      // BUG-322: the plugin's figures land in the ledger, beside ours: its 2M window against our 1M.
      const context = () => readLedger(join(state, "gluon", "cost-audit")).filter((e): e is ContextEntry => e.kind === "context");
      await waitUntil(() => context().length > 0);
      expect(context()[0]).toMatchObject({ harness: "claude-code", ownTokens: 380_000, reportedTokens: 380_000, ownWindow: 1_000_000, reportedWindow: 2_000_000, ownPct: 38, reportedPct: 19, cause: "window" });
    } finally {
      cleanDir(state);
    }
  });

  test("BUG-359/ledger-and-report: a session with figures shows Gluon's own cost, unmarked (the harness's own total is only audited); the ledger file is in the state dir, and `gluon cost-report` names the harness and a cause @full", async () => {
    const state = mkdtempSync(join(tmpdir(), "gluon-ledger-"));
    try {
      const app = await gluon({ XDG_STATE_HOME: state, LOCALAPPDATA: state });
      await launch(app, "report task");
      await say(app, "!event figures cost=0.5", "EVENT figures");
      await say(app, "!otel 1.23 380000", "OTEL 200,200");
      await app.waitFor((s) => /· ~\$1\.23(?!\*) · 38% context/.test(s.split("\n")[1]!));
      await say(app, "!event figures tokens=380000 window=2000000", "EVENT figures");
      // A reading that disagrees with ours waits for ours (BUG-472): the next reading, or the end of the session, judges it.
      await say(app, "!event figures tokens=380001 window=2000000", "EVENT figures");
      await say(app, "!event status done", "EVENT status done");
      const dir = join(state, "gluon", "cost-audit");
      const entries = () => readLedger(dir);
      await waitUntil(() => entries().some((e) => e.kind === "usage") && entries().some((e) => e.kind === "context" && e.cause === "window"));
      expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
      const r = await cli(["cost-report"], { env: { XDG_STATE_HOME: state, LOCALAPPDATA: state } });
      expect([r.code, r.stderr]).toEqual([0, ""]);
      expect(r.stdout).toMatch(/priced by Gluon[^]*claude-code claude-sonnet[^\n]*: \d+ requests?, \$1\.23/);
      expect(r.stdout).toMatch(/context % audited[^\n]*differ by more than a point\n  claude-code window: \d+ readings? \(own 38% of 1000000, reported 19% of 2000000/);
    } finally {
      cleanDir(state);
    }
  });

  test("BUG-356/audit-off-removes: `cost.audit: off` removes the ledger an earlier launch wrote; with it on, a launch keeps it", async () => {
    const state = mkdtempSync(join(tmpdir(), "gluon-ledger-"));
    try {
      const dir = join(state, "gluon", "cost-audit");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "20260101T000000-1.jsonl");
      writeFileSync(file, '{"kind":"dropped","t":1,"harness":"codex","what":"usage","reason":"x","count":1}\n');
      const env = { XDG_STATE_HOME: state, LOCALAPPDATA: state };
      await gluon(env);
      expect(existsSync(file)).toBe(true);
      await gluon(env, {}, "cost:\n  audit: off\n");
      await waitUntil(() => !existsSync(dir));
      expect(existsSync(join(state, "gluon"))).toBe(true);
    } finally {
      cleanDir(state);
    }
  });

  test("GLUON-19: on_exit: quit — Gluon exits with the agent's code when it was the last session @full", async () => {
    const app = await gluon({ FAKE_EXIT: "5" }, {}, "handoff:\n  on_exit: quit\n");
    await launch(app, "last task");
    await app.type("/exit");
    await app.press(KEY.enter);
    expect(await app.exitCode()).toBe(5);
  });
});

describe("Gluon: several sessions", () => {
  test("GLUON-9: three sessions — → / ← on an untouched line move between the tabs (wrapping through home, BUG-210); a resize reaches every session's PTY @full", async () => {
    const app = await gluon();
    for (const name of ["one", "two", "three"]) {
      await launch(app, `${name} task`);
      await say(app, `me-${name}`);
      if (name !== "three") await home(app);
    }
    const which = () => ["one", "two", "three"].filter((x) => app.screen().includes(`GOT <me-${x}>`));
    // The fallback turns quiet agents to "awaiting": wait until the tab order (by state) is settled.
    await app.waitFor((s) => /\? 2 awaiting/.test(s.split("\n").at(-1)!), 20_000);
    await app.waitFor((s) => s.split("\n")[1]!.includes("awaiting your input"), 20_000);
    expect(which()).toEqual(["three"]);
    // Tabs in launch order, home the ring's leftmost: from the last tab, → is home, then each tab.
    await app.press(KEYS.right);
    await app.waitFor(HOME_VIEW);
    expect(which()).toEqual([]);
    for (const name of ["one", "two", "three"]) {
      await app.press(KEYS.right);
      await app.waitFor((s) => s.includes(`GOT <me-${name}>`) && s.includes("◆ gluon"));
      expect(which()).toEqual([name]);
    }
    await app.press(KEYS.left);
    await app.waitFor("GOT <me-two>");
    await app.press(KEYS.right);
    await app.waitFor("GOT <me-three>");

    app.resize(120, 40);
    await app.waitFor("SIZE 118x34");
    expect(app.lines()[3]).toMatch(/^┌─ .*┐$/);
    expect(Bun.stringWidth(app.lines()[3]!)).toBe(120);
    // The other sessions were resized in the background.
    for (let i = 0; i < 2; i++) {
      await app.press(KEYS.left);
      await app.waitFor("SIZE 118x34");
    }
  });

  test("BUG-210/GLUON: from home → opens the first session (never into the composer); once a key is typed the bar drops ←/→ and the home key's prefix still switches @full", async () => {
    const app = await gluon();
    for (const name of ["one", "two"]) {
      await launch(app, `${name} task`);
      await say(app, `me-${name}`);
      await home(app);
    }
    await app.waitFor(HOME_VIEW);
    const shown = (name: string) => app.waitFor((s) => s.includes(`GOT <me-${name}>`) && s.includes("◆ gluon"));
    await app.press(KEYS.right);
    await shown("one");
    expect(app.lines().at(-1)).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions/);
    await app.type("x");
    await app.waitFor((s) => /^ ctrl\+\\ sessions/.test(s.split("\n").at(-1)!));
    expect(app.lines().at(-1)).not.toContain("switch");
    // Typed: ← is the agent's; the home key's prefix switches — from the first tab, ← is home.
    await app.press(HOME_KEY, KEYS.left);
    await app.waitFor(HOME_VIEW);
    await app.press(KEYS.right);
    await shown("one");
    await app.press(HOME_KEY, KEYS.right);
    await shown("two");
    await app.press(...HOME_TWICE);
    await app.waitFor(HOME_VIEW);
    // Nothing of the keys reached the composer: its placeholder is still there.
    expect(app.screen()).toMatch(/› describe (the|another) session/);
  });

});

describe.skipIf(WIN)("Gluon: the mouse", () => {
  test("GLUON-11: with no mouse tracking in the agent, Gluon reports the wheel and scrolls the frame back; Esc returns @full", async () => {
    const app = await gluon();
    await launch(app, "scroll task");
    // Gluon asks the real terminal for the wheel (SGR reports) while the agent hasn't (at home already: BUG-269).
    expect(app.modes()).toMatchObject({ mouseTracking: "vt200", mouseEncoding: "sgr" });
    await say(app, "!lines 60", "LINE 60");
    expect(app.screen()).not.toContain("LINE 20\n");
    await app.press(wheelUp(10, 10));
    await app.waitFor("↑ 3 · esc back");
    await app.press(KEYS.shiftPgup);
    await app.waitFor(/↑ \d+ · esc back/);
    expect(app.screen()).toMatch(/LINE 2\d\b/);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("esc back"));
    expect(app.screen()).toContain("LINE 60");
  });

  test("BUG-196/GLUON: a click on a tab shows that session, on ◆ gluon the home view — with the strip scrolled (‹ ›) and no mouse asked for @full", async () => {
    // 70 columns: two of the three tabs (`Gluon-…-long-task`) fit beside `◆ gluon`.
    const app = await gluon({}, { cols: 70, rows: 30 });
    for (const name of ["first", "second", "third"]) {
      await launch(app, `${name} long task`);
      await say(app, `me-${name}`);
      if (name !== "third") await home(app);
    }
    // The third shown, the first hidden behind ‹.
    expect(app.lines()[0]).toMatch(/^ ◆ gluon ‹1 .*second-long-task.*third-long-task/);
    await app.press(click(tabX(app, "second-long"), 1));
    await app.waitFor("GOT <me-second>");
    expect(app.screen()).not.toContain("GOT <me-third>");
    await app.press(click(2, 1));
    await app.waitFor(/describe (the|another) session/);
    // From home, → shows the first tab: the strip scrolls back, › marks the hidden ones.
    await app.press(KEY.right);
    await app.waitFor("GOT <me-first>");
    await app.waitFor((s) => s.split("\n")[0]!.endsWith("1›"));
    await app.press(click(tabX(app, "first-long"), 1));
    await app.settle(150);
    expect(app.screen()).toContain("GOT <me-first>");
  });
});

describe("Gluon: quitting", () => {
  test("GLUON-13: Ctrl+C twice with a live session asks first; Esc stays, y quits and ends the agent @full", async () => {
    const pidFile = join(tmpdir(), `gluon-pid-${process.pid}-13`);
    rmSync(pidFile, { force: true });
    const app = await gluon({ FAKE_PID_FILE: pidFile });
    await launch(app, "quit task");
    await home(app);
    await app.press(KEY.ctrlC, KEY.ctrlC);
    await app.waitFor("1 session running — quit and end it?");
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("quit and end it?"));
    expect(await app.exitCode(300)).toBeNull();
    await app.press(KEY.ctrlC, KEY.ctrlC);
    await app.waitFor("quit and end it?");
    // Only Enter says yes (BUG-213): y is ignored, the question stays.
    await app.press("y");
    expect(await app.exitCode(300)).toBeNull();
    expect(app.screen()).toContain("quit and end it?");
    app.mark();
    await app.press(KEY.enter);
    expect(await app.exitCode()).toBe(130);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(false);
    // The terminal back as it was: modes reset, the normal screen, line mode.
    if (!WIN) expect(app.since()).toContain("\x1b[?1049l");
    if (!WIN) expect(app.since()).toContain("\x1b[?25h");
  });

  test.skipIf(WIN)("GLUON-14: SIGTERM ends every agent, restores the terminal and exits 143 @full", async () => {
    const pidFile = join(tmpdir(), `gluon-pid-${process.pid}-14`);
    rmSync(pidFile, { force: true });
    const app = await gluon({ FAKE_PID_FILE: pidFile });
    await launch(app, "term task");
    expect(existsSync(pidFile)).toBe(true);
    app.mark();
    app.signal("SIGTERM");
    expect(await app.exitCode()).toBe(143);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    expect(app.since()).toContain("\x1b[?1049l");
    expect(app.since()).toContain("\x1b[<u");
    // Line mode again.
    const ICANON = process.platform === "darwin" ? 0x100 : 0x2;
    expect(app.localFlags & ICANON).toBe(ICANON);
    // The launch's files went with it.
    const mine = readdirSync(tmpdir()).filter((f) => /^gluon-(events|adapter)-/.test(f) && (() => {
      try {
        return readFileSync(join(tmpdir(), f, "pid"), "utf8").trim() === String(app.pid);
      } catch {
        return false;
      }
    })());
    expect(mine).toEqual([]);
  });

  test("GLUON-15: Ctrl+C twice with no live session quits at once", async () => {
    const app = await gluon();
    await app.press(KEY.ctrlC, KEY.ctrlC);
    expect(await app.exitCode()).toBe(130);
  });
});

describe("Gluon: QA findings", () => {

  test("BUG-262/GLUON-44: an agent that exits while its “End …?” question is up at home takes the question with it — the bar and its hint go with the row, and keys reach the home view again @full", async () => {
    const pidFile = join(tmpdir(), `gluon-pid-${process.pid}-262`);
    rmSync(pidFile, { force: true });
    const app = await gluon({ FAKE_PID_FILE: pidFile });
    await launch(app, "turn task");
    await home(app);
    await app.waitFor(/turn-task[\s\S]*del ends it|del ends it[\s\S]*turn-task/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await app.press(KEY.delete);
    await app.waitFor("? End Gluon-turn-task?  enter yes · esc no");
    expect(app.screen()).toContain("enter ends it · esc keeps it");
    process.kill(pid, "SIGKILL");
    await app.waitFor((s) => !s.includes("End Gluon-turn-task?") && !s.includes("enter ends it"));
    expect(app.screen()).not.toMatch(/^ \? /m);
    await app.type("abc");
    await app.waitFor("› abc");
  });

  test("BUG-164/GLUON-yes, BUG-213/GLUON: Delete on a live row asks “End Gluon-turn-task?”; Esc keeps it, y and n do nothing, Enter ends the agent (SIGTERM) and its row goes @full", async () => {
    const pidFile = join(tmpdir(), `gluon-pid-${process.pid}-164y`);
    rmSync(pidFile, { force: true });
    const app = await gluon({ FAKE_PID_FILE: pidFile });
    await launch(app, "turn task");
    await say(app, "!event status done", "EVENT status done");
    await home(app);
    await app.waitFor(/turn-task[\s\S]*del ends it|del ends it[\s\S]*turn-task/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const question = "? End Gluon-turn-task?  enter yes · esc no";
    await app.press(KEY.delete);
    await app.waitFor(question);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("End Gluon-turn-task?"));
    expect(alive(pid)).toBe(true);
    expect(app.screen()).toContain("turn-task");
    await app.press(KEY.delete);
    await app.waitFor(question);
    await app.press("y");
    await app.press("n");
    await app.settle(300);
    expect(app.screen()).toContain(question);
    expect(alive(pid)).toBe(true);
    await app.press(KEY.enter);
    // Its session closed: the row goes with the agent (BUG-192).
    await app.waitFor((s) => !s.includes("turn-task"));
    // (Windows ends the process tree a moment after the row goes.)
    await app.waitFor(() => !alive(pid), 10_000);
    expect(alive(pid)).toBe(false);
  });

  test.skipIf(WIN)("BUG-200/GLUON-yes: Delete → Enter on an agent slow to exit: its row goes at once (Delete can't ask again, Enter can't reopen it); the agent ends in the background @full", async () => {
    const pidFile = join(tmpdir(), `gluon-pid-${process.pid}-200`);
    rmSync(pidFile, { force: true });
    const app = await gluon({ FAKE_PID_FILE: pidFile, FAKE_HANG: "ignore-term" });
    await launch(app, "hang task");
    await home(app);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await app.press(KEY.delete);
    await app.waitFor("End Gluon-hang-task?");
    await app.press(KEY.enter);
    // Well within KILL_GRACE_MS (3 s), while the agent still ignores its SIGTERM.
    await app.waitFor((s) => !s.includes("hang-task"), 1500);
    expect(alive(pid)).toBe(true);
    await app.press(KEY.delete);
    await app.press(KEY.enter);
    await app.settle(300);
    expect(app.screen()).not.toContain("enter yes · esc no");
    expect(app.screen()).not.toContain("◆ gluon  ●");
    // SIGKILL after the grace.
    const until = Date.now() + 10_000;
    while (alive(pid) && Date.now() < until) await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  });

  test("BUG-193/GLUON: Ctrl+D on the home list marks a session done (its tab and info line say so) and back; Delete on the drafting row asks “Discard this chat?”, Enter starts the chat over @full", async () => {
    const app = await gluon();
    await launch(app, "mark task");
    await home(app);
    await app.waitFor("ctrl+d marks done");
    await app.press("\x04");
    await app.waitFor(/Done\n.*✓ +Gluon-mark-task/);
    await app.waitFor("ctrl+d unmarks done");
    await app.press(KEY.right);
    await app.waitFor((s) => s.split("\n")[1]!.endsWith("· done") || s.split("\n")[1]!.includes("· done "));
    expect(app.lines()[0]).toMatch(/✓ Gluon-mark-task/);
    await home(app);
    await app.press("\x04");
    await app.waitFor((s) => !s.includes("Done") && s.includes("ctrl+d marks done"));
    // A chat being drafted: Delete on its row asks, then the chat starts over.
    await app.type("another thing");
    await app.press(KEY.enter);
    await app.waitFor("Should the fix include a regression test", 20_000);
    await app.idle();
    await app.press(KEY.esc);
    // Past the Drafting label to its row.
    await app.press(KEY.down);
    await app.press(KEY.down);
    await app.waitFor("del discards it");
    await app.press(KEY.delete);
    await app.waitFor("Discard this chat?");
    await app.press(KEY.enter);
    await app.waitFor((s) => !s.includes("Drafting") && !s.includes("Should the fix include"));
    expect(app.screen()).toContain("mark-task");
  });

  test("BUG-179/GLUON: an agent with no status of its own reads Working once it prints, never Starting for good @full", async () => {
    const app = await gluon();
    await launch(app, "quiet task");
    await home(app);
    await app.waitFor(/quiet-task .*Working/);
    expect(app.screen()).not.toContain("Starting");
  });

  test("BUG-183/awaiting: a row waiting on Gluon's own question shows that question as its activity @full", async () => {
    const app = await gluon();
    await launch(app, "ask task");
    await app.type("/clear");
    await app.press(KEY.enter);
    await app.waitFor("ends this session in Gluon — end it?");
    await home(app);
    // At 100 columns the activity is cut after the Gluon- name and the triple ("/clear ends this…").
    await app.waitFor(/Awaiting input[\s\S]*Gluon-ask-task .*\/clear ends th/);
  });

  // Home.tsx keeps `optionCount + 4` rows for an open question, counted in lines; at a narrow
  // width the lead line wraps and its first line (the question itself) is cut from the top.
  test("BUG-167/E: at 60×24 with a session listed, an open question's lead line stays in view @full", async () => {
    const app = await gluon({}, { cols: 60, rows: 24 });
    await launch(app, "first task");
    await home(app);
    await app.type("fix the add bug");
    await app.press(KEY.enter);
    await app.waitFor("the change?", 20_000);
    await app.idle();
    expect(app.screen().replace(/\s+/g, " ")).toContain("◆ Should the fix include a regression test");
  });

});

/** The composer's cursor: its first cell (the placeholder's first letter, or the draft's) drawn inverse. */
function composerCursor(app: App): boolean {
  const y = app.row(/^ {3}› /);
  const buf = app.term.buffer.active;
  return !!buf.getLine(buf.viewportY + y)?.getCell(5)?.isInverse();
}

describe("Gluon: round-2 QA findings", () => {
  test("BUG-231/E: coming home selects the session you came from — the home key twice after →, → past the last tab @full", async () => {
    const app = await gluon({}, { cols: 80, rows: 24 });
    for (const task of ["alpha task", "bravo task", "charlie task"]) {
      await launch(app, task);
      await home(app);
    }
    const selected = () => ["alpha", "bravo", "charlie"].filter((n) => app.bg(4, app.row(`Gluon-${n}-task `)) === GLUON_HEX.selected);
    await app.waitFor(() => selected().join() === "charlie");
    // → opens the first tab; the home key comes back to it.
    await app.press(KEY.right);
    await app.waitFor((s) => s.includes("◆ gluon") && !HOME_VIEW.test(s));
    await home(app);
    await app.waitFor(() => selected().join() === "alpha");
    // → opens the first tab, the home key's prefix and → the next, → again the last; → goes on past it: home, the last tab's row selected.
    await app.press(KEYS.right);
    await app.waitFor((s) => s.includes("◆ gluon") && !HOME_VIEW.test(s));
    await app.press(HOME_KEY, KEYS.right);
    await app.press(KEYS.right);
    await app.waitFor((s) => s.includes("Gluon-charlie-task") && s.includes("◆ gluon") && !HOME_VIEW.test(s));
    await app.settle(200);
    await app.press(KEYS.right);
    await app.waitFor(HOME_VIEW);
    await app.waitFor(() => selected().join() === "charlie");
  });

});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A harness sizes its dialogs from the rows it is given (Claude Code's plan viewport and subagent
 * panel: a dozen rows of its own, the rest is the plan): zoom gives the shown session's PTY the
 * whole terminal but the last row. The fake prints `SIZE colsxrows` at every resize.
 */
describe("Gluon: zoom", () => {
  async function zoomsAt(cols: number, rows: number) {
    const app = await gluon({}, { cols, rows });
    await launch(app, "alpha task");
    await app.waitFor(`SIZE ${cols - 2}x${rows - 5 - (rows >= 24 ? 1 : 0)}`);
    const framed = sizes(app).at(-1)!;
    expect(app.lines()[0]).toMatch(/^ ◆ gluon/);
    // The home key, then z: the frame goes, the agent gets the terminal but the last row, which stays Gluon's.
    await app.press(HOME_KEY);
    await app.waitFor(/esc cancel · z zoom/);
    await app.press("z");
    await app.waitFor(`SIZE ${cols}x${rows - 1}`);
    const lines = app.lines();
    expect(lines.slice(0, rows - 1).join("\n")).not.toMatch(/[┌│└◆]/);
    expect(lines.at(-1)).toMatch(/^ zoomed · ctrl\+\\ z back · ctrl\+\\ sessions/);
    // Keys still reach the agent, the bar stays.
    await app.type("hello");
    await app.press(KEY.enter);
    await app.waitFor("GOT <hello>");
    expect(app.lines().at(-1)).toMatch(/^ zoomed/);
    // Again: the frame is back and the PTY is the interior.
    await app.press(HOME_KEY);
    await app.waitFor(/esc cancel · z unzoom/);
    await app.press("z");
    await app.waitFor(/^ ◆ gluon/m);
    await app.waitFor((s) => sizes({ screen: () => s } as App).at(-1) === framed);
    expect(app.lines().at(-1)).toMatch(/^ ctrl\+\\ sessions/);
  }

  test("BUG-284/zoom: on 80×24 the PTY is 78×18 framed, 80×23 zoomed (Claude Code's plan dialog: 0 plan lines framed, 2 zoomed); the last row stays Gluon's; z again brings the frame back @full", async () => {
    await zoomsAt(80, 24);
  });

});
