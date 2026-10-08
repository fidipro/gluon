/** `gluon stats` (src/stats.ts): the query side of the local analytics. Offline: a temp database seeded with the schema contract, a pinned time zone and an injected clock. */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLUON, SLOW, SYSTEM_ENV } from "./e2e/harness.ts";
import { WIN } from "./e2e/fixtures.ts";
import { uninstallTargets } from "../src/uninstall.ts";
import { HEARTBEAT_MS, MIGRATIONS, runStatus, type SessionRow } from "../src/analytics.ts";
import { SQL_CHILD_ENV, SQL_CHILD_MEMORY_ENV, SQL_MEMORY_MARK } from "../src/stats-sql.ts";
import { detailJson, durationLabel, findSession, formatTable, newestSessions, openStats, parseWhen, queryJson, runQuery, selectSessions, sqlProblem, StatsError, statsCommand, summarize, wipe } from "../src/stats.ts";

// UTC+12/+13: a day boundary far from UTC, so a UTC-day bug shows. Pinned for this file's tests only: Bun loads every test file of
// a process before running any, so a zone left set at load leaked into other files' tests (a name made from Date.UTC, in
// test/workspaces.test.ts, failed whenever the two shared a process).
// (Bun keeps the zone it was last given after `delete process.env.TZ`: the zone in use is set back by name.)
const WAS_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const pinTz = () => void (process.env.TZ = "Pacific/Auckland");
const unpinTz = () => void (process.env.TZ = WAS_ZONE);
pinTz(); // for what this file makes while it loads (NOW, the seeds): its body is synchronous, so the microtask runs after it
queueMicrotask(unpinTz);
beforeEach(pinTz);
afterEach(unpinTz);

const dir = mkdtempSync(join(tmpdir(), "gluon-stats-"));
// Windows: a just-closed SQLite file (its -wal) may be held a moment longer; the run's temp root is removed at exit (test/preload.ts).
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    if (process.platform !== "win32" || (e as NodeJS.ErrnoException).code !== "EBUSY") throw e;
  }
});
let n = 0;
const fresh = () => join(dir, `a${++n}.db`);

const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = local(2026, 3, 10);

function row(over: Partial<SessionRow>): SessionRow {
  return {
    id: "00000000-0000-4000-8000-000000000000", kind: "new", child_key: null, workspace_id: null, name: "a session", cwd: "/home/u/proj", repo: "proj", branch: null, worktree_path: null,
    worktree_branch: null, harness: "claude-code", harness_version: null, model: "sonnet", effort: "high", mode: "build", conn: null, routing_types: null, routing_why: null,
    spec: "do the thing", agent_session_id: null, agent_session_source: null, gluon_version: "1.0.0", started_at: NOW - 3_600_000, ended_at: NOW - 1_800_000, duration_ms: 1_800_000,
    exit_code: 0, end_reason: "exit", cost_usd: 1, cost_approx: 0, cost_own: 1, cost_billed: 0, context_pct: 10, updated_at: NOW - 1_800_000, ...over,
  };
}

function seed(path: string, rows: Partial<SessionRow>[], version = MIGRATIONS.length): void {
  const db = new Database(path, { create: true });
  for (const m of MIGRATIONS) db.exec(m);
  db.run(`PRAGMA user_version=${version}`);
  for (const [i, r] of rows.entries()) {
    const full = row({ id: `${String(i + 1).padStart(8, "0")}-aaaa-4000-8000-000000000000`, ...r }) as unknown as Record<string, unknown>;
    const cols = Object.keys(full);
    db.run(`INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => full[c] as string | number | null));
  }
  db.close();
}

/** A set of sessions across agents, models, days and repositories. */
const SET: Partial<SessionRow>[] = [
  { harness: "claude-code", model: "sonnet", repo: "alpha", started_at: local(2026, 3, 8, 9), ended_at: local(2026, 3, 8, 10), duration_ms: 3_600_000, cost_usd: 2, name: "one" },
  { harness: "claude-code", model: "opus", repo: "alpha", started_at: local(2026, 3, 8, 23, 30), ended_at: local(2026, 3, 9, 0, 30), duration_ms: 3_600_000, cost_usd: 3, cost_approx: 1, name: "two" },
  { harness: "codex", model: "gpt-6-luna", repo: "Beta", cwd: "/x/Beta", started_at: local(2026, 3, 9, 15), ended_at: local(2026, 3, 9, 15, 10), duration_ms: 600_000, cost_usd: 0.5, name: "three" },
  { harness: "codex", model: "gpt-6-luna", repo: null, cwd: "/y/loose", started_at: local(2026, 3, 10, 8), ended_at: null, duration_ms: null, cost_usd: null, updated_at: local(2026, 3, 10, 8, 20), name: "four" },
];

async function stats(path: string, argv: string[], extra: { now?: number; tty?: boolean; ask?: (q: string) => boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  // In this process: the child that runs a query is tried below (`gluonStats`), through the real command.
  const sql = async (p: string, q: string) => {
    const db = openStats(p)!;
    try {
      return runQuery(db, q);
    } finally {
      db.close();
    }
  };
  const code = await statsCommand(argv, { path, now: NOW, log: (t) => out.push(t), error: (t) => err.push(t), tty: false, sql, ...extra });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("when and how long", () => {
  test("parseWhen: a day is local midnight (the end of that day for until), a span counts back from now, an ISO datetime is taken as is", () => {
    expect(parseWhen("2026-03-09", NOW, "since")).toBe(local(2026, 3, 9, 0));
    expect(parseWhen("2026-03-09", NOW, "until")).toBe(local(2026, 3, 10, 0) - 1);
    expect(parseWhen("7d", NOW, "since")).toBe(NOW - 7 * 86_400_000);
    expect(parseWhen("24h", NOW, "since")).toBe(NOW - 86_400_000);
    expect(parseWhen("2w", NOW, "until")).toBe(NOW - 14 * 86_400_000);
    expect(parseWhen("30m", NOW, "since")).toBe(NOW - 1_800_000);
    expect(parseWhen("2026-03-09T14:30:00Z", NOW, "since")).toBe(Date.UTC(2026, 2, 9, 14, 30));
    for (const bad of ["yesterday", "2026-02-30", "7", "d7", "2026-13-01", ""]) expect(() => parseWhen(bad, NOW, "since")).toThrow(/--since/);
  });

  test("BUG-566/analytics: a date and time of a day that does not exist (2026-02-30T10:00) is refused like the date alone, not moved to 2 March", () => {
    for (const edge of ["since", "until"] as const) {
      expect(() => parseWhen("2026-02-30", NOW, edge)).toThrow(StatsError);
      for (const text of ["2026-02-30T10:00", "2026-02-31 10:00", "2026-04-31T08:15", "2026-13-01T10:00"]) expect(() => parseWhen(text, NOW, edge)).toThrow(StatsError);
    }
    expect(parseWhen("2026-02-28T10:00", NOW, "since")).toBe(local(2026, 2, 28, 10));
  });

  test("durationLabel", () => {
    expect([null, 0, 45_000, 303_000, 3_900_000, 90 * 3_600_000].map(durationLabel)).toEqual(["—", "0s", "45s", "5m03s", "1h05m", "3d18h"]);
  });
});

describe("summary", () => {
  const path = fresh();
  seed(path, SET);
  const db = openStats(path)!;
  afterAll(() => db.close());
  const sum = (by: "agent" | "model" | "day" | "repo", f = {}) => summarize(selectSessions(db, f), by, NOW);

  test("by agent: sessions, time (an unfinished row counts to its last heartbeat), cost (approx flagged) and unfinished", () => {
    const { groups, total } = sum("agent");
    expect(groups.map((g) => [g.key, g.sessions, g.duration_ms, g.cost_usd, g.cost_approx_usd, g.unfinished])).toEqual([
      ["claude-code", 2, 7_200_000, 5, 3, 0],
      ["codex", 2, 600_000 + 1_200_000, 0.5, null, 1],
    ]);
    expect([total.sessions, total.duration_ms, total.cost_usd, total.unfinished]).toEqual([4, 9_000_000, 5.5, 1]);
  });

  test("by model, repo (repo, else the directory) and day (local days, newest first)", () => {
    expect(sum("model").groups.map((g) => [g.key, g.sessions])).toEqual([["gpt-6-luna", 2], ["opus", 1], ["sonnet", 1]]);
    expect(sum("repo").groups.map((g) => g.key)).toEqual(["alpha", "/y/loose", "Beta"]);
    // 23:30 local on the 8th is the 8th, though it is the 8th-11th in UTC.
    expect(sum("day").groups.map((g) => [g.key, g.sessions])).toEqual([["2026-03-10", 1], ["2026-03-09", 1], ["2026-03-08", 2]]);
  });

  test("filters: since, until, agent, repo (any case, repo or directory), and together", () => {
    const keys = (f: object) => selectSessions(db, f).map((r) => r.name);
    expect(keys({ since: local(2026, 3, 9, 0) })).toEqual(["three", "four"]);
    expect(keys({ until: local(2026, 3, 9, 0) })).toEqual(["one", "two"]);
    expect(keys({ agent: "codex" })).toEqual(["three", "four"]);
    expect(keys({ repo: "BETA" })).toEqual(["three"]);
    expect(keys({ repo: "loose" })).toEqual(["four"]);
    expect(keys({ repo: "alp", agent: "claude-code", since: local(2026, 3, 8, 12) })).toEqual(["two"]);
  });

  test("the text output has a header, a row per group and a total; a cost with an estimate in it is marked ~", async () => {
    const r = await stats(path, []);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toMatch(/^agent\s+sessions\s+time\s+cost\s+unfinished$/);
    expect(lines[1]).toMatch(/^claude-code\s+2\s+2h00m\s+~\$5\.00\s+—$/);
    expect(lines[2]).toMatch(/^codex\s+2\s+30m00s\s+\$0\.50\s+1$/);
    expect(lines[3]).toMatch(/^total\s+4\s+2h30m\s+~\$5\.50\s+1$/);
  });

  test("--limit cuts the groups and says so; the total stays whole", async () => {
    const r = await stats(path, ["--by", "day", "--limit", "1"]);
    expect(r.out).toContain("2026-03-10");
    expect(r.out).not.toContain("2026-03-09");
    expect(r.out).toMatch(/total\s+4/);
    expect(r.out).toContain("(2 more days: --limit)");
  });

  test("--json: groups with sessions, duration_ms, cost_usd, cost_approx_usd, unfinished, and the total", async () => {
    const r = await stats(path, ["--json", "--by", "model", "--agent", "claude-code"]);
    const j = JSON.parse(r.out);
    expect(j.by).toBe("model");
    expect(j.groups).toEqual([
      { key: "opus", sessions: 1, duration_ms: 3_600_000, cost_usd: 3, cost_approx_usd: 3, unfinished: 0 },
      { key: "sonnet", sessions: 1, duration_ms: 3_600_000, cost_usd: 2, cost_approx_usd: null, unfinished: 0 },
    ]);
    expect(j.total.sessions).toBe(2);
  });

  test("a filter that matches nothing says so", async () => {
    expect((await stats(path, ["--repo", "zzz"])).out).toBe("No recorded session matches.");
  });
});

describe("sessions and one session", () => {
  const path = fresh();
  seed(path, [
    ...SET,
    { id: "abcd1234-0000-4000-8000-000000000001", name: "p1", agent_session_id: "agent-xyz", spec: "line one\n  indented \x1b[31mred\x1b[0m\n\nlast", routing_types: '["feature","fix"]', routing_why: '["strong model","small repo"]', started_at: local(2026, 3, 1) },
    { id: "abcd5678-0000-4000-8000-000000000002", name: "p2", started_at: local(2026, 3, 2) },
  ]);

  test("newest first, limited, with the status of each row from the injected clock", async () => {
    const r = await stats(path, ["sessions", "--limit", "3"]);
    const lines = r.out.split("\n");
    expect(lines[0]).toMatch(/^id\s+started\s+time\s+agent\s+cost\s+status\s+repo\s+name$/);
    expect(lines.slice(1, 4).map((l) => l.split(/\s+/).at(-1))).toEqual(["four", "three", "two"]);
    expect(lines[1]).toContain("unfinished"); // updated_at is 4 h before NOW, no end
    expect(lines[1]).toContain("codex/gpt-6-luna/high/build");
    expect(lines[1]).toContain("2026-03-10 08:00");
    expect(lines[2]).toContain("ended");
    expect(lines.at(-1)).toBe("(3 older: --limit)");
  });

  test("status: running while the heartbeat is fresh, unfinished past it, ended with an end", () => {
    const p = fresh();
    seed(p, [
      { name: "live", ended_at: null, duration_ms: null, updated_at: NOW - HEARTBEAT_MS + 1 },
      { name: "dead", ended_at: null, duration_ms: null, updated_at: NOW - HEARTBEAT_MS },
      { name: "done" },
    ]);
    const db = openStats(p)!;
    const rows = selectSessions(db, {});
    db.close();
    expect(Object.fromEntries(rows.map((r) => [r.name, detailJson(r, NOW).status]))).toEqual({ live: "running", dead: "unfinished", done: "ended" });
  });

  test("an id prefix of 4+ characters, an exact id, or the agent's session id finds it; an ambiguous prefix lists the candidates (exit 1)", async () => {
    const full = await stats(path, ["abcd1"]);
    expect(full.code).toBe(0);
    expect(full.out).toContain("id:            abcd1234-0000-4000-8000-000000000001");
    expect(full.out).toContain("routing types: feature, fix");
    expect(full.out).toContain("routing why:\n  - strong model\n  - small repo");
    // The spec, indented, with the escape sequence gone and the blank line kept.
    expect(full.out).toContain("spec:\n    line one\n      indented red\n\n    last");
    expect((await stats(path, ["agent-xyz"])).out).toContain("name:          p1");
    expect((await stats(path, ["abcd1234-0000-4000-8000-000000000001"])).code).toBe(0);
    const many = await stats(path, ["abcd"]);
    expect([many.code, many.out]).toEqual([1, ""]);
    expect(many.err).toContain("matches 2 sessions");
    expect(many.err).toContain("abcd5678-0000-4000-8000-000000000002");
    for (const none of ["abc", "ffff"]) {
      const r = await stats(path, [none]);
      expect([none, r.code, r.err]).toEqual([none, 1, expect.stringContaining("no recorded session")]);
    }
  });

  test("findSession: a prefix under 4 characters finds nothing unless it is an exact id", () => {
    const db = openStats(path)!;
    expect(findSession(db, "abc")).toEqual({ none: true });
    expect("row" in findSession(db, "abcd1")).toBe(true);
    db.close();
  });

  test("--json of one session: the JSON columns parsed, and a status", async () => {
    const j = JSON.parse((await stats(path, ["abcd1", "--json"])).out);
    expect([j.routing_types, j.routing_why, j.status, j.spec.startsWith("line one")]).toEqual([["feature", "fix"], ["strong model", "small repo"], "ended", true]);
  });

  test("BUG-571/analytics: an agent session id shared by several rows (a resumed session) lists them, not 'use more of the id'", async () => {
    const p = fresh();
    const SHARED = "11111111-2222-4333-8444-555566667777";
    seed(p, [
      { id: "aaaa1111-0000-4000-8000-000000000001", name: "first run", agent_session_id: SHARED, started_at: local(2026, 3, 1) },
      { id: "bbbb2222-0000-4000-8000-000000000002", name: "resumed", kind: "resume", agent_session_id: SHARED, started_at: local(2026, 3, 2) },
      { id: "cccc3333-0000-4000-8000-000000000003", name: "other", agent_session_id: "other-agent-id", started_at: local(2026, 3, 3) },
    ]);
    const r = await stats(p, [SHARED]);
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(r.err).toContain(`2 sessions share agent session id ${SHARED} (a resumed session); use one of these ids:`);
    expect(r.err).not.toContain("more of the id");
    expect(r.err).toContain("bbbb2222-0000-4000-8000-000000000002");
    expect(r.err).toContain("aaaa1111-0000-4000-8000-000000000001");
    expect(r.err).not.toContain("cccc3333");
    // Each row's own id still opens it, and an id prefix shared by two rows is still the ambiguous prefix.
    expect((await stats(p, ["bbbb2222-0000-4000-8000-000000000002"])).out).toContain("name:          resumed");
    const db = openStats(p)!;
    expect("shared" in findSession(db, SHARED)).toBe(true);
    db.close();
  });

  test("--json of the list: rows with status, newest first", async () => {
    const j = JSON.parse((await stats(path, ["sessions", "--json", "--limit", "2"])).out);
    expect(j.map((r: SessionRow & { status: string }) => [r.name, r.status])).toEqual([["four", "unfinished"], ["three", "ended"]]);
  });
});

describe("what the summary and the list read", () => {
  const path = fresh();
  seed(path, [...SET, { name: "big", spec: "S".repeat(100_000), started_at: local(2026, 3, 11) }]);

  test("BUG-570/analytics: the summary and the list read no spec (up to 100 KB a row); the list's limit is applied in SQL", async () => {
    const db = openStats(path)!;
    try {
      expect(selectSessions(db, {}).every((r) => !("spec" in r))).toBe(true);
      const { rows, total } = newestSessions(db, {}, 2);
      expect([rows.map((r) => r.name), total, rows.some((r) => "spec" in r)]).toEqual([["big", "four"], 5, false]);
      // A filter on the repository is matched in code but gives the same answer.
      const repoRows = newestSessions(db, { repo: "alpha" }, 1);
      expect([repoRows.rows.map((r) => r.name), repoRows.total]).toEqual([["two"], 2]);
      expect(newestSessions(db, { agent: "codex", since: local(2026, 3, 10, 0) }, 5).total).toBe(1);
      // One session in full still has its spec.
      const found = findSession(db, "00000005-aaaa");
      expect("row" in found && found.row.spec.length).toBe(100_000);
    } finally {
      db.close();
    }
    const list = JSON.parse((await stats(path, ["sessions", "--json", "--limit", "2"])).out);
    expect(list.map((r: Record<string, unknown>) => [r.name, "spec" in r, r.status])).toEqual([["big", false, "ended"], ["four", false, "unfinished"]]);
    const text = await stats(path, ["sessions", "--limit", "2"]);
    expect(text.out.split("\n").at(-1)).toBe("(3 older: --limit)");
    expect((await stats(path, [])).out).toMatch(/total\s+5/);
  });
});

describe("sql", () => {
  const path = fresh();
  seed(path, SET);

  test("sqlProblem: SELECT, WITH, EXPLAIN and VALUES alone; one statement; quotes and comments don't count", () => {
    for (const ok of ["SELECT 1", "select 1;", " /* c */ SELECT 1 -- x", "WITH a AS (SELECT 1) SELECT * FROM a", "EXPLAIN SELECT 1", "VALUES (1)", "SELECT ';' AS s", 'SELECT "a;b"', "SELECT 1; /* tail */ ;", "SELECT 'it''s; fine'"]) expect([ok, sqlProblem(ok)]).toEqual([ok, null]);
    for (const bad of ["INSERT INTO sessions VALUES (1)", "ATTACH ':memory:' AS m", "VACUUM", "PRAGMA user_version=5", "DELETE FROM sessions", "SELECT 1; DROP TABLE sessions", "SELECT 1; SELECT 2", "SELECT 1;\nDELETE FROM sessions", "(SELECT 1)", "", "   ", "-- SELECT 1", "CREATE TABLE x(a)", "REPLACE INTO sessions SELECT 1"]) expect([bad, typeof sqlProblem(bad)]).toEqual([bad, "string"]);
  });

  test("a query runs: a table of aligned columns, --json an array of objects", async () => {
    const t = await stats(path, ["sql", "SELECT harness, count(*) AS n FROM sessions GROUP BY harness ORDER BY harness"]);
    expect(t.code).toBe(0);
    expect(t.out.split("\n")).toEqual(["harness      n", "claude-code  2", "codex        2", "(2 rows)"]);
    // The remaining arguments are joined.
    const j = await stats(path, ["sql", "SELECT", "count(*)", "AS", "n", "FROM", "sessions", "--json"]);
    expect(JSON.parse(j.out)).toEqual([{ n: 4 }]);
    expect(JSON.parse((await stats(path, ["sql", "WITH x AS (SELECT 1 AS a) SELECT a FROM x", "--json"])).out)).toEqual([{ a: 1 }]);
  });

  test("refused statements exit 2 and change nothing; a bad query exits 1", async () => {
    for (const q of ["INSERT INTO sessions (id) VALUES ('x')", "ATTACH 'x.db' AS m", "VACUUM", "PRAGMA user_version=9", "SELECT 1; DROP TABLE sessions", "SELECT 1; DELETE FROM sessions"]) {
      const r = await stats(path, ["sql", q]);
      expect([q, r.code, r.err.startsWith("gluon: ")]).toEqual([q, 2, true]);
    }
    expect(existsSync(join(dir, "x.db"))).toBe(false);
    const bad = await stats(path, ["sql", "SELECT nope FROM sessions"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("no such column");
    const db = openStats(path)!;
    expect((db.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(4);
    db.close();
  });

  test("even with the guard bypassed, the handle itself cannot write", () => {
    const db = openStats(path)!;
    for (const q of ["DELETE FROM sessions", "INSERT INTO sessions (id) VALUES ('x')", "DROP TABLE sessions", "UPDATE sessions SET name='x'", "CREATE TABLE y(a)", "PRAGMA user_version=7"]) {
      let wrote = true;
      try {
        db.run(q);
      } catch {
        wrote = false;
      }
      expect([q, wrote]).toEqual([q, false]);
    }
    db.close();
    const check = new Database(path, { readonly: true });
    expect((check.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(4);
    expect((check.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    check.close();
  });

  test("runQuery/queryJson: a NULL prints as NULL; duplicate column names don't collapse the table", () => {
    const db = openStats(path)!;
    const r = runQuery(db, "SELECT 1, 1, NULL");
    db.close();
    expect(r.values).toEqual([[1, 1, null]]);
    expect(formatTable(["a", "b"], [["x", "yy"]])).toEqual(["a  b", "x  yy"]);
    expect(queryJson({ columns: ["a"], values: [[null]] })).toEqual([{ a: null }]);
  });
});

describe("delete, a missing database, bad arguments", () => {
  test("--delete without --yes: refused without a terminal; on one, a 'no' deletes nothing", async () => {
    const path = fresh();
    seed(path, SET);
    const refused = await stats(path, ["--delete"]);
    expect([refused.code, refused.err]).toEqual([2, expect.stringContaining("needs a terminal to ask first; to delete without asking: gluon stats --delete --yes")]);
    const no = await stats(path, ["--delete"], { tty: true, ask: () => false });
    expect([no.code, no.out]).toEqual([0, "Nothing deleted."]);
    expect(wipe(path)).toBe(4);
  });

  test("--delete: asks with the count; --yes wipes through a write connection and never removes the file", async () => {
    const path = fresh();
    seed(path, SET);
    const asked: string[] = [];
    const yes = await stats(path, ["--delete"], { tty: true, ask: (q) => (asked.push(q), true) });
    expect([yes.code, yes.out, asked.length]).toEqual([0, "Deleted 4 recorded sessions.", 1]);
    expect(asked[0]).toContain("Delete all 4 recorded sessions");
    expect(existsSync(path)).toBe(true);
    const db = new Database(path, { readonly: true });
    expect((db.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    db.close();
    const again = await stats(path, ["--delete", "--yes"]);
    expect([again.code, again.out]).toEqual([0, "Deleted 0 recorded sessions."]);
    expect((await stats(path, [])).out).toBe("No analytics recorded yet.");
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  test("a missing database: 'No analytics recorded yet.', exit 0, and the file is not created", async () => {
    const path = join(dir, "never.db");
    for (const argv of [[], ["sessions"], ["sql", "SELECT 1"], ["--delete", "--yes"], ["abcd1234"]]) {
      const r = await stats(path, argv);
      expect([argv.join(" "), r.code, r.out]).toEqual([argv.join(" "), 0, "No analytics recorded yet."]);
    }
    expect(JSON.parse((await stats(path, ["sessions", "--json"])).out)).toEqual([]);
    expect(JSON.parse((await stats(path, ["--json"])).out).groups).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  test("a database of a newer Gluon (user_version above ours) is still read", async () => {
    const path = fresh();
    seed(path, SET, MIGRATIONS.length + 3);
    expect((await stats(path, [])).out).toMatch(/total\s+4/);
  });

  test("a file that is no database: exit 1 with the path; one without the table: nothing recorded", async () => {
    const junk = join(dir, "junk.db");
    await Bun.write(junk, "this is not sqlite, not at all, not even close, nope nope nope".repeat(10));
    const r = await stats(junk, []);
    expect([r.code, r.err]).toEqual([1, expect.stringContaining(`couldn't read ${junk}`)]);
    const empty = fresh();
    new Database(empty, { create: true }).close();
    expect((await stats(empty, [])).out).toBe("No analytics recorded yet.");
  });

  test("bad arguments: `gluon: <message>` on stderr, exit 2, nothing on stdout", async () => {
    const path = fresh();
    seed(path, SET);
    const bads = [
      ["--nope"], ["--by", "week"], ["--agent", "vim"], ["--since", "soon"], ["--until", "2026-02-30"], ["--limit", "0"], ["--limit", "x"], ["--yes"], ["--delete", "--json"], ["--delete", "abcd"],
      ["sql"], ["sessions", "--by", "day"], ["abcd1234", "--agent", "codex"], ["sql", "SELECT 1", "--limit", "3"], ["sessions", "extra"], ["--since"],
    ];
    for (const argv of bads) {
      const r = await stats(path, argv);
      expect([argv.join(" "), r.code, r.out, r.err.startsWith("gluon: ")]).toEqual([argv.join(" "), 2, "", true]);
    }
  });

  test("--help prints the help (exit 0)", async () => {
    const r = await stats(fresh(), ["--help"]);
    expect([r.code, r.out.startsWith("gluon stats [options]")]).toEqual([0, true]);
  });

  test("text from the database is printed without control characters", async () => {
    const path = fresh();
    seed(path, [{ name: "evil\x1b]0;title\x07name\x1b[2J", repo: "re\x07po" }]);
    const r = await stats(path, ["sessions"]);
    expect(r.out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
    expect(r.out).toContain("evil name");
  });
});

describe("uninstall", () => {
  test("uninstallTargets names analytics.db and its -wal and -shm when they exist, and not before", () => {
    const state = mkdtempSync(join(tmpdir(), "gluon-stats-un-"));
    const was = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    try {
      const names = ["analytics.db", "analytics.db-wal", "analytics.db-shm"].map((f) => join(state, "gluon", f));
      const targets = () => uninstallTargets(join(state, "no-tmp"));
      for (const f of names) expect(targets()).not.toContain(f);
      mkdirSync(join(state, "gluon"), { recursive: true });
      writeFileSync(names[0]!, "");
      expect(targets()).toContain(names[0]!);
      expect(targets()).not.toContain(names[1]!);
      writeFileSync(names[1]!, "");
      writeFileSync(names[2]!, "");
      for (const f of names) expect(targets()).toContain(f);
    } finally {
      if (was === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = was;
      rmSync(state, { recursive: true, force: true });
    }
  });
});

// ---- QA of `gluon stats` (B4) ----

describe("QA analytics: sql cannot write or reach outside the file", () => {
  test("ATTACH, writable_schema, VACUUM INTO, load_extension, a CTE with INSERT or DELETE, and statements after a semicolon change nothing and write no file", async () => {
    const path = fresh();
    seed(path, SET);
    const out = join(dir, `qa-out-${n}`);
    mkdirSync(out);
    const before = new Uint8Array(await Bun.file(path).arrayBuffer());
    const queries = [
      `ATTACH DATABASE '${out}/x.db' AS x`,
      `SELECT 1; ATTACH DATABASE '${out}/y.db' AS y`,
      "PRAGMA writable_schema=1",
      `VACUUM INTO '${out}/v.db'`,
      "SELECT load_extension('/lib/x86_64-linux-gnu/libc.so.6')",
      "WITH t AS (SELECT 1) INSERT INTO sessions(id) SELECT 'z' FROM t",
      "WITH t AS (SELECT 1) DELETE FROM sessions",
      "WITH t AS (SELECT 1) UPDATE sessions SET name = 'x'",
      `SELECT writefile('${out}/w', 'x')`,
      `SELECT readfile('${join(import.meta.dir, "../package.json")}')`,
      "SELECT 1 /* ; */ ; DROP TABLE sessions",
      "SELECT 1\n;\nDELETE FROM sessions",
      "SELECT 1; DELETE FROM sessions",
      "EXPLAIN DELETE FROM sessions",
    ];
    for (const q of queries) {
      const r = await stats(path, ["sql", q]);
      // Refused (2), a SQLite error (1) or an EXPLAIN that only describes (0): never a write.
      expect([q, [0, 1, 2].includes(r.code)]).toEqual([q, true]);
    }
    expect(readdirSync(out)).toEqual([]);
    const db = new Database(path, { readonly: true });
    expect((db.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(4);
    expect((db.query("PRAGMA writable_schema").get() as { writable_schema: number }).writable_schema).toBe(0);
    db.close();
    // Reading the file through `gluon stats` leaves its main file as it was (a read-only handle writes no page).
    expect(Buffer.compare(Buffer.from(before), Buffer.from(await Bun.file(path).arrayBuffer()))).toBe(0);
  });
});

describe("QA analytics: times and zones", () => {
  test("a day is the local day in a zone with a 23-hour and a 25-hour day, and in one with a half-hour offset", () => {
    for (const [zone, day, hours] of [["America/New_York", [2026, 3, 8], 23], ["America/New_York", [2026, 11, 1], 25], ["Asia/Kolkata", [2026, 6, 15], 24], ["Pacific/Chatham", [2026, 4, 5], 25]] as const) {
      process.env.TZ = zone;
      const [y, m, d] = day;
      const text = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const since = parseWhen(text, NOW, "since");
      const until = parseWhen(text, NOW, "until");
      expect([zone, since, until - since + 1]).toEqual([zone, new Date(y, m - 1, d).getTime(), hours * 3_600_000]);
      // Every hour of that day is inside it, and the hour after its end is not.
      for (let h = 0; h < hours; h++) {
        const t = since + h * 3_600_000;
        expect([zone, h, t >= since && t <= until]).toEqual([zone, h, true]);
      }
      expect(until + 1 > until).toBe(true);
    }
  });

  test("an end that is exactly one heartbeat old is unfinished, one millisecond younger is running", () => {
    const r = { ended_at: null, updated_at: 1_000_000 };
    expect([runStatus(r, 1_000_000 + HEARTBEAT_MS - 1), runStatus(r, 1_000_000 + HEARTBEAT_MS), runStatus(r, 1_000_000 - 5)]).toEqual(["running", "unfinished", "running"]);
  });

  test("--since later than --until is an empty answer, not an error", async () => {
    const path = fresh();
    seed(path, SET);
    const r = await stats(path, ["--since", "2026-03-10", "--until", "2026-03-01"]);
    expect([r.code, r.out]).toEqual([0, "No recorded session matches."]);
  });
});

describe("QA analytics: output shapes", () => {
  test("--json: the summary, the list and one session keep their keys (a script can rely on them)", async () => {
    const path = fresh();
    seed(path, SET);
    const sum = JSON.parse((await stats(path, ["--json"])).out);
    expect(Object.keys(sum)).toEqual(["by", "groups", "total"]);
    expect(Object.keys(sum.groups[0])).toEqual(["key", "sessions", "duration_ms", "cost_usd", "cost_approx_usd", "unfinished"]);
    const list = JSON.parse((await stats(path, ["sessions", "--json"])).out);
    const cols = (new Database(path, { readonly: true }).query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name).filter((c) => c !== "spec");
    expect(Object.keys(list[0]).sort()).toEqual([...cols, "status"].sort());
    const one = JSON.parse((await stats(path, [list[0].id, "--json"])).out);
    expect(Object.keys(one).sort()).toEqual([...cols, "spec", "status"].sort());
    expect([typeof one.routing_types, one.routing_types]).toEqual(["object", null]);
  });

  test("--repo text with LIKE wildcards or a quote is matched literally", async () => {
    const path = fresh();
    seed(path, SET);
    for (const needle of ["%", "_", "a_pha", "al%", "'", "alpha' OR '1'='1"]) {
      const r = await stats(path, ["sessions", "--repo", needle, "--json"]);
      expect([needle, r.code, JSON.parse(r.out).length]).toEqual([needle, 0, 0]);
    }
  });

  test("BUG-598/QA-analytics-04: `gluon stats <id> --json` with no database prints null, not [] (a session is an object); exit 0 like the text path's \"nothing recorded\"", async () => {
    const path = join(dir, "never-created.db");
    const r = await stats(path, ["abcd1234", "--json"]);
    expect([r.code, r.out]).toEqual([0, "null"]);
    // The lists keep their arrays; the file is still not created.
    expect((await stats(path, ["sessions", "--json"])).out).toBe("[]");
    expect(existsSync(path)).toBe(false);
  });

  test("--delete leaves a newer Gluon's schema version alone", async () => {
    const path = fresh();
    seed(path, SET, MIGRATIONS.length + 3);
    const r = await stats(path, ["--delete", "--yes"]);
    expect(r.code).toBe(0);
    const db = new Database(path, { readonly: true });
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length + 3);
    db.close();
  });
});

describe("QA analytics: what --delete leaves", () => {
  test("with a recorder still holding the file open, no old spec is left in the file or its -wal (and the running session keeps recording)", async () => {
    const { Analytics } = await import("../src/analytics.ts");
    const path = fresh();
    const a = new Analytics({ enabled: true, path });
    const MARK = `QA-OLD-SPEC-${"x".repeat(200)}`;
    for (let i = 0; i < 5; i++) a.begin({ kind: "new", name: `done${i}`, harness: "claude-code", model: "m", spec: MARK })?.end({ code: 0, reason: "exit" });
    const live = a.begin({ kind: "new", name: "live", harness: "claude-code", model: "m", spec: "LIVE-SPEC" })!;
    const r = await stats(path, ["--delete", "--yes"]);
    expect([r.code, r.out]).toEqual([0, "Deleted 6 recorded sessions."]);
    for (const f of [path, `${path}-wal`]) if (existsSync(f)) expect([f, Buffer.from(await Bun.file(f).arrayBuffer()).includes("QA-OLD-SPEC")]).toEqual([f, false]);
    // The running session's row stays wiped (it is only ever updated), and a later session records.
    live.set({ contextPct: 5 });
    live.end({ code: 0, reason: "exit" });
    a.begin({ kind: "new", name: "later", harness: "claude-code", model: "m", spec: "after" })?.end({ code: 0, reason: "exit" });
    a.close();
    const db = new Database(path, { readonly: true });
    expect((db.query("SELECT name FROM sessions").all() as { name: string }[]).map((x) => x.name)).toEqual(["later"]);
    db.close();
  });
});

// ---- `gluon stats sql` limits (QA gap: an unbounded query held 6.4 GB and a core for 16 hours) ----

/**
 * Runs the real `gluon stats …` (Bun on the source, or GLUON_TEST_BINARY) in a child with its own state dir, so nothing of the user's is
 * touched, and a hard timeout of its own: a test must never wait on a query that does not end. `maxRss` is the peak, sampled every few ms,
 * of the process and its children together (bytes; Linux only: `ru_maxrss` of a child spawned by a big test process starts at the parent's size).
 */
/** The resident bytes of a process and its descendants (Linux /proc); 0 for one that is gone. */
function treeRss(pid: number): number {
  try {
    const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
    const kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").split(/\s+/).filter(Boolean).map(Number);
    return kb * 1024 + kids.reduce((sum, k) => sum + treeRss(k), 0);
  } catch {
    return 0;
  }
}

async function gluonStats(argv: string[], env: Record<string, string> = {}, hardMs = 20_000 * SLOW, interrupt?: { afterMs: number }) {
  const state = join(dir, `state${++n}`);
  mkdirSync(join(state, "gluon"), { recursive: true });
  seed(join(state, "gluon", "analytics.db"), SET);
  const proc = Bun.spawn([...GLUON, "stats", ...argv], {
    cwd: dir,
    env: { ...SYSTEM_ENV, PATH: process.env.PATH ?? "", HOME: state, USERPROFILE: state, XDG_STATE_HOME: state, LOCALAPPDATA: state, XDG_CONFIG_HOME: state, APPDATA: state, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, hardMs);
  const start = Date.now();
  let maxRss: number | undefined;
  const sampler = process.platform === "linux" ? setInterval(() => (maxRss = Math.max(maxRss ?? 0, treeRss(proc.pid))), 10) : undefined;
  if (interrupt) setTimeout(() => proc.kill("SIGINT"), interrupt.afterMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  clearInterval(sampler);
  return { code, out, err, ms: Date.now() - start, timedOut, maxRss };
}

const COUNT_TO = (rows: number) => `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${rows}) SELECT x FROM c`;


describe("gluon stats sql: limits", () => {
  const seeded = fresh();
  seed(seeded, SET);
  const inProcess = (q: string) => {
    const db = openStats(seeded)!;
    try {
      return runQuery(db, q);
    } finally {
      db.close();
    }
  };

  test("BUG-597/rows: more than 10000 rows are cut, and the cut is said (a table's last line; JSON: on stderr, the array stays valid)", async () => {
    const r = inProcess(COUNT_TO(10_500));
    expect([r.values.length, r.cut, r.values.at(-1)]).toEqual([10_000, "rows", [10_000]]);
    expect(inProcess(COUNT_TO(10_000)).cut).toBeUndefined();
    const t = await stats(seeded, ["sql", COUNT_TO(10_500)]);
    expect([t.code, t.out.split("\n").at(-1)]).toEqual([0, "(first 10000 rows; add LIMIT)"]);
    // Through the real command and its child.
    const j = await gluonStats(["sql", COUNT_TO(10_500), "--json"]);
    expect([j.timedOut, j.code]).toEqual([false, 0]);
    expect(JSON.parse(j.out)).toHaveLength(10_000);
    expect(j.err).toContain("gluon: first 10000 rows; add LIMIT");
  });

  test("BUG-597/deadline: a query still running at the deadline is stopped, with a clear error and a non-zero exit", async () => {
    // 20 million rows: about 3 s of one core, bounded. The seam shortens the 10 s deadline.
    const r = await gluonStats(["sql", `SELECT count(*) FROM (${COUNT_TO(20_000_000)})`], { GLUON_TEST_SQL_DEADLINE_MS: "700" });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(r.err).toContain("gluon: sql: stopped after 0.7 s");
    expect(r.err).toContain("add a LIMIT");
    expect(r.ms).toBeLessThan(2_500 * SLOW);
  });

  test("BUG-597/memory: one huge value is an out-of-memory error at once, not its size in RAM @full", async () => {
    // The instrument first: a 100 MB value fits under the cap, and the sampler sees it (about 240 MB for the pair).
    const control = await gluonStats(["sql", "SELECT zeroblob(100000000) AS z"]);
    expect([control.code, control.out.includes("<blob 100000000 bytes>")]).toEqual([0, true]);
    if (control.maxRss !== undefined) expect(control.maxRss).toBeGreaterThan(150_000_000);
    for (const q of ["SELECT zeroblob(300000000) AS z", "SELECT randomblob(1000000000)", "SELECT hex(randomblob(200000000))"]) {
      const r = await gluonStats(["sql", q]);
      expect([q, r.timedOut, r.code]).toEqual([q, false, 1]);
      expect(r.err).toContain("needs more than 256 MB of memory");
      // Peak of the command and its child: a bare run is about 125 MB; the values are 300 MB to 1 GB.
      if (r.maxRss !== undefined) expect([q, r.maxRss < 400_000_000]).toEqual([q, true]);
    }
  }, 30_000 * SLOW);

  test.skipIf(WIN)("BUG-597/macos-memory: where SQLite ignores its heap limit (macOS), the child's watchdog ends it past its memory cap, with the mark the parent reads as out of memory", async () => {
    // Forced here with a small cap: on Linux SQLite's own limit (256 MB) lets a 100 MB value through, the 30 MB cap doesn't. Random bytes:
    // building them takes long enough for the watchdog to see (macOS's SQLite returns a zeroblob before its first look).
    const dir = mkdtempSync(join(tmpdir(), "gluon-sql-memory-"));
    try {
      const path = join(dir, "a.db");
      new Database(path, { create: true }).close();
      const child = Bun.spawn([...GLUON, "stats-sql"], { env: { ...SYSTEM_ENV, PATH: process.env.PATH ?? "", [SQL_CHILD_ENV]: path, [SQL_CHILD_MEMORY_ENV]: String(30_000_000) }, stdin: new TextEncoder().encode("SELECT randomblob(100000000) AS z"), stdout: "pipe", stderr: "pipe" });
      const [err] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect([child.signalCode, err.trim()]).toEqual(["SIGKILL", SQL_MEMORY_MARK]);
      // Without the cap the same query answers.
      const free = Bun.spawn([...GLUON, "stats-sql"], { env: { ...SYSTEM_ENV, PATH: process.env.PATH ?? "", [SQL_CHILD_ENV]: path }, stdin: new TextEncoder().encode("SELECT randomblob(100000000) AS z"), stdout: "pipe", stderr: "pipe" });
      const [out] = await Promise.all([new Response(free.stdout).text(), free.exited]);
      expect(out).toContain("<blob 100000000 bytes>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000 * SLOW);

  test.skipIf(WIN)("BUG-597/Ctrl+C: an interrupt ends the command and its child at once", async () => {
    const r = await gluonStats(["sql", `SELECT count(*) FROM (${COUNT_TO(60_000_000)})`], {}, 20_000 * SLOW, { afterMs: 800 * SLOW });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(130);
    expect(r.ms).toBeLessThan(4_000 * SLOW);
  });

  /** Whether a process exists and is not a zombie (Linux). */
  const alive = (pid: number): boolean => {
    try {
      return !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return false;
    }
  };

  test.skipIf(process.platform !== "linux")("BUG-597/orphan: a SIGKILLed command leaves no query running; the child ends itself within a second", async () => {
    const state = join(dir, `state${++n}`);
    mkdirSync(join(state, "gluon"), { recursive: true });
    seed(join(state, "gluon", "analytics.db"), SET);
    // 60 million rows: about 9 s of one core, bounded; the child would end at the 10 s deadline anyway, far after the checks below.
    const parent = Bun.spawn([...GLUON, "stats", "sql", `SELECT count(*) FROM (${COUNT_TO(60_000_000)})`], {
      cwd: dir,
      env: { ...SYSTEM_ENV, PATH: process.env.PATH ?? "", HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let child = 0;
      for (let i = 0; i < 400 && !child; i++) {
        child = Number(readFileSync(`/proc/${parent.pid}/task/${parent.pid}/children`, "utf8").trim().split(/\s+/)[0]) || 0;
        if (!child) await Bun.sleep(25);
      }
      expect(child).toBeGreaterThan(0);
      // Let the query start (the child's watchdog is up before it runs).
      await Bun.sleep(1_000 * SLOW);
      expect(alive(child)).toBe(true);
      parent.kill("SIGKILL");
      await parent.exited;
      const killed = Date.now();
      while (alive(child) && Date.now() - killed < 5_000 * SLOW) await Bun.sleep(25);
      const took = Date.now() - killed;
      expect([alive(child), took < 2_000 * SLOW]).toEqual([false, true]);
    } finally {
      parent.kill("SIGKILL");
    }
  });

  test.skipIf(WIN)("BUG-597/hard limit: the child ends itself at its own limit, parent or no parent", async () => {
    const state = join(dir, `state${++n}`);
    mkdirSync(join(state, "gluon"), { recursive: true });
    const db = join(state, "gluon", "analytics.db");
    seed(db, SET);
    const start = Date.now();
    // The test process is the child's parent and stays alive; 60 million rows is about 9 s.
    const child = Bun.spawn([...GLUON, "stats-sql"], {
      cwd: dir,
      env: { ...SYSTEM_ENV, PATH: process.env.PATH ?? "", GLUON_STATS_SQL_DB: db, GLUON_STATS_SQL_LIMIT_MS: "800" },
      stdin: new TextEncoder().encode(`SELECT count(*) FROM (${COUNT_TO(60_000_000)})`),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000 * SLOW);
    const code = await child.exited;
    clearTimeout(timer);
    const took = Date.now() - start;
    expect([code === 0, child.signalCode, took < 3_500 * SLOW]).toEqual([false, "SIGKILL", true]);
  });

  test("BUG-597/shape: a normal query is unchanged through the child: columns, blobs, text, order, comments, a trailing semicolon", async () => {
    const t = await gluonStats(["sql", "SELECT harness, count(*) AS n FROM sessions GROUP BY harness ORDER BY harness DESC; -- done"]);
    expect([t.code, t.out.trimEnd().split("\n")]).toEqual([0, ["harness      n", "codex        2", "claude-code  2", "(2 rows)"]]);
    const j = await gluonStats(["sql", "SELECT 1 AS a, 2.5 AS b, NULL AS c, 'x' AS d, zeroblob(3) AS e, 9e999 AS f, 7 AS g --", "--json"]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toEqual([{ a: 1, b: 2.5, c: null, d: "x", e: "<blob 3 bytes>", f: null, g: 7 }]);
    expect((await gluonStats(["sql", "SELECT nope FROM sessions"])).code).toBe(1);
    expect((await gluonStats(["sql", "DELETE FROM sessions"])).code).toBe(2);
  });

  test("BUG-597/shape: a blob shows its size, a very long text is cut and says so, EXPLAIN, VALUES, and no row at all still work", () => {
    expect(inProcess("SELECT zeroblob(5) AS z, x'0102' AS b").values).toEqual([["<blob 5 bytes>", "<blob 2 bytes>"]]);
    const long = inProcess("SELECT hex(zeroblob(1500000)) AS h").values[0]![0] as string;
    expect([long.length < 1_000_100, long.endsWith("... [cut: 3000000 characters in all]"), long.startsWith("0000")]).toEqual([true, true, true]);
    expect(inProcess("EXPLAIN SELECT 1").columns).toContain("opcode");
    expect(inProcess("VALUES (1, 'a'), (2, 'b')").values).toEqual([[1, "a"], [2, "b"]]);
    expect(inProcess("SELECT id FROM sessions WHERE 0")).toEqual({ columns: ["id"], values: [] });
    // A repeated column name collapses in bun:sqlite; the count comes from the statement, the header says the position.
    expect(inProcess("SELECT 1, 1, NULL")).toEqual({ columns: ["column 1", "column 2", "column 3"], values: [[1, 1, null]] });
    expect(inProcess("WITH t AS (SELECT name FROM sessions ORDER BY name DESC) SELECT * FROM t").values.map((r) => r[0])).toEqual(["two", "three", "one", "four"]);
  });

  test("BUG-597/output: rows whose text adds up past 32 MB are cut like rows, and say so", () => {
    const r = inProcess(`SELECT hex(zeroblob(400000)) AS h FROM (${COUNT_TO(100)})`);
    expect(r.cut).toBe("bytes");
    expect(r.values.length).toBeLessThan(100);
    expect(r.values.length).toBeGreaterThan(30);
  });
});
