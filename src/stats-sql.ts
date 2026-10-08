/**
 * `gluon stats sql`: the guard on the user's query and the limits it runs under. The query itself never runs in the Gluon
 * process: `stats.ts` starts a child (`gluon stats-sql`, below) and kills it at the deadline, because a Worker's `terminate()` does
 * not stop a SQLite step that is running (it keeps the core and the memory) and nothing in `bun:sqlite` can interrupt one.
 *
 * Inside the child: `PRAGMA hard_heap_limit` caps SQLite's own memory (a `randomblob(1e9)`, a `group_concat` over a recursive CTE
 * fail with "out of memory" instead of taking GB; on macOS, whose SQLite ignores it, the watchdog caps the child's memory instead); the query is wrapped so a blob or a very long text never reaches JS whole
 * (`zeroblob(1e9)` takes no SQLite memory, but would be copied into a 1 GB array) and so at most `SQL_MAX_ROWS` + 1 rows are
 * produced; the rows are counted in bytes as they stream in. Light on purpose: the child loads only this file.
 */
import { Database } from "bun:sqlite";
import { safeLine } from "./events.ts";

/** A refusal: `message` goes to stderr as `gluon: <message>`, `code` is the exit code. */
export class StatsError extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message);
  }
}

/** How long the child may run before it is killed. */
export const SQL_DEADLINE_MS = 10_000;
/** Rows returned; one more is read to know that rows were cut. */
export const SQL_MAX_ROWS = 10_000;
/** SQLite's memory in the child (`hard_heap_limit`). */
export const SQL_HEAP_BYTES = 256 * 1024 * 1024;
/** The text and numbers of the rows kept (about their size in JS); more is cut like the rows. */
export const SQL_OUTPUT_BYTES = 32 * 1024 * 1024;
/** A text value longer than this is cut (and says so). */
export const SQL_CELL_CHARS = 1_000_000;

const SQL_FIRST = new Set(["SELECT", "WITH", "EXPLAIN", "VALUES"]);

const line = (text: string, max = 200): string => safeLine(text, max);

/** The checked query: why it is refused (or null), its first word, and the text of its one statement (up to the first top-level `;`). */
function scanSql(query: string): { problem: string | null; first: string | null; statement: string } {
  let first: string | null = null;
  let end = -1;
  let i = 0;
  const refuse = (problem: string) => ({ problem, first, statement: query });
  while (i < query.length) {
    const c = query[i]!;
    const n = query[i + 1];
    if (c === "-" && n === "-") {
      const e = query.indexOf("\n", i);
      i = e < 0 ? query.length : e + 1;
    } else if (c === "/" && n === "*") {
      const e = query.indexOf("*/", i + 2);
      i = e < 0 ? query.length : e + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < query.length) {
        if (query[j] === close) {
          if (close !== "]" && query[j + 1] === close) j += 2;
          else break;
        } else j++;
      }
      if (end >= 0) return refuse("only one statement can run");
      first ??= c;
      i = j + 1;
    } else if (c === ";") {
      if (end < 0) end = i;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      if (end >= 0) return refuse("only one statement can run");
      if (first === null) {
        const word = /^[A-Za-z]+/.exec(query.slice(i))?.[0] ?? c;
        first = word.toUpperCase();
        i += word.length;
      } else i++;
    }
  }
  const statement = end < 0 ? query : query.slice(0, end);
  if (first === null) return { problem: "give a query: gluon stats sql \"SELECT count(*) FROM sessions\"", first, statement };
  if (!SQL_FIRST.has(first)) return { problem: "only a read-only query runs: start it with SELECT, WITH, EXPLAIN or VALUES", first, statement };
  return { problem: null, first, statement };
}

/**
 * Why a query is refused, or null when it may run: one statement only (bun:sqlite would silently run the first and drop the
 * rest, which would hide a mistake), and one starting with SELECT, WITH, EXPLAIN or VALUES. Quotes and comments are skipped
 * when looking for the end of the statement. The read-only handle, not this, is what makes a write impossible.
 */
export function sqlProblem(query: string): string | null {
  return scanSql(query).problem;
}

export interface QueryResult {
  columns: string[];
  values: unknown[][];
  /** Why the rows stop early: `rows` (more than `SQL_MAX_ROWS`) or `bytes` (their text passed `SQL_OUTPUT_BYTES`). */
  cut?: "rows" | "bytes";
}

/**
 * The statement with every column renamed `c0…`, a blob replaced by its size, a long text cut (and saying so), at most one row more
 * than `SQL_MAX_ROWS`. A CTE used once is not materialized, so the query streams as before.
 */
function bounded(statement: string, columns: number): string {
  const cols = Array.from({ length: columns }, (_, i) => `c${i}`);
  const select = cols.map((c) => `CASE typeof(${c}) WHEN 'blob' THEN printf('<blob %d bytes>', length(${c})) WHEN 'text' THEN (CASE WHEN length(${c}) > ${SQL_CELL_CHARS} THEN substr(${c}, 1, ${SQL_CELL_CHARS}) || printf('... [cut: %d characters in all]', length(${c})) ELSE ${c} END) ELSE ${c} END AS ${c}`);
  return `WITH gluon_q(${cols.join(", ")}) AS (\n${statement}\n) SELECT ${select.join(", ")} FROM gluon_q LIMIT ${SQL_MAX_ROWS + 1}`;
}

export const MEMORY_HINT = `sql: the query needs more than ${SQL_HEAP_BYTES / 1024 / 1024} MB of memory; select less (a LIMIT, fewer or shorter values)`;
const sqlMessage = (e: unknown): string => (/out of memory/i.test((e as Error).message) ? MEMORY_HINT : `sql: ${line((e as Error).message)}`);

/** Runs a checked query on a read-only handle, within the limits above (the caller bounds its time). */
export function runQuery(db: Database, query: string): QueryResult {
  const { problem, first, statement } = scanSql(query);
  if (problem) throw new StatsError(problem);
  try {
    // A sort or a temporary table stays inside the heap limit instead of going to a file.
    db.run("PRAGMA temp_store=MEMORY");
    db.run(`PRAGMA hard_heap_limit=${SQL_HEAP_BYTES}`);
    const raw = db.query(statement);
    const names = raw.columnNames;
    // bun:sqlite drops a repeated column name (`SELECT 1, 1`), so the real count is the program's: its ResultRow's P2.
    const width = first === "EXPLAIN" ? undefined : (db.query(`EXPLAIN ${statement}`).values() as unknown[][]).find((op) => op[1] === "ResultRow")?.[3];
    // EXPLAIN can't be a subquery (its rows are the program, few); an unknown width or no column: nothing to wrap.
    if (typeof width !== "number" || width < 1) {
      const all = raw.values() as unknown[][];
      return all.length > SQL_MAX_ROWS ? { columns: names, values: all.slice(0, SQL_MAX_ROWS), cut: "rows" } : { columns: names, values: all };
    }
    // Names that collapsed can't be told apart: say the position.
    const columns = names.length === width ? names : Array.from({ length: width }, (_, i) => `column ${i + 1}`);
    raw.finalize();
    const stmt = db.query(bounded(statement, columns.length));
    const values: unknown[][] = [];
    let bytes = 0;
    let cut: QueryResult["cut"];
    for (const r of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
      if (values.length >= SQL_MAX_ROWS) {
        cut = "rows";
        break;
      }
      const row = columns.map((_, i) => r[`c${i}`]);
      for (const v of row) bytes += typeof v === "string" ? v.length : 8;
      values.push(row);
      if (bytes > SQL_OUTPUT_BYTES) {
        cut = "bytes";
        break;
      }
    }
    stmt.finalize();
    return cut ? { columns, values, cut } : { columns, values };
  } catch (e) {
    throw new StatsError(sqlMessage(e), 1);
  }
}

// ---------------------------------------------------------------- the child

/**
 * Writes the whole text and waits until it is out: the command ends in `process.exit`, and with the sql child `console.log` to a pipe
 * came out cut (an answer of MBs), while `Bun.write(Bun.stdout, …)` hung (Bun 1.3.14).
 */
export const writeAll = (stream: NodeJS.WriteStream, text: string): Promise<void> => new Promise((done) => void stream.write(text, () => done()));

/** The variable that makes `gluon stats-sql` run (and names the database): nothing else starts it, so the words are free for a session's prompt. */
export const SQL_CHILD_ENV = "GLUON_STATS_SQL_DB";

/** A number JSON can't carry (SQLite's Infinity) travels as text. */
const wire = (_: string, v: unknown): unknown => (typeof v === "number" && !Number.isFinite(v) ? { num: String(v) } : v);
const unwire = (_: string, v: unknown): unknown => (v && typeof v === "object" && "num" in v && Object.keys(v).length === 1 ? Number((v as { num: string }).num) : v);

export type ChildAnswer = { ok: QueryResult } | { error: string; code: number };

export const encodeAnswer = (a: ChildAnswer): string => JSON.stringify(a, wire);
export const decodeAnswer = (text: string): ChildAnswer => JSON.parse(text, unwire) as ChildAnswer;

/** The child's own hard deadline in ms (set by the parent: its deadline plus a grace), for when the parent can't kill it. */
export const SQL_CHILD_LIMIT_ENV = "GLUON_STATS_SQL_LIMIT_MS";
/** How long after the parent's deadline the child ends itself. */
export const SQL_CHILD_GRACE_MS = 3_000;
/**
 * The child's own memory cap in bytes above what it used at start, set by the parent where SQLite doesn't enforce `hard_heap_limit`:
 * macOS, where `bun:sqlite` is Apple's build (it keeps no memory statistics, so the limit is never reached). Past it the watchdog writes
 * `SQL_MEMORY_MARK` to stderr and ends the child (SIGKILL); the parent reads the mark as the out-of-memory refusal. Not a signal of its
 * own: Bun on macOS names signals by Linux's numbers (a SIGUSR2 arrived as SIGSYS). A single allocation may overshoot the cap briefly.
 */
export const SQL_CHILD_MEMORY_ENV = "GLUON_STATS_SQL_MEMORY_BYTES";
/** The line the watchdog writes before it ends a child past its memory cap. */
export const SQL_MEMORY_MARK = "gluon-stats-sql: memory cap";

/** The watchdog's code, run in a Worker made from a Blob (no file to bundle or to resolve from the cwd): a thread of its own, so it runs while the main one is inside a SQLite step. */
const WATCHDOG = `
self.onmessage = (e) => {
  const { parent, pid, limit, memory, mark } = e.data;
  const start = Date.now();
  const base = process.memoryUsage.rss();
  let tick = 0;
  setInterval(() => {
    if (memory > 0 && process.memoryUsage.rss() - base > memory) {
      require("node:fs").writeSync(2, mark + "\\n");
      process.kill(pid, "SIGKILL");
    }
    if (++tick % 10) return;
    let orphan = false;
    try { process.kill(parent, 0); } catch (err) { orphan = err.code === "ESRCH"; }
    if (orphan || Date.now() - start > limit) process.kill(pid, "SIGKILL");
  }, 25);
  postMessage("ready");
};`;

/**
 * Ends this process by SIGKILL when its parent is gone (a killed `gluon stats sql` must not leave a query running: the orphan of the
 * incident ran 16 hours), when `limit` ms have passed, or once it uses `memory` bytes more than at start (0: no cap; it says
 * `SQL_MEMORY_MARK` first), from a thread of its own. Resolves once the watchdog runs; never throws: the parent's deadline is the first line, this is the second.
 */
async function watchdog(limit: number, memory: number): Promise<void> {
  try {
    const url = URL.createObjectURL(new Blob([WATCHDOG], { type: "text/javascript" }));
    const w = new Worker(url);
    await new Promise<void>((ready) => {
      w.onmessage = () => ready();
      w.onerror = () => ready();
      w.postMessage({ parent: process.ppid, pid: process.pid, limit, memory, mark: SQL_MEMORY_MARK });
      setTimeout(ready, 2_000);
    });
  } catch {}
}

/** `gluon stats-sql`: reads the query from stdin, answers one JSON document on stdout; always exits 0 once it answered. */
export async function statsSqlChild(): Promise<number> {
  const path = process.env[SQL_CHILD_ENV]!;
  const query = await Bun.stdin.text();
  await watchdog(Number(process.env[SQL_CHILD_LIMIT_ENV]) || 15_000, Number(process.env[SQL_CHILD_MEMORY_ENV]) || 0);
  let answer: ChildAnswer;
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.run("PRAGMA query_only=1");
      answer = { ok: runQuery(db, query) };
    } finally {
      db.close();
    }
  } catch (e) {
    answer = e instanceof StatsError ? { error: e.message, code: e.code } : { error: `couldn't read ${path}: ${line((e as Error).message)}`, code: 1 };
  }
  await writeAll(process.stdout, encodeAnswer(answer));
  return 0;
}
