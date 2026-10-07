/**
 * Gluon's per-session signals: `status` events (parsing, caps, safe text), the hook → event round
 * trip, the telemetry listener (real HTTP POSTs of OTLP JSON) and context windows.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { statusHook, toolActivity } from "../src/adapters/common.ts";
import { RETURN_COMMAND } from "../src/handoff.ts";
import { ACTIVITY_MAX, EVENTS_PER_READ, formatEvent, MAX_STATUS_BYTES, parseEvent, parseStatus, readEvents, safeLine, writeEvent, type StatusInfo } from "../src/events.ts";
import { assertSafeEnv, withTelemetry, type Command } from "../src/launchers.ts";
import { claudeContextWindow, codexContextWindows, contextPercent } from "../src/models.ts";
import { MAX_TELEMETRY_BYTES, startTelemetry, TELEMETRY_HEADER, telemetryLaunch, type ContextFigure, type TurnCostEvent, type UsageEvent } from "../src/telemetry.ts";
import { BUN_FLAGS, SYSTEM_ENV } from "./e2e/harness.ts";

const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "gluon-status-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const eventsDir = () => mkdtempSync(join(TMP, `ev-${++n}-`));
const ESC = "\x1b";
const RLO = String.fromCharCode(0x202e);

describe("status events", () => {
  test("parsed strictly: an object of known fields with the right types and bounds; unknown fields dropped", () => {
    expect(parseEvent('status {"state":"working","activity":"Bash: bun test"}')).toEqual({ name: "status", status: { state: "working", activity: "Bash: bun test" } });
    expect(parseEvent('status {"costUsd":0.42,"contextTokens":41512.4,"contextWindow":1000000,"model":"claude-opus-5-5[1m]","extra":true}')).toEqual({
      name: "status",
      status: { costUsd: 0.42, contextTokens: 41512, contextWindow: 1_000_000, model: "claude-opus-5-5[1m]" },
    });
    for (const s of ["working", "awaiting", "done"]) expect(parseStatus(`{"state":"${s}"}`)).toEqual({ state: s } as StatusInfo);
    const refused = [
      "",
      "null",
      "[]",
      '"working"',
      "{}",
      '{"extra":1}',
      '{"state":"sleeping"}',
      '{"state":1}',
      '{"activity":42}',
      '{"costUsd":-1}',
      '{"costUsd":"1"}',
      '{"costUsd":1e7}',
      '{"contextTokens":1e10}',
      '{"model":"a b"}',
      '{"model":"x;rm -rf"}',
      '{"model":""}',
      "{not json",
    ];
    for (const json of refused) expect([json, parseStatus(json)]).toEqual([json, null]);
    // A wrong field refuses the whole event, not only the field.
    expect(parseStatus('{"state":"working","costUsd":"free"}')).toBeNull();
    // Only `status <json>`: not a bare name, nor an id in its place.
    for (const text of ["status", "status working", "status  ", 'status{"state":"done"}']) expect(parseEvent(text)).toBeNull();
    expect(parseEvent("back")).toEqual({ name: "back" });
    expect(parseEvent("compact c1")).toEqual({ name: "compact", id: "c1" });
  });

  test("the activity is one line safe to draw: escapes, controls and bidi overrides gone, at most 120 characters", () => {
    expect(safeLine(`Bash: ${ESC}[2J${ESC}]0;title${String.fromCharCode(7)}ls\r\n-la\t${RLO}x${ESC}P1;2|x${ESC}\\ end`)).toBe("Bash: ls -la x end");
    expect(safeLine(`${String.fromCharCode(0x9b)}31mred${String.fromCharCode(0x9d)}8;;evil${String.fromCharCode(0x9c)} ok`)).toBe("red ok");
    const long = safeLine(`Read ${"a".repeat(300)}`);
    expect([...long].length).toBe(ACTIVITY_MAX);
    expect(long).toEndWith("…");
    expect(parseStatus(JSON.stringify({ state: "working", activity: `${ESC}[31m  ${String.fromCharCode(0)} ` }))).toEqual({ state: "working" });
    // Keys are masked like anything Gluon shows.
    expect(parseStatus(JSON.stringify({ activity: "Bash: curl -H 'x-api-key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz' api" }))!.activity).toBe("Bash: curl -H 'x-api-key: sk-ant-••••' api");
  });

  test("BUG-169/F: every format character goes from an activity line — the Arabic letter mark, bidi marks and isolates, zero-width and invisible characters", () => {
    const fmt = [0x061c, 0x200b, 0x200e, 0x200f, 0x202a, 0x202d, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0xfff9, 0xe0041];
    for (const cp of fmt) expect([cp.toString(16), safeLine(`a${String.fromCodePoint(cp)}b`)]).toEqual([cp.toString(16), "a b"]);
    // A zero-width joiner only goes: the emoji's pieces stay next to each other.
    expect(safeLine("Read 👨\u200d👩 ok")).toBe("Read 👨👩 ok");
    expect(safeLine(`x${String.fromCharCode(0x2028)}y${String.fromCharCode(0x2029)}z`)).toBe("x y z");
  });

  test("BUG-177/F: a backlog of status files drains a batch per read, and the seen names stay only while their files do", () => {
    const dir = eventsDir();
    for (let i = 0; i < 450; i++) writeFileSync(join(dir, `${String(i).padStart(6, "0")}.event`), 'status {"state":"working"}');
    writeFileSync(join(dir, "zzzzzz.event"), "back");
    const seen = new Set<string>();
    expect(readEvents(dir, seen).length).toBe(EVENTS_PER_READ);
    expect(readEvents(dir, seen).length).toBe(EVENTS_PER_READ);
    expect(readEvents(dir, seen).map((e) => e.name)).toEqual([...Array(50).fill("status"), "back"]);
    expect(readEvents(dir, seen)).toEqual([]);
    // Status files were removed on read: only the `back` event's name is remembered.
    expect([...seen]).toEqual(["zzzzzz.event"]);
    rmSync(join(dir, "zzzzzz.event"));
    readEvents(dir, seen);
    expect(seen.size).toBe(0);
  });

  test.skipIf(process.platform === "win32")("BUG-165/F: a symlink or a directory named like an event is never read or followed", () => {
    const dir = eventsDir();
    const outside = join(TMP, `outside-${n}`);
    writeFileSync(outside, "back");
    symlinkSync(outside, join(dir, "0001.event"));
    mkdirSync(join(dir, "0002.event"));
    expect(writeEvent(dir, { name: "compact", id: "c9" })).toBe(true);
    expect(readEvents(dir, new Set())).toEqual([{ name: "compact", id: "c9" }]);
    expect(existsSync(outside)).toBe(true);
  });

  test("caps: a status up to 4 KB, the others 256 bytes; a larger file is never read; writeEvent refuses what wouldn't be read", () => {
    const dir = eventsDir();
    const big: StatusInfo = { activity: "x".repeat(MAX_STATUS_BYTES) };
    expect(writeEvent(dir, { name: "status", status: big })).toBe(false);
    expect(writeEvent(dir, { name: "status", status: { state: "done", activity: "x".repeat(3000) } })).toBe(true);
    writeFileSync(join(dir, "0001.event"), `status ${JSON.stringify({ state: "working", activity: "y".repeat(MAX_STATUS_BYTES) })}`);
    writeFileSync(join(dir, "0002.event"), `back ${"x".repeat(300)}`);
    writeFileSync(join(dir, "0003.event"), `status {"state":"awaiting"}${" ".repeat(MAX_STATUS_BYTES)}`);
    const got = readEvents(dir, new Set());
    expect(got.map((e) => [e.name, e.status?.state, e.status?.activity?.length])).toEqual([["status", "done", ACTIVITY_MAX]]);
  });

  test("written and read back in order; status files are removed once read, the others stay", () => {
    const dir = eventsDir();
    expect(writeEvent(dir, { name: "status", status: { state: "working", activity: "Read src/cli.tsx" } })).toBe(true);
    expect(writeEvent(dir, { name: "compact", id: "c1" })).toBe(true);
    expect(writeEvent(dir, { name: "status", status: { state: "awaiting" } })).toBe(true);
    const seen = new Set<string>();
    expect(readEvents(dir, seen)).toEqual([
      { name: "status", status: { state: "working", activity: "Read src/cli.tsx" } },
      { name: "compact", id: "c1" },
      { name: "status", status: { state: "awaiting" } },
    ]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".event")).length).toBe(1);
    expect(readEvents(dir, seen)).toEqual([]);
    expect(formatEvent({ name: "status", status: { state: "done" } })).toBe('status {"state":"done"}');
  });

  test("BUG-296/resume: a session event is removed once read (Codex sends one with every hook; a long session must not fill the directory)", () => {
    const dir = eventsDir();
    for (let i = 0; i < 50; i++) expect(writeEvent(dir, { name: "session", id: "019f3a2c-7b1e" })).toBe(true);
    expect(writeEvent(dir, { name: "back" })).toBe(true);
    const seen = new Set<string>();
    const got = readEvents(dir, seen, 100);
    expect(got.filter((e) => e.name === "session")).toHaveLength(50);
    expect(readdirSync(dir).filter((f) => f.endsWith(".event"))).toHaveLength(1);
    expect(seen.size).toBe(1);
    expect(readEvents(dir, seen)).toEqual([]);
  });

  test("the activity line from a tool call, in the harnesses' shapes", () => {
    expect(toolActivity("Bash", { command: "bun test\nsecond line" })).toBe("Bash: bun test\nsecond line");
    expect(toolActivity("Edit", { file_path: "/w/r/src/a.ts", old_string: "x" }, "/w/r/")).toBe("Edit src/a.ts");
    expect(toolActivity("Edit", { file_path: "/w/rx/src/a.ts" }, "/w/r")).toBe("Edit /w/rx/src/a.ts");
    expect(toolActivity("WebFetch", { url: "https://x.dev", prompt: "p" })).toBe("WebFetch https://x.dev");
    expect(toolActivity("Glob", { pattern: "**/*.ts" })).toBe("Glob **/*.ts");
    expect(toolActivity("exec", { cmd: ["git", "status"] })).toBe("exec: git status");
    expect(toolActivity("TodoWrite", { todos: [] })).toBe("TodoWrite");
    expect(toolActivity("", { command: "x" })).toBeUndefined();
    expect(toolActivity(42, {})).toBeUndefined();
    expect(toolActivity("Bash", { command: "y".repeat(5000) })!.length).toBeLessThan(400);
    expect(statusHook("anything-else", {})).toBeNull();
  });

  test("BUG-186/live: Gluon's own return command is no activity: the hook says working, the activity before it stays", () => {
    for (const command of [RETURN_COMMAND.posix, RETURN_COMMAND.powershell, RETURN_COMMAND.posix.replaceAll('"', ""), '"${GLUON_SELF}" signal back', "/home/me/.local/bin/gluon signal back", '"C:\\Program Files\\Gluon\\gluon.exe" signal back', `cd /w && ${RETURN_COMMAND.posix}`]) {
      expect(toolActivity("Bash", { command })).toBeUndefined();
      expect(statusHook("tool", { tool_name: "Bash", tool_input: { command } })).toEqual({ events: [{ name: "status", status: { state: "working" } }] });
    }
    expect(toolActivity("Bash", { command: "grep 'signal back' src" })).toBe("Bash: grep 'signal back' src");
    expect(toolActivity("Bash", { command: "gluon signal back --help && ls" })).toBe("Bash: gluon signal back --help && ls");
  });

  test("the hook round trip: `gluon hook <agent> <name>` turns the harness's input into one status event, prints nothing, exits 0", async () => {
    const dir = eventsDir();
    const hook = async (agent: string, name: string, input: object) => {
      // The shebang's Bun flags (on Windows an empty bunfig, not /dev/null).
      const p = Bun.spawn([process.execPath, ...BUN_FLAGS, join(ROOT, "src", "cli.tsx"), "hook", agent, name], {
        env: { ...SYSTEM_ENV, PATH: process.env.PATH ?? "", GLUON_EVENTS: dir, GLUON_HANDOFF: "clear,compact" },
        stdin: Buffer.from(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
    };
    expect(await hook("claude-code", "tool", { hook_event_name: "PreToolUse", cwd: "/w", tool_name: "Bash", tool_input: { command: `rm ${ESC}[2J -rf build` } })).toEqual({ code: 0, out: "", err: "" });
    expect(await hook("codex", "permission", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: {} })).toEqual({ code: 0, out: "", err: "" });
    expect(await hook("grok-build", "stop", { hook_event_name: "Stop", subagentType: "explore" })).toEqual({ code: 0, out: "", err: "" });
    expect(readEvents(dir, new Set())).toEqual([
      { name: "status", status: { state: "working", activity: "Bash: rm -rf build" } },
      { name: "status", status: { state: "awaiting" } },
    ]);
    // Outside a launch: nothing at all.
    const p = Bun.spawnSync([process.execPath, ...BUN_FLAGS, join(ROOT, "src", "cli.tsx"), "hook", "claude-code", "stop"], { env: { ...SYSTEM_ENV, PATH: process.env.PATH ?? "" }, stdin: Buffer.from("{}") });
    expect([p.exitCode, p.stdout.toString()]).toEqual([0, ""]);
  });
});

/** OTLP JSON as the exporters send it. */
const str = (key: string, v: string) => ({ key, value: { stringValue: v } });
const int = (key: string, v: number) => ({ key, value: { intValue: String(v) } });
const dbl = (key: string, v: number) => ({ key, value: { doubleValue: v } });
const t = (s: number) => String(1_759_400_000_000_000_000 + s * 1_000_000_000);
const costMetric = (points: { model: string; usd: number; start?: number }[], temporality: number | string = 2) => ({
  resourceMetrics: [
    {
      resource: { attributes: [str("service.name", "claude-code")] },
      scopeMetrics: [
        {
          scope: { name: "com.anthropic.claude_code", version: "2.1.287" },
          metrics: [
            { name: "claude_code.token.usage", unit: "tokens", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ attributes: [str("type", "input")], asDouble: 999 }] } },
            {
              name: "claude_code.cost.usage",
              unit: "USD",
              sum: { aggregationTemporality: temporality, isMonotonic: true, dataPoints: points.map((p) => ({ attributes: [str("model", p.model), str("session.id", "s1")], startTimeUnixNano: t(p.start ?? 0), timeUnixNano: t(5), asDouble: p.usd })) },
            },
          ],
        },
      ],
    },
  ],
});
const apiRequest = (s: number, attrs: object[]) => ({ timeUnixNano: t(s), body: { stringValue: "claude_code.api_request" }, attributes: [str("event.name", "api_request"), ...attrs] });
const logs = (records: object[]) => ({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: records }] }] });

describe("the telemetry listener", () => {
  const server = startTelemetry({ maxBodyBytes: 64 * 1024 });
  afterAll(() => server.stop());
  const post = (path: string, body: unknown, headers: Record<string, string>, raw?: Uint8Array) =>
    fetch(`${server.endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw ?? JSON.stringify(body) });
  function session() {
    const costs: number[] = [];
    const contexts: (ContextFigure | null)[] = [];
    const s = server.session({ onCost: (usd) => costs.push(usd), onContext: (c) => contexts.push(c) });
    return { s, costs, contexts, auth: { [TELEMETRY_HEADER]: s.token } };
  }

  test("loopback only, on a free port; each launch its own token", () => {
    expect(server.endpoint).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);
    const [a, b] = [session(), session()];
    expect(a.s.token).toMatch(/^[0-9a-f]{48}$/);
    expect(a.s.token).not.toBe(b.s.token);
    a.s.close();
    b.s.close();
  });

  test("Claude Code's cost metric: cumulative series (per model) summed at their latest, deltas added; other metrics ignored", async () => {
    const a = session();
    expect((await post("/v1/metrics", costMetric([{ model: "claude-opus-5-5", usd: 0.0123 }]), a.auth)).status).toBe(200);
    expect((await post("/v1/metrics", costMetric([{ model: "claude-opus-5-5", usd: 0.05 }, { model: "claude-haiku-4-5", usd: 0.01 }]), a.auth)).status).toBe(200);
    // The same figures again: no new report.
    await post("/v1/metrics", costMetric([{ model: "claude-opus-5-5", usd: 0.05 }, { model: "claude-haiku-4-5", usd: 0.01 }]), a.auth);
    expect(a.costs.length).toBe(2);
    expect(a.costs[0]).toBe(0.0123);
    expect(a.costs[1]).toBeCloseTo(0.06, 10);
    const d = session();
    await post("/v1/metrics", costMetric([{ model: "claude-opus-5-5", usd: 0.01 }], 1), d.auth);
    await post("/v1/metrics", costMetric([{ model: "claude-opus-5-5", usd: 0.02 }], "AGGREGATION_TEMPORALITY_DELTA"), d.auth);
    expect(d.costs).toEqual([0.01, 0.03]);
    a.s.close();
    d.s.close();
  });

  test("Claude Code's api_request events: the main thread's context (input + cache read + cache creation) and model; every request's cost until the metric comes", async () => {
    const a = session();
    const main = (s: number, input: number, read: number, created: number, usd: number) =>
      apiRequest(s, [str("model", "claude-opus-5-5"), int("input_tokens", input), int("output_tokens", 300), int("cache_read_tokens", read), int("cache_creation_tokens", created), dbl("cost_usd", usd), str("query_source", "repl_main_thread")]);
    const sub = apiRequest(9, [str("model", "claude-haiku-4-5"), int("input_tokens", 90_000), int("cache_read_tokens", 0), int("cache_creation_tokens", 0), dbl("cost_usd", 0.002), str("query_source", "agent:custom")]);
    expect((await post("/v1/logs", logs([main(1, 12, 40_000, 1_500, 0.031), sub, main(3, 20, 41_000, 900, 0.01)]), a.auth)).status).toBe(200);
    expect(a.contexts).toEqual([{ tokens: 41_920, model: "claude-opus-5-5" }]);
    expect(a.costs.at(-1)).toBeCloseTo(0.043, 10);
    // An older request arriving late doesn't move the context back.
    await post("/v1/logs", logs([main(2, 1, 1, 1, 0)]), a.auth);
    expect(a.contexts.length).toBe(1);
    // Once the metric came, it alone is the cost.
    await post("/v1/metrics", costMetric([{ model: "claude-opus-5-5", usd: 0.5 }]), a.auth);
    await post("/v1/logs", logs([main(4, 30, 42_000, 0, 0.2)]), a.auth);
    expect(a.costs.at(-1)).toBe(0.5);
    expect(a.contexts.at(-1)).toEqual({ tokens: 42_030, model: "claude-opus-5-5" });
    a.s.close();
  });

  test("BUG-329/subagent-source: a request's query_source says whether it takes the subagent cache TTL: only the main thread and the helpers inline with it do not", async () => {
    const usages: UsageEvent[] = [];
    const s = server.session({ onUsage: (u) => usages.push(u) });
    const sources = ["repl_main_thread", "repl_main_thread:outputStyle:custom", "sdk", "auto_mode", "memdir_relevance", "agent:custom", "agent:builtin:Explore", "compact", "generate_session_title"];
    const records = sources.map((source, i) => apiRequest(i + 1, [str("model", "claude-opus-4-6"), str("request_id", `r${i}`), int("input_tokens", 10), int("cache_creation_tokens", 100), str("query_source", source)]));
    // No query_source at all is no evidence of a subagent.
    records.push(apiRequest(20, [str("model", "claude-opus-4-6"), str("request_id", "none"), int("input_tokens", 10)]));
    await post("/v1/logs", logs(records), { [TELEMETRY_HEADER]: s.token });
    expect(usages.map((u) => u.harness === "claude-code" && u.subagent)).toEqual([false, false, false, false, false, true, true, true, true, false]);
    s.close();
  });

  test("BUG-334/usage-dedup-bounded: 5001 distinct requests then a replay of the first count it once; a request with no model is a usage record without one", async () => {
    const big = startTelemetry();
    const usages: UsageEvent[] = [];
    const s = big.session({ onUsage: (u) => usages.push(u) });
    const auth = { [TELEMETRY_HEADER]: s.token };
    const one = (i: number, extra: object[] = [str("model", "claude-opus-4-6")]) => apiRequest(i + 1, [...extra, str("request_id", `req-${i}`), int("input_tokens", 10 + i), int("output_tokens", 1), str("query_source", "repl_main_thread")]);
    const send = (records: object[]) => fetch(`${big.endpoint}/v1/logs`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(logs(records)) });
    for (let from = 0; from < 5001; from += 500) await send(Array.from({ length: Math.min(500, 5001 - from) }, (_, i) => one(from + i)));
    expect(usages.length).toBe(5001);
    // The exporter re-sends the first batch and the latest one: nothing is counted twice.
    await send(Array.from({ length: 500 }, (_, i) => one(i)));
    await send([one(5000)]);
    expect(usages.length).toBe(5001);
    // A request that names no model still has its usage (priced at the launched model by the tracker).
    await send([one(6000, [])]);
    expect(usages.length).toBe(5002);
    expect(usages.at(-1)).toMatchObject({ harness: "claude-code", input: 6010 });
    expect("model" in usages.at(-1)!).toBe(false);
    s.close();
    big.stop();
  });

  test("Codex's response.completed events: the context (input, cached included, plus output: its total) and model; no cost", async () => {
    const a = session();
    const completed = (s: number, input: string) => ({
      timeUnixNano: t(s),
      attributes: [str("event.name", "codex.sse_event"), str("event.kind", "response.completed"), str("input_token_count", input), int("cached_token_count", 1000), str("output_token_count", "80"), str("model", "gpt-6-sol"), str("slug", "gpt-6-sol")],
    });
    const other = { timeUnixNano: t(3), attributes: [str("event.name", "codex.sse_event"), str("event.kind", "response.output_item.done"), str("input_token_count", "1")] };
    await post("/v1/logs", logs([completed(1, "52000"), other, completed(2, "53210")]), { authorization: `Bearer ${a.s.token}` });
    expect(a.contexts).toEqual([{ tokens: 53_290, model: "gpt-6-sol" }]);
    expect(a.costs).toEqual([]);
    a.s.close();
  });

  test("refused: no token, a wrong or closed one, another path or method, not JSON, too large (a gzip bomb too); traces are taken and dropped", async () => {
    const a = session();
    const body = costMetric([{ model: "m", usd: 1 }]);
    expect((await post("/v1/metrics", body, {})).status).toBe(401);
    expect((await post("/v1/metrics", body, { [TELEMETRY_HEADER]: "0".repeat(48) })).status).toBe(401);
    expect((await post("/v1/metrics", body, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post("/v1/other", body, a.auth)).status).toBe(404);
    expect((await fetch(`${server.endpoint}/v1/metrics`, { headers: a.auth })).status).toBe(405);
    expect((await post("/v1/metrics", body, { ...a.auth, "content-type": "text/plain" })).status).toBe(415);
    expect((await post("/v1/metrics", null, a.auth, new TextEncoder().encode("{nope"))).status).toBe(400);
    expect((await post("/v1/metrics", null, a.auth, new TextEncoder().encode(`{"pad":"${"x".repeat(70 * 1024)}"}`))).status).toBe(413);
    const bomb = gzipSync(Buffer.from(`{"pad":"${"x".repeat(1024 * 1024)}"}`));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect((await post("/v1/metrics", null, { ...a.auth, "content-encoding": "gzip" }, bomb)).status).toBe(413);
    expect((await post("/v1/metrics", null, { ...a.auth, "content-encoding": "br" }, new TextEncoder().encode("{}"))).status).toBe(415);
    expect((await post("/v1/traces", { resourceSpans: [] }, a.auth)).status).toBe(200);
    expect(a.costs).toEqual([]);
    // gzip within the cap is fine.
    expect((await post("/v1/metrics", null, { ...a.auth, "content-encoding": "gzip" }, gzipSync(Buffer.from(JSON.stringify(body))))).status).toBe(200);
    expect(a.costs).toEqual([1]);
    a.s.close();
    expect((await post("/v1/metrics", body, a.auth)).status).toBe(401);
    expect(MAX_TELEMETRY_BYTES).toBe(2 * 1024 * 1024);
  });

  test("a callback that throws doesn't break the listener", async () => {
    const s = server.session({
      onCost: () => {
        throw new Error("x");
      },
    });
    expect((await post("/v1/metrics", costMetric([{ model: "m", usd: 2 }]), { [TELEMETRY_HEADER]: s.token })).status).toBe(200);
    s.close();
  });
});

describe("a launch's telemetry", () => {
  const session = { token: "ab".repeat(24), endpoint: "http://127.0.0.1:4318" };

  test("Claude Code: OTLP http/json to the loopback listener with the token; prompts, responses and tool content never exported", () => {
    const l = telemetryLaunch("claude-code", session, { PATH: "/bin", HOME: "/h" })!;
    expect(l).toEqual({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
        OTEL_EXPORTER_OTLP_HEADERS: `x-gluon-telemetry=${session.token}`,
        OTEL_METRIC_EXPORT_INTERVAL: "5000",
        OTEL_LOGS_EXPORT_INTERVAL: "2000",
        OTEL_LOG_USER_PROMPTS: "0",
        OTEL_LOG_ASSISTANT_RESPONSES: "0",
        OTEL_LOG_TOOL_DETAILS: "0",
        OTEL_LOG_TOOL_CONTENT: "0",
        OTEL_LOG_RAW_API_BODIES: "0",
      },
      argv: [],
    });
    // Not a login token, not a base URL: allowed on every connection.
    for (const conn of [undefined, "plan", "anthropic", "openrouter", "bedrock"] as const) expect(() => assertSafeEnv(l.env, conn)).not.toThrow();
  });

  test("Claude Code: nothing when the user has telemetry settings of their own (theirs stay)", () => {
    for (const own of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_METRICS_EXPORTER", "OTEL_RESOURCE_ATTRIBUTES", "CLAUDE_CODE_ENABLE_TELEMETRY"]) expect(telemetryLaunch("claude-code", session, { [own]: "x" })).toBeNull();
    expect(telemetryLaunch("claude-code", session, { OTEL_EXPORTER_OTLP_ENDPOINT: undefined })).not.toBeNull();
  });

  test("Codex: its log exporter, by -c, to /v1/logs, JSON, with the token; prompts never logged; no telemetry for the others", () => {
    expect(telemetryLaunch("codex", session, {})).toEqual({
      env: {},
      argv: ["-c", `otel.exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/logs",protocol="json",headers={x-gluon-telemetry="${session.token}"}}}`, "-c", "otel.log_user_prompt=false"],
    });
    for (const h of ["antigravity", "opencode"] as const) expect(telemetryLaunch(h, session, {})).toBeNull();
  });

  test("withTelemetry: options before the spec (after the last --), variables added; never after or into the spec", () => {
    const codex: Command = { argv: ["codex", "-m", "gpt-6-sol", "-c", "hooks.Stop=[]", "--", "- fix it"], env: { OPENAI_API_KEY: "k" }, spec: "- fix it", harness: "codex", conn: "openai" };
    const r = withTelemetry(codex, telemetryLaunch("codex", session, {}));
    expect(r.argv.slice(0, 5)).toEqual(codex.argv.slice(0, 5));
    expect(r.argv.slice(5, 9)).toEqual(telemetryLaunch("codex", session, {})!.argv);
    expect(r.argv.slice(-2)).toEqual(["--", "- fix it"]);
    const claude: Command = { argv: ["claude", "--model", "opus", "--", "spec"], env: {}, spec: "spec", harness: "claude-code", conn: "plan" };
    const c = withTelemetry(claude, telemetryLaunch("claude-code", session, {}));
    expect(c.argv).toEqual(claude.argv);
    expect(c.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(session.endpoint);
    expect(withTelemetry(claude, null)).toBe(claude);
    // No `--` before the spec: the options are left out (the spec stays the last argument).
    const oc: Command = { argv: ["opencode", "--standalone", "--prompt=x"], env: {}, spec: "x", harness: "opencode" };
    expect(withTelemetry(oc, { env: {}, argv: ["-c", "y"] }).argv).toEqual(oc.argv);
  });
});

describe("context windows", () => {
  test("Claude, as Claude Code sizes them: 1M natively for Opus 4.7+, Sonnet 5+, Haiku 5.5+, Fable; 200k for Haiku 4.5, Opus/Sonnet 4.6 (1M with [1m]); every id form", () => {
    const cases: Record<string, number> = {
      opus: 1e6,
      sonnet: 1e6,
      haiku: 1e6,
      "claude-haiku-5-5": 1e6,
      "global.anthropic.claude-haiku-5-5": 1e6,
      "anthropic/claude-haiku-5.5": 1e6,
      fable: 1e6,
      "sonnet[1m]": 1e6,
      "opus-4.6": 2e5,
      "sonnet-4.6": 2e5,
      "claude-opus-5-5": 1e6,
      "claude-sonnet-5-5": 1e6,
      "claude-fable-5-1": 1e6,
      "claude-opus-4-7": 1e6,
      "claude-opus-4-6": 2e5,
      "claude-opus-4-6[1m]": 1e6,
      "claude-haiku-4-5-20251001": 2e5,
      "us.anthropic.claude-haiku-4-5-20251001-v1:0": 2e5,
      "global.anthropic.claude-sonnet-5-5": 1e6,
      "us.anthropic.claude-opus-4-6-v1": 2e5,
      "anthropic/claude-opus-4.6": 2e5,
      "anthropic/claude-fable-5.1": 1e6,
      "claude-sonnet-4-5": 2e5,
      "claude-3-7-sonnet-20250219": 2e5,
    };
    for (const [model, window] of Object.entries(cases)) expect([model, claudeContextWindow(model, {})]).toEqual([model, window]);
    for (const other of ["gpt-6-sol", "kimi-k3", "grok-4.7", "gemini-3.8-flash", ""]) expect(claudeContextWindow(other, {})).toBeUndefined();
    expect(claudeContextWindow("opus", { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" })).toBe(2e5);
    expect(claudeContextWindow("opus", { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" })).toBe(1e6);
  });

  test("Codex from its catalog: the window Codex lets a conversation use", () => {
    const catalog = JSON.stringify({ models: [{ slug: "gpt-6-sol", context_window: 400_000, effective_context_window_percent: 95 }, { slug: "gpt-6-luna", context_window: 200_000 }, { slug: "bad", context_window: "x" }] });
    // No effective percent in the catalog: Codex's own default, 95.
    expect(codexContextWindows(catalog)).toEqual({ "gpt-6-sol": 380_000, "gpt-6-luna": 190_000 });
    expect(codexContextWindows("not json")).toEqual({});
    expect(codexContextWindows('{"models":3}')).toEqual({});
  });

  test("contextPercent: by a window or a model; undefined when unknown; at most 100", () => {
    expect(contextPercent(50_000, "claude-haiku-4-5", { env: {} })).toBe(25);
    expect(contextPercent(41_920, "claude-opus-5-5", { env: {} })).toBeCloseTo(4.192, 6);
    // Codex's footer: 12k off the prompt and the window.
    expect(contextPercent(190_000, "gpt-6-sol", { codex: { "gpt-6-sol": 380_000 } })).toBeCloseTo((178 / 368) * 100, 6);
    expect(contextPercent(5_000, "gpt-6-sol", { codex: { "gpt-6-sol": 380_000 } })).toBe(0);
    expect(contextPercent(1_000, "gpt-6-sol", { codex: { "gpt-6-sol": 10_000 } })).toBe(100);
    expect(contextPercent(131_072, 262_144)).toBe(50);
    expect(contextPercent(300_000, 262_144)).toBe(100);
    for (const w of ["kimi-k3", undefined, 0, -5]) expect(contextPercent(1000, w as never, { env: {} })).toBeUndefined();
    expect(contextPercent(Number.NaN, 1000)).toBeUndefined();
  });
});

test("status events stay out of the events directory's remains: a launch's directory holds only what's still to read", () => {
  const dir = eventsDir();
  for (let i = 0; i < 50; i++) writeEvent(dir, { name: "status", status: { state: "working", activity: `Bash: step ${i}` } });
  expect(readEvents(dir, new Set()).length).toBe(50);
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync(dir)).toBe(true);
});

describe("OpenCode's per-step usage in a status event (issue #39)", () => {
  const step = { n: 3, model: "openrouter/deepseek/deepseek-v4-flash", input: 95, output: 3, reasoning: 13, cacheRead: 5120, cacheWrite: 0, cost: 0.000137296 };
  test("strictly: known fields, bounded counts and count of steps; anything else refuses the whole event", () => {
    expect(parseStatus(JSON.stringify({ steps: [step, { ...step, n: 4, cost: undefined }], extra: 1 }))).toEqual({ steps: [step, { n: 4, model: step.model, input: 95, output: 3, reasoning: 13, cacheRead: 5120, cacheWrite: 0 }] });
    for (const bad of [[], "x", [null], [{ ...step, model: "no spaces allowed" }], [{ ...step, input: -1 }], [{ ...step, cacheRead: 1e13 }], [{ ...step, n: "1" }], [{ ...step, cost: 1e7 }], Array(26).fill(step)]) expect(parseStatus(JSON.stringify({ steps: bad }))).toBeNull();
  });
  test("a step's counts are rounded; its text fields can't carry anything (only the model name)", () => {
    expect(parseStatus(JSON.stringify({ steps: [{ ...step, input: 95.6, prompt: "secret" }] }))!.steps![0]).toEqual({ ...step, input: 96 });
  });
});

describe("Codex's compaction (issue #39): the PreCompact hook says one starts", () => {
  test("status {compacting: true} parses; anything else refuses the event", () => {
    expect(parseStatus('{"compacting":true,"extra":1}')).toEqual({ compacting: true });
    for (const bad of ["false", '"yes"', "1", "null"]) expect(parseStatus(`{"compacting":${bad}}`)).toBeNull();
  });

  test("the compaction's own response (old history as its prompt) is no context: unknown until the next response; its cost still counts", async () => {
    const server = startTelemetry();
    try {
      const contexts: (ContextFigure | null)[] = [];
      const usages: number[] = [];
      const s = server.session({ onContext: (c) => contexts.push(c), onUsage: (u) => usages.push(u.harness === "codex" ? u.input : 0) });
      let time = 1;
      const send = (conversation: string, input: number, output: number) =>
        fetch(`${server.endpoint}/v1/logs`, {
          method: "POST",
          headers: { "content-type": "application/json", [TELEMETRY_HEADER]: s.token },
          body: JSON.stringify(logs([{ observedTimeUnixNano: t(++time), attributes: [str("event.name", "codex.sse_event"), str("event.kind", "response.completed"), str("conversation.id", conversation), str("model", "gpt-6-sol"), str("input_token_count", String(input)), str("output_token_count", String(output))] }])),
        });
      await send("main", 30_000, 500);
      s.expectCompaction();
      // A side conversation's response in between is not the compaction's.
      await send("title", 800, 20);
      await send("main", 95_000, 2_000);
      await send("main", 12_000, 100);
      expect(contexts).toEqual([{ tokens: 30_500, model: "gpt-6-sol" }, null, { tokens: 12_100, model: "gpt-6-sol" }]);
      expect(usages).toEqual([30_000, 800, 95_000, 12_000]);
      s.close();
    } finally {
      server.stop();
    }
  });

  test("the main conversation can be named: a conversation seen first is then a side one, and only the named one is the context", async () => {
    const server = startTelemetry();
    try {
      const contexts: (ContextFigure | null)[] = [];
      const s = server.session({ onContext: (c) => contexts.push(c) });
      s.setMainConversation("main");
      let time = 1;
      const send = (conversation: string, input: number) =>
        fetch(`${server.endpoint}/v1/logs`, {
          method: "POST",
          headers: { "content-type": "application/json", [TELEMETRY_HEADER]: s.token },
          body: JSON.stringify(logs([{ observedTimeUnixNano: t(++time), attributes: [str("event.name", "codex.sse_event"), str("event.kind", "response.completed"), str("conversation.id", conversation), str("model", "gpt-6-sol"), str("input_token_count", String(input)), str("output_token_count", "10")] }])),
        });
      await send("title", 800);
      await send("main", 30_000);
      expect(contexts).toEqual([{ tokens: 30_010, model: "gpt-6-sol" }]);
      s.close();
    } finally {
      server.stop();
    }
  });
});

describe("Codex's main conversation and turn cost (issue #39)", () => {
  const post = (server: ReturnType<typeof startTelemetry>, token: string, records: object[]) =>
    fetch(`${server.endpoint}/v1/logs`, { method: "POST", headers: { "content-type": "application/json", [TELEMETRY_HEADER]: token }, body: JSON.stringify(logs(records)) });
  const response = (time: number, conversation: string, input: number, output = 10) => ({ observedTimeUnixNano: t(time), attributes: [str("event.name", "codex.sse_event"), str("event.kind", "response.completed"), str("conversation.id", conversation), str("model", "gpt-6-sol"), str("input_token_count", String(input)), str("output_token_count", String(output))] });

  test("BUG-337/fork: after a /fork (a new conversation id), the hook's session_id is the main conversation: context follows it, cost still sums both", async () => {
    const server = startTelemetry();
    try {
      const contexts: (ContextFigure | null)[] = [];
      const usages: number[] = [];
      const s = server.session({ onContext: (c) => contexts.push(c), onUsage: (u: UsageEvent) => void usages.push(u.harness === "codex" ? u.input : 0) });
      // Until the hook speaks, the first conversation seen is the main one.
      await post(server, s.token, [response(1, "orig", 30_000)]);
      expect(contexts).toEqual([{ tokens: 30_010, model: "gpt-6-sol" }]);
      // The fork's response comes before its hook: still a side conversation to the context.
      await post(server, s.token, [response(2, "fork", 31_000)]);
      expect(contexts).toHaveLength(1);
      // The hook of the forked thread names it.
      s.setMainConversation("fork");
      await post(server, s.token, [response(3, "orig", 5_000), response(4, "fork", 32_000)]);
      expect(contexts.at(-1)).toEqual({ tokens: 32_010, model: "gpt-6-sol" });
      expect(contexts).toHaveLength(2);
      expect(usages).toEqual([30_000, 31_000, 5_000, 32_000]);
      s.close();
    } finally {
      server.stop();
    }
  });

  test("BUG-337/override: the new main conversation's own context_window override (announced at its start, before the hook named it) applies", async () => {
    const server = startTelemetry();
    try {
      const contexts: (ContextFigure | null)[] = [];
      const s = server.session({ onContext: (c) => contexts.push(c) });
      const start = (time: number, conversation: string, window?: number) => ({ observedTimeUnixNano: t(time), attributes: [str("event.name", "codex.conversation_starts"), str("conversation.id", conversation), str("model", "gpt-6-sol"), ...(window ? [int("context_window", window)] : [])] });
      await post(server, s.token, [start(1, "orig")]);
      await post(server, s.token, [start(2, "fork", 100_000)]);
      s.setMainConversation("fork");
      await post(server, s.token, [response(3, "fork", 20_000)]);
      expect(contexts).toEqual([{ tokens: 20_010, model: "gpt-6-sol", windowOverride: 100_000 }]);
      s.close();
    } finally {
      server.stop();
    }
  });

  test("BUG-336/parse: codex.turn_cost goes to onTurnCost once (a re-sent batch is dropped), from either attribute spelling; it is no context and no usage; an incomplete one is ignored", async () => {
    const server = startTelemetry();
    try {
      const turnsSeen: TurnCostEvent[] = [];
      const contexts: unknown[] = [];
      const usages: unknown[] = [];
      const s = server.session({ onTurnCost: (x) => turnsSeen.push(x), onContext: (c) => contexts.push(c), onUsage: (u) => usages.push(u) });
      const cost = (time: number, attrs: object[]) => ({ observedTimeUnixNano: t(time), attributes: [str("event.name", "codex.turn_cost"), str("conversation.id", "orig"), str("model", "gpt-6-sol"), ...attrs] });
      const full = cost(5, [str("turn.id", "t1"), int("input_token_count", 40_000), int("cached_token_count", 30_000), int("output_token_count", 500), int("reasoning_token_count", 200), dbl("usage.estimated_usd", 0.0525), str("speed", "standard")]);
      await post(server, s.token, [full]);
      await post(server, s.token, [full]);
      await post(server, s.token, [cost(6, [int("gen_ai.usage.input_tokens", 1_000), int("gen_ai.usage.cache_read.input_tokens", 400), int("gen_ai.usage.output_tokens", 50), int("cost_microusd", 12_500)])]);
      // No cost, no tokens, a bad speed: nothing to audit or nothing taken from it.
      await post(server, s.token, [cost(7, [int("input_token_count", 5), int("output_token_count", 5)]), cost(8, [dbl("usage.estimated_usd", 1)]), cost(9, [int("input_token_count", 7), int("output_token_count", 7), dbl("usage.estimated_usd", 0.1), str("speed", "no spaces allowed!")])]);
      expect(turnsSeen).toEqual([
        { model: "gpt-6-sol", input: 40_000, cached: 30_000, output: 500, reasoning: 200, reportedUsd: 0.0525, speed: "standard" },
        { model: "gpt-6-sol", input: 1_000, cached: 400, output: 50, reportedUsd: 0.0125 },
        { model: "gpt-6-sol", input: 7, cached: 0, output: 7, reportedUsd: 0.1 },
      ]);
      expect(contexts).toEqual([]);
      expect(usages).toEqual([]);
      s.close();
    } finally {
      server.stop();
    }
  });
});
