/**
 * The brain on the user's own ChatGPT plan: opt-in, personal use. It runs only through the user's
 * official `codex` program (`codex app-server`, JSON-RPC over stdio), which signs in on its own.
 * Gluon never reads Codex's credential files, never calls OpenAI itself in this mode, never sets
 * a base URL, forwards no token, and sends its own system prompt unchanged as the thread's base
 * instructions. Codex's own tools are turned off: the brain sees Gluon's five tools only.
 *
 * What gives a Codex thread tools (checked against codex 0.159 by capturing the model request; feature
 * names and item types against 0.161):
 * - features (`--disable` below);
 * - the model catalog: a model's `tool_mode: code_mode_only` wraps every tool in a JavaScript
 *   `exec` tool (with `wait`), `apply_patch_tool_type` adds `apply_patch`,
 *   `experimental_supported_tools` adds e.g. `clock.curr_time` and `multi_agent_version` the
 *   collaboration tools. No feature turns these off: the app-server gets a copy of Codex's own
 *   catalog (`codex debug models`) with them cleared (`-c model_catalog_json=…`);
 * - the thread: an execution environment (`apply_patch`), `agents` (collaboration), the
 *   `request_user_input` tool and the skills list, turned off in `thread/start`.
 *
 * This list is a denylist, so it fails closed at runtime: before the app-server starts, `codex
 * features list` (with the same `--disable`s, for the names this codex knows) must show no enabled
 * feature outside CODEX_FEATURES_KEPT, and every catalog field set on a model must be one Gluon knows
 * (CATALOG_FIELDS). A newer codex with a new feature or catalog field is refused, with a readable
 * error, until Gluon has looked at it; the brain order then falls through. During a turn, an item
 * of a type outside BRAIN_ITEMS (a tool of Codex's own that got through) stops the app-server.
 *
 * `dynamicTools` is an experimental app-server API: a Codex update may break it. The probe catches
 * that, and the brain order falls through to the next step. A ChatGPT account may also refuse
 * some models: Codex's own refusal is what `doctor` and `gluon brain` show, and the order moves on.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import type { Effort } from "../harnesses.ts";
import { maskSecrets } from "../secrets.ts";
import { codexReasoningLevels, sentEffort } from "./effort.ts";
import { assertShimArgs, binPath, killTree, missingReason, neutralCwd } from "../detect.ts";
import { run } from "../status.ts";
import type { LoopBrain, LoopHooks, ToolOutput } from "./session.ts";
import { TOOLS } from "./tools.ts";

/**
 * Codex features that bring tools or run commands of their own, or that Gluon hasn't looked into
 * (off costs nothing). `codex` refuses a `--disable` of a name it doesn't know (exit 1), so only
 * the names a codex lists are passed (`knownFeatures`). `code_mode_host` stays on: turning it off
 * makes code mode fail closed rather than go away. test/codex.test.ts checks this list against
 * `codex features list` (test/fixtures/codex-features-list.txt).
 */
export const CODEX_FEATURES_OFF = [
  // Commands on the host.
  "shell_tool",
  "unified_exec",
  "unified_exec_tty",
  "shell_snapshot",
  "shell_snapshot_v2",
  "shell_zsh_fork",
  "hooks",
  "skill_mcp_dependency_install",
  "workspace_dependencies",
  "worktrees",
  "write_stdin_approval",
  "exec_permission_approvals",
  "request_permissions_tool",
  "deferred_executor",
  // Apps, plugins, MCP apps.
  "apps",
  "plugins",
  "remote_plugin",
  "enable_mcp_apps",
  "tool_suggest",
  "skill_search",
  // Browser, computer, images, voice.
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "view_image",
  "realtime_conversation",
  "artifact",
  // Agents, goals, code mode, other model-facing tools.
  "multi_agent",
  "multi_agent_v2",
  "agent_message_board",
  "goals",
  "code_mode",
  "code_mode_only",
  "code_mode_prewarm",
  "code_mode_interrupt",
  "instant_interrupt",
  "sleep_tool",
  "current_time_reminder",
  "send_message_to_user_async",
  "default_mode_request_user_input",
  "standalone_web_search",
  "token_budget",
  "memories",
  "chronicle",
  // New in codex 0.161, not looked into: off.
  "browser_annotation_api",
  "in_app_voice",
  "cli_daybreak",
  "guardian_conversation_history_tools",
  "guardian_root_handoff_context",
  "login_shell_package_path",
  "model_catalog_in_context",
  "api_key_cyber_access_programs",
];

/**
 * Features that may stay on (`codex features list` after CODEX_FEATURES_OFF), and why: none gives
 * the model a tool or runs a command. Any other enabled feature makes Gluon refuse this codex.
 */
export const CODEX_FEATURES_KEPT: Record<string, string> = {
  // Code mode fails closed without its host; the catalog keeps code mode off (tool_mode: direct).
  code_mode_host: "needed: code mode fails closed without it; the catalog keeps code mode off",
  // Forced on by codex 0.158 (only managed requirements can turn it off); it gives no tool
  // without shell_tool (off) and an execution environment (the thread has none).
  unified_exec: "forced on by codex; no tool without shell_tool and an execution environment",
  ...Object.fromEntries(
    ["analytics_plan_history", "api_key_model_discovery", "auth_elicitation", "background_paginated_rollout_migration", "bedrock_setup_wizard", "compaction_image_budget", "concurrent_reasoning_summaries", "content_item_kinds", "context_management", "cwd_relative_turn_diffs", "daemon_auto_start", "defer_mailbox_preemption", "deferred_tool_world_state", "enable_request_compression", "executed_tool_call_metadata", "executor_capability_discovery", "external_agent_memory_import", "fast_mode", "guardian_approval", "guardian_enhanced_node_repl_transcripts", "guardian_node_repl_transcript_images", "guardian_reuse_parent_compaction", "guardianv2", "image_resize_notice", "in_app_chat", "in_app_dictation", "in_app_local_automation", "in_app_updates", "local_thread_store_compression", "mcp_2026_07_28", "mcp_oauth_refresh_coordination", "mentions_v2", "network_proxy", "nonfatal_clock_read_errors", "non_prefixed_mcp_tool_names", "omit_app_server_notification_media", "plugin_sharing", "powershell_shell_version", "prefer_mxc", "prevent_idle_sleep", "psp", "reasoning_effort_override", "recommended_plugins", "respect_system_proxy", "retain_client_developer_messages", "rollout_budget", "runtime_metrics", "secret_auth_storage", "skip_host_skill_discovery", "step_model_switching", "system_proxy_fallback", "terminal_visualization_instructions", "tool_call_mcp_elicitation", "unbounded_connection_retries", "unified_image_budget", "use_agent_identity", "use_xaa", "windows_sandbox_service", "codex_apps_mcp_2026_07_28", "apply_patch_preserve_line_endings", "apply_patch_streaming_events", "guardianv2.thread_context"].map((f) => [f, "no tool: client, storage, auth, telemetry or UI"]),
  ),
};

/** What the refusals say: the user's codex is newer than what Gluon has checked. */
export const UNSUPPORTED = "this codex version isn't supported for the intake agent on the ChatGPT plan yet (checked against codex 0.161)";
/** The tail of a refusal of a codex whose catalog Gluon can't read: `brainErrorHint` matches it with `UNSUPPORTED`. */
export const TOO_NEW = "this codex may be too new for the intake agent";

/** `codex features list` as [name, stage, on] rows. Throws when the list can't be read. */
function featureRows(list: string): string[][] {
  const rows = list
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s{2,}/));
  if (rows.length < 10 || rows.some((r) => r.length !== 3 || !/^(true|false)$/.test(r[2]!))) throw new Error(`${UNSUPPORTED}: its \`codex features list\` isn't in the shape Gluon reads`);
  return rows;
}

/** The names of CODEX_FEATURES_OFF that this `codex features list` knows: the only ones `--disable` may name. */
export function knownFeatures(list: string): string[] {
  const known = new Set(featureRows(list).map(([name]) => name));
  return CODEX_FEATURES_OFF.filter((f) => known.has(f));
}

/**
 * The enabled features of `codex features list` that Gluon hasn't cleared (not in
 * CODEX_FEATURES_KEPT; features at the "removed" stage do nothing). Throws when the list can't be read.
 */
export function uncheckedFeatures(list: string): string[] {
  return featureRows(list)
    .filter(([name, stage, on]) => on === "true" && stage !== "removed" && !(name! in CODEX_FEATURES_KEPT))
    .map(([name]) => name!);
}

/** Catalog fields that add tools of their own, and the values that add none. */
const CATALOG_TOOLS_OFF = { tool_mode: "direct", apply_patch_tool_type: null, experimental_supported_tools: [], multi_agent_version: null };

/**
 * The other catalog fields Gluon knows (codex 0.161), none of which gives the thread a tool:
 * descriptions, reasoning and context settings, prompts, access programs. `shell_type` and
 * `web_search_tool_type` / `supports_search_tool` only shape tools that are off (shell_tool,
 * web_search, no environment).
 */
const CATALOG_FIELDS = new Set([
  ...Object.keys(CATALOG_TOOLS_OFF),
  "slug", "display_name", "description", "default_reasoning_level", "supported_reasoning_levels", "shell_type", "visibility", "supported_in_api", "priority",
  "additional_speed_tiers", "service_tiers", "availability_nux", "upgrade", "model_messages", "include_skills_usage_instructions", "include_plugin_usage_instructions",
  "include_apps_usage_instructions", "default_reasoning_summary", "support_verbosity", "default_verbosity", "web_search_tool_type", "truncation_policy",
  "supports_image_detail_original", "context_window", "max_context_window", "comp_hash", "effective_context_window_percent", "input_modalities", "supports_search_tool",
  "supports_experimental_context", "use_responses_lite", "supports_reasoning_effort_updates", "node_repl_auto_review_required", "node_repl_disabled",
  "multi_agent_reasoning_effort", "base_instructions", "default_service_tier", "model_specialty", "available_access_programs",
]);

/** A value that sets nothing: null, false, an empty list, string or mapping. */
const unset = (v: unknown) => v === null || v === undefined || v === false || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length);

/**
 * Codex's model catalog (`codex debug models` JSON) with every model's own tools turned off. Throws
 * when it isn't the shape Gluon knows, or a model sets a field Gluon hasn't checked (it may
 * bring tools: fail closed).
 */
export function catalogWithoutTools(json: string): string {
  let catalog: { models?: unknown };
  try {
    catalog = JSON.parse(json);
  } catch {
    throw new Error(`codex's model catalog (\`codex debug models\`) isn't JSON; ${TOO_NEW}`);
  }
  if (!Array.isArray(catalog?.models) || !catalog.models.length) throw new Error(`codex's model catalog (\`codex debug models\`) has no models list; ${TOO_NEW}`);
  const unknown = new Set<string>();
  for (const m of catalog.models as Record<string, unknown>[]) for (const [k, v] of Object.entries(m ?? {})) if (!CATALOG_FIELDS.has(k) && !unset(v)) unknown.add(k);
  if (unknown.size) throw new Error(`${UNSUPPORTED}: its model catalog has fields Gluon hasn't checked (${[...unknown].join(", ")}), which may give the intake agent tools of Codex's own. Update Gluon, or use another step of brain.order`);
  return JSON.stringify({ ...catalog, models: catalog.models.map((m) => ({ ...(m as object), ...CATALOG_TOOLS_OFF })) });
}

/**
 * Runs one `codex` command to its end (30 s at most): its output, errors and exit code. A timeout
 * stops the tree and doesn't wait for the output to close (a child codex started may still hold it).
 */
async function codexOutput(spawn: SpawnCodex, args: string[], timeoutMs = 30_000): Promise<{ out: string; err: string; code: number }> {
  const child = spawn(["codex", ...args], codexEnv());
  child.stdin.end?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      killTree(child);
      resolve(null);
    }, timeoutMs);
  });
  const err = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
  const r = await Promise.race([Promise.all([new Response(child.stdout).text(), err, child.exited]), timedOut]);
  clearTimeout(timer);
  return r ? { out: r[0], err: r[1], code: r[2] } : { out: "", err: "", code: -1 };
}

/** The last line codex wrote to stderr, without colours and masked; "" when there is none. */
function lastLine(text: string): string {
  const last = text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return last ? maskSecrets(last) : "";
}

/** A `codex features list` that ran: its output, or a refusal that says why it didn't. */
async function featuresList(spawn: SpawnCodex, disable: string[]): Promise<string> {
  const r = await codexOutput(spawn, ["features", "list", ...disable.flatMap((f) => ["--disable", f])]);
  if (r.code === 0) return r.out;
  const why = lastLine(r.err);
  throw new Error(`${UNSUPPORTED}: \`codex features list\` failed (exit code ${r.code})${why ? `: ${why}` : ""}`);
}

/** What the app-server is started with: the tool-free catalog's path and the features to turn off. */
type BrainSetup = { catalog: string; off: string[] };

const catalogFiles = new WeakMap<SpawnCodex, Promise<BrainSetup>>();

/** Each model's `supported_reasoning_levels` from the last catalog read; empty until one is. */
let levels: Readonly<Record<string, string[]>> = {};

/** Codex's reasoning levels by model slug, as last read from its catalog (empty until read). */
export function codexLevels(): Readonly<Record<string, string[]>> {
  return levels;
}

/**
 * Checks this codex (once per run): with every feature of CODEX_FEATURES_OFF it knows turned off,
 * no enabled feature Gluon hasn't cleared. Then writes the tool-free catalog to a private temp file:
 * from Codex's own refreshed catalog, else the one bundled with the binary. Returns its path and the
 * features turned off. Never a model call.
 */
function brainCatalog(spawn: SpawnCodex): Promise<BrainSetup> {
  let file = catalogFiles.get(spawn);
  if (file) return file;
  file = (async () => {
    const off = knownFeatures(await featuresList(spawn, []));
    const unchecked = uncheckedFeatures(await featuresList(spawn, off));
    if (unchecked.length) throw new Error(`${UNSUPPORTED}: it has features on that Gluon hasn't checked (${unchecked.join(", ")}), which may give the intake agent tools of Codex's own. Update Gluon, or use another step of brain.order`);
    let json = "";
    for (const args of [["debug", "models"], ["debug", "models", "--bundled"]]) {
      const r = await codexOutput(spawn, args);
      json = r.out;
      if (r.code === 0 && r.out.trim().startsWith("{")) break;
    }
    levels = Object.freeze(codexReasoningLevels(json));
    const dir = mkdtempSync(join(tmpdir(), "gluon-codex-"));
    const path = join(dir, "catalog.json");
    try {
      writeFileSync(path, catalogWithoutTools(json), { mode: 0o600 });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    return { catalog: path, off };
  })();
  catalogFiles.set(spawn, file);
  file.catch(() => catalogFiles.delete(spawn));
  return file;
}

/** What a spawned `codex app-server` must offer; `Bun.spawn` with piped stdio fits. */
export interface ChildLike {
  stdin: { write(chunk: string): unknown; flush?(): unknown; end?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  pid?: number;
  exitCode?: number | null;
  kill(): void;
}

export type SpawnCodex = (argv: string[], env: Record<string, string | undefined>) => ChildLike;

/**
 * The environment for `codex`: the user's own, with nothing added. No token, no base URL: `codex`
 * signs in on its own.
 */
export function codexEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/** What in the user's own environment changes where `codex` sends requests; told, never stripped. */
export function codexEnvWarnings(): string[] {
  const out: string[] = [];
  if (process.env.OPENAI_BASE_URL) out.push("OPENAI_BASE_URL is set in your environment, so `codex` sends its requests there. Unset it to talk to OpenAI directly.");
  return out;
}

/**
 * The app-server command: Codex's own tools are off from the start (the features `off`, the names
 * of CODEX_FEATURES_OFF this codex knows, and the catalog at `catalog`).
 */
export function appServerArgv(catalog: string, off: string[] = CODEX_FEATURES_OFF, codex = "codex"): string[] {
  return [codex, "app-server", ...off.flatMap((f) => ["--disable", f]), "-c", `model_catalog_json=${JSON.stringify(catalog)}`];
}

/** The thread: Gluon's prompt and tools only, read-only, never asking, nothing saved to disk. */
export function threadStartParams(model: string, cwd: string, system: string, mcpServers: string[] = [], off: string[] = CODEX_FEATURES_OFF) {
  return {
    model,
    cwd,
    baseInstructions: system,
    dynamicTools: TOOLS.map((t) => ({ type: "function", name: t.name, description: t.description ?? "", inputSchema: t.input_schema })),
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
    // No execution environment: no apply_patch, nothing that runs on the host.
    environments: [],
    config: {
      ...Object.fromEntries(off.map((f) => [`features.${f}`, false])),
      web_search: "disabled",
      "agents.enabled": false,
      "tools.experimental_request_user_input.enabled": false,
      "skills.include_instructions": false,
      // No AGENTS.md from the repository: the brain runs on Gluon's prompt alone.
      project_doc_max_bytes: 0,
      ...Object.fromEntries(mcpServers.map((name) => [`mcp_servers.${name}.enabled`, false])),
    },
  };
}

function defaultSpawn(argv: string[], env: Record<string, string | undefined>): ChildLike {
  const codex = binPath("codex");
  if (!codex) throw new Error(missingReason("codex"));
  // The thread gets the repository as its cwd (thread/start); the process runs outside it.
  assertShimArgs([codex, ...argv.slice(1)]);
  return Bun.spawn([codex, ...argv.slice(1)], { cwd: neutralCwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
}

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } };

/** One `codex app-server` process: requests, notifications, and the server's own requests. */
class AppServer {
  private next = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderr = "";
  private done = false;
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<unknown> = async () => {
    throw new Error("not supported");
  };
  onExit: (e: Error) => void = () => {};

  constructor(private child: ChildLike) {
    void this.read();
    void this.readErrors();
    void child.exited.then((code) => this.fail(new Error(this.exitReason(code))));
  }

  private async read() {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of this.child.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.dispatch(line);
        }
      }
    } catch {
      // The process ended; `exited` reports why.
    }
  }

  private async readErrors() {
    if (!this.child.stderr) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.child.stderr) this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-4000);
    } catch {}
  }

  private exitReason(code: number): string {
    const last = this.stderr
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    return `codex app-server stopped (exit code ${code})${last ? `: ${last}` : ""}`;
  }

  private dispatch(line: string) {
    let m: Message;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method !== undefined && m.id !== undefined) {
      const id = m.id;
      this.onRequest(m.method, m.params).then(
        (result) => this.send({ id, result }),
        (e: Error) => this.send({ id, error: { code: -32000, message: e.message } }),
      );
    } else if (m.method !== undefined) {
      this.onNotification(m.method, m.params);
    } else if (typeof m.id === "number") {
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.error) w?.reject(new Error(m.error.message ?? "request failed"));
      else w?.resolve(m.result);
    }
  }

  private send(m: Message) {
    if (this.done) return;
    try {
      this.child.stdin.write(JSON.stringify(m) + "\n");
      this.child.stdin.flush?.();
    } catch {}
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.done) return Promise.reject(new Error("codex app-server is not running"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ id, method, params } as Message);
    });
  }

  notify(method: string) {
    this.send({ method });
  }

  /** Ends every request; `onExit` hears of a process that stopped on its own, not of `close`. */
  private fail(e: Error, exited = true) {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
    if (exited) this.onExit(e);
  }

  close() {
    if (this.done) return;
    this.fail(new Error("closed"), false);
    try {
      this.child.stdin.end?.();
    } catch {}
    killTree(this.child);
  }
}

/** initialize (opting into the experimental API that carries `dynamicTools`), then initialized. */
async function handshake(server: AppServer) {
  await server.request("initialize", {
    clientInfo: { name: "gluon", title: "Gluon", version: pkg.version },
    capabilities: { experimentalApi: true },
  });
  server.notify("initialized");
}

/** The user's MCP servers from Codex's effective config, to turn off for this thread. */
async function mcpServerNames(server: AppServer, cwd: string): Promise<string[]> {
  const res = await server.request("config/read", { cwd });
  const names = Object.keys(res?.config?.mcp_servers ?? {});
  const odd = names.find((n) => n.includes("."));
  if (odd) throw new Error(`Codex's MCP server "${odd}" can't be turned off for the intake agent (its name has a dot); rename it in Codex's config`);
  return names;
}

/** Starts the thread and returns its id and the start response. */
async function startThread(server: AppServer, model: string, cwd: string, system: string, off: string[]) {
  await handshake(server);
  const res = await server.request("thread/start", threadStartParams(model, cwd, system, await mcpServerNames(server, cwd), off));
  return { threadId: res.thread.id as string, res };
}

/**
 * The thread items a brain's turn may hold (codex 0.161's `ThreadItem` types): the developer's
 * message, the model's text, reasoning and plan text, Gluon's own tool calls, and Codex's context compaction.
 */
export const BRAIN_ITEMS = new Set(["userMessage", "agentMessage", "reasoning", "plan", "dynamicToolCall", "contextCompaction"]);

/**
 * The other item types of codex 0.161: a tool of Codex's own, or work Gluon never asks for. A type
 * in neither set is new: `scripts/codex-drift.ts` reports it, and the brain refuses it like these.
 */
export const FOREIGN_ITEMS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "functionCallOutput",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "imageGeneration",
  "sleep",
  "hookPrompt",
  "enteredReviewMode",
  "exitedReviewMode",
]);

const GLUON_TOOLS = new Set(TOOLS.map((t) => t.name));

/**
 * The refusal for an `item/started` or `item/completed` whose item the brain must never have: a
 * type outside BRAIN_ITEMS, or a dynamic tool that isn't one of Gluon's. Null for anything else.
 */
export function foreignItem(method: string, p: any): string | null {
  if (method !== "item/started" && method !== "item/completed") return null;
  const item = p?.item;
  const type = typeof item?.type === "string" ? item.type : "an item without a type";
  const what = !BRAIN_ITEMS.has(type) ? type : type === "dynamicToolCall" && !GLUON_TOOLS.has(String(item.tool)) ? `the tool ${JSON.stringify(String(item.tool))}` : null;
  return what && `${UNSUPPORTED}: Codex gave the intake agent a tool of its own (${what}), so Gluon stopped it. Update Gluon, or use another step of brain.order`;
}

/** Approval requests get a denial (the brain never runs commands or edits files); anything else an error. */
const DENIALS: Record<string, unknown> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  execCommandApproval: { decision: "denied" },
  applyPatchApproval: { decision: "denied" },
  "mcpServer/elicitation/request": { action: "decline" },
  "item/permissions/requestApproval": { permissions: {} },
};

type Turn = {
  hooks: LoopHooks;
  resolve: () => void;
  reject: (e: Error) => void;
  id: string | null;
  interrupted: boolean;
  /** The model call in progress: its blocks, whether `end` was called, and tool calls not yet answered. */
  call: { content: Anthropic.ContentBlock[]; ended: boolean } | null;
  texts: Map<string, Anthropic.TextBlock>;
  inflight: number;
  error: string | null;
};

/**
 * The brain on the user's ChatGPT plan. One `codex app-server` and one ephemeral thread live for
 * the whole session; each developer message is a turn. `spawn` is replaceable in tests.
 * `effort` (default medium) goes as every `turn/start`'s `effort`, clamped to the model's
 * `supported_reasoning_levels` in Codex's catalog, none when it lists none (`sentEffort`);
 * `onEffort` hears what is sent once the catalog is read.
 */
export function chatgptPlanBrain(opts: { model: string; cwd: string; spawn?: SpawnCodex; effort?: Effort; onEffort?: (effort: string | null) => void }): LoopBrain {
  const spawn = opts.spawn ?? defaultSpawn;
  let live: { server: AppServer | null; ready: Promise<string>; started: boolean; effort: string | null } | null = null;
  let turn: Turn | null = null;
  /** The app-server stopped after its thread started: the next one starts without it (the developer is told). */
  let lost = false;

  const openCall = (t: Turn) => {
    t.call = { content: [], ended: false };
    t.texts.clear();
    t.hooks.begin();
    return t.call;
  };
  const endCall = (t: Turn) => {
    if (t.call && !t.call.ended) {
      t.call.ended = true;
      t.hooks.end(t.call.content);
    }
  };
  const textBlock = (t: Turn, itemId: string) => {
    let block = t.texts.get(itemId);
    if (block && t.call && !t.call.ended) return block;
    const call = !t.call || t.call.ended ? openCall(t) : t.call;
    block = { type: "text", text: "", citations: null };
    call.content.push(block);
    t.texts.set(itemId, block);
    return block;
  };

  /**
   * Codex gave the brain a tool of its own: the app-server stops at once (with what it runs), the
   * turn fails with why, and the next message starts a new one (the developer is told it forgot).
   */
  const stop = (reason: string) => {
    const session = live;
    live = null;
    lost ||= !!session?.started;
    session?.server?.close();
    turn?.reject(new Error(reason));
  };

  const onNotification = (method: string, p: any) => {
    const foreign = foreignItem(method, p);
    if (foreign) return stop(foreign);
    const t = turn;
    if (!t) return;
    if (p?.turnId && t.id && p.turnId !== t.id) return;
    switch (method) {
      case "turn/started":
        t.id ??= p.turn?.id ?? null;
        if (t.interrupted) interrupt(t);
        break;
      case "item/started":
        if (p.item?.type === "agentMessage") textBlock(t, p.item.id);
        break;
      case "item/agentMessage/delta": {
        const block = textBlock(t, p.itemId);
        block.text += p.delta;
        t.hooks.text(p.delta);
        break;
      }
      case "item/completed":
        if (p.item?.type === "agentMessage" && typeof p.item.text === "string") {
          // Words the deltas didn't carry (a message sent whole) still reach the session.
          const block = textBlock(t, p.item.id);
          if (p.item.text.startsWith(block.text) && p.item.text.length > block.text.length) {
            const rest = p.item.text.slice(block.text.length);
            block.text = p.item.text;
            t.hooks.text(rest);
          }
        }
        break;
      case "error":
        if (!p.willRetry) t.error = turnError(p.error, opts.model);
        break;
      case "turn/completed": {
        if (t.id && p.turn?.id && p.turn.id !== t.id) return;
        endCall(t);
        const status = p.turn?.status;
        if (status === "completed") t.resolve();
        else if (status === "interrupted") t.reject(new Error("Interrupted"));
        else t.reject(new Error(turnError(p.turn?.error, opts.model) ?? t.error ?? "the brain's turn failed"));
        break;
      }
    }
  };

  const onRequest = async (method: string, p: any): Promise<unknown> => {
    if (method !== "item/tool/call") {
      if (method in DENIALS) return DENIALS[method];
      throw new Error(`Gluon does not allow ${method}`);
    }
    const t = turn;
    let out: ToolOutput = { content: "No turn in progress.", error: true };
    if (t) {
      const input = toolInput(p.arguments);
      // A tool call after every earlier one was answered starts a new model call.
      if (!t.call || (t.call.ended && t.inflight === 0)) openCall(t);
      if (!t.call!.ended) {
        t.call!.content.push({ type: "tool_use", id: String(p.callId), name: String(p.tool), input } as Anthropic.ContentBlock);
        endCall(t);
      }
      t.inflight++;
      try {
        out = await t.hooks.tool(String(p.tool), input);
      } finally {
        t.inflight--;
      }
    }
    return { contentItems: [{ type: "inputText", text: out.content }], success: !out.error };
  };

  const start = (system: string) => {
    const session: NonNullable<typeof live> = { server: null, ready: Promise.resolve(""), started: false, effort: null };
    session.ready = (async () => {
      const setup = await brainCatalog(spawn);
      const argv = appServerArgv(setup.catalog, setup.off);
      if (live !== session) throw new Error("closed");
      session.effort = sentEffort({ route: "chatgpt-plan", model: opts.model, ...(opts.effort ? { effort: opts.effort } : {}) }, levels[opts.model]);
      opts.onEffort?.(session.effort);
      const server = (session.server = new AppServer(spawn(argv, codexEnv())));
      server.onNotification = onNotification;
      server.onRequest = onRequest;
      server.onExit = (e) => {
        if (live === session) {
          live = null;
          lost ||= session.started;
        }
        turn?.reject(e);
      };
      const { threadId } = await startThread(server, opts.model, opts.cwd, system, setup.off);
      session.started = true;
      return threadId;
    })();
    session.ready.catch(() => {
      if (live === session) live = null;
      session.server?.close();
    });
    live = session;
    return session;
  };

  const interrupt = (t: Turn) => {
    t.interrupted = true;
    const session = live;
    if (!session || !t.id) return;
    const turnId = t.id;
    void session.ready.then((threadId) => session.server!.request("turn/interrupt", { threadId, turnId })).catch(() => {});
  };

  return {
    send(text, system, hooks, signal) {
      return new Promise<void>((resolve, reject) => {
        const settle = (fn: () => void) => () => {
          if (turn === t) turn = null;
          fn();
        };
        const t: Turn = {
          hooks,
          resolve: () => settle(resolve)(),
          reject: (e) => settle(() => reject(new Error(maskSecrets(explain(e.message, opts.model)))))(),
          id: null,
          interrupted: false,
          call: null,
          texts: new Map(),
          inflight: 0,
          error: null,
        };
        turn = t;
        const restarted = !live && lost;
        let session: NonNullable<typeof live>;
        try {
          session = live ?? start(system);
        } catch (e) {
          return t.reject(e as Error);
        }
        if (restarted) {
          lost = false;
          hooks.restarted?.();
        }
        signal.addEventListener("abort", () => interrupt(t), { once: true });
        session.ready
          .then((threadId) => session.server!.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], ...(session.effort ? { effort: session.effort } : {}) }))
          .then((res) => {
            t.id ??= res?.turn?.id ?? null;
            if (t.interrupted) interrupt(t);
          })
          .catch((e: Error) => t.reject(e));
      });
    },
    close() {
      live?.server?.close();
      live = null;
      turn?.reject(new Error("closed"));
    },
  };
}

/** A tool call's arguments: an object, or a JSON string of one. */
function toolInput(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return toolInput(JSON.parse(args));
    } catch {
      return {};
    }
  }
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/** A readable reason from a failed turn's error. */
function turnError(error: any, model: string): string | null {
  if (!error?.message) return null;
  const info = typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : null;
  if (info === "unauthorized") return "Codex isn't signed in to ChatGPT. Run `codex login`, then try again.";
  if (info === "usageLimitExceeded") return `Your ChatGPT plan's Codex usage limit is reached (${error.message}).`;
  return explain(String(error.message), model);
}

/** The message inside an error that carries a JSON body ({"error": {"message"}}), or the text itself. */
function innerMessage(text: string): string {
  const json = text.slice(text.indexOf("{"));
  if (!json.startsWith("{")) return text.trim();
  try {
    const j = JSON.parse(json) as { error?: { message?: string } | string; message?: string; detail?: string };
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message ?? j.detail);
    return typeof m === "string" && m ? m.trim() : text.trim();
  } catch {
    return text.trim();
  }
}

/** Known failures, said plainly (once: an explained message is left as it is); anything else as Codex put it. */
function explain(message: string, model: string): string {
  if (/^(This codex doesn't support the app-server API|Codex isn't signed in|Your ChatGPT plan's Codex usage limit)/.test(message) || message.startsWith(`${model} isn't available on this ChatGPT plan`)) return message;
  if (/requires experimentalApi|unknown field `?dynamicTools|unrecognized subcommand|unexpected argument/i.test(message)) {
    return `This codex doesn't support the app-server API Gluon needs (${message.trim()}). Update codex.`;
  }
  if (/model/i.test(message) && /not (supported|available|found)|does not exist|unknown model|no access/i.test(message)) {
    return `${model} isn't available on this ChatGPT plan: ${innerMessage(message).replace(/\.$/, "")}.`;
  }
  if (/\b401\b|unauthori[sz]ed|not logged in|not signed in/i.test(message) && !/codex login/.test(message)) {
    return `Codex isn't signed in to ChatGPT (${message.trim()}). Run \`codex login\`, then try again.`;
  }
  return message;
}

/** `codex login status` output, read. Wording as of codex 0.161. */
export function parseLoginStatus(text: string): { loggedIn: boolean; method?: "chatgpt" | "api-key" } | null {
  if (/Logged in using ChatGPT/i.test(text)) return { loggedIn: true, method: "chatgpt" };
  if (/Logged in using an API key/i.test(text)) return { loggedIn: true, method: "api-key" };
  if (/Logged in using/i.test(text)) return { loggedIn: true };
  if (/Not logged in/i.test(text)) return { loggedIn: false };
  return null;
}

/**
 * Whether `codex` is installed and signed in, asked of `codex` itself (`codex login status`), with
 * the same time limit as the other status checks. `transient`: no answer (timed out, unreadable).
 */
export async function codexLoginStatus({ timeoutMs = 15_000 } = {}): Promise<{ installed: boolean; loggedIn: boolean; method?: "chatgpt" | "api-key"; error?: string; transient?: boolean }> {
  const codex = binPath("codex");
  if (!codex) return { installed: false, loggedIn: false, error: missingReason("codex") };
  try {
    const r = await run([codex, "login", "status"], timeoutMs, codexEnv());
    if (r.code === null) return { installed: true, loggedIn: false, transient: true, error: "`codex login status` timed out" };
    const status = parseLoginStatus(`${r.stdout}\n${r.stderr}`);
    if (status) return { installed: true, ...status };
    return { installed: true, loggedIn: false, transient: true, error: maskSecrets(`\`codex login status\` said: ${(r.stdout + r.stderr).trim() || "nothing"}`) };
  } catch (e) {
    return { installed: true, loggedIn: false, transient: true, error: maskSecrets((e as Error).message) };
  }
}

const PROBE_SYSTEM = "You are a connectivity check. Follow the user's instruction exactly.";

/**
 * One tiny turn on the user's ChatGPT plan through `codex app-server`, with the brain's real thread
 * settings. Also checks Codex is signed in with ChatGPT and that no MCP server stays on.
 */
export async function probeChatgptPlan(
  model: string,
  cwd: string,
  opts: { spawn?: SpawnCodex; timeoutMs?: number } = {},
): Promise<{ ok: true; warnings?: string[] } | { ok: false; error: string }> {
  let server: AppServer;
  let setup: BrainSetup;
  try {
    const spawn = opts.spawn ?? defaultSpawn;
    setup = await brainCatalog(spawn);
    server = new AppServer(spawn(appServerArgv(setup.catalog, setup.off), codexEnv()));
  } catch (e) {
    return { ok: false, error: maskSecrets((e as Error).message) };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = async () => {
      await handshake(server);
      const account = (await server.request("account/read", {}))?.account;
      if (!account) throw new Error("Codex isn't signed in. Run `codex login` and sign in with ChatGPT.");
      if (account.type !== "chatgpt") {
        throw new Error(`Codex is signed in with ${account.type === "apiKey" ? "an API key" : account.type}, not a ChatGPT plan. Run \`codex login\` and sign in with ChatGPT.`);
      }
      const names = await mcpServerNames(server, cwd);
      const res = await server.request("thread/start", threadStartParams(model, cwd, PROBE_SYSTEM, names, setup.off));
      const threadId = res.thread.id as string;
      const warnings = (res.instructionSources ?? []).map((s: string) => `Codex adds instructions from ${s} to the brain's prompt.`);
      if (names.length) {
        const status = await server.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" });
        const on = (status?.data ?? []).filter((s: { runtimeStatus?: string | null }) => s.runtimeStatus !== "disabled").map((s: { name: string }) => s.name);
        if (on.length) throw new Error(`Codex's MCP servers ${on.join(", ")} stayed on; the intake agent must see its own tools only.`);
      }
      const done = new Promise<void>((resolve, reject) => {
        let error: string | null = null;
        server.onNotification = (method, p) => {
          const foreign = foreignItem(method, p);
          if (foreign) {
            server.close();
            return reject(new Error(foreign));
          }
          if (method === "error" && !p?.willRetry) error = turnError(p?.error, model);
          if (method !== "turn/completed") return;
          if (p?.turn?.status === "completed") resolve();
          else reject(new Error(turnError(p?.turn?.error, model) ?? error ?? `the turn ended ${p?.turn?.status ?? "without a status"}`));
        };
        server.onExit = reject;
      });
      server.onRequest = async (method) => {
        if (method in DENIALS) return DENIALS[method];
        throw new Error(`Gluon does not allow ${method}`);
      };
      await server.request("turn/start", { threadId, input: [{ type: "text", text: "Reply with the single word: ok", text_elements: [] }] });
      await done;
      return warnings as string[];
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("codex app-server did not answer in time")), opts.timeoutMs ?? 90_000);
    });
    const warnings = await Promise.race([run(), timeout]);
    return warnings.length ? { ok: true, warnings } : { ok: true };
  } catch (e) {
    return { ok: false, error: maskSecrets(explain((e as Error).message, model)) };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
