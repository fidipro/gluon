/**
 * The price and window tables Gluon prices by (issue #39, #89). None ships in the repository: they are built on
 * the user's machine (prices from the network, windows from the installed binaries) and kept in the local store
 * (`tables-store.ts`); this registry reads them at import (synchronously: the tables of the last run) and hands out
 * the current ones (`currentTables`), which a refresh replaces (`setTables`, `onTablesChanged`). A table not built yet is
 * `undefined`, which a caller treats as it treats a model the table lacks (no price, no window): never a harness's fallback.
 * Each table carries the source's own date and digest, so a table's age can be said (`gluon cost-report`) and a figure
 * traced to the table that priced it. The only table in the repository is the hand-maintained observed Grok windows
 * (`tables/grok-observed-windows.json`).
 */
import grokObservedWindows from "./tables/grok-observed-windows.json" with { type: "json" };
import type { ModelsDevCost } from "./opencode.ts";
import type { ClaudeTierRow } from "./claude.ts";
import { readStoredTable } from "./tables-store.ts";

/** The tables Gluon prices by; a key is `undefined` until that table exists (never built here, or not yet fetched). */
export interface Tables {
  modelsdev?: ModelsDevTable;
  claudeCatalog?: ClaudeCatalog;
  codexWindows?: CodexWindowsTable;
  grokModels?: GrokModelsTable;
}

/** What the store holds now: the tables of the last run, valid ones only (`readStoredTable`). */
function loadStored(): Tables {
  const out: Tables = {};
  const modelsdev = readStoredTable<ModelsDevTable>("modelsdev");
  const claudeCatalog = readStoredTable<ClaudeCatalog>("claude-catalog");
  const codexWindows = readStoredTable<CodexWindowsTable>("codex-windows");
  const grokModels = readStoredTable<GrokModelsTable>("grok-models");
  if (modelsdev) out.modelsdev = modelsdev;
  if (claudeCatalog) out.claudeCatalog = claudeCatalog;
  if (codexWindows) out.codexWindows = codexWindows;
  if (grokModels) out.grokModels = grokModels;
  return out;
}

let current: Tables = loadStored();
const listeners = new Set<() => void>();

/** The tables now: a snapshot object, never mutated (a refresh swaps it, `setTables`), so a holder of one keeps the tables it priced with. */
export const currentTables = (): Tables => current;

/**
 * Replaces the tables named in `partial` (a key present with `undefined` removes that table), then tells the listeners. It validates
 * nothing: the refresh checks a table (`table-schema.ts`) and stores it (`tables-store.ts`) before it gets here.
 */
export function setTables(partial: Tables): void {
  current = { ...current, ...partial };
  for (const k of Object.keys(current) as (keyof Tables)[]) if (current[k] === undefined) delete current[k];
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {} // a listener's failure never stops a refresh
  }
}

const building = new Set<keyof Tables>();
const buildFailed = new Set<keyof Tables>();

/** Whether a table is being built from a harness's binary right now (`refreshBinaryTables`): a session whose table is older than its harness waits for it. */
export const tableBuilding = (key: keyof Tables): boolean => building.has(key);
/** Whether the last build of a table from its binary failed in this process (it can't be built here: a session stops waiting for it). */
export const tableBuildFailed = (key: keyof Tables): boolean => buildFailed.has(key);

/** Says where a binary build of `key` stands (`building`, `done`: its table is in, `failed`) and tells the listeners, who wait or stop waiting for it. */
export function setTableBuild(key: keyof Tables, state: "building" | "done" | "failed"): void {
  if (state === "building") buildFailed.delete(key);
  else if (state === "failed") buildFailed.add(key);
  else buildFailed.delete(key);
  if (state === "building") building.add(key);
  else building.delete(key);
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {}
  }
}

/** The version a harness's `--version` line holds ("2.1.101 (Claude Code)" -> "2.1.101"), or undefined. */
export const versionIn = (text: string | null | undefined): string | undefined => {
  const v = (text ?? "").match(/\d+\.\d+[\w.-]*/)?.[0];
  return v && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/.test(v) ? v : undefined;
};

/** Calls `fn` after every `setTables`; returns the function that stops it. */
export function onTablesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export interface PriceEntry {
  cost: ModelsDevCost;
  /** models.dev's `limit.context`: NOT a harness's usable window: `ownWindow` (`context.ts`) sizes those (Grok's catalog window is the one that equals it: `grokWindow`). */
  context: number | null;
  status?: string;
  /** A kept `openrouter/*` row that OpenRouter's listing has not priced since this moment (`refresh.ts`, when openrouter.ai did not answer). */
  staleSince?: string;
  /** An `openrouter/*` model: the endpoints OpenRouter listed for it when the table was built (`modelsdev-catalog.ts`), prices in USD per million tokens. */
  endpoints?: { count: number; input: { min: number; max: number }; output: { min: number; max: number } };
  /** Priced modes: `serviceTier` is the request's `service_tier` (OpenAI), `speed` Claude's `speed: "fast"`. */
  modes?: Record<string, { cost: ModelsDevCost; serviceTier?: string; speed?: string }>;
}

export interface ModelsDevTable {
  schema: 1;
  source: "models.dev";
  catalogUpdatedAt: string | null;
  /** When the table was built (a day for a generator's, a moment for Gluon's; `catalogUpdatedAt` is null for the public API): the table's age when the catalog has no date. */
  generatedAt?: string;
  catalogDigest: string;
  /** When Gluon fetched it on this machine (a moment); absent in a table a generator made. */
  fetchedAt?: string;
  /** Models Gluon offers that the sources had no price for when this was built. */
  missing: string[];
  entries: Record<string, PriceEntry>;
}

/** The entry for a `priceKey` in `table` (default: the current models.dev table), or undefined (an unknown model, or no table yet: no figure of ours). */
export const priceEntry = (key: string | undefined, table: ModelsDevTable | undefined = currentTables().modelsdev): PriceEntry | undefined => (key && table && Object.hasOwn(table.entries, key) ? table.entries[key] : undefined);

/** Claude Code's own baked-in model catalog (`scripts/pricing/claude.ts`, from its binary): windows, provider ids and price tiers. */
export interface ClaudeCatalog {
  schema: 1;
  source: "claude-code binary";
  claudeCodeVersion: string;
  catalogDigest: string;
  fetchedAt?: string;
  pricingTiers: Record<string, ClaudeTierRow>;
  models: { id: string; family: string; providerIds: Record<string, string>; pricing: string; window: number; native1m: boolean; supports1mSuffix: boolean; supports1mBeta: boolean }[];
  /** Claude Code's fast-mode price rows by catalog model id (from its price function, not its catalog); a model without one is priced as usual when fast. */
  fastPricing?: Record<string, ClaudeTierRow>;
}

/** The catalog model a name (Gluon's id, the API's, Bedrock's or Vertex's, dated or not, with or without `[1m]`) names, or undefined. */
export function claudeCatalogModel(name: string, catalog: ClaudeCatalog | undefined = currentTables().claudeCatalog): ClaudeCatalog["models"][number] | undefined {
  if (!catalog) return undefined;
  const bare = name.replace(/\[1m\]$/i, "");
  const undated = bare.replace(/-\d{8}$/, "");
  return catalog.models.find((m) => m.id === bare || m.id === undated || Object.values(m.providerIds).some((p) => p === bare || p === undated));
}

/** What a table says about itself (`tableInfos`): its source, date or version, and the digest a ledger's usage entries carry a prefix of. */
export interface TableInfo {
  source: string;
  /** The source's own date (models.dev's `catalogUpdatedAt`), else when the table was generated (`generatedAt`). */
  updatedAt: string | null;
  /** The harness version it was read from, when it has one (`claudeCodeVersion`). */
  version: string | null;
  /** When Gluon fetched or built it on this machine (a moment), when the table says. */
  fetchedAt?: string;
  digest: string;
}

/**
 * Every table loaded now (none yet: not listed), found by its metadata (a string `source` and a digest in
 * `catalogDigest` or `digest`, a date in `catalogUpdatedAt` or `generatedAt`, a version in a `*Version`
 * field): a table added to `Tables` the same way shows in `gluon cost-report` with no change to it.
 */
export function tableInfos(): TableInfo[] {
  const out: TableInfo[] = [];
  for (const v of Object.values(currentTables())) {
    const t = v as unknown as Record<string, unknown> | null;
    if (!t || typeof t !== "object" || typeof t.source !== "string") continue;
    const digest = typeof t.catalogDigest === "string" ? t.catalogDigest : t.digest;
    if (typeof digest !== "string") continue;
    const versionKey = Object.keys(t).find((k) => /Version$/.test(k) && typeof t[k] === "string");
    out.push({ source: t.source, ...(typeof t.fetchedAt === "string" ? { fetchedAt: t.fetchedAt } : {}), updatedAt: typeof t.catalogUpdatedAt === "string" ? t.catalogUpdatedAt : typeof t.generatedAt === "string" ? t.generatedAt : null, version: versionKey ? (t[versionKey] as string) : null, digest });
  }
  return out.sort((a, b) => (a.source < b.source ? -1 : 1));
}

/**
 * Codex's window per model slug (`scripts/pricing/codex.ts`, from `codex debug models`):
 * the window it uses, the most it allows and the share of it a conversation may fill. Gluon resolves
 * a model's window from this table as Codex does (`codexUsableWindow`, `context.ts`); the table is built from the installed `codex`, never asked per request.
 */
export interface CodexWindowsTable {
  schema: 1;
  source: "codex debug models";
  codexVersion: string;
  generatedAt: string;
  digest: string;
  /** When Gluon built it on this machine (a moment); absent in a table a generator made. */
  fetchedAt?: string;
  /** How a table not made by a generator came about (a seed). */
  note?: string;
  models: Record<string, { context: number; max: number; percent: number }>;
}

/**
 * Grok Build's own model catalog (`scripts/pricing/grok.ts`, from the binary's embedded `default_models.json`): the
 * window Grok sizes a model by (`source`: the binary's, or `observed`: a model the binary lacks, from
 * `GrokObservedWindowsTable`; never models.dev's `limit.context`) and, where the binary has no price, models.dev's
 * prices as a marked seed (`costSource`). A model with a seeded price and no window has neither `context` nor `source`.
 */
export interface GrokModel {
  context?: number;
  source?: "binary" | "observed";
  autoCompactPercent?: number;
  cost?: ModelsDevCost;
  costSource?: "binary" | "models.dev-seed";
}

export interface GrokModelsTable {
  schema: 1;
  source: "grok binary default_models.json";
  grokVersion: string;
  generatedAt: string;
  digest: string;
  /** When Gluon built it on this machine (a moment); absent in a table a generator made. */
  fetchedAt?: string;
  models: Record<string, GrokModel>;
}

/**
 * The one hand-maintained table (`tables/grok-observed-windows.json`): the window Grok showed for a model its
 * binary's catalog doesn't list yet, with the evidence. Added only with a live observation, removed once the binary lists the model
 * (the builder says so: `grokTable`); `docs/contributing/internal.md` has the steps. Never stored locally: it is not built.
 */
export interface GrokObservedWindowsTable {
  schema: 1;
  source: "observed";
  note: string;
  models: Record<string, { context: number; observedAt: string; grokVersion: string; evidence: string }>;
}

export const GROK_OBSERVED_WINDOWS = grokObservedWindows as unknown as GrokObservedWindowsTable;
