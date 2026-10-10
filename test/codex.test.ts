/**
 * The ChatGPT-plan brain (`codex app-server`) against a scripted fake app-server: the session looks
 * the same as on any other brain, the thread gets Gluon's prompt and tools only, approvals are
 * denied, interrupts reach Codex, and nothing touches Codex's credentials or the network.
 */
import { SLOW } from "./fixtures/slow.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { BRAIN_ITEMS, catalogWithoutTools, chatgptPlanBrain, CODEX_FEATURES_KEPT, CODEX_FEATURES_OFF, codexEnv, codexLoginStatus, FOREIGN_ITEMS, featuresToDisable, foreignItem, parseLoginStatus, probeChatgptPlan, uncheckedCatalogFields, uncheckedFeatures, type SpawnCodex } from "../src/agent/codex.ts";
import * as codexModule from "../src/agent/codex.ts";
import { ownPercent, ownWindow } from "../src/cost/context.ts";
import { FIXTURE_CODEX_WINDOWS as CODEX_WINDOWS } from "./fixtures/fixture-tables.ts";
import { HARNESS_INFO } from "../src/harnesses.ts";
import { Session, type State } from "../src/agent/session.ts";
import { TOOLS } from "../src/agent/tools.ts";
import { loadConfig } from "../src/config.ts";
import { assertSafeEnv } from "../src/launchers.ts";

const ROOT = join(import.meta.dir, "..");
const FAKE = join(import.meta.dir, "fixtures", "fake-codex-app-server.ts");
const TMP = mkdtempSync(join(tmpdir(), "gluon-codex-"));
const SYSTEM = "You are Gluon.\n- a bullet, kept verbatim";
const saved = { ...process.env };
const realFetch = globalThis.fetch;
let fetches = 0;

beforeAll(() => {
  process.env.GLUON_CONFIG = join(TMP, "config.yaml");
  for (const k of ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[k];
  globalThis.fetch = (() => {
    fetches++;
    throw new Error("no network in these tests");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(TMP, { recursive: true, force: true });
});

type Step = Record<string, unknown>;
type Logged = { id?: number; method?: string; params?: any; result?: any; error?: any };

/** A spawn that runs the fake with this script, and what it received. */
function fake(script: { turns: Step[][]; mcpServers?: string[]; account?: unknown }, extraEnv: Record<string, string> = {}) {
  const log = join(TMP, `log-${crypto.randomUUID()}.jsonl`);
  const spawned: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  const spawn: SpawnCodex = (argv, env) => {
    spawned.push({ argv, env });
    return Bun.spawn(["bun", FAKE, ...argv.slice(1)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, ...extraEnv, FAKE_CODEX_SCRIPT: JSON.stringify(script), FAKE_CODEX_LOG: log },
    });
  };
  const received = (): Logged[] => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  /** The brain's answers to the fake's requests, in order. */
  const answers = () => received().filter((m) => m.method === undefined);
  const toolResults = () => answers().filter((m) => m.result?.contentItems).map((m) => m.result.contentItems[0].text as string);
  return { spawn, spawned, received, answers, toolResults };
}

function session(spawn: SpawnCodex) {
  const config = loadConfig();
  const s = new Session(chatgptPlanBrain({ model: "gpt-6-sol", cwd: ROOT, spawn }), config, SYSTEM, ROOT);
  let state: State = s.snapshot;
  s.subscribe((next) => (state = next));
  return { s, config, state: () => state };
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

test("on the ChatGPT plan, exploring, questions and proposals look the same as on any brain", async () => {
  // route (pinned: the agent is exactly this one), then propose_launch.
  const choice = { harness: "claude-code", model: "sonnet", effort: "low", reason: "small", spec: "- Fix add." };
  const routeInput = { types: [{ type: "feature", model_steps: 0, effort_steps: 0 }], pinned: "claude-code/sonnet@low" };
  const proposeInput = { name: "fix-add", spec: choice.spec, types: ["feature"], reason: choice.reason };
  const f = fake({
    turns: [
      [
        { text: "Let me look.", tool: { name: "list_files", input: {} } },
        { tool: { name: "ask_user", input: { question: "Add a test?", options: [{ label: "Yes" }, { label: "No" }] } } },
        { tool: { name: "route", input: routeInput } },
        { text: "Here's the plan.", tool: { name: "propose_launch", input: proposeInput } },
        { text: "Done.", whole: true },
      ],
    ],
  });
  const { s, state } = session(f.spawn);

  await s.submit("fix the add bug");
  expect(state().pending).toMatchObject({ kind: "question", question: { question: "Add a test?" } });
  expect(state().items.map((i) => i.kind)).toEqual(["user", "assistant", "explored"]);
  expect(f.toolResults()[0]).toContain("package.json");

  await s.submit("Yes");
  await until(() => f.toolResults().length >= 3);
  expect(f.toolResults()[1]).toBe("The developer answered: Yes");
  expect(state().pending).toMatchObject({ kind: "proposal", choice: { model: choice.model } });
  expect(s.confirm()).toMatchObject({ ...choice, spec: choice.spec });

  await s.submit("cheaper");
  expect(JSON.parse(f.toolResults()[2]!)).toMatchObject({ mode: "build", recommended: { harness: "claude-code", model: "sonnet", effort: "low" } });
  expect(f.toolResults()[3]).toBe("The developer did not launch. They replied: cheaper");
  expect(state().pending).toBeNull();
  expect(state().workingSince).toBeNull();
  expect(state().items.map((i) => i.kind)).toEqual(["user", "assistant", "explored", "question", "user", "assistant", "proposal", "user", "assistant"]);
  expect(state().items.at(-1)).toMatchObject({ kind: "assistant", text: "Done." });

  // One thread for the session: the developer's first message is the only turn.
  const sent = f.received().filter((m) => m.method);
  expect(sent.map((m) => m.method)).toEqual(["initialize", "initialized", "config/read", "thread/start", "turn/start"]);
  // The catalog lists no reasoning levels for the model: Gluon's default effort goes as it is.
  expect(sent[4]!.params).toEqual({ threadId: "thr_fake", input: [{ type: "text", text: "fix the add bug", text_elements: [] }], effort: "medium" });
  s.close();
});

test("every turn/start carries the step's effort, clamped to the model's supported_reasoning_levels in Codex's catalog; none when it lists none", async () => {
  const run = async (levels: unknown, effort?: "low" | "medium" | "high" | "xhigh" | "max") => {
    const f = fake({ turns: [[{ text: "Hi." }], [{ text: "Again." }]] }, { FAKE_CODEX_CATALOG_EXTRA: JSON.stringify({ supported_reasoning_levels: levels }) });
    const heard: (string | null)[] = [];
    const s = new Session(chatgptPlanBrain({ model: "gpt-6-sol", cwd: ROOT, spawn: f.spawn, ...(effort ? { effort } : {}), onEffort: (e) => heard.push(e) }), loadConfig(), SYSTEM, ROOT);
    await s.submit("hello");
    await s.submit("more");
    s.close();
    const turns = f.received().filter((m) => m.method === "turn/start").map((m) => m.params.effort);
    return { turns, heard };
  };
  const levels = (...efforts: string[]) => efforts.map((effort) => ({ effort, description: effort }));
  expect(await run(levels("low", "medium", "high", "xhigh"))).toEqual({ turns: ["medium", "medium"], heard: ["medium"] });
  expect(await run(levels("high", "xhigh"))).toEqual({ turns: ["high", "high"], heard: ["high"] });
  expect(await run(levels("low", "medium", "high", "xhigh"), "max")).toEqual({ turns: ["xhigh", "xhigh"], heard: ["xhigh"] });
  expect(await run([])).toEqual({ turns: [undefined, undefined], heard: [null] });
});

test("the thread runs on Gluon's prompt and tools only: read-only, never asking, ephemeral, Codex's tools off", async () => {
  const f = fake({ turns: [[{ text: "Hi." }], [{ text: "Again." }]], mcpServers: ["github"] });
  const { s, state } = session(f.spawn);
  await s.submit("hello");
  await s.submit("more");
  expect(state().items.filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text)).toEqual(["Hi.", "Again."]);

  const sent = f.received().filter((m) => m.method);
  expect(sent.filter((m) => m.method === "thread/start")).toHaveLength(1);
  expect(sent.filter((m) => m.method === "turn/start")).toHaveLength(2);
  expect(sent.find((m) => m.method === "initialize")!.params.capabilities).toEqual({ experimentalApi: true });

  const params = sent.find((m) => m.method === "thread/start")!.params;
  expect(params.baseInstructions).toBe(SYSTEM);
  expect(params.developerInstructions).toBeUndefined();
  expect(params.dynamicTools).toEqual(TOOLS.map((t) => ({ type: "function", name: t.name, description: t.description, inputSchema: t.input_schema })));
  expect(params.dynamicTools.map((t: { name: string }) => t.name)).toEqual(["list_files", "grep", "read_file", "git_status", "git_log", "git_diff", "forge", "ask_user", "route", "propose_launch"]);
  expect(params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never", ephemeral: true, model: "gpt-6-sol", cwd: ROOT });
  expect(params.config).toMatchObject({
    "features.shell_tool": false,
    "features.unified_exec": false,
    "features.apps": false,
    web_search: "disabled",
    project_doc_max_bytes: 0,
    "mcp_servers.github.enabled": false,
  });

  // The process itself starts with Codex's tools off, on the user's own environment.
  const servers = f.spawned.filter((x) => x.argv[1] === "app-server");
  expect(servers).toHaveLength(1);
  expect(servers[0]!.argv).toContain("shell_tool");
  expect(servers[0]!.env).toEqual({ ...process.env });
  // Before it: the feature check and the catalog, never a model call.
  expect(f.spawned.map((x) => x.argv.slice(1, 3).join(" "))).toEqual(["features list", "features list", "debug models", "app-server --disable"]);
  for (const x of f.spawned) expect(x.env).toEqual({ ...process.env });
  s.close();
});

test("approval requests are denied; the brain never runs commands or edits files", async () => {
  const f = fake({
    turns: [
      [
        { approval: "item/commandExecution/requestApproval" },
        { approval: "item/fileChange/requestApproval" },
        { approval: "execCommandApproval" },
        { approval: "applyPatchApproval" },
        { approval: "item/tool/requestUserInput" },
        { text: "Fine." },
      ],
    ],
  });
  const { s, state } = session(f.spawn);
  await s.submit("delete everything");
  const answers = f.answers().filter((m) => m.id! > 1000);
  expect(answers.map((m) => m.result ?? "error")).toEqual([{ decision: "decline" }, { decision: "decline" }, { decision: "denied" }, { decision: "denied" }, "error"]);
  expect(answers[4]!.error.message).toContain("does not allow");
  expect(state().items.at(-1)).toMatchObject({ kind: "assistant", text: "Fine." });
  s.close();
});

test("interrupting sends turn/interrupt for the running turn", async () => {
  const f = fake({ turns: [[{ text: "Thinking", hang: true }], [{ text: "Back." }]] });
  const { s, state } = session(f.spawn);
  const done = s.submit("go");
  await until(() => state().live.some((i) => i.kind === "assistant" && i.text === "Thinking"));
  s.interrupt();
  await done;
  expect(f.received().find((m) => m.method === "turn/interrupt")!.params).toEqual({ threadId: "thr_fake", turnId: "turn_1" });
  expect(state().items.at(-1)).toMatchObject({ kind: "notice", tone: "info", text: expect.stringContaining("Interrupted") });

  // The thread goes on.
  await s.submit("continue");
  expect(state().items.at(-1)).toMatchObject({ kind: "assistant", text: "Back." });
  s.close();
});

test("a failed turn shows a readable error", async () => {
  const f = fake({ turns: [[{ fail: { message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.", codexErrorInfo: "badRequest" } }]] });
  const { s, state } = session(f.spawn);
  await s.submit("hi");
  expect(state().items.at(-1)).toMatchObject({ kind: "notice", tone: "error", text: expect.stringContaining("gpt-6-sol isn't available on this ChatGPT plan") });
  s.close();
});

test("a codex without the experimental API is said plainly", async () => {
  const spawn: SpawnCodex = (argv, env) => {
    // A fake that ignores the opt-in, like an old codex would reject dynamicTools.
    const child = fake({ turns: [] }).spawn(argv, env);
    const stdin = child.stdin;
    return {
      stdout: child.stdout,
      exited: child.exited,
      kill: () => child.kill(),
      stdin: { write: (chunk: string) => stdin.write(chunk.replace('"experimentalApi":true', '"experimentalApi":false')), flush: () => stdin.flush?.() },
    };
  };
  const { s, state } = session(spawn);
  await s.submit("hi");
  expect(state().items.at(-1)).toMatchObject({ kind: "notice", text: expect.stringContaining("Update codex") });
  s.close();
});

describe("probe", () => {
  test("one tiny turn on the plan", async () => {
    const f = fake({ turns: [[{ text: "ok" }]], mcpServers: ["github"] });
    expect(await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: f.spawn })).toEqual({ ok: true });
    const sent = f.received().filter((m) => m.method);
    expect(sent.map((m) => m.method)).toEqual(["initialize", "initialized", "account/read", "config/read", "thread/start", "mcpServerStatus/list", "turn/start"]);
    expect(sent.at(-1)!.params.input[0].text).toBe("Reply with the single word: ok");
  });

  test("not signed in, or signed in without ChatGPT", async () => {
    const out = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: fake({ turns: [], account: null }).spawn });
    expect(out).toEqual({ ok: false, error: expect.stringContaining("codex login") });
    const key = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: fake({ turns: [], account: { type: "apiKey" } }).spawn });
    expect(key).toEqual({ ok: false, error: expect.stringContaining("not a ChatGPT plan") });
  });

  test("a model the plan doesn't offer", async () => {
    const f = fake({ turns: [[{ fail: { message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." } }]] });
    const out = await probeChatgptPlan("gpt-6-astra", ROOT, { spawn: f.spawn });
    expect(out).toEqual({ ok: false, error: expect.stringContaining("gpt-6-astra isn't available on this ChatGPT plan") });
  });

  test("BUG-67/6.2: the refusal is said once, in Codex's own words, not wrapped twice", async () => {
    const body = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account."}}';
    const f = fake({ turns: [[{ fail: { message: body } }]] });
    const out = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: f.spawn });
    expect(out).toEqual({ ok: false, error: "gpt-6-sol isn't available on this ChatGPT plan: The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." });
  });
});

describe("hard rules", () => {
  test("codexEnv is the user's own environment: nothing added, no base URL, no token", () => {
    const env = codexEnv();
    expect(env).toEqual({ ...process.env });
    expect("OPENAI_BASE_URL" in env).toBe(false);
    expect(() => assertSafeEnv(env)).not.toThrow();
  });

  test("login goes through the official binary", () => {
    expect(HARNESS_INFO.codex.subscription!.loginArgv).toEqual(["codex", "login"]);
    expect(parseLoginStatus("Not logged in\n")).toEqual({ loggedIn: false });
    expect(parseLoginStatus("Logged in using ChatGPT\n")).toEqual({ loggedIn: true, method: "chatgpt" });
    expect(parseLoginStatus("Logged in using an API key - sk-proj-***ABCD\n")).toEqual({ loggedIn: true, method: "api-key" });
    expect(parseLoginStatus("Logged in using access token\n")).toEqual({ loggedIn: true });
    expect(parseLoginStatus("something else")).toBeNull();
  });

  test("no source reads Codex's credentials; the codex brain has no HTTP client of its own", () => {
    const sources = (dir: string): [string, string][] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [[p, readFileSync(p, "utf8")] as [string, string]] : [];
      });
    for (const [file, text] of sources(join(ROOT, "src"))) {
      for (const line of text.split("\n")) {
        if (/auth\.json/.test(line)) expect([file, line]).not.toEqual([file, expect.stringMatching(/readFile|Bun\.file|open\w*\(|createReadStream/)]);
      }
    }
    const codex = readFileSync(join(ROOT, "src/agent/codex.ts"), "utf8");
    expect(codex).not.toMatch(/auth\.json|["'`/]\.codex["'`/]|CODEX_HOME|keychain/i);
    expect(codex).not.toMatch(/\bfetch\(|https?:\/\/|from "openai"/);
    expect(codex).not.toMatch(/OPENAI_BASE_URL\s*[:=]|OPENAI_API_KEY|_TOKEN/);
    expect(fetches).toBe(0);
  });
});

describe("the brain's tools: Gluon's own, nothing of Codex's", () => {
  /** Features left on, and why: none of them gives the model a tool or runs a command. */
  const KEPT = CODEX_FEATURES_KEPT;

  test("every feature of `codex features list` that isn't kept on purpose is turned off, and the ones that give tools always", () => {
    const list = readFileSync(join(import.meta.dir, "fixtures", "codex-features-list.txt"), "utf8");
    const rows = list.trim().split("\n").map((l) => l.trim().split(/\s{2,}/));
    const off = featuresToDisable(list);
    const live = rows.filter(([, stage]) => stage !== "removed" && stage !== "deprecated").map(([name]) => name!);
    expect(live.length).toBeGreaterThan(50);
    // A feature that is neither kept nor looked at is turned off unchecked.
    expect(live.filter((f) => !off.includes(f) && !(f in KEPT))).toEqual([]);
    for (const f of ["shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "remote_plugin", "browser_use", "in_app_browser", "computer_use", "view_image", "multi_agent", "multi_agent_v2", "code_mode", "code_mode_only", "current_time_reminder", "worktrees", "workspace_dependencies", "write_stdin_approval", "skill_mcp_dependency_install"]) {
      expect(CODEX_FEATURES_OFF).toContain(f);
      expect(off).toContain(f);
    }
    expect(CODEX_FEATURES_OFF).not.toContain("code_mode_host");
    expect(off).not.toContain("code_mode_host");
    // Kept and always off: only what codex forces on today.
    expect(CODEX_FEATURES_OFF.filter((f) => f in KEPT)).toEqual(["unified_exec"]);
    // Every name is one this codex knows (an older codex gets only the names it lists: BUG-708).
    const known = new Set(rows.map(([name]) => name));
    expect(CODEX_FEATURES_OFF.filter((f) => !known.has(f))).toEqual([]);
  });

  test("the catalog handed to the app-server has every model's own tools cleared, the rest kept", () => {
    const catalog = { models: [{ slug: "gpt-6-luna", display_name: "GPT-6-Luna", available_access_programs: { cyber: ["standard"] }, tool_mode: "code_mode_only", apply_patch_tool_type: "freeform", experimental_supported_tools: ["send_user_message_async", "clock"], multi_agent_version: "v2" }], extra: 1 };
    const out = JSON.parse(catalogWithoutTools(JSON.stringify(catalog)));
    expect(out).toEqual({ extra: 1, models: [{ slug: "gpt-6-luna", display_name: "GPT-6-Luna", available_access_programs: { cyber: ["standard"] }, tool_mode: "direct", apply_patch_tool_type: null, experimental_supported_tools: [], multi_agent_version: null }] });
    expect(() => catalogWithoutTools("not json")).toThrow(/too new/);
    expect(() => catalogWithoutTools('{"data": []}')).toThrow(/no models list/);
  });

  test("the app-server gets that catalog; the thread has no environment, agents, request_user_input or skills", async () => {
    const f = fake({ turns: [[{ text: "Hi." }]] });
    const { s } = session(f.spawn);
    await s.submit("hello");
    const server = f.spawned.find((x) => x.argv[1] === "app-server")!;
    const i = server.argv.indexOf("-c");
    expect(server.argv[i + 1]).toMatch(/^model_catalog_json=".+catalog\.json"$/);
    const path = JSON.parse(server.argv[i + 1]!.slice("model_catalog_json=".length));
    const models = JSON.parse(readFileSync(path, "utf8")).models as Record<string, unknown>[];
    for (const m of models) expect(m).toMatchObject({ tool_mode: "direct", apply_patch_tool_type: null, experimental_supported_tools: [], multi_agent_version: null });
    const params = f.received().find((m) => m.method === "thread/start")!.params;
    expect(params.environments).toEqual([]);
    expect(params.config).toMatchObject({ "agents.enabled": false, "tools.experimental_request_user_input.enabled": false, "skills.include_instructions": false, web_search: "disabled" });
    s.close();
  });
});

describe("review of PR #1", () => {
  test("BUG-79/4: a codex that keeps on a feature Gluon hasn't checked, or sets a catalog field it hasn't, still runs the brain, and the probe warns what it found", async () => {
    // As checked: the fixture's features after the disables, and the fake catalog, pass with no warning.
    expect(await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: fake({ turns: [[{ text: "ok" }]] }).spawn })).toEqual({ ok: true });
    // A new feature, on by default, that codex keeps on when Gluon turns it off: the brain runs, with a warning.
    const feature = fake({ turns: [[{ text: "ok" }]] }, { FAKE_CODEX_FEATURES_EXTRA: "hosted_agent_tools                       stable             true", FAKE_CODEX_FORCED_ON: "unified_exec,hosted_agent_tools" });
    const kept = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: feature.spawn });
    expect(kept).toEqual({ ok: true, warnings: [expect.stringContaining("keeps features on that Gluon hasn't checked (hosted_agent_tools)")] });
    expect(feature.spawned.some((x) => x.argv[1] === "app-server")).toBe(true);
    // A new catalog field that is set (it may bring tools): passed to codex as it is, with a warning; the same field unset says nothing.
    const field = fake({ turns: [[{ text: "ok" }]] }, { FAKE_CODEX_CATALOG_EXTRA: JSON.stringify({ hosted_tools: ["computer"] }) });
    const out = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: field.spawn });
    expect(out).toEqual({ ok: true, warnings: [expect.stringContaining("model catalog has fields Gluon hasn't checked (hosted_tools)")] });
    const server = field.spawned.find((x) => x.argv[1] === "app-server")!;
    const catalog = JSON.parse(readFileSync(JSON.parse(server.argv[server.argv.indexOf("-c") + 1]!.slice("model_catalog_json=".length)), "utf8"));
    for (const m of catalog.models) expect(m.hosted_tools).toEqual(["computer"]);
    const empty = fake({ turns: [[{ text: "ok" }]] }, { FAKE_CODEX_CATALOG_EXTRA: JSON.stringify({ hosted_tools: [], new_label: null }) });
    expect(await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: empty.spawn })).toEqual({ ok: true });
    // The session's brain answers as usual.
    const { s, state } = session(fake({ turns: [[{ text: "Hi." }]] }, { FAKE_CODEX_FEATURES_EXTRA: "hosted_agent_tools  stable  true", FAKE_CODEX_FORCED_ON: "unified_exec,hosted_agent_tools", FAKE_CODEX_CATALOG_EXTRA: JSON.stringify({ hosted_tools: ["computer"] }) }).spawn);
    await s.submit("hello");
    expect(state().items.at(-1)).toMatchObject({ kind: "assistant", text: "Hi." });
    s.close();
    // Reading the list: removed features do nothing; an unreadable list is refused.
    const rows = (extra: string) => `${Array.from({ length: 10 }, (_, i) => `f${i}  removed  true`).join("\n")}\ncode_mode_host  stable  true\n${extra}`;
    expect(uncheckedFeatures(rows(""))).toEqual([]);
    expect(uncheckedFeatures(rows("new_one  experimental  true\nother  stable  false"))).toEqual(["new_one"]);
    expect(() => uncheckedFeatures("Usage: codex features")).toThrow(/isn't in the shape/);
  });

  test("BUG-79/new-feature: a feature on by default that Gluon hasn't checked is turned off unchecked, for the app-server and the thread, and the brain works", async () => {
    const extra = { FAKE_CODEX_FEATURES_EXTRA: "next_new_mode  stable  true" };
    const f = fake({ turns: [[{ text: "ok" }]] }, extra);
    expect(await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: f.spawn })).toEqual({ ok: true });
    const server = f.spawned.find((x) => x.argv[1] === "app-server")!;
    expect(server.argv[server.argv.indexOf("next_new_mode") - 1]).toBe("--disable");
    expect(f.received().find((m) => m.method === "thread/start")!.params.config["features.next_new_mode"]).toBe(false);
    const { s, state } = session(fake({ turns: [[{ text: "Hi." }]] }, extra).spawn);
    await s.submit("hello");
    expect(state().items.at(-1)).toMatchObject({ kind: "assistant", text: "Hi." });
    s.close();
  });

  test("BUG-79/mcp: an MCP server codex keeps on by itself is a warning and the probe passes; one of the user's config that stays on still fails it", async () => {
    const own = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: fake({ turns: [[{ text: "ok" }]] }, { FAKE_CODEX_OWN_MCP: "codex_apps" }).spawn });
    expect(own).toEqual({ ok: true, warnings: [expect.stringContaining("MCP servers on that aren't in your config (codex_apps)")] });
    // With a server in the config too: the thread turns it off, so only codex's own is warned about.
    const theirs = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: fake({ turns: [[{ text: "ok" }]], mcpServers: ["docs"] }, { FAKE_CODEX_OWN_MCP: "codex_apps" }).spawn });
    expect(theirs).toEqual({ ok: true, warnings: [expect.stringContaining("(codex_apps)")] });
    // A server of the user's config that stays on although Gluon turned it off: turning off is broken, so the probe fails.
    const stuck = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: fake({ turns: [[{ text: "ok" }]], mcpServers: ["docs"] }, { FAKE_CODEX_MCP_STAYS_ON: "docs" }).spawn });
    expect(stuck).toEqual({ ok: false, error: expect.stringContaining("Codex's MCP servers docs stayed on") });
  });

  test("BUG-79/start-hint: a codex that fails to start after Gluon turned off features it hasn't checked is told which (codex may need one); one that starts isn't", async () => {
    const env = { FAKE_CODEX_FEATURES_EXTRA: "next_new_mode  stable  true" };
    const crash = fake({ turns: [] }, env);
    // `features list` and `debug models` from the fake; the app-server exits at once, as a codex missing a feature might.
    const spawn: SpawnCodex = (argv, e) => (argv[1] === "app-server" ? Bun.spawn(["bun", "-e", "console.error('Error: thread needs a feature'); process.exit(1)"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: e }) : crash.spawn(argv, e));
    const out = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn });
    expect(out).toEqual({ ok: false, error: expect.stringContaining("Gluon turned off features of this codex it hasn't checked: ") });
    expect(!out.ok && out.error).toContain("next_new_mode");
    // A failure once the thread runs (the plan's own refusal) isn't about features.
    const later = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: fake({ turns: [[{ fail: { message: "usage limit", codexErrorInfo: "usageLimitExceeded" } }]] }, env).spawn });
    expect(later).toEqual({ ok: false, error: expect.not.stringContaining("hasn't checked") });
    // Nor is one where codex answers but refuses to start the thread (it didn't exit): the hint is for an exit alone.
    const refusing = fake({ turns: [] }, { ...env, FAKE_CODEX_THREAD_START_ERROR: "model gpt-6-sol does not exist" });
    const refused = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: refusing.spawn });
    expect(refused).toEqual({ ok: false, error: expect.stringContaining("does not exist") });
    expect(!refused.ok && refused.error).not.toContain("hasn't checked");
  });

  test("BUG-80/5: `codex login status` that never answers times out like the other status checks", async () => {
    const { fakeAgents } = await import("./e2e/fixtures.ts");
    const path = process.env.PATH;
    process.env.PATH = `${fakeAgents(["codex"])}${delimiter}${path}`;
    process.env.FAKE_CODEX_LOGIN_HANG = "1";
    try {
      const started = Date.now();
      const s = await codexLoginStatus({ timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(3000 * SLOW);
      expect(s).toEqual({ installed: true, loggedIn: false, transient: true, error: "`codex login status` timed out" });
      delete process.env.FAKE_CODEX_LOGIN_HANG;
      expect(await codexLoginStatus()).toEqual({ installed: true, loggedIn: true, method: "chatgpt" });
    } finally {
      process.env.PATH = path;
      delete process.env.FAKE_CODEX_LOGIN_HANG;
    }
    // It runs through the shared, timed helper, on codex's own environment.
    expect(readFileSync(join(ROOT, "src/agent/codex.ts"), "utf8")).toContain("await run([codex, \"login\", \"status\"], timeoutMs, codexEnv())");
  });

  test("BUG-85/10: when `codex app-server` stops mid-session, the next message restarts it and says the brain forgot", async () => {
    const f = fake({ turns: [[{ text: "Hi." }, { exit: true }], [{ text: "Fresh." }]] });
    const { s, state } = session(f.spawn);
    await s.submit("hello");
    expect(state().items.at(-1)).toMatchObject({ kind: "assistant", text: "Hi." });
    await until(() => f.spawned.filter((x) => x.argv[1] === "app-server").length === 1 && f.received().length > 0);
    await Bun.sleep(300 * SLOW); // the fake exits 50 ms after the turn
    await s.submit("again");
    expect(f.spawned.filter((x) => x.argv[1] === "app-server")).toHaveLength(2);
    const notices = state().items.filter((i) => i.kind === "notice");
    expect(notices).toEqual([expect.objectContaining({ tone: "info", text: "The intake agent restarted; it doesn't remember this conversation — repeat what matters." })]);
    // Said once, not on every later message.
    await s.submit("more");
    expect(state().items.filter((i) => i.kind === "notice")).toHaveLength(1);
    s.close();
  });
});

test("BUG-335: a Codex session's window comes from the bundled table (Codex's own resolution), with no `debug models` read at run time", () => {
  // No run-time loader is left to call, and a model resolves with nothing spawned.
  for (const gone of ["loadCodexWindows", "codexWindows", "codexCatalog"]) expect(gone in codexModule).toBe(false);
  const sol = CODEX_WINDOWS.models["gpt-6-sol"]!;
  // The table's window × its effective percent, rounded down: the part Codex lets a conversation use.
  expect(ownWindow("codex", "gpt-6-sol")).toEqual({ window: Math.floor((sol.context * sol.percent) / 100), source: "codex-catalog" });
  // Codex's own rules: the longest slug that is a prefix, a `provider/` namespace stripped, its 272k x 95% fallback, the config's override capped by the model's maximum.
  expect(ownWindow("codex", "gpt-6-sol-2026-10-01").source).toBe("codex-catalog");
  expect(ownWindow("codex", "openrouter/gpt-6-sol").source).toBe("codex-catalog");
  expect(ownWindow("codex", "gpt-daybreak-red-latest")).toEqual({ window: Math.floor(372_000 * 0.95), source: "codex-catalog" });
  expect(ownWindow("codex", "no-such-model")).toEqual({ window: 258_400, source: "codex-fallback" });
  expect(ownWindow("codex", "gpt-6-sol", { override: 100_000 })).toEqual({ window: 95_000, source: "override" });
  expect(ownWindow("codex", "gpt-6-sol", { override: 5_000_000 }).window).toBe(Math.floor(sol.max * 0.95));
  // Codex's footer counts a 12k baseline off both sides: (200k - 12k) of (258.4k - 12k) used.
  expect(ownPercent("codex", 200_000, ownWindow("codex", "gpt-6-sol").window)).toBeCloseTo((188_000 / 246_400) * 100, 6);
  // The table says where it came from.
  expect(CODEX_WINDOWS.source).toBe("codex debug models");
  expect(CODEX_WINDOWS.codexVersion).toMatch(/^\d+\.\d+\.\d+/);
});

// --- QA pass (brain, offline): what a user reads when this codex is newer than Gluon has checked

/** The chat's last notice for a codex that fails closed, as the app shows it (`brainErrorHint` is the hint the session appends). */
async function refusalNotice(extraEnv: Record<string, string>, turns: Step[][] = [[{ text: "Hi." }]]): Promise<string> {
  const { brainErrorHint } = await import("../src/brain.ts");
  const config = loadConfig();
  const step = { route: "chatgpt-plan", model: "gpt-6-luna" } as const;
  const s = new Session(chatgptPlanBrain({ model: "gpt-6-luna", cwd: ROOT, spawn: fake({ turns }, extraEnv).spawn }), config, SYSTEM, ROOT, (m) => brainErrorHint(step, m, config));
  await s.submit("hello");
  s.close();
  const last = s.snapshot.items.at(-1) as { kind: string; text: string };
  expect(last.kind).toBe("notice");
  return last.text;
}

test("QA: a codex that keeps an unchecked feature on, or sets an unchecked catalog field, isn't refused: the chat works, and the probe (`gluon doctor`) says what was found, why it matters and what happens", async () => {
  const env = { FAKE_CODEX_FEATURES_EXTRA: "hosted_agent_tools  stable  true", FAKE_CODEX_FORCED_ON: "unified_exec,hosted_agent_tools", FAKE_CODEX_CATALOG_EXTRA: JSON.stringify({ hosted_tools: ["computer"], other_new: { a: 1 } }) };
  const { s, state } = session(fake({ turns: [[{ text: "Hi." }]] }, env).spawn);
  await s.submit("hello");
  expect(state().items.at(-1)).toMatchObject({ kind: "assistant", text: "Hi." });
  s.close();
  const probe = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: fake({ turns: [[{ text: "ok" }]] }, env).spawn });
  const [feature, field] = (probe.ok && probe.warnings) || [];
  expect(feature).toContain("hosted_agent_tools");
  expect(field).toContain("model catalog has fields Gluon hasn't checked (hosted_tools, other_new)");
  for (const text of [feature, field]) {
    expect(text).toContain("may give the intake agent tools of Codex's own");
    expect(text).toContain("It runs anyway; a Gluon update will cover them.");
  }
});

test("BUG-628/QA-brain-13: the refusal of a codex Gluon hasn't checked isn't followed by 'Send your message again to retry' (a retry can only be refused again; the message itself says to update Gluon or use another step)", async () => {
  // A tool of Codex's own that got through and was used: the turn is stopped with the refusal.
  const text = await refusalNotice({}, [[{ item: { type: "commandExecution", command: "ls" } }, { hang: true }]]);
  expect(text).toContain("this codex version isn't supported");
  expect(text).not.toMatch(/send your message again/i);
});

test("BUG-628/variants: every refusal of a too-new codex points at `gluon doctor` and the brain order; a plain failure of the plan still says to send again", async () => {
  const { brainErrorHint } = await import("../src/brain.ts");
  const config = loadConfig();
  const step = { route: "chatgpt-plan", model: "gpt-6-luna" } as const;
  // codex.ts's own texts, so a reworded refusal can't silently lose the hint (it did once: the intake-agent rename).
  const { TOO_NEW, UNSUPPORTED } = await import("../src/agent/codex.ts");
  expect(UNSUPPORTED).toMatch(/isn't supported for the intake agent/);
  for (const m of [`${UNSUPPORTED}: its \`codex features list\` isn't in the shape Gluon reads`, `codex's model catalog (\`codex debug models\`) isn't JSON; ${TOO_NEW}`]) {
    expect(brainErrorHint(step, m, config)).toContain("brain.order");
    expect(brainErrorHint(step, m, config)).not.toMatch(/send your message again/i);
  }
  expect(brainErrorHint(step, "the brain's turn failed", config)).toMatch(/send your message again/i);
});

test("QA: an unknown catalog field goes to codex as it is, and a set value of it (even `true` or 0) is listed as unchecked; unset values (null, false, empty list, empty text, empty object) aren't", () => {
  const models = (extra: Record<string, unknown>) => JSON.stringify({ models: [{ slug: "gpt-6-luna", display_name: "x", ...extra }] });
  for (const unset of [null, false, [], "", {}]) expect(uncheckedCatalogFields(models({ new_field: unset }))).toEqual([]);
  for (const set of [true, 0, 1, "x", ["a"], { a: 1 }]) {
    expect(uncheckedCatalogFields(models({ new_field: set }))).toEqual(["new_field"]);
    expect(JSON.parse(catalogWithoutTools(models({ new_field: set }))).models[0].new_field).toEqual(set);
  }
  // The known tool fields are cleared whatever they held; a models list that is empty or not a list is refused as too new.
  const out = JSON.parse(catalogWithoutTools(models({ tool_mode: "code_mode_only", apply_patch_tool_type: "freeform", experimental_supported_tools: ["x"], multi_agent_version: "v2" })));
  expect(out.models[0]).toMatchObject({ tool_mode: "direct", apply_patch_tool_type: null, experimental_supported_tools: [], multi_agent_version: null });
  for (const bad of ['{"models": []}', '{"models": "x"}', "[]", "null"]) expect(() => catalogWithoutTools(bad)).toThrow(/too new|no models list/);
});

test("QA: a features list that is cut short, has a missing column, or a non-boolean is 'not in the shape Gluon reads', never read as 'nothing enabled'", () => {
  const rows = (n: number, last = "f  stable  true") => `${Array.from({ length: n }, (_, i) => `f${i}  removed  false`).join("\n")}\n${last}`;
  expect(uncheckedFeatures(rows(10, "code_mode_host  stable  true"))).toEqual([]);
  expect(() => uncheckedFeatures(rows(3))).toThrow(/isn't in the shape/);
  expect(() => uncheckedFeatures(rows(10, "f  stable"))).toThrow(/isn't in the shape/);
  expect(() => uncheckedFeatures(rows(10, "f  stable  yes"))).toThrow(/isn't in the shape/);
  expect(() => uncheckedFeatures("")).toThrow(/isn't in the shape/);
  expect(uncheckedFeatures(rows(10, "new_one  under development  true"))).toEqual(["new_one"]); // a stage of two words is still one column
});

describe("BUG-708: a codex that doesn't know every feature Gluon turns off", () => {
  // Real codex: `--disable` of a name it doesn't list is "Error: Unknown feature flag: …", exit 1 (seen on Windows).
  const older = { FAKE_CODEX_FEATURES_DROP: "chronicle,agent_message_board,browser_annotation_api" };

  test("BUG-708/older-codex: only the names it lists are turned off, in the check, the app-server and the thread; the probe and the brain work", async () => {
    const f = fake({ turns: [[{ text: "ok" }]] }, older);
    expect(await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: f.spawn })).toEqual({ ok: true });
    const [list, check, , server] = f.spawned;
    expect(list!.argv).toEqual(["codex", "features", "list"]);
    for (const x of [check!, server!]) {
      expect(x.argv).toContain("shell_tool");
      for (const name of older.FAKE_CODEX_FEATURES_DROP.split(",")) expect(x.argv).not.toContain(name);
    }
    const config = f.received().find((m) => m.method === "thread/start")!.params.config;
    expect(config["features.shell_tool"]).toBe(false);
    expect(Object.keys(config)).not.toContain("features.chronicle");

    const { s, state } = session(fake({ turns: [[{ text: "Hi." }]] }, older).spawn);
    await s.submit("hello");
    expect(state().items.at(-1)).toMatchObject({ kind: "assistant", text: "Hi." });
    s.close();
  });

  test("BUG-708/stderr: a `codex features list` that fails says codex's own reason", async () => {
    const spawn: SpawnCodex = (argv, env) => Bun.spawn(["bun", "-e", "console.error('\\x1b[31mError: something codex said\\x1b[0m'); process.exit(2)"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    const out = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn });
    expect(out).toEqual({ ok: false, error: expect.stringContaining("`codex features list` failed (exit code 2): Error: something codex said") });
  });

  test("BUG-708/known: featuresToDisable names only what the list has: all but the kept and the removed, and the always-off even when kept", () => {
    const list = ["shell_tool  stable  true", "apps  stable  true", "unified_exec  stable  true", "code_mode_host  stable  true", "gone_one  removed  true", ...Array.from({ length: 10 }, (_, i) => `f${i}  stable  false`)].join("\n");
    expect(featuresToDisable(list)).toEqual(["shell_tool", "apps", "unified_exec", ...Array.from({ length: 10 }, (_, i) => `f${i}`)]);
    expect(() => featuresToDisable("Usage: codex features")).toThrow(/isn't in the shape/);
  });
});

describe("BUG-709: a tool of Codex's own that gets through stops the brain", () => {
  test("BUG-709/session: an item outside the brain's types stops the app-server, refuses the turn with what to do, and the next message starts afresh", async () => {
    for (const item of [{ type: "commandExecution", command: "cat .env" }, { type: "someNewTool" }, { type: "dynamicToolCall", tool: "shell", arguments: {} }]) {
      const f = fake({ turns: [[{ text: "Let me look." }, { item }, { hang: true }], [{ text: "Fresh." }]] });
      const { brainErrorHint } = await import("../src/brain.ts");
      const config = loadConfig();
      const step = { route: "chatgpt-plan", model: "gpt-6-sol" } as const;
      const s = new Session(chatgptPlanBrain({ model: "gpt-6-sol", cwd: ROOT, spawn: f.spawn }), config, SYSTEM, ROOT, (m) => brainErrorHint(step, m, config));
      await s.submit("hello");
      const notice = s.snapshot.items.at(-1) as { kind: string; tone: string; text: string };
      expect(notice).toMatchObject({ kind: "notice", tone: "error" });
      expect(notice.text).toContain("Codex gave the intake agent a tool of its own");
      expect(notice.text).toContain(item.type === "dynamicToolCall" ? '"shell"' : item.type);
      expect(notice.text).toContain("brain.order");
      expect(notice.text).not.toMatch(/send your message again/i);
      // Stopped, not interrupted: the app-server is gone.
      expect(f.received().some((m) => m.method === "turn/interrupt")).toBe(false);
      const first = f.spawned.find((x) => x.argv[1] === "app-server")!;
      expect(first).toBeDefined();
      await s.submit("again");
      expect(f.spawned.filter((x) => x.argv[1] === "app-server")).toHaveLength(2);
      s.close();
    }
  });

  test("BUG-709/probe: the probe is refused the same way", async () => {
    const f = fake({ turns: [[{ item: { type: "webSearch", query: "x" } }, { hang: true }]] });
    const out = await probeChatgptPlan("gpt-6-sol", ROOT, { spawn: f.spawn, timeoutMs: 10_000 });
    expect(out).toEqual({ ok: false, error: expect.stringContaining("Codex gave the intake agent a tool of its own (webSearch)") });
  });

  test("BUG-709/types: the brain's own items pass; Gluon's tools by name; every other item is foreign", () => {
    for (const type of BRAIN_ITEMS) if (type !== "dynamicToolCall") expect(foreignItem("item/started", { item: { type } })).toBeNull();
    for (const t of TOOLS) expect(foreignItem("item/completed", { item: { type: "dynamicToolCall", tool: t.name } })).toBeNull();
    for (const type of [...FOREIGN_ITEMS, "brandNew"]) expect(foreignItem("item/started", { item: { type } })).toContain(`(${type})`);
    expect(foreignItem("item/started", { item: {} })).toContain("an item without a type");
    expect(foreignItem("turn/started", { item: { type: "commandExecution" } })).toBeNull();
    expect([...BRAIN_ITEMS].filter((t) => FOREIGN_ITEMS.has(t))).toEqual([]);
  });
});
