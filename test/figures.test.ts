/**
 * Issue #39: are the cost and context % Gluon shows the harness's own? Each case replays what a
 * real harness exported (`test/fixtures/telemetry/`, captured offline on the real binary against
 * a local fake API, ids removed) through Gluon's listener, and compares the result with what the
 * harness itself displayed for the same session. Where each figure comes from, per harness:
 * "Status, cost and context" in `docs/concepts/architecture.md`.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyStatus, antigravity } from "../src/adapters/antigravity.ts";
import { pluginSource } from "../src/adapters/opencode.ts";
import { parseStatus, readEvents, type StatusInfo } from "../src/events.ts";
import { applyEndpoints, applyOpenRouter, endpointRange, format, openCodeProviders, select, wantedKeys } from "../scripts/pricing/modelsdev.ts";
import { parseTable } from "../src/cost/table-schema.ts";
import { codexCost } from "../src/cost/codex.ts";
import { parseGrokUsage } from "../src/cost/grok-usage.ts";
import { Ledger } from "../src/cost/ledger.ts";
import { reportLines } from "../src/cost/report.ts";
import { agyContextTokens } from "../src/cost/antigravity.ts";
import { ownWindow, ownPercent } from "../src/cost/context.ts";
import { opencodeContextTokens } from "../src/cost/opencode.ts";
import type { ModelsDevTable } from "../src/cost/tables.ts";
import { FIXTURE_TABLES as BUNDLED_TABLES } from "./fixtures/fixture-tables.ts";
import type { CostTracker } from "../src/cost/tracker.ts";
import { codexCatalogWindows, codexContextWindows, codexUsableWindow, contextPercent } from "../src/models.ts";
import { contextLabel, costLabel } from "../src/sessions.ts";
import { ownTelemetry, startTelemetry, TELEMETRY_HEADER, telemetryLaunch, type ContextFigure, type UsageEvent } from "../src/telemetry.ts";
import { frozenEntry, frozenTableWith, frozenTracker, frozenWindow } from "./fixtures/frozen-prices.ts";
import { encodeLogs } from "./fixtures/otlp-protobuf.ts";

const DIR = join(import.meta.dir, "fixtures", "telemetry");
const jsonl = (name: string) =>
  readFileSync(join(DIR, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { path: string; body: unknown });

const server = startTelemetry();
afterAll(() => server.stop());

/** What a launch's callbacks received while one capture was replayed in order. */
async function replay(name: string, { resend = false }: { resend?: boolean } = {}) {
  const costs: number[] = [];
  const contexts: (ContextFigure | null)[] = [];
  const usages: UsageEvent[] = [];
  const s = server.session({ onCost: (usd) => costs.push(usd), onContext: (c) => contexts.push(c), onUsage: (u) => usages.push(u) });
  for (const { path, body } of jsonl(name)) {
    const r = await fetch(`${server.endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json", [TELEMETRY_HEADER]: s.token }, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    // An exporter that re-sends a batch of logs must not count twice (a delta metric is never re-sent: Gluon answers 200).
    if (resend && path === "/v1/logs") await fetch(`${server.endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json", [TELEMETRY_HEADER]: s.token }, body: JSON.stringify(body) });
  }
  s.close();
  return { costs, contexts, usages };
}

describe("Claude Code 2.1.289: Gluon's figures against its own status line", () => {
  // The status line's input after each step of the capture: a turn, /compact, a subagent turn, a turn.
  const own = JSON.parse(readFileSync(join(DIR, "claude-code-2.1.289-statusline.json"), "utf8")).steps as {
    model: { id: string };
    cost: { total_cost_usd: number };
    context_window: { used_percentage: number | null; context_window_size: number; current_usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } | null };
  }[];

  test("cost: the sum of the delta cost metric is its own total after every step (subagent and side requests included)", async () => {
    const { costs } = await replay("claude-code-2.1.289.jsonl");
    // Every total it displayed was reached by the stream, and the last is the same to the cent.
    for (const step of own) expect(costs.some((c) => Math.abs(c - step.cost.total_cost_usd) < 1e-9)).toBe(true);
    expect(costs.at(-1)).toBeCloseTo(own.at(-1)!.cost.total_cost_usd, 9);
    // Never goes down.
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });

  test("BUG-314/compaction: the context is the main thread's prompt (subagent and title requests left out), and unknown after /compact until the next request: its own figure's sequence", async () => {
    const { contexts } = await replay("claude-code-2.1.289.jsonl");
    // Collapse repeats (several requests of one turn).
    const seq = contexts.filter((c, i) => i === 0 || JSON.stringify(c) !== JSON.stringify(contexts[i - 1]));
    expect(seq.length).toBe(own.length);
    own.forEach((step, i) => {
      const figure = seq[i];
      const theirs = step.context_window.used_percentage;
      if (theirs === null) {
        expect(figure).toBeNull();
        return;
      }
      const u = step.context_window.current_usage!;
      expect(figure).toEqual({ tokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, model: step.model.id });
      // The label rounds as Claude Code does.
      expect(Math.round(contextPercent(figure!.tokens, figure!.model, { env: {} })!)).toBe(theirs);
    });
  });
});

describe("Claude Code 2.1.289, a real run on an API key (issue #39, paid, ~$0.05)", () => {
  const own = JSON.parse(readFileSync(join(DIR, "claude-code-2.1.289-live-haiku-statusline.json"), "utf8")).steps as { cost: { total_cost_usd: number }; context_window: { used_percentage: number } }[];

  test("the real stream's cost is its own total to the last digit, and its context is its status line's percentage (the compaction step aside: it shows 0 there, Gluon `—`)", async () => {
    const { costs, contexts } = await replay("claude-code-2.1.289-live-haiku.jsonl");
    expect(costs.at(-1)).toBeCloseTo(own.at(-1)!.cost.total_cost_usd, 9);
    const seq = contexts.filter((c, i) => i === 0 || JSON.stringify(c) !== JSON.stringify(contexts[i - 1]));
    // Two prompts, the compaction, a prompt; the title request (`generate_session_title`) is no context.
    expect(seq.map((c) => c?.tokens ?? null)).toEqual([22_099, 22_185, null, 21_291]);
    const pct = seq.map((c) => (c ? Math.round(contextPercent(c.tokens, c.model, { env: {} })!) : null));
    expect(pct).toEqual([own[0]!.context_window.used_percentage, own[1]!.context_window.used_percentage, null, own[3]!.context_window.used_percentage]);
  });
});

describe("the usage Gluon's own cost is computed from (onUsage)", () => {
  test("Claude Code: every request once (main thread, title, /compact), with the reported cost beside it", async () => {
    const { usages, costs } = await replay("claude-code-2.1.289-live-haiku.jsonl", { resend: true });
    expect(usages.length).toBe(5);
    expect(usages.every((u) => u.harness === "claude-code" && u.model === "claude-haiku-4-5-20251001" && u.reportedUsd !== undefined)).toBe(true);
    expect(usages.reduce((n, u) => n + (u.harness === "claude-code" ? u.reportedUsd! : 0), 0)).toBeCloseTo(0.04530665, 9);
    expect(usages[0]).toMatchObject({ input: 10, output: 40, cacheRead: 0, cacheWrite: 22_089, fast: false });
    // The cost too: a re-sent batch of logs is not added twice (before the metric came, the logs are the cost).
    expect(costs.at(-1)).toBeCloseTo(0.04530665, 9);
  });

  test("Codex: every conversation's response, the title thread's too, with the requested tier; a batch sent twice counts once", async () => {
    const { usages } = await replay("codex-0.159.3-live-luna.jsonl", { resend: true });
    expect(usages).toEqual([
      { harness: "codex", model: "gpt-6-luna", input: 10_611, cached: 0, cacheWrite: 10_608, output: 228, serviceTier: "priority" },
      { harness: "codex", model: "gpt-6-luna", input: 7_195, cached: 0, cacheWrite: 7_192, output: 115 },
      { harness: "codex", model: "gpt-6-luna", input: 40_421, cached: 10_608, cacheWrite: 29_810, output: 22, serviceTier: "priority" },
    ]);
  });
});

describe("Codex 0.159.3: Gluon's context against its own /status", () => {
  const windows = codexContextWindows(JSON.stringify({ models: [{ slug: "gpt-6-sol", context_window: 272_000, effective_context_window_percent: 95 }] }));

  test("BUG-317/codex-footer: counted as its footer counts: last response's input + output, 12k off both sides (what /status showed for the same numbers)", () => {
    expect(windows["gpt-6-sol"]).toBe(258_400);
    // /status in the TUI: "97% left (20.5K used / 258K)" and "22% left (204K used / 258K)".
    // A real run on an API key (paid, gpt-6-luna) added: "100% left (10.8K used / 258K)" for 10,611 + 228, and "88% left (40.4K used / 258K)" for 40,421 + 22.
    for (const [input, output, left] of [[20_000, 500, 97], [200_000, 4_000, 22], [10_611, 228, 100], [40_421, 22, 88]] as const) {
      expect(100 - Math.round(contextPercent(input + output, "gpt-6-sol", { codex: windows })!)).toBe(left);
    }
  });

  test("a real run on an API key (paid): the title thread (read-only, `approval_policy` never; its prompt 7,195 tokens, finished BEFORE the main response) is no context; the session's is input + output", async () => {
    const { contexts } = await replay("codex-0.159.3-live-luna.jsonl");
    expect(contexts.map((c) => c?.tokens)).toEqual([10_839, 40_443]);
  });

  test("the session's conversation only: the title thread each prompt starts is a conversation of its own, with a small prompt of its own", async () => {
    const { contexts } = await replay("codex-0.159.3.jsonl");
    expect(contexts.every((c) => c?.model === "gpt-6-sol")).toBe(true);
    expect(contexts.map((c) => c?.tokens)).toEqual([20_500, 204_000, 9_300, 30_700]);
  });

  test("BUG-316/codex-title-thread: a side conversation's response, newer than the session's, doesn't replace its figure", async () => {
    // The capture's side threads have the main one's usage (its fake API sent one answer for all): give them a title request's size.
    const lines = jsonl("codex-0.159.3.jsonl");
    const main = (lines[0]!.body as { resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string; value: { stringValue: string } }[] }[] }[] }[] }).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes.find((a) => a.key === "conversation.id")!.value.stringValue;
    const contexts: (ContextFigure | null)[] = [];
    const s = server.session({ onContext: (c) => contexts.push(c) });
    for (const { path, body } of lines) {
      const text = JSON.stringify(body, (_k, v) =>
        v && typeof v === "object" && Array.isArray(v.attributes) && v.attributes.some((a: { key: string; value: { stringValue?: string } }) => a.key === "conversation.id" && a.value.stringValue !== main)
          ? { ...v, attributes: v.attributes.map((a: { key: string }) => (a.key === "input_token_count" ? { key: a.key, value: { stringValue: "1300" } } : a)) }
          : v,
      );
      await fetch(`${server.endpoint}${path}`, { method: "POST", headers: { "content-type": "application/json", [TELEMETRY_HEADER]: s.token }, body: text });
    }
    s.close();
    expect(contexts.map((c) => c?.tokens)).toEqual([20_500, 204_000, 9_300, 30_700]);
  });
});

describe("Codex's window, resolved as Codex resolves it (issue #39)", () => {
  const catalog = codexCatalogWindows(JSON.stringify({ models: [{ slug: "gpt-6-sol", context_window: 272_000, max_context_window: 872_000, effective_context_window_percent: 95 }, { slug: "gpt-6", context_window: 100_000 }, { slug: "only-max", max_context_window: 50_000 }, { slug: "bad", context_window: "x" }] }));

  test("the catalog keeps the window, its maximum and the effective percent (95 when absent); max_context_window stands in for a missing window", () => {
    expect(catalog).toEqual({ "gpt-6-sol": { context: 272_000, max: 872_000, percent: 95 }, "gpt-6": { context: 100_000, max: 100_000, percent: 95 }, "only-max": { context: 50_000, max: 50_000, percent: 95 } });
    expect(codexContextWindows(JSON.stringify({ models: [{ slug: "m", context_window: 1000 }] }))).toEqual({ m: 950 });
  });

  test("the model resolves by the longest catalog prefix, then once without a `provider/` namespace, then Codex's 272k x 95% fallback", () => {
    expect(codexUsableWindow("gpt-6-sol", catalog)).toBe(258_400);
    expect(codexUsableWindow("gpt-6-sol-2026-10", catalog)).toBe(258_400);
    expect(codexUsableWindow("gpt-6-luna", catalog)).toBe(95_000);
    expect(codexUsableWindow("openai/gpt-6-sol", catalog)).toBe(258_400);
    // Only one namespace segment is stripped: two fall to the fallback (which happens to equal gpt-6-sol's window).
    expect(codexUsableWindow("a/b/gpt-6-luna", catalog)).toBe(Math.floor((272_000 * 95) / 100));
    expect(codexUsableWindow("us.openai.gpt-6-sol", catalog)).toBe(Math.floor((272_000 * 95) / 100));
    expect(codexUsableWindow("unknown-model", {})).toBe(258_400);
  });

  test("the config's model_context_window replaces the window, capped by the model's maximum, then the percent applies", () => {
    expect(codexUsableWindow("gpt-6-sol", catalog, 100_000)).toBe(95_000);
    expect(codexUsableWindow("gpt-6-sol", catalog, 2_000_000)).toBe(Math.floor((872_000 * 95) / 100));
    expect(codexUsableWindow("gpt-6-sol", catalog, 0)).toBe(258_400);
  });

  test("a real run with `-c model_context_window=100000`: the override travels with the context, and the figure is /status's own (90% left of 95K at 20.5K)", async () => {
    const { contexts } = await replay("codex-0.159.3-window-override-100000.jsonl");
    expect(contexts[0]).toMatchObject({ tokens: 20_500, model: "gpt-6-sol", windowOverride: 100_000 });
    // 20,500 tokens: Codex's /status said "90% left (20.5K used / 95K)": 10% used.
    const pct = contextPercent(contexts[0]!.tokens, "gpt-6-sol", { codexCatalog: catalog, codexOverride: contexts[0]!.windowOverride });
    expect(100 - Math.round(pct!)).toBe(90);
    // Without the override the same tokens read 3% used: the override is what makes it right.
    expect(Math.round(contextPercent(20_500, "gpt-6-sol", { codexCatalog: catalog })!)).toBe(3);
  });

  test("a model Codex doesn't know (Bedrock's id) still gets a window, as in Codex (its fallback), where a bare lookup gave none", () => {
    expect(contextPercent(100_000, "us.openai.gpt-6-sol", { codexCatalog: catalog })).toBeCloseTo(((100_000 - 12_000) / (258_400 - 12_000)) * 100, 6);
    expect(contextPercent(100_000, "us.openai.gpt-6-sol", { codex: {} })).toBeUndefined();
  });
});

describe("the context window: a model named without its [1m] suffix", () => {
  test("BUG-315/window: Claude Code's telemetry drops `[1m]` from the model, so a prompt over 200k proves a 1M window (and stays so after a compaction)", () => {
    // Real: `--model claude-opus-4-6[1m]` is exported as model `claude-opus-4-6`; its own status line says 1,000,000.
    expect(contextPercent(150_000, "claude-opus-4-6", { env: {} })).toBe(75);
    expect(contextPercent(300_000, "claude-opus-4-6", { env: {} })).toBe(30);
    expect(contextPercent(40_000, "claude-opus-4-6", { env: {}, peak: 300_000 })).toBe(4);
    // Not for what is no Claude, a Codex or OpenCode window, or a window already 1M.
    expect(contextPercent(300_000, "gpt-6-sol", { env: {}, codex: { "gpt-6-sol": 380_000 } })).toBeCloseTo((288 / 368) * 100, 6);
    expect(contextPercent(300_000, 262_144, { env: {} })).toBe(100);
    expect(contextPercent(300_000, "claude-opus-5-5", { env: {} })).toBe(30);
  });
});

describe("when Gluon can't see a harness's figures", () => {
  test("Claude Code with telemetry settings of the user's own: Gluon adds none (the figures show as —) and says so; no other harness is affected", () => {
    for (const own of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME", "CLAUDE_CODE_ENABLE_TELEMETRY"]) {
      expect(ownTelemetry({ [own]: "x", PATH: "/bin" })).toBe(true);
      expect(telemetryLaunch("claude-code", { token: "t", endpoint: "http://127.0.0.1:1" }, { [own]: "x" })).toBeNull();
    }
    expect(ownTelemetry({ PATH: "/bin", OTEL_X: undefined })).toBe(false);
  });

  test("Antigravity exports nothing Gluon can read (no OpenTelemetry, no hook with figures: its status line is the only source): no telemetry is added, and its row reads —; Grok Build exports protobuf (test/grok.test.ts)", () => {
    expect(telemetryLaunch("antigravity", { token: "t", endpoint: "http://127.0.0.1:1" }, {})).toBeNull();
    expect(telemetryLaunch("grok-build", { token: "t", endpoint: "http://127.0.0.1:1" }, {})).not.toBeNull();
  });
});

describe("OpenCode 2.0.21: its plugin's figures against OpenCode's own footer", () => {
  const dir = mkdtempSync(join(tmpdir(), "gluon-figures-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (p: unknown) => p } }));
  const models = [
    { id: "fake-1", providerID: "fake", limit: { context: 100_000, output: 8_000 } },
    { id: "fake-small", providerID: "fake", limit: { context: 20_000, output: 4_000 } },
  ];
  let n = 0;

  /** The figures the plugin wrote for these events (a real capture, ids removed), as Gluon merges them. */
  async function figures(stream: object[], { models: list = models, session = "ses_01" }: { models?: object[]; session?: string } = {}): Promise<StatusInfo> {
    const events = mkdtempSync(join(dir, "events-"));
    const saved = process.env.GLUON_EVENTS;
    process.env.GLUON_EVENTS = events;
    try {
      const file = join(dir, `tui-${++n}.js`);
      writeFileSync(file, pluginSource());
      const plugin = (await import(file)).default as { setup: (c: unknown) => () => void };
      const context = {
        ui: { slot: () => () => {}, router: { current: () => ({ type: "session", sessionID: session }) } },
        keymap: { layer: () => {} },
        client: { event: { subscribe: async () => ({ stream: (async function* () { yield* stream; })() }) }, model: { list: async () => ({ data: list }) } },
      };
      const stop = plugin.setup(context);
      // Figures are written at most once a second.
      await Bun.sleep(1400);
      stop();
      const merged: StatusInfo = {};
      const steps: NonNullable<StatusInfo["steps"]> = [];
      for (const e of readEvents(events, new Set())) {
        // The steps are never merged: each arrives once, in order.
        if (!e.status) continue;
        const { steps: these, ...rest } = e.status;
        if (these) steps.push(...these);
        Object.assign(merged, rest);
      }
      return steps.length ? { ...merged, steps } : merged;
    } finally {
      saved === undefined ? delete process.env.GLUON_EVENTS : (process.env.GLUON_EVENTS = saved);
    }
  }
  const capture = (name: string) => readFileSync(join(DIR, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; data: { reason?: string } });
  /** What Gluon's row would read for these figures. */
  const shown = (f: StatusInfo) => ({ context: f.contextTokens == null ? "—" : contextLabel(contextPercent(f.contextTokens, f.contextWindow ?? f.model)), cost: costLabel(f.costUsd === undefined ? undefined : { usd: f.costUsd, approx: false }) });

  test("BUG-318/opencode-footer: the context counts the last step's input + cache + output + reasoning, as the footer does (32,000 / 32% for a prompt of 10k + 20k cached, 1.6k out, 0.4k reasoning); its cost summed over the sessions (subagent's too) @full", async () => {
    const events = capture("opencode-2.0.21-prompts.jsonl");
    // The footer after the first prompt, read from the TUI: 32,000 tokens, 32%, $0.10.
    const first = await figures(events.slice(0, events.findIndex((e) => e.type === "session.usage.updated") + 3));
    expect(first).toMatchObject({ contextTokens: 32_000, contextWindow: 100_000 });
    expect(shown(first).context).toBe("32%");
    // After the last prompt, with a subagent on another model in between: 50,500, 51%, $0.38.
    const last = await figures(events);
    expect(last).toMatchObject({ contextTokens: 50_500, contextWindow: 100_000, model: "fake/fake-1" });
    expect(last.costUsd).toBeCloseTo(0.3793, 9);
    expect(shown(last)).toEqual({ context: "51%", cost: "$0.38" });
  });

  test("each step and each compaction goes out as its own record, in order, never merged (a context tier is chosen by one step's prompt) @full", async () => {
    const events = capture("opencode-2.0.21-prompts.jsonl");
    const f = await figures(events);
    const ended = events.filter((e) => e.type === "session.step.ended") as unknown as { data: { sessionID: string; cost: number; tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } } }[];
    // The title request (no step event: BUG-345) is one more record, after the steps that were there when the second ran out.
    const steps = f.steps!.filter((s) => !s.side);
    expect(f.steps!.length).toBe(ended.length + 1);
    expect(steps.length).toBe(ended.length);
    expect(f.steps!.map((s) => s.n)).toEqual(f.steps!.map((_, i) => i + 1));
    ended.forEach((e, i) => expect(steps[i]).toMatchObject({ input: e.data.tokens.input, output: e.data.tokens.output, reasoning: e.data.tokens.reasoning, cacheRead: e.data.tokens.cache.read, cacheWrite: e.data.tokens.cache.write, cost: e.data.cost }));
    // Both steps of a tool turn (22 ms apart in the capture) are there; the subagent's (another session, another model) too.
    expect(new Set(steps.map((s) => s.model))).toEqual(new Set(["fake/fake-1", "fake/fake-small"]));
    // A compaction that worked, and one that failed (no model of its own: the session's), each once.
    const c = (await figures(capture("opencode-2.0.21-compaction.jsonl"))).steps!.filter((s) => !s.side);
    expect(c.length).toBe(capture("opencode-2.0.21-compaction.jsonl").filter((e) => ["session.step.ended", "session.compaction.ended", "session.compaction.failed"].includes(e.type)).length);
  });

  test("BUG-319/opencode-compaction: after a compaction that worked OpenCode shows no context until its next step; a failed one changes nothing @full", async () => {
    const events = capture("opencode-2.0.21-compaction.jsonl");
    const ended = events.findIndex((e) => e.type === "session.compaction.ended");
    // The step after the first compaction (window 20,000): the footer read 16,000 tokens, 80%.
    const step = events.findIndex((e, i) => i > ended && e.type === "session.step.ended");
    const after = await figures(events.slice(0, step + 2));
    expect(after).toMatchObject({ contextTokens: 16_000, contextWindow: 20_000 });
    expect(shown(after).context).toBe("80%");
    // The manual /compact at the end: no context in the footer, $0.28.
    const last = await figures(events);
    expect(last.contextTokens).toBeNull();
    expect(shown(last)).toEqual({ context: "—", cost: "$0.28" });
    // A failed compaction (an earlier one in the capture) leaves the last figure.
    const failed = events.findIndex((e) => e.type === "session.compaction.failed");
    expect((await figures(events.slice(0, failed + 1))).contextTokens).toBe(21_000);
  });

  test("a real run (paid, deepseek-v4-flash via OpenRouter): the last step's input 95 + cache read 5,120 + output 3 + reasoning 13 is OpenCode's own \"5,231 tokens\"", async () => {
    const tokens = { input: 95, output: 3, reasoning: 13, cache: { read: 5120, write: 0 } };
    const f = await figures([
      { type: "session.created", data: { sessionID: "ses_01", model: { id: "deepseek/deepseek-v4-flash", providerID: "openrouter" } } },
      { type: "session.step.started", data: { sessionID: "ses_01", model: { id: "deepseek/deepseek-v4-flash", providerID: "openrouter", variant: "default" } } },
      { type: "session.step.ended", data: { sessionID: "ses_01", finish: "stop", cost: 0.000137296, tokens } },
      { type: "session.usage.updated", data: { sessionID: "ses_01", cost: 0.00032909439999999996, tokens } },
    ]);
    expect(f).toMatchObject({ contextTokens: 5_231, model: "openrouter/deepseek/deepseek-v4-flash" });
    expect(f.costUsd).toBeCloseTo(0.000329, 6);
  });

  test("a model without a price (cost 0) sends no cost, as OpenCode shows none; a null context is a valid status", async () => {
    const events = capture("opencode-2.0.21-prompts.jsonl").map((e) => ((e.data as { cost?: number }).cost !== undefined ? { ...e, data: { ...e.data, cost: 0 } } : e));
    expect((await figures(events)).costUsd).toBeUndefined();
    expect(parseStatus('{"contextTokens":null}')).toEqual({ contextTokens: null });
    expect(parseStatus('{"contextTokens":"x"}')).toBeNull();
    expect(parseStatus('{"costUsd":null}')).toBeNull();
  });

  /** The prices that fixture's steps were made at (`opencode-2.0.21-cost-steps.json`): each step's reported cost reproduces. */
  const table = (): ModelsDevTable => frozenTableWith({ "fake/fake-1": { cost: { input: 2, output: 10, cache_read: 0.5, cache_write: 3 }, context: 100_000 }, "fake/fake-small": { cost: { input: 1, output: 1 }, context: 20_000 } } as never);
  const priced = (records: NonNullable<StatusInfo["steps"]>, ledger = new Ledger()) => {
    const t = frozenTracker({ harness: "opencode", conn: "opencode-go", ledger, table: table(), now: () => 1 });
    for (const r of records) t.opencodeStep({ model: r.model, tokens: { input: r.input, output: r.output, reasoning: r.reasoning, cache: { read: r.cacheRead, write: r.cacheWrite } }, ...(r.cost !== undefined ? { reportedUsd: r.cost } : {}), ...(r.side ? { side: true } : {}) });
    return { t, ledger };
  };

  test("BUG-345/opencode-title-in-cost: the request OpenCode bills with no step event (the session title: usage moves by its tokens and cost before the first step) is its own `side` record, so the cost total is OpenCode's cumulative one; it is no context", async () => {
    const f = await figures(capture("opencode-2.0.21-prompts.jsonl"));
    const side = f.steps!.filter((s) => s.side);
    // Exactly the title: the first usage update (10,000 in, 1,600 out, 400 reasoning, 20,000 cached; $0.05), on the session's model, once.
    expect(side).toEqual([{ n: expect.any(Number), model: "fake/fake-1", input: 10_000, output: 1_600, reasoning: 400, cacheRead: 20_000, cacheWrite: 0, cost: expect.closeTo(0.05, 9), side: true }]);
    expect(side[0]!.context).toBeUndefined();
    // Every request priced: ours is the last cumulative total of both sessions (0.3742 + 0.0051), to the micro-dollar; without the title it would be $0.05 short.
    const { t, ledger } = priced(f.steps!);
    expect(t.figure()).toMatchObject({ own: true });
    expect(t.figure()!.usd).toBeCloseTo(0.3793, 9);
    expect(priced(f.steps!.filter((s) => !s.side)).t.figure()!.usd).toBeCloseTo(0.3293, 9);
    // The title's model is assumed (OpenCode names none), and said so; the reported cost of it is audited against ours.
    const usage = ledger.entries.filter((e) => e.kind === "usage") as { assumptions: string[] }[];
    expect(usage.filter((u) => u.assumptions.includes("side-model-assumed")).length).toBe(1);
    expect(ledger.divergences()).toEqual([]);
  });

  test("BUG-345/opencode-title-no-false-title: a compaction's usage update (its event comes later), a failed compaction and a subagent never read as a title; the only side record of the compaction capture is its title", async () => {
    const f = await figures(capture("opencode-2.0.21-compaction.jsonl"));
    expect(f.steps!.filter((s) => s.side).map((s) => [s.input, s.output, s.cost])).toEqual([[20_000, 1_000, expect.closeTo(0.05, 9)]]);
  });

  test("BUG-346/opencode-own-context: the conversation on screen's steps say `context` (a subagent's, a title's and a failed compaction's don't), the compaction says `compacted`; the % is the step's tokens over models.dev's limit, never the window OpenCode reports @full", async () => {
    const f = await figures(capture("opencode-2.0.21-prompts.jsonl"));
    // The steps of ses_01 (on screen) move the context; the subagent ses_02 (parentID) and the title (sent a second after the update, behind the steps) do not.
    expect(f.steps!.map((s) => [s.model, s.side ? "side" : (s.context ?? "-")])).toEqual([
      ["fake/fake-1", "step"], ["fake/fake-1", "step"], ["fake/fake-1", "step"], ["fake/fake-1", "step"], ["fake/fake-1", "step"], ["fake/fake-small", "-"], ["fake/fake-1", "step"], ["fake/fake-1", "step"], ["fake/fake-1", "side"],
    ]);
    const c = (await figures(capture("opencode-2.0.21-compaction.jsonl"))).steps!;
    expect(c.filter((s) => s.context === "compacted").length).toBe(capture("opencode-2.0.21-compaction.jsonl").filter((e) => e.type === "session.compaction.ended").length);
    // What Gluon does with a step: the whole prompt and answer, over its own window; OpenCode's reported 100,000 (`model.list`) is only compared.
    const last = f.steps!.filter((s) => s.context === "step").at(-1)!;
    const tokens = opencodeContextTokens({ input: last.input, output: last.output, reasoning: last.reasoning, cache: { read: last.cacheRead, write: last.cacheWrite } });
    expect(tokens).toBe(50_500);
    const model = "openrouter/deepseek/deepseek-v4-flash";
    // The window is models.dev's `limit.context` as captured (frozen: BUG-413); that the live table is still OpenCode's source of it is `ownWindow`'s.
    const own = { window: frozenWindow(model) };
    expect(own.window).toBe(1_048_576);
    expect(ownWindow("opencode", model).source).toBe("opencode-models-dev");
    expect(ownPercent("opencode", tokens, own.window)).toBeCloseTo((50_500 / 1_048_576) * 100, 9);
    const ledger = new Ledger();
    frozenTracker({ harness: "opencode", conn: "opencode-go", ledger }).observeContext({ own: { tokens, window: own.window }, reported: { tokens, window: 1_000_000 } });
    expect(ledger.entries).toEqual([expect.objectContaining({ kind: "context", ownTokens: 50_500, reportedTokens: 50_500, ownWindow: 1_048_576, reportedWindow: 1_000_000, cause: "none" })]);
    // A model models.dev has no entry for: no window, so no % (never a window taken from the harness).
    expect(ownWindow("opencode", "fake/fake-1").window).toBeUndefined();
  });

  test("BUG-347/opencode-resume-baseline: in a resumed launch a session that was already there holds history: its first usage update beyond its records is a baseline, off its cost and off the title detection; a session created in this launch has none @full", async () => {
    const tokens = (input: number) => ({ input, output: 100, reasoning: 0, cache: { read: 0, write: 0 } });
    const stream = (created: boolean) => [
      ...(created ? [{ type: "session.created", data: { sessionID: "ses_01", model: { id: "fake-1", providerID: "fake" } } }] : [{ type: "session.step.started", data: { sessionID: "ses_01", model: { id: "fake-1", providerID: "fake" } } }]),
      // The session had $5 of history; this launch's step cost $0.0025 (1,000 in at 2 + 50 out... as the capture's fake-1).
      { type: "session.step.ended", data: { sessionID: "ses_01", cost: 0.0025, tokens: tokens(1_000) } },
      { type: "session.usage.updated", data: { sessionID: "ses_01", cost: created ? 0.0025 : 5.0025, tokens: tokens(created ? 1_000 : 900_000) } },
    ];
    const saved = process.env.GLUON_RESUMED;
    process.env.GLUON_RESUMED = "1";
    try {
      const resumed = await figures(stream(false));
      // Only this launch's cost, and no title read out of the 900,000 tokens of history.
      expect(resumed.costUsd).toBeCloseTo(0.0025, 9);
      expect(resumed.steps!.map((s) => !!s.side)).toEqual([false]);
      // A fresh session in the same (resumed) launch: its own, whole.
      const fresh = await figures(stream(true));
      expect(fresh.costUsd).toBeCloseTo(0.0025, 9);
      expect(fresh.steps!.map((s) => !!s.side)).toEqual([false]);
      // Not a resumed launch: no baseline (the session's whole history would be this launch's).
      delete process.env.GLUON_RESUMED;
      expect((await figures(stream(false))).costUsd).toBeCloseTo(5.0025, 9);
    } finally {
      saved === undefined ? delete process.env.GLUON_RESUMED : (process.env.GLUON_RESUMED = saved);
    }
  });

  // A real run (paid, deepseek-v4-flash via OpenRouter, 2026-10-04): the events OpenCode 2.0.21 sent a plugin, and what its own footer showed after each step.
  const LIVE = "opencode-2.0.21-live-openrouter-deepseek-v4-flash-events.jsonl";
  /** The models list the plugin asks OpenCode for: the session's model and, per the live title's price, OpenRouter's small model (family `gpt-luna`, the first of OpenCode's four). */
  const live = [
    { id: "deepseek/deepseek-v4-flash", providerID: "openrouter", family: "deepseek", status: "active", limit: { context: 1_048_576, output: 65_536 } },
    { id: "anthropic/claude-haiku-4.5", providerID: "openrouter", family: "claude-haiku", status: "active", limit: { context: 200_000, output: 64_000 } },
    { id: "openai/gpt-6-luna", providerID: "openrouter", family: "gpt-luna", status: "active", limit: { context: 400_000, output: 128_000 } },
    { id: "openai/gpt-6-luna-pro", providerID: "openrouter", family: "gpt-luna", status: "deprecated", limit: { context: 400_000, output: 128_000 } },
  ];
  /** The plugin's figures for the whole capture, run once (a run waits out the plugin's one-second write interval). */
  let liveOnce: Promise<StatusInfo> | undefined;
  const liveRun = () => (liveOnce ??= figures(capture(LIVE), { models: live, session: "ses_REDACTED0001" }));
  const liveTracker = (ledger = new Ledger()) => frozenTracker({ harness: "opencode", conn: "openrouter", launchedKey: "openrouter/deepseek/deepseek-v4-flash", ledger });

  test("live run 2: the % after each step is the footer's (1%: 7,450, 7,586 and 7,831 tokens), — after the compaction, then 7,243 tokens; Gluon's own window is models.dev's 1,048,576", async () => {
    const f = await liveRun();
    const window = frozenWindow("openrouter/deepseek/deepseek-v4-flash");
    expect(window).toBe(1_048_576);
    const steps = f.steps!.filter((s) => s.context);
    const shownContexts = steps.map((s) => (s.context === "compacted" ? null : opencodeContextTokens({ input: s.input, output: s.output, reasoning: s.reasoning, cache: { read: s.cacheRead, write: s.cacheWrite } })));
    // The footer after the first prompt, the tool prompt, the later prompt, and after /compact and a prompt: 7,450 / 7,586 / 7,831 / 7,243 tokens, "1% used" each.
    expect(shownContexts).toEqual([7_450, 7_547, 7_586, 7_750, 7_831, null, 7_243]);
    for (const tokens of shownContexts) if (tokens) expect(contextLabel(ownPercent("opencode", tokens, window))).toBe("1%");
    expect(contextLabel(undefined)).toBe("—");
    // What its status channel said last is the same size.
    expect(f).toMatchObject({ contextTokens: 7_243, contextWindow: 1_048_576 });
  });

  test("BUG-380/opencode-title-model: the title request (3 in, 7 out, 1,099 written; no step event, billed $0.000141175) is priced at the provider's small model as OpenCode picks it (the first family of gpt-luna, gemini-flash-lite, gemini-flash, claude-haiku the provider has), not the session's: 141 micro-USD like OpenCode's, not 9", async () => {
    const f = await liveRun();
    const side = f.steps!.filter((s) => s.side);
    expect(side).toEqual([{ n: expect.any(Number), model: "openrouter/openai/gpt-6-luna", input: 3, output: 7, reasoning: 0, cacheRead: 0, cacheWrite: 1_099, cost: expect.closeTo(0.000141175, 12), side: true }]);
    const ledger = new Ledger();
    const t = liveTracker(ledger);
    for (const r of f.steps!) t.opencodeStep({ model: r.model, tokens: { input: r.input, output: r.output, reasoning: r.reasoning, cache: { read: r.cacheRead, write: r.cacheWrite } }, ...(r.cost !== undefined ? { reportedUsd: r.cost } : {}), ...(r.side ? { side: true } : {}) });
    const title = ledger.entries.find((e) => e.kind === "usage" && e.assumptions.includes("side-model-assumed")) as { ownMicros: number; model: string };
    expect(title).toMatchObject({ ownMicros: 141, model: "openrouter/openai/gpt-6-luna" });
    // Every request's figure is OpenCode's, to the micro-dollar, the title's too; so is the running total (its last usage update: $0.0025356774).
    expect(ledger.entries.filter((e) => e.kind === "observation" && e.reportedMicros !== e.ownMicros)).toEqual([]);
    expect(Math.round(t.figure()!.usd * 1e6)).toBe(Math.round(f.costUsd! * 1e6));
    // Without the models list (or without a family in it) the plugin names the session's model: the old figure, 9, and a difference that names its cause.
    const bare = f.steps!.map((r) => (r.side ? { ...r, model: "openrouter/deepseek/deepseek-v4-flash" } : r));
    const wrong = new Ledger();
    const w = liveTracker(wrong);
    for (const r of bare) w.opencodeStep({ model: r.model, tokens: { input: r.input, output: r.output, reasoning: r.reasoning, cache: { read: r.cacheRead, write: r.cacheWrite } }, ...(r.cost !== undefined ? { reportedUsd: r.cost } : {}), ...(r.side ? { side: true } : {}) });
    expect(wrong.entries.find((e) => e.kind === "usage" && e.assumptions.includes("side-model-assumed"))).toMatchObject({ ownMicros: 9 });
    const diff = wrong.entries.filter((e) => e.kind === "observation" && e.scope === "request" && e.reportedMicros !== e.ownMicros);
    expect(diff.map((e) => [(e as { reportedMicros: number }).reportedMicros, (e as { ownMicros: number }).ownMicros, (e as { cause?: string }).cause])).toEqual([[141, 9, "side-model-assumed"]]);
    // The pick is OpenCode's own: a deprecated model is not a candidate, and the order of families decides (flash before haiku), per provider.
    const picked = await figures(capture(LIVE), { session: "ses_REDACTED0001", models: [
      { id: "deepseek/deepseek-v4-flash", providerID: "openrouter", limit: { context: 1_048_576 } },
      { id: "anthropic/claude-haiku-4.5", providerID: "openrouter", family: "claude-haiku", status: "active" },
      { id: "google/gemini-3-flash", providerID: "openrouter", family: "gemini-flash", status: "active" },
      { id: "openai/gpt-6-luna", providerID: "openrouter", family: "gpt-luna", status: "deprecated" },
      { id: "gpt-6-luna", providerID: "openai", family: "gpt-luna", status: "active" },
    ] });
    expect(picked.steps!.find((s) => s.side)!.model).toBe("openrouter/google/gemini-3-flash");
    // The running total's difference is the same assumption's, named so (not `unexplained`).
    w.reportedCumulative(f.costUsd!);
    // A total ahead of ours waits for the records that catch ours up (BUG-472); none will, so the session's end judges it.
    w.ended();
    expect(wrong.entries.filter((e) => e.kind === "observation" && e.scope === "cumulative").map((e) => (e as { cause?: string }).cause)).toEqual(["side-model-assumed"]);
    expect(reportLines(wrong.entries).join("\n")).toContain("opencode side-model-assumed");
  });

  test("a resumed session (live run 2): its history is a baseline, so only this launch's step is cost (the footer's $0.00 and 7,463 tokens), and no title is read out of the history", async () => {
    const saved = process.env.GLUON_RESUMED;
    process.env.GLUON_RESUMED = "1";
    try {
      const f = await figures(capture("opencode-2.0.21-live-resume-events.jsonl"), { models: live, session: "ses_REDACTED0003" });
      expect(f).toMatchObject({ contextTokens: 7_463, contextWindow: 1_048_576 });
      expect(f.costUsd).toBeCloseTo(0.00018477759999999997, 12);
      expect(f.steps!.map((s) => !!s.side)).toEqual([false]);
      expect(contextLabel(ownPercent("opencode", 7_463, 1_048_576))).toBe("1%");
    } finally {
      saved === undefined ? delete process.env.GLUON_RESUMED : (process.env.GLUON_RESUMED = saved);
    }
  });
});

describe("issue #39, live run 2 (paid, API keys): what each harness displayed, step by step", () => {
  const statusLines = (name: string) =>
    readFileSync(join(DIR, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { model: { id: string }; cost: { total_cost_usd: number }; context_window: { used_percentage: number | null; current_usage: Record<string, number> | null } });
  /** The percentages Claude Code's own status line showed over the run, one per change; after a /compact it says 0 for a usage of zero tokens (unknown), which Gluon shows as —. */
  const shownPct = (name: string) => {
    const seq = statusLines(name)
      .filter((s) => s.context_window.used_percentage !== null)
      .map((s) => (Object.values(s.context_window.current_usage ?? {}).every((n) => n === 0) ? null : s.context_window.used_percentage));
    return seq.filter((v, i) => i === 0 || v !== seq[i - 1]);
  };
  const claudeRun = async (telemetry: string, launched: string, key: string) => {
    const { usages, contexts } = await replay(telemetry);
    const ledger = new Ledger();
    const tracker = frozenTracker({ harness: "claude-code", conn: "anthropic", launchedKey: key, ledger });
    for (const u of usages) if (u.harness === "claude-code") tracker.claudeRequest(u);
    // The row's % as Gluon computes it: the request's prompt over Gluon's own window (the launched `[1m]` and the peak size it).
    const peaks = new Map<string, number>();
    const pct = contexts.map((c) => {
      if (!c) return null;
      peaks.set(c.model!, Math.max(peaks.get(c.model!) ?? 0, c.tokens));
      return Math.round(ownPercent("claude-code", c.tokens, ownWindow("claude-code", c.model, { launchedModel: launched, peak: peaks.get(c.model!) }).window)!);
    });
    return { tracker, ledger, usages, pct: pct.filter((v, i) => i === 0 || v !== pct[i - 1]) };
  };

  test("Claude Code Haiku 4.5 (200k): Gluon's own total is the micro-dollar sum of its requests (107,616) = what the status line and /cost showed ($0.1076), no request differs, the % follows each step, and — after /compact", async () => {
    const { tracker, ledger, usages, pct } = await claudeRun("claude-code-2.1.289-live-api-haiku-telemetry.jsonl", "claude-haiku-4-5", "anthropic/claude-haiku-4-5");
    const shown = statusLines("claude-code-2.1.289-live-api-haiku-statusline.jsonl");
    expect(usages.length).toBe(17);
    expect(Math.round(tracker.figure()!.usd * 1e6)).toBe(107_616);
    // /cost: "Total cost: $0.1076"; the status line's last total: 0.10761585 (Claude's own sum of unrounded costs).
    expect(Math.round(shown.at(-1)!.cost.total_cost_usd * 1e6)).toBe(107_616);
    expect(tracker.figure()!.usd.toFixed(4)).toBe("0.1076");
    const requests = ledger.entries.filter((e) => e.kind === "observation");
    expect(requests.length).toBe(17);
    expect(requests.filter((o) => o.kind === "observation" && o.reportedMicros !== o.ownMicros)).toEqual([]);
    expect(pct).toEqual([12, 13, null, 12]);
    expect(pct).toEqual(shownPct("claude-code-2.1.289-live-api-haiku-statusline.jsonl"));
  });

  test("Claude Code Opus 4.6 [1m]: 394,424 (Claude's own OTEL total and status line: 0.39442375), every request equal, the % of a 1M window at each step (2, 3, —, 2), a Haiku title request and a subagent included", async () => {
    const { tracker, ledger, pct } = await claudeRun("claude-code-2.1.289-live-api-opus-4-6-1m-telemetry.jsonl", "claude-opus-4-6[1m]", "anthropic/claude-opus-4-6");
    expect(Math.round(tracker.figure()!.usd * 1e6)).toBe(394_424);
    const shown = statusLines("claude-code-2.1.289-live-api-opus-4-6-1m-statusline.jsonl");
    expect(shown.at(-1)!.cost.total_cost_usd).toBeCloseTo(0.39442375, 9);
    // /cost: "Total cost: $0.3944", Opus $0.3928 + Haiku (the title) $0.0016.
    expect(tracker.figure()!.usd.toFixed(4)).toBe("0.3944");
    expect(ledger.entries.filter((e) => e.kind === "observation" && e.reportedMicros !== e.ownMicros)).toEqual([]);
    expect(new Set(ledger.entries.filter((e) => e.kind === "usage").map((e) => (e as { model: string }).model))).toEqual(new Set(["claude-opus-4-6", "claude-haiku-4-5-20251001"]));
    expect(pct).toEqual([2, 3, null, 2]);
    expect(pct).toEqual(shownPct("claude-code-2.1.289-live-api-opus-4-6-1m-statusline.jsonl"));
    // The OTEL metric's running total is the same to the last digit.
    const { costs } = await replay("claude-code-2.1.289-live-api-opus-4-6-1m-telemetry.jsonl");
    expect(costs.at(-1)).toBeCloseTo(0.39442375, 9);
  });

  test("BUG-381/report-running-total: the running total is compared at its last sample per launch: the samples that were in flight (the plugin's ahead of the telemetry's) are not 64 differences, and the final totals agree", async () => {
    const shown = statusLines("claude-code-2.1.289-live-api-haiku-statusline.jsonl");
    const ledger = new Ledger();
    const tracker = frozenTracker({ harness: "claude-code", conn: "anthropic", launchedKey: "anthropic/claude-haiku-4-5", ledger });
    const { usages } = await replay("claude-code-2.1.289-live-api-haiku-telemetry.jsonl");
    // The plugin's samples (the status line's total) arrive ahead of the telemetry's requests: each sample is taken before the requests it includes are priced.
    const claude = usages.filter((u) => u.harness === "claude-code");
    const samples = shown.map((s) => s.cost.total_cost_usd);
    for (const [i, u] of claude.entries()) {
      tracker.observeCost(samples[Math.min(samples.length - 1, Math.ceil(((i + 1) * samples.length) / claude.length))]!);
      tracker.claudeRequest(u as never);
    }
    tracker.observeCost(samples.at(-1)!);
    // The session ends: a sample still ahead of ours is judged now (BUG-472).
    tracker.ended();
    const cumulative = ledger.entries.filter((e) => e.kind === "observation" && e.scope === "cumulative");
    expect(cumulative.length).toBeGreaterThan(10);
    // The report counts the last sample only, and says the others were in flight.
    const text = reportLines(ledger.entries).join("\n");
    expect(text).toContain("running total: 1 observation, 0 differ");
    expect(text).toContain(`${cumulative.length - 1} earlier running-total samples left out`);
    expect(ledger.divergences()).toEqual([]);
  });
});

describe("issue #39, live run 2 (paid): Codex 0.159.3 on an OpenAI API key, /status at each step", () => {
  type Line = { t: number; event?: string };
  const hooks = readFileSync(join(DIR, "codex-0.159.3-live-api-luna-hook-events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
  /** What Gluon heard from the hooks over the run, in order: the thread each hook ran in (`session <id>`, which `setMainConversation` takes) and a compaction starting. */
  const heard = hooks.filter((h) => h.event).map((h) => ({ t: h.t, event: h.event! }));
  const telemetry = jsonl("codex-0.159.3-live-api-luna-telemetry.jsonl").map((line) => {
    const logs = (line.body as { resourceLogs: { scopeLogs: { logRecords: { observedTimeUnixNano: string }[] }[] }[] }).resourceLogs;
    const at = Math.max(...logs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((r) => Number(BigInt(r.observedTimeUnixNano) / 1_000_000n)))));
    return { ...line, at };
  });
  /** The run as it happened: telemetry batches and hook events interleaved by time. `follow`: whether the hooks name the main thread (Gluon's `onMainSession`). */
  async function run({ follow = true }: { follow?: boolean } = {}) {
    const contexts: (ContextFigure | null)[] = [];
    const usages: UsageEvent[] = [];
    const s = server.session({ onContext: (c) => contexts.push(c), onUsage: (u) => usages.push(u) });
    const mains: string[] = [];
    const timeline = [...telemetry.map((x) => ({ at: x.at, post: x })), ...heard.map((h) => ({ at: h.t, event: h.event }))].sort((a, b) => a.at - b.at);
    for (const step of timeline) {
      if ("post" in step) await fetch(`${server.endpoint}${step.post.path}`, { method: "POST", headers: { "content-type": "application/json", [TELEMETRY_HEADER]: s.token }, body: JSON.stringify(step.post.body) });
      else if (step.event.startsWith("session ") && follow) {
        const id = step.event.slice(8);
        if (mains.at(-1) !== id) {
          mains.push(id);
          s.setMainConversation(id);
        }
      } else if (step.event.includes('"compacting":true')) s.expectCompaction();
      // The context after each step: what the row would show next.
    }
    s.close();
    return { contexts, usages, mains };
  }

  test("the context is the main thread's last response (input + output), 0% of the 258K window as /status said (100% left); a spawned agent's and the title thread's requests are no context; the compaction's own request is —", async () => {
    const { contexts } = await run();
    const seq = contexts.map((c) => c?.tokens ?? null);
    // /status: 11.1K, 11.5K, 11.8K, 12K, then compacted (Codex showed 5.42K: Gluon says unknown), then 11.5K (11,541), the fork's 11.8K.
    expect(seq.slice(0, 9)).toEqual([11_137, 11_470, 11_514, 11_666, 11_709, 11_808, 11_882, 11_924, 12_003]);
    expect(seq.slice(9, 11)).toEqual([null, 11_541]);
    const window = ownWindow("codex", contexts[0]!.model);
    expect(window.window).toBe(258_400);
    // The footer says "100% left" at each: 0% used (the 12K baseline comes off both sides).
    for (const c of contexts.filter((c) => c)) expect(Math.round(ownPercent("codex", c!.tokens, window.window)!)).toBe(0);
  });

  test("BUG-382/codex-fork-follows: after /fork the hooks run in the new thread (a new session_id); the context follows it from its first response, and not before (the old thread's figure stays until then)", async () => {
    const { contexts, mains } = await run();
    // The thread the hooks named: the first, then the fork's (conversation ids of the telemetry are the same ids).
    expect(mains.length).toBe(2);
    const seq = contexts.map((c) => c?.tokens ?? null);
    // The fork's two responses: 11,564 + 211 and 11,814 + 29 (Codex's /status: 11.8K used).
    expect(seq.slice(-2)).toEqual([11_775, 11_843]);
    // Without the hooks naming the fork (follow off) the first conversation stays the main one: the fork's responses are no context of it.
    const first = (await run({ follow: false })).contexts.map((c) => c?.tokens ?? null);
    expect(first.slice(-1)).toEqual([11_541]);
  });

  test("BUG-383/codex-api-key-no-turn-noise: an API-key launch gets no codex.turn_cost (the ChatGPT login only): nothing is pending, nothing dropped, no turn observation, however long it runs", async () => {
    const { usages } = await run();
    const ledger = new Ledger();
    let now = 0;
    const tracker = frozenTracker({ harness: "codex", conn: "openai", launchedKey: "openai/gpt-6-luna", ledger, now: () => now });
    for (const u of usages) if (u.harness === "codex") tracker.codexResponse(u);
    tracker.codexTurnEnded();
    now += 3 * 60 * 60_000;
    tracker.codexTurnEnded();
    expect(ledger.entries.filter((e) => e.kind === "usage").length).toBe(18);
    expect(ledger.entries.filter((e) => e.kind !== "usage")).toEqual([]);
    expect(reportLines(ledger.entries).join("\n")).not.toMatch(/dropped|did not count|per turn/);
    expect(tracker.figure()).toMatchObject({ own: true });
  });

  test("BUG-384/codex-usage-semantics: input_token_count includes the cached and the written tokens, output the reasoning, and service_tier is the requested tier — the real response (11,162 in, 11,129 cached, 30 written, 308 out of which 219 reasoning, priority) is priced so", async () => {
    const { usages } = await run();
    const real = usages.find((u) => u.harness === "codex" && u.input === 11_162);
    expect(real).toEqual({ harness: "codex", model: "gpt-6-luna", input: 11_162, cached: 11_129, cacheWrite: 30, output: 308, serviceTier: "priority" });
    const entry = frozenEntry("openai/gpt-6-luna")!;
    const { input, output, cache_read, cache_write } = entry.cost as { input: number; output: number; cache_read: number; cache_write: number };
    // 3 uncached + 11,129 cached + 30 written, and 308 output (the reasoning is inside it, not added): the standard row...
    const standard = Math.round(3 * input + 11_129 * cache_read + 30 * cache_write + 308 * output);
    expect(codexCost(entry, { input: 11_162, cached: 11_129, cacheWrite: 30, output: 308 }).micros).toBe(standard);
    // ...and the priority tier's priced mode (the assumption `service-tier-requested`).
    const fast = codexCost(entry, { input: 11_162, cached: 11_129, cacheWrite: 30, output: 308, serviceTier: "priority" });
    expect(fast.assumptions).toContain("service-tier-requested");
    expect(fast.micros).toBeGreaterThanOrEqual(standard);
  });
});

describe("issue #39, live run 2 (paid, Google account): Antigravity 1.2.16 on gemini-3.8-flash, step by step", () => {
  type Reading = { t: number; stdin: Record<string, unknown> & { conversation_id: string; agent_state: string; context_window: { total_input_tokens: number; used_percentage: number; current_usage: { input_tokens: number } | null } } };
  const readings = readFileSync(join(DIR, "agy-1.2.16-live-gemini-3.8-flash-statusline.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Reading);
  /** The moments the screen was read after each step of the run (T1, T2, the subagent turn, T4, `/clear` + T5), in the status line's clock. */
  const STEPS = { t1: 1791145423195, t2: 1791145453721, sub: 1791145497766, t4: 1791145655019, clear: 1791145682334 };
  const at = (t: number) => [...readings].reverse().find((r) => r.t <= t)!;
  /** The row as Gluon draws it after one reading: the hook's status, then `agyContextTokens` as `src/gluon.ts` calls it, over Gluon's own window. */
  async function row(shown: number | undefined, r: Reading) {
    const hook = await antigravity.hook!("statusline", JSON.stringify(r.stdin), { eventsDir: "/x", pieces: [] });
    const st = parseStatus(JSON.stringify(hook.events![0]!.status))!;
    const tokens = st.totals ? agyContextTokens(st.totals, shown) : undefined;
    return { tokens, st };
  }
  const label = (tokens: number) => contextLabel(ownPercent("antigravity", tokens, frozenWindow("google/gemini-3.8-flash")));

  test("BUG-388/agy-context-is-total-input: the % is total_input_tokens over Gluon's window (models.dev, 1,048,576), as agy counts its own: 1.67, 1.70, 1.80, 1.82 and 1.60 after each step, not current_usage's 1.2% (the last request's prompt)", async () => {
    const window = frozenWindow("google/gemini-3.8-flash")!;
    expect(window).toBe(1_048_576);
    expect(ownWindow("antigravity", "gemini-3.8-flash").source).toBe("agy-table");
    const steps = Object.values(STEPS).map(at);
    const pcts = steps.map((r) => ownPercent("antigravity", r.stdin.context_window.total_input_tokens, window)!);
    expect(pcts.map((p) => p.toFixed(2))).toEqual(["1.67", "1.70", "1.80", "1.82", "1.60"]);
    // The same figure agy printed (its used_percentage), to the last digit: it only audits ours.
    for (const [i, r] of steps.entries()) expect(pcts[i]).toBeCloseTo(r.stdin.context_window.used_percentage, 9);
    // The rows read 2% each; the request's prompt (12,406..14,341 tokens) would have read 1%.
    expect(steps.map((r) => label(r.stdin.context_window.total_input_tokens))).toEqual(["2%", "2%", "2%", "2%", "2%"]);
    expect(steps.slice(0, 4).map((r) => label(r.stdin.context_window.current_usage!.input_tokens))).toEqual(["1%", "1%", "1%", "1%"]);
    // agy names its model with a display name (`Gemini 3.8 Flash (Low)`), which no model id is: the launched model sizes it.
    expect((await row(undefined, steps[0]!)).st.model).toBeUndefined();
    expect(ownWindow("antigravity", undefined, { launchedModel: "gemini-3.8-flash" })).toEqual(ownWindow("antigravity", "gemini-3.8-flash"));
  });

  test("BUG-389/agy-clear-shows-the-new-conversation: after /clear (a new conversation id, the totals back to zero, no current_usage) the next reading is the row's figure at once; the old 19,098 tokens are never kept", async () => {
    let shown: number | undefined;
    const seen: { id: string; tokens: number; label: string }[] = [];
    for (const r of readings) {
      const { tokens } = await row(shown, r);
      if (tokens !== undefined) {
        shown = tokens;
        seen.push({ id: r.stdin.conversation_id.slice(-2), tokens, label: label(tokens) });
      }
    }
    // The first reading is zero (a launch), then the conversation's size after each request, and the new conversation's zero and 16,781.
    expect(seen.map((s) => s.tokens)).toEqual([0, 17_487, 17_539, 17_876, 18_045, 18_345, 18_606, 18_884, 19_098, 0, 16_781]);
    expect(seen.map((s) => s.id).slice(-3)).toEqual(["17", "18", "18"]);
    // The reading right after the new conversation id: 0, never 19,098; no reading of the old conversation follows it.
    const clearAt = readings.findIndex((r) => r.stdin.conversation_id.endsWith("18"));
    expect(readings[clearAt]!.stdin.context_window.current_usage).toBeNull();
    expect((await row(19_098, readings[clearAt]!)).tokens).toBe(0);
    expect(readings.slice(clearAt).every((r) => r.stdin.conversation_id.endsWith("18"))).toBe(true);
    // A redraw of the same figure changes nothing.
    expect((await row(16_781, at(STEPS.clear))).tokens).toBeUndefined();
  });

  test("BUG-387/agy-no-cost: nothing in the run is priced: the status line holds the conversation's size, which grew by 18,884 - 17,487 tokens over the run while the requests (a subagent's among them, absent from it) billed more; the row's cost is — and agy reports none", async () => {
    for (const r of readings) {
      expect(r.stdin).not.toHaveProperty("cost");
      expect((await row(undefined, r)).st.costUsd).toBeUndefined();
    }
    const ledger = new Ledger();
    const tracker = frozenTracker({ harness: "antigravity", conn: "plan", launchedKey: "google/gemini-3.8-flash", ledger });
    for (const r of readings) tracker.observeContext({ own: { tokens: r.stdin.context_window.total_input_tokens, window: 1_048_576 }, reported: { pct: r.stdin.context_window.used_percentage } });
    expect(tracker.figure()).toBeUndefined();
    expect(costLabel(tracker.figure())).toBe("—");
    // Our context is agy's to the digit: every observation agrees.
    const contexts = ledger.entries.filter((e) => e.kind === "context") as { cause?: string }[];
    expect(contexts.length).toBeGreaterThan(80);
    expect(new Set(contexts.map((c) => c.cause))).toEqual(new Set(["none"]));
    expect(ledger.entries.some((e) => e.kind === "usage" || e.kind === "observation" && e.what === "cost")).toBe(false);
  });
});

describe("issue #39, live run 2 (paid, SuperGrok subscription): Grok Build 1.0.46 on grok-4.7, step by step", () => {
  type Value = { stringValue?: string; intValue?: string; boolValue?: boolean };
  type Batch = { t: number; path: string; body: { resourceLogs: { scopeLogs: { logRecords: { timeUnixNano: string; attributes: { key: string; value: Value }[] }[] }[] }[] } };
  /** The logs Gluon received, in order (`t`: when, in ms). The capture keeps them decoded; Grok sends protobuf, which `protobuf` rebuilds for the listener. The metrics batches (dropped by Gluon) were not kept. */
  const batches = readFileSync(join(DIR, "grok-1.0.46-live-subscription-telemetry.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Batch).filter((b) => b.path === "/v1/logs");
  const protobuf = (b: Batch) =>
    encodeLogs(b.body.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords)).map((r) => ({ time: BigInt(r.timeUnixNano), attributes: Object.fromEntries(r.attributes.map(({ key, value }) => [key, value.stringValue ?? (value.intValue !== undefined ? Number(value.intValue) : value.boolValue)!])) })));
  /** The moments the screen was read after each step (T1, T2, the subagent turn, `/compact`, T4), in the telemetry's clock, and `grok usage`'s own output then. */
  const STEPS = [
    { name: "t1", mark: 1791143833678, usage: "t1" },
    { name: "t2", mark: 1791143866244, usage: "t2" },
    { name: "sub", mark: 1791143970587, usage: "sub" },
    { name: "compact", mark: 1791144006793, usage: "compact" },
    { name: "t4", mark: 1791144028867, usage: "t4" },
  ];
  const report = (name: string) => parseGrokUsage(readFileSync(join(DIR, `grok-1.0.46-live-usage-${name}.json`), "utf8"))!;
  const wall = (name: string) => Date.parse((JSON.parse(readFileSync(join(DIR, `grok-1.0.46-live-usage-${name}.json`), "utf8")) as { updatedAt: string }).updatedAt);
  /** The run replayed batch by batch: `to(t)` delivers what Gluon had received by `t`. */
  async function live() {
    const ledger = new Ledger();
    const tracker = frozenTracker({ harness: "grok-build", conn: "plan", launchedKey: "xai/grok-4.7", ledger });
    const usages: Extract<UsageEvent, { harness: "grok-build" }>[] = [];
    const contexts: (ContextFigure | null)[] = [];
    const s = server.session({ onUsage: (u) => (u.harness === "grok-build" && (usages.push(u), tracker.grokRequest(u)), undefined), onContext: (c) => contexts.push(c) });
    let next = 0;
    const to = async (t: number) => {
      for (; next < batches.length && batches[next]!.t <= t; next++) {
        const r = await fetch(`${server.endpoint}/v1/logs`, { method: "POST", headers: { "content-type": "application/x-protobuf", [TELEMETRY_HEADER]: s.token }, body: protobuf(batches[next]!) });
        expect(r.status).toBe(200);
      }
    };
    return { ledger, tracker, usages, contexts, to, close: () => s.close() };
  }
  const micros = (tracker: CostTracker) => Math.round((tracker.figure()?.usd ?? 0) * 1e6);
  const requestObs = (ledger: Ledger) => ledger.entries.filter((e) => e.kind === "observation" && e.scope === "request") as { ownMicros: number; reportedMicros: number; cause: string }[];
  const cumulativeObs = (ledger: Ledger) => ledger.entries.filter((e) => e.kind === "observation" && e.scope === "cumulative") as { ownMicros: number; reportedMicros: number; cause: string }[];

  test("every one of the 8 requests (a subagent's two among them) is Grok's own cost_usd_micros to the micro, at the table's rates; the 200k tier never applies", async () => {
    const f = await live();
    await f.to(Infinity);
    f.close();
    expect(f.usages.map((u) => u.reportedMicros)).toEqual([25_722, 15_072, 8_834, 10_532, 18_124, 5_500, 9_242, 34_118]);
    expect(requestObs(f.ledger).map((o) => [o.ownMicros, o.reportedMicros, o.cause])).toEqual(f.usages.map((u) => [u.reportedMicros!, u.reportedMicros!, "none"]));
    // The first: 13,512 input of which 1,152 read from the cache, 71 out (70 of them reasoning, inside the output).
    expect(f.usages[0]).toMatchObject({ input: 13_512, cacheRead: 1_152, output: 71, reasoning: 70, session: expect.any(String) });
    expect(f.tracker.figure()).toMatchObject({ approx: true, own: true });
  });

  test("the row after each step is the sum of the requests so far, and grok usage's own total to the micro: ~$0.03, ~$0.05, ~$0.09, ~$0.09 (the compaction adds nothing), ~$0.13", async () => {
    const f = await live();
    const rows: string[] = [];
    for (const step of STEPS) {
      await f.to(step.mark);
      expect(micros(f.tracker)).toBe(report(step.usage).micros!);
      rows.push(costLabel(f.tracker.figure()));
    }
    f.close();
    expect(rows).toEqual(["~$0.03", "~$0.05", "~$0.09", "~$0.09", "~$0.13"]);
    expect(STEPS.map((s) => report(s.usage).micros)).toEqual([25_722, 49_628, 93_026, 93_026, 127_144]);
  });

  test("BUG-396/grok-4.7-footer-percent: the context % after each step is the last main request's input + output over Grok's own 256K window for grok-4.7 (its footer read 13K / 256K, then 17K / 256K): 5, 7, 7, — after /compact, 7 (it was 3-4 over models.dev's 500K)", async () => {
    const f = await live();
    const labels: string[] = [];
    for (const step of STEPS) {
      await f.to(step.mark);
      const c = f.contexts.at(-1)!;
      labels.push(contextLabel(c ? ownPercent("grok-build", c.tokens, ownWindow("grok-build", c.model ?? "grok-4.7").window) : undefined));
    }
    f.close();
    expect(labels).toEqual(["5%", "7%", "7%", "—", "7%"]);
  });

  test("BUG-390/grok-usage-race: grok usage is read 0.4 to 1.5 s before the turn's last OTLP batch reaches Gluon, so each report waits for the requests it counts and is then equal to ours: no 'unexplained' difference, no dropped entry", async () => {
    const f = await live();
    // The best case for the old code: the report is looked at the instant Grok persisted it.
    const naive: number[] = [];
    const waiting: number[] = [];
    for (const step of STEPS) {
      const r = report(step.usage);
      await f.to(wall(step.usage));
      naive.push(r.micros! - micros(f.tracker));
      f.tracker.grokUsageReport(r);
      // The audits made so far, with this report's among them if all its requests were already here.
      waiting.push(cumulativeObs(f.ledger).length);
      await f.to(step.mark);
    }
    f.close();
    // Compared at once, Gluon would have been short of Grok's total by the requests in flight: 25,722 (the whole first turn), 8,834, 9,242, nothing after /compact, 34,118 (the last request of each turn).
    expect(naive).toEqual([25_722, 8_834, 9_242, 0, 34_118]);
    expect(waiting).toEqual([0, 1, 2, 4, 4]);
    expect(cumulativeObs(f.ledger).map((o) => [o.ownMicros, o.reportedMicros, o.cause])).toEqual([[25_722, 25_722, "none"], [49_628, 49_628, "none"], [93_026, 93_026, "none"], [93_026, 93_026, "none"], [127_144, 127_144, "none"]]);
    expect(f.ledger.entries.filter((e) => e.kind === "dropped")).toEqual([]);
    expect(reportLines(f.ledger.entries).join("\n")).not.toMatch(/unexplained|dropped/);
  });

  test("BUG-391/grok-usage-includes-subagents: turn 3 is 4 model calls and $0.043398 in grok usage: the main thread's first and last request and the subagent's two; ours matches with no named 'subagent' cause", async () => {
    const f = await live();
    await f.to(Infinity);
    f.close();
    const r = report("sub");
    expect(r.modelCalls).toBe(7);
    const turn3 = JSON.parse(readFileSync(join(DIR, "grok-1.0.46-live-usage-sub.json"), "utf8")).turns[2] as { modelCalls: number; costUsdTicks: number };
    expect([turn3.modelCalls, turn3.costUsdTicks / 1e4]).toEqual([4, 43_398]);
    // The requests of that turn, by the telemetry: 17,080 (before the subagent launched), the subagent's 9,461 and 9,680, then 17,455.
    const turn = f.usages.slice(3, 7);
    expect(turn.map((u) => [u.input, u.subagent])).toEqual([[17_080, false], [9_461, true], [9_680, true], [17_455, false]]);
    expect(turn.reduce((n, u) => n + u.reportedMicros!, 0)).toBe(43_398);
    // Audited at 7 requests, the subagent's among them, equal.
    const g = frozenTracker({ harness: "grok-build", conn: "plan", launchedKey: "xai/grok-4.7", ledger: new Ledger() });
    for (const u of f.usages.slice(0, 7)) g.grokRequest(u);
    g.grokUsageReport(r);
    expect(micros(g)).toBe(r.micros!);
    expect(cumulativeObs((g as unknown as { o: { ledger: Ledger } }).o.ledger).map((o) => o.cause)).toEqual(["none"]);
  });

  test("BUG-392/grok-compaction-unpriced: /compact emits grok_code.compaction and no api_request: nothing is priced for it, the context is unknown, grok usage right after it counts no new call and no new cost, and the audit finds no difference", async () => {
    const f = await live();
    await f.to(STEPS[2]!.mark);
    const before = { usages: f.usages.length, own: micros(f.tracker), contexts: f.contexts.length };
    await f.to(STEPS[3]!.mark);
    // Only the compaction record arrived: no request, no price, a context of null.
    expect([f.usages.length, micros(f.tracker)]).toEqual([before.usages, before.own]);
    expect(f.contexts.slice(before.contexts)).toEqual([null]);
    expect(JSON.stringify(batches.map((b) => b.body))).toContain("grok_code.compaction");
    const [sub, compact] = [report("sub"), report("compact")];
    expect([compact.modelCalls, compact.micros, compact.turns]).toEqual([sub.modelCalls, sub.micros, sub.turns]);
    f.tracker.grokUsageReport(compact);
    expect(cumulativeObs(f.ledger).map((o) => [o.ownMicros, o.reportedMicros, o.cause])).toEqual([[93_026, 93_026, "none"]]);
    expect(f.ledger.entries.filter((e) => e.kind === "dropped")).toEqual([]);
    // The next request carries on from the old size: 4%.
    await f.to(Infinity);
    expect(f.contexts.at(-1)).toMatchObject({ tokens: 17_885 });
    f.close();
  });
});

describe("openrouter/* prices come from OpenRouter's own listing (BUG-469)", () => {
  // The live audit: models.dev had input 0.3 / output 1.2 for deepseek-v4.1-flash; OpenRouter listed (and billed) 0.003 / 2.4 per million.
  const listing = {
    data: [
      { id: "deepseek/deepseek-v4.1-flash", context_length: 1_048_576, pricing: { prompt: "0.000000003", completion: "0.0000024", input_cache_read: "0.000000003" } },
      { id: "anthropic/claude-haiku-4.5", context_length: 200_000, pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000001", input_cache_write: "0.00000125" } },
      { id: "google/gemini-3.6-flash", pricing: { prompt: "0.00000075", completion: "0.00000375", input_cache_write: "0.0000000416667" } },
      { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
      { id: "acme/new", context_length: 64_000, pricing: { prompt: "0.000002", completion: "0.000004" } },
    ],
  };
  const dsKey = "openrouter/deepseek/deepseek-v4.1-flash";
  const picked = {
    entries: {
      [dsKey]: { cost: { input: 0.3, output: 1.2, cache_read: 0.006 }, context: 1_048_576 },
      "openrouter/anthropic/claude-haiku-4.5": { cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 }, context: 200_000 },
      "openrouter/google/gemini-3.6-flash": { cost: { input: 0.75, output: 3.75, reasoning: 3.75, cache_write: 0.041667 }, context: 1_048_576 },
      "openrouter/not/listed": { cost: { input: 9, output: 9 }, context: null },
      "xai/grok-4.6": { cost: { input: 2, output: 6 }, context: 500_000 },
    } as Record<string, any>,
    missing: [] as string[],
  };

  test("BUG-469/openrouter-listing: the listing's per-token price (prompt, completion, cache read and write) replaces models.dev's, per million, and says so; models.dev's is kept where they differ", () => {
    const { entries, missing } = applyOpenRouter(picked.entries, picked.missing, listing, new Set([dsKey]));
    expect(missing).toEqual([]);
    expect(entries[dsKey]).toEqual({ cost: { input: 0.003, output: 2.4, cache_read: 0.003 }, context: 1_048_576, priceSource: "openrouter", modelsdevCost: { input: 0.3, output: 1.2, cache_read: 0.006 } });
    // Agreeing prices stay as they were (no modelsdevCost), and the float noise of a per-token string is gone.
    expect(entries["openrouter/anthropic/claude-haiku-4.5"]).toEqual({ cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 }, context: 200_000, priceSource: "openrouter" });
    // A rounding-level difference keeps models.dev's number; a field the listing has no price for (reasoning) stays.
    expect(entries["openrouter/google/gemini-3.6-flash"]).toEqual({ cost: { input: 0.75, output: 3.75, reasoning: 3.75, cache_write: 0.041667 }, context: 1_048_576, priceSource: "openrouter" });
    // A model the listing lacks and another connection's entry are untouched.
    expect(entries["openrouter/not/listed"]).toEqual(picked.entries["openrouter/not/listed"]);
    expect(entries["xai/grok-4.6"]).toEqual(picked.entries["xai/grok-4.6"]);
    // Only the listing's own table keys enter: the router's -1 is no price, and a model nothing wants is not added.
    expect(Object.keys(entries)).not.toContain("openrouter/openrouter/auto");
    expect(Object.keys(entries)).not.toContain("openrouter/acme/new");
  });

  test("BUG-469/openrouter-listing: a wanted openrouter key models.dev has no price for is taken from the listing, not left missing", () => {
    const { entries, missing } = applyOpenRouter({}, ["openrouter/acme/new", "openrouter/acme/gone", "xai/grok-9"], listing, new Set(["openrouter/acme/new", "openrouter/acme/gone", "xai/grok-9"]));
    expect(entries["openrouter/acme/new"]).toEqual({ cost: { input: 2, output: 4 }, context: 64_000, priceSource: "openrouter" });
    expect(missing).toEqual(["openrouter/acme/gone", "xai/grok-9"]);
  });

  test("BUG-474/openrouter-tiers: models.dev's long-context tier stays where OpenRouter lists one and goes where it lists none (a flat price)", () => {
    const tier = { input: 10, output: 37.5, tier: { type: "context", size: 200_000 } };
    const flat = "openrouter/anthropic/claude-opus-4.7";
    const tiered = "openrouter/openai/gpt-5.4";
    const l = {
      data: [
        { id: "anthropic/claude-opus-4.7", pricing: { prompt: "0.000005", completion: "0.000025" } },
        { id: "openai/gpt-5.4", pricing: { prompt: "0.0000025", completion: "0.000015", overrides: [{ min_prompt_tokens: 272_000, prompt: "0.000005", completion: "0.0000225" }] } },
      ],
    };
    const entries = { [flat]: { cost: { input: 5, output: 25, tiers: [tier], context_over_200k: { input: 10, output: 37.5 } }, context: 1_000_000 }, [tiered]: { cost: { input: 2.5, output: 15, tiers: [{ ...tier, input: 5, output: 22.5, tier: { type: "context", size: 272_000 } }] }, context: 1_050_000 } } as Record<string, any>;
    const r = applyOpenRouter(entries, [], l, new Set([flat, tiered])).entries as Record<string, any>;
    expect(r[flat].cost).toEqual({ input: 5, output: 25 });
    expect(r[tiered].cost.tiers).toEqual(entries[tiered].cost.tiers);
    // The committed table: no openrouter/* entry carries a tier while the listing had none (today's three Claude rows).
    const bundled = BUNDLED_TABLES.modelsdev.entries as Record<string, any>;
    for (const k of ["anthropic/claude-opus-4.6", "anthropic/claude-opus-4.7", "anthropic/claude-sonnet-4.6"]) expect(bundled[`openrouter/${k}`].cost.tiers).toBeUndefined();
  });

  test("BUG-493/openrouter-endpoints: the generator records each wanted openrouter model's endpoint count and price range; the schema holds the shape", () => {
    const ep = (prompt: string, completion: string) => ({ pricing: { prompt, completion } });
    const reply = { data: { endpoints: [ep("0.000000365", "0.000013"), ep("0.0000045", "0.0000225"), ep("0.000001", "0.00002"), { pricing: { prompt: "x" } }] } };
    expect(endpointRange(reply)).toEqual({ count: 3, input: { min: 0.365, max: 4.5 }, output: { min: 13, max: 22.5 } });
    expect(endpointRange({ data: { endpoints: [] } })).toBeUndefined();
    expect(endpointRange(null)).toBeUndefined();
    const key = "openrouter/moonshotai/kimi-k3";
    const entries = { [key]: { cost: { input: 1, output: 2 }, context: 1000, priceSource: "openrouter" as const }, "openrouter/not/wanted": { cost: { input: 1, output: 2 }, context: 1000, priceSource: "openrouter" as const }, "xai/grok-4.6": { cost: { input: 1, output: 2 }, context: 1000 } };
    const r = applyEndpoints(entries, new Set([key, "xai/grok-4.6"]), { "moonshotai/kimi-k3": reply, "not/wanted": reply });
    expect(r[key]!.endpoints).toEqual({ count: 3, input: { min: 0.365, max: 4.5 }, output: { min: 13, max: 22.5 } });
    // Not wanted, or not an OpenRouter-priced entry: none; a stale one is dropped when the model no longer has a reply.
    expect(r["openrouter/not/wanted"]!.endpoints).toBeUndefined();
    expect(r["xai/grok-4.6"]!.endpoints).toBeUndefined();
    expect(applyEndpoints(r, new Set([key]), {})[key]!.endpoints).toBeUndefined();
    // The validator takes the shape and refuses another one.
    const base = BUNDLED_TABLES.modelsdev as unknown as { entries: Record<string, Record<string, unknown>> };
    const table = (e: unknown) => JSON.stringify({ ...base, entries: { ...base.entries, [key]: { ...base.entries[key], endpoints: e } } });
    expect(parseTable("modelsdev", table(r[key]!.endpoints))).toHaveProperty("table");
    expect(parseTable("modelsdev", table({ count: 0, input: { min: 1, max: 2 }, output: { min: 1, max: 2 } }))).toHaveProperty("problem");
    expect(parseTable("modelsdev", table({ count: 2, input: { min: 1, max: 2 }, output: { min: 1, max: 2 }, url: "https://x.test" }))).toHaveProperty("problem");
  });

  test("BUG-477/openrouter-listing-empty: an error body or an empty listing fails the generator instead of leaving models.dev's prices in", () => {
    expect(() => applyOpenRouter(picked.entries, [], { data: [] }, new Set())).toThrow("no models");
    expect(() => applyOpenRouter(picked.entries, [], { error: { code: 429 } } as never, new Set())).toThrow("no models");
  });

  test("BUG-469/openrouter-listing: the committed table prices the audited model at OpenRouter's rate", () => {
    const row = (BUNDLED_TABLES.modelsdev.entries as Record<string, any>)[dsKey];
    expect(row.priceSource).toBe("openrouter");
    expect(row.cost).toMatchObject({ input: 0.003, output: 2.4 });
  });
});

describe("the price table reaches every model OpenCode can use on Gluon's connections (scripts/pricing/modelsdev.ts)", () => {
  const catalog = {
    openrouter: { models: { "acme/big": { cost: { input: 1, output: 2, cache_read: 0.1 }, limit: { context: 200_000 } }, "acme/free-text": { cost: { input: 0, output: 0 }, limit: { context: 32_000 } }, "acme/no-price": { limit: { context: 1 } }, "acme/odd": { cost: { input: "x", output: 1 } } } },
    xai: { models: { "grok-4.6": { cost: { input: 2, output: 6 }, limit: { context: 500_000 }, status: "beta", experimental: { modes: { fast: { cost: { input: 4, output: 12 }, provider: { body: { speed: "fast" } } }, pro: { cost: { input: 9, output: 9 } } } } }, "grok-x": { cost: { input: 1, output: 1 }, experimental: { modes: { fast: { cost: { input: 2, output: 2 }, provider: { body: { speed: "fast" } } } } } } } },
    "github-copilot": { models: { "gpt-6": { cost: { input: 1, output: 1 } } } },
  };

  test("issue-39/modelsdev-wide: the wanted models first (with their priced modes, `missing` when the catalog has none), then every other priced model of the providers OpenCode reaches; a provider Gluon has no connection to is left out", () => {
    const { entries, missing } = select(catalog as never, new Set(["xai/grok-4.6", "xai/grok-9"]), ["openrouter", "xai"]);
    expect(missing).toEqual(["xai/grok-9"]);
    expect(Object.keys(entries)).toEqual(["openrouter/acme/big", "openrouter/acme/free-text", "xai/grok-4.6", "xai/grok-x"]);
    // A mode with its own cost and a speed / tier is kept for a wanted model only; `pro` (no provider body) is no mode.
    expect(entries["xai/grok-4.6"]).toEqual({ cost: { input: 2, output: 6 }, context: 500_000, status: "beta", modes: { fast: { cost: { input: 4, output: 12 }, speed: "fast" } } });
    expect(entries["xai/grok-x"]).toEqual({ cost: { input: 1, output: 1 }, context: null });
    expect(entries["openrouter/acme/free-text"]!.cost).toEqual({ input: 0, output: 0 });
    expect(openCodeProviders()).toEqual(expect.arrayContaining(["amazon-bedrock", "openrouter", "opencode-go", "xai", "google", "anthropic", "openai"]));
    // The providers OpenCode used to be offered (Zen, Moonshot, …) are not connections any more.
    for (const gone of ["github-copilot", "opencode", "moonshotai", "zai", "deepseek", "alibaba", "meta"]) expect(openCodeProviders()).not.toContain(gone);
    // Every DEFAULT_MODELS key is wanted.
    expect(wantedKeys().has("openrouter/deepseek/deepseek-v4.1-flash")).toBe(true);
    expect(wantedKeys().has("opencode-go/deepseek-v4.1-flash")).toBe(true);
    // The maintainers' live-test model is priced too (it exists only behind the seam).
    expect(wantedKeys().has("amazon-bedrock/global.anthropic.claude-sonnet-4-6")).toBe(true);
    expect([...wantedKeys()].filter((k) => k.startsWith("amazon-bedrock/")).sort()).toEqual([
      "amazon-bedrock/global.anthropic.claude-fable-5-1",
      "amazon-bedrock/global.anthropic.claude-haiku-5-5",
      "amazon-bedrock/global.anthropic.claude-opus-5-5",
      "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
      "amazon-bedrock/global.anthropic.claude-sonnet-5-5",
      "amazon-bedrock/global.openai.gpt-6-astra",
      "amazon-bedrock/global.openai.gpt-6-luna",
      "amazon-bedrock/global.openai.gpt-6.1-sol",
    ]);
  });

  test("issue-39/modelsdev-format: one entry per line under a JSON header; it parses, and the same catalog gives the same bytes", () => {
    const { entries, missing } = select(catalog as never, new Set(["xai/grok-4.6"]), ["openrouter", "xai"]);
    const table = { schema: 1 as const, source: "models.dev", catalogUpdatedAt: "2026-10-01T00:00:00.000Z", generatedAt: "2026-10-04", catalogDigest: "ab".repeat(32), missing, entries };
    const text = format(table);
    expect(JSON.parse(text)).toEqual(table);
    expect(text.split("\n").filter((l) => l.startsWith('  "')).length).toBe(Object.keys(entries).length);
    expect(format(table)).toBe(text);
  });
});

describe("BUG-476/report-last-sample: the report compares the running total at its last sample per launch, whatever the earlier ones showed", () => {
  // BUG-381's guard, kept apart from replay data: BUG-472 settles in-flight samples, so a replay no longer produces earlier samples that differ.
  test("five earlier samples that differ are left out and counted; the last sample agrees: 0 differ", () => {
    const ledger = new Ledger();
    const sample = (t: number, reportedMicros: number, ownMicros: number, cause: string) => ledger.add({ kind: "observation", what: "cost", t, harness: "claude-code", scope: "cumulative", reportedMicros, ownMicros, cause });
    for (let i = 1; i <= 5; i++) sample(i, i * 100_000, 0, "unexplained");
    sample(6, 600_000, 600_000, "none");
    const text = reportLines(ledger.entries).join("\n");
    expect(text).toContain("running total: 1 observation, 0 differ");
    expect(text).toContain("5 earlier running-total samples left out");
  });
});
