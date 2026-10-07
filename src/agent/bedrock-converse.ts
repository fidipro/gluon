import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ConverseCommand, ConverseStreamCommand, ConverseStreamOutput, Message, Tool } from "@aws-sdk/client-bedrock-runtime";
import { maskSecrets } from "../secrets.ts";
import { resultText, type ProbeResult } from "./openai.ts";
import type { ModelClient } from "./session.ts";

/**
 * The brain on Bedrock's Converse API, for models the Anthropic Bedrock SDK doesn't serve
 * (OpenAI's on Bedrock, e.g. us.openai.gpt-6-sol). Converts Anthropic-shaped messages both ways.
 */

const MAX_TOKENS = 8192;

/** The part of BedrockRuntimeClient the brain uses; tests pass a fake. */
export interface ConverseLike {
  send(command: ConverseStreamCommand | ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<any>;
}

export interface ConverseOptions {
  model: string;
  region?: string;
  profile?: string;
  maxTokens?: number;
  /** The intake agent's effort (`sentEffort`): Converse's `outputConfig.effort`. Null or unset: nothing sent. */
  effort?: string | null;
  /** Injected SDK client (tests). */
  client?: ConverseLike;
}

type StopReason = "end_turn" | "tool_use" | "max_tokens";
type Result = { content: Anthropic.ContentBlock[]; stop_reason: StopReason };

/**
 * AWS credentials for every Bedrock call Gluon makes itself (the brain, the probes): the
 * environment's keys, else the given profile (or the default chain). The profile goes to the SDK,
 * never into process.env, so launched agents keep their own AWS setup.
 */
type AwsCredentialIdentityProvider = ReturnType<typeof import("@aws-sdk/credential-providers").fromEnv>;

export function awsCredentialChain(profile?: string): AwsCredentialIdentityProvider {
  // The AWS SDK is imported when credentials are first asked for, not with this module (start-up time).
  let chain: Promise<AwsCredentialIdentityProvider> | undefined; // built once: the chain caches the credentials it resolves
  return async (identity) =>
    (await (chain ??= import("@aws-sdk/credential-providers").then(
      ({ createCredentialChain, fromEnv, fromNodeProviderChain }) => createCredentialChain(fromEnv(), fromNodeProviderChain(profile ? { profile } : {})) as AwsCredentialIdentityProvider,
    )))(identity);
}

/** The SDK's own commands and client, imported with the first call. */
const bedrockSdk = () => import("@aws-sdk/client-bedrock-runtime");

/**
 * The SDK's client for the region's own endpoint: `ignoreConfiguredEndpointUrls` stops AWS_ENDPOINT_URL,
 * AWS_ENDPOINT_URL_BEDROCK_RUNTIME and the profile's `endpoint_url` from sending the conversation elsewhere
 * (QA-sec-17). `extra`: more client options (tests: a request handler).
 */
export async function bedrockRuntimeClient(opts: ConverseOptions, extra: Record<string, unknown> = {}) {
  const { BedrockRuntimeClient } = await bedrockSdk();
  const region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  return new BedrockRuntimeClient({ ...(region ? { region } : {}), credentials: awsCredentialChain(opts.profile), maxAttempts: 3, ignoreConfiguredEndpointUrls: true, ...extra });
}

async function makeClient(opts: ConverseOptions): Promise<ConverseLike> {
  return opts.client ?? (await bedrockRuntimeClient(opts));
}

/** Anthropic tools → Converse tool specs. */
export function toConverseTools(tools: Anthropic.Tool[]): Tool[] {
  return tools.map((t) => ({
    toolSpec: { name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: { json: t.input_schema as any } },
  }));
}

/**
 * Anthropic messages → Converse messages. Converse rejects blank text blocks and two turns in a
 * row from the same role, so blanks are dropped and same-role turns merged.
 */
export function toConverseMessages(messages: Anthropic.MessageParam[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    const content: ContentBlock[] = [];
    for (const b of blocks) {
      if (b.type === "text") {
        if (b.text.trim()) content.push({ text: b.text });
      } else if (b.type === "tool_use") {
        content.push({ toolUse: { toolUseId: b.id, name: b.name, input: (b.input ?? {}) as any } });
      } else if (b.type === "tool_result") {
        content.push({ toolResult: { toolUseId: b.tool_use_id, content: [{ text: resultText(b) || "(empty)" }] } });
      }
    }
    if (!content.length) continue;
    const last = out.at(-1);
    if (last?.role === m.role) last.content!.push(...content);
    else out.push({ role: m.role, content });
  }
  return out;
}

/** A Converse message and stop reason → Anthropic content and stop reason. */
export function fromConverseOutput(message: Message | undefined, stopReason: string | undefined): Result {
  const content: Anthropic.ContentBlock[] = [];
  for (const b of message?.content ?? []) {
    if (b.text) content.push({ type: "text", text: b.text, citations: null });
    else if (b.toolUse) {
      content.push({
        type: "tool_use",
        id: b.toolUse.toolUseId!,
        name: b.toolUse.name!,
        input: b.toolUse.input ?? {},
        caller: { type: "direct" },
      } as Anthropic.ToolUseBlock);
    }
  }
  const stop_reason: StopReason = content.some((b) => b.type === "tool_use")
    ? "tool_use"
    : stopReason === "max_tokens" || stopReason === "model_context_window_exceeded"
      ? "max_tokens"
      : "end_turn";
  return { content, stop_reason };
}

type Streamed = { message: Message; stopReason?: string; usage?: { input: number; output: number } };

/** Folds ConverseStream events into one message, streaming text through onText. */
export async function readConverseStream(
  events: AsyncIterable<ConverseStreamOutput>,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<Streamed> {
  const blocks: ({ text: string } | { toolUse: { toolUseId: string; name: string; json: string } })[] = [];
  let stopReason: string | undefined;
  let usage: Streamed["usage"];
  for await (const ev of events) {
    signal?.throwIfAborted();
    if (ev.contentBlockStart) {
      const tu = ev.contentBlockStart.start?.toolUse;
      if (tu) blocks[ev.contentBlockStart.contentBlockIndex ?? blocks.length] = { toolUse: { toolUseId: tu.toolUseId ?? "", name: tu.name ?? "", json: "" } };
    } else if (ev.contentBlockDelta) {
      const i = ev.contentBlockDelta.contentBlockIndex ?? 0;
      const d = ev.contentBlockDelta.delta;
      if (d?.text !== undefined) {
        const b = (blocks[i] ??= { text: "" });
        if ("text" in b) b.text += d.text;
        onText(d.text);
      } else if (d?.toolUse) {
        const b = blocks[i];
        if (b && "toolUse" in b) b.toolUse.json += d.toolUse.input ?? "";
      }
    } else if (ev.messageStop) {
      stopReason = ev.messageStop.stopReason;
    } else if (ev.metadata?.usage) {
      usage = { input: ev.metadata.usage.inputTokens ?? 0, output: ev.metadata.usage.outputTokens ?? 0 };
    } else {
      const err =
        ev.internalServerException ?? ev.modelStreamErrorException ?? ev.validationException ?? ev.throttlingException ?? ev.serviceUnavailableException;
      if (err) throw Object.assign(new Error(err.message ?? "the model stream failed"), { name: err.name });
    }
  }
  signal?.throwIfAborted();
  const content: ContentBlock[] = blocks.filter(Boolean).map((b) => {
    if ("text" in b) return { text: b.text };
    let input: unknown = {};
    try {
      input = b.toolUse.json.trim() ? JSON.parse(b.toolUse.json) : {};
    } catch {
      input = { _raw: b.toolUse.json };
    }
    return { toolUse: { toolUseId: b.toolUse.toolUseId, name: b.toolUse.name, input: input as any } };
  });
  return { message: { role: "assistant", content }, stopReason, usage };
}

/** A brain client on Bedrock's ConverseStream with tools. */
export function converseClient(opts: ConverseOptions): ModelClient {
  let made: Promise<ConverseLike> | undefined;
  return async ({ system, messages, tools, signal }, onText) => {
    const client = await (made ??= makeClient(opts));
    const { ConverseStreamCommand } = await bedrockSdk();
    const res = await client.send(
      new ConverseStreamCommand({
        modelId: opts.model,
        ...(system ? { system: [{ text: system }] } : {}),
        messages: toConverseMessages(messages),
        ...(tools.length ? { toolConfig: { tools: toConverseTools(tools) } } : {}),
        inferenceConfig: { maxTokens: opts.maxTokens ?? MAX_TOKENS },
        ...(opts.effort ? { outputConfig: { effort: opts.effort } } : {}),
      }),
      { abortSignal: signal },
    );
    if (!res?.stream) throw new Error("Bedrock returned no stream");
    const { message, stopReason } = await readConverseStream(res.stream, onText, signal);
    return fromConverseOutput(message, stopReason);
  };
}

/** The first sentence of an AWS message ("… is not available for this account."), not the sales pitch after it. */
const firstSentence = (text: string) => text.split(/(?<=\.)\s+(?=[A-Z])/)[0]!.trim();

/** Cut at a word boundary (never inside a URL), with "…". */
export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`);

/** A short, readable reason for a Bedrock error. */
export function describeConverseError(e: unknown, opts?: { model?: string; region?: string }): string {
  const err = e as { name?: string; message?: string };
  const name = err?.name ?? "";
  const message = firstSentence((err?.message ?? String(e)).split("\n")[0] ?? "");
  const where = opts?.region ? ` in ${opts.region}` : "";
  let reason: string;
  if (name === "AbortError" || /aborted/i.test(message)) reason = "the call was aborted";
  else if (/CredentialsProviderError|ExpiredToken|UnrecognizedClient|InvalidSignature/i.test(name) || /credential|expired|security token/i.test(message))
    reason = `AWS credentials missing or expired: ${message}`;
  else if (name === "AccessDeniedException") reason = `access denied to ${opts?.model ?? "the model"}${where}: ${message.replace(/\.$/, "")} (enable model access in the Bedrock console)`;
  else if (name === "ResourceNotFoundException" || /not available|not supported in|isn't supported|not found/i.test(message))
    reason = `model not available${where}: ${message}`;
  else if (name === "ValidationException" && /model identifier|model id|invalid model/i.test(message)) reason = `unknown model id ${opts?.model ?? ""}${where}`.trim();
  else if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") reason = `rate limited: ${message}`;
  else if (name === "ModelNotReadyException" || name === "ServiceUnavailableException") reason = `model not ready; try again shortly`;
  else reason = name && !message.includes(name) ? `${name}: ${message}` : message || "unknown error";
  return clip(maskSecrets(reason), 300);
}

/** One tiny Converse call (≤16 output tokens) to check the model answers with these credentials. */
export async function probeConverse(opts: ConverseOptions & { signal?: AbortSignal }): Promise<ProbeResult> {
  try {
    const client = await makeClient(opts);
    const { ConverseCommand } = await bedrockSdk();
    const res = await client.send(
      new ConverseCommand({
        modelId: opts.model,
        messages: [{ role: "user", content: [{ text: "Reply with: ok" }] }],
        inferenceConfig: { maxTokens: 16 },
      }),
      { abortSignal: opts.signal ?? AbortSignal.timeout(30_000) },
    );
    const u = res?.usage;
    return { ok: true, ...(u ? { usage: { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 } } : {}) };
  } catch (e) {
    return { ok: false, error: describeConverseError(e, opts) };
  }
}
