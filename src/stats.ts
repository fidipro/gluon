/**
 * `gluon stats`: the query side of the local analytics (`analytics.ts` writes `<state dir>/analytics.db`, one row per
 * launched session). Summaries per agent, model, day or repository, the newest sessions, one session in full, a read-only
 * SQL query, and a wipe. Needs no config and never creates the file: no database means "nothing recorded yet".
 *
 * Everything below `statsCommand` is pure or takes the database and a clock, so tests pass a temp path and an injected `now`.
 * Aggregation happens here, not in SQL: a day is the user's local day by the same clock the printed times use.
 * The `sql` command's guard is an allowlist (`sqlProblem`) on top of a read-only handle with `query_only`: ATTACH works on
 * a read-only handle, and bun:sqlite silently runs only the first of several statements, so both are refused up front.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyticsPath, runStatus, type RunStatus, type SessionRow } from "./analytics.ts";
import { killTree, neutralCwd } from "./detect.ts";
import { safeLine } from "./events.ts";
import { HARNESSES, type Harness } from "./harnesses.ts";
import { selfArgv } from "./self.ts";
import { costLabel } from "./sessions.ts";
import { decodeAnswer, SQL_CHILD_ENV, SQL_CHILD_GRACE_MS, SQL_CHILD_LIMIT_ENV, SQL_DEADLINE_MS, SQL_MAX_ROWS, SQL_OUTPUT_BYTES, sqlProblem, StatsError, writeAll, type QueryResult } from "./stats-sql.ts";

export { runQuery, sqlProblem, StatsError } from "./stats-sql.ts";

export const STATS_HELP = `gluon stats [options]
gluon stats sessions [options]
gluon stats <id>
gluon stats sql "<query>"
gluon stats --delete [--yes]

What Gluon recorded about the sessions it launched, from the local file <state dir>/analytics.db (never sent anywhere).
  gluon stats             per agent: sessions, time, cost and sessions that never reported an end
  gluon stats sessions    the newest sessions: id, start, duration, agent/model/effort/mode, cost, status, repository, name
  gluon stats <id>        one session in full, with the spec it was given: a unique id prefix (4+ characters)
                          or the agent's own session id
  gluon stats sql "<q>"   one read-only SELECT, WITH, EXPLAIN or VALUES statement against the table 'sessions'; it
                          is stopped after 10 s, returns at most 10000 rows (it says when it cut: add a LIMIT), uses at most 256 MB
  gluon stats --delete    delete every recorded session (asks first; --yes without a terminal)

options:
  --by agent|model|day|repo   group the summary by this (default agent)
  --agent <harness>           only this agent
  --repo <text>               only sessions whose repository or directory contains this text (any case)
  --since <when>              only sessions started at or after it
  --until <when>              only sessions started at or before it
                              <when>: 2026-01-31 (local day), 2026-01-31T14:30, or 7d, 24h, 2w, 30m ago
  --limit <n>                 rows shown for the summary and the session list (default 50)
  --json                      machine-readable output
  --yes                       with --delete: don't ask
  -h, --help                  this text

'analytics: off' in the config stops the recording; 'gluon uninstall' removes the file.`;

const OPTIONS = {
  json: { type: "boolean" },
  since: { type: "string" },
  until: { type: "string" },
  agent: { type: "string" },
  repo: { type: "string" },
  by: { type: "string" },
  limit: { type: "string" },
  delete: { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export const GROUPINGS = ["agent", "model", "day", "repo"] as const;
export type Grouping = (typeof GROUPINGS)[number];

// ---------------------------------------------------------------- times

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** A `--since` / `--until` value as epoch ms: `YYYY-MM-DD` (local midnight; the end of that day for `until`), an ISO datetime, or `7d`, `24h`, `2w`, `30m` before `now`. */
export function parseWhen(text: string, now: number, edge: "since" | "until"): number {
  /** The local midnight of a calendar day; a day that does not exist (2026-02-30) is refused, not rolled over. */
  const midnight = (y: number, m: number, d: number): Date => {
    const start = new Date(y, m, d);
    if (start.getFullYear() !== y || start.getMonth() !== m || start.getDate() !== d) throw new StatsError(`--${edge}: ${text.slice(0, 10)} is not a date`);
    return start;
  };
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
    const start = midnight(y, m, d);
    return edge === "since" ? start.getTime() : new Date(y, m, d + 1).getTime() - 1;
  }
  const rel = /^(\d{1,6})([mhdw])$/.exec(text);
  if (rel) return now - Number(rel[1]) * UNITS[rel[2]!]!;
  const when = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}/.exec(text);
  if (when) {
    midnight(Number(when[1]), Number(when[2]) - 1, Number(when[3]));
    const t = Date.parse(text);
    if (Number.isFinite(t)) return t;
  }
  throw new StatsError(`--${edge} takes a date (2026-01-31), a date and time (2026-01-31T14:30) or a span back from now (7d, 24h, 2w, 30m), not "${text}"`);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** `2026-01-31` in the local time zone. */
export const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** `2026-01-31 14:30` in the local time zone. */
export const localMinute = (ms: number): string => {
  const d = new Date(ms);
  return `${localDay(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** `45s`, `5m03s`, `1h05m`, `2d03h`; `—` when unknown. */
export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d${pad(h % 24)}h`;
}

// ---------------------------------------------------------------- the database

/** The database to read: null when there is no file or no `sessions` table (nothing recorded yet). Read-only; never creates the file. */
export function openStats(path: string): Database | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    db.run("PRAGMA query_only=1");
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get()) {
      db.close();
      return null;
    }
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

export interface Filters {
  since?: number;
  until?: number;
  agent?: Harness;
  repo?: string;
}

/** A session as the summary and the list read it: every column but the spec (up to 100 KB a row), which only one session's detail needs. */
export type ListRow = Omit<SessionRow, "spec">;

/** Every column of `sessions` but `spec`, read from the table itself so a new column is in it. */
function listColumns(db: Database): string {
  const cols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name).filter((c) => c !== "spec");
  return cols.map((c) => `"${c}"`).join(", ");
}

function whereOf(f: Filters): { sql: string; args: (string | number)[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.since !== undefined) (where.push("started_at >= ?"), args.push(f.since));
  if (f.until !== undefined) (where.push("started_at <= ?"), args.push(f.until));
  if (f.agent !== undefined) (where.push("harness = ?"), args.push(f.agent));
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", args };
}

/** The repository text is matched in code (case folding is Unicode-aware, SQLite's is ASCII only). */
const repoMatch = (f: Filters): ((r: Pick<SessionRow, "repo" | "cwd">) => boolean) => {
  const needle = f.repo?.toLowerCase();
  return needle === undefined ? () => true : (r) => `${r.repo ?? ""}\n${r.cwd ?? ""}`.toLowerCase().includes(needle);
};

/** The rows that match, oldest first, without their specs. */
export function selectSessions(db: Database, f: Filters): ListRow[] {
  const { sql, args } = whereOf(f);
  const rows = db.query(`SELECT ${listColumns(db)} FROM sessions${sql} ORDER BY started_at ASC, id ASC`).all(...args) as ListRow[];
  return rows.filter(repoMatch(f));
}

/** The newest `limit` rows that match (newest first, no specs) and how many match in all; the limit is applied in SQL unless a repository text has to be matched in code. */
export function newestSessions(db: Database, f: Filters, limit: number): { rows: ListRow[]; total: number } {
  const { sql, args } = whereOf(f);
  if (f.repo !== undefined) {
    const all = selectSessions(db, f).reverse();
    return { rows: all.slice(0, limit), total: all.length };
  }
  const rows = db.query(`SELECT ${listColumns(db)} FROM sessions${sql} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args, limit) as ListRow[];
  const total = (db.query(`SELECT count(*) AS n FROM sessions${sql}`).get(...args) as { n: number }).n;
  return { rows, total };
}

// ---------------------------------------------------------------- summary

export interface Group {
  key: string;
  sessions: number;
  duration_ms: number;
  /** Sum of the figures that are known; null when no session has one. */
  cost_usd: number | null;
  /** The part of it that is an estimate (an API-equivalent figure on a plan). */
  cost_approx_usd: number | null;
  unfinished: number;
}

/** How long a session ran: its recorded duration; a row with no end counts up to its last heartbeat. */
export function rowDuration(r: Pick<SessionRow, "started_at" | "ended_at" | "updated_at" | "duration_ms">): number {
  if (r.ended_at === null) return Math.max(0, r.updated_at - r.started_at);
  return r.duration_ms ?? Math.max(0, r.ended_at - r.started_at);
}

const groupKey = (r: ListRow, by: Grouping): string => (by === "agent" ? r.harness : by === "model" ? r.model : by === "day" ? localDay(r.started_at) : (r.repo ?? r.cwd ?? "(none)"));

function emptyGroup(key: string): Group {
  return { key, sessions: 0, duration_ms: 0, cost_usd: null, cost_approx_usd: null, unfinished: 0 };
}

function addRow(g: Group, r: ListRow, now: number): void {
  g.sessions++;
  g.duration_ms += rowDuration(r);
  if (r.cost_usd !== null) {
    g.cost_usd = (g.cost_usd ?? 0) + r.cost_usd;
    if (r.cost_approx) g.cost_approx_usd = (g.cost_approx_usd ?? 0) + r.cost_usd;
  }
  if (runStatus(r, now) === "unfinished") g.unfinished++;
}

/** The groups (days newest first, the others by sessions) and the total over all rows. */
export function summarize(rows: ListRow[], by: Grouping, now: number): { groups: Group[]; total: Group } {
  const map = new Map<string, Group>();
  const total = emptyGroup("total");
  for (const r of rows) {
    const k = groupKey(r, by);
    const g = map.get(k) ?? emptyGroup(k);
    map.set(k, g);
    addRow(g, r, now);
    addRow(total, r, now);
  }
  const groups = [...map.values()].sort((a, b) => (by === "day" ? (a.key < b.key ? 1 : -1) : b.sessions - a.sessions || (a.key < b.key ? -1 : 1)));
  return { groups, total };
}

/** `$1.20`, `~$1.20` when any of it is an estimate, `—` when no session has a figure. */
export function groupCost(g: Group): string {
  return g.cost_usd === null ? "—" : costLabel({ usd: g.cost_usd, approx: g.cost_approx_usd !== null });
}

// ---------------------------------------------------------------- printing

/** A text from the database as one safe line (control characters and escape sequences gone). */
const line = (text: string | null | undefined, max = 200): string => (text === null || text === undefined ? "" : safeLine(text, max));

/** Aligned columns, two spaces apart; `right` columns (numbers) are right-aligned. */
export function formatTable(header: string[], rows: string[][], right: ReadonlySet<number> = new Set()): string[] {
  const width = header.map((h, i) => Math.max(Bun.stringWidth(h), ...rows.map((r) => Bun.stringWidth(r[i] ?? ""))));
  const cell = (s: string, i: number) => (right.has(i) ? " ".repeat(width[i]! - Bun.stringWidth(s)) + s : s + " ".repeat(width[i]! - Bun.stringWidth(s)));
  const render = (r: string[]) => r.map(cell).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

export function summaryLines(groups: Group[], total: Group, by: Grouping, limit: number): string[] {
  const row = (g: Group, key: string) => [key, String(g.sessions), durationLabel(g.duration_ms), groupCost(g), g.unfinished ? String(g.unfinished) : "—"];
  const shown = groups.slice(0, limit);
  const lines = formatTable([by, "sessions", "time", "cost", "unfinished"], [...shown.map((g) => row(g, line(g.key, 60))), row(total, "total")], new Set([1, 2, 3, 4]));
  if (groups.length > shown.length) lines.push(`(${groups.length - shown.length} more ${by === "day" ? "days" : `${by}s`}: --limit)`);
  return lines;
}

/** `harness/model/effort/mode`, the parts that exist. */
const agentLabel = (r: ListRow): string => [r.harness, r.model, r.effort, r.mode].filter((p): p is string => !!p).join("/");
const costOf = (r: ListRow): string => (r.cost_usd === null ? "—" : costLabel({ usd: r.cost_usd, approx: !!r.cost_approx, own: r.cost_own === 0 ? false : undefined, billed: !!r.cost_billed }));

export function sessionLines(rows: ListRow[], now: number, total: number): string[] {
  const lines = formatTable(
    ["id", "started", "time", "agent", "cost", "status", "repo", "name"],
    rows.map((r) => [r.id.slice(0, 8), localMinute(r.started_at), durationLabel(rowDuration(r)), line(agentLabel(r), 70), costOf(r), runStatus(r, now), line(r.repo ?? r.cwd, 50), line(r.name, 60)]),
    new Set([2, 4]),
  );
  if (total > rows.length) lines.push(`(${total - rows.length} older: --limit)`);
  return lines;
}

/** A multi-line text (a spec) indented, each line made safe; leading blanks of a line are kept, so a list stays a list. */
function indented(text: string, by = "    "): string[] {
  return text.split(/\r\n|\r|\n/).map((l) => {
    const lead = (/^[ \t]*/.exec(l)![0] ?? "").replace(/\t/g, "  ");
    const body = safeLine(l, 2000);
    return body ? `${by}${lead}${body}` : "";
  });
}

/** A JSON-array column parsed; the text itself when it is none. */
function parsedJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === null ? [] : [String(v)]);

export function detailLines(r: SessionRow, now: number): string[] {
  const when = (ms: number | null) => (ms === null ? "—" : localMinute(ms));
  const kv = (k: string, v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? [] : [`${`${k}:`.padEnd(15)}${typeof v === "number" ? v : line(v, 400)}`]);
  const types = asList(parsedJson(r.routing_types));
  const why = asList(parsedJson(r.routing_why));
  const out = [
    ...kv("id", r.id),
    ...kv("name", r.name),
    ...kv("status", `${runStatus(r, now)} (${r.kind})`),
    ...kv("agent", agentLabel(r)),
    ...kv("version", r.harness_version),
    ...kv("connection", r.conn),
    ...kv("started", when(r.started_at)),
    ...kv("ended", r.ended_at === null ? null : when(r.ended_at)),
    ...kv("duration", durationLabel(rowDuration(r))),
    ...kv("exit code", r.exit_code),
    ...kv("end reason", r.end_reason),
    ...kv("cost", costOf(r)),
    ...kv("context", r.context_pct === null ? null : `${r.context_pct}%`),
    ...kv("repo", r.repo),
    ...kv("directory", r.cwd),
    ...kv("branch", r.branch),
    ...kv("worktree", r.worktree_path),
    ...kv("worktree branch", r.worktree_branch),
    ...kv("agent session", r.agent_session_id ? `${r.agent_session_id}${r.agent_session_source ? ` (${r.agent_session_source})` : ""}` : null),
    ...kv("workspace", r.workspace_id),
    ...kv("gluon", r.gluon_version),
  ];
  if (types.length) out.push(`${"routing types:".padEnd(15)}${types.map((t) => line(t, 80)).join(", ")}`);
  if (why.length) out.push("routing why:", ...why.map((w) => `  - ${line(w, 400)}`));
  out.push("spec:", ...indented(r.spec));
  return out;
}

const withStatus = <R extends Pick<SessionRow, "ended_at" | "updated_at">>(r: R, now: number) => ({ ...r, status: runStatus(r, now) });

/** One session as JSON: its row with the JSON columns parsed, and its status. */
export function detailJson(r: ListRow, now: number): Record<string, unknown> {
  return { ...withStatus(r, now), routing_types: parsedJson(r.routing_types), routing_why: parsedJson(r.routing_why) };
}

// ---------------------------------------------------------------- one session

/** `shared`: several rows carry this agent session id (a resumed session starts a row each time). */
export type Lookup = { row: SessionRow } | { none: true } | { many: SessionRow[] } | { shared: SessionRow[] };

/** A unique id prefix (4+ characters), or an exact id or agent session id. */
export function findSession(db: Database, key: string): Lookup {
  const exact = db.query("SELECT * FROM sessions WHERE id = ? OR agent_session_id = ? ORDER BY started_at DESC").all(key, key) as SessionRow[];
  if (exact.length === 1) return { row: exact[0]! };
  if (exact.length > 1) return exact.every((r) => r.agent_session_id === key && r.id !== key) ? { shared: exact } : { many: exact };
  if ([...key].length < 4) return { none: true };
  const rows = db.query("SELECT * FROM sessions WHERE substr(id, 1, ?) = ? ORDER BY started_at DESC").all([...key].length, key) as SessionRow[];
  return rows.length === 1 ? { row: rows[0]! } : rows.length ? { many: rows } : { none: true };
}

// ---------------------------------------------------------------- sql

/** How a query ends early, said in the table's last line (text) or on stderr (JSON): rows or text cut at a limit. */
export const cutNote = (r: Pick<QueryResult, "values" | "cut">): string | null =>
  r.cut === "rows" ? `first ${SQL_MAX_ROWS} rows; add LIMIT` : r.cut === "bytes" ? `first ${r.values.length} rows: their text passed ${SQL_OUTPUT_BYTES / 1024 / 1024} MB; add LIMIT or select less` : null;

const cellText = (v: unknown): string => (v === null || v === undefined ? "NULL" : v instanceof Uint8Array ? `<blob ${v.length} bytes>` : typeof v === "string" ? line(v, 200) : String(v));
const jsonCell = (v: unknown): unknown => (v instanceof Uint8Array ? `<blob ${v.length} bytes>` : typeof v === "bigint" ? v.toString() : v);

export function queryJson(r: { columns: string[]; values: unknown[][] }): Record<string, unknown>[] {
  return r.values.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, jsonCell(row[i])])));
}

export function queryLines(r: Pick<QueryResult, "columns" | "values" | "cut">): string[] {
  if (!r.columns.length) return ["(no columns)"];
  const numeric = new Set(r.columns.map((_, i) => i).filter((i) => r.values.length > 0 && r.values.every((row) => typeof row[i] === "number" || typeof row[i] === "bigint")));
  const lines = formatTable(r.columns.map((c) => line(c, 60)), r.values.map((row) => row.map(cellText)), numeric);
  lines.push(`(${cutNote(r) ?? `${r.values.length} row${r.values.length === 1 ? "" : "s"}`})`);
  return lines;
}

// ---------------------------------------------------------------- run in a child

/** Runs a checked query and answers its rows; the real one is `runQueryInChild`, a test may pass one that runs in its own process. */
export type SqlRunner = (path: string, query: string) => Promise<QueryResult>;

declare const GLUON_BUILD: string | undefined;
/** The test seam for the deadline (ms), folded away in release builds. */
const testDeadline = (): number | undefined => {
  if (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test") return undefined;
  const n = Number(process.env.GLUON_TEST_SQL_DEADLINE_MS);
  return n > 0 ? n : undefined;
};

const seconds = (ms: number): string => `${+(ms / 1000).toFixed(1)} s`;
const CHILD_ENV_KEYS = ["PATH", "SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "LANG"];

/**
 * Runs the query in a child Gluon (`gluon stats-sql`, `stats-sql.ts`) that is killed at the deadline: SQLite's native step can't be
 * interrupted from JS, and a Worker's `terminate()` leaves it running. The child gets the database path and the query alone, no keys.
 * Ctrl+C reaches the child with us (same terminal) and ends it here too; a signal sent to this process alone kills the child as well.
 */
export const runQueryInChild: SqlRunner = async (path, query) => {
  const problem = sqlProblem(query);
  if (problem) throw new StatsError(problem);
  const deadline = testDeadline() ?? SQL_DEADLINE_MS;
  const env: Record<string, string> = { [SQL_CHILD_ENV]: resolve(path), [SQL_CHILD_LIMIT_ENV]: String(deadline + SQL_CHILD_GRACE_MS) };
  for (const k of CHILD_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  const child = Bun.spawn([...selfArgv(), "stats-sql"], { cwd: neutralCwd(), env, stdin: new TextEncoder().encode(query), stdout: "pipe", stderr: "pipe" });
  const stop = () => {
    if (process.platform === "win32") killTree(child);
    else child.kill("SIGKILL");
  };
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    stop();
  }, deadline);
  const signals = ["SIGINT", "SIGTERM"] as const;
  const onSignal = (sig: NodeJS.Signals) => {
    stop();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  for (const sig of signals) process.on(sig, onSignal);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (late) throw new StatsError(`sql: stopped after ${seconds(deadline)}: the query was still running; simplify it or add a LIMIT`, 1);
    let answer: ReturnType<typeof decodeAnswer> | null = null;
    try {
      answer = out ? decodeAnswer(out) : null;
    } catch {}
    if (!answer) throw new StatsError(`sql: the query process ended without an answer (exit ${code})${err.trim() ? `: ${line(err)}` : ""}`, 1);
    if ("error" in answer) throw new StatsError(answer.error, answer.code);
    return answer.ok;
  } finally {
    clearTimeout(timer);
    for (const sig of signals) process.off(sig, onSignal);
    stop();
  }
};

// ---------------------------------------------------------------- delete

/** Deletes every row through a write connection and shrinks the files. Never unlinks them: another Gluon may hold the database open. Returns how many rows went. */
export function wipe(path: string): number {
  const db = new Database(path, { readwrite: true });
  try {
    db.run("PRAGMA busy_timeout=5000");
    const n = (db.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n;
    db.run("DELETE FROM sessions");
    db.run("VACUUM");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    return n;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- the command

export interface StatsOptions {
  /** The database (default: `analyticsPath()`). */
  path?: string;
  now?: number;
  /** stdin and stdout are a terminal (a question can be asked). */
  tty?: boolean;
  /** Asks the user; true to go on. */
  ask?: (question: string) => boolean;
  log?: (text: string) => void;
  error?: (text: string) => void;
  /** Runs `sql` queries (default: a child process with a deadline, `runQueryInChild`). */
  sql?: SqlRunner;
}

const NONE_YET = "No analytics recorded yet.";

/** Runs `gluon stats`; returns the exit code (2: bad arguments, 1: nothing found or the database refused). */
export async function statsCommand(argv: string[], o: StatsOptions = {}): Promise<number> {
  // The command ends in `process.exit`: a big answer (10000 rows is MBs) that `console.log` wrote to a pipe came out cut after the sql child ran; without
  // sinks of their own, the output is kept and written whole before returning.
  const written: string[] = [];
  const problems: string[] = [];
  const log = o.log ?? ((t: string) => void written.push(t));
  const error = o.error ?? ((t: string) => void problems.push(t));
  const now = o.now ?? Date.now();
  const path = o.path ?? analyticsPath();
  try {
    return await run(argv, { path, now, log, error, tty: o.tty ?? (!!process.stdin.isTTY && !!process.stdout.isTTY), ask: o.ask ?? ((q) => /^y(es)?$/i.test((prompt(q) ?? "").trim())), sql: o.sql ?? runQueryInChild });
  } catch (e) {
    if (e instanceof StatsError) {
      error(`gluon: ${e.message}`);
      return e.code;
    }
    error(`gluon: couldn't read ${path}: ${line((e as Error).message)}`);
    return 1;
  } finally {
    if (written.length) await writeAll(process.stdout, `${written.join("\n")}\n`);
    if (problems.length) await writeAll(process.stderr, `${problems.join("\n")}\n`);
  }
}

type Ctx = Required<Pick<StatsOptions, "path" | "now" | "log" | "error" | "tty" | "ask" | "sql">>;

async function run(argv: string[], c: Ctx): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    throw new StatsError(`${(e as Error).message.split("\n")[0]!.replace(/\. To specify a positional argument.*$/, "")}\nSee gluon stats --help.`);
  }
  const { values: v, positionals: pos } = parsed;
  if (v.help) {
    c.log(STATS_HELP);
    return 0;
  }
  const limit = v.limit === undefined ? 50 : /^[1-9]\d{0,6}$/.test(v.limit) ? Number(v.limit) : -1;
  if (limit < 0) throw new StatsError(`--limit takes a number of rows (1 or more), not "${v.limit}"`);
  const by = (v.by ?? "agent") as Grouping;
  if (!GROUPINGS.includes(by)) throw new StatsError(`--by takes one of: ${GROUPINGS.join(", ")}`);
  if (v.agent !== undefined && !HARNESSES.includes(v.agent as Harness)) throw new StatsError(`--agent takes one of: ${HARNESSES.join(", ")}`);
  const filters: Filters = {
    ...(v.since !== undefined ? { since: parseWhen(v.since, c.now, "since") } : {}),
    ...(v.until !== undefined ? { until: parseWhen(v.until, c.now, "until") } : {}),
    ...(v.agent !== undefined ? { agent: v.agent as Harness } : {}),
    ...(v.repo !== undefined ? { repo: v.repo } : {}),
  };
  const filtered = Object.keys(filters).length > 0;
  const word = pos[0];
  const mode = word === undefined ? "summary" : word === "sessions" ? "sessions" : word === "sql" ? "sql" : "one";

  if (v.delete) {
    if (pos.length || filtered || v.by !== undefined || v.limit !== undefined || v.json) throw new StatsError("--delete takes only --yes: gluon stats --delete [--yes]");
  } else if (v.yes) throw new StatsError("--yes goes with `gluon stats --delete`");
  if (mode === "sql" || mode === "one") {
    if (filtered || v.by !== undefined || v.limit !== undefined) throw new StatsError(`${mode === "sql" ? "sql" : "an id"} takes no --by, --limit or filters${mode === "sql" ? " (put them in the query)" : ""}`);
  }
  if (mode === "one" && pos.length > 1) throw new StatsError(`stats takes one id: gluon stats <id> (to query, gluon stats sql "<query>")`);
  if (mode === "sessions") {
    if (pos.length > 1) throw new StatsError("sessions takes no arguments: gluon stats sessions [options]");
    if (v.by !== undefined) throw new StatsError("--by goes with `gluon stats` (the summary)");
  }
  if (mode === "sql" && pos.length < 2) throw new StatsError(`sql takes a query: gluon stats sql "SELECT count(*) AS n FROM sessions"`);

  if (v.delete) return deleteAll(c, !!v.yes);

  const db = openStats(c.path);
  if (!db) {
    // The shape of a real answer: a list is an array, a session an object (none: null).
    c.log(v.json ? (mode === "summary" ? JSON.stringify({ by, groups: [], total: emptyGroup("total") }, null, 2) : mode === "one" ? "null" : "[]") : NONE_YET);
    return 0;
  }
  if (mode === "sql") {
    // The query runs in a child that opens the file itself: this handle only told that there is something to query.
    db.close();
    const r = await c.sql(c.path, pos.slice(1).join(" "));
    c.log(v.json ? JSON.stringify(queryJson(r), null, 2) : queryLines(r).join("\n"));
    if (v.json && r.cut) c.error(`gluon: ${cutNote(r)}`);
    return 0;
  }
  try {
    if (mode === "one") {
      const found = findSession(db, word!);
      if ("row" in found) {
        c.log(v.json ? JSON.stringify(detailJson(found.row, c.now), null, 2) : detailLines(found.row, c.now).join("\n"));
        return 0;
      }
      if ("shared" in found) {
        c.error(`gluon: ${found.shared.length} sessions share agent session id ${line(word)} (a resumed session); use one of these ids:`);
        for (const r of found.shared.slice(0, 20)) c.error(`  ${r.id}  ${localMinute(r.started_at)}  ${line(r.name, 60)}`);
        return 1;
      }
      if ("many" in found) {
        c.error(`gluon: "${line(word)}" matches ${found.many.length} sessions; use more of the id:`);
        for (const r of found.many.slice(0, 20)) c.error(`  ${r.id}  ${localMinute(r.started_at)}  ${line(r.name, 60)}`);
        return 1;
      }
      c.error(`gluon: no recorded session has the id "${line(word)}" (an id prefix needs 4 or more characters; \`gluon stats sessions\` lists them)`);
      return 1;
    }
    if (mode === "sessions") {
      const { rows: shown, total: count } = newestSessions(db, filters, limit);
      c.log(v.json ? JSON.stringify(shown.map((r) => withStatus(r, c.now)), null, 2) : count ? sessionLines(shown, c.now, count).join("\n") : filtered ? "No recorded session matches." : NONE_YET);
      return 0;
    }
    const rows = selectSessions(db, filters);
    const { groups, total } = summarize(rows, by, c.now);
    if (v.json) c.log(JSON.stringify({ by, groups: groups.slice(0, limit), total }, null, 2));
    else c.log(rows.length ? summaryLines(groups, total, by, limit).join("\n") : filtered ? "No recorded session matches." : NONE_YET);
    return 0;
  } finally {
    db.close();
  }
}

function deleteAll(c: Ctx, yes: boolean): number {
  if (!existsSync(c.path)) {
    c.log(NONE_YET);
    return 0;
  }
  const db = openStats(c.path);
  if (!db) {
    c.log(NONE_YET);
    return 0;
  }
  const n = (db.query("SELECT count(*) AS n FROM sessions").get() as { n: number }).n;
  db.close();
  if (!yes) {
    if (!c.tty) throw new StatsError("deleting the recorded sessions needs a terminal to ask first; to delete without asking: gluon stats --delete --yes");
    if (!c.ask(`Delete all ${n} recorded session${n === 1 ? "" : "s"} from ${c.path}? [y/N]`)) {
      c.log("Nothing deleted.");
      return 0;
    }
  }
  const gone = wipe(c.path);
  c.log(`Deleted ${gone} recorded session${gone === 1 ? "" : "s"}.`);
  return 0;
}
