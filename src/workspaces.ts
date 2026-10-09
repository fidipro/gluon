/**
 * Saved meta-sessions ("workspaces"): one Gluon run in a repository and the sessions in it, kept
 * so `gluon resume <id>` can reopen them. One private file each in `<config dir>/workspaces/`.
 *
 * Holds what is needed to relaunch: the repository's directory and, per session, the agent triple,
 * the spec (keys masked) and the harness's own resume id. Never the brain chat, a key, an
 * environment or anything the agent's screen showed. A resume id comes only from Gluon (it mints
 * it, `--session-id`) or from the agent's own hook (`session` event): never from another tool's
 * files. The file is read as untrusted text: every field is checked, and an id that could be read
 * as an option never reaches an argv.
 *
 * The file is written whole on every change and names the writing Gluon's process id, so `gluon
 * resume` refuses a workspace another live Gluon has open (`--force` skips the check; a dead id
 * never blocks). A session that ends (its agent exits, a yes at Delete, `/clear`, `/compact`)
 * leaves the record; quitting Gluon, a signal or a crash keeps it, since the agents that then exit
 * are not sessions that ended. A directory a record can't hold (a network path, control or
 * direction characters) is recorded not at all.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { EFFORTS } from "./agent/effort.ts";
import { configPath, type Effort, type Harness } from "./config.ts";
import { longPath, neutralCwd } from "./detect.ts";
import { safeLine } from "./events.ts";
import { HARNESSES, MODES, type Mode } from "./harnesses.ts";
import { knownSecretValues, maskSecrets, SECRET_ENV, writePrivate, writePrivateExclusive } from "./secrets.ts";

/** Where a session's resume id came from: minted by Gluon before the launch, or sent by the agent's hook. */
export type ResumeSource = "minted" | "captured";

export interface ChildRecord {
  /** Local to the workspace and stable across resumes; the process's row ids are not. */
  key: string;
  name: string;
  harness: Harness;
  model: string;
  effort?: Effort;
  /**
   * The mode the session was started in (`build` when none was asked). A resume applies it again where the harness loses it (`resumedLaunch`,
   * `src/launchers.ts`); a record from before Gluon saved it has none (`modeLostOnResume`).
   */
  mode?: Mode;
  /** The spec the session started with (keys masked). */
  spec: string;
  done?: boolean;
  startedAt: number;
  resume?: { id: string; source: ResumeSource };
}

export interface Workspace {
  v: 1;
  id: string;
  name: string;
  /** The directory Gluon ran in: a resume runs there too (the harnesses find their sessions by it). */
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** The Gluon that last wrote it (`Recorder`): `gluon resume` refuses a workspace another live Gluon has open (`ownerAlive`). */
  pid?: number;
  /** When that process started (`processStart`'s token), so a pid reused by another process isn't taken for the Gluon. Absent where the platform can't tell. */
  start?: string;
  sessions: ChildRecord[];
}

export const WORKSPACE_ID = /^[a-z2-7]{6}$/;
/** A harness's session id (a UUID, OpenCode's `ses_…`): never starts with `-`, so it is never an option. */
export const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEY = /^[A-Za-z0-9-]{1,64}$/;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_SESSIONS = 200;
/** The most characters a workspace's or a session's name keeps. */
const NAME_MAX = 200;
/**
 * The most characters a session's spec can have to be saved with it: the reader drops a longer one, so the
 * brain refuses to propose one (`parseProposal`, `src/agent/choices.ts`) and the writer refuses to record one (`unreadableReason`).
 */
export const MAX_SPEC = 1_000_000;

export const workspacesDir = (): string => join(dirname(configPath()), "workspaces");
const fileOf = (id: string): string => join(workspacesDir(), `${id}.json`);
/** The claim on a workspace (`claimWorkspace`) lives beside its file. */
const lockOf = (id: string): string => join(workspacesDir(), `${id}.lock`);

/** A new id: six characters of base32 (lowercase, no look-alikes with digits 0, 1, 8, 9). */
export function newWorkspaceId(taken: (id: string) => boolean = (id) => existsSync(fileOf(id))): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  for (;;) {
    const id = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => alphabet[b % 32]).join("");
    if (!taken(id)) return id;
  }
}

/** A workspace named for its repository and the day it started: `myrepo · Oct 4`. */
export function workspaceName(cwd: string, at: number): string {
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
  const day = ` · ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  // The reader keeps a name of NAME_MAX characters at most: a long directory name is cut, never the whole file lost (BUG-634).
  const room = NAME_MAX - day.length;
  if (base.length <= room) return `${base}${day}`;
  let cut = "";
  for (const ch of base) {
    if (cut.length + ch.length > room - 1) break;
    cut += ch;
  }
  return `${cut}…${day}`;
}

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
/** Text of the file that Gluon draws (names, models): one safe line, as any text an agent sends (BUG-291). */
const shown = (v: unknown, max: number, mask = true): string | null => {
  if (!isStr(v, max)) return null;
  const line = safeLine(mask ? maskSecrets(v) : v, max);
  return line || null;
};
/** Controls, line separators and the bidi controls that reorder what is drawn: none in a path that messages show (the rest of a real path is kept as it is: BUG-291). */
const UNSAFE_IN_PATH = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/**
 * Why `v` can't be the directory of a saved workspace, or null: absolute, on this machine (a UNC
 * path would make Windows sign in to a host the file names), and with nothing in it a message could
 * not show safely.
 */
export function dirProblem(v: unknown): string | null {
  if (!isStr(v, 4096)) return "its path is empty or too long";
  if (!isAbsolute(v) && !win32.isAbsolute(v)) return "its path isn't absolute";
  if (/^[\\/]{2}/.test(v)) return "it is a network (UNC) path";
  if (UNSAFE_IN_PATH.test(v)) return "its path has control or direction characters";
  return null;
}
/** A directory a workspace may be saved in and a resume enter (`dirProblem`). */
export const isSavableDir = (v: unknown): v is string => dirProblem(v) === null;
/** A time a Date can show (`toISOString` throws beyond its range: BUG-294). */
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 8.64e15;

/** `mask` false: the name was masked already (the writer checks records it has masked, and masking runs a set of regexes). */
function parseChild(v: unknown, mask = true): ChildRecord | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== "string" || !KEY.test(o.key)) return null;
  const name = shown(o.name, NAME_MAX, mask);
  // A model id is never a secret: masking it would only lose the session.
  const model = shown(o.model, NAME_MAX, false);
  if (!name || !model || model !== o.model || !HARNESSES.includes(o.harness as Harness)) return null;
  if (typeof o.spec !== "string" || o.spec.length > MAX_SPEC || !isTime(o.startedAt)) return null;
  if (o.effort !== undefined && !EFFORTS.includes(o.effort as Effort)) return null;
  // An unknown mode is a bad record, like an unknown effort: a mode Gluon doesn't know is never guessed (it could be read-only).
  if (o.mode !== undefined && !MODES.includes(o.mode as Mode)) return null;
  const child: ChildRecord = { key: o.key, name, harness: o.harness as Harness, model, spec: o.spec, startedAt: o.startedAt };
  if (o.effort !== undefined) child.effort = o.effort as Effort;
  if (o.mode !== undefined) child.mode = o.mode as Mode;
  if (o.done === true) child.done = true;
  const r = o.resume as Record<string, unknown> | undefined;
  // A bad resume id only loses the resume: the session can still be relaunched from its spec.
  if (r && typeof r.id === "string" && RESUME_ID.test(r.id) && (r.source === "minted" || r.source === "captured")) child.resume = { id: r.id, source: r.source };
  // Fields no longer kept (an older Gluon's `worktree`) are dropped here: the record loads without them.
  return child;
}

/** A process id as written by `Recorder`: a safe positive integer, nothing else. */
const isPid = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
/** A process start token as `processStart` makes it: short, plain characters. */
const isStart = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(v);

/** A workspace file's text, strictly; null when it isn't one (a session that isn't valid is dropped, the rest kept). */
export function parseWorkspace(text: string): Workspace | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || typeof o.id !== "string" || !WORKSPACE_ID.test(o.id)) return null;
  const name = shown(o.name, NAME_MAX);
  if (!name || !isSavableDir(o.cwd) || !isTime(o.createdAt) || !isTime(o.updatedAt) || !Array.isArray(o.sessions)) return null;
  // A key names one session: a second with the same key is dropped.
  const sessions = o.sessions.slice(0, MAX_SESSIONS).flatMap((s) => parseChild(s) ?? []).filter((c, i, all) => all.findIndex((d) => d.key === c.key) === i);
  return { v: 1, id: o.id, name, cwd: o.cwd, createdAt: o.createdAt, updatedAt: o.updatedAt, ...(isPid(o.pid) ? { pid: o.pid } : {}), ...(isPid(o.pid) && isStart(o.start) ? { start: o.start } : {}), sessions };
}

/**
 * A session's name and spec with keys masked, kept per record: masking runs a set of regexes over the
 * whole spec (up to 1 MB), and a record is checked and written on every change of the workspace.
 * What `maskSecrets` hides depends on the secret values Gluon knows when it runs, and a key can be
 * added while a record lives: an entry holds only for the set it was made with (`knownSignature`).
 */
const maskCache = new WeakMap<ChildRecord, { name: string; spec: string; known: string; maskedName: string; maskedSpec: string }>();
const knownSignature = (): string => knownSecretValues(SECRET_ENV).sort().join("\0");
function maskedChild(s: ChildRecord, known: string): ChildRecord {
  let e = maskCache.get(s);
  if (!e || e.name !== s.name || e.spec !== s.spec || e.known !== known) {
    e = { name: s.name, spec: s.spec, known, maskedName: maskSecrets(s.name), maskedSpec: maskSecrets(s.spec) };
    maskCache.set(s, e);
  }
  return { ...s, name: e.maskedName, spec: e.maskedSpec };
}

/** The fields of a record the reader checks or changes; the name is only tidied (safeLine) and the spec is kept as it is (its length is checked on its own). */
const CHILD_FIELDS = ["key", "harness", "model", "effort", "mode", "done", "startedAt", "resume"] as const;
/** Any other field would be written as it is, unmasked, and read back as nothing. */
const KNOWN_FIELDS = new Set<string>([...CHILD_FIELDS, "name", "spec"]);
const HEADER_FIELDS = new Set<string>(["v", "id", "name", "cwd", "createdAt", "updatedAt", "pid", "start", "sessions"]);

/**
 * What goes to disk for `ws` (keys masked), or why the reader would not load it whole: its limits
 * (sessions, spec, file size) and every field `parseChild` checks. The writer refuses what the
 * reader can't load and says so; it never cuts a record to fit, and never writes a field the reader
 * would drop (BUG-635, 636). Checked on the records themselves, not on a parse of the text: the
 * masked text is made once and is the one that is written.
 */
function prepare(ws: Workspace): { text: string } | { why: string } {
  if (ws.sessions.length > MAX_SESSIONS) return { why: `a saved workspace holds at most ${MAX_SESSIONS} sessions` };
  const known = knownSignature();
  const m: Workspace = { ...ws, name: maskSecrets(ws.name), sessions: ws.sessions.map((s) => maskedChild(s, known)) };
  const extra = (o: object, fields: Set<string>) => Object.entries(o).some(([k, v]) => v !== undefined && !fields.has(k));
  if (extra(m, HEADER_FIELDS) || m.sessions.some((s) => extra(s, KNOWN_FIELDS))) return { why: "a record has a field the reader doesn't keep" };
  for (const s of m.sessions) {
    if (s.spec.length > MAX_SPEC) return { why: `its spec is ${s.spec.length.toLocaleString("en-US")} characters, over the ${MAX_SPEC.toLocaleString("en-US")} a saved session keeps` };
  }
  // The workspace's own fields (no sessions here: those are checked below, one by one).
  if (!parseWorkspace(JSON.stringify({ ...m, sessions: [] }))) return { why: "its record isn't valid" };
  if (new Set(m.sessions.map((s) => s.key)).size !== m.sessions.length) return { why: "a session's record isn't valid" };
  for (const s of m.sessions) {
    const read = parseChild(s, false);
    if (!read) return { why: "a session's record isn't valid" };
    // `done: false` is no record of anything: the reader keeps only `true`.
    const written: Record<string, unknown> = { ...s, done: s.done || undefined };
    const field = CHILD_FIELDS.find((k) => written[k] !== read[k] && !Bun.deepEquals(written[k], read[k]));
    // The name is the user's text (up to 200 characters, any line breaks): one short line in a message.
    if (field) return { why: `the ${field} of session "${safeLine(s.name, 40)}" isn't valid (the reader would drop it)` };
  }
  const text = `${JSON.stringify(m, null, 2)}\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_FILE) return { why: `the saved workspace would be ${(bytes / 1048576).toFixed(1)} MB, over the ${MAX_FILE / 1048576} MB that can be read back` };
  return { text };
}

/** Why `ws`, written as it is, would not be read back whole (`prepare`), or null. */
export function unreadableReason(ws: Workspace): string | null {
  const p = prepare(ws);
  return "why" in p ? p.why : null;
}

/**
 * Writes the workspace privately; with no sessions left, removes its file instead. Returns icacls' warning, if any.
 * Throws, writing nothing, when the reader couldn't load what would be written (`prepare`).
 */
export function saveWorkspace(ws: Workspace): string | undefined {
  const path = fileOf(ws.id);
  if (ws.sessions.length === 0) {
    rmSync(path, { force: true });
    return undefined;
  }
  const p = prepare(ws);
  if ("why" in p) throw new Error(`it wouldn't read back: ${p.why}`);
  return writePrivate(path, p.text);
}

export function loadWorkspace(id: string): Workspace | null {
  if (!WORKSPACE_ID.test(id)) return null;
  try {
    const path = fileOf(id);
    // A file Gluon wrote is a plain file: a link, a pipe or a device (which could be endless) is not read.
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const ws = parseWorkspace(readFileSync(path, "utf8"));
    // The file name is the id `gluon resume` and `--delete` are given: a copy under another name is not that workspace (BUG-637).
    return ws && ws.id === id ? ws : null;
  } catch {
    return null;
  }
}

const isDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The saved workspaces, the most recently updated first, and the ids of the files named like one that
 * can't be read (a crash mid-write, a hand edit, a newer build, a copy under another name): those
 * can still be deleted by id (BUG-638).
 */
export function scanWorkspaces(): { saved: Workspace[]; unreadable: string[] } {
  let names: string[];
  try {
    names = readdirSync(workspacesDir());
  } catch {
    return { saved: [], unreadable: [] };
  }
  const saved: Workspace[] = [];
  const unreadable: string[] = [];
  for (const n of names.sort()) {
    const m = /^([a-z2-7]{6})\.json$/.exec(n);
    if (!m) continue;
    const ws = loadWorkspace(m[1]!);
    if (ws) saved.push(ws);
    else if (!isDirectory(fileOf(m[1]!))) unreadable.push(m[1]!);
  }
  return { saved: saved.sort((a, b) => b.updatedAt - a.updatedAt), unreadable };
}

/** Every saved workspace, the most recently updated first (a file that isn't valid is skipped: `scanWorkspaces` names those). */
export const listWorkspaces = (): Workspace[] => scanWorkspaces().saved;

/** The workspace an id or a unique prefix of one names. */
export function findWorkspace(prefix: string, all: Workspace[] = listWorkspaces()): { ws: Workspace } | { error: string } {
  const p = prefix.trim().toLowerCase();
  if (!p) return { error: "no id given" };
  const hits = all.filter((w) => w.id === p || w.id.startsWith(p));
  const exact = hits.find((w) => w.id === p);
  if (exact) return { ws: exact };
  if (hits.length === 1) return { ws: hits[0]! };
  return { error: hits.length ? `"${prefix}" matches ${hits.map((w) => w.id).join(", ")}` : `no saved session "${prefix}" (gluon sessions lists them)` };
}

/** A time as the user's clock shows it, with its offset from UTC (`2026-10-06 19:30 UTC-04:00`; `UTC` alone where it is 0): the list is read where the sessions were made (QA-resume-10). */
export function localTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const zone = off === 0 ? "UTC" : `UTC${off < 0 ? "-" : "+"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${zone}`;
}

/** The saved workspace's text for `gluon sessions`: id, name, count, when (local time and offset), directory. */
export function describeWorkspace(ws: Workspace): string {
  const n = ws.sessions.length;
  return `${ws.id}  ${ws.name}  ${n} session${n === 1 ? "" : "s"}  ${localTime(ws.updatedAt)}  ${ws.cwd}`;
}

/**
 * The saved workspace's directory is `cwd` (compared as the OS does: case on Windows, and long paths
 * where they matter). The long form (`longPath`, a call into the file system) is asked for only when
 * the plain spellings differ and both are on one drive: a workspace saved on another drive, a
 * disconnected mapped one included, is never touched, and none is for display or sorting alone.
 */
export function sameDir(a: string, b: string, platform: NodeJS.Platform = process.platform, long: (p: string) => string = longPath): boolean {
  const plain = (p: string) => {
    const s = platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p;
    return s.length > 1 ? s.replace(/[\\/]+$/, "") : s;
  };
  if (plain(a) === plain(b)) return true;
  if (platform !== "win32") return false;
  const drive = (p: string) => /^[a-z]:/.exec(plain(p))?.[0];
  return drive(a) !== undefined && drive(a) === drive(b) && plain(long(a)) === plain(long(b));
}

/** Whether another process with this id is running (this one, or no valid id, is not). Signal 0 only asks (it works on Windows too, in Bun); EPERM is a process of someone else's, so alive. */
export function processAlive(pid: number, kill: (pid: number, signal: 0) => unknown = (p, sig) => process.kill(p, sig)): boolean {
  if (!isPid(pid) || pid === process.pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When a process started, as an opaque token: equal for the same process, different for a later one
 * that got the same pid (pids are reused after a reboot, at once in a container). Linux:
 * `/proc/<pid>/stat` and the boot id. Windows: Windows PowerShell by its full path (unverified on
 * Windows). macOS has no such file and Gluon spawns no `ps`: there it is `undefined` and every
 * check falls back to the pid alone (unverified; QA-resume-01 stays open there). Also `undefined`
 * when the process is gone or its file is unreadable.
 */
export function processStart(
  pid: number,
  o: { platform?: NodeJS.Platform; read?: (path: string) => string; powershell?: (pid: number) => string | undefined } = {},
): string | undefined {
  if (!isPid(pid)) return undefined;
  const platform = o.platform ?? process.platform;
  const read = o.read ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    if (platform === "linux") {
      const stat = read(`/proc/${pid}/stat`);
      // The command name (field 2) may hold spaces and parentheses: the fields after the last ")" start at 3 (state), so starttime (22) is index 19.
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (!ticks || !/^\d{1,18}$/.test(ticks)) return undefined;
      let boot = "";
      try {
        boot = read("/proc/sys/kernel/random/boot_id").trim().replace(/[^A-Za-z0-9-]/g, "");
      } catch {}
      return boot ? `${boot}:${ticks}` : ticks;
    }
    if (platform === "win32") {
      const ft = (o.powershell ?? windowsStartTime)(pid);
      return ft && /^\d{15,19}$/.test(ft) ? ft : undefined;
    }
  } catch {}
  return undefined;
}

/** A Windows process's start as a FILETIME, by Windows PowerShell's full path, in a directory of Gluon's own (never the repository). */
function windowsStartTime(pid: number): string | undefined {
  const exe = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const r = Bun.spawnSync([exe, "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { cwd: neutralCwd(), stdin: "ignore", stdout: "pipe", stderr: "ignore", env: process.env, timeout: 10_000 });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
}

let ownStartCache: { value: string | undefined } | undefined;
/** This process's start, read once. */
export function ownStart(): string | undefined {
  return (ownStartCache ??= { value: processStart(process.pid) }).value;
}

export interface Owner {
  pid: number;
  /** `processStart`'s token, when it could be read. */
  start?: string;
}

/**
 * Whether the Gluon that wrote `owner` is still running: another process with that pid, started
 * when the record says. A record with no start (an older file, or a platform that can't read one),
 * or a process whose start can't be read now, is decided by the pid alone.
 */
export function ownerAlive(owner: Owner, o: { alive?: (pid: number) => boolean; startOf?: (pid: number) => string | undefined } = {}): boolean {
  if (!(o.alive ?? processAlive)(owner.pid)) return false;
  if (owner.start === undefined) return true;
  const now = (o.startOf ?? processStart)(owner.pid);
  return now === undefined || now === owner.start;
}

const ownerOf = (ws: Workspace): Owner | undefined => (ws.pid !== undefined ? { pid: ws.pid, ...(ws.start !== undefined ? { start: ws.start } : {}) } : undefined);

/** The pid of the live Gluon that has this saved workspace open (its claim, or the pid it last wrote), or undefined. */
export function liveOwner(ws: Workspace): number | undefined {
  const lock = readLockAt(lockOf(ws.id));
  if (lock && ownerAlive(lock.owner)) return lock.owner.pid;
  const owner = ownerOf(ws);
  return owner && ownerAlive(owner) ? owner.pid : undefined;
}

const lockText = (o: Owner): string => `${JSON.stringify({ v: 1, pid: o.pid, ...(o.start !== undefined ? { start: o.start } : {}) })}\n`;

function parseLock(raw: string): { owner: Owner; raw: string } | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || !isPid(v.pid)) return null;
    return { owner: { pid: v.pid, ...(isStart(v.start) ? { start: v.start } : {}) }, raw };
  } catch {
    return null;
  }
}

function readLockAt(path: string): { owner: Owner; raw: string } | null {
  const raw = rawOf(path);
  return raw === undefined ? null : parseLock(raw);
}

/** A claim file's text; undefined when there is none. Anything else (not a plain file, too big, unreadable) is a marker that equals only itself. */
function rawOf(path: string): string | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 4096) return `\0other:${st.ino}:${st.size}`;
    return readFileSync(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "\0unreadable";
  }
}

/** The claim files this process holds (path to content), taken off at exit. */
const held = new Map<string, string>();
let releaseSet = false;
function holdLock(path: string, text: string): void {
  held.set(path, text);
  if (releaseSet) return;
  releaseSet = true;
  // Only a claim that is still ours: a `--force` resume may have taken it over. A crash leaves a stale one, which the next claim takes over (its owner is dead).
  process.on("exit", () => {
    for (const [p, t] of held) {
      try {
        if (readFileSync(p, "utf8") === t) rmSync(p, { force: true });
      } catch {}
    }
  });
}

/** A takeover file older than this belongs to a process that crashed inside the takeover. */
const TAKEOVER_STALE_MS = 10_000;

/**
 * Takes the exclusive claim on a saved workspace, right after `gluon resume` checked it (the
 * Recorder only writes the pid about a second later, so two Gluons started together both passed the
 * check: QA-resume-02). The claim file is created exclusively and privately (`writePrivateExclusive`);
 * one whose owner is gone (a crash) or is another process by that pid is taken over, a live one
 * refuses with its pid unless `force`. A claim that can't be made for another reason (a read-only
 * directory) lets the resume go on, as it did before: the file's own pid check still ran.
 *
 * A takeover is serialised by a second exclusive file, `<id>.lock.takeover`: under it the claim is
 * removed only if it still is the exact stale one that was judged (nobody else replaces a claim
 * without the takeover file, and the fast path only creates where there is none), so a live claim is
 * never moved or put back, and two processes never both end up holding it. The takeover file of a
 * process that crashed inside it is stale after `TAKEOVER_STALE_MS`.
 * On a filesystem without hard links a claim is created in place and a reader could see it half
 * written (read as garbled, so taken for stale): acceptable for a file of two numbers.
 */
export function claimWorkspace(id: string, o: { force?: boolean; owner?: Owner; alive?: (owner: Owner) => boolean } = {}): { ok: true } | { ok: false; pid?: number } {
  if (!WORKSPACE_ID.test(id)) return { ok: true };
  const start = ownStart();
  const me: Owner = o.owner ?? { pid: process.pid, ...(start !== undefined ? { start } : {}) };
  const alive = o.alive ?? ((w: Owner) => ownerAlive(w));
  const path = lockOf(id);
  const text = lockText(me);
  const mutex = `${path}.takeover`;
  let holder: number | undefined;
  try {
    for (let tries = 0; tries < 200; tries++) {
      if (writePrivateExclusive(path, text)) {
        holdLock(path, text);
        return { ok: true };
      }
      // One read: the text that is judged is the text that may be removed.
      const judged = rawOf(path);
      const cur = judged === undefined ? null : parseLock(judged);
      holder = cur?.owner.pid;
      if (cur && !o.force && alive(cur.owner)) return { ok: false, pid: holder };
      // Stale, garbled or forced: only one process at a time may remove it.
      if (!writePrivateExclusive(mutex, text)) {
        try {
          const held = readLockAt(mutex);
          if ((held && !alive(held.owner)) || Date.now() - lstatSync(mutex).mtimeMs > TAKEOVER_STALE_MS) rmSync(mutex, { force: true });
        } catch {}
        Bun.sleepSync(10);
        continue;
      }
      try {
        // Only the exact claim that was judged: anything else is someone else's and is judged again. No file is nobody's to remove: a claim made at this
        // moment (the fast path above needs no takeover file) would be removed. A file that is there cannot be replaced by anyone but this process.
        const now = rawOf(path);
        if (judged !== undefined && now === judged) rmSync(path, { force: true });
      } finally {
        rmSync(mutex, { force: true });
      }
    }
  } catch {
    return { ok: true };
  }
  return { ok: false, ...(holder !== undefined ? { pid: holder } : {}) };
}

/** The pids of Gluons running with a saved workspace open (a live claim or a last-written pid): what `gluon uninstall` must not remove files under. */
export function runningGluons(dir = workspacesDir()): number[] {
  const pids = new Set<number>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const n of names) {
    const m = /^[a-z2-7]{6}\.(json|lock)$/.exec(n);
    if (!m) continue;
    try {
      const path = join(dir, n);
      if (m[1] === "lock") {
        const lock = readLockAt(path);
        if (lock && ownerAlive(lock.owner)) pids.add(lock.owner.pid);
        continue;
      }
      const st = lstatSync(path);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      const ws = parseWorkspace(readFileSync(path, "utf8"));
      const owner = ws && ownerOf(ws);
      if (owner && ownerAlive(owner)) pids.add(owner.pid);
    } catch {}
  }
  return [...pids].sort((a, b) => a - b);
}

/** Removes one saved workspace's file and nothing else; false when there was none. */
export function deleteWorkspace(id: string): boolean {
  if (!WORKSPACE_ID.test(id)) return false;
  // lstat, not exists: a dangling link is an entry of this directory too, and rm removes the link, never what it names.
  try {
    lstatSync(fileOf(id));
  } catch {
    return false;
  }
  rmSync(fileOf(id), { force: true });
  // Its claim goes with it (a stale one; `--force` on a live Gluon is the user's word).
  rmSync(lockOf(id), { force: true });
  return true;
}

/** What a session adds to a record: everything but the key, which the record gives. */
export type NewChild = Omit<ChildRecord, "key">;

/**
 * The running Gluon's saved workspace: created at the first session launched (an empty Gluon
 * saves nothing) or continuing a resumed one, and rewritten on every change. A failed write never
 * stops Gluon: `onError` hears it once. With no sessions left the file goes (`saveWorkspace`).
 */
export class Recorder {
  private ws: Workspace | null;
  private failed = false;
  /** Why this directory can't be saved (a network path, control characters): then nothing is recorded. */
  private unsavable: string | null;

  constructor(
    private cwd: string,
    resumed: Workspace | undefined,
    private o: { now?: () => number; save?: (ws: Workspace) => string | undefined; onError?: (message: string) => void; pid?: number; start?: string } = {},
  ) {
    this.ws = resumed ? structuredClone(resumed) : null;
    // A resumed workspace's directory passed the same check when it was read.
    this.unsavable = resumed ? null : dirProblem(cwd);
  }

  /**
   * A resumed workspace is this Gluon's from the start: its file names this process (`gluon resume` refuses the id while it runs).
   * The exclusive claim itself was taken earlier, in `main.tsx` right after the check (`claimWorkspace`): this write comes about a second later.
   */
  claim(): void {
    if (this.ws && this.ws.sessions.length > 0) this.write();
  }

  private get now() {
    return (this.o.now ?? Date.now)();
  }

  /** The id, once the record exists with a session in it (what `gluon resume` takes); null otherwise. */
  get id(): string | null {
    return this.ws && this.ws.sessions.length > 0 ? this.ws.id : null;
  }

  get children(): readonly ChildRecord[] {
    return this.ws?.sessions ?? [];
  }

  get(key: string): ChildRecord | undefined {
    return this.ws?.sessions.find((s) => s.key === key);
  }

  private fail(message: string): void {
    if (!this.failed) this.o.onError?.(message);
    this.failed = true;
  }

  /** A session that isn't recorded is told at once, each one: unlike a failed write it isn't the same news twice. */
  private refuse(message: string): void {
    this.o.onError?.(message);
  }

  private write(): void {
    if (!this.ws) return;
    this.ws.updatedAt = this.now;
    this.ws.pid = this.o.pid ?? process.pid;
    // This process's start, unless a test names another pid; where it can't be read the file carries none (pid alone).
    const start = this.o.pid === undefined ? ownStart() : this.o.start;
    if (start !== undefined) this.ws.start = start;
    else delete this.ws.start;
    try {
      const warning = (this.o.save ?? saveWorkspace)(this.ws);
      if (warning) this.fail(warning);
    } catch (e) {
      this.fail(`couldn't save the session record: ${(e as Error).message}`);
    }
  }

  /** A new session in the record (the first one creates the workspace). */
  add(child: NewChild): ChildRecord {
    if (!this.ws && this.unsavable) {
      // Nothing is kept and no id is announced; the one who asked is told why, once. The record that comes back is no part of any file.
      this.fail(`this directory can't be saved for resume: ${this.unsavable}`);
      return { key: crypto.randomUUID().slice(0, 8), ...child };
    }
    if (!this.ws) {
      const now = this.now;
      this.ws = { v: 1, id: newWorkspaceId(), name: workspaceName(this.cwd, now), cwd: this.cwd, createdAt: now, updatedAt: now, sessions: [] };
    }
    let key: string;
    do key = crypto.randomUUID().slice(0, 8);
    while (this.ws.sessions.some((s) => s.key === key));
    const record: ChildRecord = { key, ...child };
    // What the reader couldn't load is not written, and it doesn't take the sessions already saved with it (BUG-635, 636): this one runs on, unrecorded.
    const why = unreadableReason({ ...this.ws, sessions: [...this.ws.sessions, record] });
    if (why) {
      this.refuse(`this session can't be saved for resume: ${why}`);
      return record;
    }
    this.ws.sessions.push(record);
    this.write();
    return record;
  }

  /** Changes fields of a session (a key set to undefined is removed); nothing is written when nothing changed. */
  update(key: string, patch: Partial<NewChild>): void {
    const child = this.get(key);
    if (!child) return;
    let changed = false;
    for (const [k, v] of Object.entries(patch) as [keyof NewChild, unknown][]) {
      const old = child[k];
      if (JSON.stringify(old) === JSON.stringify(v)) continue;
      changed = true;
      if (v === undefined) delete child[k];
      else (child as unknown as Record<string, unknown>)[k] = v;
    }
    if (changed) this.write();
  }

  /** A session left the record (it ended); the last one takes the file with it. */
  remove(key: string): void {
    if (!this.ws || !this.get(key)) return;
    this.ws.sessions = this.ws.sessions.filter((s) => s.key !== key);
    this.write();
  }
}
