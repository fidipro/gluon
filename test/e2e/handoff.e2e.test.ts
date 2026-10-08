/** F. Starting agents: Gluon's frame, the agent's own questions, one at a time without a pseudo-terminal, --launch. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshConfig, repo, WIN } from "./fixtures.ts";
import { App, baseEnv, cli, descendants, GLUON, HOME_VIEW, KEY, MAC_STEALS, SLOW, start, stopAll, toLaunch, toProposal, tracked } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

/** The argv lines the fake agent printed. */
const argv = (text: string) => [...text.matchAll(/ARG\d+=<([\s\S]*?)>(?=\nARG|\nSTTY)/g)].map((m) => m[1]);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Gluon's info line (row 1 of a session's frame). */
const info = (app: App) => app.lines()[1] ?? "";
/** The composer's row on the home view (between its two rules, at the bottom). */
const composer = (app: App) => app.lines().at(-2) ?? "";
/**
 * The demo's session ended: it closed, so the sessions home is up without its row (BUG-192);
 * `line`: what the chat then says (an agent that exited on its own with an error).
 */
const closed = (app: App, line?: string) => app.waitFor((s) => HOME_VIEW.test(s) && !/fix-add-bug +claude code/.test(s) && (!line || s.includes(line)));

describe("from the UI", () => {
  test("F1/BUG-02/BUG-34: Enter launches Claude Code with the spec after --, a sane tty and no AWS leak @full", async () => {
    // FAKE_HANG: the agent stays after its line, so its answer is seen before its session closes (BUG-192).
    const app = await start({ cwd: repo.tiny(), rows: 60, env: { AWS_PROFILE: undefined, FAKE_HANG: "1" } });
    await toLaunch(app);
    expect(info(app)).toMatch(/^ claude code × sonnet 5\.5 × high · /);
    const log = app.agentLog();
    // What the UI launch adds so the agent can send the user back (adapters/) goes between the
    // options and the spec; the spec stays last, after `--`.
    const args = argv(log);
    expect(args.slice(0, 4)).toEqual(["--model", "sonnet", "--effort", "high"]);
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toStartWith("Fix the add bug.");
    expect(log).toContain("STTY: isig icanon echo");
    expect(log).toContain("ENV AWS_PROFILE=unset");
    await app.type("hello");
    await app.press(KEY.enter);
    await app.waitFor("GOT <hello>");
  });

  test("BUG-455/instruction files: the spec ends with a line to read the instruction file the chosen harness doesn't load, and only then @full", async () => {
    // A repository with AGENTS.md and CLAUDE.md: Codex loads AGENTS.md only, Claude Code CLAUDE.md only (with both).
    for (const [fake, file] of [["codex", "CLAUDE.md"], ["claude", "AGENTS.md"]] as const) {
      const app = await start({ cwd: repo.withInstructions(), rows: 60, agents: [fake], env: { FAKE_HANG: "1" } });
      await toLaunch(app);
      const spec = argv(app.agentLog()).at(-1)!;
      expect(spec).toStartWith("Fix the add bug.");
      expect(spec).toContain(`Read \`${file}\` before you start: it is this project's instructions for coding agents, and your harness doesn't load it.`);
      expect(spec.match(/Read `/g)).toHaveLength(1);
    }
    // No instruction file in the repository: nothing is added.
    const plain = await start({ cwd: repo.tiny(), rows: 60, agents: ["codex"], env: { FAKE_HANG: "1" } });
    await toLaunch(plain);
    expect(argv(plain.agentLog()).at(-1)).not.toContain("Read `");
  });

  test("F2: a revised OpenCode proposal launches with --prompt= (no AWS profile, no key when none is connected) @full", async () => {
    const app = await start({ cwd: repo.tiny(), rows: 60 });
    await toProposal(app);
    await app.type("cheaper please");
    await app.press(KEY.enter);
    await app.waitFor("❯ 1. opencode × deepseek flash × max", 20_000);
    await app.idle();
    await app.press(KEY.enter);
    await app.waitFor("type a line>");
    const log = app.agentLog();
    const args = argv(log);
    expect(args[0]).toBe("--standalone");
    expect(args.at(-1)).toStartWith("--prompt=Fix the add bug.");
    expect(log).toContain(`ENV OPENCODE_CONFIG_CONTENT={"model":"opencode-go/deepseek-v4.1-flash","providers":{"opencode-go":{"models":{"deepseek-v4.1-flash":{"settings":{"reasoningEffort":"max"}}}}}}`);
    expect(log).toContain("ENV AWS_PROFILE=unset AWS_REGION=unset");
    expect(log).toContain("ANTHROPIC_API_KEY=unset");
  });

  test("BUG-192/F3: when the agent exits its session closes: home without its row, the chat says how it ended; Ctrl+C twice quits with 130 @full", async () => {
    const app = await launched("f3", { FAKE_EXIT: "3" }, "");
    expect(app.lines().at(-1)).toMatch(/^ ctrl\+\\ sessions/);
    const log = app.agentLog();
    expect(log).toContain("ENV GLUON_EVENTS=set");
    expect(log).toContain("ENV GLUON_HANDOFF=clear,compact");
    await app.press(KEY.enter);
    await closed(app, "Gluon-fix-add-bug exited (code 3)");
    expect(app.screen()).not.toContain("Done");
    await app.press(KEY.ctrlC, KEY.ctrlC);
    expect(await app.exitCode()).toBe(130);
  });
});

/** A FAKE_HOOK that writes this event into $GLUON_EVENTS (what `"$GLUON_SELF" signal …` does). */
const signal = (...args: string[]) => `"${process.execPath}" --no-env-file "${join(import.meta.dir, "../fixtures/write-event.ts")}" ${args.join(" ")}`;
/** Two FAKE_HOOK commands one after the other, in the hook's shell (sh, or cmd.exe on Windows). */
const then = (a: string, b: string) => `${a}${WIN ? " & " : "; "}${b}`;
/** A FAKE_HOOK command that waits `s` seconds (cmd.exe has no sleep that works without a console). */
const pause = (s: number) => (WIN ? `"${process.execPath}" -e "await Bun.sleep(${s * 1000})"` : `sleep ${s}`);

/**
 * The demo's Claude Code proposal, launched: the line-mode fake agent is asking for a line. Its
 * typed `/clear` runs its FAKE_HOOK; `on_clear: stay` (unless the test's config says otherwise)
 * so Gluon doesn't ask about that /clear itself. `direct`: no pseudo-terminal (the agent gets the
 * terminal itself, one session at a time).
 */
async function launched(name: string, env: Record<string, string>, yaml = "handoff:\n  on_clear: stay\n", direct = false) {
  const app = await start({ cwd: repo.tiny(), rows: 60, env: { GLUON_CONFIG: freshConfig(name, yaml), ...(direct ? { GLUON_TEST_NO_PTY: "1" } : {}), ...env } });
  await toLaunch(app);
  return app;
}
const direct = (name: string, env: Record<string, string>, yaml?: string) => launched(name, env, yaml, true);

/**
 * `waitFor` without a pseudo-terminal, saying on a timeout what the terminal and the processes on it
 * were doing: the terminal's local modes and each process under Gluon (state, what it waits on).
 * Only a diagnosis: these tests failed on macOS alone, where nobody can look (BUG-189).
 */
async function waitDirect(app: App, pattern: string) {
  try {
    await app.waitFor(pattern);
  } catch (e) {
    let procs = "";
    if (!WIN) {
      const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,stat=,wchan=,command="], { env: process.env, stdout: "pipe", stderr: "ignore" });
      const rows = ps.stdout.toString().split("\n").map((l) => l.trim().split(/\s+/)).filter((r) => r.length > 4);
      const ours = new Set([String(app.pid)]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const r of rows) if (ours.has(r[1]!) && !ours.has(r[0]!)) grew = !!ours.add(r[0]!);
      }
      procs = rows.filter((r) => ours.has(r[0]!)).map((r) => `  ${r.slice(0, 4).join(" ")} ${r.slice(4).join(" ").slice(0, 120)}`).join("\n");
    }
    throw new Error(`${(e as Error).message}\nterminal lflag=0x${app.localFlags.toString(16)}\nprocesses:\n${procs}`);
  }
}

/** Types `/clear` into the line-mode fake (it runs its FAKE_HOOK) and resolves with how long Gluon took to come back. */
async function clear(app: App, back = "Back from Claude Code") {
  await app.type("/clear");
  const at = performance.now();
  await app.press(KEY.enter);
  await waitDirect(app, back);
  return performance.now() - at;
}

const killLog = (name: string) => join(tmpdir(), `gluon-kill-${name}-${process.pid}.log`);
/**
 * Waits until `file` reads `text`: what an agent ending in the background wrote. On Windows a
 * SIGTERM is TerminateProcess: the fake never gets to write KILLED.
 */
async function waitForFile(file: string, text: string, ms = 15_000 * SLOW) {
  const end = performance.now() + ms;
  let got = "";
  while (performance.now() < end) {
    got = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (got === text) return;
    await Bun.sleep(50);
  }
  expect(got).toBe(text);
}

describe("one session at a time, without a pseudo-terminal (issue #13)", () => {
  test.skipIf(MAC_STEALS || WIN)("F10: the agent gets the terminal itself; `back` from inside it (the return command) ends it at once and shows home with a note @full", async () => {
    const log = killLog("f10");
    const app = await direct("f10", { FAKE_HOOK: signal("back"), FAKE_KILL_LOG: log });
    // The normal screen, not Gluon's frame.
    expect(app.screen()).not.toContain("◆ gluon");
    // Wrapped where the terminal's width falls: compared without whitespace.
    const flat = (t: string) => t.replace(/\s+/g, "");
    expect(flat(app.history())).toContain(flat("gluon: note: no pseudo-terminal here: the agent runs directly in this terminal, one session at a time"));
    expect(app.history()).toContain("Quit Claude Code to come back to Gluon");
    const ms = await clear(app);
    expect(ms).toBeLessThan(2000 * SLOW);
    await app.waitFor(HOME_VIEW);
    expect(app.screen().replace(/\s+/g, " ")).toContain("Back from Claude Code. No pseudo-terminal here, so sessions run one at a time.");
    if (!WIN) expect(readFileSync(log, "utf8")).toBe("KILLED\n");
    expect(app.screen()).not.toContain("exited (code");
    // The session closed: no row left for it (BUG-192).
    expect(app.screen()).not.toMatch(/fix-add-bug +claude code/);
  });

  test.skipIf(MAC_STEALS || WIN)("F13: on_exit: quit exits with the agent's code, but `back` still comes back @full", async () => {
    const app = await direct("f13", { FAKE_HOOK: signal("back"), FAKE_EXIT: "5" }, "handoff:\n  on_exit: quit\n  on_clear: stay\n");
    // Quitting the agent ends Gluon too.
    expect(app.history()).not.toContain("to come back to Gluon");
    await clear(app);
    await app.waitFor(HOME_VIEW);
    const before = app.agentLog().split("FAKE-CLAUDE").length;
    await toProposal(app);
    await app.press(KEY.enter);
    await app.waitFor(() => app.agentLog().split("FAKE-CLAUDE").length > before && app.screen().includes("type a line>"));
    await app.press(KEY.enter);
    expect(await app.exitCode()).toBe(5);
  });

  // Windows has no SIGTERM to ignore: the agent's tree is ended at once (killTree).
  test.skipIf(WIN || MAC_STEALS)("F14: an agent that ignores SIGTERM is killed after 3 s @full", async () => {
    const log = killLog("f14");
    const app = await direct("f14", { FAKE_HOOK: signal("back"), FAKE_HANG: "ignore-term", FAKE_KILL_LOG: log });
    const ms = await clear(app);
    expect(ms).toBeGreaterThan(2900);
    expect(existsSync(log)).toBe(false);
    await app.waitFor(HOME_VIEW);
  });

  // Not on Windows: ConPTY re-renders the output, so the exact reset bytes don't appear.
  test.skipIf(WIN || MAC_STEALS)("F15: the terminal is reset after the agent, and keys it never read don't reach the composer @full", async () => {
    // The hook takes a moment: keys typed meanwhile wait, unread, when the agent ends.
    const app = await direct("f15", { FAKE_HOOK: then(pause(SLOW), signal("back")) });
    app.mark();
    await app.type("/clear");
    await app.press(KEY.enter);
    app.write("zzz");
    await waitDirect(app, "Back from Claude Code");
    await app.settle(300);
    // Its session closed: no run left, the first placeholder (BUG-192).
    expect(composer(app)).toMatch(/^ {3}› describe the session you want/);
    expect(app.since()).toContain("\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[?1004l");
  });

  test.skipIf(MAC_STEALS || WIN)("F17: the return command `\"$GLUON_SELF\" signal back` brings the user back (v1's `signal clear` no longer does anything) @full", async () => {
    // The return command as a harness's shell runs it: here GLUON_SELF is the launch's wrapper (gluon.cmd on Windows, BUG-144).
    const self = (words: string) => (WIN ? `call "%GLUON_SELF%" ${words}` : `"$GLUON_SELF" ${words}`);
    const app = await direct("f17", { FAKE_HOOK: then(self("signal clear"), self("signal back")) });
    await clear(app);
    expect(app.screen()).not.toContain("(/clear)");
  });

  test.skipIf(MAC_STEALS || WIN)("F19: status events (the harnesses' status hooks, the real `gluon hook`) never end the agent @full", async () => {
    const self = (words: string) => (WIN ? `call "%GLUON_SELF%" ${words}` : `"$GLUON_SELF" ${words}`);
    // Two status events, then time for several polls before the agent asks again.
    const app = await direct("f19", { FAKE_HOOK: then(then(self("hook claude-code stop"), signal("status", "awaiting")), pause(SLOW)) });
    await app.type("/clear");
    await app.press(KEY.enter);
    await waitDirect(app, "HOOK ran");
    await app.type("still here");
    await app.press(KEY.enter);
    await app.waitFor("Claude Code exited (code 7)");
    expect(app.screen()).not.toMatch(/fix-add-bug +claude code/);
    expect(app.history({ normal: true })).toContain("GOT <still here>");
    expect(app.screen()).not.toContain("Back from Claude Code");
  });
});

describe("returning home (issue #13)", () => {
  test("F16: the config file gets its handoff section at the first launch from the UI, not before @full", async () => {
    const cfg = freshConfig("f16", "# mine\n");
    const dry = await cli(["--launch", "claude-code", "--model", "sonnet", "--dry-run", "x"], { env: { GLUON_CONFIG: cfg } });
    expect(dry.code).toBe(0);
    expect(readFileSync(cfg, "utf8")).toBe("# mine\n");
    const app = await start({ cwd: repo.tiny(), rows: 60, env: { GLUON_CONFIG: cfg } });
    await toLaunch(app);
    expect(readFileSync(cfg, "utf8")).toStartWith("# mine\n");
    expect(readFileSync(cfg, "utf8")).toContain("  on_exit: return");
    await app.press(KEY.enter);
    await closed(app, "exited (code 7)");
  });

  test("F18: --launch is unchanged: no channel back, no line about returning, the agent's exit code", async () => {
    const app = new App({ cwd: repo.tiny(), args: ["--launch", "claude-code", "--model", "sonnet", "fix it"], env: { FAKE_EXIT: "4" }, agents: ["claude"], noDemo: true, rows: 40 });
    await app.waitFor("type a line>");
    const h = app.history();
    expect(h).toContain("ENV GLUON_EVENTS=unset");
    expect(h).toContain("ENV GLUON_HANDOFF=unset");
    expect(h).not.toContain("come back to");
    expect(h).not.toContain("◆ gluon");
    await app.press(KEY.enter);
    expect(await app.exitCode()).toBe(4);
  });
});

/** The bottom bar's questions (in 100 columns). */
const END_BAR = "? /clear ends this session in Gluon — end it?  enter yes · esc no";
/** The same for a typed /new (BUG-270). */
const NEW_BAR = "? /new ends this session in Gluon — end it?  enter yes · esc no";
/** Empties the agent's typed line (the fake TUI's Ctrl+C), after a no left a command on it (BUG-234). */
async function clearLine(app: App) {
  const n = app.screen().split("CTRL-C").length;
  await app.press(KEY.ctrlC);
  await app.waitFor((s) => s.split("CTRL-C").length > n);
}
const COMPACT_BAR = "? End this session instead of compacting?  enter yes · esc no";

/** The demo's Claude Code proposal, launched with the fake's raw-mode TUI (`FAKE_TUI`): its prompt is up in the frame. */
async function tui(env: Record<string, string> = {}, yaml?: string) {
  const app = await start({ cwd: repo.tiny(), rows: 60, cols: 100, env: { FAKE_TUI: "1", ...(yaml ? { GLUON_CONFIG: freshConfig(`tui-${Math.random().toString(36).slice(2)}`, yaml) } : {}), ...env } });
  await toLaunch(app, "TUI ready");
  return app;
}

/** The last visible row (the bottom bar, where the question is drawn). */
const lastRow = (app: App) => app.term.buffer.active.getLine(app.term.buffer.active.viewportY + app.term.rows - 1)!.translateToString(true);

/** Waits for a file the agent's hook writes (it may outlive the agent by a moment). */
async function fileText(path: string): Promise<string> {
  for (let i = 0; i < 50 * SLOW && !existsSync(path); i++) await Bun.sleep(50);
  return readFileSync(path, "utf8");
}

/** Whether a process is gone within 2 s. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(50);
    } catch {
      return true;
    }
  }
  return false;
}

const answerLog = (name: string) => join(tmpdir(), `gluon-answer-${name}-${process.pid}.log`);

describe("the agent in Gluon's frame (issue #13 v2)", () => {
  test("F20: Ctrl+\\ twice shows home at once, with no question (the first arms the prefix and names it in the bar); the keys never reach the agent, which keeps running @full", async () => {
    const log = killLog("f20");
    const app = await tui({ FAKE_KILL_LOG: log });
    app.write("\x1c");
    await app.waitFor((s) => /^ ←\/→ switch session · ctrl\+\\ home · esc cancel/.test(s.split("\n").at(-1)!));
    const at = performance.now();
    app.write("\x1c");
    await app.waitFor(HOME_VIEW);
    expect(performance.now() - at).toBeLessThan(2000 * SLOW);
    expect(app.screen()).not.toContain("enter yes");
    expect(existsSync(log)).toBe(false);
    await app.press(KEY.right);
    await app.waitFor("TUI ready");
    await app.type("x");
    await app.press(KEY.enter);
    await app.waitFor("GOT <x>");
  });

  test("F21: Ctrl+\\ in the kitty keyboard protocol (twice) goes home too; kitty keys reach the agent @full", async () => {
    const app = await tui({ FAKE_KITTY: "1" });
    await app.type("hi");
    // Enter as the kitty protocol encodes it.
    await app.press("\x1b[13u");
    await app.waitFor("GOT <hi>");
    app.write("\x1b[92;5u");
    await app.waitFor((s) => /^ ←\/→ switch session · ctrl\+\\ home/.test(s.split("\n").at(-1)!));
    app.write("\x1b[92;5u");
    await app.waitFor(HOME_VIEW);
  });

  test("F22: typing goes through: editing, Tab completion, the slash menu; the agent's /exit ends its session @full", async () => {
    const app = await tui();
    await app.type("helx");
    await app.press(KEY.backspace);
    await app.type("lo");
    await app.press(KEY.enter);
    await app.waitFor("GOT <hello>");
    await app.type("/he");
    await app.press("\t");
    await app.waitFor("❯ /help");
    await app.press(KEY.enter);
    await app.waitFor("GOT </help>");
    await app.type("/");
    await app.waitFor((s) => s.includes("/compact") && s.includes("/exit"));
    await app.press(KEY.down, KEY.down, KEY.down, KEY.down);
    await app.press(KEY.enter);
    await closed(app, "fix-add-bug exited (code 7)");
  });

  test("F22b: Ctrl+C is a key for the agent: Gluon stays out of it @full", async () => {
    const app = await tui();
    await app.press(KEY.ctrlC);
    await app.waitFor("CTRL-C");
    await app.press(KEY.ctrlC);
    await closed(app, "fix-add-bug exited (code 130)");
    expect(await app.exitCode(300)).toBeNull();
  });

  test("F23: colours and resizes pass through @full", async () => {
    const app = await tui();
    // 100 × 60 minus the chrome.
    expect(app.screen()).toContain("SIZE 98x54");
    const y = app.row("RED TUI ready");
    const cell = app.term.buffer.active.getLine(app.term.buffer.active.viewportY + y)!.getCell(1)!;
    expect(cell.isFgPalette() ? cell.getFgColor() : -1).toBe(1);
    app.resize(90, 50);
    await app.waitFor("SIZE 88x44");
  });

  test("F24: auto-compaction (a waiting PreCompact hook) asks; Enter answers yes and ends the session @full", async () => {
    const log = answerLog("f24");
    const app = await tui({ FAKE_HOOK: signal("compact", "c24", "--wait"), FAKE_ANSWER_LOG: log });
    await app.type("!compact");
    await app.press(KEY.enter);
    await app.waitFor(COMPACT_BAR);
    expect(lastRow(app)).toContain(COMPACT_BAR);
    await app.press(KEY.enter);
    await closed(app);
    expect(app.screen()).not.toContain("exited (code");
  });

  test("BUG-151: yes to an auto-compaction ends the agent before its hook answers (no \"blocked\" message) @full", async () => {
    const log = answerLog("bug151");
    const pidFile = join(tmpdir(), `gluon-pid-bug151-${process.pid}`);
    // POSIX: the hook outlives the agent's hangup, as a hook in its own process group would.
    const hook = signal("compact", "c151", "--wait", String(20_000 * SLOW));
    const app = await tui({ FAKE_HOOK: WIN ? hook : `trap '' HUP; ${hook}`, FAKE_ANSWER_LOG: log, FAKE_PID_FILE: pidFile });
    const agent = Number(readFileSync(pidFile, "utf8"));
    await app.type("!compact");
    await app.press(KEY.enter);
    await app.waitFor(COMPACT_BAR);
    await app.press(KEY.enter);
    await closed(app);
    // The harness never got a hook that stopped the compaction (the fake's "blocked" line).
    expect(app.screen()).not.toContain("COMPACT BLOCKED");
    expect(await gone(agent)).toBe(true);
    // No answer was written: the hook found its events dir gone and ended quietly.
    if (!WIN) expect(await fileText(log)).toBe("none\n");
  });

  test("F25: Esc answers no: the frame is as it was, the agent compacts and goes on @full", async () => {
    const log = answerLog("f25");
    // The hook lingers after the answer: the agent draws nothing meanwhile.
    const app = await tui({ FAKE_HOOK: then(signal("compact", "c25", "--wait"), pause(2 * SLOW)), FAKE_ANSWER_LOG: log });
    await app.type("!compact");
    const before = app.lines();
    await app.press(KEY.enter);
    await app.waitFor(COMPACT_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes"));
    // The question sat in the bottom bar: the agent's frame never changed (the info line may say
    // awaiting); the bar is back (the only tab: no switch key, BUG-241).
    expect(app.lines().slice(2, -1)).toEqual(before.slice(2, -1));
    expect(app.lines().at(-1)).toMatch(/^ ctrl\+\\ sessions/);
    expect(await fileText(log)).toBe("no\n");
    await app.waitFor("AUTO COMPACTED");
    await app.type("x");
    await app.press(KEY.enter);
    await app.waitFor("GOT <x>");
  });

  test("F26: an unanswered compaction question lets the agent compact @full", async () => {
    const log = answerLog("f26");
    const app = await tui({ FAKE_HOOK: signal("compact", "c26", "--wait"), FAKE_ANSWER_LOG: log, GLUON_TEST_COMPACT_TIMEOUT_MS: "500" });
    await app.type("!compact");
    await app.press(KEY.enter);
    await app.waitFor("AUTO COMPACTED");
    expect(app.screen()).not.toContain("enter yes");
    expect(await fileText(log)).toBe("no\n");
  });

  test("F27: a failure in Gluon ends every agent and gives the terminal back @full", async () => {
    const pidFile = join(tmpdir(), `gluon-pid-f27-${process.pid}`);
    const app = await tui({ GLUON_TEST_PTY_FAIL: "1", FAKE_PID_FILE: pidFile });
    const pid = Number(readFileSync(pidFile, "utf8"));
    app.mark();
    app.write("%");
    expect(await app.exitCode()).toBe(1);
    // ConPTY re-renders the output: the exact reset bytes show only on POSIX.
    if (!WIN) expect(app.since()).toContain("\x1b[?1049l");
    expect(await gone(pid)).toBe(true);
  });

  test.skipIf(WIN)("BUG-149: SIGTERM or SIGHUP ends the agents and restores the terminal", async () => {
    // ECHO is 0x8 everywhere; ICANON 0x2 on Linux, 0x100 on macOS.
    const ICANON = process.platform === "darwin" ? 0x100 : 0x2;
    for (const [sig, code] of [
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const) {
      const pidFile = join(tmpdir(), `gluon-pid-bug149-${sig}-${process.pid}`);
      const log = killLog(`bug149-${sig}`);
      const app = await tui({ FAKE_PID_FILE: pidFile, FAKE_KILL_LOG: log });
      const agent = Number(readFileSync(pidFile, "utf8"));
      // The launch's own files carry Gluon's pid.
      const mine = () =>
        readdirSync(tmpdir()).filter((n) => /^gluon-(events|adapter)-/.test(n) && (() => {
          try {
            return readFileSync(join(tmpdir(), n, "pid"), "utf8").trim() === String(app.pid);
          } catch {
            return false;
          }
        })());
      expect(mine().length).toBeGreaterThan(0);
      expect(app.localFlags & ICANON).toBe(0);
      app.mark();
      app.signal(sig);
      expect(await app.exitCode()).toBe(code);
      expect(app.since()).toContain("\x1b[?1049l");
      expect(app.localFlags & ICANON).toBe(ICANON);
      expect(app.localFlags & 0x8).toBe(0x8);
      expect(readFileSync(log, "utf8")).toBe("KILLED\n");
      expect(await gone(agent)).toBe(true);
      expect(mine()).toEqual([]);
    }
  });
});

describe("the question at the agent's /clear and /compact (issue #13 v2)", () => {
  test("BUG-192/F30: a typed /clear asks; Enter: the agent's own /clear runs first, then the session ends and closes — the sessions home, its row gone @full", async () => {
    const log = killLog("f30");
    const app = await tui({ FAKE_KILL_LOG: log });
    await app.type("/clear");
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    expect(app.screen()).not.toContain("CLEARED");
    const at = performance.now();
    await app.press(KEY.enter);
    await closed(app);
    expect(performance.now() - at).toBeLessThan(2500 * SLOW);
    // The agent ran its own /clear before it was ended (in the background, after home showed).
    await waitForFile(log, WIN ? "CLEARED\n" : "CLEARED\nKILLED\n");
    // Ended at the user's yes: no line about an exit code, no Done group.
    expect(app.screen()).not.toContain("exited (code");
    expect(app.screen()).not.toContain("Done");
  });

  test("BUG-145/F30: yes waits for the agent's output after the forwarded Enter @full", async () => {
    // The agent answers /clear only after a moment: the output from before the question (the
    // typed line's echo) must not count as the agent having settled.
    const log = killLog("bug145");
    const app = await tui({ FAKE_CLEAR_DELAY_MS: "200", FAKE_KILL_LOG: log });
    await app.type("/clear");
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    // The user takes a moment to answer (longer than the quiet time).
    await Bun.sleep(500);
    await app.press(KEY.enter);
    await closed(app);
    // The agent's /clear ran before it was ended.
    await waitForFile(log, WIN ? "CLEARED\n" : "CLEARED\nKILLED\n");
  });

  test("BUG-146/F23: a resize while the bar is up redraws it @full", async () => {
    const app = await tui();
    await app.type("/clear");
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    app.resize(90, 66);
    await app.waitFor(() => lastRow(app).includes(END_BAR));
    app.resize(80, 40);
    await app.waitFor(() => lastRow(app).includes(END_BAR));
    // Still a question: Esc sends nothing, /clear stays typed (BUG-234).
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes") && s.includes("❯ /clear"));
    expect(app.screen()).not.toContain("CLEARED");
  });

  test("BUG-147/F32: Esc that closes the slash menu keeps the typed / line @full", async () => {
    const app = await tui();
    const menu = () => app.lines().some((l) => /^│ {2}\/clear +│$/.test(l));
    await app.type("/clear");
    await app.waitFor(menu);
    await app.press(KEY.esc);
    await app.waitFor(() => !menu() && app.screen().includes("❯ /clear"));
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes") && s.includes("❯ /clear"));
    expect(app.screen()).not.toContain("CLEARED");
  });

  test("BUG-150/F30: /clear and Enter in one chunk still asks @full", async () => {
    const app = await tui();
    app.write("/clear\r");
    await app.waitFor(END_BAR);
    expect(app.screen()).not.toContain("CLEARED");
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes") && s.includes("❯ /clear"));
    expect(app.screen()).not.toContain("CLEARED");
    // The line kept is the user's to edit (Ctrl+C empties it); ordinary lines in one chunk still go straight through.
    await clearLine(app);
    app.write("hello\r");
    await app.waitFor("GOT <hello>");
    expect(app.screen()).not.toContain("enter yes");
  });

  test("BUG-234/F31: Esc sends nothing — /clear stays typed and the session goes on; Enter on it asks again (/new too) @full", async () => {
    const app = await tui();
    await app.type("/clear");
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes") && s.includes("❯ /clear"));
    expect(app.screen()).not.toContain("CLEARED");
    // The same line, Enter again: asked again.
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    await app.press(KEY.esc);
    await clearLine(app);
    await app.type("/new");
    await app.press(KEY.enter);
    await app.waitFor(NEW_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes") && s.includes("❯ /new"));
    expect(app.screen()).not.toContain("CLEARED");
    expect(info(app)).not.toMatch(/ended|exited/);
  });

  test("F32: /cl + Tab, and /clear picked from the slash menu, ask too; /compact picked from it asks about compacting @full", async () => {
    const app = await tui();
    await app.type("/cl");
    await app.press("\t");
    await app.waitFor("❯ /clear");
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes"));
    await clearLine(app);
    await app.type("/c");
    await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor(COMPACT_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes"));
    expect(app.screen()).not.toMatch(/CLEARED|COMPACTED/);
  });

  test("BUG-234/F33: a typed /compact asks each time; Esc sends nothing (no compaction, no hook asks), Enter ends without compacting @full", async () => {
    const log = answerLog("f33");
    // As a PreCompact hook would, were the agent to compact.
    const app = await tui({ FAKE_HOOK: signal("compact", "c33", "--wait", "1500"), FAKE_ANSWER_LOG: log });
    await app.type("/compact");
    await app.press(KEY.enter);
    await app.waitFor(COMPACT_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes") && s.includes("❯ /compact"));
    await app.settle(500);
    expect(app.screen()).not.toContain("COMPACTED");
    expect(existsSync(log)).toBe(false);
    // The same line, Enter again: asked again.
    await app.press(KEY.enter);
    await app.waitFor(COMPACT_BAR);
    app.mark();
    await app.press(KEY.enter);
    await closed(app);
    // The agent never compacted again (ConPTY re-renders the whole screen: POSIX only).
    if (!WIN) expect(app.since()).not.toContain("COMPACTED");
  });

  test("BUG-191: in a Codex-shaped session, a typed /clear, /cl + Tab, the menu's /clear and /new ask; yes ends the agent @full", async () => {
    // Only `codex` installed: the demo proposes it; the fake draws Codex's composer and menu.
    const app = await start({ cwd: repo.tiny(), rows: 30, cols: 100, agents: ["codex"], env: { FAKE_TUI: "1" } });
    await toLaunch(app, "TUI ready");
    expect(info(app)).toMatch(/^ codex × /);
    await app.type("/cl");
    await app.press("\t");
    await app.waitFor("› /clear");
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes"));
    await clearLine(app);
    await app.type("/c");
    await app.waitFor((s) => /› \/clear +clear the terminal/.test(s));
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes"));
    await clearLine(app);
    await app.type("/new");
    await app.press(KEY.enter);
    await app.waitFor(NEW_BAR);
    await app.press(KEY.esc);
    await app.waitFor((s) => !s.includes("enter yes"));
    expect(app.screen()).not.toContain("CLEARED");
    await clearLine(app);
    await app.type("/clear");
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    await app.press(KEY.enter);
    await app.waitFor((s) => HOME_VIEW.test(s) && !/fix-add-bug +codex/.test(s));
  });

  test("BUG-191/busy: a yes to /clear shows the sessions home at once while a busy agent still ends @full", async () => {
    // Codex mid-turn refuses /clear and keeps printing, so it is ended only after SETTLE_MAX_MS
    // (10 s); the user is home long before that.
    const app = await start({ cwd: repo.tiny(), rows: 30, cols: 100, agents: ["codex"], env: { FAKE_TUI: "1" } });
    await toLaunch(app, "TUI ready");
    await app.type("!tick");
    await app.press(KEY.enter);
    await app.waitFor("TICK 2");
    await app.type("/clear");
    await app.press(KEY.enter);
    await app.waitFor(END_BAR);
    const yes = performance.now();
    await app.press(KEY.enter);
    await app.waitFor((s) => HOME_VIEW.test(s) && !/fix-add-bug +codex/.test(s));
    expect(performance.now() - yes).toBeLessThan(5000 * SLOW);
  });

  test("F34: a pasted /clear never asks; on_clear: stay never asks @full", async () => {
    const app = await tui();
    await app.paste("/clear");
    await app.press(KEY.enter);
    await app.waitFor("CLEARED");
    expect(app.screen()).not.toContain("enter yes");
    const stay = await tui({}, "handoff:\n  on_clear: stay\n");
    await stay.type("/clear");
    await stay.press(KEY.enter);
    await stay.waitFor("CLEARED");
    expect(stay.screen()).not.toContain("enter yes");
  });
});

describe("--launch", () => {
  // The agent has the terminal; a signal to Gluon alone (a test timeout, `kill`, a closed window) must reach it too.
  for (const [signal, code, hang, note] of [
    ["SIGTERM", 143, "1", ""],
    ["SIGHUP", 129, "1", ""],
    // An agent that ignores SIGTERM is killed after KILL_GRACE_MS: more than the fast tier's 3 s.
    ["SIGTERM", 143, "ignore-term", " (an agent that ignores it is killed after the grace; still 143, the signal Gluon got) @full"],
  ] as const) {
    (WIN ? test.skip : test)(`BUG-572/launch-signal: ${signal} to a --launch Gluon ends the agent too, and Gluon exits ${code}${note}`, async () => {
      const proc = tracked(Bun.spawn([...GLUON, "--launch", "claude-code", "--model", "sonnet", "fix it"], {
        cwd: repo.tiny(),
        env: baseEnv(["claude"], { FAKE_HANG: hang }),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }));
      let agents: number[] = [];
      try {
        for (const end = Date.now() + 15_000 * SLOW; !agents.length && Date.now() < end; await Bun.sleep(50)) agents = descendants(proc.pid);
        expect(agents.length).toBeGreaterThan(0);
        proc.kill(signal);
        expect(await Promise.race([proc.exited, Bun.sleep(8000 * SLOW).then(() => null)])).toBe(code);
        for (const end = Date.now() + 3000 * SLOW; agents.some(isAlive) && Date.now() < end; await Bun.sleep(50));
        expect(agents.filter(isAlive)).toEqual([]);
      } finally {
        for (const pid of agents) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        proc.kill(9);
      }
    });
  }

  test("BUG-134: OpenCode 1.x isn't started (its launch changed in 2.x): the spec is printed with the command that installs 2.x", async () => {
    const r = await cli(["--launch", "opencode", "--model", "deepseek-flash", "fix the add bug"], { env: { FAKE_VERSION: "1.18.34" }, agents: ["opencode"] });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("couldn't launch opencode: OpenCode 1.18.34 is too old for Gluon (it needs 2.x):");
    expect(r.stderr).toContain("fix the add bug");
    expect(r.stdout + r.stderr).not.toContain("FAKE-OPENCODE");
  });

  test("BUG-02/G9: a prompt that starts with '-' is the prompt", async () => {
    const r = await cli(["--launch", "claude-code", "--model", "sonnet", "--dry-run", "- fix the thing"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).argv).toEqual(["claude", "--model", "sonnet", "--", "- fix the thing"]);
    const oc = await cli(["--launch", "opencode", "--model", "deepseek-flash", "--dry-run", "--", "- fix"]);
    expect(JSON.parse(oc.stdout).argv.at(-1)).toBe("--prompt=- fix");
  });

  test("--mode: explore and plan add the harness's own options before the spec; build adds nothing; the mode is on the command @full", async () => {
    // Each call is stopped when it hangs, and says which one (CI's Windows run timed out at 120 s with no word of which of the seven).
    const dry = async (harness: string, model: string, mode: string) => {
      const r = await cli(["--launch", harness, "--model", model, "--mode", mode, "--dry-run", "--", "- fix"], { timeoutMs: 30_000 * SLOW });
      if (r.code !== 0) throw new Error(`--launch ${harness} --mode ${mode} --dry-run: exit ${r.code}, stdout ${JSON.stringify(r.stdout.slice(0, 300))}, stderr ${JSON.stringify(r.stderr.slice(0, 300))}`);
      return JSON.parse(r.stdout);
    };
    const explore = await dry("claude-code", "sonnet", "explore");
    expect(explore.mode).toBe("explore");
    expect(explore.argv).toEqual(["claude", "--model", "sonnet", "--permission-mode", "dontAsk", "--disallowedTools", "Edit", "Write", "NotebookEdit", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "--", "- fix"]);
    expect((await dry("claude-code", "sonnet", "plan")).argv).toEqual(["claude", "--model", "sonnet", "--permission-mode", "plan", "--", "- fix"]);
    const build = await dry("claude-code", "sonnet", "build");
    expect(build.argv).toEqual(["claude", "--model", "sonnet", "--", "- fix"]);
    expect(build.mode).toBeUndefined();
    expect((await dry("grok-build", "grok-4.7", "explore")).argv).toEqual(["grok", "-m", "grok-4.7", "--sandbox", "read-only", "--deny", "Edit", "--deny", "Write", "--deny", "Bash", "--", "- fix"]);
    expect((await dry("codex", "gpt-6.1-sol", "explore")).argv).toEqual(["codex", "-m", "gpt-6.1-sol", "-s", "read-only", "-a", "never", "--", "- fix"]);
    expect((await dry("antigravity", "gemini-3.8-flash", "explore")).argv).toEqual(["agy", "--model=gemini-3.8-flash-high", "--mode=plan", "--prompt-interactive=- fix"]);
    // OpenCode: the explore agent is in the config it gets, readable in the dry run.
    const oc = await dry("opencode", "deepseek-flash", "explore");
    expect(oc.argv).toEqual(["opencode", "--standalone", "--prompt=- fix"]);
    const config = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT);
    expect(config).toMatchObject({ model: "opencode-go/deepseek-v4.1-flash", default_agent: "gluon-explore" });
    expect(config.agents["gluon-explore"].permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
  });

  test("--mode explore reaches the agent when launched for real (a fake agent prints its argv)", async () => {
    const app = new App({ cwd: repo.tiny(), args: ["--launch", "grok-build", "--model", "grok-4.7", "--mode", "explore", "- look"], env: { GLUON_CONFIG: freshConfig("launch-mode-explore", "connections: { grok-build: { auth: subscription } }\n") }, agents: ["grok"], noDemo: true, rows: 40, cols: 120 });
    await app.waitFor("type a line>");
    expect(argv(app.history())).toEqual(["-m", "grok-4.7", "--sandbox", "read-only", "--deny", "Edit", "--deny", "Write", "--deny", "Bash", "--", "- look"]);
  });

  test("--mode plan on Codex is refused (nothing can type /plan into it here), a dry run included, before anything starts; explore and build go @full", async () => {
    for (const extra of [[], ["--dry-run"]]) {
      const r = await cli(["--launch", "codex", "--model", "gpt-6.1-sol", "--mode", "plan", ...extra, "fix it"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Codex starts in plan mode only in Gluon's frame (Gluon types /plan into it); use --mode explore or build");
      expect(r.stdout).not.toContain("/plan");
      expect(r.stdout + r.stderr).not.toContain("FAKE-");
    }
    expect((await cli(["--launch", "codex", "--model", "gpt-6.1-sol", "--mode", "plan", "--dry-run", "fix it"], { agents: [] })).code).toBe(2);
    const grok = await cli(["--launch", "grok-build", "--model", "grok-4.7", "--mode", "plan", "--dry-run", "fix it"]);
    expect(grok.code).toBe(2);
    expect(grok.stderr).toContain("Grok Build starts in plan mode only in Gluon's frame (Gluon types /plan into it); use --mode explore or build");
    expect((await cli(["--launch", "codex", "--model", "gpt-6.1-sol", "--mode", "build", "--dry-run", "fix it"])).code).toBe(0);
  });

  test("--mode takes build, explore or plan, and only with --launch", async () => {
    const bad = await cli(["--launch", "claude-code", "--model", "sonnet", "--mode", "yolo", "--dry-run", "x"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--mode takes one of: build, explore, plan");
    const alone = await cli(["--mode", "explore"]);
    expect(alone.code).toBe(2);
    expect(alone.stderr).toContain("--mode goes with --launch");
    expect((await cli(["--help"])).stdout).toContain("[--mode <m>]");
  });

  test("BUG-25/F9: an agent that isn't installed fails with 127 and prints the spec", async () => {
    const r = await cli(["--launch", "opencode", "--model", "deepseek-flash", "do the thing"], { agents: ["claude"] });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("opencode is not installed");
    expect(r.stderr).toContain("do the thing");
  });

  test("G7/G8: bad model, harness or effort is refused with the valid choices @full", async () => {
    expect((await cli(["--launch", "claude-code", "x"])).stderr).toContain("--model is required with --launch (claude-code models: haiku, sonnet, opus, fable)");
    expect((await cli(["--launch", "pi", "--model", "m", "x"])).stderr).toContain('unknown harness "pi"');
    // Efforts are the model's: DeepSeek takes low, high, max; Haiku 5.5 every level.
    const e = await cli(["--launch", "opencode", "--model", "deepseek-flash", "--effort", "medium", "x"]);
    expect(e.code).toBe(2);
    expect(e.stderr).toContain("does not take effort \"medium\" (efforts: low, high, max)");
    const h = await cli(["--launch", "claude-code", "--model", "haiku", "--effort", "high", "--dry-run", "x"]);
    expect(h.code).toBe(0);
    expect(JSON.parse(h.stdout).argv).toEqual(["claude", "--model", "haiku", "--effort", "high", "--", "x"]);
    expect((await cli(["--launch", "claude-code", "--model", "sonnet", "  "])).stderr).toContain("spec is empty");
  });
});

describe("each harness, handed the terminal", () => {
  /** --launch in a terminal: the fake agent prints what it was given. */
  const launch = async (yaml: string, args: string[], env: Record<string, string> = {}) => {
    const app = new App({ cwd: repo.tiny(), args: ["--launch", ...args], env: { GLUON_CONFIG: freshConfig(`launch-${args[0]}-${Object.keys(env).join("-")}`, yaml), ...env }, agents: ["claude", "codex", "agy", "grok", "opencode"], noDemo: true, rows: 40, cols: 120 });
    await app.waitFor("type a line>");
    return app.history();
  };

  test("Claude Code on OpenRouter: OpenRouter's documented setup, no Anthropic key, no token", async () => {
    const h = await launch("connections: { claude-code: { auth: api, provider: openrouter } }\n", ["claude-code", "--model", "opus", "--effort", "high", "- fix it"], { OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef0123456789abcdef" });
    expect(argv(h)).toEqual(["--model", "anthropic/claude-opus-5.5", "--effort", "high", "--", "- fix it"]);
    expect(h).toContain("ENV ANTHROPIC_BASE_URL=https://openrouter.ai/api");
    expect(h).toContain("ENV ANTHROPIC_AUTH_TOKEN=set");
    expect(h).toContain("ENV ANTHROPIC_API_KEY=unset");
    expect(h).toContain("ENV CLAUDE_CODE_OAUTH_TOKEN=unset");
  });

  test("Codex on its ChatGPT plan: nothing added, no base URL, no key", async () => {
    const h = await launch("connections: { codex: { auth: subscription } }\n", ["codex", "--model", "gpt-6-astra", "--effort", "xhigh", "fix it"], { OPENAI_API_KEY: "" });
    expect(argv(h)).toEqual(["-m", "gpt-6-astra", "-c", 'model_reasoning_effort="xhigh"', "--", "fix it"]);
    expect(h).toContain("ENV OPENAI_BASE_URL=unset");
    expect(h).toContain("ENV OPENAI_API_KEY=unset");
  });

  test("Grok Build with an xAI key: only XAI_API_KEY", async () => {
    const h = await launch("connections: { grok-build: { auth: api, provider: xai } }\n", ["grok-build", "--model", "grok-4.7", "fix it"], { XAI_API_KEY: "xai-0123456789abcdef0123456789", OPENROUTER_API_KEY: "sk-or-v1-notpassednotpassed01" });
    expect(argv(h)).toEqual(["-m", "grok-4.7", "--", "fix it"]);
    expect(h).toContain("ENV XAI_API_KEY=set");
    expect(h).toContain("ENV OPENROUTER_API_KEY=set"); // the user's own environment, inherited as is
  });
});
