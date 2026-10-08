/**
 * A scripted stand-in for `codex app-server` (JSON-RPC over stdio), for test/codex.test.ts. It
 * speaks the messages Gluon's ChatGPT-plan brain uses, plays one scripted turn per turn/start,
 * and appends every message it receives to $FAKE_CODEX_LOG. Nothing leaves the process.
 *
 * $FAKE_CODEX_SCRIPT (JSON): { turns: Step[][], mcpServers?: string[], account?: object | null }
 * `debug models` prints a small model catalog (with the tool fields the brain must clear) instead.
 */
import { appendFileSync } from "node:fs";
// Imported, not read from disk: the fake also runs inside the compiled fake agent (Windows).
import FEATURES from "./codex-features-list.txt" with { type: "text" };

if (process.argv[2] === "debug" && process.argv[3] === "models") {
  const tools = { tool_mode: "code_mode_only", apply_patch_tool_type: "freeform", experimental_supported_tools: ["clock"], multi_agent_version: "v2" };
  // FAKE_CODEX_CATALOG_EXTRA: fields a newer codex might add to each model.
  const extra = JSON.parse(process.env.FAKE_CODEX_CATALOG_EXTRA ?? "{}");
  console.log(JSON.stringify({ models: ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"].map((slug) => ({ slug, display_name: slug, shell_type: "unified_exec", context_window: 400_000, effective_context_window_percent: 95, ...tools, ...extra })) }));
  process.exit(0);
}

// codex 0.161's features (the fixture), less FAKE_CODEX_FEATURES_DROP's names (an older codex). Like
// codex, `features list` and `app-server` refuse a `--disable` of a name the list doesn't have.
const drop = new Set((process.env.FAKE_CODEX_FEATURES_DROP ?? "").split(",").filter(Boolean));
const rows = FEATURES.trim()
  .split(/\r?\n/)
  .filter((row) => !drop.has(row.trim().split(/\s{2,}/)[0]!));
const known = new Set(rows.map((row) => row.trim().split(/\s{2,}/)[0]!));
const off = new Set(process.argv.flatMap((a, i) => (process.argv[i - 1] === "--disable" ? [a] : [])));
const unknown = [...off].find((f) => !known.has(f));
if (unknown) {
  console.error(`Error: Unknown feature flag: ${unknown}`);
  process.exit(1);
}

// `features list [--disable f]…`: the list with the disables applied (unified_exec stays on, as
// codex forces it), and FAKE_CODEX_FEATURES_EXTRA rows a newer codex might add.
if (process.argv[2] === "features" && process.argv[3] === "list") {
  for (const row of rows) {
    const [name, stage, on] = row.trim().split(/\s{2,}/);
    console.log(`${name!.padEnd(40)} ${stage!.padEnd(18)} ${off.has(name!) && name !== "unified_exec" ? "false" : on}`);
  }
  if (process.env.FAKE_CODEX_FEATURES_EXTRA) console.log(process.env.FAKE_CODEX_FEATURES_EXTRA);
  process.exit(0);
}

type Step = {
  text?: string;
  /** The message arrives whole in item/completed, with no deltas. */
  whole?: boolean;
  tool?: { name: string; input: Record<string, unknown> };
  /** A server request the client must answer (an approval). */
  approval?: string;
  /** An item/started of any item (say, a tool of Codex's own that got through). */
  item?: Record<string, unknown>;
  /** Waits for turn/interrupt. */
  hang?: boolean;
  fail?: { message: string; codexErrorInfo?: string };
  /** The turn completes, then the process exits (a crash between turns). */
  exit?: boolean;
};

const script: { turns: Step[][]; mcpServers?: string[]; account?: unknown } = JSON.parse(process.env.FAKE_CODEX_SCRIPT ?? '{"turns":[]}');
const log = process.env.FAKE_CODEX_LOG;
const THREAD = "thr_fake";

let next = 1000;
let turnCount = 0;
let experimental = false;
let disabled = new Set<string>();
const pending = new Map<number, (result: unknown) => void>();
let onInterrupt: (() => void) | null = null;

const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method: string, params: object) => send({ method, params });
const request = (method: string, params: object) =>
  new Promise<any>((resolve) => {
    const id = ++next;
    pending.set(id, resolve);
    send({ id, method, params });
  });

async function playTurn(turnId: string, steps: Step[]) {
  let n = 0;
  for (const step of steps) {
    const itemId = `item_${turnId}_${++n}`;
    if (step.text !== undefined) {
      notify("item/started", { threadId: THREAD, turnId, startedAtMs: 0, item: { type: "agentMessage", id: itemId, text: "" } });
      if (!step.whole) {
        const half = Math.ceil(step.text.length / 2);
        for (const delta of [step.text.slice(0, half), step.text.slice(half)]) if (delta) notify("item/agentMessage/delta", { threadId: THREAD, turnId, itemId, delta });
      }
      notify("item/completed", { threadId: THREAD, turnId, completedAtMs: 0, item: { type: "agentMessage", id: itemId, text: step.text } });
    }
    if (step.tool) {
      const item = { type: "dynamicToolCall", id: itemId, tool: step.tool.name, arguments: step.tool.input, status: "inProgress" };
      notify("item/started", { threadId: THREAD, turnId, startedAtMs: 0, item });
      const res = await request("item/tool/call", { threadId: THREAD, turnId, callId: `call_${n}`, tool: step.tool.name, arguments: step.tool.input });
      notify("item/completed", { threadId: THREAD, turnId, completedAtMs: 0, item: { ...item, status: "completed", ...res } });
    }
    if (step.approval) await request(step.approval, { threadId: THREAD, turnId, itemId, command: "rm -rf /" });
    if (step.item) notify("item/started", { threadId: THREAD, turnId, startedAtMs: 0, item: { id: itemId, ...step.item } });
    if (step.hang) {
      await new Promise<void>((resolve) => (onInterrupt = resolve));
      notify("turn/completed", { threadId: THREAD, turn: { id: turnId, items: [], status: "interrupted", error: null } });
      return;
    }
    if (step.exit) {
      notify("turn/completed", { threadId: THREAD, turn: { id: turnId, items: [], status: "completed", error: null } });
      setTimeout(() => process.exit(3), 50);
      return;
    }
    if (step.fail) {
      const error = { message: step.fail.message, codexErrorInfo: step.fail.codexErrorInfo ?? null };
      notify("error", { threadId: THREAD, turnId, willRetry: false, error });
      notify("turn/completed", { threadId: THREAD, turn: { id: turnId, items: [], status: "failed", error } });
      return;
    }
  }
  notify("turn/completed", { threadId: THREAD, turn: { id: turnId, items: [], status: "completed", error: null } });
}

function handle(m: { id?: number; method?: string; params?: any; result?: unknown; error?: unknown }) {
  if (log) appendFileSync(log, JSON.stringify(m) + "\n");
  if (m.method === undefined) {
    if (typeof m.id === "number") pending.get(m.id)?.(m.result ?? { error: m.error });
    pending.delete(m.id!);
    return;
  }
  const reply = (result: unknown) => send({ id: m.id, result });
  const fail = (message: string) => send({ id: m.id, error: { code: -32600, message } });
  switch (m.method) {
    case "initialize":
      experimental = m.params?.capabilities?.experimentalApi === true;
      return reply({ userAgent: "fake", codexHome: "/nonexistent", platformFamily: "unix", platformOs: "linux" });
    case "initialized":
      return;
    case "account/read":
      return reply({ account: "account" in script ? script.account : { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true });
    case "config/read":
      return reply({ config: { mcp_servers: Object.fromEntries((script.mcpServers ?? []).map((name) => [name, { command: "true", enabled: true }])) } });
    case "thread/start": {
      if (m.params?.dynamicTools && !experimental) return fail("thread/start.dynamicTools requires experimentalApi capability");
      const config = m.params?.config ?? {};
      disabled = new Set((script.mcpServers ?? []).filter((name) => config[`mcp_servers.${name}.enabled`] === false));
      const thread = { id: THREAD, ephemeral: true, turns: [] };
      reply({ thread, model: m.params?.model, modelProvider: "openai", instructionSources: [], approvalPolicy: "never", sandbox: { type: "readOnly" } });
      return notify("thread/started", { thread });
    }
    case "mcpServerStatus/list":
      return reply({ data: (script.mcpServers ?? []).map((name) => ({ name, runtimeStatus: disabled.has(name) ? "disabled" : "ready" })), nextCursor: null });
    case "turn/start": {
      const turnId = `turn_${++turnCount}`;
      reply({ turn: { id: turnId, items: [], status: "inProgress" } });
      notify("turn/started", { threadId: THREAD, turn: { id: turnId, items: [], status: "inProgress" } });
      void playTurn(turnId, script.turns.shift() ?? []);
      return;
    }
    case "turn/interrupt":
      reply({});
      onInterrupt?.();
      onInterrupt = null;
      return;
    default:
      return fail(`unknown method ${m.method}`);
  }
}

for await (const line of console) {
  if (line.trim()) handle(JSON.parse(line));
}
