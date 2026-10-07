/**
 * The channel from a launched agent back to Gluon (issue #13). Per UI launch Gluon makes a
 * private directory outside the repository and names it in the agent's environment; a hook or
 * plugin inside the agent (or the agent itself, on the user's yes) runs `gluon signal back` or
 * `gluon hook …`, which drops one small file there; Gluon polls the directory, ends the agent
 * and opens a new session.
 *
 * Compaction handshake (`on_compact: ask`):
 * - Auto-compaction: the harness's `PreCompact` hook writes `compact <id>` (a random id) and waits
 *   (`waitAnswer`) for `<id>.answer`. no, or no answer in time: Gluon writes "no" (`writeAnswer`)
 *   and the hook lets it compact. yes: Gluon ends the agent without answering (a stopped
 *   compaction would print the harness's "blocked" line, BUG-151); the hook goes with the agent,
 *   or ends quietly once the events directory is gone.
 * - Typed `/compact`: the PTY asks before the agent sees the Enter. At a no the Enter is never
 *   sent (BUG-234): nothing compacts, so no hook asks again.
 *
 * Status (display only): a harness's hooks (or OpenCode's plugin) write `status {json}` — the
 * agent is working, awaiting the user, or done with its turn; its latest activity; cost and context
 * figures where the harness has them. A status never ends or holds the agent (`StatusInfo`).
 *
 * Session id (Codex's hooks, OpenCode's plugin): `session <id>` — the harness's own id for its
 * conversation, kept so `gluon resume` can reopen it (`src/workspaces.ts`). The first valid one
 * of a launch counts (`AgentSession.onSessionId`); the id must pass `SESSION_ID`.
 *
 * Any process the agent starts inherits the variables and can write an event: the worst it can do
 * is end the session, or show a wrong status. Events are fixed names; an id is checked and never
 * shown or used as a path; a status is parsed strictly and its text made safe to draw
 * (`parseStatus`).
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskSecrets, privateDir } from "./secrets.ts";

/** The events directory. */
export const EVENTS_ENV = "GLUON_EVENTS";
/** The enabled pieces, comma-separated (`handoffPieces`). */
export const HANDOFF_ENV = "GLUON_HANDOFF";
/** An executable (absolute path) that runs Gluon with the arguments it's given (`self.ts`). */
export const SELF_ENV = "GLUON_SELF";
/** Scrubbed at start (`startup.ts`): a Gluon started inside an agent never reuses its channel. */
export const CHANNEL_ENV = [EVENTS_ENV, HANDOFF_ENV, SELF_ENV];

/**
 * back: return to Gluon (`/gluon`, or the agent on the user's yes); compact: the agent is
 * about to compact on its own and its `PreCompact` hook waits for the user's answer (with an id:
 * Gluon asks, then `writeAnswer`); status: what the agent is doing (`StatusInfo`, display only);
 * session: the agent's own session id (for `gluon resume`).
 */
export const EVENTS = ["back", "compact", "status", "session"] as const;
export type EventName = (typeof EVENTS)[number];
export interface AgentEvent {
  name: EventName;
  id?: string;
  /** A `status` event's content (theirs only). */
  status?: StatusInfo;
}

/**
 * working: on a turn; awaiting: waiting for the user (a permission prompt, a question); done: its
 * turn ended. Not the Done group: Gluon shows it as awaiting input (`runState`, BUG-193).
 */
export const AGENT_STATES = ["working", "awaiting", "done"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/**
 * A `status` event: any subset of these, display only, never acted on. The figures are the
 * harness's own: `costUsd` the session's total so far (USD), `contextTokens` what the last request
 * left in the context, counted as that harness's own display counts it (OpenCode: input + cache +
 * output + reasoning), and `contextWindow` its model's window, where the harness knows them.
 * `contextTokens: null`: the context is unknown until the next request (it was just compacted).
 */
export interface StatusInfo {
  state?: AgentState;
  /** One line: the tool and its target ("Bash: bun test", "Read src/cli.tsx"); already safe to draw. */
  activity?: string;
  costUsd?: number;
  contextTokens?: number | null;
  contextWindow?: number;
  /** The model the figures are for (provider/model ids: letters, digits and `._:/@[]-`). */
  model?: string;
  /**
   * OpenCode's plugin: each step's (or compaction's) own token counts, never merged (a price tier
   * is chosen by one step's prompt) and delivered once (`src/cost/`). At most `MAX_STEPS` per event.
   */
  steps?: StepUsage[];
  /** Codex's `PreCompact` hook: a compaction is starting (its own request's prompt is no context of the conversation). */
  compacting?: true;
  /**
   * Antigravity's status line: the conversation's token totals (`input` is its size: the context, `src/cost/antigravity.ts`;
   * a new conversation after `/clear` starts at zero). Not a cost: the command runs on redraws, not per request.
   */
  totals?: { input: number; output: number };
}

/** One OpenCode step: a counter (`n`, the plugin's, increasing), the model as `provider/model`, the five counts and OpenCode's own cost of it. */
export interface StepUsage {
  n: number;
  model: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
  /**
   * What this record does to the context of the conversation on screen (a session no other started): "step" its tokens
   * are the context, "compacted" it is unknown until the next step. None: a subagent's, another session's, a failed compaction's, a side request's.
   */
  context?: "step" | "compacted";
  /** A request OpenCode billed but sent no step for (the session title), its tokens left over in the session's usage: priced at the session's model, an assumption. */
  side?: true;
}

export const MAX_STEPS = 25;

/**
 * Each OpenCode step once, by the plugin's counter. The counter restarts at 1 when the plugin reloads or a second follower
 * starts: a number below the last seen begins a new count (the records after it are not repeats: BUG-402). A number equal to
 * the last one is a repeat, left out and counted (`repeated`) so the audit can say so.
 */
export function stepGate(): (steps: StepUsage[]) => { fresh: StepUsage[]; repeated: number } {
  let last = 0;
  return (steps) => {
    const fresh: StepUsage[] = [];
    let repeated = 0;
    for (const st of steps) {
      if (st.n < last) last = 0;
      if (st.n === last) repeated++;
      else {
        last = st.n;
        fresh.push(st);
      }
    }
    return { fresh, repeated };
  };
}

export const EVENTS_PREFIX = "gluon-events-";
const ID = /^[A-Za-z0-9-]{1,64}$/;
/**
 * A harness's session id: the same pattern as `RESUME_ID` (`workspaces.ts`; `test/events.test.ts`
 * pins them equal), kept here so a hook process doesn't load the config. Never starts with `-`.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_EVENT_BYTES = 256;
/** A `status` event carries JSON: a larger cap, still small. */
export const MAX_STATUS_BYTES = 4096;
/** An activity line's length once made safe (characters). */
export const ACTIVITY_MAX = 120;

// Terminal escapes (CSI, OSC, DCS/SOS/PM/APC strings, two-byte ESC sequences, their 8-bit forms),
// C0/C1 controls and DEL, line/paragraph separators, and every format character (Unicode Cf: the
// bidi controls U+061C, U+200E/F, U+202A–E, U+2066–9 that reorder what's drawn, zero-width and
// invisible characters, tags): none may reach the screen from an agent. A zero-width joiner only
// goes (an emoji sequence falls apart into its pieces); the others become a space.
const ESCAPE_SEQ = /\x1b\[[0-?]*[ -/]*[@-~]?|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]?|\x9b[0-?]*[ -/]*[@-~]?|[\x90\x98\x9d-\x9f][^\x07\x1b\x9c]*[\x07\x9c]?/g;
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** Text an agent sent, made one line safe to draw, of at most `max` characters (an ellipsis when cut). */
export function safeLine(text: string, max = ACTIVITY_MAX): string {
  const line = text.replace(ESCAPE_SEQ, " ").replace(/\u200d/g, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

const MODEL = /^[A-Za-z0-9._:/@[\]-]{1,128}$/;
/** The bounds of a sane figure (cost in USD, tokens). */
const LIMITS = { costUsd: 1e6, contextTokens: 1e9, contextWindow: 1e9 } as const;
const figure = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;

/**
 * A status event's JSON, strictly: an object whose known fields have the right types and bounds
 * (one that doesn't refuses the whole event); unknown fields are dropped. The activity is made a
 * safe line, dropped when empty. Null when nothing valid is left.
 */
export function parseStatus(json: string): StatusInfo | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: StatusInfo = {};
  if (o.state !== undefined) {
    if (!AGENT_STATES.includes(o.state as AgentState)) return null;
    out.state = o.state as AgentState;
  }
  if (o.activity !== undefined) {
    if (typeof o.activity !== "string") return null;
    // A command line can carry a key: masked like anything Gluon shows.
    const line = safeLine(maskSecrets(o.activity.slice(0, MAX_STATUS_BYTES)));
    if (line) out.activity = line;
  }
  for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const n = o[k];
    if (n === undefined) continue;
    if (k === "contextTokens" && n === null) {
      out.contextTokens = null;
      continue;
    }
    if (!figure(n, LIMITS[k])) return null;
    out[k] = k === "costUsd" ? n : Math.round(n);
  }
  if (o.model !== undefined) {
    if (typeof o.model !== "string" || !MODEL.test(o.model)) return null;
    out.model = o.model;
  }
  if (o.compacting !== undefined) {
    if (o.compacting !== true) return null;
    out.compacting = true;
  }
  if (o.totals !== undefined) {
    const t = o.totals as Record<string, unknown> | null;
    if (!t || typeof t !== "object" || Array.isArray(t) || !figure(t.input, 1e12) || !figure(t.output, 1e12)) return null;
    out.totals = { input: Math.round(t.input), output: Math.round(t.output) };
  }
  if (o.steps !== undefined) {
    if (!Array.isArray(o.steps) || o.steps.length === 0 || o.steps.length > MAX_STEPS) return null;
    const steps: StepUsage[] = [];
    for (const raw of o.steps) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const r = raw as Record<string, unknown>;
      const counts = [r.input, r.output, r.reasoning, r.cacheRead, r.cacheWrite];
      if (typeof r.model !== "string" || !MODEL.test(r.model) || !figure(r.n, 1e9) || !counts.every((c) => figure(c, 1e12))) return null;
      if (r.cost !== undefined && !figure(r.cost, LIMITS.costUsd)) return null;
      if ((r.context !== undefined && r.context !== "step" && r.context !== "compacted") || (r.side !== undefined && r.side !== true)) return null;
      steps.push({ n: Math.round(r.n as number), model: r.model, input: Math.round(r.input as number), output: Math.round(r.output as number), reasoning: Math.round(r.reasoning as number), cacheRead: Math.round(r.cacheRead as number), cacheWrite: Math.round(r.cacheWrite as number), ...(r.cost !== undefined ? { cost: r.cost as number } : {}), ...(r.context ? { context: r.context } : {}), ...(r.side ? { side: true as const } : {}) });
    }
    out.steps = steps;
  }
  return Object.keys(out).length ? out : null;
}

/** `<name>`, `<name> <id>`, `session <id>` or `status <json>`, or null when it isn't a valid event. */
export function parseEvent(text: string): AgentEvent | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("status ")) {
    const status = parseStatus(trimmed.slice("status ".length));
    return status ? { name: "status", status } : null;
  }
  const [name, id, ...rest] = trimmed.split(" ");
  if (rest.length || name === "status" || !EVENTS.includes(name as EventName)) return null;
  if (name === "session" ? id === undefined || !SESSION_ID.test(id) : id !== undefined && !ID.test(id)) return null;
  return id === undefined ? { name: name as EventName } : { name: name as EventName, id };
}

export const formatEvent = (e: AgentEvent) => (e.name === "status" ? `status ${JSON.stringify(e.status ?? {})}` : e.id ? `${e.name} ${e.id}` : e.name);

/** A private events directory for one launch, with this process's pid (a sweep keeps a live one). */
export function createEventsDir(tmp = tmpdir()): { dir: string; warning?: string } {
  const made = privateDir(tmp, EVENTS_PREFIX, process.platform === "win32");
  writeFileSync(join(made.dir, "pid"), String(process.pid), { mode: 0o600 });
  return made;
}

let written = 0;

/** Writes one event into an existing directory (never creates it); false when it can't. */
export function writeEvent(dir: string, e: AgentEvent): boolean {
  const text = formatEvent(e);
  if (!parseEvent(text) || Buffer.byteLength(text) > (e.name === "status" ? MAX_STATUS_BYTES : MAX_EVENT_BYTES)) return false;
  try {
    // Sorts by time, then by order within this process; the random part keeps names unique.
    const name = `${String(Date.now()).padStart(15, "0")}-${String(++written).padStart(6, "0")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.event`;
    writeFileSync(join(dir, name), formatEvent(e), { mode: 0o600, flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Events taken per `readEvents` call: a backlog drains over several polls, never in one long block. */
export const EVENTS_PER_READ = 200;

/**
 * An event file's bytes, or null when it isn't a plain file of at most `max` bytes. Never blocks
 * and never follows a link: anything the agent's processes can put in the directory (a FIFO, a
 * device, a symlink, a file swapped between the checks) is skipped (BUG-165).
 */
export function readSmallFile(path: string, max: number): Buffer | null {
  const before = lstatSync(path);
  if (!before.isFile() || before.size > max) return null;
  // O_NONBLOCK: a FIFO swapped in after the lstat opens at once (and fails the fstat); O_NOFOLLOW:
  // a symlink swapped in fails to open. Windows has neither (and no FIFOs in a directory).
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max || st.ino !== before.ino || st.dev !== before.dev) return null;
    const buf = Buffer.alloc(max + 1);
    const n = readSync(fd, buf, 0, max + 1, 0);
    return n > max ? null : buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Valid events not seen before (`seen` collects file names; names no longer in the directory
 * leave it, so it stays as small as the directory), oldest first, at most `EVENTS_PER_READ` per
 * call (the rest at the next); anything else is ignored, and a file over the caps, or not a plain
 * file, is never read (`readSmallFile`). A status file is removed once read (a long session writes
 * one per tool call); the others stay for the launch.
 */
export function readEvents(dir: string, seen: Set<string>, limit = EVENTS_PER_READ): AgentEvent[] {
  return scanEvents(dir, seen, limit).events;
}

/** `readEvents`, and whether names remain unread (the limit cut the batch): then the next call must read again. */
export function scanEvents(dir: string, seen: Set<string>, limit: number): { events: AgentEvent[]; more: boolean } {
  let all: string[];
  try {
    all = readdirSync(dir).filter((n) => n.endsWith(".event"));
  } catch {
    return { events: [], more: false };
  }
  const present = new Set(all);
  for (const n of seen) if (!present.has(n)) seen.delete(n);
  const unseen = all.filter((n) => !seen.has(n)).sort();
  const names = unseen.slice(0, limit);
  const out: AgentEvent[] = [];
  for (const n of names) {
    seen.add(n);
    const path = join(dir, n);
    try {
      const bytes = readSmallFile(path, MAX_STATUS_BYTES);
      if (!bytes) continue;
      const text = bytes.toString("utf8");
      const status = text.startsWith("status ");
      // A status, and a session id (Codex sends one with every hook): taken once, the file goes, so
      // a long session doesn't fill the directory (BUG-296).
      if (status || text.startsWith("session ")) {
        unlinkSync(path);
        seen.delete(n);
      }
      const e = bytes.length <= (status ? MAX_STATUS_BYTES : MAX_EVENT_BYTES) ? parseEvent(text) : null;
      if (e) out.push(e);
    } catch {}
  }
  return { events: out, more: unseen.length > names.length };
}

/**
 * A directory change younger than this is not trusted as "nothing new": a file created in the same
 * timestamp tick after our listing leaves the same time (git's "racy" case). Some file systems keep
 * times to 1 s (HFS+, ext3, some NFS and overlays) or 2 s (FAT): longer than the coarsest tick.
 */
export const RACY_MS = 2500;
/** The backstop: whatever the directory's time says, it is listed at least this often. */
export const FULL_LIST_MS = 2000;

/** What `EventsWatch` reads of a directory's status (`statSync` with `bigint`): a test passes coarser times. */
export type DirStat = { dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint };

export interface EventsWatchSeams {
  scan?: typeof scanEvents;
  now?: () => number;
  stat?: (dir: string) => DirStat;
  /** False: every read lists (Windows). */
  skipping?: boolean;
}

/**
 * One session's events directory, polled often (`AgentSession`, every `POLL_MS`) by many sessions
 * at once. `read()` is `readEvents`, but a directory whose status (inode, change time) is the
 * one the last complete listing saw, and old enough not to be racy (`RACY_MS`), is not listed again
 * (QA-perf-03). Never skipped: after a batch cut by the limit, on Windows (its directory times are
 * not relied on), whenever the directory can't be examined, and at least every `FULL_LIST_MS`.
 */
export class EventsWatch {
  readonly seen = new Set<string>();
  private clean: string | null = null;
  private listedAt = -Infinity;
  private readonly scan: typeof scanEvents;
  private readonly now: () => number;
  private readonly stat: (dir: string) => DirStat;
  private readonly skipping: boolean;
  constructor(
    private readonly dir: string,
    seams: EventsWatchSeams = {},
  ) {
    this.scan = seams.scan ?? scanEvents;
    this.now = seams.now ?? Date.now;
    this.stat = seams.stat ?? ((d) => statSync(d, { bigint: true }));
    this.skipping = seams.skipping ?? process.platform !== "win32";
  }

  read(): AgentEvent[] {
    let sig: string | null = null;
    let old = false;
    const at = this.now();
    if (this.skipping) {
      try {
        const st = this.stat(this.dir);
        sig = `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
        old = Number(st.ctimeNs / 1_000_000n) + RACY_MS <= at && Number(st.mtimeNs / 1_000_000n) + RACY_MS <= at;
      } catch {}
    }
    if (sig !== null && sig === this.clean && at - this.listedAt < FULL_LIST_MS) return [];
    this.listedAt = at;
    const r = this.scan(this.dir, this.seen, EVENTS_PER_READ);
    this.clean = sig !== null && old && !r.more ? sig : null;
    return r.events;
  }
}

export const removeEventsDir = (dir: string) => rmSync(dir, { recursive: true, force: true });

/** Gluon's answer to a `compact <id>` event: yes = return to Gluon (the hook stops the compaction). */
export function writeAnswer(dir: string, id: string, yes: boolean): void {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return;
  try {
    writeFileSync(join(dir, `${id}.answer`), yes ? "yes" : "no", { mode: 0o600 });
  } catch {}
}

/**
 * The hook's side: waits for the answer to its `compact <id>` event; null when none came in time,
 * or the events directory is gone (Gluon ended the agent: the user chose to return).
 */
export async function waitAnswer(dir: string, id: string, timeoutMs: number, pollMs = 100): Promise<boolean | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const bytes = readSmallFile(join(dir, `${id}.answer`), 16);
      if (bytes) return bytes.toString("utf8") === "yes";
    } catch {}
    if (!existsSync(dir)) return null;
    await Bun.sleep(pollMs);
  }
  return null;
}
