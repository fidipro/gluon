/**
 * QA pass (brain, offline): the brain's own clients against a fake transport, not the SDKs' stubs.
 * `anthropicBrain` and `bedrockClaudeBrain` run the real SDKs against a local server (their requests for the providers'
 * hosts are sent there by `redirectTo`; the environment's base URLs are not read: BUG-590, BUG-591), so the request
 * shapes, the status-to-error mapping and the stream's edge cases are the ones a provider would cause.
 * The plan brain runs on a fake `query`; the OpenAI and Converse clients on their injected clients.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicBrain, bedrockClaudeBrain } from "../src/agent/clients.ts";
import { Session, type ModelClient } from "../src/agent/session.ts";
import { modelUnavailable } from "../src/brain.ts";
import { defaults } from "../src/config.ts";

const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_PROFILE", "AWS_BEARER_TOKEN_BEDROCK"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});

const root = join(import.meta.dir, "..");
const ask = (over: Partial<Parameters<ModelClient>[0]> = {}): Parameters<ModelClient>[0] => ({
  system: "You are Gluon.",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "list_files", description: "List files", input_schema: { type: "object", properties: {} } }],
  signal: new AbortController().signal,
  ...over,
});

type Seen = { method: string; path: string; headers: Record<string, string>; body: any };
/** A local server that records every request and answers with `reply`. */
function serve(reply: (seen: Seen, n: number) => Response | Promise<Response>) {
  const requests: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      const seen: Seen = { method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body };
      requests.push(seen);
      return reply(seen, requests.length);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests, server };
}
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  restoreFetch();
});

/**
 * The SDKs are given their endpoints (BUG-590, BUG-591): the environment's base URLs no longer move them, so these tests send the
 * requests for the providers' hosts (and nothing else: any other host is an error, never the network) to a local server.
 */
const realFetch = globalThis.fetch;
const restoreFetch = () => {
  globalThis.fetch = realFetch;
};
function redirectTo(url: string) {
  const to = new URL(url);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (!/^(api\.anthropic\.com|api\.openai\.com|bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com)$/.test(u.hostname)) throw new Error(`a test reached ${u.hostname}`);
    u.protocol = to.protocol;
    u.host = to.host;
    return realFetch(u, init);
  }) as typeof fetch;
}

const sse = (events: [string, unknown][]) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const sseResponse = (events: [string, unknown][], init: ResponseInit = {}) => new Response(sse(events), { ...init, headers: { "content-type": "text/event-stream", ...(init.headers ?? {}) } });
const START: [string, unknown] = ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }];
const text = (index: number, ...parts: string[]): [string, unknown][] => [
  ["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }],
  ...parts.map((t): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: t } }]),
  ["content_block_stop", { type: "content_block_stop", index }],
];
const toolUse = (index: number, id: string, name: string, ...json: string[]): [string, unknown][] => [
  ["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }],
  ...json.map((j): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: j } }]),
  ["content_block_stop", { type: "content_block_stop", index }],
];
const END = (stop: string): [string, unknown][] => [
  ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } }],
  ["message_stop", { type: "message_stop" }],
];
/** Anthropic's error body. */
const apiError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json", "x-should-retry": "false", ...headers } });

describe("anthropicBrain (the real SDK on a local server)", () => {
  const brain = (url: string, model = "claude-sonnet-5-5", effort: Anthropic.OutputConfig["effort"] = null) => {
    redirectTo(url);
    return anthropicBrain("sk-ant-api03-test0123456789abcdefghijklmnop", model, effort);
  };

  test("the request: POST /v1/messages, the key in x-api-key, a streamed body with the model, 8192 tokens, the cached system prompt, the tools and the effort", async () => {
    const { url, requests } = serve(() => sseResponse([START, ...text(0, "Hello"), ...END("end_turn")]));
    const deltas: string[] = [];
    const res = await brain(url, "claude-sonnet-5-5", "high")(ask(), (d) => deltas.push(d));
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect([r.method, r.path]).toEqual(["POST", "/v1/messages"]);
    expect(r.headers["x-api-key"]).toBe("sk-ant-api03-test0123456789abcdefghijklmnop");
    expect(r.headers["anthropic-version"]).toBeTruthy();
    expect(r.headers.authorization).toBeUndefined();
    expect(r.body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 8192,
      stream: true,
      system: [{ type: "text", text: "You are Gluon.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "list_files" }],
      output_config: { effort: "high" },
    });
    expect(deltas).toEqual(["Hello"]);
    expect(res.stop_reason).toBe("end_turn");
    expect(res.content).toMatchObject([{ type: "text", text: "Hello" }]);
  });

  test("no effort is sent for a model that takes none, and no other field of the request is invented", async () => {
    const { url, requests } = serve(() => sseResponse([START, ...text(0, "ok"), ...END("end_turn")]));
    await brain(url, "claude-haiku-4-5", null)(ask(), () => {});
    expect(Object.keys(requests[0]!.body).sort()).toEqual(["max_tokens", "messages", "model", "stream", "system", "tools"]);
  });

  test("text and a tool call in one reply: the words stream, the tool's input is the JSON its pieces make, the stop reason is tool_use", async () => {
    const { url } = serve(() => sseResponse([START, ...text(0, "Let me ", "look."), ...toolUse(1, "toolu_1", "grep", '{"patt', 'ern":"ex', 'port","path":"src"}'), ...END("tool_use")]));
    const deltas: string[] = [];
    const res = await brain(url)(ask(), (d) => deltas.push(d));
    expect(deltas.join("")).toBe("Let me look.");
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content).toMatchObject([{ type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "grep", input: { pattern: "export", path: "src" } }]);
  });

  test("a tool call with no input pieces at all has an empty input; a reply with no content is returned empty (the session decides)", async () => {
    const { url } = serve((_, n) => sseResponse(n === 1 ? [START, ...toolUse(0, "toolu_1", "list_files"), ...END("tool_use")] : [START, ...END("end_turn")]));
    const b = brain(url);
    expect((await b(ask(), () => {})).content).toMatchObject([{ type: "tool_use", name: "list_files", input: {} }]);
    expect(await b(ask(), () => {})).toEqual({ content: [], stop_reason: "end_turn" });
  });

  test("max_tokens comes back as the stop reason (the session turns it into 'cut off')", async () => {
    const { url } = serve(() => sseResponse([START, ...text(0, "long"), ...END("max_tokens")]));
    expect((await brain(url)(ask(), () => {})).stop_reason).toBe("max_tokens");
  });

  test("errors keep their HTTP status and the provider's own message; only a missing model is 'model unavailable'", async () => {
    const cases: [string, number, string, string, boolean][] = [
      ["401", 401, "authentication_error", "invalid x-api-key", false],
      ["403 permission", 403, "permission_error", "Your API key does not have permission to use the specified resource.", false],
      ["404 model", 404, "not_found_error", "model: claude-nonesuch", true],
      ["400 effort", 400, "invalid_request_error", "output_config.effort: not supported for this model", false],
      ["429", 429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", false],
      ["500", 500, "api_error", "Internal server error", false],
      ["529", 529, "overloaded_error", "Overloaded", false],
    ];
    for (const [name, status, type, message, unavailable] of cases) {
      const { url } = serve(() => apiError(status, type, message));
      const error = await brain(url)(ask(), () => {}).then(() => null, (e: Error & { status?: number }) => e);
      expect([name, error?.status, error?.message.includes(message), modelUnavailable(error)]).toEqual([name, status, true, unavailable]);
    }
  });

  test("an error event in the middle of a stream (overloaded) rejects with its message, not as a model problem", async () => {
    const { url } = serve(() => sseResponse([START, ...text(0, "partial"), ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]]));
    const deltas: string[] = [];
    const error = await brain(url)(ask(), (d) => deltas.push(d)).then(() => null, (e: Error) => e);
    expect(deltas).toEqual(["partial"]);
    expect(error?.message).toContain("Overloaded");
    expect(modelUnavailable(error)).toBe(false);
  });

  test("a stream that ends without message_stop rejects instead of returning half a reply", async () => {
    const { url } = serve(() => sseResponse([START, ...text(0, "half a repl")].slice(0, 3)));
    const error = await brain(url)(ask(), () => {}).then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(Error);
  });

  test("garbage instead of an event stream (a proxy's HTML page) rejects", async () => {
    const { url } = serve(() => new Response("<html>502 Bad Gateway</html>", { status: 200, headers: { "content-type": "text/html", "x-should-retry": "false" } }));
    const error = await brain(url)(ask(), () => {}).then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(Error);
  });

  test("an abort during the stream rejects at once and the server sees the connection close", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { url } = serve(() => {
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(sse([START, ...text(0, "one")].slice(0, 3))));
          await gate;
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const ac = new AbortController();
    const started = Date.now();
    const p = brain(url)(ask({ signal: ac.signal }), () => {}).then(() => "resolved", () => "rejected");
    setTimeout(() => ac.abort(), 150);
    expect(await p).toBe("rejected");
    expect(Date.now() - started).toBeLessThan(2000);
    release();
  });

  test("nothing listening: a connection error, after the SDK's own two retries, and not a model problem", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    const error = await brain(url)(ask(), () => {}).then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/connection error/i);
    expect(modelUnavailable(error)).toBe(false);
  });

  test("a Session on it: the key echoed in an error is masked, and the next message still goes", async () => {
    const key = "sk-ant-api03-test0123456789abcdefghijklmnop";
    const { url, requests } = serve((_, n) => (n === 1 ? apiError(401, "authentication_error", `invalid x-api-key ${key}`) : sseResponse([START, ...text(0, "back"), ...END("end_turn")])));
    const s = new Session(brain(url), defaults(), "sys", root);
    await s.submit("one");
    expect(JSON.stringify(s.snapshot.items)).not.toContain(key);
    expect(s.snapshot.items.at(-1)).toMatchObject({ kind: "notice", tone: "error", text: expect.stringContaining("401") });
    await s.submit("two");
    expect(s.snapshot.items.at(-1)).toMatchObject({ kind: "assistant", text: "back" });
    expect(requests[1]!.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "user"]);
  });
});

// --- Claude on Bedrock: the Anthropic Bedrock SDK signs with the user's AWS credentials and reads an AWS event stream

/** One AWS event-stream frame (prelude, string headers, payload, CRCs). */
function frame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const h = Object.entries(headers).flatMap(([name, value]) => {
    const n = enc.encode(name);
    const v = enc.encode(value);
    return [Uint8Array.of(n.length), n, Uint8Array.of(7, v.length >> 8, v.length & 255), v];
  });
  const headerBytes = Buffer.concat(h);
  const total = 12 + headerBytes.length + payload.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBytes.length, 4);
  out.writeUInt32BE(Bun.hash.crc32(out.subarray(0, 8)) >>> 0, 8);
  headerBytes.copy(out, 12);
  Buffer.from(payload).copy(out, 12 + headerBytes.length);
  out.writeUInt32BE(Bun.hash.crc32(out.subarray(0, total - 4)) >>> 0, total - 4);
  return out;
}
/** A Bedrock `invoke-with-response-stream` body: each Anthropic event is a `chunk` frame holding it base64-encoded. */
const eventStream = (events: [string, unknown][]) =>
  Buffer.concat(events.map(([, e]) => frame({ ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" }, new TextEncoder().encode(JSON.stringify({ bytes: Buffer.from(JSON.stringify(e)).toString("base64") })))));
const eventStreamResponse = (events: [string, unknown][], init: ResponseInit = {}) => new Response(eventStream(events), { ...init, headers: { "content-type": "application/vnd.amazon.eventstream", ...(init.headers ?? {}) } });
/** An AWS JSON error (`x-amzn-errortype`). */
const awsError = (status: number, type: string, message: string) => new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json", "x-amzn-errortype": type, "x-should-retry": "false" } });

describe("bedrockClaudeBrain (the Anthropic Bedrock SDK on a local server)", () => {
  const MODEL = "global.anthropic.claude-sonnet-5-5";
  const brain = (url: string, effort: Anthropic.OutputConfig["effort"] = null, profile?: string) => {
    redirectTo(url);
    process.env.AWS_ACCESS_KEY_ID = "AKIATESTTESTTESTTEST";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-test-secret-test-secret-12";
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_PROFILE;
    return bedrockClaudeBrain({ ...defaults(), bedrock: { region: "eu-west-1", ...(profile ? { profile } : {}) } }, MODEL, effort);
  };

  test("the request: signed with the environment's AWS keys for the configured region, the model in the path, the Bedrock body (no model, no stream), the effort and the cached system prompt", async () => {
    const { url, requests } = serve(() => eventStreamResponse([START, ...text(0, "Hello", " there"), ...END("end_turn")]));
    const deltas: string[] = [];
    const res = await brain(url, "medium")(ask(), (d) => deltas.push(d));
    const r = requests[0]!;
    expect([r.method, r.path]).toEqual(["POST", `/model/${MODEL}/invoke-with-response-stream`]);
    expect(r.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTTESTTESTTEST\/\d{8}\/eu-west-1\/bedrock\//);
    expect(r.body).toMatchObject({ anthropic_version: "bedrock-2023-05-31", max_tokens: 8192, system: [{ type: "text", text: "You are Gluon.", cache_control: { type: "ephemeral" } }], output_config: { effort: "medium" }, tools: [{ name: "list_files" }] });
    expect(r.body).not.toHaveProperty("model");
    expect(r.body).not.toHaveProperty("stream");
    expect(deltas.join("")).toBe("Hello there");
    expect(res).toMatchObject({ stop_reason: "end_turn", content: [{ type: "text", text: "Hello there" }] });
  });

  test("a tool call streams through the AWS framing like through SSE", async () => {
    const { url } = serve(() => eventStreamResponse([START, ...toolUse(0, "toolu_9", "read_file", '{"path":', '"package.json"}'), ...END("tool_use")]));
    const res = await brain(url)(ask(), () => {});
    expect(res).toMatchObject({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_9", name: "read_file", input: { path: "package.json" } }] });
  });

  test("AWS's errors: access denied and a missing model move the order on; throttling, expired credentials and outages don't", async () => {
    const cases: [string, number, string, string, boolean][] = [
      ["access denied", 403, "AccessDeniedException", "You don't have access to the model with the specified model ID.", true],
      ["model not found", 404, "ResourceNotFoundException", "Could not resolve the foundation model from the provided model identifier.", true],
      ["bad model id", 400, "ValidationException", "The provided model identifier is invalid.", true],
      ["throttled", 429, "ThrottlingException", "Too many requests, please wait before trying again.", false],
      ["outage", 503, "ServiceUnavailableException", "Service unavailable", false],
      ["server", 500, "InternalServerException", "Internal server error", false],
      ["expired token", 403, "ExpiredTokenException", "The security token included in the request is expired", false],
    ];
    for (const [name, status, type, message, unavailable] of cases) {
      const { url } = serve(() => awsError(status, type, message));
      const error = await brain(url)(ask(), () => {}).then(() => null, (e: Error & { status?: number }) => e);
      expect([name, error?.status, error?.message.includes(message), modelUnavailable(error)]).toEqual([name, status, true, unavailable]);
    }
  });

  test("a stream cut off before its last frame rejects", async () => {
    const whole = eventStream([START, ...text(0, "partial"), ...END("end_turn")]);
    const { url } = serve(() => new Response(whole.subarray(0, Math.floor(whole.length * 0.6)), { headers: { "content-type": "application/vnd.amazon.eventstream" } }));
    const error = await brain(url)(ask(), () => {}).then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(Error);
  });

  test("the configured AWS profile goes to the SDK's credential chain, never into the environment (launched agents keep their own AWS setup)", async () => {
    const { url, requests } = serve(() => eventStreamResponse([START, ...text(0, "ok"), ...END("end_turn")]));
    await brain(url, null, "a-profile-that-does-not-exist")(ask(), () => {});
    expect(requests).toHaveLength(1); // the environment's keys came first in the chain, so the missing profile was never needed
    expect(process.env.AWS_PROFILE).toBeUndefined();
  });

  test("nothing to sign with (no keys, no profile, no metadata service): the error names the credentials, and isn't a model problem", async () => {
    const { url, requests } = serve(() => eventStreamResponse([START, ...END("end_turn")]));
    const b = brain(url, null, "a-profile-that-does-not-exist");
    for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) delete process.env[k];
    const home = mkdtempSync(join(tmpdir(), "gluon-aws-"));
    const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, meta: process.env.AWS_EC2_METADATA_DISABLED };
    Object.assign(process.env, { HOME: home, USERPROFILE: home, AWS_EC2_METADATA_DISABLED: "true" });
    try {
      const error = await b(ask(), () => {}).then(() => null, (e: Error) => e);
      expect(error?.message).toMatch(/profile|credentials/i);
      expect(modelUnavailable(error)).toBe(false);
      expect(requests).toEqual([]);
    } finally {
      for (const [k, v] of [["HOME", was.HOME], ["USERPROFILE", was.USERPROFILE], ["AWS_EC2_METADATA_DISABLED", was.meta]] as const) (v === undefined ? delete process.env[k] : (process.env[k] = v));
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- The Claude plan brain (the Agent SDK's `query`, replaced by a fake)

import { delimiter } from "node:path";
import type { query as sdkQuery, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { subscriptionBrain } from "../src/agent/subscription.ts";
import { fakeAgents } from "./e2e/fixtures.ts";

describe("subscriptionBrain on a fake `query`", () => {
  const path = process.env.PATH;
  beforeAll(() => {
    process.env.PATH = `${fakeAgents(["claude"])}${delimiter}${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
  });

  type Step = { kind: "events"; events: unknown[] } | { kind: "result"; result: Record<string, unknown> } | { kind: "tool"; name: string; input: unknown } | { kind: "end" } | { kind: "hold" };
  /** A `query` that plays `script` (one array of steps per developer message) and records interrupts, closes and tool results. */
  function fake(script: Step[][]) {
    const log = { interrupts: 0, closes: 0, toolResults: [] as unknown[], toolsSeenWithoutTurn: [] as unknown[] };
    let tools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }> = {};
    const run = (({ prompt, options }: Parameters<typeof sdkQuery>[0]) => {
      tools = (options!.mcpServers!.gluon as unknown as { instance: { _registeredTools: typeof tools } }).instance._registeredTools;
      let wake: (() => void) | null = null;
      let interrupted = false;
      async function* messages(): AsyncGenerator<SDKMessage> {
        const ev = (event: unknown, parent: string | null = null) => ({ type: "stream_event", event, parent_tool_use_id: parent, session_id: "s", uuid: crypto.randomUUID() }) as unknown as SDKMessage;
        for await (const _ of prompt as AsyncIterable<unknown>) {
          for (const step of script.shift() ?? []) {
            if (step.kind === "events") for (const e of step.events as { e: unknown; parent?: string }[]) yield ev(e.e, e.parent ?? null);
            else if (step.kind === "result") yield { type: "result", session_id: "s", ...step.result } as unknown as SDKMessage;
            else if (step.kind === "tool") log.toolResults.push(await tools[step.name]!.handler(step.input, {}));
            else if (step.kind === "end") return;
            else if (step.kind === "hold") await new Promise<void>((r) => ((wake = r), interrupted && r()));
          }
        }
      }
      return Object.assign(messages(), { interrupt: async () => { log.interrupts++; interrupted = true; wake?.(); }, close: () => void log.closes++ });
    }) as unknown as typeof sdkQuery;
    return { run, log, tools: () => tools };
  }
  const start = (message: unknown = {}) => ({ kind: "events", events: [{ e: { type: "message_start", message } }] }) as Step;
  const block = (index: number, content_block: unknown) => ({ kind: "events", events: [{ e: { type: "content_block_start", index, content_block } }] }) as Step;
  const delta = (index: number, d: unknown, parent?: string) => ({ kind: "events", events: [{ e: { type: "content_block_delta", index, delta: d }, parent }] }) as Step;
  const stop = { kind: "events", events: [{ e: { type: "message_stop" } }] } as Step;
  const done = { kind: "result", result: { subtype: "success", is_error: false, result: "" } } as Step;
  const sessionOn = (script: Step[][]) => {
    const f = fake(script);
    return { ...f, session: new Session(subscriptionBrain("claude-sonnet-5-5", root, f.run), defaults(), "sys", root) };
  };

  test("two text blocks and a tool call in one model call, the tool's name without Gluon's MCP prefix; words stream as they come", async () => {
    const { session, log } = sessionOn([[
      start(), block(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Looking " }), delta(0, { type: "text_delta", text: "now." }),
      block(1, { type: "tool_use", id: "t1", name: "mcp__gluon__list_files", input: {} }), stop,
      { kind: "tool", name: "list_files", input: {} },
      start(), block(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Done." }), stop, done,
    ]]);
    await session.submit("go");
    expect(session.snapshot.items.map((i) => i.kind)).toEqual(["user", "assistant", "explored", "assistant"]);
    expect(session.snapshot.items.filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text)).toEqual(["Looking now.", "Done."]);
    expect((log.toolResults[0] as { content: { text: string }[] }).content[0]!.text).toContain("package.json");
    session.close();
  });

  test("events of a sub-agent (parent_tool_use_id set) are not the brain's words", async () => {
    const { session } = sessionOn([[start(), block(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "mine" }), delta(0, { type: "text_delta", text: "THEIRS" }, "toolu_x"), stop, done]]);
    await session.submit("go");
    expect(JSON.stringify(session.snapshot.items)).toContain("mine");
    expect(JSON.stringify(session.snapshot.items)).not.toContain("THEIRS");
    session.close();
  });

  test("a failed result says why in its own words, else from its errors, else plainly; a success flagged is_error is a failure too", async () => {
    const fails: [Record<string, unknown>, string][] = [
      [{ subtype: "success", is_error: true, result: "Credit balance is too low" }, "Credit balance is too low"],
      [{ subtype: "error_during_execution", is_error: true, errors: ["first", "second"] }, "first; second"],
      [{ subtype: "error_max_turns", is_error: true }, "the intake agent took too many steps"],
      [{ subtype: "error_during_execution", is_error: true, result: "  " }, "the intake agent's turn failed"],
    ];
    for (const [result, said] of fails) {
      const { session } = sessionOn([[{ kind: "result", result }]]);
      await session.submit("go");
      expect([said, session.snapshot.items.at(-1)]).toEqual([said, expect.objectContaining({ kind: "notice", tone: "error", text: expect.stringContaining(said) })]);
      expect(session.busy).toBe(false);
      session.close();
    }
  });

  test("after a failed turn the same `claude` takes the next message (no restart notice)", async () => {
    const { session, log } = sessionOn([[{ kind: "result", result: { subtype: "error_during_execution", is_error: true, result: "overloaded" } }], [start(), block(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "back" }), stop, done]]);
    await session.submit("one");
    await session.submit("two");
    expect(session.snapshot.items.filter((i) => i.kind === "notice")).toHaveLength(1);
    expect(session.snapshot.items.at(-1)).toMatchObject({ kind: "assistant", text: "back" });
    expect(log.closes).toBe(0);
    session.close();
  });

  test("`claude` that ends its output mid-turn is an error naming it, and the next message starts a new one with the 'forgot' notice", async () => {
    const { session } = sessionOn([[start(), { kind: "end" }], [done]]);
    await session.submit("one");
    expect(session.snapshot.items.at(-1)).toMatchObject({ kind: "notice", tone: "error", text: expect.stringContaining("the intake agent stopped") });
    await session.submit("two");
    expect(session.snapshot.items.filter((i) => i.kind === "notice" && i.tone === "info")).toEqual([expect.objectContaining({ text: expect.stringContaining("doesn't remember") })]);
    session.close();
  });

  test("Esc interrupts the query, the turn ends with the Interrupted notice, and a tool call that comes in afterwards is answered 'Stopped'", async () => {
    const { session, log, tools } = sessionOn([[start(), { kind: "hold" }, { kind: "result", result: { subtype: "error_during_execution", is_error: true, result: "interrupted" } }]]);
    const p = session.submit("go");
    await Bun.sleep(50);
    session.interrupt();
    await p;
    expect(log.interrupts).toBe(1);
    expect(session.snapshot.items.at(-1)).toMatchObject({ kind: "notice", tone: "info", text: expect.stringContaining("Interrupted") });
    expect(session.busy).toBe(false);
    // A tool call the SDK still delivers after the turn is over: no turn, no work.
    const late = await tools().list_files!.handler({}, {});
    expect(late).toMatchObject({ isError: true, content: [{ text: "No turn in progress." }] });
    session.close();
  });

  test("a model that is gone (Claude Code's own wording) moves the order on to the next brain; the plan's query is closed", async () => {
    const f = fake([[{ kind: "result", result: { subtype: "success", is_error: true, result: "There's an issue with the selected model (claude-nonesuch). It may not exist or you may not have access to it." } }]]);
    const { client: next, requests } = (() => {
      const requests: unknown[] = [];
      const client: ModelClient = async (req) => (requests.push(structuredClone(req.messages)), { content: [{ type: "text", text: "from the next", citations: null }], stop_reason: "end_turn" });
      return { client, requests };
    })();
    const session = new Session(subscriptionBrain("claude-nonesuch", root, f.run), defaults(), "sys", root, () => "", async (_m, e) => (modelUnavailable(e) ? { client: next, label: "Next" } : null));
    await session.submit("go");
    expect(session.snapshot.brain).toBe("Next");
    expect(f.log.closes).toBe(1);
    await session.submit("go");
    expect(requests).toEqual([[{ role: "user", content: "go" }]]);
    session.close();
  });

  test("`claude` not installed: the first message says so (and how to go on), without starting anything", async () => {
    const was = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "gluon-nopath-"));
    try {
      const f = fake([[done]]);
      const session = new Session(subscriptionBrain("claude-sonnet-5-5", root, f.run), defaults(), "sys", root, (m) => (/not installed/.test(m) ? "Install Claude Code (`claude`), or run `gluon brain` to see the other steps." : ""));
      await session.submit("go");
      const last = session.snapshot.items.at(-1) as { kind: string; tone: string; text: string };
      expect([last.kind, last.tone]).toEqual(["notice", "error"]);
      expect(last.text).toContain("claude is not installed");
      expect(last.text).toContain("Install Claude Code");
      expect(session.busy).toBe(false);
      session.close();
    } finally {
      process.env.PATH = was;
    }
  });
});

// --- OpenAI Responses and OpenRouter Chat Completions (the real `openai` SDK on a local server)

import { describeOpenAIError, openaiClient } from "../src/agent/openai.ts";
import { OPENROUTER_HEADERS } from "../src/brain.ts";

describe("openaiClient (the real SDK on a local server)", () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
  const chatStream = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const jsonError = (status: number, message: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ error: { message, ...extra } }), { status, headers: { "content-type": "application/json", "x-should-retry": "false" } });
  const chat = (url: string, over: Partial<Parameters<typeof openaiClient>[0]> = {}) => openaiClient({ apiKey: "sk-or-v1-0123456789abcdef0123456789abcdef", model: "anthropic/claude-sonnet-5.5", mode: "chat", baseURL: `${url}/api/v1`, headers: OPENROUTER_HEADERS, effort: "high", ...over });

  test("Chat Completions: the request carries OpenRouter's attribution headers, the tools as functions, max_tokens and reasoning.effort; text streams, parallel tool calls are assembled by index", async () => {
    const { url, requests } = serve(() => chatStream([
      chunk({ role: "assistant", content: "Look" }), chunk({ content: "ing." }),
      chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "grep", arguments: '{"pattern":' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "list_files", arguments: "{}" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
      chunk({}, "tool_calls"),
    ]));
    const deltas: string[] = [];
    const res = await chat(url)(ask(), (d) => deltas.push(d));
    const r = requests[0]!;
    expect([r.method, r.path]).toEqual(["POST", "/api/v1/chat/completions"]);
    expect(r.headers.authorization).toBe("Bearer sk-or-v1-0123456789abcdef0123456789abcdef");
    expect(r.headers["http-referer"]).toBe(OPENROUTER_HEADERS["HTTP-Referer"]);
    expect(r.headers["x-title"]).toBe("Gluon");
    expect(r.body).toMatchObject({ model: "anthropic/claude-sonnet-5.5", stream: true, max_tokens: 8192, reasoning: { effort: "high" }, tools: [{ type: "function", function: { name: "list_files" } }], messages: [{ role: "system", content: "You are Gluon." }, { role: "user", content: "hi" }] });
    expect(deltas.join("")).toBe("Looking.");
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content).toMatchObject([{ type: "text", text: "Looking." }, { type: "tool_use", id: "call_a", name: "grep", input: { pattern: "x" } }, { type: "tool_use", id: "call_b", name: "list_files", input: {} }]);
  });

  test("a tool call whose arguments aren't JSON reaches the session as an input the tool refuses, not as a crash", async () => {
    const { url } = serve((_, n) => chatStream(n === 1
      ? [chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path": "pack' } }] }), chunk({}, "tool_calls")]
      : [chunk({ content: "ok" }), chunk({}, "stop")]));
    const s = new Session(chat(url), defaults(), "sys", root);
    await s.submit("go");
    expect(s.busy).toBe(false);
    expect(s.snapshot.items.at(-1)).toMatchObject({ kind: "assistant", text: "ok" });
  });

  test("finish_reason length is max_tokens; a stream with no chunks at all is an empty reply", async () => {
    const { url } = serve((_, n) => chatStream(n === 1 ? [chunk({ content: "cut" }, "length")] : []));
    const b = chat(url);
    expect((await b(ask(), () => {})).stop_reason).toBe("max_tokens");
    expect(await b(ask(), () => {})).toEqual({ content: [], stop_reason: "end_turn" });
  });

  test("errors: the provider's wording decides what is 'model unavailable', and the probe's reading says the same", async () => {
    const cases: [string, number, string, boolean][] = [
      ["401", 401, "No auth credentials found", false],
      ["402", 402, "Insufficient credits", false],
      ["404 no endpoints", 404, "No endpoints found for anthropic/claude-nonesuch.", true],
      ["429", 429, "Rate limit exceeded", false],
      ["502", 502, "Provider returned error", false],
    ];
    for (const [name, status, message, unavailable] of cases) {
      const { url } = serve(() => jsonError(status, message, { code: status }));
      const error = await chat(url)(ask(), () => {}).then(() => null, (e: Error & { status?: number }) => e);
      expect([name, error?.status, error?.message.includes(message), modelUnavailable(error)]).toEqual([name, status, true, unavailable]);
      expect(describeOpenAIError(error, "sk-or-v1-0123456789abcdef0123456789abcdef")).not.toContain("0123456789abcdef0123456789abcdef");
    }
  });

  test("Responses (the SDK's own endpoint, a local server behind it): input items, instructions, store false, reasoning.effort, streamed text; a failed response and an error event are errors with their messages", async () => {
    const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const completed = { id: "r1", status: "completed", incomplete_details: null, output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "Hello", annotations: [] }] }, { type: "function_call", id: "f1", call_id: "call_1", name: "list_files", arguments: "{}" }] };
    const { url, requests } = serve((_, n) => new Response(n === 1 ? event("response.output_text.delta", { delta: "Hel" }) + event("response.output_text.delta", { delta: "lo" }) + event("response.completed", { response: completed }) : n === 2 ? event("response.failed", { response: { status: "failed", error: { message: "The server had an error" } } }) : event("error", { message: "stream broke" }), { headers: { "content-type": "text/event-stream" } }));
    redirectTo(url);
    try {
      const b = openaiClient({ apiKey: "sk-proj-test0123456789abcdefghij", model: "gpt-6.1-sol", mode: "responses", effort: "medium" });
      const deltas: string[] = [];
      const res = await b(ask({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "tool_use", id: "call_0", name: "list_files", input: {} } as Anthropic.ToolUseBlockParam] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_0", content: "a.ts", is_error: true }] }] }), (d) => deltas.push(d));
      expect(requests[0]!.path).toBe("/v1/responses");
      expect(requests[0]!.body).toMatchObject({ model: "gpt-6.1-sol", instructions: "You are Gluon.", store: false, stream: true, max_output_tokens: 8192, reasoning: { effort: "medium" }, input: [{ role: "user", content: "hi" }, { type: "function_call", call_id: "call_0", name: "list_files" }, { type: "function_call_output", call_id: "call_0", output: "Error: a.ts" }] });
      expect(deltas.join("")).toBe("Hello");
      expect(res).toMatchObject({ stop_reason: "tool_use", content: [{ type: "text", text: "Hello" }, { type: "tool_use", id: "call_1", name: "list_files" }] });
      await expect(b(ask(), () => {})).rejects.toThrow("The server had an error");
      await expect(b(ask(), () => {})).rejects.toThrow("stream broke");
    } finally {
      restoreFetch();
    }
  });
});
