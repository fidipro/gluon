/** Local analytics (`src/analytics.ts`): one row per launched session in a private SQLite file; recording never breaks anything. */
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics, FLUSH_MS, HEARTBEAT_MS, MIGRATIONS, runStatus, SPEC_MAX, type RunStart, type SessionRow } from "../src/analytics.ts";
import { loadConfig, defaults } from "../src/config.ts";
import { wipe } from "../src/stats.ts";
import { windowsTool } from "../src/detect.ts";
import { isPrivate } from "./e2e/fixtures.ts";

const POSIX = process.platform !== "win32";
const ROOT = mkdtempSync(join(tmpdir(), "gluon-analytics-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
/** A directory of the test's own (never the real state dir) and the db path in a subdirectory Gluon creates. */
const fresh = () => {
  const dir = join(ROOT, `t${++n}`);
  return { dir, path: join(dir, "state", "analytics.db") };
};
const start = (over: Partial<RunStart> = {}): RunStart => ({ kind: "new", name: "Gluon-fix-it", harness: "claude-code", model: "sonnet", spec: "Fix it.", ...over });
const rows = (path: string): SessionRow[] => {
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT * FROM sessions ORDER BY started_at, id").all() as SessionRow[];
  } finally {
    db.close();
  }
};
const mode = (p: string) => statSync(p).mode & 0o777;
/** A clock the test moves. */
const clock = (t = 1_000_000) => {
  const c = { t, now: () => c.t };
  return c;
};

describe("the file", () => {
  test("a first session creates the schema (user_version, the table, WAL) and one row", () => {
    const { path } = fresh();
    const a = new Analytics({ enabled: true, path });
    expect(existsSync(path)).toBe(false);
    expect(a.begin(start())).toBeDefined();
    a.close();
    const db = new Database(path, { readonly: true });
    try {
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
      expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      const cols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(["id", "kind", "spec", "agent_session_id", "updated_at"]));
    } finally {
      db.close();
    }
    expect(rows(path)).toHaveLength(1);
  });

  test.skipIf(!POSIX)("the directory is 0700, the database and its -wal and -shm 0600, however loose the umask", () => {
    const { dir, path } = fresh();
    const old = process.umask(0);
    try {
      const a = new Analytics({ enabled: true, path });
      const run = a.begin(start());
      run?.set({ contextPct: 5 });
      expect(mode(join(dir, "state"))).toBe(0o700);
      expect(mode(path)).toBe(0o600);
      // WAL mode keeps them while a connection is open.
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(mode(`${path}-wal`)).toBe(0o600);
      expect(mode(`${path}-shm`)).toBe(0o600);
      a.close();
    } finally {
      process.umask(old);
    }
  });

  test.skipIf(!POSIX)("a looser file or directory that was already there is made private again", () => {
    const { dir, path } = fresh();
    mkdirSync(join(dir, "state"), { recursive: true, mode: 0o755 });
    chmodSync(join(dir, "state"), 0o755);
    writeFileSync(path, "");
    chmodSync(path, 0o644);
    const a = new Analytics({ enabled: true, path });
    a.begin(start());
    a.close();
    expect(mode(join(dir, "state"))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  });

  // On Windows the mode means nothing: the directory Gluon creates is limited to the user with icacls, and the file and its -wal and -shm
  // (SQLite makes them while a connection is open) must come out limited too. `isPrivate` reads each one's ACL by SID; the home it is
  // given is no parent of the path, so it checks (inside the real profile it would pass anything).
  test.skipIf(POSIX)("Windows: the directory, the database and its -wal and -shm are limited to the user, SYSTEM and Administrators", () => {
    const { dir, path } = fresh();
    const a = new Analytics({ enabled: true, path });
    try {
      a.begin(start())?.set({ contextPct: 5 });
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(existsSync(`${path}-shm`)).toBe(true);
      const elsewhere = "Z:\\nowhere";
      expect([join(dir, "state"), path, `${path}-wal`, `${path}-shm`].map((p) => [p, isPrivate(p, elsewhere)])).toEqual([join(dir, "state"), path, `${path}-wal`, `${path}-shm`].map((p) => [p, true]));
    } finally {
      a.close();
    }
  });

  // The usual case on Windows: the state directory is already there (the price tables and the ledger made it), so `privateTree` leaves it as it is and
  // only the database file is limited (icacls); the -wal and -shm SQLite makes later inherit the directory's ACL, not the file's. Inside the profile that
  // is the profile's own; a directory elsewhere (XDG_STATE_HOME on another drive) may be readable by others, and then the -wal, which holds the spec of
  // the sessions not yet checkpointed, was: the database was private, its journal not. Gluon now limits each of them itself (the variants below run it on any OS).
  (POSIX ? test.skip : test)("BUG-651/QA-win-03: in a state directory that already exists and others can read, the -wal and -shm are as private as the database", () => {
    const { dir, path } = fresh();
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    // Everyone (S-1-1-0) reads what is made in it. A setup that fails returns: the test then passes, which test.failing reports as a failure.
    if (Bun.spawnSync([windowsTool("icacls"), state, "/grant", "*S-1-1-0:(OI)(CI)R"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) return;
    const a = new Analytics({ enabled: true, path });
    try {
      a.begin(start())?.set({ contextPct: 5 });
      expect(existsSync(`${path}-wal`)).toBe(true);
      const elsewhere = "Z:\\nowhere";
      expect(isPrivate(path, elsewhere)).toBe(true);
      expect([`${path}-wal`, isPrivate(`${path}-wal`, elsewhere)]).toEqual([`${path}-wal`, true]);
      expect([`${path}-shm`, isPrivate(`${path}-shm`, elsewhere)]).toEqual([`${path}-shm`, true]);
    } finally {
      a.close();
    }
  });

  // The same fix on any OS, with the ACL call replaced: the database, its -wal and its -shm are each limited once, after they exist and before a row is written.
  test("BUG-651/variants: with restrict on, the database, its -wal and its -shm are each limited once, when they exist and before a row is written", () => {
    const { path } = fresh();
    const calls: { path: string; exists: boolean; rows: number }[] = [];
    const rowCount = (): number => {
      const db = new Database(path, { readonly: true });
      try {
        return (db.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n;
      } catch {
        return 0;
      } finally {
        db.close();
      }
    };
    const a = new Analytics({
      enabled: true,
      path,
      restrict: true,
      restrictFile: (p) => {
        calls.push({ path: p, exists: existsSync(p), rows: existsSync(path) ? rowCount() : 0 });
      },
    });
    a.begin(start())?.set({ contextPct: 5 });
    a.close();
    expect(calls.map((c) => c.path.slice(path.length)).sort()).toEqual(["", "-shm", "-wal"]);
    expect(calls.every((c) => c.exists)).toBe(true);
    expect(calls.every((c) => c.rows === 0)).toBe(true);
  });

  test("BUG-651/variants: with restrict off nothing is limited, and a failing ACL call never stops recording", () => {
    const off = fresh();
    const seen: string[] = [];
    const a = new Analytics({ enabled: true, path: off.path, restrict: false, restrictFile: (p) => seen.push(p) });
    a.begin(start());
    a.close();
    expect(seen).toEqual([]);
    const on = fresh();
    const b = new Analytics({ enabled: true, path: on.path, restrict: true, restrictFile: () => "could not limit it (icacls)" });
    b.begin(start())?.end({ code: 0, reason: "exit" });
    b.close();
    expect(rows(on.path)).toHaveLength(1);
  });

  test("enabled: false never creates a file or a directory", () => {
    const { dir, path } = fresh();
    const a = new Analytics({ enabled: false, path });
    expect(a.begin(start())).toBeUndefined();
    a.tick();
    a.close();
    expect(existsSync(dir)).toBe(false);
  });

  test("nothing is created before the first session", () => {
    const { dir, path } = fresh();
    const a = new Analytics({ enabled: true, path });
    a.tick();
    a.close();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("a session's row", () => {
  test("begin, set and end write the columns: identity, agent, routing, worktree, ids, cost, context, how it ended", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const run = a.begin(
      start({
        kind: "resume",
        childKey: "k1",
        workspaceId: "abcdef",
        cwd: "/work/tiny",
        repo: "owner/tiny",
        branch: "main",
        worktree: { path: "/work/tiny/.gluon/x", branch: "gluon/x" },
        harnessVersion: "2.1.4",
        effort: "high",
        mode: "plan",
        conn: "plan",
        routingTypes: ["feature", "bugfix"],
        routingWhy: ["explore first", "high effort"],
        agentSessionId: "0b1f3c5e-1111-4222-8333-444455556666",
        agentSessionSource: "minted",
        gluonVersion: "1.2.3",
      }),
    );
    run!.set({ cost: { usd: 1.25, approx: true, own: true }, contextPct: 38 });
    c.t += 90_000;
    run!.end({ code: 0, reason: "exit" });
    const [r] = rows(path);
    expect(r).toMatchObject({
      kind: "resume",
      child_key: "k1",
      workspace_id: "abcdef",
      name: "Gluon-fix-it",
      cwd: "/work/tiny",
      repo: "owner/tiny",
      branch: "main",
      worktree_path: "/work/tiny/.gluon/x",
      worktree_branch: "gluon/x",
      harness: "claude-code",
      harness_version: "2.1.4",
      model: "sonnet",
      effort: "high",
      mode: "plan",
      conn: "plan",
      routing_types: '["feature","bugfix"]',
      routing_why: '["explore first","high effort"]',
      spec: "Fix it.",
      agent_session_id: "0b1f3c5e-1111-4222-8333-444455556666",
      agent_session_source: "minted",
      gluon_version: "1.2.3",
      started_at: 1_000_000,
      ended_at: 1_090_000,
      duration_ms: 90_000,
      exit_code: 0,
      end_reason: "exit",
      cost_usd: 1.25,
      cost_approx: 1,
      cost_own: 1,
      cost_billed: 0,
      context_pct: 38,
      updated_at: 1_090_000,
    });
    expect(r!.id).toMatch(/^[0-9a-f-]{36}$/);
    a.close();
  });

  test("a row is there from the start: a session with no figures yet is running, with NULL ends and costs", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    a.begin(start());
    const [r] = rows(path);
    expect(r).toMatchObject({ ended_at: null, duration_ms: null, exit_code: null, end_reason: null, cost_usd: null, cost_approx: null, context_pct: null, started_at: c.t, updated_at: c.t });
    expect(runStatus(r!, c.t + 1)).toBe("running");
    a.close();
  });

  test("every begin is its own row (a restart of the same session is another)", () => {
    const { path } = fresh();
    const a = new Analytics({ enabled: true, path });
    a.begin(start({ childKey: "k" }));
    a.begin(start({ childKey: "k", kind: "restart" }));
    const all = rows(path);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.id)).size).toBe(2);
    a.close();
  });

  test("a cost, a captured session id and the OpenRouter marks go in; context_pct keeps the last real reading", () => {
    const { path } = fresh();
    const a = new Analytics({ enabled: true, path });
    const run = a.begin(start({ conn: "openrouter" }))!;
    run.set({ agentSessionId: "ses_1", agentSessionSource: "captured", cost: { usd: 0.5, approx: false, own: true, billed: true }, contextPct: 20 });
    run.set({ contextPct: undefined });
    run.end({ code: 3, reason: "exit", contextPct: undefined });
    expect(rows(path)[0]).toMatchObject({ agent_session_id: "ses_1", agent_session_source: "captured", cost_usd: 0.5, cost_approx: 0, cost_own: 1, cost_billed: 1, context_pct: 20, exit_code: 3 });
    a.close();
  });

  test("end() with a cost and a context reading sets them, and only the first end counts", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const run = a.begin(start())!;
    run.end({ code: 1, reason: "back", cost: { usd: 2, approx: true, own: false }, contextPct: 61 });
    c.t += 5000;
    run.end({ code: 9, reason: "quit" });
    expect(rows(path)[0]).toMatchObject({ exit_code: 1, end_reason: "back", cost_usd: 2, cost_own: 0, context_pct: 61, ended_at: 1_000_000 });
    a.close();
  });

  test("a set after the end writes through at once (a late cost) and leaves the end as it was", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const run = a.begin(start())!;
    run.end({ code: 0, reason: "exit" });
    c.t += 3000;
    run.set({ cost: { usd: 4.5, approx: false, own: true } });
    expect(rows(path)[0]).toMatchObject({ cost_usd: 4.5, ended_at: 1_000_000, duration_ms: 0, end_reason: "exit", updated_at: 1_003_000 });
    a.close();
  });

  test("a flush is the whole row from memory: the same one twice is the same row, never a second one", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const run = a.begin(start())!;
    run.set({ contextPct: 7 });
    const before = rows(path)[0]!;
    c.t += FLUSH_MS;
    a.tick();
    c.t += FLUSH_MS;
    a.tick();
    const after = rows(path);
    expect(after).toHaveLength(1);
    expect({ ...after[0]!, updated_at: 0 }).toEqual({ ...before, context_pct: 7, updated_at: 0 });
    a.close();
  });

  test("tick: changes wait for FLUSH_MS, and an open row's updated_at is refreshed at least that often (the heartbeat)", () => {
    const { path } = fresh();
    const c = clock(0);
    const a = new Analytics({ enabled: true, path, now: c.now });
    const run = a.begin(start())!;
    run.set({ contextPct: 5 });
    c.t = FLUSH_MS - 1;
    a.tick();
    expect(rows(path)[0]).toMatchObject({ context_pct: null, updated_at: 0 });
    c.t = FLUSH_MS;
    a.tick();
    expect(rows(path)[0]).toMatchObject({ context_pct: 5, updated_at: FLUSH_MS });
    // Nothing changed: only the heartbeat.
    c.t = FLUSH_MS * 2 - 1;
    a.tick();
    expect(rows(path)[0]!.updated_at).toBe(FLUSH_MS);
    c.t = FLUSH_MS * 2;
    a.tick();
    expect(rows(path)[0]!.updated_at).toBe(FLUSH_MS * 2);
    expect(FLUSH_MS * 2).toBeLessThan(HEARTBEAT_MS);
    a.close();
  });

  test("runStatus: ended, running (heartbeat within HEARTBEAT_MS) and unfinished (a crash left it)", () => {
    const { path } = fresh();
    const c = clock(0);
    const a = new Analytics({ enabled: true, path, now: c.now });
    a.begin(start({ name: "open" }));
    a.begin(start({ name: "done" }))!.end({ code: 0, reason: "exit" });
    const byName = (name: string) => rows(path).find((r) => r.name === name)!;
    expect(runStatus(byName("open"), HEARTBEAT_MS - 1)).toBe("running");
    expect(runStatus(byName("open"), HEARTBEAT_MS)).toBe("unfinished");
    expect(runStatus(byName("done"), HEARTBEAT_MS * 100)).toBe("ended");
    a.close();
  });

  test("close() ends the sessions still open as quit, with no exit code, and a later set or begin does nothing", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const open = a.begin(start({ name: "open" }))!;
    a.begin(start({ name: "done" }))!.end({ code: 0, reason: "exit" });
    c.t += 7000;
    a.close();
    const byName = (name: string) => rows(path).find((r) => r.name === name)!;
    expect(byName("open")).toMatchObject({ end_reason: "quit", exit_code: null, ended_at: 1_007_000, duration_ms: 7000 });
    expect(byName("done")).toMatchObject({ end_reason: "exit", exit_code: 0 });
    open.set({ cost: { usd: 9, approx: false, own: true } });
    expect(a.begin(start())).toBeUndefined();
    expect(rows(path)).toHaveLength(2);
    expect(byName("open").cost_usd).toBeNull();
  });
});

describe("what goes in the row", () => {
  const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwx";

  test("keys in the spec, the name, the paths and the routing lines are masked; the key itself is never in the file", () => {
    const { path } = fresh();
    const a = new Analytics({ enabled: true, path });
    const run = a.begin(start({ spec: `Use ${KEY} to call the API`, name: `n-${KEY}`, cwd: `/w/${KEY}`, repo: `r-${KEY}`, routingWhy: [`why ${KEY}`] }))!;
    run.set({ spec: `later ${KEY}` });
    run.end({ code: 0, reason: "exit" });
    a.close();
    const [r] = rows(path);
    expect(r!.spec).toBe("later sk-ant-••••");
    for (const v of [r!.name, r!.cwd, r!.repo, r!.routing_why]) expect(v).not.toContain(KEY);
    expect(r!.name).toBe("n-sk-ant-••••");
    // Not in the main file, nor in the write-ahead log.
    expect(readFileSync(path).includes(KEY)).toBe(false);
    if (existsSync(`${path}-wal`)) expect(readFileSync(`${path}-wal`).includes(KEY)).toBe(false);
  });

  test("a spec is cut at SPEC_MAX (a key that straddles the cut is masked first)", () => {
    const { path } = fresh();
    const a = new Analytics({ enabled: true, path });
    a.begin(start({ spec: `${"x".repeat(SPEC_MAX - 10)}${KEY}${"y".repeat(500)}` }));
    a.begin(start({ name: "short", spec: "x".repeat(SPEC_MAX) }));
    a.close();
    const all = rows(path);
    const long = all.find((r) => r.name !== "short")!;
    expect(long.spec.endsWith("…[truncated]")).toBe(true);
    expect(long.spec.length).toBe(SPEC_MAX + "…[truncated]".length);
    expect(long.spec).not.toContain("sk-ant-api03");
    expect(all.find((r) => r.name === "short")!.spec.length).toBe(SPEC_MAX);
  });
});

describe("recording never breaks anything", () => {
  /** Every method, many times: nothing throws, whatever state the recorder is in. */
  function exercise(a: Analytics): number {
    let runs = 0;
    for (let i = 0; i < 5; i++) {
      const run = a.begin(start());
      if (run) runs++;
      run?.set({ contextPct: 1, cost: { usd: 1, approx: false, own: true } });
      a.tick();
      run?.end({ code: 0, reason: "exit" });
    }
    a.close();
    a.close();
    return runs;
  }

  test("the parent path is a file: no throw, and the recorder switches itself off after three failures in a row", () => {
    const { dir } = fresh();
    mkdirSync(dir, { recursive: true });
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const a = new Analytics({ enabled: true, path: join(blocker, "state", "analytics.db") });
    expect(() => exercise(a)).not.toThrow();
    const b = new Analytics({ enabled: true, path: join(blocker, "state", "analytics.db") });
    for (let i = 0; i < 3; i++) b.begin(start());
    expect(b.begin(start())).toBeUndefined();
    expect(readFileSync(blocker, "utf8")).toBe("x");
  });

  test("a file that is not a database: no throw, left as it was", () => {
    const { path, dir } = fresh();
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(path, "this is not a sqlite file at all, just text".repeat(20));
    const before = readFileSync(path, "utf8");
    expect(() => exercise(new Analytics({ enabled: true, path }))).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  // BUG-650: a symlinked state directory (a dotfiles setup) is followed to the real directory, which gets the usual owner and mode checks (so it records there);
  // before, the directory half of this test asserted nothing was written through it. A symlink at the database file itself is still refused.
  test.skipIf(!POSIX)("a symlinked directory is followed to its checked, private target, and a symlinked file is refused", () => {
    const { dir, path } = fresh();
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    symlinkSync(join(dir, "elsewhere"), join(dir, "state"));
    expect(() => exercise(new Analytics({ enabled: true, path }))).not.toThrow();
    expect(existsSync(join(dir, "elsewhere", "analytics.db"))).toBe(true);
    expect(statSync(join(dir, "elsewhere")).mode & 0o777).toBe(0o700);

    const real = fresh();
    mkdirSync(join(real.dir, "state"), { recursive: true });
    const target = join(real.dir, "target.db");
    writeFileSync(target, "");
    symlinkSync(target, real.path);
    expect(() => exercise(new Analytics({ enabled: true, path: real.path }))).not.toThrow();
    expect(statSync(target).size).toBe(0);
  });

  test.skipIf(!POSIX || process.getuid?.() === 0)("a read-only parent directory: no throw", () => {
    const { dir } = fresh();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      expect(() => exercise(new Analytics({ enabled: true, path: join(dir, "state", "analytics.db") }))).not.toThrow();
      expect(existsSync(join(dir, "state"))).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a write that fails is dropped and the next one heals the row (the table is dropped under it, then back)", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const run = a.begin(start())!;
    const db = new Database(path);
    db.exec("ALTER TABLE sessions RENAME TO gone");
    run.set({ contextPct: 3 });
    c.t += FLUSH_MS;
    expect(() => a.tick()).not.toThrow();
    db.exec("ALTER TABLE gone RENAME TO sessions");
    db.close();
    c.t += FLUSH_MS;
    a.tick();
    expect(rows(path)[0]).toMatchObject({ context_pct: 3, updated_at: c.t });
    a.close();
  });

  test("a file of a newer schema is not written to at all: no row, no change, nothing thrown", () => {
    const { path, dir } = fresh();
    mkdirSync(join(dir, "state"), { recursive: true });
    const db = new Database(path);
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, future TEXT); INSERT INTO sessions VALUES ('x', 'y')");
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    const before = readFileSync(path);
    const a = new Analytics({ enabled: true, path });
    expect(a.begin(start())).toBeUndefined();
    expect(() => exercise(a)).not.toThrow();
    expect(readFileSync(path).equals(before)).toBe(true);
    const check = new Database(path, { readonly: true });
    expect((check.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
    check.close();
  });
});

describe("a write that failed is not the last word", () => {
  /** Another connection holds the write lock (a `gluon stats --delete`, a second Gluon). */
  const lock = (path: string) => {
    const other = new Database(path);
    other.exec("BEGIN IMMEDIATE");
    return () => {
      other.exec("ROLLBACK");
      other.close();
    };
  };

  test("BUG-563/analytics: a session's end that failed while the file was locked is written once the file is free (the row is not unfinished for ever)", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const run = a.begin(start());
    expect(run).toBeDefined();
    const unlock = lock(path);
    c.t += 5_000;
    run!.end({ code: 0, reason: "exit", cost: { usd: 1.5, approx: false, own: true } });
    unlock();
    // The lock is gone: the next flush and the quit are the chances to write the end that was lost.
    c.t += FLUSH_MS;
    a.tick();
    a.close();
    const [row] = rows(path);
    expect(row).toMatchObject({ exit_code: 0, end_reason: "exit", cost_usd: 1.5 });
    expect(row!.ended_at).not.toBeNull();
  });

  test("BUG-563/analytics: an end that failed is also tried at close()", () => {
    const { path } = fresh();
    const a = new Analytics({ enabled: true, path });
    const run = a.begin(start())!;
    const unlock = lock(path);
    run.end({ code: 2, reason: "exit" });
    unlock();
    a.close();
    expect(rows(path)[0]).toMatchObject({ exit_code: 2, end_reason: "exit" });
  });

  /**
   * Whether no connection holds the file any more: another one can leave WAL mode, which takes the only connection.
   * (A -wal and -shm still on disk say nothing on macOS: its system SQLite keeps them, the -wal emptied, after the last close.)
   */
  const free = (path: string): boolean => {
    const other = new Database(path);
    try {
      return (other.query("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }).journal_mode === "delete";
    } catch {
      return false;
    } finally {
      other.close();
    }
  };

  test("BUG-564/analytics: close() really closes the database: no -wal or -shm is left behind by this process, and the file is free", () => {
    const { path } = fresh();
    const a = new Analytics({ enabled: true, path });
    a.begin(start())?.end({ code: 0, reason: "exit" });
    a.close();
    // SQLite removes the -wal and -shm when the last connection closes cleanly (a prepared statement left unfinalized keeps it open: Bun's close() then does nothing).
    if (process.platform !== "darwin") {
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
    }
    expect(free(path)).toBe(true);
  });

  test("BUG-564/analytics: a recorder that switches itself off closes the file too", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const run = a.begin(start())!;
    // The table is gone under it: three failures in a row switch it off.
    const db = new Database(path);
    db.exec("DROP TABLE sessions");
    for (let i = 0; i < 3; i++) {
      c.t += FLUSH_MS;
      a.tick();
    }
    run.set({ contextPct: 1 });
    db.close();
    if (process.platform !== "darwin") expect(existsSync(`${path}-wal`)).toBe(false);
    expect(free(path)).toBe(true);
  });

  // macOS's system SQLite sleeps about twice a busy_timeout in a locked write (200 ms took 422 ms on a runner), and CI is slower than a desk.
  const PATIENCE = (process.platform === "darwin" ? 2 : 1) * (Number(process.env.GLUON_TEST_SLOW) || 1);
  test("BUG-568/analytics: a locked file does not switch recording off, and a blocked write waits well under a second", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const first = a.begin(start({ name: "first" }))!;
    const unlock = lock(path);
    const t0 = performance.now();
    first.set({ contextPct: 7 });
    // The row is begun while the file is locked: its first write fails, and is tried again at the next ticks.
    c.t += 10;
    const second = a.begin(start({ name: "second" }));
    expect(second).toBeDefined();
    for (let i = 0; i < 4; i++) {
      c.t += FLUSH_MS;
      a.tick();
    }
    expect(performance.now() - t0).toBeLessThan(3000 * PATIENCE);
    unlock();
    // Four locked writes in a row (more than MAX_FAILURES) and the recorder still records.
    c.t += FLUSH_MS;
    a.tick();
    expect(rows(path).map((r) => [r.name, r.context_pct])).toEqual([["first", 7], ["second", null]]);
    expect(a.begin(start({ name: "third" }))).toBeDefined();
    a.close();
    expect(rows(path)).toHaveLength(3);
  }, 5000 * PATIENCE);

  test("BUG-565/analytics: a session still running when the history is wiped does not write its row (spec and all) back", () => {
    const { path } = fresh();
    const a = new Analytics({ enabled: true, path });
    const done = a.begin(start({ name: "finished", spec: "FINISHED-PROMPT" }));
    done?.end({ code: 0, reason: "exit" });
    const live = a.begin(start({ name: "live", spec: "LIVE-PROMPT" }));
    expect(wipe(path)).toBe(2);
    // The running session goes on: a context reading, then its end.
    live?.set({ contextPct: 40 });
    live?.end({ code: 0, reason: "exit" });
    a.close();
    expect(rows(path)).toEqual([]);
  });

  test("BUG-565/analytics: a row whose first write failed is still inserted by a later one, and a row wiped after that stays wiped", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    a.begin(start({ name: "opener" }));
    const unlock = lock(path);
    c.t += 10;
    const late = a.begin(start({ name: "late" }))!;
    unlock();
    c.t += FLUSH_MS;
    a.tick();
    expect(rows(path).map((r) => r.name)).toEqual(["opener", "late"]);
    expect(wipe(path)).toBe(2);
    late.set({ contextPct: 5 });
    c.t += FLUSH_MS;
    a.tick();
    a.close();
    expect(rows(path)).toEqual([]);
  });
});

describe("two Gluons at once", () => {
  test("two recorders on one file, their writes interleaved: every session and every figure is there", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    const b = new Analytics({ enabled: true, path, now: c.now });
    const runs: { run: NonNullable<ReturnType<Analytics["begin"]>>; tag: string; i: number }[] = [];
    for (let i = 0; i < 10; i++) {
      for (const [tag, x] of [["a", a], ["b", b]] as const) runs.push({ run: x.begin(start({ name: `${tag}-${i}`, spec: `${tag} ${i}` }))!, tag, i });
      c.t += 1000;
    }
    for (const { run, i } of runs) run.set({ contextPct: i });
    for (const { run, i } of runs.reverse()) run.end({ code: i, reason: "exit" });
    a.close();
    b.close();
    const all = rows(path);
    expect(all).toHaveLength(20);
    for (const r of all) {
      const [tag, i] = r.name.split("-");
      expect(r).toMatchObject({ spec: `${tag} ${i}`, context_pct: Number(i), exit_code: Number(i), end_reason: "exit" });
    }
  });

  test("three Gluon processes writing at once lose nothing @full", async () => {
    const { path } = fresh();
    const writer = join(import.meta.dir, "fixtures/analytics-writer.ts");
    const procs = ["a", "b", "c"].map((tag) => Bun.spawn([process.execPath, "--no-env-file", writer, path, tag, "40"], { stdout: "pipe", stderr: "pipe", env: process.env }));
    const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    expect(results).toEqual([0, 1, 2].map(() => ({ code: 0, err: "" })));
    const all = rows(path);
    expect(all).toHaveLength(120);
    expect(all.every((r) => r.ended_at !== null && r.end_reason === "exit" && r.exit_code === 0)).toBe(true);
    expect(new Set(all.map((r) => r.name)).size).toBe(120);
  });
});

describe("the analytics config key", () => {
  const cfg = join(ROOT, "config.yaml");
  const saved = process.env.GLUON_CONFIG;
  beforeEach(() => {
    process.env.GLUON_CONFIG = cfg;
    rmSync(cfg, { force: true });
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.GLUON_CONFIG;
    else process.env.GLUON_CONFIG = saved;
  });

  test("on by default; on, off, true and false are read; anything else names the key", () => {
    expect(defaults().analytics).toBe(true);
    expect(loadConfig().analytics).toBe(true);
    for (const [yaml, want] of [["analytics: on\n", true], ["analytics: off\n", false], ["analytics: true\n", true], ["analytics: false\n", false], ["analytics:\n", true]] as const) {
      writeFileSync(cfg, yaml);
      expect([yaml, loadConfig().analytics]).toEqual([yaml, want]);
    }
    for (const bad of ["analytics: maybe\n", "analytics: 1\n", "analytics: [on]\n"]) {
      writeFileSync(cfg, bad);
      expect(() => loadConfig()).toThrow("analytics must be on or off");
    }
  });
});

// ---- QA of the recorder (B4) ----

describe("QA analytics: what the spec keeps", () => {
  // The spec is what the user typed or pasted: a repository URL with a token, a private key block or a fine-grained GitHub token is as likely in it as an `sk-` key.
  const SECRETS: Record<string, string> = {
    "a fine-grained GitHub token": "github_pat_11ABCDEFG0abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTU",
    "a password in a URL": "https://deploy:hunter2hunter2hunter2@git.example.com/org/repo.git",
    "a private key block": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7QWERTYUIOPASDFGH\n-----END PRIVATE KEY-----",
    "a Slack token": "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx",
    "a Groq key": "gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
    "a Hugging Face token": "hf_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
    "a GitLab token": "glpat-abcdefghij0123456789",
    "an npm token": "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "a Stripe key": "sk_live_abcdefghijklmnopqrstuvwx",
    "a Perplexity key": "pplx-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
    "a JWT": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "a password= value": "password=hunter2-abcdef-0123456789",
  };
  for (const [what, secret] of Object.entries(SECRETS)) {
    test(`BUG-588/spec-masks: ${what} pasted into a spec is not stored as typed`, () => {
      const { path } = fresh();
      const a = new Analytics({ enabled: true, path });
      a.begin(start({ spec: `Fix the deploy. Here is the thing I used: ${secret} thanks` }));
      a.close();
      const needle = secret.split("\n").at(-2) ?? secret;
      expect(rows(path)[0]!.spec).not.toContain(needle.slice(0, 40));
    });
  }

  test("the documented key shapes are masked in every field, and a 5 MB spec is masked in well under two seconds", () => {
    const { path } = fresh();
    const a = new Analytics({ enabled: true, path });
    const keys = ["sk-ant-api03-abcdefghijklmnop", "sk-or-v1-0123456789abcdef0123456789abcdef", "AIzaSyA-abcdefghijklmnopqrstuvwxyz012345", "AKIAABCDEFGHIJKLMNOP", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "Bearer abcdefghijklmnopqrstuvwxyz", "hf_abcdefghijklmnopqrstuvwxyzABCDEFGH", "https://u:pw-abcdef-0123456789@h", "password=hunter2-abcdef-0123456789"];
    const t0 = performance.now();
    a.begin(start({ spec: `${keys.join(" ")} ${"the quick brown fox ".repeat(250_000)}` }));
    expect(performance.now() - t0).toBeLessThan(2000);
    a.close();
    const spec = rows(path)[0]!.spec;
    for (const k of keys) expect(spec).not.toContain(k.slice(-12));
  });
});

describe("QA analytics: a file that is busy or in an unusual place", () => {
  /** Another connection holds the write lock (a `gluon stats --delete`, a second Gluon). */
  const hold = (path: string) => {
    const other = new Database(path);
    other.exec("BEGIN IMMEDIATE");
    return () => {
      other.exec("ROLLBACK");
      other.close();
    };
  };

  // `tick` runs on the UI's timer (`FILES_POLL_MS`, 5 s): every open session's write waits `BUSY_MS` for the lock on its own, in the UI thread, so N sessions freeze it N x 200 ms
  // per poll for as long as the other connection holds the lock. One busy answer says the file is busy for the rest of that tick.
  test("BUG-649/QA-analytics-02: one tick against a locked file waits for the lock once, not once per open session", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    for (let i = 0; i < 6; i++) a.begin(start({ name: `s${i}` }));
    const unlock = hold(path);
    c.t += FLUSH_MS;
    const t0 = performance.now();
    a.tick();
    const waited = performance.now() - t0;
    unlock();
    a.close();
    expect(waited).toBeLessThan(500);
  });

  (POSIX ? test : test.skip)("BUG-650/QA-analytics-03: a state directory that is a symlink (a dotfiles setup) still records", () => {
    const root = join(ROOT, `link${++n}`);
    mkdirSync(join(root, "real"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "state"));
    const a = new Analytics({ enabled: true, path: join(root, "state", "analytics.db") });
    a.begin(start())?.end({ code: 0, reason: "exit" });
    a.close();
    expect(existsSync(join(root, "real", "analytics.db"))).toBe(true);
  });

  test("BUG-649/variants: a row skipped for a lock is written at the next tick, once the lock is gone", () => {
    const { path } = fresh();
    const c = clock();
    const a = new Analytics({ enabled: true, path, now: c.now });
    for (let i = 0; i < 3; i++) a.begin(start({ name: `s${i}` }))?.set({ contextPct: 7 });
    const unlock = hold(path);
    c.t += FLUSH_MS;
    a.tick();
    unlock();
    a.tick();
    a.close();
    expect(rows(path).map((r) => [r.name, r.context_pct]).sort()).toEqual([["s0", 7], ["s1", 7], ["s2", 7]]);
  });

  test("BUG-650/variants: a link to a directory owned by someone else is still refused, and a loose real target is made private", () => {
    if (!POSIX || process.getuid?.() === 0) return;
    // `/` is root's: the owner check runs on the real directory, so the link is refused and nothing is written there.
    const root = join(ROOT, `link${++n}`);
    mkdirSync(root, { recursive: true });
    symlinkSync("/", join(root, "state"));
    const a = new Analytics({ enabled: true, path: join(root, "state", "analytics.db") });
    a.begin(start())?.end({ code: 0, reason: "exit" });
    a.close();
    expect(existsSync("/analytics.db")).toBe(false);
    // A target of ours that anyone can write is the same as a plain loose directory: made 0700 before the file is made.
    const loose = join(root, "loose");
    mkdirSync(loose);
    chmodSync(loose, 0o777);
    symlinkSync(loose, join(root, "state2"));
    const b = new Analytics({ enabled: true, path: join(root, "state2", "analytics.db") });
    b.begin(start());
    b.close();
    expect(statSync(loose).mode & 0o777).toBe(0o700);
    expect(rows(join(loose, "analytics.db"))).toHaveLength(1);
  });

  test("BUG-650/variants: a link at the database file inside a linked directory is still refused", () => {
    if (!POSIX) return;
    const root = join(ROOT, `link${++n}`);
    mkdirSync(join(root, "real"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "state"));
    const target = join(root, "target.db");
    writeFileSync(target, "");
    symlinkSync(target, join(root, "real", "analytics.db"));
    const a = new Analytics({ enabled: true, path: join(root, "state", "analytics.db") });
    a.begin(start())?.end({ code: 0, reason: "exit" });
    a.close();
    expect(statSync(target).size).toBe(0);
  });

  test("a symlink where the database file should be is never followed", () => {
    if (!POSIX) return;
    const { dir, path } = fresh();
    mkdirSync(join(dir, "state"), { recursive: true });
    const target = join(dir, "elsewhere.db");
    writeFileSync(target, "not ours");
    symlinkSync(target, path);
    const a = new Analytics({ enabled: true, path });
    a.begin(start())?.end({ code: 0, reason: "exit" });
    a.close();
    expect(readFileSync(target, "utf8")).toBe("not ours");
  });
});
