/**
 * Grok Build's cost: Grok computes none locally (the xAI server stamps `cost_in_usd_ticks` on
 * API-key traffic; a plan's often has none), so this is Gluon's own estimate from
 * `grok_code.api_request` (verified on a real 1.0.46 against a mock backend, issue #39):
 *   `input_tokens` INCLUDES the cache reads; `output_tokens` includes the reasoning tokens;
 *   xAI has no cache-write price (`cache_creation_tokens` is 0).
 * cost = (uncached·in + cacheRead·cr + output·out) / 1e6, in the 200k context tier's prices when the
 * prompt exceeds 200,000 tokens (the tier's basis is the prompt: an assumption, named, unverified:
 * pricing is server-side). The server's own figure (`cost_usd_micros`, floored) only audits it.
 */
import { clamp, result, type CostResult } from "./types.ts";
import type { ModelsDevCost } from "./opencode.ts";
import { currentTables, GROK_OBSERVED_WINDOWS, type GrokModelsTable, type GrokObservedWindowsTable, type PriceEntry } from "./tables.ts";

export interface GrokUsage {
  /** Includes `cacheRead`. */
  input: number;
  cacheRead: number;
  /** Includes the reasoning tokens. */
  output: number;
}

const row = (c: ModelsDevCost) => ({ input: clamp(c.input), output: clamp(c.output), cacheRead: c.cache_read === undefined ? clamp(c.input) : clamp(c.cache_read) });

/** The tier a prompt of this size is in: the largest `tiers` size it strictly exceeds. */
const tierFor = (cost: ModelsDevCost, prompt: number) => (cost.tiers ?? []).filter((t) => t.tier?.type === "context" && prompt > clamp(t.tier.size)).sort((a, b) => b.tier.size - a.tier.size)[0];

export function grokCost(entry: PriceEntry, usage: GrokUsage): CostResult {
  const tier = tierFor(entry.cost, clamp(usage.input));
  const p = row(tier ? { ...entry.cost, ...tier } : entry.cost);
  const cacheRead = Math.min(clamp(usage.cacheRead), clamp(usage.input));
  const uncached = clamp(usage.input) - cacheRead;
  return result((uncached * p.input + cacheRead * p.cacheRead + clamp(usage.output) * p.output) / 1e6, tier ? ["long-context-tier-assumed"] : []);
}

/** The window when Grok's catalog and the observed table both lack the model: a guess (`windowIsGuess`), never the row's %: the one of Grok's embedded catalog (grok-4.5 and 4.6). */
export const GROK_DEFAULT_WINDOW = 500_000;

/** Where a Grok window came from: Grok's own table (`scripts/pricing/grok.ts`, the binary's), the observed table (`GrokObservedWindowsTable`), or the default (a guess). Never models.dev (BUG-396). */
export type GrokWindowSource = "grok-table" | "grok-observed" | "grok-default";

/**
 * The window Grok uses for a model: its own catalog's (`grokModels`, built from the installed binary:
 * checked on 1.0.46, its footer read 301K / 500K for a 300,000-token prompt and 1,000 output), else the
 * observed table's (a model the binary doesn't list yet: grok-4.7's footer read 13K / 256K), else the
 * default, a guess; the source says which. models.dev's `limit.context` is never one (BUG-396/397). A
 * user's `/context-window` isn't seen.
 */
export function grokWindowOf(model: string, table: GrokModelsTable | undefined = currentTables().grokModels, observed: GrokObservedWindowsTable = GROK_OBSERVED_WINDOWS): { window: number; source: GrokWindowSource } {
  const own = table && Object.hasOwn(table.models, model) ? table.models[model]! : undefined;
  if (own?.context && own.context > 0 && own.source === "binary") return { window: own.context, source: "grok-table" };
  // The generated table copies the observed one (`source: "observed"`); the observed table itself covers a table built before the model was added to it (none yet: it alone).
  const seen = Object.hasOwn(observed.models, model) ? observed.models[model]!.context : own?.source === "observed" ? own.context : undefined;
  if (seen && seen > 0) return { window: seen, source: "grok-observed" };
  return { window: GROK_DEFAULT_WINDOW, source: "grok-default" };
}

export const grokWindow = (model: string): number => grokWindowOf(model).window;

/** Grok's own table's price entry for an xAI model (its binary's, else a marked models.dev seed), else undefined: models.dev's takes over. */
export function grokTableEntry(model: string, table: GrokModelsTable | undefined = currentTables().grokModels): PriceEntry | undefined {
  const m = table && Object.hasOwn(table.models, model) ? table.models[model] : undefined;
  return m?.cost ? { cost: m.cost, context: m.context ?? null } : undefined;
}
