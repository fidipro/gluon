/**
 * One launch's cost, Gluon's own (issue #39): each request a harness reports usage for is priced
 * by that harness's function (`claude.ts`, `codex.ts`, `opencode.ts`) from the local price table (`tables.ts`), summed,
 * and written to the audit ledger; what the harness itself says about cost is only recorded beside
 * it (`reported*`), with the likeliest cause of any difference. The figure shown is ours whenever
 * every request could be priced; a model with no price entry has no figure of ours, and the
 * harness's own total is shown instead, marked (`own: false`).
 */
import { isPlanConn, PROVIDERS, type Conn, type Harness } from "../harnesses.ts";
import { claudeCost, claudeFallbackHypotheses, claudeHypotheses, claudePriceFrom, claudePriceFromTier, HARNESS_UNKNOWN_MODEL_PRICE, type ClaudePrice } from "./claude.ts";
import { codexCost } from "./codex.ts";
import { grokCost, grokTableEntry } from "./grok.ts";
import type { GrokUsageReport } from "./grok-usage.ts";
import { micros as toMicros, PRICE_DRIFT } from "./billed.ts";
import { contextCause, ownPercent } from "./context.ts";
import { explain, Ledger, toleranceMicros, type Channel, type Counts } from "./ledger.ts";
import { kimiCost, kimiPriceKey, type KimiUsageRecord } from "./kimi.ts";
import { OPENCODE_NO_MODEL, opencodeCost, opencodePrices, type OpenCodeTokens } from "./opencode.ts";
import { claudeCatalogModel, currentTables, onTablesChanged, priceEntry, tableBuilding, tableBuildFailed, versionIn, type ClaudeCatalog, type GrokModelsTable, type ModelsDevTable, type PriceEntry, type Tables } from "./tables.ts";
import { windowTable } from "./context.ts";
import type { Assumption } from "./types.ts";

export interface TrackerOptions {
  harness: Harness;
  conn: Conn;
  /** The key of the launched model's entry (`priceKey`): what Bedrock/OpenRouter names resolve through, and the fallback. */
  launchedKey?: string;
  harnessVersion?: string;
  ledger?: Ledger;
  table?: ModelsDevTable;
  /** Claude Code's own catalog (windows, tiers incl. the 1h cache write); the default is the current one (`currentTables`; none yet: no catalog). */
  claudeCatalog?: ClaudeCatalog;
  /** Grok Build's own model table; the default is the current one (`currentTables`). Its price comes first, models.dev's is the fallback. */
  grokTable?: GrokModelsTable;
  /**
   * The cache TTL Claude's writes are priced at, from the user's settings (Claude Code's own, read by the caller):
   * the main conversation's and the subagents'. Unset: 5m is assumed (`cache-ttl-assumed-5m`), never learned from
   * Claude's reported cost; a reported cost that says otherwise is recorded as the cause of the difference.
   */
  cacheTtl?: { main?: "5m" | "1h"; subagent?: "5m" | "1h" };
  /** Codex: how long a reported turn cost waits for the responses it sums (default `TURN_COST_TIMEOUT_MS`). */
  turnCostTimeoutMs?: number;
  /** Grok: how long a `grok usage` report waits for the requests it counts (default `GROK_USAGE_TIMEOUT_MS`). */
  grokUsageTimeoutMs?: number;
  now?: () => number;
  /**
   * A table the session was still missing arrived (`onTablesChanged`) and was pinned: `priced` is how many waiting requests it priced (their
   * figure and ledger entries are written). The caller redraws, restates an estimate it calibrates, and sizes the context again (`windowReady`).
   */
  onTables?: (change: { priced: number }) => void;
}

/** The most requests kept while a table they need hasn't arrived (past it the oldest is dropped, counted: `price-buffer-full`). */
export const MAX_DEFERRED = 256;

/** The tables a tracker pins (`Tables`' keys). */
const TABLE_KEYS = ["modelsdev", "claudeCatalog", "codexWindows", "grokModels"] as const;

type ClaudeReq = Parameters<CostTracker["claudeRequest"]>[0];
type CodexReq = Parameters<CostTracker["codexResponse"]>[0];
type GrokReq = Parameters<CostTracker["grokRequest"]>[0];
type StepReq = Parameters<CostTracker["opencodeStep"]>[0];
/** A request whose price table hasn't arrived: its raw inputs, priced when it does (`CostTracker.defer`). */
type Deferred = { k: "claude"; r: ClaudeReq } | { k: "codex"; r: CodexReq } | { k: "grok"; r: GrokReq } | { k: "opencode"; r: StepReq } | { k: "kimi"; r: KimiUsageRecord };

/** Codex's `codex.turn_cost` comes from its server, minutes after the turn: it waits this long for our own sum of that turn. */
export const TURN_COST_TIMEOUT_MS = 15 * 60_000;

/** Grok's `grok usage` is read about 0.5 to 1.5 s before the last OTLP batch of the turn reaches Gluon: it waits this long for the requests it counts. */
export const GROK_USAGE_TIMEOUT_MS = 60_000;

/**
 * A harness's running total and context reading come from a plugin or a telemetry channel that is a few milliseconds AHEAD of the usage records our own
 * figures sum (measured: 2 to 100 ms before the request's record), so a reading that is ahead of ours waits for them (`settleCumulative`,
 * `settleContext`) and is compared once ours has caught up, at the latest after this long (checked at the next event) or when the session ends.
 */
export const SETTLE_GRACE_MS = 5_000;

/** One turn as Codex reports its cost (`codex.turn_cost`): tokens as its responses count them (input includes cached, output includes reasoning), and the server's estimate. */
export interface CodexTurn {
  /** The turn's model, when the event names it: only our responses of that model are summed. */
  model?: string;
  input: number;
  cached: number;
  output: number;
  reasoning?: number;
  reportedUsd: number;
  /** The tier the server says it priced (`standard`, ...): not used, the service-tier cause is read from our own prices. */
  speed?: string;
}

/** A Codex response we priced and no turn has claimed yet. */
interface CodexRecord {
  model: string;
  input: number;
  cached: number;
  output: number;
  micros: number;
  /** What it would have cost at the standard tier (= `micros` when no tier was requested). */
  standardMicros: number;
  assumptions: Assumption[];
}

/** What a harness reported as its context, beside what Gluon computed (`CostTracker.observeContext`). */
export interface ContextObservation {
  /** Our own count and window, when Gluon has them. */
  own?: { tokens?: number; window?: number; /** The window is a default for a model no table knows: the entry says `unknown-model` (BUG-369). */ guessed?: boolean };
  /** The harness's own: tokens and window, or a percentage. */
  reported: { tokens?: number; window?: number; pct?: number };
}

export interface Figure {
  usd: number;
  /** An estimate or a plan's API-equivalent (the `~` of the display). */
  approx: boolean;
  /** Ours; false: the harness's own total, because a request had no price of ours. */
  own: boolean;
  /** What OpenRouter billed the session (the key's usage over it): exact, replaces our estimate (`billed()`). */
  billed?: boolean;
}

const dateless = (name: string) => name.replace(/-\d{8}$/, "");

export class CostTracker {
  private ownUsd = 0;
  private ownCount = 0;
  private unpriced = 0;
  private estimated = false;
  private reportedUsd: number | undefined;
  private grokReportedMicros = 0;
  /** Grok: the requests seen (every `api_request`: main, subagent) and our own micros after the last ones, so a `grok usage` report is compared at the request count it holds (BUG-390). */
  private grokSeen = 0;
  private grokCum: number[] = [];
  private grokPending: { report: GrokUsageReport; since: number } | undefined;
  private grokBaselineCalls = 0;
  /** Codex responses priced and not yet part of an audited turn (bounded), and the reported turns waiting for theirs. */
  private codexUnclaimed: CodexRecord[] = [];
  private codexPending: { turn: CodexTurn; since: number }[] = [];
  private grokBaselineMicros = 0;
  /** OpenCode: what its reported cost of the side requests (the title) came to beyond ours, summed: the part of a cumulative difference `side-model-assumed` explains. */
  private sideResidualMicros = 0;
  /** Claude: what its reported cost of requests priced at its own fallback row (`harness-unknown-model-price`) came to beyond ours, summed. */
  private fallbackResidualMicros = 0;
  /** Running totals reported ahead of our own sum, waiting for the usage records (bounded). */
  private pendingCumulative: { reportedMicros: number; t: number }[] = [];
  /** Our own context as last known (`ownContextChanged`), and a reported reading waiting for ours to agree. */
  private latestOwnContext: ContextObservation["own"] | undefined;
  private pendingContext: { reported: ContextObservation["reported"]; t: number } | undefined;
  /**
   * OpenRouter: a model served by several providers is billed at the one that served each request, so tokens x table price is an estimate (`~`)
   * unless the table says the model has one endpoint price (`endpointSpread` false: the table's data, built at refresh from OpenRouter's listing, never asked per request). `calibration` is the live ratio of billed to ours (`src/openrouter-billed.ts`), and
   * `billedUsd` what OpenRouter billed the whole session once its usage had settled: that is the session's figure.
   */
  private openrouter = false;
  private calibration: number | undefined;
  private billedUsd: number | undefined;
  /**
   * The tables this session is pinned to (issue #89): taken from the registry when the tracker is made (what a caller injected stands for its own), a missing
   * one pinned when it first arrives, and then never changed: a refresh mid-session re-prices nothing. A key absent here is a table not built yet.
   */
  private pinned: Tables;
  private unsubscribe: (() => void) | undefined;
  /** Requests whose price table is absent (arrival order, capped): priced when it arrives (`tablesChanged`), a `dropped` marker if the session ends first. */
  private deferred: Deferred[] = [];
  /** Claude's catalog is from another Claude Code version than the installed one, whose build is under way: the version waited for, and the stored table to fall back to. */
  private claudeWait: { version: string; fallback: ClaudeCatalog } | undefined;
  /** While waiting requests are priced: when each arrived, so their ledger entries carry that time. */
  private replayAt: number | undefined;
  private over = false;
  private readonly now: () => number;
  /** models.dev's table, or undefined when none exists yet (nothing is priced from it). */
  private get table(): ModelsDevTable | undefined {
    return this.pinned.modelsdev;
  }
  /** The digest of models.dev's table, "" when there is none (a ledger entry then names no table). */
  private get tableDigest(): string {
    return this.table?.catalogDigest ?? "";
  }

  constructor(private readonly o: TrackerOptions) {
    this.pinned = { ...currentTables(), ...(o.table ? { modelsdev: o.table } : {}), ...(o.claudeCatalog ? { claudeCatalog: o.claudeCatalog } : {}), ...(o.grokTable ? { grokModels: o.grokTable } : {}) };
    this.now = o.now ?? Date.now;
    // Claude Code updates often and its catalog is its own: a stored table from another version, while the installed one's is being built, is not pinned (the first
    // session after an upgrade must not be priced by the old catalog); it waits for the new one and falls back to the stored one if that build fails (`tablesChanged`).
    const want = o.harness === "claude-code" && !o.claudeCatalog ? versionIn(o.harnessVersion) : undefined;
    const held = this.pinned.claudeCatalog;
    if (want && held && held.claudeCodeVersion !== want && tableBuilding("claudeCatalog")) {
      this.claudeWait = { version: want, fallback: held };
      delete this.pinned.claudeCatalog;
      this.listen();
    }
  }

  /** The tables this session is pinned to (what its figures and its context windows are computed from). */
  tables(): Tables {
    return this.pinned;
  }

  /** Whether the table this harness sizes a window by is pinned (`windowTable`): until it is, the context % is unknown, and the caller sizes it again when `onTables` fires. */
  windowReady(): boolean {
    const k = windowTable(this.o.harness);
    if (k === undefined || this.pinned[k]) return true;
    this.listen();
    return !!this.pinned[k];
  }

  /** Requests waiting for a price table. */
  pendingNow(): number {
    return this.deferred.length;
  }

  /** Subscribes to the registry, then takes a table that landed before this session needed it (BUG-704: nothing would announce it again). */
  private listen(): void {
    if (this.over || this.unsubscribe) return;
    this.unsubscribe = onTablesChanged(() => this.tablesChanged());
    this.tablesChanged();
  }

  private stopListening(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * The registry changed: a table this session lacks is pinned, and the requests waiting for it are priced in arrival order. Never un-pins or replaces a pinned one.
   * A session waiting for Claude's new catalog (`claudeWait`) takes it when it lands, else the stored one once its build is no longer running (it failed).
   * Grok's table that can't be built (`tableBuildFailed`) leaves Grok requests priced from models.dev's seed (`grokRequest`): they are replayed too.
   */
  private tablesChanged(): void {
    const now = currentTables();
    const pin: Record<string, unknown> = {};
    for (const k of TABLE_KEYS) if (!this.pinned[k] && now[k] && !(k === "claudeCatalog" && this.claudeWait)) pin[k] = now[k];
    const wait = this.claudeWait;
    if (wait) {
      if (now.claudeCatalog && now.claudeCatalog.claudeCodeVersion === wait.version) pin.claudeCatalog = now.claudeCatalog;
      else if (!tableBuilding("claudeCatalog")) pin.claudeCatalog = wait.fallback;
      if (pin.claudeCatalog) this.claudeWait = undefined;
    }
    const seedNow = this.deferred.some((d) => d.k === "grok") && this.grokSeeded();
    if (!Object.keys(pin).length && !seedNow) return;
    this.pinned = { ...this.pinned, ...pin } as Tables;
    if (!this.claudeWait && TABLE_KEYS.every((k) => this.pinned[k] || (k === "grokModels" && this.grokSeeded()))) this.stopListening();
    const waiting = this.deferred;
    this.deferred = [];
    const before = waiting.length;
    // One request that can't be priced (a throw) is dropped, counted: the rest still are.
    for (const d of waiting) {
      try {
        this.price(d);
      } catch {
        this.dropRequests("price-error", 1);
      }
    }
    this.o.onTables?.({ priced: before - this.deferred.length });
  }

  /** Grok's table can't be built on this machine (its binary is gone, unreadable or failed): its requests are priced from models.dev's seed. */
  private grokSeeded(): boolean {
    return !this.pinned.grokModels && !!this.pinned.modelsdev && tableBuildFailed("grokModels");
  }

  /** One request that waited, priced as if it had just arrived (a request that still lacks its table waits again). */
  private price(d: Deferred): void {
    const t = this.stamps.get(d);
    this.replayAt = t;
    try {
      if (d.k === "claude") this.claudeRequest(d.r);
      else if (d.k === "codex") this.codexResponse(d.r);
      else if (d.k === "grok") this.grokRequest(d.r);
      else if (d.k === "opencode") this.opencodeStep(d.r);
      else this.kimiRecords([d.r]);
    } finally {
      this.replayAt = undefined;
    }
  }

  private readonly stamps = new WeakMap<Deferred, number>();

  /** The time a ledger entry of the request being priced carries: when it arrived. */
  private stamp(): number {
    return this.replayAt ?? this.now();
  }

  /**
   * The request's price table is absent: keep its raw inputs (capped) and price it when the table arrives. Not `unknown-model` (that is a table
   * without the model). A request that can no longer be priced (the session ended) or no longer fits is a `dropped` marker, never silence.
   */
  private defer(d: Deferred): void {
    if (this.over) return this.dropRequests("no-price-table", 1);
    this.stamps.set(d, this.stamp());
    this.deferred.push(d);
    if (this.deferred.length > MAX_DEFERRED) {
      const old = this.deferred.shift()!;
      this.stamps.delete(old);
      this.dropRequests("price-buffer-full", 1);
    }
    // After the request is queued: a table already here prices it at once.
    this.listen();
  }

  /** Requests that will never be priced: counted as unpriced (the harness's own total stands in, marked) and noted in the ledger. */
  private dropRequests(reason: string, count: number): void {
    this.unpriced += count;
    this.o.ledger?.add({ kind: "dropped", t: this.now(), harness: this.o.harness, what: "usage", reason, count });
  }

  /** The table entry for a model name the harness reported on this connection (or the launched model's). */
  private entryFor(names: string[], launchedStandsIn = true): { entry: PriceEntry; key: string; launched: boolean } | undefined {
    const keys = [...names, ...(launchedStandsIn && this.o.launchedKey ? [this.o.launchedKey] : [])];
    for (const key of keys) {
      const entry = this.table ? priceEntry(key, this.table) : undefined;
      // `launched`: none of the reported model's own keys had a price, so the launched model's was used (an assumption).
      if (entry) return { entry, key, launched: !names.includes(key) };
    }
    return undefined;
  }

  /** models.dev's priced modes (fast) for an Anthropic model id: the catalog has none of its own. */
  private fastModes(id: string): NonNullable<PriceEntry["modes"]> {
    return (this.table ? priceEntry(`anthropic/${id}`, this.table)?.modes : undefined) ?? {};
  }

  private claudeKeys(model: string): string[] {
    const provider = this.o.conn === "plan" || this.o.conn === "anthropic" ? "anthropic" : PROVIDERS[this.o.conn]?.opencodeId;
    if (!provider) return [];
    // Bedrock and OpenRouter name models their own way: a name that isn't in the table falls to the launched model's.
    return provider === "anthropic" ? [`anthropic/${model}`, `anthropic/${dateless(model)}`] : [`${provider}/${model}`];
  }

  /** `digest`: the table that priced the request (Claude Code's catalog or models.dev); default models.dev's. */
  /** The assumptions of a request, plus `launched-model-price` when the launched model's price stood in for the reported model's. */
  private withLaunched(assumptions: Assumption[], found: { launched: boolean } | undefined): Assumption[] {
    return found?.launched ? [...assumptions, "launched-model-price"] : assumptions;
  }

  private record(channel: Channel, model: string, counts: Counts, ownMicros: number, assumptions: Assumption[], usd: number, digest = this.tableDigest): void {
    this.ownUsd += usd;
    this.ownCount++;
    if (assumptions.length) this.estimated = true;
    this.o.ledger?.add({ kind: "usage", t: this.stamp(), harness: this.o.harness, ...(this.o.harnessVersion ? { harnessVersion: this.o.harnessVersion } : {}), model, connection: this.o.conn, channel, counts, ownMicros, assumptions, table: digest.slice(0, 8) });
    this.settleCumulative();
  }

  private unknown(channel: Channel, model: string, counts: Counts): void {
    this.unpriced++;
    this.o.ledger?.add({ kind: "usage", t: this.stamp(), harness: this.o.harness, model, connection: this.o.conn, channel, counts, ownMicros: 0, assumptions: ["unknown-model"], table: this.tableDigest.slice(0, 8) });
    this.settleCumulative();
  }

  /** A Claude Code `api_request` (OTEL: the cache write is one total, so the TTL comes from the settings, Claude's automatic rule, or the 5m rate is assumed). `model` absent: the launched model's price stands in. */
  claudeRequest(r: { model?: string; input: number; output: number; cacheRead: number; cacheWrite: number; fast?: boolean; reportedUsd?: number; subagent?: boolean }): void {
    const counts: Counts = { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
    // A request that names no model is priced at the launched model's price (the id after the key's provider), and says so.
    const standIn = !r.model;
    const model = r.model || this.o.launchedKey?.split("/").slice(1).join("/");
    if (!model) return this.unknown("otel", "unknown", counts);
    // Claude Code's own catalog first (its prices, the 1h write exactly: Bedrock and Vertex ids resolve through it, and Claude
    // prices every connection at its list price); a model it doesn't list is priced from models.dev as before.
    const catalog = this.pinned.claudeCatalog;
    // Claude's table is its own catalog: until it is pinned the request waits (a model it lacks then falls to models.dev's price, which must be pinned too).
    if (!catalog) return this.defer({ k: "claude", r });
    const catalogModel = claudeCatalogModel(model, catalog);
    const tier = catalogModel && catalog.pricingTiers[catalogModel.pricing];
    const found = tier ? undefined : this.entryFor(this.claudeKeys(model));
    if (!tier && !found) return this.table ? this.unknown("otel", model, counts) : this.defer({ k: "claude", r });
    // Fast mode: a catalog model has the price row Claude Code's price function gives it (a model with none is priced as usual, as Claude does);
    // a model outside the catalog takes models.dev's fast row, when it has one.
    const fastTier = catalogModel && catalog.fastPricing?.[catalogModel.id];
    const fastRow = catalogModel ? undefined : Object.values(found?.entry.modes ?? this.fastModes(model)).find((m) => m.speed === "fast");
    const fastPrice = fastTier ? claudePriceFromTier(fastTier) : fastRow ? claudePriceFrom(fastRow.cost) : undefined;
    const price: ClaudePrice = r.fast && fastPrice ? fastPrice : tier ? claudePriceFromTier(tier) : claudePriceFrom(found!.entry.cost);
    const usage = { input_tokens: r.input, output_tokens: r.output, cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite };
    // The TTL is the settings' (never learned from the reported cost, which is the oracle). Unset: Claude Code's own automatic rule,
    // which is 1h for a subscription's main conversation (while it is within its limits: an assumption) and 5m otherwise.
    const setting = r.subagent ? this.o.cacheTtl?.subagent : this.o.cacheTtl?.main;
    const ttl = setting ?? (this.o.conn === "plan" && !r.subagent ? "1h" : "5m");
    const withTtl = { ...usage, ...(ttl === "1h" ? { cache_creation: { ephemeral_1h_input_tokens: r.cacheWrite } } : {}) };
    const c = claudeCost(price, withTtl, { assumed5m: setting === undefined && ttl === "5m" });
    const assumed1h: Assumption[] = setting === undefined && ttl === "1h" && r.cacheWrite > 0 ? ["cache-ttl-assumed-1h"] : [];
    const assumptions = this.withLaunched([...c.assumptions, ...assumed1h], { launched: standIn || !!found?.launched });
    // The table that priced it: Claude Code's catalog, or models.dev for a model the catalog doesn't list.
    const digest = tier ? catalog.catalogDigest : this.tableDigest;
    // A cause is judged before the request is recorded: recording settles the running totals waiting for it, which may name the same cause.
    let observation: { reportedMicros: number; cause: string } | undefined;
    if (r.reportedUsd !== undefined) {
      const reportedMicros = Math.round(r.reportedUsd * 1e6);
      // An id Claude Code's catalog lacks is priced by it at a row of its own: a reported cost on one of those rows is named (never copied).
      const fallback = catalogModel ? [] : claudeFallbackHypotheses(Object.values(catalog.pricingTiers).map(claudePriceFromTier), withTtl, c.micros);
      const cause = explain(reportedMicros - c.micros, [...claudeHypotheses(price, withTtl, fastPrice, ttl), ...fallback], toleranceMicros(reportedMicros));
      if (cause === HARNESS_UNKNOWN_MODEL_PRICE) this.fallbackResidualMicros += reportedMicros - c.micros;
      observation = { reportedMicros, cause };
    }
    this.record("otel", model, counts, c.micros, assumptions, c.usd, digest);
    if (observation) this.o.ledger?.add({ kind: "observation", what: "cost", t: this.stamp(), harness: this.o.harness, scope: "request", ...observation, ownMicros: c.micros });
  }

  /** A Codex `response.completed` (every conversation counts for cost). */
  codexResponse(r: { model: string; input: number; cached: number; cacheWrite: number; output: number; serviceTier?: string }): void {
    const counts: Counts = { input: r.input, cached: r.cached, cacheWrite: r.cacheWrite, output: r.output };
    const provider = this.o.conn === "plan" ? "openai" : PROVIDERS[this.o.conn]?.opencodeId;
    const found = this.entryFor(provider ? [`${provider}/${r.model}`] : []);
    if (!found) return this.table ? this.unknown("otel", r.model, counts) : this.defer({ k: "codex", r });
    const usage = { input: r.input, cached: r.cached, cacheWrite: r.cacheWrite, output: r.output };
    const c = codexCost(found.entry, { ...usage, ...(r.serviceTier ? { serviceTier: r.serviceTier } : {}) });
    const assumptions = this.withLaunched(c.assumptions, found);
    this.record("otel", r.model, counts, c.micros, assumptions, c.usd);
    // Kept to audit the turn it belongs to against `codex.turn_cost` (`codexTurnCost`); `standardMicros` is what the requested tier would explain.
    this.codexUnclaimed.push({ model: r.model, input: r.input, cached: r.cached, output: r.output, micros: c.micros, standardMicros: r.serviceTier ? codexCost(found.entry, usage).micros : c.micros, assumptions });
    if (this.codexUnclaimed.length > 256) this.codexUnclaimed.shift();
    this.settleTurns();
  }

  /** A Grok Build `api_request` (every one counts: a subagent's too); `reportedMicros`: the server's own cost of it, floored. */
  grokRequest(r: { model: string; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; reportedMicros?: number; subagent?: boolean }): void {
    const counts: Counts = { input: r.input, output: r.output, reasoning: r.reasoning, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
    const provider = this.o.conn === "plan" ? "xai" : PROVIDERS[this.o.conn]?.opencodeId;
    const grokTable = this.pinned.grokModels;
    // Grok's table is built from its binary: a request waits for it (and for models.dev's, when the model isn't in it). When that table can't be built here,
    // models.dev's `xai/` price is the seed Grok's table would have held, and says so (`grok-seed-price`).
    const seeded = provider === "xai" && !grokTable && this.grokSeeded();
    if (provider === "xai" && !grokTable && !seeded) return this.defer({ k: "grok", r });
    // Grok's own table first (a price of its binary's, else a marked models.dev seed in it); models.dev's own entry is the fallback, and tagged by its digest.
    const own = provider === "xai" ? grokTableEntry(r.model, grokTable) : undefined;
    const found = own ? { entry: own, key: `xai/${r.model}`, launched: false } : this.entryFor(provider ? [`${provider}/${r.model}`] : []);
    const digest = own ? grokTable?.digest : undefined;
    if (!found && !this.table) return this.defer({ k: "grok", r });
    // The server's own figures, summed, are what is shown for a model the table has no price for.
    if (r.reportedMicros !== undefined) this.grokReportedMicros += r.reportedMicros;
    if (!found) {
      this.unknown("otel", r.model, counts);
      if (r.reportedMicros !== undefined) this.reportedUsd = this.grokReportedMicros / 1e6;
      this.grokCounted(0);
      this.settleGrok();
      return;
    }
    const c = grokCost(found.entry, { input: r.input, cacheRead: r.cacheRead, output: r.output });
    this.record("otel", r.model, counts, c.micros, this.withLaunched(seeded ? [...c.assumptions, "grok-seed-price"] : c.assumptions, found), c.usd, digest);
    this.grokCounted(c.micros);
    if (r.reportedMicros !== undefined) {
      // The server floors its ticks to micro-USD (at most one micro under); the tier basis is the one thing we assume.
      const tierless = found.entry.cost.tiers?.length ? grokCost({ ...found.entry, cost: { ...found.entry.cost, tiers: [] } }, { input: r.input, cacheRead: r.cacheRead, output: r.output }).micros - c.micros : 0;
      const cause = explain(r.reportedMicros - c.micros, [{ name: "long-context-tier", deltaMicros: tierless }], Math.max(1, toleranceMicros(r.reportedMicros)));
      this.o.ledger?.add({ kind: "observation", what: "cost", t: this.stamp(), harness: this.o.harness, scope: "request", reportedMicros: r.reportedMicros, ownMicros: c.micros, cause });
    }
    this.settleGrok();
  }

  /** One more request counted, priced at `micros` (an unpriced one is counted at 0: `grok usage` counted it too). */
  private grokCounted(micros: number): void {
    this.grokSeen++;
    this.grokCum.push((this.grokCum.at(-1) ?? 0) + micros);
    if (this.grokCum.length > 512) this.grokCum.shift();
  }

  /**
   * Grok's own persisted totals (`grok usage`, `grok-usage.ts`) against ours: cumulative, audit only. They cover every
   * request of the session (a subagent's too: verified live on 1.0.46; a compaction has no request and no price, so adds none).
   * The report is read from Gluon before the turn's last OTLP batch has reached it, so it is compared only once Gluon has
   * seen as many requests as it counts (`modelCalls`), at that count: until then it waits (`settleGrok`, run by each request),
   * and after `grokUsageTimeoutMs` it is a `dropped` entry, never a divergence (BUG-390). A partial one (a turn without a server
   * cost) is skipped. A resumed or forked session's totals start from its inherited history (`grokBaseline`): only what this launch added is compared.
   */
  grokUsageReport(report: GrokUsageReport): void {
    if (report.micros === null || report.partial) return;
    this.grokPending = { report, since: this.now() };
    this.settleGrok();
  }

  /** Audits the report that is waiting once its requests are all here; drops it when they never come. */
  private settleGrok(): void {
    const p = this.grokPending;
    if (!p) return;
    const expected = Math.max(0, p.report.modelCalls - this.grokBaselineCalls);
    if (this.grokSeen >= expected) {
      this.grokPending = undefined;
      // Ours after exactly the requests the report counts: later ones (the next turn's) are not in it. Beyond the window kept, the total so far.
      const behind = this.grokSeen - expected;
      const ownMicros = expected === 0 ? 0 : behind === 0 ? (this.grokCum.at(-1) ?? 0) : this.grokCum.length > behind ? this.grokCum[this.grokCum.length - 1 - behind]! : undefined;
      if (ownMicros === undefined) return void this.o.ledger?.add({ kind: "dropped", t: this.now(), harness: this.o.harness, what: "cost", reason: "grok-usage-stale", count: 1 });
      const reported = Math.max(0, p.report.micros! - this.grokBaselineMicros);
      const cause = explain(reported - ownMicros, [], Math.max(1, Math.round(reported / 1000), p.report.turns));
      this.o.ledger?.add({ kind: "observation", what: "cost", t: this.now(), harness: this.o.harness, scope: "cumulative", reportedMicros: reported, ownMicros, cause });
    } else if (this.deferred.some((d) => d.k === "grok")) {
      // Requests still waiting for their table are among those the report counts: it waits for them (`ended()` drops what never came).
    } else if (this.now() - p.since > (this.o.grokUsageTimeoutMs ?? GROK_USAGE_TIMEOUT_MS)) {
      this.grokPending = undefined;
      this.o.ledger?.add({ kind: "dropped", t: this.now(), harness: this.o.harness, what: "cost", reason: "grok-usage-unmatched", count: 1 });
    }
  }

  /** OpenCode records the plugin sent twice, left out of the cost: counted, never silent (BUG-402). */
  stepsRepeated(count: number): void {
    this.o.ledger?.add({ kind: "dropped", t: this.now(), harness: this.o.harness, what: "usage", reason: "opencode-step-repeated", count });
  }

  /** The Grok session ended: a report still waiting for requests that never came is dropped, not forgotten. */
  grokEnded(): void {
    const p = this.grokPending;
    if (!p) return;
    this.settleGrok();
    if (this.grokPending) {
      this.grokPending = undefined;
      this.o.ledger?.add({ kind: "dropped", t: this.now(), harness: this.o.harness, what: "cost", reason: "grok-usage-unmatched", count: 1 });
    }
  }

  /** What `grok usage` already showed for the session before this launch's first turn (a resume's or a fork's inherited history): taken off every later cumulative audit. */
  grokBaseline(micros: number, calls = 0): void {
    if (Number.isFinite(micros) && micros >= 0) this.grokBaselineMicros = Math.round(micros);
    if (Number.isFinite(calls) && calls >= 0) this.grokBaselineCalls = Math.round(calls);
  }

  /**
   * The baseline when it wasn't read before the first turn: the first report's total beyond what Gluon itself
   * counted (its requests so far). That first audit then compares nothing (the later ones do); a request the report holds
   * that Gluon has not received yet makes it that much too high, which the pre-launch read (`grokBaseline`) avoids.
   * False for a partial report (try the next one).
   */
  grokBaselineFromReport(report: GrokUsageReport): boolean {
    if (report.micros === null || report.partial) return false;
    this.grokBaseline(Math.max(0, report.micros - (this.grokCum.at(-1) ?? 0)), Math.max(0, report.modelCalls - this.grokSeen));
    return true;
  }

  /**
   * One OpenCode step or compaction (`model`: `<opencode provider>/<model id>`, the table's key, or `OPENCODE_NO_MODEL` when the plugin saw none). `side`: a request it billed
   * without a step (the session title): OpenCode names no model for it, so the plugin names the provider's small model, else the
   * session's is used; either is an assumption (`side-model-assumed`), and the cause named when its reported cost differs from ours.
   */
  opencodeStep(r: { model: string; tokens: OpenCodeTokens; reportedUsd?: number; side?: boolean }): void {
    const counts: Counts = { input: r.tokens.input, output: r.tokens.output, reasoning: r.tokens.reasoning, cacheRead: r.tokens.cache.read, cacheWrite: r.tokens.cache.write };
    // The step's own model sets its price: the user may switch model by hand mid-session (F06, BUG-671). The launched model's price stands in
    // only for a step that names none; a named model the table lacks is unknown (the harness's total stands in, marked), never the launched price.
    const found = this.entryFor([r.model], r.model === OPENCODE_NO_MODEL);
    if (!found) return this.table ? this.unknown("plugin", r.model, counts) : this.defer({ k: "opencode", r });
    const c = opencodeCost(r.tokens, opencodePrices(found.entry.cost));
    // The residual is counted before the step is recorded: recording settles the running totals waiting for it, which may be explained by it.
    let observation: { reportedMicros: number; cause: string } | undefined;
    if (r.reportedUsd !== undefined) {
      const reportedMicros = Math.round(r.reportedUsd * 1e6);
      const residual = reportedMicros - c.micros;
      // The title's model is a guess: a difference on that record is the guess's (a model's price is all it assumes).
      const cause = explain(residual, r.side ? [{ name: "side-model-assumed", deltaMicros: residual }] : [], toleranceMicros(reportedMicros));
      if (cause === "side-model-assumed") this.sideResidualMicros += residual;
      observation = { reportedMicros, cause };
    }
    this.record("plugin", r.model, counts, c.micros, this.withLaunched([...c.assumptions, ...(r.side ? (["side-model-assumed"] as const) : [])], found), c.usd);
    if (observation) this.o.ledger?.add({ kind: "observation", what: "cost", t: this.stamp(), harness: this.o.harness, scope: "request", ...observation, ownMicros: c.micros });
  }

  /**
   * Kimi Code's usage records (`kimi export`, `src/kimi-usage.ts`; each exactly once, `KimiRecords`): every request of the session, a subagent's too,
   * priced at the route's table price of the model Gluon launched (`kimiCost`). Kimi reports no cost: nothing to audit, so no observation, only the
   * usage entries. A name Gluon doesn't offer (not the environment alias) is priced at the launched model's, an assumption.
   */
  kimiRecords(records: KimiUsageRecord[]): void {
    for (const r of records) {
      const counts: Counts = { input: r.inputOther, output: r.output, cacheRead: r.inputCacheRead, cacheWrite: r.inputCacheCreation };
      const named = kimiPriceKey(r.model, this.o.conn);
      const found = this.entryFor(named.key ? [named.key] : []);
      // The ledger's model is the one priced (the environment alias says nothing).
      const model = (named.key ?? this.o.launchedKey ?? "").split("/").slice(1).join("/") || r.model;
      if (!found) {
        if (this.table) this.unknown("export", model, counts);
        else this.defer({ k: "kimi", r });
        continue;
      }
      const c = kimiCost(found.entry, r);
      this.record("export", model, counts, c.micros, this.withLaunched(c.assumptions, named.known ? undefined : found), c.usd);
    }
  }

  /** The cause of a running total's difference: what the assumptions seen so far add up to, else unexplained (none when it agrees). */
  private cumulativeCause(reportedMicros: number, ownMicros: number): string {
    const hypotheses = [
      ...(this.sideResidualMicros ? [{ name: "side-model-assumed", deltaMicros: this.sideResidualMicros }] : []),
      ...(this.fallbackResidualMicros ? [{ name: HARNESS_UNKNOWN_MODEL_PRICE, deltaMicros: this.fallbackResidualMicros }] : []),
    ];
    return explain(reportedMicros - ownMicros, hypotheses, toleranceMicros(reportedMicros));
  }

  /**
   * A running total from the harness, to be written beside ours. It arrives a few ms BEFORE the usage records of the requests it
   * includes: one that is ahead of our own sum waits for them (`settleCumulative`, run by every request we record), so two equal totals compare
   * equal; one that is level with ours or behind it is written at once. Never longer than `SETTLE_GRACE_MS`, nor past `ended()`.
   */
  private cumulativeSample(reportedMicros: number): void {
    this.pendingCumulative.push({ reportedMicros, t: this.now() });
    if (this.pendingCumulative.length > 8) this.writeCumulative(this.pendingCumulative.shift()!);
    this.settleCumulative();
  }

  private writeCumulative(p: { reportedMicros: number; t: number }): void {
    const ownMicros = Math.round(this.ownUsd * 1e6);
    this.o.ledger?.add({ kind: "observation", what: "cost", t: p.t, harness: this.o.harness, scope: "cumulative", reportedMicros: p.reportedMicros, ownMicros, cause: this.cumulativeCause(p.reportedMicros, ownMicros) });
  }

  /** Writes the totals whose waiting is over: ours caught up (or passed), they waited too long, or `force` (the session ended). */
  private settleCumulative(force = false): void {
    if (!this.pendingCumulative.length) return;
    const ownMicros = Math.round(this.ownUsd * 1e6);
    const waiting: typeof this.pendingCumulative = [];
    for (const p of this.pendingCumulative) {
      const ahead = p.reportedMicros - ownMicros > toleranceMicros(p.reportedMicros);
      // A total that waits for requests not priced yet (no table) is not "ahead of ours" by a few ms: it waits for them, or the end.
      if (!ahead || force || (this.now() - p.t > SETTLE_GRACE_MS && !this.deferred.length)) this.writeCumulative(p);
      else waiting.push(p);
    }
    this.pendingCumulative = waiting;
  }

  /** The harness's own running total (Claude's metric, OpenCode's `usage.updated`): recorded beside ours, and shown only if ours can't be. */
  reportedCumulative(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) return;
    this.reportedUsd = usd;
    this.cumulativeSample(Math.round(usd * 1e6));
  }

  /** A harness's own running total that is never to be shown (Claude's plugin `session.measure`): the ledger only, beside ours; it does not become the figure `figure()` falls back to. */
  observeCost(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) return;
    this.cumulativeSample(Math.round(usd * 1e6));
  }

  /**
   * A harness's reported context beside Gluon's own, written to the ledger (never shown). The
   * percentages are computed here from tokens and window when the harness gave no percentage of its
   * own; `cause` names what differs (`contextCause`) once both sides have a percentage.
   * `r.own` given: compared now. Absent (the live case): against our own context as `ownContextChanged` last told it, and a reading that
   * disagrees with it waits for ours (it is a few ms ahead of the usage record that moves ours), so both sides are paired, not logged one-sided;
   * a reading still waiting when the next arrives, after `SETTLE_GRACE_MS`, or at `ended()` is judged against what ours is then.
   */
  observeContext(r: ContextObservation): void {
    if (r.own) return this.writeContext(r.reported, r.own);
    this.flushContext();
    if (this.contextAgrees(r.reported, this.latestOwnContext)) return this.writeContext(r.reported, this.latestOwnContext);
    this.pendingContext = { reported: r.reported, t: this.now() };
  }

  /** Our own context moved (the main conversation's last request, or `undefined`: compacted, unknown): a reading waiting for it is compared once they agree. */
  ownContextChanged(own: ContextObservation["own"] | undefined): void {
    this.latestOwnContext = own;
    const p = this.pendingContext;
    if (p && (this.contextAgrees(p.reported, own) || this.now() - p.t > SETTLE_GRACE_MS)) {
      this.pendingContext = undefined;
      this.writeContext(p.reported, own);
    }
  }

  /** The waiting reading, judged against our own context as it is now. */
  private flushContext(): void {
    const p = this.pendingContext;
    this.pendingContext = undefined;
    if (p) this.writeContext(p.reported, this.latestOwnContext);
  }

  /** Whether both sides have a percentage and the cause is `none`. */
  private contextAgrees(reported: ContextObservation["reported"], own: ContextObservation["own"] | undefined): boolean {
    const rep = reported.pct ?? (reported.tokens !== undefined && reported.window ? Math.min(100, (reported.tokens / reported.window) * 100) : undefined);
    const mine = own?.tokens !== undefined ? ownPercent(this.o.harness, own.tokens, own.window) : undefined;
    if (rep === undefined || mine === undefined || !Number.isFinite(rep)) return false;
    return contextCause({ tokens: own!.tokens, window: own!.window, pct: mine }, { ...reported, pct: rep }) === "none";
  }

  /** The harness's session is over: what still waits (a running total, a context reading, a Grok report) is judged now, never forgotten. */
  ended(): void {
    // A request that never got its table is counted, never silent; nothing arrives after this one.
    this.stopListening();
    this.over = true;
    const waiting = this.deferred.length;
    this.deferred = [];
    if (waiting) this.dropRequests("no-price-table", waiting);
    this.grokEnded();
    this.settleCumulative(true);
    this.flushContext();
  }

  private writeContext(reported: ContextObservation["reported"], ownIn: ContextObservation["own"] | undefined): void {
    const r = { reported, own: ownIn };
    // A figure that is not a sane number is absent: the other side's valid figures are still a reading (BUG-368).
    const sane = (n: number | undefined, max = 1e13) => (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max ? n : undefined);
    const rep = { tokens: sane(r.reported.tokens), window: sane(r.reported.window), pct: sane(r.reported.pct, 1000) };
    const own = { tokens: sane(r.own?.tokens), window: sane(r.own?.window) };
    const reportedPct = rep.pct ?? (rep.tokens !== undefined && rep.window ? Math.min(100, (rep.tokens / rep.window) * 100) : undefined);
    const ownPct = own.tokens !== undefined ? ownPercent(this.o.harness, own.tokens, own.window) : undefined;
    if (reportedPct === undefined && ownPct === undefined) {
      // Something was reported, but none of it was a figure: a count, not silence.
      if (Object.values({ ...r.reported, ...r.own }).some((v) => v !== undefined)) this.o.ledger?.add({ kind: "dropped", t: this.now(), harness: this.o.harness, what: "context", reason: "invalid-figures", count: 1 });
      return;
    }
    const cause = ownPct !== undefined && reportedPct !== undefined ? contextCause({ ...own, pct: ownPct }, { ...rep, pct: reportedPct }) : undefined;
    this.o.ledger?.add({ kind: "context", t: this.now(), harness: this.o.harness, ...(own.tokens !== undefined ? { ownTokens: own.tokens } : {}), ...(rep.tokens !== undefined ? { reportedTokens: rep.tokens } : {}), ...(own.window ? { ownWindow: own.window } : {}), ...(rep.window ? { reportedWindow: rep.window } : {}), ...(ownPct !== undefined ? { ownPct } : {}), ...(reportedPct !== undefined ? { reportedPct } : {}), ...(cause ? { cause } : {}), ...(r.own?.guessed ? { assumptions: ["unknown-model"] } : {}) });
  }

  /**
   * One turn's cost as Codex's server reports it (`codex.turn_cost`), to audit the sum of the responses
   * Gluon priced for that turn against (a `turn`-scope observation, never shown). The event exists on a ChatGPT login only: an
   * API-key launch never calls this (no audit, nothing pending: BUG-383). A resumed session inherits no total to subtract (Codex has no cumulative oracle), and a
   * turn from before the resume has none of our responses: it records nothing (BUG-338). It has no id to join on and
   * comes minutes late, so the turn is found by its tokens among the responses not yet claimed; until they are
   * all there it stays pending, and after `turnCostTimeoutMs` it is dropped (a `dropped` count, no observation:
   * a turn from before the session was resumed, or one with a response we couldn't price, has none to compare).
   */
  codexTurnCost(turn: CodexTurn): void {
    if (!Number.isFinite(turn.reportedUsd) || turn.reportedUsd < 0) return;
    if (this.codexPending.length >= 64) this.codexPending.shift();
    this.codexPending.push({ turn, since: this.now() });
    this.settleTurns();
  }

  /** Codex finished a turn (its Stop hook): its responses are all in, so look again for the reported turns waiting, and drop those that waited too long. */
  codexTurnEnded(): void {
    this.settleTurns();
  }

  private settleTurns(): void {
    const timeout = this.o.turnCostTimeoutMs ?? TURN_COST_TIMEOUT_MS;
    for (const p of [...this.codexPending]) {
      const run = this.findTurn(p.turn);
      if (run) {
        this.codexPending.splice(this.codexPending.indexOf(p), 1);
        this.codexUnclaimed = this.codexUnclaimed.filter((r) => !run.includes(r));
        this.auditTurn(p.turn, run);
      } else if (this.now() - p.since > timeout) {
        this.codexPending.splice(this.codexPending.indexOf(p), 1);
        this.o.ledger?.add({ kind: "dropped", t: this.now(), harness: this.o.harness, what: "cost", reason: "turn-unmatched", count: 1 });
      }
    }
  }

  /** The shortest, earliest run of unclaimed responses (of the turn's model) whose tokens are the turn's, or undefined. */
  private findTurn(turn: CodexTurn): CodexRecord[] | undefined {
    const rs = this.codexUnclaimed.filter((r) => turn.model === undefined || r.model === turn.model);
    let best: CodexRecord[] | undefined;
    for (let i = 0; i < rs.length; i++) {
      let input = 0;
      let cached = 0;
      let output = 0;
      for (let j = i; j < rs.length && output <= turn.output; j++) {
        input += rs[j]!.input;
        cached += rs[j]!.cached;
        output += rs[j]!.output;
        // The turn's input is the responses' (cached included), or without the cached part, whichever the event counts.
        if (output === turn.output && (input === turn.input || input - cached === turn.input) && (!best || j - i + 1 < best.length)) best = rs.slice(i, j + 1);
      }
    }
    return best;
  }

  private auditTurn(turn: CodexTurn, run: CodexRecord[]): void {
    const own = run.reduce((n, r) => n + r.micros, 0);
    const standard = run.reduce((n, r) => n + r.standardMicros, 0);
    const reportedMicros = Math.round(turn.reportedUsd * 1e6);
    // Codex reports the tier it REQUESTED, never the served one: what our priced tier adds is the cause to test.
    const assumptions = [...new Set(run.flatMap((r) => r.assumptions))];
    const cause = explain(reportedMicros - own, [{ name: "service-tier-requested", deltaMicros: standard - own }], Math.max(run.length, toleranceMicros(reportedMicros)));
    this.o.ledger?.add({ kind: "observation", what: "cost", t: this.now(), harness: this.o.harness, scope: "turn", reportedMicros, ownMicros: own, cause, assumptions });
  }

  /** This session is on OpenRouter's key usage: its own figure is an estimate (`~`) unless the launched model has one endpoint price in the table. */
  openrouterSession(): void {
    this.openrouter = true;
  }

  /** Whether the launched model's OpenRouter endpoints differ in input or output price (the table's `endpoints`); undefined: the table doesn't say. */
  private endpointSpread(): boolean | undefined {
    const e = (this.table ? priceEntry(this.o.launchedKey, this.table) : undefined)?.endpoints;
    return e ? e.count > 1 && (e.input.min !== e.input.max || e.output.min !== e.output.max) : undefined;
  }

  /** Our own sum so far in USD (the estimate: no calibration in it). */
  ownUsdNow(): number {
    return this.ownUsd;
  }

  /** Whether the session spent something the key's usage must show: a priced request above $0, or one we couldn't price (a free model's requests are $0 of ours too). */
  usageExpected(): boolean {
    return this.ownUsd > 0 || this.unpriced > 0 || this.deferred.length > 0;
  }

  /** How many requests are counted, priced or not (a change is a new request whose usage OpenRouter will show late). */
  requestsNow(): number {
    return this.ownCount + this.unpriced + this.deferred.length;
  }

  /** The live ratio of what OpenRouter billed to our estimate (`ratio`), or undefined: back to the table price. The figure is ours times it, marked `~`. */
  setCalibration(k: number | undefined): void {
    // The estimate it calibrates is only valid once every request is priced: while one waits for its table, the live ratio isn't taken.
    if (this.deferred.length && k !== undefined) return;
    this.calibration = k !== undefined && Number.isFinite(k) && k > 0 ? k : undefined;
  }

  /**
   * What OpenRouter billed the session, settled (a clean delta of the key's usage: `src/openrouter-billed.ts`): the session's figure from now on, and
   * audited against ours in the ledger with the cause of a difference. A cause is named only for what is observed: the model has several endpoint
   * prices, or the live ratio moved more than `PRICE_DRIFT`. Returns false (nothing taken, a `dropped` record) for $0 on a session that spent: that is a
   * reading taken before OpenRouter's usage moved, never a price difference (`openrouter-billed-zero`, never `openrouter-provider-price`).
   */
  billed(usd: number): boolean {
    if (!Number.isFinite(usd) || usd < 0) return false;
    if (usd === 0 && this.usageExpected()) {
      this.o.ledger?.add({ kind: "dropped", t: this.now(), harness: this.o.harness, what: "cost", reason: "openrouter-billed-zero", count: 1 });
      return false;
    }
    this.billedUsd = usd;
    const billedMicros = toMicros(usd);
    const ownMicros = Math.round(this.ownUsd * 1e6);
    const k = this.calibration;
    const named = this.endpointSpread() === true || (k !== undefined && Math.abs(k - 1) > PRICE_DRIFT);
    const cause = this.unpriced > 0 ? "unexplained" : explain(billedMicros - ownMicros, named ? [{ name: "openrouter-provider-price", deltaMicros: billedMicros - ownMicros }] : [], toleranceMicros(billedMicros));
    this.o.ledger?.add({ kind: "observation", what: "cost", t: this.now(), harness: this.o.harness, scope: "billed", reportedMicros: billedMicros, ...(this.unpriced === 0 ? { ownMicros } : {}), cause, ...(k !== undefined ? { calibration: k } : {}) });
    return true;
  }

  /** The figure to show, or undefined when there is none yet. */
  figure(): Figure | undefined {
    const plan = isPlanConn(this.o.conn);
    if (this.billedUsd !== undefined) return { usd: this.billedUsd, approx: false, own: true, billed: true };
    // A request waits for its price table: no figure yet (the sum without it would be wrong), shown as any missing figure.
    if (this.deferred.length) return undefined;
    if (this.ownCount > 0 && this.unpriced === 0) return { usd: this.ownUsd * (this.calibration ?? 1), approx: plan || this.estimated || (this.openrouter && this.endpointSpread() !== false) || this.calibration !== undefined, own: true };
    if (this.reportedUsd !== undefined) return { usd: this.reportedUsd, approx: plan, own: false };
    if (this.ownCount > 0) return { usd: this.ownUsd, approx: true, own: true };
    return undefined;
  }
}
