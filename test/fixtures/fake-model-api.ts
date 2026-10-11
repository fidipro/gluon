/**
 * A model API on 127.0.0.1 for the real-harness tier (test/real/, issue #31): a real harness binary sends its model traffic here
 * (`GLUON_TEST_MODEL_URL`, src/launchers.ts) and gets a scripted reply, so the tier runs the newest harnesses offline and free.
 *
 * One server speaks what each harness's connection speaks:
 * - Anthropic Messages, JSON or SSE (`POST …/v1/messages`; Claude Code on an Anthropic key);
 * - OpenAI Responses, SSE (`POST …/responses`; Codex on an OpenAI key);
 * - OpenAI Chat Completions, JSON or SSE (`POST …/chat/completions`; OpenCode and Kimi Code on OpenRouter).
 * Anything else (a model listing, a token count) gets an empty, valid answer. Every request is recorded.
 *
 * The reply is `reply` (default "OK"): the real-harness check asks the agent to "Reply with just OK". Usage is small and fixed, so
 * Gluon's cost figure is a known, tiny amount.
 */

export interface ModelRequest {
  path: string;
  body: unknown;
}

export interface FakeModelApi {
  url: string;
  requests: ModelRequest[];
  /** What the next replies say. */
  reply: string;
  stop(): void;
}

export const FAKE_USAGE = { input: 120, output: 3 } as const;

const sse = (events: { event?: string; data: unknown }[]) =>
  events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");
const stream = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });

/** A request body as a harness may send it (zstd or gzip, as codex does). */
async function bodyOf(req: Request): Promise<unknown> {
  const raw = new Uint8Array(await req.arrayBuffer());
  if (!raw.length) return null;
  const enc = (req.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const bytes = enc === "zstd" ? Bun.zstdDecompressSync(raw) : enc === "gzip" ? Bun.gunzipSync(raw) : raw;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function anthropic(body: { model?: string; stream?: boolean }, text: string): Response {
  const usage = { input_tokens: FAKE_USAGE.input, output_tokens: FAKE_USAGE.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: "msg_fake", type: "message", role: "assistant", model: body.model ?? "claude", content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } };
  if (!body.stream) return Response.json({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn", usage });
  return stream(
    sse([
      { event: "message_start", data: { type: "message_start", message } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: FAKE_USAGE.output } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]),
  );
}

function responses(body: { model?: string }, text: string): Response {
  const item = { type: "message", id: "msg_fake", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const usage = { input_tokens: FAKE_USAGE.input, input_tokens_details: { cached_tokens: 0 }, output_tokens: FAKE_USAGE.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: FAKE_USAGE.input + FAKE_USAGE.output };
  const response = { id: "resp_fake", object: "response", model: body.model ?? "gpt", status: "in_progress", output: [] as unknown[] };
  return stream(
    sse([
      { event: "response.created", data: { type: "response.created", response } },
      { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } } },
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_fake", delta: text } },
      { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item } },
      { event: "response.completed", data: { type: "response.completed", response: { ...response, status: "completed", output: [item], usage } } },
    ]),
  );
}

function chat(body: { model?: string; stream?: boolean }, text: string): Response {
  const usage = { prompt_tokens: FAKE_USAGE.input, completion_tokens: FAKE_USAGE.output, total_tokens: FAKE_USAGE.input + FAKE_USAGE.output, cost: 0.0001 };
  const base = { id: "chatcmpl-fake", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model ?? "model" };
  if (!body.stream) return Response.json({ ...base, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
  const chunk = (delta: unknown, finish: string | null, extra: object = {}) => ({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  return stream(sse([{ data: chunk({ role: "assistant", content: "" }, null) }, { data: chunk({ content: text }, null) }, { data: chunk({}, "stop", { usage }) }, { data: "[DONE]" }]));
}

/**
 * Starts the server; `stop()` it when done. A reply takes `delayMs` (a real model's turn takes a while: without it the agent is
 * never seen working).
 */
export function fakeModelApi(reply = "OK", delayMs = 2500): FakeModelApi {
  const api: FakeModelApi = { url: "", requests: [], reply, stop: () => server.stop(true) };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "POST" ? await bodyOf(req) : null;
      api.requests.push({ path, body });
      const b = (body ?? {}) as { model?: string; stream?: boolean };
      if (req.method === "POST" && /\/(messages|responses|chat\/completions)$/.test(path)) await Bun.sleep(delayMs); // sleep-ok: a model's turn takes time
      if (req.method === "POST" && path.endsWith("/messages/count_tokens")) return Response.json({ input_tokens: FAKE_USAGE.input });
      if (req.method === "POST" && path.endsWith("/messages")) return anthropic(b, api.reply);
      if (req.method === "POST" && path.endsWith("/responses")) return responses(b, api.reply);
      if (req.method === "POST" && path.endsWith("/chat/completions")) return chat(b, api.reply);
      if (path.endsWith("/models")) return Response.json({ object: "list", data: [] });
      return Response.json({});
    },
  });
  api.url = `http://127.0.0.1:${server.port}`;
  return api;
}
