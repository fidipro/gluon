/**
 * Small helpers shared by the per-launch adapters. Light imports only: `gluon hook` loads the
 * adapters on every hook call, inside the agent.
 */
import { randomUUID } from "node:crypto";
import { SESSION_ID, waitAnswer, writeEvent, type AgentEvent, type StatusInfo } from "../events.ts";
import type { HandoffPiece, HandoffSettings } from "../handoff.ts";
import { COMPACT_TIMEOUT_MS } from "../pty/types.ts";
import type { HookResult } from "./types.ts";

/** A `status` event (`events.ts`): display only. */
export const statusEvent = (status: StatusInfo): AgentEvent => ({ name: "status", status });

/**
 * The hook payload's `session_id` as a `session` event (`events.ts`), for a harness whose id Gluon
 * can't mint (Codex). None when it is missing or not a valid id, or when the payload is a
 * sub-agent's (`agent_id`: its own thread, not the session).
 */
export function sessionEvents(input: Record<string, unknown>): AgentEvent[] {
  const id = input.session_id;
  const sub = typeof input.agent_id === "string" && input.agent_id !== "";
  return typeof id === "string" && SESSION_ID.test(id) && !sub ? [{ name: "session", id }] : [];
}

/** How much of one tool argument goes into an activity line (it is cut to `ACTIVITY_MAX` later). */
const ARG_MAX = 300;

/** The first of these fields that is a non-empty string, or a list of strings (joined), cut short. */
function field(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    const s = typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(" ") : undefined;
    if (s?.trim()) return s.trim().slice(0, ARG_MAX);
  }
  return undefined;
}

/** A path under `cwd`, relative to it; otherwise as it is. */
function shortPath(path: string, cwd: unknown): string {
  if (typeof cwd !== "string" || !cwd) return path;
  const base = cwd.replace(/[\\/]+$/, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`) ? path.slice(base.length + 1) : path;
}

/** A command that ends in Gluon's own return command (`RETURN_COMMAND` in `handoff.ts`, or `gluon signal back` by path). */
export const RETURN_COMMAND_RE = /(?:GLUON_SELF|gluon(?:\.exe|\.cmd)?)\}?["']?\s+signal\s+back\s*;?\s*$/i;

/**
 * A tool call as one activity line: "Bash: bun test", "Read src/cli.tsx", "Grep TODO". `tool` is
 * the harness's tool name, `input` its arguments (snake or camel case, as the harnesses send them);
 * a path under `cwd` is shown relative to it. Undefined without a tool name. Made safe to draw
 * (and masked) when the event is read (`parseStatus`). Undefined for Gluon's own return command.
 */
export function toolActivity(tool: unknown, input: unknown, cwd?: unknown): string | undefined {
  if (typeof tool !== "string" || !tool.trim()) return undefined;
  const name = tool.trim().slice(0, 64);
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const command = field(args, ["command", "cmd"]);
  // Gluon's return command isn't the agent's work: the activity before it stays (BUG-186).
  if (command) return RETURN_COMMAND_RE.test(command) ? undefined : `${name}: ${command}`;
  const path = field(args, ["file_path", "filePath", "notebook_path", "target_file", "targetFile", "path", "file"]);
  const target = field(args, ["pattern", "query", "url"]);
  if (target) return path ? `${name} ${target} in ${shortPath(path, cwd)}` : `${name} ${target}`;
  if (path) return `${name} ${shortPath(path, cwd)}`;
  const description = field(args, ["description"]);
  return description ? `${name}: ${description}` : name;
}

/**
 * The status hooks every harness that has hooks shares (Claude Code, Codex, Grok Build): what the
 * agent does, display only. Their result never changes the agent's behaviour: no output, exit 0.
 * - `prompt`: the user sent a prompt → working (Claude Code's adds `/gluon` on top);
 * - `tool`: a tool is about to run → working, with the activity line;
 * - `tool-done`: a tool finished (the user may just have allowed it) → working;
 * - `permission`: a permission prompt waits for the user → awaiting (Claude Code's `PermissionRequest` and
 *   `Elicitation`, Codex's `PermissionRequest`);
 * - `stop`, `idle`: the turn ended → done (Claude Code's `StopFailure` too);
 * - `notify`: Claude Code's Notification, by its `notification_type` (permission or a question →
 *   awaiting, its `message` the activity; idle → done; anything else: nothing).
 * A Grok Build subagent's own hooks (`subagentType`) say nothing about the session. Null for a
 * name that isn't one of these.
 */
export function statusHook(name: string, input: Record<string, unknown>): HookResult | null {
  if (typeof input.subagentType === "string" && input.subagentType) return STATUS_HOOKS.includes(name) ? {} : null;
  const one = (status: StatusInfo): HookResult => ({ events: [statusEvent(status)] });
  switch (name) {
    case "prompt":
    case "tool-done":
      return one({ state: "working" });
    case "tool": {
      const activity = toolActivity(input.tool_name ?? input.toolName, input.tool_input ?? input.toolInput, input.cwd);
      return one(activity ? { state: "working", activity } : { state: "working" });
    }
    case "permission":
      return one({ state: "awaiting" });
    case "stop":
    case "idle":
      return one({ state: "done" });
    case "notify": {
      const type = input.notification_type ?? input.notificationType;
      // What it waits for, as the agent says it ("Claude needs your permission", as 2.1.289 words it): the row's activity.
      const message = typeof input.message === "string" && input.message.trim() ? { activity: input.message.slice(0, 300) } : {};
      if (type === "permission_prompt" || type === "elicitation_dialog" || type === "elicitation_url_dialog") return one({ state: "awaiting", ...message });
      if (type === "idle_prompt") return one({ state: "done" });
      return {};
    }
    default:
      return null;
  }
}

/** The names `statusHook` answers. */
export const STATUS_HOOKS = ["prompt", "tool", "tool-done", "permission", "stop", "idle", "notify"];

/** What a launch enables, from the settings (as `handoffPieces`, as a set). */
export function enabled(s: HandoffSettings): Record<HandoffPiece, boolean> {
  return { clear: s.on_clear === "ask", compact: s.on_compact === "ask" };
}

/** A hook's JSON input, or `{}` when it isn't a JSON object. */
export function hookInput(input: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(input);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** How much longer than Gluon's question a waiting hook waits for its answer. */
export const ANSWER_SLACK_MS = 5_000;
/**
 * The timeout each harness gets for a waiting `PreCompact` hook, in seconds: above the hook's own
 * wait, so the harness never kills it first (it would compact without the user's answer).
 */
export const COMPACT_HOOK_TIMEOUT_S = Math.ceil((COMPACT_TIMEOUT_MS + 10_000) / 1000);

/** The text a hook gives the harness when it stops the compaction. */
export const COMPACT_STOP_REASON = "Gluon ends this session instead of compacting.";

/**
 * A `PreCompact` hook's question (`events.ts`, "Compaction handshake"): true when the user chose
 * to return to Gluon instead of compacting; false when they said stay, didn't answer in time, the piece is off or the event can't be written.
 */
export async function askBeforeCompact(eventsDir: string, pieces: HandoffPiece[], timeoutMs = COMPACT_TIMEOUT_MS + ANSWER_SLACK_MS): Promise<boolean> {
  if (!pieces.includes("compact")) return false;
  const id = randomUUID();
  if (!writeEvent(eventsDir, { name: "compact", id })) return false;
  return (await waitAnswer(eventsDir, id, timeoutMs)) === true;
}
