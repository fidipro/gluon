/**
 * Kimi Code's usage for Gluon's own cost figure (`src/cost/kimi.ts`). Gluon never reads Kimi's files: the official binary hands it the data.
 *   1. `kimi session list --cwd <launch dir> --json` names the launch's session: the one created after the launch started
 *      (`pickSession`; none or several: no figure, the reason goes to the ledger, never a guess);
 *   2. `kimi export <id> -o <zip>` writes it into a fresh private directory of Gluon's (`privateDir`: 0700), the zip is read in memory, only
 *      the numbers of its `usage.record` lines are kept (`readUsageZip`: never a prompt, a message or a tool's text), and the directory
 *      and the zip go at once, whatever happened.
 * Both run through `run` (status.ts: `binPath`, `neutralCwd()`). A refresh runs from the status timer, at least `KIMI_REFRESH_MS` apart, never
 * two at once, and once more when Kimi has exited; the screen never starts one.
 */
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { binPath } from "./detect.ts";
import { KimiRecords, type KimiUsageRecord } from "./cost/kimi.ts";
import { privateDir } from "./secrets.ts";
import { run } from "./status.ts";

/** A refresh of an open session at most this often (an export is cheap, but not free). */
export const KIMI_REFRESH_MS = 30_000;
/** Until the session exists (Kimi creates it at the first message), look again sooner. */
export const KIMI_LOOK_MS = 10_000;
/** At quit, how long Gluon waits for the last exports. */
export const KIMI_END_WAIT_MS = 10_000;
/** The biggest zip, and the wire logs inside it together, that are read (bytes). */
export const MAX_ZIP_BYTES = 256 * 1024 * 1024;
export const MAX_WIRE_BYTES = 512 * 1024 * 1024;

export type SessionPick = { id: string; updatedAt: number | undefined } | { reason: "none" | "ambiguous" | "unreadable"; count?: number };

interface Row {
  id: string;
  createdAt: number;
  updatedAt: number | undefined;
}

/** The sessions `kimi session list --json` names (an id, its creation and last update in ms; archived ones left out), or null when it isn't a list. */
export function listedSessions(listJson: string): Row[] | null {
  let rows: unknown;
  try {
    rows = JSON.parse(listJson);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((r) => {
    const o = r as { id?: unknown; createdAt?: unknown; updatedAt?: unknown; archived?: unknown } | null;
    if (!o || typeof o.id !== "string" || !/^[A-Za-z0-9][\w.-]{0,127}$/.test(o.id) || typeof o.createdAt !== "number" || o.archived === true) return [];
    return [{ id: o.id, createdAt: o.createdAt, updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : undefined }];
  });
}

/** What the other launches of Kimi in the same directory (Gluon's own: `launches`) tell a pick: the sessions they have, and when those still without one started. */
export interface Rivals {
  claimed?: ReadonlySet<string>;
  pending?: readonly number[];
}

/**
 * The session this launch made: the only one created at or after `startedAt` (ms). Kimi's other sessions of the directory are older; two new ones
 * (another launch in the same directory, a `/new`) can't be told apart: ambiguous, and none at all: not yet, or never. Kimi creates its session at
 * the first message, so a second launch of the directory that is still without one may own any session created after it started: such a session is
 * the launch's only when no other launch could (`pending`: a launch without a session that started no later than the session's creation), and one
 * another launch already has (`claimed`) is never it (BUG-478).
 */
export function pickSession(listJson: string, startedAt: number, rivals: Rivals = {}): SessionPick {
  const rows = listedSessions(listJson);
  if (!rows) return { reason: "unreadable" };
  const fresh = rows.filter((r) => r.createdAt >= startedAt && !rivals.claimed?.has(r.id));
  if (fresh.length === 0) return { reason: "none" };
  const sure = fresh.filter((r) => !rivals.pending?.some((t) => t <= r.createdAt));
  return sure.length === 1 ? { id: sure[0]!.id, updatedAt: sure[0]!.updatedAt } : { reason: "ambiguous", count: fresh.length };
}

const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);

/** The files of a zip by name (stored or deflated; no encryption, no zip64): `want` picks the names inflated, the rest is never touched. */
export function zipEntries(zip: Uint8Array, want: (name: string) => boolean, maxBytes = MAX_WIRE_BYTES): Map<string, Uint8Array> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = u16(zip, eocd + 10);
  if (count === 0xffff || u32(zip, eocd + 16) === 0xffffffff) throw new Error("zip64 isn't supported");
  const out = new Map<string, Uint8Array>();
  // The wanted files together never come to more than `maxBytes` inflated (a zip bomb of many entries, BUG-479).
  let budget = maxBytes;
  let p = u32(zip, eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || u32(zip, p) !== 0x02014b50) throw new Error("bad zip directory");
    const flags = u16(zip, p + 8);
    const method = u16(zip, p + 10);
    const size = u32(zip, p + 20);
    const full = u32(zip, p + 24);
    const nameLen = u16(zip, p + 28);
    const next = p + 46 + nameLen + u16(zip, p + 30) + u16(zip, p + 32);
    const local = u32(zip, p + 42);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    p = next;
    if (!want(name) || flags & 1) continue;
    if (full > budget) throw new Error("a file in the zip is too large");
    if (local + 30 > zip.length || u32(zip, local) !== 0x04034b50) throw new Error("bad zip entry");
    const start = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    if (start + size > zip.length) throw new Error("zip entry out of range");
    const data = zip.subarray(start, start + size);
    let bytes: Uint8Array;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = inflateRawSync(data, { maxOutputLength: Math.max(1, budget) });
    else throw new Error("unsupported zip compression");
    budget -= bytes.length;
    if (budget < 0) throw new Error("the zip is too large");
    out.set(name, bytes);
  }
  return out;
}

const WIRE = /^agents\/([^/]+)\/wire\.jsonl$/;
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * The usage records of an export, per agent (the key is the agent's folder: the main agent's and each subagent's own wire log), in the log's order.
 * Only a `usage.record` line is parsed and only its model, agent, scope and four counts are kept: everything else in the zip is dropped unread.
 */
export function readUsageZip(zip: Uint8Array): Map<string, KimiUsageRecord[]> {
  const byAgent = new Map<string, KimiUsageRecord[]>();
  for (const [name, bytes] of zipEntries(zip, (n) => WIRE.test(n))) {
    const agent = WIRE.exec(name)![1]!;
    const records: KimiUsageRecord[] = [];
    const text = new TextDecoder().decode(bytes);
    // Line by line without a list of them all: most lines are messages and tool output, never parsed (the cheap test first).
    for (let from = 0; from < text.length; ) {
      let to = text.indexOf("\n", from);
      if (to < 0) to = text.length;
      const line = text.slice(from, to);
      from = to + 1;
      if (!line.includes('"usage.record"')) continue;
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.type !== "usage.record" || !j.usage || typeof j.usage !== "object") continue;
      const u = j.usage as Record<string, unknown>;
      records.push({
        agentId: typeof j.agentId === "string" ? j.agentId.slice(0, 64) : agent,
        model: typeof j.model === "string" ? j.model.slice(0, 128) : "",
        inputOther: count(u.inputOther),
        output: count(u.output),
        inputCacheRead: count(u.inputCacheRead),
        inputCacheCreation: count(u.inputCacheCreation),
        ...(j.usageScope === "turn" || j.usageScope === "session" ? { usageScope: j.usageScope } : {}),
      });
    }
    if (records.length) byAgent.set(agent, records);
  }
  return byAgent;
}

export type Runner = typeof run;

const EXPORT_PREFIX = "gluon-kimi-export-";
const swept = new Set<string>();
/** The export directories in use right now: `removeKimiExports` takes them away when Gluon quits mid-export. */
const live = new Set<string>();

/** Removes every export directory still in use (a quit that doesn't wait for the export: the zip must not outlive Gluon). */
export function removeKimiExports(): void {
  for (const d of live) rmSync(d, { recursive: true, force: true });
  live.clear();
}

/** A directory of a Gluon that was killed mid-export (a crash, a power cut) is removed once it is an hour old: the zip in it is a session's whole log. Once per process. */
function sweepStale(tmp: string, now = Date.now()): void {
  if (swept.has(tmp)) return;
  swept.add(tmp);
  try {
    for (const f of readdirSync(tmp)) {
      if (!f.startsWith(EXPORT_PREFIX)) continue;
      const st = lstatSync(join(tmp, f), { throwIfNoEntry: false });
      if (st?.isDirectory() && !st.isSymbolicLink() && now - st.mtimeMs > 3_600_000) rmSync(join(tmp, f), { recursive: true, force: true });
    }
  } catch {}
}

export type ExportResult = { records: Map<string, KimiUsageRecord[]> } | { reason: "export-failed" | "unreadable" };

/**
 * `kimi export <id>` into a fresh private directory, read, and removed: the directory (and the zip in it) never outlives this call, an error included.
 * `--no-include-global-log`: only the session is wanted. `-y`: never a prompt.
 */
export async function exportUsage(kimi: string, sessionId: string, o: { runner?: Runner; tmp?: string } = {}): Promise<ExportResult> {
  const runner = o.runner ?? run;
  const tmp = o.tmp ?? tmpdir();
  sweepStale(tmp);
  const { dir } = privateDir(tmp, EXPORT_PREFIX);
  live.add(dir);
  try {
    const zip = join(dir, "session.zip");
    const r = await runner([kimi, "export", sessionId, "-o", zip, "-y", "--no-include-global-log"], 120_000, { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: "1" });
    if (r.code !== 0 || !existsSync(zip)) return { reason: "export-failed" };
    if (statSync(zip).size > MAX_ZIP_BYTES) return { reason: "unreadable" };
    try {
      return { records: readUsageZip(new Uint8Array(await Bun.file(zip).arrayBuffer())) };
    } catch {
      return { reason: "unreadable" };
    }
  } catch {
    return { reason: "export-failed" };
  } finally {
    live.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Gluon's launches of Kimi that have not ended (the same directory twice: `pickSession`'s rivals). */
interface Launch {
  cwd: string;
  startedAt: number;
  session: string | undefined;
}
const launches = new Set<Launch>();

export type KimiProblem = "none" | "ambiguous" | "unreadable" | "export-failed";

export interface KimiUsageOptions {
  /** The launch's directory (`--cwd`) and when the launch started (ms): only a session created from then on is the launch's. */
  cwd: string;
  startedAt: number;
  /** The new records of a refresh, each once. */
  onRecords: (records: KimiUsageRecord[]) => void;
  /** Why a refresh gave nothing (each reason once per change). */
  onProblem?: (reason: KimiProblem, detail?: { count?: number }) => void;
  runner?: Runner;
  tmp?: string;
  now?: () => number;
  refreshMs?: number;
  lookMs?: number;
  /** The binary (default `binPath("kimi")`). */
  bin?: () => string | null | undefined;
}

/**
 * One launch's usage source. `tick` (the status timer) refreshes when due: never two refreshes at once, at least `refreshMs` apart (`lookMs` while no
 * session is known); an open session whose `updatedAt` hasn't moved isn't exported again. `end` (Kimi exited) waits for a refresh in flight, then exports
 * once more. Once the launch's session is known it is kept (a later `/new` makes another session of the directory: it isn't counted).
 */
export function kimiUsage(o: KimiUsageOptions) {
  const now = o.now ?? Date.now;
  const records = new KimiRecords();
  const me: Launch = { cwd: o.cwd, startedAt: o.startedAt, session: undefined };
  launches.add(me);
  let session: string | undefined;
  let exportedAt: number | undefined;
  let busy: Promise<void> | undefined;
  let nextAt = 0;
  let last: KimiProblem | undefined;
  const problem = (r: KimiProblem | undefined, detail?: { count?: number }) => {
    if (r !== last) {
      last = r;
      if (r) o.onProblem?.(r, detail);
    }
  };

  async function refresh(final: boolean): Promise<void> {
    const kimi = (o.bin ?? (() => binPath("kimi")))();
    if (!kimi) return;
    const runner = o.runner ?? run;
    const listed = await runner([kimi, "session", "list", "--cwd", o.cwd, "--json"], 30_000, { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: "1" });
    if (listed.code !== 0) return void problem("unreadable");
    // A session known stays the launch's: more sessions later (a `/new`) don't unset it.
    if (!session) {
      const others = [...launches].filter((l) => l !== me && l.cwd === o.cwd);
      const pick = pickSession(listed.stdout, o.startedAt, { claimed: new Set(others.flatMap((l) => (l.session ? [l.session] : []))), pending: others.filter((l) => !l.session).map((l) => l.startedAt) });
      if ("reason" in pick) {
        return void problem(pick.reason, pick.count === undefined ? undefined : { count: pick.count });
      }
      session = me.session = pick.id;
    }
    const updatedAt = listedSessions(listed.stdout)?.find((r) => r.id === session)?.updatedAt;
    // Nothing happened in the session since the last export: not exported again while it is open.
    if (!final && updatedAt !== undefined && updatedAt === exportedAt) return;
    const got = await exportUsage(kimi, session, { ...(o.runner ? { runner: o.runner } : {}), ...(o.tmp ? { tmp: o.tmp } : {}) });
    if ("reason" in got) return void problem(got.reason);
    problem(undefined);
    exportedAt = updatedAt;
    const fresh = records.fresh(got.records);
    if (fresh.length) o.onRecords(fresh);
  }

  const start = (final: boolean) => {
    // Start to start: at least `refreshMs` apart, `lookMs` while the launch's session isn't known.
    const began = now();
    return (busy = refresh(final)
      .catch(() => problem("export-failed"))
      .finally(() => {
        busy = undefined;
        nextAt = began + (session ? (o.refreshMs ?? KIMI_REFRESH_MS) : (o.lookMs ?? KIMI_LOOK_MS));
      }));
  };

  return {
    tick(): void {
      if (busy || now() < nextAt) return;
      void start(false);
    },
    async end(): Promise<void> {
      try {
        await busy;
        await start(true);
      } finally {
        launches.delete(me);
      }
    },
    /** The launch never started (or is done without `end`): it is no rival of another. */
    dispose(): void {
      launches.delete(me);
    },
    /** The session this launch made, once known. */
    get session() {
      return session;
    },
    /** What the last refresh couldn't do (undefined: it worked, or none has run). */
    get problem() {
      return last;
    },
  };
}
