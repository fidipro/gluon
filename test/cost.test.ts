/**
 * Gluon's own cost functions (`src/cost/`, issue #39) against what the harnesses themselves reported
 * for the same requests: real captures (`test/fixtures/telemetry/`, real runs of issue #39), ids removed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCost, claudePriceFrom, claudePriceFromTier, type ClaudePrice } from "../src/cost/claude.ts";
import { balancedObject, parseJsLiteral } from "../scripts/pricing/jsliteral.ts";
import { catalogText, fastPrices, fastPricingText, trim } from "../scripts/pricing/claude.ts";
import { claudeTable } from "../src/cost/claude-catalog.ts";
import { claudeCatalogLiteral } from "./fixtures/pricing-sources.ts";
import { buildTable } from "../scripts/pricing/codex.ts";
import { claudeContextWindow, claudeContextWindowByName } from "../src/models.ts";
import * as agyModule from "../src/cost/antigravity.ts";
import { agyModelId, agyWindow } from "../src/cost/antigravity.ts";
import { contextCause, ownPercent, ownWindow, windowIsGuess } from "../src/cost/context.ts";
import { codexCost, type CodexUsage } from "../src/cost/codex.ts";
import { priceKey } from "../src/cost/keys.ts";
import { Ledger } from "../src/cost/ledger.ts";
import { reportLines } from "../src/cost/report.ts";
import { CostTracker, SETTLE_GRACE_MS } from "../src/cost/tracker.ts";
import { FROZEN_CLAUDE_CATALOG, FROZEN_GROK_MODELS, FROZEN_TABLE, frozenEntry, frozenTableWith, frozenTracker } from "./fixtures/frozen-prices.ts";
import { opencodeCost, opencodePrices, opencodePriceFor, type OpenCodePrice } from "../src/cost/opencode.ts";
import { claudeCatalogModel, priceEntry } from "../src/cost/tables.ts";
import { FIXTURE_CLAUDE_CATALOG as CLAUDE_CATALOG, FIXTURE_CODEX_WINDOWS as CODEX_WINDOWS, FIXTURE_MODELS_DEV as MODELS_DEV } from "./fixtures/fixture-tables.ts";
import { DEFAULT_MODELS, idOn, type Conn, type Harness } from "../src/harnesses.ts";
import { claudeCacheTtl } from "../src/cost/harness-config.ts";
import { changeProblems, tableProblem } from "../src/cost/table-schema.ts";
import { costLabel } from "../src/sessions.ts";

const DIR = join(import.meta.dir, "fixtures", "telemetry");

/** Claude Code's catalog tiers (USD per million; the 2.1.289 binary's `usr` catalog). */
const HAIKU_45: ClaudePrice = { inputTokens: 1, outputTokens: 5, promptCacheWriteTokens: 1.25, promptCacheWrite1hTokens: 2, promptCacheReadTokens: 0.1, webSearchRequests: 0.01 };
const OPUS_46: ClaudePrice = { inputTokens: 5, outputTokens: 25, promptCacheWriteTokens: 6.25, promptCacheWrite1hTokens: 10, promptCacheReadTokens: 0.5, webSearchRequests: 0.01 };

describe("Claude Code: the ported cost function reproduces its own cost_usd", () => {
  type Attrs = Record<string, string | number>;
  const apiRequests = (file: string): Attrs[] => {
    const out: Attrs[] = [];
    for (const l of readFileSync(join(DIR, file), "utf8").split("\n").filter(Boolean)) {
      const body = JSON.parse(l).body as { resourceLogs?: { scopeLogs: { logRecords: { attributes: { key: string; value: Record<string, string | number> }[] }[] }[] }[] };
      for (const rl of body.resourceLogs ?? []) for (const sl of rl.scopeLogs) for (const r of sl.logRecords) {
        const a: Attrs = {};
        for (const kv of r.attributes) a[kv.key] = Object.values(kv.value)[0]!;
        if (a["event.name"] === "api_request") out.push(a);
      }
    }
    return out;
  };

  test("every request of a real Haiku 4.5 run (main thread, title, /compact), to the micro-dollar", () => {
    const requests = apiRequests("claude-code-2.1.289-live-haiku.jsonl");
    expect(requests.length).toBeGreaterThanOrEqual(5);
    for (const a of requests) {
      const cost = claudeCost(HAIKU_45, { input_tokens: Number(a.input_tokens), output_tokens: Number(a.output_tokens), cache_read_input_tokens: Number(a.cache_read_tokens), cache_creation_input_tokens: Number(a.cache_creation_tokens) });
      expect([a.query_source, cost.micros]).toEqual([a.query_source, Number(a.cost_usd_micros)]);
      expect(cost.usd).toBeCloseTo(Number(a.cost_usd), 12);
    }
  });

  test("a real Opus 4.6 [1m] request: 3 input + 21,929 cache-creation + 4 output = $0.13717125 (the 5m write rate)", () => {
    const cost = claudeCost(OPUS_46, { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 21_929 });
    expect(cost.usd).toBeCloseTo(0.13717125, 12);
    expect(cost.micros).toBe(137_171);
  });

  test("the terms Claude Code adds that OTEL doesn't carry: 1h writes, US inference (x1.1 on tokens only), web searches", () => {
    const u = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 10_000 };
    const base = claudeCost(OPUS_46, u).usd;
    expect(base).toBeCloseTo((1000 * 5 + 500 * 25 + 2000 * 0.5 + 10_000 * 6.25) / 1e6, 12);
    // All of the write at the 1h rate; half of it.
    expect(claudeCost(OPUS_46, { ...u, cache_creation: { ephemeral_1h_input_tokens: 10_000, ephemeral_5m_input_tokens: 0 } }).usd).toBeCloseTo(base + (10_000 * (10 - 6.25)) / 1e6, 12);
    expect(claudeCost(OPUS_46, { ...u, cache_creation: { ephemeral_1h_input_tokens: 5_000, ephemeral_5m_input_tokens: 5_000 } }).usd).toBeCloseTo(base + (5_000 * (10 - 6.25)) / 1e6, 12);
    // More 1h tokens than were written count as written, no more.
    expect(claudeCost(OPUS_46, { ...u, cache_creation: { ephemeral_1h_input_tokens: 99_999 } }).usd).toBeCloseTo(base + (10_000 * (10 - 6.25)) / 1e6, 12);
    // US inference multiplies the token terms; a web search fee comes on top, unmultiplied.
    expect(claudeCost(OPUS_46, { ...u, inference_geo: "us", server_tool_use: { web_search_requests: 2 } }).usd).toBeCloseTo(base * 1.1 + 0.02, 12);
    // No 1h price in the row: the 1h part is billed at the 5m rate.
    expect(claudeCost({ ...OPUS_46, promptCacheWrite1hTokens: undefined }, { ...u, cache_creation: { ephemeral_1h_input_tokens: 10_000 } }).usd).toBeCloseTo(base, 12);
  });

  test("an OTEL-only request (no TTL split) with a cache write is flagged: the 5m rate was assumed", () => {
    expect(claudeCost(OPUS_46, { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 100 }, { assumed5m: true }).assumptions).toEqual(["cache-ttl-assumed-5m"]);
    expect(claudeCost(OPUS_46, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 100 }, { assumed5m: true }).exact).toBe(true);
  });
});

describe("OpenCode: the ported Y0 reproduces its own step costs", () => {
  test("the real deepseek-v4-flash run (OpenRouter): both steps, bit for bit", () => {
    const prices = opencodePrices({ input: 0.0224, output: 1.28, cache_read: 0.0224 });
    // session.step.ended of a real OpenCode 2.0.21: cost 0.0001341984 and 0.000137296.
    expect(opencodeCost({ input: 5191, output: 3, reasoning: 11, cache: { read: 0, write: 0 } }, prices).usd).toBe(0.0001341984);
    expect(opencodeCost({ input: 95, output: 3, reasoning: 13, cache: { read: 5120, write: 0 } }, prices).usd).toBe(0.000137296);
  });

  test("all 31 captured step and compaction costs of real OpenCode 2.0.21 runs (4 cross a context tier), bit for bit", () => {
    type Entry = { source: string; kind: string; tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }; reportedCost: number; price: OpenCodePrice[] };
    const { entries } = JSON.parse(readFileSync(join(DIR, "opencode-2.0.21-cost-steps.json"), "utf8")) as { entries: Entry[] };
    expect(entries.length).toBe(31);
    for (const e of entries) expect([e.source, e.kind, opencodeCost(e.tokens, e.price).usd]).toEqual([e.source, e.kind, e.reportedCost]);
    expect(entries.filter((e) => e.price.some((p) => p.tier) && opencodePriceFor(e.price, e.tokens)?.tier).length).toBe(4);
  });

  test("a configured price: reasoning at the output rate, cache read and write at their own", () => {
    const prices = opencodePrices({ input: 2, output: 10, cache_read: 0.5, cache_write: 3 });
    expect(opencodeCost({ input: 10_000, output: 1_600, reasoning: 400, cache: { read: 20_000, write: 0 } }, prices).usd).toBe(0.05);
    expect(opencodeCost({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 1000 } }, prices).usd).toBe(0.003);
  });

  test("context tiers: the largest one the prompt (input + cache read + cache write) strictly exceeds; the legacy context_over_200k is a tier at 200000 whatever the provider", () => {
    const prices = opencodePrices({ input: 4, output: 12, cache_read: 1, tiers: [{ tier: { type: "context", size: 272_000 }, input: 8, output: 18, cache_read: 2 }], context_over_200k: { input: 6, output: 15, cache_read: 1.5 } });
    const at = (prompt: number) => opencodePriceFor(prices, { input: prompt, output: 1, reasoning: 0, cache: { read: 0, write: 0 } })!.input;
    expect([at(200_000), at(200_001), at(272_000), at(272_001)]).toEqual([4, 6, 6, 8]);
    // Output is not part of the prompt.
    expect(opencodePriceFor(prices, { input: 100, output: 999_999, reasoning: 0, cache: { read: 0, write: 0 } })!.input).toBe(4);
  });

  test("no price entry, or junk counts and rates: 0, never NaN", () => {
    expect(opencodeCost({ input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, []).usd).toBe(0);
    const junk = opencodePrices({ input: Number.NaN, output: 1 });
    expect(opencodeCost({ input: 1e6, output: Number.POSITIVE_INFINITY, reasoning: -5, cache: { read: 0, write: 0 } }, junk).usd).toBe(0);
  });
});

describe("the price table (scripts/pricing/modelsdev.ts)", () => {
  const pairs = (Object.entries(DEFAULT_MODELS) as [Harness, (typeof DEFAULT_MODELS)[Harness]][]).flatMap(([harness, models]) => models.flatMap((m) => (Object.keys(m.ids) as Conn[]).map((conn) => ({ harness, model: m.id, conn, key: priceKey(harness, m.ids, conn) }))));

  test("every model Gluon offers on every connection has a price (and a key): a gap is a failing test, not a silent \u2014", () => {
    expect(pairs.length).toBeGreaterThan(30);
    expect(pairs.filter((p) => !p.key).map((p) => `${p.harness}/${p.model}/${p.conn}`)).toEqual([]);
    expect(pairs.filter((p) => !priceEntry(p.key)).map((p) => `${p.harness}/${p.model}/${p.conn}: ${p.key}`)).toEqual([]);
    expect(MODELS_DEV.missing).toEqual([]);
  });

  test("BUG-413/live-tables-size-every-offered-model: the live tables give every model Gluon offers a window (the table-dependent half of the coverage; the replays price from the frozen snapshot, not these)", () => {
    const unsized = pairs.filter((p) => p.key && ownWindow(p.harness, p.harness === "opencode" ? p.key : p.model).window === undefined);
    expect(unsized.map((p) => `${p.harness}/${p.model}/${p.conn}: ${p.key}`)).toEqual([]);
    // The guess for a Grok model no table lists is a default, not a window.
    expect(pairs.filter((p) => p.harness === "grok-build" && windowIsGuess(ownWindow(p.harness, p.model).source)).map((p) => p.model)).toEqual([]);
  });

  test("BUG-413/frozen-snapshot-shape: the prices the replays use are three tables of the shapes the live ones have (models.dev's trimmed to the entries looked up), dated, and not the live objects (editing the live tables cannot move a replay)", () => {
    for (const [key, e] of Object.entries(FROZEN_TABLE.entries)) expect([key, typeof e.cost.input, typeof e.cost.output, typeof e.context]).toEqual([key, "number", "number", "number"]);
    expect(tableProblem("claude-catalog", FROZEN_CLAUDE_CATALOG)).toBeNull();
    expect(tableProblem("grok-models", FROZEN_GROK_MODELS)).toBeNull();
    expect(FROZEN_TABLE.generatedAt).toMatch(/^20\d\d-\d\d-\d\d$/);
    expect(Object.keys(FROZEN_TABLE.entries).length).toBeGreaterThan(5);
    expect(FROZEN_TABLE.missing).toEqual([]);
    expect([FROZEN_TABLE, FROZEN_CLAUDE_CATALOG, FROZEN_GROK_MODELS]).not.toContain(MODELS_DEV);
    expect(FROZEN_TABLE.entries).not.toBe(MODELS_DEV.entries);
  });

  test("BUG-360/table-age: the table carries its source's date (null: the public API's catalog has none, only OpenCode's cached copy does), the day it was generated, and a digest; every entry has input and output prices", () => {
    if (MODELS_DEV.catalogUpdatedAt !== null) expect(MODELS_DEV.catalogUpdatedAt).toMatch(/^20\d\d-\d\d-\d\dT/);
    expect(MODELS_DEV.generatedAt).toMatch(/^20\d\d-\d\d-\d\d$/);
    expect(MODELS_DEV.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const [key, e] of Object.entries(MODELS_DEV.entries)) expect([key, typeof e.cost.input, typeof e.cost.output]).toEqual([key, "number", "number"]);
  });

  test("a connection decides the price: the same Claude model on the API, Bedrock and OpenRouter, and the plan priced as the vendor's API", () => {
    const haiku = DEFAULT_MODELS["claude-code"].find((m) => m.id === "haiku")!;
    expect(priceKey("claude-code", haiku.ids, "plan")).toBe("anthropic/claude-haiku-5-5");
    expect(priceKey("claude-code", haiku.ids, "bedrock")).toBe("amazon-bedrock/global.anthropic.claude-haiku-5-5");
    expect(priceKey("claude-code", haiku.ids, "openrouter")).toBe("openrouter/anthropic/claude-haiku-5.5");
    expect(priceEntry("anthropic/claude-haiku-5-5", MODELS_DEV)!.cost).toMatchObject({ input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 });
    expect(priceEntry(undefined)).toBeUndefined();
    expect(priceEntry("anthropic/made-up")).toBeUndefined();
  });

  test("OpenCode's own models price through the table: a gpt-6 tier above 272k, and the legacy 200k tier OpenCode adds", () => {
    const luna = frozenEntry("openai/gpt-6-luna")!;
    const prices = opencodePrices(luna.cost);
    expect(prices.map((p) => p.tier?.size ?? 0).sort()).toEqual([0, 200_000, 272_000]);
    const at = (prompt: number) => opencodeCost({ input: prompt, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, prices).usd;
    expect(at(100_000)).toBeCloseTo((100_000 * 0.1) / 1e6, 12);
    expect(at(250_000)).toBeCloseTo((250_000 * 0.2) / 1e6, 12);
  });
});

describe("Codex: Gluon's own estimate from response.completed (Codex reports no cost of its own)", () => {
  const luna = frozenEntry("openai/gpt-6-luna")!;
  const attrs = (l: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const body = JSON.parse(l).body as { resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string; value: Record<string, string> }[] }[] }[] }[] };
    for (const r of body.resourceLogs[0]!.scopeLogs[0]!.logRecords) for (const kv of r.attributes) if (kv.key === "input_token_count") for (const k of r.attributes) out[k.key] = Object.values(k.value)[0]!;
    return out;
  };
  const usages = readFileSync(join(DIR, "codex-0.159.3-live-luna.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(attrs)
    .filter((a) => a.input_token_count)
    .map((a): CodexUsage => ({ input: Number(a.input_token_count), cached: Number(a.cached_token_count), cacheWrite: Number(a.cache_write_token_count), output: Number(a.output_token_count), ...(a.service_tier ? { serviceTier: a.service_tier } : {}) }));

  test("the three real requests of a gpt-6-luna session: priority (main), standard (title thread), priority (main) = $0.011525; the tier is a named assumption", () => {
    expect(usages.map((u) => u.serviceTier)).toEqual(["priority", undefined, "priority"]);
    const costs = usages.map((u) => codexCost(luna, u));
    // (3 uncached x 0.2 + 10,608 written x 0.25 + 228 out x 1) / 1e6, the priority (fast) mode's prices.
    expect(costs[0]!.usd).toBeCloseTo((3 * 0.2 + 10_608 * 0.25 + 228 * 1) / 1e6, 12);
    expect(costs[1]!.usd).toBeCloseTo((3 * 0.1 + 7_192 * 0.125 + 115 * 0.5) / 1e6, 12);
    expect(costs[2]!.usd).toBeCloseTo((3 * 0.2 + 10_608 * 0.02 + 29_810 * 0.25 + 22 * 1) / 1e6, 12);
    expect(costs.reduce((n, c) => n + c.usd, 0)).toBeCloseTo(0.011525, 6);
    expect(costs.map((c) => c.assumptions)).toEqual([["service-tier-requested"], [], ["service-tier-requested"]]);
    // The same tokens at standard prices only: priority roughly doubles it.
    expect(usages.map((u) => codexCost(luna, { ...u, serviceTier: undefined }).usd).reduce((n, c) => n + c, 0)).toBeCloseTo(0.006241, 6);
  });

  test("the context tier above 272k prompt tokens (strictly), and a priced mode without tiers scaled by it (an assumption)", () => {
    const at = (input: number, serviceTier?: string) => codexCost(luna, { input, cached: 0, cacheWrite: 0, output: 0, ...(serviceTier ? { serviceTier } : {}) });
    expect(at(272_000).usd).toBeCloseTo((272_000 * 0.1) / 1e6, 12);
    expect(at(272_001).usd).toBeCloseTo((272_001 * 0.2) / 1e6, 12);
    const long = at(300_000, "priority");
    expect(long.usd).toBeCloseTo((300_000 * 0.4) / 1e6, 12);
    expect(long.assumptions).toEqual(["service-tier-requested", "long-context-tier-assumed"]);
  });

  test("a tier with no priced mode (flex) is priced at the base and flagged; a missing cache price is billed at the input rate", () => {
    const flex = codexCost(luna, { input: 1000, cached: 0, cacheWrite: 0, output: 1000, serviceTier: "flex" });
    expect(flex.usd).toBeCloseTo((1000 * 0.1 + 1000 * 0.5) / 1e6, 12);
    expect(flex.assumptions).toEqual(["service-tier-requested"]);
    const oss = { cost: { input: 0.15, output: 0.6 }, context: null };
    expect(codexCost(oss, { input: 1000, cached: 400, cacheWrite: 0, output: 0 }).usd).toBeCloseTo((1000 * 0.15) / 1e6, 12);
  });
});

describe("the per-launch tracker: our figure, the harness's beside it, the cause of a difference", () => {
  const entriesOf = (ledger: Ledger) => ledger.entries;

  test("a real Claude Code Haiku run: every request priced and audited, no divergence, the total is Claude's own", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    let reported = 0;
    for (const l of readFileSync(join(DIR, "claude-code-2.1.289-live-haiku.jsonl"), "utf8").split("\n").filter(Boolean)) {
      const body = JSON.parse(l).body as { resourceLogs?: { scopeLogs: { logRecords: { attributes: { key: string; value: Record<string, string | number> }[] }[] }[] }[] };
      for (const rl of body.resourceLogs ?? []) for (const sl of rl.scopeLogs) for (const r of sl.logRecords) {
        const a: Record<string, string | number> = {};
        for (const kv of r.attributes) a[kv.key] = Object.values(kv.value)[0]!;
        if (a["event.name"] !== "api_request") continue;
        reported += Number(a.cost_usd);
        t.claudeRequest({ model: String(a.model), input: Number(a.input_tokens), output: Number(a.output_tokens), cacheRead: Number(a.cache_read_tokens), cacheWrite: Number(a.cache_creation_tokens), reportedUsd: Number(a.cost_usd) });
      }
    }
    t.reportedCumulative(reported);
    expect(t.figure()!.own).toBe(true);
    expect(t.figure()!.usd).toBeCloseTo(0.04530665, 9);
    expect(t.figure()!.approx).toBe(true);
    expect(entriesOf(ledger).filter((e) => e.kind === "observation" && e.scope === "request").map((e) => (e as { cause?: string }).cause)).toEqual(Array(5).fill("none"));
    expect(ledger.divergences()).toEqual([]);
    // Cache writes with no TTL split are an assumption of the 5m rate; the plan flag is separate.
    expect(entriesOf(ledger).some((e) => e.kind === "usage" && e.assumptions.includes("cache-ttl-assumed-5m"))).toBe(true);
    expect(frozenTracker({ harness: "claude-code", conn: "plan" }).figure()).toBeUndefined();
  });

  test("BUG-324/ttl-divergence-recorded: a request Claude billed at the 1h cache rate (OTEL can't show it) is not re-priced and the TTL is not learned: the ledger names cache-ttl-1h as the cause", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    // The spike's vector on Opus 4.6: 20k cache write, all 1h: Claude said $0.22 where the 5m rate gives $0.145.
    t.claudeRequest({ model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 0, cacheWrite: 20_000, reportedUsd: 0.22 });
    expect(t.figure()!.usd).toBeCloseTo(0.145, 9);
    expect(ledger.divergences().map((d) => [d.cause, d.reportedMicros, d.ownMicros])).toEqual([["cache-ttl-1h", 220_000, 145_000]]);
    // The next one starts from the same assumption, not from what the oracle said.
    t.claudeRequest({ model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 0, cacheWrite: 20_000 });
    expect(t.figure()!.usd).toBeCloseTo(0.29, 9);
    expect(entriesOf(ledger).filter((e) => e.kind === "usage").map((e) => (e as { assumptions: string[] }).assumptions)).toEqual([["cache-ttl-assumed-5m"], ["cache-ttl-assumed-5m"]]);
  });

  test("BUG-324/ttl-from-settings: a cache TTL from the settings prices the writes (main and subagent apart), is no assumption, and a report that says the other one is the cause", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1, cacheTtl: { main: "1h", subagent: "5m" } });
    const req = { model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 0, cacheWrite: 20_000 };
    t.claudeRequest({ ...req, reportedUsd: 0.22 });
    expect(t.figure()!.usd).toBeCloseTo(0.22, 9);
    t.claudeRequest({ ...req, subagent: true, reportedUsd: 0.145 });
    expect(t.figure()!.usd).toBeCloseTo(0.365, 9);
    expect(entriesOf(ledger).filter((e) => e.kind === "usage").map((e) => (e as { assumptions: string[] }).assumptions)).toEqual([[], []]);
    expect(ledger.divergences()).toEqual([]);
    // The main conversation wrote at 5m after all: the setting was wrong for this request; ours says 1h, the oracle 5m.
    t.claudeRequest({ ...req, reportedUsd: 0.145 });
    expect(ledger.divergences().map((d) => d.cause)).toEqual(["cache-ttl-5m"]);
  });

  test("BUG-407/hypotheses-at-the-ttl-used: a request priced at the 1h cache rate (a plan's main conversation, or the setting) and billed with the US geo factor is 'us-geo', judged from the 1h figure it was priced at, not from the 5m one ('unexplained')", () => {
    const req = { model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 0, cacheWrite: 20_000 };
    for (const o of [{ conn: "plan" as const }, { conn: "anthropic" as const, cacheTtl: { main: "1h" as const } }]) {
      const ledger = new Ledger();
      const t = frozenTracker({ harness: "claude-code", ledger, now: () => 1, ...o });
      // 1h: $0.22; the US geo factor (1.1) on it: $0.242. (On the 5m figure, $0.145, the geo would add $0.0145: no match.)
      t.claudeRequest({ ...req, reportedUsd: 0.242 });
      expect(t.figure()!.usd).toBeCloseTo(0.22, 9);
      expect(ledger.divergences().map((d) => d.cause)).toEqual(["us-geo"]);
    }
  });

  test("a difference no hypothesis explains stays a divergence ('unexplained'): the TTL is not touched", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    t.claudeRequest({ model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 0, cacheWrite: 20_000, reportedUsd: 0.5 });
    expect(ledger.divergences().map((d) => d.cause)).toEqual(["unexplained"]);
    expect(t.figure()!.usd).toBeCloseTo(0.145, 9);
  });

  test("a model with no price entry has no figure of ours: the harness's own total is shown, marked; the ledger says why", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    t.claudeRequest({ model: "claude-made-up-9", input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reportedUsd: 0.5 });
    expect(t.figure()).toBeUndefined();
    t.reportedCumulative(0.5);
    expect(t.figure()).toEqual({ usd: 0.5, approx: false, own: false });
    expect(entriesOf(ledger)[0]).toMatchObject({ kind: "usage", assumptions: ["unknown-model"], ownMicros: 0 });
  });

  test("BUG-323/fallback-cost-marked: the harness's own total, shown because a request had no price of ours, is own=false and the row marks it; our own figure is not marked", () => {
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger: new Ledger() });
    t.claudeRequest({ model: "claude-made-up-9", input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
    t.reportedCumulative(0.5);
    const fallback = t.figure()!;
    expect(fallback.own).toBe(false);
    expect(costLabel(fallback)).toBe("$0.50*");
    expect(costLabel({ ...fallback, approx: true })).toBe("~$0.50*");
    const ours = frozenTracker({ harness: "claude-code", conn: "anthropic" });
    ours.claudeRequest({ model: "claude-haiku-4-5", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
    expect(ours.figure()!.own).toBe(true);
    expect(costLabel(ours.figure())).toBe("$0.0015");
    expect(costLabel({ usd: 4.12, approx: true })).toBe("~$4.12");
  });

  test("BUG-671/F06: an OpenCode step is priced at the model it reports, not the launched model's: a model switched to by hand, a free one ($0), and one with no entry (unknown, never the launched price)", () => {
    const ledger = new Ledger();
    const table = frozenTableWith({
      "openrouter/test/switched": { cost: { input: 10, output: 20 }, context: 100_000 },
      "openrouter/test/free": { cost: { input: 0, output: 0 }, context: 100_000 },
    });
    const t = frozenTracker({ harness: "opencode", conn: "openrouter", launchedKey: "openrouter/deepseek/deepseek-v4-flash", ledger, table, now: () => 1 });
    const tokens = { input: 1_000_000, output: 100_000, reasoning: 0, cache: { read: 0, write: 0 } };
    t.opencodeStep({ model: "openrouter/deepseek/deepseek-v4-flash", tokens });
    t.opencodeStep({ model: "openrouter/test/switched", tokens });
    t.opencodeStep({ model: "openrouter/test/free", tokens });
    // A Zen model the table doesn't list: the launched model's price must not stand in for it.
    t.opencodeStep({ model: "opencode/zen-unlisted-free", tokens });
    const usage = entriesOf(ledger).filter((e) => e.kind === "usage") as { model: string; assumptions: string[]; ownMicros: number }[];
    expect(usage.map((u) => [u.model, u.ownMicros, u.assumptions])).toEqual([
      ["openrouter/deepseek/deepseek-v4-flash", expect.any(Number), []],
      ["openrouter/test/switched", 10_000_000 + 2_000_000, []],
      ["openrouter/test/free", 0, []],
      ["opencode/zen-unlisted-free", 0, ["unknown-model"]],
    ]);
    expect(usage[0]!.ownMicros).not.toBe(12_000_000);
    // The unpriced step makes the sum partial: an estimate (~) until the harness's own total stands in, marked `*`.
    expect(t.figure()).toEqual({ usd: (usage[0]!.ownMicros + usage[1]!.ownMicros) / 1e6, approx: true, own: true });
    t.reportedCumulative(1.5);
    expect(t.figure()).toEqual({ usd: 1.5, approx: false, own: false });
  });

  test("BUG-325/launched-model-price: a model with no entry of its own is priced from the launched model's, and says so; one with an entry does not", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "opencode", conn: "openrouter", launchedKey: "openrouter/deepseek/deepseek-v4-flash", ledger, now: () => 1 });
    const tokens = { input: 1_000_000, output: 100_000, reasoning: 0, cache: { read: 0, write: 0 } };
    // OpenCode: only a step the plugin could name no model for (F06, BUG-671: a named model the table lacks is unknown).
    t.opencodeStep({ model: "unknown/unknown", tokens });
    t.opencodeStep({ model: "openrouter/deepseek/deepseek-v4-flash", tokens });
    const usage = entriesOf(ledger).filter((e) => e.kind === "usage") as { assumptions: string[]; ownMicros: number }[];
    expect(usage.map((u) => u.assumptions)).toEqual([["launched-model-price"], []]);
    expect(usage[0]!.ownMicros).toBe(usage[1]!.ownMicros);
    // A launched-model price makes the figure an estimate (~).
    expect(frozenTracker({ harness: "opencode", conn: "openrouter", launchedKey: "openrouter/deepseek/deepseek-v4-flash" }).figure()).toBeUndefined();
    const est = frozenTracker({ harness: "claude-code", conn: "anthropic", launchedKey: "anthropic/claude-haiku-4-5" });
    est.claudeRequest({ model: "claude-made-up-9", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
    expect(est.figure()).toEqual({ usd: (1000 * 1 + 100 * 5) / 1e6, approx: true, own: true });
    // No launched model, no price: nothing is copied from anywhere (an unknown model has no figure of ours).
    expect(frozenTracker({ harness: "claude-code", conn: "anthropic" }).figure()).toBeUndefined();
  });

  test("BUG-327/table-digest-of-the-pricing-table: the ledger names the table that priced the request (Claude Code's catalog or models.dev)", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    t.claudeRequest({ model: "claude-opus-4-6", input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
    // A catalog with no model: the same request falls to models.dev.
    const bare = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1, claudeCatalog: { ...FROZEN_CLAUDE_CATALOG, models: [], catalogDigest: "f".repeat(64) } });
    bare.claudeRequest({ model: "claude-opus-4-6", input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
    const codex = frozenTracker({ harness: "codex", conn: "openai", ledger, now: () => 1 });
    codex.codexResponse({ model: "gpt-6-luna", input: 10, cached: 0, cacheWrite: 0, output: 10 });
    expect(FROZEN_CLAUDE_CATALOG.catalogDigest.slice(0, 8)).not.toBe(FROZEN_TABLE.catalogDigest.slice(0, 8));
    expect(entriesOf(ledger).filter((e) => e.kind === "usage").map((e) => (e as { table: string }).table)).toEqual([FROZEN_CLAUDE_CATALOG.catalogDigest.slice(0, 8), FROZEN_TABLE.catalogDigest.slice(0, 8), FROZEN_TABLE.catalogDigest.slice(0, 8)]);
  });

  test("BUG-326/context-cause: the ledger tells a difference in tokens from one in the window, and both from neither", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    const own = { tokens: 100_000, window: 200_000 };
    t.observeContext({ own, reported: { tokens: 100_000, window: 200_000 } });
    t.observeContext({ own, reported: { tokens: 60_000, window: 200_000 } });
    t.observeContext({ own, reported: { tokens: 100_000, window: 400_000 } });
    t.observeContext({ own, reported: { tokens: 60_000, window: 400_000 } });
    const contexts = entriesOf(ledger).filter((e) => e.kind === "context") as { cause?: string; ownPct?: number; reportedPct?: number; reportedWindow?: number }[];
    expect(contexts.map((c) => c.cause)).toEqual(["none", "tokens", "window", "both"]);
    expect(contexts[2]).toMatchObject({ ownPct: 50, reportedPct: 25, reportedWindow: 400_000 });
    expect(ledger.contextDivergences().map((c) => c.cause)).toEqual(["tokens", "window", "both"]);
    // The harness's own percentage is taken as it is; with none of ours, the reading is kept without a cause.
    t.observeContext({ own, reported: { pct: 50, tokens: 100_000, window: 200_000 } });
    t.observeContext({ reported: { tokens: 50_000, window: 100_000 } });
    // With none of ours the reading waits for ours (BUG-473); the session's end writes it as it is.
    t.ended();
    expect(entriesOf(ledger).slice(-2)).toMatchObject([{ cause: "none", reportedPct: 50 }, { reportedPct: 50 }]);
    expect(entriesOf(ledger).at(-1)).not.toHaveProperty("cause");
    // Nothing to compare, nothing written.
    t.observeContext({ reported: {} });
    t.ended();
    expect(entriesOf(ledger).length).toBe(6);
  });

  test("a launch on a plan is API-equivalent (~) even when every request is priced", () => {
    const t = frozenTracker({ harness: "claude-code", conn: "plan", launchedKey: "anthropic/claude-haiku-4-5" });
    t.claudeRequest({ model: "claude-haiku-4-5-20251001", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
    expect(t.figure()).toEqual({ usd: (1000 * 1 + 100 * 5) / 1e6, approx: true, own: true });
  });

  test("Codex: every conversation counts (title thread too); the real gpt-6-luna session is an estimate", () => {
    const t = frozenTracker({ harness: "codex", conn: "openai", ledger: new Ledger() });
    t.codexResponse({ model: "gpt-6-luna", input: 10_611, cached: 0, cacheWrite: 10_608, output: 228, serviceTier: "priority" });
    t.codexResponse({ model: "gpt-6-luna", input: 7_195, cached: 0, cacheWrite: 7_192, output: 115 });
    t.codexResponse({ model: "gpt-6-luna", input: 40_421, cached: 10_608, cacheWrite: 29_810, output: 22, serviceTier: "priority" });
    expect(t.figure()!.usd).toBeCloseTo(0.011525, 6);
    expect(t.figure()).toMatchObject({ approx: true, own: true });
    // On Bedrock the price is Bedrock's (1.1x here), keyed by the connection.
    const b = frozenTracker({ harness: "codex", conn: "bedrock" });
    b.codexResponse({ model: "us.openai.gpt-6-luna", input: 1000, cached: 0, cacheWrite: 0, output: 0 });
    expect(b.figure()!.usd).toBeCloseTo((1000 * 0.11) / 1e6, 12);
  });

  test("OpenCode: a step priced from the table through the provider/model key, audited against its own cost", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "opencode", conn: "openrouter", ledger, now: () => 1 });
    const key = "openrouter/deepseek/deepseek-v4-flash";
    const price = frozenEntry(key)!.cost;
    const tokens = { input: 5191, output: 3, reasoning: 11, cache: { read: 0, write: 0 } };
    const expected = opencodeCost(tokens, opencodePrices(price)).usd;
    t.opencodeStep({ model: key, tokens, reportedUsd: expected });
    t.reportedCumulative(expected);
    expect(t.figure()).toEqual({ usd: expected, approx: false, own: true });
    expect(ledger.divergences()).toEqual([]);
    t.opencodeStep({ model: key, tokens, reportedUsd: expected * 1.5 });
    expect(ledger.divergences().map((d) => d.cause)).toEqual(["unexplained"]);
  });
});

describe("Claude Code's own catalog (scripts/pricing/claude.ts: read from its binary, parsed, never evaluated)", () => {
  test("the literal parser reads what a bundler emits and refuses anything it would have to run", () => {
    expect(parseJsLiteral('{a:1,"b-c":[1e6,-2.5,!0,!1,null],d:{e:"x\\u00e9\\"y"}}')).toEqual({ a: 1, "b-c": [1_000_000, -2.5, true, false, null], d: { e: 'x\u00e9"y' } });
    for (const bad of ["{a:foo}", "{a:f()}", "{a:`t`}", "{a:1} x", "{a:1,}x", "{a:'q'}", '{"a":1', "{a:1 b:2}", "[1,2", "{a:/re/}"]) expect(() => parseJsLiteral(bad)).toThrow();
    expect(balancedObject('x{a:"}",b:{c:1}}y', 1)).toBe('{a:"}",b:{c:1}}');
    expect(balancedObject("{a:{", 0)).toBeNull();
  });

  test("the catalog text is found in a binary's bytes by its comment, and trimmed to ids, windows and tiers", () => {
    const literal = '{"//":"Hand-maintained baked-in model catalog \\u2014 x",schema_version:1,pricing_tiers:{t:{input:1,output:2,cache_write_5m:1.25,cache_write_1h:2,cache_read:0.1,web_search:0.01}},models:[{id:"m-1",family:"f",provider_ids:{first_party:"m-1-20250101",bedrock:null},context:{window:1e6,native_1m:!0},pricing:"t"}]}';
    const bytes = Buffer.concat([Buffer.from("\x00junk;var usr="), Buffer.from(literal), Buffer.from(";more\x00")]);
    expect(catalogText(bytes)).toBe(literal);
    expect(catalogText(Buffer.from("nothing here"))).toBeNull();
    const t = trim(parseJsLiteral(catalogText(bytes)!) as Record<string, unknown>);
    expect(t.models).toEqual([{ id: "m-1", family: "f", providerIds: { first_party: "m-1-20250101" }, pricing: "t", window: 1_000_000, native1m: true, supports1mSuffix: false, supports1mBeta: false }]);
    expect(() => trim({ pricing_tiers: {}, models: [{ id: "x", pricing: "missing" }] })).toThrow(/known price tier/);
  });

  test("the bundled table: every model has a tier with the 5m and 1h cache-write prices; names resolve by API, Bedrock and Vertex id, dated or not, with [1m]", () => {
    expect(CLAUDE_CATALOG.models.length).toBeGreaterThanOrEqual(20);
    for (const m of CLAUDE_CATALOG.models) expect(CLAUDE_CATALOG.pricingTiers[m.pricing]!.cache_write_1h).toBeGreaterThan(CLAUDE_CATALOG.pricingTiers[m.pricing]!.cache_write_5m);
    const haiku = claudeCatalogModel("claude-haiku-4-5")!;
    for (const name of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5@20251001"]) expect(claudeCatalogModel(name)).toBe(haiku);
    expect(claudeCatalogModel("claude-opus-4-6[1m]")?.id).toBe("claude-opus-4-6");
    expect(claudeCatalogModel("gpt-6-sol")).toBeUndefined();
  });

  test("windows from the catalog agree with the name-based rule for every model (so neither drifts alone); [1m] only where the catalog supports it", () => {
    for (const m of CLAUDE_CATALOG.models) expect([m.id, claudeContextWindow(m.id, {})]).toEqual([m.id, claudeContextWindowByName(m.id, {}) ?? m.window]);
    expect(claudeContextWindow("claude-opus-4-6", {})).toBe(200_000);
    expect(claudeContextWindow("claude-opus-4-6[1m]", {})).toBe(1_000_000);
    expect(claudeContextWindow("claude-opus-5-5", {})).toBe(1_000_000);
    expect(claudeContextWindow("claude-opus-5-5", { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" })).toBe(200_000);
    // The catalog lists the suffix for Haiku 4.5 (and Claude Code applies it); a model without the suffix keeps its window.
    expect(claudeContextWindow("claude-haiku-4-5-20251001[1m]", {})).toBe(1_000_000);
    expect(claudeContextWindow("claude-3-5-haiku[1m]", {})).toBe(200_000);
    // Aliases and Gluon's ids are not in the catalog: the name rule.
    expect(claudeContextWindow("opus", {})).toBe(1_000_000);
    expect(claudeContextWindow("sonnet-4.6", {})).toBe(200_000);
  });

  test("its prices agree with models.dev's for the same models (two sources, one price): a difference is a failing test to look at", () => {
    for (const m of CLAUDE_CATALOG.models) {
      const dev = priceEntry(`anthropic/${m.providerIds.first_party}`)?.cost;
      if (!dev) continue;
      const t = CLAUDE_CATALOG.pricingTiers[m.pricing]!;
      expect([m.id, dev.input, dev.output, dev.cache_read, dev.cache_write]).toEqual([m.id, t.input, t.output, t.cache_read, t.cache_write_5m]);
    }
  });

  test("the 1h write at Claude's own price: the spike's real vectors on Opus 4.6 ($0.145 at 5m, $0.22 at 1h, $0.19 mixed) and the tracker resolves a Bedrock id", () => {
    const opus = claudePriceFromTier(FROZEN_CLAUDE_CATALOG.pricingTiers[claudeCatalogModel("claude-opus-4-6", FROZEN_CLAUDE_CATALOG)!.pricing]!);
    const u = { input_tokens: 1000, output_tokens: 600, cache_creation_input_tokens: 20_000 };
    expect(claudeCost(opus, u).micros).toBe(145_000);
    expect(claudeCost(opus, { ...u, cache_creation: { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 0 } }).micros).toBe(220_000);
    expect(claudeCost(opus, { ...u, cache_creation: { ephemeral_1h_input_tokens: 12_000, ephemeral_5m_input_tokens: 8_000 } }).micros).toBe(190_000);
    const t = frozenTracker({ harness: "claude-code", conn: "bedrock" });
    t.claudeRequest({ model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
    expect(t.figure()).toEqual({ usd: (1000 * 1 + 100 * 5) / 1e6, approx: false, own: true });
  });
});

describe("Gluon's own context window and percentage (src/cost/context.ts)", () => {
  test("Claude: the window comes from Claude Code's catalog or the name; a prompt past 200k proves 1M; the environment is an argument", () => {
    expect(ownWindow("claude-code", "claude-opus-4-6")).toEqual({ window: 200_000, source: "claude-catalog" });
    expect(ownWindow("claude-code", "opus")).toEqual({ window: 1_000_000, source: "claude-name" });
    expect(ownWindow("claude-code", "claude-opus-4-6", { peak: 300_000 })).toEqual({ window: 1_000_000, source: "claude-peak" });
    expect(ownWindow("claude-code", "claude-opus-5-5", { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } })).toEqual({ window: 200_000, source: "claude-1m-disabled" });
    // A reported name Gluon can't size falls to the launched model's; with neither, no window.
    expect(ownWindow("claude-code", "mystery-9", { launchedModel: "sonnet-4.6" })).toEqual({ window: 200_000, source: "claude-launched" });
    expect(ownWindow("claude-code", "mystery-9")).toEqual({ window: undefined, source: "none" });
    expect(ownWindow("claude-code", undefined, { launchedModel: "claude-haiku-4-5" }).window).toBe(200_000);
  });

  test("Codex: the bundled table's usable window, Codex's fallback, the config's override; Grok: its table; OpenCode: models.dev's limit; Antigravity: its table", () => {
    expect(ownWindow("codex", "gpt-6-sol")).toEqual({ window: 258_400, source: "codex-catalog" });
    expect(ownWindow("codex", "gpt-99-unlisted")).toEqual({ window: 258_400, source: "codex-fallback" });
    expect(ownWindow("codex", "gpt-6-sol", { override: 100_000 })).toEqual({ window: 95_000, source: "override" });
    expect(ownWindow("grok-build", "grok-4.5")).toEqual({ window: 500_000, source: "grok-table" });
    // grok-4.7 is not in Grok 1.0.46's catalog: its window is the one its footer showed (256K), from the observed table (BUG-396).
    expect(ownWindow("grok-build", "grok-4.7")).toEqual({ window: 256_000, source: "grok-observed" });
    expect(ownWindow("grok-build", undefined, { launchedModel: "grok-4.6" }).window).toBe(500_000);
    // OpenCode's own footer divides by models.dev's `limit.context`: so does Gluon (BUG-346).
    expect(ownWindow("opencode", "openrouter/deepseek/deepseek-v4-flash")).toEqual({ window: 1_048_576, source: "opencode-models-dev" });
    expect(ownWindow("opencode", "fake/made-up")).toEqual({ window: undefined, source: "none" });
    expect(ownWindow("antigravity", "gemini-3.8-flash").source).toBe("agy-table");
  });

  test("the percentage is counted as the harness's display counts it (Codex: the baseline off both sides), at most 100, undefined without a window", () => {
    expect(ownPercent("claude-code", 150_000, 200_000)).toBe(75);
    expect(ownPercent("claude-code", 300_000, 200_000)).toBe(100);
    expect(ownPercent("codex", 20_500, 258_400)).toBeCloseTo((8_500 / 246_400) * 100, 9);
    expect(ownPercent("codex", 5_000, 380_000)).toBe(0);
    expect(ownPercent("codex", 1_000, 10_000)).toBe(100);
    for (const bad of [undefined, 0, -1]) expect(ownPercent("grok-build", 1_000, bad)).toBeUndefined();
    expect(ownPercent("grok-build", Number.NaN, 1_000)).toBeUndefined();
  });

  test("BUG-326/cause-function: tokens, window, both or none; a missing figure counts as differing; equal percentages are none whatever the inputs", () => {
    expect(contextCause({ pct: 50, tokens: 100_000, window: 200_000 }, { pct: 50, tokens: 100_000, window: 200_000 })).toBe("none");
    expect(contextCause({ pct: 50, tokens: 100_000, window: 200_000 }, { pct: 30, tokens: 60_000, window: 200_000 })).toBe("tokens");
    expect(contextCause({ pct: 50, tokens: 100_000, window: 200_000 }, { pct: 25, tokens: 100_000, window: 400_000 })).toBe("window");
    expect(contextCause({ pct: 50, tokens: 100_000, window: 200_000 }, { pct: 15, tokens: 60_000, window: 400_000 })).toBe("both");
    expect(contextCause({ pct: 50, tokens: 100_000, window: 200_000 }, { pct: 20 })).toBe("both");
    expect(contextCause({ pct: 50, tokens: 100_000, window: 200_000 }, { pct: 50, window: 1 })).toBe("none");
  });
});

describe("Antigravity: no cost, its context is Gluon's own (src/cost/antigravity.ts; live run 2 on agy 1.2.16)", () => {
  const agyTracker = (over: Partial<ConstructorParameters<typeof CostTracker>[0]> = {}) => {
    const ledger = new Ledger();
    return { ledger, t: frozenTracker({ harness: "antigravity", conn: "plan", launchedKey: "google/gemini-3.8-flash", ledger, now: () => 1, ...over }) };
  };

  test("BUG-348/no-priced-deltas: agy's status-line totals are the conversation's size, not what was billed, so nothing prices them: the tracker has no estimate, the module no price, the row's cost stays unknown (—) and the ledger holds no usage entry", () => {
    const { ledger, t } = agyTracker();
    expect(t.figure()).toBeUndefined();
    expect(costLabel(t.figure())).toBe("—");
    expect("agyEstimate" in t).toBe(false);
    expect(Object.keys(agyModule).sort()).toEqual(["agyContextTokens", "agyModelId", "agyWindow"]);
    expect(ledger.entries).toEqual([]);
    // The assumption of the old estimate is gone from the vocabulary: a ledger entry naming it is dropped by the sanitizer.
    const l = new Ledger();
    l.add({ kind: "usage", t: 1, harness: "antigravity", model: "gemini-3.8-flash", connection: "plan", channel: "statusline", counts: { input: 1 }, ownMicros: 1, assumptions: ["statusline-delta"], table: "abcd1234" } as never);
    expect(l.entries).toEqual([]);
  });

  test("BUG-349/effort-suffix: agy names a model with its effort, which is no part of the table's id", () => {
    for (const [from, to] of [["gemini-3.8-flash-high", "gemini-3.8-flash"], ["gemini-3.8-flash-minimal", "gemini-3.8-flash"], ["gemini-3.8-flash", "gemini-3.8-flash"], ["gemini-3.8-flash-highest", "gemini-3.8-flash-highest"]]) expect(agyModelId(from!)).toBe(to!);
  });

  test("BUG-350/window-ledger-only: the window comes from Gluon's table (models.dev); agy's own percentage lands in the ledger beside ours with the cause, and is never shown", () => {
    const { t, ledger } = agyTracker();
    // The window is Gluon's (models.dev's limit.context), by the name agy reports (effort suffix and all) or the launched model's; the percentage is ours.
    expect(agyWindow("gemini-3.8-flash-high")).toBe(1_048_576);
    expect(ownWindow("antigravity", "gemini-3.8-flash")).toEqual({ window: 1_048_576, source: "agy-table" });
    expect(ownWindow("antigravity", "mock-model", { launchedModel: "gemini-3.7-flash" })).toEqual({ window: 1_048_576, source: "agy-table" });
    expect(ownWindow("antigravity", "mock-model")).toEqual({ window: undefined, source: "none" });
    expect(ownPercent("antigravity", 524_288, 1_048_576)).toBe(50);
    t.observeContext({ own: { tokens: 524_288, window: 1_048_576 }, reported: { tokens: 100_000, window: 200_000 } });
    expect(ledger.entries.at(-1)).toMatchObject({ kind: "context", ownPct: 50, reportedPct: 50, ownWindow: 1_048_576, reportedWindow: 200_000, cause: "none" });
  });
});

describe("Codex's window table (scripts/pricing/codex.ts: `codex debug models` in CI, read at build time)", () => {
  const catalog = JSON.stringify({ models: [{ slug: "gpt-6-sol", context_window: 272_000, max_context_window: 872_000 }, { slug: "gpt-6-luna", max_context_window: 100_000, effective_context_window_percent: 90 }, { slug: "bad", context_window: "x" }, { not: "a model" }] });

  test("BUG-335/generator: the table's shape from a catalog: windows as Codex reads them, a digest of the text, sorted, byte-stable", () => {
    const t = buildTable(catalog, { codexVersion: "0.159.3", generatedAt: "2026-10-04" });
    expect(t).toEqual({ schema: 1, source: "codex debug models", codexVersion: "0.159.3", generatedAt: "2026-10-04", digest: expect.stringMatching(/^[0-9a-f]{64}$/), models: { "gpt-6-luna": { context: 100_000, max: 100_000, percent: 90 }, "gpt-6-sol": { context: 272_000, max: 872_000, percent: 95 } } });
    expect(Object.keys(t.models)).toEqual(["gpt-6-luna", "gpt-6-sol"]);
    expect(JSON.stringify(buildTable(catalog, { codexVersion: "0.159.3", generatedAt: "2026-10-04" }))).toBe(JSON.stringify(t));
    expect(buildTable(catalog, { codexVersion: "1", generatedAt: "d", note: "seed" }).note).toBe("seed");
    // A catalog that moved must fail the job, never empty the table.
    for (const bad of ["not json", "{}", '{"models":[]}', '{"models":[{"slug":"x"}]}']) expect(() => buildTable(bad, { codexVersion: "1", generatedAt: "d" })).toThrow(/no model with a window/);
  });

  test("the bundled table is that shape and Codex's own windows are sane", () => {
    // On a copy: Bun's toMatchObject overwrites the received object's fields with the asymmetric matchers, which would corrupt the shared table for every later test (BUG-365).
    expect(structuredClone(CODEX_WINDOWS)).toMatchObject({ schema: 1, source: "codex debug models", digest: expect.stringMatching(/^[0-9a-f]{64}$/), generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(Object.keys(CODEX_WINDOWS.models).length).toBeGreaterThan(3);
    for (const [slug, w] of Object.entries(CODEX_WINDOWS.models)) {
      expect(slug).toMatch(/^[A-Za-z0-9._-]{1,80}$/);
      expect(w.context).toBeGreaterThanOrEqual(100_000);
      expect(w.max).toBeGreaterThanOrEqual(w.context);
      expect(w.percent).toBeGreaterThan(0);
      expect(w.percent).toBeLessThanOrEqual(100);
    }
    // Every GPT model Gluon offers has a window of its own, not the fallback (an open-weight one on another provider isn't in Codex's catalog).
    for (const m of DEFAULT_MODELS.codex.filter((x) => x.id.startsWith("gpt-6-"))) expect(ownWindow("codex", m.id).source).toBe("codex-catalog");
  });
});

describe("Codex's turn_cost as an oracle (issue #39: a turn-scope observation, pending, never displayed)", () => {
  // The three requests of the real gpt-6-luna session (`codex-0.159.3-live-luna.jsonl`): main (priority), title thread (standard), main (priority).
  const R = [
    { model: "gpt-6-luna", input: 10_611, cached: 0, cacheWrite: 10_608, output: 228, serviceTier: "priority" },
    { model: "gpt-6-luna", input: 7_195, cached: 0, cacheWrite: 7_192, output: 115 },
    { model: "gpt-6-luna", input: 40_421, cached: 10_608, cacheWrite: 29_810, output: 22, serviceTier: "priority" },
  ];
  const luna = frozenEntry("openai/gpt-6-luna")!;
  const standardUsd = (r: (typeof R)[number]) => codexCost(luna, { ...r, serviceTier: undefined }).usd;
  const turnOf = (r: (typeof R)[number], reportedUsd: number) => ({ model: r.model, input: r.input, cached: r.cached, output: r.output, reportedUsd });
  const setup = (o: { turnCostTimeoutMs?: number } = {}) => {
    const ledger = new Ledger();
    let now = 1_000;
    const t = frozenTracker({ harness: "codex", conn: "plan", ledger, now: () => now, ...o });
    return { ledger, t, advance: (ms: number) => void (now += ms) };
  };
  const turns = (ledger: Ledger) => ledger.entries.filter((e) => e.kind === "observation" && e.scope === "turn");

  test("BUG-336/turn: a reported turn is matched to our responses by its tokens and recorded as a turn observation; the figure shown stays ours", () => {
    const { ledger, t } = setup();
    for (const r of R.slice(0, 2)) t.codexResponse(r);
    const before = t.figure()!;
    // Exactly our sum of the title thread's request (no tier requested): no difference.
    t.codexTurnCost(turnOf(R[1]!, standardUsd(R[1]!)));
    expect(turns(ledger)).toEqual([expect.objectContaining({ kind: "observation", what: "cost", scope: "turn", harness: "codex", reportedMicros: Math.round(standardUsd(R[1]!) * 1e6), ownMicros: Math.round(standardUsd(R[1]!) * 1e6), cause: "none" })]);
    // Never displayed: the figure is the sum of our responses whatever Codex's estimate says.
    expect(t.figure()).toEqual(before);
    expect(t.figure()!.own).toBe(true);
  });

  test("BUG-336/divergence: a difference has a cause: the requested priority tier explains a turn Codex's server priced as standard; any other is unexplained", () => {
    const { ledger, t } = setup();
    t.codexResponse(R[0]!);
    t.codexTurnCost(turnOf(R[0]!, standardUsd(R[0]!)));
    const [e] = turns(ledger) as { reportedMicros: number; ownMicros: number; cause: string }[];
    expect(e!.ownMicros).toBeGreaterThan(e!.reportedMicros);
    expect(e!.cause).toBe("service-tier-requested");
    expect(ledger.divergences()).toHaveLength(1);
    // A reported cost nothing explains.
    t.codexResponse(R[2]!);
    t.codexTurnCost(turnOf(R[2]!, 1));
    expect((turns(ledger)[1] as { cause: string }).cause).toBe("unexplained");
  });

  test("BUG-336/pending: a turn cost that comes before its responses waits and is recorded when they are in; a turn spanning several responses sums them", () => {
    const { ledger, t } = setup();
    const both = { model: "gpt-6-luna", input: R[0]!.input + R[2]!.input, cached: R[0]!.cached + R[2]!.cached, output: R[0]!.output + R[2]!.output, reportedUsd: 0.5 };
    t.codexTurnCost(both);
    expect(turns(ledger)).toEqual([]);
    t.codexResponse(R[0]!);
    expect(turns(ledger)).toEqual([]);
    t.codexResponse(R[2]!);
    expect(turns(ledger)).toEqual([expect.objectContaining({ scope: "turn", reportedMicros: 500_000, ownMicros: Math.round(codexCost(luna, R[0]!).usd * 1e6) + Math.round(codexCost(luna, R[2]!).usd * 1e6) })]);
    // Claimed once: the same tokens reported again have nothing left to match.
    t.codexTurnCost(both);
    expect(turns(ledger)).toHaveLength(1);
  });

  test("BUG-336/timeout: responses with no turn_cost leave no entry; a turn_cost with no responses is dropped after the timeout as a count, never as an observation", () => {
    const { ledger, t, advance } = setup({ turnCostTimeoutMs: 60_000 });
    for (const r of R) t.codexResponse(r);
    advance(3_600_000);
    t.codexTurnEnded();
    expect(ledger.entries.filter((e) => e.kind === "observation" || e.kind === "dropped")).toEqual([]);
    t.codexTurnCost({ model: "gpt-6-luna", input: 123, cached: 0, output: 4, reportedUsd: 0.01 });
    advance(59_000);
    t.codexTurnEnded();
    expect(ledger.entries.filter((e) => e.kind === "dropped")).toEqual([]);
    advance(2_000);
    t.codexTurnEnded();
    expect(ledger.entries.filter((e) => e.kind === "observation")).toEqual([]);
    expect(ledger.entries.filter((e) => e.kind === "dropped")).toEqual([expect.objectContaining({ what: "cost", reason: "turn-unmatched", count: 1 })]);
    // Dropped once.
    advance(3_600_000);
    t.codexTurnEnded();
    expect(ledger.entries.filter((e) => e.kind === "dropped")).toHaveLength(1);
  });

  test("BUG-338/resume: Codex has no cumulative oracle, so a resumed session has no inherited total to subtract, and a turn from before the resume (none of our responses) records nothing", () => {
    const { ledger, t, advance } = setup({ turnCostTimeoutMs: 1_000 });
    expect(ledger.entries).toEqual([]);
    t.codexResponse(R[2]!);
    const own = t.figure()!.usd;
    // The inherited history's turn: its tokens are not among the responses Gluon saw.
    t.codexTurnCost({ model: "gpt-6-luna", input: 500_000, cached: 400_000, output: 9_000, reportedUsd: 3 });
    advance(2_000);
    t.codexTurnEnded();
    expect(turns(ledger)).toEqual([]);
    expect(t.figure()!.usd).toBe(own);
    expect(own).toBeCloseTo(codexCost(luna, R[2]!).usd, 12);
  });

  test("BUG-339/tier: the service tier Codex requested (never the one it served) is named on the turn's entry, with the cause when the price differs", () => {
    const { ledger, t } = setup();
    t.codexResponse(R[0]!);
    t.codexResponse(R[1]!);
    t.codexTurnCost(turnOf(R[0]!, standardUsd(R[0]!)));
    t.codexTurnCost(turnOf(R[1]!, standardUsd(R[1]!)));
    const [priority, standard] = turns(ledger) as { assumptions?: string[]; cause: string }[];
    expect(priority!.assumptions).toEqual(["service-tier-requested"]);
    expect(priority!.cause).toBe("service-tier-requested");
    // A turn with no tier requested has nothing to name.
    expect(standard!.assumptions).toBeUndefined();
    expect(standard!.cause).toBe("none");
  });

  test("an entry keeps only whitelisted assumptions (a ledger line can't carry free text)", () => {
    const ledger = new Ledger();
    const e = ledger.add({ kind: "observation", what: "cost", t: 1, harness: "codex", scope: "turn", reportedMicros: 5, assumptions: ["service-tier-requested", "my prompt", 3] });
    expect(e).toMatchObject({ assumptions: ["service-tier-requested"] });
  });
});

describe("Claude Code: its cache TTL, fast mode, web search and the request that names no model", () => {
  const req = { model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 0, cacheWrite: 20_000 };
  const claude = (o: Partial<ConstructorParameters<typeof CostTracker>[0]> = {}) => {
    const ledger = new Ledger();
    return { ledger, t: frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1, ...o }) };
  };
  const assumptionsOf = (ledger: Ledger) => ledger.entries.filter((e) => e.kind === "usage").map((e) => (e as { assumptions: string[] }).assumptions);

  test("BUG-328/ttl-configured: a configured TTL prices the cache write at it and is no assumption; with none, 5m on an API key and Claude's automatic 1h for a subscription's main conversation, each an assumption", () => {
    const one = claude({ cacheTtl: { main: "1h" } });
    one.t.claudeRequest(req);
    expect(one.t.figure()!.usd).toBeCloseTo(0.22, 9);
    expect(assumptionsOf(one.ledger)).toEqual([[]]);
    const five = claude({ cacheTtl: { main: "5m" } });
    five.t.claudeRequest(req);
    expect(five.t.figure()!.usd).toBeCloseTo(0.145, 9);
    expect(assumptionsOf(five.ledger)).toEqual([[]]);
    // A setting beats the automatic rule in both directions.
    const plan5 = claude({ conn: "plan", cacheTtl: { main: "5m" } });
    plan5.t.claudeRequest(req);
    expect(plan5.t.figure()!.usd).toBeCloseTo(0.145, 9);
    // None set: Claude Code's own rule (2.1.289): 5m on an API key; 1h for a subscription's main conversation, 5m for a subagent's.
    const api = claude();
    api.t.claudeRequest(req);
    expect(api.t.figure()!.usd).toBeCloseTo(0.145, 9);
    expect(assumptionsOf(api.ledger)).toEqual([["cache-ttl-assumed-5m"]]);
    const plan = claude({ conn: "plan" });
    plan.t.claudeRequest(req);
    plan.t.claudeRequest({ ...req, subagent: true });
    expect(plan.t.figure()!.usd).toBeCloseTo(0.22 + 0.145, 9);
    expect(assumptionsOf(plan.ledger)).toEqual([["cache-ttl-assumed-1h"], ["cache-ttl-assumed-5m"]]);
    // Read from the user's settings, the same chain end to end.
    const files: Record<string, string> = { "/h/.claude/settings.json": '{"promptCacheTtl":"1h","subagentPromptCacheTtl":"5m"}' };
    const read = claudeCacheTtl({ home: "/h", cwd: "/p", readFile: (f) => files[f.replaceAll("\\", "/")] });
    const viaSettings = claude({ cacheTtl: read });
    viaSettings.t.claudeRequest(req);
    viaSettings.t.claudeRequest({ ...req, subagent: true });
    expect(viaSettings.t.figure()!.usd).toBeCloseTo(0.22 + 0.145, 9);
  });

  test("BUG-329/ttl-subagent: the subagent TTL prices a subagent request, the main one the main request", () => {
    const { ledger, t } = claude({ cacheTtl: { main: "5m", subagent: "1h" } });
    t.claudeRequest({ ...req, reportedUsd: 0.145 });
    t.claudeRequest({ ...req, subagent: true, reportedUsd: 0.22 });
    expect(t.figure()!.usd).toBeCloseTo(0.365, 9);
    expect(ledger.divergences()).toEqual([]);
    expect(assumptionsOf(ledger)).toEqual([[], []]);
  });

  test("BUG-330/cause-ttl-5m: a request our 1h figure disagrees with by the write's rate step is attributed to cache-ttl-5m, and the TTL stays the setting's", () => {
    const { ledger, t } = claude({ cacheTtl: { main: "1h" } });
    t.claudeRequest({ ...req, reportedUsd: 0.145 });
    expect(ledger.divergences().map((d) => [d.cause, d.reportedMicros, d.ownMicros])).toEqual([["cache-ttl-5m", 145_000, 220_000]]);
    t.claudeRequest(req);
    expect(t.figure()!.usd).toBeCloseTo(0.44, 9);
  });

  test("BUG-331/fast-mode: a fast request is priced from the catalog's fast row (Opus 4.6: 6x, $0.87 where $0.145 was), a model without a fast row as usual, and a request Claude billed fast that we priced standard is attributed to fast-mode", () => {
    expect(FROZEN_CLAUDE_CATALOG.fastPricing!["claude-opus-4-6"]).toMatchObject({ input: 30, output: 150, cache_write_5m: 37.5, cache_read: 3 });
    const { ledger, t } = claude();
    t.claudeRequest({ ...req, fast: true, reportedUsd: 0.87 });
    expect(t.figure()!.usd).toBeCloseTo(0.87, 9);
    expect(ledger.divergences()).toEqual([]);
    // The oracle's vector: the offline expectation is the same row the oracle checks.
    const row = claudePriceFromTier(FROZEN_CLAUDE_CATALOG.fastPricing!["claude-opus-4-6"]!);
    expect(claudeCost(row, { input_tokens: 1000, output_tokens: 600, cache_creation_input_tokens: 20_000 }).micros).toBe(870_000);
    // Opus 5.5 has its own fast row: (1000 x 8 + 600 x 40 + 20,000 x 10) / 1e6.
    const five = claude();
    five.t.claudeRequest({ ...req, model: "claude-opus-5-5", fast: true });
    expect(five.t.figure()!.usd).toBeCloseTo(0.232, 9);
    // Haiku has none: fast is priced as usual, as Claude does.
    const haiku = claude();
    haiku.t.claudeRequest({ model: "claude-haiku-4-5", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, fast: true });
    expect(haiku.t.figure()!.usd).toBeCloseTo((1000 + 500) / 1e6, 9);
    // Billed fast though OTEL's `speed` didn't say so.
    const missed = claude();
    missed.t.claudeRequest({ ...req, reportedUsd: 0.87 });
    expect(missed.ledger.divergences().map((d) => d.cause)).toEqual(["fast-mode"]);
  });

  test("BUG-331/fast-prices-parse: the generator reads the fast rows out of the binary's price function by model id", () => {
    const text = 'var a={inputTokens:5,outputTokens:25,promptCacheWriteTokens:6.25,promptCacheWrite1hTokens:10,promptCacheReadTokens:0.5,webSearchRequests:0.01},g_={inputTokens:30,outputTokens:150,promptCacheWriteTokens:37.5,promptCacheWrite1hTokens:60,promptCacheReadTokens:3,webSearchRequests:0.01},$w={inputTokens:10,outputTokens:50,promptCacheWriteTokens:12.5,promptCacheWrite1hTokens:20,promptCacheReadTokens:1,webSearchRequests:0.01};function L(e,n){let r=e;if(n.speed==="fast"){if(r==="claude-opus-4-8"||r==="claude-opus-5")return $w;if(r==="claude-opus-4-6")return g_}return a}';
    const fast = fastPrices(text);
    expect(Object.keys(fast)).toEqual(["claude-opus-4-6", "claude-opus-4-8", "claude-opus-5"]);
    expect(fast["claude-opus-4-6"]).toEqual({ input: 30, output: 150, cache_write_5m: 37.5, cache_write_1h: 60, cache_read: 3, web_search: 0.01 });
    expect(fast["claude-opus-5"]).toEqual(fast["claude-opus-4-8"]!);
    expect(fastPrices("nothing here")).toEqual({});
    expect(fastPricingText(Buffer.from("x"))).toBeNull();
    // The bundled table holds exactly what the generator reads, for models the catalog lists.
    for (const id of Object.keys(CLAUDE_CATALOG.fastPricing!)) expect(CLAUDE_CATALOG.models.some((m) => m.id === id)).toBe(true);
  });

  test("BUG-332/cause-web-search: a difference of one or two search fees is attributed to web-search", () => {
    for (const [fees, usd] of [[1, 0.155], [2, 0.165]] as const) {
      const { ledger, t } = claude();
      t.claudeRequest({ ...req, reportedUsd: usd });
      expect([fees, ledger.divergences().map((d) => d.cause)]).toEqual([fees, ["web-search"]]);
    }
  });

  test("BUG-334/no-model: a Claude request that names no model is counted at the launched model's price and tagged launched-model-price; with no launched model it is unknown", () => {
    const { ledger, t } = claude({ launchedKey: "anthropic/claude-opus-4-6" });
    t.claudeRequest({ input: 1000, output: 600, cacheRead: 0, cacheWrite: 20_000 });
    expect(t.figure()).toEqual({ usd: 0.145, approx: true, own: true });
    expect(ledger.entries[0]).toMatchObject({ kind: "usage", model: "claude-opus-4-6", ownMicros: 145_000, assumptions: ["cache-ttl-assumed-5m", "launched-model-price"] });
    const bare = claude();
    bare.t.claudeRequest({ input: 1000, output: 600, cacheRead: 0, cacheWrite: 0 });
    expect(bare.t.figure()).toBeUndefined();
    expect(bare.ledger.entries[0]).toMatchObject({ kind: "usage", assumptions: ["unknown-model"] });
  });

  test("a harness's own cost audited without being the figure: observeCost writes the ledger only, so with no request of ours (the user's own OTEL) nothing is shown", () => {
    const { ledger, t } = claude();
    t.observeCost(1.23);
    expect(t.figure()).toBeUndefined();
    t.ended();
    expect(ledger.entries).toMatchObject([{ kind: "observation", what: "cost", scope: "cumulative", reportedMicros: 1_230_000, ownMicros: 0 }]);
    t.reportedCumulative(1.23);
    expect(t.figure()).toEqual({ usd: 1.23, approx: false, own: false });
  });
});

describe("Claude Code's window: the launched model's 1M, every default model sized", () => {
  test("a [1m] on the launched model carries over to the telemetry's suffix-less name of the same model, where the catalog supports it; the disable variable and a different model keep 200k", () => {
    expect(ownWindow("claude-code", "claude-opus-4-6", { launchedModel: "claude-opus-4-6[1m]" })).toEqual({ window: 1_000_000, source: "claude-launched" });
    expect(ownWindow("claude-code", "claude-opus-4-6-20260101", { launchedModel: "claude-opus-4-6[1m]" }).window).toBe(1_000_000);
    expect(ownWindow("claude-code", "claude-sonnet-4-6", { launchedModel: "claude-opus-4-6[1m]" }).window).toBe(200_000);
    expect(ownWindow("claude-code", "claude-opus-4-6", { launchedModel: "claude-opus-4-6" }).window).toBe(200_000);
    expect(ownWindow("claude-code", "claude-opus-4-6", { launchedModel: "claude-opus-4-6[1m]", env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } })).toEqual({ window: 200_000, source: "claude-1m-disabled" });
    // An alias launch (`opus[1m]`) is the same family; a model whose catalog entry has no suffix keeps its window.
    expect(ownWindow("claude-code", "claude-opus-4-6", { launchedModel: "opus[1m]" }).window).toBe(1_000_000);
    expect(ownWindow("claude-code", "claude-3-5-haiku", { launchedModel: "claude-3-5-haiku[1m]" }).window).toBe(200_000);
    // The >200k evidence stays the backstop for a launch without the suffix.
    expect(ownWindow("claude-code", "claude-opus-4-6", { launchedModel: "claude-opus-4-6", peak: 250_000 })).toEqual({ window: 1_000_000, source: "claude-peak" });
  });

  test("every Claude model Gluon offers has a window of ours on every connection it runs on (the id the telemetry will name or the launch used)", () => {
    const conns: Conn[] = ["plan", "anthropic", "bedrock", "openrouter"];
    for (const m of DEFAULT_MODELS["claude-code"]) {
      for (const conn of conns) {
        const id = idOn(m, conn);
        if (!id) continue;
        const own = ownWindow("claude-code", id, { env: {} });
        expect([m.id, conn, id, own.window !== undefined && own.window >= 200_000]).toEqual([m.id, conn, id, true]);
      }
    }
  });
});

describe("BUG-471: Claude Code's own fallback price for an id its catalog lacks is a named cause", () => {
  // The live audit on OpenRouter (real billing as ground truth): the launched id `anthropic/claude-haiku-4.5` is no id of Claude Code's catalog, so it priced
  // the request at a default row of its own: $0.1688 where Gluon (models.dev's OpenRouter row, the billed price) said $0.0422, 4x on every term.
  const haiku = { cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 }, context: 200_000 };
  const table = frozenTableWith({ "openrouter/anthropic/claude-haiku-4.5": haiku });
  const request = { model: "anthropic/claude-haiku-4.5", input: 10, output: 420, cacheRead: 0, cacheWrite: 32_076 };
  const fallbackRow = claudePriceFromTier(FROZEN_CLAUDE_CATALOG.pricingTiers.tier_4_20_cache_read_0_20!);
  const fallbackUsd = claudeCost(fallbackRow, { input_tokens: request.input, output_tokens: request.output, cache_creation_input_tokens: request.cacheWrite }).usd;
  const tracker = (ledger: Ledger) => frozenTracker({ harness: "claude-code", conn: "openrouter", launchedKey: "openrouter/anthropic/claude-haiku-4.5", ledger, table, now: () => 1 });

  test("the observed request: ours is the billed $0.0422, Claude's $0.1688 is the fallback row's price, and the ledger says so instead of 'unexplained'", () => {
    expect(claudeCatalogModel("anthropic/claude-haiku-4.5", FROZEN_CLAUDE_CATALOG)).toBeUndefined();
    expect(fallbackUsd).toBeCloseTo(0.1688, 4);
    const ledger = new Ledger();
    const t = tracker(ledger);
    t.claudeRequest({ ...request, reportedUsd: fallbackUsd });
    expect(t.figure()!.usd).toBeCloseTo(0.0422, 4);
    expect(ledger.divergences().map((d) => [d.scope, d.cause, d.reportedMicros, d.ownMicros])).toEqual([["request", "harness-unknown-model-price", Math.round(fallbackUsd * 1e6), Math.round(t.figure()!.usd * 1e6)]]);
    // The running total of such requests is explained the same way (and Gluon's figure is untouched).
    t.reportedCumulative(fallbackUsd);
    t.ended();
    expect(ledger.divergences().map((d) => [d.scope, d.cause])).toEqual([["request", "harness-unknown-model-price"], ["cumulative", "harness-unknown-model-price"]]);
    expect(t.figure()!.usd).toBeCloseTo(0.0422, 4);
  });

  test("the cause is for an id the catalog lacks only: the same figure on an id it lists, or one that matches no row, stays unexplained", () => {
    const listed = new Ledger();
    tracker(listed).claudeRequest({ ...request, model: "claude-haiku-4-5", reportedUsd: fallbackUsd });
    expect(listed.divergences().map((d) => d.cause)).toEqual(["unexplained"]);
    const other = new Ledger();
    tracker(other).claudeRequest({ ...request, reportedUsd: fallbackUsd * 1.37 });
    expect(other.divergences().map((d) => d.cause)).toEqual(["unexplained"]);
    // Agreeing figures are no divergence.
    const same = new Ledger();
    const t = tracker(same);
    t.claudeRequest({ ...request });
    t.claudeRequest({ ...request, reportedUsd: t.figure()!.usd });
    expect(same.divergences()).toEqual([]);
  });

  test("the name is a ledger cause the file keeps, and the report counts it", () => {
    const ledger = new Ledger();
    tracker(ledger).claudeRequest({ ...request, reportedUsd: fallbackUsd });
    expect(reportLines(ledger.entries).join("\n")).toContain("claude-code harness-unknown-model-price");
  });
});

describe("BUG-472: a running total that arrives before the usage record it includes compares equal to ours", () => {
  // The plugin's and the telemetry's samples come 2 to 100 ms BEFORE the usage record that moves our own sum: a one-turn session compared them at once
  // and reported "1 differ, unexplained" for two equal totals.
  const claudeReq = { model: "claude-haiku-4-5-20251001", input: 1000, output: 100, cacheRead: 5000, cacheWrite: 2000 };
  const claudeUsd = (() => {
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic" });
    t.claudeRequest(claudeReq);
    return t.figure()!.usd;
  })();
  const step = { model: "openrouter/deepseek/deepseek-v4-flash", tokens: { input: 7_000, output: 300, reasoning: 0, cache: { read: 2_000, write: 0 } } };
  const stepUsd = (() => {
    const t = frozenTracker({ harness: "opencode", conn: "openrouter" });
    t.opencodeStep(step);
    return t.figure()!.usd;
  })();

  const cumulative = (ledger: Ledger) => ledger.entries.filter((e) => e.kind === "observation" && e.scope === "cumulative") as { reportedMicros: number; ownMicros: number; cause: string }[];

  test("Claude Code: the plugin's sample before the request's usage record (a one-turn session)", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    t.observeCost(claudeUsd);
    expect(cumulative(ledger)).toEqual([]);
    t.claudeRequest(claudeReq);
    const [sample] = cumulative(ledger);
    expect(sample).toMatchObject({ reportedMicros: Math.round(claudeUsd * 1e6), ownMicros: Math.round(claudeUsd * 1e6), cause: "none" });
    t.ended();
    expect(cumulative(ledger).length).toBe(1);
    expect(ledger.divergences()).toEqual([]);
    expect(reportLines(ledger.entries).join("\n")).toContain("running total: 1 observation, 0 differ");
  });

  test("Claude Code: the telemetry's cumulative metric too, and a turn after turn: each total is met by its own request", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    for (let i = 1; i <= 3; i++) {
      t.reportedCumulative(claudeUsd * i);
      t.observeCost(claudeUsd * i);
      t.claudeRequest(claudeReq);
    }
    t.ended();
    expect(cumulative(ledger).map((c) => c.cause)).toEqual(Array(6).fill("none"));
    expect(ledger.divergences()).toEqual([]);
  });

  test("OpenCode: the `usage.updated` total before the step's record", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "opencode", conn: "openrouter", ledger, now: () => 1 });
    t.reportedCumulative(stepUsd);
    t.opencodeStep(step);
    expect(cumulative(ledger).map((c) => c.cause)).toEqual(["none"]);
    t.ended();
    expect(ledger.divergences()).toEqual([]);
  });

  test("a total that stays ahead of ours is still a divergence: judged when the session ends, or after the grace window at the next record, never silently dropped", () => {
    let now = 1;
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => now });
    t.observeCost(claudeUsd * 3);
    t.claudeRequest(claudeReq);
    expect(cumulative(ledger)).toEqual([]);
    now += SETTLE_GRACE_MS + 1;
    t.claudeRequest(claudeReq);
    expect(cumulative(ledger).map((c) => c.cause)).toEqual(["unexplained"]);
    // The sample keeps the time it arrived at, so the report still takes the launch's LAST sample.
    expect(cumulative(ledger)[0]).toMatchObject({ reportedMicros: Math.round(claudeUsd * 3e6) });
    const ended = new Ledger();
    const e = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger: ended, now: () => 1 });
    e.observeCost(claudeUsd * 3);
    e.ended();
    expect(cumulative(ended).map((c) => c.cause)).toEqual(["unexplained"]);
    expect(ended.divergences().length).toBe(1);
  });

  test("a total level with ours or behind it (the telemetry first, the old order) is written at once, as before", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    t.claudeRequest(claudeReq);
    t.observeCost(claudeUsd);
    t.observeCost(claudeUsd / 2);
    expect(cumulative(ledger).map((c) => c.cause)).toEqual(["none", "unexplained"]);
  });
});

describe("BUG-473: a context reading that arrives before the request's usage record is paired with ours, not logged one-sided", () => {
  type Context = { ownPct?: number; reportedPct?: number; cause?: string };
  const contexts = (ledger: Ledger) => ledger.entries.filter((e) => e.kind === "context") as Context[];

  for (const harness of ["claude-code", "opencode"] as const) {
    test(`${harness}: the reading first, then ours: one entry with both sides and the cause none`, () => {
      const ledger = new Ledger();
      const t = frozenTracker({ harness, conn: "anthropic", ledger, now: () => 1 });
      t.observeContext({ reported: { tokens: 40_000, window: 200_000 } });
      expect(contexts(ledger)).toEqual([]);
      t.ownContextChanged({ tokens: 40_000, window: 200_000 });
      expect(contexts(ledger)).toMatchObject([{ ownPct: 20, reportedPct: 20, cause: "none" }]);
      t.ended();
      expect(contexts(ledger).length).toBe(1);
      expect(ledger.contextDivergences()).toEqual([]);
    });
  }

  test("a turn after turn: each reading meets the request that follows it, and the last one is compared too", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    t.ownContextChanged({ tokens: 20_000, window: 200_000 });
    for (const tokens of [40_000, 60_000, 80_000]) {
      t.observeContext({ reported: { tokens, window: 200_000 } });
      t.ownContextChanged({ tokens, window: 200_000 });
    }
    t.ended();
    expect(contexts(ledger).map((c) => [c.ownPct, c.reportedPct, c.cause])).toEqual([[20, 20, "none"], [30, 30, "none"], [40, 40, "none"]]);
  });

  test("a reading that never agrees is a real difference, written against ours when the next reading comes, when the grace window passes, or at the end", () => {
    let now = 1;
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => now });
    t.ownContextChanged({ tokens: 20_000, window: 200_000 });
    t.observeContext({ reported: { tokens: 90_000, window: 200_000 } });
    now += SETTLE_GRACE_MS + 1;
    t.ownContextChanged({ tokens: 21_000, window: 200_000 });
    expect(contexts(ledger)).toMatchObject([{ ownPct: 11, reportedPct: 45, cause: "tokens" }]);
    t.observeContext({ reported: { tokens: 90_000, window: 200_000 } });
    t.observeContext({ reported: { tokens: 91_000, window: 200_000 } });
    expect(contexts(ledger).length).toBe(2);
    t.ended();
    expect(contexts(ledger).map((c) => c.cause)).toEqual(["tokens", "tokens", "tokens"]);
    // With no context of ours at all (a compaction, a model without a window) the reading is still recorded, one-sided, at the end.
    const none = new Ledger();
    const n = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger: none, now: () => 1 });
    n.observeContext({ reported: { tokens: 40_000, window: 200_000 } });
    n.ended();
    expect(contexts(none)).toMatchObject([{ reportedPct: 20 }]);
    expect(contexts(none)[0]).not.toHaveProperty("ownPct");
  });
});

describe("BUG-475: a session's tracker is ended at every way out of Gluon", () => {
  test("the process's exit (a crash included) ends the trackers still waiting, and a session's own end drops its tracker", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "gluon.ts"), "utf8");
    expect(src).toMatch(/process\.on\("exit", \(\) => \{[^}]*for \(const t of trackers\) t\.ended\(\);/s);
    expect(src).toMatch(/tracker\.ended\(\);\s*trackers\.delete\(tracker\);/);
    // Ending twice is harmless: nothing is written twice.
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1 });
    t.observeCost(1.23);
    t.ended();
    t.ended();
    expect(ledger.entries.length).toBe(1);
  });
});

// ---- QA of the parsers that read a vendor's text (B4) ----

describe("QA cost: the literal parser and the Claude catalog read from a binary", () => {
  const literal = (mutate: (c: Record<string, any>) => void) => claudeCatalogLiteral(mutate);
  const build = (mutate: (c: Record<string, any>) => void) => claudeTable(literal(mutate), { version: "9.9.9", fastPricing: {} });

  test("a literal is never evaluated and a hostile one only ever throws an Error: deep nesting, a huge string, odd escapes, comments, numbers that are not numbers", () => {
    const hostile = [
      "[".repeat(200_000),
      `{a:${"[".repeat(100_000)}${"]".repeat(100_000)}}`,
      `{a:"${"x".repeat(2_000_000)}`,
      '{a:"\\x41"}',
      '{a:"\\u00"}',
      "{a:1 // c\n}",
      "{a:/* c */1}",
      "{a:undefined}",
      "{a:NaN}",
      "{a:Infinity}",
      "{a:0x10}",
      "{a:.5}",
      "{a:1_000}",
      "{a:-}",
      "{a:[,]}",
      "{a:(1)}",
      "{a:!2}",
      "{a:this}",
      "{a:process.exit(1)}",
      "{[a]:1}",
      "{get a(){return 1}}",
      "{...a}",
      "",
      "   ",
    ];
    for (const text of hostile) {
      let threw: unknown;
      try {
        parseJsLiteral(text);
      } catch (e) {
        threw = e;
      }
      expect([text.slice(0, 30), threw instanceof Error]).toEqual([text.slice(0, 30), true]);
    }
    // Keys that name Object.prototype members are plain keys of a plain, null-prototype object.
    const o = parseJsLiteral('{__proto__:{x:1},constructor:2,toString:3}') as Record<string, unknown>;
    expect([Object.getPrototypeOf(o), o.constructor, Object.keys(o)]).toEqual([null, 2, ["__proto__", "constructor", "toString"]]);
    expect((({}) as Record<string, unknown>).x).toBeUndefined();
  });

  test("the numbers a bundler writes: 1e6, 1E-3, -0, 12.5, and a number that is too big is Infinity (the table then refuses it)", () => {
    expect(parseJsLiteral("[1e6,1E-3,-0,12.5,0,007]")).toEqual([1_000_000, 0.001, -0, 12.5, 0, 7]);
    expect(parseJsLiteral("[1e999]")).toEqual([Infinity]);
  });

  test("balancedObject: a brace inside a string or after an escaped quote does not close it, and one that never closes within the limit is null", () => {
    expect(balancedObject('{a:"}",b:"\\"}"}tail', 0)).toBe('{a:"}",b:"\\"}"}');
    expect(balancedObject("{a:{b:{c:1}}", 0)).toBeNull();
    expect(balancedObject(`{a:"${"x".repeat(500)}"}`, 0, 100)).toBeNull();
  });

  // `trim` gives a model whose `context.window` is not a number 200,000 (`claude-catalog.ts`), and the table is valid: a layout Claude Code changed (a renamed field) on a
  // user's newer binary makes every model 200k, so a 1M model's context reads 5x too full until it passes 200k. Gluon runs this build on the user's machine, no maintainer in the loop.
  test("BUG-633/QA-cost-08: a catalog model whose context has no window is refused, not sized 200k: a layout Claude Code changed must not silently make every 1M model read 5x too full", () => {
    expect(() => build((c) => void (c.models[0].context = {}))).toThrow();
  });

  // Claude Code 2.1.293's catalog, as read from the installed binary: three legacy models with no `context` at all (its own schema makes it optional) and Haiku 5.5's tier with a
  // `long_prompt` row. Both made `gluon pricing update` refuse the whole Claude table (BUG-633's strictness, then the schema's allowlist), so no Claude request had a price: no figure.
  const as293 = (c: Record<string, any>) => {
    for (const id of ["claude-3-9-test-a", "claude-3-9-test-b", "claude-3-9-test-c"]) c.models.push({ id, family: "sonnet", provider_ids: { first_party: id }, pricing: c.models[0].pricing });
    c.pricing_tiers.haiku_55 = { input: 0.1, output: 0.5, cache_write_5m: 0.125, cache_write_1h: 0.2, cache_read: 0.01, web_search: 0.01, long_prompt: { above_prompt_tokens: 100000, input: 0.5, output: 2.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05 } };
    c.models.push({ id: "claude-haiku-5-5", family: "haiku", provider_ids: { first_party: "claude-haiku-5-5" }, pricing: "haiku_55", context: { window: 1_000_000, native_1m: true, supports_1m_beta: true } });
  };

  test("BUG-675/claude-2.1.293: a catalog with legacy models that have no context and a tier with a long_prompt row builds a valid table (the model without a context is 200k)", () => {
    const table = build(as293);
    expect(tableProblem("claude-catalog", table)).toBeNull();
    const legacy = table.models.filter((m) => m.id.startsWith("claude-3-9-test-"));
    expect(legacy.map((m) => [m.window, m.native1m, m.supports1mSuffix, m.supports1mBeta])).toEqual([[200_000, false, false, false], [200_000, false, false, false], [200_000, false, false, false]]);
    expect(table.models.find((m) => m.id === "claude-haiku-5-5")!.window).toBe(1_000_000);
    expect(table.pricingTiers.haiku_55!.long_prompt).toEqual({ above_prompt_tokens: 100000, input: 0.5, output: 2.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05 });
  });

  test("BUG-675/claude-2.1.293: only a claude-3- model with no context is sized 200k: any other model without one throws, so a moved layout (or 8 of 11 1M models losing theirs) never builds at 200k", () => {
    expect(() => build((c) => void delete c.models.find((m: { id: string }) => !m.id.startsWith("claude-3-")).context)).toThrow(/without a context window/);
    expect(() => build((c) => void c.models.forEach((m: Record<string, unknown>) => delete m.context))).toThrow(/without a context window/);
    // A legacy id keeps its 200k only by its id, not because others lack a context too.
    expect(() => build((c) => {
      as293(c);
      for (const m of c.models.filter((x: { id: string }) => !x.id.startsWith("claude-3-")).slice(0, 8)) delete m.context;
    })).toThrow(/without a context window/);
  });

  test("BUG-675/claude-2.1.293: a prompt over a tier's long_prompt size is billed wholly at that row, as Claude Code 2.1.293 reports it (captured: $0.001300 under, $0.015750 over)", () => {
    const price = claudePriceFromTier(build(as293).pricingTiers.haiku_55!);
    // Under: 1000 + 90,000 cache read = 91,000 prompt tokens, the usual row.
    expect(claudeCost(price, { input_tokens: 1000, output_tokens: 600, cache_read_input_tokens: 90_000 }).micros).toBe(1300);
    // Over: 1000 + 150,000 read + 10,000 written = 161,000 prompt tokens: every term at the long row (the web search fee is the tier's).
    expect(claudeCost(price, { input_tokens: 1000, output_tokens: 600, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 10_000 }).micros).toBe(15_750);
    // Exactly the size is not over it; one more token is.
    expect(claudeCost(price, { input_tokens: 100_000, output_tokens: 0 }).micros).toBe(10_000);
    expect(claudeCost(price, { input_tokens: 100_001, output_tokens: 0 }).micros).toBe(50_001);
    expect(claudeCost(price, { input_tokens: 1000, output_tokens: 0, server_tool_use: { web_search_requests: 1 }, cache_read_input_tokens: 200_000 }).micros).toBe(500 + 10_000 + 10_000);
  });

  test("BUG-675/claude-2.1.293: the change guard reads a long_prompt row as prices: a new tier is no change of an old one, a long price that moved 4x is named", () => {
    const before = build(() => {}) as unknown as Record<string, unknown>;
    const after = build(as293) as unknown as Record<string, unknown>;
    expect(changeProblems("claude-catalog", before, after).gone).toEqual([]);
    const dearer = build((c) => {
      as293(c);
      c.pricing_tiers.haiku_55.long_prompt.input *= 4;
    }) as unknown as Record<string, unknown>;
    expect(changeProblems("claude-catalog", after, dearer).moved.some((m) => m.includes("long_prompt.input"))).toBe(true);
  });

  test("BUG-675/claude-2.1.293: the tracker prices a Haiku 5.5 request by its long row and its figure equals what Claude Code reported (no divergence)", () => {
    const ledger = new Ledger();
    const claudeCatalog = { ...CLAUDE_CATALOG, ...build(as293), claudeCodeVersion: "2.1.293" } as typeof CLAUDE_CATALOG;
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 1, claudeCatalog });
    t.claudeRequest({ model: "claude-haiku-5-5", input: 1000, output: 600, cacheRead: 90_000, cacheWrite: 0, reportedUsd: 0.0013 });
    t.claudeRequest({ model: "claude-haiku-5-5", input: 1000, output: 600, cacheRead: 150_000, cacheWrite: 10_000, reportedUsd: 0.01575 });
    expect(t.figure()!.usd).toBeCloseTo(0.01705, 9);
    expect(ledger.divergences()).toEqual([]);
  });

  test("Haiku 5.5 outside Claude Code's catalog (2.1.289's, an OpenRouter id) is priced from models.dev's row, its context tier as the long-prompt row: the same figures as the catalog's", () => {
    for (const key of ["anthropic/claude-haiku-5-5", "amazon-bedrock/global.anthropic.claude-haiku-5-5", "openrouter/anthropic/claude-haiku-5.5"]) {
      const price = claudePriceFrom(priceEntry(key, MODELS_DEV)!.cost);
      expect([key, price.longPrompt?.abovePromptTokens, price.longPrompt?.inputTokens]).toEqual([key, 100_000, 0.5]);
      expect(claudeCost(price, { input_tokens: 1000, output_tokens: 600, cache_read_input_tokens: 90_000 }).micros).toBe(1300);
      expect(claudeCost(price, { input_tokens: 1000, output_tokens: 600, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 10_000 }).micros).toBe(15_750);
    }
    // A tier that names only its input and output: its cache prices follow its own input, not the base row's.
    expect(claudePriceFrom({ input: 0.1, output: 0.5, tiers: [{ tier: { type: "context", size: 100_000 }, input: 0.5, output: 2.5 }] }).longPrompt).toMatchObject({ promptCacheReadTokens: 0.05, promptCacheWriteTokens: 0.625 });
    // No tier: one flat row, as before.
    expect(claudePriceFrom(priceEntry("anthropic/claude-sonnet-5-5", MODELS_DEV)!.cost).longPrompt).toBeUndefined();
    // The tracker on Bedrock, where the frozen catalog (2.1.289) lacks the model: models.dev's row, tier and all.
    const t = frozenTracker({ harness: "claude-code", conn: "bedrock", now: () => 1, table: MODELS_DEV, claudeCatalog: CLAUDE_CATALOG });
    t.claudeRequest({ model: "global.anthropic.claude-haiku-5-5", input: 1000, output: 600, cacheRead: 150_000, cacheWrite: 10_000 });
    expect(t.figure()!.usd).toBeCloseTo(0.01575, 9);
  });
});
