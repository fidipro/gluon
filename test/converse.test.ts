import type Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "bun:test";
import {
  converseClient,
  describeConverseError,
  fromConverseOutput,
  probeConverse,
  readConverseStream,
  toConverseMessages,
  toConverseTools,
  type ConverseLike,
} from "../src/agent/bedrock-converse.ts";
import { TOOLS } from "../src/agent/tools.ts";

const tool = (id: string, name: string, input: object) =>
  ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as Anthropic.ToolUseBlock;

const history: Anthropic.MessageParam[] = [
  { role: "user", content: "fix the bug" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Looking.", citations: null },
      tool("t1", "list_files", {}),
      tool("t2", "read_file", { path: "a.ts" }),
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "a.ts" },
      { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "no such file" }], is_error: true },
      { type: "text", text: "also check b" },
    ],
  },
];

async function* iterate<T>(items: T[]) {
  for (const i of items) yield i;
}

/** A fake Bedrock client that records command inputs and replays a stream or a response. */
function fake(events: unknown[], response?: unknown) {
  const calls: { input: any; options: any }[] = [];
  const client: ConverseLike = {
    send: async (command, options) => {
      calls.push({ input: command.input, options });
      return response ?? { stream: iterate(events) };
    },
  };
  return { client, calls };
}

test("tools convert to Converse tool specs", () => {
  const t = toConverseTools(TOOLS);
  expect(t.map((x) => x.toolSpec?.name)).toEqual(TOOLS.map((x) => x.name));
  expect(t[1]!.toolSpec).toMatchObject({ name: "grep", inputSchema: { json: TOOLS[1]!.input_schema } });
});

test("messages convert with tool ids preserved, errors marked, blanks dropped and roles merged", () => {
  expect(toConverseMessages(history)).toEqual([
    { role: "user", content: [{ text: "fix the bug" }] },
    {
      role: "assistant",
      content: [
        { text: "Looking." },
        { toolUse: { toolUseId: "t1", name: "list_files", input: {} } },
        { toolUse: { toolUseId: "t2", name: "read_file", input: { path: "a.ts" } } },
      ],
    },
    {
      role: "user",
      content: [
        { toolResult: { toolUseId: "t1", content: [{ text: "a.ts" }] } },
        { toolResult: { toolUseId: "t2", content: [{ text: "Error: no such file" }] } },
        { text: "also check b" },
      ],
    },
  ]);
  const merged = toConverseMessages([
    { role: "user", content: "a" },
    { role: "assistant", content: [{ type: "text", text: "  ", citations: null }] },
    { role: "user", content: "b" },
  ]);
  expect(merged).toEqual([{ role: "user", content: [{ text: "a" }, { text: "b" }] }]);
});

test("output converts back; stop reasons map to Anthropic's", () => {
  const out = fromConverseOutput(
    { role: "assistant", content: [{ text: "Asking." }, { toolUse: { toolUseId: "tooluse_1", name: "ask_user", input: { question: "Q?" } } }] },
    "tool_use",
  );
  expect(out).toEqual({
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "Asking.", citations: null },
      { type: "tool_use", id: "tooluse_1", name: "ask_user", input: { question: "Q?" }, caller: { type: "direct" } } as any,
    ],
  });
  expect(fromConverseOutput({ role: "assistant", content: [{ text: "x" }] }, "max_tokens").stop_reason).toBe("max_tokens");
  expect(fromConverseOutput({ role: "assistant", content: [{ text: "x" }] }, "end_turn").stop_reason).toBe("end_turn");
});

const streamEvents = [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Let me " } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "look." } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu_1", name: "grep" } } } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"pattern":' } } } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"x"}' } } } },
  { contentBlockStop: { contentBlockIndex: 1 } },
  { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: "tu_2", name: "list_files" } } } },
  { contentBlockStop: { contentBlockIndex: 2 } },
  { messageStop: { stopReason: "tool_use" } },
  { metadata: { usage: { inputTokens: 100, outputTokens: 20 } } },
];

test("the stream folds into one message with usage", async () => {
  const deltas: string[] = [];
  const s = await readConverseStream(iterate(streamEvents) as any, (d) => deltas.push(d));
  expect(deltas.join("")).toBe("Let me look.");
  expect(s.stopReason).toBe("tool_use");
  expect(s.usage).toEqual({ input: 100, output: 20 });
  expect(s.message.content).toEqual([
    { text: "Let me look." },
    { toolUse: { toolUseId: "tu_1", name: "grep", input: { pattern: "x" } } },
    { toolUse: { toolUseId: "tu_2", name: "list_files", input: {} } },
  ]);
});

test("the client sends system, tools and messages and returns Anthropic content", async () => {
  const { client, calls } = fake(streamEvents);
  const brain = converseClient({ model: "us.openai.gpt-6-sol", client });
  const signal = new AbortController().signal;
  const deltas: string[] = [];
  const res = await brain({ system: "sys", messages: history, tools: TOOLS, signal }, (d) => deltas.push(d));
  expect(deltas.join("")).toBe("Let me look.");
  expect(res.stop_reason).toBe("tool_use");
  expect(res.content.filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.ToolUseBlock).id)).toEqual(["tu_1", "tu_2"]);
  expect(calls[0]!.input).toMatchObject({ modelId: "us.openai.gpt-6-sol", system: [{ text: "sys" }] });
  expect(calls[0]!.input.toolConfig.tools).toHaveLength(TOOLS.length);
  expect(calls[0]!.options.abortSignal).toBe(signal);
});

test("a stream error event is thrown", async () => {
  const { client } = fake([{ throttlingException: { name: "ThrottlingException", message: "slow down" } }]);
  const brain = converseClient({ model: "m", client });
  await expect(brain({ system: "", messages: [{ role: "user", content: "x" }], tools: [], signal: new AbortController().signal }, () => {})).rejects.toThrow("slow down");
});

test("an abort stops the stream", async () => {
  const ctl = new AbortController();
  const { client } = fake(streamEvents);
  const brain = converseClient({ model: "m", client });
  const seen: string[] = [];
  const run = brain({ system: "", messages: [{ role: "user", content: "x" }], tools: [], signal: ctl.signal }, (d) => {
    seen.push(d);
    ctl.abort();
  });
  await expect(run).rejects.toThrow();
  expect(seen).toEqual(["Let me "]);
});

test("probe returns usage and readable errors", async () => {
  const ok = fake([], { usage: { inputTokens: 8, outputTokens: 3 } });
  expect(await probeConverse({ model: "us.openai.gpt-6-sol", client: ok.client })).toEqual({ ok: true, usage: { input: 8, output: 3 } });
  expect(ok.calls[0]!.input.inferenceConfig.maxTokens).toBeLessThanOrEqual(16);

  const failing = (name: string, message: string): ConverseLike => ({
    send: async () => {
      throw Object.assign(new Error(message), { name });
    },
  });
  const probe = (name: string, message: string) => probeConverse({ model: "us.openai.gpt-6-sol", region: "us-east-1", client: failing(name, message) });
  const denied = await probe("AccessDeniedException", "You don't have access to the model with the specified model ID.");
  expect(!denied.ok && denied.error).toContain("access denied");
  const unknown = await probe("ValidationException", "The provided model identifier is invalid.");
  expect(!unknown.ok && unknown.error).toContain("unknown model id us.openai.gpt-6-sol in us-east-1");
  const region = await probe("ValidationException", "Invocation of model ID openai.gpt-6-sol with on-demand throughput isn't supported.");
  expect(!region.ok && region.error).toContain("model not available");
  expect(describeConverseError(Object.assign(new Error("key AKIAABCDEFGHIJKLMNOP"), { name: "X" }))).not.toContain("ABCDEFGHIJKLMNOP");
});
