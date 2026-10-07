/**
 * What the price sources say, built from the fixture tables (`test/fixtures/tables/`): models.dev's catalog, OpenRouter's listing and its endpoints
 * replies, and a local server that serves them (`servePricing`: what `GLUON_TEST_PRICING` points Gluon at). A test
 * that refreshes the tables (`src/cost/refresh.ts`) reads these and nothing real. The sources are mutable: `mutate*` change what a source says.
 */
import { FIXTURE_CLAUDE_CATALOG, FIXTURE_MODELS_DEV } from "./fixture-tables.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** models.dev's catalog (`{ provider: { models: { id: row } } }`) that the fixture models.dev table was built from. */
export function modelsDevCatalog(mutate: (c: Record<string, any>) => void = () => {}): Record<string, any> {
  const catalog: Record<string, any> = {};
  for (const [key, e] of Object.entries(FIXTURE_MODELS_DEV.entries)) {
    const [provider, ...rest] = key.split("/");
    const row: Record<string, any> = { cost: { ...e.cost, ...(e as { modelsdevCost?: object }).modelsdevCost }, limit: { context: e.context } };
    if (e.status) row.status = e.status;
    if (e.modes) row.experimental = { modes: Object.fromEntries(Object.entries(e.modes).map(([n, m]) => [n, { cost: m.cost, provider: { body: { ...(m.serviceTier ? { service_tier: m.serviceTier } : {}), ...(m.speed ? { speed: m.speed } : {}) } } }])) };
    (catalog[provider!] ??= { models: {} }).models[rest.join("/")] = row;
  }
  mutate(catalog);
  return catalog;
}

/** A long-context price tier as OpenRouter lists one: an `overrides` row with a `min_prompt_tokens`. */
const tierOverrides = (cost: object): { overrides?: { min_prompt_tokens: number }[] } => {
  const tiers = (cost as { tiers?: { tier?: { size?: number } }[] }).tiers;
  return tiers?.length ? { overrides: tiers.map((t) => ({ min_prompt_tokens: t.tier?.size ?? 0 })) } : {};
};

/** OpenRouter's `/models` listing for every OpenRouter-priced fixture entry (USD per token, as decimal strings). */
export function openRouterListing(mutate: (l: { data: Record<string, any>[] }) => void = () => {}): { data: Record<string, any>[] } {
  const perToken = (n: number) => (n / 1e6).toString();
  const data = Object.entries(FIXTURE_MODELS_DEV.entries)
    .filter(([key, e]) => key.startsWith("openrouter/") && (e as { priceSource?: string }).priceSource === "openrouter")
    .map(([key, e]) => ({
      id: key.slice("openrouter/".length),
      context_length: e.context ?? 100_000,
      pricing: { ...tierOverrides(e.cost), prompt: perToken(e.cost.input ?? 0), completion: perToken(e.cost.output ?? 0), ...(e.cost.cache_read !== undefined ? { input_cache_read: perToken(e.cost.cache_read) } : {}), ...(e.cost.cache_write !== undefined ? { input_cache_write: perToken(e.cost.cache_write) } : {}) },
    }));
  const listing = { data };
  mutate(listing);
  return listing;
}

/** `/models/<id>/endpoints` for a model: its cheapest and dearest endpoint, from the fixture's range; undefined for a model with none. */
export function endpointsReply(id: string): { data: { endpoints: { pricing: Record<string, string> }[] } } | undefined {
  const range = FIXTURE_MODELS_DEV.entries[`openrouter/${id}`]?.endpoints;
  if (!range) return undefined;
  const perToken = (n: number) => (n / 1e6).toString();
  return { data: { endpoints: [{ pricing: { prompt: perToken(range.input.min), completion: perToken(range.output.min) } }, { pricing: { prompt: perToken(range.input.max), completion: perToken(range.output.max) } }] } };
}

/**
 * Claude Code's own baked-in model catalog as the text of its literal (the fixture's models and tiers): what `catalogText` finds in the installed binary.
 * It is no source on the network: Anthropic's published catalog has no prices, so Claude's table is built from the binary alone.
 */
export function claudeCatalogLiteral(mutate: (c: Record<string, any>) => void = () => {}): string {
  const b = FIXTURE_CLAUDE_CATALOG;
  const c: Record<string, any> = {
    "//": "Hand-maintained baked-in model catalog",
    pricing_tiers: clone(b.pricingTiers),
    models: b.models.map((m) => ({ id: m.id, family: m.family, provider_ids: m.providerIds, pricing: m.pricing, context: { window: m.window, native_1m: m.native1m, supports_1m_suffix: m.supports1mSuffix, supports_1m_beta: m.supports1mBeta } })),
  };
  mutate(c);
  // A minified bundle writes true and false as !0 and !1.
  return JSON.stringify(c).replace(/:true/g, ":!0").replace(/:false/g, ":!1");
}
export const addClaudeModel = (c: Record<string, any>) => void c.models.push({ id: "claude-test-9", family: "opus", provider_ids: { first_party: "claude-test-9" }, pricing: c.models[0].pricing, context: { window: 200_000 } });

/** What each source answers; a test changes a field (a function: computed at each request). */
export interface Sources {
  modelsDev: () => string | null;
  listing: () => string | null;
  endpoints: (id: string) => string | null;
}

/** The sources as the fixtures say them. */
export function fixtureSources(): Sources {
  return {
    modelsDev: () => JSON.stringify(modelsDevCatalog()),
    listing: () => JSON.stringify(openRouterListing()),
    endpoints: (id) => {
      const r = endpointsReply(id);
      return r ? JSON.stringify(r) : null;
    },
  };
}

/** The URL paths of `PricingSource` for a base: `/api.json`, `/api/v1`. */
export const urlsFor = (base: string) => ({ modelsDev: `${base}/api.json`, openrouter: `${base}/api/v1` });

/**
 * A local server for the sources (`GLUON_TEST_PRICING`: `{ base }` of `http://127.0.0.1:<port>`). `seen` lists the paths asked; a source answering null is a 404;
 * `hold` makes every request wait (never answer) until the server stops, to prove nothing waits on a refresh; `gate` makes each wait for that promise, then answer.
 */
export function servePricing(sources: Sources = fixtureSources(), { hold = false, gate }: { hold?: boolean; gate?: Promise<void> } = {}) {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // A request waiting for `gate` is not idle: Bun's default (10 s) would cut it before a slow runner's test lets go (BUG-512).
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      if (hold) return new Promise<Response>(() => {});
      await gate;
      let body: string | null = null;
      if (path === "/api.json") body = sources.modelsDev();
      else if (path === "/api/v1/models") body = sources.listing();
      else if (path.startsWith("/api/v1/models/") && path.endsWith("/endpoints")) body = sources.endpoints(path.slice("/api/v1/models/".length, -"/endpoints".length));
      return body === null ? new Response("{}", { status: 404 }) : new Response(body, { headers: { "content-type": "application/json" } });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { server, seen, base, stop: () => server.stop(true) };
}

/** What Claude Code's price function looks like in its binary, with these fast-mode rows (`fastPricingOf` reads it). */
export const claudeFastFunction = (rows: Record<string, any>): string => {
  const defs = Object.values(rows).map((r, i) => `r${i}={inputTokens:${r.input},outputTokens:${r.output},promptCacheWriteTokens:${r.cache_write_5m},promptCacheWrite1hTokens:${r.cache_write_1h},promptCacheReadTokens:${r.cache_read},webSearchRequests:${r.web_search}}`);
  const branch = Object.keys(rows).map((id, i) => `if(r==="${id}")return r${i};`);
  return `var ${defs.join(",")};function L(e,n){let r=e;if(n.speed==="fast"){${branch.join("")}}return null}`;
};

/** A Claude Code binary's bytes: its price function and its baked-in catalog literal (`catalogText` finds it). */
export const claudeBinaryText = (fastRows: Record<string, any>, mutate?: (c: Record<string, any>) => void): string => `\0\0${claudeFastFunction(fastRows)}\0var usr=${claudeCatalogLiteral(mutate)};\0`;
