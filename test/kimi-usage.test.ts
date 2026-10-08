/**
 * Kimi Code's own cost figure (issue #39 follow-up): the usage records of `kimi export`, priced at Gluon's table. The record in the first test is
 * the one Kimi Code 2.1.1 wrote for a mock turn (prompt 1234, completion 56, cached 1000).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MODELS, isPlanConn } from "../src/harnesses.ts";
import { KIMI_ENV_MODEL, kimiCost, kimiPriceKey, KimiRecords, type KimiUsageRecord } from "../src/cost/kimi.ts";
import { priceKey } from "../src/cost/keys.ts";
import { Ledger } from "../src/cost/ledger.ts";
import { priceEntry } from "../src/cost/tables.ts";
import { CostTracker } from "../src/cost/tracker.ts";
import { exportUsage, kimiUsage, listedSessions, pickSession, readUsageZip, removeKimiExports, zipEntries, type Runner } from "../src/kimi-usage.ts";
import { SLOW } from "./e2e/harness.ts";
import { makeZip, usageLine } from "./fixtures/zip.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-kimi-usage-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const CAPTURED = { inputOther: 234, output: 56, inputCacheRead: 1000, inputCacheCreation: 0 };
const rec = (o: Partial<KimiUsageRecord> = {}): KimiUsageRecord => ({ agentId: "main", model: KIMI_ENV_MODEL, ...CAPTURED, usageScope: "turn", ...o });
const K3 = DEFAULT_MODELS["kimi-code"].find((m) => m.id === "kimi-k3")!;

describe("pricing", () => {
  test("a captured record is priced to the last digit: (234·in + 1000·cache_read + 56·out) / 1e6", () => {
    const c = kimiCost({ cost: { input: 3, output: 15, cache_read: 0.3 }, context: 1_048_576 }, CAPTURED);
    expect(c.usd).toBe((234 * 3 + 1000 * 0.3 + 0 * 3 + 56 * 15) / 1e6);
    expect(c.usd).toBe(0.001842);
    expect(c.micros).toBe(1842);
    expect(c.exact).toBe(true);
  });

  test("a missing cache price is the input price (cache read and creation)", () => {
    expect(kimiCost({ cost: { input: 2, output: 10 }, context: null }, { inputOther: 100, output: 10, inputCacheRead: 50, inputCacheCreation: 25 }).usd).toBe((100 * 2 + 50 * 2 + 25 * 2 + 10 * 10) / 1e6);
    expect(kimiCost({ cost: { input: 2, output: 10, cache_read: 1, cache_write: 4 }, context: null }, { inputOther: 100, output: 10, inputCacheRead: 50, inputCacheCreation: 25 }).usd).toBe((100 * 2 + 50 * 1 + 25 * 4 + 10 * 10) / 1e6);
  });

  test("the plan is priced as Moonshot's API price of the same model, OpenRouter at its own; the environment alias is the launched model", () => {
    expect(priceKey("kimi-code", K3.ids, "plan")).toBe("moonshotai/kimi-k3");
    expect(priceKey("kimi-code", K3.ids, "openrouter")).toBe("openrouter/moonshotai/kimi-k3");
    expect(priceEntry("moonshotai/kimi-k3")!.cost.input).toBeGreaterThan(0);
    expect(priceEntry("kimi-code-plan-global/k3")).toBeUndefined();
    expect(kimiPriceKey(KIMI_ENV_MODEL, "openrouter")).toEqual({ known: true });
    expect(priceKey("kimi-code", K3.ids, "moonshot")).toBe("moonshotai/kimi-k3");
    expect(kimiPriceKey("kimi-code/k3", "plan")).toEqual({ key: "moonshotai/kimi-k3", known: true });
    expect(kimiPriceKey("moonshotai/kimi-k3", "openrouter")).toEqual({ key: "openrouter/moonshotai/kimi-k3", known: true });
    expect(kimiPriceKey("something-else", "plan")).toEqual({ known: false });
  });

  function tracker(conn: "plan" | "openrouter" | "moonshot") {
    const ledger = new Ledger();
    const launchedKey = priceKey("kimi-code", K3.ids, conn);
    return { ledger, t: new CostTracker({ harness: "kimi-code", conn, ...(launchedKey ? { launchedKey } : {}), ledger }) };
  }

  test("an OpenRouter session: tokens × the OpenRouter price, every record once, subagents' too, both scopes; no audit pair", () => {
    const { t, ledger } = tracker("openrouter");
    const price = priceEntry("openrouter/moonshotai/kimi-k3")!;
    t.kimiRecords([rec(), rec({ agentId: "agent_sub1", usageScope: "turn" }), rec({ usageScope: "session", inputOther: 10, output: 5, inputCacheRead: 0 })]);
    const expected = kimiCost(price, CAPTURED).usd * 2 + kimiCost(price, { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 }).usd;
    expect(t.figure()).toEqual({ usd: expected, approx: false, own: true });
    const usage = ledger.entries.filter((e) => e.kind === "usage");
    expect(usage).toHaveLength(3);
    expect(usage[0]).toMatchObject({ harness: "kimi-code", model: "moonshotai/kimi-k3", connection: "openrouter", channel: "export", counts: { input: 234, output: 56, cacheRead: 1000, cacheWrite: 0 }, assumptions: [] });
    // Kimi reports no cost: there is nothing to compare ours with.
    expect(ledger.entries.filter((e) => e.kind === "observation")).toEqual([]);
  });

  test("a Moonshot session (issue #107): tokens × Moonshot's own price (`moonshotai/<id>`), exact (no `~`: a key bills it), no audit pair", () => {
    const { t, ledger } = tracker("moonshot");
    expect(isPlanConn("moonshot")).toBe(false);
    const price = priceEntry("moonshotai/kimi-k3")!;
    t.kimiRecords([rec(), rec({ model: "kimi-k3" })]);
    expect(t.figure()).toEqual({ usd: kimiCost(price, CAPTURED).usd * 2, approx: false, own: true });
    expect(ledger.entries.filter((e) => e.kind === "usage")[0]).toMatchObject({ harness: "kimi-code", model: "kimi-k3", connection: "moonshot", channel: "export", assumptions: [] });
    expect(ledger.entries.filter((e) => e.kind === "observation")).toEqual([]);
  });

  test("a plan session: the API-equivalent price, marked approximate (`~`)", () => {
    const { t, ledger } = tracker("plan");
    t.kimiRecords([rec({ model: "kimi-code/k3" }), rec({ model: "kimi-code/k3" })]);
    const price = priceEntry("moonshotai/kimi-k3")!;
    expect(isPlanConn("plan")).toBe(true);
    expect(t.figure()).toEqual({ usd: kimiCost(price, CAPTURED).usd * 2, approx: true, own: true });
    expect(t.figure()!.usd).toBeGreaterThan(0);
    expect(ledger.entries[0]).toMatchObject({ kind: "usage", connection: "plan", model: "kimi-k3", assumptions: [] });
  });

  test("a model name Gluon doesn't offer is priced at the launched model's, and says so", () => {
    const { t, ledger } = tracker("plan");
    t.kimiRecords([rec({ model: "kimi-code/k3-256k" })]);
    expect(t.figure()).toMatchObject({ approx: true, own: true });
    expect(ledger.entries[0]).toMatchObject({ assumptions: ["launched-model-price"] });
  });

  test("a model with no price has no figure of ours", () => {
    const t = new CostTracker({ harness: "kimi-code", conn: "openrouter", ledger: new Ledger() });
    t.kimiRecords([rec()]);
    expect(t.figure()).toBeUndefined();
  });
});

describe("records are counted once", () => {
  const by = (o: Record<string, KimiUsageRecord[]>) => new Map(Object.entries(o));

  test("the whole log again adds nothing; a longer one adds its new records; a shorter one adds nothing and never counts back", () => {
    const k = new KimiRecords();
    const a = rec();
    const b = rec({ usageScope: "session", inputOther: 1 });
    expect(k.fresh(by({ main: [a] }))).toEqual([a]);
    expect(k.fresh(by({ main: [a] }))).toEqual([]);
    expect(k.fresh(by({ main: [a, b], sub: [rec({ agentId: "sub" })] }))).toEqual([b, rec({ agentId: "sub" })]);
    expect(k.fresh(by({ main: [a] }))).toEqual([]);
    expect(k.fresh(by({ main: [a, b] }))).toEqual([]);
  });

  test("turn and session records are separate requests (Kimi's own fold adds both): a turn's record is not a total of the session's", () => {
    const k = new KimiRecords();
    const all = [rec({ usageScope: "turn" }), rec({ usageScope: "session" }), rec({ usageScope: "turn" })];
    const t = new CostTracker({ harness: "kimi-code", conn: "openrouter", launchedKey: priceKey("kimi-code", K3.ids, "openrouter")!, ledger: new Ledger() });
    t.kimiRecords(k.fresh(by({ main: all })));
    t.kimiRecords(k.fresh(by({ main: all })));
    expect(t.figure()!.usd).toBe(kimiCost(priceEntry("openrouter/moonshotai/kimi-k3")!, CAPTURED).usd * 3);
  });
});

describe("the session list", () => {
  const row = (id: string, createdAt: number, extra: object = {}) => ({ id, workDir: "/w", sessionDir: "/s", createdAt, updatedAt: createdAt + 5, archived: false, metadata: {}, ...extra });

  test("the only session created since the launch started is the launch's", () => {
    expect(pickSession(JSON.stringify([row("session_new", 2000), row("session_old", 500)]), 1000)).toEqual({ id: "session_new", updatedAt: 2005 });
    expect(pickSession(JSON.stringify([row("session_edge", 1000)]), 1000)).toMatchObject({ id: "session_edge" });
  });

  test("none, or more than one: no pick, never a guess", () => {
    expect(pickSession("[]", 1000)).toEqual({ reason: "none" });
    expect(pickSession(JSON.stringify([row("session_old", 999)]), 1000)).toEqual({ reason: "none" });
    expect(pickSession(JSON.stringify([row("session_a", 1500), row("session_b", 2500)]), 1000)).toEqual({ reason: "ambiguous", count: 2 });
  });

  test("an archived session, an odd id or a row of the wrong shape is no candidate; a list that isn't one is unreadable", () => {
    expect(pickSession(JSON.stringify([row("session_a", 1500, { archived: true })]), 1000)).toEqual({ reason: "none" });
    expect(pickSession(JSON.stringify([row("--evil", 1500), row("a b", 1500), { id: 3, createdAt: 2000 }, null, row("session_ok", "1500" as unknown as number)]), 1000)).toEqual({ reason: "none" });
    expect(pickSession("not json", 1000)).toEqual({ reason: "unreadable" });
    expect(pickSession('{"a":1}', 1000)).toEqual({ reason: "unreadable" });
    expect(listedSessions("[]")).toEqual([]);
  });
});

describe("the export's zip", () => {
  const PROMPT = "SECRET-PROMPT-do-not-keep sk-or-v1-abcdef";
  const wire = (lines: string[]) => `${lines.join("\n")}\n`;

  test("only a usage.record's numbers are kept: no prompt, message, tool text or other file of the zip", () => {
    const main = wire([
      JSON.stringify({ type: "turn.prompt", text: PROMPT }),
      usageLine(CAPTURED),
      JSON.stringify({ type: "context.append_message", message: { content: PROMPT }, note: '"usage.record" in a message' }),
      "not json at all with \"usage.record\" in it",
      usageLine({ inputOther: 5, output: 6, inputCacheRead: 7, inputCacheCreation: 8 }, { usageScope: "session" }),
    ]);
    const zip = makeZip({
      "manifest.json": JSON.stringify({ workspaceDir: "/home/me/secret-project" }),
      "agents/main/wire.jsonl": main,
      "agents/agent_sub1/wire.jsonl": wire([usageLine({ inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 }, { agentId: "agent_sub1", model: "kimi-code/k3" })]),
      "logs/global/kimi-code.log": PROMPT,
      "agents/main/plans/x.md": PROMPT,
    });
    const got = readUsageZip(zip);
    expect([...got.keys()]).toEqual(["main", "agent_sub1"]);
    expect(got.get("main")).toEqual([rec(), { agentId: "main", model: KIMI_ENV_MODEL, inputOther: 5, output: 6, inputCacheRead: 7, inputCacheCreation: 8, usageScope: "session" }]);
    expect(got.get("agent_sub1")).toEqual([{ agentId: "agent_sub1", model: "kimi-code/k3", inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4, usageScope: "turn" }]);
    const kept = JSON.stringify([...got]);
    expect(kept).not.toContain("SECRET");
    expect(kept).not.toContain("sk-or");
    expect(kept).not.toContain("secret-project");
    // Exactly these fields, nothing else.
    for (const r of got.get("main")!) expect(Object.keys(r).sort()).toEqual(["agentId", "inputCacheCreation", "inputCacheRead", "inputOther", "model", "output", "usageScope"]);
  });

  test("a stored entry reads as a deflated one; bad counts are 0; a file that isn't wire.jsonl is never inflated", () => {
    const zip = makeZip({ "agents/main/wire.jsonl": wire([JSON.stringify({ type: "usage.record", agentId: "main", model: "m", usage: { inputOther: -3, output: "x", inputCacheRead: 7 } })]), "logs/x.log": "garbage" }, ["agents/main/wire.jsonl"]);
    expect(readUsageZip(zip).get("main")).toEqual([{ agentId: "main", model: "m", inputOther: 0, output: 0, inputCacheRead: 7, inputCacheCreation: 0 }]);
  });

  test("a zip that isn't one throws", () => {
    expect(() => readUsageZip(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => readUsageZip(makeZip({ "agents/main/wire.jsonl": "x" }).subarray(0, 60))).toThrow();
  });
});

describe("kimi export into Gluon's private directory", () => {
  const zipOf = (n = 1) => makeZip({ "agents/main/wire.jsonl": `${Array.from({ length: n }, () => usageLine(CAPTURED)).join("\n")}\n`, "manifest.json": "{}" });
  const leftovers = (tmp: string) => readdirSync(tmp);

  function runnerWriting(zip: Uint8Array | null, code = 0, seen: { argv?: string[]; dir?: string; mode?: number } = {}): Runner {
    return (async (argv: string[]) => {
      seen.argv = argv;
      const out = argv[argv.indexOf("-o") + 1]!;
      seen.dir = dirname(out);
      seen.mode = statSync(seen.dir).mode & 0o777;
      if (zip) writeFileSync(out, zip);
      return { stdout: "", stderr: "", code };
    }) as Runner;
  }

  test("the zip is written into a fresh 0700 directory of Gluon's, read in memory, and the directory is gone", async () => {
    const tmp = mkdtempSync(join(TMP, "ok-"));
    const seen: { argv?: string[]; dir?: string; mode?: number } = {};
    const got = await exportUsage("kimi", "session_abc", { runner: runnerWriting(zipOf(2), 0, seen), tmp });
    expect("records" in got && got.records.get("main")).toHaveLength(2);
    expect(seen.argv!.slice(0, 3)).toEqual(["kimi", "export", "session_abc"]);
    expect(seen.argv).toContain("--no-include-global-log");
    expect(seen.argv).toContain("-y");
    expect(dirname(seen.dir!)).toBe(tmp);
    if (process.platform !== "win32") expect(seen.mode).toBe(0o700);
    expect(leftovers(tmp)).toEqual([]);
  });

  test("the zip is deleted when the export fails after writing it, when it is unreadable, and when the runner throws", async () => {
    for (const [zip, code, expected] of [[zipOf(), 1, "export-failed"], [new Uint8Array([9, 9, 9]), 0, "unreadable"], [null, 0, "export-failed"]] as const) {
      const tmp = mkdtempSync(join(TMP, "err-"));
      expect(await exportUsage("kimi", "session_abc", { runner: runnerWriting(zip, code), tmp })).toEqual({ reason: expected });
      expect(leftovers(tmp)).toEqual([]);
    }
    const tmp = mkdtempSync(join(TMP, "throw-"));
    const boom = (async (argv: string[]) => {
      writeFileSync(argv[argv.indexOf("-o") + 1]!, zipOf());
      throw new Error("spawn failed");
    }) as Runner;
    expect(await exportUsage("kimi", "session_abc", { runner: boom, tmp })).toEqual({ reason: "export-failed" });
    expect(leftovers(tmp)).toEqual([]);
  });

  test("an old directory of a killed Gluon is swept once; a young one is left", async () => {
    const tmp = mkdtempSync(join(TMP, "sweep-"));
    const old = join(tmp, "gluon-kimi-export-old");
    const young = join(tmp, "gluon-kimi-export-young");
    for (const d of [old, young]) {
      mkdirSync(d);
      writeFileSync(join(d, "session.zip"), "x");
    }
    const { utimesSync } = await import("node:fs");
    utimesSync(old, new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 2 * 3_600_000));
    await exportUsage("kimi", "session_abc", { runner: runnerWriting(zipOf()), tmp });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });
});

// Each launch of a test is in a directory of its own: launches of one directory are rivals of each other (`pickSession`).
let dirs = 0;

describe("the refresh cadence", () => {
  /** A fake `kimi`: its sessions (`list`) and the log of the session it exports. */
  function fake(sessions: () => object[], log: () => number, calls: string[] = []) {
    const runner = (async (argv: string[]) => {
      const verb = argv[1] === "session" ? "list" : "export";
      calls.push(verb);
      if (verb === "list") return { stdout: JSON.stringify(sessions()), stderr: "", code: 0 };
      writeFileSync(argv[argv.indexOf("-o") + 1]!, makeZip({ "agents/main/wire.jsonl": `${Array.from({ length: log() }, () => usageLine(CAPTURED)).join("\n")}\n` }));
      return { stdout: "", stderr: "", code: 0 };
    }) as Runner;
    return { runner, calls };
  }
  const session = (id: string, createdAt: number, updatedAt = createdAt) => ({ id, createdAt, updatedAt, archived: false });
  // An export is file work in a temp directory (slow on Windows): wait until what the test watches has been still for three short sleeps.
  const settle = async (watch: () => unknown = () => 0) => {
    let last = "";
    for (let quiet = 0; quiet < 3; ) {
      await new Promise((r) => setTimeout(r, 20 * SLOW));
      const now = JSON.stringify(watch());
      quiet = now === last ? quiet + 1 : 0;
      last = now;
    }
  };

  function setup(over: { sessions: () => object[]; log: () => number }) {
    const tmp = mkdtempSync(join(TMP, "cad-"));
    let clock = 10_000;
    const got: KimiUsageRecord[][] = [];
    const problems: string[] = [];
    const f = fake(over.sessions, over.log);
    const u = kimiUsage({ cwd: `/w${++dirs}`, startedAt: 5_000, onRecords: (r) => got.push(r), onProblem: (r) => problems.push(r), runner: f.runner, tmp, bin: () => "kimi", now: () => clock });
    return { u, got, problems, calls: f.calls, tick: async (ms = 0) => { clock += ms; u.tick(); await settle(() => [f.calls.length, got.length, problems.length]); }, tmp };
  }

  test("refreshes are at least 30 s apart; each record reaches the tracker once; an open session that hasn't changed is not exported again", async () => {
    let log = 1;
    let updated = 6_000;
    const s = setup({ sessions: () => [session("session_a", 6_000, updated), session("session_old", 100)], log: () => log });
    await s.tick();
    expect(s.calls).toEqual(["list", "export"]);
    expect(s.got).toHaveLength(1);
    await s.tick(10_000);
    await s.tick(10_000);
    expect(s.calls).toEqual(["list", "export"]);
    // Due, but nothing changed in the session: a list only.
    await s.tick(11_000);
    expect(s.calls).toEqual(["list", "export", "list"]);
    log = 3;
    updated = 7_000;
    await s.tick(30_000);
    expect(s.calls).toEqual(["list", "export", "list", "list", "export"]);
    expect(s.got.map((r) => r.length)).toEqual([1, 2]);
    expect(s.u.session).toBe("session_a");
  });

  test("no session yet: looked for again sooner; ambiguous: said once, nothing exported", async () => {
    let sessions: object[] = [];
    const s = setup({ sessions: () => sessions, log: () => 1 });
    await s.tick();
    expect(s.problems).toEqual(["none"]);
    await s.tick(5_000);
    expect(s.calls).toEqual(["list"]);
    sessions = [session("session_a", 6_000), session("session_b", 7_000)];
    await s.tick(6_000);
    await s.tick(11_000);
    expect(s.problems).toEqual(["none", "ambiguous"]);
    expect(s.calls.filter((c) => c === "export")).toEqual([]);
    expect(s.got).toEqual([]);
    expect(s.u.session).toBeUndefined();
    expect(s.u.problem).toBe("ambiguous");
  });

  test("once known the launch's session stays it: a /new makes another one, which is not counted and does not unset it", async () => {
    let sessions: object[] = [session("session_a", 6_000, 6_100)];
    const s = setup({ sessions: () => sessions, log: () => 2 });
    await s.tick();
    sessions = [session("session_a", 6_000, 6_200), session("session_b", 20_000)];
    await s.tick(31_000);
    expect(s.u.session).toBe("session_a");
    expect(s.got.map((r) => r.length)).toEqual([2]);
    expect(s.problems).toEqual([]);
  });

  test("at its end Kimi's session is exported once more, whatever the cadence and its updatedAt say; two concurrent refreshes never run", async () => {
    let log = 1;
    const s = setup({ sessions: () => [session("session_a", 6_000, 6_100)], log: () => log });
    await s.tick();
    s.u.tick();
    s.u.tick();
    log = 4;
    await s.u.end();
    expect(s.got.map((r) => r.length)).toEqual([1, 3]);
    expect(s.calls.filter((c) => c === "export")).toHaveLength(2);
    expect(readdirSync(s.tmp)).toEqual([]);
  });

  test("a failing export is said once and the next one that works counts", async () => {
    let fail = true;
    const tmp = mkdtempSync(join(TMP, "fail-"));
    const problems: string[] = [];
    const got: KimiUsageRecord[][] = [];
    let clock = 10_000;
    const ok = fake(() => [session("session_a", 6_000)], () => 1).runner;
    const runner = (async (argv: string[], ...rest: unknown[]) => (fail && argv[1] === "export" ? { stdout: "", stderr: "x", code: 1 } : (ok as (...a: unknown[]) => unknown)(argv, ...rest))) as Runner;
    const u = kimiUsage({ cwd: `/w${++dirs}`, startedAt: 5_000, onRecords: (r) => got.push(r), onProblem: (r) => problems.push(r), runner, tmp, bin: () => "kimi", now: () => clock });
    u.tick();
    await settle(() => [got.length, problems.length]);
    clock += 31_000;
    u.tick();
    await settle(() => [got.length, problems.length]);
    expect(problems).toEqual(["export-failed"]);
    fail = false;
    clock += 31_000;
    u.tick();
    await settle(() => [got.length, problems.length]);
    expect(got).toHaveLength(1);
    expect(u.problem).toBeUndefined();
  });
});

describe("two launches of Kimi in one directory", () => {
  const row = (id: string, createdAt: number) => ({ id, createdAt, updatedAt: createdAt, archived: false });
  const list = (...r: ReturnType<typeof row>[]) => JSON.stringify(r);

  test("BUG-478/concurrent: a session another launch could own is no pick; one it has is never one", () => {
    // B started at 2000 and has no session yet: a session created after that is A's or B's.
    expect(pickSession(list(row("s_b", 2500)), 1000, { pending: [2000] })).toEqual({ reason: "ambiguous", count: 1 });
    // One created before B started can only be A's, even when B's is listed too.
    expect(pickSession(list(row("s_a", 1500), row("s_b", 2500)), 1000, { pending: [2000] })).toEqual({ id: "s_a", updatedAt: 1500 });
    // B's own pick: A (earlier, no session) could own anything B can.
    expect(pickSession(list(row("s_b", 2500)), 2000, { pending: [1000] })).toEqual({ reason: "ambiguous", count: 1 });
    // A session already claimed is skipped; once A has its own, B's pick is plain.
    expect(pickSession(list(row("s_a", 1500), row("s_b", 2500)), 2000, { claimed: new Set(["s_a"]) })).toEqual({ id: "s_b", updatedAt: 2500 });
  });

  test("BUG-478/concurrent: A looks while only B's session exists: neither takes it for its own, the cost is not counted twice", async () => {
    const tmp = mkdtempSync(join(TMP, "conc-"));
    let sessions: object[] = [];
    const calls: string[] = [];
    const runner = (async (argv: string[]) => {
      if (argv[1] === "session") return { stdout: JSON.stringify(sessions), stderr: "", code: 0 };
      calls.push(argv[2]!);
      writeFileSync(argv[argv.indexOf("-o") + 1]!, makeZip({ "agents/main/wire.jsonl": `${usageLine(CAPTURED)}\n` }));
      return { stdout: "", stderr: "", code: 0 };
    }) as Runner;
    const mk = (startedAt: number, got: KimiUsageRecord[][]) => kimiUsage({ cwd: "/same", startedAt, onRecords: (r) => got.push(r), runner, tmp, bin: () => "kimi", now: () => Date.now() + 1e9, refreshMs: 0, lookMs: 0 });
    const ga: KimiUsageRecord[][] = [];
    const gb: KimiUsageRecord[][] = [];
    const a = mk(1000, ga);
    const b = mk(2000, gb);
    const sess = (id: string, createdAt: number) => ({ id, createdAt, updatedAt: createdAt, archived: false });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    sessions = [sess("s_b", 2500)];
    a.tick();
    b.tick();
    await settle();
    expect(a.session).toBeUndefined();
    expect(b.session).toBeUndefined();
    expect(calls).toEqual([]);
    // A's session appears before B's: it is A's alone, and then B's is B's.
    sessions = [sess("s_a", 1500), sess("s_b", 2500)];
    a.tick();
    await settle();
    expect(a.session).toBe("s_a");
    b.tick();
    await settle();
    expect(b.session).toBe("s_b");
    expect(calls.sort()).toEqual(["s_a", "s_b"]);
    await a.end();
    await b.end();
  });

  test("a launch that never started is no rival", async () => {
    const mk = (startedAt: number) => kimiUsage({ cwd: "/dispose", startedAt, onRecords: () => {}, runner: (async () => ({ stdout: JSON.stringify([{ id: "s_b", createdAt: 2500, updatedAt: 2500 }]), stderr: "", code: 0 })) as Runner, tmp: TMP, bin: () => "kimi", now: () => Date.now() + 1e9, refreshMs: 0, lookMs: 0 });
    const a = mk(1000);
    const b = mk(2000);
    a.dispose();
    b.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(b.session).toBe("s_b");
    await b.end();
  });
});

describe("a hostile zip", () => {
  test("BUG-479/zip bomb: the wire logs together are capped, not only each one", () => {
    const big = "a".repeat(1_000_000);
    const zip = makeZip({ "agents/a/wire.jsonl": big, "agents/b/wire.jsonl": big, "agents/c/wire.jsonl": big });
    expect(zipEntries(zip, (n) => n === "agents/a/wire.jsonl", 2_000_000).size).toBe(1);
    expect(() => zipEntries(zip, (n) => n.endsWith("wire.jsonl"), 2_000_000)).toThrow();
    expect(zipEntries(zip, (n) => n.endsWith("wire.jsonl"), 3_000_000).size).toBe(3);
    // Stored entries count too.
    expect(() => zipEntries(makeZip({ "agents/a/wire.jsonl": big, "agents/b/wire.jsonl": big }, ["agents/a/wire.jsonl", "agents/b/wire.jsonl"]), () => true, 1_500_000)).toThrow();
  });

  test("a deflate stream that inflates far beyond what the directory says is cut at the cap", () => {
    const zip = makeZip({ "agents/a/wire.jsonl": "a".repeat(5_000_000) });
    // The central directory lies about the size: 10 bytes.
    const b = Buffer.from(zip);
    const cd = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    b.writeUInt32LE(10, cd + 24);
    expect(() => zipEntries(new Uint8Array(b), () => true, 1_000_000)).toThrow();
  });
});

describe("a quit that doesn't wait for the export", () => {
  test("BUG-480/crash: removeKimiExports takes away a directory still in use", async () => {
    const tmp = mkdtempSync(join(TMP, "quit-"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = (async (argv: string[]) => {
      writeFileSync(argv[argv.indexOf("-o") + 1]!, makeZip({ "agents/main/wire.jsonl": "x\n" }));
      await gate;
      return { stdout: "", stderr: "", code: 0 };
    }) as Runner;
    const pending = exportUsage("kimi", "session_abc", { runner, tmp });
    await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(tmp)).toHaveLength(1);
    removeKimiExports();
    expect(readdirSync(tmp)).toEqual([]);
    release();
    await pending;
    expect(readdirSync(tmp)).toEqual([]);
  });
});

// ---- QA of Kimi's export (B4) ----

describe("QA cost: a corrupt export", () => {
  const good = () => makeZip({ "agents/main/wire.jsonl": [usageLine(CAPTURED), usageLine({ ...CAPTURED, output: 7 })].join("\n"), "agents/sub/wire.jsonl": usageLine(CAPTURED, { agentId: "sub" }), "session.json": "{}" });

  test("a zip cut at any length, or with a byte changed anywhere, is a records map or an Error: never a hang, never another kind of throw", () => {
    const zip = good();
    const outcomes = new Set<string>();
    const t0 = performance.now();
    const check = (bytes: Uint8Array) => {
      try {
        readUsageZip(bytes);
        outcomes.add("ok");
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        outcomes.add("error");
      }
    };
    for (let len = 0; len < zip.length; len += 3) check(zip.subarray(0, len));
    for (let i = 0; i < zip.length; i += 2) {
      for (const v of [0, 0xff, zip[i]! ^ 0x55]) {
        const copy = zip.slice();
        copy[i] = v;
        check(copy);
      }
    }
    expect(performance.now() - t0).toBeLessThan(3000 * SLOW);
    expect([...outcomes].sort()).toEqual(["error", "ok"]);
  });

  test("a wire log with invalid UTF-8, a line that only mentions usage.record, and records in the wrong shape keeps only the real ones", () => {
    const bytes = Buffer.concat([
      Buffer.from(`${JSON.stringify({ type: "message", text: 'a "usage.record" in a message' })}\n`),
      Buffer.from([0xff, 0xfe, 0x0a]),
      Buffer.from(`${JSON.stringify({ type: "usage.record", usage: "oops" })}\n${JSON.stringify({ type: "usage.record", usage: null })}\n{"type":"usage.record","usage":{"output":5\n`),
      Buffer.from(usageLine(CAPTURED)),
    ]);
    const zip = makeZip({ "agents/main/wire.jsonl": bytes.toString("latin1") });
    const got = readUsageZip(zip).get("main") ?? [];
    expect(got).toHaveLength(1);
    expect(got[0]!.output).toBe(56);
  });

  test("two sessions' folders with the same agent id never merge, and a path trick in the name is just a key", () => {
    const zip = makeZip({ "agents/main/wire.jsonl": usageLine(CAPTURED), "agents/../wire.jsonl": usageLine(CAPTURED), "x/agents/main/wire.jsonl": usageLine(CAPTURED), "agents/a/b/wire.jsonl": usageLine(CAPTURED) });
    const got = readUsageZip(zip);
    expect([...got.keys()].sort()).toEqual(["..", "main"]);
  });
});
