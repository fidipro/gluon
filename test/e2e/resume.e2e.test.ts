/**
 * Saved meta-sessions (issue #42): `gluon sessions`, `gluon resume`, what Gluon keeps while it
 * runs, and what a resume does with each saved session. The saved files are seeded by hand where
 * a first run isn't the point; the agents are the fakes (`FAKE_ARGV_LOG` / `FAKE_CWD_LOG` say how
 * they were started).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SELF_GUARD_MS } from "../../src/pty/compositor.ts";
import { parseWorkspace, processAlive, type ChildRecord, type Workspace } from "../../src/workspaces.ts";
import { KEYS } from "./actions.ts";
import { freshConfig, repo, WIN, type FakeAgent } from "./fixtures.ts";
import { ASK_YAML, EVENT_HOOK, gluon, home, launch, launchAs, say } from "./gluon-kit.ts";
import { App, cli, HOME_VIEW, MAC_STEALS, SLOW, start, stopAll, toLaunch } from "./harness.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

const ALL: FakeAgent[] = ["claude", "codex", "agy", "grok", "opencode"];
const UUID = "0b1f3c5e-1111-4222-8333-444455556666";

let n = 0;
/** A config directory of the test's own: its workspaces directory, and the fakes' logs. */
function sandbox(yaml = ASK_YAML) {
  const cfg = freshConfig(`resume-${++n}`, yaml);
  const dir = dirname(cfg);
  const cwdLog = join(dir, "cwd.log");
  return { cfg, ws: join(dir, "workspaces"), cwdLog, env: { GLUON_CONFIG: cfg, FAKE_TUI: "1", FAKE_EVENT_HOOK: EVENT_HOOK, FAKE_CWD_LOG: cwdLog } };
}
type Sandbox = ReturnType<typeof sandbox>;

const child = (over: Partial<ChildRecord> = {}): ChildRecord => ({ key: "k1", name: "Gluon-alpha-task", harness: "claude-code", model: "sonnet", effort: "medium", spec: "fix the add bug", startedAt: Date.now() - 60_000, resume: { id: UUID, source: "minted" }, ...over });
const workspace = (cwd: string, over: Partial<Workspace> = {}): Workspace => ({ v: 1, id: "abcdef", name: "tiny · Oct 4", cwd, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000, sessions: [child()], ...over });

/** Writes a workspace file as Gluon would. */
function seed(s: Sandbox, w: Workspace) {
  mkdirSync(s.ws, { recursive: true });
  writeFileSync(join(s.ws, `${w.id}.json`), JSON.stringify(w));
}
/** The saved workspaces now. */
const saved = (s: Sandbox): Workspace[] => (existsSync(s.ws) ? readdirSync(s.ws).filter((f) => f.endsWith(".json")).map((f) => parseWorkspace(readFileSync(join(s.ws, f), "utf8"))!) : []);
/** How the fakes were started: the `ARGn=<…>` lines of each, as one list per start. */
const starts = (app: App): string[][] => app.agentLog().split(/FAKE-[A-Z]+ argc=\d+\n/).slice(1).map((blk) => [...blk.matchAll(/^ARG\d+=<(.*)>$/gm)].map((m) => m[1]!));
/** Waits for text on the screen with its line breaks (the chat wraps) turned into spaces. */
const waitText = (app: App, text: string, ms?: number) => app.waitFor((x) => x.replace(/\s+/g, " ").includes(text), ms);
const fakeRuns = (s: Sandbox): string[] => (existsSync(s.cwdLog) ? readFileSync(s.cwdLog, "utf8").trim().split("\n") : []);

/** Gluon resuming `args` (after `resume`), with every fake agent on PATH. */
const resumeApp = (s: Sandbox, args: string[], cwd = repo.tiny(), env: Record<string, string> = {}) => start({ cwd, cols: 200, rows: 40, args: ["resume", ...args], agents: ALL, env: { ...s.env, ...env } });

/**
 * Answers a question Gluon raised by itself (a saved session to start again): it ignores Enter, Esc
 * and Ctrl+C for a moment after it comes, as the install offer does, so it's answered after that.
 */
const answer = async (app: App, key: string) => {
  await Bun.sleep((SELF_GUARD_MS + 150) * SLOW);
  await app.press(key);
};

/** Quits from the home view: Ctrl+C twice, and yes to ending the sessions. */
async function quit(app: App, live = true) {
  await app.press(KEYS.ctrlC, KEYS.ctrlC);
  if (live) {
    await app.waitFor("quit and end");
    await app.press(KEYS.enter);
  }
  return app.exitCode();
}

describe("BUG-312/resume: gluon sessions and the picker's checks, without a terminal", () => {
  test("gluon sessions says so when nothing is saved", async () => {
    const s = sandbox();
    const r = await cli(["sessions"], { env: s.env });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toContain("No saved sessions");
  });

  test("gluon sessions lists every saved workspace, this directory's first and marked", async () => {
    const s = sandbox();
    const here = repo.tiny();
    seed(s, workspace("/elsewhere/project", { id: "aaaaaa", name: "project · Oct 1", updatedAt: Date.now() - 1000 }));
    seed(s, workspace(here, { id: "bbbbbb", updatedAt: Date.now() - 90_000, sessions: [child(), child({ key: "k2" })] }));
    const r = await cli(["sessions"], { cwd: here, env: s.env });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toStartWith(`* bbbbbb  tiny · Oct 4  2 sessions  `);
    expect(lines[0]).toEndWith(here);
    expect(lines[1]).toStartWith("  aaaaaa  project · Oct 1  1 session  ");
    expect(r.stdout).toContain("* is this directory");
    // Neither reached a real agent or brain: nothing was started.
    expect(fakeRuns(s)).toEqual([]);
  });

  test("gluon resume with no id and no terminal prints this directory's workspaces and exits 2; with none, says so and exits 1", async () => {
    const s = sandbox();
    const here = repo.tiny();
    const none = await cli(["resume"], { cwd: here, env: s.env });
    expect([none.code, none.stderr.trim()]).toEqual([1, "gluon: no saved sessions here"]);
    seed(s, workspace("/elsewhere/project", { id: "aaaaaa" }));
    const other = await cli(["resume"], { cwd: here, env: s.env });
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("no saved sessions here");
    expect(other.stderr).toContain("gluon resume --all");
    seed(s, workspace(here, { id: "bbbbbb" }));
    const list = await cli(["resume"], { cwd: here, env: s.env });
    expect(list.code).toBe(2);
    expect(list.stdout).toContain("bbbbbb  tiny · Oct 4");
    expect(list.stdout).not.toContain("aaaaaa");
    expect(list.stderr).toContain("gluon resume <id>");
    const all = await cli(["resume", "--all"], { cwd: here, env: s.env });
    expect(all.code).toBe(2);
    expect(all.stdout).toContain("aaaaaa");
    expect(fakeRuns(s)).toEqual([]);
  });

  test("an unknown or ambiguous id stops before anything starts", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { id: "abcdef" }));
    seed(s, workspace(repo.tiny(), { id: "abcxyz" }));
    const unknown = await cli(["resume", "zzz"], { env: s.env });
    expect([unknown.code, unknown.stderr.trim()]).toEqual([1, 'gluon: no saved session "zzz" (gluon sessions lists them)']);
    const ambiguous = await cli(["resume", "abc"], { env: s.env });
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toStartWith('gluon: "abc" matches ');
    expect(ambiguous.stderr).toContain("abcdef");
    expect(ambiguous.stderr).toContain("abcxyz");
    expect(fakeRuns(s)).toEqual([]);
  });

  test("a workspace whose directory is gone stops with a clear message, exit 1", async () => {
    const s = sandbox();
    const gone = mkdtempSync(join(tmpdir(), "gluon-gone-"));
    rmSync(gone, { recursive: true });
    seed(s, workspace(gone));
    const r = await cli(["resume", "abcdef"], { env: s.env });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`gluon: the directory of saved session abcdef no longer exists: ${gone}\nMove it back there (the agents find their sessions by directory), or delete the saved session: gluon sessions --delete abcdef\n`);
    expect(fakeRuns(s)).toEqual([]);
  });

  test("resume takes one id; --all goes only with resume and sessions; a mistyped resume is caught; --help lists both @full", async () => {
    const s = sandbox();
    const two = await cli(["resume", "abcdef", "ghijkl"], { env: s.env });
    expect(two.code).toBe(2);
    expect(two.stderr).toContain("resume takes one id: gluon resume [<id>]");
    const sessions = await cli(["sessions", "abcdef"], { env: s.env });
    expect(sessions.code).toBe(2);
    expect(sessions.stderr).toContain("sessions takes no arguments");
    const all = await cli(["doctor", "--all"], { env: s.env });
    expect(all.code).toBe(2);
    expect(all.stderr).toContain("--all goes with `gluon resume` and `gluon sessions`");
    const typo = await cli(["resum"], { env: s.env });
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('did you mean "gluon resume"');
    const help = await cli(["--help"], { env: s.env });
    expect(help.stdout).toContain("gluon sessions");
    expect(help.stdout).toContain("gluon resume [<id>] [--all]");
  });

  test("a valid id without a terminal gets as far as the terminal check: in the saved directory, no agent", async () => {
    const s = sandbox();
    const dir = repo.withSpace();
    seed(s, workspace(dir));
    const r = await cli(["resume", "abc"], { cwd: repo.noGit(), env: s.env });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(`gluon: resuming abcdef in ${dir} (where it was saved)`);
    expect(r.stderr).toContain("needs an interactive terminal");
    expect(fakeRuns(s)).toEqual([]);
  });
});

describe("BUG-312/resume: what Gluon keeps while it runs", () => {
  test("an empty Gluon saves nothing and prints no resume line", async () => {
    const s = sandbox();
    const app = await gluon(100, 30, s.env);
    expect(await quit(app, false)).toBe(130);
    expect(saved(s)).toEqual([]);
    expect(app.history()).not.toContain("gluon resume");
  });

  test("a launch creates the record (masked spec, minted id), names the workspace in the header and chat; quitting keeps it and prints how to resume @full", async () => {
    const s = sandbox();
    const app = await gluon(110, 30, s.env);
    await launch(app, "alpha task");
    const [w] = saved(s);
    expect(w!.id).toMatch(/^[a-z2-7]{6}$/);
    expect(w).toMatchObject({ cwd: repo.tiny(), sessions: [{ name: "Gluon-alpha-task", harness: "claude-code", model: "sonnet", effort: "high", resume: { source: "minted" } }] });
    expect(w!.sessions[0]!.resume!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(w!.sessions[0]!.spec.length).toBeGreaterThan(10);
    // This process's id for the file.
    expect(w!.pid).toBeGreaterThan(0);
    // The agent was started under that very id, with the spec.
    const [argv] = starts(app);
    expect(argv).toContain("--session-id");
    expect(argv![argv!.indexOf("--session-id") + 1]).toBe(w!.sessions[0]!.resume!.id);
    await home(app);
    await app.waitFor(`workspace ${w!.id}`);
    expect(await quit(app)).toBe(130);
    // The record survives the quit (the agent ending with Gluon is not a session ended).
    expect(saved(s).map((x) => x.id)).toEqual([w!.id]);
    expect(saved(s)[0]!.sessions).toHaveLength(1);
    expect(app.history()).toContain(`Resume this session: gluon resume ${w!.id}`);
  });

  test("a session the user ends leaves the record, and the record with it @full", async () => {
    const s = sandbox();
    const app = await gluon(110, 30, s.env);
    await launch(app, "alpha task");
    expect(saved(s)).toHaveLength(1);
    await home(app);
    await app.press(KEYS.delete);
    await app.waitFor("End ");
    await app.press(KEYS.enter);
    await app.waitFor((x) => !x.includes("Gluon-alpha-task"));
    await app.waitFor(() => saved(s).length === 0);
    expect(await quit(app, false)).toBe(130);
    expect(app.history()).not.toContain("Resume this session");
  });

  test("a session marked done stays in the record, marked @full", async () => {
    const s = sandbox();
    const app = await gluon(110, 30, s.env);
    await launch(app, "alpha task");
    await home(app);
    await app.press(KEYS.ctrlD);
    await app.waitFor(/Done[\s\S]*Gluon-alpha-task/);
    await app.waitFor(() => saved(s)[0]?.sessions[0]?.done === true);
    expect(saved(s)[0]!.sessions[0]!).toMatchObject({ name: "Gluon-alpha-task", done: true });
  });

  test("an agent that exits on its own leaves the record @full", async () => {
    const s = sandbox();
    const app = await gluon(110, 30, { ...s.env, FAKE_EXIT: "0" });
    await launch(app, "alpha task");
    expect(saved(s)).toHaveLength(1);
    await app.type("/exit");
    await app.press(KEYS.enter);
    await app.waitFor(HOME_VIEW);
    await app.waitFor(() => saved(s).length === 0);
    await app.waitFor((x) => !x.includes("Gluon-alpha-task"));
  });
});

/** The first Gluon of a round trip: one session launched, home, quit; the saved workspace. */
async function firstRun(s: Sandbox, fake?: FakeAgent, then?: (app: App) => Promise<void>): Promise<Workspace> {
  const app = fake ? await launchAs(fake, { env: s.env }) : await gluon(110, 30, s.env).then(async (a) => (await launch(a, "alpha task"), a));
  await then?.(app);
  await home(app);
  expect(await quit(app)).toBe(130);
  return saved(s)[0]!;
}

describe("BUG-312/resume: gluon resume reopens the saved sessions", () => {
  test("start, quit, resume: the agent is reopened under its id with no spec, in the saved directory; the record continues; quitting again keeps it @full", async () => {
    const s = sandbox();
    const before = await firstRun(s);
    const minted = before.sessions[0]!.resume!.id;
    const app = await resumeApp(s, [before.id]);
    await app.waitFor(/Gluon-alpha-task[\s\S]*Resumed|Resumed[\s\S]*Gluon-alpha-task/);
    expect(app.screen()).toContain(`workspace ${before.id}`);
    expect(app.screen()).toContain(`Resuming workspace ${before.id}`);
    await app.waitFor(() => starts(app).length === 1);
    const [argv] = starts(app);
    expect(argv).toContain(`--resume=${minted}`);
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--");
    // No spec again: the spec is several lines, which `starts` does not read, so look in the whole log for its lines.
    const specLines = before.sessions[0]!.spec.split("\n").filter((l) => l.trim().length > 12);
    expect(specLines.length).toBeGreaterThan(0);
    for (const l of specLines) expect(app.agentLog()).not.toContain(l.trim());
    const runs = fakeRuns(s);
    expect(runs.at(-1)).toMatch(new RegExp(`^claude .*--resume=${minted} @ .*tiny$`));
    // The same file and the same session key: no second record.
    const [after] = saved(s);
    expect(saved(s)).toHaveLength(1);
    expect(after).toMatchObject({ id: before.id, createdAt: before.createdAt, sessions: [{ key: before.sessions[0]!.key, name: "Gluon-alpha-task", resume: { id: minted } }] });
    // The record names this Gluon while it runs: another `gluon resume` of it is refused (BUG-306).
    expect(after!.pid).toBeGreaterThan(0);
    const other = await cli(["resume", before.id], { env: s.env });
    expect([other.code, other.stderr]).toEqual([1, `gluon: saved session ${before.id} is open in another Gluon (process ${after!.pid}); quit it first, or reopen it anyway with: gluon resume ${before.id} --force\n`]);
    // The resumed session is a session like any: it opens in the frame, and quitting keeps the record.
    await app.press(KEYS.enter);
    await app.waitFor("TUI ready");
    await home(app);
    expect(await quit(app)).toBe(130);
    // A Gluon that quit never blocks the next resume.
    expect(processAlive(after!.pid!)).toBe(false);
    expect(saved(s)[0]!.sessions.map((c) => c.key)).toEqual([before.sessions[0]!.key]);
    expect(app.history()).toContain(`Resume this session: gluon resume ${before.id}`);
  });

  test("an id's unique prefix is enough; a resume from another directory runs in the saved one and says so", async () => {
    const s = sandbox();
    const here = repo.tiny();
    seed(s, workspace(here));
    const app = await resumeApp(s, ["abc"], repo.noGit());
    await app.waitFor("Gluon-alpha-task");
    expect(app.history()).toContain(`gluon: resuming abcdef in ${here} (where it was saved)`);
    await app.waitFor(() => fakeRuns(s).some((l) => l.includes("--resume=")));
    expect(fakeRuns(s).find((l) => l.includes("--resume="))).toEndWith(`@ ${here}`);
    // Gluon itself runs there too: the header's repository is the saved directory's.
    expect(app.screen()).toContain("tiny");
    expect(app.screen()).not.toContain("nogit");
  });

  test("Codex and OpenCode give their session id by hook: it is saved, and the resume uses it @full", async () => {
    for (const [fake, last, resumes] of [["codex", "019a1b2c-d3e4-test", (a: string[]) => a[0] === "resume" && a.at(-2) === "--" && a.at(-1) === "019a1b2c-d3e4-test"], ["opencode", "ses_3f2a9c0d1e8b", (a: string[]) => a.includes("--session=ses_3f2a9c0d1e8b") && !a.some((x) => x.startsWith("--prompt="))]] as const) {
      const s = sandbox();
      const before = await firstRun(s, fake, async (app) => {
        await say(app, `!event session ${last}`, "EVENT session");
        await app.waitFor(() => saved(s)[0]?.sessions[0]?.resume?.id === last);
      });
      expect(before.sessions[0]!.resume).toEqual({ id: last, source: "captured" });
      const app = await start({ cwd: repo.tiny(), args: ["resume", before.id], agents: [fake], env: s.env });
      await app.waitFor(() => starts(app).length > 0);
      expect(resumes(starts(app)[0]!)).toBe(true);
      app.kill();
    }
  });

  test("sessions that can't be resumed are asked about one at a time once the others are up: Enter starts one again from its spec (same key), Esc drops one @full", async () => {
    const s = sandbox();
    const here = repo.tiny();
    seed(s, workspace(here, { sessions: [child({ key: "kc" }), child({ key: "ka", name: "Gluon-agy-task", harness: "antigravity", model: "gemini-3.8-flash", spec: "agy spec", resume: undefined }), child({ key: "kx", name: "Gluon-codex-task", harness: "codex", mode: "build", model: "gpt-6.1-sol", spec: "codex spec", resume: undefined })] }));
    const app = await resumeApp(s, ["abcdef"]);
    // Claude is up first; then the first question.
    await app.waitFor("Gluon-agy-task (Antigravity) can't be resumed (it has no way to resume a session). Start it again with its saved spec?");
    expect(starts(app)).toHaveLength(1);
    expect(starts(app)[0]).toContain(`--resume=${UUID}`);
    await app.waitFor("enter starts it again · esc drops it · ctrl+c keeps it");
    await answer(app, KEYS.enter);
    await app.waitFor("Gluon-codex-task (Codex) can't be resumed (it never reported its session id)");
    // Antigravity started again with its saved spec.
    await app.waitFor(() => starts(app).length === 2);
    expect(app.agentLog()).toContain("=<--prompt-interactive=agy spec>");
    await answer(app, KEYS.esc);
    await app.waitFor((x) => !x.includes("can't be resumed"));
    await app.waitFor(() => saved(s)[0]?.sessions.length === 2);
    expect(starts(app)).toHaveLength(2);
    // The record: Claude (unchanged), Antigravity (same key), no Codex.
    const [w] = saved(s);
    expect(w!.sessions.map((c) => [c.key, c.harness])).toEqual([["kc", "claude-code"], ["ka", "antigravity"]]);
    expect(w!.sessions[0]!.resume!.id).toBe(UUID);
  });

  test("a harness that refuses the resume soon after it starts is asked about the same way, with the reason; Enter starts it again under a new id", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny()));
    const app = await resumeApp(s, ["abcdef"], repo.tiny(), { FAKE_REFUSE_RESUME: "3" });
    await app.waitFor("Gluon-alpha-task (Claude Code) can't be resumed (Claude Code exited with code 3 right after resuming). Start it again with its saved spec?");
    expect(app.screen()).toContain("Claude Code exited with code 3");
    // It was never taken out of the record.
    expect(saved(s)[0]!.sessions).toHaveLength(1);
    await answer(app, KEYS.enter);
    await app.waitFor(() => starts(app).length === 2);
    const fresh = starts(app)[1]!;
    expect(fresh).toContain("--session-id");
    const newId = fresh[fresh.indexOf("--session-id") + 1]!;
    expect(newId).not.toBe(UUID);
    // The spec is the saved one.
    expect(app.agentLog()).toContain("=<fix the add bug>");
    await app.waitFor(() => saved(s)[0]?.sessions[0]?.resume?.id === newId);
    expect(saved(s)[0]!.sessions.map((c) => c.key)).toEqual(["k1"]);
    expect(saved(s)[0]!.sessions[0]!.resume).toEqual({ id: newId, source: "minted" });
  });

  test("a refused resume answered no is dropped from the record, each in turn @full", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [child(), child({ key: "k2", name: "Gluon-two", resume: { id: "22222222-1111-4222-8333-444455556666", source: "minted" } })] }));
    const app = await resumeApp(s, ["abcdef"], repo.tiny(), { FAKE_REFUSE_RESUME: "9" });
    await waitText(app, "Gluon-alpha-task (Claude Code) can't be resumed");
    await answer(app, KEYS.esc);
    await app.waitFor(() => saved(s)[0]?.sessions.map((c) => c.key).join() === "k2");
    await waitText(app, "Gluon-two (Claude Code) can't be resumed");
    await answer(app, KEYS.esc);
    await app.waitFor((x) => !x.includes("can't be resumed (Claude"));
    await app.waitFor(() => saved(s).length === 0);
    // Nothing saved any more: the header stops naming the workspace.
    expect(app.lines()[1]).not.toContain("workspace");
  });

  test("a saved session whose model is gone can be neither resumed nor started again: the chat says why and the record keeps it", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [child({ model: "sonnet-0" })] }));
    const app = await resumeApp(s, ["abcdef"]);
    await app.waitFor("nor started again");
    expect(app.screen()).toContain("Claude Code doesn't offer sonnet-0 any more");
    expect(fakeRuns(s)).toEqual([]);
    expect(saved(s)[0]!.sessions).toHaveLength(1);
    expect(saved(s)[0]!.sessions[0]!.model).toBe("sonnet-0");
  });

  test("BUG-423/resume-dropped-effort: a saved session with an effort its model no longer takes (Codex has no max) still resumes, without the effort", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [child({ name: "Gluon-codex-task", harness: "codex", mode: "build", model: "gpt-6.1-sol", effort: "max", spec: "codex spec", resume: { id: "019a1b2c-d3e4-test", source: "captured" } })] }));
    const app = await resumeApp(s, ["abcdef"]);
    await app.waitFor(() => starts(app).length === 1);
    expect(app.screen()).not.toContain("can't be resumed");
    expect(starts(app)[0]).toContain("019a1b2c-d3e4-test");
    expect(starts(app)[0]!.join(" ")).not.toContain("model_reasoning_effort");
    app.kill();
  });

  test.skipIf(MAC_STEALS)("without a pseudo-terminal each saved session is asked about, one at a time; Enter resumes it with the terminal itself", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny()));
    const app = await resumeApp(s, ["abcdef"], repo.tiny(), { GLUON_TEST_NO_PTY: "1" });
    await app.waitFor("Resume Gluon-alpha-task (Claude Code) now? Sessions run one at a time here.");
    expect(fakeRuns(s)).toEqual([]);
    await answer(app, KEYS.enter);
    await app.waitFor("TUI ready");
    expect(starts(app)[0]).toContain(`--resume=${UUID}`);
  });

  test.skipIf(MAC_STEALS || WIN)("BUG-290/resume: without a pseudo-terminal a session event (Codex's hook, OpenCode's plugin) is not the agent's way back to Gluon: it keeps running @full", async () => {
    const s = sandbox();
    const write = `"${process.execPath}" --no-env-file "${join(import.meta.dir, "../fixtures/write-event.ts")}" session ses_1`;
    const app = await start({ cwd: repo.tiny(), rows: 60, env: { ...s.env, FAKE_TUI: "", GLUON_TEST_NO_PTY: "1", FAKE_HOOK: `${write}${WIN ? " & " : "; "}"${process.execPath}" -e "await Bun.sleep(${2000 * SLOW})"` } });
    await toLaunch(app);
    // The fake's typed /clear runs the hook; several polls later it asks again.
    await app.type("/clear");
    await app.press(KEYS.enter);
    await app.waitFor(() => app.history().includes("HOOK ran"), 20_000);
    await app.type("still here");
    await app.press(KEYS.enter);
    await app.waitFor("Claude Code exited (code 7)");
    expect(app.history({ normal: true })).toContain("GOT <still here>");
    expect(app.screen()).not.toContain("Back from Claude Code");
  });
});

describe("BUG-298/resume: the review's findings", () => {
  const agy = (key = "ka") => child({ key, name: "Gluon-agy-task", harness: "antigravity", model: "gemini-3.8-flash", spec: "agy spec", resume: undefined });
  const asked = "Gluon-agy-task (Antigravity) can't be resumed";

  test.skipIf(MAC_STEALS)("BUG-298/resume: without a pseudo-terminal an agent that refuses the resume soon after it starts stays in the record and is asked about, and on_exit quit does not quit Gluon @full", async () => {
    const s = sandbox(`${ASK_YAML}  on_exit: quit\n`);
    seed(s, workspace(repo.tiny()));
    const app = await resumeApp(s, ["abcdef"], repo.tiny(), { GLUON_TEST_NO_PTY: "1", FAKE_REFUSE_RESUME: "3" });
    await app.waitFor("Resume Gluon-alpha-task (Claude Code) now?");
    await answer(app, KEYS.enter);
    await waitText(app, "Gluon-alpha-task (Claude Code) can't be resumed (Claude Code exited with code 3 right after resuming). Start it again with its saved spec?");
    // The record stayed, and Gluon is still here to ask.
    expect(saved(s)[0]!.sessions.map((c) => c.key)).toEqual(["k1"]);
    expect(saved(s)[0]!.sessions[0]!.resume).toEqual({ id: UUID, source: "minted" });
    await answer(app, KEYS.enter);
    await app.waitFor("TUI ready");
    expect(starts(app)).toHaveLength(2);
    expect(starts(app)[1]).toContain("--session-id");
    expect(saved(s)[0]!.sessions[0]!.resume!.id).not.toBe(UUID);
  });

  test("BUG-299/resume: typing while Gluon's own question is up closes it and keeps every key; it is not asked again while the chat holds text, and comes back when it is empty @full", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [agy()] }));
    const app = await resumeApp(s, ["abcdef"]);
    await app.waitFor(asked);
    await app.type("hello");
    await app.waitFor((x) => !x.includes("can't be resumed") && x.includes("hello"));
    // Not re-asked over the draft, however long it stays.
    await Bun.sleep(2500 * SLOW);
    expect(app.screen()).not.toContain("can't be resumed");
    expect(app.screen()).toContain("hello");
    expect(starts(app)).toHaveLength(0);
    // The draft cleared: the question is back, and nothing was started meanwhile.
    await app.press(KEYS.ctrlC);
    await app.waitFor(asked, 20_000);
    expect(app.screen()).not.toContain("hello");
    expect(starts(app)).toHaveLength(0);
    expect(saved(s)[0]!.sessions).toHaveLength(1);
  });

  test("BUG-300/resume: Ctrl+C on the start-again question keeps the session in the record (the next resume asks again); only Esc drops it @full", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [agy()] }));
    const app = await resumeApp(s, ["abcdef"]);
    await app.waitFor(asked);
    await answer(app, KEYS.ctrlC);
    await waitText(app, "Gluon-agy-task stays in workspace abcdef: gluon resume asks about it again.");
    await app.waitFor((x) => !x.includes("Start it again"));
    expect(starts(app)).toHaveLength(0);
    expect(saved(s)[0]!.sessions.map((c) => c.key)).toEqual(["ka"]);
    expect(await quit(app, false)).toBe(130);
    expect(saved(s)[0]!.sessions.map((c) => c.key)).toEqual(["ka"]);
    const again = await resumeApp(s, ["abcdef"]);
    await again.waitFor(asked);
    await answer(again, KEYS.esc);
    await again.waitFor(() => saved(s).length === 0);
  });

  test.skipIf(WIN)("BUG-303/resume: a directory that can't be saved is recorded nowhere: no workspace in the header, no resume line on quit, and the chat says why @full", async () => {
    const s = sandbox();
    const dir = join(mkdtempSync(join(tmpdir(), "gluon-bidi-")), "evil‮dir");
    mkdirSync(dir);
    const app = await start({ cwd: dir, rows: 50, env: s.env });
    await toLaunch(app, "TUI ready");
    await home(app);
    await waitText(app, "this directory can't be saved for resume: its path has control or direction characters");
    await app.waitFor((x) => !x.includes("workspace "));
    expect(saved(s)).toEqual([]);
    expect(await quit(app)).toBe(130);
    expect(app.history()).not.toContain("Resume this session");
  });

  test("BUG-307/resume: starting a Codex session again forgets the id the harness refused (a fresh start has none until its hook sends one) @full", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [child({ key: "kx", name: "Gluon-codex-task", harness: "codex", mode: "build", model: "gpt-6.1-sol", spec: "codex spec", resume: { id: "019a1b2c-d3e4-test", source: "captured" } })] }));
    const app = await resumeApp(s, ["abcdef"], repo.tiny(), { FAKE_REFUSE_RESUME: "3" });
    await waitText(app, "Gluon-codex-task (Codex) can't be resumed (Codex exited with code 3");
    expect(saved(s)[0]!.sessions[0]!.resume!.id).toBe("019a1b2c-d3e4-test");
    await answer(app, KEYS.enter);
    await app.waitFor(() => starts(app).length === 2);
    await app.waitFor(() => saved(s)[0]?.sessions[0]?.resume === undefined);
    expect(starts(app)[1]).not.toContain("resume");
    expect(app.agentLog()).toContain("codex spec");
  });
});

describe("BUG-306/resume: one Gluon per workspace, and deleting a saved one", () => {
  const deadPid = () => Bun.spawnSync([process.execPath, "-e", ""]).pid;

  test("BUG-306/resume: a workspace another live Gluon has open is refused naming its process; --force opens it anyway; a dead id never blocks", async () => {
    const s = sandbox();
    const dir = repo.withSpace();
    seed(s, workspace(dir, { pid: process.pid }));
    const live = await cli(["resume", "abcdef"], { env: s.env });
    expect(live.code).toBe(1);
    expect(live.stderr).toBe(`gluon: saved session abcdef is open in another Gluon (process ${process.pid}); quit it first, or reopen it anyway with: gluon resume abcdef --force\n`);
    expect(live.stdout).toBe("");
    // Forced, or left by a Gluon that is gone: on to the terminal check.
    const forced = await cli(["resume", "abcdef", "--force"], { env: s.env });
    expect([forced.code, forced.stderr]).toEqual([2, expect.stringContaining("needs an interactive terminal")]);
    seed(s, workspace(dir, { pid: deadPid() }));
    const dead = await cli(["resume", "abcdef"], { env: s.env });
    expect([dead.code, dead.stderr]).toEqual([2, expect.stringContaining("needs an interactive terminal")]);
    expect(fakeRuns(s)).toEqual([]);
  });

  test("BUG-310/resume: --delete of a workspace another live Gluon has open is refused naming its process; --force deletes it; a dead id never blocks", async () => {
    const s = sandbox();
    seed(s, workspace("/elsewhere/a", { id: "abcdef", pid: process.pid }));
    const live = await cli(["sessions", "--delete", "abcdef", "--yes"], { env: s.env });
    expect([live.code, live.stderr]).toEqual([1, `gluon: saved session abcdef is open in another Gluon (process ${process.pid}); quit it first, or delete it anyway with: gluon sessions --delete abcdef --force\n`]);
    expect(saved(s)).toHaveLength(1);
    const forced = await cli(["sessions", "--delete", "abcdef", "--yes", "--force"], { env: s.env });
    expect(forced.code).toBe(0);
    expect(saved(s)).toEqual([]);
    seed(s, workspace("/elsewhere/a", { id: "abcdef", pid: deadPid() }));
    const dead = await cli(["sessions", "--delete", "abcdef", "--yes"], { env: s.env });
    expect(dead.code).toBe(0);
    expect(saved(s)).toEqual([]);
  });

  test("BUG-306/resume: --force, --delete and --yes go only where they belong, and --help names them", async () => {
    const s = sandbox();
    const force = await cli(["sessions", "--force"], { env: s.env });
    expect([force.code, force.stderr]).toEqual([2, expect.stringContaining("--force goes with `gluon resume` and `gluon sessions --delete <id>`")]);
    const del = await cli(["resume", "abcdef", "--delete", "x"], { env: s.env });
    expect([del.code, del.stderr]).toEqual([2, expect.stringContaining("--delete and --yes go with `gluon sessions`")]);
    const yes = await cli(["sessions", "--yes"], { env: s.env });
    expect([yes.code, yes.stderr]).toEqual([2, expect.stringContaining("--yes goes with `gluon sessions --delete <id>`")]);
    const help = await cli(["--help"], { env: s.env });
    expect(help.stdout).toContain("gluon sessions --delete <id> [--yes] [--force]");
    expect(help.stdout).toContain("gluon resume [<id>] [--all] [--force]");
  });

  test("BUG-308/resume: gluon sessions --delete removes that workspace's file only; unknown and ambiguous ids stop; without a terminal it needs --yes", async () => {
    const s = sandbox();
    seed(s, workspace("/elsewhere/a", { id: "abcdef" }));
    seed(s, workspace("/elsewhere/b", { id: "abcxyz" }));
    seed(s, workspace("/elsewhere/c", { id: "kkkkkk", sessions: [child(), child({ key: "k2" })] }));
    writeFileSync(join(s.ws, "notes.txt"), "mine");
    const unknown = await cli(["sessions", "--delete", "zzz"], { env: s.env });
    expect([unknown.code, unknown.stderr.trim()]).toEqual([1, 'gluon: no saved session "zzz" (gluon sessions lists them)']);
    const ambiguous = await cli(["sessions", "--delete", "abc"], { env: s.env });
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toStartWith('gluon: "abc" matches ');
    const noTerminal = await cli(["sessions", "--delete", "kkk"], { env: s.env });
    expect(noTerminal.code).toBe(2);
    expect(noTerminal.stderr).toContain("needs a terminal to ask first; to delete without asking: gluon sessions --delete kkkkkk --yes");
    expect(saved(s)).toHaveLength(3);
    const done = await cli(["sessions", "--delete", "kkk", "--yes"], { env: s.env });
    expect([done.code, done.stdout.trim()]).toEqual([0, "Deleted saved session kkkkkk (tiny · Oct 4, 2 sessions)."]);
    expect(readdirSync(s.ws).sort()).toEqual(["abcdef.json", "abcxyz.json", "notes.txt"]);
  });

  test("BUG-308/resume: on a terminal --delete asks first: anything but y deletes nothing", async () => {
    const s = sandbox();
    seed(s, workspace("/elsewhere/a", { id: "abcdef" }));
    const no = new App({ cwd: repo.tiny(), args: ["sessions", "--delete", "abcd"], env: s.env, cols: 120, rows: 20 });
    await no.waitFor("Delete saved session abcdef (tiny · Oct 4, 1 session)? [y/N]");
    await no.press(KEYS.enter);
    expect(await no.exitCode()).toBe(0);
    expect(no.history()).toContain("Nothing deleted.");
    expect(saved(s)).toHaveLength(1);
    const yes = new App({ cwd: repo.tiny(), args: ["sessions", "--delete", "abcd"], env: s.env, cols: 120, rows: 20 });
    await yes.waitFor("[y/N]");
    await yes.type("y");
    await yes.press(KEYS.enter);
    expect(await yes.exitCode()).toBe(0);
    expect(yes.history()).toContain("Deleted saved session abcdef");
    expect(saved(s)).toEqual([]);
  });
});
