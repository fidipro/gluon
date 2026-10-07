/**
 * The audit ledger (issue #39): for every request Gluon prices, what it counted and what it
 * computed; for every figure a harness reports, what it said. Comparing the two, and keeping every
 * difference with its likeliest cause, is how Gluon's own calculations are tested in the field.
 *
 * Privacy: a record is built field by field from a whitelist (`sanitize`), so nothing a harness or
 * the agent's processes send can pass through: no prompt, id, host, path or free text, only the
 * harness, model and connection names, token counts and money in micro-USD.
 */
import { randomBytes } from "node:crypto";
import type { Harness } from "../harnesses.ts";
import type { ContextCause } from "./context.ts";
import type { Assumption } from "./types.ts";

export const CHANNELS = ["otel", "plugin", "status-event", "export"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The only count names a record keeps. */
export const COUNT_KEYS = ["input", "output", "cached", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "webSearch"] as const;
export type Counts = Partial<Record<(typeof COUNT_KEYS)[number], number>>;

export interface UsageEntry {
  kind: "usage";
  t: number;
  harness: Harness;
  harnessVersion?: string;
  model: string;
  connection: string;
  channel: Channel;
  counts: Counts;
  ownMicros: number;
  assumptions: Assumption[];
  /** `catalogDigest` of the table the price came from (a prefix). */
  table: string;
}

/** What a harness itself reported: of one request, one turn, or its running total. */
export interface ObservationEntry {
  kind: "observation";
  t: number;
  harness: Harness;
  /** What was reported: a cost (the default of an older entry) or a context size. */
  what: "cost" | "context";
  scope: "request" | "turn" | "cumulative" | "billed";
  /** What was reported. Scope `billed`: what OpenRouter billed the session (the key's usage over it: `src/openrouter-billed.ts`), and `ownMicros` is tokens x table price. */
  reportedMicros: number;
  /** Our own figure over the same scope, once known. */
  ownMicros?: number;
  /** The likeliest cause of a difference (`explain`), or "unexplained". */
  cause?: string;
  /** What our own figure over this scope assumed (a turn's: the service tier Codex requested, not the one it served). */
  assumptions?: Assumption[];
  /** Scope `billed`: the live ratio of billed to our estimate the row was showing when the session ended (`src/cost/billed.ts` `ratio`), if any. */
  calibration?: number;
  /**
   * Which launch's ledger wrote it (a random tag of that `Ledger`, no identity): a running total is a series of samples of one launch,
   * of which only the last is compared (`reportLines`); the earlier ones were in flight.
   */
  launch?: string;
}

/**
 * Our own context beside the harness's own, over the same request: tokens, window and percentage on
 * each side (percent of the window; any may be missing: a harness that reports no tokens, a model
 * Gluon has no window for). `cause`, when both percentages exist: which of the two differ.
 */
export interface ContextEntry {
  kind: "context";
  t: number;
  harness: Harness;
  ownTokens?: number;
  reportedTokens?: number;
  ownWindow?: number;
  reportedWindow?: number;
  ownPct?: number;
  reportedPct?: number;
  cause?: ContextCause;
  /** What the own figure assumed: `unknown-model` (its window is a default for a model no table knows). */
  assumptions?: Assumption[];
}

/** What Gluon could not count and why (a record it dropped: counts only, never its content). */
export interface DroppedEntry {
  kind: "dropped";
  t: number;
  /** The harness it was for; none for a table refresh at Gluon's start (`TablesEntry`), which belongs to no harness. */
  harness?: Harness;
  /** The figure it was meant for: a cost, a context size or a usage record. */
  what: "cost" | "context" | "usage";
  /** A slug, e.g. `side-conversation`. */
  reason: string;
  count: number;
}

/** The tables a refresh can change (`refresh.ts`): the ones built on this machine. */
export const REFRESHED_TABLES = ["modelsdev", "claude-catalog", "codex-windows", "grok-models"] as const;
export type RefreshedTable = (typeof REFRESHED_TABLES)[number];
/** Most prices one `tables` entry names (the largest moves first); `moved` counts them all. */
export const MAX_TABLE_PRICES = 20;
/** Most skipped rows (model ids) one `tables` entry names; `skipped` counts them all. */
export const MAX_SKIPPED_NAMES = 20;

/**
 * A table the refresh changed (issue #89): which table, which way it was built (`network`: at start or launch; `binary`: from an installed
 * harness; `openrouter-row`: one model's price at an OpenRouter launch), its digest (a prefix), and how far its prices moved: the count, and the
 * largest moves as `{ key, from, to }` (a model id and the price field, USD per million tokens). Names and numbers only. A move that the change
 * guard would once have refused (more than 3x, more than 15% of the prices, a model gone) is accepted and says so (`big`, `gone`).
 */
export interface TablesEntry {
  kind: "tables";
  t: number;
  /** The harness a launch refresh was for; none for the start's. */
  harness?: Harness;
  table: RefreshedTable;
  via: "network" | "binary" | "openrouter-row";
  /** `catalogDigest` or `digest` of the new table (a prefix). */
  digest: string;
  /** When the table was fetched or built: a moment (ISO 8601). */
  fetchedAt: string;
  moved: number;
  /** Models the new table no longer has. */
  gone: number;
  big: boolean;
  prices: { key: string; from: number; to: number }[];
  /** Rows of the source left out as malformed (BUG-604): how many, and the first names. Absent when none. */
  skipped?: number;
  skippedNames?: string[];
}

export type LedgerEntry = UsageEntry | ObservationEntry | ContextEntry | DroppedEntry | TablesEntry;

const HARNESSES: readonly string[] = ["claude-code", "codex", "antigravity", "grok-build", "opencode", "kimi-code"];
const NAME = /^[A-Za-z0-9._:/@[\]-]{1,128}$/;
const ASSUMPTIONS: readonly string[] = ["unknown-model", "launched-model-price", "cache-ttl-assumed-5m", "cache-ttl-assumed-1h", "cache-ttl-inferred", "service-tier-requested", "long-context-tier-assumed", "list-price", "reasoning-in-output", "side-model-assumed", "grok-seed-price"];
const num = (v: unknown, max = 1e13): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : undefined);
const CONTEXT_CAUSES: readonly string[] = ["none", "tokens", "window", "both"];
const slug = (v: unknown): string | undefined => (typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v) ? v : undefined);
const name = (v: unknown): string | undefined => (typeof v === "string" && NAME.test(v) ? v : undefined);

const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** A `tables` entry from anything: a known table and way, a digest prefix, a moment, bounded counts and prices named by a model id; null when it isn't one. */
function sanitizeTables(o: Record<string, unknown>, t: number, harness: Harness | undefined): TablesEntry | null {
  const table = REFRESHED_TABLES.find((x) => x === o.table);
  const via = o.via === "network" || o.via === "binary" || o.via === "openrouter-row" ? o.via : undefined;
  const digest = typeof o.digest === "string" && /^[0-9a-f]{1,16}$/.test(o.digest) ? o.digest : undefined;
  const fetchedAt = typeof o.fetchedAt === "string" && MOMENT.test(o.fetchedAt) ? o.fetchedAt : undefined;
  const moved = num(o.moved);
  const gone = num(o.gone) ?? 0;
  if (!table || !via || !digest || !fetchedAt || moved === undefined) return null;
  const prices: TablesEntry["prices"] = [];
  for (const p of Array.isArray(o.prices) ? o.prices : []) {
    const r = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    const key = name(r.key);
    // A price is a plain number, not rounded to a micro: a cache price may be 0.0375 USD per million.
    const [from, to] = [r.from, r.to].map((v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9 ? v : undefined));
    if (key && from !== undefined && to !== undefined && prices.length < MAX_TABLE_PRICES) prices.push({ key, from, to });
  }
  const skipped = num(o.skipped) ?? 0;
  const skippedNames = (Array.isArray(o.skippedNames) ? o.skippedNames : []).flatMap((v) => (name(v) ? [name(v)!] : [])).slice(0, MAX_SKIPPED_NAMES);
  return { kind: "tables", t, ...(harness ? { harness } : {}), table, via, digest, fetchedAt, moved, gone, big: o.big === true, prices, ...(skipped ? { skipped, skippedNames } : {}) };
}

/** A ledger entry from anything: only whitelisted fields, bounded; null when it isn't one. Never throws. */
export function sanitize(input: unknown): LedgerEntry | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const t = num(o.t, 1e15);
  const harness = typeof o.harness === "string" && HARNESSES.includes(o.harness) ? (o.harness as Harness) : undefined;
  if (t === undefined) return null;
  if (o.kind === "tables") return sanitizeTables(o, t, harness);
  if (o.kind === "dropped") {
    const what = o.what === "cost" || o.what === "context" || o.what === "usage" ? o.what : undefined;
    const reason = slug(o.reason);
    const count = num(o.count);
    if (!what || !reason || count === undefined) return null;
    return { kind: "dropped", t, ...(harness ? { harness } : {}), what, reason, count };
  }
  if (!harness) return null;
  if (o.kind === "usage") {
    const counts: Counts = {};
    const c = o.counts && typeof o.counts === "object" ? (o.counts as Record<string, unknown>) : {};
    for (const k of COUNT_KEYS) {
      const n = num(c[k]);
      if (n !== undefined) counts[k] = n;
    }
    const ownMicros = num(o.ownMicros);
    const channel = CHANNELS.find((x) => x === o.channel);
    if (ownMicros === undefined || !channel) return null;
    const harnessVersion = typeof o.harnessVersion === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(o.harnessVersion) ? o.harnessVersion : undefined;
    return {
      kind: "usage",
      t,
      harness,
      ...(harnessVersion ? { harnessVersion } : {}),
      model: name(o.model) ?? "?",
      connection: name(o.connection) ?? "?",
      channel,
      counts,
      ownMicros,
      assumptions: Array.isArray(o.assumptions) ? (o.assumptions.filter((a) => typeof a === "string" && ASSUMPTIONS.includes(a)) as Assumption[]) : [],
      table: typeof o.table === "string" && /^[0-9a-f]{1,16}$/.test(o.table) ? o.table : "",
    };
  }
  if (o.kind === "observation") {
    const reportedMicros = num(o.reportedMicros);
    const scope = o.scope === "request" || o.scope === "turn" || o.scope === "cumulative" || o.scope === "billed" ? o.scope : undefined;
    if (reportedMicros === undefined || !scope) return null;
    const ownMicros = num(o.ownMicros);
    const cause = slug(o.cause);
    const assumptions = Array.isArray(o.assumptions) ? (o.assumptions.filter((a) => typeof a === "string" && ASSUMPTIONS.includes(a)) as Assumption[]) : [];
    const launch = typeof o.launch === "string" && /^[0-9a-f]{8}$/.test(o.launch) ? o.launch : undefined;
    const calibration = scope === "billed" && typeof o.calibration === "number" && Number.isFinite(o.calibration) && o.calibration > 0 && o.calibration <= 1000 ? Math.round(o.calibration * 1e4) / 1e4 : undefined;
    return { kind: "observation", t, harness, what: o.what === "context" ? "context" : "cost", scope, reportedMicros, ...(ownMicros !== undefined ? { ownMicros } : {}), ...(cause ? { cause } : {}), ...(assumptions.length ? { assumptions } : {}), ...(calibration !== undefined ? { calibration } : {}), ...(launch ? { launch } : {}) };
  }
  if (o.kind === "context") {
    // A figure that isn't a sane number is absent, not a reason to lose the entry: the other side's valid figures stay (BUG-368).
    const out: Record<string, number> = {};
    for (const [k, max] of [["ownTokens", 1e13], ["reportedTokens", 1e13], ["ownWindow", 1e13], ["reportedWindow", 1e13], ["ownPct", 1000], ["reportedPct", 1000]] as const) {
      const n = num(o[k], max);
      if (n !== undefined) out[k] = n;
    }
    if (out.ownPct === undefined && out.reportedPct === undefined) return null;
    // A cause compares both sides: with one gone, it says nothing.
    const cause = out.ownPct !== undefined && out.reportedPct !== undefined ? (CONTEXT_CAUSES.find((c) => c === o.cause) as ContextCause | undefined) : undefined;
    const assumptions = Array.isArray(o.assumptions) ? (o.assumptions.filter((a) => typeof a === "string" && ASSUMPTIONS.includes(a)) as Assumption[]) : [];
    return { kind: "context", t, harness, ...out, ...(cause ? { cause } : {}), ...(assumptions.length ? { assumptions } : {}) };
  }
  return null;
}

/** Differences within this are rounding (a micro-dollar per request, or 0.1%): not a divergence. */
export const toleranceMicros = (reportedMicros: number, requests = 1) => Math.max(requests, Math.round(reportedMicros / 1000));

/**
 * Whether a cost observation differs from our figure beyond rounding. The tracker's own verdict (`cause`: "none" or a named cause) is the
 * truth: it judged at the tolerance of what it compared (a turn of N responses, a total of N turns), which this file cannot know (BUG-400).
 * Without a cause (an entry from elsewhere), the tolerance of one request.
 */
export const differs = (o: ObservationEntry): boolean => o.ownMicros !== undefined && (o.cause !== undefined ? o.cause !== "none" : Math.abs(o.reportedMicros - o.ownMicros) > toleranceMicros(o.reportedMicros));

/**
 * The hypothesis (`name` → how much it would add to our figure, in micro-USD) that explains a
 * residual (reported − own): the one whose delta lands within tolerance of it, the closest first;
 * "unexplained" when none does. Hypotheses are the harness's named divergence causes.
 */
export function explain(residualMicros: number, hypotheses: { name: string; deltaMicros: number }[], tolerance = 1): string {
  if (Math.abs(residualMicros) <= tolerance) return "none";
  const fits = hypotheses.filter((h) => Math.abs(h.deltaMicros - residualMicros) <= tolerance).sort((a, b) => Math.abs(a.deltaMicros - residualMicros) - Math.abs(b.deltaMicros - residualMicros));
  return fits[0]?.name ?? "unexplained";
}

/** One launch's entries in memory (the file writer is `ledger-file.ts`). */
export class Ledger {
  readonly entries: LedgerEntry[] = [];
  /** Tells this launch's running-total samples from another's in the same file. */
  readonly launch = randomBytes(4).toString("hex");
  constructor(private readonly sink?: (e: LedgerEntry) => void) {}

  add(raw: unknown): LedgerEntry | null {
    const e = sanitize(raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "observation" ? { launch: this.launch, ...raw } : raw);
    if (!e) return null;
    this.entries.push(e);
    try {
      this.sink?.(e);
    } catch {}
    return e;
  }

  /** Our own total so far, in micro-USD. */
  ownMicros(): number {
    let n = 0;
    for (const e of this.entries) if (e.kind === "usage") n += e.ownMicros;
    return n;
  }

  /** Context entries whose percentage differs from the harness's by more than a point (their rounding): those with a cause other than `none`. */
  contextDivergences(): ContextEntry[] {
    return this.entries.filter((e): e is ContextEntry => e.kind === "context" && e.cause !== undefined && e.cause !== "none");
  }

  /** Observations whose reported figure differs from ours beyond rounding (a running total: its last sample per launch only, `finalCumulative`). */
  divergences(): ObservationEntry[] {
    return finalCumulative(this.entries).kept.filter((e): e is ObservationEntry => e.kind === "observation" && e.what === "cost" && differs(e));
  }
}

/**
 * A harness's running total is sampled many times while a launch runs, and our own sum lags or leads it by the requests in
 * flight (the plugin's sample and the telemetry's arrive at different times): only the LAST sample of each launch (and harness)
 * says whether the totals agree. `kept` is the entries without the earlier samples, `inFlight` how many were left out.
 */
export function finalCumulative(entries: LedgerEntry[]): { kept: LedgerEntry[]; inFlight: number } {
  const last = new Map<string, LedgerEntry>();
  const cumulative = (e: LedgerEntry): e is ObservationEntry => e.kind === "observation" && e.what === "cost" && e.scope === "cumulative";
  for (const e of entries) {
    if (!cumulative(e)) continue;
    const k = `${e.harness} ${e.launch ?? ""}`;
    const prev = last.get(k);
    if (!prev || e.t >= prev.t) last.set(k, e);
  }
  const kept = entries.filter((e) => !cumulative(e) || last.get(`${e.harness} ${e.launch ?? ""}`) === e);
  return { kept, inFlight: entries.length - kept.length };
}
