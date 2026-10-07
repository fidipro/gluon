/**
 * QA campaign (B6): meta-session resume, workspaces, `gluon sessions` and `uninstall`, the defects
 * found by hand. A fixed one is a plain `BUG-nnn/<id>` test; each `test.failing` left
 * (`BUG-CANDIDATE/…`) passes while its defect stands, and once it is fixed it fails: turn it into a
 * `test`. Same kit as `resume.e2e.test.ts`.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseWorkspace, processStart, type ChildRecord, type Workspace } from "../../src/workspaces.ts";
import { SELF_GUARD_MS } from "../../src/pty/compositor.ts";
import { KEYS } from "./actions.ts";
import { freshConfig, repo, WIN, type FakeAgent } from "./fixtures.ts";
import { ASK_YAML, EVENT_HOOK } from "./gluon-kit.ts";
import { App, cli, SLOW, start, stopAll } from "./harness.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

const ALL: FakeAgent[] = ["claude", "codex", "agy", "grok", "opencode"];
const UUID = "0b1f3c5e-1111-4222-8333-444455556666";

let n = 0;
function sandbox() {
  const cfg = freshConfig(`resume-qa-${++n}`, ASK_YAML);
  const dir = dirname(cfg);
  return { cfg, ws: join(dir, "workspaces"), env: { GLUON_CONFIG: cfg, FAKE_TUI: "1", FAKE_EVENT_HOOK: EVENT_HOOK } };
}
type Sandbox = ReturnType<typeof sandbox>;
const child = (over: Partial<ChildRecord> = {}): ChildRecord => ({ key: "k1", name: "Gluon-alpha-task", harness: "claude-code", model: "sonnet", effort: "medium", spec: "fix the add bug", startedAt: Date.now() - 60_000, resume: { id: UUID, source: "minted" }, ...over });
const workspace = (cwd: string, over: Partial<Workspace> = {}): Workspace => ({ v: 1, id: "abcdef", name: "tiny · Oct 4", cwd, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000, sessions: [child()], ...over });
function seed(s: Sandbox, w: unknown, id = "abcdef") {
  mkdirSync(s.ws, { recursive: true });
  writeFileSync(join(s.ws, `${id}.json`), JSON.stringify(w));
}
const saved = (s: Sandbox): Workspace[] => (existsSync(s.ws) ? readdirSync(s.ws).filter((f) => f.endsWith(".json")).map((f) => parseWorkspace(readFileSync(join(s.ws, f), "utf8"))!) : []);
/** A real worktree of `dir` at `path` on a new `branch` (what the agent makes at its start). */
function addWorktree(dir: string, path: string, branch: string) {
  const r = Bun.spawnSync(["git", "worktree", "add", "-q", "-b", branch, path, "HEAD"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env });
  if (r.exitCode !== 0) throw new Error(`worktree add: ${r.stderr.toString()}`);
}

/** The text of the screen with its line breaks (the chat wraps) turned into spaces. */
const flat = (app: App) => app.screen().replace(/\s+/g, " ");

describe("QA-resume: one Gluon per workspace", () => {
  // Linux only: the process start is read from /proc there; Windows (PowerShell) is unverified, and macOS falls back to the pid alone (`processStart`).
  (process.platform === "linux" ? test : test.skip)("BUG-642/QA-resume-01: a pid in the file that another, unrelated process now holds (pids are reused after a reboot, at once in a container) doesn't make `gluon resume` say the workspace is open in another Gluon", async () => {
    const s = sandbox();
    const other = Bun.spawn(["sleep", "60"]);
    try {
      // The record carries the start of the process that wrote it (a Gluon that is gone); the process now holding its pid started at another time.
      seed(s, workspace(repo.tiny(), { pid: other.pid, start: "0-a-gluon-that-quit" }));
      const r = await cli(["resume", "abcdef"], { env: s.env });
      expect(r.stderr).not.toContain("is open in another Gluon");
    } finally {
      other.kill();
    }
  });

  (process.platform === "linux" ? test : test.skip)("BUG-642/variants: a process that started when the record says is still the Gluon (refused, naming it); a record without a start is decided by the pid, as before", async () => {
    const s = sandbox();
    const other = Bun.spawn(["sleep", "60"]);
    try {
      const started = processStart(other.pid);
      expect(started).toBeDefined();
      seed(s, workspace(repo.tiny(), { pid: other.pid, start: started }));
      const same = await cli(["resume", "abcdef"], { env: s.env });
      expect([same.code, same.stderr]).toEqual([1, expect.stringContaining(`is open in another Gluon (process ${other.pid})`)]);
      seed(s, workspace(repo.tiny(), { pid: other.pid }));
      const bare = await cli(["resume", "abcdef"], { env: s.env });
      expect([bare.code, bare.stderr]).toEqual([1, expect.stringContaining(`is open in another Gluon (process ${other.pid})`)]);
    } finally {
      other.kill();
    }
  });

  test("BUG-643/QA-resume-02: two Gluons that resume one workspace at the same moment are not both let in (the check reads the pid file at startup; the claim is written about a second later, so both reopen the same harness session)", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny()));
    const dir = repo.tiny();
    const both = await Promise.allSettled([1, 2].map(() => start({ cwd: dir, args: ["resume", "abcdef"], agents: ALL, env: s.env })));
    // One of them must have been refused (it exits before its home view).
    expect(both.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("BUG-643/variants: the claim on a workspace", () => {
  const lock = (s: Sandbox) => join(s.ws, "abcdef.lock");
  const deadPid = () => Bun.spawnSync([process.execPath, "-e", ""]).pid;
  const hold = (s: Sandbox, pid: number) => writeFileSync(lock(s), `${JSON.stringify({ v: 1, pid })}\n`);

  test("a live claim refuses the resume naming its pid; --force takes it over; a claim of a Gluon that is gone never blocks; none outlives the command", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny()));
    hold(s, process.pid);
    const live = await cli(["resume", "abcdef"], { env: s.env });
    expect([live.code, live.stderr]).toEqual([1, `gluon: saved session abcdef is open in another Gluon (process ${process.pid}); quit it first, or reopen it anyway with: gluon resume abcdef --force\n`]);
    expect(existsSync(lock(s))).toBe(true);
    // Past the check: no terminal here, so the resume stops there, and the claim it took goes with the process.
    const forced = await cli(["resume", "abcdef", "--force"], { env: s.env });
    expect([forced.code, forced.stderr]).toEqual([2, expect.stringContaining("needs an interactive terminal")]);
    expect(existsSync(lock(s))).toBe(false);
    hold(s, deadPid());
    const dead = await cli(["resume", "abcdef"], { env: s.env });
    expect([dead.code, dead.stderr]).toEqual([2, expect.stringContaining("needs an interactive terminal")]);
    expect(existsSync(lock(s))).toBe(false);
  });

  (WIN ? test.skip : test)("a running resumed Gluon holds a private claim naming its process, and quitting removes it", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny()));
    const app = await start({ cwd: repo.tiny(), cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ALL, env: s.env });
    await app.waitFor("Resumed");
    const claim = JSON.parse(readFileSync(join(s.ws, "abcdef.lock"), "utf8")) as { pid: number };
    expect(claim.pid).toBeGreaterThan(0);
    expect((await Bun.file(join(s.ws, "abcdef.lock")).stat()).mode & 0o777).toBe(0o600);
    await app.waitFor(() => saved(s)[0]?.pid === claim.pid);
    await app.press(KEYS.ctrlC, KEYS.ctrlC);
    await app.waitFor("quit and end");
    await app.press(KEYS.enter);
    await app.exitCode();
    expect(existsSync(join(s.ws, "abcdef.lock"))).toBe(false);
  });
});

describe("QA-resume: a saved session that can't come back", () => {
  test("BUG-659/QA-resume-06: a saved session whose model is gone (PR #84) says how to let it go: the notice names a way to drop it, or the question has a key for it (today the record stays for ever and nothing in Gluon removes it)", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [child({ model: "sonnet-0" })] }));
    const app = await start({ cwd: repo.tiny(), cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ALL, env: s.env });
    await app.waitFor((x) => x.replace(/\s+/g, " ").includes("nor started again"));
    expect(flat(app)).toMatch(/sessions --delete|esc drops|drop it/i);
  });

  test("a harness that refuses an unknown session id but exits 0 is not seen as a refusal: the session ends like any other, its record (spec included) is deleted, and the only text is the 'Resuming workspace' line (documented limit, `resumeRefused`)", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny()));
    const app = await start({ cwd: repo.tiny(), cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ALL, env: { ...s.env, FAKE_REFUSE_RESUME: "0" } });
    await app.waitFor(() => saved(s).length === 0);
    await app.idle();
    expect(flat(app)).not.toContain("can't be resumed");
    expect(flat(app)).not.toContain("refused");
  });
});

describe("QA-resume: the directory a resume enters", () => {
  test("BUG-661/QA-resume-14: a saved directory that was moved or renamed says what to do next (the message only says it no longer exists; the harnesses find their sessions by directory, so the way out is to move it back or delete the record)", async () => {
    const s = sandbox();
    seed(s, workspace("/nonexistent/gluon-qa/moved-away"));
    const r = await cli(["resume", "abcdef"], { env: s.env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no longer exists");
    expect(r.stderr).toContain("gluon sessions --delete abcdef");
  });
});

describe("QA-resume: starting a saved session again", () => {
  /** A path as the brief spells it: forward slashes on Windows (git takes them, and a backslash in a Git Bash command is an escape: `worktreeBrief`). */
  const inBrief = (p: string) => (WIN ? p.replaceAll("\\", "/") : p);

  test("BUG-660/QA-resume-13: starting again a session that can't be resumed (Antigravity, Kimi, no id) reuses the worktree it already has, or says where the earlier work is (it plans a second one, `-2`, drops the first from the record, and the new agent isn't told of it)", async () => {
    const s = sandbox();
    const dir = repo.tiny();
    const old = join(dir, ".gluon", "worktrees", "gluon-agy-task");
    addWorktree(dir, old, "gluon/agy-task");
    seed(s, workspace(dir, { sessions: [child({ key: "ka", name: "Gluon-agy-task", harness: "antigravity", model: "gemini-3.8-flash", spec: "agy spec", resume: undefined, worktree: { path: old, branch: "gluon/agy-task" } })] }));
    const app = await start({ cwd: dir, cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ALL, env: s.env });
    await app.waitFor((x) => x.replace(/\s+/g, " ").includes("can't be resumed"));
    await Bun.sleep((SELF_GUARD_MS + 150) * SLOW);
    await app.press(KEYS.enter);
    await app.waitFor(() => app.agentLog().includes("agy spec"));
    expect(app.agentLog()).toContain(`- Worktree: \`${inBrief(old)}\``);
    expect(saved(s)[0]!.sessions[0]!.worktree?.path).toBe(old);
  });

  test("BUG-660/variants: a worktree that is gone from the disk is planned anew, at its first free name, and the record follows", async () => {
    const s = sandbox();
    const dir = repo.tiny();
    const was = join(dir, ".gluon", "worktrees", "gluon-agy-lost-9");
    seed(s, workspace(dir, { sessions: [child({ key: "ka", name: "Gluon-agy-lost", harness: "antigravity", model: "gemini-3.8-flash", spec: "agy lost spec", resume: undefined, worktree: { path: was, branch: "gluon/agy-lost-9" } })] }));
    const app = await start({ cwd: dir, cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ALL, env: s.env });
    await app.waitFor((x) => x.replace(/\s+/g, " ").includes("can't be resumed"));
    await Bun.sleep((SELF_GUARD_MS + 150) * SLOW);
    await app.press(KEYS.enter);
    await app.waitFor(() => app.agentLog().includes("agy lost spec"));
    const fresh = join(dir, ".gluon", "worktrees", "gluon-agy-lost");
    expect(app.agentLog()).toContain(`- Worktree: \`${inBrief(fresh)}\``);
    expect(app.agentLog()).toContain("worktree add");
    await app.waitFor(() => saved(s)[0]?.sessions[0]?.worktree?.path === fresh);
  });

  test("BUG-660/variants: the brief of a worktree it already has says it is there and not to create it", async () => {
    const s = sandbox();
    const dir = repo.tiny();
    const have = join(dir, ".gluon", "worktrees", "gluon-agy-have");
    addWorktree(dir, have, "gluon/agy-have");
    seed(s, workspace(dir, { sessions: [child({ key: "ka", name: "Gluon-agy-have", harness: "antigravity", model: "gemini-3.8-flash", spec: "agy have spec", resume: undefined, worktree: { path: have, branch: "gluon/agy-have" } })] }));
    const app = await start({ cwd: dir, cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ALL, env: s.env });
    await app.waitFor((x) => x.replace(/\s+/g, " ").includes("can't be resumed"));
    await Bun.sleep((SELF_GUARD_MS + 150) * SLOW);
    await app.press(KEYS.enter);
    await app.waitFor(() => app.agentLog().includes("agy have spec"));
    expect(app.agentLog()).toContain("Don't create it");
    expect(app.agentLog()).toContain("uncommitted work");
    expect(app.agentLog()).not.toContain("worktree add");
  });

  test("BUG-660/variants: a record that names a directory outside the checkout (a path with a quote and `$(…)` in it) is not reused: a worktree is planned anew and nothing is told to work or run there", async () => {
    const s = sandbox();
    const dir = repo.tiny();
    // A Windows file name can't hold a double quote: a single one stands in there.
    const outside = mkdtempSync(join(tmpdir(), `gluon-qa-out$(touch pwned)${WIN ? "'" : '"'}-`));
    const evil = join(outside, ".gluon", "worktrees", "gluon-evil");
    mkdirSync(evil, { recursive: true });
    try {
      seed(s, workspace(dir, { sessions: [child({ key: "ka", name: "Gluon-agy-evil", harness: "antigravity", model: "gemini-3.8-flash", spec: "agy evil spec", resume: undefined, worktree: { path: evil, branch: "gluon/evil" } })] }));
      const app = await start({ cwd: dir, cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ALL, env: s.env });
      await app.waitFor((x) => x.replace(/\s+/g, " ").includes("can't be resumed"));
      await Bun.sleep((SELF_GUARD_MS + 150) * SLOW);
      await app.press(KEYS.enter);
      await app.waitFor(() => app.agentLog().includes("agy evil spec"));
      const fresh = join(dir, ".gluon", "worktrees", "gluon-agy-evil");
      expect(app.agentLog()).toContain(`- Worktree: \`${inBrief(fresh)}\``);
      expect(app.agentLog()).not.toContain("touch pwned");
      expect(app.agentLog()).not.toContain("Don't create it");
      await app.waitFor(() => saved(s)[0]?.sessions[0]?.worktree?.path === fresh);
      expect(existsSync(join(dir, "pwned"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("QA-resume: files Gluon can't read", () => {
  test("BUG-638/QA-resume-11: a saved workspace file that doesn't parse (a crash mid-write on a system that lost the rename, a hand edit, a newer build) can be deleted by its id (it is invisible to `gluon sessions`, and `--delete` says there is no such session)", async () => {
    const s = sandbox();
    mkdirSync(s.ws, { recursive: true });
    writeFileSync(join(s.ws, "abcdef.json"), '{"v":1,"id":"abcdef","name":');
    const r = await cli(["sessions", "--delete", "abcdef", "--yes"], { env: s.env });
    expect([r.code, existsSync(join(s.ws, "abcdef.json"))]).toEqual([0, false]);
  });

  test("BUG-638/variants: `gluon sessions` names the file it can't read with the way to remove it; a readable one stays listed beside it, and deleting the broken one leaves it alone; a prefix or an unknown id doesn't delete it", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { id: "ghijkl" }), "ghijkl");
    writeFileSync(join(s.ws, "abcdef.json"), "not json");
    const list = await cli(["sessions"], { env: s.env });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("ghijkl");
    expect(list.stdout).toContain("? abcdef  can't be read; remove it: gluon sessions --delete abcdef");
    const miss = await cli(["sessions", "--delete", "abc", "--yes"], { env: s.env });
    expect(miss.code).toBe(1);
    expect(existsSync(join(s.ws, "abcdef.json"))).toBe(true);
    const r = await cli(["sessions", "--delete", "abcdef", "--yes"], { env: s.env });
    expect([r.code, existsSync(join(s.ws, "abcdef.json")), existsSync(join(s.ws, "ghijkl.json"))]).toEqual([0, false, true]);
  });
});

describe("QA-resume: uninstall", () => {
  // Owner decision: uninstall refuses while a Gluon runs, naming its pid, and removes nothing (the candidate expected it to remove everything and the Gluon not to write back).
  (WIN ? test.skip : test)("BUG-644/QA-resume-12: `gluon uninstall --yes` while a Gluon is running refuses, naming that Gluon's pid, and removes nothing; once the Gluon has quit it uninstalls @full", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny()));
    const own = mkdtempSync(join(tmpdir(), "gluon-qa-uninstall-"));
    try {
      const app = await start({ cwd: repo.tiny(), cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ALL, env: s.env });
      await app.waitFor("Resumed");
      const home = join(own, "home");
      mkdirSync(home);
      const env = { ...s.env, HOME: home, XDG_STATE_HOME: join(own, "state"), XDG_CONFIG_HOME: join(own, "xdg"), TMPDIR: own };
      await app.waitFor(() => saved(s)[0]?.pid !== undefined);
      const pid = saved(s)[0]!.pid!;
      const r = await cli(["uninstall", "--yes"], { env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`a Gluon is running (process ${pid})`);
      expect(r.stdout).not.toContain("uninstalled");
      expect(r.stdout).not.toContain("Removed");
      // Nothing was removed: the saved sessions, their claim and the config are all there.
      expect([existsSync(s.ws), existsSync(join(s.ws, "abcdef.json")), existsSync(s.cfg)]).toEqual([true, true, true]);
      await app.press(KEYS.ctrlC, KEYS.ctrlC);
      await app.waitFor("quit and end");
      await app.press(KEYS.enter);
      await app.exitCode();
      const after = await cli(["uninstall", "--yes"], { env });
      expect(after.code).toBe(0);
      expect(existsSync(s.ws)).toBe(false);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});
