import type Anthropic from "@anthropic-ai/sdk";
import { awsSetup, type Config } from "../config.ts";
import { ANTHROPIC_API_BASE, bedrockRuntimeBase, HARNESS_INFO, HARNESSES, type Mode } from "../harnesses.ts";
import { defaultRouting } from "../routing-config.ts";
import type { Config as RoutingConfig } from "../routing.ts";
import { awsCredentialChain } from "./bedrock-converse.ts";
import { nameFromSpec } from "./choices.ts";
import type { ModelClient } from "./session.ts";

/** Credentials for the brain on Bedrock: the one chain (`awsCredentialChain`) on the profile of `awsSetup`, as the probes and launches use it. */
export function awsCredentials(config: Config) {
  return awsCredentialChain(awsSetup(config).profile);
}

type MessagesClient = { messages: { stream: Anthropic["messages"]["stream"] } };

/**
 * A streaming Anthropic-API brain on any Anthropic-shaped client (the API, or Bedrock for Claude).
 * `effort` goes as `output_config.effort` (`sentEffort`; null: the model takes none, nothing sent).
 */
export function messagesBrain(client: MessagesClient | (() => Promise<MessagesClient>), model: string, effort: Anthropic.OutputConfig["effort"] = null): ModelClient {
  // A function builds the client with the first call, so the SDKs behind it aren't imported at start-up.
  let made: Promise<MessagesClient> | undefined;
  return async ({ system, messages, tools, signal }, onText) => {
    const stream = (typeof client === "function" ? await (made ??= client()) : client).messages.stream(
      {
        model,
        max_tokens: 8192,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
        tools,
        ...(effort ? { output_config: { effort } } : {}),
      },
      { signal },
    );
    stream.on("text", onText);
    const msg = await stream.finalMessage();
    return { content: msg.content, stop_reason: msg.stop_reason };
  };
}

const OPTIONS = { timeout: 60_000, maxRetries: 2 };

// Both Anthropic clients below pass `baseURL` explicitly: left out, the SDKs would read ANTHROPIC_BASE_URL or
// ANTHROPIC_BEDROCK_BASE_URL from the environment and send the key and the conversation there.

/** The brain on the user's Anthropic API key. */
export function anthropicBrain(apiKey: string, model: string, effort: Anthropic.OutputConfig["effort"] = null): ModelClient {
  return messagesBrain(async () => new (await import("@anthropic-ai/sdk")).default({ ...OPTIONS, apiKey, authToken: null, baseURL: ANTHROPIC_API_BASE }), model, effort);
}

/** The brain on Claude through the user's own AWS setup. */
export function bedrockClaudeBrain(config: Config, model: string, effort: Anthropic.OutputConfig["effort"] = null): ModelClient {
  const provider = awsCredentials(config);
  const { region } = awsSetup(config);
  return messagesBrain(
    async () => new (await import("@anthropic-ai/bedrock-sdk")).default({ ...OPTIONS, awsRegion: region, baseURL: bedrockRuntimeBase(region), providerChainResolver: async () => provider }),
    model,
    effort,
  );
}

/**
 * The demo's pace: its pauses (a turn's thinking, each streamed word) are multiplied by this.
 * `GLUON_TEST_DEMO_PACE` (the e2e harness: 0.05, so a walk to a session takes less) is a test
 * seam, compiled out of release builds: there the demo always takes its full time.
 */
const demoPace = (): number => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? 1 : paceOf(Number(process.env.GLUON_TEST_DEMO_PACE)));
const paceOf = (p: number): number => (p > 0 && p <= 1 ? p : 1);
declare const GLUON_BUILD: string | undefined;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms * demoPace());
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

type Turn = { text?: string; tools?: { name: string; input: Record<string, unknown> }[] };

/** Text of every tool_result for the tool calls named `name`, in order. */
function toolResults(messages: Anthropic.MessageParam[], name: string): string[] {
  const ids = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && b.name === name) ids.add(b.id);
      if (b.type === "tool_result" && ids.has(b.tool_use_id) && !b.is_error) out.push(typeof b.content === "string" ? b.content : "");
    }
  }
  return out;
}

/** The developer's first message. */
function demoTask(messages: Anthropic.MessageParam[]): string {
  const first = messages.find((m) => m.role === "user" && typeof m.content === "string");
  return (typeof first?.content === "string" ? first.content : "the session").trim();
}

/** The demo's mode: explore when the developer asks to understand or explain, plan when they ask for a plan, else build (none). */
function demoMode(task: string): Record<string, unknown> {
  if (/\b(explain|understand|how does|how do|why does|investigate|review)\b/i.test(task)) return { mode: "explore", worktree: false };
  if (/\b(plan|design|propose)\b/i.test(task)) return { mode: "plan" };
  return {};
}

/** The demo's spec, built from the developer's task, the files it listed and their answer. */
function demoSpec(messages: Anthropic.MessageParam[]): string {
  const task = demoTask(messages);
  const words = new Set(task.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const files = (toolResults(messages, "list_files")[0] ?? "").split("\n").filter((f) => f && !f.startsWith("…"));
  const scored = files.map((f) => ({ f, score: [...words].filter((w) => f.toLowerCase().includes(w)).length }));
  const relevant = [...scored.filter((x) => x.score > 0), ...scored.filter((x) => x.score === 0)].slice(0, 4).map((x) => x.f);
  const answers = toolResults(messages, "ask_user").map((a) => a.replace(/^The developer answered: /, ""));
  return [
    task.charAt(0).toUpperCase() + task.slice(1) + (/[.!?]$/.test(task) ? "" : "."),
    "",
    "**Relevant files**",
    ...(relevant.length ? relevant.map((f) => `- \`${f}\``) : ["- (none found; start from the repository root)"]),
    "",
    "**Decisions**",
    ...(answers.length ? answers.map((a) => `- ${a}`) : ["- none"]),
    "",
    "**Done when**",
    "- the change works and the existing tests pass",
  ].join("\n");
}

/**
 * A scripted brain for walking the UI without API calls. It explores the real repository, asks
 * one question, routes (a type of the developer's routing.yaml) and proposes a spec built from the
 * task, and on a reply routes again, one level lower. It offers only what `route` returns, like any brain.
 */
export function demoClient(routing: RoutingConfig = defaultRouting()): ModelClient {
  let turn = 0;
  const types = Object.entries(routing.types ?? {});
  // The first type of that mode (`other` when the routing.yaml has no such type: any one will do).
  const typeFor = (mode: Mode) => (types.find(([, t]) => t.mode === mode) ?? types[0])?.[0] ?? "other";
  const routeCall = (task: string, cheap: boolean, named?: string): Record<string, unknown> => {
    const explore = demoMode(task).mode === "explore";
    const plan = demoMode(task).mode === "plan";
    return {
      types: [{ type: typeFor(explore ? "explore" : "build"), model_steps: cheap ? 0 : 1, effort_steps: 0, reasons: "demo" }],
      ...(plan ? { mode: "plan" } : {}),
      ...(named ? { pinned: named } : {}),
    };
  };
  // A reply that names an agent ("use codex") is a pin, as it would be for any brain.
  const namedIn = (messages: Anthropic.MessageParam[]): string | undefined => {
    const reply = toolResults(messages, "propose_launch").at(-1)?.replace(/^The developer did not launch\. They replied: /, "") ?? "";
    return HARNESSES.find((h) => new RegExp(`\\b(${h}|${HARNESS_INFO[h].binary})\\b`, "i").test(reply));
  };
  const script = (messages: Anthropic.MessageParam[]): Turn => {
    switch (turn++) {
      case 0:
        return { text: "Let me look at how this repo is laid out.", tools: [{ name: "list_files", input: {} }] };
      case 1:
        return { tools: [{ name: "grep", input: { pattern: "test", path: "." } }, { name: "read_file", input: { path: "package.json" } }] };
      case 2:
        return {
          text: "I found the test setup. One thing I can't tell from the code:",
          tools: [
            {
              name: "ask_user",
              input: {
                question: "Should the fix include a regression test, or just the change?",
                options: [
                  { label: "Add a regression test", description: "Reproduce the bug in a test first, then fix" },
                  { label: "Just the fix", description: "Smallest change that works" },
                ],
              },
            },
          ],
        };
      default: {
        // Round after round: route, then propose; from the second round on, a cheaper setup.
        const round = turn - 4;
        const cheap = round >= 2;
        const task = demoTask(messages);
        const named = cheap ? namedIn(messages) : undefined;
        if (round % 2 === 0) return { text: cheap ? `Sure — ${named ? `${named}, as you asked; ` : ""}a cheaper setup is enough for this.` : "Clear. Here's what I'd launch.", tools: [{ name: "route", input: routeCall(task, cheap, named) }] };
        // The reason: what route picked, in a sentence.
        let picked = "";
        try {
          const r = JSON.parse(toolResults(messages, "route").at(-1) ?? "{}").recommended as { harness: string; model: string; effort?: string } | undefined;
          if (r) picked = ` routing picks ${r.harness}/${r.model}${r.effort ? ` at ${r.effort}` : ""}`;
        } catch {}
        const type = (routeCall(task, cheap).types as { type: string }[])[0]!.type;
        const why = cheap ? "A small, clear change; a cheaper setup is enough" : "A focused change with a clear test path";
        return {
          tools: [{ name: "propose_launch", input: { name: nameFromSpec(task), spec: demoSpec(messages), types: [type], ...(demoMode(task).mode === "explore" ? { worktree: false } : {}), reason: `${why};${picked || " routing picks the agent"}.` } }],
        };
      }
    }
  };

  return async ({ messages, signal }, onText) => {
    await sleep(700, signal);
    const t = script(messages);
    const content: Anthropic.ContentBlock[] = [];
    if (t.text) {
      for (const word of t.text.split(/(?<= )/)) {
        await sleep(35, signal);
        onText(word);
      }
      content.push({ type: "text", text: t.text, citations: null });
    }
    for (const [i, tool] of (t.tools ?? []).entries()) {
      content.push({ type: "tool_use", id: `demo_${turn}_${i}`, name: tool.name, input: tool.input, caller: { type: "direct" } } as Anthropic.ToolUseBlock);
    }
    return { content, stop_reason: t.tools ? "tool_use" : "end_turn" };
  };
}
