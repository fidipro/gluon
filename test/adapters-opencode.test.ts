import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterOutput } from "../src/adapters/index.ts";
import { CLI_CONFIG_ENV, mergeCliConfig, opencode, PLUGIN_DIR, pluginSource } from "../src/adapters/opencode.ts";
import { ADAPTER_DIR, ADAPTER_DIR_JSON, NO_ADAPTER, type AdapterContext } from "../src/adapters/types.ts";
import { defaults } from "../src/config.ts";
import { handoffDefaults, handoffFor, type HandoffSettings } from "../src/handoff.ts";
import { assertShimArgs } from "../src/detect.ts";
import { MAX_STATUS_BYTES, parseStatus, readEvents, type AgentEvent, type StatusInfo } from "../src/events.ts";
import { buildCommand, substituteTokens } from "../src/launchers.ts";

const settings = (s: Partial<HandoffSettings> = {}): HandoffSettings => ({ ...handoffFor(handoffDefaults(), "opencode"), ...s });
const ctx = (s: Partial<HandoffSettings> = {}, env: Record<string, string | undefined> = {}, version: string | null = "2.0.21"): AdapterContext => ({ harness: "opencode", version, handoff: settings(s), env });
const OURS = `${ADAPTER_DIR_JSON}/${PLUGIN_DIR}`;

describe("OpenCode adapter", () => {
  test("adds the CLI plugin through OPENCODE_CLI_CONFIG_CONTENT, and stops OpenCode updating itself", () => {
    const out = adapterOutput(ctx());
    expect(out.argv).toEqual([]);
    expect(out.env).toEqual({ [CLI_CONFIG_ENV]: JSON.stringify({ plugins: [OURS] }), OPENCODE_DISABLE_AUTOUPDATE: "1" });
    expect(Object.keys(out.files).sort()).toEqual([`${PLUGIN_DIR}/package.json`, `${PLUGIN_DIR}/tui.js`]);
    // The documented CLI plugin package shape: exports ./tui.
    expect(JSON.parse(out.files[`${PLUGIN_DIR}/package.json`]!)).toMatchObject({ type: "module", exports: { "./tui": "./tui.js" } });
  });

  test("BUG-140/v1 fixes: a Windows adapter dir goes into OPENCODE_CLI_CONFIG_CONTENT as valid JSON", () => {
    const out = adapterOutput({ ...ctx({}, { [CLI_CONFIG_ENV]: '{"tabs":{"mode":"off"}}' }), platform: "win32" });
    const dir = 'C:\\Users\\me "x"\\AppData\\Local\\Temp\\gluon-adapter-abc';
    const cmd = substituteTokens({ argv: ["opencode", "x"], env: out.env, adapter: out, spec: "x" }, dir, "C:\\x\\gluon.cmd");
    expect(JSON.parse(cmd.env[CLI_CONFIG_ENV]!)).toEqual({ tabs: { mode: "off" }, plugins: [`${dir}/${PLUGIN_DIR}`] });
  });

  test("nothing below 2.0.21 or when the version is unknown", () => {
    for (const v of ["1.18.34", "2.0.20", null]) expect(adapterOutput(ctx({}, {}, v))).toEqual(NO_ADAPTER);
    for (const v of ["2.0.21", "2.1.0", "3.0.0"]) expect(adapterOutput(ctx({}, {}, v)).files).not.toEqual({});
  });

  test("the plugin is /gluon only, whatever the settings (/new, /clear and /compact are the PTY's)", () => {
    const text = (s: Partial<HandoffSettings>) => adapterOutput(ctx(s)).files[`${PLUGIN_DIR}/tui.js`]!;
    for (const s of [{}, { on_clear: "stay" as const }, { on_compact: "stay" as const }, { on_exit: "quit" as const }]) {
      expect(text(s)).toBe(pluginSource());
    }
    expect(pluginSource()).toContain('slash: { name: "gluon" }');
    expect(pluginSource()).toContain('import { Plugin } from "@opencode/plugin/tui"');
    // It never asks before a compaction (it has no hook that could wait): it only learns that one ended (the context is unknown then).
    for (const gone of ["session.new", "session.clear", "session.compaction.started", "toast"]) expect(pluginSource()).not.toContain(gone);
  });

  test("merges with the user's own OPENCODE_CLI_CONFIG_CONTENT: their settings and plugins stay, ours is appended", () => {
    const user = JSON.stringify({ tabs: { mode: "off" }, plugins: ["/home/me/plug", { package: "x", options: { a: 1 } }] });
    expect(JSON.parse(adapterOutput(ctx({}, { [CLI_CONFIG_ENV]: user })).env[CLI_CONFIG_ENV]!)).toEqual({ tabs: { mode: "off" }, plugins: ["/home/me/plug", { package: "x", options: { a: 1 } }, OURS] });
    expect(JSON.parse(mergeCliConfig('{"theme":{"name":"x"}}', "p")!)).toEqual({ theme: { name: "x" }, plugins: ["p"] });
    expect(JSON.parse(mergeCliConfig('{"plugins":"odd"}', "p")!)).toEqual({ plugins: ["p"] });
    for (const empty of [undefined, "", "  "]) expect(mergeCliConfig(empty, "p")).toBe('{"plugins":["p"]}');
    // Not a JSON object: left as it is (OpenCode reports it), and Gluon adds nothing.
    for (const bad of ["{oops", "[]", "null", '"s"', "3"]) {
      expect(mergeCliConfig(bad, "p")).toBeNull();
      expect(adapterOutput(ctx({}, { [CLI_CONFIG_ENV]: bad }))).toEqual(NO_ADAPTER);
      expect(opencode.notes(ctx({}, { [CLI_CONFIG_ENV]: bad })).join(" ")).toContain("isn't a JSON object");
    }
  });

  test("notes say what's supported and what isn't", () => {
    const n = (s: Partial<HandoffSettings>, env = {}) => opencode.notes(ctx(s, env)).join("\n");
    expect(n({})).toContain("/gluon shows Gluon's sessions home");
    expect(n({})).toContain("auto-compaction: OpenCode compacts without asking");
    expect(n({ on_compact: "stay" })).not.toContain("compact");
    expect(n({})).not.toMatch(/\/clear|\/new/);
    expect(n({})).toContain("cli.json");
    expect(n({}, { [CLI_CONFIG_ENV]: '{"plugins":[]}' })).not.toContain("cli.json");
    expect(n({}, { [CLI_CONFIG_ENV]: '{"plugins":[]}' })).toContain("doesn't update itself");
  });

  test("buildCommand: the adapter's env joins the model's config, the spec stays last, the env passes assertSafeEnv", () => {
    const config = defaults();
    const out = adapterOutput(ctx());
    const cmd = buildCommand(config, { harness: "opencode", model: "deepseek-flash", spec: "- fix it", reason: "" }, out);
    expect(cmd.argv).toEqual(["opencode", "--standalone", "--prompt=- fix it"]);
    expect(cmd.argv.at(-1)).toBe("--prompt=- fix it");
    expect(cmd.env).toMatchObject({ OPENCODE_CONFIG_CONTENT: '{"model":"opencode-go/deepseek-v4.1-flash"}', ...out.env });
    expect(() => assertShimArgs(["C:\\x\\opencode.cmd", ...cmd.argv.slice(1)])).not.toThrow();
  });
});

describe("OpenCode plugin, run against a fake OpenCode", () => {
  const dir = mkdtempSync(join(tmpdir(), "gluon-oc-plugin-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (p: unknown) => p } }));

  type Command = { id: string; slash?: { name: string }; palette?: boolean; run: () => unknown };
  let loads = 0;
  async function load() {
    const file = join(dir, `tui-${++loads}.js`);
    writeFileSync(file, pluginSource());
    const plugin = (await import(file)).default as { id: string; setup: (c: unknown) => () => void };
    let commands: Command[] = [];
    let stopped = 0;
    const context = {
      ui: { slot: (claim: { append: string; render: () => unknown }) => (expect(claim.append).toBe("app"), claim.render(), () => stopped++) },
      keymap: { layer: (f: () => { commands: Command[] }) => ({ commands } = f()) },
    };
    const stop = plugin.setup(context);
    return { plugin, commands: () => commands, stop, stopped: () => stopped };
  }

  test("/gluon sends `back`; outside a Gluon launch nothing", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({})) as never);
    const saved = { self: process.env.GLUON_SELF, events: process.env.GLUON_EVENTS };
    process.env.GLUON_SELF = "/x/gluon";
    process.env.GLUON_EVENTS = "/x/events";
    try {
      const p = await load();
      expect(p.plugin.id).toBe("gluon.handoff");
      expect(p.commands().map((c) => [c.id, c.slash, c.palette])).toEqual([["gluon.back", { name: "gluon" }, true]]);
      expect(p.commands()[0]!.run()).toBeUndefined();
      expect(spawn.mock.calls.map((c) => c[0])).toEqual([["/x/gluon", "signal", "back"]]);
      p.stop();
      expect(p.stopped()).toBe(1);

      delete process.env.GLUON_EVENTS;
      spawn.mockClear();
      const q = await load();
      q.commands()[0]!.run();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      for (const [k, v] of [["GLUON_SELF", saved.self], ["GLUON_EVENTS", saved.events]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });

  test("the status from OpenCode 1.x's event names (still handled): working, the activity, awaiting, cost per message and context, done", async () => {
    const events = mkdtempSync(join(dir, "events-"));
    const saved = process.env.GLUON_EVENTS;
    process.env.GLUON_EVENTS = events;
    const assistant = (id: string, sessionID: string, cost: number, input: number) => ({
      type: "message.updated",
      data: { sessionID, info: { id, sessionID, role: "assistant", providerID: "openrouter", modelID: "moonshotai/kimi-k3", cost, tokens: { input, output: 50, reasoning: 0, cache: { read: 1000, write: 200 } } } },
    });
    const stream = [
      { type: "server.connected", data: {} },
      { type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } },
      { type: "message.part.updated", data: { sessionID: "ses_1", part: { type: "tool", tool: "bash", state: { status: "running", input: { command: "bun test\u001b[2J" } } } } },
      { type: "message.part.updated", data: { sessionID: "ses_1", part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ignored" } } } } },
      { type: "permission.asked", data: { sessionID: "ses_1", id: "per_1", action: "bash" } },
      { type: "permission.replied", data: { sessionID: "ses_1", requestID: "per_1", reply: "once" } },
      assistant("msg_1", "ses_1", 0.01, 3000),
      assistant("msg_1", "ses_1", 0.02, 3000),
      // A subagent's session: its cost counts, its context isn't the one on screen.
      assistant("msg_2", "ses_child", 0.005, 90_000),
      { type: "session.status", data: { sessionID: "ses_1", status: { type: "idle" } } },
    ];
    let asked: unknown;
    const context = {
      ui: { slot: () => () => {}, router: { current: () => ({ type: "session", sessionID: "ses_1" }) } },
      keymap: { layer: () => {} },
      client: {
        event: {
          subscribe: (opts: unknown) => {
            asked = opts;
            return (async function* () {
              for (const e of stream) yield e;
            })();
          },
        },
        model: { list: async () => ({ data: [{ id: "moonshotai/kimi-k3", providerID: "openrouter", limit: { context: 262_144, output: 32_000 } }] }) },
      },
    };
    try {
      const file = join(dir, `tui-status-${Date.now()}.js`);
      writeFileSync(file, pluginSource());
      const plugin = (await import(file)).default as { setup: (c: unknown) => () => void };
      const stop = plugin.setup(context);
      const seen = new Set<string>();
      const got: StatusInfo[] = [];
      for (let i = 0; i < 100 && !got.some((s) => s.costUsd !== undefined); i++) {
        got.push(...readEvents(events, seen).flatMap((e) => (e.status ? [e.status] : [])));
        await Bun.sleep(30);
      }
      const signal = (asked as { signal: AbortSignal }).signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      expect(got).toEqual([
        { state: "working" },
        { state: "working", activity: "bash: bun test" },
        { state: "awaiting" },
        { state: "working" },
        { state: "done" },
        // Figures at most once a second, the latest of each: cost summed per message, context (input + cache + output) from
        // the session on screen, its model's window once `model.list` answered.
        { costUsd: 0.025, contextTokens: 4250, contextWindow: 262_144, model: "openrouter/moonshotai/kimi-k3" },
      ]);
      stop();
      // Stopping the plugin closes the stream.
      expect(signal.aborted).toBe(true);
    } finally {
      saved === undefined ? delete process.env.GLUON_EVENTS : (process.env.GLUON_EVENTS = saved);
    }
  });

  /** Runs the plugin on a fake event stream (OpenCode's `{id, created, type, data}` envelope added) until a figures event arrives. */
  async function statuses(stream: { type: string; data: unknown }[], models: unknown[]): Promise<StatusInfo[]> {
    const events = mkdtempSync(join(dir, "events-"));
    const saved = process.env.GLUON_EVENTS;
    process.env.GLUON_EVENTS = events;
    const context = {
      ui: { slot: () => () => {}, router: { current: () => ({ type: "session", sessionID: "ses_1" }) } },
      keymap: { layer: () => {} },
      client: {
        event: { subscribe: async () => ({ stream: (async function* () { let n = 0; for (const e of stream) yield { id: `evt_${++n}`, created: 1_759_000_000_000 + n, location: { directory: "/w" }, ...e }; })() }) },
        model: { list: async () => ({ data: models }) },
      },
    };
    try {
      const file = join(dir, `tui-v2-${++loads}.js`);
      writeFileSync(file, pluginSource());
      const plugin = (await import(file)).default as { setup: (c: unknown) => () => void };
      const stop = plugin.setup(context);
      const seen = new Set<string>();
      const got: StatusInfo[] = [];
      for (let i = 0; i < 100 && !got.some((s) => s.costUsd !== undefined); i++) {
        // The per-step records (`steps`, priced by Gluon: test/figures.test.ts) are not part of these figures.
        got.push(...readEvents(events, seen).flatMap((e) => (e.status ? [e.status] : [])).filter((st) => !st.steps));
        await Bun.sleep(30);
      }
      stop();
      return got;
    } finally {
      saved === undefined ? delete process.env.GLUON_EVENTS : (process.env.GLUON_EVENTS = saved);
    }
  }

  test("BUG-188/opencode-2: the status from OpenCode 2.x's events (shapes seen on 2.0.21): execution, tools, forms, cumulative cost per session, the last step's context", async () => {
    const tokens = (input: number, cache: unknown) => ({ input, output: 40, reasoning: 0, cache });
    const called = (id: string, name: string, input: unknown) => [
      { type: "session.tool.input.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1", id, name } },
      { type: "session.tool.called", data: { sessionID: "ses_1", assistantMessageID: "msg_1", id, input, executed: true } },
      { type: "session.tool.success", data: { sessionID: "ses_1", assistantMessageID: "msg_1", id, content: [], metadata: {} } },
    ];
    const got = await statuses(
      [
        { type: "server.connected", data: {} },
        { type: "session.created", data: { sessionID: "ses_1", slug: "brave-otter", version: "2.0.21", projectID: "prj_1", location: { directory: "/w" }, subpath: "", agent: "build", model: { providerID: "openrouter", modelID: "moonshotai/kimi-k3" } } },
        { type: "session.inbox.enqueued", data: { sessionID: "ses_1" } },
        { type: "session.execution.started", data: { sessionID: "ses_1" } },
        { type: "session.step.started", data: { sessionID: "ses_1", agent: "build", model: "openrouter/moonshotai/kimi-k3", assistantMessageID: "msg_1", snapshot: "snp_1", started: 1 } },
        { type: "session.text.delta", data: { sessionID: "ses_1", text: "Looking" } },
        ...called("call_1", "read", { path: "src/a.ts" }),
        // Gluon's own return command and the question tool: no activity line.
        ...called("call_2", "bash", { command: '"$GLUON_SELF" signal back' }),
        ...called("call_3", "question", { questions: [{ question: "Go back to Gluon?", options: [] }] }),
        { type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_1" } } },
        { type: "form.replied", data: { id: "frm_1", sessionID: "ses_1", answer: ["yes"] } },
        { type: "session.step.ended", data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls", rawFinish: "tool_calls", cost: 0.00213643, tokens: tokens(541, { read: 0, write: 0 }), snapshot: "snp_2", files: [] } },
        { type: "session.usage.updated", data: { sessionID: "ses_1", cost: 0.00213643, tokens: tokens(541, { read: 0, write: 0 }) } },
        // The last step's input is the context; usage's tokens are cumulative totals (not used).
        { type: "session.step.ended", data: { sessionID: "ses_1", assistantMessageID: "msg_2", finish: "stop", rawFinish: "stop", cost: 0.00286357, tokens: tokens(6384, { read: 100, write: 16 }), snapshot: "snp_3", files: [] } },
        { type: "session.usage.updated", data: { sessionID: "ses_1", cost: 0.005, tokens: tokens(6925, { read: 100, write: 16 }) } },
        // A subagent's session: its cost counts, its context and model aren't the ones on screen.
        { type: "session.created", data: { sessionID: "ses_child", model: { providerID: "x", modelID: "not a model!" } } },
        { type: "session.execution.started", data: { sessionID: "ses_child" } },
        { type: "session.step.started", data: { sessionID: "ses_child", model: "anthropic/claude-haiku" } },
        { type: "session.step.ended", data: { sessionID: "ses_child", tokens: tokens(90_000, 5000) } },
        { type: "session.usage.updated", data: { sessionID: "ses_child", cost: 0.001, tokens: tokens(90_000, 5000) } },
        { type: "session.execution.succeeded", data: { sessionID: "ses_child" } },
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
        // The next turn: the same tool line shows again.
        { type: "session.execution.started", data: { sessionID: "ses_1" } },
        ...called("call_4", "read", { path: "src/a.ts" }),
        { type: "session.execution.cancelled", data: { sessionID: "ses_1" } },
      ],
      [{ id: "moonshotai/kimi-k3", providerID: "openrouter", limit: { context: 262_144, output: 32_000 } }],
    );
    expect(got).toEqual([
      { state: "working" },
      { state: "working", activity: "read src/a.ts" },
      { state: "awaiting" },
      { state: "working" },
      { state: "working" },
      { state: "done" },
      { state: "working" },
      { state: "working", activity: "read src/a.ts" },
      { state: "done" },
      // Once, the latest of each: cost = each session's latest cumulative cost, summed; context =
      // the last step's input + cache read + write + output + reasoning of the session on screen, its model's window.
      { costUsd: 0.006, contextTokens: 6540, contextWindow: 262_144, model: "openrouter/moonshotai/kimi-k3" },
    ]);
  });

  /** Runs the plugin on a fake event stream and returns the `session` events it sent. */
  async function sessionsSent(stream: { type: string; data: unknown }[]): Promise<string[]> {
    const events = mkdtempSync(join(dir, "events-"));
    const saved = process.env.GLUON_EVENTS;
    process.env.GLUON_EVENTS = events;
    const context = {
      ui: { slot: () => () => {}, router: { current: () => ({ type: "session", sessionID: "ses_1" }) } },
      keymap: { layer: () => {} },
      client: {
        event: { subscribe: async () => ({ stream: (async function* () { for (const e of stream) yield { id: "evt", created: 1, ...e }; yield { type: "session.execution.started", data: { sessionID: "end" } }; })() }) },
        model: { list: async () => ({ data: [] }) },
      },
    };
    try {
      const file = join(dir, `tui-sessions-${++loads}.js`);
      writeFileSync(file, pluginSource());
      const plugin = (await import(file)).default as { setup: (c: unknown) => () => void };
      const stop = plugin.setup(context);
      const seen = new Set<string>();
      const got: AgentEvent[] = [];
      // The marker at the end of the stream is a status: everything before it has been handled.
      for (let i = 0; i < 100 && !got.some((e) => e.status); i++) {
        got.push(...readEvents(events, seen));
        await Bun.sleep(30);
      }
      stop();
      return got.flatMap((e) => (e.name === "session" ? [e.id!] : []));
    } finally {
      saved === undefined ? delete process.env.GLUON_EVENTS : (process.env.GLUON_EVENTS = saved);
    }
  }

  test("BUG-311/resume: the first TOP-LEVEL session's id goes out as a `session` event; sub-sessions (parentID) and later sessions never do", async () => {
    expect(
      await sessionsSent([
        { type: "session.created", data: { sessionID: "ses_child", parentID: "ses_top" } },
        { type: "session.created", data: { sessionID: "ses_top", slug: "brave-otter" } },
        { type: "session.created", data: { sessionID: "ses_other" } },
      ]),
    ).toEqual(["ses_top"]);
  });

  test("BUG-311/resume: OpenCode 1.x's session.created ({sessionID, info: {id, parentID}}), and an id Gluon would refuse, are handled", async () => {
    expect(
      await sessionsSent([
        { type: "session.created", data: { sessionID: "ses_c", info: { id: "ses_c", parentID: "ses_p" } } },
        { type: "session.created", data: { sessionID: "-x" } },
        { type: "session.created", data: { sessionID: "ses_p", info: { id: "ses_p" } } },
      ]),
    ).toEqual(["ses_p"]);
    expect(await sessionsSent([{ type: "session.created", data: {} }])).toEqual([]);
  });

  // Issue #40: what each OpenCode event says about the session (done is its turn ending: Gluon shows it awaiting input, BUG-193).
  const figuresLast = { type: "session.usage.updated", data: { sessionID: "ses_1", cost: 0.1 } };
  const states = (got: StatusInfo[]): string[] => got.flatMap((s) => (s.state ? [s.state] : []));
  const on = (type: string, sessionID = "ses_1") => ({ type, data: { sessionID } });

  test("issue-40/opencode-2: every way an execution ends is done once no session is busy; a form waits, whatever answers it (reply, reject, cancel) is working", async () => {
    const ends = ["succeeded", "failed", "cancelled", "canceled", "aborted", "errored", "interrupted"];
    const got = await statuses(
      [
        ...ends.flatMap((e) => [on("session.execution.started"), on(`session.execution.${e}`)]),
        // A second session still running: the first one's end isn't the turn's end.
        on("session.execution.started"),
        on("session.execution.started", "ses_2"),
        on("session.execution.succeeded"),
        on("session.execution.succeeded", "ses_2"),
        ...["form.replied", "form.rejected", "form.cancelled"].flatMap((answer) => [{ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_1" } } }, { type: answer, data: { id: "frm_1", sessionID: "ses_1" } }]),
        // Events that say nothing about it.
        on("session.text.delta"),
        on("session.inbox.enqueued"),
        on("session.execution.unheard-of"),
        figuresLast,
      ],
      [],
    );
    expect(states(got)).toEqual([
      ...ends.flatMap(() => ["working", "done"]),
      "working",
      "working",
      "done",
      "awaiting",
      "working",
      "awaiting",
      "working",
      "awaiting",
      "working",
    ]);
  });

  test("issue-40/opencode-1: idle (status or session.idle) is done once no session is busy; busy and retry are working; a permission waits and its reply works on", async () => {
    const status = (type: string, sessionID = "ses_1") => ({ type: "session.status", data: { sessionID, status: { type } } });
    const got = await statuses(
      [
        status("busy"),
        status("retry"),
        on("session.idle"),
        // Two sessions: the first going idle leaves the other at work.
        status("busy"),
        status("busy", "ses_2"),
        status("idle"),
        on("session.idle", "ses_2"),
        { type: "permission.asked", data: { sessionID: "ses_1", id: "per_1", action: "bash" } },
        { type: "permission.replied", data: { sessionID: "ses_1", requestID: "per_1", reply: "once" } },
        // Others say nothing about it.
        on("session.updated"),
        figuresLast,
      ],
      [],
    );
    expect(states(got)).toEqual(["working", "working", "done", "working", "working", "done", "awaiting", "working"]);
  });

  test("BUG-188/opencode-2: an unknown window sends the tokens and the model (Gluon works the window out); a numeric cache counts", async () => {
    const got = await statuses(
      [
        { type: "session.step.started", data: { sessionID: "ses_1", model: { providerID: "anthropic", id: "claude-sonnet-5" } } },
        { type: "session.step.ended", data: { sessionID: "ses_1", tokens: { input: 1000, output: 1, reasoning: 0, cache: 24 } } },
        { type: "session.usage.updated", data: { sessionID: "ses_1", cost: 0.5, tokens: {} } },
        { type: "session.usage.updated", data: { sessionID: "ses_1", cost: "odd" } },
      ],
      [],
    );
    expect(got).toEqual([{ costUsd: 0.5, contextTokens: 1025, model: "anthropic/claude-sonnet-5" }]);
  });

  /** Runs the plugin on a fake event stream and returns every status event it wrote, with when; `afterMs` after the stream ended it is stopped (unloaded). */
  async function written(stream: { type: string; data: unknown }[], stopAfterMs: number): Promise<{ statuses: StatusInfo[]; stoppedAfterMs: number }> {
    const events = mkdtempSync(join(dir, "events-"));
    const saved = process.env.GLUON_EVENTS;
    process.env.GLUON_EVENTS = events;
    try {
      const context = {
        ui: { slot: () => () => {}, router: { current: () => ({ type: "session", sessionID: "ses_1" }) } },
        keymap: { layer: () => {} },
        client: { event: { subscribe: async () => ({ stream: (async function* () { yield* stream; })() }) }, model: { list: async () => ({ data: [] }) } },
      };
      const file = join(dir, `tui-steps-${++loads}.js`);
      writeFileSync(file, pluginSource());
      const plugin = (await import(file)).default as { setup: (c: unknown) => () => void };
      const stop = plugin.setup(context);
      await Bun.sleep(stopAfterMs);
      const at = Date.now();
      stop();
      const stoppedAfterMs = Date.now() - at;
      const seen = new Set<string>();
      return { statuses: readEvents(events, seen, 10_000).flatMap((e) => (e.status ? [e.status] : [])), stoppedAfterMs };
    } finally {
      saved === undefined ? delete process.env.GLUON_EVENTS : (process.env.GLUON_EVENTS = saved);
    }
  }
  const stepEnded = (cost: number, input = 100) => ({ type: "session.step.ended", data: { sessionID: "ses_1", cost, tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } });

  test("BUG-344/flushsteps-no-loss: a burst of steps in one tick goes out as batches of at most 12, every record once and in order, none overwritten; the plugin being stopped sends what is waiting at once", async () => {
    // 60 steps written the same millisecond; stopped 150 ms later, long before the second's timer.
    const { statuses, stoppedAfterMs } = await written(Array.from({ length: 60 }, (_, i) => stepEnded(0.001 * (i + 1), 100 + i)), 150);
    const steps = statuses.flatMap((s) => s.steps ?? []);
    expect(steps.map((r) => r.n)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(steps.map((r) => r.input)).toEqual(Array.from({ length: 60 }, (_, i) => 100 + i));
    expect(statuses.filter((s) => s.steps).map((s) => s.steps!.length)).toEqual([12, 12, 12, 12, 12]);
    expect(stoppedAfterMs).toBeLessThan(500);
  });

  test("BUG-344/flushsteps-batch-fits: the biggest batch the plugin builds (12 records with a 128-character model, 13-digit counts and a long cost, a context and a side flag) is a status file Gluon reads (under MAX_STATUS_BYTES), not one it drops whole", () => {
    const model = `p/${"m".repeat(126)}`;
    const record = { n: 999_999_999, model, input: 999_999_999_999, output: 999_999_999_999, reasoning: 999_999_999_999, cacheRead: 999_999_999_999, cacheWrite: 999_999_999_999, cost: 0.12345678901234568, context: "compacted" as const, side: true as const };
    const line = `status ${JSON.stringify({ steps: Array.from({ length: 12 }, () => record) })}`;
    expect(Buffer.byteLength(line)).toBeLessThan(MAX_STATUS_BYTES);
    expect(parseStatus(line.slice("status ".length))?.steps?.length).toBe(12);
    // The plugin's batch size is the one this proves.
    expect(pluginSource()).toContain("stepQueue.splice(0, 12)");
  });

  test("without an event stream, or one that fails, the plugin still loads and /gluon still works", async () => {
    const saved = process.env.GLUON_EVENTS;
    process.env.GLUON_EVENTS = mkdtempSync(join(dir, "events-"));
    try {
      const file = join(dir, `tui-nostream-${Date.now()}.js`);
      writeFileSync(file, pluginSource());
      const plugin = (await import(file)).default as { setup: (c: unknown) => () => void };
      for (const client of [undefined, { event: {} }, { event: { subscribe: () => { throw new Error("no"); } } }, { event: { subscribe: async () => 42 } }]) {
        let commands: { id: string }[] = [];
        const stop = plugin.setup({ client, ui: { slot: (c: { render: () => unknown }) => (c.render(), () => {}) }, keymap: { layer: (f: () => { commands: { id: string }[] }) => ({ commands } = f()) } });
        expect(commands.map((c) => c.id)).toEqual(["gluon.back"]);
        stop();
      }
      await Bun.sleep(20);
    } finally {
      saved === undefined ? delete process.env.GLUON_EVENTS : (process.env.GLUON_EVENTS = saved);
    }
  });
});
