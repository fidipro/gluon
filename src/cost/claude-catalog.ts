/**
 * Building the Claude catalog table (`claude-catalog`) from Claude Code's model catalog:
 * the literal baked into its binary (Anthropic's published catalog has no prices, so there is no other source). Pure (text in, table out):
 * `scripts/pricing/claude.ts` (a manual refresh) and `gluon pricing update` (`pricing-update.ts`) both
 * call these, so a table is built one way wherever it is built. The literal is parsed, never evaluated.
 */
import { createHash } from "node:crypto";
import type { ClaudeTierRow } from "./claude.ts";
import { balancedObject, parseJsLiteral } from "./jsliteral.ts";

export const ANCHOR = "Hand-maintained baked-in model catalog";

/** The catalog object literal's text inside a binary's bytes, or null. */
export function catalogText(bytes: Buffer): string | null {
  const at = bytes.indexOf(ANCHOR);
  if (at < 0) return null;
  // The literal opens just before its `"//":` comment key.
  const start = bytes.subarray(Math.max(0, at - 40), at).toString("latin1").lastIndexOf("{");
  if (start < 0) return null;
  const from = Math.max(0, at - 40) + start;
  return balancedObject(bytes.subarray(from, from + 400_000).toString("latin1"), 0);
}

export interface ClaudeCatalogModel {
  id: string;
  family: string;
  /** The ids by provider (`first_party`, `bedrock`, `vertex`, `foundry`, `anthropic_aws`, `anthropic_google_cloud`, `mantle`, `gateway`). */
  providerIds: Record<string, string>;
  pricing: string;
  window: number;
  native1m: boolean;
  supports1mSuffix: boolean;
  supports1mBeta: boolean;
}

/** The window of a catalog model that has no `context` (a legacy one). */
const LEGACY_WINDOW = 200_000;

/** The trimmed table from the parsed catalog. */
export function trim(catalog: Record<string, unknown>): { pricingTiers: Record<string, ClaudeTierRow>; models: ClaudeCatalogModel[] } {
  const tiers = catalog.pricing_tiers as Record<string, ClaudeTierRow>;
  const raw = catalog.models as Record<string, unknown>[];
  // A `claude-3-…` model with no `context` at all is a legacy one (3.5 Haiku, 3.5 and 3.7 Sonnet in 2.1.290 to 2.1.293: Claude Code's own schema makes `context` optional and its `bye()` tests for `claude-3-`): 200k.
  // Any other model without one throws below: a layout that moved must not size 1M models 200k (BUG-633, 675).
  const models = raw.map((m): ClaudeCatalogModel => {
    const ctx = (m.context ?? {}) as Record<string, unknown>;
    const ids: Record<string, string> = {};
    for (const [k, v] of Object.entries((m.provider_ids ?? {}) as Record<string, unknown>)) if (typeof v === "string") ids[k] = v;
    if (typeof m.id !== "string" || typeof m.pricing !== "string" || !tiers[m.pricing]) throw new Error(`catalog model without an id or a known price tier: ${JSON.stringify(m.id)}`);
    // No default window: a layout Claude Code changed would size every 1M model 200k and read its context 5x too full (QA-cost-08, BUG-633). The build fails, the stored table stands (BUG-524).
    if (m.context === undefined && m.id.startsWith("claude-3-")) return { id: m.id, family: String(m.family), providerIds: ids, pricing: m.pricing, window: LEGACY_WINDOW, native1m: false, supports1mSuffix: false, supports1mBeta: false };
    if (typeof ctx.window !== "number" || !Number.isFinite(ctx.window) || ctx.window <= 0) throw new Error(`catalog model without a context window: ${m.id} (the catalog's layout moved: update src/cost/claude-catalog.ts)`);
    return { id: m.id, family: String(m.family), providerIds: ids, pricing: m.pricing, window: ctx.window, native1m: ctx.native_1m === true, supports1mSuffix: ctx.supports_1m_suffix === true, supports1mBeta: ctx.supports_1m_beta === true };
  });
  return { pricingTiers: tiers, models: models.sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

/** One price row of the catalog's shape (USD per million tokens; web search per request). */
export interface ClaudeTier {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  web_search: number;
}

const FAST_ANCHOR = 'speed==="fast"){if(';

/** The part of a binary's bytes that holds its price function's fast-mode branch and the rows it returns, or null. */
export function fastPricingText(bytes: Buffer): string | null {
  const at = bytes.indexOf(FAST_ANCHOR);
  if (at < 0) return null;
  return bytes.subarray(Math.max(0, at - 20000), at + 1000).toString("latin1");
}

/**
 * Claude Code's fast-mode prices by model id, from its price function: `if(<speed>==="fast"){if(r==="claude-opus-5-5")return m_;
 * if(r==="claude-opus-4-8"||r==="claude-opus-5")return Ws;…}`, each name a row `m_={inputTokens:8,outputTokens:40,…}` defined beside it.
 * A model that is in no branch is priced as usual when fast. Empty when the text isn't that shape.
 */
export function fastPrices(text: string): Record<string, ClaudeTier> {
  const branch = text.match(/\w+\.speed==="fast"\)\{((?:if\([\w$]+==="claude-[\w.-]+"(?:\|\|[\w$]+==="claude-[\w.-]+")*\)return [\w$]+;?)+)/);
  if (!branch) return {};
  const out: Record<string, ClaudeTier> = {};
  for (const [, cond, row] of branch[1]!.matchAll(/if\(([^)]*)\)return ([\w$]+);?/g)) {
    const def = text.match(new RegExp(`(?<![\\w$])${row!.replaceAll("$", "\\$")}=\\{(inputTokens:[^}]*)\\}`));
    if (!def) throw new Error(`fast-mode row ${row} has no definition beside its branch: update src/cost/claude-catalog.ts`);
    const v = Object.fromEntries([...def[1]!.matchAll(/(\w+):([\d.e+-]+)/g)].map(([, k, n]) => [k!, Number(n)])) as Record<string, number>;
    const tier = { input: v.inputTokens, output: v.outputTokens, cache_write_5m: v.promptCacheWriteTokens, cache_write_1h: v.promptCacheWrite1hTokens, cache_read: v.promptCacheReadTokens, web_search: v.webSearchRequests };
    if (Object.values(tier).some((n) => !Number.isFinite(n))) throw new Error(`fast-mode row ${row} is incomplete: update src/cost/claude-catalog.ts`);
    for (const [, id] of cond!.matchAll(/"(claude-[\w.-]+)"/g)) out[id!] = tier as ClaudeTier;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The fast-mode rows of a binary's bytes; throws when its price function has none (it moved: the job must fail, not drop the rows). */
export function fastPricingOf(bytes: Buffer): Record<string, ClaudeTier> {
  const text = fastPricingText(bytes);
  const fast = text ? fastPrices(text) : {};
  if (!Object.keys(fast).length) throw new Error("no fast-mode prices in the claude binary (its price function moved: update src/cost/claude-catalog.ts)");
  return fast;
}

/**
 * The table for a catalog's text (the installed binary's literal): deterministic, its digest is the text's. `version` is the Claude Code version it
 * came from. `fastPricing` (a price function's rows, not in the catalog) comes from the same binary's `bytes` (`fastPricingOf`, which throws when they are gone).
 */
export function claudeTable(text: string, { version, bytes, fastPricing }: { version: string; bytes?: Buffer; fastPricing?: Record<string, ClaudeTier> }) {
  const fast = bytes ? fastPricingOf(bytes) : fastPricing;
  return { schema: 1 as const, source: "claude-code binary" as const, claudeCodeVersion: version, catalogDigest: createHash("sha256").update(text).digest("hex"), ...trim(parseJsLiteral(text) as Record<string, unknown>), ...(fast ? { fastPricing: fast } : {}) };
}
