/**
 * A session whose price table isn't here yet (first run, the fetch still in flight) launches anyway and is priced retroactively once the table lands; a
 * session is pinned to the table it was priced with (issue #89, `src/cost/tracker.ts`). Offline: the tracker and the registry, nothing else.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { claudeContextWindow, ownWindow } from "../src/cost/context.ts";
import { Ledger, type DroppedEntry, type UsageEntry } from "../src/cost/ledger.ts";
import { currentTables, setTables, type ModelsDevTable, type Tables } from "../src/cost/tables.ts";
import { CostTracker, MAX_DEFERRED, type TrackerOptions } from "../src/cost/tracker.ts";
import { BilledMeter, Registry, TIMINGS, type Source } from "../src/openrouter-billed.ts";
import { FIXTURE_CODEX_WINDOWS, FIXTURE_MODELS_DEV } from "./fixtures/fixture-tables.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { MAX_PER_MINUTE, openLedgerFile, readLedger } from "../src/cost/ledger-file.ts";
import { reportLines } from "../src/cost/report.ts";
import { sanitize, type TablesEntry } from "../src/cost/ledger.ts";
import { tableInfos } from "../src/cost/tables.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["modelsdev", "claudeCatalog", "codexWindows", "grokModels"] as const;
let saved: Tables;
beforeEach(() => {
  saved = { ...currentTables() };
});
afterEach(() => {
  setTables(Object.fromEntries(KEYS.map((k) => [k, saved[k]])) as Tables);
});
/** No table at all, as on a first run. */
const emptyRegistry = () => setTables({ modelsdev: undefined, claudeCatalog: undefined, codexWindows: undefined, grokModels: undefined });

const usageOf = (l: Ledger) => l.entries.filter((e): e is UsageEntry => e.kind === "usage");
const droppedOf = (l: Ledger) => l.entries.filter((e): e is DroppedEntry => e.kind === "dropped");
const GROK = { model: "grok-4.7", input: 20_000, output: 500, reasoning: 200, cacheRead: 15_000, cacheWrite: 0 };
const TOKENS = { input: 12_345, output: 678, reasoning: 0, cache: { read: 4_000, write: 300 } };

/** Each harness's requests, as the channel would send them. */
const CASES: { name: string; opts: TrackerOptions; feed: (t: CostTracker) => void }[] = [
  {
    name: "Claude Code (its catalog)",
    opts: { harness: "claude-code", conn: "anthropic" },
    feed: (t) => {
      t.claudeRequest({ model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 5000, cacheWrite: 20_000 });
      t.claudeRequest({ model: "claude-haiku-4-5-20251001", input: 3333, output: 77, cacheRead: 0, cacheWrite: 0, subagent: true });
    },
  },
  {
    name: "Codex (models.dev)",
    opts: { harness: "codex", conn: "plan" },
    feed: (t) => {
      t.codexResponse({ model: "gpt-6-luna", input: 10_611, cached: 3_000, cacheWrite: 0, output: 228 });
      t.codexResponse({ model: "gpt-6-luna", input: 7_195, cached: 0, cacheWrite: 0, output: 115, serviceTier: "priority" });
    },
  },
  {
    name: "OpenCode (models.dev)",
    opts: { harness: "opencode", conn: "openrouter", launchedKey: "openrouter/deepseek/deepseek-v4-flash" },
    feed: (t) => {
      t.opencodeStep({ model: "openrouter/deepseek/deepseek-v4-flash", tokens: TOKENS });
      t.opencodeStep({ model: "openrouter/deepseek/deepseek-v4-flash", tokens: { ...TOKENS, input: 99 }, side: true });
    },
  },
  {
    name: "Grok Build (its table)",
    opts: { harness: "grok-build", conn: "plan" },
    feed: (t) => {
      t.grokRequest({ ...GROK, reportedMicros: 20_499 });
      t.grokRequest({ ...GROK, input: 1234, subagent: true });
    },
  },
  {
    name: "Kimi Code (models.dev)",
    opts: { harness: "kimi-code", conn: "openrouter", launchedKey: "openrouter/moonshotai/kimi-k3" },
    feed: (t) => t.kimiRecords([{ agentId: "a", model: "kimi-code/k3", inputOther: 4000, output: 300, inputCacheRead: 900, inputCacheCreation: 10 }]),
  },
];

describe("a session launched before its price table exists (issue #89)", () => {
  for (const c of CASES) {
    test(`BUG-512/pending-priced-on-arrival: ${c.name}: requests that arrive before the table are priced when it lands, to the last digit as if it had been there`, () => {
      const fresh = new Ledger();
      const ref = new CostTracker({ ...c.opts, ledger: fresh, now: () => 1000 });
      c.feed(ref);
      const refFigure = ref.figure();
      expect(refFigure).toBeDefined();
      expect(usageOf(fresh).length).toBeGreaterThan(0);

      const fixture = { ...currentTables() };
      emptyRegistry();
      const ledger = new Ledger();
      let told = 0;
      const t = new CostTracker({ ...c.opts, ledger, now: () => 2000, onTables: ({ priced }) => (told += priced) });
      c.feed(t);
      // Waiting: no figure (never `unknown-model`, which is a table without the model), no entry, a count of what waits.
      expect(t.figure()).toBeUndefined();
      expect(t.pendingNow()).toBe(usageOf(fresh).length);
      expect(usageOf(ledger)).toEqual([]);
      expect(t.usageExpected()).toBe(true);
      expect(t.requestsNow()).toBe(usageOf(fresh).length);
      expect(t.ownUsdNow()).toBe(0);

      setTables(fixture);
      expect(told).toBe(usageOf(fresh).length);
      expect(t.pendingNow()).toBe(0);
      expect(t.figure()).toEqual(refFigure!);
      expect(t.ownUsdNow()).toBe(ref.ownUsdNow());
      // The ledger has the same entries, in arrival order, each with the digest of the table that priced it (and the time it arrived).
      const strip = (e: UsageEntry) => ({ ...e, t: 0 });
      expect(usageOf(ledger).map(strip)).toEqual(usageOf(fresh).map(strip));
      expect(usageOf(ledger).every((e) => e.table !== "" && e.t === 2000)).toBe(true);
      expect(droppedOf(ledger)).toEqual([]);
      t.ended();
    });
  }

  test("BUG-512/pending-in-order: a request still waiting for a second table stays waiting, in order, while the first one's are priced", () => {
    const fixture = { ...currentTables() };
    emptyRegistry();
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "grok-build", conn: "plan", ledger });
    t.grokRequest({ ...GROK, model: "grok-4.7" });
    // Grok's own table arrives; a model it lacks falls to models.dev's price, which isn't here yet: that request keeps waiting.
    setTables({ grokModels: fixture.grokModels });
    expect(usageOf(ledger).map((e) => e.model)).toEqual(["grok-4.7"]);
    t.grokRequest({ ...GROK, model: "zz-not-in-grok-table" });
    expect(t.pendingNow()).toBe(1);
    expect(t.figure()).toBeUndefined();
    setTables({ modelsdev: fixture.modelsdev });
    expect(t.pendingNow()).toBe(0);
    // The model neither table lists is `unknown-model` now: the table is there, the model is not.
    expect(usageOf(ledger).map((e) => [e.model, e.assumptions.includes("unknown-model")])).toEqual([["grok-4.7", false], ["zz-not-in-grok-table", true]]);
    t.ended();
  });

  test("BUG-513/pinned-session: a refresh mid-session changes no figure of a session that was priced with a table; a session that waited pins the FIRST table that arrived", () => {
    const double = (m: ModelsDevTable): ModelsDevTable => ({ ...m, catalogDigest: "d".repeat(64), entries: Object.fromEntries(Object.entries(m.entries).map(([k, e]) => [k, { ...e, cost: { ...e.cost, input: (e.cost.input ?? 0) * 2, output: (e.cost.output ?? 0) * 2 } }])) });
    const step = { model: "openrouter/deepseek/deepseek-v4-flash", tokens: TOKENS };
    const ledger = new Ledger();
    const pinned = new CostTracker({ harness: "opencode", conn: "openrouter", ledger });
    pinned.opencodeStep(step);
    const before = pinned.ownUsdNow();
    expect(before).toBeGreaterThan(0);
    const tablesBefore = pinned.tables();
    setTables({ modelsdev: double(FIXTURE_MODELS_DEV) });
    pinned.opencodeStep(step);
    // The second request is priced by the same table as the first: exactly twice the first.
    expect(pinned.ownUsdNow()).toBe(before * 2);
    expect(pinned.tables()).toBe(tablesBefore);
    expect(usageOf(ledger).map((e) => e.table)).toEqual([FIXTURE_MODELS_DEV.catalogDigest.slice(0, 8), FIXTURE_MODELS_DEV.catalogDigest.slice(0, 8)]);
    // A session made after the refresh has the new table.
    const after = new CostTracker({ harness: "opencode", conn: "openrouter" });
    after.opencodeStep(step);
    expect(after.ownUsdNow()).toBeGreaterThan(before * 1.9);

    // A session that waited: the first table to arrive is its table; a later one prices nothing it holds.
    emptyRegistry();
    const waited = new CostTracker({ harness: "opencode", conn: "openrouter" });
    waited.opencodeStep(step);
    setTables({ modelsdev: FIXTURE_MODELS_DEV });
    const first = waited.ownUsdNow();
    expect(first).toBe(before);
    setTables({ modelsdev: double(FIXTURE_MODELS_DEV) });
    waited.opencodeStep(step);
    expect(waited.ownUsdNow()).toBe(first * 2);
  });

  test("BUG-514/pending-at-end: a session that ends with requests still waiting leaves a `dropped` marker with a reason, never silence; the harness's own total then stands in, marked; nothing is priced after the end", () => {
    const fixture = { ...currentTables() };
    emptyRegistry();
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "claude-code", conn: "anthropic", ledger });
    t.claudeRequest({ model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 0, cacheWrite: 0 });
    t.claudeRequest({ model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 0, cacheWrite: 0 });
    t.reportedCumulative(0.42);
    expect(t.figure()).toBeUndefined();
    t.ended();
    expect(droppedOf(ledger)).toEqual([expect.objectContaining({ what: "usage", reason: "no-price-table", count: 2, harness: "claude-code" })]);
    expect(t.pendingNow()).toBe(0);
    expect(t.figure()).toEqual({ usd: 0.42, approx: false, own: false });
    // The table arrives too late; a request after the end is a marker too, none is priced.
    setTables(fixture);
    t.claudeRequest({ model: "claude-opus-4-6", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
    expect(usageOf(ledger)).toEqual([]);
    expect(droppedOf(ledger).map((d) => [d.reason, d.count])).toEqual([["no-price-table", 2], ["no-price-table", 1]]);
  });

  test("BUG-514/no-subscription-left: a tracker that waited and ended holds no listener of the registry (a later table changes nothing and nothing throws)", () => {
    const fixture = { ...currentTables() };
    emptyRegistry();
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "codex", conn: "plan", ledger });
    t.codexResponse({ model: "gpt-6-luna", input: 10, cached: 0, cacheWrite: 0, output: 10 });
    t.ended();
    setTables(fixture);
    expect(usageOf(ledger)).toEqual([]);
    expect(t.tables().modelsdev).toBeUndefined();
  });

  test("BUG-515/buffer-overflow: past the cap the oldest request is dropped with a marker (counted as unpriced), the rest are priced on arrival", () => {
    const fixture = { ...currentTables() };
    emptyRegistry();
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "codex", conn: "plan", ledger });
    for (let i = 0; i < MAX_DEFERRED + 3; i++) t.codexResponse({ model: "gpt-6-luna", input: 100 + i, cached: 0, cacheWrite: 0, output: 10 });
    expect(t.pendingNow()).toBe(MAX_DEFERRED);
    expect(droppedOf(ledger).map((d) => [d.reason, d.count])).toEqual([["price-buffer-full", 1], ["price-buffer-full", 1], ["price-buffer-full", 1]]);
    setTables(fixture);
    expect(usageOf(ledger)).toHaveLength(MAX_DEFERRED);
    // The three oldest are the ones gone: the first priced request is the fourth.
    expect(usageOf(ledger)[0]!.counts.input).toBe(103);
    // Three requests had no price: the figure is not a sum that pretends to hold them (the harness's own total would stand in).
    expect(t.requestsNow()).toBe(MAX_DEFERRED + 3);
    expect(t.figure()).toMatchObject({ own: true });
    t.ended();
  });

  test("BUG-516/window-appears-late: the context window is unknown until the table it comes from is pinned; then the session is told, and later tables don't move it", () => {
    const fixture = { ...currentTables() };
    emptyRegistry();
    let told = 0;
    const t = new CostTracker({ harness: "codex", conn: "plan", onTables: () => told++ });
    expect(t.windowReady()).toBe(false);
    setTables({ codexWindows: fixture.codexWindows });
    expect(told).toBe(1);
    expect(t.windowReady()).toBe(true);
    const slug = Object.keys(FIXTURE_CODEX_WINDOWS.models).find((m) => m === "gpt-5.6-luna")!;
    const w = ownWindow("codex", slug, { tables: t.tables() }).window;
    expect(w).toBeGreaterThan(0);
    // A refresh with other windows: this session keeps its own.
    setTables({ codexWindows: { ...fixture.codexWindows!, models: { ...FIXTURE_CODEX_WINDOWS.models, [slug]: { context: 111_111, max: 111_111, percent: 100 } } } });
    expect(ownWindow("codex", slug, { tables: t.tables() }).window).toBe(w);
    expect(ownWindow("codex", slug).window).not.toBe(w);
    t.ended();
  });

  test("BUG-704/table-landed-before-first-use: a table that lands after the tracker is built and before its first request or window check still prices the session (issue #112)", () => {
    const fixture = { ...currentTables() };
    const feedClaude = (t: CostTracker) => t.claudeRequest({ model: "claude-opus-4-6", input: 1000, output: 600, cacheRead: 5000, cacheWrite: 20_000 });
    const ref = new CostTracker({ harness: "claude-code", conn: "anthropic", ledger: new Ledger(), now: () => 1000 });
    feedClaude(ref);
    const refFigure = ref.figure();
    expect(refFigure).toBeDefined();

    // The request first: the tracker has not listened yet when the table lands, and the request finds it already here.
    emptyRegistry();
    const ledger = new Ledger();
    let told = 0;
    const t = new CostTracker({ harness: "claude-code", conn: "anthropic", ledger, now: () => 2000, onTables: () => told++ });
    setTables({ modelsdev: fixture.modelsdev, claudeCatalog: fixture.claudeCatalog });
    feedClaude(t);
    expect(t.pendingNow()).toBe(0);
    expect(t.figure()).toEqual(refFigure!);
    expect(usageOf(ledger).length).toBe(1);
    expect(t.windowReady()).toBe(true);
    expect(told).toBe(1);
    t.ended();

    // The window check first: ready at once, told once, and no listener is left once every table it needs is pinned.
    emptyRegistry();
    let toldWindow = 0;
    const w = new CostTracker({ harness: "claude-code", conn: "anthropic", onTables: () => toldWindow++ });
    setTables({ modelsdev: fixture.modelsdev, claudeCatalog: fixture.claudeCatalog });
    expect(w.windowReady()).toBe(true);
    expect(toldWindow).toBe(1);
    expect(claudeContextWindow("claude-opus-4-6", {}, w.tables().claudeCatalog)).toBe(200_000);
    w.ended();
  });

  test("BUG-516/window-per-harness:Claude's window waits for its catalog (no name rule stands in), models.dev's for OpenCode, Antigravity and Kimi; Grok's for its own table", () => {
    const fixture = { ...currentTables() };
    emptyRegistry();
    const need = (h: Parameters<typeof ownWindow>[0], conn = "plan") => new CostTracker({ harness: h, conn: conn as never });
    const [claude, opencode, agy, kimi, grok] = [need("claude-code"), need("opencode"), need("antigravity"), need("kimi-code"), need("grok-build")];
    for (const t of [claude, opencode, agy, kimi, grok]) expect(t.windowReady()).toBe(false);
    setTables({ modelsdev: fixture.modelsdev });
    expect([claude, opencode, agy, kimi, grok].map((t) => t.windowReady())).toEqual([false, true, true, true, false]);
    setTables({ claudeCatalog: fixture.claudeCatalog });
    expect(claude.windowReady()).toBe(true);
    expect(claudeContextWindow("claude-opus-4-6", {}, claude.tables().claudeCatalog)).toBe(200_000);
    setTables({ grokModels: fixture.grokModels });
    expect(grok.windowReady()).toBe(true);
    for (const t of [claude, opencode, agy, kimi, grok]) t.ended();
  });

  test("BUG-517/no-calibration-while-pending: the live OpenRouter ratio isn't taken while a request waits for its price (the estimate it calibrates is only valid priced); the figure appears priced, uncalibrated", () => {
    const fixture = { ...currentTables() };
    emptyRegistry();
    const t = new CostTracker({ harness: "opencode", conn: "openrouter", launchedKey: "openrouter/deepseek/deepseek-v4-flash" });
    t.openrouterSession();
    t.opencodeStep({ model: "openrouter/deepseek/deepseek-v4-flash", tokens: TOKENS });
    t.setCalibration(1.7);
    expect(t.figure()).toBeUndefined();
    setTables(fixture);
    const priced = t.ownUsdNow();
    expect(priced).toBeGreaterThan(0);
    expect(t.figure()!.usd).toBe(priced);
    // Priced now: a live ratio is welcome again.
    t.setCalibration(2);
    expect(t.figure()!.usd).toBe(priced * 2);
    t.ended();
  });

  test("BUG-517/restate-drops-the-old-estimate: a meter restated after the late pricing calibrates only against an estimate that holds the requests (nothing before one lag), and keeps the time of the last request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-restate-"));
    try {
      let now = 1_000_000;
      let usage = 0;
      const source: Source = { base: "https://openrouter.test/api/v1", timings: { ...TIMINGS, sampleMs: 1000, lagMs: 60_000, readTimeoutMs: 1000 } };
      const fetch = async () => new Response(JSON.stringify({ data: { usage } }), { status: 200 });
      const ks: (number | undefined)[] = [];
      const meter = await BilledMeter.begin({ key: "sk-or-v1-0123456789abcdef", source, registry: new Registry(dir, { now: () => now, alive: () => true }), fetch, now: () => now, onCalibration: (k) => ks.push(k) });
      // A partial estimate while requests waited, then the late pricing at +30 s: the estimate is 2.0 from then on.
      meter.tick(5.0, true, 3);
      now += 30_000;
      meter.restate(2.0);
      meter.tick(2.0, true, 3);
      // A reading 80 s in holds requests up to 20 s: before the restate, the old 5.0 would be its estimate. No calibration from it.
      now += 50_000;
      usage = 1.0;
      meter.tick(2.1, true, 3);
      await Bun.sleep(5);
      expect(ks.filter((k) => k !== undefined)).toEqual([]);
      // One lag after the restate, the estimate is the restated one: k = billed / 2.0.
      now += 20_000;
      usage = 1.2;
      meter.tick(2.2, true, 3);
      await Bun.sleep(5);
      expect(ks.filter((k) => k !== undefined)).toEqual([0.6]);
      meter.abandon();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the ledger and the report of the tables (issue #89)", () => {
  const tablesEntry = (over: Partial<TablesEntry> = {}): TablesEntry => ({ kind: "tables", t: 1_791_000_000_000, table: "modelsdev", via: "network", digest: "abcdef12", fetchedAt: "2026-10-06T11:00:00.000Z", moved: 2, gone: 0, big: false, prices: [], ...over });

  test("BUG-518/dropped-marker-of-a-table-refresh: the marker for a capped `tables` entry (it has no harness) names none, never `claude-code`; the entry survives a file and the report says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-tables-ledger-"));
    try {
      const now = 1_791_000_000_000;
      const writer = openLedgerFile(join(dir, "gluon", "cost-audit"), { now: () => now, pid: 7 })!;
      for (let i = 0; i < MAX_PER_MINUTE + 5; i++) writer(tablesEntry({ t: now + i })!);
      writer.close();
      const entries = readLedger(join(dir, "gluon", "cost-audit"));
      const markers = entries.filter((e): e is DroppedEntry => e.kind === "dropped");
      expect(markers.length).toBeGreaterThan(0);
      expect(markers.every((m) => !("harness" in m) && m.reason === "rate-cap")).toBe(true);
      expect(sanitize({ kind: "dropped", t: 1, what: "usage", reason: "rate-cap", count: 2 })).toEqual({ kind: "dropped", t: 1, what: "usage", reason: "rate-cap", count: 2 });
      expect(sanitize({ kind: "dropped", t: 1, harness: "nobody", what: "usage", reason: "rate-cap", count: 2 })).not.toHaveProperty("harness");
      const text = reportLines(entries).join("\n");
      expect(text).toContain("no harness usage: rate-cap: 5");
      expect(text).not.toContain("claude-code usage: rate-cap");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("BUG-519/report-tables: each local table is listed with its source, date, when it was fetched and how many requests it priced; the table refreshes are summed", () => {
    const info = tableInfos().find((t) => t.source === "models.dev")!;
    expect(info.fetchedAt === undefined || typeof info.fetchedAt === "string").toBe(true);
    const t = { source: "models.dev", updatedAt: "2026-10-04T08:57:09.103Z", version: null, fetchedAt: "2026-10-06T11:00:00.000Z", digest: "3a1d9fce060e" };
    const used = { kind: "usage", t: 1, harness: "codex", model: "gpt-6-luna", connection: "openai", channel: "otel", counts: {}, ownMicros: 5, assumptions: [], table: "3a1d9fce" } as UsageEntry;
    const text = reportLines([used, used, { ...used, table: "00000000" }, tablesEntry({ moved: 3, big: true, gone: 1 }), tablesEntry(), tablesEntry({ table: "codex-windows", via: "binary", moved: 0 })], { now: Date.parse("2026-10-06T12:00:00Z"), tables: [t] }).join("\n");
    expect(text).toContain("price table: models.dev of 2026-10-04 (2 days old); priced 2 requests here; fetched 2026-10-06 11:00Z");
    expect(text).toContain("table refreshes that changed a table:\n  codex-windows (binary): 1 refresh, 0 prices moved\n  modelsdev (network): 2 refreshes, 5 prices moved, 1 gone, 1 big move");
    // A table nothing was priced by says 0, when the ledger has usage at all; without usage the line has no count.
    expect(reportLines([used], { tables: [{ ...t, digest: "ffffffff" }] })[0]).toContain("priced 0 requests here");
    expect(reportLines([], { tables: [t] })[0]).not.toContain("priced");
  });
});
