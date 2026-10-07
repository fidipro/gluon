#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Generates a models.dev price table (issue #39, #89): the way to build one by hand, from the live sources or from files (the builder is `src/cost/modelsdev-catalog.ts`, shared with Gluon's own refresh). One entry per line.
 * Deterministic and idempotent: the same catalog gives the same bytes (`generatedAt` is a day: today's for a table that changed, the
 * file's own for one that did not, or `--generated-at`; the catalog's own date, `catalogUpdatedAt`, is null for the public API, which has none).
 *   bun scripts/pricing/modelsdev.ts --out path (--live | --from catalog.json --openrouter-from listing.json --openrouter-endpoints-from endpoints.json) [--catalog-date ISO] [--generated-at YYYY-MM-DD]
 * It reaches the network only with `--live` (a maintainer's manual refresh), for each source not given as a file: models.dev's
 * `api.json`, OpenRouter's listing and its `/models/<id>/endpoints`. Without `--live` a missing file is an error, never a fetch: the
 * regression suite is offline (BUG-520). `--from` takes the catalog itself (OpenCode keeps a snapshot of it in its
 * cache dir, `models.json`) or OpenCode's kv row `{updatedAt, digest, body}` (the date is its `updatedAt`; a bare catalog has none:
 * `--catalog-date`). A DEFAULT_MODELS model with no entry is listed in `missing`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildModelsDevTable, format, priceModelsDev, type Catalog, type EndpointsReply, type OpenRouterListing } from "../../src/cost/modelsdev-catalog.ts";
import { generatedDay } from "./stable.ts";

export { applyEndpoints, applyOpenRouter, buildModelsDevTable, endpointRange, entriesDigest, format, openCodeProviders, perMillion, priceModelsDev, select, wantedKeys, type Entry } from "../../src/cost/modelsdev-catalog.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const LIVE = process.argv.includes("--live");
/** A source's file, or (only with `--live`) undefined: the fetch. Without `--live` a missing file refuses (BUG-520). */
const fileOrLive = (flag: string): string | undefined => {
  const from = arg(flag);
  if (!from && !LIVE) throw new Error(`no ${flag}: pass the file, or --live to fetch it (only a manual refresh does; the regression suite never reaches the network)`);
  return from;
};

async function load(): Promise<{ catalog: Catalog; updatedAt: number | string | null }> {
  const from = fileOrLive("--from");
  const text = from ? readFileSync(from, "utf8") : await (await fetch("https://models.dev/api.json")).text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  // Either the catalog itself, or OpenCode's kv row `{updatedAt, digest, body}`.
  const row = typeof parsed.body === "string" || (parsed.body && typeof parsed.body === "object") ? parsed : null;
  const catalog = (row ? (typeof row.body === "string" ? JSON.parse(row.body) : row.body) : parsed) as Catalog;
  return { catalog, updatedAt: row && typeof row.updatedAt === "number" ? row.updatedAt : (arg("--catalog-date") ?? null) };
}

/** The replies for the wanted `openrouter/*` models: from a file, or OpenRouter's free `/models/<id>/endpoints` (a 404 is a model it doesn't know: no reply; any other failure fails the run). */
async function loadEndpoints(ids: string[]): Promise<Record<string, EndpointsReply>> {
  const from = fileOrLive("--openrouter-endpoints-from");
  if (from) return JSON.parse(readFileSync(from, "utf8")) as Record<string, EndpointsReply>;
  const out: Record<string, EndpointsReply> = {};
  for (const id of ids) {
    if (!/^[\w.:@~-]+\/[\w.:@~-]+$/.test(id)) continue;
    const res = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`OpenRouter's endpoints of ${id}: HTTP ${res.status}`);
    out[id] = (await res.json()) as EndpointsReply;
  }
  return out;
}

async function loadOpenRouter(): Promise<OpenRouterListing> {
  const from = fileOrLive("--openrouter-from");
  let text: string;
  if (from) text = readFileSync(from, "utf8");
  else {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw new Error(`OpenRouter's listing: HTTP ${res.status}`);
    text = await res.text();
  }
  return JSON.parse(text) as OpenRouterListing;
}


if (import.meta.main) {
  const OUT = arg("--out");
  if (!OUT) throw new Error("no output: pass --out <path> (Gluon's tables live in its state directory, never in the repository)");
  const { catalog, updatedAt } = await load();
  const listing = await loadOpenRouter();
  const body = buildModelsDevTable({ catalog, openrouterListing: listing, endpoints: await loadEndpoints(priceModelsDev(catalog, listing).orIds), generatedAt: "", catalogUpdatedAt: updatedAt });
  const table = { ...body, generatedAt: generatedDay(OUT, body, arg("--generated-at")) };
  writeFileSync(OUT, format(table));
  console.log(`${Object.keys(table.entries).length} priced, ${table.missing.length} missing${table.missing.length ? `: ${table.missing.join(", ")}` : ""} -> ${OUT}`);
}
