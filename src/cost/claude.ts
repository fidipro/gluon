/**
 * Claude Code's cost, ported from its own `vx`/`OQe`/`Ex` (2.1.289, found in the binary; the real
 * runs of issue #39 reproduce `cost_usd` exactly: `test/cost.test.ts`). Per request:
 *   tokens/1e6 × price for input, output, cache read and cache write (the 1h write at its own rate
 *   when the usage splits it), summed in that order; × 1.1 for `inference_geo: "us"`; plus
 *   $0.01-style per-request web search fees (not multiplied).
 * Not reproduced here (each is a named divergence the audit ledger attributes, see `claudeHypotheses` below):
 * server-pushed price aliases, `additionalModelCostsCache`, an organisation's `modelPricing`,
 * advisor and refusal-fallback iterations. Fast mode is a price row per model the catalog data
 * carries (`fastPricing`, from the binary's price function) that the tracker swaps in.
 * Claude Code's own fallback for an unknown model (a default row of its catalog) is NOT copied:
 * an unknown model has no figure of ours; a reported cost that is that fallback is only named (`claudeFallbackHypotheses`).
 */
import { clamp, result, type CostResult } from "./types.ts";

/** One catalog price row (`inputTokens` etc. are USD per million tokens, as in the binary). */
export interface ClaudePrice {
  inputTokens: number;
  outputTokens: number;
  promptCacheWriteTokens: number;
  /** Absent: a 1h write is billed at the 5m rate. */
  promptCacheWrite1hTokens?: number;
  promptCacheReadTokens: number;
  /** USD per request (not per million). */
  webSearchRequests: number;
  /** A prompt over `abovePromptTokens` (input + cache read + cache write) is billed wholly at this row's rates (`mP` in 2.1.293; a catalog tier's `long_prompt`: BUG-675). */
  longPrompt?: ClaudePrice & { abovePromptTokens: number };
}

/** A catalog price tier as Claude Code's catalog spells it: `long_prompt` is a second row for prompts over `above_prompt_tokens` (Haiku 5.5 on, 2.1.293; it shares the web search fee). */
export interface ClaudeTierRow {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  web_search: number;
  long_prompt?: { above_prompt_tokens: number; input: number; output: number; cache_write_5m: number; cache_write_1h?: number; cache_read: number };
}

/** The API's usage object, the fields the formula reads. */
export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null;
  server_tool_use?: { web_search_requests?: number } | null;
  inference_geo?: string | null;
}

/** US-only inference is billed 1.1x on every token term. */
export const CLAUDE_US_GEO_FACTOR = 1.1;

/** `vx`: the cache-write term. */
export function claudeCacheWriteUsd(price: ClaudePrice, usage: ClaudeUsage): number {
  const written = clamp(usage.cache_creation_input_tokens);
  const oneHour = Math.min(clamp(usage.cache_creation?.ephemeral_1h_input_tokens), written);
  if (price.promptCacheWrite1hTokens === undefined || oneHour <= 0) return (written / 1e6) * price.promptCacheWriteTokens;
  return (oneHour / 1e6) * price.promptCacheWrite1hTokens + ((written - oneHour) / 1e6) * price.promptCacheWriteTokens;
}

/** `mP`: the row a request is billed at: the long-prompt row when the whole prompt is over its threshold, else the usual one. */
export function claudeRowFor(price: ClaudePrice, usage: ClaudeUsage): ClaudePrice {
  const long = price.longPrompt;
  if (!long) return price;
  return clamp(usage.input_tokens) + clamp(usage.cache_read_input_tokens) + clamp(usage.cache_creation_input_tokens) > long.abovePromptTokens ? long : price;
}

/** `OQe` and `Ex`: one request's cost. `assumed5m`: the usage didn't split its cache write (OTEL's `cache_creation_tokens` is a total), so the 5m rate was assumed. */
export function claudeCost(basePrice: ClaudePrice, usage: ClaudeUsage, { assumed5m = false }: { assumed5m?: boolean } = {}): CostResult {
  const price = claudeRowFor(basePrice, usage);
  const tokens = (clamp(usage.input_tokens) / 1e6) * price.inputTokens + (clamp(usage.output_tokens) / 1e6) * price.outputTokens + (clamp(usage.cache_read_input_tokens) / 1e6) * price.promptCacheReadTokens + claudeCacheWriteUsd(price, usage);
  const search = clamp(usage.server_tool_use?.web_search_requests) * price.webSearchRequests;
  const usd = tokens * (usage.inference_geo === "us" ? CLAUDE_US_GEO_FACTOR : 1) + search;
  return result(usd, assumed5m && clamp(usage.cache_creation_input_tokens) > 0 && price.promptCacheWrite1hTokens !== undefined ? ["cache-ttl-assumed-5m"] : []);
}

type ModelsDevRow = { input?: number; output?: number; cache_read?: number; cache_write?: number };

/**
 * A catalog row as Claude Code prices it, from a models.dev `cost` (its 1h write is 2x the input price in every catalog tier of 2.1.289).
 * Its smallest `context` tier is the long-prompt row, as the catalog's `long_prompt` (Haiku 5.5's, over 100k): a model outside
 * Claude Code's catalog (an OpenRouter id) is billed by it too.
 */
export function claudePriceFrom(cost: ModelsDevRow & { tiers?: ({ tier: { type: string; size: number } } & ModelsDevRow)[] }): ClaudePrice {
  const row = (c: ModelsDevRow): ClaudePrice => {
    const input = clamp(c.input);
    return { inputTokens: input, outputTokens: clamp(c.output), promptCacheWriteTokens: c.cache_write === undefined ? input * 1.25 : clamp(c.cache_write), promptCacheWrite1hTokens: input * 2, promptCacheReadTokens: c.cache_read === undefined ? input * 0.1 : clamp(c.cache_read), webSearchRequests: 0.01 };
  };
  const long = (cost.tiers ?? []).filter((t) => t.tier?.type === "context" && clamp(t.tier.size) > 0).sort((a, b) => a.tier.size - b.tier.size)[0];
  if (!long) return row(cost);
  // A tier without its own input or output price keeps the base one; its cache prices follow its own input, as the base row's do.
  const longRow = row({ input: long.input ?? cost.input, output: long.output ?? cost.output, cache_read: long.cache_read, cache_write: long.cache_write });
  return { ...row(cost), longPrompt: { ...longRow, abovePromptTokens: long.tier.size } };
}

/**
 * The named divergence causes of a request whose cost Gluon computes from OTEL's counts (no cache
 * TTL split, no geo, `speed` unreliable): how many micro-USD each would add to our figure.
 * `assumedTtl`: the TTL our figure assumed (a cause that reverses it subtracts); `fast`: the same
 * request priced from the fast table.
 */
export function claudeHypotheses(price: ClaudePrice, usage: ClaudeUsage, fast?: ClaudePrice, assumedTtl: "5m" | "1h" = "5m"): { name: string; deltaMicros: number }[] {
  const own = claudeCost(price, usage);
  const written = clamp(usage.cache_creation_input_tokens);
  const row = claudeRowFor(price, usage);
  const step = Math.round(written * ((row.promptCacheWrite1hTokens ?? row.promptCacheWriteTokens) - row.promptCacheWriteTokens));
  const out = [
    assumedTtl === "5m" ? { name: "cache-ttl-1h", deltaMicros: step } : { name: "cache-ttl-5m", deltaMicros: -step },
    { name: "us-geo", deltaMicros: Math.round(own.micros * (CLAUDE_US_GEO_FACTOR - 1)) },
    { name: "web-search", deltaMicros: Math.round(price.webSearchRequests * 1e6) },
    { name: "web-search", deltaMicros: Math.round(price.webSearchRequests * 2e6) },
  ];
  if (fast) out.push({ name: "fast-mode", deltaMicros: claudeCost(fast, usage).micros - own.micros });
  return out;
}

/** A catalog price tier as Claude Code's own table: the 5m and 1h cache-write prices, the web search fee. */
export function claudePriceFromTier(t: ClaudeTierRow): ClaudePrice {
  const row = (r: { input: number; output: number; cache_write_5m: number; cache_write_1h?: number; cache_read: number }): ClaudePrice => ({
    inputTokens: r.input,
    outputTokens: r.output,
    promptCacheWriteTokens: r.cache_write_5m,
    ...(r.cache_write_1h === undefined ? {} : { promptCacheWrite1hTokens: r.cache_write_1h }),
    promptCacheReadTokens: r.cache_read,
    webSearchRequests: t.web_search,
  });
  const long = t.long_prompt;
  return { ...row(t), ...(long ? { longPrompt: { ...row(long), abovePromptTokens: long.above_prompt_tokens } } : {}) };
}

/** The cause named when Gluon priced a request from the connection's own row (Bedrock's) and Claude Code at its catalog's list price. */
export const HARNESS_LIST_PRICE = "harness-list-price";

/** The cause named when Claude Code priced an id its catalog doesn't list (an OpenRouter or gateway spelling) at a default row of its own. */
export const HARNESS_UNKNOWN_MODEL_PRICE = "harness-unknown-model-price";

/**
 * For a request on an id absent from Claude Code's catalog: what its own fallback price would add to our figure. Claude Code prices such
 * an id at a catalog row it picks itself (the default model's: a live OpenRouter run got 4x Haiku 4.5's figure), so every distinct row of
 * the local catalog table is a candidate, at either cache TTL (OTEL can't show it): the cause is named when the reported cost lands on one.
 * `ownMicros`: our figure of the same request.
 */
export function claudeFallbackHypotheses(rows: ClaudePrice[], usage: ClaudeUsage, ownMicros: number): { name: string; deltaMicros: number }[] {
  const written = clamp(usage.cache_creation_input_tokens);
  const deltas = new Set<number>();
  for (const row of rows)
    for (const oneHour of [false, true]) deltas.add(claudeCost(row, { ...usage, cache_creation: { ephemeral_1h_input_tokens: oneHour ? written : 0 } }).micros - ownMicros);
  return [...deltas].map((deltaMicros) => ({ name: HARNESS_UNKNOWN_MODEL_PRICE, deltaMicros }));
}
