/**
 * Saved meta-sessions (`src/workspaces.ts`, issue #42): the store's file, how it is read back (as
 * untrusted text), ids and prefixes, and the `Recorder` the running Gluon keeps it with.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canSymlink, isPrivate } from "./e2e/fixtures.ts";
import { claimWorkspace, deleteWorkspace, describeWorkspace, dirProblem, findWorkspace, listWorkspaces, liveOwner, loadWorkspace, localTime, MAX_SPEC, newWorkspaceId, ownerAlive, ownStart, parseWorkspace, processAlive, processStart, Recorder, RESUME_ID, runningGluons, sameDir, saveWorkspace, scanWorkspaces, WORKSPACE_ID, workspaceName, workspacesDir, type ChildRecord, type Workspace } from "../src/workspaces.ts";
import { uninstall, workspaceFiles } from "../src/uninstall.ts";
import { loadSecrets, useSecrets } from "../src/secrets.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-workspaces-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const was = process.env.GLUON_CONFIG;
let n = 0;
beforeEach(() => {
  const dir = join(TMP, `cfg-${++n}`);
  mkdirSync(dir);
  process.env.GLUON_CONFIG = join(dir, "config.yaml");
});
afterEach(() => {
  if (was === undefined) delete process.env.GLUON_CONFIG;
  else process.env.GLUON_CONFIG = was;
});

const child = (over: Partial<ChildRecord> = {}): ChildRecord => ({ key: "k1", name: "Gluon-fix-add", harness: "claude-code", model: "sonnet", effort: "medium", spec: "fix add", startedAt: 1_000, resume: { id: "0b1f3c5e-1111-4222-8333-444455556666", source: "minted" }, ...over });
const workspace = (over: Partial<Workspace> = {}): Workspace => ({ v: 1, id: "abcdef", name: "tiny · Oct 4", cwd: "/work/tiny", createdAt: 1_000, updatedAt: 2_000, sessions: [child()], ...over });
const fileOf = (id: string) => join(workspacesDir(), `${id}.json`);
const raw = (ws: unknown) => JSON.stringify(ws);

describe("BUG-312/resume: the saved workspace file", () => {
  test("a workspace round-trips through its file", () => {
    const ws = workspace({ sessions: [child(), child({ key: "k2", harness: "codex", model: "gpt-5.5", effort: undefined, done: true, resume: { id: "019a-codex", source: "captured" } }), child({ key: "k3", harness: "antigravity", resume: undefined })] });
    saveWorkspace(ws);
    expect(loadWorkspace("abcdef")).toEqual(ws);
  });

  test("BUG-612/resume-modes: a session's mode round-trips through the file; a record without one stays without (it is not guessed as build)", () => {
    const ws = workspace({ sessions: [child({ key: "k1", harness: "codex", model: "gpt-5.5", resume: { id: "019a-codex", source: "captured" }, mode: "explore" }), child({ key: "k2", mode: "plan" }), child({ key: "k3", mode: "build" }), child({ key: "k4" })] });
    saveWorkspace(ws);
    const got = loadWorkspace("abcdef")!.sessions;
    expect(got.map((c) => c.mode)).toEqual(["explore", "plan", "build", undefined]);
    expect(got[3]).not.toHaveProperty("mode");
    expect(loadWorkspace("abcdef")).toEqual(ws);
  });

  test("BUG-612/resume-modes: a mode that is no known mode (or no string) is a bad record like a bad effort: that session is dropped, the others kept", () => {
    const bad = ["yolo", "", "EXPLORE", 1, null, ["explore"], { x: 1 }].map((mode, i) => ({ ...child({ key: `b${i}` }), mode }));
    const ws = parseWorkspace(raw({ ...workspace(), sessions: [child({ key: "k1", mode: "explore" }), ...bad, child({ key: "k9" })] }));
    expect(ws!.sessions.map((s) => s.key)).toEqual(["k1", "k9"]);
  });

  test("the file is private (mode 600) and no temporary directory is left next to it", () => {
    saveWorkspace(workspace());
    expect(isPrivate(fileOf("abcdef"), tmpdir())).toBe(true);
    expect(readdirSync(workspacesDir())).toEqual(["abcdef.json"]);
  });

  test("a key in a spec is masked on disk, the rest of the spec kept", () => {
    const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    saveWorkspace(workspace({ sessions: [child({ spec: `use ANTHROPIC_API_KEY=${key} to fix add` })] }));
    const text = readFileSync(fileOf("abcdef"), "utf8");
    expect(text).not.toContain(key);
    expect(text).toContain("to fix add");
    expect(loadWorkspace("abcdef")!.sessions[0]!.spec).not.toContain(key);
  });

  test("saving a workspace with no sessions removes its file", () => {
    saveWorkspace(workspace());
    expect(existsSync(fileOf("abcdef"))).toBe(true);
    saveWorkspace(workspace({ sessions: [] }));
    expect(existsSync(fileOf("abcdef"))).toBe(false);
    // Nothing there to remove: not an error.
    expect(saveWorkspace(workspace({ sessions: [] }))).toBeUndefined();
  });
});

describe("BUG-312/resume: the file is read as untrusted text", () => {
  test("corrupt, foreign-shaped and oversized files are skipped; the good ones listed", () => {
    saveWorkspace(workspace({ id: "good22" }));
    mkdirSync(workspacesDir(), { recursive: true });
    writeFileSync(fileOf("corrupt"), "{ not json");
    writeFileSync(join(workspacesDir(), "garbage.json"), "{ not json");
    writeFileSync(fileOf("abcdee"), raw({ ...workspace({ id: "abcdee" }), v: 2 }));
    writeFileSync(fileOf("abcdeg"), raw({ ...workspace({ id: "abcdeg" }), cwd: 7 }));
    writeFileSync(fileOf("abcdeh"), raw({ ...workspace({ id: "abcdeh" }), sessions: "no" }));
    writeFileSync(fileOf("abcdei"), raw(["array"]));
    writeFileSync(fileOf("abcdej"), "null");
    // The name inside must match the file's: an id with a path in it never reads a file.
    writeFileSync(fileOf("abcdek"), raw({ ...workspace({ id: "../../x1" }) }));
    // Over the size cap.
    writeFileSync(fileOf("abcdem"), raw(workspace({ id: "abcdem", sessions: [child({ spec: "x".repeat(5 * 1024 * 1024) })] })));
    writeFileSync(join(workspacesDir(), "notes.txt"), "hello");
    expect(listWorkspaces().map((w) => w.id)).toEqual(["good22"]);
    expect(loadWorkspace("../config")).toBeNull();
    expect(loadWorkspace("abcdem")).toBeNull();
  });

  test("one bad session is dropped and the others kept", () => {
    const bad = [{ ...child({ key: "b1" }), harness: "nope" }, { ...child({ key: "b2" }), model: "" }, { ...child({ key: "b3" }), key: "bad key!" }, { ...child({ key: "b4" }), effort: "ludicrous" }, null, 7, "x"];
    const ws = parseWorkspace(raw({ ...workspace(), sessions: [child({ key: "k1" }), ...bad, child({ key: "k9", name: "Gluon-other" })] }));
    expect(ws!.sessions.map((s) => s.key)).toEqual(["k1", "k9"]);
  });

  test("a resume id that could be read as an option is dropped; the session stays, to be started again", () => {
    for (const id of ["-x", "--resume=1", "a b", "a\nb", "", "x".repeat(65), "ses/../x"]) {
      const ws = parseWorkspace(raw({ ...workspace(), sessions: [child({ resume: { id, source: "captured" } })] }));
      expect(ws!.sessions).toHaveLength(1);
      expect(ws!.sessions[0]!.resume).toBeUndefined();
      expect(RESUME_ID.test(id)).toBe(false);
    }
    for (const id of ["0b1f3c5e-1111-4222-8333-444455556666", "ses_3f2a9c0d1E8b", "019a1b2c-d3e4"]) expect(RESUME_ID.test(id)).toBe(true);
    // An unknown source is no id either.
    expect(parseWorkspace(raw({ ...workspace(), sessions: [child({ resume: { id: "ok-id", source: "guess" as never } })] }))!.sessions[0]!.resume).toBeUndefined();
  });

  test("a workspace with an id that is not six base32 characters is refused", () => {
    for (const id of ["ABCDEF", "abcde", "abcdefg", "abc018", "../abcd"]) expect(parseWorkspace(raw(workspace({ id })))).toBeNull();
    expect(WORKSPACE_ID.test("abcdef")).toBe(true);
  });

  test("at most 200 sessions are read", () => {
    const many = Array.from({ length: 300 }, (_, i) => child({ key: `k${i}` }));
    expect(parseWorkspace(raw(workspace({ sessions: many })))!.sessions).toHaveLength(200);
  });
});

describe("BUG-312/resume: ids, prefixes and the list", () => {
  test("a new id is six characters of the alphabet and never one taken", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newWorkspaceId((x) => seen.has(x));
      expect(id).toMatch(WORKSPACE_ID);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
    let first = true;
    // The first draw is taken: another comes.
    const id = newWorkspaceId(() => (first ? !(first = false) : false));
    expect(id).toMatch(WORKSPACE_ID);
  });

  test("workspaces are listed most recently updated first", () => {
    saveWorkspace(workspace({ id: "aaaaaa", updatedAt: 10 }));
    saveWorkspace(workspace({ id: "bbbbbb", updatedAt: 30 }));
    saveWorkspace(workspace({ id: "cccccc", updatedAt: 20 }));
    expect(listWorkspaces().map((w) => w.id)).toEqual(["bbbbbb", "cccccc", "aaaaaa"]);
    expect(listWorkspaces().map((w) => w.id)).toEqual(["bbbbbb", "cccccc", "aaaaaa"]);
  });

  test("an id or a unique prefix finds the workspace; an ambiguous or unknown one says so", () => {
    const all = ["abcdef", "abcxyz", "kkkkkk"].map((id) => workspace({ id }));
    expect(findWorkspace("kkk", all)).toEqual({ ws: all[2]! });
    expect(findWorkspace("ABCDEF", all)).toEqual({ ws: all[0]! });
    expect(findWorkspace(" abcx ", all)).toEqual({ ws: all[1]! });
    expect(findWorkspace("abc", all)).toEqual({ error: '"abc" matches abcdef, abcxyz' });
    expect(findWorkspace("zzz", all)).toEqual({ error: 'no saved session "zzz" (gluon sessions lists them)' });
    expect(findWorkspace("", all)).toEqual({ error: "no id given" });
    // An exact id wins over being the prefix of another.
    const nested = ["abcdef", "abcdef"].map((id) => workspace({ id }));
    expect("ws" in findWorkspace("abcdef", nested)).toBe(true);
  });

  test("a workspace is named for its directory and day, and described in one line", () => {
    expect(workspaceName("/home/me/tiny/", Date.UTC(2026, 9, 4, 12))).toBe("tiny · Oct 4");
    expect(workspaceName("C:\\work\\tiny", Date.UTC(2026, 9, 4, 12))).toBe("tiny · Oct 4");
    // The time is the machine's own, with its offset from UTC (BUG-662): built here from the Date's local fields, so any zone passes.
    const at = Date.UTC(2026, 9, 4, 12, 30);
    expect(describeWorkspace(workspace({ updatedAt: at }))).toBe(`abcdef  tiny · Oct 4  1 session  ${localTime(at)}  /work/tiny`);
    expect(describeWorkspace(workspace({ sessions: [child(), child({ key: "k2" })] }))).toContain("2 sessions");
  });

  test("directories compare as the OS does: a trailing slash is the same, Windows ignores case", () => {
    expect(sameDir("/work/tiny", "/work/tiny/", "linux")).toBe(true);
    expect(sameDir("/work/tiny", "/work/Tiny", "linux")).toBe(false);
    expect(sameDir("/", "/", "linux")).toBe(true);
    expect(sameDir("C:\\Work\\Tiny", "c:/work/tiny/", "win32")).toBe(true);
    expect(sameDir("C:\\Work\\Tiny", "c:/work/other", "win32")).toBe(false);
  });

  test("BUG-309/resume: the long form (a call into the file system) is asked for only when the spellings differ and both are on one drive", () => {
    const asked: string[] = [];
    const long = (p: string) => (asked.push(p), p.replace("PROGRA~1", "Program Files"));
    // Equal as written, or on another drive (a disconnected mapped one): never asked.
    expect(sameDir("C:\\Work\\Tiny", "c:/work/tiny/", "win32", long)).toBe(true);
    expect(sameDir("Z:\\gone\\repo", "C:\\Work\\Tiny", "win32", long)).toBe(false);
    expect(sameDir("\\\\host\\share\\x", "C:\\Work", "win32", long)).toBe(false);
    expect(sameDir("/a/b", "/a/c", "linux", long)).toBe(false);
    expect(asked).toEqual([]);
    // Same drive, other spelling: the long forms decide.
    expect(sameDir("C:\\PROGRA~1\\x", "C:\\Program Files\\x", "win32", long)).toBe(true);
    expect(sameDir("C:\\PROGRA~1\\x", "C:\\Program Files\\y", "win32", long)).toBe(false);
    expect(asked).toHaveLength(4);
  });
});

describe("BUG-312/resume: the recorder", () => {
  const noSave = () => {
    const saved: Workspace[] = [];
    return { saved, save: (ws: Workspace) => (saved.push(structuredClone(ws)), undefined) };
  };
  const base = { harness: "claude-code" as const, model: "sonnet", spec: "fix add", startedAt: 5 };

  test("an empty Gluon saves nothing; the first session creates the workspace", () => {
    const { saved, save } = noSave();
    const rec = new Recorder("/work/tiny", undefined, { save, now: () => 3_000 });
    expect(rec.id).toBeNull();
    expect(saved).toHaveLength(0);
    const first = rec.add({ ...base, name: "Gluon-fix-add" });
    expect(rec.id).toMatch(WORKSPACE_ID);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ v: 1, cwd: "/work/tiny", createdAt: 3_000, updatedAt: 3_000, sessions: [{ key: first.key, name: "Gluon-fix-add" }] });
    expect(first.key).toMatch(/^[A-Za-z0-9-]{1,64}$/);
  });

  test("a change is written once; a patch that changes nothing writes nothing; an undefined removes the field", () => {
    const { saved, save } = noSave();
    const rec = new Recorder("/work/tiny", undefined, { save });
    const c = rec.add({ ...base, name: "a", resume: { id: "old-id", source: "captured" } });
    rec.update(c.key, { name: "b" });
    rec.update(c.key, { name: "b", done: undefined });
    rec.update(c.key, { done: true });
    rec.update(c.key, { resume: undefined });
    rec.update("nope", { name: "x" });
    expect(saved.map((w) => [w.sessions[0]!.name, w.sessions[0]!.done, w.sessions[0]!.resume?.id])).toEqual([
      ["a", undefined, "old-id"],
      ["b", undefined, "old-id"],
      ["b", true, "old-id"],
      ["b", true, undefined],
    ]);
  });

  test("the last session to end takes the file with it, and the workspace keeps its id for the next", () => {
    const rec = new Recorder("/work/tiny", undefined, {});
    const a = rec.add({ ...base, name: "a" });
    const b = rec.add({ ...base, name: "b" });
    const id = rec.id!;
    expect(existsSync(fileOf(id))).toBe(true);
    rec.remove(a.key);
    expect(loadWorkspace(id)!.sessions.map((s) => s.name)).toEqual(["b"]);
    rec.remove(b.key);
    expect(existsSync(fileOf(id))).toBe(false);
    expect(rec.id).toBeNull();
    rec.add({ ...base, name: "c" });
    expect(rec.id).toBe(id);
    expect(loadWorkspace(id)!.sessions.map((s) => s.name)).toEqual(["c"]);
  });

  test("a resumed workspace continues in the same file with the same keys", () => {
    saveWorkspace(workspace());
    const rec = new Recorder("/work/tiny", loadWorkspace("abcdef")!, {});
    expect(rec.id).toBe("abcdef");
    expect(rec.children.map((c) => c.key)).toEqual(["k1"]);
    rec.update("k1", { resume: { id: "new-id", source: "minted" } });
    rec.add({ ...base, name: "second" });
    const after = loadWorkspace("abcdef")!;
    expect(after.sessions.map((s) => [s.key, s.name])).toEqual([["k1", "Gluon-fix-add"], [expect.any(String), "second"]]);
    expect(after.sessions[0]!.resume!.id).toBe("new-id");
    expect(after.createdAt).toBe(1_000);
    expect(after.updatedAt).toBeGreaterThan(2_000);
  });

  test("a save that fails never throws: it is reported once", () => {
    const errors: string[] = [];
    const rec = new Recorder("/work/tiny", undefined, { save: () => { throw new Error("disk full"); }, onError: (m) => errors.push(m) });
    const c = rec.add({ ...base, name: "a" });
    rec.update(c.key, { name: "b" });
    rec.remove(c.key);
    expect(errors).toEqual(["couldn't save the session record: disk full"]);
  });

  test("a warning from the private write (icacls) is passed on once", () => {
    const errors: string[] = [];
    const rec = new Recorder("/work/tiny", undefined, { save: () => "icacls said no", onError: (m) => errors.push(m) });
    const c = rec.add({ ...base, name: "a" });
    rec.update(c.key, { name: "b" });
    expect(errors).toEqual(["icacls said no"]);
  });
});

describe("BUG-302/resume: the worktree a session was planned in", () => {
  const wt = { path: "/work/tiny/.gluon/worktrees/gluon-fix-add", branch: "gluon/fix-add" };

  test("it round-trips with the session", () => {
    saveWorkspace(workspace({ sessions: [child({ worktree: wt })] }));
    expect(loadWorkspace("abcdef")!.sessions[0]!.worktree).toEqual(wt);
  });

  test("a path that isn't a Gluon worktree, with a `..`, or a branch that isn't gluon/<name> drops only the worktree (git is run in that path)", () => {
    const bad = [
      { path: "/etc", branch: "gluon/x" },
      { path: "/work/tiny/.gluon/worktrees/gluon-fix-add/..", branch: "gluon/x" },
      { path: "/work/../.gluon/worktrees/gluon-x", branch: "gluon/x" },
      { path: "/work/tiny/.gluon/worktrees/other", branch: "gluon/x" },
      { path: "\\\\evil\\share\\.gluon\\worktrees\\gluon-x", branch: "gluon/x" },
      { path: wt.path, branch: "--upload-pack=x" },
      { path: wt.path, branch: "main" },
      { path: wt.path, branch: "gluon/a b" },
      { path: wt.path, branch: "gluon/../x" },
      { path: wt.path },
      "x",
      7,
    ];
    for (const worktree of bad) {
      const ws = parseWorkspace(raw({ ...workspace(), sessions: [{ ...child(), worktree }] }))!;
      expect(ws.sessions).toHaveLength(1);
      expect(ws.sessions[0]!.worktree).toBeUndefined();
    }
    expect(parseWorkspace(raw({ ...workspace(), sessions: [{ ...child(), worktree: { path: "C:\\work\\tiny\\.gluon\\worktrees\\gluon-fix-add", branch: "gluon/fix-add" } }] }))!.sessions[0]!.worktree).toBeDefined();
  });

  test("BUG-641/variants: a branch under another prefix (`gluon-2/…`, chosen when a branch is named `gluon`) round-trips; `gluon-x/…` does not", () => {
    const other = { ...wt, branch: "gluon-2/fix-add" };
    expect(parseWorkspace(raw({ ...workspace(), sessions: [{ ...child(), worktree: other }] }))!.sessions[0]!.worktree).toEqual(other);
    expect(parseWorkspace(raw({ ...workspace(), sessions: [{ ...child(), worktree: { ...wt, branch: "gluon-x/fix-add" } }] }))!.sessions[0]!.worktree).toBeUndefined();
  });

  test("a patch sets and clears it", () => {
    const rec = new Recorder("/work/tiny", undefined, {});
    const c = rec.add({ ...base0, name: "a" });
    rec.update(c.key, { worktree: wt });
    expect(loadWorkspace(rec.id!)!.sessions[0]!.worktree).toEqual(wt);
    rec.update(c.key, { worktree: undefined });
    expect(loadWorkspace(rec.id!)!.sessions[0]!.worktree).toBeUndefined();
  });
});
const base0 = { harness: "claude-code" as const, model: "sonnet", spec: "fix add", startedAt: 5 };

describe("BUG-303/resume: a directory that can't be saved", () => {
  test("a network path or one with control or direction characters is no workspace: nothing is written, no id, and the user is told once why", () => {
    for (const cwd of ["\\\\server\\share\\repo", "//server/share/repo", "/work/tab\there", "/work/evil\u202edir", "relative/dir"]) {
      const errors: string[] = [];
      const saved: Workspace[] = [];
      const rec = new Recorder(cwd, undefined, { save: (w) => (saved.push(w), undefined), onError: (m) => errors.push(m) });
      const a = rec.add({ ...base0, name: "a" });
      const b = rec.add({ ...base0, name: "b" });
      expect(a.key).not.toBe(b.key);
      rec.update(a.key, { name: "c" });
      rec.remove(a.key);
      expect([saved.length, rec.id, rec.children.length]).toEqual([0, null, 0]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toStartWith("this directory can't be saved for resume: ");
      expect(dirProblem(cwd)).not.toBeNull();
    }
    expect(existsSync(workspacesDir())).toBe(false);
  });

  test("an ordinary directory, with spaces or on a drive, is saved", () => {
    for (const cwd of ["/work/my project", "C:\\Users\\me\\repo"]) {
      expect(dirProblem(cwd)).toBeNull();
      const rec = new Recorder(cwd, undefined, { save: () => undefined });
      rec.add({ ...base0, name: "a" });
      expect(rec.id).toMatch(WORKSPACE_ID);
    }
  });
});

describe("BUG-306/resume: one Gluon at a time per workspace", () => {
  test("the recorder writes its process id on every save, and a resumed workspace claims it at once", () => {
    const rec = new Recorder("/work/tiny", undefined, { pid: 4242 });
    const c = rec.add({ ...base0, name: "a" });
    expect(loadWorkspace(rec.id!)!.pid).toBe(4242);
    rec.update(c.key, { name: "b" });
    expect(loadWorkspace(rec.id!)!.pid).toBe(4242);
    saveWorkspace({ ...workspace({ id: "bbbbbb" }), pid: 1 });
    const resumed = new Recorder("/work/tiny", loadWorkspace("bbbbbb")!, { pid: 77 });
    expect(loadWorkspace("bbbbbb")!.pid).toBe(1);
    resumed.claim();
    expect(loadWorkspace("bbbbbb")!.pid).toBe(77);
  });

  test("a pid in the file is a safe positive integer or nothing", () => {
    for (const pid of [0, -5, 1.5, "7", null, 2 ** 60, Number.NaN, true]) expect(parseWorkspace(raw({ ...workspace(), pid }))!.pid).toBeUndefined();
    expect(parseWorkspace(raw({ ...workspace(), pid: 12345 }))!.pid).toBe(12345);
  });

  test("a process is alive when signal 0 reaches it or is refused (EPERM); not when it's gone (ESRCH), nor for this process, nor a bad id", async () => {
    const err = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(processAlive(4242, () => true)).toBe(true);
    expect(processAlive(4242, err("EPERM"))).toBe(true);
    expect(processAlive(4242, err("ESRCH"))).toBe(false);
    expect(processAlive(process.pid, () => true)).toBe(false);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(processAlive(bad, () => true)).toBe(false);
    // For real: a process that runs, then one that has ended.
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      expect(processAlive(child.pid)).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
    expect(processAlive(child.pid)).toBe(false);
  });
});

describe("BUG-308/resume: deleting one saved workspace", () => {
  test("only that workspace's file goes", () => {
    saveWorkspace(workspace({ id: "aaaaaa" }));
    saveWorkspace(workspace({ id: "bbbbbb" }));
    writeFileSync(join(workspacesDir(), "notes.txt"), "mine");
    expect(deleteWorkspace("aaaaaa")).toBe(true);
    expect(deleteWorkspace("aaaaaa")).toBe(false);
    expect(deleteWorkspace("../config")).toBe(false);
    expect(readdirSync(workspacesDir()).sort()).toEqual(["bbbbbb.json", "notes.txt"]);
  });
});

describe("BUG-291/resume: a hand-edited file is hostile text", () => {
  const evil = "\x1b]0;PWNED\x07\x1b[2J\x1b[31mred\x9b2J\u202eevil\u200b\n";
  const sane = (s: string) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s);

  test("names and models are made one safe line; a directory or model with controls is refused", () => {
    const ws = parseWorkspace(raw({ ...workspace({ name: `repo${evil}` }), sessions: [child({ name: `Gluon-x${evil}` })] }))!;
    expect(sane(ws.name)).toBe(true);
    expect(sane(ws.sessions[0]!.name)).toBe(true);
    expect(ws.name).toContain("repo");
    // A cwd is a path, never rewritten: with a control in it, the workspace is refused.
    expect(parseWorkspace(raw(workspace({ cwd: `/work/x${evil}` })))).toBeNull();
    // A model that isn't one safe line drops the session, not the others.
    const two = parseWorkspace(raw({ ...workspace(), sessions: [child({ key: "k1", model: `sonnet${evil}` }), child({ key: "k2" })] }))!;
    expect(two.sessions.map((s) => s.key)).toEqual(["k2"]);
    // Nothing a person sees is left holding an escape: the one line `gluon sessions` prints.
    expect(sane(describeWorkspace(ws))).toBe(true);
  });

  test("a real model id survives the round trip (masking a model would only lose its session)", () => {
    for (const model of ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic/claude-sonnet-4.5", "openai/gpt-5.1-codex-max", "amazon.nova-pro-v1:0", "AbCdEfGhIj/KlMnOpQrStUvWxYz+0123456789ab"]) {
      expect(parseWorkspace(raw({ ...workspace(), sessions: [child({ model })] }))!.sessions.map((c) => c.model)).toEqual([model]);
    }
  });

  test("a name holding a key is masked, on disk and when read", () => {
    const key = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8".repeat(3);
    const ws = workspace({ name: `repo ${key}`, sessions: [child({ name: `Gluon-${key}` })] });
    saveWorkspace(ws);
    const text = readFileSync(fileOf("abcdef"), "utf8");
    expect(text).not.toContain(key);
    expect(parseWorkspace(raw(ws))!.name).not.toContain(key);
  });

  test("a directory that is not absolute is refused: a resume never enters a path relative to wherever it was started", () => {
    for (const cwd of [".", "..", "repo", "../x", "~/x", "-x"]) expect(parseWorkspace(raw(workspace({ cwd })))).toBeNull();
    expect(parseWorkspace(raw(workspace({ cwd: "C:\\Users\\me\\repo" })))).not.toBeNull();
    expect(parseWorkspace(raw(workspace({ cwd: "/work/tiny" })))).not.toBeNull();
  });

  test("BUG-297/resume: a network (UNC) directory is refused: entering it would make Windows sign in to a host a file names", () => {
    for (const cwd of ["\\\\evil\\share\\repo", "//evil/share/repo", "\\\\?\\UNC\\evil\\share"]) expect(parseWorkspace(raw(workspace({ cwd })))).toBeNull();
  });

  test("a real directory with two spaces, a trailing space, an emoji sequence or non-Latin letters is kept exactly", () => {
    for (const cwd of ["/work/my  project", "/work/trailing ", "/work/👨‍👩‍👧 family", "/work/проект", "C:\\Users\\me\\My Repo"]) expect(parseWorkspace(raw(workspace({ cwd })))!.cwd).toBe(cwd);
  });

  test("BUG-294/resume: a time a Date can't show refuses the file instead of crashing gluon sessions", () => {
    for (const bad of [1e300, 8.64e15 + 1, -1, "1", null]) {
      expect(parseWorkspace(raw({ ...workspace(), updatedAt: bad }))).toBeNull();
      expect(parseWorkspace(raw({ ...workspace(), createdAt: bad }))).toBeNull();
      expect(parseWorkspace(raw({ ...workspace(), sessions: [child({ startedAt: bad as number })] }))!.sessions).toEqual([]);
    }
    expect(describeWorkspace(parseWorkspace(raw({ ...workspace(), updatedAt: 8.64e15 }))!)).toContain("275760-09-1");
  });

  test("two sessions with one key keep the first (a key names one session)", () => {
    const ws = parseWorkspace(raw({ ...workspace(), sessions: [child({ key: "k1", name: "Gluon-first" }), child({ key: "k1", name: "Gluon-second" }), child({ key: "k2" })] }))!;
    expect(ws.sessions.map((s) => s.name)).toEqual(["Gluon-first", "Gluon-fix-add"]);
  });

  test("__proto__ and other odd keys in the file reach nothing", () => {
    const text = `{"v":1,"id":"abcdef","name":"x","cwd":"/work","createdAt":1,"updatedAt":2,"__proto__":{"polluted":1},"sessions":[{"key":"k1","name":"a","harness":"claude-code","model":"sonnet","spec":"s","startedAt":1,"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"resume":{"id":"abc","source":"minted","__proto__":{"polluted":1}}}]}`;
    const ws = parseWorkspace(text)!;
    expect(ws.sessions).toHaveLength(1);
    expect(Object.keys(ws)).toEqual(["v", "id", "name", "cwd", "createdAt", "updatedAt", "sessions"]);
    expect(Object.keys(ws.sessions[0]!).sort()).toEqual(["harness", "key", "model", "name", "resume", "spec", "startedAt"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(ws.sessions[0]!.resume).toEqual({ id: "abc", source: "minted" });
  });

  test.skipIf(!canSymlink)("a workspace file that is a link to a file or a device is not read", () => {
    mkdirSync(workspacesDir(), { recursive: true });
    const real = join(TMP, "elsewhere.json");
    writeFileSync(real, raw(workspace({ id: "abcdef" })));
    symlinkSync(real, fileOf("abcdef"));
    expect(loadWorkspace("abcdef")).toBeNull();
    // A device that never ends would hang a plain read.
    symlinkSync("/dev/zero", fileOf("abcdeg"));
    expect(loadWorkspace("abcdeg")).toBeNull();
    expect(listWorkspaces()).toEqual([]);
  });

  test.skipIf(!canSymlink)("a symlinked file is replaced by a save, never written through", () => {
    mkdirSync(workspacesDir(), { recursive: true });
    const victim = join(TMP, "victim.txt");
    writeFileSync(victim, "precious");
    symlinkSync(victim, fileOf("abcdef"));
    saveWorkspace(workspace());
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(loadWorkspace("abcdef")!.id).toBe("abcdef");
  });
});

// QA campaign (B6): defects found by hand. Each `test.failing` passes while the defect stands; fixing it makes the test fail: turn it into `test`.
describe("QA-resume: what is saved must be readable again", () => {
  /** Saves `ws` the way the Recorder does, then asks whether `gluon resume` would find it. */
  const roundTrip = (ws: Workspace) => {
    saveWorkspace(ws);
    return loadWorkspace(ws.id);
  };

  test("BUG-634/QA-resume-03: a directory whose name is over ~190 characters is still resumable (its workspace name, `<dir> · Oct 4`, is read back with a 200-character limit and the whole file is refused)", () => {
    const rec = new Recorder(`/work/${"x".repeat(250)}`, undefined, { save: saveWorkspace });
    rec.add({ name: "Gluon-a", harness: "claude-code", model: "sonnet", spec: "s", startedAt: 1 });
    // Gluon announces `Resume this session: gluon resume <id>` for this id.
    expect(rec.id).not.toBeNull();
    expect(loadWorkspace(rec.id!)).not.toBeNull();
  });

  test("BUG-635/QA-resume-04: a workspace that saves is not larger than the 4 MB the reader accepts (five 900 KB specs are written, then `gluon resume` finds no such session): the writer refuses the fifth, out loud, and the file keeps reading back", () => {
    const told: string[] = [];
    const rec = new Recorder("/work/tiny", undefined, { save: saveWorkspace, onError: (m) => told.push(m) });
    for (let i = 1; i <= 5; i++) rec.add({ name: `Gluon-s${i}`, harness: "claude-code", model: "sonnet", spec: "x".repeat(900_000), startedAt: 1 });
    expect(rec.children).toHaveLength(4);
    expect(loadWorkspace(rec.id!)!.sessions).toHaveLength(4);
    expect(readFileSync(fileOf(rec.id!)).length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/can't be saved for resume.*4 MB/);
  });

  test("BUG-635/variants: saveWorkspace itself writes nothing it couldn't read back (it throws, the earlier file stays); a spec over the limit is refused, the session after it is recorded", () => {
    const big = workspace({ sessions: [1, 2, 3, 4, 5].map((i) => child({ key: `k${i}`, spec: "x".repeat(900_000) })) });
    saveWorkspace(workspace());
    expect(() => saveWorkspace({ ...big, sessions: big.sessions })).toThrow(/wouldn't read back.*4 MB/);
    expect(loadWorkspace("abcdef")!.sessions[0]!.spec).toBe("fix add");
    const told: string[] = [];
    const rec = new Recorder("/work/tiny", undefined, { save: saveWorkspace, onError: (m) => told.push(m) });
    rec.add({ name: "Gluon-big", harness: "claude-code", model: "sonnet", spec: "x".repeat(MAX_SPEC + 1), startedAt: 1 });
    expect(rec.id).toBeNull();
    rec.add({ name: "Gluon-ok", harness: "claude-code", model: "sonnet", spec: "x".repeat(MAX_SPEC), startedAt: 1 });
    expect(loadWorkspace(rec.id!)!.sessions.map((s) => s.name)).toEqual(["Gluon-ok"]);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("1,000,001 characters");
  });

  test("BUG-636/QA-resume-04b: the 201st session is not recorded in a file that reads back only 200 (the newest, not the oldest, are silently lost)", () => {
    const rec = new Recorder("/work/tiny", undefined, { save: saveWorkspace });
    for (let i = 0; i < 201; i++) rec.add({ name: `Gluon-s${i}`, harness: "claude-code", model: "sonnet", spec: "s", startedAt: 1 });
    expect(loadWorkspace(rec.id!)!.sessions).toHaveLength(rec.children.length);
  });

  test("BUG-636/variants: the 201st session is refused out loud and runs unrecorded; the 200 saved stay, and a session ending frees a place", () => {
    const told: string[] = [];
    const rec = new Recorder("/work/tiny", undefined, { save: saveWorkspace, onError: (m) => told.push(m) });
    for (let i = 0; i < 201; i++) rec.add({ name: `Gluon-s${i}`, harness: "claude-code", model: "sonnet", spec: "s", startedAt: 1 });
    expect(told).toEqual(["this session can't be saved for resume: a saved workspace holds at most 200 sessions"]);
    const names = loadWorkspace(rec.id!)!.sessions.map((s) => s.name);
    expect(names).toHaveLength(200);
    expect(names).not.toContain("Gluon-s200");
    rec.remove(rec.children[0]!.key);
    rec.add({ name: "Gluon-later", harness: "claude-code", model: "sonnet", spec: "s", startedAt: 1 });
    expect(loadWorkspace(rec.id!)!.sessions.at(-1)!.name).toBe("Gluon-later");
    expect(told).toHaveLength(1);
  });

  test("BUG-634/variants: a long name is cut to fit, with its day; a short one and an astral character are kept whole", () => {
    const at = Date.UTC(2026, 9, 4, 12);
    for (const dir of ["x".repeat(190), "x".repeat(250), "😀".repeat(150), `${"y".repeat(193)}😀z`]) {
      const name = workspaceName(`/work/${dir}`, at);
      expect(name.length).toBeLessThanOrEqual(200);
      expect(name).toMatch(/ · Oct 4$/);
      expect([...name].includes("�")).toBe(false);
      expect(parseWorkspace(raw(workspace({ name })))).not.toBeNull();
    }
    expect(workspaceName("/work/tiny", at)).toBe("tiny · Oct 4");
    expect(workspaceName(`/work/${"x".repeat(250)}`, at)).toStartWith("xxxx");
    expect(workspaceName(`/work/${"x".repeat(250)}`, at)).toContain("… · Oct 4");
  });

  test("BUG-637/QA-resume-05: a file whose content names another workspace than its file name is not listed as that one (copying `abcdef.json` to `ghijkl.json` lists abcdef twice, and `--delete ghijkl` finds nothing)", () => {
    mkdirSync(workspacesDir(), { recursive: true });
    writeFileSync(fileOf("ghijkl"), raw(workspace({ id: "abcdef" })));
    expect(loadWorkspace("ghijkl")).toBeNull();
  });

  test("BUG-637/variants: a copy under another name is not listed twice or found by the id it holds; it is named as unreadable, so it can be deleted by its file's id; the original stays", () => {
    saveWorkspace(workspace());
    writeFileSync(fileOf("ghijkl"), raw(workspace({ id: "abcdef" })));
    expect(listWorkspaces().map((w) => w.id)).toEqual(["abcdef"]);
    expect(findWorkspace("ghijkl")).toHaveProperty("error");
    expect(scanWorkspaces().unreadable).toEqual(["ghijkl"]);
    expect(deleteWorkspace("ghijkl")).toBe(true);
    expect(scanWorkspaces()).toMatchObject({ unreadable: [] });
    expect(loadWorkspace("abcdef")).not.toBeNull();
  });

  test.skipIf(!canSymlink)("BUG-638/variants: a dangling link named like a workspace is named as unreadable and deleted by its id (the link goes, nothing else)", () => {
    mkdirSync(workspacesDir(), { recursive: true });
    symlinkSync(join(TMP, "nonexistent"), fileOf("dangaa"));
    expect(scanWorkspaces().unreadable).toEqual(["dangaa"]);
    expect(deleteWorkspace("dangaa")).toBe(true);
    expect(readdirSync(workspacesDir())).toEqual([]);
    expect(deleteWorkspace("dangaa")).toBe(false);
  });

  test("BUG-635/variants: a session whose resume id or worktree the reader would drop is refused out loud, not written and lost on the next read; a good one beside it stays", () => {
    const told: string[] = [];
    const rec = new Recorder("/work/tiny", undefined, { save: saveWorkspace, onError: (m) => told.push(m) });
    const base = { name: "Gluon-a", harness: "claude-code" as const, model: "sonnet", spec: "s", startedAt: 1 };
    rec.add(base);
    rec.add({ ...base, name: "Gluon-bad-id", resume: { id: "a.b/c", source: "minted" } });
    rec.add({ ...base, name: "Gluon-bad-tree", worktree: { path: "/work/tiny/elsewhere", branch: "gluon/x" } });
    rec.add({ ...base, name: "Gluon-good", done: false, resume: { id: "0b1f3c5e-1111-4222-8333-444455556666", source: "minted" }, worktree: { path: "/work/tiny/.gluon/worktrees/gluon-good", branch: "gluon/good" } });
    expect(loadWorkspace(rec.id!)!.sessions.map((s) => s.name)).toEqual(["Gluon-a", "Gluon-good"]);
    expect(rec.children).toHaveLength(2);
    expect(told).toHaveLength(2);
    expect(told[0]).toContain('resume of session "Gluon-bad-id"');
    expect(told[1]).toContain('worktree of session "Gluon-bad-tree"');
    // A later update to a bad value is a failed write, told once; the saved file keeps the last readable state.
    rec.update(rec.children[0]!.key, { resume: { id: "-x", source: "captured" } });
    expect(told).toHaveLength(3);
    expect(loadWorkspace(rec.id!)!.sessions[0]!.resume).toBeUndefined();
  });

  test("BUG-635/variants: a key that becomes known while a record lives is masked in the next write (the masking of a record is not kept past the set of known keys)", () => {
    const plain = "plain-value-not-shaped-like-a-token";
    const rec = new Recorder("/work/tiny", undefined, { save: saveWorkspace });
    rec.add({ name: "Gluon-a", harness: "claude-code", model: "sonnet", spec: `deploy with ${plain} then test`, startedAt: 1 });
    expect(readFileSync(fileOf(rec.id!), "utf8")).toContain(plain);
    try {
      useSecrets([["OPENAI_API_KEY", plain]], "test");
      rec.update(rec.children[0]!.key, { done: true });
      expect(readFileSync(fileOf(rec.id!), "utf8")).not.toContain(plain);
    } finally {
      loadSecrets();
    }
  });

  test("BUG-635/variants: a field the reader doesn't keep (a token on a record or on the workspace) is refused, never written raw; the message shows the name as one short line", () => {
    const told: string[] = [];
    const rec = new Recorder("/work/tiny", undefined, { save: saveWorkspace, onError: (m) => told.push(m) });
    const base = { name: "Gluon-a", harness: "claude-code" as const, model: "sonnet", spec: "s", startedAt: 1 };
    rec.add({ ...base, token: "sk-ant-api03-0123456789abcdefghijklmnop" } as never);
    expect(rec.id).toBeNull();
    expect(told).toEqual(["this session can't be saved for resume: a record has a field the reader doesn't keep"]);
    const w = { ...workspace(), token: "sk-ant-api03-0123456789abcdefghijklmnop" } as Workspace;
    expect(() => saveWorkspace(w)).toThrow(/field the reader doesn't keep/);
    expect(existsSync(fileOf("abcdef"))).toBe(false);
    const long = `${"line one\n".repeat(30)}end`;
    rec.add({ ...base, name: long, resume: { id: "a.b/c", source: "minted" } });
    expect(told).toHaveLength(2);
    expect(told[1]).not.toContain("\n");
    expect(told[1]!.length).toBeLessThan(160);
  });

  test("BUG-638/variants: a file that doesn't parse, a directory and a stray name: only the first is named as unreadable", () => {
    mkdirSync(workspacesDir(), { recursive: true });
    writeFileSync(fileOf("abcdef"), '{"v":1,"id":"abcdef","name":');
    mkdirSync(fileOf("ghijkl"));
    writeFileSync(join(workspacesDir(), "notes.txt"), "x");
    writeFileSync(join(workspacesDir(), "abcdef.json.tmp"), "x");
    expect(scanWorkspaces()).toEqual({ saved: [], unreadable: ["abcdef"] });
    expect(listWorkspaces()).toEqual([]);
  });

  test("BUG-589/spec-secrets-on-disk: a URL password, a password= value and a cut key block are masked in the file, and the workspace still reads back", () => {
    const spec = "clone https://ci:pw-abcdef-0123456789@git.example.com/org/repo with password=hunter2-abcdef\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7abcdefghABCDEFGHIJ0123456789\n\nthen test";
    saveWorkspace(workspace({ sessions: [child({ spec })] }));
    const text = readFileSync(fileOf("abcdef"), "utf8");
    for (const gone of ["pw-abcdef-0123456789", "hunter2-abcdef", "MIIEowIBAAKCAQEA7"]) expect(text).not.toContain(gone);
    expect(loadWorkspace("abcdef")!.sessions[0]!.spec).toBe("clone https://ci:••••@git.example.com/org/repo with password=••••\n-----BEGIN RSA PRIVATE KEY-----\n••••\n\nthen test");
  });

  test("BUG-589/pem-in-spec: a private key block in a spec is masked on disk like any other secret (a PEM body is saved as it is, in a 0600 file that lives as long as the workspace)", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    saveWorkspace(workspace({ sessions: [child({ spec: `deploy with this key:\n${pem}\nthen test` })] }));
    expect(readFileSync(fileOf("abcdef"), "utf8")).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU");
  });

  test("BUG-662/QA-resume-10: `gluon sessions` and the picker show the time in the zone the user lives in, or say UTC (it printed `toISOString` as `2026-10-06 23:30` with no label)", () => {
    const at = Date.UTC(2026, 9, 6, 23, 30);
    const line = describeWorkspace(workspace({ updatedAt: at }));
    const local = new Date(at);
    const localText = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
    // Equal when this machine is on UTC: then the label is what is missing.
    expect(line.includes(` ${localText} `) || line.includes("UTC")).toBe(true);
    if (local.getTimezoneOffset() === 0) expect(line).toContain("UTC");
  });

  test("BUG-662/variants: the time is the local one with its offset from UTC (half hours included), and `UTC` alone at offset 0; the day follows the zone", () => {
    const at = Date.UTC(2026, 9, 6, 23, 30);
    // Bun keeps the zone it was last given after `delete process.env.TZ` (and ignores a later assignment of nothing): the zone in use is set back by name, as `test/stats.test.ts` does.
    const was = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const shown = (tz: string) => {
        process.env.TZ = tz;
        return localTime(at);
      };
      expect(shown("America/New_York")).toBe("2026-10-06 19:30 UTC-04:00");
      expect(shown("Asia/Kolkata")).toBe("2026-10-07 05:00 UTC+05:30");
      expect(shown("America/St_Johns")).toBe("2026-10-06 21:00 UTC-02:30");
      expect(shown("UTC")).toBe("2026-10-06 23:30 UTC");
    } finally {
      process.env.TZ = was;
    }
  });
});

describe("BUG-642/resume: a pid reused by another process is not the Gluon", () => {
  const stat = (comm: string, ticks = "123456") => `4242 (${comm}) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 1000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`;
  const enoent = (): never => {
    throw new Error("ENOENT");
  };
  const files = (comm: string, ticks?: string, boot = "boot-1\n") => (path: string) => {
    if (path === "/proc/4242/stat") return stat(comm, ticks);
    if (path === "/proc/sys/kernel/random/boot_id") return boot;
    return enoent();
  };

  test("Linux: the start is the 22nd field of /proc/<pid>/stat with the boot id, whatever the command is called", () => {
    expect(processStart(4242, { platform: "linux", read: files("bun") })).toBe("boot-1:123456");
    // A name with spaces and parentheses must not move the fields.
    expect(processStart(4242, { platform: "linux", read: files("a (b) c d e") })).toBe("boot-1:123456");
    // Another boot, or another start, is another process; without a boot id the ticks alone.
    expect(processStart(4242, { platform: "linux", read: files("bun", "123456", "boot-2\n") })).not.toBe("boot-1:123456");
    expect(processStart(4242, { platform: "linux", read: files("bun", "999") })).not.toBe("boot-1:123456");
    expect(processStart(4242, { platform: "linux", read: (p) => (p.endsWith("/stat") ? stat("bun") : enoent()) })).toBe("123456");
  });

  test("an unreadable, gone or odd /proc entry has no start; macOS has none (no ps is spawned); Windows takes PowerShell's FILETIME and nothing else", () => {
    expect(processStart(4242, { platform: "linux", read: enoent })).toBeUndefined();
    expect(processStart(4242, { platform: "linux", read: () => "garbage" })).toBeUndefined();
    expect(processStart(4242, { platform: "linux", read: files("bun", "12x") })).toBeUndefined();
    expect(processStart(4242, { platform: "darwin", read: enoent, powershell: enoent })).toBeUndefined();
    expect(processStart(4242, { platform: "win32", powershell: () => "133700000000000000" })).toBe("133700000000000000");
    for (const bad of [undefined, "", "Get-Process : Cannot find a process", "12;calc"]) expect(processStart(4242, { platform: "win32", powershell: () => bad })).toBeUndefined();
    expect(processStart(0, { platform: "linux", read: files("bun") })).toBeUndefined();
    expect(processStart(Number.NaN, { platform: "linux", read: files("bun") })).toBeUndefined();
  });

  test("this process has a start on Linux, and it is stable", () => {
    if (process.platform !== "linux") return;
    expect(ownStart()).toMatch(/:\d+$|^\d+$/);
    expect(ownStart()).toBe(processStart(process.pid));
  });

  test("an owner is alive when the pid is and the start is the recorded one; a different start is a different process; where no start is known the pid decides", () => {
    const alive = () => true;
    expect(ownerAlive({ pid: 4242, start: "s1" }, { alive, startOf: () => "s1" })).toBe(true);
    expect(ownerAlive({ pid: 4242, start: "s1" }, { alive, startOf: () => "s2" })).toBe(false);
    expect(ownerAlive({ pid: 4242, start: "s1" }, { alive: () => false, startOf: () => "s1" })).toBe(false);
    // Nothing recorded (an older file, macOS), or nothing readable now: the pid alone, as before.
    expect(ownerAlive({ pid: 4242 }, { alive, startOf: () => "s2" })).toBe(true);
    expect(ownerAlive({ pid: 4242, start: "s1" }, { alive, startOf: () => undefined })).toBe(true);
    expect(ownerAlive({ pid: 4242 }, { alive: () => false })).toBe(false);
  });

  test("the file keeps a start only beside a pid, as plain characters", () => {
    expect(parseWorkspace(raw({ ...workspace(), pid: 7, start: "boot-1:123" }))).toMatchObject({ pid: 7, start: "boot-1:123" });
    for (const start of ["", "a b", "x".repeat(101), 5, null, ["a"], "a;b", "../x"]) expect(parseWorkspace(raw({ ...workspace(), pid: 7, start }))!.start).toBeUndefined();
    expect(parseWorkspace(raw({ ...workspace(), start: "boot-1:123" }))!.start).toBeUndefined();
  });

  test("the recorder writes its own start with its pid, and none when a pid is named for a test (unless it names a start too)", () => {
    const rec = new Recorder("/work/tiny", undefined);
    rec.add({ ...base0, name: "a" });
    expect(loadWorkspace(rec.id!)!.pid).toBe(process.pid);
    expect(loadWorkspace(rec.id!)!.start).toBe(ownStart());
    const named = new Recorder("/work/tiny", undefined, { pid: 4242 });
    named.add({ ...base0, name: "a" });
    expect(loadWorkspace(named.id!)!.start).toBeUndefined();
    const given = new Recorder("/work/tiny", undefined, { pid: 4242, start: "boot-1:9" });
    given.add({ ...base0, name: "a" });
    expect(loadWorkspace(given.id!)!.start).toBe("boot-1:9");
  });

  test("liveOwner: a live process with another start than the file's is nobody's Gluon; the same start is; this process is not another", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      const now = processStart(child.pid);
      expect(liveOwner(workspace({ pid: child.pid }))).toBe(child.pid);
      if (now !== undefined) {
        expect(liveOwner(workspace({ pid: child.pid, start: now }))).toBe(child.pid);
        expect(liveOwner(workspace({ pid: child.pid, start: "0-another-process" }))).toBeUndefined();
      }
    } finally {
      child.kill();
      await child.exited;
    }
    expect(liveOwner(workspace({ pid: process.pid }))).toBeUndefined();
  });
});

describe("BUG-643/resume: the claim on a saved workspace", () => {
  const lockOf = (id: string) => join(workspacesDir(), `${id}.lock`);
  const me = { pid: 111, start: "s-me" };
  const livePids = new Set<number>();
  const alive = (o: { pid: number }) => livePids.has(o.pid);
  beforeEach(() => livePids.clear());

  test("the first claim wins and the second is refused with the first's pid, however many ask", () => {
    livePids.add(111);
    expect(claimWorkspace("abcdef", { owner: me, alive })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(lockOf("abcdef"), "utf8"))).toEqual({ v: 1, pid: 111, start: "s-me" });
    for (const pid of [222, 333]) expect(claimWorkspace("abcdef", { owner: { pid }, alive })).toEqual({ ok: false, pid: 111 });
    expect(JSON.parse(readFileSync(lockOf("abcdef"), "utf8")).pid).toBe(111);
    // Another workspace is another claim.
    expect(claimWorkspace("ghijkl", { owner: { pid: 222 }, alive })).toEqual({ ok: true });
  });

  test("a claim whose owner is gone is taken over, a garbled one too; --force takes a live one", () => {
    livePids.add(222);
    claimWorkspace("abcdef", { owner: { pid: 111 }, alive });
    expect(claimWorkspace("abcdef", { owner: { pid: 222 }, alive })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(lockOf("abcdef"), "utf8")).pid).toBe(222);
    writeFileSync(lockOf("abcdef"), "not json");
    expect(claimWorkspace("abcdef", { owner: { pid: 333 }, alive })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(lockOf("abcdef"), "utf8")).pid).toBe(333);
    livePids.add(333);
    expect(claimWorkspace("abcdef", { owner: { pid: 444 }, alive })).toEqual({ ok: false, pid: 333 });
    expect(claimWorkspace("abcdef", { owner: { pid: 444 }, alive, force: true })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(lockOf("abcdef"), "utf8")).pid).toBe(444);
    // No leftover of the takeover or of the private directory it was written in.
    expect(readdirSync(workspacesDir())).toEqual(["abcdef.lock"]);
  });

  test("the claim file is private, and is made inside a private directory first", () => {
    claimWorkspace("abcdef", { owner: me, alive });
    expect(isPrivate(lockOf("abcdef"), tmpdir())).toBe(true);
  });

  test("an id that is no workspace id makes no file", () => {
    expect(claimWorkspace("../x", { owner: me, alive })).toEqual({ ok: true });
    expect(existsSync(workspacesDir())).toBe(false);
  });

  test("processes that claim at once: exactly one gets it, and each takes its own claim off at exit", async () => {
    mkdirSync(workspacesDir(), { recursive: true });
    const script = `import { claimWorkspace } from ${JSON.stringify(join(import.meta.dir, "../src/workspaces.ts"))}; console.log(JSON.stringify(claimWorkspace("abcdef"))); await Bun.sleep(1500);`;
    const run = () => Bun.spawn([process.execPath, "--no-env-file", `--config=${join(import.meta.dir, "../scripts/empty-bunfig.toml")}`, "-e", script], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GLUON_CONFIG: process.env.GLUON_CONFIG } });
    const procs = [run(), run(), run()];
    const outs = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
    await Promise.all(procs.map((p) => p.exited));
    const results = outs.map((o) => JSON.parse(o) as { ok: boolean });
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(existsSync(lockOf("abcdef"))).toBe(false);
  });

  /** The first line a process prints, read before it exits. */
  async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    reader.releaseLock();
    return text.trim();
  }

  test("BUG-643/variants: processes that take over one stale claim at the same millisecond: exactly one holds it, round after round @full", async () => {
    const ROUNDS = 40;
    const WORKERS = 4;
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const ids = Array.from({ length: ROUNDS }, (_, r) => `aaaa${alphabet[r >> 5]}${alphabet[r & 31]}`);
    mkdirSync(workspacesDir(), { recursive: true });
    // Every claim starts out as one left by a Gluon that is gone.
    for (const id of ids) writeFileSync(lockOf(id), `${JSON.stringify({ v: 1, pid: 99_999_999 })}\n`);
    const t0 = Date.now() + 1500;
    const script = `
      import { claimWorkspace } from ${JSON.stringify(join(import.meta.dir, "../src/workspaces.ts"))};
      const ids = ${JSON.stringify(ids)};
      const out = [];
      for (const [r, id] of ids.entries()) {
        while (Date.now() < ${t0} + r * 40) {}
        out.push(claimWorkspace(id).ok);
      }
      console.log(JSON.stringify(out));
      // Hold the claims until the test has every worker's answer: a worker that exits takes its claims off, and a slower one (on Windows each
      // losing round asks PowerShell for the winner's start) would then win rounds that are over.
      for await (const _ of Bun.stdin.stream()) {}`;
    const run = () => Bun.spawn([process.execPath, "--no-env-file", `--config=${join(import.meta.dir, "../scripts/empty-bunfig.toml")}`, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, GLUON_CONFIG: process.env.GLUON_CONFIG } });
    const procs = Array.from({ length: WORKERS }, run);
    const outs = await Promise.all(procs.map(async (p) => JSON.parse(await firstLine(p.stdout)) as boolean[]));
    for (const p of procs) p.stdin.end(); // every answer is in: the workers exit and take their claims off
    await Promise.all(procs.map((p) => p.exited));
    const winners = ids.map((_, r) => outs.filter((o) => o[r]).length);
    expect(winners).toEqual(ids.map(() => 1));
    // They took their claims off at exit; no takeover file is left.
    expect(readdirSync(workspacesDir())).toEqual([]);
  });

  test("a takeover file left by a crashed process (dead owner, or old) doesn't stop the claim; its sweep is a Gluon file's", () => {
    mkdirSync(workspacesDir(), { recursive: true });
    livePids.add(222);
    writeFileSync(lockOf("abcdef"), `${JSON.stringify({ v: 1, pid: 111 })}\n`);
    writeFileSync(`${lockOf("abcdef")}.takeover`, `${JSON.stringify({ v: 1, pid: 333 })}\n`);
    expect(claimWorkspace("abcdef", { owner: { pid: 222 }, alive })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(lockOf("abcdef"), "utf8")).pid).toBe(222);
    expect(existsSync(`${lockOf("abcdef")}.takeover`)).toBe(false);
  });

  // 200 tries, each a sleep of 10 ms and two private-directory creations (the claim, the takeover file): 2 s on Linux, 9.4 s on a macOS CI runner (BUG-643).
  const SLOW = Number(process.env.GLUON_TEST_SLOW) || (process.platform === "win32" ? 3 : 1);
  test("a garbled claim that can't be taken over names no process", () => {
    // A takeover file held by a live process keeps the garbled claim in place for the whole wait.
    mkdirSync(workspacesDir(), { recursive: true });
    livePids.add(333);
    writeFileSync(lockOf("abcdef"), "not json");
    writeFileSync(`${lockOf("abcdef")}.takeover`, `${JSON.stringify({ v: 1, pid: 333 })}\n`);
    expect(claimWorkspace("abcdef", { owner: { pid: 222 }, alive })).toEqual({ ok: false });
  }, 10_000 * SLOW);

  test("deleting a saved workspace takes its claim along; a claim without a workspace is left to its owner", () => {
    saveWorkspace(workspace());
    claimWorkspace("abcdef", { owner: { pid: 111 }, alive });
    expect(deleteWorkspace("abcdef")).toBe(true);
    expect(existsSync(lockOf("abcdef"))).toBe(false);
    claimWorkspace("ghijkl", { owner: { pid: 111 }, alive });
    expect(deleteWorkspace("ghijkl")).toBe(false);
    expect(existsSync(lockOf("ghijkl"))).toBe(true);
  });

  test("a claim is no saved session: it is not listed, nor read as an unreadable file", () => {
    saveWorkspace(workspace());
    claimWorkspace("abcdef", { owner: { pid: 111 }, alive });
    claimWorkspace("zzzzzz", { owner: { pid: 111 }, alive });
    expect(scanWorkspaces()).toEqual({ saved: [workspace()], unreadable: [] });
  });
});

describe("BUG-644/resume: uninstall refuses while a Gluon is running", () => {
  const sleeper = () => Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdio: ["ignore", "ignore", "ignore"] });

  test("runningGluons names the live pids of workspace files and of claims, once each, and not a dead one or this process", async () => {
    const a = sleeper();
    const b = sleeper();
    try {
      const dead = Bun.spawnSync([process.execPath, "-e", ""]).pid;
      saveWorkspace(workspace({ id: "aaaaaa", pid: a.pid }));
      saveWorkspace(workspace({ id: "bbbbbb", pid: dead }));
      saveWorkspace(workspace({ id: "cccccc", pid: process.pid }));
      writeFileSync(join(workspacesDir(), "dddddd.lock"), JSON.stringify({ v: 1, pid: b.pid }));
      writeFileSync(join(workspacesDir(), "eeeeee.lock"), JSON.stringify({ v: 1, pid: a.pid }));
      writeFileSync(join(workspacesDir(), "ffffff.lock"), "junk");
      writeFileSync(join(workspacesDir(), "notes.txt"), JSON.stringify({ pid: b.pid }));
      expect(runningGluons()).toEqual([a.pid, b.pid].sort((x, y) => x - y));
      // The same pid with another start (a reused one) is no Gluon.
      if (processStart(a.pid) !== undefined) {
        saveWorkspace(workspace({ id: "aaaaaa", pid: a.pid, start: "0-another-process" }));
        rmSync(join(workspacesDir(), "eeeeee.lock"));
        expect(runningGluons()).toEqual([b.pid]);
      }
    } finally {
      a.kill();
      b.kill();
      await Promise.all([a.exited, b.exited]);
    }
    expect(runningGluons(join(TMP, "nowhere"))).toEqual([]);
  });

  test("uninstall refuses naming the pid, exits 1, removes nothing and asks nothing; a claim counts as a saved session file for the sweep", async () => {
    const a = sleeper();
    const logged: string[] = [];
    try {
      saveWorkspace(workspace({ pid: a.pid }));
      writeFileSync(join(workspacesDir(), "abcdef.lock"), JSON.stringify({ v: 1, pid: a.pid }));
      writeFileSync(process.env.GLUON_CONFIG!, "x: 1\n");
      const errors: string[] = [];
      const was = console.error;
      console.error = (m: string) => void errors.push(m);
      try {
        const ask = (): boolean => {
          throw new Error("must not ask");
        };
        expect(uninstall({ yes: false, tty: true, log: (l) => logged.push(l), ask })).toBe(1);
        expect(uninstall({ yes: true, tty: false, log: (l) => logged.push(l), ask })).toBe(1);
      } finally {
        console.error = was;
      }
      const said = `gluon: a Gluon is running (process ${a.pid}); nothing was removed. Quit it, then run gluon uninstall again.`;
      expect(errors).toEqual([said, said]);
      expect(logged).toEqual([]);
      expect([existsSync(fileOf("abcdef")), existsSync(join(workspacesDir(), "abcdef.lock")), existsSync(process.env.GLUON_CONFIG!)]).toEqual([true, true, true]);
    } finally {
      a.kill();
      await a.exited;
    }
    expect(runningGluons()).toEqual([]);
    expect(workspaceFiles().map((f) => basename(f)).sort()).toEqual(["abcdef.json", "abcdef.lock"]);
  });
});
