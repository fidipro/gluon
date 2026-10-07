/**
 * How a session is classified (issue #40): what each harness reports, and the group the row lands in.
 *
 * Every event a harness's hooks are registered for (read from the config Gluon writes, so a new
 * hook can't slip in unclassified) is driven through the harness's own adapter; the state it
 * reports then goes through `runState`, the rule `wire()` uses (an agent's finished turn is awaiting
 * input, never Done: BUG-193). The screen fallback for a harness with no hooks is
 * `test/pty-session.test.ts`; OpenCode's event stream, `test/adapters-opencode.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, adapterOutput } from "../src/adapters/index.ts";
import { CODEX_HOOK_ARGS } from "../src/adapters/codex.ts";
import { grokHooks } from "../src/adapters/permanent.ts";
import type { HookContext } from "../src/adapters/types.ts";
import type { AgentState } from "../src/events.ts";
import { handoffDefaults, handoffFor } from "../src/handoff.ts";
import type { Harness } from "../src/harnesses.ts";
import { runState, type SessionState } from "../src/sessions.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-status-matrix-"));
const hookCtx = (): HookContext => ({ eventsDir: mkdtempSync(join(TMP, "ev-")), pieces: [], answerTimeoutMs: 100 });

/** What a harness registers for status: its own event (`Event`, or `Event[matcher]`) → the hook name Gluon's command passes. */
function registered(harness: Harness): Map<string, string> {
  const out = new Map<string, string>();
  const add = (event: string, command: string, matcher?: string) => {
    const name = /hook (?:claude-code|codex|grok-build) ([\w-]+)'?(?:,|$)/.exec(command)?.[1];
    if (name) out.set(matcher ? `${event}[${matcher}]` : event, name);
  };
  if (harness === "codex") {
    // `-c`, `hooks.<Event>=[{hooks=[{type="command",command='"$GLUON_SELF" hook codex <name>',…`
    for (const arg of CODEX_HOOK_ARGS) {
      const m = /^hooks\.(\w+)=.*?command='[^']*hook codex ([\w-]+)'/.exec(arg);
      if (m) out.set(m[1]!, m[2]!);
    }
    return out;
  }
  let hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  if (harness === "grok-build") hooks = JSON.parse(grokHooks("linux")).hooks;
  else {
    const files = adapterOutput({ harness, version: "2.1.287", handoff: handoffFor(handoffDefaults(), harness), env: {}, platform: "linux" }).files;
    hooks = JSON.parse(files["claude-plugin/hooks/hooks.json"]!).hooks;
  }
  for (const [event, groups] of Object.entries(hooks)) for (const g of groups) for (const h of g.hooks) add(event, h.command, g.matcher);
  return out;
}

/** The group a state lands in for the user: only Ctrl+D makes a row Done. */
const GROUP: Record<AgentState, Exclude<SessionState, "done" | "drafting">> = { working: "working", awaiting: "awaiting", done: "awaiting" };

interface Case {
  /** The harness's own event (`Event`, `Event[matcher]`). */
  event: string;
  /** What the harness sends the hook on stdin. */
  input: object;
  /** What the hook reports; null: nothing (the event says nothing about the session). */
  state: AgentState | null;
  why: string;
}

const base = { session_id: "s", cwd: "/w/repo" };
const CASES: Partial<Record<Harness, Case[]>> = {
  "claude-code": [
    { event: "UserPromptSubmit", input: { ...base, prompt: "fix it" }, state: "working", why: "the user sent a prompt" },
    { event: "PreToolUse", input: { ...base, tool_name: "Bash", tool_input: { command: "bun test" } }, state: "working", why: "a tool is about to run" },
    { event: "PostToolUse", input: { ...base, tool_name: "Bash" }, state: "working", why: "a tool finished (the user may just have allowed it)" },
    { event: "Notification", input: { ...base, notification_type: "permission_prompt", message: "Claude needs your permission" }, state: "awaiting", why: "a permission prompt" },
    { event: "Notification", input: { ...base, notification_type: "elicitation_dialog", message: "Which one?" }, state: "awaiting", why: "a question" },
    { event: "Notification", input: { ...base, notification_type: "idle_prompt", message: "Claude is waiting for your input" }, state: "done", why: "idle at the prompt: the turn is over" },
    { event: "Notification", input: { ...base, notification_type: "auth_success", message: "x" }, state: null, why: "other notifications say nothing" },
    { event: "Notification", input: { ...base, notification_type: "elicitation_url_dialog", message: "Claude Code needs your input" }, state: "awaiting", why: "an MCP link dialog" },
    { event: "PermissionRequest", input: { ...base, tool_name: "Bash", tool_input: { command: "rm -rf build" } }, state: "awaiting", why: "a dialog opens (tool permission, a question, plan approval), before any Notification" },
    { event: "Elicitation", input: { ...base, mcp_server_name: "x", message: "Which one?" }, state: "awaiting", why: "an MCP form opens" },
    { event: "Stop", input: { ...base, stop_hook_active: false }, state: "done", why: "the turn ended" },
    { event: "StopFailure", input: { ...base }, state: "done", why: "the turn ended in an API error (no Stop)" },
  ],
  codex: [
    { event: "UserPromptSubmit", input: { ...base, prompt: "fix it" }, state: "working", why: "the user sent a prompt" },
    { event: "PreToolUse", input: { ...base, tool_name: "Bash", tool_input: { command: "cargo test" } }, state: "working", why: "a tool is about to run" },
    { event: "PostToolUse", input: { ...base, tool_name: "Bash" }, state: "working", why: "a tool finished" },
    { event: "PermissionRequest", input: { ...base, tool_name: "Bash", tool_input: { command: "rm -rf build" } }, state: "awaiting", why: "a permission prompt" },
    { event: "Stop", input: { ...base, stop_hook_active: false }, state: "done", why: "the turn ended" },
  ],
  "grok-build": [
    { event: "UserPromptSubmit", input: { ...base, prompt: "fix it" }, state: "working", why: "the user sent a prompt" },
    { event: "PreToolUse", input: { ...base, tool_name: "Bash", tool_input: { command: "bun test" } }, state: "working", why: "a tool is about to run" },
    { event: "PostToolUse", input: { ...base, tool_name: "Bash" }, state: "working", why: "a tool finished" },
    { event: "Notification[permission_prompt]", input: { ...base, message: "Grok needs your permission" }, state: "awaiting", why: "a permission prompt" },
    { event: "Notification[idle_prompt]", input: { ...base }, state: "done", why: "idle: the backstop for a turn that reported no end" },
    { event: "Stop", input: { ...base }, state: "done", why: "the turn ended" },
    { event: "StopFailure", input: { ...base }, state: "done", why: "the turn ended in a failure" },
    { event: "StopCancelled", input: { ...base }, state: "done", why: "the turn was cancelled" },
  ],
};

for (const [harness, cases] of Object.entries(CASES) as [Harness, Case[]][]) {
  describe(`${harness}: what its hooks report, and the group the row lands in`, () => {
    const hooks = registered(harness);
    const adapter = ADAPTERS[harness];

    test("every event it registers is classified here (a new hook needs a decision), and every case names a registered event", () => {
      const status = [...hooks.keys()].filter((e) => !e.startsWith("PreCompact"));
      expect([...new Set(cases.map((c) => c.event))].sort()).toEqual(status.sort());
    });

    for (const c of cases) {
      const label = `${c.event}${c.input && "notification_type" in c.input ? ` (${c.input.notification_type})` : ""}: ${c.why} → ${c.state ?? "nothing"}${c.state ? `, shown ${GROUP[c.state]}` : ""}`;
      test(label, async () => {
        const name = hooks.get(c.event);
        expect(name).toBeDefined();
        const r = await adapter.hook!(name!, JSON.stringify(c.input), hookCtx());
        // Display only: never any output, never a non-zero exit.
        expect(r.stdout).toBeUndefined();
        expect(r.code ?? 0).toBe(0);
        // A `session` event (the harness's own session id, for `gluon resume`) may go with it; it says nothing about the state.
        const statuses = (r.events ?? []).filter((e) => e.name !== "session");
        if (c.state === null) {
          expect(statuses).toEqual([]);
          return;
        }
        expect(statuses).toHaveLength(1);
        expect(statuses[0]!.name).toBe("status");
        const reported = statuses[0]!.status!.state!;
        expect(reported).toBe(c.state);
        // What the user sees: a finished turn is awaiting input, never Done (BUG-193).
        expect(runState(reported)).toBe(GROUP[c.state]);
      });
    }
  });
}

describe("what no hook can say", () => {
  test("a subagent's own hooks (Grok Build's `subagentType`) say nothing about the session, whatever they are", async () => {
    const hooks = registered("grok-build");
    for (const [event, name] of hooks) {
      if (event.startsWith("PreCompact")) continue;
      const r = await ADAPTERS["grok-build"].hook!(name, JSON.stringify({ subagentType: "explore", tool_name: "Bash", message: "x" }), hookCtx());
      expect([event, r]).toEqual([event, {}]);
    }
  });

  test("Antigravity writes no hook file: its group comes from the screen alone (pty-session.test.ts); its one hook is the opt-in status line's figures", async () => {
    expect(await ADAPTERS.antigravity.hook!("prompt", "{}", hookCtx())).toEqual({});
    const out = adapterOutput({ harness: "antigravity", version: "1.2.14", handoff: handoffFor(handoffDefaults(), "antigravity"), env: {}, platform: "linux" });
    expect(out.files).toEqual({});
    expect(out.argv).toEqual([]);
  });

  test("OpenCode reports through a plugin on its event stream, not hooks (adapters-opencode.test.ts)", () => {
    expect(ADAPTERS.opencode.hook).toBeUndefined();
  });
});

/** Gaps found live on Claude Code 2.1.289 (header of `src/adapters/claude-code.ts`, issue #40), now reported. */
describe("claude-code: gaps found live (issue #40)", () => {
  test("BUG-652/issue-40-url-elicitation: an MCP link dialog (`elicitation_url_dialog`) waits for the user → awaiting", async () => {
    const name = registered("claude-code").get("Notification");
    const input = { ...base, notification_type: "elicitation_url_dialog", message: "Claude Code needs your input" };
    const r = await ADAPTERS["claude-code"].hook!(name!, JSON.stringify(input), hookCtx());
    expect(r.events?.[0]?.status?.state).toBe("awaiting");
    expect(r.events?.[0]?.status?.activity).toBe("Claude Code needs your input");
  });

  test("BUG-653/issue-40-stop-failure: a turn that ends in an API error fires `StopFailure`, not `Stop` → registered, done", async () => {
    const name = registered("claude-code").get("StopFailure");
    expect(name).toBeDefined();
    const r = await ADAPTERS["claude-code"].hook!(name!, JSON.stringify({ ...base, hook_event_name: "StopFailure" }), hookCtx());
    expect(r.events?.[0]?.status?.state).toBe("done");
  });

  test("BUG-653/variants: a dialog's own hooks (`PermissionRequest`, `Elicitation`) are registered and wait for the user at once, before `Notification` 6 s later", async () => {
    for (const event of ["PermissionRequest", "Elicitation"]) {
      const name = registered("claude-code").get(event);
      expect(name).toBeDefined();
      const r = await ADAPTERS["claude-code"].hook!(name!, JSON.stringify({ ...base, hook_event_name: event }), hookCtx());
      expect(r.events?.[0]?.status?.state).toBe("awaiting");
    }
  });
});
