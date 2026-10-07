/**
 * Codex's cost: Codex computes none locally (its `codex.turn_cost` comes from the server, minutes
 * late), so this is Gluon's own estimate from `codex.sse_event response.completed` (verified on a
 * real 0.159.3, `test/fixtures/telemetry/codex-0.159.3-live-luna.jsonl`, and
 * `codex-0.159.3-live-api-luna-telemetry.jsonl`: 11,162 input of which 11,129 cached and 30 written; BUG-384):
 *   `input_token_count` includes the cached tokens and the cache writes; `output_token_count`
 *   includes the reasoning tokens; `service_tier` is the tier Codex REQUESTED (it never reports the
 *   served one: spike of issue #39), so a priced tier is a named assumption.
 * cost = (uncached·in + cached·cr + written·cw + output·out) / 1e6, with the row of the requested
 * tier's priced mode (models.dev `experimental.modes`: priority is the `fast` mode), and the
 * context tier above 272k prompt tokens. A missing cache price is billed at the input rate.
 */
import { clamp, result, type Assumption, type CostResult } from "./types.ts";
import type { ModelsDevCost } from "./opencode.ts";
import type { PriceEntry } from "./tables.ts";

/** One `response.completed`: the counts as Codex reports them. */
export interface CodexUsage {
  /** Includes `cached` and `cacheWrite`. */
  input: number;
  cached: number;
  cacheWrite: number;
  /** Includes the reasoning tokens. */
  output: number;
  /** The requested tier (`priority`, `flex`, …); absent = standard. */
  serviceTier?: string;
}

type Row = { input: number; output: number; cache_read: number; cache_write: number };
const row = (c: ModelsDevCost): Row => ({ input: clamp(c.input), output: clamp(c.output), cache_read: c.cache_read === undefined ? clamp(c.input) : clamp(c.cache_read), cache_write: c.cache_write === undefined ? clamp(c.input) : clamp(c.cache_write) });

/** The context tier a prompt of this size is in: the largest `tiers` size it strictly exceeds. */
const longTier = (cost: ModelsDevCost, prompt: number) => (cost.tiers ?? []).filter((t) => t.tier?.type === "context" && prompt > clamp(t.tier.size)).sort((a, b) => b.tier.size - a.tier.size)[0];

export function codexCost(entry: PriceEntry, usage: CodexUsage): CostResult {
  const assumptions: Assumption[] = [];
  const base = entry.cost;
  const tier = usage.serviceTier && usage.serviceTier !== "default" ? usage.serviceTier : undefined;
  if (tier) assumptions.push("service-tier-requested");
  const mode = tier ? Object.values(entry.modes ?? {}).find((m) => m.serviceTier === tier) : undefined;
  let p = row(mode?.cost ?? base);
  const long = longTier(base, clamp(usage.input));
  if (long) {
    const longRow = row({ ...base, ...long });
    if (!mode) p = longRow;
    else {
      // A priced mode lists no tiers: scale each of its prices by the long tier's step over the base (an assumption).
      const b = row(base);
      const scale = (k: keyof Row) => (b[k] > 0 ? p[k] * (longRow[k] / b[k]) : p[k]);
      p = { input: scale("input"), output: scale("output"), cache_read: scale("cache_read"), cache_write: scale("cache_write") };
      assumptions.push("long-context-tier-assumed");
    }
  }
  const cached = clamp(usage.cached);
  const written = clamp(usage.cacheWrite);
  const uncached = Math.max(0, clamp(usage.input) - cached - written);
  return result((uncached * p.input + cached * p.cache_read + written * p.cache_write + clamp(usage.output) * p.output) / 1e6, assumptions);
}
