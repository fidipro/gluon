/**
 * The tables Gluon builds on the user's machine (issue #89), after an independent review (BUG-523 to 533): Claude's table comes from the installed binary alone,
 * the first session after a Claude Code upgrade is not pinned to the old catalog, `gluon pricing update` says when nothing was reachable, a user's NODE_ENV
 * does not switch a release build's refresh off, the fetch counts wire bytes, the store's directory is held like the ledger's, a request that can't be
 * priced doesn't lose the rest, Grok requests are priced when its table can't be built, the demo refreshes nothing, the refreshes don't overwrite each other, and Grok's
 * binary is scanned in chunks. Offline: injected fetch, spawn and bytes, a local server, and the registry.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { noInkDev } from "../scripts/build.ts";
import { defaultModels, defaultModelsInFile } from "../src/cost/grok-catalog.ts";
import { Ledger, type DroppedEntry, type UsageEntry } from "../src/cost/ledger.ts";
import { pricingUpdate } from "../src/cost/pricing-update.ts";
import { defaultFetch, refreshAllowed, refreshBinaryTables, refreshNetworkTables, refreshOpenRouterRow, type RefreshDeps } from "../src/cost/refresh.ts";
import { currentTables, setTableBuild, setTables, type ClaudeCatalog, type Tables } from "../src/cost/tables.ts";
import { cleanStaleTemps, readStoredTable, STALE_TEMP_MS, writeStoredTable } from "../src/cost/tables-store.ts";
import { CostTracker } from "../src/cost/tracker.ts";
import { FIXTURE_CLAUDE_CATALOG, FIXTURE_GROK_MODELS, FIXTURE_MODELS_DEV, FIXTURE_TABLES } from "./fixtures/fixture-tables.ts";
import { claudeCatalogLiteral, claudeFastFunction, fixtureSources, openRouterListing, servePricing, urlsFor } from "./fixtures/pricing-sources.ts";
import { seedTables } from "./fixtures/seed-tables.ts";

const ROOT = join(import.meta.dir, "..");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const scratches: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "gluon-hardening-"));
  scratches.push(d);
  return d;
};
const posix = process.platform !== "win32";

const KEYS = ["modelsdev", "claudeCatalog", "codexWindows", "grokModels"] as const;
let saved: Tables;
beforeEach(() => {
  saved = { ...currentTables() };
});
afterEach(() => {
  for (const k of KEYS) setTableBuild(k, "done");
  setTables(Object.fromEntries(KEYS.map((k) => [k, saved[k]])) as Tables);
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true });
});
const emptyRegistry = () => setTables({ modelsdev: undefined, claudeCatalog: undefined, codexWindows: undefined, grokModels: undefined });
const usageOf = (l: Ledger) => l.entries.filter((e): e is UsageEntry => e.kind === "usage");
const droppedOf = (l: Ledger) => l.entries.filter((e): e is DroppedEntry => e.kind === "dropped");

/** The same Claude catalog as another Claude Code version's: every price doubled, so a figure says which one priced it. */
const upgraded = (version: string): ClaudeCatalog => {
  const c = clone(FIXTURE_CLAUDE_CATALOG);
  for (const t of Object.values(c.pricingTiers)) for (const k of Object.keys(t) as (keyof typeof t)[]) if (k !== "long_prompt") t[k] *= 2;
  return { ...c, claudeCodeVersion: version, catalogDigest: "e".repeat(64) };
};
const OPUS = { model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 0, cacheWrite: 0 };
const STORED = FIXTURE_CLAUDE_CATALOG.claudeCodeVersion;

describe("BUG-523/no-claude-source: Claude's table comes only from the installed binary; nothing is asked of downloads.claude.ai", () => {
  test("no source, URL, seam key or fixture for a published Claude catalog is left in the code", () => {
    for (const f of ["src/cost/refresh.ts", "src/cost/pricing-update.ts", "src/cost/claude-catalog.ts", "src/cost/tables.ts", "src/cost/table-schema.ts"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect([f, /downloads\.claude\.ai|model-catalog\/v1|CLAUDE_CATALOG_URL|claude model catalog/.test(text)]).toEqual([f, false]);
    }
    for (const f of ["SECURITY.md", "docs/concepts/architecture.md", "CHANGELOG.md"]) {
      // CHANGELOG may say why it went; the others name only what is contacted.
      if (f !== "CHANGELOG.md") expect([f, readFileSync(join(ROOT, f), "utf8").includes("downloads.claude.ai")]).toEqual([f, false]);
    }
  });

  test("a network refresh asks models.dev and OpenRouter and writes no Claude table; with none stored it leaves none", async () => {
    const root = scratch();
    const dir = join(root, "tables");
    let tables: Tables = {};
    const asked: string[] = [];
    const sources = fixtureSources();
    const deps: RefreshDeps = {
      dir,
      restrict: false,
      registry: { get: () => tables, set: (p) => void (tables = { ...tables, ...p }) },
      source: urlsFor("http://127.0.0.1:1"),
      fetchText: async (url) => {
        asked.push(new URL(url).pathname);
        const p = new URL(url).pathname;
        return p === "/api.json" ? sources.modelsDev() : p === "/api/v1/models" ? sources.listing() : sources.endpoints(p.slice("/api/v1/models/".length, -"/endpoints".length));
      },
    };
    const r = await refreshNetworkTables(deps);
    expect(r.reports.map((x) => x.table)).toEqual(["modelsdev"]);
    expect(tables.claudeCatalog).toBeUndefined();
    expect(readdirSync(dir)).toEqual(["modelsdev.json"]);
    expect(asked.every((p) => p === "/api.json" || p.startsWith("/api/v1/models"))).toBe(true);
  });
});

describe("BUG-524/claude-upgrade: the first session after a Claude Code upgrade waits for the new catalog, and falls back to the stored one if its build fails", () => {
  const tracker = (version: string | undefined) => {
    const ledger = new Ledger();
    return { ledger, t: new CostTracker({ harness: "claude-code", conn: "anthropic", ledger, ...(version ? { harnessVersion: version } : {}) }) };
  };
  const priced = (c: ClaudeCatalog) => {
    const ref = new CostTracker({ harness: "claude-code", conn: "anthropic", claudeCatalog: c });
    ref.claudeRequest(OPUS);
    return ref.ownUsdNow();
  };

  test("the build of the installed version is running: the request waits, and is priced by the new table when it lands (never the old one)", () => {
    const next = upgraded("2.2.0");
    expect(priced(next)).toBeGreaterThan(priced(FIXTURE_CLAUDE_CATALOG));
    setTableBuild("claudeCatalog", "building");
    const { t, ledger } = tracker("2.2.0");
    t.claudeRequest(OPUS);
    expect([t.pendingNow(), t.figure(), t.windowReady()]).toEqual([1, undefined, false]);
    // A refresh of another table meanwhile (the network one) neither pins the old catalog nor releases the request.
    setTables({ modelsdev: clone(FIXTURE_MODELS_DEV) });
    expect([t.pendingNow(), usageOf(ledger)]).toEqual([1, []]);
    setTables({ claudeCatalog: next });
    setTableBuild("claudeCatalog", "done");
    expect(t.pendingNow()).toBe(0);
    expect(t.ownUsdNow()).toBe(priced(next));
    expect(usageOf(ledger)[0]!.table).toBe(next.catalogDigest.slice(0, 8));
    expect(t.tables().claudeCatalog).toBe(next);
    t.ended();
  });

  test("the build fails: the request is priced by the stored table (what the session would have had), nothing is dropped", () => {
    setTableBuild("claudeCatalog", "building");
    const { t, ledger } = tracker("2.2.0 (Claude Code)");
    t.claudeRequest(OPUS);
    expect(t.pendingNow()).toBe(1);
    setTableBuild("claudeCatalog", "failed");
    expect(t.pendingNow()).toBe(0);
    expect(t.ownUsdNow()).toBe(priced(FIXTURE_CLAUDE_CATALOG));
    expect(usageOf(ledger)[0]!.table).toBe(FIXTURE_CLAUDE_CATALOG.catalogDigest.slice(0, 8));
    expect(droppedOf(ledger)).toEqual([]);
    expect(t.windowReady()).toBe(true);
    t.ended();
  });

  test("no build under way (same version, or none running): priced at once from the stored table; a session that ends while waiting leaves a marker", () => {
    for (const version of [STORED, "2.2.0", undefined]) {
      const { t } = tracker(version);
      t.claudeRequest(OPUS);
      expect([version, t.pendingNow()]).toEqual([version, 0]);
      t.ended();
    }
    setTableBuild("claudeCatalog", "building");
    const same = tracker(STORED);
    same.t.claudeRequest(OPUS);
    expect(same.t.pendingNow()).toBe(0);
    const { t, ledger } = tracker("2.2.0");
    t.claudeRequest(OPUS);
    t.ended();
    expect(droppedOf(ledger)).toEqual([expect.objectContaining({ reason: "no-price-table", count: 1 })]);
  });

  test("refreshBinaryTables says a build is running before its first await, and done or failed after", async () => {
    const root = scratch();
    const dir = join(root, "tables");
    seedTables(dir);
    let tables: Tables = { claudeCatalog: readStoredTable("claude-catalog", dir)! };
    const rows = clone(FIXTURE_CLAUDE_CATALOG.fastPricing!);
    const bytes = Buffer.from(`\0${claudeFastFunction(rows)}\0var usr=${claudeCatalogLiteral()};\0`);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps: RefreshDeps = { dir, restrict: false, live: true, registry: { get: () => tables, set: (p) => void (tables = { ...tables, ...p }) }, bin: () => "/opt/claude", readBinary: async () => (await gate, bytes) };
    const { tableBuilding, tableBuildFailed } = await import("../src/cost/tables.ts");
    const run = refreshBinaryTables("claude-code", "9.1.0", deps);
    expect([tableBuilding("claudeCatalog"), tableBuildFailed("claudeCatalog")]).toEqual([true, false]);
    release();
    expect((await run).reports[0]).toMatchObject({ status: "written" });
    expect([tableBuilding("claudeCatalog"), tableBuildFailed("claudeCatalog")]).toEqual([false, false]);
    const bad = await refreshBinaryTables("claude-code", "9.2.0", { ...deps, readBinary: async () => Buffer.from("no catalog") });
    expect(bad.reports[0]).toMatchObject({ status: "unreadable" });
    expect([tableBuilding("claudeCatalog"), tableBuildFailed("claudeCatalog")]).toEqual([false, true]);
    // A binary that can't be read at all (a throw) is a failure too, not a build forever running.
    const boom = await refreshBinaryTables("claude-code", "9.3.0", { ...deps, readBinary: async () => Promise.reject(new Error("EACCES")) });
    expect(boom.reports[0]).toMatchObject({ status: "unreadable" });
    expect([tableBuilding("claudeCatalog"), tableBuildFailed("claudeCatalog")]).toEqual([false, true]);
  });
});

describe("BUG-525/pricing-update-offline: nothing reachable is said and exits 1; never 'every table is current'", () => {
  test("every source unreachable: stderr names what, the stored tables are kept, exit 1", async () => {
    const root = scratch();
    const dir = join(root, "tables");
    seedTables(dir);
    const before = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8"));
    const out: string[] = [];
    const err: string[] = [];
    const code = await pricingUpdate({ dir, restrict: false, source: urlsFor("http://127.0.0.1:1"), fetchText: async () => null, bin: () => undefined, registry: { get: () => ({}), set: () => {} }, log: (l) => out.push(l), error: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Could not reach models\.dev.*kept the stored tables/);
    expect(out.join("\n")).not.toContain("every table is current");
    expect(readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8"))).toEqual(before);
  });

  test("a table written from an installed binary while the network is down is a run that did something: exit 0, the unreachable source still said", async () => {
    const root = scratch();
    const dir = join(root, "tables");
    seedTables(dir);
    const codexDump = JSON.stringify({ models: [{ slug: "gpt-x", context_window: 200_000, max_context_window: 400_000, effective_context_window_percent: 90 }] });
    const out: string[] = [];
    let tables: Tables = {};
    const code = await pricingUpdate({
      dir,
      restrict: false,
      source: urlsFor("http://127.0.0.1:1"),
      live: true,
      fetchText: async () => null,
      bin: (h) => (h === "codex" ? "/opt/codex" : undefined),
      spawn: async (argv) => (argv[1] === "--version" ? "codex-cli 7.7.7\n" : codexDump),
      registry: { get: () => tables, set: (p) => void (tables = { ...tables, ...p }) },
      log: (l) => out.push(l),
      error: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("modelsdev: unreachable");
    expect(out.join("\n")).toContain("codex-windows: written");
  });
});

describe("BUG-526/release-node-env: a user's NODE_ENV=test does not switch a release build's refresh or billed reading off", () => {
  const ask = (file: string, expr: string): unknown => {
    const run = Bun.spawnSync([process.execPath, "--no-env-file", "--config=scripts/empty-bunfig.toml", "-e", `const m = await import(${JSON.stringify(file)}); console.log(JSON.stringify(${expr}))`], { cwd: ROOT, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    expect(run.stderr.toString()).toBe("");
    return JSON.parse(run.stdout.toString());
  };

  for (const flavor of ["release", "npm"]) {
    test(`${flavor} build: refresh sources and the billed reading are the real ones under NODE_ENV=test; the seam is not read`, async () => {
      const wrapper = (entry: string, name: string) => {
        const dir = scratch();
        const file = join(dir, `${name}.ts`);
        writeFileSync(file, `export { ${name} } from ${JSON.stringify(join(ROOT, entry))};\n`);
        return file;
      };
      const build = async (entry: string, name: string) => {
        const r = await Bun.build({ entrypoints: [wrapper(entry, name)], target: "bun", plugins: [noInkDev], define: { GLUON_BUILD: JSON.stringify(flavor), "process.env.NODE_ENV": JSON.stringify("production") } });
        expect(r.success).toBe(true);
        const file = join(scratch(), `${name}.js`);
        writeFileSync(file, await r.outputs[0]!.text());
        return file;
      };
      const pricing = await build("src/cost/refresh.ts", "pricingSource");
      const billed = await build("src/openrouter-billed.ts", "billedSource");
      expect(ask(pricing, 'm.pricingSource({ NODE_ENV: "test" })')).toEqual({ modelsDev: "https://models.dev/api.json", openrouter: "https://openrouter.ai/api/v1" });
      expect(ask(billed, 'm.billedSource({ NODE_ENV: "test" })')).toMatchObject({ base: "https://openrouter.ai/api/v1" });
      // The seams are not read at all in a release build (no GLUON_TEST_* may redirect it), and the probes seam is folded away too.
      expect(ask(pricing, 'm.pricingSource({ GLUON_TEST_PRICING: "/etc/passwd", GLUON_TEST_PROBES: "/x" })')).toMatchObject({ modelsDev: "https://models.dev/api.json" });
    });
  }

  test("from source (`bun test`, a test build) NODE_ENV=test still means no network", async () => {
    const { pricingSource } = await import("../src/cost/refresh.ts");
    const { billedSource } = await import("../src/openrouter-billed.ts");
    expect([pricingSource({ NODE_ENV: "test" }), billedSource({ NODE_ENV: "test" })]).toEqual([null, null]);
  });
});

describe("BUG-527/gzip-bomb: the size cap counts the bytes on the wire", () => {
  test("a compressed answer is refused unread (identity asked for, a content-encoding is no answer), and memory does not grow by what it would have inflated to", async () => {
    const asked: { encoding: string | null } = { encoding: null };
    const bomb = gzipSync(Buffer.alloc(200_000_000, 97));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        asked.encoding = req.headers.get("accept-encoding");
        return new Response(bomb, { headers: { "content-encoding": "gzip", "content-type": "application/json" } });
      },
    });
    try {
      const before = process.memoryUsage().rss;
      const text = await defaultFetch(`http://127.0.0.1:${server.port}/`, { timeoutMs: 10_000, maxBytes: 1_000_000 });
      expect(text).toBeNull();
      expect(asked.encoding).toBe("identity");
      expect(process.memoryUsage().rss - before).toBeLessThan(80_000_000);
    } finally {
      server.stop(true);
    }
  });

  test("a plain answer within its cap still arrives, and one over it by wire bytes is null", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(new URL(req.url).pathname === "/big" ? "x".repeat(2000) : '{"ok":true}', { headers: { "content-type": "application/json" } }) });
    try {
      expect(await defaultFetch(`http://127.0.0.1:${server.port}/`, { timeoutMs: 5000, maxBytes: 1000 })).toBe('{"ok":true}');
      expect(await defaultFetch(`http://127.0.0.1:${server.port}/big`, { timeoutMs: 5000, maxBytes: 1000 })).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});

describe("BUG-528/store-dir: the tables directory is held like the ledger's", () => {
  const table = () => ({ ...clone(FIXTURE_TABLES["codex-windows"]), fetchedAt: "2026-10-06T12:00:00.000Z" });

  test.skipIf(!posix)("an existing loose directory is tightened to 0700 on a write", () => {
    const dir = join(scratch(), "tables");
    mkdirSync(dir, { mode: 0o777 });
    chmodSync(dir, 0o777);
    writeStoredTable("codex-windows", table(), dir, false);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(readStoredTable("codex-windows", dir)).toBeDefined();
  });

  test.skipIf(!posix)("a symlinked directory is refused: nothing is written through it and nothing is read from it", () => {
    const root = scratch();
    const real = join(root, "elsewhere");
    mkdirSync(real);
    const link = join(root, "tables");
    symlinkSync(real, link);
    expect(() => writeStoredTable("codex-windows", table(), link, false)).toThrow(/not a real directory/);
    expect(readdirSync(real)).toEqual([]);
    writeStoredTable("codex-windows", table(), real, false);
    expect(readStoredTable("codex-windows", real)).toBeDefined();
    expect(readStoredTable("codex-windows", link)).toBeUndefined();
  });

  test.skipIf(!posix)("a path that is a file is refused", () => {
    const root = scratch();
    const file = join(root, "tables");
    writeFileSync(file, "x");
    expect(() => writeStoredTable("codex-windows", table(), file, false)).toThrow();
  });

  test("a killed write's temp directory is removed on the next write once it is an hour old; a fresh one (a write in progress) and other files stay", () => {
    const dir = join(scratch(), "tables");
    writeStoredTable("codex-windows", table(), dir, false);
    const old = join(dir, ".gluon-old1");
    const fresh = join(dir, ".gluon-new1");
    mkdirSync(old);
    writeFileSync(join(old, "codex-windows.json"), "{}");
    mkdirSync(fresh);
    const longAgo = new Date(Date.now() - STALE_TEMP_MS - 60_000);
    utimesSync(old, longAgo, longAgo);
    writeStoredTable("grok-models", { ...clone(FIXTURE_GROK_MODELS), fetchedAt: "2026-10-06T12:00:00.000Z" }, dir, false);
    expect(readdirSync(dir).sort()).toEqual([".gluon-new1", "codex-windows.json", "grok-models.json"]);
    expect(cleanStaleTemps(join(dir, "missing"))).toBe(0);
    expect(existsSync(old)).toBe(false);
  });
});

describe("BUG-529/replay-throw: one request that can't be priced does not lose the rest", () => {
  test("a throw while pricing a waiting request is a `price-error` marker, the others are priced in order", () => {
    emptyRegistry();
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "codex", conn: "plan", ledger });
    const good = { input: 10_611, cached: 3_000, cacheWrite: 0, output: 228 };
    t.codexResponse({ model: "gpt-6-luna", ...good });
    t.codexResponse({ model: "gpt-throw", ...good });
    t.codexResponse({ model: "gpt-6-luna", ...good });
    expect(t.pendingNow()).toBe(3);
    // A table whose entry for one model throws when read (a corrupt row).
    const poisoned = { ...FIXTURE_MODELS_DEV, entries: new Proxy(FIXTURE_MODELS_DEV.entries, { getOwnPropertyDescriptor: (target, key) => (key === "openai/gpt-throw" ? (() => { throw new Error("corrupt row"); })() : Reflect.getOwnPropertyDescriptor(target, key)) }) };
    setTables({ modelsdev: poisoned });
    expect(t.pendingNow()).toBe(0);
    expect(usageOf(ledger).map((e) => e.model)).toEqual(["gpt-6-luna", "gpt-6-luna"]);
    expect(droppedOf(ledger)).toEqual([expect.objectContaining({ reason: "price-error", count: 1, what: "usage" })]);
    expect(t.requestsNow()).toBe(3);
    t.ended();
  });
});

describe("BUG-530/grok-seed: Grok requests don't wait forever for a table that can't be built", () => {
  const GROK = { model: "grok-4.7", input: 20_000, output: 500, reasoning: 200, cacheRead: 15_000, cacheWrite: 0 };
  const grokOnly = () => setTables({ modelsdev: FIXTURE_MODELS_DEV, grokModels: undefined });

  test("the binary's table can't be built: waiting requests are priced from models.dev's xai price, marked `grok-seed-price`; later ones at once", () => {
    grokOnly();
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "grok-build", conn: "plan", ledger });
    t.grokRequest(GROK);
    expect(t.pendingNow()).toBe(1);
    // Not built yet and not failed either (a test, no refresh): the request keeps waiting.
    setTableBuild("grokModels", "building");
    expect(t.pendingNow()).toBe(1);
    setTableBuild("grokModels", "failed");
    expect(t.pendingNow()).toBe(0);
    const first = usageOf(ledger)[0]!;
    expect(first.assumptions).toContain("grok-seed-price");
    expect(first.ownMicros).toBeGreaterThan(0);
    t.grokRequest({ ...GROK, input: 1234 });
    expect(usageOf(ledger).map((e) => e.assumptions.includes("grok-seed-price"))).toEqual([true, true]);
    // An estimate (`~`): the seed is an assumption.
    expect(t.figure()).toMatchObject({ approx: true, own: true });
    expect(t.pendingNow()).toBe(0);
    t.ended();
    expect(droppedOf(ledger)).toEqual([]);
  });

  test("a request no models.dev price covers is `unknown-model` once the table can't come, never pending; without models.dev it still waits", () => {
    grokOnly();
    setTableBuild("grokModels", "failed");
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "grok-build", conn: "plan", ledger });
    t.grokRequest({ ...GROK, model: "zz-nobody" });
    expect(usageOf(ledger).map((e) => [e.model, e.assumptions])).toEqual([["zz-nobody", ["unknown-model"]]]);
    emptyRegistry();
    setTableBuild("grokModels", "failed");
    const waiting = new CostTracker({ harness: "grok-build", conn: "plan" });
    waiting.grokRequest(GROK);
    expect(waiting.pendingNow()).toBe(1);
    waiting.ended();
  });

  test("the build says failed for every way it can't be built: no version, no binary, a bad layout, a failed earlier try", async () => {
    const root = scratch();
    const dir = join(root, "tables");
    seedTables(dir);
    let tables: Tables = { modelsdev: readStoredTable("modelsdev", dir)! };
    const base: RefreshDeps = { dir, restrict: false, live: true, registry: { get: () => tables, set: (p) => void (tables = { ...tables, ...p }) } };
    const { tableBuildFailed } = await import("../src/cost/tables.ts");
    for (const [why, version, extra] of [
      ["no version", null, { bin: () => "/opt/grok" }],
      ["not installed", "1.9.0", { bin: () => undefined }],
      ["no catalog in the binary", "1.9.1", { bin: () => "/opt/grok", readBinary: () => Buffer.from("nothing") }],
    ] as const) {
      setTableBuild("grokModels", "done");
      await refreshBinaryTables("grok-build", version, { ...base, ...extra });
      expect([why, tableBuildFailed("grokModels")]).toEqual([why, true]);
    }
    // The same version again (it failed in this run): still failed, not "never tried".
    setTableBuild("grokModels", "done");
    await refreshBinaryTables("grok-build", "1.9.1", { ...base, bin: () => "/opt/grok", readBinary: () => Buffer.from("nothing") });
    expect(tableBuildFailed("grokModels")).toBe(true);
  });

  test("`grok usage` waits for the requests that wait for their table: it is not dropped while they do, and is audited once they are priced", () => {
    grokOnly();
    let now = 1_000;
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "grok-build", conn: "plan", ledger, now: () => now, grokUsageTimeoutMs: 100 });
    t.grokRequest({ ...GROK, reportedMicros: 20_000 });
    t.grokRequest({ ...GROK, reportedMicros: 20_000 });
    t.grokUsageReport({ turns: 1, micros: 40_000, partial: false, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, modelCalls: 2 });
    now += 10_000;
    t.grokUsageReport({ turns: 1, micros: 40_000, partial: false, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, modelCalls: 2 });
    expect(droppedOf(ledger)).toEqual([]);
    setTableBuild("grokModels", "failed");
    expect(t.pendingNow()).toBe(0);
    expect(ledger.entries.filter((e) => e.kind === "observation" && e.scope === "cumulative")).toHaveLength(1);
    expect(droppedOf(ledger)).toEqual([]);
    t.ended();
  });

  test("the session that ends while its requests still wait drops the report with them, never silence", () => {
    grokOnly();
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "grok-build", conn: "plan", ledger });
    t.grokRequest(GROK);
    t.grokUsageReport({ turns: 1, micros: 20_000, partial: false, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, modelCalls: 1 });
    t.ended();
    expect(droppedOf(ledger).map((d) => d.reason).sort()).toEqual(["grok-usage-unmatched", "no-price-table"]);
  });
});

describe("BUG-531/demo-no-refresh: the demo makes no network call, so it refreshes nothing", () => {
  test("`refreshAllowed`: not in the demo unless a test names a local server of its own; always outside it", () => {
    expect([refreshAllowed(false, {}), refreshAllowed(true, {})]).toEqual([true, false]);
    expect(refreshAllowed(true, { GLUON_TEST_PRICING: "/tmp/seam.json" })).toBe(true);
  });

  test("a release build's demo never refreshes, seam or not; and both refresh calls in `runGluon` are behind it", async () => {
    const dir = scratch();
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `export { refreshAllowed } from ${JSON.stringify(join(ROOT, "src/cost/refresh.ts"))};\n`);
    const r = await Bun.build({ entrypoints: [entry], target: "bun", define: { GLUON_BUILD: JSON.stringify("release"), "process.env.NODE_ENV": JSON.stringify("production") } });
    expect(r.success).toBe(true);
    const file = join(dir, "bundle.js");
    writeFileSync(file, await r.outputs[0]!.text());
    const run = Bun.spawnSync([process.execPath, "--no-env-file", "--config=scripts/empty-bunfig.toml", "-e", `const m = await import(${JSON.stringify(file)}); console.log(JSON.stringify([m.refreshAllowed(true, { GLUON_TEST_PRICING: "/x" }), m.refreshAllowed(false, {})]))`], { cwd: ROOT, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(run.stdout.toString())).toEqual([false, true]);
    const gluon = readFileSync(join(ROOT, "src/gluon.ts"), "utf8");
    expect(gluon).toMatch(/if \(refreshAllowed\(demo\)\) void refreshNetworkTables\(/);
    expect(gluon).toMatch(/if \(refreshAllowed\(demo\)\) \{\s*const launched[\s\S]{0,400}refreshOnLaunch\(/);
    expect(gluon.match(/refreshNetworkTables\(|refreshOnLaunch\(/g)).toHaveLength(2);
  });
});

describe("BUG-532/refresh-order: a network refresh and an OpenRouter row refresh never overwrite each other", () => {
  const ID = "anthropic/claude-haiku-4.5";
  const world = () => {
    const root = scratch();
    const dir = join(root, "tables");
    seedTables(dir);
    let tables: Tables = { modelsdev: readStoredTable("modelsdev", dir)! };
    let clock = Date.parse("2026-10-06T12:00:00Z");
    const deps: RefreshDeps = { dir, restrict: false, source: urlsFor("http://127.0.0.1:1"), registry: { get: () => tables, set: (p) => void (tables = { ...tables, ...p }) }, now: () => new Date((clock += 1000)) };
    return { deps, price: () => tables.modelsdev!.entries[`openrouter/${ID}`]!.cost.input as number };
  };
  /** Sources that say Haiku costs `network` on models.dev's OpenRouter listing, a row refresh `row` (a later listing), in the order they answer. */
  const listingAt = (price: number) => JSON.stringify(openRouterListing((l) => void (l.data.find((m) => m.id === ID)!.pricing.prompt = String(price / 1e6))));
  const fetchFor = (log: string[], listing: () => string, gate?: Promise<void>): RefreshDeps["fetchText"] => async (url) => {
    const p = new URL(url).pathname;
    log.push(p);
    if (gate && p === "/api/v1/models") await gate;
    const sources = fixtureSources();
    return p === "/api.json" ? sources.modelsDev() : p === "/api/v1/models" ? listing() : sources.endpoints(p.slice("/api/v1/models/".length, -"/endpoints".length));
  };

  test("a row refresh asked while a network one runs waits for it and lands after it: the newer row wins", async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    let listing = listingAt(3);
    // The network refresh's listing is held (and old: price 3); by the time the row refresh asks, OpenRouter says 4.
    const net = refreshNetworkTables({ ...w.deps, fetchText: fetchFor(log, () => listing, gate) });
    await Bun.sleep(5);
    const row = refreshOpenRouterRow(`openrouter/${ID}`, { ...w.deps, fetchText: fetchFor(log, () => listingAt(4)) });
    await Bun.sleep(20);
    // The row refresh has asked nothing yet: it is waiting.
    expect(log.filter((p) => p === "/api/v1/models")).toHaveLength(1);
    listing = listingAt(3);
    release();
    await Promise.all([net, row]);
    expect(w.price()).toBe(4);
  });

  test("a network refresh asked while a row refresh runs waits for it; the row it overwrites is newer data's, never older", async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    const row = refreshOpenRouterRow(`openrouter/${ID}`, { ...w.deps, fetchText: fetchFor(log, () => listingAt(5), gate) });
    await Bun.sleep(5);
    const net = refreshNetworkTables({ ...w.deps, fetchText: fetchFor(log, () => listingAt(6)) });
    await Bun.sleep(20);
    // The network refresh asked nothing yet (models.dev's catalog is its first request).
    expect(log).not.toContain("/api.json");
    release();
    await Promise.all([row, net]);
    expect(log.indexOf("/api.json")).toBeGreaterThan(log.indexOf(`/api/v1/models/${ID}/endpoints`));
    expect(w.price()).toBe(6);
  });
});

describe("BUG-533/grok-chunked-scan: Grok's embedded catalog is found without reading the whole binary into memory", () => {
  const catalog = JSON.stringify({ default: "grok-4.6", models: [{ id: "grok-chunky", context_window: 321_000, auto_compact_threshold_percent: 80 }, { id: "grok-other", context_window: 1_000_000 }] });
  const decoys = '{"models":[1]} "models": [ {"id":"x"} ] ';

  test("found wherever it sits, including across a chunk boundary, with the same result as the whole bytes", () => {
    const dir = scratch();
    for (const at of [0, 1_000, 99_990, 100_000 - 5, 199_000, 330_000]) {
      const bytes = Buffer.concat([Buffer.alloc(at, 0x61), Buffer.from(decoys), Buffer.from(catalog), Buffer.alloc(400_000 - at, 0x62), Buffer.from(decoys)]);
      const file = join(dir, `bin-${at}`);
      writeFileSync(file, bytes);
      const whole = defaultModels(bytes);
      expect(whole).not.toBeNull();
      // A small chunk, so the catalog straddles boundaries.
      const chunked = defaultModelsInFile(file, { chunk: 150_000 + 60_000, overlap: 60_000 });
      expect([at, chunked?.text]).toEqual([at, whole!.text]);
    }
  });

  test("a file with none is null; a small file (smaller than a chunk) works", () => {
    const dir = scratch();
    writeFileSync(join(dir, "none"), Buffer.alloc(500_000, 0x61));
    expect(defaultModelsInFile(join(dir, "none"), { chunk: 100_000, overlap: 20_000 })).toBeNull();
    writeFileSync(join(dir, "small"), Buffer.from(`xx${catalog}yy`));
    expect(defaultModelsInFile(join(dir, "small"))?.catalog.models.map((m) => m.id)).toEqual(["grok-chunky", "grok-other"]);
    writeFileSync(join(dir, "empty"), "");
    expect(defaultModelsInFile(join(dir, "empty"))).toBeNull();
  });

  test("the refresh reads Grok's binary through the scan unless a test injects bytes: a real file gives the table", async () => {
    const dir = scratch();
    const bin = join(dir, "grok");
    writeFileSync(bin, Buffer.concat([Buffer.alloc(50_000, 0x61), Buffer.from(catalog), Buffer.alloc(50_000, 0x62)]));
    const store = join(dir, "tables");
    seedTables(store);
    let tables: Tables = { modelsdev: readStoredTable("modelsdev", store)! };
    const r = await refreshBinaryTables("grok-build", "7.0.0", { dir: store, restrict: false, live: true, bin: () => bin, registry: { get: () => tables, set: (p) => void (tables = { ...tables, ...p }) } });
    expect(r.reports[0]).toMatchObject({ table: "grok-models", status: "written" });
    expect(tables.grokModels!.models["grok-chunky"]).toMatchObject({ context: 321_000, source: "binary", autoCompactPercent: 80 });
  });
});
