/** The Claude Code and Codex adapters (issue #13): what each adds per setting and version, and their hooks. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_COMMAND, CLAUDE_PLUGIN_DIR, CLAUDE_SETTINGS, claudeCode, MEASURE_MODULE, returnRules } from "../src/adapters/claude-code.ts";
import { codex } from "../src/adapters/codex.ts";
import { askBeforeCompact, COMPACT_HOOK_TIMEOUT_S, COMPACT_STOP_REASON } from "../src/adapters/common.ts";
import { adapterOutput } from "../src/adapters/index.ts";
import { ADAPTER_DIR, NO_ADAPTER, type Adapter, type AdapterContext, type HookContext, type HookResult } from "../src/adapters/types.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { assertShimArgs, unsafeChar } from "../src/detect.ts";
import { parseEvent, readEvents, writeAnswer } from "../src/events.ts";
import { RETURN_COMMAND, type HandoffPiece, type HandoffSettings } from "../src/handoff.ts";
import type { Harness } from "../src/harnesses.ts";
import { buildCommand } from "../src/launchers.ts";
import { COMPACT_TIMEOUT_MS } from "../src/pty/types.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-adapters-test-"));
const saved = process.env.GLUON_CONFIG;
beforeAll(() => {
  process.env.GLUON_CONFIG = join(TMP, "config.yaml");
});
afterAll(() => {
  if (saved === undefined) delete process.env.GLUON_CONFIG;
  else process.env.GLUON_CONFIG = saved;
  rmSync(TMP, { recursive: true, force: true });
});

const ALL: HandoffSettings = { on_exit: "return", on_clear: "ask", on_compact: "ask", key: "ctrl+]" };
const NONE: HandoffSettings = { on_exit: "return", on_clear: "stay", on_compact: "stay", key: "ctrl+]" };
const ctx = (harness: Harness, version: string | null, handoff: Partial<HandoffSettings> = {}, platform: NodeJS.Platform = "linux"): AdapterContext => ({
  harness,
  version,
  handoff: { ...ALL, ...handoff },
  platform,
});
let n = 0;
/** A fresh events directory for a hook; a waiting hook gives up after `answerTimeoutMs`. */
const hookCtx = (pieces: HandoffPiece[] = ["clear", "compact"], answerTimeoutMs = 5000): HookContext => ({ eventsDir: mkdtempSync(join(TMP, `ev-${++n}-`)), pieces, answerTimeoutMs });

/** Runs a waiting `pre-compact` hook and answers its `compact <id>` event like Gluon would (`null`: never). */
async function compactHook(adapter: Adapter, answer: boolean | null, c = hookCtx(undefined, answer === null ? 300 : 5000)) {
  const run = adapter.hook!("pre-compact", '{"trigger":"auto"}', c);
  const seen = new Set<string>();
  let asked: { name: string; id?: string }[] = [];
  for (let i = 0; i < 200 && !asked.length; i++) {
    // (Codex's hook also sends a display-only `status` first: the question is the `compact` event.)
    asked = readEvents(c.eventsDir, seen).filter((e) => e.name === "compact");
    await Bun.sleep(10);
  }
  if (answer !== null && asked[0]?.id) writeAnswer(c.eventsDir, asked[0].id, answer);
  return { result: await run, asked };
}

// Hook inputs as the harnesses sent them in the spikes (paths shortened).
const CLAUDE_PROMPT = (prompt: string) => JSON.stringify({ session_id: "b200d418-9522-4b31-98d3-df97c5c52494", transcript_path: "/t/x.jsonl", cwd: "/w", permission_mode: "auto", hook_event_name: "UserPromptSubmit", prompt });

describe("the waiting compaction question (askBeforeCompact)", () => {
  test("its timeouts: the harness gives the hook more time than the hook waits, which is more than Gluon asks", () => {
    expect(COMPACT_HOOK_TIMEOUT_S * 1000).toBeGreaterThanOrEqual(COMPACT_TIMEOUT_MS + 10_000);
  });

  test("writes `compact <id>` and resolves with the answer; no answer in time → compact", async () => {
    for (const answer of [true, false]) {
      const c = hookCtx();
      const run = askBeforeCompact(c.eventsDir, c.pieces, 5000);
      let asked: { name: string; id?: string }[] = [];
      for (let i = 0; i < 200 && !asked.length; i++) {
        asked = readEvents(c.eventsDir, new Set());
        await Bun.sleep(10);
      }
      expect(asked).toEqual([{ name: "compact", id: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
      writeAnswer(c.eventsDir, asked[0]!.id!, answer);
      expect(await run).toBe(answer);
    }
    const c = hookCtx();
    const t = Date.now();
    expect(await askBeforeCompact(c.eventsDir, c.pieces, 200)).toBe(false);
    expect(Date.now() - t).toBeGreaterThanOrEqual(150);
  });

  test("BUG-151: the events directory gone while it waits (Gluon ended the agent on a yes): it ends quietly, at once", async () => {
    const c = hookCtx();
    const run = askBeforeCompact(c.eventsDir, c.pieces, 5000);
    for (let i = 0; i < 200 && !readEvents(c.eventsDir, new Set()).length; i++) await Bun.sleep(10);
    const t = Date.now();
    rmSync(c.eventsDir, { recursive: true, force: true });
    expect(await run).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  test("never asks with the piece off or an events directory that can't be written", async () => {
    const c = hookCtx(["clear"]);
    expect(await askBeforeCompact(c.eventsDir, c.pieces, 5000)).toBe(false);
    expect(readdirSync(c.eventsDir)).toEqual([]);
    expect(await askBeforeCompact(join(TMP, "missing"), ["compact"], 5000)).toBe(false);
  });
});

describe("Claude Code adapter", () => {
  const files = (c: AdapterContext) => claudeCode.build(c).files;
  const hooks = (c: AdapterContext) => JSON.parse(files(c)["claude-plugin/hooks/hooks.json"]!).hooks;
  const command = (name: string) => `[ -z "$GLUON_SELF" ] || "$GLUON_SELF" hook claude-code ${name}`;
  const cmd = (name: string, timeout?: number) => [{ type: "command", command: command(name), ...(timeout ? { timeout } : {}) }];
  /** A status hook: in the background, never holding Claude. */
  const status = (name: string) => [{ hooks: [{ type: "command", command: command(name), timeout: 10, async: true }] }];
  const STATUS = { PreToolUse: status("tool"), PostToolUse: status("tool-done"), Notification: status("notify"), Stop: status("stop"), PermissionRequest: status("permission"), Elicitation: status("permission"), StopFailure: status("stop") };

  test("everything on: the plugin (waiting PreCompact, /gluon) and the settings that allow the return command", () => {
    const out = claudeCode.build(ctx("claude-code", "2.1.286"));
    expect(out.argv).toEqual(["--plugin-dir", `${ADAPTER_DIR}/claude-plugin`, "--settings", `${ADAPTER_DIR}/claude-settings.json`]);
    expect([CLAUDE_PLUGIN_DIR, CLAUDE_SETTINGS]).toEqual([`${ADAPTER_DIR}/claude-plugin`, `${ADAPTER_DIR}/claude-settings.json`]);
    expect(out.env).toEqual({});
    expect(Object.keys(out.files).sort()).toEqual([
      "claude-plugin/.claude-plugin/plugin.json",
      "claude-plugin/commands/gluon.md",
      "claude-plugin/hooks/hooks.json",
      "claude-plugin/hooks/measure.ts",
      "claude-settings.json",
    ]);
    // The function-hooks module (Claude Code's own context window and cost after each turn) rides in the same hooks.json.
    expect(JSON.parse(out.files["claude-plugin/hooks/hooks.json"]!).modules).toEqual(["./measure.ts"]);
    expect(JSON.parse(out.files["claude-plugin/.claude-plugin/plugin.json"]!).name).toBe("gluon");
    expect(out.files["claude-plugin/commands/gluon.md"]).toStartWith("---\ndescription: Back to Gluon's sessions home (this session keeps running)\ndisable-model-invocation: true\n---\n");
    expect(CLAUDE_COMMAND).toBe("/gluon:gluon");
    // No matcher: manual and auto; a timeout (seconds) above the hook's own wait.
    // The status hooks are async; /gluon's UserPromptSubmit isn't (it blocks the prompt).
    expect(hooks(ctx("claude-code", "2.1.286"))).toEqual({
      PreCompact: [{ hooks: cmd("pre-compact", COMPACT_HOOK_TIMEOUT_S) }],
      UserPromptSubmit: [{ hooks: cmd("prompt") }],
      ...STATUS,
    });
    expect(JSON.parse(out.files["claude-settings.json"]!)).toEqual({ disableAgentView: true, permissions: { allow: ['Bash("$GLUON_SELF" signal back)', "Bash($GLUON_SELF signal back)"] } });
  });

  test("BUG-207/live: every launch turns Claude Code's agent view off (← ←, /background, --bg), whatever the settings", () => {
    for (const handoff of [{}, { on_clear: "stay" }, { on_clear: "stay", on_compact: "stay" }] as const) {
      const out = claudeCode.build(ctx("claude-code", "2.1.287", handoff));
      expect(out.argv).toEqual(["--plugin-dir", `${ADAPTER_DIR}/claude-plugin`, "--settings", `${ADAPTER_DIR}/claude-settings.json`]);
      expect(JSON.parse(out.files["claude-settings.json"]!).disableAgentView).toBe(true);
    }
    const none = claudeCode.build({ ...ctx("claude-code", "2.1.287"), handoff: NONE });
    expect(JSON.parse(none.files["claude-settings.json"]!)).toEqual({ disableAgentView: true, permissions: { allow: returnRules(false) } });
  });

  test.if(process.platform !== "win32")("BUG-207/live: a hook run without GLUON_SELF (outside the launch) does nothing, quietly; inside it runs Gluon", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-claude-hook-"));
    try {
      const self = join(dir, "self with space");
      writeFileSync(self, `#!/bin/sh\nprintf '%s|' "$@"; cat\n`, { mode: 0o700 });
      const sh = (env: Record<string, string>) => {
        const r = Bun.spawnSync(["/bin/sh", "-c", hooks(ctx("claude-code", "2.1.287")).UserPromptSubmit[0].hooks[0].command], { env, stdin: Buffer.from('{"x":1}'), stdout: "pipe", stderr: "pipe" });
        return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
      };
      expect(sh({})).toEqual({ code: 0, out: "", err: "" });
      expect(sh({ GLUON_SELF: "" })).toEqual({ code: 0, out: "", err: "" });
      expect(sh({ GLUON_SELF: self })).toEqual({ code: 0, out: 'hook|claude-code|prompt|{"x":1}', err: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the allowed command is exactly Gluon's return command, and nothing wider", () => {
    expect(returnRules(false)).toEqual([`Bash(${RETURN_COMMAND.posix})`, "Bash($GLUON_SELF signal back)"]);
    expect(returnRules(true)).toEqual([...returnRules(false), `PowerShell(${RETURN_COMMAND.powershell})`]);
    // No wildcard, no prefix rule.
    for (const rule of returnRules(true)) expect(rule).not.toContain("*");
  });

  test("each setting off drops its part; the /gluon command and the status always stay", () => {
    expect(Object.keys(hooks(ctx("claude-code", "2.1.286", { on_clear: "stay" })))).toEqual(["PreCompact", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "PermissionRequest", "Elicitation", "StopFailure"]);
    expect(hooks(ctx("claude-code", "2.1.286", { on_compact: "stay" }))).toEqual({ UserPromptSubmit: [{ hooks: cmd("prompt") }], ...STATUS });
    const none = { ...ctx("claude-code", "2.1.286"), handoff: NONE };
    expect(hooks(none)).toEqual({ UserPromptSubmit: [{ hooks: cmd("prompt") }], ...STATUS });
  });

  test("v1's routes are gone: no SessionEnd, SessionStart, MCP server", () => {
    const out = claudeCode.build(ctx("claude-code", "2.1.286"));
    const text = JSON.stringify(out);
    for (const gone of ["SessionEnd", "SessionStart", ".mcp.json", "mcpServers", '"mcp"']) expect(text).not.toContain(gone);
  });

  test("on Windows the hooks run in PowerShell and pass their input on; PowerShell's return command is allowed too", () => {
    const c = ctx("claude-code", "2.1.286", {}, "win32");
    const h = hooks(c);
    expect(h.PreCompact[0].hooks).toEqual([{ type: "command", shell: "powershell", command: "if ($env:GLUON_SELF) { $input | & $env:GLUON_SELF hook claude-code pre-compact }", timeout: COMPACT_HOOK_TIMEOUT_S }]);
    for (const groups of Object.values(h) as { hooks: { shell?: string }[] }[][]) for (const g of groups) expect(g.hooks[0]!.shell).toBe("powershell");
    expect(JSON.parse(files(c)["claude-settings.json"]!).permissions.allow).toContain("PowerShell(& $env:GLUON_SELF signal back)");
  });

  test("version gate: nothing below 2.1.139 or when the version is unknown", () => {
    expect(claudeCode.minVersion).toBe("2.1.139");
    expect(adapterOutput(ctx("claude-code", "2.1.138 (Claude Code)"))).toBe(NO_ADAPTER);
    expect(adapterOutput(ctx("claude-code", null))).toBe(NO_ADAPTER);
    expect(adapterOutput(ctx("claude-code", "2.1.139 (Claude Code)")).argv[0]).toBe("--plugin-dir");
  });

  test("pre-compact: yes blocks the compaction, no or no answer lets it go on", async () => {
    const yes = await compactHook(claudeCode, true);
    expect(yes.asked.map((e) => e.name)).toEqual(["compact"]);
    expect(yes.result).toEqual({ stdout: JSON.stringify({ decision: "block", reason: COMPACT_STOP_REASON }) });
    expect(COMPACT_STOP_REASON).toBe("Gluon ends this session instead of compacting.");
    expect((await compactHook(claudeCode, false)).result).toEqual({});
    expect((await compactHook(claudeCode, null)).result).toEqual({});
    // With the piece off: no question at all.
    const off = hookCtx(["clear"]);
    expect(await claudeCode.hook!("pre-compact", "{}", off)).toEqual({});
    expect(readdirSync(off.eventsDir)).toEqual([]);
  });

  test("/gluon: blocked before the model, and back to Gluon whatever the settings", async () => {
    const back: HookResult = { events: [{ name: "back" }], stdout: JSON.stringify({ decision: "block", reason: "Back to Gluon…" }) };
    for (const p of ["/gluon:gluon", "/gluon", " /gluon:gluon ", "/gluon:gluon now"]) expect([p, await claudeCode.hook!("prompt", CLAUDE_PROMPT(p), hookCtx([]))]).toEqual([p, back]);
    // Any other prompt goes on (no output), and the agent is working.
    const working: HookResult = { events: [{ name: "status", status: { state: "working" } }] };
    for (const p of ["hi", "/gluonx", "tell me about /gluon:gluon", "/clear"]) expect([p, await claudeCode.hook!("prompt", CLAUDE_PROMPT(p), hookCtx())]).toEqual([p, working]);
    expect(await claudeCode.hook!("prompt", "not json", hookCtx())).toEqual(working);
    expect(await claudeCode.hook!("prompt", '{"prompt":42}', hookCtx())).toEqual(working);
    for (const gone of ["unknown", "session-end-clear", "session-start", "session-start-compact"]) expect(await claudeCode.hook!(gone, "{}", hookCtx())).toEqual({});
  });

  test("status hooks: working, the activity line, awaiting, done; never any output", async () => {
    const base = { session_id: "s", transcript_path: "/t/x.jsonl", cwd: "/w/repo", permission_mode: "default" };
    const run = (name: string, input: object) => claudeCode.hook!(name, JSON.stringify({ ...base, ...input }), hookCtx());
    const st = (status: object): HookResult => ({ events: [{ name: "status", status }] });
    expect(await run("tool", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "bun test", description: "Run tests" } })).toEqual(st({ state: "working", activity: "Bash: bun test" }));
    expect(await run("tool", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/w/repo/src/cli.tsx" } })).toEqual(st({ state: "working", activity: "Read src/cli.tsx" }));
    expect(await run("tool", { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "TODO", path: "/w/repo/src" } })).toEqual(st({ state: "working", activity: "Grep TODO in src" }));
    expect(await run("tool", { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { description: "Explore the PTY" } })).toEqual(st({ state: "working", activity: "Task: Explore the PTY" }));
    expect(await run("tool", { hook_event_name: "PreToolUse" })).toEqual(st({ state: "working" }));
    expect(await run("tool-done", { hook_event_name: "PostToolUse", tool_name: "Bash" })).toEqual(st({ state: "working" }));
    expect(await run("notify", { hook_event_name: "Notification", message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" })).toEqual(st({ state: "awaiting", activity: "Claude needs your permission to use Bash" }));
    expect(await run("notify", { hook_event_name: "Notification", message: "Claude is waiting for your input", notification_type: "idle_prompt" })).toEqual(st({ state: "done" }));
    expect(await run("notify", { hook_event_name: "Notification", message: "x", notification_type: "auth_success" })).toEqual({});
    expect(await run("stop", { hook_event_name: "Stop", stop_hook_active: false })).toEqual(st({ state: "done" }));
  });

  test("notes say what's on and off", () => {
    const on = claudeCode.notes(ctx("claude-code", "2.1.286"));
    expect(on).toContain("auto-compaction asks first whether to end the session instead");
    expect(on).toContain("Gluon's return command (`signal back`) runs without a permission prompt");
    const off = claudeCode.notes({ ...ctx("claude-code", "2.1.286"), handoff: NONE });
    expect(off).toContain("auto-compaction: Claude compacts (on_compact: stay)");
    expect(off).toContain("/gluon:gluon shows Gluon's sessions home");
    expect([...on, ...off].join("\n")).not.toMatch(/task|\/clear/);
  });

  test("its arguments pass through a Windows .cmd shim (plain paths)", () => {
    const argv = claudeCode.build(ctx("claude-code", "2.1.286", {}, "win32")).argv.map((a) => a.replaceAll(ADAPTER_DIR, "C:\\Temp\\gluon-adapter-x"));
    for (const a of argv) expect([a, unsafeChar(a)]).toEqual([a, null]);
    expect(() => assertShimArgs(["C:\\npm\\claude.cmd", ...argv])).not.toThrow();
  });
});

describe("Claude Code's measure module (issue #39)", () => {
  async function load() {
    const dir = mkdtempSync(join(tmpdir(), "gluon-measure-"));
    const file = join(dir, "measure.ts");
    writeFileSync(file, MEASURE_MODULE);
    const handlers: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    ((await import(file)) as { register: (on: (e: string, h: (...a: unknown[]) => Promise<unknown>) => void) => void }).register((e, h) => (handlers[e] = h));
    return { dir, handlers };
  }
  const dollar = (dir: string | undefined, writes: Record<string, string>) => ({ env: { get: async () => dir }, fs: { write: async (path: string, text: string) => void (writes[path] = text) } });

  test("session.measure becomes one status event with Claude Code's own window, tokens and cumulative cost; next(e) is always called unchanged", async () => {
    const { dir, handlers } = await load();
    expect(Object.keys(handlers)).toEqual(["session.measure"]);
    const writes: Record<string, string> = {};
    const e = { context: { tokens: 100_000, window: 1_000_000, percent: 10 }, rateLimits: [], cost: { usd: 0.4025 }, changed: ["context", "cost"] };
    let nexted: unknown;
    await handlers["session.measure"]!(dollar(dir, writes), e, async (x: unknown) => (nexted = x));
    expect(nexted).toBe(e);
    const [path, text] = Object.entries(writes)[0]!;
    expect(path.startsWith(`${dir}/`)).toBe(true);
    expect(path.slice(dir.length + 1)).toMatch(/^\d{15}-000001-claude-[a-z0-9]{1,6}\.event$/);
    expect(parseEvent(text!)).toEqual({ name: "status", status: { contextTokens: 100_000, contextWindow: 1_000_000, costUsd: 0.4025 } });
  });

  test("outside a Gluon launch (no GLUON_EVENTS), with bad numbers, or when a write fails: nothing, no error, next still called", async () => {
    const { dir, handlers } = await load();
    const writes: Record<string, string> = {};
    let calls = 0;
    const next = async () => void calls++;
    await handlers["session.measure"]!(dollar(undefined, writes), { context: { tokens: 5, window: 10 } }, next);
    await handlers["session.measure"]!(dollar(dir, writes), { context: { tokens: Number.NaN, window: -1 }, cost: { usd: "x" } }, next);
    await handlers["session.measure"]!({ env: { get: async () => dir }, fs: { write: async () => Promise.reject(new Error("disk")) } }, { context: { tokens: 5, window: 10 } }, next);
    await handlers["session.measure"]!({ env: { get: async () => { throw new Error("no env"); } } }, { context: { tokens: 5, window: 10 } }, next);
    expect(writes).toEqual({});
    expect(calls).toBe(4);
  });
});

describe("Codex's PreCompact hook tells Gluon a compaction starts (issue #39)", () => {
  test("a compacting status event first, whatever the answer; the ask logic is unchanged", async () => {
    for (const pieces of [[], ["compact" as HandoffPiece]]) {
      const dir = mkdtempSync(join(tmpdir(), "gluon-precompact-"));
      const r = await codex.hook!("pre-compact", "{}", { eventsDir: dir, pieces, answerTimeoutMs: 50 });
      expect(r).toEqual({});
      expect(readEvents(dir, new Set()).map((e) => e.status)).toEqual([{ compacting: true }]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex adapter", () => {
  const H = (name: string, timeout: number, async = false) =>
    `{type="command",command='"$GLUON_SELF" hook codex ${name}',command_windows='"%GLUON_SELF%" hook codex ${name}',timeout=${timeout}${async ? ",async=true" : ""}}`;
  /** The whole hook set, byte for byte: changing it makes every user review Codex's hooks again. */
  const SET = [
    "-c", `hooks.PreCompact=[{hooks=[${H("pre-compact", COMPACT_HOOK_TIMEOUT_S)}]}]`,
    "-c", `hooks.UserPromptSubmit=[{hooks=[${H("prompt", 10)}]}]`,
    "-c", `hooks.PreToolUse=[{hooks=[${H("tool", 10, true)}]}]`,
    "-c", `hooks.PostToolUse=[{hooks=[${H("tool-done", 10, true)}]}]`,
    "-c", `hooks.PermissionRequest=[{hooks=[${H("permission", 10)}]}]`,
    "-c", `hooks.Stop=[{hooks=[${H("stop", 10)}]}]`,
  ];

  test("one -c override per hook event: the waiting PreCompact hook and the status hooks; nothing else", () => {
    const out = codex.build(ctx("codex", "0.159.3"));
    expect(out).toEqual({ argv: SET, env: {}, files: {} });
    // PreCompact's bytes are the ones users already approved before the status hooks came.
    expect(SET[1]).toBe(`hooks.PreCompact=[{hooks=[{type="command",command='"$GLUON_SELF" hook codex pre-compact',command_windows='"%GLUON_SELF%" hook codex pre-compact',timeout=${COMPACT_HOOK_TIMEOUT_S}}]}]`);
    // Never the whole `hooks` table (it holds the user's hooks and their approvals), never the
    // user's developer_instructions (a -c value replaces theirs), and v1's routes are gone.
    for (const a of out.argv.filter((_, i) => i % 2)) expect(a).toMatch(/^hooks\.[A-Za-z]+=/);
    for (const gone of ["developer_instructions", "SessionEnd", "SessionStart", "thread_unload_delay_secs", "mcp_servers"]) expect(out.argv.join(" ")).not.toContain(gone);
  });

  test("the hook set is ONE constant, the same bytes whatever the settings, platform and launch (Codex's approval is keyed by it)", () => {
    const one = codex.build(ctx("codex", "0.159.3"));
    expect(codex.build(ctx("codex", "0.159.3", {}, "win32"))).toEqual(one);
    expect(codex.build(ctx("codex", "0.160.0", { on_clear: "stay" }))).toEqual(one);
    // on_compact: stay is the hook's own no (GLUON_HANDOFF), not a different set.
    expect(codex.build(ctx("codex", "0.159.3", { on_compact: "stay" }))).toEqual(one);
    expect(codex.build({ ...ctx("codex", "0.159.3"), handoff: NONE })).toEqual(one);
    expect(codex.build(ctx("codex", "0.159.3")).argv).not.toBe(codex.build(ctx("codex", "0.159.3")).argv);
  });

  test("version gate: nothing below 0.159 or when the version is unknown", () => {
    expect(adapterOutput(ctx("codex", "codex-cli 0.158.9"))).toBe(NO_ADAPTER);
    expect(adapterOutput(ctx("codex", null))).toBe(NO_ADAPTER);
    expect(adapterOutput(ctx("codex", "codex-cli 0.159.0")).argv).toEqual(SET);
  });

  test("pre-compact: yes stops Codex (continue:false), no or no answer lets it compact; off: no question", async () => {
    expect((await compactHook(codex, true)).result).toEqual({ stdout: JSON.stringify({ continue: false, stopReason: COMPACT_STOP_REASON }) });
    expect((await compactHook(codex, false)).result).toEqual({});
    expect((await compactHook(codex, null)).result).toEqual({});
    const off = hookCtx(["clear"]);
    expect(await codex.hook!("pre-compact", "{}", off)).toEqual({});
    // No question and no `compact` event, only the display-only note that a compaction starts.
    expect(readEvents(off.eventsDir, new Set()).map((e) => e.name)).toEqual(["status"]);
    for (const gone of ["session-end", "session-start-compact"]) expect(await codex.hook!(gone, "{}", hookCtx())).toEqual({});
  });

  test("status hooks, with Codex's inputs (its hook schemas): working, the activity line, awaiting, done; never any output", async () => {
    const base = { session_id: "s", turn_id: "t", transcript_path: null, cwd: "/w/repo", model: "gpt-6-sol", permission_mode: "default" };
    const run = (name: string, input: object) => codex.hook!(name, JSON.stringify({ ...base, ...input }), hookCtx());
    // Every Codex hook payload has `session_id`: it goes out with the status (`session` event, BUG-311).
    const st = (status: object): HookResult => ({ events: [{ name: "session", id: "s" }, { name: "status", status }] });
    expect(await run("prompt", { hook_event_name: "UserPromptSubmit", prompt: "fix it" })).toEqual(st({ state: "working" }));
    expect(await run("tool", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "u", tool_input: { command: "cargo test -p codex-tui" } })).toEqual(st({ state: "working", activity: "Bash: cargo test -p codex-tui" }));
    expect(await run("tool", { hook_event_name: "PreToolUse", tool_name: "shell", tool_use_id: "u", tool_input: { command: ["bash", "-lc", "ls"] } })).toEqual(st({ state: "working", activity: "shell: bash -lc ls" }));
    expect(await run("tool-done", { hook_event_name: "PostToolUse", tool_name: "Bash" })).toEqual(st({ state: "working" }));
    expect(await run("permission", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" } })).toEqual(st({ state: "awaiting" }));
    expect(await run("stop", { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done" })).toEqual(st({ state: "done" }));
  });

  test("BUG-311/resume: each hook sends the payload's session_id as a `session` event; none without one, with an unusable one, or from a sub-agent", async () => {
    const id = "019f3a2c-7b1e-7c40-9d2a-5e8f01234567";
    const run = (name: string, input: object, c = hookCtx()) => codex.hook!(name, JSON.stringify(input), c);
    expect(await run("prompt", { session_id: id })).toEqual({ events: [{ name: "session", id }, { name: "status", status: { state: "working" } }] });
    expect(await run("stop", { session_id: id })).toEqual({ events: [{ name: "session", id }, { name: "status", status: { state: "done" } }] });
    expect(await run("prompt", {})).toEqual({ events: [{ name: "status", status: { state: "working" } }] });
    // Not an id Gluon would hand to `codex resume` (an option, too long, spaces, a number, empty).
    for (const bad of ["-x", "--last", "a".repeat(65), "a b", "", 7, null]) expect(await run("prompt", { session_id: bad })).toEqual({ events: [{ name: "status", status: { state: "working" } }] });
    // A sub-agent's hooks carry its own thread id and an agent_id.
    expect(await run("tool-done", { session_id: "sub-thread", agent_id: "agent-1" })).toEqual({ events: [{ name: "status", status: { state: "working" } }] });
    expect(await codex.hook!("prompt", "not json", hookCtx())).toEqual({ events: [{ name: "status", status: { state: "working" } }] });
  });

  test("BUG-311/resume: the PreCompact hook sends the session id before it waits, so a yes (the agent ends) loses nothing", async () => {
    const c = hookCtx();
    expect(await codex.hook!("pre-compact", JSON.stringify({ session_id: "sess-1" }), { ...c, answerTimeoutMs: 100 })).toEqual({});
    const got = readEvents(c.eventsDir, new Set());
    expect(got[0]).toEqual({ name: "session", id: "sess-1" });
    // Display only (issue #39): the compaction's own request is no context.
    expect(got[1]).toEqual({ name: "status", status: { compacting: true } });
    expect(got[2]!.name).toBe("compact");
    const off = hookCtx(["clear"]);
    expect(await codex.hook!("pre-compact", JSON.stringify({ session_id: "sess-2" }), off)).toEqual({});
    expect(readEvents(off.eventsDir, new Set())).toEqual([{ name: "session", id: "sess-2" }, { name: "status", status: { compacting: true } }]);
  });

  test("notes: the one-time hook review, always (the set is constant)", () => {
    expect(codex.notes(ctx("codex", "0.159.3")).join("\n")).toContain("Hooks need review");
    expect(codex.notes(ctx("codex", "0.159.3", { on_compact: "stay" }))).toEqual([
      "auto-compaction: Codex compacts (on_compact: stay)",
      "its status and latest activity show in Gluon",
      'Codex asks once to approve Gluon\'s hooks ("Hooks need review"): choose to trust them',
    ]);
  });

  test("its TOML arguments can't go through a .cmd shim: Codex on Windows runs as codex.exe", () => {
    const argv = codex.build(ctx("codex", "0.159.3", {}, "win32")).argv;
    expect(() => assertShimArgs(["C:\\npm\\codex.cmd", ...argv])).toThrow("cmd.exe would act on");
    expect(() => assertShimArgs(["C:\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\codex.exe", ...argv])).not.toThrow();
  });
});

describe("buildCommand with an adapter", () => {
  const subscription = (h: Harness): [Config, string] => {
    const config = { ...loadConfig(), connections: { [h]: { auth: "subscription" } } } as Config;
    return [config, config.models[h].find((m) => m.ids.plan)!.id];
  };

  test("the adapter's options go before the spec, which stays last", () => {
    for (const h of ["claude-code", "codex"] as const) {
      const [config, model] = subscription(h);
      const adapter = adapterOutput(ctx(h, h === "codex" ? "0.159.3" : "2.1.286"));
      const cmd = buildCommand(config, { harness: h, model, effort: "high", spec: "- fix it", reason: "" }, adapter);
      expect(cmd.argv.slice(-2)).toEqual(["--", "- fix it"]);
      expect(cmd.argv.slice(-2 - adapter.argv.length, -2)).toEqual(adapter.argv);
      expect(cmd.adapter).toBe(adapter);
      // Without one, nothing of it.
      expect(buildCommand(config, { harness: h, model, spec: "x", reason: "" }).argv.join(" ")).not.toContain("gluon");
    }
  });
});

test("BUG-142/v1 fixes: Claude Code's /gluon command is the user's only, never offered to the model", () => {
  const md = claudeCode.build(ctx("claude-code", "2.1.286")).files["claude-plugin/commands/gluon.md"]!;
  expect(md.split("---\n")[1]!.split("\n")).toContain("disable-model-invocation: true");
});
