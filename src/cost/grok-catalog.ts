/**
 * Building the Grok table (`grok-models`) from Grok Build's binary: its embedded
 * `default_models.json`, read as bytes and parsed with `JSON.parse`, never evaluated. Pure (bytes, the models.dev
 * table and the observed table in, table out): `scripts/pricing/grok.ts` (a manual refresh) and `gluon pricing update`
 * (`pricing-update.ts`) both call it, so a table is built one way wherever it is built.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { balancedObject } from "./jsliteral.ts";
import { rowProblem } from "./table-schema.ts";
import { GROK_OBSERVED_WINDOWS, type GrokModel, type GrokModelsTable, type GrokObservedWindowsTable, type ModelsDevTable } from "./tables.ts";

/** A price object the way models.dev writes one: numbers only (else it is not a price and is left out). */
function priceObject(v: unknown): GrokModel["cost"] | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of ["input", "output", "cache_read", "cache_write"]) if (typeof o[k] === "number" && Number.isFinite(o[k]) && (o[k] as number) >= 0) out[k] = o[k] as number;
  return typeof out.input === "number" && typeof out.output === "number" ? out : undefined;
}

/** The embedded catalog's JSON text and object inside a binary's bytes, or null: the object whose `models` array holds `{id, context_window}` entries. */
export function defaultModels(bytes: Buffer): { text: string; catalog: { models: Record<string, unknown>[] } } | null {
  const key = Buffer.from('"models"');
  for (let at = bytes.indexOf(key); at >= 0; at = bytes.indexOf(key, at + key.length)) {
    if (!/^\s*:\s*\[/.test(bytes.subarray(at + key.length, at + key.length + 16).toString("latin1"))) continue;
    // The top-level object opens before its keys: the nearest `{` back from `"models"` that makes a catalog. One window is decoded
    // for all of them (a decode per `{` was quadratic on a binary full of braces: BUG-406); `head` is where `"models"` sits in it.
    const start = Math.max(0, at - 4096);
    const head = bytes.subarray(start, at).toString("utf8").length;
    const window = bytes.subarray(start, at + 400_000).toString("utf8");
    for (let open = window.lastIndexOf("{", head); open >= 0; open = open > 0 ? window.lastIndexOf("{", open - 1) : -1) {
      const text = balancedObject(window.slice(open, open + 400_000), 0);
      if (!text || !text.includes('"models"')) continue;
      try {
        const catalog = JSON.parse(text) as { models?: unknown };
        const models = catalog.models;
        if (Array.isArray(models) && models.length && models.every((m) => m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string" && typeof (m as Record<string, unknown>).context_window === "number")) return { text, catalog: catalog as { models: Record<string, unknown>[] } };
      } catch {}
    }
  }
  return null;
}

/**
 * The trimmed table's models: the binary's (window and, if it has one, price), then the xAI models models.dev lists that the binary
 * doesn't: their price is seeded from models.dev, marked; their window never is (models.dev's `limit.context` is not Grok's: BUG-396),
 * it is the observed table's, marked `observed`, else none. A model the binary lists and the observed table still holds
 * takes the binary's window, and `notice` says to remove it from the observed table (BUG-398). A binary model the table would refuse (a window of 5, a price over
 * the bound) is left out and its id pushed to `skipped`, never a reason to refuse every model (BUG-604).
 */
export function trim(catalog: { models: Record<string, unknown>[] }, devEntries: ModelsDevTable["entries"], observed: GrokObservedWindowsTable, notice?: (line: string) => void, skipped?: string[]): Record<string, GrokModel> {
  // A model id comes from a binary and the public catalog: `__proto__` and the like are no model (BUG-371).
  const models: Record<string, GrokModel> = {};
  for (const m of catalog.models) {
    const id = m.id as string;
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id) || id in Object.prototype || !((m.context_window as number) > 0)) continue;
    const cost = priceObject(m.cost) ?? priceObject(m.pricing);
    const threshold = m.auto_compact_threshold_percent;
    const model: GrokModel = { context: Math.round(m.context_window as number), source: "binary", ...(typeof threshold === "number" && threshold > 0 && threshold <= 100 ? { autoCompactPercent: threshold } : {}), ...(cost ? { cost, costSource: "binary" as const } : {}) };
    if (rowProblem("grok-models", id, model)) {
      skipped?.push(id);
      continue;
    }
    models[id] = model;
    if (Object.hasOwn(observed.models, id)) notice?.(`${id} is now in Grok's catalog: remove it from grok-observed-windows.json (the binary's window, ${models[id]!.context}, is used; observed: ${observed.models[id]!.context})`);
  }
  for (const [key, e] of Object.entries(devEntries)) {
    const id = key.startsWith("xai/") ? key.slice(4) : undefined;
    if (!id || id in Object.prototype) continue;
    const have = Object.hasOwn(models, id) ? models[id] : undefined;
    // A binary model without a price of its own gets models.dev's; a model the binary lacks gets its price seeded and the observed window, if any.
    if (have) {
      if (!have.cost && e.cost) models[id] = { ...have, cost: e.cost, costSource: "models.dev-seed" };
    } else {
      const window = Object.hasOwn(observed.models, id) ? observed.models[id]!.context : undefined;
      if (window || e.cost) models[id] = { ...(window ? { context: window, source: "observed" as const } : {}), ...(e.cost ? { cost: e.cost, costSource: "models.dev-seed" as const } : {}) };
    }
  }
  // A model observed but listed by neither the binary nor models.dev still has its window.
  for (const [id, o] of Object.entries(observed.models)) if (!Object.hasOwn(models, id) && !(id in Object.prototype)) models[id] = { context: o.context, source: "observed" };
  return Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** How a file is read in `defaultModelsInFile`: a chunk, and the overlap that keeps a catalog (at most 400 kB after its first key, 4 kB before) whole in one chunk. */
export const SCAN_CHUNK_BYTES = 16 * 1024 * 1024;
export const SCAN_OVERLAP_BYTES = 512 * 1024;

/**
 * `defaultModels` over a file read in overlapping chunks, so a 170 MB binary is never held whole (about one chunk of memory, not three times the file). A catalog
 * lies whole inside some chunk (the overlap is more than its reach), and a window cut off by a chunk's end doesn't parse, so it is found in the next one.
 */
export function defaultModelsInFile(path: string, { chunk = SCAN_CHUNK_BYTES, overlap = SCAN_OVERLAP_BYTES }: { chunk?: number; overlap?: number } = {}): ReturnType<typeof defaultModels> {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(Math.min(Math.max(chunk, overlap * 2), Math.max(size, 1)));
    for (let from = 0; from < size; ) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - from), from);
      if (n <= 0) break;
      const found = defaultModels(buf.subarray(0, n));
      if (found) return found;
      if (from + n >= size) break;
      from += n - overlap;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The table for a binary's embedded catalog (`defaultModels`): throws when there is none. */
export function grokTableFrom(found: ReturnType<typeof defaultModels>, { grokVersion, generatedAt, modelsdev, observed = GROK_OBSERVED_WINDOWS, fetchedAt, notice, skipped }: { grokVersion: string; generatedAt: string; modelsdev?: ModelsDevTable; observed?: GrokObservedWindowsTable; fetchedAt?: string; notice?: (line: string) => void; skipped?: string[] }): GrokModelsTable {
  if (!found) throw new Error("no embedded default_models.json in the grok binary (its layout moved: update src/cost/grok-catalog.ts)");
  return { schema: 1, source: "grok binary default_models.json", grokVersion, generatedAt, digest: createHash("sha256").update(found.text).digest("hex"), ...(fetchedAt ? { fetchedAt } : {}), models: trim(found.catalog, modelsdev?.entries ?? {}, observed, notice, skipped) };
}

/**
 * The table for a binary's bytes: throws when it holds no embedded catalog (its layout moved: the job must fail, not empty the table). `modelsdev`: the table the
 * prices are seeded from (none: no seeded price); `observed`: the observed windows (default: the repository's). `notice` hears what a maintainer should do (`trim`).
 */
export function grokTable(bytes: Buffer, o: Parameters<typeof grokTableFrom>[1]): GrokModelsTable {
  return grokTableFrom(defaultModels(bytes), o);
}

/**
 * A stored Grok table over a new models.dev table, without the binary (reading it again costs a 100 MB read, and only the seeded prices change): the models
 * the binary listed (`source: "binary"`: their window, auto-compact threshold and own price) are put back as the binary's catalog, and `trim` seeds
 * the rest from `modelsdev` as `grokTable` does. The digest then names both (the binary's catalog and the seed's), since the table is a different one.
 */
export function reseedGrok(table: GrokModelsTable, modelsdev: ModelsDevTable, observed: GrokObservedWindowsTable = GROK_OBSERVED_WINDOWS): GrokModelsTable {
  const models = Object.entries(table.models).flatMap(([id, m]) => (m.source === "binary" && m.context ? [{ id, context_window: m.context, ...(m.autoCompactPercent ? { auto_compact_threshold_percent: m.autoCompactPercent } : {}), ...(m.costSource === "binary" && m.cost ? { cost: m.cost } : {}) }] : []));
  const next = trim({ models }, modelsdev.entries, observed);
  if (JSON.stringify(next) === JSON.stringify(table.models)) return table;
  return { ...table, digest: createHash("sha256").update(`${table.digest} ${modelsdev.catalogDigest}`).digest("hex"), models: next };
}
