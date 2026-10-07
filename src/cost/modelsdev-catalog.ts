/**
 * Building the models.dev price table (issue #39, #89): the public catalog (the JSON OpenCode prices from)
 * trimmed to (1) the models Gluon offers on each connection (`DEFAULT_MODELS`), with their priced modes, and
 * (2) every priced model of the providers Gluon's OpenCode connections reach (`PROVIDERS[*].opencodeId`:
 * OpenCode lets the user switch to any of them, and a step on a model the table lacks has no figure of
 * ours), with prices (USD per million tokens, tiers included) and context limits. Pure (parsed data in,
 * table out; no file, no network): `scripts/pricing/modelsdev.ts` (the manual refresh's generator) and the run-time
 * refresh both call it, so a table is built one way wherever it is built.
 *
 * An `openrouter/*` entry is priced from OpenRouter's own public listing (https://openrouter.ai/api/v1/models): it is what
 * OpenRouter bills, and models.dev has been 6x off on one (BUG-469). Such an entry says `priceSource: "openrouter"`, and keeps
 * models.dev's price as `modelsdevCost` where the two differ, so the validator can report the disagreement. Each wanted
 * `openrouter/*` entry also records `endpoints` (count, min and max input and output price) from OpenRouter's free
 * `/models/<id>/endpoints`: a model billed at the provider that served each request has several prices, and Gluon marks its
 * OpenRouter figure `~` by this table. A wanted model with no entry is listed in `missing`.
 */
import { createHash } from "node:crypto";
import { DEFAULT_MODELS, MAINTAINER_TEST_MODELS, PROVIDERS, type Conn, type Harness, type ModelEntry } from "../harnesses.ts";
import { priceKey } from "./keys.ts";
import { rowProblem } from "./table-schema.ts";

export type Catalog = Record<string, { models?: Record<string, Record<string, unknown>> }>;
export type Mode = { cost: unknown; serviceTier?: string; speed?: string };
export interface Entry {
  cost: unknown;
  context: number | null;
  status?: string;
  /** Present when the price is OpenRouter's own listing rather than models.dev's. */
  priceSource?: "openrouter";
  /** An `openrouter/*` entry Gluon offers: how many endpoints OpenRouter lists for the model, and their cheapest and dearest input and output price (USD per million). */
  endpoints?: { count: number; input: { min: number; max: number }; output: { min: number; max: number } };
  /** A kept `openrouter/*` row OpenRouter's listing has not priced since this moment (it did not answer at the refreshes since). */
  staleSince?: string;
  /** models.dev's price (input, output, cache) for an OpenRouter-priced entry where it differs from OpenRouter's. */
  modelsdevCost?: Record<string, number>;
  modes?: Record<string, Mode>;
}

const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)])) : v);

/**
 * The table's digest: that of the entries Gluon keeps (canonical JSON, keys sorted), not of the whole upstream
 * catalog, so a change anywhere else on models.dev leaves the table as it was.
 */
export const entriesDigest = (entries: Record<string, Entry>): string => createHash("sha256").update(JSON.stringify(canonical(entries))).digest("hex");

/** The keys of the models Gluon offers on each connection (`DEFAULT_MODELS`, and the maintainers' live-test models): the table must price every one. */
export function wantedKeys(): Set<string> {
  const wanted = new Set<string>();
  for (const [harness, models] of [...Object.entries(DEFAULT_MODELS), ...Object.entries(MAINTAINER_TEST_MODELS)] as [Harness, ModelEntry[]][]) {
    for (const m of models) for (const conn of Object.keys(m.ids) as Conn[]) {
      const key = priceKey(harness, m.ids, conn);
      if (key) wanted.add(key);
    }
  }
  return wanted;
}

/** The models.dev providers OpenCode reaches on Gluon's connections (the part before the `/` of `--model`). */
export const openCodeProviders = (): string[] => [...new Set(Object.values(PROVIDERS).flatMap((p) => (p.opencodeId ? [p.opencodeId] : [])))].sort();

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The table's entries from a catalog: the wanted keys (`missing`: those it has no price for), then every other priced model of
 * `providers`. A priced mode (OpenAI's `service_tier`, Claude's `speed: fast`; a mode without its own cost is no price) only for a wanted key.
 * A row that is priced but odd (an unknown cost key, a price over the bound, a fractional window, a malformed object) is `skipped`, never copied into
 * a table that `parseTable` would then refuse whole (BUG-604); a skipped wanted key is `missing` too.
 */
export function select(catalog: Catalog, wanted: Set<string>, providers: string[]): { entries: Record<string, Entry>; missing: string[]; skipped: string[] } {
  const entries: Record<string, Entry> = {};
  const missing: string[] = [];
  const skipped: string[] = [];
  const entry = (key: string, model: unknown, withModes: boolean): Entry | undefined => {
    if (!isObj(model)) {
      if (model !== undefined) skipped.push(key);
      return undefined;
    }
    const m = model as { cost?: { input?: unknown; output?: unknown }; limit?: { context?: number }; status?: string; experimental?: { modes?: Record<string, { cost?: unknown; provider?: { body?: { service_tier?: string; speed?: string } } }> } };
    if (!m.cost || typeof m.cost !== "object" || typeof m.cost.input !== "number" || typeof m.cost.output !== "number") return undefined;
    let row: Entry;
    try {
      const modes: Record<string, Mode> = {};
      if (withModes && isObj(m.experimental?.modes))
        for (const [name, mode] of Object.entries(m.experimental.modes).sort(([a], [b]) => (a < b ? -1 : 1))) {
          const body = mode?.provider?.body;
          if (mode?.cost && (body?.service_tier || body?.speed)) modes[name] = { cost: mode.cost, ...(body.service_tier ? { serviceTier: body.service_tier } : {}), ...(body.speed ? { speed: body.speed } : {}) };
        }
      row = { cost: m.cost, context: typeof m.limit?.context === "number" ? m.limit.context : null, ...(m.status ? { status: m.status } : {}), ...(Object.keys(modes).length ? { modes } : {}) };
    } catch {
      skipped.push(key);
      return undefined;
    }
    if (rowProblem("modelsdev", key, row)) {
      skipped.push(key);
      return undefined;
    }
    return row;
  };
  for (const key of [...wanted].sort()) {
    const [provider, ...rest] = key.split("/");
    const models = catalog[provider!]?.models;
    const e = isObj(models) ? entry(key, models[rest.join("/")], true) : undefined;
    if (e) entries[key] = e;
    else missing.push(key);
  }
  for (const provider of providers) {
    const models = catalog[provider]?.models;
    if (!isObj(models)) continue;
    for (const [id, model] of Object.entries(models)) {
      const key = `${provider}/${id}`;
      const e = key in entries ? undefined : entry(key, model, false);
      if (e) entries[key] = e;
    }
  }
  return { entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1))), missing: missing.sort(), skipped: [...new Set(skipped)].sort() };
}

/** OpenRouter's USD per token (a decimal string) as USD per million tokens, without float noise; undefined for a missing, negative (a router's) or non-numeric one. */
export const perMillion = (v: unknown): number | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Number((n * 1e6).toPrecision(12)) : undefined;
};

export type OpenRouterListing = { data?: { id?: unknown; context_length?: unknown; pricing?: Record<string, unknown> & { overrides?: unknown } }[] };

const COST_FIELDS = ["input", "output", "cache_read", "cache_write"] as const;

/**
 * Prices every `openrouter/*` entry from OpenRouter's own listing (prompt, completion, input_cache_read, input_cache_write: per token
 * there, per million here): OpenRouter bills by it, so it wins over models.dev for those four fields (the rest of models.dev's row stays). A wanted key models.dev lacks
 * is added from the listing (`missing` shrinks); a model the listing does not carry keeps models.dev's price. `source` is untouched.
 */
export function applyOpenRouter(entries: Record<string, Entry>, missing: string[], listing: OpenRouterListing, wanted: Set<string>): { entries: Record<string, Entry>; missing: string[] } {
  // An error body or an empty listing must fail the run, not quietly leave models.dev's prices in (BUG-477).
  if (!Array.isArray(listing.data) || listing.data.length === 0) throw new Error("OpenRouter's listing has no models");
  const rows = new Map<string, { cost: Record<string, number>; context: number | null; tiered: boolean }>();
  for (const m of listing.data) {
    // A listing's element that is no object (a `null`) is no model: skipped, never a reason to refuse every price (BUG-606).
    if (!isObj(m)) continue;
    const input = perMillion(m.pricing?.prompt);
    const output = perMillion(m.pricing?.completion);
    if (typeof m.id !== "string" || input === undefined || output === undefined) continue;
    const cost: Record<string, number> = { input, output };
    const read = perMillion(m.pricing?.input_cache_read);
    const write = perMillion(m.pricing?.input_cache_write);
    if (read !== undefined) cost.cache_read = read;
    if (write !== undefined) cost.cache_write = write;
    // A long-context price OpenRouter bills is an `overrides` row with a `min_prompt_tokens`; none means one flat price (BUG-474).
    const tiered = Array.isArray(m.pricing?.overrides) && m.pricing.overrides.some((o) => Number((o as { min_prompt_tokens?: unknown })?.min_prompt_tokens) > 0);
    rows.set(m.id, { tiered, cost, context: typeof m.context_length === "number" && m.context_length > 0 ? m.context_length : null });
  }
  // A listing whose every element is unusable is an error body too (BUG-477).
  if (rows.size === 0) throw new Error("OpenRouter's listing has no usable models");
  const out: Record<string, Entry> = { ...entries };
  const stillMissing: string[] = [];
  for (const key of new Set([...Object.keys(entries), ...missing])) {
    if (!key.startsWith("openrouter/")) continue;
    const row = rows.get(key.slice("openrouter/".length));
    const old = entries[key];
    if (!row) {
      if (!old && missing.includes(key)) stillMissing.push(key);
      continue;
    }
    if (!old && !wanted.has(key)) continue;
    const was = (old?.cost ?? {}) as Record<string, unknown>;
    // A field the two agree on to rounding (models.dev's 0.083333 against OpenRouter's 0.0833333333) keeps models.dev's number.
    const same = (f: (typeof COST_FIELDS)[number]) => typeof was[f] === "number" && Math.abs((was[f] as number) - row.cost[f]!) <= 1e-4 * Math.max(Math.abs(row.cost[f]!), 1e-9);
    for (const f of COST_FIELDS) if (row.cost[f] !== undefined && same(f)) row.cost[f] = was[f] as number;
    const differs = old && COST_FIELDS.some((f) => row.cost[f] !== undefined && was[f] !== row.cost[f]);
    const prior = differs ? Object.fromEntries(COST_FIELDS.flatMap((f) => (typeof was[f] === "number" ? [[f, was[f] as number]] : []))) : undefined;
    const { cost: _cost, modelsdevCost: _prior, ...rest } = old ?? { cost: null, context: row.context };
    // The four fields the listing carries are OpenRouter's; the rest of models.dev's row (tiers, reasoning, a field the listing has no price for) stays.
    const merged: Record<string, unknown> = { ...was, ...row.cost };
    // models.dev's long-context tier stays where OpenRouter lists one; where it lists none the price is flat, and a stale tier would double the bill.
    if (!row.tiered) {
      delete merged.tiers;
      delete merged.context_over_200k;
    }
    out[key] = { ...rest, cost: merged, priceSource: "openrouter", ...(prior ? { modelsdevCost: prior } : {}) } as Entry;
  }
  return { entries: Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1))), missing: missing.filter((k) => stillMissing.includes(k) || !k.startsWith("openrouter/")).sort() };
}

export type EndpointsReply = { data?: { endpoints?: { pricing?: Record<string, unknown> }[] } } | null;

/** The endpoints a reply lists as a range, or undefined (none with a usable prompt and completion price). */
export function endpointRange(reply: EndpointsReply | undefined): Entry["endpoints"] {
  const eps = Array.isArray(reply?.data?.endpoints) ? reply.data.endpoints : [];
  const prices = eps.flatMap((e) => {
    const input = perMillion(e?.pricing?.prompt);
    const output = perMillion(e?.pricing?.completion);
    return input === undefined || output === undefined ? [] : [{ input, output }];
  });
  if (!prices.length) return undefined;
  const range = (f: "input" | "output") => ({ min: Math.min(...prices.map((p) => p[f])), max: Math.max(...prices.map((p) => p[f])) });
  return { count: prices.length, input: range("input"), output: range("output") };
}

/** Adds `endpoints` to every wanted `openrouter/*` entry priced from OpenRouter's listing, from `replies` by model id (a model with no reply or no usable endpoint gets none). */
export function applyEndpoints(entries: Record<string, Entry>, wanted: Set<string>, replies: Record<string, EndpointsReply>): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const [key, e] of Object.entries(entries)) {
    const { endpoints: _old, ...rest } = e;
    const range = wanted.has(key) && key.startsWith("openrouter/") && e.priceSource === "openrouter" ? endpointRange(replies[key.slice("openrouter/".length)]) : undefined;
    // A range over the table's bounds is left off (the row keeps its price) rather than refusing the whole table (BUG-604).
    out[key] = range && !rowProblem("modelsdev", key, { ...rest, endpoints: range }) ? { ...rest, endpoints: range } : rest;
  }
  return out;
}

/** The table's header and entries, as `format` writes them and `tables.ts` reads them. */
export interface ModelsDevTableOut {
  schema: 1;
  source: "models.dev";
  catalogUpdatedAt: string | null;
  generatedAt: string;
  /** When Gluon fetched it (a moment); absent in a table a generator made. */
  fetchedAt?: string;
  catalogDigest: string;
  missing: string[];
  entries: Record<string, Entry>;
}

/**
 * The first two steps of the build: models.dev's wanted and OpenCode's models, then OpenRouter's own prices over the `openrouter/*`
 * ones. `orIds` are the OpenRouter model ids whose `/models/<id>/endpoints` the next step (`buildModelsDevTable`) wants: the caller
 * fetches those. Throws when OpenRouter's listing has no models (an error body must not leave models.dev's prices in: BUG-477).
 * `openrouterListing` null: OpenRouter did not answer, so the table has no `openrouter/*` row (models.dev's price for one is never what bills: BUG-469;
 * a wanted one is `missing`) and the rest is built as ever (BUG-607). `skipped`: the rows left out for being odd (`select`; BUG-604).
 */
export function priceModelsDev(catalog: Catalog, openrouterListing: OpenRouterListing | null, wanted: Set<string> = wantedKeys(), providers: string[] = openCodeProviders()): { entries: Record<string, Entry>; missing: string[]; orIds: string[]; skipped: string[] } {
  const picked = select(catalog, wanted, providers);
  const skipped = new Set(picked.skipped);
  const missing = new Set(picked.missing);
  let entries: Record<string, Entry>;
  if (openrouterListing === null) {
    entries = {};
    for (const [key, e] of Object.entries(picked.entries)) {
      if (!key.startsWith("openrouter/")) entries[key] = e;
      else if (wanted.has(key)) missing.add(key);
    }
  } else {
    const priced = applyOpenRouter(picked.entries, picked.missing, openrouterListing, wanted);
    entries = priced.entries;
    missing.clear();
    for (const k of priced.missing) missing.add(k);
  }
  // OpenRouter's numbers (a price over the bound) are checked too: a row the table would refuse is skipped.
  for (const [key, e] of Object.entries(entries))
    if (rowProblem("modelsdev", key, e)) {
      delete entries[key];
      skipped.add(key);
      if (wanted.has(key)) missing.add(key);
    }
  const orIds = [...wanted].filter((k) => k.startsWith("openrouter/") && entries[k]?.priceSource === "openrouter").map((k) => k.slice("openrouter/".length));
  return { entries, missing: [...missing].sort(), orIds, skipped: [...skipped].sort() };
}

/**
 * The whole table from the three sources: models.dev's catalog, OpenRouter's listing and its endpoints replies by model id (`{ "<id>": reply }`;
 * a model with none gets no `endpoints`). `catalogUpdatedAt`: the catalog's own date (null for the public API, which has none); `generatedAt`:
 * a day (the manual refresh's generators) or a moment (Gluon's own refresh). Deterministic: the same inputs give the same table.
 */
export function buildModelsDevTable({ catalog, openrouterListing, endpoints, generatedAt, catalogUpdatedAt = null, fetchedAt }: { catalog: Catalog; openrouterListing: OpenRouterListing | null; endpoints: Record<string, EndpointsReply>; generatedAt: string; catalogUpdatedAt?: number | string | null; fetchedAt?: string }): ModelsDevTableOut {
  const wanted = wantedKeys();
  const priced = priceModelsDev(catalog, openrouterListing, wanted);
  const entries = applyEndpoints(priced.entries, wanted, endpoints);
  return { schema: 1, source: "models.dev", catalogUpdatedAt: catalogUpdatedAt === null ? null : new Date(catalogUpdatedAt).toISOString(), generatedAt, ...(fetchedAt ? { fetchedAt } : {}), catalogDigest: entriesDigest(entries), missing: priced.missing, entries };
}

/** The file's text: the header as indented JSON, one entry per line (a reviewable diff for a table of a thousand models). */
export function format(table: Omit<ModelsDevTableOut, "source"> & { source: string }): string {
  const { entries, ...head } = table;
  const lines = Object.entries(entries).map(([key, e]) => `  ${JSON.stringify(key)}: ${JSON.stringify(e)}`);
  return `${JSON.stringify(head, null, 1).slice(0, -2)},\n "entries": {\n${lines.join(",\n")}\n }\n}\n`;
}

