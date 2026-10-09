/**
 * Local analytics: one row per launched session in `<state dir>/analytics.db` (SQLite, `bun:sqlite`),
 * queried by `gluon stats` (`stats.ts`). On by default, `analytics: off` stops recording; private
 * like the cost ledger (directory 0700 first, the file 0600 before SQLite opens it, so its `-wal`
 * and `-shm` take its mode; on Windows the file and, as soon as SQLite has made them, the `-wal` and `-shm` get their own ACL). Holds the spec (keys masked), the repository's path and the agent's
 * own session id: never a key, an environment or anything the agent's screen showed. Recording never
 * breaks a launch: every write is caught and dropped (an end is tried again).
 */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, openSync, realpathSync, constants as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Figure } from "./cost/tracker.ts";
import { privateTree, stateDir } from "./cost/ledger-file.ts";
import { maskSecrets, restrictToUser } from "./secrets.ts";

/** `<state dir>/analytics.db`. */
export function analyticsPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(stateDir(env, platform), "analytics.db");
}

/** Schema steps, applied in order; `PRAGMA user_version` is how many ran. Append, never edit. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    child_key TEXT,
    workspace_id TEXT,
    name TEXT NOT NULL,
    cwd TEXT,
    repo TEXT,
    branch TEXT,
    worktree_path TEXT,
    worktree_branch TEXT,
    harness TEXT NOT NULL,
    harness_version TEXT,
    model TEXT NOT NULL,
    effort TEXT,
    mode TEXT,
    conn TEXT,
    routing_types TEXT,
    routing_why TEXT,
    spec TEXT NOT NULL,
    agent_session_id TEXT,
    agent_session_source TEXT,
    gluon_version TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    exit_code INTEGER,
    end_reason TEXT,
    cost_usd REAL,
    cost_approx INTEGER,
    cost_own INTEGER,
    cost_billed INTEGER,
    context_pct INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_started ON sessions(started_at);
  CREATE INDEX sessions_agent ON sessions(harness, model);
  CREATE INDEX sessions_repo ON sessions(repo);
  CREATE INDEX sessions_agent_id ON sessions(agent_session_id);`,
];

/** How a row came to be: a new session, a resumed one, a restart (`/clear`, a respawn) or a one-shot `--launch`. */
export type RunKind = "new" | "resume" | "restart" | "launch";

/** A `sessions` row as stored (times in epoch ms; booleans 0/1; JSON arrays as text). */
export interface SessionRow {
  id: string;
  kind: RunKind;
  child_key: string | null;
  workspace_id: string | null;
  name: string;
  cwd: string | null;
  repo: string | null;
  branch: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  harness: string;
  harness_version: string | null;
  model: string;
  effort: string | null;
  mode: string | null;
  conn: string | null;
  routing_types: string | null;
  routing_why: string | null;
  spec: string;
  agent_session_id: string | null;
  agent_session_source: string | null;
  gluon_version: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  end_reason: string | null;
  cost_usd: number | null;
  cost_approx: number | null;
  cost_own: number | null;
  cost_billed: number | null;
  context_pct: number | null;
  updated_at: number;
}

/** A live Gluon refreshes `updated_at` at least this often; a row older than this without an end was left by a crash. */
export const HEARTBEAT_MS = 60_000;

export type RunStatus = "ended" | "running" | "unfinished";

/** Derived at query time: no reaper ever rewrites a row. */
export function runStatus(row: Pick<SessionRow, "ended_at" | "updated_at">, now: number): RunStatus {
  if (row.ended_at !== null) return "ended";
  return now - row.updated_at < HEARTBEAT_MS ? "running" : "unfinished";
}

/** What a session's row says about it from its start on; `set` can change any of it later (Gluon learns an id, a cost, a context reading while the agent runs). */
export interface RunState {
  /** The saved workspace's key of this session (`recorder`), to tell a resumed or restarted session's rows apart. */
  childKey?: string;
  workspaceId?: string;
  name: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  harness: string;
  harnessVersion?: string;
  model: string;
  effort?: string;
  mode?: string;
  conn?: string;
  /** `route`'s type names and its lines on why (JSON text in the row). */
  routingTypes?: string[];
  routingWhy?: string[];
  /** The spec as the user saw it (keys masked, capped at `SPEC_MAX`). */
  spec: string;
  /** The agent's own session id: Gluon's, minted for the launch, or the one the harness's hook sent. */
  agentSessionId?: string;
  agentSessionSource?: "minted" | "captured";
  gluonVersion?: string;
  cost?: Figure;
  /** Gluon's own context reading, 0 to 100; the last real one is kept (an unknown reading never erases it). */
  contextPct?: number;
}

export type RunStart = RunState & { kind: RunKind };

/** One session's row while Gluon runs it. Every method is safe to call at any time: nothing throws out of it. */
export interface Run {
  /** Changes what the row says; written at the next flush (`Analytics.tick`), at once once the run has ended (a late cost). */
  set(p: Partial<RunState>): void;
  /** The session is over: the row gets its end, the exit code and why, and is written now. Only the first call counts. */
  end(e: { code: number | null; reason: string; cost?: Figure; contextPct?: number }): void;
}

/** The longest spec a row keeps; the rest is cut. */
export const SPEC_MAX = 100_000;
/** An open row is written (changes, and `updated_at` as the heartbeat) at least this often by `tick`, and at most this often when only changes are waiting. */
export const FLUSH_MS = 15_000;
/** This many failures in a row switch the recorder off for the rest of the process: it never slows or breaks a launch. A busy or locked file is not one (it is tried again at the next tick). */
const MAX_FAILURES = 3;
/** How long a write waits for a lock another connection holds (a `gluon stats --delete`, a second Gluon): the UI is blocked that long per failed write. */
const BUSY_MS = 200;

const COLUMNS = [
  "id", "kind", "child_key", "workspace_id", "name", "cwd", "repo", "branch", "worktree_path", "worktree_branch", "harness", "harness_version", "model", "effort", "mode", "conn",
  "routing_types", "routing_why", "spec", "agent_session_id", "agent_session_source", "gluon_version", "started_at", "ended_at", "duration_ms", "exit_code", "end_reason",
  "cost_usd", "cost_approx", "cost_own", "cost_billed", "context_pct", "updated_at",
] as const satisfies readonly (keyof SessionRow)[];

/** A row's first write: the full row from memory (an upsert, so a first write that reached the file but not the caller is not a second row). */
const UPSERT = `INSERT INTO sessions (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => `$${c}`).join(", ")}) ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`;
/**
 * Every later write of a row that is in the file: the full row from memory too, so a dropped write heals at the next one,
 * but never an insert: a row that `gluon stats --delete` removed stays removed (BUG-565).
 */
const UPDATE = `UPDATE sessions SET ${COLUMNS.filter((c) => c !== "id").map((c) => `${c} = $${c}`).join(", ")} WHERE id = $id`;

/** SQLITE_BUSY / SQLITE_LOCKED: another connection holds the file; not a fault of this recorder. */
function isLocked(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^SQLITE_(BUSY|LOCKED)/.test(code);
}

type Statement = ReturnType<Database["prepare"]>;

const clean = (s: string | undefined): string | null => (s === undefined ? null : maskSecrets(s));
const int = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);
const flag = (b: boolean | undefined): number => (b ? 1 : 0);

/** The spec as stored: keys masked first (a cut could hide a key's shape), then capped. */
function cleanSpec(spec: string): string {
  const masked = maskSecrets(spec);
  return masked.length > SPEC_MAX ? `${masked.slice(0, SPEC_MAX)}…[truncated]` : masked;
}

interface Entry {
  id: string;
  kind: RunKind;
  state: RunState;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  reason: string | null;
  contextPct: number | null;
  lastFlush: number;
  dirty: boolean;
  /** The row is in the file (a write succeeded): later writes only update it. */
  written: boolean;
  /** An update found no row: it was deleted under us, and stays deleted. */
  gone: boolean;
}

export class Analytics {
  private readonly enabled: boolean;
  private readonly path: string;
  private readonly now: () => number;
  private readonly restrict: boolean;
  private db: Database | null = null;
  private upsert: Statement | null = null;
  private update: Statement | null = null;
  private opened = false;
  private off: boolean;
  private failures = 0;
  /** A write met a lock in this tick (or since the last one): the rest of the tick waits for the next one (BUG-649). */
  private busy = false;
  private readonly open = new Map<string, Entry>();

  private readonly restrictFile: (path: string) => unknown;

  /** `restrictFile` is the Windows ACL call on a file (`restrictToUser`); a seam so the order of calls is testable on Linux. */
  constructor(o: { enabled: boolean; path?: string; now?: () => number; restrict?: boolean; restrictFile?: (path: string) => unknown }) {
    this.enabled = o.enabled;
    this.off = !o.enabled;
    this.path = o.path ?? analyticsPath();
    this.now = o.now ?? Date.now;
    this.restrict = o.restrict ?? process.platform === "win32";
    this.restrictFile = o.restrictFile ?? ((p) => restrictToUser(p));
  }

  /** A session starts: its row is written now. Undefined when recording is off or failed (the caller carries on without it). */
  begin(start: RunStart): Run | undefined {
    try {
      if (this.off) return undefined;
      const { kind, ...rest } = start;
      const t = this.now();
      const e: Entry = { id: crypto.randomUUID(), kind, state: { name: "", harness: "", model: "", spec: "" }, startedAt: t, endedAt: null, exitCode: null, reason: null, contextPct: null, lastFlush: t, dirty: true, written: false, gone: false };
      this.assign(e, rest);
      this.guard(() => this.write(e));
      if (this.off) return undefined;
      this.open.set(e.id, e);
      return {
        set: (p) => this.set(e, p),
        end: (x) => this.finish(e, x),
      };
    } catch (err) {
      this.fail(err);
      return undefined;
    }
  }

  /**
   * Called from the app's periodic timer: writes the open rows whose last write is `FLUSH_MS` old (their changes, or just the heartbeat), and an ended row whose write failed, every time.
   * The first write to meet a lock ends the tick: each write would wait `BUSY_MS` for it, N sessions freezing the UI N x 200 ms (BUG-649); the rest go at the next tick.
   */
  tick(): void {
    try {
      if (this.off) return;
      this.busy = false;
      const t = this.now();
      for (const e of [...this.open.values()]) {
        if (this.off || this.busy) return;
        if (e.endedAt !== null || t - e.lastFlush >= FLUSH_MS) this.guard(() => this.write(e));
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /** Quitting: every session still open ends as "quit" (no exit code), an end that failed to be written gets its last try, and the file is closed. */
  close(): void {
    try {
      for (const e of [...this.open.values()]) {
        if (e.endedAt === null) this.finish(e, { code: null, reason: "quit" });
        else if (!this.off) this.guard(() => this.write(e));
      }
    } catch {}
    this.disable();
  }

  private set(e: Entry, p: Partial<RunState>): void {
    try {
      if (this.off || e.gone) return;
      this.assign(e, p);
      e.dirty = true;
      // After the end nothing else will write the row: a late cost goes through now.
      if (e.endedAt !== null) this.guard(() => this.write(e));
    } catch (err) {
      this.fail(err);
    }
  }

  private finish(e: Entry, x: { code: number | null; reason: string; cost?: Figure; contextPct?: number }): void {
    try {
      if (this.off || e.gone || e.endedAt !== null) return;
      if (x.cost) e.state.cost = x.cost;
      this.keepContext(e, x.contextPct);
      e.endedAt = Math.max(this.now(), e.startedAt);
      e.exitCode = int(x.code);
      e.reason = x.reason;
      e.dirty = true;
      // The entry stays open until the end is in the file: `tick` and `close` try again if this write fails.
      this.guard(() => this.write(e));
    } catch (err) {
      this.fail(err);
    }
  }

  /** Only defined values change the state; what came from the user's world (spec, names, paths, routing lines) is masked when it arrives, never held raw. */
  private assign(e: Entry, p: Partial<RunState>): void {
    const s = e.state;
    for (const [k, v] of Object.entries(p) as [keyof RunState, unknown][]) {
      if (v === undefined) continue;
      switch (k) {
        case "spec":
          s.spec = cleanSpec(String(v));
          break;
        case "name":
        case "cwd":
        case "repo":
        case "branch":
          s[k] = clean(String(v)) ?? "";
          break;
        case "routingTypes":
        case "routingWhy":
          s[k] = (v as string[]).map((x) => maskSecrets(String(x)));
          break;
        case "contextPct":
          this.keepContext(e, v as number);
          break;
        case "cost":
          s.cost = { ...(v as Figure) };
          break;
        default:
          (s as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }

  private keepContext(e: Entry, pct: number | undefined): void {
    const n = int(pct);
    if (n !== null) e.contextPct = n;
  }

  private row(e: Entry, t: number): Record<string, string | number | null> {
    const s = e.state;
    const f = s.cost;
    const ended = e.endedAt;
    return {
      id: e.id,
      kind: e.kind,
      child_key: s.childKey ?? null,
      workspace_id: s.workspaceId ?? null,
      name: s.name,
      cwd: s.cwd ?? null,
      repo: s.repo ?? null,
      branch: s.branch ?? null,
      // Sessions no longer get a worktree of Gluon's: the columns stay (`MIGRATIONS` only grow), empty.
      worktree_path: null,
      worktree_branch: null,
      harness: s.harness,
      harness_version: s.harnessVersion ?? null,
      model: s.model,
      effort: s.effort ?? null,
      mode: s.mode ?? null,
      conn: s.conn ?? null,
      routing_types: s.routingTypes ? JSON.stringify(s.routingTypes) : null,
      routing_why: s.routingWhy ? JSON.stringify(s.routingWhy) : null,
      spec: s.spec,
      agent_session_id: s.agentSessionId ?? null,
      agent_session_source: s.agentSessionSource ?? null,
      gluon_version: s.gluonVersion ?? null,
      started_at: e.startedAt,
      ended_at: ended,
      duration_ms: ended === null ? null : Math.max(0, ended - e.startedAt),
      exit_code: e.exitCode,
      end_reason: e.reason,
      cost_usd: f && Number.isFinite(f.usd) ? f.usd : null,
      cost_approx: f ? flag(f.approx) : null,
      cost_own: f ? flag(f.own) : null,
      cost_billed: f ? flag(f.billed) : null,
      context_pct: e.contextPct,
      updated_at: t,
    };
  }

  /**
   * The full row, from memory, into the file (opened on the first write): an upsert until a write has succeeded, an update after.
   * An ended row leaves `open` once it is in the file. Throws on failure: `guard` counts it.
   */
  private write(e: Entry): void {
    if (e.gone) {
      this.open.delete(e.id);
      return;
    }
    const st = this.statements();
    if (!st) return;
    const t = this.now();
    const params: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(this.row(e, t))) params[`$${k}`] = v;
    if (e.written) {
      if (st.update.run(params).changes === 0) {
        e.gone = true;
        this.open.delete(e.id);
        return;
      }
    } else {
      st.upsert.run(params);
      e.written = true;
    }
    e.lastFlush = t;
    e.dirty = false;
    if (e.endedAt !== null) this.open.delete(e.id);
  }

  private guard(f: () => void): void {
    try {
      f();
      this.failures = 0;
    } catch (e) {
      this.fail(e);
    }
  }

  /** A failed write counts toward `MAX_FAILURES`, unless the file was only locked: that is tried again at the next tick. */
  private fail(e?: unknown): void {
    if (isLocked(e)) {
      this.busy = true;
      return;
    }
    if (++this.failures >= MAX_FAILURES) this.disable();
  }

  /** Recording stops for good: the statements are finalized and the file is really closed (Bun's `close` does nothing while one is open). */
  private disable(): void {
    this.off = true;
    this.release();
    this.open.clear();
  }

  private release(): void {
    for (const st of [this.upsert, this.update]) {
      try {
        st?.finalize();
      } catch {}
    }
    this.upsert = null;
    this.update = null;
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }

  /** The prepared statements; the file is created and migrated at the first call. Null: recording is off (a newer file, or nothing to write). */
  private statements(): { upsert: Statement; update: Statement } | null {
    if (this.upsert && this.update) return { upsert: this.upsert, update: this.update };
    if (this.off || this.opened) return null;
    this.opened = true;
    try {
      this.db = openDatabase(this.path, this.restrict, this.restrictFile);
      if (!this.db) {
        this.disable();
        return null;
      }
      this.upsert = this.db.prepare(UPSERT);
      this.update = this.db.prepare(UPDATE);
    } catch (e) {
      this.opened = false;
      this.release();
      throw e;
    }
    return { upsert: this.upsert, update: this.update };
  }
}

/**
 * The database, private and migrated; null when its schema is newer than this Gluon's (it records nothing and never writes it).
 * The directory is made first (0700), the file before SQLite touches it (0600: its `-wal` and `-shm` take the mode of the file).
 */
function openDatabase(path: string, restrict: boolean, restrictFile: (path: string) => unknown): Database | null {
  // A state directory that is a symlink (a dotfiles setup) is followed once, here: `privateTree` refuses a link itself and checks the real directory (ours, mode 0700). A link at the file stays refused (O_NOFOLLOW below) (BUG-650).
  let dir = dirname(path);
  try {
    dir = realpathSync(dir);
  } catch {}
  path = join(dir, basename(path));
  privateTree(dir, restrict);
  const fd = openSync(path, fs.O_CREAT | fs.O_RDWR | (fs.O_NOFOLLOW ?? 0), 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("the analytics file is not a regular file");
    if (process.platform !== "win32") {
      if (process.getuid !== undefined && st.uid !== process.getuid()) throw new Error("the analytics file is not ours");
      if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    }
  } finally {
    closeSync(fd);
  }
  if (restrict) restrictFile(path);
  const db = new Database(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
    const version = () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    // A newer Gluon's file: not touched at all (not even the journal mode).
    if (version() > MIGRATIONS.length) {
      db.close();
      return null;
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    // The -wal and -shm (the -wal holds the specs not yet checkpointed) inherit the directory's ACL, not the file's: limit each as soon as it exists, before the first write (BUG-651).
    const limited = new Set<string>();
    const restrictJournal = () => {
      if (!restrict) return;
      for (const suffix of ["-wal", "-shm"]) {
        if (!limited.has(suffix) && existsSync(path + suffix)) {
          limited.add(suffix);
          restrictFile(path + suffix);
        }
      }
    };
    version();
    restrictJournal();
    if (version() < MIGRATIONS.length) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Read again inside the lock: another Gluon may have migrated while this one waited.
        const have = version();
        if (have > MIGRATIONS.length) {
          db.exec("ROLLBACK");
          db.close();
          return null;
        }
        for (let i = have; i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i]!);
        db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    }
    restrictJournal();
    // A -wal or -shm another version left looser than the file.
    if (process.platform !== "win32") {
      for (const suffix of ["-wal", "-shm"]) {
        try {
          chmodSync(path + suffix, 0o600);
        } catch {}
      }
    }
    return db;
  } catch (e) {
    try {
      db.close();
    } catch {}
    throw e;
  }
}
