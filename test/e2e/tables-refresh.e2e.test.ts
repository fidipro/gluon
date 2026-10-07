/**
 * The price tables Gluon builds on the user's machine (issue #89, `src/cost/refresh.ts`), end to end: a local server stands in for models.dev and OpenRouter
 * (the test seam `GLUON_TEST_PRICING` points Gluon at it; release builds have no seam; without it a test reaches no network at all).
 * `gluon pricing update` writes the tables and says what moved; Gluon at start refreshes in the background and logs the moves in the audit ledger; a source
 * that never answers delays neither the home view nor a launch.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedger } from "../../src/cost/ledger-file.ts";
import { fixtureSources, modelsDevCatalog, openRouterListing, servePricing, type Sources } from "../fixtures/pricing-sources.ts";
import { WIN } from "./fixtures.ts";
import { gluon, launch, say } from "./gluon-kit.ts";
import { cli, SLOW, stopAll } from "./harness.ts";

setDefaultTimeout(60_000 * SLOW);
afterAll(stopAll);

const MODEL = "anthropic/claude-haiku-4.5";
/** The sources with OpenRouter's price for `MODEL` moved (the fixture's input price is 1). */
const moved = () => ({
  ...fixtureSources(),
  listing: () => {
    const listing = openRouterListing();
    listing.data.find((m) => m.id === MODEL)!.pricing.prompt = String(1.7 / 1e6);
    return JSON.stringify(listing);
  },
});

async function sandbox(sources: Sources = moved(), opts: { hold?: boolean; gate?: Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gluon-tables-e2e-"));
  const state = join(dir, "state");
  const server = servePricing(sources, opts);
  const seam = join(dir, "seam.json");
  // A gated server answers when the test says so: Gluon's own wait for it must outlast every step before that on a slow runner (BUG-512: the start's
  // refresh and the launch's both gave up after 5 s, before the test let go, and no table ever landed). Held ones never answer: 5 s is enough.
  writeFileSync(seam, JSON.stringify({ base: server.base, timeoutMs: opts.gate ? 60_000 : 5000 }));
  const stored = () => JSON.parse(readFileSync(join(state, "gluon", "tables", "modelsdev.json"), "utf8")).entries[`openrouter/${MODEL}`].cost.input as number;
  return { dir, state, server, seam, stored, env: { XDG_STATE_HOME: state, GLUON_TEST_PRICING: seam }, done: () => (server.stop(), rmSync(dir, { recursive: true, force: true })) };
}

test("BUG-509/e2e: `gluon pricing update` with no seam reaches no network in a test; with it, it writes the tables from the server, prints what moved, and offline it keeps them", async () => {
  const s = await sandbox();
  try {
    const none = await cli(["pricing", "update"], { env: { XDG_STATE_HOME: s.state } });
    expect([none.code, none.stderr]).toEqual([0, ""]);
    expect(none.stdout).toContain("Nothing to update: no network here");
    expect(s.server.seen).toEqual([]);
    const r = await cli(["pricing", "update"], { env: s.env });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toContain("modelsdev: written");
    // The fake `claude` on PATH carries a catalog like the real one: its table is built from it, the only source of Claude's.
    // (On Windows the fake `claude` is the one compiled fake agent, which carries no catalog.)
    if (!WIN) expect(r.stdout).toContain("claude-catalog: written");
    expect(s.server.seen.every((p) => p === "/api.json" || p.startsWith("/api/v1/models"))).toBe(true);
    expect(r.stdout).toContain(`moved openrouter/${MODEL}.cost.input: 1 -> 1.7`);
    expect(s.stored()).toBe(1.7);
    expect(s.server.seen).toContain("/api.json");
    // The server gone: the tables stay, and the command says nothing could be reached and exits 1 (never "every table is current").
    s.server.stop();
    const offline = await cli(["pricing", "update"], { env: s.env });
    expect(offline.code).toBe(1);
    expect(offline.stderr).toContain("Could not reach models.dev");
    expect(offline.stderr).toContain("kept the stored tables");
    expect(offline.stdout).toContain("modelsdev: unreachable");
    expect(offline.stdout).not.toContain("every table is current");
    expect(s.stored()).toBe(1.7);
    // A server that answers a malformed catalog: refused, exit 1, the stored table as it was.
    const bad = servePricing({ ...fixtureSources(), listing: () => JSON.stringify({ data: [] }) });
    writeFileSync(s.seam, JSON.stringify({ base: bad.base, timeoutMs: 5000 }));
    const refused = await cli(["pricing", "update"], { env: s.env });
    bad.stop();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("modelsdev: refused");
    expect(s.stored()).toBe(1.7);
  } finally {
    s.done();
  }
});

test.skipIf(WIN)("BUG-510/e2e: Gluon at start refreshes the prices in the background: the stored table and the registry's price move, and the ledger names the moved price @full", async () => {
  const s = await sandbox();
  const app = await gluon(100, 30, s.env);
  try {
    // Home was drawn without waiting for the sources; the table follows.
    const deadline = Date.now() + 20_000 * SLOW;
    while (s.stored() !== 1.7 && Date.now() < deadline) await Bun.sleep(100);
    expect(s.stored()).toBe(1.7);
    const dir = join(s.state, "gluon", "cost-audit");
    while (!existsSync(dir) && Date.now() < deadline) await Bun.sleep(100);
    await app.type("/exit");
    await app.press("\r");
    await app.exitCode();
    const entry = readLedger(dir).find((e) => e.kind === "tables" && e.table === "modelsdev");
    expect(entry).toMatchObject({ kind: "tables", via: "network", big: false, moved: 1, prices: [{ key: `openrouter/${MODEL}.cost.input`, from: 1, to: 1.7 }] });
    // Names and numbers: nothing of the server's answer but ids and prices.
    expect(readFileSync(join(dir, readdirSyncOne(dir)), "utf8")).not.toContain("127.0.0.1");
  } finally {
    s.done();
  }
});

test.skipIf(WIN)("BUG-511/e2e: a source that never answers delays neither the home view nor a launch, and nothing it holds is written @full", async () => {
  const s = await sandbox(moved(), { hold: true });
  try {
    const app = await gluon(100, 30, s.env);
    await launch(app, "fix the thing");
    // The refresh did start (it asked), and is still waiting: the stored prices are the fixture's.
    expect(s.server.seen).toContain("/api.json");
    expect(s.stored()).toBe(1);
  } finally {
    s.done();
  }
});

/** The digest a stored table carries (a ledger's usage entries name its first 8 characters). */
const digestOf = (state: string, file: string): string => JSON.parse(readFileSync(join(state, "gluon", "tables", file), "utf8")).catalogDigest;

test.skipIf(WIN)("BUG-512/e2e: a first run (no models.dev table yet) launches anyway; a model only models.dev prices shows no cost until the refresh lands, then the cost appears, and the ledger names models.dev's table @full", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // Claude Code's table is the installed `claude`'s own catalog, built at the launch with no network: a model it lists is priced from it alone (BUG-704/e2e).
  // The price that must wait for the refresh is one of a model only models.dev lists.
  const only = { ...fixtureSources(), modelsDev: () => JSON.stringify(modelsDevCatalog((c) => (c.anthropic.models["claude-legacy-9"] = { cost: { input: 3, output: 15 }, limit: { context: 200_000 } }))) };
  const s = await sandbox(only, { gate });
  const app = await gluon(100, 30, { ...s.env, GLUON_TEST_EMPTY_TABLES: "1" });
  try {
    await launch(app, "first run task");
    await say(app, "!otel 1 100000 claude-legacy-9", "OTEL 200,200");
    await app.idle();
    // The request is counted, waiting for its table: no cost. The context % is not waiting: Claude's window is its catalog's, which is here.
    const info = () => app.lines()[1]!;
    expect(info()).not.toMatch(/\$\d/);
    expect(s.server.seen).toContain("/api.json");
    expect(existsSync(join(s.state, "gluon", "tables", "modelsdev.json"))).toBe(false);
    release();
    await app.waitFor((t) => /· ~?\$[\d.]+ · \d+% context/.test(t.split("\n")[1]!), 20_000 * SLOW);
    await app.type("/exit");
    await app.press("\r");
    await app.exitCode();
    const usage = readLedger(join(s.state, "gluon", "cost-audit")).filter((e) => e.kind === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: "claude-legacy-9", table: digestOf(s.state, "modelsdev.json").slice(0, 8) });
  } finally {
    release();
    s.done();
  }
});

test.skipIf(WIN)("BUG-704/e2e: a first run's Claude catalog (built from the installed `claude` at the launch) that landed before the first request prices it at once, models.dev's refresh still held; the ledger names the catalog @full", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await sandbox(fixtureSources(), { gate });
  const app = await gluon(100, 30, { ...s.env, GLUON_TEST_EMPTY_TABLES: "1" });
  try {
    await launch(app, "first run task");
    await say(app, "!otel 1 100000 claude-opus-4-6", "OTEL 200,200");
    await app.waitFor((t) => /· ~?\$[\d.]+ · 50% context/.test(t.split("\n")[1]!), 20_000 * SLOW);
    // models.dev's table is not here (its refresh is held): Claude's own catalog priced the request and sized the window.
    expect(existsSync(join(s.state, "gluon", "tables", "modelsdev.json"))).toBe(false);
    await app.type("/exit");
    await app.press("\r");
    await app.exitCode();
    const usage = readLedger(join(s.state, "gluon", "cost-audit")).filter((e) => e.kind === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: "claude-opus-4-6", table: digestOf(s.state, "claude-catalog.json").slice(0, 8) });
  } finally {
    release();
    s.done();
  }
});

import { readdirSync } from "node:fs";
const readdirSyncOne = (dir: string): string => readdirSync(dir).filter((f) => f.endsWith(".jsonl"))[0]!;
