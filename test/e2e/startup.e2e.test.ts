/** A. Startup and environment: header, repo kinds, terminal, theme, the terminal probe. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDir, freshConfig, repo, WIN } from "./fixtures.ts";
import { App, cli, KEY, SLOW, start, stopAll, toLaunch, toProposal } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

describe("header", () => {
  test("home/header: shows the mark and gluon with its version, the repo with its branch and the first line", async () => {
    const app = await start({ cwd: repo.tiny() });
    const s = app.screen();
    expect(s).toMatch(/⡠● +Gluon v\d+\.\d+\.\d+\s*$/m);
    expect(s).not.toContain("intake agent ·");
    expect(s).toMatch(/──⢎──● +tiny · main/);
    expect(s).toContain("no sessions yet");
    expect(s.replace(/\s+/g, " ")).toContain("◆ What are we building? I'll ask a few questions first, then start a session with the right harness, model and effort.");
    expect(s).toContain("› describe the session you want");
  });

  test.each([40, 60, 70])("home/header: at %i columns the header's lines are cut, never wrapped, aligned with gluon #BUG-40", async (cols) => {
    const app = await start({ cwd: repo.tiny(), cols, rows: 30 });
    const lines = app.lines();
    const title = lines.find((l) => l.includes("Gluon v"))!;
    const where = lines.find((l) => l.includes("tiny · main"))!;
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(cols);
    expect(where.indexOf("tiny")).toBe(title.indexOf("Gluon"));
  });

  test("home/header: the repo is named owner/name from its remote, never its host or the credentials in its URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-remote-"));
    for (const args of [["init", "-q"], ["remote", "add", "origin", "https://user:ghp_secret0123@github.example/acme/widget.git"]]) expect(Bun.spawnSync(["git", ...args], { cwd: dir }).exitCode).toBe(0);
    try {
      const app = await start({ cwd: dir });
      await app.waitFor(/──⢎──● +acme\/widget · /);
      expect(app.screen()).not.toMatch(/ghp_secret|github\.example|user:/);
    } finally {
      cleanDir(dir);
    }
  });

  test("home/header: a repo with no commits still shows its branch #BUG-35", async () => {
    const app = await start({ cwd: repo.emptyGit() });
    expect(app.screen()).toContain("emptygit · main");
  });

  test("home/header: a detached HEAD shows its commit #BUG-35", async () => {
    const [dir, sha] = repo.detached();
    const app = await start({ cwd: dir });
    expect(app.screen()).toContain(`detached · detached at ${sha}`);
  });

  test("home/header: a non-git dir and a path with a space start fine @full", async () => {
    const a = await start({ cwd: repo.noGit() });
    expect(a.screen()).toMatch(/──⢎──● +nogit\n/);
    const b = await start({ cwd: repo.withSpace() });
    expect(b.screen()).toMatch(/──⢎──● +with space\n/);
  });
});

describe("terminal", () => {
  test("cli/needs-terminal: refuses to start without a terminal #BUG-26", async () => {
    const r = await cli(["--demo"], { cwd: repo.tiny() });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs an interactive terminal");
  });

  test("composer/terminal-noise: a late background-colour reply is not typed into the composer #BUG-18 @full", async () => {
    const app = await start({ cwd: repo.tiny(), osc11: { delayMs: 400 } });
    await app.settle(800);
    await app.type("hi");
    await app.waitFor("› hi");
    expect(app.screen()).not.toContain("rgb:");
    expect(app.screen()).not.toContain("11;");
  });

  test("composer/terminal-noise: filtering that reply doesn't swallow a typed ], typed slowly or fast #BUG-18 @full", async () => {
    const app = await start({ cwd: repo.tiny() });
    await app.type("a[1]b]");
    // Under load the last keys can land after type() settles: wait for them (a swallowed "]" never comes).
    await app.waitFor("› a[1]b]");
    // Typed fast, the next key inside the 30 ms a lone `]` is held: the `]` still comes, before it.
    for (const ch of "c]d]e") {
      app.write(ch);
      await Bun.sleep(5); // sleep-ok: keys apart, as a fast typist sends them, but inside the hold
    }
    await app.waitFor("› a[1]b]c]d]e");
  });

  test("home/theme: Gluon paints its own ground, on a dark and on a light terminal alike #BUG-128 #BUG-42 @full", async () => {
    // The ground can take a frame or two after the first screen under load (BUG-128): wait for it.
    const ground = (app: App) => app.waitFor(() => app.bg(0, app.row("describe the session")) === "#0f1013");
    await ground(await start({ cwd: repo.tiny(), osc11: "dark" }));
    await ground(await start({ cwd: repo.tiny(), osc11: "light" }));
  });

  test("home/theme: with no answer from the terminal, COLORFGBG picks the light theme (the setup menus' colours) #BUG-38", async () => {
    const app = new App({ cwd: repo.tiny(), args: ["setup"], noDemo: true, osc11: "none", env: { COLORFGBG: "0;15", GLUON_CONFIG: freshConfig("bug38") } });
    await app.waitFor("Claude Code");
    const y = app.row("› ");
    expect(app.fg(1, y)).toBe("#1c64c8");
    app.kill();
  });

  // Not on Windows: ConPTY answers DA1 itself and drops a reply written as input.
  test.skipIf(WIN)("home/theme: the startup probe: a terminal that speaks the kitty keyboard protocol has its `CSI ? u` answered for every agent #BUG-160", async () => {
    const cfg = freshConfig("kitty-probe", "handoff:\n  on_clear: ask\n");
    // A plain terminal and a kitty one, at once: what the agent's own probe gets back in each.
    const probe = async (kitty: boolean) => {
      const app = await start({ cwd: repo.tiny(), cols: 100, kitty, env: { GLUON_CONFIG: cfg, FAKE_TUI: "1" } });
      await toLaunch(app, "TUI ready");
      await app.type("!kq");
      await app.press(KEY.enter);
      await app.waitFor("DA1");
      return app.screen();
    };
    const [plain, kitty] = await Promise.all([probe(false), probe(true)]);
    expect(plain).not.toContain("KITTYQ");
    expect(kitty).toContain("KITTYQ ?0");
  });
});

describe("agents on PATH", () => {
  test("cli/no-agents: with no agent installed it says which binaries it looked for #A12", async () => {
    const app = new App({ cwd: repo.tiny(), agents: [] });
    expect(await app.exitCode(5000)).toBe(2);
    expect(app.history().replace(/\n/g, "")).toContain("none of claude, codex, agy, grok, opencode, kimi is on PATH");
  });

  test("routing/round-up: with only Claude Code, the demo's cheaper revision stays on Claude Code @full #BUG-07/A13", async () => {
    const app = await start({ cwd: repo.tiny(), agents: ["claude"] });
    await toProposal(app);
    await app.type("cheaper please");
    await app.press(KEY.enter);
    // Standard has no Claude Code model: it rounds up to Sonnet again, with one effort step less, and Haiku 5.5 (a level down) is the alternative.
    await app.waitFor("❯ 1. claude code × sonnet 5.5 × medium", 20_000);
    await app.waitFor("claude code × haiku 5.5", 20_000);
    await app.idle();
    expect(app.screen()).not.toContain("opencode ×");
  });
});
