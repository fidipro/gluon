/**
 * Claude Code: a plugin of Gluon's own, loaded for this launch only with `--plugin-dir` (never
 * installed, nothing in the user's settings or workspace), and a settings file with `--settings`.
 * The plugin's hooks run `gluon hook claude-code <name>` (`hook` below); its command
 * `/gluon:gluon` is caught by a hook before it reaches the model. Hooks run only once the
 * user has trusted the workspace (Claude Code's own dialog). `/clear`, a typed `/compact` and the
 * return key are the PTY's (`src/pty/`): the `PreCompact` hook matters for auto-compaction.
 *
 * Checked by hand on Claude Code 2.1.286 (isolated config dir, a local sink for the API, this
 * adapter's files and the real `gluon hook`):
 * - `PreCompact` blocks with {"decision":"block","reason"}: Claude shows "Compaction blocked by
 *   PreCompact hook: […]: <reason>". No matcher: both `manual` and `auto`.
 * - Typing `/gluon` completes to `/gluon:gluon`; `UserPromptSubmit` sees that text, and
 *   its block reaches no model.
 * - The hooks inherit `GLUON_*`.
 * - SIGTERM: Claude Code exits in ~0.25 s with code 0 and restores the terminal.
 * From the docs (code.claude.com; still not checked live, 2.1.289 included): a hook's `timeout` is in seconds; a
 * plugin can't carry permissions, `--settings` can, and its `permissions.allow` is added to the
 * user's lists; a Bash rule matches the command's text; Windows has a `PowerShell(…)` tool.
 *
 * Status (display only, `statusHook`): `UserPromptSubmit` → working, `PreToolUse` → the activity
 * line, `PostToolUse` → working, `PermissionRequest` and `Elicitation` → awaiting, `Notification` → awaiting
 * (`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`) or done (`idle_prompt`), `Stop` and
 * `StopFailure` → done. All but `UserPromptSubmit` (which
 * may block `/gluon`) are `async`: they run in the background and never hold the agent.
 *
 * Status hooks checked live on Claude Code 2.1.289 (2026-10-04, issue #40): this adapter's files and
 * the real `gluon hook`, a scratch config dir, a mock API on loopback in a network-less namespace
 * (no sign-in, no model), plus a logger plugin on every hook event:
 * - No hook ran before the folder-trust and API-key dialogs were answered (first one: `SessionStart`).
 * - `async` holds: a 4 s `gluon hook` delayed neither the next tool nor `Stop`; the sync
 *   `UserPromptSubmit` holds the prompt for as long as `gluon hook` runs (~0.2 s).
 * - A turn: `UserPromptSubmit`, `PreToolUse`, `PermissionRequest` (a dialog opens), `PostToolUse`,
 *   `PostToolBatch`, `Stop`. A subagent (Agent tool) adds `SubagentStart`/`SubagentStop`; its end is
 *   not `Stop`; its result, back in the main agent, starts a new turn (a `UserPromptSubmit` whose
 *   prompt is "<task-notification>…").
 * - `Stop`: at the moment a turn ends, once per turn. `Notification` `idle_prompt` ("Claude is waiting
 *   for your input"): a timer, 60.0 s after the turn ended (the user setting
 *   `messageIdleNotifThresholdMs`), once per turn; not if a key was touched in those 60 s, not while a
 *   dialog is open, and not after Esc or a refused permission. After an API error the turn ends with
 *   `StopFailure` (no `Stop`) and `idle_prompt` follows 60 s later. So `idle_prompt` is only a backstop.
 * - Waiting for the user, a dialog: `PermissionRequest` at once (tool permission, AskUserQuestion, plan
 *   approval); `Notification` 6 s later, only if the dialog is still open and nothing was typed (answered
 *   sooner: none). Tool permission and AskUserQuestion: `permission_prompt`, message "Claude needs your
 *   permission" (never "… to use Bash"); plan approval: `permission_prompt`, "Claude Code needs your
 *   approval for the plan"; an MCP form (`Elicitation` hook at once): `elicitation_dialog`, "Claude Code
 *   needs your input"; an MCP link: `elicitation_url_dialog`, same message. After the user's answer:
 *   `Notification` `elicitation_response`. Input: `session_id`, `transcript_path`, `cwd`, `prompt_id`,
 *   `hook_event_name`, `message`, `notification_type` (no `title`, no `permission_mode`).
 * Mapped since (BUG-652, BUG-653): `elicitation_url_dialog`, `PermissionRequest`, `Elicitation`, `StopFailure`.
 * Not mapped, so they leave the row as it was (issue #40): Esc during a turn (no hook at
 * all: working until the next prompt); a refused permission (no hook: awaiting, stale activity).
 * Async hooks race: a slow one can write its status after a later one (`done` overtaken by a late
 * `tool-done`'s working), nothing orders them. Read from the binary only (not run): `agent_needs_input`,
 * `agent_completed` (agent view, off here), `worker_permission_prompt` (teammates), `auth_success`,
 * `push_notification` and other types in the `Notification` matcher list; sandbox network, "Session
 * paused" and other dialogs.
 *
 * Agent view off (`disableAgentView` in `--settings`, BUG-207): ← ← on an empty prompt, `/background`
 * and `--bg` would move the conversation to Claude Code's background daemon, out of Gluon's PTY
 * (its hooks see no `GLUON_*`). Checked in the 2.1.287 binary (no model run): the setting is
 * read from the merged settings, `--settings` included ("Disable agent view (`claude agents`,
 * `--bg`, /background, the on-demand daemon)"), and with it off the ← gesture has no handler.
 */
import { RETURN_COMMAND } from "../handoff.ts";
import { askBeforeCompact, COMPACT_HOOK_TIMEOUT_S, COMPACT_STOP_REASON, enabled, hookInput, statusHook } from "./common.ts";
import { ADAPTER_DIR, NO_ADAPTER, type Adapter, type AdapterContext } from "./types.ts";

/** The plugin's name; its command is `/<PLUGIN>:<COMMAND>`. */
const PLUGIN = "gluon";
export const CLAUDE_COMMAND = `/${PLUGIN}:gluon`;
export const CLAUDE_PLUGIN_DIR = `${ADAPTER_DIR}/claude-plugin`;
export const CLAUDE_SETTINGS = `${ADAPTER_DIR}/claude-settings.json`;
const PROMPT = new RegExp(`^/${PLUGIN}(:gluon)?(\\s|$)`);

/**
 * The permission rules that let Claude run Gluon's return command (`RETURN_COMMAND`) without
 * asking: exactly that command, as written and without its quotes; PowerShell's on Windows.
 */
export function returnRules(windows: boolean): string[] {
  const bash = [`Bash(${RETURN_COMMAND.posix})`, `Bash(${RETURN_COMMAND.posix.replaceAll('"', "")})`];
  return windows ? [...bash, `PowerShell(${RETURN_COMMAND.powershell})`] : bash;
}

/**
 * A command hook. POSIX: Claude Code runs it with `sh -c` (or the user's $SHELL). Windows: Git Bash
 * when installed, else PowerShell — one string can't run in both, so the hook names PowerShell
 * (`shell`, pwsh or Windows PowerShell 5.1) and pipes its stdin (`$input`) on to Gluon. Exec
 * form (`args`) can't be used: it expands no variables and can't start a `.cmd` (`self.ts` on Windows).
 * Without `GLUON_SELF` (a process Claude started outside the launch) it does nothing, quietly
 * (BUG-207: "/bin/sh: 1: : Permission denied" on every prompt).
 */
function hook(name: string, windows: boolean, { timeout, async }: { timeout?: number; async?: boolean } = {}) {
  const h = windows
    ? { type: "command", shell: "powershell", command: `if ($env:GLUON_SELF) { $input | & $env:GLUON_SELF hook claude-code ${name} }` }
    : { type: "command", command: `[ -z "$GLUON_SELF" ] || "$GLUON_SELF" hook claude-code ${name}` };
  return { ...h, ...(timeout ? { timeout } : {}), ...(async ? { async: true } : {}) };
}

/** A status hook's timeout (seconds): it only writes one small file. */
const STATUS_TIMEOUT_S = 10;

/**
 * The plugin's function-hooks module (audit only): after each turn Claude Code's own
 * `session.measure` says how many tokens the context holds, the model's window and the session's cost
 * so far (what its status line shows); this sends them to Gluon as a `status` event, so Gluon
 * can audit its own context % and cost against them (`src/cost/`): they are recorded in the ledger and never shown.
 * Checked on Claude Code 2.1.289 against a fake API: it loads with default settings (also with the user's own OTEL settings), once the folder is trusted;
 * `disableAllHooks` refuses it (the OpenTelemetry figures stay). `$` is only used through
 * top-level functions (the validator refuses it otherwise). It writes one small file per measure
 * into the launch's events directory and does nothing outside a Gluon launch.
 */
export const MEASURE_MODULE = `import type { Register } from 'claude-code'

let written = 0
async function send($: any, info: Record<string, number>) {
  const dir = await $.env.get('GLUON_EVENTS')
  if (!dir) return
  const name = String(Date.now()).padStart(15, '0') + '-' + String(++written).padStart(6, '0') + '-claude-' + Math.random().toString(36).slice(2, 8) + '.event'
  try { await $.fs.write(dir + '/' + name, 'status ' + JSON.stringify(info)) } catch {}
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

export const register: Register = (on) => {
  on('session.measure', async ($, e, next) => {
    try {
      const info: Record<string, number> = {}
      const c = e.context
      if (c && finite(c.tokens)) info.contextTokens = Math.round(c.tokens)
      if (c && finite(c.window) && c.window > 0) info.contextWindow = Math.round(c.window)
      if (e.cost && finite(e.cost.usd)) info.costUsd = e.cost.usd
      if (Object.keys(info).length) await send($, info)
    } catch {}
    return next(e)
  })
}
`

export const claudeCode: Adapter = {
  harness: "claude-code",
  // 2.1.139: hooks' `shell` field (checked in the 2.1.139 binary); it already has blocking
  // PreCompact (2.1.105) and graceful exit on SIGTERM (2.1.132).
  minVersion: "2.1.139",

  build(ctx: AdapterContext) {
    const on = enabled(ctx.handoff);
    const windows = (ctx.platform ?? process.platform) === "win32";
    const hooks: Record<string, { matcher?: string; hooks: object[] }[]> = {};
    // Waits for the user's answer: Claude must not kill it first.
    if (on.compact) hooks.PreCompact = [{ hooks: [hook("pre-compact", windows, { timeout: COMPACT_HOOK_TIMEOUT_S })] }];
    // Always: the command that brings the user back (and the status: working).
    hooks.UserPromptSubmit = [{ hooks: [hook("prompt", windows)] }];
    // Always: the status, in the background.
    const status = (name: string) => [{ hooks: [hook(name, windows, { timeout: STATUS_TIMEOUT_S, async: true })] }];
    hooks.PreToolUse = status("tool");
    hooks.PostToolUse = status("tool-done");
    hooks.Notification = status("notify");
    hooks.Stop = status("stop");
    // A dialog waits for the user the moment it opens (`Notification` follows 6 s later, if at all): a tool
    // permission, AskUserQuestion, plan approval; an MCP form (`Elicitation`). A turn that ends in an API
    // error fires `StopFailure`, not `Stop` (BUG-652, BUG-653).
    hooks.PermissionRequest = status("permission");
    hooks.Elicitation = status("permission");
    hooks.StopFailure = status("stop");
    const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
    const files: Record<string, string> = {
      "claude-plugin/.claude-plugin/plugin.json": json({ name: PLUGIN, version: "1.0.0", description: "Back to Gluon: added by Gluon for this session only" }),
      "claude-plugin/hooks/hooks.json": json({ hooks, modules: ["./measure.ts"] }),
      "claude-plugin/hooks/measure.ts": MEASURE_MODULE,
      "claude-plugin/commands/gluon.md":
        "---\ndescription: Back to Gluon's sessions home (this session keeps running)\ndisable-model-invocation: true\n---\n" +
        "Tell the user, in one sentence, that Gluon couldn't be reached from here, and that its home key (Ctrl+\\ by default), pressed twice, shows their sessions.\n",
    };
    // Agent view off: the conversation stays in Gluon's PTY (BUG-207). Claude may run the return
    // command (the user asked for it) without a permission prompt.
    files["claude-settings.json"] = json({ disableAgentView: true, permissions: { allow: returnRules(windows) } });
    const argv = ["--plugin-dir", CLAUDE_PLUGIN_DIR, "--settings", CLAUDE_SETTINGS];
    return { ...NO_ADAPTER, argv, files };
  },

  notes(ctx) {
    const on = enabled(ctx.handoff);
    return [
      on.compact ? "auto-compaction asks first whether to end the session instead" : "auto-compaction: Claude compacts (on_compact: stay)",
      "Gluon's return command (`signal back`) runs without a permission prompt",
      `${CLAUDE_COMMAND} shows Gluon's sessions home`,
      "its status and latest activity show in Gluon (hooks in the background)",
      "agent view is off (← ← and /background would move the conversation out of Gluon)",
      "hooks run once you trust the folder in Claude Code",
    ];
  },

  async hook(name, input, { eventsDir, pieces, answerTimeoutMs }) {
    switch (name) {
      case "pre-compact":
        return (await askBeforeCompact(eventsDir, pieces, answerTimeoutMs)) ? { stdout: JSON.stringify({ decision: "block", reason: COMPACT_STOP_REASON }) } : {};
      case "prompt": {
        const data = hookInput(input);
        if (typeof data.prompt === "string" && PROMPT.test(data.prompt.trim())) {
          return { events: [{ name: "back" }], stdout: JSON.stringify({ decision: "block", reason: "Back to Gluon…" }) };
        }
        return statusHook(name, data) ?? {};
      }
      default:
        return statusHook(name, hookInput(input)) ?? {};
    }
  },
};
