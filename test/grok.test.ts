/**
 * Grok Build's cost and context figures (issue #39): its OTLP protobuf export (the real captured
 * bytes of a 1.0.46 run against a mock backend, and its other captures re-encoded from their
 * decoded attributes), the decoder's limits, the listener, Gluon's own estimate and its audit.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeEnv, withTelemetry, type Command } from "../src/launchers.ts";
import { grokCost, grokWindow, grokWindowOf, GROK_DEFAULT_WINDOW } from "../src/cost/grok.ts";
import { ownWindow, windowIsGuess } from "../src/cost/context.ts";
import { defaultSpawn, MAX_USAGE_BYTES, parseGrokUsage, readGrokUsage, UUID, type SpawnUsage } from "../src/cost/grok-usage.ts";
import { Ledger } from "../src/cost/ledger.ts";
import { GROK_OBSERVED_WINDOWS, type GrokModelsTable, type GrokObservedWindowsTable, type ModelsDevTable } from "../src/cost/tables.ts";
import { defaultModels, grokTable, trim } from "../scripts/pricing/grok.ts";
import { decodeLogs } from "../src/otlp-protobuf.ts";
import { ownTelemetry, startTelemetry, SUBAGENT_STALE_MS, TELEMETRY_HEADER, telemetryLaunch, type ContextFigure, type UsageEvent } from "../src/telemetry.ts";
import { FROZEN_GROK_MODELS, FROZEN_TABLE, frozenTableWith, frozenTracker } from "./fixtures/frozen-prices.ts";
import { FIXTURE_GROK_MODELS as GROK_MODELS, FIXTURE_MODELS_DEV as MODELS_DEV } from "./fixtures/fixture-tables.ts";
import { encodeLogs, fromDecoded, lenField, varint } from "./fixtures/otlp-protobuf.ts";

const DIR = join(import.meta.dir, "fixtures", "telemetry");
const server = startTelemetry();
afterAll(() => server.stop());

const canon = new Uint8Array(readFileSync(join(DIR, "grok-1.0.46-canon-logs.bin")));
const decodedFixture = (name: string) => Object.values(JSON.parse(readFileSync(join(DIR, name), "utf8")) as Record<string, { eventName?: string; attributes: Record<string, unknown> }[]>).flat();

/** Posts protobuf bodies to a fresh launch and returns what its callbacks got. */
async function post(bodies: Uint8Array[], path = "/v1/logs") {
  const usages: UsageEvent[] = [];
  const contexts: (ContextFigure | null)[] = [];
  const s = server.session({ onUsage: (u) => usages.push(u), onContext: (c) => contexts.push(c) });
  const responses: Response[] = [];
  for (const body of bodies) responses.push(await fetch(`${server.endpoint}${path}`, { method: "POST", headers: { "content-type": "application/x-protobuf", [TELEMETRY_HEADER]: s.token }, body }));
  s.close();
  return { usages, contexts, responses };
}

describe("the protobuf decoder (src/otlp-protobuf.ts)", () => {
  test("the real captured body of Grok Build 1.0.46: event names from field 12, the typed attributes, as OTLP/JSON", () => {
    const records = (decodeLogs(canon).resourceLogs[0] as { scopeLogs: { logRecords: { attributes: { key: string; value: Record<string, string | boolean> }[] }[] }[] }).scopeLogs.flatMap((s) => s.logRecords);
    const attr = (r: (typeof records)[number], k: string) => Object.values(r.attributes.find((a) => a.key === k)?.value ?? {})[0];
    expect(records.map((r) => attr(r, "event.name"))).toEqual(["grok_code.auth", "grok_code.session_start", "grok_code.model_switched", "grok_code.user_prompt", "grok_code.api_request", "grok_code.turn_completed", "grok_code.assistant_response", "grok_code.session_end"]);
    const api = records.find((r) => attr(r, "event.name") === "grok_code.api_request")!;
    expect(["model", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_creation_tokens"].map((k) => attr(api, k))).toEqual(["spike-1", "20000", "500", "200", "15000", "0"]);
    expect(records[2]!.attributes.find((a) => a.key === "success")!.value).toEqual({ boolValue: true });
  });

  test("malformed bytes throw, never hang or allocate: every truncation of the real body, a varint of 11 bytes, a length past the end, field number 0, a deep or huge message", () => {
    for (let n = 1; n < canon.length; n += 7) {
      try {
        decodeLogs(canon.subarray(0, n));
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
    expect(() => decodeLogs(Uint8Array.from([0x08, ...Array(11).fill(0xff), 0x01]))).toThrow(/varint/);
    expect(() => decodeLogs(Uint8Array.from([0x0a, 0x7f, 0x01]))).toThrow(/truncated/);
    expect(() => decodeLogs(Uint8Array.from([0x00, 0x01]))).toThrow(/field number 0/);
    expect(() => decodeLogs(Uint8Array.from([0x0b]))).toThrow(/wire type/);
    const many = new Uint8Array(5000 * 2).map((_, i) => (i % 2 === 0 ? 0x08 : 0x01));
    expect(() => decodeLogs(many)).toThrow(/too many fields/);
    const attrs = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
    expect(() => decodeLogs(encodeLogs([{ eventName: "x", attributes: attrs }]))).toThrow(/too many attributes/);
    // Random garbage: an error or an empty result, within a time bound.
    const rnd = new Uint8Array(4096);
    for (let i = 0; i < 200; i++) {
      crypto.getRandomValues(rnd);
      try {
        decodeLogs(rnd);
      } catch {}
    }
  });

  test("the encoder used by these tests round-trips what the decoder reads (ints, strings, bools; an event with no name)", () => {
    const body = encodeLogs([{ eventName: "e.one", attributes: { a: "x", b: 7, c: true } }, { attributes: { "event.name": "e.two" } }]);
    const records = (decodeLogs(body).resourceLogs[0] as { scopeLogs: { logRecords: { attributes: { key: string; value: object }[] }[] }[] }).scopeLogs[0]!.logRecords;
    expect(records[0]!.attributes).toEqual([{ key: "a", value: { stringValue: "x" } }, { key: "b", value: { intValue: "7" } }, { key: "c", value: { boolValue: true } }, { key: "event.name", value: { stringValue: "e.one" } }]);
    expect(records[1]!.attributes).toEqual([{ key: "event.name", value: { stringValue: "e.two" } }]);
    expect(varint(300)).toEqual(Uint8Array.from([0xac, 0x02]));
    expect(lenField(1, new Uint8Array(0))).toEqual(Uint8Array.from([0x0a, 0x00]));
  });
});

describe("the listener takes Grok's protobuf", () => {
  test("a real request: answered 200 with an empty protobuf body; its api_request is one usage event (input includes the cache reads, output the reasoning), and the context is input + output", async () => {
    const { usages, contexts, responses } = await post([canon]);
    expect([responses[0]!.status, responses[0]!.headers.get("content-type"), (await responses[0]!.arrayBuffer()).byteLength]).toEqual([200, "application/x-protobuf", 0]);
    expect(usages).toEqual([{ harness: "grok-build", model: "spike-1", input: 20_000, output: 500, reasoning: 200, cacheRead: 15_000, cacheWrite: 0, reportedMicros: expect.any(Number), subagent: false, session: expect.stringMatching(UUID) }]);
    expect(contexts).toEqual([{ tokens: 20_500, model: "spike-1" }]);
  });

  test("a re-sent batch counts once; metrics are taken and dropped; a malformed body is a 400; no token, 401; JSON still works", async () => {
    const twice = await post([canon, canon]);
    expect(twice.usages.length).toBe(1);
    expect((await post([canon], "/v1/metrics")).responses[0]!.status).toBe(200);
    expect((await post([Uint8Array.from([0x0a, 0x7f])])).responses[0]!.status).toBe(400);
    expect((await fetch(`${server.endpoint}/v1/logs`, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: canon })).status).toBe(401);
    const s = server.session({});
    expect((await fetch(`${server.endpoint}/v1/logs`, { method: "POST", headers: { "content-type": "application/json", [TELEMETRY_HEADER]: s.token }, body: "{}" })).status).toBe(200);
    s.close();
  });

  test("a real turn with 300k input (100k cached), a compaction: the context follows each main request, then is unknown (its `tokens_after` isn't the new size)", async () => {
    const records = fromDecoded(decodedFixture("grok-1.0.46-tui-300k-compaction.decoded.json").filter((r) => r.eventName !== "grok_code.auth"));
    const { usages, contexts } = await post(records.map((r) => encodeLogs([r])));
    expect(usages.map((u) => (u.harness === "grok-build" ? [u.input, u.output, u.cacheRead, u.reasoning] : []))).toEqual([[30_000, 100, 0, 0], [300_000, 1_000, 100_000, 400]]);
    // Grok's own footer read "301K / 500K" for the second.
    expect(contexts).toEqual([{ tokens: 30_100, model: "spike-1" }, { tokens: 301_000, model: "spike-1" }, null]);
  });

  test("a subagent's requests count for cost but not for the context: none while one runs (its first request, before the `launched` event, can't be told apart)", async () => {
    const records = fromDecoded(decodedFixture("grok-1.0.46-subagent.decoded.json"));
    const { usages, contexts } = await post(records.map((r) => encodeLogs([r])));
    expect(usages.map((u) => (u.harness === "grok-build" ? u.input : 0))).toEqual([50_000, 1_000, 7_000]);
    expect(usages.map((u) => u.harness === "grok-build" && u.subagent)).toEqual([false, false, true]);
    expect(contexts.map((c) => c?.tokens)).toEqual([50_500, 1_010]);
  });
});

describe("a subagent that never completes (BUG-401)", () => {
  /** The subagent fixture without its `completed` record (an interrupted subagent sends none), then the main thread's next request (2,000 in, 20 out). */
  const lost = () => {
    const records = fromDecoded(decodedFixture("grok-1.0.46-subagent.decoded.json").filter((r) => !(r.eventName === "grok_code.subagent" && r.attributes.phase === "completed")));
    const next = fromDecoded(decodedFixture("grok-1.0.46-subagent.decoded.json").filter((r) => r.eventName === "grok_code.api_request").slice(0, 1).map((r) => ({ ...r, attributes: { ...r.attributes, input_tokens: { int: "2000" }, output_tokens: { int: "20" } } })), 1_000_000_000n);
    return { before: records.map((r) => encodeLogs([r])), next: next.map((r) => encodeLogs([r])) };
  };
  const send = async (srv: ReturnType<typeof startTelemetry>, token: string, bodies: Uint8Array[]) => {
    for (const b of bodies) await fetch(`${srv.endpoint}/v1/logs`, { method: "POST", headers: { "content-type": "application/x-protobuf", [TELEMETRY_HEADER]: token }, body: b });
  };

  test("BUG-401/subagent-lost-on-turn-end: the turn's end clears the count, so the next main request moves the context again (it stayed frozen at the subagent's `launched` for good)", async () => {
    const { before, next } = lost();
    const contexts: (ContextFigure | null)[] = [];
    const s = server.session({ onContext: (c) => contexts.push(c) });
    await send(server, s.token, before);
    expect(contexts.map((c) => c?.tokens)).toEqual([50_500, 1_010]);
    s.turnEnded();
    await send(server, s.token, next);
    expect(contexts.map((c) => c?.tokens)).toEqual([50_500, 1_010, 2_020]);
    s.close();
  });

  test("BUG-401/subagent-lost-timeout: with no turn end either, a count nothing moved for SUBAGENT_STALE_MS is a lost record: the next request is the main thread's (and until then it is not)", async () => {
    let clock = 1_000_000;
    const srv = startTelemetry({ now: () => clock });
    try {
      const { before, next } = lost();
      const contexts: (ContextFigure | null)[] = [];
      const s = srv.session({ onContext: (c) => contexts.push(c) });
      await send(srv, s.token, before);
      clock += SUBAGENT_STALE_MS - 1;
      await send(srv, s.token, next);
      expect(contexts.map((c) => c?.tokens)).toEqual([50_500, 1_010]);
      clock += 2;
      const again = fromDecoded(decodedFixture("grok-1.0.46-subagent.decoded.json").filter((r) => r.eventName === "grok_code.api_request").slice(0, 1).map((r) => ({ ...r, attributes: { ...r.attributes, input_tokens: { int: "3000" }, output_tokens: { int: "30" } } })), 2_000_000_000n).map((r) => encodeLogs([r]));
      await send(srv, s.token, again);
      expect(contexts.map((c) => c?.tokens)).toEqual([50_500, 1_010, 3_030]);
      s.close();
    } finally {
      srv.stop();
    }
  });
});

describe("Grok's own estimate (src/cost/grok.ts), audited against the server's figure", () => {
  const table = (cost: object): ModelsDevTable => frozenTableWith({ "xai/spike-1": { cost, context: 500_000 } as never });
  const tiered = { input: 2, output: 6, cache_read: 0.5, tiers: [{ tier: { type: "context", size: 200_000 }, input: 4, output: 12, cache_read: 1 }] };

  test("uncached input, cache reads and output (reasoning inside it); no cache-write price; the 200k tier is a named assumption", () => {
    const entry = { cost: tiered, context: 500_000 };
    expect(grokCost(entry, { input: 20_000, cacheRead: 15_000, output: 500 })).toMatchObject({ usd: (5_000 * 2 + 15_000 * 0.5 + 500 * 6) / 1e6, assumptions: [] });
    const long = grokCost(entry, { input: 300_000, cacheRead: 100_000, output: 1_000 });
    expect(long.usd).toBeCloseTo((200_000 * 4 + 100_000 * 1 + 1_000 * 12) / 1e6, 12);
    expect(long.assumptions).toEqual(["long-context-tier-assumed"]);
    expect(grokCost(entry, { input: 200_000, cacheRead: 0, output: 0 }).assumptions).toEqual([]);
    // More cached than the prompt: capped, never negative.
    expect(grokCost(entry, { input: 100, cacheRead: 999, output: 0 }).usd).toBeCloseTo((100 * 0.5) / 1e6, 12);
  });

  test("the tracker prices every request and audits it against cost_usd_micros (floored by the server: a micro under is rounding); a difference no cause explains stays one", () => {
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "grok-build", conn: "xai", ledger, table: table(tiered), now: () => 1 });
    t.grokRequest({ model: "spike-1", input: 20_000, output: 500, reasoning: 200, cacheRead: 15_000, cacheWrite: 0, reportedMicros: 20_499 });
    expect(t.figure()).toEqual({ usd: 0.0205, approx: false, own: true });
    expect(ledger.divergences()).toEqual([]);
    t.grokRequest({ model: "spike-1", input: 20_000, output: 500, reasoning: 200, cacheRead: 15_000, cacheWrite: 0, reportedMicros: 90_000 });
    expect(ledger.divergences().map((d) => d.cause)).toEqual(["unexplained"]);
    // The 200k tier basis: a server that didn't double the prices makes the tier the named cause.
    const l2 = new Ledger();
    const t2 = frozenTracker({ harness: "grok-build", conn: "xai", ledger: l2, table: table(tiered), now: () => 1 });
    t2.grokRequest({ model: "spike-1", input: 300_000, output: 1_000, reasoning: 0, cacheRead: 100_000, cacheWrite: 0, reportedMicros: (200_000 * 2 + 100_000 * 0.5 + 1_000 * 6) });
    expect(l2.divergences().map((d) => d.cause)).toEqual(["long-context-tier"]);
  });

  test("a model with no price: the server's own costs, summed, are shown (marked); with none stamped (a plan's usual case) there is no figure", () => {
    const t = frozenTracker({ harness: "grok-build", conn: "plan", ledger: new Ledger(), now: () => 1 });
    t.grokRequest({ model: "grok-9", input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect(t.figure()).toBeUndefined();
    t.grokRequest({ model: "grok-9", input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, reportedMicros: 1_500 });
    t.grokRequest({ model: "grok-9", input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, reportedMicros: 500 });
    expect(t.figure()).toEqual({ usd: 0.002, approx: true, own: false });
  });

  test("the bundled table prices Grok's models (a plan as the xAI API) and its windows are Grok's own: 500k from its binary, grok-4.7's 256k observed", () => {
    const plan = frozenTracker({ harness: "grok-build", conn: "plan" });
    plan.grokRequest({ model: "grok-4.7", input: 10_000, cacheRead: 4_000, output: 100, reasoning: 0, cacheWrite: 0 });
    expect(plan.figure()).toMatchObject({ usd: (6_000 * 2 + 4_000 * 0.5 + 100 * 6) / 1e6, approx: true, own: true });
    expect(["grok-4.7", "grok-4.6", "grok-4.5"].map(grokWindow)).toEqual([256_000, 500_000, 500_000]);
    expect(grokWindow("no-such-model")).toBe(GROK_DEFAULT_WINDOW);
  });
});

describe("Grok's launch", () => {
  test("protobuf OTLP to the launch's listener with its token; prompts and content off; nothing when your environment has telemetry settings of its own", () => {
    const session = { token: "t0k", endpoint: "http://127.0.0.1:4318" };
    const l = telemetryLaunch("grok-build", session, { PATH: "/bin" })!;
    expect(l.argv).toEqual([]);
    expect(l.env).toMatchObject({ GROK_EXTERNAL_OTEL: "1", OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_EXPORTER_OTLP_HEADERS: `${TELEMETRY_HEADER}=t0k`, OTEL_LOG_USER_PROMPTS: "0", OTEL_LOG_TOOL_CONTENT: "0" });
    for (const own of ["GROK_EXTERNAL_OTEL", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME"]) {
      expect(ownTelemetry({ [own]: "x" }, "grok-build")).toBe(true);
      expect(telemetryLaunch("grok-build", session, { [own]: "x" })).toBeNull();
    }
    // Through a launch: the variables join the command's environment, the argv and the spec untouched, and the environment stays safe.
    const cmd: Command = { argv: ["grok", "-m", "grok-4.7", "--", "- fix it"], env: { XAI_API_KEY: "k" }, spec: "- fix it", harness: "grok-build", conn: "xai" };
    const launched = withTelemetry(cmd, l);
    expect(launched.argv).toEqual(cmd.argv);
    expect(launched.env.GROK_EXTERNAL_OTEL).toBe("1");
    expect(launched.env.XAI_API_KEY).toBe("k");
    expect(() => assertSafeEnv(launched.env)).not.toThrow();
    // The Claude variable is not Grok's, and Antigravity has no telemetry to add.
    expect(telemetryLaunch("grok-build", session, { CLAUDE_CODE_ENABLE_TELEMETRY: "1" })).not.toBeNull();
    expect(telemetryLaunch("antigravity", session, {})).toBeNull();
  });
});

describe("`grok usage <session>`: Grok's own persisted totals, an audit (src/cost/grok-usage.ts)", () => {
  const fixture = (name: string) => readFileSync(join(DIR, name), "utf8");

  test("the real output of 1.0.46: turns, the server's cost floored to micro-USD (a tick is 1e-10 USD), tokens with the cache reads included", () => {
    expect(parseGrokUsage(fixture("grok-1.0.46-usage-canon-usage.json"))).toEqual({ turns: 1, micros: 12_345, partial: false, inputTokens: 20_000, outputTokens: 500, cachedReadTokens: 15_000, modelCalls: 1 });
  });

  test("a turn the server stamped no cost on: the report is partial, and the audit skips it", () => {
    const r = parseGrokUsage(fixture("grok-1.0.46-usage-partial-cost-3-turns.json"))!;
    expect([r.turns, r.partial]).toEqual([3, true]);
    const ledger = new Ledger();
    frozenTracker({ harness: "grok-build", conn: "xai", ledger }).grokUsageReport(r);
    expect(ledger.entries).toEqual([]);
  });

  test("junk and hostile output is no report, never an exception", () => {
    for (const bad of ["", "nope", "[]", "null", '{"session":3,"turns":[]}', '{"session":{},"turns":"x"}', JSON.stringify({ session: {}, turns: new Array(100_001).fill({}) })]) expect(parseGrokUsage(bad)).toBeNull();
    expect(parseGrokUsage('{"session":{"costUsdTicks":-1,"inputTokens":"x"},"turns":[]}')).toMatchObject({ micros: null, inputTokens: 0 });
  });

  test("only a UUID is ever run (an id from the agent's own export is untrusted): GROK_DISABLE_AUTOUPDATER set, the id the last argument; no binary, no run", async () => {
    const calls: { argv: string[]; env: Record<string, string | undefined> }[] = [];
    const spawn: SpawnUsage = async (argv, o) => (calls.push({ argv, env: o.env }), fixture("grok-1.0.46-usage-canon-usage.json"));
    const id = "01a10748-9317-7c11-8fcc-b3dde48d5344";
    expect(UUID.test(id)).toBe(true);
    for (const bad of ["", "--debug", "../../etc/passwd", `${id} x`, "01a10748-9317-7c11-8fcc"]) expect(await readGrokUsage(bad, { spawn, bin: "/x/grok" })).toBeNull();
    expect(await readGrokUsage(id, { spawn, bin: null })).toBeNull();
    expect(calls).toEqual([]);
    expect((await readGrokUsage(id, { spawn, bin: "/x/grok", env: { PATH: "/bin" } }))?.micros).toBe(12_345);
    expect(calls[0]!.argv).toEqual(["/x/grok", "usage", id]);
    expect(calls[0]!.env.GROK_DISABLE_AUTOUPDATER).toBe("1");
  });

  test("the data lands after the Stop hook: retried until a newer turn shows; a failing or never-newer run is null after its tries", async () => {
    const id = "01a10748-9317-7c11-8fcc-b3dde48d5344";
    let n = 0;
    const late: SpawnUsage = async () => (++n < 3 ? null : fixture("grok-1.0.46-usage-canon-usage.json"));
    expect((await readGrokUsage(id, { spawn: late, bin: "/x/grok", delayMs: 1 }))?.turns).toBe(1);
    expect(n).toBe(3);
    // Already audited that turn: nothing newer, so none.
    n = 0;
    const same: SpawnUsage = async () => (n++, fixture("grok-1.0.46-usage-canon-usage.json"));
    expect(await readGrokUsage(id, { spawn: same, bin: "/x/grok", delayMs: 1, tries: 3, after: 1 })).toBeNull();
    expect(n).toBe(3);
    expect(await readGrokUsage(id, { spawn: async () => Promise.reject(new Error("boom")), bin: "/x/grok", delayMs: 1, tries: 2 })).toBeNull();
  });

  test("the audit: our own total against Grok's, cumulative, at the request count the report holds; a subagent's requests are in both (BUG-391), rounding is none", () => {
    const table: ModelsDevTable = frozenTableWith({ "xai/spike-1": { cost: { input: 2, output: 6, cache_read: 0.5 }, context: 500_000 } as never });
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "grok-build", conn: "xai", ledger, table, now: () => 1 });
    const main = { model: "spike-1", input: 20_000, output: 500, reasoning: 0, cacheRead: 15_000, cacheWrite: 0 };
    const report = (turns: number, micros: number, modelCalls: number) => ({ turns, micros, partial: false, inputTokens: 20_000, outputTokens: 500, cachedReadTokens: 15_000, modelCalls });
    t.grokRequest(main);
    // The server's total (floored): equal to ours within a micro.
    t.grokUsageReport(report(1, 20_499, 1));
    t.grokRequest({ ...main, subagent: true });
    // `grok usage` counts the subagent's request: 2 calls, and the sum of both.
    t.grokUsageReport(report(2, 41_000, 2));
    t.grokUsageReport(report(3, 99_999, 2));
    expect(ledger.entries.filter((e) => e.kind === "observation").map((e) => (e as { cause?: string }).cause)).toEqual(["none", "none", "unexplained"]);
  });

  test("BUG-390/audit-waits-for-the-requests: a report that counts more requests than Gluon has received waits (no observation), is audited at ITS count when the last arrives, and is a dropped entry when they never do", () => {
    const table: ModelsDevTable = frozenTableWith({ "xai/spike-1": { cost: { input: 2, output: 6, cache_read: 0.5 }, context: 500_000 } as never });
    const main = { model: "spike-1", input: 20_000, output: 500, reasoning: 0, cacheRead: 15_000, cacheWrite: 0 };
    const report = (turns: number, micros: number, modelCalls: number) => ({ turns, micros, partial: false, inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, modelCalls });
    const observed = (l: Ledger) => l.entries.filter((e) => e.kind === "observation") as { ownMicros: number; reportedMicros: number; cause: string }[];
    // 20,500 micros a request. The report, read 1 s early, holds 2 requests; Gluon has the first.
    const a = new Ledger();
    let now = 0;
    const t = frozenTracker({ harness: "grok-build", conn: "xai", ledger: a, table, now: () => now, grokUsageTimeoutMs: 10_000 });
    t.grokRequest(main);
    t.grokUsageReport(report(1, 41_000, 2));
    expect(a.entries.filter((e) => e.kind !== "usage")).toEqual([]);
    t.grokRequest(main);
    expect(observed(a).map((o) => [o.ownMicros, o.reportedMicros, o.cause])).toEqual([[41_000, 41_000, "none"]]);
    t.grokRequest(main);
    t.grokUsageReport(report(2, 61_500, 3));
    t.grokRequest(main);
    t.grokUsageReport(report(3, 82_000, 4));
    t.grokRequest(main);
    t.grokUsageReport(report(3, 143_500, 7));
    expect(observed(a).map((o) => [o.ownMicros, o.cause]).slice(1)).toEqual([[61_500, "none"], [82_000, "none"]]);
    // Requests that never come: waiting, then dropped when the clock moves on (the next request or the end), never a divergence.
    now = 1_000;
    now += 11_000;
    t.grokRequest(main);
    expect(observed(a)).toHaveLength(3);
    expect(a.entries.at(-1)).toMatchObject({ kind: "dropped", what: "cost", reason: "grok-usage-unmatched", count: 1 });
    // The end of the session drops one still waiting.
    const b = new Ledger();
    const u = frozenTracker({ harness: "grok-build", conn: "xai", ledger: b, table, now: () => 1 });
    u.grokUsageReport(report(1, 20_500, 1));
    u.grokEnded();
    u.grokEnded();
    expect(b.entries).toEqual([expect.objectContaining({ kind: "dropped", reason: "grok-usage-unmatched" })]);
    // The next turn's request arrived before the report of the previous turn was looked at: it is compared at its own count (2), not at ours (3).
    const d = new Ledger();
    const w = frozenTracker({ harness: "grok-build", conn: "xai", ledger: d, table, now: () => 1 });
    for (let i = 0; i < 3; i++) w.grokRequest(main);
    w.grokUsageReport(report(1, 41_000, 2));
    expect(observed(d).map((o) => [o.ownMicros, o.reportedMicros, o.cause])).toEqual([[41_000, 41_000, "none"]]);
    // A report without `modelCalls` has no count to wait for: compared at once, as before.
    const c = new Ledger();
    const v = frozenTracker({ harness: "grok-build", conn: "xai", ledger: c, table, now: () => 1 });
    v.grokRequest(main);
    v.grokUsageReport(report(1, 20_500, 0));
    expect(observed(c)).toHaveLength(1);
  });
});

describe("Grok's own model table (scripts/pricing/grok.ts; issue #39)", () => {
  const embedded = JSON.stringify({ default: "grok-4.6", models: [{ id: "grok-4.6", model: "grok-4.6", context_window: 500_000, auto_compact_threshold_percent: 80, name: "Grok é" }, { id: "grok-5", context_window: 2_000_000 }, { id: "bad id!", context_window: 1 }, { id: "grok-x", context_window: 0 }] }, null, 2);

  test("BUG-406/grok-catalog-one-decode: a binary full of braces before the catalog (each a candidate for its opening) is decoded once, not once per brace, and the same catalog comes out (multi-byte text before it included)", () => {
    const catalog = JSON.stringify({ models: [{ id: "grok-5", context_window: 2_000_000 }] });
    // 1,500 balanced `{}` inside a string between the catalog's `{` and its "models" key: each is tried first, and fails quickly.
    const bytes = Buffer.concat([Buffer.from("é\u00e9 \x00"), Buffer.from(`{"k":"${"{}".repeat(1_500)}",${catalog.slice(1)}`), Buffer.alloc(100_000, 0x78)]);
    const decode = Buffer.prototype.toString;
    let decodes = 0;
    Buffer.prototype.toString = function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
      if (args[0] === "utf8") decodes++;
      return decode.apply(this, args);
    } as never;
    try {
      const found = defaultModels(bytes);
      expect(found?.catalog.models).toEqual([{ id: "grok-5", context_window: 2_000_000 }]);
    } finally {
      Buffer.prototype.toString = decode;
    }
    expect(decodes).toBeLessThanOrEqual(3);
  });

  test("BUG-342/grok-table-generator: the embedded default_models.json is found in a binary's bytes and parsed (never evaluated); models.dev seeds what it lacks, marked", () => {
    const bytes = Buffer.concat([Buffer.from('\x00{"models":[1]} junk "models": ['), Buffer.from(embedded), Buffer.from("\x00default_models.json: invalid JSON")]);
    const found = defaultModels(bytes)!;
    expect(found.text).toBe(embedded);
    expect(defaultModels(Buffer.from('nothing {"models": [{"id": "x"}]}'))).toBeNull();
    const dev = { "xai/grok-4.6": { cost: { input: 2, output: 6 }, context: 123 }, "xai/grok-4.7": { cost: { input: 3, output: 9, cache_read: 1 }, context: 500_000 }, "openai/gpt-6": { cost: { input: 1, output: 1 }, context: 9 } } as never;
    const observed = { schema: 1, source: "observed", note: "t", models: { "grok-4.7": { context: 256_000, observedAt: "2026-10-04", grokVersion: "1.0.46", evidence: "t" } } } as const;
    expect(trim(found.catalog, dev, observed)).toEqual({
      // The binary's window wins over models.dev's; the price its catalog lacks is the seed's.
      "grok-4.6": { context: 500_000, source: "binary", autoCompactPercent: 80, cost: { input: 2, output: 6 }, costSource: "models.dev-seed" },
      // models.dev's window (500k) is never taken: the seeded model has its price and the observed window.
      "grok-4.7": { context: 256_000, source: "observed", cost: { input: 3, output: 9, cache_read: 1 }, costSource: "models.dev-seed" },
      "grok-5": { context: 2_000_000, source: "binary" },
    });
  });

  test("BUG-342/grok-table-bundled: the committed table names its source, version and digest, marks what is a seed, and carries Grok 4.5/4.6 at 500k and 4.7 at the observed 256k", () => {
    expect(GROK_MODELS).toMatchObject({ schema: 1, source: "grok binary default_models.json", grokVersion: "1.0.46" });
    expect(GROK_MODELS.digest).toMatch(/^[0-9a-f]{64}$/);
    // The live table may list more (the daily refresh seeds models.dev's): these three are the ones whose window is pinned.
    const windows = Object.fromEntries(Object.entries(GROK_MODELS.models).map(([id, m]) => [id, [m.context, m.source]]));
    expect(windows["grok-4.5"]).toEqual([500_000, "binary"]);
    expect(windows["grok-4.6"]).toEqual([500_000, "binary"]);
    expect(windows["grok-4.7"]).toEqual([256_000, "observed"]);
    for (const m of Object.values(GROK_MODELS.models)) if (m.cost) expect(m.costSource).toBe("models.dev-seed");
  });

  test("BUG-342/grok-window-from-table: the window is the table's, then the default (a guess); the source says which", () => {
    const table: GrokModelsTable = { ...GROK_MODELS, models: { "grok-t": { context: 123_456, source: "binary" } } };
    expect(grokWindowOf("grok-t", table)).toEqual({ window: 123_456, source: "grok-table" });
    expect(grokWindowOf("nope", table)).toEqual({ window: GROK_DEFAULT_WINDOW, source: "grok-default" });
    // A name like a prototype key is no model.
    expect(grokWindowOf("constructor", table).source).toBe("grok-default");
    expect(ownWindow("grok-build", "grok-4.5")).toEqual({ window: 500_000, source: "grok-table" });
    expect(ownWindow("grok-build", "grok-9")).toEqual({ window: GROK_DEFAULT_WINDOW, source: "grok-default" });
  });

  const observedTable = (models: GrokObservedWindowsTable["models"]): GrokObservedWindowsTable => ({ schema: 1, source: "observed", note: "test", models });
  const seen = (context: number) => ({ context, observedAt: "2026-10-04", grokVersion: "1.0.46", evidence: "test" });

  test("BUG-396/grok-4.7-window-is-256k-observed: grok-4.7 is not in Grok 1.0.46's catalog, so its window is the observed table's 256,000 (its footer read 13K / 256K and 17K / 256K), not models.dev's 500,000", () => {
    expect(GROK_OBSERVED_WINDOWS).toMatchObject({ schema: 1, source: "observed", models: { "grok-4.7": { context: 256_000, observedAt: "2026-10-04", grokVersion: "1.0.46" } } });
    expect(GROK_OBSERVED_WINDOWS.models["grok-4.7"]!.evidence).toContain("13K / 256K");
    // The footer's K is 1000 (301K / 500K for 301,000 of 500,000 tokens above): 256K is 256,000, not 262,144.
    expect(GROK_MODELS.models["grok-4.7"]).toMatchObject({ context: 256_000, source: "observed", costSource: "models.dev-seed" });
    expect(ownWindow("grok-build", "grok-4.7")).toEqual({ window: 256_000, source: "grok-observed" });
    expect(MODELS_DEV.entries["xai/grok-4.7"]?.context).toBe(500_000);
    expect(windowIsGuess("grok-observed")).toBe(false);
  });

  test("BUG-397/grok-window-precedence: the binary's window, then the observed table's, then none (the default, a guess); models.dev's `limit.context` is never one", () => {
    const observed = observedTable({ "grok-o": seen(256_000), "grok-b": seen(111_000) });
    const table: GrokModelsTable = { ...GROK_MODELS, models: { "grok-b": { context: 500_000, source: "binary" }, "grok-p": { cost: { input: 1, output: 2 }, costSource: "models.dev-seed" } } };
    // Both hold grok-b: the binary's wins. Only the observed table holds grok-o (a table built before it was added: an overlay).
    expect(grokWindowOf("grok-b", table, observed)).toEqual({ window: 500_000, source: "grok-table" });
    expect(grokWindowOf("grok-o", table, observed)).toEqual({ window: 256_000, source: "grok-observed" });
    // A generated table's `observed` window is read as the observed one.
    expect(grokWindowOf("grok-g", { ...table, models: { "grok-g": { context: 256_000, source: "observed" } } }, observedTable({}))).toEqual({ window: 256_000, source: "grok-observed" });
    // Neither: a model models.dev lists with a 500,000 window, one with a price only in the table, one nobody lists.
    for (const m of ["grok-4.20-0309-reasoning", "grok-p", "grok-nobody"]) expect(grokWindowOf(m, table, observed)).toEqual({ window: GROK_DEFAULT_WINDOW, source: "grok-default" });
    expect(windowIsGuess("grok-default")).toBe(true);
    // Generated: a model the binary lacks gets models.dev's price and the observed window, or no window at all, never models.dev's.
    const dev = { "xai/grok-o": { cost: { input: 1, output: 2 }, context: 500_000 }, "xai/grok-n": { cost: { input: 1, output: 2 }, context: 500_000 } } as never;
    const models = trim({ models: [{ id: "grok-b", context_window: 500_000 }] }, dev, observed);
    expect(models["grok-o"]).toEqual({ context: 256_000, source: "observed", cost: { input: 1, output: 2 }, costSource: "models.dev-seed" });
    expect(models["grok-n"]).toEqual({ cost: { input: 1, output: 2 }, costSource: "models.dev-seed" });
    expect(models["grok-b"]).toEqual({ context: 500_000, source: "binary" });
  });

  test("BUG-398/grok-observed-notice: when the binary lists a model the observed table holds, the generator says to remove it and uses the binary's window; the daily script prints it", () => {
    const lines: string[] = [];
    const observed = observedTable({ "grok-4.7": seen(256_000), "grok-9": seen(256_000) });
    const bytes = Buffer.from(JSON.stringify({ models: [{ id: "grok-4.6", context_window: 500_000 }, { id: "grok-4.7", context_window: 262_144 }] }));
    const table = grokTable(bytes, { grokVersion: "1.0.47", generatedAt: "2026-10-05", observed, notice: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("grok-4.7 is now in Grok's catalog: remove it from grok-observed-windows.json");
    expect(table.models["grok-4.7"]).toMatchObject({ context: 262_144, source: "binary" });
    // grok-9 is still observed only.
    expect(table.models["grok-9"]).toMatchObject({ context: 256_000, source: "observed" });
    // No notice for a model the binary doesn't list.
    const quiet: string[] = [];
    grokTable(bytes, { grokVersion: "1.0.47", generatedAt: "x", observed: observedTable({ "grok-9": seen(1_000) }), notice: (l) => quiet.push(l) });
    expect(quiet).toEqual([]);
    // The script itself: a binary (bytes only, the version given so it is never run) and an observed file.
    const dir = mkdtempSync(join(tmpdir(), "gluon-grok-observed-"));
    try {
      writeFileSync(join(dir, "grok.bin"), bytes);
      writeFileSync(join(dir, "observed.json"), JSON.stringify(observed));
      const run = Bun.spawnSync([process.execPath, "--no-env-file", "--config=scripts/empty-bunfig.toml", "scripts/pricing/grok.ts", "--binary", join(dir, "grok.bin"), "--grok-version", "1.0.47", "--generated-at", "2026-10-05", "--observed", join(dir, "observed.json"), "--out", join(dir, "out.json")], { cwd: join(import.meta.dir, ".."), env: process.env, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toContain("notice: grok-4.7 is now in Grok's catalog: remove it from grok-observed-windows.json");
      expect(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).models["grok-4.7"]).toMatchObject({ context: 262_144, source: "binary" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("BUG-342/grok-price-from-table: a price in Grok's table is used before models.dev's, and the request is tagged with the table's digest; without one models.dev's price and digest", () => {
    const table: GrokModelsTable = { ...FROZEN_GROK_MODELS, digest: "ab".repeat(32), models: { "grok-t": { context: 1, source: "binary", cost: { input: 10, output: 20, cache_read: 5 }, costSource: "binary" } } };
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "grok-build", conn: "xai", ledger, grokTable: table, now: () => 1 });
    t.grokRequest({ model: "grok-t", input: 1000, cacheRead: 400, output: 100, reasoning: 0, cacheWrite: 0 });
    t.grokRequest({ model: "grok-4.7", input: 1000, cacheRead: 400, output: 100, reasoning: 0, cacheWrite: 0 });
    const usage = ledger.entries.filter((e) => e.kind === "usage") as { ownMicros: number; table: string }[];
    // 600 uncached x 10 + 400 cached x 5 + 100 out x 20 = $0.01, tagged by the table; the other model's $0.002 by models.dev.
    expect(usage.map((u) => [u.ownMicros, u.table])).toEqual([[10_000, "abababab"], [2_000, FROZEN_TABLE.catalogDigest.slice(0, 8)]]);
  });
});

describe("`grok usage` is bounded and audits only what this launch spent (issue #39)", () => {
  const id = "01a10748-9317-7c11-8fcc-b3dde48d5344";
  const opts = { cwd: tmpdir(), env: { PATH: process.env.PATH }, timeoutMs: 20_000 };

  test("BUG-340/usage-stdout-cap: a process printing past MAX_USAGE_BYTES is killed and read as null; one within it is read whole", async () => {
    // cwd is the temp dir, so there is no bunfig to skip (and Windows has no /dev/null for --config).
    const print = (bytes: number) => [process.execPath, "--no-env-file", "-e", `process.stdout.write("x".repeat(${bytes}))`];
    expect((await defaultSpawn(print(1000), opts))?.length).toBe(1000);
    expect(await defaultSpawn(print(MAX_USAGE_BYTES + 1), opts)).toBeNull();
    expect(await defaultSpawn([process.execPath, "--no-env-file", "-e", "process.exit(3)"], opts)).toBeNull();
  });

  test("BUG-340/usage-no-double-dash: the session id is the last argument with no `--` (nothing in the repo shows `grok usage` takes one; a UUID can't start with `-` anyway)", async () => {
    const calls: string[][] = [];
    const spawn: SpawnUsage = async (argv) => (calls.push(argv), readFileSync(join(DIR, "grok-1.0.46-usage-canon-usage.json"), "utf8"));
    await readGrokUsage(id, { spawn, bin: "/x/grok" });
    expect(calls).toEqual([["/x/grok", "usage", id]]);
    expect(UUID.test("-1a10748-9317-7c11-8fcc-b3dde48d5344")).toBe(false);
  });

  test("BUG-341/grok-resume-baseline: the history a resumed or forked session inherited (`grok usage` totals it) is taken off the cumulative audit, so only this launch's spend is compared", () => {
    const table: ModelsDevTable = frozenTableWith({ "xai/spike-1": { cost: { input: 2, output: 6, cache_read: 0.5 }, context: 500_000 } as never });
    const main = { model: "spike-1", input: 20_000, output: 500, reasoning: 0, cacheRead: 15_000, cacheWrite: 0 };
    // 5,000 uncached x 2 + 15,000 x 0.5 + 500 x 6 = $0.0205 = 20,500 micros.
    const report = (micros: number, turns: number, modelCalls = 1) => ({ turns, micros, partial: false, inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, modelCalls });
    const causes = (ledger: Ledger) => ledger.entries.filter((e) => e.kind === "observation").map((e) => (e as { cause?: string; reportedMicros: number }).cause);

    // Without a baseline the inherited $1.00 reads as a huge unexplained difference.
    const plain = new Ledger();
    const a = frozenTracker({ harness: "grok-build", conn: "xai", ledger: plain, table, now: () => 1 });
    a.grokRequest(main);
    a.grokUsageReport(report(1_020_500, 4));
    expect(causes(plain)).toEqual(["unexplained"]);

    // Read before the first turn (`grok usage` of the resumed id): 1,000,000 micros.
    const before = new Ledger();
    const b = frozenTracker({ harness: "grok-build", conn: "xai", ledger: before, table, now: () => 1 });
    // Its history is 3 requests: the report counts them beside this launch's.
    b.grokBaseline(1_000_000, 3);
    b.grokRequest(main);
    b.grokUsageReport(report(1_020_500, 4, 4));
    b.grokRequest({ ...main, subagent: true });
    b.grokUsageReport(report(1_041_000, 5, 5));
    expect(causes(before)).toEqual(["none", "none"]);
    expect(before.entries.filter((e) => e.kind === "observation").map((e) => (e as { reportedMicros: number }).reportedMicros)).toEqual([20_500, 41_000]);

    // Not read in time: the first full report is taken instead (a partial one is skipped, the next tries again), and later ones compare.
    const late = new Ledger();
    const c = frozenTracker({ harness: "grok-build", conn: "xai", ledger: late, table, now: () => 1 });
    c.grokRequest(main);
    expect(c.grokBaselineFromReport({ ...report(1_020_500, 4, 4), partial: true })).toBe(false);
    expect(c.grokBaselineFromReport(report(1_020_500, 4, 4))).toBe(true);
    c.grokUsageReport(report(1_020_500, 4, 4));
    c.grokRequest(main);
    c.grokUsageReport(report(1_041_000, 5, 5));
    expect(causes(late)).toEqual(["none", "none"]);
    // A junk baseline changes nothing.
    c.grokBaseline(Number.NaN);
    c.grokBaseline(-5);
    c.grokUsageReport(report(1_041_000, 5, 5));
    expect(causes(late).at(-1)).toBe("none");
  });
});
