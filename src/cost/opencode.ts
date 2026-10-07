/**
 * OpenCode's cost, ported from its own `Y0`/`c6` (2.0.21; found in the binary, checked bit-exact
 * against every captured `session.step.ended` and compaction cost, `test/cost.test.ts`): the
 * price entry is chosen by the prompt size, then
 * `(input·in + (output + reasoning)·out + cache.read·cr + cache.write·cw) / 1e6`.
 * Reasoning is billed at the output rate (the catalog's `reasoning` price is ignored), a missing
 * cache price is 0, audio prices are ignored, and nothing is rounded.
 */
import { clamp, result, type CostResult } from "./types.ts";

export { OPENCODE_NO_MODEL } from "../adapters/opencode.ts";

/** OpenCode's token record for one step (`session.step.ended`), output EXCLUDING reasoning. */
export interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/** One price entry of OpenCode's internal model cost array: the base (no `tier`) or a context tier. */
export interface OpenCodePrice {
  tier?: { type: "context"; size: number };
  input: number;
  output: number;
  cache: { read: number; write: number };
}

/** The models.dev `cost` object of a model. */
export interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: { tier: { type: string; size: number }; input?: number; output?: number; cache_read?: number; cache_write?: number }[];
  /** Legacy: OpenCode turns it into a tier at 200000 whatever the provider (an OpenAI model's real tier is 272000). */
  context_over_200k?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

const entry = (c: { input?: number; output?: number; cache_read?: number; cache_write?: number }): Omit<OpenCodePrice, "tier"> => ({ input: clamp(c.input), output: clamp(c.output), cache: { read: clamp(c.cache_read), write: clamp(c.cache_write) } });

/** OpenCode's price entries for a models.dev `cost`: the base first, then each context tier. */
export function opencodePrices(cost: ModelsDevCost): OpenCodePrice[] {
  const out: OpenCodePrice[] = [entry(cost)];
  for (const t of cost.tiers ?? []) if (t.tier?.type === "context" && clamp(t.tier.size) > 0) out.push({ tier: { type: "context", size: t.tier.size }, ...entry(t) });
  if (cost.context_over_200k && !out.some((p) => p.tier?.size === 200_000)) out.push({ tier: { type: "context", size: 200_000 }, ...entry(cost.context_over_200k) });
  return out;
}

/** The entry for this prompt: the largest context tier it exceeds (strictly), else the base entry. */
export function opencodePriceFor(prices: OpenCodePrice[], tokens: OpenCodeTokens): OpenCodePrice | undefined {
  const prompt = clamp(tokens.input) + clamp(tokens.cache.read) + clamp(tokens.cache.write);
  let best: OpenCodePrice | undefined;
  for (const p of prices) if (p.tier?.type === "context" && prompt > p.tier.size && (!best || p.tier.size > best.tier!.size)) best = p;
  return best ?? prices.find((p) => !p.tier);
}

/** One step's (or compaction's) cost. No price entry at all: 0, as OpenCode. */
export function opencodeCost(tokens: OpenCodeTokens, prices: OpenCodePrice[]): CostResult {
  const p = opencodePriceFor(prices, tokens);
  if (!p) return result(0);
  const usd = (clamp(tokens.input) * p.input + (clamp(tokens.output) + clamp(tokens.reasoning)) * p.output + clamp(tokens.cache.read) * p.cache.read + clamp(tokens.cache.write) * p.cache.write) / 1e6;
  return result(usd);
}

/**
 * What OpenCode's footer counts as a conversation's context after a step: the step's whole prompt and answer, `input` (the
 * non-cached part) + cache read + cache write + output + reasoning (what the next request will carry; BUG-318).
 */
export const opencodeContextTokens = (t: OpenCodeTokens): number => clamp(t.input) + clamp(t.cache.read) + clamp(t.cache.write) + clamp(t.output) + clamp(t.reasoning);
