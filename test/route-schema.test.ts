// `route`'s input schema (nested arrays, enums, integers with min/max) reaches the model through every
// brain client; each one must hand it over whole. The Claude-plan brain (zod) is in choices.test.ts.
import { expect, test } from "bun:test";
import { z } from "zod";
import { toConverseTools } from "../src/agent/bedrock-converse.ts";
import { threadStartParams } from "../src/agent/codex.ts";
import { toChatTools, toResponsesTools } from "../src/agent/openai.ts";
import { TOOLS } from "../src/agent/tools.ts";

const route = TOOLS.find((t) => t.name === "route")!;
// What a model sends, and what it must not: as the schema says (types 1+, steps in range, a known mode).
const good = { types: [{ type: "debug", model_steps: -2, effort_steps: 2, mode: "plan", reasons: "x" }, { type: "test", model_steps: 0, effort_steps: 0 }], mode: "explore", pinned: "codex/gpt-6-luna@low", harness: "codex", because: "prefer codex" };
const bad = [
  { types: [] },
  { types: [{ type: "debug", model_steps: 3, effort_steps: 0 }] },
  { types: [{ type: "debug", model_steps: -3, effort_steps: 0 }] },
  { types: [{ type: "debug", model_steps: 0, effort_steps: 3 }] },
  { types: [{ type: "debug", model_steps: 0.5, effort_steps: 0 }] },
  { types: [{ type: "debug", model_steps: 0, effort_steps: 0, mode: "ship" }] },
  { types: [{ type: "debug", effort_steps: 0 }] },
  { mode: "plan" },
];

/** The schema as the client sends it (JSON, as on the wire) accepts `good`, refuses each of `bad`, and is the tool's own. */
function roundTrips(sent: unknown) {
  const wire = JSON.parse(JSON.stringify(sent));
  expect(wire).toEqual(route.input_schema);
  const zod = z.fromJSONSchema(wire);
  expect(zod.safeParse(good).success).toBe(true);
  for (const b of bad) expect(zod.safeParse(b).success, JSON.stringify(b)).toBe(false);
}

test("route's schema reaches the OpenAI Responses tools whole", () => {
  const t = toResponsesTools(TOOLS).find((x) => x.name === "route")!;
  roundTrips(t.parameters);
});

test("route's schema reaches the Chat Completions tools whole", () => {
  const t = toChatTools(TOOLS).find((x) => (x as { function: { name: string } }).function.name === "route") as { function: { parameters: unknown } };
  roundTrips(t.function.parameters);
});

test("route's schema reaches Bedrock Converse whole", () => {
  const t = toConverseTools(TOOLS).find((x) => x.toolSpec?.name === "route")!;
  roundTrips((t.toolSpec!.inputSchema as { json: unknown }).json);
});

test("route's schema reaches Codex's dynamicTools whole", () => {
  const t = threadStartParams("gpt-6-luna", "/tmp", "system").dynamicTools.find((x) => x.name === "route")!;
  roundTrips(t.inputSchema);
});
