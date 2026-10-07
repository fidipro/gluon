/**
 * Building the price and window tables on this machine (issue #89): at Gluon's start and at each harness launch, in the background,
 * never awaited (a first screen or a launch never waits for a table), and `gluon pricing update` in the foreground. Nothing ships in the
 * repository: prices come from the network, windows from the user's installed binaries, and both are kept in the local store
 * (`tables-store.ts`) and handed out by the registry (`tables.ts`).
 *
 *  - `refreshNetworkTables`: models.dev's catalog and OpenRouter's listing (+ the endpoints of the models Gluon offers on it), built
 *    as `modelsdev-catalog.ts` builds them; Grok's seeded prices follow models.dev's. Claude's table is never fetched: the installed `claude` is its only source.
 *    One refresh in flight at a time: a second call is the first's promise.
 *  - `refreshBinaryTables(harness, version)`: Codex's windows (`codex debug models`), Grok's (the binary's embedded `default_models.json`) and
 *    Claude's catalog and fast-mode rows (its own and its price function), read from the installed binary only when its version is not the stored table's.
 *  - `refreshOpenRouterRow(id)`: one `openrouter/*` model's price and endpoints, for a launch on it.
 *  - `refreshOnLaunch(...)`: the three of them for a launch, as fire and forget.
 *
 * Failure is silent and keeps the last good stored table, whatever its age: an unreachable source, a size over its cap, an answer that isn't
 * the shape, a table that fails `parseTable` (the shape and bounds validation still refuse a malformed table). A big move (more than 3x, more
 * than 15% of the prices, a model gone) is ACCEPTED and logged in the audit ledger as a `tables` entry (names and numbers only); except a network table that
 * lacks more than half the stored one's models (`MAX_GONE_SHARE`: an outage), which is refused. A malformed row of a source is skipped and named (BUG-604). Tests reach
 * no network: `pricingSource` is null under `NODE_ENV=test`, `GLUON_BUILD=test` and the offline suite's probes seam, unless
 * `GLUON_TEST_PRICING` names a local server (compiled out of release builds, like `GLUON_TEST_OPENROUTER`).
 *
 * Everything outside is injectable (`RefreshDeps`: fetch, spawn, binary path and bytes, clock, directory, registry, ledger), so a unit test runs nothing real.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { binPath, neutralCwd } from "../detect.ts";
import { HARNESS_INFO, type Harness } from "../harnesses.ts";
import { catalogText, claudeTable } from "./claude-catalog.ts";
import { buildTable } from "./codex-catalog.ts";
import { defaultModels, defaultModelsInFile, grokTableFrom, reseedGrok } from "./grok-catalog.ts";
import { defaultSpawn, type SpawnUsage } from "./grok-usage.ts";
import { MAX_SKIPPED_NAMES, MAX_TABLE_PRICES } from "./ledger.ts";
import { applyOpenRouter, buildModelsDevTable, endpointRange, entriesDigest, priceModelsDev, wantedKeys, type Catalog, type EndpointsReply, type Entry, type OpenRouterListing } from "./modelsdev-catalog.ts";
import { changeProblems, parseTable, tableFile, type TableName } from "./table-schema.ts";
import { currentTables, setTables, setTableBuild, versionIn, type ClaudeCatalog, type CodexWindowsTable, type GrokModelsTable, type ModelsDevTable, type Tables } from "./tables.ts";
import { tablesDir, writeStoredTable } from "./tables-store.ts";

// ---- where the network is read ----

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";

/** What each source may be at most: models.dev's catalog is about 5 MB, OpenRouter's listing 0.8 MB, one model's endpoints a few KB. */
export const MAX_BYTES = { modelsDev: 16_000_000, listing: 8_000_000, endpoints: 1_000_000 } as const;
export const FETCH_TIMEOUT_MS = 10_000;
/** models.dev's catalog is big: more time. */
export const MODELS_DEV_TIMEOUT_MS = 40_000;
export const SPAWN_TIMEOUT_MS = 15_000;
/** The most `codex debug models` may print (it is about 0.2 MB). */
const MAX_CODEX_CATALOG_BYTES = 4_000_000;
/** Endpoints requested at once. */
const CONCURRENCY = 6;
/** A table that did not change is written again (its date moves) once its `fetchedAt` is this old: a table checked today is not "stale". */
export const REWRITE_AFTER_MS = 6 * 3_600_000;
/** A launch refreshes the network tables again only when the last success is older than this. */
export const LAUNCH_REFRESH_AFTER_MS = 10 * 60_000;

/** The two network sources: URLs (the second is OpenRouter's API base: `/models`, `/models/<id>/endpoints`). */
export interface PricingSource {
  modelsDev: string;
  openrouter: string;
  /** One request's time, in place of the real ones (tests). */
  timeoutMs?: number;
}

export const REAL_SOURCE: PricingSource = { modelsDev: MODELS_DEV_URL, openrouter: OPENROUTER_API_URL };

declare const GLUON_BUILD: string | undefined;
/** The test seam's file, or undefined (always, in a release build). */
const seamPath = (env: Record<string, string | undefined>): string | undefined => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? undefined : env.GLUON_TEST_PRICING);
/**
 * Whether Gluon may refresh the tables in this run: not in the demo (it makes no network call by design), except a test build that names a local server of its
 * own (`GLUON_TEST_PRICING`, loopback only: a release build has no seam, so the demo there never refreshes).
 */
export const refreshAllowed = (demo: boolean, env: Record<string, string | undefined> = process.env): boolean => !demo || seamPath(env) !== undefined;

/** The offline suite's probes seam, folded away in release builds. */
const probesPath = (env: Record<string, string | undefined>): string | undefined => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? undefined : env.GLUON_TEST_PROBES);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const loopbackUrl = (v: unknown): string | undefined => {
  try {
    const u = new URL(String(v));
    return u.protocol === "http:" && LOOPBACK.has(u.hostname) ? String(v).replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The sources to read, or null: no network at all. The real ones only when nothing says "test": the seam names a server of its own
 * (`GLUON_TEST_PRICING`, a JSON file `{ "base": "http://127.0.0.1:<port>" }`, or per source `modelsDev`, `openrouter`; `timeoutMs`; loopback http only:
 * from `base` the sources are `/api.json` and `/api/v1`); the offline suite (its probes seam is on), a `bun test`
 * process (`NODE_ENV=test`) and a compiled test binary reach none. Fails closed: a test that forgets the seam fetches nothing, and a seam that doesn't read is no network.
 */
export function pricingSource(env: Record<string, string | undefined> = process.env): PricingSource | null {
  const path = seamPath(env);
  if (path) {
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const base = j.base === undefined ? undefined : loopbackUrl(j.base);
      if (j.base !== undefined && !base) return null;
      const modelsDev = loopbackUrl(j.modelsDev ?? (base && `${base}/api.json`));
      const openrouter = loopbackUrl(j.openrouter ?? (base && `${base}/api/v1`));
      const timeoutMs = typeof j.timeoutMs === "number" && j.timeoutMs > 0 && j.timeoutMs <= 60_000 ? j.timeoutMs : undefined;
      if (modelsDev && openrouter) return { modelsDev, openrouter, ...(timeoutMs ? { timeoutMs } : {}) };
    } catch {}
    return null;
  }
  // A release or npm build ignores NODE_ENV (a user's own `NODE_ENV=test` must not switch the refresh off); `bun test` (no GLUON_BUILD) and a test build do honour it.
  const release = typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test";
  if ((typeof GLUON_BUILD === "string" && GLUON_BUILD === "test") || probesPath(env) || (!release && env.NODE_ENV === "test")) return null;
  return REAL_SOURCE;
}

/** Fetches a URL's text; null when it fails, times out, redirects, is not on the expected host or is larger than `maxBytes`. */
export type FetchText = (url: string, o: { timeoutMs: number; maxBytes: number }) => Promise<string | null>;

export const defaultFetch: FetchText = async (url, { timeoutMs, maxBytes }) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // A redirect is an error (`redirect: "error"`): the host named is the host asked.
    // No compression either (`accept-encoding: identity`, and Bun is told not to decode): the size cap counts the bytes on the wire, so a gzip bomb can't fill memory first.
    const res = await fetch(url, { signal: ctl.signal, redirect: "error", headers: { accept: "application/json", "accept-encoding": "identity" }, decompress: false } as RequestInit);
    if (!res.ok || !res.body || new URL(res.url || url).origin !== new URL(url).origin) return null;
    const encoding = (res.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
    if (encoding !== "identity" && encoding !== "") return null;
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) {
        ctl.abort();
        return null;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// ---- what a refresh may be given ----

/** Where the tables are kept in memory: the registry (`tables.ts`). */
export interface Registry {
  get(): Tables;
  set(partial: Tables): void;
}
const REGISTRY: Registry = { get: currentTables, set: setTables };

export interface RefreshDeps {
  /** The sources to read (default `pricingSource()`); null: no network (the refresh is a no-op). */
  source?: PricingSource | null;
  /** Whether binaries may be read and run (default: `pricingSource()` is not null): a test that names `bin` and `spawn` says true. */
  live?: boolean;
  fetchText?: FetchText;
  spawn?: SpawnUsage;
  /** A harness's binary (`binPath`), or undefined. */
  bin?: (harness: Harness) => string | undefined;
  /** The bytes of a binary (links followed). */
  readBinary?: (path: string) => Buffer | Promise<Buffer>;
  now?: () => Date;
  /** The local store (default `tablesDir()`). */
  dir?: string;
  /** Windows: limit the directory to the user with icacls. */
  restrict?: boolean;
  registry?: Registry;
  /** Where a `tables` ledger entry goes (`Ledger.add`). */
  ledger?: (entry: unknown) => void;
  /** Endpoint requests at once. */
  concurrency?: number;
}

interface Ctx {
  src: PricingSource | null;
  live: boolean;
  get: (url: string, maxBytes: number, timeoutMs: number) => Promise<string | null>;
  bin: (h: Harness) => string | undefined;
  run: (bin: string, args: string[]) => Promise<string | null>;
  readBinary: (p: string) => Promise<Buffer>;
  /** Grok's embedded catalog in a binary: found in chunks of the file (never the whole of it in memory), or in the bytes a test injects. */
  grokCatalog: (p: string) => Promise<ReturnType<typeof defaultModels>>;
  now: () => Date;
  dir: string;
  restrict: boolean;
  reg: Registry;
  ledger?: (entry: unknown) => void;
  concurrency: number;
}

function ctxOf(o: RefreshDeps): Ctx {
  const src = o.source !== undefined ? o.source : pricingSource();
  const fetchText = o.fetchText ?? defaultFetch;
  const spawn = o.spawn ?? defaultSpawn;
  return {
    src,
    live: o.live ?? src !== null,
    get: async (url, maxBytes, timeoutMs) => {
      try {
        return await fetchText(url, { timeoutMs: src?.timeoutMs ?? timeoutMs, maxBytes });
      } catch {
        return null;
      }
    },
    bin: o.bin ?? ((h) => binPath(HARNESS_INFO[h].binary)),
    run: (bin, args) => spawn([bin, ...args], { cwd: neutralCwd(), env: { ...process.env, DISABLE_AUTOUPDATER: "1", GROK_DISABLE_AUTOUPDATER: "1" }, timeoutMs: SPAWN_TIMEOUT_MS }).catch(() => null),
    readBinary: async (p) => (o.readBinary ? o.readBinary(p) : Buffer.from(await Bun.file(realpathSync(p)).arrayBuffer())),
    grokCatalog: async (p) => (o.readBinary ? defaultModels(await o.readBinary(p)) : defaultModelsInFile(realpathSync(p))),
    now: o.now ?? (() => new Date()),
    dir: o.dir ?? tablesDir(),
    restrict: o.restrict ?? process.platform === "win32",
    reg: o.registry ?? REGISTRY,
    ...(o.ledger ? { ledger: o.ledger } : {}),
    concurrency: Math.max(1, o.concurrency ?? CONCURRENCY),
  };
}

// ---- what a refresh says ----

export interface TableReport {
  table: TableName;
  /**
   * written: a changed table is stored; current: the stored one is the same; unreachable: a source didn't answer (the stored table stays); refused: what
   * came failed the checks (the stored table stays; the exit code of `gluon pricing update`); unreadable: an installed binary gave no table (its layout moved:
   * the stored table stays, a maintainer's matter, no failure); skipped: not asked for.
   */
  status: "written" | "current" | "unreachable" | "refused" | "unreadable" | "skipped";
  detail: string;
  /** Prices that moved from the stored table. */
  moved: number;
  /** A move the change guard would once have refused (accepted): its reasons, `problems.length > 0` is `big`. */
  problems: string[];
  changes: { key: string; from: number; to: number }[];
  /** Rows (model ids) the source gave that were left out for being malformed (an unknown cost key, a price over the bound, a window of 5): the rest of the table is still built (BUG-604). */
  skipped?: string[];
}

export interface RefreshResult {
  /** Why nothing was asked (no network in a test), or undefined. */
  skipped?: string;
  reports: TableReport[];
  /** Some table was refused (failed its checks or its build): `gluon pricing update` exits 1. */
  failed: boolean;
}

export const NO_NETWORK = "no network here (a test build)";

const report = (table: TableName, status: TableReport["status"], detail: string, extra: Partial<TableReport> = {}): TableReport => ({ table, status, detail, moved: 0, problems: [], changes: [], ...extra });
const result = (reports: TableReport[], skipped?: string): RefreshResult => ({ ...(skipped ? { skipped } : {}), reports, failed: reports.some((r) => r.status === "refused") });
/** Text that may carry what a source sent (a parse error quotes its input): one line, no control character (an ESC, a BEL, a NUL, a Unicode bidi control that reorders what follows), at most 200 characters. */
const plain = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 200);
const firstLine = (e: unknown): string => plain((e instanceof Error ? e.message : String(e)).split("\n")[0]!);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---- committing a table ----

/** The registry key of each table a refresh builds. */
const TABLE_KEY: Partial<Record<TableName, keyof Tables>> = { modelsdev: "modelsdev", "claude-catalog": "claudeCatalog", "codex-windows": "codexWindows", "grok-models": "grokModels" };
type Held = Record<string, any>;
const heldTable = (reg: Registry, name: TableName): Held | undefined => {
  const key = TABLE_KEY[name];
  return key ? (reg.get()[key] as unknown as Held | undefined) : undefined;
};

const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
/** Whether two tables say the same, whenever they were built. */
const sameTable = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const bare = ({ generatedAt: _g, fetchedAt: _f, ...rest }: Record<string, unknown>) => JSON.stringify(canonical(rest));
  return bare(a) === bare(b);
};

type Via = "network" | "binary" | "openrouter-row";

/** A network table that loses more than this share of the stored table's models is an outage (an answer of `{}`), not a repricing: refused, the stored one stays (BUG-605). */
export const MAX_GONE_SHARE = 0.5;
/** The skipped rows a report names (`detail`); the ledger names up to `MAX_SKIPPED_NAMES`. */
const NAMED_SKIPS = 5;


/** A row id that is safe to print: the ledger's own name rule (a source's id may hold an escape sequence, a newline, 5000 characters). */
const NAME = /^[A-Za-z0-9._:/@[\]-]{1,128}$/;
const NAMED_LENGTH = 64;

/** "; N rows skipped as malformed (a, b, and 3 more, 2 with ids that are not plain names)" for the rows a source gave that were left out; "" for none. Only plain ids are named, cut to 64 characters. */
const skippedNote = (skipped: string[]): string => {
  if (!skipped.length) return "";
  const plainIds = skipped.filter((k) => NAME.test(k));
  const shown = plainIds.slice(0, NAMED_SKIPS).map((k) => (k.length > NAMED_LENGTH ? `${k.slice(0, NAMED_LENGTH - 3)}...` : k));
  const parts = [...shown, ...(plainIds.length > shown.length ? [`and ${plainIds.length - shown.length} more`] : []), ...(plainIds.length < skipped.length ? [`${skipped.length - plainIds.length} with ids that are not plain names`] : [])];
  return `; ${skipped.length} row${skipped.length === 1 ? "" : "s"} skipped as malformed (${parts.join(", ")})`;
};

/**
 * Validates and stores a table, then hands it to the registry. Synchronous from reading the stored table to setting the new one, so
 * refreshes that overlap never lose each other's work. `build` gets the stored table (or undefined) and returns the table without its dates;
 * `skipped` is where it says which source rows it left out (read after `build`: said in the report and the ledger).
 */
function commit(d: Ctx, name: TableName, via: Via, build: (held: Held | undefined) => Record<string, unknown>, harness?: Harness, buildFails: "refused" | "unreadable" = "refused", skipped: string[] = []): TableReport {
  const key = TABLE_KEY[name]!;
  try {
    const held = heldTable(d.reg, name);
    const iso = d.now().toISOString();
    let built: Record<string, unknown>;
    try {
      built = build(held);
    } catch (e) {
      return report(name, buildFails, firstLine(e));
    }
    const skips = [...new Set(skipped)].sort();
    const note = skippedNote(skips);
    // The report names only the ids that are safe to print; the count is in `detail` and the ledger.
    const safeSkips = skips.filter((k) => NAME.test(k));
    const extra: Partial<TableReport> = safeSkips.length ? { skipped: safeSkips } : {};
    const table = { ...built, generatedAt: iso, fetchedAt: iso };
    const parsed = parseTable(name, JSON.stringify(table));
    if ("problem" in parsed) return report(name, "refused", plain(parsed.problem), extra);
    const change = changeProblems(name, held, parsed.table);
    // A network table that lost most of the models the stored one had is an outage or a changed catalog, not a repricing: the stored table stays (BUG-605). A repricing is still accepted.
    if (name === "modelsdev" && via === "network" && held) {
      const had = Object.keys((held.entries ?? {}) as object).length;
      if (change.gone.length > had * MAX_GONE_SHARE) return report(name, "refused", `${change.gone.length} of the ${had} stored models are gone from what the sources answered (an outage, not a repricing): the stored table stays. If the change is real, delete ${join(d.dir, tableFile(name))} and run \`gluon pricing update\``, extra);
    }
    // A first table has nothing to move from: the guard's "zero price" of a first table is no big move.
    const problems = held ? change.problems : [];
    const same = held !== undefined && sameTable(held, parsed.table);
    // The same table: written again (its date moves) only once the stored one is old, so a table checked today never reads "stale".
    // A stored date in the future (a clock that was wrong) is old: it would never age (BUG-608).
    const age = held?.fetchedAt ? d.now().getTime() - Date.parse(held.fetchedAt) : NaN;
    if (same && age >= 0 && age < REWRITE_AFTER_MS) return report(name, "current", `the stored table is current${note}`, extra);
    let stored = "";
    try {
      const warning = writeStoredTable(name, table, d.dir, d.restrict);
      if (warning) stored = ` (${warning})`;
    } catch (e) {
      // A directory that can't be written still gives this run the new prices.
      stored = ` (not stored: ${firstLine(e)})`;
    }
    d.reg.set({ [key]: parsed.table } as Tables);
    if (same) return report(name, "current", `the stored table is current${stored}${note}`, extra);
    const sorted = [...change.changes].sort((a, b) => Math.abs(Math.log((b.to || 1e-9) / (b.from || 1e-9))) - Math.abs(Math.log((a.to || 1e-9) / (a.from || 1e-9))));
    try {
      d.ledger?.({
        kind: "tables",
        t: d.now().getTime(),
        ...(harness ? { harness } : {}),
        table: name,
        via,
        digest: String(parsed.table.catalogDigest ?? parsed.table.digest ?? "").slice(0, 16),
        fetchedAt: iso,
        moved: change.changes.length,
        gone: change.gone.length,
        big: problems.length > 0,
        prices: sorted.slice(0, MAX_TABLE_PRICES),
        ...(skips.length ? { skipped: skips.length, skippedNames: safeSkips.slice(0, MAX_SKIPPED_NAMES) } : {}),
      });
    } catch {} // the audit never stops a refresh
    const n = change.changes.length;
    return report(name, "written", `${held ? `${n} price${n === 1 ? "" : "s"} moved` : "a first table"}${change.gone.length ? `, ${change.gone.length} model${change.gone.length === 1 ? "" : "s"} gone` : ""}${stored}${note}`, { moved: n, problems, changes: change.changes, ...extra });
  } catch (e) {
    return report(name, "refused", firstLine(e));
  }
}

// ---- the network tables ----

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

/** An OpenRouter model id as a path piece (`vendor/model`): nothing that could name another URL. */
const OR_ID = /^[\w.:@~-]+\/[\w.:@~-]+$/;

async function modelsDevTables(d: Ctx, src: PricingSource): Promise<TableReport[]> {
  const [md, or] = await Promise.all([d.get(src.modelsDev, MAX_BYTES.modelsDev, MODELS_DEV_TIMEOUT_MS), d.get(`${src.openrouter}/models`, MAX_BYTES.listing, FETCH_TIMEOUT_MS)]);
  // models.dev is the table's base: without it nothing is built. OpenRouter's listing only prices the `openrouter/*` rows: without it the table is built without them (BUG-607).
  if (md === null) return [report("modelsdev", "unreachable", "models.dev didn't answer")];
  let catalog: Catalog;
  let listing: OpenRouterListing | null;
  let orIds: string[];
  let skipped: string[];
  try {
    const c = JSON.parse(md) as unknown;
    const l = or === null ? null : (JSON.parse(or) as unknown);
    if (!isObj(c) || (l !== null && !isObj(l))) throw new Error("not a catalog");
    catalog = c as Catalog;
    listing = l as OpenRouterListing | null;
    ({ orIds, skipped } = priceModelsDev(catalog, listing));
  } catch (e) {
    return [report("modelsdev", "refused", `models.dev or OpenRouter's listing isn't the shape expected (${firstLine(e)})`)];
  }
  const replies: Record<string, EndpointsReply> = {};
  const failed = new Set<string>();
  await pool(orIds.filter((id) => OR_ID.test(id)), d.concurrency, async (id) => {
    const text = await d.get(`${src.openrouter}/models/${id}/endpoints`, MAX_BYTES.endpoints, FETCH_TIMEOUT_MS);
    try {
      if (text === null) throw new Error("no answer");
      replies[id] = JSON.parse(text) as EndpointsReply;
    } catch {
      failed.add(id);
    }
  });
  // The oldest day a kept `openrouter/*` row was last priced by OpenRouter (set while building, read for the report).
  let staleSince: string | undefined;
  const out = [
    commit(d, "modelsdev", "network", (held) => {
      const iso = d.now().toISOString();
      const table = buildModelsDevTable({ catalog, openrouterListing: listing, endpoints: replies, generatedAt: iso, fetchedAt: iso }) as unknown as ModelsDevTable;
      // A model whose endpoints didn't answer keeps the range the stored table had.
      for (const id of failed) {
        const key = `openrouter/${id}`;
        const old = held?.entries?.[key]?.endpoints;
        if (old && table.entries[key]) table.entries[key] = { ...table.entries[key]!, endpoints: old };
      }
      // OpenRouter's listing didn't answer: the `openrouter/*` rows OpenRouter itself priced before stay as they were (never models.dev's, BUG-469); with no stored table there are none.
      let kept = 0;
      if (listing === null)
        for (const [key, row] of Object.entries((held?.entries ?? {}) as Record<string, Entry>))
          if (key.startsWith("openrouter/") && row.priceSource === "openrouter") {
            // A kept row says since when OpenRouter did not price it (the stored table's own date the first time, its own `staleSince` after): it never looks freshly fetched.
            const since = row.staleSince ?? (typeof held?.fetchedAt === "string" ? held.fetchedAt : iso);
            if (!staleSince || since < staleSince) staleSince = since;
            table.entries[key] = { ...row, staleSince: since } as unknown as (typeof table.entries)[string];
            table.missing = table.missing.filter((k) => k !== key);
            kept++;
          }
      if (kept) table.entries = Object.fromEntries(Object.entries(table.entries).sort(([a], [b]) => (a < b ? -1 : 1)));
      if (failed.size || kept) table.catalogDigest = entriesDigest(table.entries as unknown as Record<string, Entry>);
      return table as unknown as Record<string, unknown>;
    }, undefined, "refused", skipped),
  ];
  // Said once, on what was written: OpenRouter's own prices could not be refreshed this time.
  if (listing === null && out[0]!.status !== "refused") out[0] = { ...out[0]!, detail: `${out[0]!.detail}; OpenRouter's listing didn't answer, its openrouter/* prices were not refreshed${staleSince ? ` since ${staleSince.slice(0, 10)}` : ""}` };
  // Grok's seeded prices are models.dev's: its table follows without reading the binary again.
  const modelsdev = d.reg.get().modelsdev;
  if (out[0]!.status !== "refused" && d.reg.get().grokModels && modelsdev) out.push(commit(d, "grok-models", "network", (held) => reseedGrok(held as unknown as GrokModelsTable, modelsdev) as unknown as Record<string, unknown>));
  return out;
}

let inFlight: Promise<RefreshResult> | undefined;
/** The OpenRouter row refreshes running (`refreshOpenRouterRow`): a network refresh waits for them, and they wait for a network one that is running. */
const rowsInFlight = new Set<Promise<unknown>>();
let lastSuccess = 0;

/** Whether no network refresh is running and the last that worked is older than `maxAgeMs` (none yet in this process: due). */
export const networkRefreshDue = (maxAgeMs = LAUNCH_REFRESH_AFTER_MS, now = Date.now()): boolean => !inFlight && now - lastSuccess > maxAgeMs;
/** Whether a network refresh is running. */
export const networkRefreshRunning = (): boolean => inFlight !== undefined;

/** Refreshes the prices from the network; never throws. One at a time: a call while one is running is that one's promise. */
export function refreshNetworkTables(deps: RefreshDeps = {}): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  const run = (async (): Promise<RefreshResult> => {
    const d = ctxOf(deps);
    if (!d.src) return result([], NO_NETWORK);
    // A row refresh already running finishes first: what this one reads is then newer than the row it would overwrite (never the other way: `refreshOpenRouterRow` waits for this one).
    while (rowsInFlight.size) await Promise.allSettled([...rowsInFlight]);
    const src = d.src;
    const reports = await modelsDevTables(d, src).catch((e) => [report("modelsdev", "refused", firstLine(e))]);
    if (reports.some((r) => r.status === "written" || r.status === "current")) lastSuccess = d.now().getTime();
    return result(reports);
  })().catch((e) => result([report("modelsdev", "refused", firstLine(e))]));
  inFlight = run.finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

// ---- the binary tables ----

/** The table each harness with a binary builds. */
const BINARY_TABLE: Partial<Record<Harness, TableName>> = { "claude-code": "claude-catalog", codex: "codex-windows", "grok-build": "grok-models" };
/** The version a binary's `--version` line holds (`versionOf`'s rule), or undefined. */
export { versionIn };
const versionOfTable = (t: Held | undefined): string | undefined => t?.claudeCodeVersion ?? t?.codexVersion ?? t?.grokVersion;
/** A binary version that failed to build in this process: not tried again until Gluon restarts (reading a binary is not free). */
const failedBuilds = new Set<string>();

/**
 * The table of `harness` from its installed binary, unless the stored table is from `version` already. Claude's is its baked-in
 * catalog and the fast-mode rows of its price function; Codex's `codex debug models`; Grok's the embedded `default_models.json`.
 * Binaries are found by `binPath`, run in `neutralCwd()` with a timeout and `killTree` (`defaultSpawn`), read as bytes. Never throws.
 */
export async function refreshBinaryTables(harness: Harness, version: string | null | undefined, deps: RefreshDeps = {}): Promise<RefreshResult> {
  const name = BINARY_TABLE[harness];
  if (!name) return result([], `${harness} has no table built from its binary`);
  const d = ctxOf(deps);
  if (!d.live) return result([], NO_NETWORK);
  const key = TABLE_KEY[name]!;
  // A table that can't be built here (no version, no binary, a build that failed before) is said so at once: a session waiting on it stops waiting (`CostTracker`).
  const cannot = (why: string) => {
    setTableBuild(key, "failed");
    return result([report(name, "skipped", why)]);
  };
  let building = false;
  try {
    const v = versionIn(version);
    if (!v) return cannot("the harness's version is unknown");
    if (versionOfTable(heldTable(d.reg, name)) === v) return result([report(name, "skipped", `the stored table is from ${v} already`)]);
    const tried = `${harness} ${v}`;
    if (failedBuilds.has(tried)) return cannot(`${v} was tried and failed in this run`);
    const bin = d.bin(harness);
    if (!bin) return cannot(`${HARNESS_INFO[harness].label} is not installed`);
    // From here to the end a session whose table is older than this harness waits for this one (set before the first await).
    setTableBuild(key, "building");
    building = true;
    let r: TableReport;
    if (harness === "codex") {
      const catalog = await d.run(bin, ["debug", "models"]);
      if (!catalog || catalog.length > MAX_CODEX_CATALOG_BYTES) r = report(name, "unreadable", "`codex debug models` printed nothing usable");
      else r = commit(d, name, "binary", () => buildTable(catalog, { codexVersion: v, generatedAt: d.now().toISOString() }) as unknown as Record<string, unknown>, harness, "unreadable");
    } else if (harness === "grok-build") {
      const found = await d.grokCatalog(bin);
      const skipped: string[] = [];
      r = commit(d, name, "binary", () => grokTableFrom(found, { grokVersion: v, generatedAt: d.now().toISOString(), modelsdev: d.reg.get().modelsdev, skipped }) as unknown as Record<string, unknown>, harness, "unreadable", skipped);
    } else {
      const bytes = await d.readBinary(bin);
      r = commit(
        d,
        name,
        "binary",
        () => {
          // Claude Code's own catalog and price function, read from the installed binary (it updates often): the whole table is rebuilt for a new version.
          const text = catalogText(bytes);
          if (!text) throw new Error(`no model catalog found in ${bin}`);
          return claudeTable(text, { version: v, bytes }) as unknown as Record<string, unknown>;
        },
        harness,
        "unreadable",
      );
    }
    const bad = r.status === "refused" || r.status === "unreadable";
    if (bad) failedBuilds.add(tried);
    setTableBuild(key, bad ? "failed" : "done");
    building = false;
    return result([r]);
  } catch (e) {
    if (building) setTableBuild(key, "failed");
    return result([report(name, "unreadable", firstLine(e))]);
  }
}

/** Whether `harness` is installed and the version its `--version` says (asked in `neutralCwd()`, with a timeout); `gluon pricing update` asks, a launch already knows. */
export async function installedVersion(harness: Harness, deps: RefreshDeps = {}): Promise<{ installed: boolean; version?: string }> {
  const d = ctxOf(deps);
  const bin = d.bin(harness);
  if (!bin) return { installed: false };
  const version = versionIn(await d.run(bin, ["--version"]));
  return { installed: true, ...(version ? { version } : {}) };
}

// ---- one OpenRouter model ----

/** A stored OpenRouter-priced row as models.dev priced it: OpenRouter's fields put back to models.dev's where they differed (`modelsdevCost`). */
function asModelsDevRow(row: Entry): Entry {
  const { modelsdevCost, priceSource: _from, staleSince: _stale, ...rest } = row;
  return { ...rest, cost: { ...(row.cost as Record<string, unknown>), ...modelsdevCost } };
}

/**
 * One `openrouter/*` model's row (a launch on it): its price from OpenRouter's listing and its endpoints, put on the stored models.dev table in place of
 * the row it had, nothing else of the table touched. No stored table yet: nothing (the network refresh builds the whole). Never throws.
 */
export async function refreshOpenRouterRow(id: string, deps: RefreshDeps = {}): Promise<RefreshResult> {
  // Serialized with the network refresh: a refresh built from older data never lands over a newer row. Waits for one that is running, then runs.
  while (inFlight) await inFlight.catch(() => {});
  const run = openRouterRow(id, deps);
  rowsInFlight.add(run);
  try {
    return await run;
  } finally {
    rowsInFlight.delete(run);
  }
}

async function openRouterRow(id: string, deps: RefreshDeps): Promise<RefreshResult> {
  const d = ctxOf(deps);
  const model = id.replace(/^openrouter\//, "");
  try {
    if (!d.src) return result([], NO_NETWORK);
    if (!OR_ID.test(model)) return result([report("modelsdev", "skipped", "not an OpenRouter model id")]);
    if (!d.reg.get().modelsdev) return result([report("modelsdev", "skipped", "no models.dev table yet: the network refresh builds it")]);
    const [list, eps] = await Promise.all([d.get(`${d.src.openrouter}/models`, MAX_BYTES.listing, FETCH_TIMEOUT_MS), d.get(`${d.src.openrouter}/models/${model}/endpoints`, MAX_BYTES.endpoints, FETCH_TIMEOUT_MS)]);
    if (list === null) return result([report("modelsdev", "unreachable", "OpenRouter's listing didn't answer")]);
    let listing: OpenRouterListing;
    let range: Entry["endpoints"];
    try {
      const parsed = JSON.parse(list) as unknown;
      if (!isObj(parsed)) throw new Error("not a listing");
      listing = parsed as OpenRouterListing;
    } catch (e) {
      return result([report("modelsdev", "refused", `OpenRouter's listing isn't the shape expected (${firstLine(e)})`)]);
    }
    try {
      range = eps === null ? undefined : endpointRange(JSON.parse(eps) as EndpointsReply);
    } catch {
      range = undefined;
    }
    const key = `openrouter/${model}`;
    return result([
      commit(d, "modelsdev", "openrouter-row", (held) => {
        if (!held) throw new Error("no models.dev table");
        const entries = held.entries as Record<string, Entry>;
        const old = entries[key];
        const priced = applyOpenRouter(old ? { [key]: asModelsDevRow(old) } : {}, old ? [] : [key], listing, new Set([key]));
        const row = priced.entries[key];
        // OpenRouter doesn't list it (the row is models.dev's, as it was): the table as it was.
        if (!row || row.priceSource !== "openrouter") return held;
        const next = { ...entries, [key]: range ? { ...row, endpoints: range } : row };
        const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)));
        return { ...held, entries: sorted, missing: (held.missing as string[]).filter((k) => k !== key), catalogDigest: entriesDigest(sorted) };
      }),
    ]);
  } catch (e) {
    return result([report("modelsdev", "refused", firstLine(e))]);
  }
}

// ---- a launch ----

/**
 * What a harness launch refreshes, in the background and never awaited (the launch must not wait for a table): the harness's binary tables when its
 * version is new; the network tables again when none is running and the last success is more than `LAUNCH_REFRESH_AFTER_MS` old; for an
 * `openrouter/*` launch, that model's row (unless a network refresh covers it). Returns at once.
 */
export function refreshOnLaunch(o: { harness: Harness; version: string | null | undefined; openrouterKey?: string; deps?: RefreshDeps }): void {
  const deps = o.deps ?? {};
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  quiet(refreshBinaryTables(o.harness, o.version, deps));
  // A refresh already running covers the model's row too.
  if (networkRefreshRunning()) return;
  if (networkRefreshDue(LAUNCH_REFRESH_AFTER_MS, deps.now ? deps.now().getTime() : Date.now())) quiet(refreshNetworkTables(deps));
  else if (o.openrouterKey) quiet(refreshOpenRouterRow(o.openrouterKey, deps));
}
