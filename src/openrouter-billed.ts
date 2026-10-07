/**
 * What OpenRouter billed an OpenRouter session: the usage of the user's key (`GET /api/v1/key`, free, `data.usage` in USD), read before the
 * session starts and after it ends, is the session's exact cost (the user's decision, 2026-10-06). OpenRouter bills each request at the provider
 * that served it, so Gluon's tokens x table price can be off by 2x; the key's usage is what was charged.
 *
 * It holds only while nothing else spent on the key during the session: another OpenRouter session of Gluon on the same key (this process or
 * another: `Registry`) makes the delta unattributable, and Gluon says so instead of showing a figure. Use outside Gluon can't be seen:
 * that is what the notice "use an OpenRouter key only Gluon uses" (`OPENROUTER_KEY_NOTICE`) is for.
 *
 * Gluon's own brain on the same key is not part of any session (QA-cost-04): `brainSpend` (`src/cost/billed.ts`) keeps each brain reply's exact `usage.cost`
 * and when it ended; the meter takes off the replies that certainly landed between its baseline and its final reading (OpenRouter's usage shows a reply
 * `minLagMs` to `tailMs` after it ends), and a reply whose cost is unknown, or that may have landed before the baseline, leaves no figure (`brain`).
 * Other Gluon processes' brains are read from their `<pid>.brain` files (`BrainLog`, `Registry.foreignBrain`) the same way.
 *
 * OpenRouter's usage lags the requests by 30 to 110 s (30 to 90 in its docs; a live run saw its key's usage move 80 to 110 s after the requests), so:
 *   - while the session runs and is clean, a reading is taken every `sampleMs` while Gluon's own count changed (never idle), and the live figure
 *     is calibrated: k = usage so far / our estimate as it was one lag ago (`src/cost/billed.ts`), shown as k x estimate, marked `~`;
 *   - after it ends, the key is read every `pollMs` in the background until it has settled, giving up after `giveUpMs` (an unsettled record, no figure).
 *     When Gluon counted spend (`expectsUsage`), a usage that hasn't moved past the baseline is never a settle (it only hasn't landed yet: a live run
 *     settled at $0.00 that way): it settles once the usage moved, two consecutive readings agree and `landMs` have passed since the session's last
 *     request. A session with no counted spend settles at what the key shows (two equal readings and `settleMs` since the exit).
 *     Gluon quitting first leaves an unsettled record and no figure (`abandon`).
 * The key itself is read from Gluon's secrets and goes only into the Authorization header of that one request: never into process.env, a file or a log.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrainSpend, brainSpend, CALIBRATION_LAG_MS, overlap, ratio, EstimateHistory, type BrainShare, type Reading, type Window } from "./cost/billed.ts";
import { privateTree, registryDir } from "./cost/ledger-file.ts";
import type { Harness } from "./harnesses.ts";
import type { Ledger } from "./cost/ledger.ts";
import type { CostTracker } from "./cost/tracker.ts";
import { renameOver } from "./secrets.ts";
import { costLabel } from "./sessions.ts";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

export interface Timings {
  /** After the exit: how often the key is read. */
  pollMs: number;
  /** After the exit, for a session Gluon counted no spend for: the least time before a figure settles (two equal readings and this much since the exit). */
  settleMs: number;
  /** After the exit, for a session Gluon counted spend for: the least time since its last request before a figure settles (the usage moved, two equal readings and this much since the last request). */
  landMs: number;
  /** After the exit: when Gluon gives up (it must cover `landMs` after the last request, and the lag still unsettled after it). */
  giveUpMs: number;
  /** While running: the least time between two readings. */
  sampleMs: number;
  /** One request. */
  readTimeoutMs: number;
  /** How long after a session's last request its usage may still land (a window that ended without settling keeps this tail). */
  tailMs: number;
  /** The usage lag the live calibration compares across (`CALIBRATION_LAG_MS`). */
  lagMs: number;
  /** The least time after a request before OpenRouter's usage can show it (its docs: 30 s): a brain reply that ended less than this before a reading is not in it. */
  minLagMs: number;
}

export const TIMINGS: Timings = { pollMs: 15_000, settleMs: 30_000, landMs: 120_000, giveUpMs: 300_000, sampleMs: 45_000, readTimeoutMs: 5_000, tailMs: 150_000, lagMs: CALIBRATION_LAG_MS, minLagMs: 30_000 };

/** Where the key's usage is read, and how fast: the real endpoint, or (tests) the seam's. Null: no network (the offline test suite). */
export interface Source {
  base: string;
  timings: Timings;
}

declare const GLUON_BUILD: string | undefined;
/** The test seam's file ({ base, timings }), or undefined (always, in a release build). */
const seamPath = (env: Record<string, string | undefined>): string | undefined => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? undefined : env.GLUON_TEST_OPENROUTER);

/** The offline suite's probes seam (`src/verify.ts` `testProbesPath`, on `env`), folded away in release builds. */
const probesPath = (env: Record<string, string | undefined>): string | undefined => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? undefined : env.GLUON_TEST_PROBES);

/**
 * The real endpoint only when nothing says "test": the seam names its own server; the offline suite (its probes seam is on), a `bun test` process
 * (`NODE_ENV=test`) and a compiled test binary reach no network at all. Fails closed: a test that forgets the seam reads nothing.
 */
export function billedSource(env: Record<string, string | undefined> = process.env): Source | null {
  const path = seamPath(env);
  if (path) {
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as { base?: unknown; timings?: Partial<Timings> };
      if (typeof j.base === "string") return { base: j.base, timings: { ...TIMINGS, ...j.timings } };
    } catch {}
    return null;
  }
  // A release or npm build ignores NODE_ENV: a user's own `NODE_ENV=test` must not switch the billed reading off.
  const release = typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test";
  if ((typeof GLUON_BUILD === "string" && GLUON_BUILD === "test") || probesPath(env) || (!release && env.NODE_ENV === "test")) return null;
  return { base: OPENROUTER_API, timings: TIMINGS };
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "error" }) => Promise<Response>;

/** The key's usage in USD, or undefined (no answer, an error status, something else than a number: never throws, never says why: the key must not travel into a message). */
export async function readUsage(key: string, source: Source, f: Fetch = fetch as Fetch): Promise<number | undefined> {
  try {
    const r = await f(`${source.base}/key`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(source.timings.readTimeoutMs), redirect: "error" });
    if (!r.ok) return undefined;
    const u = ((await r.json()) as { data?: { usage?: unknown } } | null)?.data?.usage;
    return typeof u === "number" && Number.isFinite(u) && u >= 0 ? u : undefined;
  } catch {
    return undefined;
  }
}

/** Gluon's own, never the key: a key's identity on disk and in comparisons. */
export const keyTag = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 16);

interface Entry {
  v: 1;
  pid: number;
  key: string;
  start: number;
  end?: number;
}

/** Whether a process exists (signal 0 only tests). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const DAY_MS = 86_400_000;
/** A running session's file is touched every 30 s (`Registry.touch`): one untouched this long is not running, whatever its pid says (a pid is reused). */
export const STALE_MS = 300_000;

/** A small file in the registry directory: the directory private from the moment it exists, the file written whole under a temporary name and renamed over (never torn). */
function writePrivate(dir: string, name: string, text: string, restrict: boolean): void {
  privateTree(dir, restrict);
  const tmp = join(dir, `.${name}.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(tmp, 0o600);
    renameOver(tmp, join(dir, name));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The windows of Gluon's OpenRouter sessions on a key, across Gluon processes: one small file per session (`<pid>-<tag>.json`, written by its own
 * process alone, so two Gluons never write one file), in a private directory made before anything is put in it. A window is `start` (before the
 * first request) to `end` (when its usage had landed, or the exit plus the lag tail if it never settled); no `end` means running. A process that is
 * gone without writing one (a crash), or whose file wasn't touched for `STALE_MS` (its pid reused by another program), ended at its file's last touch plus the tail; a window of a day or more ago is removed. Holds a key's hash, never the key.
 */
export class Registry {
  private readonly own = new Map<string, Entry>();
  constructor(
    readonly dir = registryDir(),
    private readonly o: { pid?: number; now?: () => number; alive?: (pid: number) => boolean; tailMs?: number; restrict?: boolean } = {},
  ) {}

  private get now() {
    return this.o.now ?? Date.now;
  }

  private write(tag: string, e: Entry): void {
    writePrivate(this.dir, `${e.pid}-${tag}.json`, JSON.stringify(e), this.o.restrict ?? process.platform === "win32");
  }

  /** A session starts (call it before its first reading of the key). */
  register(tag: string, key: string, start: number): void {
    const e: Entry = { v: 1, pid: this.o.pid ?? process.pid, key, start };
    this.own.set(tag, e);
    try {
      this.write(tag, e);
    } catch {}
  }

  /** Its window ended at `end`. */
  close(tag: string, end: number): void {
    const e = this.own.get(tag);
    if (!e || e.end !== undefined) return;
    e.end = end;
    try {
      this.write(tag, e);
    } catch {}
  }

  /** Still running: its file's time moves, so a crash is dated. */
  touch(tag: string): void {
    const e = this.own.get(tag);
    if (!e) return;
    try {
      const t = new Date(this.now());
      utimesSync(join(this.dir, `${e.pid}-${tag}.json`), t, t);
    } catch {}
  }

  /** What other Gluon processes' brains did on their keys (their `<pid>.brain` files, see `BrainLog`), kept in memory: they age out of the files, not out of a running session's account. */
  private readonly foreign = new BrainSpend();
  /** Per process: the file's identity and the last record taken, so a file read twice counts once. */
  private readonly taken = new Map<number, { boot: string; n: number }>();

  /**
   * The brains of the other Gluon processes, read now: every `<pid>.brain` of a process that is not this one, those of dead processes too (their replies still land in
   * a key's usage until they age out). A file that can't be read whole (junk, torn, too big, another shape, not a regular file) says nothing about which replies it held: windows that start
   * before its last write plus the slowest lag are unknown. Never throws.
   */
  foreignBrain(): BrainSpend {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((f) => /^\d+\.brain$/.test(f));
    } catch {
      return this.foreign;
    }
    const mine = `${this.o.pid ?? process.pid}.brain`;
    const now = this.now();
    const isAlive = this.o.alive ?? alive;
    for (const f of names) {
      if (f === mine) continue;
      const path = join(this.dir, f);
      let mtime = now;
      // A file that can't be removed (a lock on Windows, a read-only directory) stays; it never stops the reading.
      const drop = () => {
        try {
          rmSync(path, { force: true });
        } catch {}
      };
      try {
        // Only a regular file is read: a directory, a symlink or a FIFO of that name is not ours (a FIFO would block the read), and says nothing: unreadable.
        const st = lstatSync(path);
        mtime = st.mtimeMs;
        if (!st.isFile()) {
          this.foreign.lose(mtime);
          continue;
        }
        if (st.size > BRAIN_FILE_MAX) throw new Error("big");
        const e = JSON.parse(readFileSync(path, "utf8")) as Partial<BrainFile>;
        if (e.v !== 1 || typeof e.pid !== "number" || typeof e.boot !== "string" || typeof e.lost !== "number" || !Array.isArray(e.calls)) throw new Error("shape");
        const calls: BrainRecord[] = e.calls.map((c) => {
          const r = c as Partial<BrainRecord> | null;
          if (!r || typeof r.n !== "number" || typeof r.key !== "string" || typeof r.end !== "number" || !Number.isFinite(r.end) || (r.usd !== null && typeof r.usd !== "number")) throw new Error("shape");
          return r as BrainRecord;
        });
        let seen = this.taken.get(e.pid);
        if (!seen || seen.boot !== e.boot) this.taken.set(e.pid, (seen = { boot: e.boot, n: 0 }));
        if (e.lost > 0) this.foreign.lose(e.lost);
        for (const c of calls) if (c.n > seen.n) this.foreign.record(c.key, c.end, c.usd ?? undefined);
        seen.n = Math.max(seen.n, ...calls.map((c) => c.n));
        // The file of a process that has been gone for a day has aged out.
        if (now - mtime > DAY_MS && !isAlive(e.pid)) drop();
      } catch {
        if (now - mtime > DAY_MS) drop();
        else this.foreign.lose(mtime);
      }
    }
    return this.foreign;
  }

  /** The windows of every other session of Gluon on this key (this process's other sessions too). */
  others(tag: string, key: string): Window[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    } catch {
      return [];
    }
    const now = this.now();
    const isAlive = this.o.alive ?? alive;
    const tail = this.o.tailMs ?? TIMINGS.tailMs;
    const out: Window[] = [];
    for (const f of names) {
      if (f.endsWith(`-${tag}.json`)) continue;
      const path = join(this.dir, f);
      try {
        const st = statSync(path);
        if (st.size > 4096) continue;
        const e = JSON.parse(readFileSync(path, "utf8")) as Partial<Entry>;
        if (typeof e.pid !== "number" || typeof e.start !== "number" || typeof e.key !== "string") continue;
        const running = isAlive(e.pid) && now - st.mtimeMs < STALE_MS;
        const end = typeof e.end === "number" ? e.end : running ? undefined : Math.min(st.mtimeMs, now) + tail; // a last touch in the future (clock ahead, VM restored) never ends a window later than now plus the tail (QA-cost-05, BUG-632)
        if (end !== undefined && end < now - DAY_MS) {
          rmSync(path, { force: true });
          continue;
        }
        if (e.key === key) out.push({ start: e.start, ...(end !== undefined ? { end } : {}) });
      } catch {}
    }
    return out;
  }
}

/** A brain file is never bigger (the cap below keeps it far under): a bigger one is not ours. */
const BRAIN_FILE_MAX = 65_536;
/** At most this many replies in a process's file. */
const BRAIN_FILE_CAP = 256;
/** A reply stays in its file this long beyond the slowest lag (`tailMs`): a running session reads the files every 30 s and keeps what it read. */
const BRAIN_MARGIN_MS = 600_000;

interface BrainRecord {
  /** Count in this process (a reader takes each once). */
  n: number;
  /** `keyTag`, never the key. */
  key: string;
  end: number;
  /** The reply's exact cost, null when not known. */
  usd: number | null;
}

interface BrainFile {
  v: 1;
  pid: number;
  /** This process's run: a pid another program reuses starts its count again. */
  boot: string;
  /** Replies that ended up to this time were dropped (age or cap): a window that starts before it can't be told. */
  lost: number;
  calls: BrainRecord[];
}

/**
 * This process's brain's replies on OpenRouter keys, for the other Gluon processes' meters (QA-cost-04): `<registry dir>/<pid>.brain`, one small file written whole
 * (private directory first, 0600, renamed over) at each reply. Key tags, times and costs only. Replies older than `tailMs` plus a margin are dropped from the file
 * (and the newest dropped is kept as `lost`), at most `BRAIN_FILE_CAP` stay; the file is never removed at exit: a dead process's replies still land in the key's usage
 * (a reader removes a dead process's file a day after its last write). Never throws.
 */
export class BrainLog {
  private readonly boot = randomBytes(4).toString("hex");
  private calls: BrainRecord[] = [];
  private lost = 0;
  private n = 0;
  constructor(
    private readonly dir?: string,
    private readonly o: { pid?: number; now?: () => number; tailMs?: number; restrict?: boolean } = {},
  ) {}

  record(key: string, end: number, usd: number | undefined): void {
    try {
      const pid = this.o.pid ?? process.pid;
      const keep = (this.o.tailMs ?? TIMINGS.tailMs) + BRAIN_MARGIN_MS;
      this.calls.push({ n: ++this.n, key, end, usd: typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : null });
      const now = (this.o.now ?? Date.now)();
      while (this.calls.length > BRAIN_FILE_CAP || (this.calls.length > 1 && this.calls[0]!.end < now - keep)) this.lost = Math.max(this.lost, this.calls.shift()!.end);
      const file: BrainFile = { v: 1, pid, boot: this.boot, lost: this.lost, calls: this.calls };
      writePrivate(this.dir ?? registryDir(), `${pid}.brain`, JSON.stringify(file), this.o.restrict ?? process.platform === "win32");
    } catch {}
  }
}

/** The process's brain log (`src/brain.ts` records through `recordBrainReply`). */
export const brainLog = new BrainLog();

/**
 * One reply of the brain on the OpenRouter key `tag` ended at `end` with this exact cost (undefined: not known): told to this process's meters (`brainSpend`)
 * and to the other Gluon processes' (`brainLog`).
 */
export function recordBrainReply(tag: string, end: number, usd: number | undefined): void {
  brainSpend.record(tag, end, usd);
  brainLog.record(tag, end, usd);
}

/** What became of the session's billed figure. */
export type BilledResult =
  | { status: "clean"; usd: number; /** The exact cost of Gluon's own brain's replies on this key that landed in the window, already taken off `usd`. */ brainUsd?: number }
  /** Another OpenRouter session of Gluon on the same key ran in the window: the delta isn't this session's. */
  | { status: "overlap" }
  /** Gluon's own brain spent on this key in the window and what it cost is not known exactly (or when it landed): the delta isn't the session's. */
  | { status: "brain" }
  /** Gluon quit, or the usage still moved at the end of the wait: no figure. */
  | { status: "unsettled"; why: "quit" | "timeout" }
  /** The key's usage couldn't be read (before the session, or at all after it), or went down. */
  | { status: "unreadable"; why: "no-baseline" | "read-failed" | "negative" };

export interface MeterOptions {
  key: string;
  source: Source;
  registry: Registry;
  /** Gluon's own brain's requests in this process (default: the process's `brainSpend`); the other processes' come from `registry`. Their cost is taken off the delta. */
  brain?: BrainSpend;
  fetch?: Fetch;
  now?: () => number;
  /** The live calibration moved (k, or undefined: back to the table price). */
  onCalibration?: (k: number | undefined) => void;
  /** The figure's fate, once (also when Gluon quits: `abandon`). */
  onSettled?: (r: BilledResult) => void;
}

export class BilledMeter {
  private readonly tag = randomBytes(4).toString("hex");
  private readonly id: string;
  private readonly now: () => number;
  private history = new EstimateHistory();
  private start = 0;
  private baseline: number | undefined;
  /** When the baseline was read. */
  private baseRead: Reading = { from: 0, to: 0 };
  private calibrating = true;
  private finished = false;
  private abandoned = false;
  private reported = false;
  private closed = false;
  private inflight = false;
  private lastSampleAt = 0;
  private lastSampleOwn = 0;
  private lastB = 0;
  private lastTouch = 0;
  /** Gluon's own count of the session: its estimate in USD, whether it expects the key's usage to move, and when it last grew (the last request). */
  private ownUsd = 0;
  private expects = false;
  private requests = 0;
  private lastRequestAt = 0;
  private wake: () => void = () => {};
  private woken: Promise<void>;
  /** The latest calibration. */
  k: number | undefined;

  private constructor(private readonly o: MeterOptions) {
    this.id = keyTag(o.key);
    this.now = o.now ?? Date.now;
    this.woken = new Promise<void>((r) => (this.wake = r));
  }

  /** Registers the session and reads the key's usage (bounded: a slow answer is no baseline, never a stuck launch). Never throws. */
  static async begin(o: MeterOptions): Promise<BilledMeter> {
    const m = new BilledMeter(o);
    m.start = m.lastSampleAt = m.lastTouch = m.lastRequestAt = m.now();
    o.registry.register(m.tag, m.id, m.start);
    m.baseline = await readUsage(o.key, o.source, o.fetch);
    m.baseRead = { from: m.start, to: m.now() };
    if (m.baseline === undefined) m.calibrating = false;
    return m;
  }

  private get t() {
    return this.o.source.timings;
  }

  private overlapped(): boolean {
    const mine: Window = { start: this.start };
    return this.o.registry.others(this.tag, this.id).some((w) => overlap(mine, w));
  }

  /** What Gluon's own brain did to the delta between the baseline and a reading (its replies on this key are not the session's). */
  private brainShare(final: Reading): BrainShare {
    const lag = { minMs: this.t.minLagMs, maxMs: this.t.tailMs };
    const own = (this.o.brain ?? brainSpend).share(this.id, this.baseRead, final, lag);
    // The other Gluon processes' brains on this key (their files, read now): no less the key's spend than this process's own.
    const others = this.o.registry.foreignBrain().share(this.id, this.baseRead, final, lag);
    return { usd: own.usd + others.usd, unknown: own.unknown || others.unknown, pending: own.pending || others.pending };
  }

  private close(end: number): void {
    if (this.closed) return;
    this.closed = true;
    this.o.registry.close(this.tag, end);
  }

  private report(r: BilledResult): BilledResult {
    if (!this.reported) {
      this.reported = true;
      try {
        this.o.onSettled?.(r);
      } catch {}
    }
    return r;
  }

  /**
   * Gluon's own estimate is `ownUsd` now: kept for the calibration's lag lookup, and the time of the session's last request. `expects`: Gluon counted
   * spend the key's usage must show (a priced request with a price above 0, or one it couldn't price): by default `ownUsd > 0`. `requests`: how many
   * requests Gluon counted (an unpriced one adds nothing to `ownUsd` but is a request: its usage lands later too).
   */
  observe(ownUsd: number, expects = ownUsd > 0, requests = this.requests): void {
    const t = this.now();
    this.history.push(t, ownUsd);
    if (ownUsd !== this.ownUsd || (expects && (!this.expects || requests !== this.requests))) this.lastRequestAt = t;
    this.requests = requests;
    this.ownUsd = ownUsd;
    this.expects ||= expects;
  }

  /**
   * Gluon's estimate was rewritten: requests it couldn't price (their table hadn't arrived) now are, so what it said before is no account of them. The
   * history starts again from `ownUsd` now, and the live ratio waits one lag (`lagMs`) for an estimate that holds the requests the key's usage holds;
   * the time of the last request is not moved (the requests happened when they were counted, not when they were priced).
   */
  restate(ownUsd: number): void {
    this.history = new EstimateHistory();
    this.history.push(this.now(), ownUsd);
    this.ownUsd = ownUsd;
    this.lastB = 0;
    if (this.k !== undefined) {
      this.k = undefined;
      this.o.onCalibration?.(undefined);
    }
  }

  /**
   * From the status timer: while the session runs and nothing else spends on the key, one reading at most every `sampleMs`, and only if our own count
   * changed since the last (an idle session is never polled), moves the live calibration. Never waits for the network.
   */
  tick(ownUsd: number, expects?: boolean, requests?: number): void {
    this.observe(ownUsd, expects, requests);
    if (this.finished || this.closed) return;
    const t = this.now();
    if (t - this.lastTouch >= 30_000) {
      this.lastTouch = t;
      this.o.registry.touch(this.tag);
      // The other brains' files are read at this pace too: a running session keeps what it read, whatever ages out of the files.
      this.o.registry.foreignBrain();
    }
    if (!this.calibrating || this.baseline === undefined || this.inflight || t - this.lastSampleAt < this.t.sampleMs || ownUsd === this.lastSampleOwn) return;
    this.inflight = true;
    this.lastSampleAt = t;
    this.lastSampleOwn = ownUsd;
    void this.sample().finally(() => (this.inflight = false));
  }

  private async sample(): Promise<void> {
    const from = this.now();
    const u = await readUsage(this.o.key, this.o.source, this.o.fetch);
    if (this.finished || !this.calibrating) return;
    // Another session on the key in the window: the usage is not ours, and stays not ours: back to the table price for good.
    if (this.overlapped()) {
      this.calibrating = false;
      this.k = undefined;
      this.o.onCalibration?.(undefined);
      return;
    }
    if (u === undefined || this.baseline === undefined) return;
    // The brain's replies that landed are not the session's; one that may or may not have landed leaves this reading out (the last k stands).
    const brain = this.brainShare({ from, to: this.now() });
    if (brain.unknown || brain.pending) return;
    const billed = u - this.baseline - brain.usd;
    // Usage that hasn't moved since the last reading says nothing new (it lags): the last k stands.
    if (billed <= this.lastB) return;
    this.lastB = billed;
    const k = ratio(billed, this.history.at(this.now() - this.t.lagMs));
    if (k === undefined) return;
    this.k = k;
    this.o.onCalibration?.(k);
  }

  /** Sleeps `ms` or until woken; the timer never outlives the wait (a quit or a cancel leaves none pending). */
  private async wait(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([new Promise<void>((r) => (timer = setTimeout(r, ms))), this.woken]);
    } finally {
      clearTimeout(timer);
    }
  }

  private result: Promise<BilledResult> | undefined;

  /**
   * The session ended: settles in the background (never awaited by the UI); the promise holds the result, `onSettled` gets it once. `own`: Gluon's
   * count at the exit (a request after the last tick is counted as of now); left out, what the ticks saw.
   */
  finish(own?: { usd: number; expects?: boolean; requests?: number }): Promise<BilledResult> {
    if (own && !this.result) this.observe(own.usd, own.expects, own.requests);
    this.result ??= this.settle();
    return this.result;
  }

  private async settle(): Promise<BilledResult> {
    const exitAt = this.now();
    this.finished = true;
    this.calibrating = false;
    const lagged = exitAt + this.t.tailMs;
    const expects = this.expects;
    if (this.baseline === undefined) {
      this.close(lagged);
      return this.report({ status: "unreadable", why: "no-baseline" });
    }
    // Two consecutive readings (a poll interval apart: the loop waits `pollMs` between them) that agree.
    let prev: number | undefined;
    let last: number | undefined;
    let lastRead: Reading = this.baseRead;
    for (;;) {
      if (this.overlapped()) {
        this.close(Math.max(this.now(), lagged));
        return this.report({ status: "overlap" });
      }
      const from = this.now();
      const u = await readUsage(this.o.key, this.o.source, this.o.fetch);
      if (this.abandoned) return { status: "unsettled", why: "quit" };
      const t = this.now();
      if (u !== undefined) {
        [prev, last] = [last, u];
        lastRead = { from, to: t };
      }
      if (this.overlapped()) {
        this.close(Math.max(t, lagged));
        return this.report({ status: "overlap" });
      }
      // Gluon's own brain spends on the same key: its replies that landed are taken off, and one whose cost or landing is unknown leaves no figure.
      const brain: BrainShare = last === undefined ? { usd: 0, unknown: false, pending: false } : this.brainShare(lastRead);
      if (brain.unknown) {
        this.close(Math.max(t, lagged));
        return this.report({ status: "brain" });
      }
      const net = last === undefined ? 0 : last - this.baseline - brain.usd;
      // Spend counted but the usage still at the baseline: it hasn't landed (OpenRouter lags the requests), not "$0": keep polling. And the usage that
      // moved may still be moving: not before `landMs` since the last request. (A usage below the baseline is no delta: it settles into `negative`.)
      // A usage that moved only by the brain's replies has not moved for the session.
      const moved = !expects || Math.round(net * 1e6) !== 0;
      const ripe = expects ? t - this.lastRequestAt >= this.t.landMs : t - exitAt >= this.t.settleMs;
      // A brain reply that may or may not have landed by this reading settles with the next ones.
      if (last !== undefined && prev === last && moved && ripe && !brain.pending) {
        this.close(t);
        const tolerance = brain.usd > 0 ? 1e-9 : 0;
        return this.report(net < -tolerance ? { status: "unreadable", why: "negative" } : { status: "clean", usd: Math.max(0, net), ...(brain.usd > 0 ? { brainUsd: brain.usd } : {}) });
      }
      if (t - exitAt >= this.t.giveUpMs) {
        this.close(Math.max(t, lagged));
        return this.report(last === undefined ? { status: "unreadable", why: "read-failed" } : brain.pending ? { status: "brain" } : { status: "unsettled", why: "timeout" });
      }
      this.o.registry.touch(this.tag);
      await this.wait(this.t.pollMs);
      if (this.abandoned) return { status: "unsettled", why: "quit" };
    }
  }

  /** The session never ran (its launch failed): its window ends now, and nothing is reported. */
  cancel(): void {
    this.reported = true;
    this.abandoned = true;
    this.finished = true;
    this.calibrating = false;
    this.close(this.now());
    this.wake();
  }

  /** Gluon quits (or crashes) before the figure settled: no figure, an unsettled record, and the window keeps its lag tail for the sessions that follow. Synchronous. */
  abandon(): void {
    if (this.abandoned || this.reported) return;
    this.abandoned = true;
    this.finished = true;
    this.calibrating = false;
    this.close(this.now() + this.t.tailMs);
    this.report({ status: "unsettled", why: "quit" });
    this.wake();
  }
}

/**
 * A session's figure has its fate (`BilledMeter`'s `onSettled`): a clean delta becomes the session's cost (the tracker audits it against its own sum in the
 * ledger, with the cause of a difference); anything else leaves a `dropped` record saying why, and the figure stays the estimate. `note` tells the user (the chat).
 */
export function settled(r: BilledResult, d: { tracker: CostTracker; ledger: Ledger; harness: Harness; note: (message: string) => void; now?: () => number }): void {
  const drop = (reason: string) => d.ledger.add({ kind: "dropped", t: (d.now ?? Date.now)(), harness: d.harness, what: "cost", reason, count: 1 });
  if (r.status === "clean") {
    const was = d.tracker.figure();
    if (!d.tracker.billed(r.usd)) {
      // $0 for a session that spent: the usage hadn't landed (the meter never settles so; a second guard).
      d.note("no billed figure: OpenRouter's usage showed nothing for this session.");
      return;
    }
    d.note(`OpenRouter billed ${costLabel({ usd: r.usd, approx: false, billed: true })} for this session${was && !was.billed ? ` (Gluon's running figure was ${costLabel(was)})` : ""}${r.brainUsd ? `; the intake agent's own ${costLabel({ usd: r.brainUsd, approx: false })} on this key in that time is not in it` : ""}.`);
  } else if (r.status === "overlap") {
    drop("openrouter-overlap");
    d.note("no billed figure: another OpenRouter session ran at the same time on this key.");
  } else if (r.status === "brain") {
    drop("openrouter-brain-spend");
    d.note("no billed figure: the intake agent spent on this key during the session and what it cost, or when it was charged, isn't known exactly.");
  } else if (r.status === "unsettled") {
    drop("openrouter-unsettled");
    if (r.why === "timeout") d.note(`no billed figure: OpenRouter's usage hadn't settled after ${Math.round(TIMINGS.giveUpMs / 60_000)} minutes.`);
  } else {
    drop("openrouter-key-unreadable");
    d.note(`no billed figure: the key's usage couldn't be ${r.why === "negative" ? "trusted (it went down)" : "read"}.`);
  }
}
