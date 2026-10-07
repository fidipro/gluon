/**
 * Codex: per-launch `-c` overrides, one per hook event, and nothing written anywhere: the
 * `PreCompact` hook that asks before an auto-compaction (`/clear`, `/new`, a typed `/compact` and
 * the return key are the PTY's: `src/pty/`) and the status hooks (`statusHook`, display only).
 * Hooks need Codex's own one-time "Hooks need review" approval; Codex stores it in its config,
 * keyed by event and position and a hash of the hook, so the set here is ONE constant: the same
 * bytes whatever the settings, launch, install or platform (`$GLUON_SELF` is resolved by the
 * shell, not written in; `on_compact: stay` is the hook's own no, from `GLUON_HANDOFF`). Change
 * it only on purpose: every user reviews it again. One `-c` per event (`hooks.<Event>=…`), never
 * `hooks=…`, which would replace the user's whole table, its stored approvals with it.
 *
 * Status hooks (event names and inputs from Codex's source, `codex-rs/config/src/hook_config.rs`
 * and `hooks/schema/generated/*.input.schema.json`): `UserPromptSubmit` → working, `PreToolUse` →
 * the activity line (`tool_name`, `tool_input`), `PostToolUse` → working, `PermissionRequest` →
 * awaiting, `Stop` → done. Empty output: no decision. The tool hooks are `async` (run in the
 * background, in Codex's source); a Codex that doesn't know the field runs them in line (a fast
 * `gluon hook`).
 *
 * Run on Codex 0.159.3, 2026-10-04 (tmux, scratch CODEX_HOME, a loopback mock Responses provider,
 * `gluon hook` through a logging wrapper; screens in `test/fixtures/screens/codex/`): the events,
 * their inputs (`tool_name` `Bash` / `apply_patch` / the tool's own name, `tool_input`, `prompt`)
 * and `async` (PreToolUse and PermissionRequest started within 25 ms of each other) work as above:
 * - A text turn: UserPromptSubmit, Stop. A command to approve: UserPromptSubmit, PreToolUse,
 *   PermissionRequest (once per approval, also for `apply_patch`, which has no PostToolUse), then
 *   PostToolUse (when approved) and Stop. An answered `request_user_input`: PostToolUse, Stop.
 * - Not as assumed, no change made (issue #40): (1) the async PreToolUse (working + activity) and
 *   PermissionRequest (awaiting) each take a `gluon` start-up and land in either order, awaiting
 *   first in 8 of 19 runs: the approval then shows as working. (2) Nothing fires for an
 *   approval denied or a turn interrupted with Esc (no PostToolUse, no Stop): the status stays
 *   working or awaiting at an idle composer. (3) A `request_user_input` question fires PreToolUse
 *   only (working, activity "request_user_input"), no PermissionRequest. (4) The folder trust
 *   question and the "Hooks need review" screen come before any hook can run. The screen reader
 *   (`awaitsChoice`) covers (3) and (4) and the approval dialogs once the output is quiet.
 * Not yet checked: MCP elicitations, network approvals, Codex's other pickers when it waits.
 *
 * Session id: every hook payload has `session_id` (required in all of Codex's generated input
 * schemas; a sub-agent's carries `agent_id` too); the hook also sends a `session` event for
 * `gluon resume` (`sessionEvents`).
 *
 * Checked by hand on Codex 0.159.3 (isolated CODEX_HOME, a local sink as the model provider) and
 * in its source:
 * - Hooks run as `$SHELL -lc <command>`, on Windows `%COMSPEC% /C "<command_windows>"`; they
 *   inherit Codex's environment.
 * - `PreCompact`'s `{"continue":false}` aborts the compaction (a `systemMessage` doesn't).
 * - Approval persists across launches while the hooks are byte-identical (relaunch: no review).
 * - SIGTERM: Codex exits in ~60 ms with code 0, restores the tty mode but leaves the alternate
 *   screen on (Gluon's reset leaves it).
 * Not yet checked live: `continue:false` aborts the turn with the compaction (acceptable: Gluon
 * ends Codex next); a command hook's `timeout` is in seconds (the field is in the 0.159 binary).
 *
 * Values: a `-c` value is TOML, or a plain string when it isn't valid TOML. TOML literal strings
 * ('…') hold the commands, so nothing in them needs escaping. These arguments have `"`, `[`, `{`, `%`
 * and `$`, which a `.cmd` shim can't take (`assertShimArgs`): on Windows Codex runs as its native
 * `codex.exe` (`nativeExe`), as it already must for `model_reasoning_effort="…"`.
 */
import { writeEvent } from "../events.ts";
import { askBeforeCompact, COMPACT_HOOK_TIMEOUT_S, COMPACT_STOP_REASON, enabled, hookInput, sessionEvents, statusEvent, statusHook } from "./common.ts";
import { NO_ADAPTER, type Adapter, type AdapterContext } from "./types.ts";

/** One command hook, the same bytes on every platform (both commands are always given). */
const hook = (name: string, timeout: number, async = false) =>
  `{type="command",command='"$GLUON_SELF" hook codex ${name}',command_windows='"%GLUON_SELF%" hook codex ${name}',timeout=${timeout}${async ? ",async=true" : ""}}`;

/** A status hook's timeout (seconds): it only writes one small file. */
const STATUS_TIMEOUT_S = 10;

/** The hook set: event → its one hook. Constant (see above). */
const HOOKS: [event: string, hook: string][] = [
  // Waits for the user's answer: Codex must not kill it first.
  ["PreCompact", hook("pre-compact", COMPACT_HOOK_TIMEOUT_S)],
  ["UserPromptSubmit", hook("prompt", STATUS_TIMEOUT_S)],
  ["PreToolUse", hook("tool", STATUS_TIMEOUT_S, true)],
  ["PostToolUse", hook("tool-done", STATUS_TIMEOUT_S, true)],
  ["PermissionRequest", hook("permission", STATUS_TIMEOUT_S)],
  ["Stop", hook("stop", STATUS_TIMEOUT_S)],
];

/** The `-c` overrides that add the hook set. */
export const CODEX_HOOK_ARGS: readonly string[] = HOOKS.flatMap(([event, h]) => ["-c", `hooks.${event}=[{hooks=[${h}]}]`]);

export const codex: Adapter = {
  harness: "codex",
  // 0.159: hooks as checked above.
  minVersion: "0.159",

  build(_ctx: AdapterContext) {
    return { ...NO_ADAPTER, argv: [...CODEX_HOOK_ARGS] };
  },

  notes(ctx) {
    return [
      enabled(ctx.handoff).compact ? "auto-compaction asks first whether to end the session instead" : "auto-compaction: Codex compacts (on_compact: stay)",
      "its status and latest activity show in Gluon",
      'Codex asks once to approve Gluon\'s hooks ("Hooks need review"): choose to trust them',
    ];
  },

  async hook(name, input, { eventsDir, pieces, answerTimeoutMs }) {
    const data = hookInput(input);
    // Every hook payload carries `session_id`; Gluon keeps the first (`resume`, `src/workspaces.ts`).
    const events = sessionEvents(data);
    if (name === "pre-compact") {
      // Written now, not with the result: a yes ends the agent before this hook returns.
      for (const e of events) writeEvent(eventsDir, e);
      // Display only: Codex's telemetry names no compaction, and the compaction's own request would read as the context (issue #39).
      writeEvent(eventsDir, statusEvent({ compacting: true }));
      return (await askBeforeCompact(eventsDir, pieces, answerTimeoutMs)) ? { stdout: JSON.stringify({ continue: false, stopReason: COMPACT_STOP_REASON }) } : {};
    }
    const r = statusHook(name, data) ?? {};
    return events.length ? { ...r, events: [...events, ...(r.events ?? [])] } : r;
  },
};
