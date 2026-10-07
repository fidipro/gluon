import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "bun:test";
import {
  assembleChatChunks,
  customHeaderNames,
  describeOpenAIError,
  fromChatCompletion,
  fromResponsesOutput,
  openaiClient,
  probeOpenAI,
  toChatMessages,
  toChatTools,
  toResponsesInput,
  toResponsesTools,
  type OpenAILike,
} from "../src/agent/openai.ts";
import { bedrockRuntimeClient } from "../src/agent/bedrock-converse.ts";
import type { ModelClient } from "../src/agent/session.ts";
import { TOOLS } from "../src/agent/tools.ts";
import { brainFor, envWarnings, probeStep } from "../src/brain.ts";
import { defaults } from "../src/config.ts";
import { bedrockRuntimeBase } from "../src/harnesses.ts";

const tool = (id: string, name: string, input: object) =>
  ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as Anthropic.ToolUseBlock;

/** A conversation with text, two tool calls in one turn, results (one an error), and a follow-up. */
const history: Anthropic.MessageParam[] = [
  { role: "user", content: "fix the bug" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Looking.", citations: null },
      tool("call_1", "list_files", {}),
      tool("call_2", "read_file", { path: "a.ts" }),
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_1", content: "a.ts\nb.ts" },
      { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "no such file" }], is_error: true },
      { type: "text", text: "also check b" },
    ],
  },
];

async function* iterate<T>(items: T[]) {
  for (const i of items) yield i;
}

/** A fake SDK client that records requests and replays events. */
function fake(events: unknown[], final?: unknown) {
  const calls: { body: any; options: any }[] = [];
  const create = async (body: any, options: any) => {
    calls.push({ body, options });
    return body.stream ? iterate(events) : final;
  };
  const client: OpenAILike = { responses: { create }, chat: { completions: { create } } };
  return { client, calls };
}

test("tools convert to function tools with the same names and schemas", () => {
  const r = toResponsesTools(TOOLS);
  expect(r.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  expect(r[1]).toMatchObject({ type: "function", name: "grep", strict: false, parameters: TOOLS[1]!.input_schema });
  const c = toChatTools(TOOLS);
  expect(c[2]).toMatchObject({ type: "function", function: { name: "read_file", parameters: TOOLS[2]!.input_schema } });
  for (const t of TOOLS) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
});

test("Responses input: text, function calls and outputs keep their ids; errors are marked", () => {
  expect(toResponsesInput(history)).toEqual([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: "Looking." },
    { type: "function_call", call_id: "call_1", name: "list_files", arguments: "{}" },
    { type: "function_call", call_id: "call_2", name: "read_file", arguments: '{"path":"a.ts"}' },
    { type: "function_call_output", call_id: "call_1", output: "a.ts\nb.ts" },
    { type: "function_call_output", call_id: "call_2", output: "Error: no such file" },
    { role: "user", content: "also check b" },
  ]);
});

test("Responses output: text and tool calls come back Anthropic-shaped", () => {
  const out = fromResponsesOutput({
    status: "completed",
    incomplete_details: null,
    output: [
      { type: "reasoning", id: "rs_1", summary: [] } as any,
      { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Let me ask.", annotations: [] } as any] },
      { type: "function_call", call_id: "call_9", name: "ask_user", arguments: '{"question":"Q?","options":[{"label":"a"},{"label":"b"}]}' },
    ],
  });
  expect(out.stop_reason).toBe("tool_use");
  expect(out.content).toEqual([
    { type: "text", text: "Let me ask.", citations: null },
    { type: "tool_use", id: "call_9", name: "ask_user", input: { question: "Q?", options: [{ label: "a" }, { label: "b" }] }, caller: { type: "direct" } } as any,
  ]);
  expect(fromResponsesOutput({ status: "completed", incomplete_details: null, output: [] }).stop_reason).toBe("end_turn");
  expect(fromResponsesOutput({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }).stop_reason).toBe("max_tokens");
});

test("Chat messages: system first, assistant tool_calls, tool messages, then the user's text", () => {
  expect(toChatMessages("sys", history)).toEqual([
    { role: "system", content: "sys" },
    { role: "user", content: "fix the bug" },
    {
      role: "assistant",
      content: "Looking.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "list_files", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "a.ts\nb.ts" },
    { role: "tool", tool_call_id: "call_2", content: "Error: no such file" },
    { role: "user", content: "also check b" },
  ]);
  // A turn that is only tool calls has null content.
  const [, msg] = toChatMessages("", [{ role: "user", content: "x" }, { role: "assistant", content: [tool("c", "grep", { pattern: "x" })] }]);
  expect(msg).toMatchObject({ role: "assistant", content: null });
});

test("Chat stream chunks assemble into text and tool calls; finish reasons map", () => {
  const chunk = (delta: object, finish_reason: string | null = null) => ({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason }] }) as any;
  const done = assembleChatChunks([
    chunk({ content: "Hi " }),
    chunk({ content: "there." }),
    chunk({ tool_calls: [{ index: 0, id: "t1", function: { name: "grep", arguments: '{"pat' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: "t2", function: { name: "list_files", arguments: "" } }] }),
    chunk({}, "tool_calls"),
  ]);
  const out = fromChatCompletion(done);
  expect(out.stop_reason).toBe("tool_use");
  expect(out.content.map((b) => (b.type === "tool_use" ? [b.id, b.name, b.input] : b.type === "text" ? b.text : b.type))).toEqual([
    "Hi there.",
    ["t1", "grep", { pattern: "x" }],
    ["t2", "list_files", {}],
  ]);
  expect(fromChatCompletion(assembleChatChunks([chunk({ content: "long" }, "length")])).stop_reason).toBe("max_tokens");
  expect(fromChatCompletion(assembleChatChunks([chunk({ content: "ok" }, "stop")])).stop_reason).toBe("end_turn");
});

test("responses mode streams text and returns the completed response", async () => {
  const response = {
    status: "completed",
    incomplete_details: null,
    output: [
      { type: "message", content: [{ type: "output_text", text: "Hello world" }] },
      { type: "function_call", call_id: "call_1", name: "list_files", arguments: "{}" },
    ],
  };
  const { client, calls } = fake([
    { type: "response.created" },
    { type: "response.output_text.delta", delta: "Hello " },
    { type: "response.output_text.delta", delta: "world" },
    { type: "response.completed", response },
  ]);
  const brain = openaiClient({ apiKey: "k", model: "gpt-6-sol", mode: "responses", client });
  const deltas: string[] = [];
  const signal = new AbortController().signal;
  const res = await brain({ system: "sys", messages: history, tools: TOOLS, signal }, (d) => deltas.push(d));
  expect(deltas.join("")).toBe("Hello world");
  expect(res.stop_reason).toBe("tool_use");
  expect(res.content[1]).toMatchObject({ type: "tool_use", id: "call_1", name: "list_files" });
  expect(calls[0]!.body).toMatchObject({ model: "gpt-6-sol", instructions: "sys", stream: true, store: false });
  expect(calls[0]!.body.tools).toHaveLength(TOOLS.length);
  expect(calls[0]!.options.signal).toBe(signal);
});

test("responses mode surfaces a failed response", async () => {
  const { client } = fake([{ type: "response.failed", response: { error: { message: "boom" } } }]);
  const brain = openaiClient({ apiKey: "k", model: "m", mode: "responses", client });
  await expect(brain({ system: "", messages: [{ role: "user", content: "x" }], tools: [], signal: new AbortController().signal }, () => {})).rejects.toThrow("boom");
});

test("chat mode streams text and tool calls", async () => {
  const chunk = (delta: object, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
  const { client, calls } = fake([
    chunk({ content: "On it." }),
    chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"x"}' } }] }),
    chunk({}, "tool_calls"),
  ]);
  const brain = openaiClient({ apiKey: "k", model: "openai/gpt-6-sol", mode: "chat", client });
  const deltas: string[] = [];
  const res = await brain({ system: "sys", messages: history, tools: TOOLS, signal: new AbortController().signal }, (d) => deltas.push(d));
  expect(deltas).toEqual(["On it."]);
  expect(res).toEqual({
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "On it.", citations: null },
      { type: "tool_use", id: "c1", name: "read_file", input: { path: "x" }, caller: { type: "direct" } } as any,
    ],
  });
  expect(calls[0]!.body.messages[0]).toEqual({ role: "system", content: "sys" });
  expect(calls[0]!.body.stream).toBe(true);
});

test("an abort stops the stream", async () => {
  const ctl = new AbortController();
  const { client } = fake([{ choices: [{ index: 0, delta: { content: "a" }, finish_reason: null }] }, { choices: [{ index: 0, delta: { content: "b" }, finish_reason: null }] }]);
  const brain = openaiClient({ apiKey: "k", model: "m", mode: "chat", client });
  const seen: string[] = [];
  const run = brain({ system: "", messages: [{ role: "user", content: "x" }], tools: [], signal: ctl.signal }, (d) => {
    seen.push(d);
    ctl.abort();
  });
  await expect(run).rejects.toThrow();
  expect(seen).toEqual(["a"]);
});

test("probe returns usage, and classifies errors without leaking the key", async () => {
  const ok = fake([], { status: "completed", usage: { input_tokens: 9, output_tokens: 5 } });
  expect(await probeOpenAI({ apiKey: "k", model: "gpt-6-sol", mode: "responses", client: ok.client })).toEqual({ ok: true, usage: { input: 9, output: 5 } });
  expect(ok.calls[0]!.body.max_output_tokens).toBeLessThanOrEqual(16);

  const chat = fake([], { usage: { prompt_tokens: 7, completion_tokens: 2 } });
  expect(await probeOpenAI({ apiKey: "k", model: "openai/gpt-6-sol", mode: "chat", client: chat.client })).toEqual({ ok: true, usage: { input: 7, output: 2 } });
  expect(chat.calls[0]!.body.max_tokens).toBeLessThanOrEqual(16);

  const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx";
  const failing = (err: object): OpenAILike => {
    const create = async () => {
      throw err;
    };
    return { responses: { create }, chat: { completions: { create } } };
  };
  const probe = (err: object) => probeOpenAI({ apiKey: key, model: "m", mode: "responses", client: failing(err) });
  const r401 = await probe({ status: 401, message: `401 Incorrect API key provided: ${key}` });
  expect(r401.ok).toBe(false);
  if (!r401.ok) {
    expect(r401.error).toContain("API key was rejected");
    expect(r401.error).not.toContain(key);
  }
  const r404 = await probe({ status: 404, message: "The model `m` does not exist or you do not have access to it." });
  expect(!r404.ok && r404.error).toContain("model not found");
  const r429 = await probe({ status: 429, message: "Rate limit reached" });
  expect(!r429.ok && r429.error).toContain("rate limited");
  expect(describeOpenAIError({ status: 429, code: "insufficient_quota", message: "You exceeded your current quota" })).toContain("no credit or quota");
  expect(describeOpenAIError(new Error("leaked sk-or-v1-0123456789abcdef0123"))).not.toContain("0123456789abcdef");
});

// Security QA pass: where a saved key is sent (BUG-590, BUG-591). The SDKs take a base URL from the environment unless they are given one.
describe("the brain's API clients and the environment's base URLs", () => {
  /** Every request the SDKs make, answered 401 without a network; the environment's variables set for the call. */
  async function requests(env: Record<string, string>, call: () => Promise<unknown>): Promise<{ url: string; headers: Record<string, string> }[]> {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const realFetch = globalThis.fetch;
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      seen.push({ url: String(input instanceof Request ? input.url : input), headers: Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))) });
      return new Response(JSON.stringify({ error: { message: "no" } }), { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    Object.assign(process.env, env);
    try {
      await call().catch(() => {});
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return seen;
  }
  const hosts = async (env: Record<string, string>, call: () => Promise<unknown>): Promise<string[]> => (await requests(env, call)).map((r) => r.url);
  const HOSTILE = "https://attacker.example";
  // Built at run time so no secret scanner sees a key shape in this file.
  const OR_KEY = "sk-or-v1-" + "SAVEDKEY".repeat(3);
  const turn = () => ({ system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [], signal: new AbortController().signal });
  /** The brain's probes read keys from the environment and the answers file only in tests. */
  const probeEnv = { GLUON_TEST_PROBES: "" };
  const never = (urls: string[], ...allowed: string[]) => expect(urls.filter((u) => !allowed.some((a) => u.startsWith(a)))).toEqual([]);

  describe("BUG-590: OpenAI", () => {
    test("BUG-590/QA-sec-16: the OpenAI-key brain sends its saved key and the conversation to OpenAI's endpoint only, whatever OPENAI_BASE_URL says (a direnv/.envrc of the repository can set it; the SDK reads it by default)", async () => {
      const urls = await hosts({ OPENAI_BASE_URL: "https://attacker.example/v1" }, () => probeOpenAI({ apiKey: "sk-proj-SAVEDKEYSAVEDKEYSAVEDKEY", model: "gpt-6-sol", mode: "responses" }));
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.filter((u) => !u.startsWith("https://api.openai.com/"))).toEqual([]);
    });

    test("the conversation too: Responses and Chat Completions clients, with OPENAI_BASE_URL and OPENAI_API_BASE set", async () => {
      for (const mode of ["responses", "chat"] as const) {
        const urls = await hosts({ OPENAI_BASE_URL: `${HOSTILE}/v1`, OPENAI_API_BASE: `${HOSTILE}/v1` }, () => openaiClient({ apiKey: "sk-proj-SAVEDKEYSAVEDKEYSAVEDKEY", model: "gpt-6-sol", mode })(turn(), () => {}));
        expect([mode, urls]).toEqual([mode, [mode === "responses" ? "https://api.openai.com/v1/responses" : "https://api.openai.com/v1/chat/completions"]]);
      }
    });

    test("the brain's own steps: the probe and the client of the OpenAI-key route", async () => {
      const step = { route: "openai-api" as const, model: "gpt-6-sol" };
      const env = { ...probeEnv, OPENAI_API_KEY: "sk-proj-SAVEDKEYSAVEDKEYSAVEDKEY", OPENAI_BASE_URL: `${HOSTILE}/v1` };
      const probed = await hosts(env, () => probeStep(defaults(), step, process.cwd()));
      const asked = await hosts(env, () => (brainFor(defaults(), step, process.cwd()) as ModelClient)(turn(), () => {}));
      expect([probed.length, asked.length]).toEqual([1, 1]);
      never([...probed, ...asked], "https://api.openai.com/v1/");
    });

    test("the OpenRouter route keeps OpenRouter's endpoint, whatever OPENAI_BASE_URL says", async () => {
      const step = { route: "openrouter" as const, model: "anthropic/claude-sonnet-5.5" };
      const env = { ...probeEnv, OPENROUTER_API_KEY: OR_KEY, OPENAI_BASE_URL: `${HOSTILE}/v1` };
      const probed = await hosts(env, () => probeStep(defaults(), step, process.cwd()));
      const asked = await hosts(env, () => (brainFor(defaults(), step, process.cwd()) as ModelClient)(turn(), () => {}));
      expect([probed.length, asked.length]).toEqual([1, 1]);
      never([...probed, ...asked], "https://openrouter.ai/api/v1/");
    });
  });

  describe("BUG-591: Anthropic and Bedrock", () => {
    const brain = (key = "sk-ant-SAVEDKEYSAVEDKEY00000") => import("../src/agent/clients.ts").then(({ anthropicBrain }) => anthropicBrain(key, "claude-sonnet-5-5"));
    test("BUG-591/QA-sec-17: …and the Anthropic-key brain to api.anthropic.com only, whatever ANTHROPIC_BASE_URL says", async () => {
      const b = await brain();
      const urls = await hosts({ ANTHROPIC_BASE_URL: "https://attacker.example" }, () => b({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] } as never, () => {}));
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.filter((u) => !u.startsWith("https://api.anthropic.com/"))).toEqual([]);
    });

    test("the probe of the Anthropic-key route and the client built by the brain's step", async () => {
      const step = { route: "anthropic-api" as const, model: "claude-sonnet-5-5" };
      const env = { ...probeEnv, ANTHROPIC_API_KEY: "sk-ant-SAVEDKEYSAVEDKEY00000", ANTHROPIC_BASE_URL: HOSTILE };
      const probed = await hosts(env, () => probeStep(defaults(), step, process.cwd()));
      const asked = await hosts(env, () => (brainFor(defaults(), step, process.cwd()) as ModelClient)(turn(), () => {}));
      expect([probed.length, asked.length]).toEqual([1, 1]);
      never([...probed, ...asked], "https://api.anthropic.com/");
    });

    test("Claude on Bedrock: the region's runtime endpoint, whatever ANTHROPIC_BEDROCK_BASE_URL says (the SDK signs the request for that host and takes the variable by default)", async () => {
      const aws = { AWS_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST", AWS_SECRET_ACCESS_KEY: "test-secret-test-secret-test-secret-12", AWS_REGION: "eu-west-1", ANTHROPIC_BEDROCK_BASE_URL: HOSTILE };
      const { bedrockClaudeBrain } = await import("../src/agent/clients.ts");
      const config = { ...defaults(), bedrock: { region: "eu-west-1" } };
      const urls = await hosts(aws, () => bedrockClaudeBrain(config, "global.anthropic.claude-sonnet-5-5")(turn(), () => {}));
      expect(urls).toEqual(["https://bedrock-runtime.eu-west-1.amazonaws.com/model/global.anthropic.claude-sonnet-5-5/invoke-with-response-stream"]);
      // The config's region wins over the environment's, and the endpoint follows it.
      const other = await hosts(aws, () => bedrockClaudeBrain({ ...defaults(), bedrock: { region: "us-west-2" } }, "global.anthropic.claude-sonnet-5-5")(turn(), () => {}));
      expect(other.map((u) => new URL(u).host)).toEqual(["bedrock-runtime.us-west-2.amazonaws.com"]);
    });

    test("Converse (the AWS SDK): AWS_ENDPOINT_URL and AWS_ENDPOINT_URL_BEDROCK_RUNTIME don't move the request off the region's endpoint", async () => {
      const seen: string[] = [];
      const requestHandler = { handle: async (r: { hostname: string }) => (seen.push(r.hostname), Promise.reject(new Error("stop"))), destroy() {} };
      const saved = { a: process.env.AWS_ENDPOINT_URL, b: process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME, k: process.env.AWS_ACCESS_KEY_ID, s: process.env.AWS_SECRET_ACCESS_KEY };
      Object.assign(process.env, { AWS_ENDPOINT_URL: HOSTILE, AWS_ENDPOINT_URL_BEDROCK_RUNTIME: HOSTILE, AWS_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST", AWS_SECRET_ACCESS_KEY: "test-secret-test-secret-test-secret-12" });
      try {
        const { ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
        const client = await bedrockRuntimeClient({ model: "m", region: "eu-west-1" }, { requestHandler, maxAttempts: 1 });
        await client.send(new ConverseCommand({ modelId: "m", messages: [] })).catch(() => {});
      } finally {
        for (const [k, v] of [["AWS_ENDPOINT_URL", saved.a], ["AWS_ENDPOINT_URL_BEDROCK_RUNTIME", saved.b], ["AWS_ACCESS_KEY_ID", saved.k], ["AWS_SECRET_ACCESS_KEY", saved.s]] as const) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      expect(seen).toEqual(["bedrock-runtime.eu-west-1.amazonaws.com"]);
    });

    test("China's regions: the runtime endpoint is under amazonaws.com.cn", async () => {
      expect(bedrockRuntimeBase("cn-north-1")).toBe("https://bedrock-runtime.cn-north-1.amazonaws.com.cn");
      expect(bedrockRuntimeBase("cn-northwest-1")).toBe("https://bedrock-runtime.cn-northwest-1.amazonaws.com.cn");
      expect(bedrockRuntimeBase("us-gov-west-1")).toBe("https://bedrock-runtime.us-gov-west-1.amazonaws.com");
      const aws = { AWS_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST", AWS_SECRET_ACCESS_KEY: "test-secret-test-secret-test-secret-12", ANTHROPIC_BEDROCK_BASE_URL: HOSTILE };
      const { bedrockClaudeBrain } = await import("../src/agent/clients.ts");
      const urls = await hosts(aws, () => bedrockClaudeBrain({ ...defaults(), bedrock: { region: "cn-north-1" } }, "anthropic.claude-sonnet-5-5")(turn(), () => {}));
      expect(urls.map((u) => new URL(u).host)).toEqual(["bedrock-runtime.cn-north-1.amazonaws.com.cn"]);
    });
  });

  describe("BUG-591: what else the environment holds for a provider", () => {
    const TOKEN = { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat-ENVTOKENENVTOKEN" };
    const AWS = { AWS_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST", AWS_SECRET_ACCESS_KEY: "test-secret-test-secret-test-secret-12" };

    test("ANTHROPIC_AUTH_TOKEN is not sent as a bearer token next to the saved key (the brain and its probe)", async () => {
      const step = { route: "anthropic-api" as const, model: "claude-sonnet-5-5" };
      const env = { ...probeEnv, ...TOKEN, ANTHROPIC_API_KEY: "sk-ant-SAVEDKEYSAVEDKEY00000" };
      const probed = await requests(env, () => probeStep(defaults(), step, process.cwd()));
      const asked = await requests(env, () => (brainFor(defaults(), step, process.cwd()) as ModelClient)(turn(), () => {}));
      expect([probed.length, asked.length]).toEqual([1, 1]);
      for (const r of [...probed, ...asked]) expect([r.headers["x-api-key"], r.headers.authorization]).toEqual(["sk-ant-SAVEDKEYSAVEDKEY00000", undefined]);
    });

    test("Claude on Bedrock: the request is signed, ANTHROPIC_AUTH_TOKEN is not sent", async () => {
      const { bedrockClaudeBrain } = await import("../src/agent/clients.ts");
      const sent = await requests({ ...AWS, ...TOKEN, AWS_REGION: "eu-west-1" }, () => bedrockClaudeBrain({ ...defaults(), bedrock: { region: "eu-west-1" } }, "global.anthropic.claude-sonnet-5-5")(turn(), () => {}));
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(JSON.stringify(sent[0]!.headers)).not.toContain("ENVTOKEN");
    });

    const FOREIGN = { OPENAI_ORG_ID: "org-HOMEORG", OPENAI_PROJECT_ID: "proj_HOMEPROJECT", OPENAI_CUSTOM_HEADERS: "X-Corp-Proxy: secret-corp-value\nx-trace-id : abc\nnot a header line" };
    const headersOf = (r: { headers: Record<string, string> }) => JSON.stringify(r.headers);

    test("OpenRouter: the OpenAI organization, project and custom headers of the environment stay home; Gluon's own headers go", async () => {
      const step = { route: "openrouter" as const, model: "anthropic/claude-sonnet-5.5" };
      const env = { ...probeEnv, ...FOREIGN, OPENROUTER_API_KEY: OR_KEY };
      const probed = await requests(env, () => probeStep(defaults(), step, process.cwd()));
      const asked = await requests(env, () => (brainFor(defaults(), step, process.cwd()) as ModelClient)(turn(), () => {}));
      expect([probed.length, asked.length]).toEqual([1, 1]);
      for (const r of [...probed, ...asked]) {
        expect(headersOf(r)).not.toMatch(/HOMEORG|HOMEPROJECT|corp|x-trace-id|openai-organization|openai-project/i);
        expect([r.headers["x-title"], r.headers.authorization]).toEqual(["Gluon", `Bearer ${OR_KEY}`]);
        expect(r.headers["http-referer"]).toBeTruthy();
      }
    });

    test("the OpenAI route keeps them: they are the user's own choice of billing and proxy", async () => {
      const step = { route: "openai-api" as const, model: "gpt-6-sol" };
      const env = { ...probeEnv, ...FOREIGN, OPENAI_API_KEY: "sk-proj-SAVEDKEYSAVEDKEYSAVEDKEY" };
      const asked = await requests(env, () => (brainFor(defaults(), step, process.cwd()) as ModelClient)(turn(), () => {}));
      expect(asked).toHaveLength(1);
      expect([asked[0]!.headers["openai-organization"], asked[0]!.headers["openai-project"], asked[0]!.headers["x-corp-proxy"], asked[0]!.headers["x-trace-id"]]).toEqual(["org-HOMEORG", "proj_HOMEPROJECT", "secret-corp-value", "abc"]);
    });

    test("the header names of a custom-headers variable, as the SDKs read it", () => {
      expect(customHeaderNames("A-B: 1\n  c : 2\nnone\n: x\nD:e:f")).toEqual(["A-B", "c", "D"]);
      expect(customHeaderNames(undefined)).toEqual([]);
    });

    test("told, never stripped: custom headers and a Bedrock bearer token are warned about on their own route only", () => {
      const keys = ["ANTHROPIC_CUSTOM_HEADERS", "OPENAI_CUSTOM_HEADERS", "AWS_BEARER_TOKEN_BEDROCK"];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      try {
        for (const k of keys) delete process.env[k];
        const steps = [
          { route: "anthropic-api" as const, model: "claude-sonnet-5-5" },
          { route: "openai-api" as const, model: "gpt-6-sol" },
          { route: "openrouter" as const, model: "anthropic/claude-sonnet-5.5" },
          { route: "bedrock" as const, model: "global.anthropic.claude-sonnet-5-5" },
          { route: "bedrock" as const, model: "us.openai.gpt-6-sol" },
        ];
        expect(steps.map((s) => envWarnings(s))).toEqual([[], [], [], [], []]);
        Object.assign(process.env, { ANTHROPIC_CUSTOM_HEADERS: "X: 1", OPENAI_CUSTOM_HEADERS: "Y: 2", AWS_BEARER_TOKEN_BEDROCK: "bearer" });
        const [anthropic, openai, openrouter, claude, converse] = steps.map((s) => envWarnings(s).map((w) => w.split(" ")[0]));
        expect([anthropic, openai, openrouter, claude, converse]).toEqual([["ANTHROPIC_CUSTOM_HEADERS"], ["OPENAI_CUSTOM_HEADERS"], [], ["ANTHROPIC_CUSTOM_HEADERS", "AWS_BEARER_TOKEN_BEDROCK"], ["AWS_BEARER_TOKEN_BEDROCK"]]);
        for (const k of keys) expect(process.env[k]).toBeTruthy();
      } finally {
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  });
});
