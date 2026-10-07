/**
 * Saved meta-sessions (issue #42), the independent tester's scenarios: a hostile or odd workspace
 * file, and a resume's change of directory. Same kit as `resume.e2e.test.ts`.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseWorkspace, type ChildRecord, type Workspace } from "../../src/workspaces.ts";
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
  const cfg = freshConfig(`resume-hostile-${++n}`, ASK_YAML);
  const dir = dirname(cfg);
  const cwdLog = join(dir, "cwd.log");
  return { cfg, ws: join(dir, "workspaces"), cwdLog, env: { GLUON_CONFIG: cfg, FAKE_TUI: "1", FAKE_EVENT_HOOK: EVENT_HOOK, FAKE_CWD_LOG: cwdLog } };
}
type Sandbox = ReturnType<typeof sandbox>;

const child = (over: Partial<ChildRecord> = {}): ChildRecord => ({ key: "k1", name: "Gluon-alpha-task", harness: "claude-code", model: "sonnet", effort: "medium", spec: "fix the add bug", startedAt: Date.now() - 60_000, resume: { id: UUID, source: "minted" }, ...over });
const workspace = (cwd: string, over: Partial<Workspace> = {}): Workspace => ({ v: 1, id: "abcdef", name: "tiny · Oct 4", cwd, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000, sessions: [child()], ...over });
function seed(s: Sandbox, w: unknown, id = "abcdef") {
  mkdirSync(s.ws, { recursive: true });
  writeFileSync(join(s.ws, `${id}.json`), JSON.stringify(w));
}
const saved = (s: Sandbox): Workspace[] => (existsSync(s.ws) ? readdirSync(s.ws).filter((f) => f.endsWith(".json")).map((f) => parseWorkspace(readFileSync(join(s.ws, f), "utf8"))!) : []);

describe("BUG-291/resume: a hostile workspace file", () => {
  const evil = "\x1b]0;PWNED\x07\x1b[2J\x9b2J‮";

  test("BUG-291/resume: gluon sessions and the errors of gluon resume never put an escape from the file on the terminal", async () => {
    const s = sandbox();
    seed(s, workspace("/tmp/x", { name: `n${evil}`, sessions: [child({ name: `s${evil}` })] }));
    const list = await cli(["sessions"], { env: s.env });
    expect(list.stdout).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f‮]/);
    expect(list.stdout).toContain("abcdef");
    // A directory with an escape in it is no workspace at all: it is neither listed nor entered.
    seed(s, workspace(`/tmp/x${evil}`), "bbbbbb");
    const gone = await cli(["resume", "bbbbbb"], { env: s.env });
    expect(gone.code).toBe(1);
    expect(gone.stderr + gone.stdout).not.toMatch(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f‮]/);
  });

  test("BUG-291/resume: a saved name with an escape is a plain line in the home view, the chat and the question", async () => {
    const s = sandbox();
    // A harness with no way to resume: the user is asked, with the name in the question.
    seed(s, workspace(repo.tiny(), { sessions: [child({ name: `Gluon-evil${evil}`, harness: "antigravity", model: "gemini-3.8-flash", resume: undefined })] }));
    const app = await start({ cwd: repo.tiny(), args: ["resume", "abcdef"], agents: ALL, env: s.env });
    app.mark();
    await app.waitFor("Start it again");
    expect(app.since()).not.toContain("PWNED");
    expect(app.since()).not.toContain("‮");
  });

  test("BUG-291/resume: a file that holds a resume id like an option never puts it in an argv", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [child({ resume: { id: "--dangerously-skip-permissions", source: "captured" } as never })] }));
    const app = await start({ cwd: repo.tiny(), args: ["resume", "abcdef"], agents: ALL, env: s.env });
    await app.waitFor("Start it again");
    expect(app.agentLog()).not.toContain("dangerously");
  });
});

describe("BUG-291/resume: the directory a resume enters", () => {
  test("BUG-291/resume: a saved directory that is a file, or a relative path, is never entered", async () => {
    const s = sandbox();
    const file = join(repo.tiny(), "README.md");
    writeFileSync(file, "x");
    seed(s, workspace(file));
    const isFile = await cli(["resume", "abcdef"], { env: s.env });
    expect([isFile.code, isFile.stderr]).toEqual([1, `gluon: the directory of saved session abcdef no longer exists: ${file}\nMove it back there (the agents find their sessions by directory), or delete the saved session: gluon sessions --delete abcdef\n`]);
    seed(s, workspace("tiny"));
    const rel = await cli(["resume", "abcdef"], { cwd: dirname(repo.tiny()), env: s.env });
    expect(rel.code).toBe(1);
    expect(rel.stderr).toContain('no saved session "abcdef"');
  });

  test("BUG-291/resume: a relative GLUON_CONFIG still names the same files after the resume's chdir @full", async () => {
    const s = sandbox();
    const saved0 = workspace(repo.tiny());
    seed(s, saved0);
    const from = mkdtempSync(join(tmpdir(), "gluon-from-"));
    const rel = relative(from, s.cfg);
    expect(rel.startsWith("..")).toBe(true);
    const app = await start({ cwd: from, args: ["resume", "abcdef"], agents: ALL, env: { ...s.env, GLUON_CONFIG: rel } });
    await app.waitFor("Resumed");
    // A change to the record (done): written where the config is.
    await app.press(KEYS.ctrlD);
    await app.waitFor(/Done[\s\S]*Gluon-alpha-task/);
    await app.waitFor(() => saved(s)[0]?.sessions[0]?.done === true);
    await app.press(KEYS.ctrlC, KEYS.ctrlC);
    await app.waitFor("quit and end");
    await app.press(KEYS.enter);
    await app.exitCode();
    // The record went on in the config directory, not in the repository the resume entered.
    expect(saved(s)[0]!.sessions[0]!.done).toBe(true);
    expect(existsSync(join(saved0.cwd, rel))).toBe(false);
    expect(readdirSync(saved0.cwd)).not.toContain("workspaces");
  });
});

const starts = (app: { agentLog(): string }): string[][] => app.agentLog().split(/FAKE-[A-Z]+ argc=\d+\n/).slice(1).map((blk) => [...blk.matchAll(/^ARG\d+=<(.*)>$/gm)].map((m) => m[1]!));

describe("BUG-292/resume: lifecycle", () => {
  test("BUG-292/resume: a SIGTERM while a question about a saved session is up keeps every saved session, the one asked about too", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [child({ key: "kc" }), child({ key: "ka", name: "Gluon-agy-task", harness: "antigravity", model: "gemini-3.8-flash", resume: undefined })] }));
    const app = await start({ cwd: repo.tiny(), cols: 200, rows: 40, args: ["resume", "abcdef"], agents: ALL, env: s.env });
    await app.waitFor("Gluon-agy-task (Antigravity) can't be resumed");
    app.signal("SIGTERM");
    expect(await app.exitCode()).toBe(143);
    expect(saved(s)[0]!.sessions.map((c) => c.key)).toEqual(["kc", "ka"]);
    // Windows has no SIGTERM handler: the process is ended at once, with nothing printed.
    if (!WIN) expect(app.history()).toContain("Resume this session: gluon resume abcdef");
  });

  test("BUG-292/resume: a crash of Gluon keeps the record and says how to resume on stderr", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny()));
    const app = await start({ cwd: repo.tiny(), args: ["resume", "abcdef"], agents: ALL, env: { ...s.env, GLUON_TEST_PTY_FAIL: "1" } });
    await app.waitFor("Resumed");
    await app.press(KEYS.enter);
    await app.waitFor("TUI ready");
    app.write("%");
    expect(await app.exitCode()).toBe(1);
    expect(saved(s)[0]!.sessions.map((c) => c.key)).toEqual(["k1"]);
    expect(app.history()).toContain("Resume this session: gluon resume abcdef");
  });

  test("BUG-292/resume: saved sessions with one name are both reopened (the second under a free name) and both kept under their keys", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny(), { sessions: [child({ key: "k1" }), child({ key: "k2", resume: { id: "22222222-1111-4222-8333-444455556666", source: "minted" } })] }));
    const app = await start({ cwd: repo.tiny(), args: ["resume", "abcdef"], agents: ALL, env: s.env });
    await app.waitFor(() => starts(app).length === 2);
    await app.waitFor(() => saved(s)[0]?.sessions.length === 2 && saved(s)[0]!.sessions.every((c) => c.resume?.id));
    expect(starts(app).flat().filter((a) => a.startsWith("--resume=")).sort()).toEqual([`--resume=${UUID}`, "--resume=22222222-1111-4222-8333-444455556666"]);
    const [w] = saved(s);
    expect(w!.sessions.map((c) => c.key)).toEqual(["k1", "k2"]);
    expect(new Set(w!.sessions.map((c) => c.name)).size).toBe(2);
    expect(w!.sessions.map((c) => c.resume!.id)).toEqual([UUID, "22222222-1111-4222-8333-444455556666"]);
  });

  test("BUG-292/resume: two Gluons on one workspace each keep their own sessions' records from the other's (the later write never loses a file) @full", async () => {
    const s = sandbox();
    seed(s, workspace(repo.tiny()));
    const a = await start({ cwd: repo.tiny(), args: ["resume", "abcdef"], agents: ALL, env: s.env });
    await a.waitFor("Resumed");
    // A second Gluon on it is refused unless forced (BUG-306).
    const refused = await cli(["resume", "abcdef"], { env: s.env });
    expect(refused.code).toBe(1);
    const b = await start({ cwd: repo.tiny(), args: ["resume", "abcdef", "--force"], agents: ALL, env: s.env });
    await b.waitFor("Resumed");
    // The first one ends its session: the file goes; the second still has its own session and rewrites it on its next change.
    await a.press(KEYS.delete);
    await a.waitFor("End ");
    await a.press(KEYS.enter);
    await a.waitFor((x) => !x.includes("Gluon-alpha-task"));
    await a.waitFor(() => saved(s).length === 0);
    await b.press(KEYS.ctrlD);
    await b.waitFor(() => saved(s)[0]?.sessions[0]?.done === true);
    expect(saved(s)[0]?.sessions.map((c) => [c.key, c.done])).toEqual([["k1", true]]);
  });
});

describe("BUG-295/resume: the picker of gluon resume (a terminal, no id)", () => {
  const picker = (s: Sandbox, args: string[] = ["resume"]) => new App({ cwd: repo.tiny(), args, agents: ALL, env: s.env, cols: 120, rows: 30 });

  test("BUG-295/resume: it lists this directory's workspaces, newest first; Enter on one reopens that one; Esc resumes nothing, exit 130 @full", async () => {
    const s = sandbox();
    const here = repo.tiny();
    seed(s, workspace(here, { id: "aaaaaa", name: "older", updatedAt: Date.now() - 90_000 }), "aaaaaa");
    seed(s, workspace(here, { id: "bbbbbb", name: "newer", updatedAt: Date.now() - 1000, sessions: [child({ name: "Gluon-second" })] }), "bbbbbb");
    seed(s, workspace("/elsewhere/proj", { id: "cccccc", name: "far away" }), "cccccc");
    const esc = picker(s);
    await esc.waitFor("Resume which session in this directory?");
    const text = esc.screen();
    expect(text.indexOf("bbbbbb")).toBeLessThan(text.indexOf("aaaaaa"));
    expect(text).not.toContain("cccccc");
    await esc.press(KEYS.esc);
    expect(await esc.exitCode()).toBe(130);
    expect(esc.history()).toContain("Nothing resumed");
    const all = picker(s, ["resume", "--all"]);
    await all.waitFor("Resume which saved session?");
    expect(all.screen()).toContain("cccccc");
    all.kill();
    const pick = picker(s);
    await pick.waitFor("bbbbbb");
    await pick.press(KEYS.enter);
    await pick.waitFor("Resuming workspace bbbbbb");
    pick.kill();
  });
});
