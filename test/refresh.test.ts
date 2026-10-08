/**
 * The tables Gluon builds on the user's machine (issue #89, `src/cost/refresh.ts`): the network refresh, the binary tables, one OpenRouter row, what a
 * launch starts, the seam, and the ledger's `tables` entry. Offline: the fetch and the spawn are injected, or a local server stands in for the sources
 * (`test/fixtures/pricing-sources.ts`); nothing real is reached.
 */
import { SLOW } from "./fixtures/slow.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTable } from "../src/cost/claude-catalog.ts";
import { Ledger, sanitize } from "../src/cost/ledger.ts";
import { select, wantedKeys } from "../src/cost/modelsdev-catalog.ts";
import { openLedgerFile, readLedger } from "../src/cost/ledger-file.ts";
import { pricingUpdate } from "../src/cost/pricing-update.ts";
import { pricingSource, refreshBinaryTables, refreshNetworkTables, refreshOnLaunch, refreshOpenRouterRow, REAL_SOURCE, type RefreshDeps, type Registry } from "../src/cost/refresh.ts";
import type { Tables } from "../src/cost/tables.ts";
import { readStoredTable, writeStoredTable } from "../src/cost/tables-store.ts";
import { FIXTURE_TABLES } from "./fixtures/fixture-tables.ts";
import { seedTables } from "./fixtures/seed-tables.ts";
import { addClaudeModel, claudeCatalogLiteral, claudeFastFunction, fixtureSources, modelsDevCatalog, openRouterListing, servePricing, urlsFor, type Sources } from "./fixtures/pricing-sources.ts";

const ROOT = join(import.meta.dir, "..");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const scratches: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "gluon-refresh-"));
  scratches.push(d);
  return d;
};
afterEach(() => {
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A registry of its own over a store seeded with the fixture tables (or empty): what a refresh reads and replaces. */
function world(o: { seed?: boolean; now?: string } = {}) {
  const root = scratch();
  const dir = join(root, "state", "gluon", "tables");
  if (o.seed !== false) seedTables(dir);
  let tables: Tables = {};
  if (o.seed !== false)
    tables = { modelsdev: readStoredTable("modelsdev", dir)!, claudeCatalog: readStoredTable("claude-catalog", dir)!, codexWindows: readStoredTable("codex-windows", dir)!, grokModels: readStoredTable("grok-models", dir)! };
  const registry: Registry = {
    get: () => tables,
    set: (p) => {
      tables = { ...tables, ...p };
    },
  };
  const ledger: unknown[] = [];
  let clock = Date.parse(o.now ?? "2026-10-06T12:00:00Z");
  const deps: RefreshDeps = { dir, registry, ledger: (e) => ledger.push(e), now: () => new Date(clock), restrict: false };
  return { root, dir, registry, deps, ledger, tables: () => tables, advance: (ms: number) => void (clock += ms), file: (n: string) => join(dir, `${n}.json`) };
}

/** The stored files' bytes, by name: what "untouched" means. */
const stored = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));

/** A fetch that answers from `Sources` (no server) and counts what it was asked. */
function fakeFetch(sources: Sources = fixtureSources()) {
  const asked: string[] = [];
  const fetchText: RefreshDeps["fetchText"] = async (url) => {
    asked.push(url);
    const u = new URL(url);
    if (u.pathname === "/api.json") return sources.modelsDev();
    if (u.pathname === "/api/v1/models") return sources.listing();
    const m = u.pathname.match(/^\/api\/v1\/models\/(.+)\/endpoints$/);
    return m ? sources.endpoints(m[1]!) : null;
  };
  return { fetchText, asked };
}
const SRC = urlsFor("http://127.0.0.1:1");

const FAST = claudeFastFunction;
/** A Claude Code binary's bytes: the price function and the baked-in catalog literal (`catalogText` finds it). */
const claudeBytes = (fast: string, mutate: (c: Record<string, any>) => void = addClaudeModel) => Buffer.from(`\0\0${fast}\0var usr=${claudeCatalogLiteral(mutate)};\0`);



describe("BUG-500/fails-closed: under a test the tables reach no network and run no binary, unless a test names a server of its own", () => {
  test("with no seam, nothing is fetched or spawned: the refreshes are no-ops that say so", async () => {
    const w = world();
    const before = stored(w.dir);
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched++;
      throw new Error("no network in a test");
    }) as unknown as typeof fetch;
    const spawned: string[][] = [];
    try {
      // `bun test` sets NODE_ENV=test: `pricingSource()` is null, so none of these asks for a source.
      expect(pricingSource()).toBeNull();
      const deps: RefreshDeps = { ...w.deps, spawn: async (argv) => (spawned.push(argv), "9.9.9"), bin: () => "/bin/x", readBinary: () => Buffer.alloc(0) };
      const net = await refreshNetworkTables(deps);
      expect([net.skipped, net.reports, net.failed]).toEqual([expect.stringContaining("no network"), [], false]);
      expect((await refreshOpenRouterRow("openrouter/anthropic/claude-haiku-4.5", deps)).skipped).toContain("no network");
      expect((await refreshBinaryTables("codex", "9.9.9", deps)).skipped).toContain("no network");
      refreshOnLaunch({ harness: "grok-build", version: "9.9.9", openrouterKey: "openrouter/anthropic/claude-haiku-4.5", deps });
      await refreshNetworkTables(deps);
      expect(await pricingUpdate({ ...deps, log: () => {}, error: () => {} })).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect([fetched, spawned]).toEqual([0, []]);
    expect(stored(w.dir)).toEqual(before);
  });

  test("pricingSource: the seam names the server (loopback http only); a test build, the probes seam and NODE_ENV=test have none; a seam that doesn't read is no network", () => {
    const dir = scratch();
    const seam = (body: unknown) => {
      const f = join(dir, `seam-${Math.random()}.json`);
      writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
      return f;
    };
    // Outside a test the real sources.
    expect(pricingSource({})).toEqual(REAL_SOURCE);
    expect(REAL_SOURCE).toEqual({ modelsDev: "https://models.dev/api.json", openrouter: "https://openrouter.ai/api/v1" });
    for (const env of [{ NODE_ENV: "test" }, { GLUON_TEST_PROBES: "/x" }]) expect(pricingSource(env)).toBeNull();
    // A seam names its own server: `base` derives both, each can be named, the time can be shortened.
    expect(pricingSource({ NODE_ENV: "test", GLUON_TEST_PRICING: seam({ base: "http://127.0.0.1:4567/", timeoutMs: 500 }) })).toEqual({ modelsDev: "http://127.0.0.1:4567/api.json", openrouter: "http://127.0.0.1:4567/api/v1", timeoutMs: 500 });
    expect(pricingSource({ GLUON_TEST_PROBES: "/x", GLUON_TEST_PRICING: seam({ modelsDev: "http://localhost:1/a", openrouter: "http://[::1]:1/b" }) })).toEqual({ modelsDev: "http://localhost:1/a", openrouter: "http://[::1]:1/b" });
    // Anything else is no network: another host, https, a file that isn't one, a missing one, a source left out.
    for (const bad of [{ base: "http://example.com" }, { base: "https://127.0.0.1:1" }, { base: "http://127.0.0.1:1", modelsDev: "https://models.dev/api.json" }, { modelsDev: "http://127.0.0.1:1/a" }, "not json"]) expect(pricingSource({ GLUON_TEST_PRICING: seam(bad) })).toBeNull();
    expect(pricingSource({ GLUON_TEST_PRICING: join(dir, "missing.json") })).toBeNull();
  });

  test("the seam is compiled out of a release build (the file is not in the bundle) and kept in a test build; the pack and dist checks name it", async () => {
    const build = async (flavor: string) => {
      const r = await Bun.build({ entrypoints: [join(ROOT, "src/cost/refresh.ts")], target: "bun", minify: true, define: { GLUON_BUILD: JSON.stringify(flavor), "process.env.NODE_ENV": JSON.stringify("production") } });
      expect(r.success).toBe(true);
      return (await Promise.all(r.outputs.map((o) => o.text()))).join("\n");
    };
    expect(await build("release")).not.toContain("GLUON_TEST_PRICING");
    expect(await build("npm")).not.toContain("GLUON_TEST_PRICING");
    expect(await build("test")).toContain("GLUON_TEST_PRICING");
    expect(readFileSync(join(ROOT, "scripts/pack.ts"), "utf8")).toContain('text.includes("GLUON_TEST_PRICING")');
    expect(readFileSync(join(ROOT, "test/dist.test.ts"), "utf8")).toContain('"GLUON_TEST_PRICING"');
  });
});

describe("BUG-501/offline: a source that doesn't answer keeps the last good table, whatever its age", () => {
  test("no answer, a 404 or a throwing fetch: nothing written, the registry and the files are as they were, nothing is logged", async () => {
    const w = world();
    const before = stored(w.dir);
    const was = w.tables();
    for (const fetchText of [async () => null, async () => Promise.reject(new Error("offline")), fakeFetch({ ...fixtureSources(), modelsDev: () => null }).fetchText]) {
      const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText });
      expect(r.failed).toBe(false);
      expect(r.reports.map((x) => [x.table, x.status])).toEqual([["modelsdev", "unreachable"]]);
    }
    expect(stored(w.dir)).toEqual(before);
    expect(w.tables()).toBe(was);
    expect(w.ledger).toEqual([]);
  });

  test("an answer over its size cap or after a redirect is no answer (the real fetch, a local server)", async () => {
    const w = world();
    const before = stored(w.dir)["modelsdev.json"];
    const big = servePricing({ ...fixtureSources(), modelsDev: () => "x".repeat(16_100_000) });
    const redirecting = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/api.json" ? Response.redirect(`http://127.0.0.1:${big.server.port}/api.json`, 302) : new Response("{}", { status: 404 })) });
    try {
      const over = await refreshNetworkTables({ ...w.deps, source: urlsFor(big.base) });
      expect(over.reports.find((r) => r.table === "modelsdev")).toMatchObject({ status: "unreachable" });
      const redirected = await refreshNetworkTables({ ...w.deps, source: urlsFor(`http://127.0.0.1:${redirecting.port}`) });
      expect(redirected.reports.find((r) => r.table === "modelsdev")).toMatchObject({ status: "unreachable" });
    } finally {
      big.stop();
      redirecting.stop(true);
    }
    expect(stored(w.dir)["modelsdev.json"]).toEqual(before);
  });

  test("with no stored table at all, a failed refresh leaves none (the first run offline: no price, no window)", async () => {
    const w = world({ seed: false });
    await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: async () => null });
    expect([existsSync(w.dir), w.tables()]).toEqual([false, {}]);
  });
});

describe("BUG-502/malformed: a source whose answer is not what was expected is refused, and the store is left as it is", () => {
  test("models.dev and OpenRouter's listing: not JSON, not an object, no models: refused, the stored table is as it was", async () => {
    const cases: [string, Partial<Sources>][] = [
      ["models.dev is not JSON", { modelsDev: () => "<html>" }],
      ["models.dev is an array", { modelsDev: () => "[]" }],
      ["OpenRouter's listing has no models (an error body)", { listing: () => JSON.stringify({ error: "rate limited" }) }],
      ["OpenRouter's listing is empty", { listing: () => JSON.stringify({ data: [] }) }],
    ];
    for (const [why, patch] of cases) {
      const w = world();
      const before = stored(w.dir);
      const was = w.tables();
      const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), ...patch }).fetchText });
      expect([why, r.failed, r.reports.find((x) => x.table === "modelsdev")?.status]).toEqual([why, true, "refused"]);
      expect([why, stored(w.dir)]).toEqual([why, before]);
      expect([why, w.tables().modelsdev]).toEqual([why, was.modelsdev]);
    }
  });

  test("a table that fails the schema is refused however small its change; `gluon pricing update` exits 1 and names it", async () => {
    const w = world();
    const out: string[] = [];
    const err: string[] = [];
    const before = stored(w.dir)["modelsdev.json"];
    const code = await pricingUpdate({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), listing: () => JSON.stringify({ data: [] }) }).fetchText, bin: () => undefined, log: (l) => out.push(l), error: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("modelsdev: refused");
    expect(stored(w.dir)["modelsdev.json"]).toBe(before);
  });
});

describe("BUG-503/big-move: a big move is accepted and logged in the audit ledger, never refused", () => {
  test("every Claude tier x10 and a model gone, read from the binary: written, said, and one `tables` entry names the largest moves", async () => {
    const w = world();
    const gone = FIXTURE_TABLES["claude-catalog"].models[0]!.id;
    const x10 = (c: Record<string, any>) => {
      for (const t of Object.values<any>(c.pricing_tiers)) t.input *= 10;
      c.models = c.models.filter((m: { id: string }) => m.id !== gone);
    };
    const rows = clone(FIXTURE_TABLES["claude-catalog"].fastPricing!);
    const r = await refreshBinaryTables("claude-code", "3.0.0", { ...w.deps, live: true, bin: () => "/opt/claude", readBinary: () => claudeBytes(FAST(rows), x10) });
    const report = r.reports.find((x) => x.table === "claude-catalog")!;
    expect([r.failed, report.status]).toEqual([false, "written"]);
    expect(report.problems.join("\n")).toContain(`model ${gone} disappeared`);
    expect(report.problems.join("\n")).toMatch(/moved more than 3x/);
    expect(report.moved).toBeGreaterThan(0);
    // Stored and in the registry.
    expect(w.tables().claudeCatalog!.models.map((m) => m.id)).not.toContain(gone);
    expect(readStoredTable<{ models: { id: string }[] }>("claude-catalog", w.dir)!.models.map((m) => m.id)).not.toContain(gone);
    // The ledger entry: names and numbers only, through the real ledger's whitelist.
    const ledger = new Ledger();
    for (const e of w.ledger) ledger.add(e);
    const entry = ledger.entries.find((e) => e.kind === "tables" && e.table === "claude-catalog");
    expect(entry).toMatchObject({ kind: "tables", table: "claude-catalog", via: "binary", harness: "claude-code", big: true, gone: 1, fetchedAt: "2026-10-06T12:00:00.000Z" });
    const e = entry as Extract<typeof entry, { kind: "tables" }>;
    expect(e.moved).toBe(report.moved);
    expect(e.digest).toBe(w.tables().claudeCatalog!.catalogDigest.slice(0, 16));
    expect(e.prices.length).toBeGreaterThan(0);
    expect(e.prices.length).toBeLessThanOrEqual(20);
    expect(e.prices[0]).toEqual({ key: expect.stringMatching(/\.input$/), from: expect.any(Number), to: expect.any(Number) });
    expect(e.prices[0]!.to / e.prices[0]!.from).toBeCloseTo(10);
  });

  test("the entry reaches the ledger file (private, one line) and reads back; a first table is no big move; a refresh that changes nothing logs nothing", async () => {
    const w = world({ seed: false });
    const ledgerDir = join(w.root, "audit");
    const write = openLedgerFile(ledgerDir, { restrict: false })!;
    const ledger = new Ledger(write);
    const deps: RefreshDeps = { ...w.deps, source: SRC, fetchText: fakeFetch().fetchText, ledger: (e) => ledger.add(e) };
    await refreshNetworkTables(deps);
    write.close();
    const entries = readLedger(ledgerDir);
    expect(entries.filter((e) => e.kind === "tables").map((e) => [(e as { table: string }).table, (e as { big: boolean }).big, (e as { moved: number }).moved]).sort()).toEqual([["modelsdev", false, 0]]);
    if (process.platform !== "win32") expect(lstatSync(ledgerDir).mode & 0o777).toBe(0o700);
    // The same sources again: the tables are current, no entry.
    const w2 = world({ seed: false });
    const again = { ...w2.deps, source: SRC, fetchText: fakeFetch().fetchText };
    await refreshNetworkTables(again);
    w2.ledger.length = 0;
    w2.advance(60_000);
    const second = await refreshNetworkTables(again);
    expect(second.reports.map((r) => r.status)).toEqual(["current"]);
    expect(w2.ledger).toEqual([]);
  });

  test("sanitize keeps a `tables` entry to its whitelist: a table and way Gluon knows, a digest prefix, a moment, bounded prices named by an id", () => {
    const good = { kind: "tables", t: 1_000, table: "modelsdev", via: "openrouter-row", digest: "ab12", fetchedAt: "2026-10-06T12:00:00.000Z", moved: 2, gone: 0, big: false, prices: [{ key: "openrouter/a/b.cost.input", from: 1, to: 2.5 }], harness: "claude-code" };
    expect(sanitize(good)).toEqual(good as never);
    const { harness: _h, ...none } = good;
    expect(sanitize(none)).toEqual(none as never);
    expect(sanitize({ ...good, harness: "someone" })).toEqual(none as never);
    for (const bad of [{ table: "secrets" }, { via: "ssh" }, { digest: "xyz" }, { fetchedAt: "yesterday" }, { moved: -1 }, { moved: "many" }]) expect(sanitize({ ...good, ...bad })).toBeNull();
    const dirty = sanitize({ ...good, extra: "free text", prices: [...Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, from: 1, to: 2 })), { key: "has space", from: 1, to: 2 }, { key: "ok", from: "1", to: 2 }, { key: "/path/../x y", from: 1, to: 2 }] }) as unknown as { prices: unknown[] } & Record<string, unknown>;
    expect(dirty.extra).toBeUndefined();
    expect(dirty.prices).toHaveLength(20);
    // BUG-604: skipped rows are a count and names (bounded, each an id); nothing when none.
    const skipped = sanitize({ ...good, skipped: 25, skippedNames: [...Array.from({ length: 25 }, (_, i) => `anthropic/m${i}`), "has space", 5] }) as unknown as { skipped: number; skippedNames: string[] };
    expect([skipped.skipped, skipped.skippedNames.length, skipped.skippedNames[0]]).toEqual([25, 20, "anthropic/m0"]);
    expect(sanitize({ ...good, skipped: 0, skippedNames: ["a/b"] })).toEqual(good as never);
  });
});

describe("BUG-504/dedupe: one network refresh at a time", () => {
  test("a second call while one runs is the same promise, and each source is asked once", async () => {
    const w = world();
    const f = fakeFetch();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: RefreshDeps["fetchText"] = async (url, o) => (await gate, f.fetchText!(url, o));
    const deps = { ...w.deps, source: SRC, fetchText: slow };
    const a = refreshNetworkTables(deps);
    const b = refreshNetworkTables(deps);
    expect(b).toBe(a);
    release();
    await a;
    expect(f.asked.filter((u) => u.endsWith("/api.json"))).toHaveLength(1);
    expect(f.asked.filter((u) => u.endsWith("/api/v1/models"))).toHaveLength(1);
    // Once it has finished, a call is a new refresh.
    expect(refreshNetworkTables(deps)).not.toBe(a);
    await refreshNetworkTables(deps);
    expect(f.asked.filter((u) => u.endsWith("/api.json"))).toHaveLength(2);
  });

  test("the endpoints of the models Gluon offers on OpenRouter are asked a few at a time, a failed one keeps the stored range, a 404 model none", async () => {
    const w = world();
    const f = fakeFetch();
    const wantedIds = Object.entries(FIXTURE_TABLES.modelsdev.entries).filter(([k, e]) => k.startsWith("openrouter/") && e.endpoints).map(([k]) => k.slice(11));
    const failing = wantedIds[0]!;
    let live = 0;
    let peak = 0;
    const fetchText: RefreshDeps["fetchText"] = async (url, o) => {
      if (url.endsWith("/endpoints")) {
        live++;
        peak = Math.max(peak, live);
        await Bun.sleep(2);
        live--;
        if (url.includes(`/${failing}/`)) return null;
      }
      return f.fetchText!(url, o);
    };
    await refreshNetworkTables({ ...w.deps, source: SRC, fetchText, concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(w.tables().modelsdev!.entries[`openrouter/${failing}`]!.endpoints).toEqual(FIXTURE_TABLES.modelsdev.entries[`openrouter/${failing}`]!.endpoints);
    // The digest follows the entries as they were kept.
    expect(w.tables().modelsdev!.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("BUG-505/binary-version: a binary table is read only when the binary's version is not the stored table's", () => {
  const codexDump = () => JSON.stringify({ models: [...Object.entries(FIXTURE_TABLES["codex-windows"].models).map(([slug, w]) => ({ slug, context_window: w.context, max_context_window: w.max, effective_context_window_percent: w.percent })), { slug: "gpt-test-1", context_window: 300_000, max_context_window: 400_000, effective_context_window_percent: 90 }] });
  const binary = (w: ReturnType<typeof world>, extra: Partial<RefreshDeps> = {}) => {
    const spawned: { argv: string[]; cwd: string }[] = [];
    const read: string[] = [];
    const deps: RefreshDeps = { ...w.deps, live: true, bin: (h) => `/opt/${h}`, spawn: async (argv, o) => (spawned.push({ argv, cwd: o.cwd }), codexDump()), readBinary: (p) => (read.push(p), Buffer.alloc(0)), ...extra };
    return { deps, spawned, read };
  };

  test("Codex: the stored version is not run again; a new one runs `debug models` in a neutral directory and stores the windows", async () => {
    const w = world();
    const { deps, spawned } = binary(w);
    const same = await refreshBinaryTables("codex", "0.159.3", deps);
    expect(same.reports).toEqual([expect.objectContaining({ table: "codex-windows", status: "skipped" })]);
    expect(spawned).toEqual([]);
    const next = await refreshBinaryTables("codex", "0.200.1", deps);
    expect(next.reports[0]).toMatchObject({ status: "written" });
    expect(spawned.map((s) => s.argv)).toEqual([["/opt/codex", "debug", "models"]]);
    expect(spawned[0]!.cwd).not.toBe(process.cwd());
    expect(spawned[0]!.cwd).not.toBe(ROOT);
    expect(w.tables().codexWindows).toMatchObject({ codexVersion: "0.200.1", generatedAt: "2026-10-06T12:00:00.000Z", fetchedAt: "2026-10-06T12:00:00.000Z" });
    expect(w.tables().codexWindows!.models["gpt-test-1"]).toEqual({ context: 300_000, max: 400_000, percent: 90 });
    expect(readStoredTable("codex-windows", w.dir)).toMatchObject({ codexVersion: "0.200.1" });
    // Now it is the stored one.
    await refreshBinaryTables("codex", "0.200.1", deps);
    expect(spawned).toHaveLength(1);
    expect(w.ledger).toEqual([expect.objectContaining({ kind: "tables", table: "codex-windows", via: "binary", harness: "codex" })]);
  });

  test("Codex: not installed, a dump that prints nothing or has no model, an unknown version: skipped or refused, the stored table stays", async () => {
    const w = world();
    const before = stored(w.dir);
    expect((await refreshBinaryTables("codex", "0.200.1", { ...binary(w).deps, bin: () => undefined })).reports[0]).toMatchObject({ status: "skipped", detail: expect.stringContaining("not installed") });
    expect((await refreshBinaryTables("codex", null, binary(w).deps)).reports[0]).toMatchObject({ status: "skipped" });
    expect((await refreshBinaryTables("codex", "0.201.0", binary(w, { spawn: async () => null }).deps)).reports[0]).toMatchObject({ status: "unreadable" });
    // A binary that gives no table is no failure of the command (its layout moved: the stored table stays); a table that fails its checks is.
    const empty = await refreshBinaryTables("codex", "0.202.0", binary(w, { spawn: async () => JSON.stringify({ models: [] }) }).deps);
    expect([empty.failed, empty.reports[0]!.status, empty.reports[0]!.detail]).toEqual([false, "unreadable", expect.stringContaining("no model")]);
    expect(await refreshBinaryTables("opencode", "1.2.3", binary(w).deps)).toMatchObject({ reports: [], skipped: expect.any(String) });
    expect(stored(w.dir)).toEqual(before);
  });

  test("a build that failed for a version is not tried again in this run (a binary is not read at every launch)", async () => {
    const w = world();
    const { deps, spawned } = binary(w, { spawn: async () => null });
    await refreshBinaryTables("codex", "0.300.0", deps);
    await refreshBinaryTables("codex", "0.300.0", deps);
    expect(spawned).toEqual([]);
    const calls: string[] = [];
    const counting = { ...deps, spawn: async (argv: string[]) => (calls.push(argv.join(" ")), null) };
    await refreshBinaryTables("codex", "0.300.1", counting);
    await refreshBinaryTables("codex", "0.300.1", counting);
    expect(calls).toEqual(["/opt/codex debug models"]);
  });

  test("Grok: the stored version is not read; a new one is read as bytes, over models.dev's seed, with the binary's windows", async () => {
    const w = world();
    const models = Object.entries(FIXTURE_TABLES["grok-models"].models).filter(([, m]) => m.source === "binary").map(([id, m]) => ({ id, context_window: m.context, auto_compact_threshold_percent: m.autoCompactPercent }));
    models.push({ id: "grok-test-1", context_window: 777_000, auto_compact_threshold_percent: 70 });
    const bytes = Buffer.concat([Buffer.from('\0data {"models":[1]} \0'), Buffer.from(JSON.stringify({ default: "grok-4.6", models })), Buffer.from("\0more")]);
    const { deps, read, spawned } = binary(w, { readBinary: (p) => (read.push(p), bytes) });
    expect((await refreshBinaryTables("grok-build", "1.0.46", deps)).reports[0]).toMatchObject({ status: "skipped" });
    expect(read).toEqual([]);
    expect((await refreshBinaryTables("grok-build", "1.7.2", deps)).reports[0]).toMatchObject({ status: "written" });
    expect(read).toEqual(["/opt/grok-build"]);
    expect(spawned).toEqual([]);
    expect(w.tables().grokModels).toMatchObject({ grokVersion: "1.7.2" });
    expect(w.tables().grokModels!.models["grok-test-1"]).toEqual({ context: 777_000, source: "binary", autoCompactPercent: 70 });
    expect(w.tables().grokModels!.models["grok-4.7"]).toMatchObject({ source: "observed", costSource: "models.dev-seed" });
    // A binary without the embedded catalog: refused, the table stays.
    const bad = await refreshBinaryTables("grok-build", "1.8.0", { ...deps, readBinary: () => Buffer.from("nothing here") });
    expect([bad.failed, bad.reports[0]!.status, bad.reports[0]!.detail]).toEqual([false, "unreadable", expect.stringContaining("no embedded default_models.json")]);
    expect(w.tables().grokModels).toMatchObject({ grokVersion: "1.7.2" });
  });

  test("BUG-604/grok: a binary model with a window of 5 (or a price over the bound) is skipped and named; the other models and the table are written", async () => {
    const w = world();
    const models: Record<string, unknown>[] = Object.entries(FIXTURE_TABLES["grok-models"].models).filter(([, m]) => m.source === "binary").map(([id, m]) => ({ id, context_window: m.context }));
    models.push({ id: "grok-tiny", context_window: 5 }, { id: "grok-dear", context_window: 200_000, cost: { input: 9_000, output: 1 } }, { id: "grok-fine", context_window: 321_000, cost: { input: 1, output: 2 } });
    const bytes = Buffer.from(JSON.stringify({ default: "grok-4.6", models }));
    const { deps } = binary(w, { readBinary: () => bytes });
    const r = (await refreshBinaryTables("grok-build", "1.7.2", deps)).reports[0]!;
    expect(r).toMatchObject({ table: "grok-models", status: "written", skipped: ["grok-dear", "grok-tiny"] });
    expect(r.detail).toContain("2 rows skipped as malformed (grok-dear, grok-tiny)");
    const got = w.tables().grokModels!.models;
    expect([got["grok-tiny"], got["grok-dear"]]).toEqual([undefined, undefined]);
    expect(got["grok-fine"]).toMatchObject({ context: 321_000, source: "binary", cost: { input: 1, output: 2 } });
    expect(w.ledger).toEqual([expect.objectContaining({ kind: "tables", table: "grok-models", skipped: 2, skippedNames: ["grok-dear", "grok-tiny"] })]);
  });

  test("Grok's seeded prices follow a new models.dev table without reading the binary again", async () => {
    const w = world();
    const seeded = Object.entries(w.tables().grokModels!.models).find(([, m]) => m.costSource === "models.dev-seed" && m.cost)!;
    const f = fakeFetch();
    const bump = (c: Record<string, any>) => void (c.xai.models[seeded[0]].cost.input = seeded[1].cost!.input! + 0.5);
    const read: string[] = [];
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), modelsDev: () => JSON.stringify((() => { const c = JSON.parse(fixtureSources().modelsDev()!); bump(c); return c; })()) }).fetchText, readBinary: (p) => (read.push(p), Buffer.alloc(0)) });
    void f;
    expect(r.reports.map((x) => x.table)).toEqual(["modelsdev", "grok-models"]);
    expect(w.tables().grokModels!.models[seeded[0]]!.cost!.input).toBe(seeded[1].cost!.input! + 0.5);
    expect(w.tables().grokModels!.models[seeded[0]]!.costSource).toBe("models.dev-seed");
    expect(w.tables().grokModels!.grokVersion).toBe(FIXTURE_TABLES["grok-models"].grokVersion);
    expect(read).toEqual([]);
    // The binary's windows are as they were.
    for (const [id, m] of Object.entries(FIXTURE_TABLES["grok-models"].models)) if (m.source === "binary") expect(w.tables().grokModels!.models[id]).toMatchObject({ context: m.context, source: "binary", ...(m.autoCompactPercent ? { autoCompactPercent: m.autoCompactPercent } : {}) });
  });

  test("Claude: the whole table (catalog and fast-mode rows) is rebuilt from the installed binary when its version is new; the stored version is not read", async () => {
    const w = world();
    const rows = clone(FIXTURE_TABLES["claude-catalog"].fastPricing!);
    const first = Object.keys(rows)[0]!;
    rows[first]!.input += 1;
    const { deps, read } = binary(w, { readBinary: (p) => (read.push(p), claudeBytes(FAST(rows))) });
    expect((await refreshBinaryTables("claude-code", "2.1.289", deps)).reports[0]).toMatchObject({ status: "skipped" });
    expect(read).toEqual([]);
    expect((await refreshBinaryTables("claude-code", "2.9.9", deps)).reports[0]).toMatchObject({ status: "written" });
    expect(w.tables().claudeCatalog).toMatchObject({ source: "claude-code binary", claudeCodeVersion: "2.9.9", fastPricing: rows });
    // The catalog is the new binary's own (it lists a model the stored one lacked), not the stored one kept.
    expect(w.tables().claudeCatalog!.models.map((m) => m.id)).toContain("claude-test-9");
    expect(w.tables().claudeCatalog!.catalogDigest).not.toBe(FIXTURE_TABLES["claude-catalog"].catalogDigest);
    // A binary whose price function moved: unreadable, the stored table stays; and so does one with no catalog.
    const moved = await refreshBinaryTables("claude-code", "3.0.0", { ...deps, readBinary: () => claudeBytes("") });
    expect([moved.failed, moved.reports[0]!.status, moved.reports[0]!.detail]).toEqual([false, "unreadable", expect.stringContaining("no fast-mode prices")]);
    const bare = await refreshBinaryTables("claude-code", "3.0.1", { ...deps, readBinary: () => Buffer.from("nothing here") });
    expect([bare.reports[0]!.status, bare.reports[0]!.detail]).toEqual(["unreadable", expect.stringContaining("no model catalog")]);
    expect(w.tables().claudeCatalog).toMatchObject({ claudeCodeVersion: "2.9.9", fastPricing: rows });
  });

  test("Claude's table is never fetched: the network refresh leaves it alone, whatever the binary table is (or isn't)", async () => {
    const w = world({ seed: false });
    const rows = clone(FIXTURE_TABLES["claude-catalog"].fastPricing!);
    const { deps } = binary(w, { readBinary: () => claudeBytes(FAST(rows)) });
    expect((await refreshBinaryTables("claude-code", "2.9.9", deps)).reports[0]).toMatchObject({ status: "written", detail: "a first table" });
    const table = w.tables().claudeCatalog;
    const f = fakeFetch();
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: f.fetchText });
    expect(r.reports.map((x) => x.table)).toEqual(["modelsdev"]);
    expect(w.tables().claudeCatalog).toBe(table);
    expect(f.asked.every((u) => !u.includes("catalog") && !u.includes("claude.ai"))).toBe(true);
    // No binary table, none from the network: Claude has no table (its requests wait, or the session ends with them dropped).
    const none = world({ seed: false });
    await refreshNetworkTables({ ...none.deps, source: SRC, fetchText: fakeFetch().fetchText });
    expect(none.tables().claudeCatalog).toBeUndefined();
  });

  test("`gluon pricing update` runs the network refresh, then every installed harness's binary tables, and prints what was written and what moved", async () => {
    const w = world();
    const out: string[] = [];
    const sources = fixtureSources();
    const listing = openRouterListing();
    const hay = listing.data.find((m) => m.id === "anthropic/claude-haiku-4.5")!;
    hay.pricing.prompt = String(Number(hay.pricing.prompt) * 1.2);
    const f = fakeFetch({ ...sources, listing: () => JSON.stringify(listing) });
    const spawned: string[] = [];
    const code = await pricingUpdate({
      ...w.deps,
      source: SRC,
      live: true,
      fetchText: f.fetchText,
      bin: (h) => (h === "codex" ? "/opt/codex" : undefined),
      spawn: async (argv) => (spawned.push(argv.join(" ")), argv[1] === "--version" ? "codex-cli 0.200.1\n" : codexDump()),
      log: (l) => out.push(l),
      error: (l) => out.push(`ERR ${l}`),
    });
    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("modelsdev: written");
    expect(text).toContain("moved openrouter/anthropic/claude-haiku-4.5.cost.input: 1 -> 1.2");
    expect(text).toContain("codex-windows: written");
    expect(text).toContain("Claude Code: not installed");
    expect(spawned).toEqual(["/opt/codex --version", "/opt/codex debug models"]);
  });
});

describe("BUG-506/openrouter-row: a launch on an OpenRouter model refreshes that model's row and nothing else", () => {
  const ID = "anthropic/claude-haiku-4.5";
  test("its price and endpoints are replaced on the stored table; every other entry is as it was; only the listing and its endpoints are asked", async () => {
    const w = world();
    const before = clone(w.tables().modelsdev!);
    const listing = openRouterListing();
    const row = listing.data.find((m) => m.id === ID)!;
    row.pricing.prompt = String(1.5 / 1e6);
    row.pricing.completion = String(7 / 1e6);
    const f = fakeFetch({ ...fixtureSources(), listing: () => JSON.stringify(listing), endpoints: () => JSON.stringify({ data: { endpoints: [{ pricing: { prompt: "0.0000014", completion: "0.000007" } }, { pricing: { prompt: "0.0000018", completion: "0.0000075" } }, { pricing: { prompt: "0.0000016", completion: "0.000007" } }] } }) });
    const r = await refreshOpenRouterRow(`openrouter/${ID}`, { ...w.deps, source: SRC, fetchText: f.fetchText });
    expect(r.reports[0]).toMatchObject({ table: "modelsdev", status: "written", moved: 2 });
    expect(f.asked.map((u) => new URL(u).pathname).sort()).toEqual(["/api/v1/models", `/api/v1/models/${ID}/endpoints`]);
    const now = w.tables().modelsdev!;
    expect(now.entries[`openrouter/${ID}`]).toMatchObject({ cost: { input: 1.5, output: 7 }, priceSource: "openrouter", endpoints: { count: 3, input: { min: 1.4, max: 1.8 }, output: { min: 7, max: 7.5 } } });
    const others = (t: { entries: Record<string, unknown> }) => Object.fromEntries(Object.entries(t.entries).filter(([k]) => k !== `openrouter/${ID}`));
    expect(others(now)).toEqual(others(before));
    expect(now.catalogDigest).not.toBe(before.catalogDigest);
    expect(Object.keys(now.entries)).toEqual(Object.keys(before.entries));
    expect(readStoredTable<typeof now>("modelsdev", w.dir)!.entries[`openrouter/${ID}`]).toMatchObject({ cost: { input: 1.5 } });
    // The ledger names the row's two moves.
    expect(w.ledger).toEqual([expect.objectContaining({ kind: "tables", table: "modelsdev", via: "openrouter-row", moved: 2, prices: expect.arrayContaining([expect.objectContaining({ key: `openrouter/${ID}.cost.input`, from: 1, to: 1.5 })]) })]);
  });

  test("a model OpenRouter doesn't list, a failed answer, no stored table and an id that is no id: nothing is written", async () => {
    const w = world();
    const entries = clone(w.tables().modelsdev!.entries);
    const f = fakeFetch({ ...fixtureSources(), listing: () => JSON.stringify({ data: openRouterListing().data.filter((m) => m.id !== ID) }) });
    expect((await refreshOpenRouterRow(`openrouter/${ID}`, { ...w.deps, source: SRC, fetchText: f.fetchText })).reports[0]).toMatchObject({ status: "current" });
    expect(w.tables().modelsdev!.entries).toEqual(entries);
    expect(w.ledger).toEqual([]);
    const before = stored(w.dir);
    expect((await refreshOpenRouterRow(`openrouter/${ID}`, { ...w.deps, source: SRC, fetchText: async () => null })).reports[0]).toMatchObject({ status: "unreachable" });
    expect((await refreshOpenRouterRow(`openrouter/${ID}`, { ...w.deps, source: SRC, fetchText: async () => "[]" })).reports[0]).toMatchObject({ status: "refused" });
    const evil = fakeFetch();
    expect((await refreshOpenRouterRow("openrouter/../../etc/passwd", { ...w.deps, source: SRC, fetchText: evil.fetchText })).reports[0]).toMatchObject({ status: "skipped" });
    expect(evil.asked).toEqual([]);
    expect(stored(w.dir)).toEqual(before);
    const empty = world({ seed: false });
    const none = fakeFetch();
    expect((await refreshOpenRouterRow(`openrouter/${ID}`, { ...empty.deps, source: SRC, fetchText: none.fetchText })).reports[0]).toMatchObject({ status: "skipped" });
    expect(none.asked).toEqual([]);
  });
});

describe("BUG-507/launch: a launch starts the refreshes and never waits for them", () => {
  test("refreshOnLaunch returns at once while every source is still pending, and the work finishes behind it", async () => {
    const w = world();
    const f = fakeFetch();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps: RefreshDeps = { ...w.deps, source: SRC, live: true, bin: () => undefined, fetchText: async (url, o) => (await gate, f.fetchText!(url, o)) };
    const started = performance.now();
    const returned = refreshOnLaunch({ harness: "claude-code", version: "2.9.9", openrouterKey: "openrouter/anthropic/claude-haiku-4.5", deps });
    expect(returned).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(50);
    expect(f.asked).toEqual([]);
    release();
    const settled = await refreshNetworkTables(deps);
    expect(settled.failed).toBe(false);
    expect(settled.reports.every((r) => r.status === "written" || r.status === "current")).toBe(true);
    expect(f.asked.length).toBeGreaterThan(2);
  });

  test("the network tables again only when none is running and the last success is more than 10 minutes old; an OpenRouter launch refreshes its row in between", async () => {
    const w = world();
    const f = fakeFetch();
    const deps: RefreshDeps = { ...w.deps, source: SRC, live: true, bin: () => undefined, fetchText: f.fetchText };
    const idle = async () => {
      await Bun.sleep(30);
      await refreshNetworkTables({ ...deps, fetchText: async () => null }); // settles anything running (and fails: no success is recorded)
    };
    await refreshNetworkTables(deps);
    const initial = f.asked.length;
    w.advance(9 * 60_000);
    refreshOnLaunch({ harness: "claude-code", version: null, deps });
    await idle();
    expect(f.asked).toHaveLength(initial);
    // An OpenRouter launch: the model's row, the listing and its endpoints.
    refreshOnLaunch({ harness: "opencode", version: null, openrouterKey: "openrouter/anthropic/claude-haiku-4.5", deps });
    await idle();
    expect(f.asked.slice(initial).map((u) => new URL(u).pathname).sort()).toEqual(["/api/v1/models", "/api/v1/models/anthropic/claude-haiku-4.5/endpoints"]);
    // Past ten minutes since the last success: the whole refresh.
    w.advance(2 * 60_000);
    const before = f.asked.length;
    refreshOnLaunch({ harness: "opencode", version: null, openrouterKey: "openrouter/anthropic/claude-haiku-4.5", deps });
    await idle();
    expect(f.asked.slice(before).map((u) => new URL(u).pathname)).toContain("/api.json");
  });

  test("a harness launch reads its binary table in the background for a new version", async () => {
    const w = world();
    const spawned: string[] = [];
    const deps: RefreshDeps = { ...w.deps, source: SRC, live: true, bin: (h) => (h === "codex" ? "/opt/codex" : undefined), fetchText: async () => null, spawn: async (argv) => (spawned.push(argv.join(" ")), JSON.stringify({ models: [{ slug: "gpt-x", context_window: 200_000, max_context_window: 400_000, effective_context_window_percent: 90 }] })) };
    refreshOnLaunch({ harness: "codex", version: "0.400.0", deps });
    await Bun.sleep(30);
    await refreshNetworkTables(deps);
    expect(spawned).toEqual(["/opt/codex debug models"]);
    expect(w.tables().codexWindows).toMatchObject({ codexVersion: "0.400.0" });
  });
});

describe("BUG-508/full-path: the refresh against a local server, as Gluon reads it (a first run with no table)", () => {
  test("the sources are fetched, built, validated, written private, and handed to the registry; the tables are the fixtures' prices", async () => {
    const w = world({ seed: false });
    const s = servePricing();
    try {
      const r = await refreshNetworkTables({ ...w.deps, source: urlsFor(s.base) });
      expect(r.reports.map((x) => [x.table, x.status])).toEqual([["modelsdev", "written"]]);
      const md = w.tables().modelsdev!;
      expect(md.entries["openrouter/anthropic/claude-haiku-5.5"]).toMatchObject({ cost: { input: 0.1, output: 0.5 }, priceSource: "openrouter", endpoints: { count: 2 } });
      for (const [k, e] of Object.entries(FIXTURE_TABLES.modelsdev.entries)) expect([k, md.entries[k]?.cost]).toEqual([k, e.cost]);
      expect(readdirSync(w.dir).sort()).toEqual(["modelsdev.json"]);
      if (process.platform !== "win32") expect([lstatSync(w.dir).mode & 0o777, lstatSync(w.file("modelsdev")).mode & 0o777]).toEqual([0o700, 0o600]);
      // Nothing outside the store: the state directory holds only gluon/tables.
      expect(readdirSync(join(w.root, "state"))).toEqual(["gluon"]);
      expect(readdirSync(join(w.root, "state", "gluon"))).toEqual(["tables"]);
      expect(s.seen).toContain("/api.json");
      expect(s.seen.every((p) => ["/api.json", "/api/v1/models"].includes(p) || /^\/api\/v1\/models\/.+\/endpoints$/.test(p))).toBe(true);
    } finally {
      s.stop();
    }
  });

  test("the registry's listeners hear a new table; a refresh that changes nothing sets nothing new", async () => {
    const w = world();
    const heard: number[] = [];
    const registry: Registry = { get: w.registry.get, set: (p) => (heard.push(Object.keys(p).length), w.registry.set(p)) };
    const s = servePricing(fixtureSources());
    try {
      const deps = { ...w.deps, registry, source: urlsFor(s.base) };
      await refreshNetworkTables(deps);
      const first = heard.length;
      expect(first).toBeGreaterThan(0);
    } finally {
      s.stop();
    }
  });

  test("a table checked today stays 'current' without a write; one not rewritten for six hours gets its date moved", async () => {
    const w = world({ seed: false });
    const deps = { ...w.deps, source: SRC, fetchText: fakeFetch().fetchText };
    await refreshNetworkTables(deps);
    const first = JSON.parse(readFileSync(w.file("modelsdev"), "utf8")).fetchedAt;
    w.advance(60 * 60_000);
    await refreshNetworkTables(deps);
    expect(JSON.parse(readFileSync(w.file("modelsdev"), "utf8")).fetchedAt).toBe(first);
    w.advance(6 * 3_600_000);
    const later = await refreshNetworkTables(deps);
    expect(later.reports.map((r) => r.status)).toEqual(["current"]);
    expect(JSON.parse(readFileSync(w.file("modelsdev"), "utf8")).fetchedAt).not.toBe(first);
  });

  test("a directory that can't be written still gives this run the new prices", async () => {
    const w = world({ seed: false });
    mkdirSync(join(w.root, "state", "gluon"), { recursive: true });
    writeFileSync(join(w.root, "state", "gluon", "tables"), "a file, not a directory");
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch().fetchText });
    expect(r.reports.map((x) => x.status)).toEqual(["written"]);
    expect(r.reports[0]!.detail).toContain("not stored");
    expect(w.tables().modelsdev).toBeDefined();
  });

  void claudeTable;
});

// ---- QA of the table lifecycle (B4) ----

describe("QA cost: a source's odd values", () => {
  const oddRows: [string, Record<string, unknown>][] = [
    ["a cost field the schema does not know (models.dev adds one)", { cost: { input: 1, output: 2, input_video: 3 }, limit: { context: 100_000 } }],
    ["a price over the bound (6000 USD per million)", { cost: { input: 6000, output: 2 }, limit: { context: 100_000 } }],
    ["a negative price", { cost: { input: -1, output: 2 }, limit: { context: 100_000 } }],
    ["a cache price that is text", { cost: { input: 1, output: 2, cache_read: "0.1" }, limit: { context: 100_000 } }],
    ["a context limit that is not a whole number", { cost: { input: 1, output: 2 }, limit: { context: 1_048_576.5 } }],
  ];
  const provider = "anthropic";

  for (const [what, row] of oddRows) {
    // One malformed model among the ~1000 of the providers OpenCode reaches makes `parseTable` refuse the WHOLE table (`modelsdev-catalog.ts` `select` copies a
    // row's `cost` and `limit` unchecked, `table-schema.ts` refuses the table), so no price anywhere is ever refreshed again until models.dev is fixed.
    test(`BUG-604/QA-cost-01: ${what} in one model skips that model, never every price`, async () => {
      const w = world({ seed: false });
      const sources: Sources = { ...fixtureSources(), modelsDev: () => JSON.stringify(modelsDevCatalog((c) => ((c[provider] ??= { models: {} }).models["qa-odd-model"] = row))) };
      const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch(sources).fetchText });
      expect(r.reports.map((x) => x.status)).toEqual(["written"]);
      expect(Object.keys(w.tables().modelsdev?.entries ?? {})).toContain(Object.keys(FIXTURE_TABLES.modelsdev.entries)[0]!);
      expect(w.tables().modelsdev?.entries[`${provider}/qa-odd-model`]).toBeUndefined();
    });
  }

  const refreshWith = async (modelsDev: unknown, extra: Partial<Sources> = {}) => {
    const w = world({ seed: false });
    const text = typeof modelsDev === "string" ? modelsDev : JSON.stringify(modelsDev);
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), modelsDev: () => text, ...extra }).fetchText });
    return { w, r };
  };

  test("BUG-604/variants: an Infinity (1e999 in the JSON), a missing cost, a null row and a malformed provider object skip only what is odd", async () => {
    const good = Object.keys(FIXTURE_TABLES.modelsdev.entries).find((k) => k.startsWith("anthropic/"))!;
    const { w, r } = await refreshWith(
      JSON.stringify(
        modelsDevCatalog((c) => {
          c.anthropic.models["qa-infinity"] = { cost: { input: 1, output: 2 }, limit: { context: 100_000 } };
          c.anthropic.models["qa-no-cost"] = { limit: { context: 100_000 } };
          c.anthropic.models["qa-null"] = null;
          c.anthropic.models["qa bad id"] = { cost: { input: 1, output: 2 } };
          c.anthropic.models["qa-modes"] = { cost: { input: 1, output: 2 }, experimental: { modes: { fast: null, slow: { cost: { input: 1, output: 1 }, provider: { body: { speed: "slow" } } } } } };
          c.openai = { models: ["not", "an", "object"] };
          c.google = "a string, not a provider";
          c.xai = null;
          c.mistral = { models: null };
        }),
      ).replace('"qa-infinity":{"cost":{"input":1', '"qa-infinity":{"cost":{"input":1e999'),
    );
    expect(r.reports.map((x) => x.status)).toEqual(["written"]);
    const entries = w.tables().modelsdev!.entries;
    expect(entries[good]).toBeDefined();
    expect(["anthropic/qa-infinity", "anthropic/qa-no-cost", "anthropic/qa-null", "anthropic/qa bad id"].map((k) => k in entries)).toEqual([false, false, false, false]);
    // A row with no cost is no price (unchanged), not "malformed": the Infinity, the null row and the id that is no id are counted; the last has no plain name, so it is not named.
    expect(r.reports[0]!.skipped).toEqual(["anthropic/qa-infinity", "anthropic/qa-null"]);
    expect(r.reports[0]!.detail).toContain("3 rows skipped as malformed (anthropic/qa-infinity, anthropic/qa-null, 1 with ids that are not plain names)");
  });

  test("BUG-604/variants: select() leaves out a NaN and an Infinity, lists a skipped wanted key as missing too, and says what it skipped", () => {
    const wanted = new Set(["anthropic/a", "anthropic/b", "anthropic/c"]);
    const catalog = { anthropic: { models: { a: { cost: { input: Number.NaN, output: 1 } }, b: { cost: { input: 1, output: Number.POSITIVE_INFINITY } }, c: { cost: { input: 1, output: 2 } }, d: { cost: { input: 3, output: Number.NaN } } } } };
    const got = select(catalog, wanted, ["anthropic"]);
    expect(Object.keys(got.entries)).toEqual(["anthropic/c"]);
    expect(got.missing).toEqual(["anthropic/a", "anthropic/b"]);
    expect(got.skipped).toEqual(["anthropic/a", "anthropic/b", "anthropic/d"]);
  });

  test("BUG-604/variants: an OpenRouter price over the table's bound skips that row, and an endpoint range over it leaves only the range off", async () => {
    const key = [...wantedKeys()].find((k) => k.startsWith("openrouter/") && FIXTURE_TABLES.modelsdev.entries[k]?.endpoints)!;
    const id = key.slice("openrouter/".length);
    const dear = (n: number) => (n / 1e6).toString();
    // The listing prices the wanted model at 9000 USD per million: that row is skipped (and missing); every other row is still written.
    const a = world({ seed: false });
    const listing = openRouterListing((l) => void (l.data.find((m) => m.id === id)!.pricing = { prompt: dear(9_000), completion: dear(9_000) }));
    const ra = await refreshNetworkTables({ ...a.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), listing: () => JSON.stringify(listing) }).fetchText });
    expect(ra.reports.map((x) => x.status)).toEqual(["written"]);
    expect(ra.reports[0]!.skipped).toEqual([key]);
    expect(a.tables().modelsdev!.entries[key]).toBeUndefined();
    expect(a.tables().modelsdev!.missing).toContain(key);
    // Its endpoints answer with a 9000 price: the row keeps OpenRouter's price and has no range.
    const b = world({ seed: false });
    const src = fixtureSources();
    const rb = await refreshNetworkTables({ ...b.deps, source: SRC, fetchText: fakeFetch({ ...src, endpoints: (i) => (i === id ? JSON.stringify({ data: { endpoints: [{ pricing: { prompt: dear(9_000), completion: dear(1) } }] } }) : src.endpoints(i)) }).fetchText });
    expect(rb.reports.map((x) => x.status)).toEqual(["written"]);
    const row = b.tables().modelsdev!.entries[key]!;
    expect([(row as { priceSource?: string }).priceSource, (row as { endpoints?: unknown }).endpoints]).toEqual(["openrouter", undefined]);
  });

  test("a table that is written without skipped rows says nothing of them (no `skipped`, no ledger field)", async () => {
    const { r, w } = await refreshWith(modelsDevCatalog());
    expect(r.reports[0]!.skipped).toBeUndefined();
    expect(r.reports[0]!.detail).not.toContain("skipped");
    expect(w.ledger).toEqual([expect.not.objectContaining({ skipped: expect.anything() })]);
  });

  test("BUG-604/terminal: a source's ids and text never reach the report with a control character, and stay short", async () => {
    const hostile = ["a\u001b[2Jb", "t\u001b]0;pwned\u0007x", "nul\u0000id", "line\nbreak\rid", "x".repeat(5000), `anthropic/${"y".repeat(100)}`];
    const { r, w } = await refreshWith(
      modelsDevCatalog((c) => {
        for (const id of hostile) c.anthropic.models[id] = { cost: { input: -1, output: 2 } };
      }),
    );
    const detail = r.reports[0]!.detail;
    expect(detail).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(detail.length).toBeLessThan(400);
    expect(detail).toContain(`${hostile.length} rows skipped as malformed (`);
    expect(detail).toContain("5 with ids that are not plain names");
    expect(JSON.stringify(r.reports[0]!.skipped ?? [])).not.toMatch(/\\u00/);
    const entry = w.ledger[0] as { skipped: number; skippedNames: string[] };
    expect([entry.skipped, entry.skippedNames.every((n) => /^[A-Za-z0-9._:/@[\]-]{1,128}$/.test(n))]).toEqual([hostile.length, true]);
    // A named id is cut to 64 characters.
    const long = await refreshWith(modelsDevCatalog((c) => void (c.anthropic.models["z".repeat(100)] = { cost: { input: -1, output: 2 } })));
    expect(long.r.reports[0]!.detail).toContain(`anthropic/${"z".repeat(51)}...`);
    expect(long.r.reports[0]!.detail).not.toContain("z".repeat(60));
  });

  test("BUG-604/terminal: a parse error that quotes what the source sent is one plain line", async () => {
    for (const body of ["{\"a\": \u001b[2J\u0007\u0000}", "\u001b]0;pwned\u0007", "{\"a\": \u202e\u2066\u200f\u061c}", "\u202eevil"]) {
      const { r } = await refreshWith(body);
      expect(r.reports[0]!.status).toBe("refused");
      expect(r.reports[0]!.detail).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/);
      expect(r.reports[0]!.detail.length).toBeLessThan(400);
    }
  });

  test("BUG-604/ledger: the rows skipped are a count and names in the `tables` entry", async () => {
    const { r, w } = await refreshWith(modelsDevCatalog((c) => void (c.anthropic.models["qa-odd"] = { cost: { input: -1, output: 2 } })));
    expect(r.reports[0]!.detail).toContain("1 row skipped as malformed (anthropic/qa-odd)");
    expect(w.ledger).toEqual([expect.objectContaining({ kind: "tables", table: "modelsdev", via: "network", skipped: 1, skippedNames: ["anthropic/qa-odd"] })]);
  });

  test("odd values in OpenRouter's listing (negative, text, huge, missing) leave those models out and the table written", async () => {
    const w = world({ seed: false });
    const listing = openRouterListing((l) => {
      l.data.push({ id: "qa/negative", context_length: 1000, pricing: { prompt: "-1", completion: "-1" } });
      l.data.push({ id: "qa/text", context_length: "big", pricing: { prompt: "free", completion: "free" } });
      l.data.push({ id: "qa/none", pricing: null });
      l.data.push({ id: "qa/huge", pricing: { prompt: "1e30", completion: "1e30" } });
      l.data.push({ id: 5, pricing: "free" } as never);
    });
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), listing: () => JSON.stringify(listing) }).fetchText });
    expect(r.reports.map((x) => x.status)).toEqual(["written"]);
  });

  test("BUG-606/QA-cost-03: a null element in OpenRouter's listing is skipped, not a reason to refuse every price", async () => {
    const w = world({ seed: false });
    const listing = openRouterListing((l) => void l.data.push(null as never));
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), listing: () => JSON.stringify(listing) }).fetchText });
    expect(r.reports.map((x) => x.status)).toEqual(["written"]);
  });

  test("BUG-606/variants: non-object elements of every kind are skipped, but a listing with no usable model at all is still an error body (BUG-477)", async () => {
    const odd = [null, 5, "free", true, [], [null], { id: null }];
    const w = world({ seed: false });
    const listing = openRouterListing((l) => void l.data.push(...(odd as never[])));
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), listing: () => JSON.stringify(listing) }).fetchText });
    expect(r.reports.map((x) => x.status)).toEqual(["written"]);
    for (const body of [{ data: [null] }, { data: odd }, { data: [] }, { error: "x" }, { data: {} }]) {
      const v = world();
      const before = stored(v.dir);
      const res = await refreshNetworkTables({ ...v.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), listing: () => JSON.stringify(body) }).fetchText });
      expect([JSON.stringify(body), res.reports.map((x) => x.status)]).toEqual([JSON.stringify(body), ["refused"]]);
      expect(stored(v.dir)).toEqual(before);
    }
  });

  test("BUG-608/QA-cost-02:a stored table dated in the future (a clock that was wrong) is rewritten like an old one, not 'current' for ever", async () => {
    const w = world();
    const held = clone(readStoredTable("modelsdev", w.dir)!) as Record<string, unknown>;
    held.fetchedAt = "2099-01-01T00:00:00.000Z";
    writeStoredTable("modelsdev", held, w.dir, false);
    w.registry.set({ modelsdev: readStoredTable("modelsdev", w.dir)! });
    // The same content as the stored table (the endpoints don't answer: the stored ranges stay), so only its date decides.
    const src = fixtureSources();
    const deps = { ...w.deps, source: SRC, fetchText: (async (url) => (new URL(url).pathname === "/api.json" ? src.modelsDev() : new URL(url).pathname === "/api/v1/models" ? src.listing() : null)) as RefreshDeps["fetchText"] };
    w.advance(30 * 86_400_000);
    const r = await refreshNetworkTables(deps);
    expect(r.reports[0]).toMatchObject({ table: "modelsdev", status: "current" });
    expect(JSON.parse(readFileSync(w.file("modelsdev"), "utf8")).fetchedAt).not.toBe("2099-01-01T00:00:00.000Z");
  });

  test("BUG-608/variants: a stored date 1 minute or 1 year ahead is rewritten at once; a past one is current for six hours and then rewritten", async () => {
    const dated = async (fetchedAt: string, advance = 0) => {
      const w = world();
      const held = clone(readStoredTable("modelsdev", w.dir)!) as Record<string, unknown>;
      held.fetchedAt = fetchedAt;
      writeStoredTable("modelsdev", held, w.dir, false);
      w.registry.set({ modelsdev: readStoredTable("modelsdev", w.dir)! });
      const src = fixtureSources();
      const deps = { ...w.deps, source: SRC, fetchText: (async (url) => (new URL(url).pathname === "/api.json" ? src.modelsDev() : new URL(url).pathname === "/api/v1/models" ? src.listing() : null)) as RefreshDeps["fetchText"] };
      w.advance(advance);
      const r = await refreshNetworkTables(deps);
      return [r.reports[0]!.status, JSON.parse(readFileSync(w.file("modelsdev"), "utf8")).fetchedAt === fetchedAt ? "kept" : "rewritten"];
    };
    // The world's clock is 2026-10-06T12:00:00Z.
    expect(await dated("2026-10-06T12:01:00.000Z")).toEqual(["current", "rewritten"]);
    expect(await dated("2027-10-06T12:00:00.000Z")).toEqual(["current", "rewritten"]);
    expect(await dated("2026-10-06T11:00:00.000Z")).toEqual(["current", "kept"]);
    expect(await dated("2026-10-06T11:00:00.000Z", 6 * 3_600_000)).toEqual(["current", "rewritten"]);
    expect(await dated("2026-10-06T12:00:00.000Z")).toEqual(["current", "kept"]);
  });

  test("a truncated, empty, newer-schema or non-JSON stored table is no table (and a refresh then writes a good one)", async () => {
    const w = world();
    const good = readFileSync(w.file("modelsdev"), "utf8");
    for (const bad of [good.slice(0, good.length / 2), "", good.replace('"schema": 1', '"schema": 2'), "not json", "[]", "null"]) {
      writeFileSync(w.file("modelsdev"), bad);
      expect(readStoredTable("modelsdev", w.dir)).toBeUndefined();
    }
    const empty = world({ seed: false });
    mkdirSync(empty.dir, { recursive: true });
    writeFileSync(empty.file("modelsdev"), good.slice(0, 500));
    const r = await refreshNetworkTables({ ...empty.deps, source: SRC, fetchText: fakeFetch().fetchText });
    expect(r.reports.map((x) => x.status)).toEqual(["written"]);
    expect(readStoredTable("modelsdev", empty.dir)).toBeDefined();
  });

  test("three processes rewriting a table while another reads it: the reader never sees a torn or missing table", async () => {
    const w = world();
    const script = join(w.root, "writer.ts");
    writeFileSync(
      script,
      `import { writeStoredTable } from ${JSON.stringify(join(ROOT, "src/cost/tables-store.ts"))};
import { FIXTURE_MODELS_DEV } from ${JSON.stringify(join(ROOT, "test/fixtures/fixture-tables.ts"))};
for (let i = 0; i < 40; i++) writeStoredTable("modelsdev", { ...FIXTURE_MODELS_DEV, fetchedAt: new Date(Date.now() + i).toISOString() }, process.argv[2]!, false);`,
    );
    const procs = [0, 1, 2].map(() => Bun.spawn([process.execPath, script, w.dir], { stdout: "ignore", stderr: "ignore", env: { ...process.env, NODE_ENV: "test" } }));
    let reads = 0;
    let missing = 0;
    while (procs.some((p) => p.exitCode === null)) {
      reads++;
      if (!readStoredTable("modelsdev", w.dir)) missing++;
      await Bun.sleep(0);
    }
    expect([reads > 0, missing]).toEqual([true, 0]);
    expect(readdirSync(w.dir).filter((f) => f.startsWith(".gluon-"))).toEqual([]);
  });
});

describe("QA cost: a source that is only half reachable, or slow", () => {
  // A network that lets models.dev through and not openrouter.ai (a proxy's allow-list) leaves a first run with no table at all: `modelsDevTables` wants both before it
  // builds anything, so every request waits for a table that never comes and no figure is ever shown, for a user who has no OpenRouter key.
  test("BUG-607/QA-cost-06: models.dev answers and OpenRouter does not: the table is built without its `openrouter/*` rows, not left unbuilt", async () => {
    const w = world({ seed: false });
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), listing: () => null }).fetchText });
    expect(r.reports.map((x) => x.status)).toEqual(["written"]);
    const keys = Object.keys(w.tables().modelsdev?.entries ?? {});
    expect(keys.some((k) => k.startsWith("anthropic/"))).toBe(true);
    expect(keys.filter((k) => k.startsWith("openrouter/"))).toEqual([]);
  });

  test("BUG-607/variants: with OpenRouter silent, the stored table's own OpenRouter rows stay (never models.dev's), and the report says so", async () => {
    const w = world();
    const stored = w.tables().modelsdev!;
    const orKeys = Object.entries(stored.entries).filter(([, e]) => (e as { priceSource?: string }).priceSource === "openrouter").map(([k]) => k);
    expect(orKeys.length).toBeGreaterThan(0);
    // models.dev lists an `openrouter` provider too (the table never prices from it): its rows must not appear either.
    const sources = { ...fixtureSources(), listing: () => null, modelsDev: () => JSON.stringify(modelsDevCatalog((c) => void ((c.openrouter ??= { models: {} }).models["qa/only-on-models-dev"] = { cost: { input: 1, output: 2 }, limit: { context: 100_000 } }))) };
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch(sources).fetchText });
    expect(r.reports[0]!.status).toMatch(/^(written|current)$/);
    expect(r.reports[0]!.detail).toContain("OpenRouter's listing didn't answer");
    const entries = w.tables().modelsdev!.entries;
    for (const k of orKeys) expect(entries[k]).toEqual({ ...stored.entries[k]!, staleSince: expect.any(String) as unknown as string });
    expect(entries["openrouter/qa/only-on-models-dev"]).toBeUndefined();
    expect(Object.keys(entries).filter((k) => k.startsWith("openrouter/") && (entries[k] as { priceSource?: string }).priceSource !== "openrouter")).toEqual([]);
  });

  test("BUG-607/stale: a kept OpenRouter row says since when it was not priced; the date holds while OpenRouter is silent and goes when it answers", async () => {
    const w = world();
    const silent = { ...fixtureSources(), listing: () => null };
    const answers = fixtureSources();
    await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch(answers).fetchText });
    const since = w.tables().modelsdev!.fetchedAt!;
    const keys = Object.entries(w.tables().modelsdev!.entries).filter(([, e]) => (e as { priceSource?: string }).priceSource === "openrouter").map(([k]) => k);
    expect(keys.length).toBeGreaterThan(0);
    const stale = () => keys.map((k) => (w.tables().modelsdev!.entries[k] as { staleSince?: string }).staleSince);
    expect(stale()).toEqual(keys.map(() => undefined));
    w.advance(2 * 86_400_000);
    const r1 = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch(silent).fetchText });
    expect(r1.reports[0]!.detail).toContain(`its openrouter/* prices were not refreshed since ${since.slice(0, 10)}`);
    expect(stale()).toEqual(keys.map(() => since));
    // Rewritten a day later, still silent: the date is the first one, not the new fetch.
    w.advance(86_400_000);
    await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch(silent).fetchText });
    expect(stale()).toEqual(keys.map(() => since));
    expect(w.tables().modelsdev!.fetchedAt).not.toBe(since);
    // OpenRouter answers again: every row is priced by it and carries no date.
    await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch(answers).fetchText });
    expect(JSON.stringify(w.tables().modelsdev)).not.toContain("staleSince");
  });

  test("BUG-607/variants: the answers that are not 'no answer' are still refused: an empty listing, an error body, text (BUG-477)", async () => {
    for (const body of ['{"data":[]}', '{"error":{"code":500}}', "<html>", "[]"]) {
      const w = world({ seed: false });
      const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), listing: () => body }).fetchText });
      expect([body, r.reports.map((x) => x.status), w.tables().modelsdev]).toEqual([body, ["refused"], undefined]);
    }
  });

  test("OpenRouter's listing answers and models.dev does not: nothing is written and the stored table stays", async () => {
    const w = world();
    const before = stored(w.dir);
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), modelsDev: () => null }).fetchText });
    expect(r.reports.map((x) => x.status)).toEqual(["unreachable"]);
    expect(stored(w.dir)).toEqual(before);
  });

  test("a server that sends its headers and then drips the body is cut at the timeout, not waited for", async () => {
    const { defaultFetch } = await import("../src/cost/refresh.ts");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(c) {
              for (let i = 0; i < 200; i++) {
                c.enqueue(new TextEncoder().encode("x"));
                await Bun.sleep(50);
              }
              c.close();
            },
          }),
        ),
    });
    try {
      const t0 = performance.now();
      const got = await defaultFetch(`http://127.0.0.1:${server.port}/api.json`, { timeoutMs: 300, maxBytes: 1_000_000 });
      expect(got).toBeNull();
      expect(performance.now() - t0).toBeLessThan(3000 * SLOW);
    } finally {
      server.stop(true);
    }
  });

  test("a wrong content type, an HTML error page or an empty body is the shape error, never a stored table", async () => {
    const w = world();
    const before = stored(w.dir);
    for (const body of ["<html>captive portal</html>", "", "null", "[]", "42", '"x"']) {
      const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), modelsDev: () => body }).fetchText });
      expect([body, r.reports.map((x) => x.status)[0]!]).toEqual([body, expect.stringMatching(/^(refused|unreachable)$/) as unknown as string]);
    }
    expect(stored(w.dir)).toEqual(before);
  });

  // An outage that answers 200 with `{}` (or a catalog without the providers) replaces the stored table of ~700 models with the dozen OpenRouter rows: "705 models gone" is
  // accepted as a big move (`commit`), stored, and every model but those is `unknown-model` until a later refresh works. A table that loses nearly every model it had is no repricing.
  for (const body of ["{}", '{"data":[]}', '{"anthropic":{"models":{}}}']) {
    test(`BUG-605/QA-cost-07: a catalog that answers ${body} does not replace the stored table (nearly every model gone is an outage, not a repricing)`, async () => {
      const w = world();
      const before = stored(w.dir);
      const had = Object.keys(w.tables().modelsdev!.entries).length;
      await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), modelsDev: () => body }).fetchText });
      expect(Object.keys(w.tables().modelsdev!.entries).length).toBe(had);
      expect(stored(w.dir)["modelsdev.json"]).toEqual(before["modelsdev.json"]!);
    });
  }
});

describe("BUG-605/variants: how much of the stored table may be gone", () => {
  /** A world whose stored table has 100 models: `real` that models.dev still lists and the rest gone from it. */
  const heldOf = (real: number) => {
    const w = world();
    const full = clone(readStoredTable("modelsdev", w.dir)!) as Record<string, any>;
    const keep = Object.keys(full.entries).filter((k) => !k.startsWith("openrouter/")).slice(0, real);
    const row = full.entries[keep[0]!];
    const entries: Record<string, unknown> = Object.fromEntries(keep.map((k) => [k, full.entries[k]]));
    for (let i = 0; Object.keys(entries).length < 100; i++) entries[`anthropic/qa-gone-${i}`] = row;
    const held = { ...full, entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1))), missing: [] };
    writeStoredTable("modelsdev", held, w.dir, false);
    w.registry.set({ modelsdev: readStoredTable("modelsdev", w.dir)! });
    return w;
  };
  const run = (w: ReturnType<typeof world>) => refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch().fetchText });

  test("exactly half gone is a table that moved on (written); one more is an outage (refused, the stored table stays, the exit code says so)", async () => {
    const half = heldOf(50);
    expect(Object.keys(half.tables().modelsdev!.entries)).toHaveLength(100);
    const ok = await run(half);
    expect(ok.reports[0]!.status).toBe("written");
    expect(ok.reports[0]!.detail).toContain("50 models gone");

    const more = heldOf(49);
    const before = stored(more.dir);
    const bad = await run(more);
    expect([bad.failed, bad.reports.map((r) => r.status)]).toEqual([true, ["refused"]]);
    expect(bad.reports[0]!.detail).toContain("51 of the 100 stored models are gone");
    // The way out is in the message: delete the stored file, then update.
    expect(bad.reports[0]!.detail).toContain(`delete ${more.file("modelsdev")} and run \`gluon pricing update\``);
    expect(stored(more.dir)).toEqual(before);
    expect(Object.keys(more.tables().modelsdev!.entries)).toHaveLength(100);
    expect(more.ledger).toEqual([]);
    expect(await pricingUpdate({ ...more.deps, source: SRC, fetchText: fakeFetch().fetchText, log: () => {}, error: () => {} })).toBe(1);
  });

  test("the way out the refusal names works: with the stored file gone the same answer is a first table", async () => {
    const more = heldOf(49);
    expect((await run(more)).reports[0]!.status).toBe("refused");
    rmSync(more.file("modelsdev"));
    // `gluon pricing update` is a new process: nothing in the registry.
    more.registry.set({ modelsdev: undefined });
    expect((await run(more)).reports[0]!.status).toBe("written");
  });

  test("a repricing is still accepted whatever its size, and a first table (nothing stored) is never a wipe", async () => {
    const w = world();
    const pricey = modelsDevCatalog((c) => {
      for (const p of Object.values(c)) for (const m of Object.values((p as { models: Record<string, any> }).models)) if (m.cost?.input) m.cost.input = Math.min(m.cost.input * 10, 4_000);
    });
    const r = await refreshNetworkTables({ ...w.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), modelsDev: () => JSON.stringify(pricey) }).fetchText });
    expect(r.reports[0]!.status).toBe("written");
    expect(r.reports[0]!.problems.length).toBeGreaterThan(0);
    const first = world({ seed: false });
    expect((await refreshNetworkTables({ ...first.deps, source: SRC, fetchText: fakeFetch({ ...fixtureSources(), modelsDev: () => '{"anthropic":{"models":{}}}' }).fetchText })).reports.map((x) => x.status)).toEqual(["written"]);
  });
});
