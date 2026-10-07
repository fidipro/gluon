/**
 * Cost and context figures from a launched agent's own OpenTelemetry export (Gluon; display only).
 * Gluon listens on loopback (127.0.0.1, a free port) for OTLP/HTTP JSON; each launch gets its
 * own random token, sent by the agent as a header, which routes what it sends to that launch's
 * callbacks. Nothing received is stored, logged or forwarded: only the figures below are kept.
 *
 * What each harness sends (checked offline, in the binaries and sources; no model run):
 * - Claude Code (captured from a real 2.1.289, `test/fixtures/telemetry/claude-code-2.1.289.jsonl`): the
 *   metric `claude_code.cost.usage` (a sum, USD, per model; DELTA temporality: each export adds the
 *   cost since the last) and, per API request, the log event `api_request` (body
 *   `claude_code.api_request`, attribute `event.name`) with `model` (WITHOUT a `[1m]` suffix),
 *   `input_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd` and `query_source`
 *   (the main thread's start with `repl_main_thread`, or are `sdk`; subagents' are `agent:…`; a
 *   `/compact`'s is `compact`; side requests have their own: `generate_session_title`, …), and the log
 *   event `compaction` (`trigger`, `success`, `pre_tokens`, `post_tokens`). `cost_usd` is Claude
 *   Code's own list-price estimate. Enabled by `CLAUDE_CODE_ENABLE_TELEMETRY` and the standard
 *   `OTEL_*` variables (`telemetryLaunch`).
 * - Codex (captured from a real 0.159.3, `test/fixtures/telemetry/codex-0.159.3.jsonl`): with
 *   `-c otel.exporter={otlp-http=…}`, the log event `codex.sse_event` / `event.kind`
 *   `response.completed` with `input_token_count` (cached input included), `output_token_count`
 *   and `model`, each tagged with its `conversation.id`: the TUI also runs a side conversation per
 *   prompt (its title), whose small prompts must not replace the session's (the first
 *   `codex.conversation_starts` is the session's own). Its record time is 0: `observedTimeUnixNano`
 *   orders them. It reports no cost per request; its `codex.turn_cost` event (a whole turn's tokens
 *   and the server's estimate of its cost, minutes late and not always) is only an oracle: it goes to
 *   `onTurnCost`, to be compared with the sum Gluon priced (`CostTracker.codexTurnCost`). It exists on a
 *   ChatGPT login only: a real run on an OpenAI API key (0.159.3) sent none in 5 minutes, and the binary
 *   suggests the server's estimate is the login's, so an API-key launch has no per-turn audit (and no
 *   pending or dropped turn noise: nothing waits for an event that does not come). The attribute names
 *   are read tolerantly, from the 0.159.3 binary's strings: no capture of one exists yet, not even live.
 *   Its response usage, confirmed live on that run: `input_token_count` includes `cached_token_count` and
 *   `cache_write_token_count`, `output_token_count` includes `reasoning_token_count`, `service_tier` is the one requested.
 * Cost is the metric's total when it came, else the sum of the requests' `cost_usd`. Context is the
 * last main-thread request's prompt: input + cache read + cache creation tokens (what Claude Code's
 * own status line counts: output tokens are not in it); for Codex the last response's input + output
 * (its `total_tokens`, what its footer counts). A Claude Code compaction empties it: that shows no
 * figure until the next main-thread request, and so does Gluon (`onContext(null)`); Codex's
 * telemetry says nothing of a compaction, so its figure stays until the next response.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Harness } from "./harnesses.ts";
import { decodeLogs } from "./otlp-protobuf.ts";

/** The header a launch's token travels in (no spaces: OTLP header variables are `key=value` lists). */
export const TELEMETRY_HEADER = "x-gluon-telemetry";
/** The largest body taken, compressed or not (a batch of a few hundred events). */
export const MAX_TELEMETRY_BYTES = 2 * 1024 * 1024;

export interface ContextFigure {
  /** The last request's prompt, in tokens. */
  tokens: number;
  /** The model it went to, as the harness names it. */
  model?: string;
  /** Codex: the `model_context_window` the user's config sets (exported as the conversation's `context_window`). */
  windowOverride?: number;
}

/** One request's usage as a harness exported it (every conversation, subagent and side request: cost counts them all). */
export type UsageEvent =
  /** Claude Code (`model` absent: the request named none, so the launched model's price stands in; `subagent`: its `query_source` is outside the main conversation's, which is what picks the cache TTL). */
  | { harness: "claude-code"; model?: string; input: number; output: number; cacheRead: number; cacheWrite: number; fast: boolean; subagent: boolean; reportedUsd?: number }
  | { harness: "codex"; model: string; input: number; cached: number; cacheWrite: number; output: number; serviceTier?: string }
  /** Grok Build (`input` includes `cacheRead`; `output` includes `reasoning`); `reportedMicros`: the server's cost of it, floored to micro-USD, when it stamped one. */
  | { harness: "grok-build"; model: string; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; reportedMicros?: number; subagent: boolean; session?: string };

/** One Codex turn as `codex.turn_cost` reports it: its tokens and the server's estimate of its cost (an oracle, never shown). */
export interface TurnCostEvent {
  model?: string;
  /** As the response events count them: `input` includes `cached`, `output` includes the reasoning. */
  input: number;
  cached: number;
  output: number;
  reasoning?: number;
  reportedUsd: number;
  /** The tier it says it priced (`standard`, `fast`, …). */
  speed?: string;
}

export interface TelemetryCallbacks {
  /** The session's cost so far (USD), each time it changes. */
  onCost?: (usd: number) => void;
  /** The last request's context, each time a newer one comes; null once the context was compacted (unknown until the next request). */
  onContext?: (context: ContextFigure | null) => void;
  /** Each request's usage once (a re-sent record is dropped): what Gluon's own cost is computed from (`src/cost/`). */
  onUsage?: (usage: UsageEvent) => void;
  /** Codex: a turn's reported cost, once (a re-sent record is dropped): audit only. */
  onTurnCost?: (turn: TurnCostEvent) => void;
}

/** One launch's channel: its token, and where its agent sends. */
export interface TelemetrySession {
  readonly token: string;
  /** `http://127.0.0.1:<port>` (the OTLP base: `/v1/metrics`, `/v1/logs` are added by the exporter). */
  readonly endpoint: string;
  /** Stops taking this launch's data (its token is refused from then on). */
  close(): void;
  /** Codex: a compaction starts (its PreCompact hook ran): the next response of the session's conversation is its own request, no context. */
  expectCompaction(): void;
  /**
   * The id of the session's main conversation, once the harness's hook has named it (Codex: `conversation.id`):
   * the context follows that conversation only. Until it is set, the first one seen is the main one; once it
   * is, that stays so until a response of the named one arrives (a hook id no conversation carries changes nothing).
   */
  setMainConversation(id: string): void;
  /** Grok Build: the turn is over (its Stop hook), so no subagent is running whatever its records said (a lost or never-sent `completed`: BUG-401). */
  turnEnded(): void;
}

export interface TelemetryServer {
  readonly port: number;
  readonly endpoint: string;
  /** A new launch: a fresh token, routed to these callbacks. */
  session(callbacks: TelemetryCallbacks): TelemetrySession;
  stop(): void;
}

type Value = string | number | boolean;
type Json = Record<string, unknown>;

interface SessionState {
  token: Buffer;
  callbacks: TelemetryCallbacks;
  /** Cumulative metric points by series (attributes + start time): their latest values. */
  cumulative: Map<string, number>;
  /** Delta metric points, added up. */
  delta: number;
  metricSeen: boolean;
  /** Sum of the requests' `cost_usd` (used until the metric comes). */
  logCost: number;
  lastCost?: number;
  /** Time (ns, as a string's number) of the context last reported. */
  contextTime: number;
  /** Codex: the session's own conversation (the first seen); its side conversations' requests are no context of it. */
  conversation?: string;
  /** Keys of the usage records taken (an exporter may re-send a batch): bounded. */
  seenUsage: Set<string>;
  /** Codex: the session's own conversation's `context_window` override, when its config sets one. */
  windowOverride?: number;
  /** Codex: the conversation the hook named main, until a response of its own arrives (the one followed so far stays the main one meanwhile). */
  pendingConversation?: string;
  /** Codex: every conversation's `context_window` override as its start announced it (bounded): the one a hook later names as main applies. */
  startOverrides: Map<string, number>;
  /** Codex: the next main-conversation response is a compaction's own request. */
  compacting?: boolean;
  /** Grok Build: subagents launched and not yet completed (their requests carry no marker of their own). */
  subagents: number;
  /** When a subagent record last moved the count: a count nothing has moved for `SUBAGENT_STALE_MS` is a lost record (BUG-401). */
  subagentsAt: number;
  now: () => number;
}

/** A subagent count this long unmoved, with requests still arriving, is a lost `completed` record: the context follows the main thread again. */
export const SUBAGENT_STALE_MS = 30 * 60_000;

const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** An OTLP AnyValue as a plain value (int64 travels as a string in OTLP JSON). */
function anyValue(v: unknown): Value | undefined {
  const o = obj(v);
  if (!o) return undefined;
  if (typeof o.stringValue === "string") return o.stringValue;
  if (typeof o.boolValue === "boolean") return o.boolValue;
  for (const k of ["intValue", "doubleValue"]) {
    const n = typeof o[k] === "string" ? Number(o[k]) : o[k];
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return undefined;
}

/** An OTLP attribute list as a map. */
function attributes(v: unknown): Map<string, Value> {
  const out = new Map<string, Value>();
  for (const a of list(v)) {
    const o = obj(a);
    if (!o || typeof o.key !== "string") continue;
    const value = anyValue(o.value);
    if (value !== undefined) out.set(o.key, value);
  }
  return out;
}

/** A number from a value (numbers sent as text included); undefined otherwise, or when negative. */
function count(v: Value | undefined): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

const nanos = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

/** Delta, as OTLP JSON writes it (the enum's number or its name). */
const isDelta = (t: unknown) => t === 1 || t === "AGGREGATION_TEMPORALITY_DELTA";

function cost(s: SessionState): number {
  if (!s.metricSeen) return s.logCost;
  let total = s.delta;
  for (const v of s.cumulative.values()) total += v;
  return total;
}

function reportCost(s: SessionState) {
  const usd = cost(s);
  if (usd === s.lastCost) return;
  s.lastCost = usd;
  try {
    s.callbacks.onCost?.(usd);
  } catch {}
}

/** Takes a metrics export: Claude Code's `claude_code.cost.usage`. */
function takeMetrics(s: SessionState, body: Json): void {
  let changed = false;
  for (const rm of list(body.resourceMetrics)) {
    for (const sm of list(obj(rm)?.scopeMetrics)) {
      for (const m of list(obj(sm)?.metrics)) {
        const metric = obj(m);
        if (metric?.name !== "claude_code.cost.usage") continue;
        const sum = obj(metric.sum);
        if (!sum) continue;
        const delta = isDelta(sum.aggregationTemporality);
        for (const p of list(sum.dataPoints)) {
          const point = obj(p);
          if (!point) continue;
          const value = count(anyValue({ doubleValue: point.asDouble }) ?? anyValue({ intValue: point.asInt }));
          if (value === undefined) continue;
          s.metricSeen = true;
          changed = true;
          if (delta) s.delta += value;
          else {
            const series = JSON.stringify([...attributes(point.attributes)].sort(([a], [b]) => (a < b ? -1 : 1))) + String(point.startTimeUnixNano ?? "");
            s.cumulative.set(series, value);
          }
        }
      }
    }
  }
  if (changed) reportCost(s);
}

/** How many usage keys a session remembers to drop a re-sent batch (`takeLogs`); past it the oldest half goes. */
const MAX_SEEN_USAGE = 20_000;

/**
 * Claude Code's request sources that run on the main conversation's cache TTL (its `G1t`, 2.1.289): the main thread
 * (`repl_main_thread*`, `sdk`) and the helpers inline with it. Every other source (subagents `agent:*`, compaction,
 * titles, background work) takes the subagent TTL.
 */
const mainTtlSource = (source: Value | undefined) => typeof source === "string" && (source.startsWith("repl_main_thread") || source === "sdk" || source === "auto_mode" || source === "memdir_relevance");

/** Claude Code's main thread (not a subagent's or a side request's): its context is the session's. */
const mainThread = (source: Value | undefined) => source === undefined || source === "sdk" || (typeof source === "string" && source.startsWith("repl_main_thread"));

/** Takes a logs export: Claude Code's `api_request` and `compaction`, Codex's `response.completed`. */
function takeLogs(s: SessionState, body: Json): void {
  let costChanged = false;
  const usages: UsageEvent[] = [];
  const turnCosts: TurnCostEvent[] = [];
  const once = (key: string) => {
    if (s.seenUsage.has(key)) return false;
    // Full: the oldest half goes (a Set keeps insertion order), never all of it, so a batch re-sent after a long session still counts once.
    if (s.seenUsage.size >= MAX_SEEN_USAGE) {
      let drop = MAX_SEEN_USAGE / 2;
      for (const k of s.seenUsage) {
        if (drop-- <= 0) break;
        s.seenUsage.delete(k);
      }
    }
    s.seenUsage.add(key);
    return true;
  };
  let context: ((ContextFigure & { time: number }) | { tokens: null; time: number }) | undefined;
  for (const rl of list(body.resourceLogs)) {
    for (const sl of list(obj(rl)?.scopeLogs)) {
      for (const r of list(obj(sl)?.logRecords)) {
        const record = obj(r);
        if (!record) continue;
        const a = attributes(record.attributes);
        const event = a.get("event.name") ?? anyValue(record.body);
        const time = nanos(record.timeUnixNano) || nanos(record.observedTimeUnixNano);
        const model = typeof a.get("model") === "string" ? (a.get("model") as string) : typeof a.get("slug") === "string" ? (a.get("slug") as string) : undefined;
        let tokens: number | undefined;
        if (event === "api_request" || event === "claude_code.api_request") {
          const input = count(a.get("input_tokens"));
          const requestId = typeof a.get("request_id") === "string" ? (a.get("request_id") as string) : `${time}:${input}:${count(a.get("output_tokens"))}`;
          // A re-sent batch (an exporter retry) counts once: in the cost and in the usage.
          const fresh = once(`c:${requestId}`);
          const usd = count(a.get("cost_usd"));
          if (usd !== undefined && fresh) {
            s.logCost += usd;
            costChanged = true;
          }
          if (input !== undefined && fresh) usages.push({ harness: "claude-code", ...(model ? { model } : {}), subagent: typeof a.get("query_source") === "string" && !mainTtlSource(a.get("query_source")), input, output: count(a.get("output_tokens")) ?? 0, cacheRead: count(a.get("cache_read_tokens")) ?? 0, cacheWrite: count(a.get("cache_creation_tokens")) ?? 0, fast: a.get("speed") === "fast", ...(usd !== undefined ? { reportedUsd: usd } : {}) });
          const source = a.get("query_source");
          // A compaction rewrites the conversation: the prompt figure before it is stale. Its own
          // request is no main-thread one (`compaction` below says how it ended).
          if (typeof source === "string" && source.startsWith("compact")) {
            if (!context || time >= context.time) context = { tokens: null, time };
            continue;
          }
          if (!mainThread(source)) continue;
          const parts = ["input_tokens", "cache_read_tokens", "cache_creation_tokens"].map((k) => count(a.get(k)));
          if (parts[0] !== undefined) tokens = parts.reduce<number>((n, p) => n + (p ?? 0), 0);
        } else if (event === "compaction") {
          // `trigger` manual|auto, `success`, `pre_tokens`, `post_tokens`: the conversation is new; its size, unknown until the next request.
          if (String(a.get("success")) !== "false" && (!context || time >= context.time)) context = { tokens: null, time };
          continue;
        } else if (event === "grok_code.api_request") {
          const input = count(a.get("input_tokens"));
          const output = count(a.get("output_tokens")) ?? 0;
          if (input !== undefined && model && once(`g:${time}:${input}:${output}:${count(a.get("duration_ms")) ?? 0}`)) {
            const micros = count(a.get("cost_usd_micros"));
            if (s.subagents > 0 && s.now() - s.subagentsAt > SUBAGENT_STALE_MS) s.subagents = 0;
            usages.push({ harness: "grok-build", model, input, output, reasoning: count(a.get("reasoning_tokens")) ?? 0, cacheRead: count(a.get("cache_read_tokens")) ?? 0, cacheWrite: count(a.get("cache_creation_tokens")) ?? 0, ...(micros !== undefined ? { reportedMicros: micros } : {}), subagent: s.subagents > 0, ...(typeof a.get("session.id") === "string" ? { session: a.get("session.id") as string } : {}) });
            // The session's context is its main requests' prompt and answer (its own footer: input + output); a subagent's request has no marker, so none while one runs.
            if (s.subagents <= 0) tokens = input + output;
          }
        } else if (event === "grok_code.subagent") {
          const phase = a.get("phase");
          if (phase === "launched") s.subagents++;
          else if (phase === "completed" || phase === "failed" || phase === "cancelled") s.subagents = Math.max(0, s.subagents - 1);
          s.subagentsAt = s.now();
          continue;
        } else if (event === "grok_code.compaction") {
          // Its `tokens_after` isn't the new size (verified on 1.0.46): unknown until the next request.
          if (!context || time >= context.time) context = { tokens: null, time };
          continue;
        } else if (event === "codex.turn_cost") {
          // A turn's totals and the server's estimate of its cost (every conversation's: cost sums them all). Attribute names from the binary, tolerant.
          const first = (...keys: string[]) => keys.map((k) => count(a.get(k))).find((n) => n !== undefined);
          const usd = first("usage.estimated_usd", "estimated_usd", "cost_usd");
          const micros = first("cost_microusd", "usage.cost_microusd");
          const reported = usd ?? (micros !== undefined ? micros / 1e6 : undefined);
          const input = first("input_token_count", "gen_ai.usage.input_tokens", "input_tokens");
          const output = first("output_token_count", "gen_ai.usage.output_tokens", "output_tokens");
          const cached = first("cached_token_count", "gen_ai.usage.cache_read.input_tokens", "cached_input_tokens") ?? 0;
          const reasoning = first("reasoning_token_count", "codex.usage.reasoning_output_tokens", "reasoning_output_tokens");
          const speed = a.get("speed");
          const turn = a.get("turn.id") ?? a.get("turn_id");
          if (reported !== undefined && input !== undefined && output !== undefined && once(`t:${typeof turn === "string" ? turn : ""}:${time}:${input}:${output}:${reported}`)) {
            turnCosts.push({ ...(model ? { model } : {}), input, cached, output, ...(reasoning !== undefined ? { reasoning } : {}), reportedUsd: reported, ...(typeof speed === "string" && /^[a-z0-9_-]{1,24}$/.test(speed) ? { speed } : {}) });
          }
          continue;
        } else if (event === "codex.conversation_starts" || (event === "codex.sse_event" && a.get("event.kind") === "response.completed")) {
          const conversation = a.get("conversation.id");
          const codexInput = count(a.get("input_token_count"));
          if (event === "codex.sse_event" && codexInput !== undefined && model && once(`x:${typeof conversation === "string" ? conversation : ""}:${time}:${codexInput}:${count(a.get("output_token_count"))}`)) {
            const tier = a.get("service_tier");
            usages.push({ harness: "codex", model, input: codexInput, cached: count(a.get("cached_token_count")) ?? 0, cacheWrite: count(a.get("cache_write_token_count")) ?? 0, output: count(a.get("output_token_count")) ?? 0, ...(typeof tier === "string" && /^[a-z0-9_-]{1,24}$/.test(tier) ? { serviceTier: tier } : {}) });
          }
          if (event === "codex.conversation_starts" && typeof conversation === "string") {
            const announced = count(a.get("context_window"));
            if (announced !== undefined && announced > 0) {
              if (s.startOverrides.size >= 64) s.startOverrides.clear();
              s.startOverrides.set(conversation, announced);
            }
          }
          if (typeof conversation === "string") {
            s.conversation ??= conversation;
            // The hook named this one the main conversation: it takes over with its first response, with its own window override or none (BUG-372, BUG-373).
            if (conversation === s.pendingConversation && event === "codex.sse_event") {
              s.conversation = conversation;
              s.pendingConversation = undefined;
              s.windowOverride = s.startOverrides.get(conversation);
            }
            if (conversation !== s.conversation) continue;
          }
          if (event === "codex.conversation_starts") {
            const override = count(a.get("context_window"));
            if (override !== undefined && override > 0 && (typeof conversation !== "string" || conversation === s.conversation)) s.windowOverride = override;
            continue;
          }
          // The response's own total: what goes into the next request (its output too).
          const input = count(a.get("input_token_count"));
          if (input !== undefined && s.compacting && (typeof conversation !== "string" || conversation === s.conversation)) {
            // A compaction's own request (the PreCompact hook ran): its prompt is the old history, no context of the new one.
            s.compacting = false;
            if (!context || time >= context.time) context = { tokens: null, time };
            continue;
          }
          if (input !== undefined) tokens = input + (count(a.get("output_token_count")) ?? 0);
        }
        if (tokens === undefined || !(tokens > 0)) continue;
        if (!context || time >= context.time) context = { tokens, ...(model ? { model } : {}), ...(event === "codex.sse_event" && s.windowOverride ? { windowOverride: s.windowOverride } : {}), time };
      }
    }
  }
  for (const u of usages) {
    try {
      s.callbacks.onUsage?.(u);
    } catch {}
  }
  for (const t of turnCosts) {
    try {
      s.callbacks.onTurnCost?.(t);
    } catch {}
  }
  if (costChanged && !s.metricSeen) reportCost(s);
  if (context && context.time >= s.contextTime) {
    s.contextTime = context.time;
    const { time: _, ...figure } = context;
    try {
      s.callbacks.onContext?.(figure.tokens === null ? null : (figure as ContextFigure));
    } catch {}
  }
}

const reply = (status: number, body = "") => new Response(body, { status, headers: { "content-type": "application/json" } });

/**
 * Starts the listener: loopback only, a free port. Accepts POSTs of OTLP/HTTP JSON at `/v1/metrics`
 * and `/v1/logs` (and `/v1/traces`, taken and dropped) from a launch's token; refuses anything else.
 */
export function startTelemetry({ maxBodyBytes = MAX_TELEMETRY_BYTES, now = Date.now }: { maxBodyBytes?: number; now?: () => number } = {}): TelemetryServer {
  const sessions = new Set<SessionState>();
  const find = (presented: string | null): SessionState | undefined => {
    if (!presented) return undefined;
    const p = Buffer.from(presented);
    let found: SessionState | undefined;
    // Compared in constant time, against every session.
    for (const s of sessions) if (p.length === s.token.length && timingSafeEqual(p, s.token)) found = s;
    return found;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: maxBodyBytes,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (!["/v1/metrics", "/v1/logs", "/v1/traces"].includes(path)) return reply(404);
      if (req.method !== "POST") return reply(405);
      const bearer = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? null;
      const session = find(req.headers.get(TELEMETRY_HEADER) ?? bearer);
      if (!session) return reply(401);
      const protobuf = /^application\/x-protobuf\b/i.test(req.headers.get("content-type") ?? "");
      if (!protobuf && !/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return reply(415);
      if (Number(req.headers.get("content-length") ?? 0) > maxBodyBytes) return reply(413);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length > maxBodyBytes) return reply(413);
        const encoding = (req.headers.get("content-encoding") ?? "").toLowerCase();
        if (encoding === "gzip") bytes = gunzipSync(bytes, { maxOutputLength: maxBodyBytes });
        else if (encoding && encoding !== "identity") return reply(415);
      } catch {
        return reply(413);
      }
      if (protobuf) {
        // Grok Build exports protobuf only: logs are decoded (bounded, untrusted bytes); metrics and traces are taken and dropped.
        try {
          if (path === "/v1/logs") takeLogs(session, decodeLogs(bytes) as Json);
        } catch {
          return reply(400);
        }
        return new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "application/x-protobuf" } });
      }
      let body: Json | undefined;
      try {
        body = obj(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {}
      if (!body) return reply(400);
      if (path === "/v1/metrics") takeMetrics(session, body);
      else if (path === "/v1/logs") takeLogs(session, body);
      // An OTLP export's success: an empty response object.
      return reply(200, "{}");
    },
    error: () => reply(500),
  });
  const port = server.port!;
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    port,
    endpoint,
    session(callbacks) {
      const token = randomBytes(24).toString("hex");
      const s: SessionState = { token: Buffer.from(token), callbacks, cumulative: new Map(), delta: 0, metricSeen: false, logCost: 0, contextTime: 0, seenUsage: new Set(), startOverrides: new Map(), subagents: 0, subagentsAt: 0, now };
      sessions.add(s);
      return {
        token,
        endpoint,
        close: () => void sessions.delete(s),
        expectCompaction: () => {
          s.compacting = true;
        },
        turnEnded: () => {
          s.subagents = 0;
        },
        setMainConversation: (id) => {
          // The hook's session id is assumed to be the telemetry's conversation id; if it never is, the conversation followed so far stays the main one
          // (the context does not freeze). Nothing followed yet, or the same: it is the main one now, with the window override its start announced, or none.
          if (s.conversation === undefined || s.conversation === id) {
            s.conversation = id;
            s.pendingConversation = undefined;
            s.windowOverride = s.startOverrides.get(id);
          } else s.pendingConversation = id;
        },
      };
    },
    stop() {
      sessions.clear();
      server.stop(true);
    },
  };
}

/**
 * The listener, or null with a notice when it can't start (no loopback, no free port): Gluon runs
 * on without cost and context figures (they show as —), never stops for it (BUG-173).
 */
export function tryStartTelemetry(start: () => TelemetryServer = startTelemetry): { server: TelemetryServer | null; notice?: string } {
  try {
    return { server: start() };
  } catch (e) {
    return { server: null, notice: `Cost and context figures are off: couldn't listen on 127.0.0.1 (${(e as Error).message}).` };
  }
}

/** Variables that would make a harness's telemetry the user's own: then Gluon adds none. */
const OWN_TELEMETRY: Partial<Record<Harness, RegExp>> = { "claude-code": /^(OTEL_|CLAUDE_CODE_ENABLE_TELEMETRY$)/, "grok-build": /^(OTEL_|GROK_EXTERNAL_OTEL$)/ };

/** Whether this environment has telemetry settings of its own, which Gluon leaves as they are (the harness then shows no cost or context in Gluon). */
export const ownTelemetry = (env: Record<string, string | undefined> = process.env, harness: Harness = "claude-code"): boolean => {
  const own = OWN_TELEMETRY[harness];
  return !!own && Object.keys(env).some((k) => own.test(k) && env[k] !== undefined);
};

/** What a launch adds so its agent exports to its session; null when it won't. */
export interface TelemetryLaunch {
  env: Record<string, string>;
  /** Options before the spec. */
  argv: string[];
}

/**
 * How a launch of this harness exports to `session`, or null: Claude Code and Grok Build (environment), Codex
 * (`-c` overrides); none for the others. Claude Code gets nothing when the user's environment has
 * telemetry settings of its own (any `OTEL_*`, `CLAUDE_CODE_ENABLE_TELEMETRY`): theirs stay as
 * they are, and its cost shows as unknown. Prompts, tool details and responses are never exported.
 * Codex's `otel.exporter` replaces a log exporter the user configured for that launch (Gluon
 * can't see Codex's config): its other `otel` settings and its metrics stay.
 */
export function telemetryLaunch(harness: Harness, session: Pick<TelemetrySession, "token" | "endpoint">, env: Record<string, string | undefined> = process.env): TelemetryLaunch | null {
  if (harness === "claude-code") {
    if (ownTelemetry(env)) return null;
    return {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: session.endpoint,
        OTEL_EXPORTER_OTLP_HEADERS: `${TELEMETRY_HEADER}=${session.token}`,
        // Milliseconds: figures within seconds, not the default minute.
        OTEL_METRIC_EXPORT_INTERVAL: "5000",
        OTEL_LOGS_EXPORT_INTERVAL: "2000",
        OTEL_LOG_USER_PROMPTS: "0",
        OTEL_LOG_ASSISTANT_RESPONSES: "0",
        OTEL_LOG_TOOL_DETAILS: "0",
        OTEL_LOG_TOOL_CONTENT: "0",
        OTEL_LOG_RAW_API_BODIES: "0",
      },
      argv: [],
    };
  }
  if (harness === "grok-build") {
    // Grok exports `http/protobuf` only (`otlp-protobuf.ts`); `GROK_EXTERNAL_OTEL` is its master switch. Prompts and content stay off.
    if (ownTelemetry(env, harness)) return null;
    return {
      env: {
        GROK_EXTERNAL_OTEL: "1",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_EXPORTER_OTLP_ENDPOINT: session.endpoint,
        OTEL_EXPORTER_OTLP_HEADERS: `${TELEMETRY_HEADER}=${session.token}`,
        OTEL_METRIC_EXPORT_INTERVAL: "5000",
        OTEL_LOGS_EXPORT_INTERVAL: "2000",
        OTEL_LOG_USER_PROMPTS: "0",
        OTEL_LOG_ASSISTANT_RESPONSES: "0",
        OTEL_LOG_TOOL_DETAILS: "0",
        OTEL_LOG_TOOL_CONTENT: "0",
      },
      argv: [],
    };
  }
  if (harness === "codex") {
    // TOML: the exporter enum is kebab-case and externally tagged; the token is hex.
    const exporter = `otel.exporter={otlp-http={endpoint="${session.endpoint}/v1/logs",protocol="json",headers={${TELEMETRY_HEADER}="${session.token}"}}}`;
    return { env: {}, argv: ["-c", exporter, "-c", "otel.log_user_prompt=false"] };
  }
  return null;
}
