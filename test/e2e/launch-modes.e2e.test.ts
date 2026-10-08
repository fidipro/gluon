/** Launch modes (build, explore, plan) in Gluon's frame: the typed first line of Codex's Plan mode, ctrl+t, and what the brief says. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { parseWorkspace, type ChildRecord, type Workspace } from "../../src/workspaces.ts";
import { KEYS } from "./actions.ts";
import { freshConfig, repo } from "./fixtures.ts";
import { ASK_YAML, EVENT_HOOK, gluon, home, say, toChoice } from "./gluon-kit.ts";
import { SLOW, start, stopAll } from "./harness.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

test("BUG-409/launch-modes: the note that Codex's /plan line couldn't be typed is shown over the agent's frame (the line whole, until Esc), and in the home chat too @full", async () => {
  // The fake codex without FAKE_TUI draws no composer: the user's first key into it means the line is never typed.
  const app = await gluon(100, 30, { FAKE_TUI: "" }, undefined, ["codex"]);
  await toChoice(app, "fix the thing");
  await app.press(KEYS.ctrlT);
  await app.press(KEYS.ctrlT);
  await app.press(KEYS.enter);
  await app.waitFor((s) => s.includes("type a line>") && s.includes("◆ gluon"), 20_000);
  await app.settle(300);
  await app.type("x");
  // The user is in the agent's frame when the line fails: they are told there, the line whole (wrapped, never cut).
  const bare = (s: string) => s.replace(/[│\s]+/g, "");
  await app.waitFor((s) => bare(s).includes("typethisyourself:/planReadthesessionbriefin"), 20_000);
  const shown = bare(app.screen());
  expect(shown).toMatch(/\/planReadthesessionbriefin\S+spec\S*andstart\./);
  expect(shown).toContain("eschidesthisnote");
  // Esc is Gluon's while the note is up: it goes, the agent doesn't get it.
  await app.press(KEYS.esc);
  await app.waitFor((s) => !s.includes("type this yourself") && !s.includes("esc hides this note"), 10_000);
  await home(app);
  expect(app.screen().replace(/\s+/g, " ")).toContain("type this yourself: /plan Read the session brief in");
});

test("BUG-410/launch-modes: ctrl+t to explore (strictly read-only) on a proposal with a worktree gives no worktree brief, and the brief says what explore allows @full", async () => {
  const app = await gluon(100, 30, {}, undefined, ["claude"]);
  await toChoice(app, "fix the thing");
  await app.press(KEYS.ctrlT);
  await app.press(KEYS.enter);
  await app.waitFor((s) => s.includes("TUI ready") && s.includes("◆ gluon"), 20_000);
  const log = app.agentLog();
  expect(log).toContain("dontAsk");
  // The mode is read-only: the brief that tells the agent to create a worktree must not come with it, and its own block does.
  expect(log).not.toContain("git worktree add");
  expect(log).not.toContain("Where to work");
  expect(log).toContain("## Mode: explore");
});

test("BUG-410/launch-modes @full: the brief follows the mode ctrl+t ended on, whatever the spec was written for: plan keeps the worktree and says plan, build says neither mode", async () => {
  const plan = await gluon(100, 30, {}, undefined, ["claude"]);
  await toChoice(plan, "fix the thing");
  await plan.press(KEYS.ctrlT);
  await plan.press(KEYS.ctrlT);
  await plan.press(KEYS.enter);
  await plan.waitFor((s) => s.includes("TUI ready") && s.includes("◆ gluon"), 20_000);
  expect(plan.agentLog()).toContain("## Mode: plan");
  expect(plan.agentLog()).not.toContain("## Mode: explore");
  expect(plan.agentLog()).toContain("git worktree add");
  // build, explore, plan, build again: the proposal's own worktree, and no mode block.
  const build = await gluon(100, 30, {}, undefined, ["claude"]);
  await toChoice(build, "fix the thing");
  for (let i = 0; i < 3; i++) await build.press(KEYS.ctrlT);
  await build.press(KEYS.enter);
  await build.waitFor((s) => s.includes("TUI ready") && s.includes("◆ gluon"), 20_000);
  expect(build.agentLog()).not.toContain("## Mode:");
  expect(build.agentLog()).not.toContain("dontAsk");
  expect(build.agentLog()).toContain("git worktree add");
});

for (const cols of [60, 40]) {
  test(`Codex plan at ${cols} columns @full: the line is typed once with its Enter apart, Plan mode shows, and no note is posted`, async () => {
    const app = await gluon(cols, 30, {}, undefined, ["codex"]);
    await toChoice(app, "fix the thing");
    await app.press(KEYS.ctrlT);
    await app.press(KEYS.ctrlT);
    await app.press(KEYS.enter);
    await app.waitFor((s) => s.includes("◆ gluon"), 20_000);
    const chunks = () =>
      readFileSync(app.inputLogPath, "utf8")
        .split("\n")
        .slice(1)
        .filter(Boolean)
        .map((l) => l.slice(l.indexOf(" ") + 1));
    const end = performance.now() + 20_000 * SLOW;
    while (chunks().length < 2 && performance.now() < end) await Bun.sleep(50);
    await Bun.sleep(1500);
    expect(chunks()).toHaveLength(2);
    expect(chunks()[0]).toMatch(/^\/plan Read the session brief in \S+ and start\.$/);
    expect(chunks()[1]).toBe("\\x0d");
    await home(app);
    expect(app.screen()).not.toContain("couldn't type");
    expect(app.screen()).not.toContain("may not be in Plan mode");
  });
}

const UUID = "0b1f3c5e-1111-4222-8333-444455556666";
function sandbox(name: string) {
  const cfg = freshConfig(`modes-${name}`, ASK_YAML);
  return { cfg, ws: join(dirname(cfg), "workspaces"), env: { GLUON_CONFIG: cfg, FAKE_TUI: "1", FAKE_EVENT_HOOK: EVENT_HOOK } };
}
function seed(s: ReturnType<typeof sandbox>, cwd: string, c: Partial<ChildRecord>, more: Partial<ChildRecord>[] = []) {
  const w: Workspace = { v: 1, id: "abcdef", name: "tiny · Oct 4", cwd, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000, sessions: [{ key: "k1", name: "Gluon-alpha-task", harness: "codex", model: "gpt-6.1-sol", effort: "high", spec: "fix the add bug", startedAt: Date.now() - 60_000, resume: { id: UUID, source: "captured" }, ...c }, ...(more as ChildRecord[])] };
  mkdirSync(s.ws, { recursive: true });
  writeFileSync(join(s.ws, "abcdef.json"), JSON.stringify(w));
}

const sessionOf = (fake: string, mode?: string): Partial<ChildRecord> =>
  fake === "opencode"
    ? { harness: "opencode", model: "deepseek-flash", resume: { id: "ses_3f2a9c0d1e8b", source: "captured" }, ...(mode ? { mode } : {}) } as Partial<ChildRecord>
    : { ...(mode ? { mode } : {}) } as Partial<ChildRecord>;
const argvOf = (app: { agentLog(): string }) => [...app.agentLog().matchAll(/^ARG\d+=<(.*)>$/gm)].map((m) => m[1]);
const started = (app: { agentLog(): string }) => app.agentLog().includes("argc=");
const quitApp = async (app: Awaited<ReturnType<typeof start>>) => {
  await app.press(KEYS.ctrlC, KEYS.ctrlC);
  await app.waitFor("quit and end");
  await app.press(KEYS.enter);
  return app.exitCode();
};

test("BUG-612/resume-modes: a Codex session saved in plan mode resumes through codex resume alone: the plain argv (no mode options), nothing typed", async () => {
  const s = sandbox("resume-plan");
  seed(s, repo.tiny(), { mode: "plan" });
  const app = await start({ cwd: repo.tiny(), cols: 120, rows: 23, args: ["resume", "abcdef"], agents: ["codex"], env: s.env });
  const end = performance.now() + 20_000 * SLOW;
  while (!app.agentLog().includes("ARG") && performance.now() < end) await Bun.sleep(50);
  // Long enough for a typed line, were there one (the line takes ~200 ms once the box is up).
  await app.settle(1500);
  expect(app.inputLogs().map((l) => l.bytes).filter(Boolean)).toEqual([]);
  const argv = argvOf(app);
  expect(argv.slice(0, 3)).toEqual(["resume", "-m", "gpt-6.1-sol"]);
  expect(argv.slice(-2)).toEqual(["--", UUID]);
  for (const a of ["-s", "-a", "read-only", "never", "--sandbox", "--ask-for-approval"]) expect(argv).not.toContain(a);
  expect(argv.join(" ")).not.toContain("plan");
});

test("BUG-612/resume-modes: a Codex session saved in explore resumes with -s read-only -a never, still nothing typed and no spec", async () => {
  const s = sandbox("resume-explore");
  seed(s, repo.tiny(), { mode: "explore" });
  const app = await start({ cwd: repo.tiny(), cols: 120, rows: 23, args: ["resume", "abcdef"], agents: ["codex"], env: s.env });
  const end = performance.now() + 20_000 * SLOW;
  while (!app.agentLog().includes("ARG") && performance.now() < end) await Bun.sleep(50);
  await app.settle(1500);
  expect(app.inputLogs().map((l) => l.bytes).filter(Boolean)).toEqual([]);
  const argv = argvOf(app);
  expect(argv.slice(0, 3)).toEqual(["resume", "-m", "gpt-6.1-sol"]);
  expect(argv.slice(-2)).toEqual(["--", UUID]);
  expect(argv.slice(argv.indexOf("-s"), argv.indexOf("-s") + 4)).toEqual(["-s", "read-only", "-a", "never"]);
  expect(app.agentLog()).not.toContain("fix the add bug");
});

test("BUG-612/resume-modes: an OpenCode session saved in explore resumes with the gluon-explore agent as default; one saved in build with no agent of ours", async () => {
  for (const mode of ["explore", "build"]) {
    const s = sandbox(`resume-opencode-${mode}`);
    seed(s, repo.tiny(), sessionOf("opencode", mode));
    const app = await start({ cwd: repo.tiny(), cols: 120, rows: 23, args: ["resume", "abcdef"], agents: ["opencode"], env: s.env });
    const end = performance.now() + 20_000 * SLOW;
    while (!app.agentLog().includes("OPENCODE_CONFIG_CONTENT") && performance.now() < end) await Bun.sleep(50);
    const config = /^ENV OPENCODE_CONFIG_CONTENT=(.*)$/m.exec(app.agentLog())?.[1];
    expect(config, mode).toBeDefined();
    expect(argvOf(app)).toEqual(["--standalone", "--session=ses_3f2a9c0d1e8b"]);
    if (mode === "explore") expect(JSON.parse(config!)).toMatchObject({ default_agent: "gluon-explore", agents: { "gluon-explore": { mode: "primary" } } });
    else expect(JSON.parse(config!).default_agent).toBeUndefined();
    app.kill();
  }
});

// One test per harness: they run at once (a loop in one test waited out both no-start windows in turn).
for (const fake of ["codex", "opencode"]) {
  test(`BUG-612/resume-modes: a ${fake === "codex" ? "Codex" : "OpenCode"} session saved before Gluon recorded its mode is not resumed (nothing starts), the chat names \`gluon sessions --delete <id>\`, and the record stays`, async () => {
    const s = sandbox(`resume-unmoded-${fake}`);
    seed(s, repo.tiny(), sessionOf(fake));
    const app = await start({ cwd: repo.tiny(), cols: 200, rows: 40, args: ["resume", "abcdef"], agents: [fake as "codex"], env: s.env });
    await app.waitFor((x) => x.replace(/\s+/g, " ").includes("gluon sessions --delete abcdef"), 20_000);
    expect(app.screen().replace(/\s+/g, " ")).toContain("was saved before Gluon recorded a session's mode");
    // No question to start it again (that would be a build session), and no agent.
    await app.settle(1500);
    expect(started(app)).toBe(false);
    expect(app.screen()).not.toContain("Start it again");
    const kept = parseWorkspace(readFileSync(join(s.ws, "abcdef.json"), "utf8"))!;
    expect(kept.sessions.map((c) => c.key)).toEqual(["k1"]);
    app.kill();
  });
}

test("BUG-612/resume-modes: with no mode on record, Claude Code (whose own session keeps it) still resumes, and a Codex one beside it is the only refusal", async () => {
  const s = sandbox("resume-unmoded-mixed");
  seed(s, repo.tiny(), {}, [{ key: "k2", name: "Gluon-beta-task", harness: "claude-code", model: "sonnet", effort: "high", spec: "other", startedAt: Date.now() - 50_000, resume: { id: UUID, source: "minted" } }]);
  const app = await start({ cwd: repo.tiny(), cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ["claude", "codex"], env: s.env });
  await app.waitFor((x) => x.replace(/\s+/g, " ").includes("gluon sessions --delete abcdef"), 20_000);
  const end = performance.now() + 20_000 * SLOW;
  while (!app.agentLog().includes("FAKE-CLAUDE") && performance.now() < end) await Bun.sleep(50);
  expect(app.agentLog()).toContain(`--resume=${UUID}`);
  expect(app.agentLog()).not.toContain("FAKE-CODEX");
  app.kill();
});

test("BUG-612/resume-modes @full: round trip — a Codex session launched in explore saves its mode in the workspace, and gluon resume reopens it with -s read-only -a never", async () => {
  const s = sandbox("roundtrip");
  const app = await start({ cwd: repo.tiny(), cols: 110, rows: 30, agents: ["codex"], env: s.env });
  await toChoice(app, "fix the thing");
  await app.press(KEYS.ctrlT);
  await app.press(KEYS.enter);
  await app.waitFor((x) => x.includes("TUI ready") && x.includes("◆ gluon"), 20_000);
  expect(argvOf(app).join(" ")).toContain("-s read-only -a never");
  await say(app, "!event session 019a1b2c-d3e4-test", "EVENT session");
  const file = join(s.ws, readdirSync(s.ws).find((f) => f.endsWith(".json"))!);
  const until = performance.now() + 20_000 * SLOW;
  while (parseWorkspace(readFileSync(file, "utf8"))?.sessions[0]?.resume?.id !== "019a1b2c-d3e4-test" && performance.now() < until) await Bun.sleep(50);
  const saved = parseWorkspace(readFileSync(file, "utf8"))!;
  expect(saved.sessions[0]).toMatchObject({ harness: "codex", mode: "explore", resume: { id: "019a1b2c-d3e4-test", source: "captured" } });
  await home(app);
  expect(await quitApp(app)).toBe(130);
  const again = await start({ cwd: repo.tiny(), cols: 120, rows: 30, args: ["resume", saved.id], agents: ["codex"], env: s.env });
  const end = performance.now() + 20_000 * SLOW;
  while (!started(again) && performance.now() < end) await Bun.sleep(50);
  const argv = argvOf(again);
  expect(argv.slice(0, 1)).toEqual(["resume"]);
  expect(argv.slice(argv.indexOf("-s"), argv.indexOf("-s") + 4)).toEqual(["-s", "read-only", "-a", "never"]);
  expect(argv.slice(-2)).toEqual(["--", "019a1b2c-d3e4-test"]);
  again.kill();
});

test("Codex plan's spec file @full is private (0600 in a 0700 directory) while the session runs and removed when the agent exits", async () => {
  const app = await gluon(120, 30, {}, undefined, ["codex"]);
  await toChoice(app, "fix the thing");
  await app.press(KEYS.ctrlT);
  await app.press(KEYS.ctrlT);
  await app.press(KEYS.enter);
  await app.waitFor((s) => s.includes("◆ gluon"), 20_000);
  const chunks = () => readFileSync(app.inputLogPath, "utf8").split("\n").slice(1).filter(Boolean).map((l) => l.slice(l.indexOf(" ") + 1));
  const end = performance.now() + 20_000 * SLOW;
  while (chunks().length < 2 && performance.now() < end) await Bun.sleep(50);
  const file = /in (\S+) and start/.exec(chunks()[0]!)![1]!;
  expect(existsSync(file)).toBe(true);
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  }
  await app.type("/exit");
  await app.press(KEYS.enter);
  const gone = performance.now() + 20_000 * SLOW;
  while (existsSync(file) && performance.now() < gone) await Bun.sleep(100);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(dirname(file))).toBe(false);
});

test("two Codex plan sessions @full started one after the other each get their own line (own spec file) typed into their own PTY, once", async () => {
  const app = await gluon(120, 30, {}, undefined, ["codex"]);
  const planOne = async (task: string) => {
    await toChoice(app, task);
    await app.press(KEYS.ctrlT);
    await app.press(KEYS.ctrlT);
    await app.press(KEYS.enter);
    await app.waitFor((s) => s.includes("◆ gluon"), 20_000);
  };
  await planOne("first thing");
  const end = performance.now() + 20_000 * SLOW;
  while (app.inputLogs().length < 1 && performance.now() < end) await Bun.sleep(50);
  await home(app);
  await planOne("second thing");
  while (app.inputLogs().length < 2 && performance.now() < end) await Bun.sleep(50);
  await app.settle(1000);
  const logs = app.inputLogs();
  expect(logs).toHaveLength(2);
  const files = logs.map((l) => /^\/plan Read the session brief in (\S+) and start\.\r$/.exec(l.bytes)?.[1]);
  expect(files[0]).toBeDefined();
  expect(files[1]).toBeDefined();
  expect(files[0]).not.toBe(files[1]);
  expect(readFileSync(files[0]!, "utf8")).toContain("First thing");
  expect(readFileSync(files[1]!, "utf8")).toContain("Second thing");
});
