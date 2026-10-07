import type Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { FunctionTool, Response, ResponseInputItem, ResponseStreamEvent } from "openai/resources/responses/responses";
import { OPENAI_API_BASE, OPENROUTER_OPENAI_BASE } from "../harnesses.ts";
import { maskSecrets } from "../secrets.ts";
import type { ModelClient } from "./session.ts";

/**
 * The brain on an OpenAI-style API: OpenAI's Responses API (an OpenAI key), or Chat Completions
 * (OpenRouter). The Session speaks Anthropic-shaped messages; this converts both ways.
 */

const MAX_TOKENS = 8192;

/** The part of the `openai` SDK the brain uses; tests pass a fake. */
export interface OpenAILike {
  responses: { create(body: any, options?: { signal?: AbortSignal }): PromiseLike<any> };
  chat: { completions: { create(body: any, options?: { signal?: AbortSignal }): PromiseLike<any> } };
}

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  mode: "responses" | "chat";
  baseURL?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  /**
   * The intake agent's effort, in the API's own name (`sentEffort`): `reasoning.effort` on the
   * Responses API (OpenAI's `Reasoning`), OpenRouter's `reasoning.effort` on Chat Completions.
   * Null or unset: nothing sent (the model takes none). Never on the probes.
   */
  effort?: string | null;
  /**
   * OpenRouter only: a request of the brain ended (a reply, an error or a stop) at `end`, with the reply's exact `usage.cost` (undefined: not known, as
   * after an error or a stopped stream). The brain's spend on a key is not any session's (`src/cost/billed.ts` `BrainSpend`; QA-cost-04).
   */
  onSpend?: (call: { end: number; usd: number | undefined }) => void;
  /** Injected SDK client (tests). */
  client?: OpenAILike;
}

export type ProbeResult = { ok: true; usage?: { input: number; output: number } } | { ok: false; error: string };

type StopReason = "end_turn" | "tool_use" | "max_tokens";
type Result = { content: Anthropic.ContentBlock[]; stop_reason: StopReason };

/** The text of a tool_result, prefixed when it reports an error (not every model takes a status). Shared by the OpenAI and Converse conversions. */
export function resultText(b: Anthropic.ToolResultBlockParam): string {
  const text =
    typeof b.content === "string"
      ? b.content
      : (b.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return b.is_error ? `Error: ${text}` : text;
}

const textBlock = (text: string): Anthropic.TextBlock => ({ type: "text", text, citations: null });

function toolUse(id: string, name: string, args: string): Anthropic.ToolUseBlock {
  let input: unknown = {};
  try {
    input = args.trim() ? JSON.parse(args) : {};
  } catch {
    input = { _raw: args };
  }
  return { type: "tool_use", id, name, input, caller: { type: "direct" } } as Anthropic.ToolUseBlock;
}

/** Anthropic tools → Responses function tools. Not strict: our schemas leave properties optional. */
export function toResponsesTools(tools: Anthropic.Tool[]): FunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description ?? null,
    parameters: t.input_schema as Record<string, unknown>,
    strict: false,
  }));
}

/** Anthropic messages → Responses input items. Function calls carry only `call_id`, so no reasoning item is needed. */
export function toResponsesInput(messages: Anthropic.MessageParam[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.content) out.push({ role: m.role, content: m.content });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text) out.push({ role: m.role, content: b.text });
      } else if (b.type === "tool_use") {
        out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      } else if (b.type === "tool_result") {
        out.push({ type: "function_call_output", call_id: b.tool_use_id, output: resultText(b) });
      }
    }
  }
  return out;
}

/** A finished Response → Anthropic content and stop reason. */
export function fromResponsesOutput(res: Pick<Response, "output" | "status" | "incomplete_details">): Result {
  const content: Anthropic.ContentBlock[] = [];
  for (const item of res.output ?? []) {
    if (item.type === "message") {
      const text = item.content.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("");
      if (text) content.push(textBlock(text));
    } else if (item.type === "function_call") {
      content.push(toolUse(item.call_id, item.name, item.arguments));
    }
  }
  const stop_reason: StopReason = content.some((b) => b.type === "tool_use")
    ? "tool_use"
    : res.status === "incomplete" && res.incomplete_details?.reason === "max_output_tokens"
      ? "max_tokens"
      : "end_turn";
  return { content, stop_reason };
}

/** Anthropic tools → Chat Completions tools. */
export function toChatTools(tools: Anthropic.Tool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema as Record<string, unknown> },
  }));
}

/** System prompt and Anthropic messages → Chat Completions messages (tool results become `tool` messages). */
export function toChatMessages(system: string, messages: Anthropic.MessageParam[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = m.content.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }]
          : [],
      );
      // Chat Completions refuses an assistant message with neither text nor calls (BUG-613).
      if (text.trim() || calls.length) out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText(b) });
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

/** A Chat Completion (or one assembled from stream chunks) → Anthropic content and stop reason. */
export function fromChatCompletion(c: Pick<ChatCompletion, "choices">): Result {
  const choice = c.choices[0];
  const content: Anthropic.ContentBlock[] = [];
  if (choice?.message.content) content.push(textBlock(choice.message.content));
  for (const call of choice?.message.tool_calls ?? []) {
    if (call.type === "function") content.push(toolUse(call.id, call.function.name, call.function.arguments));
  }
  const stop_reason: StopReason = content.some((b) => b.type === "tool_use")
    ? "tool_use"
    : choice?.finish_reason === "length"
      ? "max_tokens"
      : "end_turn";
  return { content, stop_reason };
}

/** Folds Chat Completions stream chunks into one completion. */
export function assembleChatChunks(chunks: ChatCompletionChunk[]): Pick<ChatCompletion, "choices"> {
  let text = "";
  let finish: ChatCompletion.Choice["finish_reason"] | null = null;
  const calls: { id: string; name: string; arguments: string }[] = [];
  for (const chunk of chunks) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    text += choice.delta.content ?? "";
    for (const d of choice.delta.tool_calls ?? []) {
      const call = (calls[d.index] ??= { id: "", name: "", arguments: "" });
      if (d.id) call.id = d.id;
      if (d.function?.name) call.name += d.function.name;
      if (d.function?.arguments) call.arguments += d.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const tool_calls = calls
    .filter(Boolean)
    .map((c, i) => ({ id: c.id || `call_${i}`, type: "function" as const, function: { name: c.name, arguments: c.arguments } }));
  return {
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: finish ?? "stop",
        message: { role: "assistant", content: text || null, refusal: null, ...(tool_calls.length ? { tool_calls } : {}) },
      },
    ],
  };
}

/** OpenRouter's usage accounting (documented): the reply carries `usage.cost`, the credits it charged. Asked on OpenRouter alone: OpenAI's own endpoint refuses unknown fields. */
const usageAccounting = (opts: OpenAIOptions) => (opts.baseURL === OPENROUTER_OPENAI_BASE ? { usage: { include: true } } : {});

/**
 * Whether the SDK sent more than one HTTP attempt since `before`. The SDK retries 429, 5xx and timeouts by itself and gives no sign of it; an attempt that
 * failed may still have been charged, and only the last one's cost is in the answer. A reply that took retries has no known cost (QA-cost-04). Calls that
 * overlap on one client count each other's attempts: more "retried", never fewer.
 */
const retried = (tries: { n: number }, before: number): boolean => tries.n - before > 1;

/** The cost a reply's `usage` states, if it is a plain non-negative number. */
const costOf = (usage: unknown): number | undefined => {
  const c = (usage as { cost?: unknown } | null | undefined)?.cost;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : undefined;
};

/** The SDK is imported with the first call, not with this module (start-up time). */
async function makeClient(opts: OpenAIOptions, tries?: { n: number }): Promise<OpenAILike> {
  if (opts.client) return opts.client;
  const { default: OpenAI } = await import("openai");
  // Always an explicit base: the SDK would take OPENAI_BASE_URL from the environment, key and conversation with it (BUG-590).
  // On another endpoint (OpenRouter) what the environment holds for OpenAI stays home: the organization and project ids, and every
  // header of OPENAI_CUSTOM_HEADERS (nulled by name; Gluon's own headers go last). On OpenAI itself they are the user's own choice.
  const elsewhere = opts.baseURL !== undefined;
  const headers = { ...(elsewhere ? Object.fromEntries(customHeaderNames(process.env.OPENAI_CUSTOM_HEADERS).map((n) => [n, null])) : {}), ...opts.headers };
  return new OpenAI({
    apiKey: opts.apiKey,
    timeout: 60_000,
    maxRetries: 2,
    // Every HTTP attempt is counted: the SDK retries a failed one on its own, and OpenRouter may have charged it (see `retried`).
    ...(tries ? { fetch: ((input: any, init: any) => (tries.n++, globalThis.fetch(input, init))) as typeof fetch } : {}),
    baseURL: opts.baseURL ?? OPENAI_API_BASE,
    ...(elsewhere ? { organization: null, project: null } : {}),
    ...(Object.keys(headers).length ? { defaultHeaders: headers } : {}),
  });
}

/** The header names in `Name: value` lines, as the SDKs read `*_CUSTOM_HEADERS`. */
export function customHeaderNames(text: string | undefined): string[] {
  return (text ?? "").split("\n").flatMap((line) => (line.includes(":") ? [line.slice(0, line.indexOf(":")).trim()] : [])).filter(Boolean);
}

/** A brain client on the Responses API ("responses") or Chat Completions ("chat"). */
export function openaiClient(opts: OpenAIOptions): ModelClient {
  let made: Promise<OpenAILike> | undefined;
  const tries = { n: 0 };
  const client = () => (made ??= makeClient(opts, opts.onSpend ? tries : undefined));
  const max = opts.maxTokens ?? MAX_TOKENS;
  const reasoning = opts.effort ? { reasoning: { effort: opts.effort } } : {};
  if (opts.mode === "responses") {
    return async ({ system, messages, tools, signal }, onText) => {
      const stream: AsyncIterable<ResponseStreamEvent> = await (await client()).responses.create(
        { model: opts.model, instructions: system, input: toResponsesInput(messages), tools: toResponsesTools(tools), max_output_tokens: max, store: false, stream: true, ...reasoning },
        { signal },
      );
      for await (const ev of stream) {
        signal.throwIfAborted();
        if (ev.type === "response.output_text.delta") onText(ev.delta);
        else if (ev.type === "response.completed" || ev.type === "response.incomplete") return fromResponsesOutput(ev.response);
        else if (ev.type === "response.failed") throw new Error(ev.response.error?.message ?? "the model call failed");
        else if (ev.type === "error") throw new Error(ev.message);
      }
      signal.throwIfAborted();
      throw new Error("the response stream ended early");
    };
  }
  return async ({ system, messages, tools, signal }, onText) => {
    // The reply's cost comes in its last chunk; any way out of the request tells what is known of it.
    let usd: number | undefined;
    const before = tries.n;
    try {
      const stream: AsyncIterable<ChatCompletionChunk> = await (await client()).chat.completions.create(
        { model: opts.model, messages: toChatMessages(system, messages), tools: toChatTools(tools), max_tokens: max, stream: true, ...reasoning, ...usageAccounting(opts) },
        { signal },
      );
      const chunks: ChatCompletionChunk[] = [];
      for await (const chunk of stream) {
        signal.throwIfAborted();
        usd = costOf(chunk.usage) ?? usd;
        const delta = chunk.choices[0]?.delta.content;
        if (delta) onText(delta);
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      return fromChatCompletion(assembleChatChunks(chunks));
    } finally {
      try {
        opts.onSpend?.({ end: Date.now(), usd: retried(tries, before) ? undefined : usd });
      } catch {}
    }
  };
}

/** Masks the key itself and anything key-like (OpenAI/OpenRouter `sk-…` keys included). */
function mask(text: string, key?: string): string {
  const out = key ? text.split(key).join("sk-••••") : text;
  return maskSecrets(out).replace(/\bsk-(?!ant-|••••)[A-Za-z0-9_-]{12,}/g, (m) => `${m.slice(0, 7)}••••`);
}

/** A short, readable reason for an OpenAI/OpenRouter error. */
export function describeOpenAIError(e: unknown, key?: string): string {
  const err = e as { status?: number; message?: string; code?: string | null; name?: string };
  const message = (err?.message ?? String(e)).split("\n")[0] ?? "";
  const status = err?.status;
  let reason: string;
  if (err?.name === "AbortError" || /aborted/i.test(message)) reason = "the call was aborted";
  else if (status === 401) reason = "the API key was rejected (401)";
  else if (status === 402 || err?.code === "insufficient_quota" || /quota|credits|billing/i.test(message)) reason = `no credit or quota left on this key${status ? ` (${status})` : ""}`;
  else if (status === 404 || /model.*(not found|does not exist|not a valid)|no endpoints found/i.test(message)) reason = `model not found or not available to this key${status ? ` (${status})` : ""}`;
  else if (status === 403) reason = "this key has no access to the model (403)";
  else if (status === 429) reason = "rate limited (429); try again shortly";
  else if (status && status >= 500) reason = `the provider had a server error (${status})`;
  else if (/connection|fetch failed|ENOTFOUND|ECONNREFUSED|timed? ?out/i.test(message)) reason = "could not reach the API (network)";
  else reason = message || "unknown error";
  const detail = message && !reason.includes(message) && status ? `: ${message}` : "";
  return mask(`${reason}${detail}`, key).slice(0, 300);
}

function spent(opts: OpenAIOptions, usd: number | undefined): void {
  try {
    opts.onSpend?.({ end: Date.now(), usd });
  } catch {}
}

/** One tiny call (≤16 output tokens) to check the model answers with this key. */
export async function probeOpenAI(opts: OpenAIOptions & { signal?: AbortSignal }): Promise<ProbeResult> {
  try {
    const tries = { n: 0 };
    const client = await makeClient(opts, opts.onSpend ? tries : undefined);
    const signal = opts.signal ?? AbortSignal.timeout(30_000);
    if (opts.mode === "responses") {
      const res = await client.responses.create({ model: opts.model, input: "Reply with: ok", max_output_tokens: 16, store: false }, { signal });
      if (res?.status === "failed") return { ok: false, error: mask(res.error?.message ?? "the model call failed", opts.apiKey) };
      return { ok: true, ...(res?.usage ? { usage: { input: res.usage.input_tokens ?? 0, output: res.usage.output_tokens ?? 0 } } : {}) };
    }
    let res: any;
    try {
      res = await client.chat.completions.create({ model: opts.model, messages: [{ role: "user", content: "Reply with: ok" }], max_tokens: 16, ...usageAccounting(opts) }, { signal });
    } catch (e) {
      spent(opts, undefined);
      throw e;
    }
    spent(opts, tries.n > 1 ? undefined : costOf(res?.usage));
    return { ok: true, ...(res?.usage ? { usage: { input: res.usage.prompt_tokens ?? 0, output: res.usage.completion_tokens ?? 0 } } : {}) };
  } catch (e) {
    return { ok: false, error: describeOpenAIError(e, opts.apiKey) };
  }
}
