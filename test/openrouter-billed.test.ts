/**
 * What OpenRouter billed an OpenRouter session (`src/openrouter-billed.ts`, `src/cost/billed.ts`): the key's usage read before and after, settled
 * after OpenRouter's lag; a session that shared the key with another is no one's; a live figure calibrated against the lagged usage.
 * Offline: a fake `/api/v1/key` (an injected fetch), the real registry in a temp directory, the real tracker and ledger.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ratio, brainSpend, BrainSpend, EstimateHistory, overlap } from "../src/cost/billed.ts";
import { brainFor, probeStep } from "../src/brain.ts";
import { defaults } from "../src/config.ts";
import type { ModelClient } from "../src/agent/session.ts";
import { Ledger, sanitize } from "../src/cost/ledger.ts";
import { reportLines } from "../src/cost/report.ts";
import { priceEntry, type ModelsDevTable } from "../src/cost/tables.ts";
import { FIXTURE_MODELS_DEV as MODELS_DEV } from "./fixtures/fixture-tables.ts";
import { CostTracker } from "../src/cost/tracker.ts";
import { wantedKeys } from "../scripts/pricing/modelsdev.ts";
import { billedSource, BilledMeter, BrainLog, keyTag, readUsage, Registry, settled, STALE_MS, TIMINGS, type BilledResult, type Source, type Timings } from "../src/openrouter-billed.ts";
import { costLabel } from "../src/sessions.ts";
import { BUN_FLAGS, SLOW } from "./e2e/harness.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-or-billed-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(TMP, `r${++n}`);
const KIMI_KEY = "openrouter/moonshotai/kimi-k3";
const KIMI_INPUT = priceEntry(KIMI_KEY)!.cost.input!;
/** The table with Kimi K3 at one endpoint price (as the generator would write it for a model OpenRouter serves from one provider). */
const oneEndpoint = (): ModelsDevTable => ({ ...MODELS_DEV, entries: { ...MODELS_DEV.entries, [KIMI_KEY]: { ...MODELS_DEV.entries[KIMI_KEY]!, endpoints: { count: 1, input: { min: 1, max: 1 }, output: { min: 2, max: 2 } } } } });
const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

const FAST: Timings = { ...TIMINGS, pollMs: 4, settleMs: 12, landMs: 120, giveUpMs: 400, sampleMs: 40_000, readTimeoutMs: 1000, tailMs: 60, lagMs: 60_000 };
const source = (over: Partial<Timings> = {}): Source => ({ base: "https://openrouter.test/api/v1", timings: { ...FAST, ...over } });

/** A fake `/api/v1/key`: each read gives the next usage (the last one repeats); records the headers it was sent. */
function fakeKey(usages: number[] | (() => number)) {
  const calls: { url: string; auth: string | null }[] = [];
  let i = 0;
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, auth: init.headers.authorization ?? null });
    const usage = typeof usages === "function" ? usages() : usages[Math.min(i++, usages.length - 1)]!;
    return new Response(JSON.stringify({ data: { usage, limit: null } }), { status: 200 });
  };
  return { fetch, calls };
}

const settledTo = (m: BilledMeter) => m.finish();

describe("BUG-481/the key's usage over a session is what OpenRouter billed it", () => {
  test("BUG-481/clean delta: usage before and after, both settled: the session's figure, audited against ours with the provider-price cause", async () => {
    const dir = fresh();
    const key = fakeKey([10, 10.37, 10.37, 10.37]);
    const results: BilledResult[] = [];
    const ledger = new Ledger();
    const tracker = new CostTracker({ harness: "opencode", conn: "openrouter", launchedKey: KIMI_KEY, ledger });
    tracker.openrouterSession();
    const m = await BilledMeter.begin({ key: KEY, source: source(), registry: new Registry(dir), fetch: key.fetch, onSettled: (r) => results.push(r) });
    const r = await settledTo(m);
    expect(r.status).toBe("clean");
    expect(r.status === "clean" && Math.round(r.usd * 1e6)).toBe(370_000);
    expect(results).toHaveLength(1);
    // The tracker's own sum is the table price; OpenRouter billed more: the billed figure replaces it and the ledger names why.
    tracker.opencodeStep({ model: "openrouter/moonshotai/kimi-k3", tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
    const own = tracker.figure()!;
    expect(own).toMatchObject({ approx: true });
    expect(own.billed).toBeUndefined();
    const notes: string[] = [];
    settled(r, { tracker, ledger, harness: "opencode", note: (x) => notes.push(x) });
    expect(tracker.figure()).toEqual({ usd: r.status === "clean" ? r.usd : 0, approx: false, own: true, billed: true });
    expect(costLabel(tracker.figure()).endsWith("✓")).toBe(true);
    expect(notes[0]).toContain("OpenRouter billed $0.37✓");
    const obs = ledger.entries.find((e) => e.kind === "observation" && e.scope === "billed");
    expect(obs).toMatchObject({ kind: "observation", scope: "billed", reportedMicros: 370_000, cause: "openrouter-provider-price" });
    expect(obs && "ownMicros" in obs && obs.ownMicros).toBe(Math.round(own.usd * 1e6));
  });

  test("BUG-481/a billed delta that equals ours (a single-price model) is `none`, not a cause", async () => {
    const ledger = new Ledger();
    const tracker = new CostTracker({ harness: "opencode", conn: "openrouter", launchedKey: KIMI_KEY, table: oneEndpoint(), ledger });
    tracker.openrouterSession();
    tracker.opencodeStep({ model: "openrouter/moonshotai/kimi-k3", tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
    const ours = tracker.ownUsdNow();
    expect(tracker.figure()).toMatchObject({ approx: false });
    tracker.billed(ours);
    expect(ledger.entries.find((e) => e.kind === "observation" && e.scope === "billed")).toMatchObject({ cause: "none" });
  });

  test("BUG-482/lag then settle: usage still rising after the exit is not settled; two equal readings after the settle time are", async () => {
    const key = fakeKey([5, 5.1, 5.4, 5.62, 5.62, 5.62, 5.62]);
    const m = await BilledMeter.begin({ key: KEY, source: source(), registry: new Registry(fresh()), fetch: key.fetch });
    const t0 = Date.now();
    const r = await m.finish();
    expect(r.status === "clean" && Math.round(r.usd * 1e6)).toBe(620_000);
    // It read until the rise stopped (the baseline, then each reading up to two equal ones), and waited the settle time.
    expect(key.calls.length).toBeGreaterThanOrEqual(5);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FAST.settleMs);
  });

  test("BUG-482/a usage that never stops moving is given up on: unsettled, no figure", async () => {
    let u = 1;
    const key = fakeKey(() => (u += 0.01));
    const m = await BilledMeter.begin({ key: KEY, source: source({ giveUpMs: 60 }), registry: new Registry(fresh()), fetch: key.fetch });
    expect(await m.finish()).toEqual({ status: "unsettled", why: "timeout" });
  });

  test("BUG-482/no baseline (the key can't be read at the start) or no reading at the end: no figure, said", async () => {
    const down = async () => new Response("{}", { status: 503 });
    const m = await BilledMeter.begin({ key: KEY, source: source(), registry: new Registry(fresh()), fetch: down });
    expect(await m.finish()).toEqual({ status: "unreadable", why: "no-baseline" });
    let first = true;
    const flaky = async () => (first ? ((first = false), new Response(JSON.stringify({ data: { usage: 2 } }))) : new Response("{}", { status: 500 }));
    const m2 = await BilledMeter.begin({ key: KEY, source: source({ giveUpMs: 40 }), registry: new Registry(fresh()), fetch: flaky });
    expect(await m2.finish()).toEqual({ status: "unreadable", why: "read-failed" });
    // A usage that went down (a deleted and recreated key) is no delta.
    const k3 = fakeKey([9, 3, 3, 3]);
    const m3 = await BilledMeter.begin({ key: KEY, source: source(), registry: new Registry(fresh()), fetch: k3.fetch });
    expect(await m3.finish()).toEqual({ status: "unreadable", why: "negative" });
  });
});

describe("BUG-483/a delta is the session's only if no other OpenRouter session of Gluon shared the key meanwhile", () => {
  test("BUG-483/same process: two sessions that overlap get no figure, each", async () => {
    const dir = fresh();
    const reg = new Registry(dir);
    const a = fakeKey([1, 1.5, 1.5, 1.5]);
    const b = fakeKey([1, 2, 2, 2]);
    const ma = await BilledMeter.begin({ key: KEY, source: source(), registry: reg, fetch: a.fetch });
    const mb = await BilledMeter.begin({ key: KEY, source: source(), registry: reg, fetch: b.fetch });
    const [ra, rb] = await Promise.all([ma.finish(), mb.finish()]);
    expect(ra).toEqual({ status: "overlap" });
    expect(rb).toEqual({ status: "overlap" });
    const ledger = new Ledger();
    const tracker = new CostTracker({ harness: "codex", conn: "openrouter", ledger });
    const notes: string[] = [];
    settled(ra, { tracker, ledger, harness: "codex", note: (x) => notes.push(x) });
    expect(notes[0]).toBe("no billed figure: another OpenRouter session ran at the same time on this key.");
    expect(ledger.entries).toContainEqual(expect.objectContaining({ kind: "dropped", reason: "openrouter-overlap" }));
    expect(tracker.figure()).toBeUndefined();
  });

  test("BUG-483/one that started after the other ended, but before its usage had settled, overlaps it; one after the settle does not", async () => {
    const dir = fresh();
    const reg = new Registry(dir);
    const a = fakeKey([1, 1.5, 1.5, 1.5]);
    const ma = await BilledMeter.begin({ key: KEY, source: source(), registry: reg, fetch: a.fetch });
    const pa = ma.finish();
    // A is settling (its usage is still landing): B starts now.
    const mb = await BilledMeter.begin({ key: KEY, source: source(), registry: reg, fetch: fakeKey([1.5]).fetch });
    expect(await pa).toEqual({ status: "overlap" });
    expect((await mb.finish()).status).toBe("overlap");
    // C starts once both windows are over: clean.
    await Bun.sleep(FAST.tailMs + 10);
    const mc = await BilledMeter.begin({ key: KEY, source: source(), registry: reg, fetch: fakeKey([2, 2.25, 2.25, 2.25]).fetch });
    const rc = await mc.finish();
    expect(rc.status === "clean" && Math.round(rc.usd * 1e6)).toBe(250_000);
  });

  test("BUG-483/another key is no overlap", async () => {
    const reg = new Registry(fresh());
    const ma = await BilledMeter.begin({ key: KEY, source: source(), registry: reg, fetch: fakeKey([1, 1.5, 1.5, 1.5]).fetch });
    const mb = await BilledMeter.begin({ key: `${KEY}-other`, source: source(), registry: reg, fetch: fakeKey([7, 8, 8, 8]).fetch });
    const [ra, rb] = await Promise.all([ma.finish(), mb.finish()]);
    expect(ra.status).toBe("clean");
    expect(rb.status).toBe("clean");
  });

  test("BUG-484/two Gluon processes: a session running in another process is seen through the registry file; once that process is gone its window ends at its last touch plus the lag tail", async () => {
    const dir = fresh();
    // The other process: registers a running session on the same key and stays until its stdin closes.
    const script = join(TMP, "other-gluon.ts");
    writeFileSync(
      script,
      `import { Registry, keyTag } from ${JSON.stringify(join(import.meta.dir, "../src/openrouter-billed.ts"))};
const r = new Registry(${JSON.stringify(dir)});
r.register("deadbeef", keyTag(${JSON.stringify(KEY)}), Date.now() - 1000);
console.log("registered");
await Bun.stdin.text();`,
    );
    const child = Bun.spawn([process.execPath, ...BUN_FLAGS, script], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("registered");
      const reg = new Registry(dir);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(`${child.pid}-deadbeef.json`);
      const m = await BilledMeter.begin({ key: KEY, source: source(), registry: reg, fetch: fakeKey([1, 1.5, 1.5, 1.5]).fetch });
      expect(await m.finish()).toEqual({ status: "overlap" });
    } finally {
      child.stdin.end();
      await child.exited;
    }
    // It died without ending its window (a crash): ended at the file's last touch plus the tail.
    for (const f of readdirSync(dir)) if (!f.startsWith(`${child.pid}-`)) rmSync(join(dir, f));
    const reg = new Registry(dir);
    const windows = reg.others("none", keyTag(KEY));
    expect(windows).toHaveLength(1);
    expect(windows[0]!.end).toBeDefined();
    await Bun.sleep(FAST.tailMs + 20);
    const m2 = await BilledMeter.begin({ key: KEY, source: source(), registry: new Registry(dir, { tailMs: FAST.tailMs }), fetch: fakeKey([3, 3.5, 3.5, 3.5]).fetch });
    expect((await m2.finish()).status).toBe("clean");
  });

  test("BUG-484/the registry: private directory made first, one file per session, a key's hash and never the key, a stale window removed", () => {
    const dir = join(fresh(), "gluon", "openrouter-sessions");
    let t = 1_000_000_000_000;
    const reg = new Registry(dir, { now: () => t, pid: 4242, alive: () => false, tailMs: 10 });
    reg.register("aaaaaaaa", keyTag(KEY), t);
    const text = readFileSync(join(dir, "4242-aaaaaaaa.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ v: 1, pid: 4242, key: keyTag(KEY), start: t });
    expect(text).not.toContain(KEY);
    if (process.platform !== "win32") expect(require("node:fs").statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).filter((f) => f.startsWith("."))).toEqual([]);
    reg.close("aaaaaaaa", t + 5);
    expect(JSON.parse(readFileSync(join(dir, "4242-aaaaaaaa.json"), "utf8")).end).toBe(t + 5);
    // Another session sees the window; garbage in the directory is skipped, never trusted.
    writeFileSync(join(dir, "9-bad.json"), "{not json");
    writeFileSync(join(dir, "9-wrong.json"), JSON.stringify({ pid: "x" }));
    const other = new Registry(dir, { now: () => t, alive: () => false });
    expect(other.others("bbbbbbbb", keyTag(KEY))).toEqual([{ start: t, end: t + 5 }]);
    expect(other.others("aaaaaaaa", keyTag(KEY))).toEqual([]);
    // A day later it is gone.
    t += 86_400_000 + 1000;
    expect(new Registry(dir, { now: () => t, alive: () => false }).others("bbbbbbbb", keyTag(KEY))).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.startsWith("4242"))).toEqual([]);
    mkdirSync(join(dir, "x"), { recursive: true });
    utimesSync(join(dir, "x"), new Date(), new Date());
  });

  test("BUG-484/the windows' arithmetic: touching windows don't overlap, an open one reaches to the end of time", () => {
    expect(overlap({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
    expect(overlap({ start: 0, end: 11 }, { start: 10, end: 20 })).toBe(true);
    expect(overlap({ start: 50 }, { start: 0, end: 20 })).toBe(false);
    expect(overlap({ start: 5 }, { start: 0, end: 20 })).toBe(true);
    expect(overlap({ start: 5 }, { start: 100 })).toBe(true);
  });
});

describe("BUG-485/Gluon quitting first", () => {
  test("BUG-485/quit before the figure settles: an unsettled record and no figure; the window keeps the lag tail for the next session", async () => {
    const dir = fresh();
    const reg = new Registry(dir);
    let u = 1;
    const key = fakeKey(() => (u += 0.5));
    const ledger = new Ledger();
    const tracker = new CostTracker({ harness: "claude-code", conn: "openrouter", ledger });
    const notes: string[] = [];
    const m = await BilledMeter.begin({ key: KEY, source: source({ giveUpMs: 5000, pollMs: 50 }), registry: reg, fetch: key.fetch, onSettled: (r) => settled(r, { tracker, ledger, harness: "claude-code", note: (x) => notes.push(x) }) });
    const p = m.finish();
    await Bun.sleep(20);
    const before = Date.now();
    m.abandon();
    await p;
    expect(ledger.entries).toContainEqual(expect.objectContaining({ kind: "dropped", what: "cost", reason: "openrouter-unsettled" }));
    expect(ledger.entries.some((e) => e.kind === "observation" && e.scope === "billed")).toBe(false);
    expect(tracker.figure()).toBeUndefined();
    expect(notes).toEqual([]);
    // The window ended at the quit plus the tail: a session starting inside it overlaps; the registry says so.
    const [w] = new Registry(dir).others("zzzzzzzz", keyTag(KEY));
    expect(w!.end!).toBeGreaterThanOrEqual(before + FAST.tailMs - 5);
    // It stopped reading: no more requests after the quit.
    const calls = key.calls.length;
    await Bun.sleep(80);
    expect(key.calls.length).toBe(calls);
  });

  test("BUG-485/a launch that failed leaves no window and no record", async () => {
    const reg = new Registry(fresh());
    const ledger = new Ledger();
    const m = await BilledMeter.begin({ key: KEY, source: source(), registry: reg, fetch: fakeKey([1]).fetch, onSettled: () => ledger.add({ kind: "dropped", t: 1, harness: "codex", what: "cost", reason: "x", count: 1 }) });
    m.cancel();
    expect(ledger.entries).toEqual([]);
    const [w] = reg.others("zzzzzzzz", keyTag(KEY));
    expect(w!.end).toBeDefined();
  });
});

describe("BUG-486/the key is never logged", () => {
  test("BUG-486/it travels only in the Authorization header: not in a file, the ledger, a note, process.env, or an error", async () => {
    const dir = fresh();
    const ledger = new Ledger();
    const tracker = new CostTracker({ harness: "codex", conn: "openrouter", ledger });
    const notes: string[] = [];
    const key = fakeKey([1, 2, 2, 2]);
    const before = JSON.stringify(process.env);
    const m = await BilledMeter.begin({ key: KEY, source: source(), registry: new Registry(dir), fetch: key.fetch, onSettled: (r) => settled(r, { tracker, ledger, harness: "codex", note: (x) => notes.push(x) }) });
    await m.finish();
    expect(key.calls.every((c) => c.auth === `Bearer ${KEY}` && !c.url.includes(KEY))).toBe(true);
    const everything = [...notes, JSON.stringify(ledger.entries), ...readdirSync(dir).map((f) => `${f}\n${readFileSync(join(dir, f), "utf8")}`)].join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("sk-or-");
    expect(JSON.stringify(process.env)).toBe(before);
    // A failing request that names the key in its error says nothing of it.
    const boom = async () => {
      throw new Error(`connect to openrouter.ai failed for Bearer ${KEY}`);
    };
    expect(await readUsage(KEY, source(), boom as never)).toBeUndefined();
    const bad = async () => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 });
    expect(await readUsage(KEY, source(), bad)).toBeUndefined();
  });
});

describe("BUG-487/the live figure: calibrated against the lagged usage, ours until then", () => {
  /** A session on a fake clock: our estimate grows 0.01 per 10 s; OpenRouter's usage is what the provider's price made of the estimate one lag ago. */
  async function session(factor: (t: number) => number, o: { overlapAt?: number; idleFrom?: number } = {}) {
    let now = 1_000_000;
    const lag = 60_000;
    const ours = (t: number) => (o.idleFrom !== undefined ? Math.min(t, o.idleFrom) : t) / 10_000 * 0.01;
    const log: [number, number][] = [];
    // Billed so far (what the key shows at `t`): the integral of our increments at the price then, up to one lag ago.
    const billedAt = (t: number) => {
      let b = 0;
      for (let s = 0; s < t - lag; s += 1000) b += (ours(s + 1000) - ours(s)) * factor(s);
      return b;
    };
    const started = now;
    const reads: number[] = [];
    const fetch = async () => {
      reads.push(now);
      return new Response(JSON.stringify({ data: { usage: 20 + billedAt(now - started) } }));
    };
    const dir = fresh();
    const reg = new Registry(dir, { now: () => now, alive: () => true });
    const ks: (number | undefined)[] = [];
    const m = await BilledMeter.begin({ key: KEY, source: { base: "x", timings: { ...FAST, sampleMs: 45_000, lagMs: lag } }, registry: reg, fetch, now: () => now, onCalibration: (k) => ks.push(k) });
    const tracker = new CostTracker({ harness: "opencode", conn: "openrouter", launchedKey: KIMI_KEY });
    tracker.openrouterSession();
    const other = new Registry(dir, { now: () => now, alive: () => true, pid: 1 });
    const figures: { t: number; shown: number; table: number }[] = [];
    for (let step = 1; step <= 40; step++) {
      now = started + step * 10_000;
      const t = now - started;
      if (o.overlapAt !== undefined && t === o.overlapAt) other.register("cafecafe", keyTag(KEY), now - 5000);
      const e = ours(t);
      // The tracker's own sum, as the steps would have made it.
      const delta = e - tracker.ownUsdNow();
      if (delta > 0) tracker.opencodeStep({ model: "openrouter/moonshotai/kimi-k3", tokens: { input: Math.round((delta / KIMI_INPUT) * 1_000_000), output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
      m.tick(tracker.ownUsdNow());
      await Bun.sleep(3);
      tracker.setCalibration(ks.at(-1));
      figures.push({ t, shown: tracker.figure()?.usd ?? 0, table: tracker.ownUsdNow() });
    }
    return { ks, figures, reads, tracker };
  }

  test("BUG-487/a cheap provider: k from a lagged series, the figure drops below the table price before the session ends", async () => {
    const s = await session(() => 0.4);
    const k = s.ks.filter((x): x is number => x !== undefined).at(-1)!;
    expect(k).toBeGreaterThan(0.38);
    expect(k).toBeLessThan(0.42);
    const last = s.figures.at(-1)!;
    expect(last.shown).toBeLessThan(last.table * 0.45);
    expect(s.tracker.figure()).toMatchObject({ approx: true });
    // Before the first usable ratio the figure is the table price.
    expect(s.figures[0]!.shown).toBeCloseTo(s.figures[0]!.table, 6);
  });

  test("BUG-487/a provider switch mid-session: k moves toward the new price", async () => {
    const s = await session((t) => (t < 200_000 ? 0.4 : 2.0));
    const ks = s.ks.filter((x): x is number => x !== undefined);
    const early = ks.find((_, i) => i === 0)!;
    expect(early).toBeLessThan(0.45);
    expect(ks.at(-1)!).toBeGreaterThan(early * 1.5);
    expect(ks.at(-1)!).toBeLessThan(2.1);
  });

  test("BUG-487/another OpenRouter session on the key in the window: no calibration, the table estimate marked ~, and no more readings", async () => {
    const s = await session(() => 0.4, { overlapAt: 150_000 });
    // Calibrated before the overlap, then reset: the last event is the return to the table price.
    expect(s.ks.at(-1)).toBeUndefined();
    const after = s.figures.filter((f) => f.t > 160_000);
    for (const f of after) expect(f.shown).toBeCloseTo(f.table, 6);
    const readsAfter = s.reads.filter((t) => t > 1_000_000 + 160_000);
    expect(readsAfter).toEqual([]);
    expect(s.tracker.figure()).toMatchObject({ approx: true });
  });

  test("BUG-487/idle: no reading while our own count doesn't change", async () => {
    const s = await session(() => 0.4, { idleFrom: 100_000 });
    // The baseline, the samples while it worked (at most one per 45 s up to 100 s), nothing after.
    expect(s.reads.filter((t) => t > 1_000_000 + 100_000 + 10_000).length).toBeLessThanOrEqual(1);
    expect(s.reads.length).toBeLessThanOrEqual(4);
  });

  test("BUG-487/the ratio: needs enough of our estimate at the lagged time, 1 outside 0.05..20, none for a bad figure", () => {
    expect(ratio(0.5, 0.0005)).toBeUndefined();
    expect(ratio(0.5, 1)).toBe(0.5);
    expect(ratio(100, 1)).toBe(1);
    expect(ratio(0.01, 1)).toBe(1);
    expect(ratio(Number.NaN, 1)).toBeUndefined();
    expect(ratio(-1, 1)).toBeUndefined();
    const h = new EstimateHistory();
    h.push(1000, 0.1);
    h.push(2000, 0.3);
    expect([h.at(500), h.at(1000), h.at(1999), h.at(5000)]).toEqual([0, 0.1, 0.1, 0.3]);
  });

  test("BUG-487/the final k and a cause when it is far from 1 are in the ledger", () => {
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "codex", conn: "openrouter", ledger });
    t.openrouterSession();
    t.codexResponse({ model: "moonshotai/kimi-k3", input: 1_000_000, cached: 0, cacheWrite: 0, output: 0 });
    t.setCalibration(0.4);
    t.billed(t.ownUsdNow() * 0.4);
    expect(ledger.entries.find((e) => e.kind === "observation" && e.scope === "billed")).toMatchObject({ cause: "openrouter-provider-price", calibration: 0.4 });
    const near = new Ledger();
    const t2 = new CostTracker({ harness: "codex", conn: "openrouter", ledger: near });
    t2.openrouterSession();
    t2.codexResponse({ model: "moonshotai/kimi-k3", input: 1_000_000, cached: 0, cacheWrite: 0, output: 0 });
    t2.setCalibration(1.05);
    t2.billed(t2.ownUsdNow() * 1.05);
    // Unknown endpoint prices and a ratio within 25%: a difference, but no cause is named for what wasn't observed.
    expect(near.entries.find((e) => e.kind === "observation" && e.scope === "billed")).toMatchObject({ cause: "unexplained" });
  });
});

describe("BUG-488/an OpenRouter session's figure is an estimate (~) until its model is known to have one endpoint price", () => {
  test("BUG-488/the bundled table says, per OpenRouter model Gluon offers, how many endpoints and their price range: no request at run time", () => {
    const kimi = priceEntry(KIMI_KEY)!.endpoints!;
    expect(kimi.count).toBeGreaterThan(1);
    expect(kimi.input.max).toBeGreaterThan(kimi.input.min);
    for (const key of wantedKeys().keys()) {
      if (!key.startsWith("openrouter/")) continue;
      const e = priceEntry(key)?.endpoints;
      expect(e, key).toBeDefined();
      expect(e!.input.min, key).toBeLessThanOrEqual(e!.input.max);
      expect(e!.output.min, key).toBeLessThanOrEqual(e!.output.max);
    }
    // The module that reads the key's usage has no other request: nothing asks `/models/<id>/endpoints`.
    expect(readFileSync(join(import.meta.dir, "../src/openrouter-billed.ts"), "utf8")).not.toContain("/endpoints");
  });

  test("BUG-488/the tracker marks ~ for several or unknown prices, nothing for one; other connections are as before", () => {
    const priced = (conn: "openrouter" | "anthropic", multiple?: boolean | "off") => {
      const t = new CostTracker({ harness: "codex", conn, ...(multiple !== undefined && multiple !== "off" ? { launchedKey: KIMI_KEY } : {}), ...(multiple === false ? { table: oneEndpoint() } : {}) });
      if (multiple !== "off" && conn === "openrouter") t.openrouterSession();
      t.codexResponse({ model: "moonshotai/kimi-k3", input: 1000, cached: 0, cacheWrite: 0, output: 0 });
      return t.figure();
    };
    expect(priced("openrouter", true)?.approx).toBe(true);
    expect(priced("openrouter", undefined)?.approx).toBe(true);
    expect(priced("openrouter", false)?.approx).toBe(false);
    expect(priced("openrouter", "off")?.approx).toBe(false);
  });

  test("BUG-488/the ledger entry and the report: scope `billed` is kept with its calibration, and read as what OpenRouter billed", () => {
    const e = sanitize({ kind: "observation", what: "cost", t: 5, harness: "kimi-code", scope: "billed", reportedMicros: 370_000, ownMicros: 200_000, cause: "openrouter-provider-price", calibration: 1.85123456, prompt: "x" });
    expect(e).toEqual({ kind: "observation", t: 5, harness: "kimi-code", what: "cost", scope: "billed", reportedMicros: 370_000, ownMicros: 200_000, cause: "openrouter-provider-price", calibration: 1.8512 });
    expect(sanitize({ kind: "observation", t: 5, harness: "codex", scope: "turn", reportedMicros: 1, calibration: 2 })).not.toHaveProperty("calibration");
    const lines = reportLines([e!]).join("\n");
    expect(lines).toContain("audited against what OpenRouter billed the session: 1 observation, 1 differ");
    expect(lines).toContain("kimi-code openrouter-provider-price: 1 observation, +$0.17 (OpenRouter's figure minus ours)");
  });
});

describe("BUG-489/no real network in the regression suite; none at all in a release build", () => {
  test("BUG-489/under the offline suite the usage isn't read unless a test names its own server; the seam names the base and the timings", () => {
    const saved = { seam: process.env.GLUON_TEST_OPENROUTER, probes: process.env.GLUON_TEST_PROBES };
    try {
      delete process.env.GLUON_TEST_OPENROUTER;
      process.env.GLUON_TEST_PROBES = join(TMP, "probes.json");
      expect(billedSource()).toBeNull();
      const file = join(TMP, "seam.json");
      writeFileSync(file, JSON.stringify({ base: "http://127.0.0.1:1/api/v1", timings: { pollMs: 7 } }));
      process.env.GLUON_TEST_OPENROUTER = file;
      expect(billedSource()).toEqual({ base: "http://127.0.0.1:1/api/v1", timings: { ...TIMINGS, pollMs: 7 } });
      // A seam file that isn't one: no network either.
      writeFileSync(file, "nonsense");
      expect(billedSource()).toBeNull();
    } finally {
      for (const [k, v] of [["GLUON_TEST_OPENROUTER", saved.seam], ["GLUON_TEST_PROBES", saved.probes]] as const) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("BUG-490/fails closed: only an environment that says nothing of tests reaches openrouter.ai; a `bun test` process never does", () => {
    expect(billedSource({})?.base).toBe("https://openrouter.ai/api/v1");
    expect(billedSource({ NODE_ENV: "test" })).toBeNull();
    expect(billedSource({ GLUON_TEST_PROBES: "/x" })).toBeNull();
    // This very process (`bun test` sets NODE_ENV=test): even with no seam and no probes it has no network.
    const saved = process.env.GLUON_TEST_PROBES;
    delete process.env.GLUON_TEST_PROBES;
    try {
      expect(billedSource()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.GLUON_TEST_PROBES = saved;
    }
  });

  test("BUG-491/the key's request follows no redirect (the key must not travel to another host) and fails quietly without it in a message", async () => {
    let init: { redirect?: string; headers?: Record<string, string> } | undefined;
    const usage = await readUsage(KEY, source(), async (_url, i) => {
      init = i;
      throw new Error(`redirect to https://evil.test with ${KEY}`);
    });
    expect(usage).toBeUndefined();
    expect(init?.redirect).toBe("error");
  });
});

describe("BUG-492/a registry file of a process that's gone, or whose pid another program now has, is not a running session", () => {
  test("BUG-492/an untouched file of a live pid (reused) ends at its last touch plus the tail; a touched one stays open", () => {
    const dir = join(fresh(), "reg");
    let t = 1_000_000_000_000;
    const reg = new Registry(dir, { now: () => t, pid: process.pid, alive: () => true, tailMs: 1000 });
    reg.register("aaaa1111", keyTag(KEY), t);
    const reader = new Registry(dir, { now: () => t, alive: () => true, tailMs: 1000 });
    expect(reader.others("zzzz", keyTag(KEY))).toEqual([{ start: t }]);
    // The Gluon that wrote it is gone, and its pid is now some other running program: nobody touches the file.
    const written = t;
    t += STALE_MS + 60_000;
    utimesSync(join(dir, `${process.pid}-aaaa1111.json`), new Date(written), new Date(written));
    const [w] = reader.others("zzzz", keyTag(KEY));
    expect(w!.end).toBeDefined();
    expect(w!.end).toBeLessThan(t);
    // A running session touches its file (`BilledMeter.tick`): open again.
    reg.touch("aaaa1111");
    expect(reader.others("zzzz", keyTag(KEY))).toEqual([{ start: written }]);
  });
});

describe("BUG-494/a session that spent never settles before the key's usage moved", () => {
  /** A priced session of ours: the estimate (`own`), the tracker, a ledger. */
  const spent = () => {
    const ledger = new Ledger();
    const tracker = new CostTracker({ harness: "codex", conn: "openrouter", launchedKey: KIMI_KEY, ledger });
    tracker.openrouterSession();
    tracker.codexResponse({ model: "moonshotai/kimi-k3", input: Math.round((0.002191 / KIMI_INPUT) * 1_000_000), cached: 0, cacheWrite: 0, output: 0 });
    return { ledger, tracker, own: tracker.ownUsdNow() };
  };

  test("BUG-494/lagged usage: the readings equal the baseline long past the old settle time, then the usage moves; it settles at the moved amount, not $0", async () => {
    const { tracker, own, ledger } = spent();
    expect(own).toBeGreaterThan(0.002);
    const results: BilledResult[] = [];
    let t0 = 0;
    // The key's usage lands 100 ms (a scaled 100 s) after the exit, in two steps.
    const fetch = async () => {
      const dt = t0 ? Date.now() - t0 : 0;
      const usage = dt < 60 ? 5 : dt < 100 ? 5.001 : 5 + own;
      return new Response(JSON.stringify({ data: { usage } }));
    };
    const m = await BilledMeter.begin({ key: KEY, source: source({ giveUpMs: 1000 }), registry: new Registry(fresh()), fetch, onSettled: (r) => results.push(r) });
    m.tick(own);
    t0 = Date.now();
    // Without the guard it would settle at 0 after settleMs (12 ms): two reads at the baseline.
    const r = await m.finish({ usd: own });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(r.status).toBe("clean");
    expect(r.status === "clean" && Math.round(r.usd * 1e6)).toBe(Math.round(own * 1e6));
    const notes: string[] = [];
    settled(r, { tracker, ledger, harness: "codex", note: (x) => notes.push(x) });
    expect(tracker.figure()).toMatchObject({ billed: true, approx: false });
    expect(notes[0]).toContain("OpenRouter billed $0.0022✓");
    // It equals our estimate: no difference, no cause.
    expect(ledger.entries.find((e) => e.kind === "observation" && e.scope === "billed")).toMatchObject({ cause: "none" });
  });

  test("BUG-494/not before landMs since the session's last request, even when the usage moved and two readings agree", async () => {
    const { own } = spent();
    const key = fakeKey([5, 5 + own]);
    const m = await BilledMeter.begin({ key: KEY, source: source({ landMs: 150, giveUpMs: 1000 }), registry: new Registry(fresh()), fetch: key.fetch });
    m.tick(own);
    const t0 = Date.now();
    const r = await m.finish({ usd: own });
    expect(r.status).toBe("clean");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(145);
  });

  test("BUG-494/the usage never moves: unsettled at the give-up, no figure, a dropped record", async () => {
    const { tracker, ledger, own } = spent();
    const notes: string[] = [];
    const key = fakeKey([5]);
    const m = await BilledMeter.begin({ key: KEY, source: source({ giveUpMs: 300 }), registry: new Registry(fresh()), fetch: key.fetch, onSettled: (r) => settled(r, { tracker, ledger, harness: "codex", note: (x) => notes.push(x) }) });
    m.tick(own);
    const r = await m.finish({ usd: own });
    expect(r).toEqual({ status: "unsettled", why: "timeout" });
    expect(ledger.entries).toContainEqual(expect.objectContaining({ kind: "dropped", what: "cost", reason: "openrouter-unsettled" }));
    expect(ledger.entries.some((e) => e.kind === "observation" && e.scope === "billed")).toBe(false);
    expect(tracker.figure()).toMatchObject({ usd: own, approx: true });
    expect(tracker.figure()!.billed).toBeUndefined();
    expect(notes[0]).toBe("no billed figure: OpenRouter's usage hadn't settled after 5 minutes.");
  });

  test("BUG-494/the exit counts a request the last tick missed: the count at the exit decides", async () => {
    const { own } = spent();
    const key = fakeKey([5]);
    const m = await BilledMeter.begin({ key: KEY, source: source({ giveUpMs: 200 }), registry: new Registry(fresh()), fetch: key.fetch });
    // No tick ever saw the spend; the exit reports it.
    expect(await m.finish({ usd: own })).toEqual({ status: "unsettled", why: "timeout" });
  });

  test("BUG-494/a session with no requests settles at $0 once two readings agree (settleMs after the exit), not after landMs", async () => {
    const ledger = new Ledger();
    const tracker = new CostTracker({ harness: "codex", conn: "openrouter", launchedKey: KIMI_KEY, ledger });
    tracker.openrouterSession();
    const notes: string[] = [];
    const m = await BilledMeter.begin({ key: KEY, source: source({ landMs: 60_000, giveUpMs: 120_000 }), registry: new Registry(fresh()), fetch: fakeKey([7]).fetch, onSettled: (r) => settled(r, { tracker, ledger, harness: "codex", note: (x) => notes.push(x) }) });
    const t0 = Date.now();
    expect(await m.finish({ usd: 0 })).toEqual({ status: "clean", usd: 0 });
    expect(Date.now() - t0).toBeLessThan(2000 * SLOW);
    expect(tracker.figure()).toEqual({ usd: 0, approx: false, own: true, billed: true });
    expect(notes[0]).toContain("OpenRouter billed $0.00✓");
  });

  test("BUG-494/a model with a price of $0 (our estimate is $0, nothing unpriced) is a session with nothing to wait for", async () => {
    const t = new CostTracker({ harness: "codex", conn: "openrouter" });
    t.openrouterSession();
    expect(t.usageExpected()).toBe(false);
    const m = await BilledMeter.begin({ key: KEY, source: source({ landMs: 60_000, giveUpMs: 120_000 }), registry: new Registry(fresh()), fetch: fakeKey([7]).fetch });
    expect(await m.finish({ usd: 0, expects: t.usageExpected() })).toEqual({ status: "clean", usd: 0 });
  });
});

describe("BUG-495/the live calibration takes no k from a usage that hasn't moved", () => {
  test("BUG-495/readings at the baseline give no ratio (the table price stands); once the usage moved, k is the ratio of the moved usage to our estimate one lag ago", async () => {
    let now = 1_000_000;
    let usage = 20;
    const ks: (number | undefined)[] = [];
    const fetch = async () => new Response(JSON.stringify({ data: { usage } }));
    const m = await BilledMeter.begin({ key: KEY, source: { base: "x", timings: { ...FAST, sampleMs: 45_000, lagMs: 60_000 } }, registry: new Registry(fresh(), { now: () => now, alive: () => true }), fetch, now: () => now, onCalibration: (k) => ks.push(k) });
    m.tick(0.02);
    // Two minutes in, our count grew; the key's usage still shows the baseline: nothing to calibrate against.
    for (const own of [0.03, 0.05]) {
      now += 50_000;
      m.tick(own);
      await Bun.sleep(8);
    }
    expect(ks).toEqual([]);
    expect(m.k).toBeUndefined();
    // The usage lands (0.015 of the first 0.02): k = 0.015 / what we had estimated one lag ago.
    usage = 20.015;
    now += 50_000;
    m.tick(0.06);
    await Bun.sleep(8);
    expect(ks).toHaveLength(1);
    expect(ks[0]!).toBeCloseTo(0.015 / 0.03, 6);
  });
});

describe("BUG-496/a $0 reading for a session that spent is never a billed figure, never a provider price", () => {
  test("BUG-496/tracker.billed(0) with spend: refused, a dropped record, and no `openrouter-provider-price` observation", () => {
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "codex", conn: "openrouter", launchedKey: KIMI_KEY, ledger });
    t.openrouterSession();
    t.codexResponse({ model: "moonshotai/kimi-k3", input: 1_000_000, cached: 0, cacheWrite: 0, output: 0 });
    expect(t.billed(0)).toBe(false);
    expect(t.figure()!.billed).toBeUndefined();
    expect(ledger.entries.some((e) => e.kind === "observation" && e.scope === "billed")).toBe(false);
    expect(JSON.stringify(ledger.entries)).not.toContain("openrouter-provider-price");
    expect(ledger.entries).toContainEqual(expect.objectContaining({ kind: "dropped", reason: "openrouter-billed-zero" }));
    // A real difference is still taken and named; so is $0 for a session that spent nothing.
    expect(t.billed(t.ownUsdNow() * 0.4)).toBe(true);
    expect(new CostTracker({ harness: "codex", conn: "openrouter" }).billed(0)).toBe(true);
  });

  test("BUG-496/settled() of a clean $0 for a session that spent says there is no figure, not '$0.00✓'", () => {
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "codex", conn: "openrouter", launchedKey: KIMI_KEY, ledger });
    t.openrouterSession();
    t.codexResponse({ model: "moonshotai/kimi-k3", input: 1_000_000, cached: 0, cacheWrite: 0, output: 0 });
    const notes: string[] = [];
    settled({ status: "clean", usd: 0 }, { tracker: t, ledger, harness: "codex", note: (x) => notes.push(x) });
    expect(notes).toEqual(["no billed figure: OpenRouter's usage showed nothing for this session."]);
    expect(costLabel(t.figure())).not.toContain("✓");
  });
});

describe("BUG-497/a figure under a cent shows enough digits to be above zero", () => {
  test("BUG-497/costLabel: four decimals under $0.01 (live row and the billed chat line), two otherwise, $0.00 only for 0", () => {
    expect(costLabel({ usd: 0.002190975, approx: true })).toBe("~$0.0022");
    expect(costLabel({ usd: 0.002190975, approx: false, billed: true })).toBe("$0.0022✓");
    expect(costLabel({ usd: 0.0049, approx: false, own: false })).toBe("$0.0049*");
    expect(costLabel({ usd: 0.00004, approx: true })).toBe("~<$0.0001");
    expect(costLabel({ usd: 0, approx: false })).toBe("$0.00");
    expect(costLabel({ usd: 0.01, approx: false })).toBe("$0.01");
    expect(costLabel({ usd: 4.123, approx: true })).toBe("~$4.12");
  });

  test("BUG-497/the chat line of a sub-cent billed figure and the running figure it replaces", () => {
    const ledger = new Ledger();
    const t = new CostTracker({ harness: "codex", conn: "openrouter", launchedKey: KIMI_KEY, ledger });
    t.openrouterSession();
    t.codexResponse({ model: "moonshotai/kimi-k3", input: Math.round((0.002191 / KIMI_INPUT) * 1_000_000), cached: 0, cacheWrite: 0, output: 0 });
    const notes: string[] = [];
    settled({ status: "clean", usd: 0.002190975 }, { tracker: t, ledger, harness: "codex", note: (x) => notes.push(x) });
    expect(notes[0]).toBe("OpenRouter billed $0.0022✓ for this session (Gluon's running figure was ~$0.0022).");
  });
});

describe("BUG-498/every counted request moves the last-request time, priced or not", () => {
  test("BUG-498/requests Gluon couldn't price add nothing to our estimate, but the usage of the last one still lands late: not before landMs after it", async () => {
    const t = new CostTracker({ harness: "codex", conn: "openrouter", launchedKey: "openrouter/unknown/model-x" });
    t.openrouterSession();
    t.codexResponse({ model: "unknown/model-x", input: 1000, cached: 0, cacheWrite: 0, output: 10 });
    expect(t.usageExpected()).toBe(true);
    expect(t.ownUsdNow()).toBe(0);
    const first = t.requestsNow();
    t.codexResponse({ model: "unknown/model-x", input: 1000, cached: 0, cacheWrite: 0, output: 10 });
    expect(t.requestsNow()).toBe(first + 1);
    const m = await BilledMeter.begin({ key: KEY, source: source({ landMs: 150, giveUpMs: 1000 }), registry: new Registry(fresh()), fetch: fakeKey([5, 5.001]).fetch });
    m.tick(0, true, first);
    await Bun.sleep(120);
    m.tick(0, true, first + 1);
    const t0 = Date.now();
    const r = await m.finish({ usd: 0, expects: true, requests: first + 1 });
    expect(r.status).toBe("clean");
    // Counted from the second request (no earlier than 145 ms after it), not from the first (which would be about 30 ms).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(145);
  });
});

describe("BUG-499/the poll's sleep leaves no timer behind", () => {
  test("BUG-499/abandon (a quit) clears the pending poll timer at once", async () => {
    const live = new Set<unknown>();
    const { setTimeout: st, clearTimeout: ct } = globalThis;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const h = st(() => (live.delete(h), fn()), ms);
      if (ms === 60_000) live.add(h);
      return h;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => (live.delete(h), ct(h))) as typeof clearTimeout;
    try {
      const m = await BilledMeter.begin({ key: KEY, source: source({ pollMs: 60_000, landMs: 60_000, giveUpMs: 600_000 }), registry: new Registry(fresh()), fetch: fakeKey([5]).fetch });
      const p = m.finish({ usd: 0.5, expects: true });
      await Bun.sleep(30);
      expect(live.size).toBe(1);
      m.abandon();
      expect(await p).toEqual({ status: "unsettled", why: "quit" });
      expect(live.size).toBe(0);
    } finally {
      globalThis.setTimeout = st;
      globalThis.clearTimeout = ct;
    }
  });
});

// ---- QA of the billed figure (B4) ----

describe("QA cost: what else spends on the key", () => {
  // The delta of the key's usage is the session's only if nothing else spent on the key meanwhile. Gluon's own brain is such a spender: an `openrouter` step
  // (`brain.order`, and its default fallbacks in `config.ts`) sends OPENROUTER_API_KEY to openrouter.ai as the user chats while an OpenRouter session runs.
  // The owner's decision (2026-10-07): the brain is no part of any session, so its replies' exact `usage.cost` is taken off the delta (`BUG-631` below).

  test("a key's usage that is not a plain non-negative number is no reading, whatever else the answer says", async () => {
    const answers: unknown[] = [{ data: { usage: "5" } }, { data: { usage: null } }, { data: { usage: -1 } }, { data: { usage: [1] } }, { data: { usage: {} } }, { data: [] }, { data: null }, null, [], "usage", 5, { usage: 3 }, { data: { usage: 1e999 } }];
    for (const a of answers) {
      const f = async () => new Response(JSON.stringify(a), { status: 200 });
      expect([JSON.stringify(a), await readUsage(KEY, source(), f as never)]).toEqual([JSON.stringify(a), undefined]);
    }
    const notJson = async () => new Response("<html>502</html>", { status: 200 });
    expect(await readUsage(KEY, source(), notJson as never)).toBeUndefined();
    const huge = async () => new Response(JSON.stringify({ data: { usage: 12.5 }, pad: "x".repeat(2_000_000) }), { status: 200 });
    expect(await readUsage(KEY, source(), huge as never)).toBe(12.5);
    const slow = async (_u: string, init: { signal: AbortSignal }) => new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    // Bun 1.3.14 on Windows spins forever when only an `AbortSignal.timeout` timer can end the await (the real fetch keeps the loop alive): this keeps it alive.
    const keepAlive = setInterval(() => {}, 10);
    try {
      expect(await readUsage(KEY, source({ readTimeoutMs: 30 }), slow as never)).toBeUndefined();
    } finally {
      clearInterval(keepAlive);
    }
  });

  test("a registry file that is junk, oversized or of another shape is no window", () => {
    const dir = fresh();
    const now = 10_000_000;
    const reg = new Registry(dir, { now: () => now, alive: () => false, restrict: false });
    reg.register("aaaa", keyTag(KEY), now - 1000);
    writeFileSync(join(dir, "1-bad.json"), "{not json");
    writeFileSync(join(dir, "2-big.json"), "x".repeat(10_000));
    writeFileSync(join(dir, "3-wrongkey.json"), JSON.stringify({ v: 1, pid: 3, key: 5, start: 1 }));
    expect(reg.others("bbbb", keyTag(KEY))).toHaveLength(1);
  });

  // A crashed session's window ends at its file's last touch plus the lag tail. A last touch in the future (the clock was ahead, a VM was restored) makes the window
  // end in the future, and any session started after the clock is right again overlaps it: no billed figure on that key until that date.
  test("BUG-632/QA-cost-05: a gone process's window never ends later than now plus the lag tail, whatever its file's time says", () => {
    const dir = fresh();
    const now = 10_000_000;
    const reg = new Registry(dir, { now: () => now, alive: () => false, restrict: false });
    reg.register("aaaa", keyTag(KEY), now - 1000);
    const future = new Date(now + 86_400_000 * 3);
    utimesSync(join(dir, `${process.pid}-aaaa.json`), future, future);
    const [w] = reg.others("bbbb", keyTag(KEY));
    expect(w!.end).toBeDefined();
    expect(w!.end!).toBeLessThanOrEqual(now + TIMINGS.tailMs);
  });
});

// ---- QA-cost-04: Gluon's own brain on the same OpenRouter key is not part of a session (BUG-631) ----

/** One fake OpenRouter: a chat endpoint that streams a reply and bills it, and `/key` showing the billed usage, each charge `lagMs` late. */
function fakeOpenRouter(lagMs: number, o: { reply?: "usage" | "no-usage" | "401"; failFirst?: boolean } = {}) {
  const charges: { at: number; usd: number }[] = [];
  const bodies: Record<string, any>[] = [];
  let reads = 0;
  const bill = (usd: number) => charges.push({ at: Date.now() + lagMs, usd });
  const usage = () => charges.filter((c) => c.at <= Date.now()).reduce((a, c) => a + c.usd, 0);
  const cost = { next: 0.02 };
  const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/key")) {
      reads++;
      return new Response(JSON.stringify({ data: { usage: usage() } }), { status: 200 });
    }
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    // An attempt the SDK retries: OpenRouter charged it all the same.
    if (o.failFirst && bodies.length === 1) {
      bill(0.01);
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 500, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
    }
    if (o.reply === "401") return new Response(JSON.stringify({ error: { message: "no" } }), { status: 401, headers: { "content-type": "application/json" } });
    const chunk = (delta: object, finish: string | null = null) => ({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
    bill(cost.next);
    // The probe is no stream: one completion.
    if (!bodies.at(-1)!.stream) return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: cost.next } }), { status: 200, headers: { "content-type": "application/json" } });
    const events = [chunk({ role: "assistant", content: "ok" }), chunk({}, "stop"), ...(o.reply === "no-usage" ? [] : [{ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: cost.next } }])];
    return new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { fetch, bill, bodies, cost, reads: () => reads };
}

/** Runs `call` with the SDK's fetch answered by the fake, and `key` as the OpenRouter key in the environment. */
async function onOpenRouter<T>(or: ReturnType<typeof fakeOpenRouter>, key: string, call: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const was = process.env.OPENROUTER_API_KEY;
  globalThis.fetch = or.fetch;
  process.env.OPENROUTER_API_KEY = key;
  try {
    return await call();
  } finally {
    globalThis.fetch = realFetch;
    if (was === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = was;
  }
}

const STEP = { route: "openrouter" as const, model: "anthropic/claude-sonnet-5.5" };
const askBrain = () => (brainFor(defaults(), STEP, process.cwd()) as ModelClient)({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }, () => {});
/** A session's timings with OpenRouter's usage lagging 5 ms at least and 60 ms at most. */
const brainTimings = (over: Partial<Timings> = {}) => source({ minLagMs: 5, tailMs: 60, ...over });
let keys = 0;
const nextKey = () => `${KEY}-brain-${++keys}`;
const micros = (usd: number) => Math.round(usd * 1e6);

describe("BUG-631/Gluon's own brain on the session's OpenRouter key", () => {
  test("BUG-631/QA-cost-04: a brain reply and a session on one key: the session's figure is its own, the brain's exact cost taken off (a `✓` of $0.30, not $0.32)", async () => {
    const key = nextKey();
    const or = fakeOpenRouter(20);
    const results: BilledResult[] = [];
    const m = await BilledMeter.begin({ key, source: brainTimings(), registry: new Registry(fresh()), fetch: or.fetch, onSettled: (r) => results.push(r) });
    // The brain answers the developer while the session runs; OpenRouter charges both, a little late.
    await onOpenRouter(or, key, async () => {
      await askBrain();
    });
    or.bill(0.3);
    m.observe(0.25, true, 1);
    const r = await m.finish();
    expect(r.status).toBe("clean");
    expect(r.status === "clean" && [micros(r.usd), micros(r.brainUsd ?? 0)]).toEqual([300_000, 20_000]);
    // The brain asked for the cost it is billed (OpenRouter's usage accounting), on OpenRouter's endpoint only.
    expect(or.bodies[0]).toMatchObject({ usage: { include: true }, stream: true });
    // The figure the session shows: $0.30, billed, and the chat says what was left out.
    const ledger = new Ledger();
    const tracker = new CostTracker({ harness: "opencode", conn: "openrouter", launchedKey: KIMI_KEY, ledger });
    tracker.openrouterSession();
    tracker.opencodeStep({ model: "openrouter/moonshotai/kimi-k3", tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
    const notes: string[] = [];
    settled(r, { tracker, ledger, harness: "opencode", note: (x) => notes.push(x) });
    expect(tracker.figure()).toEqual({ usd: r.status === "clean" ? r.usd : 0, approx: false, own: true, billed: true });
    expect(costLabel(tracker.figure())).toBe("$0.30✓");
    expect(notes[0]).toContain("OpenRouter billed $0.30✓");
    expect(notes[0]).toContain("the intake agent's own $0.02 on this key in that time is not in it");
    expect(results).toEqual([r]);
  });

  test("BUG-631/variants: the brain's probe spends on the key too, and is left out the same way", async () => {
    const key = nextKey();
    const or = fakeOpenRouter(20);
    const m = await BilledMeter.begin({ key, source: brainTimings(), registry: new Registry(fresh()), fetch: or.fetch });
    or.cost.next = 0.01;
    const probed = await onOpenRouter(or, key, () => probeStep(defaults(), STEP, process.cwd()));
    expect(probed).toMatchObject({ ok: true });
    or.bill(0.3);
    m.observe(0.25, true, 1);
    const r = await m.finish();
    expect(r.status === "clean" && [micros(r.usd), micros(r.brainUsd ?? 0)]).toEqual([300_000, 10_000]);
  });

  test("BUG-631/variants: a brain reply with no cost, or an error, or a stopped stream: the cost is unknown, so no `✓`, the estimate stays `~`, and the ledger and chat say why", async () => {
    for (const reply of ["no-usage", "401"] as const) {
      const key = nextKey();
      const or = fakeOpenRouter(20, { reply });
      const m = await BilledMeter.begin({ key, source: brainTimings(), registry: new Registry(fresh()), fetch: or.fetch });
      await onOpenRouter(or, key, () => askBrain().catch(() => {}));
      or.bill(0.3);
      m.observe(0.25, true, 1);
      const r = await m.finish();
      expect([reply, r]).toEqual([reply, { status: "brain" }]);
      const ledger = new Ledger();
      const tracker = new CostTracker({ harness: "opencode", conn: "openrouter", launchedKey: KIMI_KEY, ledger });
      tracker.openrouterSession();
      tracker.opencodeStep({ model: "openrouter/moonshotai/kimi-k3", tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
      const notes: string[] = [];
      settled(r, { tracker, ledger, harness: "opencode", note: (x) => notes.push(x) });
      expect(tracker.figure()).toMatchObject({ approx: true });
      expect(tracker.figure()?.billed).toBeUndefined();
      expect(notes[0]).toContain("no billed figure: the intake agent spent on this key");
      expect(ledger.entries).toContainEqual(expect.objectContaining({ kind: "dropped", reason: "openrouter-brain-spend" }));
    }
    // A stream the developer stopped (Esc) mid-reply: OpenRouter charges what it generated, the cost never arrives.
    const key = nextKey();
    const or = fakeOpenRouter(20);
    const m = await BilledMeter.begin({ key, source: brainTimings(), registry: new Registry(fresh()), fetch: or.fetch });
    const stop = new AbortController();
    await onOpenRouter(or, key, () => (brainFor(defaults(), STEP, process.cwd()) as ModelClient)({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], signal: stop.signal }, () => stop.abort()).catch(() => {}));
    m.observe(0.25, true, 1);
    expect(await m.finish()).toEqual({ status: "brain" });
  });

  test("BUG-631/variants: a brain reply that is not in the window (long before the baseline, or after the final reading) changes nothing, whatever it cost or whether its cost is known", async () => {
    const key = nextKey();
    const brain = new BrainSpend();
    const tag = keyTag(key);
    const or = fakeOpenRouter(20);
    const t0 = Date.now();
    brain.record(tag, t0 - 10_000, undefined); // landed long before the baseline: unknown cost, but not in the delta
    brain.record(tag, t0 - 10_000, 5);
    brain.record(keyTag(`${key}-other`), t0, undefined); // another key
    const m = await BilledMeter.begin({ key, source: brainTimings(), registry: new Registry(fresh()), fetch: or.fetch, brain });
    or.bill(0.3);
    m.observe(0.25, true, 1);
    brain.record(tag, Date.now() + 10_000, undefined); // not ended yet when the figure is read
    const r = await m.finish();
    expect(r.status === "clean" && [micros(r.usd), r.brainUsd]).toEqual([300_000, undefined]);
  });

  test("BUG-631/variants: a brain reply that ended a moment before the final reading may not have landed: the meter waits for it, then takes its exact cost off; one that never resolves gives no figure", async () => {
    const key = nextKey();
    const brain = new BrainSpend();
    const or = fakeOpenRouter(20);
    const m = await BilledMeter.begin({ key, source: brainTimings({ landMs: 10 }), registry: new Registry(fresh()), fetch: or.fetch, brain });
    or.bill(0.3);
    or.bill(0.05);
    m.observe(0.25, true, 1);
    brain.record(keyTag(key), Date.now(), 0.05);
    const t = Date.now();
    const r = await m.finish();
    expect(r.status === "clean" && [micros(r.usd), micros(r.brainUsd ?? 0)]).toEqual([300_000, 50_000]);
    // It waited for the slowest lag (tailMs) since the reply, not for the session's own landMs alone.
    expect(Date.now() - t).toBeGreaterThanOrEqual(FAST.tailMs - 10);
    // A brain that keeps answering until the meter gives up: no figure.
    const key2 = nextKey();
    const or2 = fakeOpenRouter(20);
    const brain2 = new BrainSpend();
    // A reply ends just before every reading the meter makes after the baseline: it is in the delta or may be (`pending`), never a settled one. (A timer
    // recording one every 5 ms left gaps wider than `tailMs` where Windows' 15 ms timers and a busy loop stalled: a reading then saw no reply near it and settled clean.)
    let reads = 0;
    const chatty = ((input: Request | string | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).endsWith("/key") && ++reads > 1) brain2.record(keyTag(key2), Date.now() - 10, 0.01);
      return or2.fetch(input, init);
    }) as typeof globalThis.fetch;
    const m2 = await BilledMeter.begin({ key: key2, source: brainTimings({ landMs: 10, giveUpMs: 120 }), registry: new Registry(fresh()), fetch: chatty, brain: brain2 });
    or2.bill(0.3);
    m2.observe(0.25, true, 1);
    expect(await m2.finish()).toEqual({ status: "brain" });
  });

  test("BUG-631/variants: usage that moved only by the brain's reply is not the session's landing: the meter waits for the session's own", async () => {
    const key = nextKey();
    const brain = new BrainSpend();
    const or = fakeOpenRouter(20);
    const m = await BilledMeter.begin({ key, source: brainTimings({ landMs: 10 }), registry: new Registry(fresh()), fetch: or.fetch, brain });
    or.bill(0.05);
    brain.record(keyTag(key), Date.now(), 0.05);
    m.observe(0.25, true, 1);
    // The session's own $0.30 lands 200 ms after; the meter must not settle at the brain's alone ($0).
    setTimeout(() => or.bill(0.3), 150);
    const r = await m.finish();
    expect(r.status === "clean" && micros(r.usd)).toBe(300_000);
  });

  test("BUG-631/variants: a brain reply that may have landed before the baseline (it ended within the lag window before it) leaves no figure; the brain's reply 30 s or less before it is taken off", () => {
    const lag = { minMs: 30_000, maxMs: 150_000 };
    const brain = new BrainSpend();
    const base = { from: 1_000_000, to: 1_000_200 };
    const final = { from: 1_600_000, to: 1_600_200 };
    brain.record("k", base.from - 10_000, 0.5); // ended 10 s before: cannot be in the baseline yet (30 s at least)
    expect(brain.share("k", base, final, lag)).toEqual({ usd: 0.5, unknown: false, pending: false });
    brain.record("k", base.from - 60_000, 0.25); // 60 s before: in the baseline or not
    expect(brain.share("k", base, final, lag)).toMatchObject({ unknown: true });
    // Beyond the slowest lag: certainly in the baseline, not in the delta.
    const old = new BrainSpend();
    old.record("k", base.from - 150_000, undefined);
    expect(old.share("k", base, final, lag)).toEqual({ usd: 0, unknown: false, pending: false });
    // After the final reading's request by less than the fastest lag: not in the delta.
    const late = new BrainSpend();
    late.record("k", final.to - 29_000, undefined);
    expect(late.share("k", base, final, lag)).toEqual({ usd: 0, unknown: false, pending: false });
    // Between the fastest and the slowest lag before the final reading: pending.
    const mid = new BrainSpend();
    mid.record("k", final.from - 60_000, 0.1);
    expect(mid.share("k", base, final, lag)).toEqual({ usd: 0, unknown: false, pending: true });
    // Another key's replies are nobody's here.
    expect(mid.share("other", base, final, lag)).toEqual({ usd: 0, unknown: false, pending: false });
  });

  test("BUG-631/variants: more replies than the memory keeps: a window that reaches the forgotten ones is unknown, a later one is not", () => {
    const lag = { minMs: 30_000, maxMs: 150_000 };
    const brain = new BrainSpend();
    for (let i = 0; i < 2100; i++) brain.record("k", 1_000 + i, 0);
    expect(brain.share("k", { from: 1_000, to: 1_100 }, { from: 5_000, to: 5_100 }, lag).unknown).toBe(true);
    expect(brain.share("k", { from: 10_000_000, to: 10_000_100 }, { from: 10_900_000, to: 10_900_100 }, lag).unknown).toBe(false);
  });

  test("BUG-631/variants: the live calibration leaves the brain's landed reply out of k, and skips a reading the brain's reply may be in", async () => {
    let now = 1_000_000;
    const lag = 60_000;
    const key = nextKey();
    const brain = new BrainSpend();
    const timings = { ...FAST, sampleMs: 45_000, lagMs: lag, tailMs: 150_000, minLagMs: 30_000 };
    // OpenRouter shows the session's $0.20 (twice our $0.10) and the brain's $0.50 from 100 s on.
    const fetch = async () => new Response(JSON.stringify({ data: { usage: 20 + (now >= 1_100_000 ? 0.2 : 0) + (now >= 1_031_000 ? 0.5 : 0) } }));
    const ks: (number | undefined)[] = [];
    const m = await BilledMeter.begin({ key, source: { base: "x", timings }, registry: new Registry(fresh(), { now: () => now, alive: () => true }), fetch, now: () => now, brain, onCalibration: (k) => ks.push(k) });
    now = 1_010_000;
    brain.record(keyTag(key), 1_001_000, 0.5);
    m.tick(0.1, true, 1);
    now = 1_100_000;
    // 99 s after the brain's reply: it may or may not be in this reading (the slowest lag is 150 s): this reading says nothing.
    m.tick(0.1000001, true, 2);
    await Bun.sleep(5);
    expect(ks).toEqual([]);
    now = 1_200_000;
    m.tick(0.1000002, true, 3);
    await Bun.sleep(5);
    // Now it surely is: k is the session's $0.20 over our $0.10, not $0.70 over it.
    expect(ks.at(-1)).toBeCloseTo(2, 5);
  });
});

describe("BUG-631/variants: the brain's spend reaches no session's figure on any other billing path", () => {
  // Every path but OpenRouter's builds a session's figure from that session's own telemetry (tokens x price) and no meter reads a key's usage. The brain is
  // not a session: it has no telemetry channel (a launch's own token), no tracker, no ledger of the cost audit, no row in `gluon stats`.
  const BRAIN_FILES = ["src/brain.ts", ...readdirSync(join(import.meta.dir, "../src/agent")).filter((f) => f.endsWith(".ts")).map((f) => `src/agent/${f}`)];
  const SESSION_COST = ["cost/tracker", "cost/ledger", "cost/context", "telemetry", "otlp-protobuf", "kimi-usage", "stats", "analytics", "sessions", "workspaces", "events"];

  test("the brain's code imports nothing that makes a session's figure, its audit ledger or the stats (only the key's tag and the brain's record)", () => {
    for (const f of BRAIN_FILES) {
      // `MAX_SPEC` (a number, `choices.ts`) is the one thing taken from the workspaces module.
      const text = readFileSync(join(import.meta.dir, "..", f), "utf8").replace('import { MAX_SPEC } from "../workspaces.ts";', "");
      const imports = [...text.matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1]!);
      const bad = imports.filter((i) => SESSION_COST.some((s) => new RegExp(`(^|/)${s}(\\.ts)?$`).test(i)));
      expect([f, bad]).toEqual([f, []]);
    }
    // The one door into the cost code: the OpenRouter key's tag and the in-memory list of the brain's replies.
    const brain = readFileSync(join(import.meta.dir, "../src/brain.ts"), "utf8");
    expect([...brain.matchAll(/import \{([^}]*)\} from "\.\/(?:openrouter-billed|cost\/billed)\.ts"/g)].map((m) => m[1]!.trim())).toEqual(["keyTag, recordBrainReply"]);
  });

  test("an Anthropic-key, OpenAI-key and OpenRouter brain call beside sessions of every connection: no tracker moves, no ledger entry, and only the OpenRouter key's replies are kept", async () => {
    const conns = [["claude-code", "anthropic"], ["claude-code", "plan"], ["claude-code", "bedrock"], ["codex", "openai"], ["codex", "plan"], ["opencode", "openrouter"], ["kimi-code", "moonshot"], ["grok-build", "xai"]] as const;
    const sessions = conns.map(([harness, conn]) => {
      const ledger = new Ledger();
      return { ledger, tracker: new CostTracker({ harness, conn, ledger }) };
    });
    const state = () => sessions.map((s) => JSON.stringify([s.tracker.figure(), s.tracker.ownUsdNow()]));
    const before = state();
    const keys = { ANTHROPIC_API_KEY: "sk-ant-api03-brainbrainbrainbrain", OPENAI_API_KEY: "sk-proj-brainbrainbrainbrain", OPENROUTER_API_KEY: nextKey() };
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
    globalThis.fetch = (async (input: Request | string | URL) => {
      seen.push(new URL(String(input instanceof Request ? input.url : input)).host);
      return new Response(JSON.stringify({ error: { message: "no" } }), { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    Object.assign(process.env, keys);
    const turn = () => ({ system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], signal: new AbortController().signal });
    try {
      for (const step of [{ route: "anthropic-api" as const, model: "claude-sonnet-5-5" }, { route: "openai-api" as const, model: "gpt-6-sol" }, STEP]) {
        await (brainFor(defaults(), step, process.cwd()) as ModelClient)(turn(), () => {}).catch(() => {});
        await probeStep(defaults(), step, process.cwd());
      }
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    expect(new Set(seen)).toEqual(new Set(["api.anthropic.com", "api.openai.com", "openrouter.ai"]));
    expect(state()).toEqual(before);
    expect(sessions.flatMap((s) => s.ledger.entries)).toEqual([]);
    // Only replies on the OpenRouter key are kept (refused here, so their cost is unknown); none on the other providers' keys.
    const lag = { minMs: 5, maxMs: 60 };
    const base = { from: Date.now() - 100_000, to: Date.now() - 99_999 };
    const final = { from: Date.now() + 1000, to: Date.now() + 1001 };
    const other = { usd: 0, unknown: false, pending: false };
    expect(brainSpend.share(keyTag(keys.ANTHROPIC_API_KEY), base, final, lag)).toEqual(other);
    expect(brainSpend.share(keyTag(keys.OPENAI_API_KEY), base, final, lag)).toEqual(other);
    expect(brainSpend.share(keyTag(keys.OPENROUTER_API_KEY), base, final, lag).unknown).toBe(true);
  });
});

describe("BUG-631/variants: the brain of another Gluon process on the same key", () => {
  const stamp = () => Date.now();
  /** Process B's meter: its own brain list is empty, and the registry is the shared directory read as process 2002. */
  const processB = async (dir: string, key: string, or: ReturnType<typeof fakeOpenRouter>, over: Partial<Timings> = {}, alive: (pid: number) => boolean = () => true) =>
    BilledMeter.begin({ key, source: brainTimings(over), registry: new Registry(dir, { pid: 2002, alive }), fetch: or.fetch, brain: new BrainSpend() });

  test("BUG-631/variants: process A's brain reply inside process B's session window is taken off B's figure, from A's file", async () => {
    const dir = fresh();
    const key = nextKey();
    const or = fakeOpenRouter(20);
    const a = new BrainLog(dir, { pid: 1001, tailMs: FAST.tailMs });
    const m = await processB(dir, key, or);
    a.record(keyTag(key), stamp(), 0.02);
    or.bill(0.02);
    or.bill(0.3);
    m.observe(0.25, true, 1);
    const r = await m.finish();
    expect(r.status === "clean" && [micros(r.usd), micros(r.brainUsd ?? 0)]).toEqual([300_000, 20_000]);
  });

  test("BUG-631/variants: the file is private, holds the key's tag and never the key, and a reply of a dead process still counts (nothing removes its file)", async () => {
    const dir = fresh();
    const key = nextKey();
    const or = fakeOpenRouter(20);
    const a = new BrainLog(dir, { pid: 1001, tailMs: FAST.tailMs, restrict: false });
    const m = await processB(dir, key, or, {}, () => false);
    a.record(keyTag(key), stamp(), 0.02);
    const text = readFileSync(join(dir, "1001.brain"), "utf8");
    expect(text).toContain(keyTag(key));
    expect(text).not.toContain(key);
    expect(JSON.parse(text)).toMatchObject({ v: 1, pid: 1001, lost: 0, calls: [{ n: 1, key: keyTag(key), usd: 0.02 }] });
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "1001.brain")).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    or.bill(0.02);
    or.bill(0.3);
    m.observe(0.25, true, 1);
    // Process A is gone (`alive` says so): its reply is still in the key's usage.
    const r = await m.finish();
    expect(r.status === "clean" && [micros(r.usd), micros(r.brainUsd ?? 0)]).toEqual([300_000, 20_000]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".brain"))).toEqual(["1001.brain"]);
  });

  test("BUG-631/variants: another process's file that can't be read (junk, torn, too big, another shape) makes the window unknown: no ✓", async () => {
    for (const [name, text] of [["junk", "{not json"], ["torn", '{"v":1,"pid":1001,"boot":"ab","lost":0,"calls":[{"n":1,"key":"k","en'], ["big", "x".repeat(70_000)], ["shape", JSON.stringify({ v: 1, pid: 1001, boot: "ab", lost: 0, calls: [{ n: 1, key: 5, end: "now", usd: "free" }] })]] as const) {
      const dir = fresh();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "1001.brain"), text);
      const key = nextKey();
      const or = fakeOpenRouter(20);
      const m = await processB(dir, key, or);
      or.bill(0.3);
      m.observe(0.25, true, 1);
      expect([name, await m.finish()]).toEqual([name, { status: "brain" }]);
    }
  });

  test("BUG-631/variants: an unreadable file of a day ago, or a file of a process dead for a day, is removed and says nothing; another file's replies are counted once however often it is read", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 2 * 86_400_000);
    writeFileSync(join(dir, "1.brain"), "{junk");
    utimesSync(join(dir, "1.brain"), old, old);
    const a = new BrainLog(dir, { pid: 1001, tailMs: 150_000, restrict: false });
    a.record("k", 1_000_000, 0.5);
    utimesSync(join(dir, "1001.brain"), old, old);
    const reg = new Registry(dir, { pid: 2002, alive: () => false });
    const lag = { minMs: 5, maxMs: 60 };
    const win = [{ from: 900_000, to: 900_001 }, { from: 2_000_000, to: 2_000_001 }] as const;
    // A day-old file of a dead process: removed, its (old) replies were taken first.
    reg.foreignBrain();
    reg.foreignBrain();
    expect(readdirSync(dir).filter((f) => f.endsWith(".brain"))).toEqual([]);
    expect(reg.foreignBrain().share("k", win[0], win[1], lag)).toEqual({ usd: 0.5, unknown: false, pending: false });
    // A running process's file read twice counts once; a process that restarted under the same pid (a new boot) is taken again from its first reply.
    const b = new BrainLog(dir, { pid: 1003, tailMs: 150_000, restrict: false });
    b.record("k2", 1_000_000, 0.25);
    const live = new Registry(dir, { pid: 2002, alive: () => true });
    live.foreignBrain();
    live.foreignBrain();
    expect(live.foreignBrain().share("k2", win[0], win[1], lag).usd).toBe(0.25);
    new BrainLog(dir, { pid: 1003, tailMs: 150_000, restrict: false }).record("k2", 1_000_010, 0.25);
    expect(live.foreignBrain().share("k2", win[0], win[1], lag).usd).toBe(0.5);
  });

  test("BUG-631/variants: the file is bounded: replies older than the tail plus a margin and those past the cap leave it, and the newest one dropped is kept as `lost` so a window that reaches back is unknown", () => {
    const dir = fresh();
    let now = 1_000_000;
    const a = new BrainLog(dir, { pid: 1001, tailMs: 150_000, now: () => now, restrict: false });
    a.record("k", now, 0.1);
    now += 150_000 + 600_000 + 1;
    a.record("k", now, 0.1);
    let file = JSON.parse(readFileSync(join(dir, "1001.brain"), "utf8"));
    expect(file.calls.map((c: { n: number }) => c.n)).toEqual([2]);
    expect(file.lost).toBe(1_000_000);
    for (let i = 0; i < 400; i++) a.record("k", now + i, 0);
    file = JSON.parse(readFileSync(join(dir, "1001.brain"), "utf8"));
    expect(file.calls.length).toBe(256);
    expect(file.lost).toBeGreaterThan(now);
    expect(statSync(join(dir, "1001.brain")).size).toBeLessThan(65_536);
    const reg = new Registry(dir, { pid: 2002, alive: () => true });
    const lag = { minMs: 5, maxMs: 60 };
    expect(reg.foreignBrain().share("k", { from: now - 10, to: now - 9 }, { from: now + 1_000_000, to: now + 1_000_001 }, lag).unknown).toBe(true);
    expect(reg.foreignBrain().share("k", { from: now + 1_000, to: now + 1_001 }, { from: now + 1_000_000, to: now + 1_000_001 }, lag).unknown).toBe(false);
  });

  test("BUG-631/variants: the brain's own reply goes to this process's list and to its file, and this process does not read its own file back (no double count)", async () => {
    const dir = fresh();
    const key = nextKey();
    const or = fakeOpenRouter(20);
    const a = new BrainLog(dir, { pid: 3003, tailMs: FAST.tailMs });
    const own = new BrainSpend();
    const m = await BilledMeter.begin({ key, source: brainTimings(), registry: new Registry(dir, { pid: 3003 }), fetch: or.fetch, brain: own });
    own.record(keyTag(key), stamp(), 0.02);
    a.record(keyTag(key), stamp(), 0.02);
    or.bill(0.02);
    or.bill(0.3);
    m.observe(0.25, true, 1);
    const r = await m.finish();
    expect(r.status === "clean" && [micros(r.usd), micros(r.brainUsd ?? 0)]).toEqual([300_000, 20_000]);
  });
});

describe("BUG-631/variants: an attempt the SDK retried may have been charged", () => {
  test("BUG-631/variants: a reply that took a retry has no known cost (the failed attempt was charged, only the last one's cost is in the answer): no ✓; without a retry it is known", async () => {
    const key = nextKey();
    const or = fakeOpenRouter(20, { failFirst: true });
    const m = await BilledMeter.begin({ key, source: brainTimings(), registry: new Registry(fresh()), fetch: or.fetch });
    await onOpenRouter(or, key, async () => {
      await askBrain();
    });
    expect(or.bodies.length).toBe(2);
    or.bill(0.3);
    m.observe(0.25, true, 1);
    expect(await m.finish()).toEqual({ status: "brain" });
    // The probe too.
    const key2 = nextKey();
    const or2 = fakeOpenRouter(20, { failFirst: true });
    const m2 = await BilledMeter.begin({ key: key2, source: brainTimings(), registry: new Registry(fresh()), fetch: or2.fetch });
    expect(await onOpenRouter(or2, key2, () => probeStep(defaults(), STEP, process.cwd()))).toMatchObject({ ok: true });
    expect(or2.bodies.length).toBe(2);
    or2.bill(0.3);
    m2.observe(0.25, true, 1);
    expect(await m2.finish()).toEqual({ status: "brain" });
  });
});

describe("BUG-631/variants: reading the other brains' files never throws, whatever is in the directory", () => {
  const lag = { minMs: 5, maxMs: 60 };
  const win = [{ from: Date.now() - 10_000, to: Date.now() - 9_999 }, { from: Date.now() + 1000, to: Date.now() + 1001 }] as const;
  const aDayAgo = () => new Date(Date.now() - 2 * 86_400_000);

  test("BUG-631/variants: a directory named like a brain file, a day old or new, is no file: no throw, no removal, and its window is unknown while it is new", () => {
    const dir = fresh();
    mkdirSync(join(dir, "4242.brain"), { recursive: true });
    const reg = new Registry(dir, { pid: 2002, alive: () => false });
    expect(reg.foreignBrain().share("k", win[0], win[1], lag).unknown).toBe(true);
    const old = aDayAgo();
    utimesSync(join(dir, "4242.brain"), old, old);
    const later = new Registry(dir, { pid: 2002, alive: () => false });
    expect(() => later.foreignBrain()).not.toThrow();
    expect(statSync(join(dir, "4242.brain")).isDirectory()).toBe(true);
  });

  test.skipIf(process.platform === "win32")("BUG-631/variants: a FIFO named like a brain file is not read (it would block): unreadable, so unknown", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(dir, "4242.brain")]).exitCode).toBe(0);
    const reg = new Registry(dir, { pid: 2002, alive: () => true });
    expect(reg.foreignBrain().share("k", win[0], win[1], lag).unknown).toBe(true);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("BUG-631/variants: a read-only registry directory with an old dead process's file and an old junk one: no throw, the files stay, the old file's replies were still taken", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const a = new BrainLog(dir, { pid: 4242, tailMs: 150_000, restrict: false });
    a.record("k", win[1].from - 6_000, 0.5); // inside the windows, which were fixed when the file loaded
    writeFileSync(join(dir, "4243.brain"), "{junk");
    const old = aDayAgo();
    for (const f of ["4242.brain", "4243.brain"]) utimesSync(join(dir, f), old, old);
    chmodSync(dir, 0o500);
    try {
      const reg = new Registry(dir, { pid: 2002, alive: () => false });
      let got: ReturnType<BrainSpend["share"]> | undefined;
      expect(() => (got = reg.foreignBrain().share("k", win[0], win[1], lag))).not.toThrow();
      expect(got).toEqual({ usd: 0.5, unknown: false, pending: false });
      expect(readdirSync(dir).filter((f) => f.endsWith(".brain")).sort()).toEqual(["4242.brain", "4243.brain"]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("BUG-631/variants: only `<pid>.brain` is ours: a stray `notes.brain`, old or new, is neither read nor removed", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.brain"), "my notes");
    const old = aDayAgo();
    utimesSync(join(dir, "notes.brain"), old, old);
    const reg = new Registry(dir, { pid: 2002, alive: () => false });
    expect(reg.foreignBrain().share("k", win[0], win[1], lag)).toEqual({ usd: 0, unknown: false, pending: false });
    expect(readFileSync(join(dir, "notes.brain"), "utf8")).toBe("my notes");
  });
});
