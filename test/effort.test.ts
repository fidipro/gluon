/**
 * The intake agent's effort: what a step of `brain.order` may set, what each route sends for it
 * (Gluon's names mapped to each API's, clamped to what the model takes), that each client puts it
 * in its request, and that the header shows what is sent.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { query as sdkQuery, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { converseClient, type ConverseLike } from "../src/agent/bedrock-converse.ts";
import { messagesBrain } from "../src/agent/clients.ts";
import { BRAIN_EFFORT_DEFAULT, clampEffort, claudeEfforts, codexReasoningLevels, openaiEfforts, sentEffort, stepEfforts } from "../src/agent/effort.ts";
import { openaiClient, type OpenAILike } from "../src/agent/openai.ts";
import { Session } from "../src/agent/session.ts";
import { subscriptionBrain, subscriptionOptions } from "../src/agent/subscription.ts";
import { shownEffort } from "../src/brain.ts";
import { activeIndex, activeValue, DEFAULT_ORDER, defaults, loadConfig, type BrainStep } from "../src/config.ts";
import { fakeAgents } from "./e2e/fixtures.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-effort-"));
const saved = { ...process.env };
beforeAll(() => {
  process.env.GLUON_CONFIG = join(TMP, "config.yaml");
  process.env.PATH = `${fakeAgents(["claude"])}${delimiter}${process.env.PATH}`;
});
beforeEach(() => rmSync(join(TMP, "config.yaml"), { force: true }));
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(TMP, { recursive: true, force: true });
});

const ROOT = join(import.meta.dir, "..");
const signal = () => new AbortController().signal;
const ask = { system: "sys", messages: [{ role: "user", content: "hi" }] as Anthropic.MessageParam[], tools: [] };

async function* iterate<T>(items: T[]) {
  for (const i of items) yield i;
}

describe("mapping Gluon's effort to each API", () => {
  test("Claude models: all five from Opus 4.7 / Sonnet 5 / Haiku 5.5 on, no xhigh on 4.6, low–high on Opus 4.5, none on Haiku 4.5 and Sonnet 4.5", () => {
    for (const m of ["claude-sonnet-5-5", "global.anthropic.claude-sonnet-5-5", "anthropic/claude-sonnet-5.5", "claude-opus-4-7", "claude-fable-5-1", "sonnet", "opus", "haiku", "claude-haiku-5-5", "global.anthropic.claude-haiku-5-5", "anthropic/claude-haiku-5.5"]) expect([m, claudeEfforts(m)]).toEqual([m, ["low", "medium", "high", "xhigh", "max"]]);
    expect(claudeEfforts("us.anthropic.claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(claudeEfforts("claude-opus-4-5-20251101")).toEqual(["low", "medium", "high"]);
    for (const m of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-3-7-sonnet", "gpt-6-sol"]) expect([m, claudeEfforts(m)]).toEqual([m, []]);
  });

  test("OpenAI models: reasoning models only, GPT-6 all five", () => {
    expect(openaiEfforts("gpt-6-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(openaiEfforts("us.openai.gpt-6-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(openaiEfforts("openai/gpt-5.2")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(openaiEfforts("gpt-5-mini")).toEqual(["low", "medium", "high"]);
    expect(openaiEfforts("o4-mini")).toEqual(["low", "medium", "high"]);
    expect(openaiEfforts("openai.gpt-oss-120b-1:0")).toEqual(["low", "medium", "high"]);
    for (const m of ["gpt-4o", "gpt-4.1", "llama-4"]) expect([m, openaiEfforts(m)]).toEqual([m, []]);
  });

  test("clamping goes to the nearest supported level, the cheaper on a tie, never off the ladder", () => {
    expect(clampEffort("medium", ["low", "medium", "high"])).toBe("medium");
    expect(clampEffort("max", ["low", "medium", "high"])).toBe("high");
    expect(clampEffort("xhigh", ["low", "medium", "high", "max"])).toBe("high");
    expect(clampEffort("low", ["high", "xhigh"])).toBe("high");
    expect(clampEffort("medium", ["minimal", "high"])).toBe("high");
    expect(clampEffort("low", ["minimal", "medium"])).toBe("minimal");
    expect(clampEffort("medium", ["none", "ultra"])).toBeNull();
    expect(clampEffort("medium", [])).toBeNull();
  });

  test(`a step without effort sends ${BRAIN_EFFORT_DEFAULT}; every default step sends it in its API's name`, () => {
    expect(BRAIN_EFFORT_DEFAULT).toBe("medium");
    expect(DEFAULT_ORDER.map((s) => sentEffort(s))).toEqual(DEFAULT_ORDER.map(() => "medium"));
  });

  test("per route: the API's own names, clamped to the model; nothing where the model takes none", () => {
    const sent = (route: BrainStep["route"], model: string, effort?: BrainStep["effort"]) => sentEffort({ route, model, ...(effort ? { effort } : {}) });
    expect(sent("anthropic-api", "claude-opus-4-7", "xhigh")).toBe("xhigh");
    expect(sent("anthropic-api", "claude-haiku-4-5")).toBeNull();
    expect(sent("claude-plan", "claude-sonnet-5-5", "max")).toBe("max");
    expect(sent("bedrock", "us.anthropic.claude-sonnet-4-6", "xhigh")).toBe("high");
    expect(sent("bedrock", "us.openai.gpt-6-sol", "max")).toBe("max");
    expect(sent("bedrock", "meta.llama4-maverick-17b-instruct-v1:0")).toBeNull();
    expect(sent("openai-api", "gpt-6-sol", "high")).toBe("high");
    expect(sent("openai-api", "gpt-4.1")).toBeNull();
    // OpenRouter has no `max`: it becomes the model's `xhigh`.
    expect(sent("openrouter", "anthropic/claude-sonnet-5.5", "max")).toBe("xhigh");
    expect(sent("openrouter", "anthropic/claude-sonnet-4.6", "max")).toBe("xhigh");
    expect(sent("openrouter", "openai/gpt-6-sol", "low")).toBe("low");
    expect(sent("openrouter", "deepseek/deepseek-v4")).toBeNull();
    // ChatGPT plan: Codex's catalog decides; not read yet, Gluon's level as it is.
    expect(sent("chatgpt-plan", "gpt-6-luna", "xhigh")).toBe("xhigh");
    expect(sentEffort({ route: "chatgpt-plan", model: "gpt-6-luna", effort: "max" }, ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(sentEffort({ route: "chatgpt-plan", model: "gpt-6-luna" }, [])).toBeNull();
  });

  test("Codex's catalog: supported_reasoning_levels by slug, as presets or plain names", () => {
    const json = JSON.stringify({ models: [{ slug: "a", supported_reasoning_levels: [{ effort: "low", description: "x" }, { effort: "high", description: "y" }] }, { slug: "b", supported_reasoning_levels: ["medium"] }, { slug: "c" }] });
    expect(codexReasoningLevels(json)).toEqual({ a: ["low", "high"], b: ["medium"] });
    expect(codexReasoningLevels("not json")).toEqual({});
  });
});

describe("brain.order: effort per step", () => {
  const load = (yaml: string) => {
    writeFileSync(process.env.GLUON_CONFIG!, yaml);
    return loadConfig();
  };

  test("an optional effort per step, kept; unset stays unset (the default applies when sending)", () => {
    const c = load("brain:\n  order:\n    - { route: claude-plan, model: claude-sonnet-5-5, effort: high }\n    - { route: chatgpt-plan, model: gpt-6-luna }\n");
    expect(c.brain.order).toEqual([{ route: "claude-plan", model: "claude-sonnet-5-5", effort: "high" }, { route: "chatgpt-plan", model: "gpt-6-luna" }]);
    expect(sentEffort(c.brain.order[1]!)).toBe("medium");
  });

  test("a name that isn't an effort, or a level the model doesn't take, is a clear ConfigError", () => {
    expect(() => load("brain:\n  order:\n    - { route: claude-plan, model: claude-sonnet-5-5, effort: turbo }\n")).toThrow('brain.order[0].effort must be one of low, medium, high, xhigh, max (got "turbo")');
    expect(() => load("brain:\n  order:\n    - { route: bedrock, model: us.anthropic.claude-sonnet-4-6, effort: xhigh }\n")).toThrow("brain.order[0].effort: us.anthropic.claude-sonnet-4-6 on bedrock takes low, medium, high, max (got xhigh)");
    expect(() => load("brain:\n  order:\n    - { route: anthropic-api, model: claude-haiku-4-5, effort: low }\n")).toThrow("brain.order[0].effort: claude-haiku-4-5 on anthropic-api takes no effort setting; remove effort (got low)");
    expect(() => load("brain:\n  order:\n    - { route: openrouter, model: deepseek/deepseek-v4, effort: low }\n")).toThrow("takes no effort setting");
  });

  test("the ChatGPT plan takes any level (Codex's catalog clamps it when the brain starts)", () => {
    expect(stepEfforts({ route: "chatgpt-plan", model: "gpt-6-luna" })).toBeNull();
    expect(load("brain:\n  order:\n    - { route: chatgpt-plan, model: gpt-6-luna, effort: max }\n").brain.order[0]!.effort).toBe("max");
  });

  test("brain.active is saved with its effort and matches only the same step", () => {
    const order: BrainStep[] = [{ route: "claude-plan", model: "claude-sonnet-5-5" }, { route: "claude-plan", model: "claude-sonnet-5-5", effort: "high" }];
    const config = { ...defaults(), brain: { order, active: null } };
    expect(activeValue(config, 0)).toEqual({ route: "claude-plan", model: "claude-sonnet-5-5" });
    expect(activeValue(config, 1)).toEqual({ route: "claude-plan", model: "claude-sonnet-5-5", effort: "high" });
    expect(activeIndex(order, { route: "claude-plan", model: "claude-sonnet-5-5", effort: "high" })).toBe(1);
    expect(activeIndex(order, { route: "claude-plan", model: "claude-sonnet-5-5" })).toBe(0);
    expect(activeIndex(order, { route: "claude-plan", model: "claude-sonnet-5-5", effort: "low" })).toBeNull();
  });
});

describe("each client sends the effort", () => {
  test("Anthropic Messages (API key, Bedrock Claude): output_config.effort; nothing when null", async () => {
    const bodies: any[] = [];
    const client = {
      messages: {
        stream: ((body: any) => {
          bodies.push(body);
          return { on: () => {}, finalMessage: async () => ({ content: [{ type: "text", text: "ok", citations: null }], stop_reason: "end_turn" }) };
        }) as never,
      },
    };
    await messagesBrain(client, "claude-sonnet-5-5", "medium")({ ...ask, signal: signal() }, () => {});
    await messagesBrain(client, "claude-haiku-4-5", null)({ ...ask, signal: signal() }, () => {});
    expect(bodies[0]).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "medium" } });
    expect(bodies[1]).not.toHaveProperty("output_config");
  });

  test("OpenAI Responses and OpenRouter Chat Completions: reasoning.effort; nothing when null", async () => {
    const bodies: any[] = [];
    const create = async (body: any) => {
      bodies.push(body);
      return body.input ? iterate([{ type: "response.completed", response: { status: "completed", incomplete_details: null, output: [] } }]) : iterate([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
    };
    const client: OpenAILike = { responses: { create }, chat: { completions: { create } } };
    await openaiClient({ apiKey: "k", model: "gpt-6-sol", mode: "responses", effort: "medium", client })({ ...ask, signal: signal() }, () => {});
    await openaiClient({ apiKey: "k", model: "openai/gpt-6-sol", mode: "chat", effort: "xhigh", client })({ ...ask, signal: signal() }, () => {});
    await openaiClient({ apiKey: "k", model: "gpt-4.1", mode: "responses", effort: null, client })({ ...ask, signal: signal() }, () => {});
    expect(bodies[0]).toMatchObject({ model: "gpt-6-sol", reasoning: { effort: "medium" } });
    expect(bodies[1]).toMatchObject({ model: "openai/gpt-6-sol", reasoning: { effort: "xhigh" } });
    expect(bodies[2]).not.toHaveProperty("reasoning");
  });

  test("Bedrock ConverseStream: outputConfig.effort; nothing when null", async () => {
    const inputs: any[] = [];
    const client: ConverseLike = {
      send: async (command) => {
        inputs.push(command.input);
        return { stream: iterate([{ messageStop: { stopReason: "end_turn" } }]) };
      },
    };
    await converseClient({ model: "us.openai.gpt-6-sol", effort: "medium", client })({ ...ask, signal: signal() }, () => {});
    await converseClient({ model: "meta.llama", effort: null, client })({ ...ask, signal: signal() }, () => {});
    expect(inputs[0]).toMatchObject({ modelId: "us.openai.gpt-6-sol", outputConfig: { effort: "medium" } });
    expect(inputs[1]).not.toHaveProperty("outputConfig");
  });

  test("Claude plan: the Agent SDK's own effort option, nothing else added; none when null", async () => {
    expect(subscriptionOptions("claude-sonnet-5-5", ROOT, "sys", {}, "medium").effort).toBe("medium");
    expect(subscriptionOptions("claude-haiku-4-5", ROOT, "sys", {})).not.toHaveProperty("effort");
    const seen: unknown[] = [];
    const run = (({ prompt, options }: Parameters<typeof sdkQuery>[0]) => {
      seen.push(options?.effort);
      async function* messages(): AsyncGenerator<SDKMessage> {
        for await (const _ of prompt as AsyncIterable<unknown>) yield { type: "result", subtype: "success", is_error: false, result: "", session_id: "s" } as unknown as SDKMessage;
      }
      return Object.assign(messages(), { interrupt: async () => {}, close: () => {} });
    }) as unknown as typeof sdkQuery;
    const session = new Session(subscriptionBrain("claude-sonnet-5-5", ROOT, run, "high"), loadConfig(), "sys", ROOT);
    await session.submit("hello");
    session.close();
    expect(seen).toEqual(["high"]);
  });
});

describe("shownEffort", () => {
  test("is the effort sent: `medium` by default, nothing when the model takes none", () => {
    expect(shownEffort(DEFAULT_ORDER[0]!)).toBe("medium");
    expect(shownEffort({ route: "bedrock", model: "us.anthropic.claude-sonnet-4-6", effort: "max" })).toBe("max");
    expect(shownEffort({ route: "anthropic-api", model: "claude-haiku-4-5" })).toBeNull();
  });
});

// --- QA pass (brain, offline): every route × model × effort, against an oracle written here

describe("QA: effort clamping, exhaustively", () => {
  const LADDER = ["low", "medium", "high", "xhigh", "max"] as const;
  const MODELS: Record<BrainStep["route"], string[]> = {
    "claude-plan": ["claude-sonnet-5-5", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "sonnet", "opus", "fable", "haiku"],
    "anthropic-api": ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-1-20250805", "claude-sonnet-4-20250514"],
    "chatgpt-plan": ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "whatever"],
    "openai-api": ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.2", "gpt-5", "gpt-4.1", "gpt-4o", "o3", "gpt-oss-120b", "text-davinci"],
    bedrock: ["global.anthropic.claude-sonnet-5-5", "us.anthropic.claude-sonnet-4-6", "global.anthropic.claude-haiku-4-5-20251001-v1:0", "us.openai.gpt-6-sol", "global.openai.gpt-6.1-sol", "openai.gpt-oss-120b-1:0", "meta.llama4-maverick-17b-instruct-v1:0", "amazon.nova-pro-v1:0"],
    openrouter: ["anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-4.6", "anthropic/claude-haiku-4.5", "openai/gpt-6.1-sol", "openai/gpt-5", "deepseek/deepseek-v4", "moonshotai/kimi-k3"],
  };

  test("what is sent is a level the model takes (in the API's names), the nearest to the wanted one, the cheaper on a tie; nothing for a model that takes none", () => {
    let checked = 0;
    for (const [route, models] of Object.entries(MODELS) as [BrainStep["route"], string[]][]) {
      for (const model of models) {
        for (const wanted of [undefined, ...LADDER]) {
          const step = { route, model, ...(wanted ? { effort: wanted } : {}) } as BrainStep;
          const takes = stepEfforts(step);
          const sent = sentEffort(step);
          const where = `${route} ${model} ${wanted ?? "(default)"}`;
          if (takes === null) {
            expect([where, sent]).toEqual([where, wanted ?? "medium"]); // the ChatGPT plan: Codex's catalog decides later
            continue;
          }
          // OpenRouter has no `max`: a model's max is its xhigh.
          const names = route === "openrouter" ? [...new Set(takes.map((e) => (e === "max" ? "xhigh" : e)))] : takes;
          if (!names.length) {
            expect([where, sent]).toEqual([where, null]);
            continue;
          }
          const at = LADDER.indexOf((wanted ?? "medium") as (typeof LADDER)[number]);
          const best = [...names].sort((a, b) => Math.abs(LADDER.indexOf(a as never) - at) - Math.abs(LADDER.indexOf(b as never) - at) || LADDER.indexOf(a as never) - LADDER.indexOf(b as never))[0]!;
          expect([where, sent]).toEqual([where, best]);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("the ChatGPT plan: any level of the catalog's own, clamped; a catalog that lists levels off the ladder, or none, sends the nearest on it, or nothing", () => {
    const s = (effort: BrainStep["effort"], levels?: string[]) => sentEffort({ route: "chatgpt-plan", model: "gpt-6-luna", ...(effort ? { effort } : {}) }, levels);
    for (const wanted of LADDER) {
      expect(s(wanted, ["none", "low", "medium", "high", "xhigh", "ultra"])).toBe(wanted === "max" ? "xhigh" : wanted);
      expect(s(wanted, ["medium"])).toBe("medium");
      expect(s(wanted, ["none", "ultra"])).toBeNull();
      expect(s(wanted, [])).toBeNull();
      expect(s(wanted)).toBe(wanted);
    }
  });

  test("the catalog's Claude models take exactly the efforts the brain's table says for each id they run under (plan alias, API, Bedrock, OpenRouter)", async () => {
    const { DEFAULT_MODELS } = await import("../src/harnesses.ts");
    for (const m of DEFAULT_MODELS["claude-code"]) {
      for (const [conn, id] of Object.entries(m.ids)) {
        expect([m.id, conn, claudeEfforts(id!)]).toEqual([m.id, conn, m.efforts]);
      }
    }
  });
});
