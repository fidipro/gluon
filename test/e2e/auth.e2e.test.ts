/**
 * I. Connecting the coding agents: the checklist, each harness × sign-in branch, login handoffs,
 * going back (Esc), OpenCode's keys, the late-OSC fix in the menus, the brain order and doctor. Offline: fake binaries, API probes answered by a file (GLUON_TEST_PROBES).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { installHint } from "../../src/harnesses.ts";
import { GUARD_MS } from "../../src/ui/signin.tsx";
import { freshConfig, isPrivate, probes, repo, type FakeAgent } from "./fixtures.ts";
import { App, cli, HOME, HOME_VIEW, KEY, SLOW, stopAll } from "./harness.ts";

setDefaultTimeout(40_000 * SLOW);
afterAll(stopAll);

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const yaml = (path: string) => (parse(read(path)) ?? {}) as Record<string, any>;
const ALL: FakeAgent[] = ["claude", "codex", "agy", "grok", "opencode"];

/** gluon with these arguments in a terminal, without the demo brain (still offline). */
const run = (args: string[], env: Record<string, string | undefined>, { agents = ["claude"] as FakeAgent[], rows = 50, osc11 }: { agents?: FakeAgent[]; rows?: number; osc11?: { delayMs: number; splitMs?: number; light?: boolean } } = {}) =>
  new App({ cwd: repo.tiny(), args, env: { ANTHROPIC_API_KEY: undefined, ...env }, agents, noDemo: true, rows, cols: 110, ...(osc11 ? { osc11 } : {}) });

/** Picks row `n` of a picker: a digit moves the selection, Enter confirms it (BUG-50). */
const choose = (app: App, n: number | string) => app.press(String(n), KEY.enter);

/** The checklist, with only the given rows (1-based) checked, then Enter. */
async function checklist(app: App, rows: number[]) {
  await app.waitFor("Connect your coding agents");
  const screen = app.screen();
  const checked = (n: number) => new RegExp(`${n}\\. \\[x\\]`).test(screen);
  for (let n = 1; n <= 6; n++) if (checked(n) !== rows.includes(n)) await app.press(String(n));
  await app.press(KEY.enter);
}

/** How often `text` was printed so far (scrollback included). */
const printed = (app: App, text: string) => app.history().split(text).length - 1;

/** Esc, then waits for the screen titled `title` to be shown again; returns it, from its title down. */
async function back(app: App, title: string): Promise<string> {
  const before = printed(app, title);
  await app.press(KEY.esc);
  await app.waitFor(() => printed(app, title) > before);
  await app.settle(150);
  const h = app.history();
  return h.slice(h.lastIndexOf(title));
}

describe("the checklist", () => {
  test("lists the six harnesses, installed or not (the install offer shows the command); esc changes nothing", async () => {
    const cfg = freshConfig("checklist");
    const app = run([], { GLUON_CONFIG: cfg }, { agents: ["claude", "opencode"] });
    await app.waitFor("Connect your coding agents");
    const s = app.screen();
    expect(s).toMatch(/1\. \[x\] Claude Code\s+installed \(claude\)/);
    for (const [n, h, label] of [[2, "codex", "Codex"], [3, "antigravity", "Antigravity"], [4, "grok-build", "Grok Build"]] as const) {
      expect(s).toMatch(new RegExp(`${n}\\. \\[ \\] ${label}\\s+not installed$`, "m"));
      expect(s).not.toContain(installHint(h));
    }
    expect(s).toMatch(/5\. \[x\] OpenCode\s+installed \(opencode\)/);
    expect(s).toMatch(/6\. \[ \] Kimi Code\s+not installed$/m);
    expect(s).not.toContain(installHint("kimi-code"));
    await app.press(KEY.esc);
    await app.waitFor("gluon setup");
    expect(await app.exitCode()).toBe(0);
    expect(existsSync(cfg)).toBe(false);
  });

  test("a checked harness that isn't installed is offered an install; skipped, the summary gives its install command", async () => {
    const cfg = freshConfig("checklist-missing");
    const app = run(["setup"], { GLUON_CONFIG: cfg }, { agents: ["claude"] });
    await checklist(app, [2]);
    await app.waitFor("Codex (codex) isn't installed. Install it?");
    await app.settle(GUARD_MS + 150);
    await app.press(KEY.enter);
    await app.waitFor(`Codex (\`codex\`) isn't installed. Install it: \`${installHint("codex")}\``);
    expect(await app.exitCode(5000)).toBe(1);
  });
});

describe("Claude Code", () => {
  test("subscription, signed in: no notice, straight to the check, then the session on the plan", async () => {
    const cfg = freshConfig("cc-plan");
    const app = run([], { GLUON_CONFIG: cfg });
    await checklist(app, [1]);
    await app.waitFor("How should Claude Code sign in?");
    expect(app.screen()).toMatch(/› 1\. API key\s+Anthropic · Amazon Bedrock · OpenRouter; billed per use[\s\S]*2\. Subscription \(personal use\)/);
    await choose(app, 2);
    await app.waitFor(HOME_VIEW, 20_000);
    const h = app.history();
    expect(h).toContain("Signed in to Claude Code · Claude Max plan");
    expect(h).not.toMatch(/Your plan, your terminal|Sounds good|No thanks/);
    expect(h).not.toContain("dev@example.com");
    expect(h).toContain("✓ Claude Code · plan · haiku sonnet opus fable");
    expect(h).toContain("Intake agent · Sonnet 5.5 on your Claude plan (personal)");
    const c = yaml(cfg);
    expect(c.connections).toEqual({ "claude-code": { auth: "subscription" } });
    expect(c.notices).toBeUndefined();
    expect(c.verified["claude-code/plan/sonnet"]).toMatch(/^\d{4}-/);
    expect(c.checked["claude-code/plan"]).toMatch(/^\d{4}-/);
    expect(c.brain.active).toEqual({ route: "claude-plan", model: "claude-sonnet-5-5" });
  });

  test("subscription, logged out: offers `claude auth login`, hands over the terminal, then checks again", async () => {
    const cfg = freshConfig("cc-logged-out");
    const state = join(dirname(cfg), "claude-signed-in");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg, FAKE_CLAUDE_LOGGED_OUT: "1", FAKE_CLAUDE_STATE: state });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 2);
    await app.waitFor("You're not signed in to Claude Code");
    expect(app.screen()).toContain("Runs claude auth login");
    await choose(app, 1);
    await app.waitFor("FAKE-CLAUDE LOGIN press enter>");
    await app.press(KEY.enter);
    await app.waitFor("Intake agent · Sonnet 5.5 on your Claude plan", 20_000);
    expect(app.history()).toContain("Signed in to Claude Code · Claude Max plan");
    expect(app.history()).not.toContain("Your plan, your terminal");
    expect(await app.exitCode(5000)).toBe(0);
    expect(yaml(cfg).connections["claude-code"]).toEqual({ auth: "subscription" });
  });

  test("subscription, logged out and not now: nothing is connected", async () => {
    const cfg = freshConfig("cc-not-now");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg, FAKE_CLAUDE_LOGGED_OUT: "1" });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 2);
    await app.waitFor("You're not signed in to Claude Code");
    await choose(app, 2);
    expect(await app.exitCode(8000)).toBe(1);
    expect(yaml(cfg).connections).toBeUndefined();
  });

  test("an old `notices:` key loads and is ignored; ANTHROPIC_API_KEY in the environment is pointed out, not removed", async () => {
    const cfg = freshConfig("cc-old-notices", "# mine\nnotices: { claude: 2026-01-01, xai: 2026-01-02 } # old\n");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg, ANTHROPIC_API_KEY: "sk-ant-api03-envkeyenvkeyenvkey" });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 2);
    await app.waitFor("Intake agent · ", 20_000);
    const h = app.history();
    expect(h).not.toContain("Your plan, your terminal");
    expect(h).toContain("ANTHROPIC_API_KEY is set in your environment");
    expect(h).not.toContain("envkeyenvkey");
    expect(read(cfg)).toContain("# mine");
    expect(yaml(cfg).connections).toEqual({ "claude-code": { auth: "subscription" } });
  });

  test("API key: a pasted Anthropic key is saved next to the config (0600), never shown; the brain uses it @full", async () => {
    const cfg = freshConfig("cc-key");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 1);
    await app.waitFor("Paste your Anthropic API key");
    await app.paste("sk-ant-api03-pastedpastedpasted");
    await app.press(KEY.enter);
    await app.waitFor("Intake agent · Sonnet 5.5 · Anthropic API", 20_000);
    expect(await app.exitCode(5000)).toBe(0);
    expect(app.history()).not.toContain("pastedpasted");
    expect(app.history()).toContain("✓ Claude Code · Anthropic · haiku sonnet opus fable");
    const env = join(dirname(cfg), ".env");
    expect(read(env)).toContain("ANTHROPIC_API_KEY=sk-ant-api03-pastedpastedpasted");
    expect(isPrivate(env, HOME)).toBe(true);
    expect(yaml(cfg).connections["claude-code"]).toEqual({ auth: "api", provider: "anthropic" });
  });

  test("API key: a key already set is offered for reuse @full", async () => {
    const cfg = freshConfig("cc-key-reuse");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg, ANTHROPIC_API_KEY: "sk-ant-api03-testkeytestkeytestkey" });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    expect(app.screen()).toContain("already connected (ANTHROPIC_API_KEY from your environment)");
    await choose(app, 1);
    await app.waitFor("Anthropic: use what's already set up?");
    await choose(app, 1);
    await app.waitFor("Intake agent · ", 20_000);
    expect(app.history()).not.toContain("testkeytestkey");
    expect(existsSync(join(dirname(cfg), ".env"))).toBe(false);
  });

  test("OpenRouter: the key is saved; the launch gets OpenRouter's documented Claude Code setup and nothing else @full", async () => {
    const cfg = freshConfig("cc-openrouter");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 3);
    await app.waitFor("Paste your OpenRouter API key");
    await app.paste("sk-or-v1-0123456789abcdef0123456789abcdef");
    await app.press(KEY.enter);
    await app.waitFor("Intake agent · Sonnet 5.5 via OpenRouter", 20_000);
    expect(app.history()).toContain("✓ Claude Code · OpenRouter · haiku sonnet opus fable");
    const r = await cli(["--launch", "claude-code", "--model", "sonnet", "--dry-run", "x"], { env: { GLUON_CONFIG: cfg } });
    const cmd = JSON.parse(r.stdout);
    expect(cmd.argv).toEqual(["claude", "--model", "anthropic/claude-sonnet-5.5", "--", "x"]);
    expect(cmd.env).toEqual({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: "sk-or-v1-••••", ANTHROPIC_API_KEY: "" });
  });
});

describe("Codex", () => {
  test("ChatGPT plan, logged out: `codex login` handoff, then the brain on the ChatGPT plan (no notice)", async () => {
    const cfg = freshConfig("codex-plan");
    const state = join(dirname(cfg), "codex-signed-in");
    const app = run(["connect", "codex"], { GLUON_CONFIG: cfg, FAKE_CODEX_LOGGED_OUT: "1", FAKE_CODEX_STATE: state }, { agents: ["codex"] });
    await app.waitFor("How should Codex sign in?");
    expect(app.screen()).toMatch(/1\. API key\s+OpenAI · Amazon Bedrock · OpenRouter; billed per use/);
    await choose(app, 2);
    await app.waitFor("You're not signed in to Codex");
    expect(app.screen()).toContain("Runs codex login");
    await choose(app, 1);
    await app.waitFor("FAKE-CODEX LOGIN press enter>");
    await app.press(KEY.enter);
    await app.waitFor("Intake agent · GPT-6.1 Sol on your ChatGPT plan (personal)", 30_000);
    expect(app.history()).toContain("Signed in to Codex · ChatGPT");
    expect(app.history()).not.toContain("Your plan, your terminal");
    expect(app.history()).toContain("✓ Codex · plan · luna sol astra");
    const c = yaml(cfg);
    expect(c.connections.codex).toEqual({ auth: "subscription" });
    expect(c.notices).toBeUndefined();
    expect(c.brain.active).toEqual({ route: "chatgpt-plan", model: "gpt-6.1-sol" });
  });

  test("signed in with an API key is not the ChatGPT plan: it says so and offers `codex login`", async () => {
    const cfg = freshConfig("codex-api-key-login");
    const app = run(["connect", "codex"], { GLUON_CONFIG: cfg, FAKE_CODEX_METHOD: "api-key" }, { agents: ["codex"] });
    await app.waitFor("How should Codex sign in?");
    await choose(app, 2);
    await app.waitFor("Codex isn't signed in with your ChatGPT plan");
    expect(app.screen()).not.toContain("abcd");
    await choose(app, 2);
    expect(await app.exitCode(8000)).toBe(1);
  });

  test("OpenRouter: codex gets OpenRouter as its model provider and only OPENROUTER_API_KEY", async () => {
    const cfg = freshConfig("codex-openrouter", "connections: { codex: { auth: api, provider: openrouter } }\n");
    const r = await cli(["--launch", "codex", "--model", "gpt-6.1-sol", "--effort", "high", "--dry-run", "- x"], { env: { GLUON_CONFIG: cfg, OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef0123456789abcdef", OPENAI_API_KEY: "sk-proj-shouldnotbepassed0123456" }, agents: ["codex"] });
    const cmd = JSON.parse(r.stdout);
    expect(cmd.argv).toEqual([
      "codex", "-m", "openai/gpt-6.1-sol", "-c", 'model_reasoning_effort="high"',
      "-c", 'model_providers.openrouter={name="OpenRouter",base_url="https://openrouter.ai/api/v1",env_key="OPENROUTER_API_KEY"}',
      "-c", 'model_provider="openrouter"', "--", "- x",
    ]);
    expect(cmd.env).toEqual({ OPENROUTER_API_KEY: "sk-or-v1-••••" });
  });

  test("BUG-420/codex-bedrock-runtime: codex on Bedrock uses its amazon-bedrock-runtime provider (the one that takes the global.openai.* profiles), with the configured AWS profile and region", async () => {
    const cfg = freshConfig("codex-bedrock", "connections: { codex: { auth: api, provider: bedrock } }\nbedrock: { profile: dev, region: us-west-2 }\n");
    const r = await cli(["--launch", "codex", "--model", "gpt-6-luna", "--dry-run", "x"], { env: { GLUON_CONFIG: cfg }, agents: ["codex"] });
    const cmd = JSON.parse(r.stdout);
    expect(cmd.argv).toEqual(["codex", "-m", "global.openai.gpt-6-luna", "-c", 'model_provider="amazon-bedrock-runtime"', "--", "x"]);
    expect(cmd.env).toEqual({ AWS_PROFILE: "dev", AWS_REGION: "us-west-2" });
  });
});

describe("Antigravity and Grok Build", () => {
  test("Antigravity on the Google account: `agy models` is the check; launches with the effort in the model id", async () => {
    const cfg = freshConfig("agy-plan", "notices: { claude: 2026-01-01 }\nconnections: { claude-code: { auth: subscription } }\n");
    const app = run(["connect", "antigravity"], { GLUON_CONFIG: cfg }, { agents: ["claude", "agy"] });
    await app.waitFor("How should Antigravity sign in?");
    await choose(app, 2);
    await app.waitFor("Intake agent · ", 20_000);
    expect(app.history()).toContain("Signed in to Antigravity · Google account");
    expect(app.history()).toContain("✓ Antigravity · plan · gemini-3.8-flash");
    const r = await cli(["--launch", "antigravity", "--model", "gemini-3.8-flash", "--effort", "high", "--dry-run", "- x"], { env: { GLUON_CONFIG: cfg }, agents: ["agy"] });
    expect(JSON.parse(r.stdout)).toMatchObject({ argv: ["agy", "--model=gemini-3.8-flash-high", "--prompt-interactive=- x"], env: {} });
  });

  test("Antigravity with a Gemini key: it tells the user what to set in Antigravity's own settings", async () => {
    const cfg = freshConfig("agy-key");
    const app = run(["connect", "antigravity"], { GLUON_CONFIG: cfg, GEMINI_API_KEY: "AIzaSyA0123456789abcdefghijklmnopqrstuv" }, { agents: ["agy"] });
    await app.waitFor("How should Antigravity sign in?");
    await choose(app, 1);
    await app.waitFor("Gemini API: use what's already set up?");
    await choose(app, 1);
    await app.waitFor("modelProvider: gemini");
    expect(app.history().replace(/\n/g, "")).toContain("Gluon doesn't edit Antigravity's settings");
    expect(app.history()).not.toContain("0123456789abcdef");
  });

  test("Grok Build, logged out: `grok login`, then only the models the account lists (grok-4.7 unavailable on this one)", async () => {
    const cfg = freshConfig("grok-plan");
    const state = join(dirname(cfg), "grok-signed-in");
    const app = run(["connect", "grok-build"], { GLUON_CONFIG: cfg, FAKE_GROK_LOGGED_OUT: "1", FAKE_GROK_STATE: state, FAKE_GROK_MODELS: "grok-4.6" }, { agents: ["grok"] });
    await app.waitFor("How should Grok Build sign in?");
    await choose(app, 2);
    await app.waitFor("You're not signed in to Grok Build");
    await choose(app, 1);
    await app.waitFor("FAKE-GROK LOGIN press enter>");
    await app.press(KEY.enter);
    await app.waitFor("✗ Grok Build · plan · grok-4.7 unavailable (nothing reachable)", 20_000);
    // Grok is an agent only: with no brain step connected, there's no brain.
    await app.waitFor("no step of `brain.order` works");
    expect(yaml(cfg).verified ?? {}).toEqual({});
  });

  test("Kimi Code, logged out: `kimi login` (no status command: `kimi provider list` is asked after it), then K3 on the plan; K2.7 Code isn't there", async () => {
    const cfg = freshConfig("kimi-plan");
    const state = join(dirname(cfg), "kimi-signed-in");
    const app = run(["connect", "kimi-code"], { GLUON_CONFIG: cfg, FAKE_KIMI_LOGGED_OUT: "1", FAKE_KIMI_STATE: state }, { agents: ["kimi"] });
    await app.waitFor("How should Kimi Code sign in?");
    await choose(app, 2);
    await app.waitFor("You're not signed in to Kimi Code");
    // The login's own note (the region) is said with it.
    expect(app.screen().replace(/\s+/g, " ")).toContain("kimi login --region global");
    await choose(app, 1);
    await app.waitFor("FAKE-KIMI LOGIN press enter>");
    await app.press(KEY.enter);
    await app.waitFor("✓ Kimi Code · plan · kimi-k3", 20_000);
    expect(app.history()).not.toContain("kimi-k2.7-code");
    expect(yaml(cfg).connections).toEqual({ "kimi-code": { auth: "subscription" } });
  });

  test("Kimi Code on OpenRouter: the key is OpenRouter's (reused from the environment), both models are checked, nothing of Kimi's is written", async () => {
    const cfg = freshConfig("kimi-key");
    const app = run(["connect", "kimi-code"], { GLUON_CONFIG: cfg, OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef0123", GLUON_TEST_PROBES: probes("kimi-key", {}) }, { agents: ["kimi"] });
    await app.waitFor("How should Kimi Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 2);
    await app.waitFor("OpenRouter: use what's already set up?");
    await choose(app, 1);
    await app.waitFor("✓ Kimi Code · OpenRouter · kimi-k2.7-code kimi-k3", 20_000);
    expect(yaml(cfg).connections).toEqual({ "kimi-code": { auth: "api", provider: "openrouter" } });
    expect(app.history()).not.toContain("0123456789abcdef");
  });

  test("Kimi Code on Moonshot (issue #107): the key is Moonshot's (reused from the environment), both models are checked, nothing of Kimi's is written, no base URL", async () => {
    const cfg = freshConfig("kimi-moonshot");
    const app = run(["connect", "kimi-code"], { GLUON_CONFIG: cfg, MOONSHOT_API_KEY: "sk-moonshot0123456789abcdef0123", GLUON_TEST_PROBES: probes("kimi-moonshot", {}) }, { agents: ["kimi"] });
    await app.waitFor("How should Kimi Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    expect(app.screen()).toContain("already connected (MOONSHOT_API_KEY from your environment)");
    await choose(app, 1);
    await app.waitFor("Moonshot AI: use what's already set up?");
    await choose(app, 1);
    await app.waitFor("✓ Kimi Code · Moonshot AI · kimi-k2.7-code kimi-k3", 20_000);
    expect(yaml(cfg).connections).toEqual({ "kimi-code": { auth: "api", provider: "moonshot" } });
    expect(app.history()).not.toContain("0123456789abcdef");
    expect(existsSync(join(dirname(cfg), ".env"))).toBe(false);
  });

  test("BUG-100: the first line typed into a login handoff reaches the login (on Windows Gluon's stdin took it)", async () => {
    const cfg = freshConfig("bug-100");
    const state = join(dirname(cfg), "claude-signed-in");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg, FAKE_CLAUDE_LOGGED_OUT: "1", FAKE_CLAUDE_STATE: state });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 2);
    await app.waitFor("You're not signed in to Claude Code");
    await choose(app, 1);
    await app.waitFor("FAKE-CLAUDE LOGIN press enter>");
    await app.settle(500);
    await app.press(KEY.enter);
    await app.waitFor("Login successful.", 5000);
    await app.waitFor("Signed in to Claude Code · Claude Max plan", 20_000);
  });
});

describe("OpenCode (its plan and OpenRouter)", () => {
  test("the plan signs in through OpenCode's own login (a handoff), then an OpenRouter key: a launch gets only its model's key, the plan none; an effort goes in OpenCode's config @full", async () => {
    const cfg = freshConfig("opencode-plan");
    const state = join(dirname(cfg), "opencode-signed-in");
    const app = run(["connect", "opencode"], { GLUON_CONFIG: cfg, FAKE_OPENCODE_LOGGED_OUT: "1", FAKE_OPENCODE_STATE: state }, { agents: ["opencode"] });
    await app.waitFor("Which providers should OpenCode use?");
    expect(app.screen()).toMatch(/1\. \[ \] OpenRouter\s+OPENROUTER_API_KEY/);
    expect(app.screen()).toMatch(/2\. \[ \] OpenCode Go plan\s+OpenCode Go plan \(personal\), through opencode's own login/);
    await app.press("2", KEY.enter);
    await app.waitFor("You're not signed in to OpenCode");
    await app.waitFor("Runs opencode auth login opencode-go");
    await choose(app, 1);
    await app.waitFor("FAKE-OPENCODE LOGIN press enter>");
    await app.press(KEY.enter);
    await app.waitFor("OpenCode: OpenCode Go plan");
    expect(app.history()).toContain("Signed in to OpenCode · OpenCode Go plan");
    await choose(app, 2);
    await app.waitFor("Which provider?");
    await choose(app, 1);
    await app.waitFor("Paste your OpenRouter API key");
    await app.paste("sk-or-v1-0123456789abcdef0123456789abcdef");
    await app.press(KEY.enter);
    await app.waitFor("OpenCode · OpenCode Go plan, OpenRouter");
    await app.waitFor("Intake agent · Sonnet 5.5 via OpenRouter", 20_000);
    expect(app.history()).not.toMatch(/0123456789abcdef0123/);
    expect(yaml(cfg).connections.opencode).toEqual({ auth: "api", providers: ["opencode-go", "openrouter"] });

    // On the plan: no key at all in the environment, and the plan's id (DeepSeek's alias resolved by `current`).
    const flash = JSON.parse((await cli(["--launch", "opencode", "--model", "deepseek-flash", "--dry-run", "x"], { env: { GLUON_CONFIG: cfg }, agents: ["opencode"] })).stdout);
    expect(flash).toMatchObject({ argv: ["opencode", "--standalone", "--prompt=x"], env: { OPENCODE_CONFIG_CONTENT: '{"model":"opencode-go/deepseek-v4.1-flash"}' } });
    expect(Object.keys(flash.env)).toEqual(["OPENCODE_CONFIG_CONTENT"]);
    // The effort is the model's `settings` in OpenCode's config (the plan's key is `reasoningEffort`).
    const high = JSON.parse((await cli(["--launch", "opencode", "--model", "deepseek-flash", "--effort", "high", "--dry-run", "x"], { env: { GLUON_CONFIG: cfg }, agents: ["opencode"] })).stdout);
    expect(JSON.parse(high.env.OPENCODE_CONFIG_CONTENT)).toEqual({ model: "opencode-go/deepseek-v4.1-flash", providers: { "opencode-go": { models: { "deepseek-v4.1-flash": { settings: { reasoningEffort: "high" } } } } } });
    // Muse is not on the plan: OpenRouter's id and key, the effort as `reasoning.effort`.
    const muse = JSON.parse((await cli(["--launch", "opencode", "--model", "muse-spark-1.3", "--effort", "max", "--dry-run", "x"], { env: { GLUON_CONFIG: cfg }, agents: ["opencode"] })).stdout);
    expect(JSON.parse(muse.env.OPENCODE_CONFIG_CONTENT)).toEqual({ model: "openrouter/meta/muse-spark-1.3", providers: { openrouter: { models: { "meta/muse-spark-1.3": { settings: { reasoning: { effort: "max" } } } } } } });
    expect(Object.keys(muse.env)).toEqual(["OPENCODE_CONFIG_CONTENT", "OPENROUTER_API_KEY"]);
    // A model asked for an effort it doesn't take is refused (DeepSeek: low, high, max).
    const bad = await cli(["--launch", "opencode", "--model", "deepseek-flash", "--effort", "medium", "--dry-run", "x"], { env: { GLUON_CONFIG: cfg }, agents: ["opencode"] });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("does not take effort");
  });

  test("an OPENCODE_API_KEY variable is not the plan: only a stored sign-in counts, and one OpenCode wants redone doesn't @full", async () => {
    for (const [name, env] of [["env-only", { FAKE_OPENCODE_ENV_ONLY: "1" }], ["needs-auth", { FAKE_OPENCODE_NEEDS_AUTH: "1" }]] as const) {
      const cfg = freshConfig(`opencode-plan-${name}`);
      const app = run(["connect", "opencode"], { GLUON_CONFIG: cfg, OPENCODE_API_KEY: "sk-oc-0123456789abcdefghij", ...env }, { agents: ["opencode"] });
      await app.waitFor("Which providers should OpenCode use?");
      await app.press("2", KEY.enter);
      await app.waitFor("You're not signed in to OpenCode");
      await choose(app, 2);
      await app.waitFor("OpenCode has no provider yet");
      await choose(app, 1);
      expect(await app.exitCode(8000)).toBe(1);
      expect(existsSync(cfg)).toBe(false);
    }
  });
});

describe("the menus", () => {
  test("BUG-49/I1: a late reply to the background-colour query doesn't close a picker or the checklist", async () => {
    const cfg = freshConfig("late-osc");
    const app = run([], { GLUON_CONFIG: cfg }, { osc11: { delayMs: 600, splitMs: 60 } });
    await app.waitFor("Connect your coding agents");
    await app.oscReplied();
    expect(app.screen()).toContain("space or 1-6 to check");
    expect(await app.exitCode(100)).toBeNull();
    await app.press(KEY.enter);
    await app.waitFor("How should Claude Code sign in?");
    expect(app.screen()).not.toMatch(/rgb:|11;/);
  });

  test("BUG-49/I1: a late reply that arrives while a picker is up is ignored there too", async () => {
    const cfg = freshConfig("late-osc-pick");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg });
    await app.waitFor("How should Claude Code sign in?");
    app.write("\x1b]11;rgb:0c0c/0c0c/0c0c\x07");
    await app.settle(300);
    expect(app.screen()).toContain("enter to select · esc to cancel");
    expect(await app.exitCode(100)).toBeNull();
    app.write("]11;rgb:0c0c/0c0c/0c0c\x1b\\");
    await app.settle(300);
    expect(app.screen()).toContain("enter to select · esc to cancel");
    // Split across reads, as some terminals deliver it: the ESC alone first (Ink reads it as Esc), then the rest.
    app.write("\x1b");
    await Bun.sleep(60);
    app.write("]11;rgb:0c0c/0c0c/0c0c\x07");
    await app.settle(300);
    expect(app.screen()).toContain("enter to select · esc to cancel");
    expect(await app.exitCode(100)).toBeNull();
    await app.press(KEY.esc);
    expect(await app.exitCode(5000)).toBe(1);
  });
});

describe("the brain order", () => {
  const P = (name: string, answers: Record<string, true | string>) => probes(name, answers);

  test("`gluon brain`: the plan comes first when it's connected", async () => {
    const cfg = freshConfig("brain-plan", "connections: { claude-code: { auth: subscription } }\nnotices: { claude: 2026-01-01 }\n");
    const r = await cli(["brain"], { env: { GLUON_CONFIG: cfg, OPENAI_API_KEY: "sk-proj-x0123456789abcdef" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ 1. Sonnet 5.5 on your Claude plan (personal)   ← in use");
    expect(r.stdout).toContain("· 2. GPT-6.1 Sol on your ChatGPT plan (personal) · not connected");
    expect(r.stdout).toContain("· 4. GPT-6 Sol · OpenAI API · not tried (step 1 is in use)");
    expect(yaml(cfg).brain.active).toEqual({ route: "claude-plan", model: "claude-sonnet-5-5" });
    // Each step's effort: what it sends, the medium default unless the step sets one.
    expect(r.stdout).toContain("a step's optional `effort` is the intake agent's effort, medium by default");
    expect(r.stdout).toContain("← in use · effort medium (default)");
    const high = freshConfig("brain-effort", "connections: { claude-code: { auth: subscription } }\nbrain:\n  order:\n    - { route: claude-plan, model: claude-sonnet-5-5, effort: high }\n    - { route: anthropic-api, model: claude-haiku-4-5 }\n");
    const h = await cli(["brain"], { env: { GLUON_CONFIG: high } });
    expect(h.stdout).toContain("✓ 1. Sonnet 5.5 on your Claude plan (personal)   ← in use · effort high\n");
    expect(h.stdout).toContain("2. Haiku 4.5 · Anthropic API · not connected (ANTHROPIC_API_KEY isn't set) · no effort setting");
    expect(yaml(high).brain.active).toEqual({ route: "claude-plan", model: "claude-sonnet-5-5", effort: "high" });
  });

  test("keys and Bedrock: unavailable steps are skipped with their reason (Bedrock's OpenAI models → the next step)", async () => {
    const cfg = freshConfig("brain-mix", "bedrock: { region: us-east-1 }\n");
    const env = {
      GLUON_CONFIG: cfg,
      OPENAI_API_KEY: "sk-proj-x0123456789abcdef",
      GLUON_TEST_PROBES: P("brain-mix", {
        "openai-api/gpt-6-sol": "model not found or not available to this key (404)",
        "bedrock/global.anthropic.claude-sonnet-5-5": "access denied to global.anthropic.claude-sonnet-5-5 in us-east-1",
        "bedrock/us.openai.gpt-6-sol": "access denied to us.openai.gpt-6-sol in us-east-1",
      }),
    };
    const r = await cli(["brain"], { env });
    expect(r.stdout).toContain("· 3. Sonnet 5.5 · Anthropic API · not connected (ANTHROPIC_API_KEY isn't set)");
    expect(r.stdout).toContain("✗ 4. GPT-6 Sol · OpenAI API · model not found");
    expect(r.stdout).toContain("✗ 6. GPT-6 Sol on Bedrock · access denied");
    expect(r.stdout).toContain("· 7. Sonnet 5.5 via OpenRouter · not connected (OPENROUTER_API_KEY isn't set)");
    expect(r.stdout).toContain("✓ 9. Sonnet 4.6 on Bedrock   ← in use");
    expect(yaml(cfg).brain.active).toEqual({ route: "bedrock", model: "us.anthropic.claude-sonnet-4-6" });
  });

  test("OpenRouter before the 4.6 fallbacks; nothing connected: no brain, exit 1", async () => {
    const or = await cli(["brain"], { env: { GLUON_CONFIG: freshConfig("brain-or", "bedrock: { region: us-east-1 }\n"), OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef01", GLUON_TEST_PROBES: P("brain-or", { "bedrock/*": "access denied" }) } });
    expect(or.stdout).toContain("✓ 7. Sonnet 5.5 via OpenRouter   ← in use");
    const none = await cli(["brain"], { env: { GLUON_CONFIG: freshConfig("brain-none") } });
    expect(none.code).toBe(1);
    expect(none.stdout).toContain("No step works");
  });

  test("a custom order in the config is followed", async () => {
    const cfg = freshConfig("brain-custom", "brain:\n  order:\n    - { route: openrouter, model: openai/gpt-6-sol }\n    - { route: anthropic-api, model: claude-haiku-4-5 }\n");
    const r = await cli(["brain"], { env: { GLUON_CONFIG: cfg, ANTHROPIC_API_KEY: "sk-ant-api03-x0123456789abcdef" } });
    expect(r.stdout).toContain("· 1. GPT-6 Sol via OpenRouter · not connected");
    expect(r.stdout).toContain("✓ 2. Haiku 4.5 · Anthropic API   ← in use");
  });
});

describe("doctor", () => {
  test("Bedrock: models refused are named and the rest still offered (global. ids; Codex's are the runtime provider's); results cached", async () => {
    const cfg = freshConfig("doctor-bedrock", "bedrock: { region: us-east-1 }\nconnections:\n  claude-code: { auth: api, provider: bedrock }\n  codex: { auth: api, provider: bedrock }\n");
    const denied = "access denied (enable model access in the Bedrock console)";
    const env = {
      GLUON_CONFIG: cfg,
      GLUON_TEST_PROBES: probes("doctor-bedrock", {
        "bedrock/global.anthropic.claude-sonnet-5-5": denied,
        "bedrock/global.anthropic.claude-opus-5-5": denied,
        "bedrock/global.anthropic.claude-fable-5-1": denied,
        "bedrock/global.openai.gpt-6-luna": denied,
        "bedrock/global.openai.gpt-6.1-sol": denied,
        "bedrock/global.openai.gpt-6-astra": denied,
        "bedrock/us.openai.gpt-6-sol": denied,
      }),
    };
    const r = await cli(["doctor"], { env, agents: ["claude", "codex"] });
    expect(r.stdout).toContain("✗ Claude Code (claude 2.1.284) · Amazon Bedrock · AWS default credentials, us-east-1");
    expect(r.stdout).not.toContain("Amazon Bedrock key");
    expect(r.stdout).toContain("✗ sonnet · global.anthropic.claude-sonnet-5-5 · access denied");
    expect(r.stdout).toContain("✓ haiku · global.anthropic.claude-haiku-5-5");
    expect(r.stdout).toContain("Claude Code · Amazon Bedrock · sonnet, opus, fable unavailable (using haiku)");
    expect(r.stdout).toContain("✗ Codex (codex 0.158.0) · Amazon Bedrock");
    for (const m of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) expect(r.stdout).toContain(`✗ ${m} · global.openai.${m} · access denied`);
    expect(r.stdout).not.toMatch(/fallback|gpt-oss/);
    expect(r.stdout).toContain("✓ 9. Sonnet 4.6 on Bedrock   ← in use");
    const c = yaml(cfg);
    expect(c.verified["claude-code/bedrock/global.anthropic.claude-haiku-5-5"]).toBeTruthy();
    expect(c.verified["claude-code/bedrock/global.anthropic.claude-sonnet-5-5"]).toBeUndefined();
    expect(c.checked["codex/bedrock"]).toBeTruthy();
    // Only verified models are offered, and a launch resolves to them.
    const launch = JSON.parse((await cli(["--launch", "claude-code", "--model", "haiku", "--dry-run", "x"], { env: { GLUON_CONFIG: cfg } })).stdout);
    expect(launch.argv).toEqual(["claude", "--model", "global.anthropic.claude-haiku-5-5", "--", "x"]);
    expect(launch.env).toEqual({ AWS_REGION: "us-east-1", CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  test("on the plan: a failed call is reported with a hint, tokens masked; `claude -p` gets no tools or settings", async () => {
    const cfg = freshConfig("doctor-fail", "connections: { claude-code: { auth: subscription } }\nnotices: { claude: 2026-01-01 }\n");
    const log = join(dirname(cfg), "claude.log");
    const r = await cli(["doctor"], { env: { GLUON_CONFIG: cfg, FAKE_PING_FAIL: "1", FAKE_CLAUDE_LOG: log } });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗ Claude Code (claude 2.1.284) · Claude plan (personal) · signed in: Claude Max plan");
    expect(r.stdout).toContain("✗ sonnet · sonnet · Invalid token sk-ant-•••• · Please run /login");
    expect(r.stdout).toContain("✗ 1. Sonnet 5.5 on your Claude plan (personal) · Invalid token sk-ant-••••");
    expect(r.stdout).not.toContain("abcdefghijklmnop");
    expect(r.stdout).not.toContain("dev@example.com");
    expect(read(log)).toContain("-p --model sonnet --output-format json --tools  --setting-sources  --no-session-persistence");
  });

  test("on the plan, logged out: says so", async () => {
    const cfg = freshConfig("doctor-out", "connections: { claude-code: { auth: subscription } }\nnotices: { claude: 2026-01-01 }\n");
    const r = await cli(["doctor"], { env: { GLUON_CONFIG: cfg, FAKE_CLAUDE_LOGGED_OUT: "1" } });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Claude plan (personal) · not signed in");
    expect(r.stdout).toContain("not logged in to Claude Code");
  });

  test("every harness: version, connection, sign-in check and models; a missing binary shows its install command", async () => {
    const cfg = freshConfig(
      "doctor-all",
      "notices: { claude: 2026-01-01, google: 2026-01-01, xai: 2026-01-01 }\nconnections:\n  claude-code: { auth: subscription }\n  codex: { auth: subscription }\n  antigravity: { auth: subscription }\n  grok-build: { auth: subscription }\n  opencode: { providers: [openrouter] }\n",
    );
    const r = await cli(["doctor"], { env: { GLUON_CONFIG: cfg, FAKE_CODEX_LOGGED_OUT: "1", OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef0123", FAKE_CLAUDE_BAD_MODELS: "fable" }, agents: ["claude", "codex", "agy", "grok"] });
    expect(r.stdout).toContain("✗ Claude Code (claude 2.1.284) · Claude plan (personal) · signed in: Claude Max plan");
    expect(r.stdout).toContain("✗ fable · fable · There's an issue with the selected model (fable)");
    expect(r.stdout).toContain("Codex (codex 0.158.0) · ChatGPT plan (personal) · not signed in");
    expect(r.stdout).toContain("✓ Antigravity (agy 1.2.13) · Google account (personal) · signed in: Google account");
    expect(r.stdout).toContain("Grok Build (grok 1.0.44) · SuperGrok / X account (personal) · signed in: grok.com account");
    expect(r.stdout).toContain(`✗ OpenCode (opencode) · not installed · install: ${installHint("opencode")} (or \`gluon install opencode\`)`);
    expect(r.stdout).toContain("✓ 1. Sonnet 5.5 on your Claude plan (personal)   ← in use");
    expect(r.stdout).toContain("· 2. GPT-6.1 Sol on your ChatGPT plan (personal) · not connected");
    expect(r.code).toBe(1);
  });
});

describe("config from the first pass", () => {
  test("old keys are mapped to the new shape once, keeping comments", async () => {
    const cfg = freshConfig("migrate", "# mine\nbrain: { provider: subscription, model: sonnet, subscriptionNotice: 2026-09-01 }\nauth: { claude-code: subscription }\naws: { profile: dev, region: eu-west-1 }\n");
    const r = await cli(["--help"], { env: { GLUON_CONFIG: cfg } });
    expect(r.code).toBe(0);
    const text = read(cfg);
    expect(text).toContain("# mine");
    const c = yaml(cfg);
    expect(c.connections).toEqual({ "claude-code": { auth: "subscription" } });
    expect(c.bedrock).toEqual({ profile: "dev", region: "eu-west-1" });
    expect(c.notices).toBeUndefined();
    expect(c.brain?.subscriptionNotice).toBeUndefined();
    expect(c.auth).toBeUndefined();
    expect(c.aws).toBeUndefined();
    expect(c.brain?.provider).toBeUndefined();
  });
});

test("all fake agents on PATH: the checklist marks each one installed", async () => {
  const app = run([], { GLUON_CONFIG: freshConfig("checklist-all") }, { agents: ALL });
  // The title can be drawn before the rows: wait for the last one.
  await app.waitFor(/5\. \[.\] OpenCode/);
  expect(app.screen().match(/\[x\]/g)?.length).toBe(5);
});

describe("setup back navigation", () => {
  test("setup back navigation/within a harness: Esc at the provider goes back to the sign-in choice, pre-selected @full", async () => {
    const cfg = freshConfig("back-within");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 3);
    await app.waitFor("Paste your OpenRouter API key");
    expect(await back(app, "Which provider?")).toMatch(/› 3\. OpenRouter/);
    expect(await back(app, "How should Claude Code sign in?")).toMatch(/› 1\. API key/);
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Intake agent · Sonnet 5.5 on your Claude plan", 20_000);
    expect(yaml(cfg).connections).toEqual({ "claude-code": { auth: "subscription" } });
  });

  test("setup back navigation/across harnesses: back from Codex's first screen to Claude Code's key, the provider and the checklist, all as answered @full", async () => {
    const cfg = freshConfig("back-across");
    const app = run(["setup"], { GLUON_CONFIG: cfg }, { agents: ["claude", "codex"] });
    await checklist(app, [1, 2]);
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 3);
    await app.waitFor("Paste your OpenRouter API key");
    await app.paste("sk-or-v1-0123456789abcdef0123456789abcdef");
    await app.press(KEY.enter);
    await app.waitFor("How should Codex sign in?");
    expect(await back(app, "Paste your OpenRouter API key")).toMatch(/› •+/);
    expect(await back(app, "Which provider?")).toMatch(/› 3\. OpenRouter/);
    expect(await back(app, "How should Claude Code sign in?")).toMatch(/› 1\. API key/);
    const list = await back(app, "Connect your coding agents");
    expect(list).toMatch(/1\. \[x\] Claude Code[\s\S]*2\. \[x\] Codex[\s\S]*3\. \[ \] Antigravity/);
    // Forward again: each screen keeps its answer; the key is still there.
    await app.press(KEY.enter);
    await app.waitFor(() => printed(app, "How should Claude Code sign in?") === 3);
    await app.press(KEY.enter);
    await app.waitFor(() => printed(app, "Which provider?") === 3);
    await app.press(KEY.enter);
    await app.waitFor(() => printed(app, "Paste your OpenRouter API key") === 3);
    await app.press(KEY.enter);
    await app.waitFor(() => printed(app, "How should Codex sign in?") === 2);
    await choose(app, 1);
    await app.waitFor(() => printed(app, "Which provider?") === 4);
    expect(app.screen()).toContain("already connected (the OPENROUTER_API_KEY you pasted)");
    expect(existsSync(join(dirname(cfg), ".env"))).toBe(false);
    await choose(app, 3);
    await app.waitFor("OpenRouter: use what's already set up?");
    await choose(app, 1);
    await app.waitFor("Intake agent · Sonnet 5.5 via OpenRouter", 20_000);
    expect(yaml(cfg).connections).toEqual({ "claude-code": { auth: "api", provider: "openrouter" }, codex: { auth: "api", provider: "openrouter" } });
    expect(read(join(dirname(cfg), ".env")).trim()).toBe("OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef");
  });

  test("setup back navigation/from the key prompt and the AWS prompts back to the provider choice @full", async () => {
    const cfg = freshConfig("back-key");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg, AWS_PROFILE: undefined, AWS_REGION: undefined });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 1);
    await app.waitFor("Paste your Anthropic API key");
    expect(app.screen()).toContain("enter to save · esc to go back · ctrl+c to quit");
    expect(await back(app, "Which provider?")).toMatch(/› 1\. Anthropic/);
    await choose(app, 2);
    await app.waitFor("Which AWS profile should Bedrock use?");
    await app.type("dev");
    await app.press(KEY.enter);
    await app.waitFor("Which AWS region?");
    expect(await back(app, "Which AWS profile should Bedrock use?")).toContain("› dev");
    expect(await back(app, "Which provider?")).toMatch(/› 2\. Amazon Bedrock/);
    await back(app, "How should Claude Code sign in?");
    await app.press(KEY.esc);
    expect(await app.exitCode(5000)).toBe(1);
    expect(app.history()).toContain("Nothing changed.");
    expect(existsSync(cfg)).toBe(false);
  });

  test("setup back navigation/back past a login handoff lands on the sign-in choice and doesn't run the login again @full", async () => {
    const cfg = freshConfig("back-login");
    const state = join(dirname(cfg), "claude-signed-in");
    const app = run(["setup"], { GLUON_CONFIG: cfg, FAKE_CLAUDE_LOGGED_OUT: "1", FAKE_CLAUDE_STATE: state }, { agents: ["claude", "opencode"] });
    await checklist(app, [1, 5]);
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 2);
    await app.waitFor("You're not signed in to Claude Code");
    await choose(app, 1);
    await app.waitFor("FAKE-CLAUDE LOGIN press enter>");
    await app.press(KEY.enter);
    await app.waitFor("Which providers should OpenCode use?");
    expect(await back(app, "How should Claude Code sign in?")).toMatch(/› 2\. Subscription/);
    expect(printed(app, "You're not signed in to Claude Code")).toBe(1);
    expect(printed(app, "FAKE-CLAUDE LOGIN")).toBe(1);
    // Subscription again: signed in now, so no login menu and no login.
    await app.press(KEY.enter);
    await app.waitFor(() => printed(app, "Which providers should OpenCode use?") === 2);
    expect(printed(app, "You're not signed in to Claude Code")).toBe(1);
    expect(printed(app, "FAKE-CLAUDE LOGIN")).toBe(1);
    await app.press(KEY.enter);
    await app.waitFor("OpenCode has no provider yet");
    await choose(app, 1);
    await app.waitFor("Intake agent · Sonnet 5.5 on your Claude plan", 20_000);
    expect(yaml(cfg).connections).toEqual({ "claude-code": { auth: "subscription" } });
  });

  test("setup back navigation/Esc on the first screen leaves with config and .env untouched, even after a key was pasted @full", async () => {
    const before = "# mine\nconnections: { claude-code: { auth: api, provider: anthropic } } # keep\n";
    const cfg = freshConfig("back-first", before);
    const app = run(["setup"], { GLUON_CONFIG: cfg }, { agents: ["claude", "opencode"] });
    await checklist(app, [1, 5]);
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 1);
    await app.waitFor("Paste your Anthropic API key");
    await app.paste("sk-ant-api03-pastedpastedpasted");
    await app.press(KEY.enter);
    await app.waitFor("Which providers should OpenCode use?");
    for (const title of ["Paste your Anthropic API key", "Which provider?", "How should Claude Code sign in?", "Connect your coding agents"]) await back(app, title);
    await app.press(KEY.esc);
    expect(await app.exitCode(5000)).toBe(1);
    expect(read(cfg)).toBe(before);
    expect(existsSync(join(dirname(cfg), ".env"))).toBe(false);
    expect(app.history()).not.toMatch(/Intake agent ·|Checking|pastedpasted/);
  });

  test("setup back navigation/Ctrl+C after a key was pasted, in the next harness: exit 130, nothing written, nothing probed @full", async () => {
    const before = "# mine\nbedrock: { region: eu-west-1 }\n";
    const cfg = freshConfig("back-ctrlc", before);
    const app = run(["setup"], { GLUON_CONFIG: cfg }, { agents: ["claude", "opencode"] });
    await checklist(app, [1, 5]);
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 1);
    await app.waitFor("Paste your Anthropic API key");
    await app.paste("sk-ant-api03-pastedpastedpasted");
    await app.press(KEY.enter);
    await app.waitFor("Which providers should OpenCode use?");
    await app.press(KEY.ctrlC);
    expect(await app.exitCode(2000)).toBe(130);
    expect(app.history()).toContain("Setup cancelled.");
    expect(app.history()).not.toMatch(/Intake agent ·|Checking/);
    expect(read(cfg)).toBe(before);
    expect(existsSync(join(dirname(cfg), ".env"))).toBe(false);
  });

  test("setup back navigation/a late reply to the background-colour query is not an Esc: no going back @full", async () => {
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: freshConfig("back-osc") });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    app.write("\x1b");
    await Bun.sleep(60);
    app.write("]11;rgb:0c0c/0c0c/0c0c\x07");
    await app.settle(400);
    app.write("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
    await app.settle(400);
    expect(printed(app, "How should Claude Code sign in?")).toBe(1);
    expect(app.screen()).toContain("enter to select · esc to go back · ctrl+c to quit");
    expect(app.screen()).not.toMatch(/rgb:|11;/);
    expect(await back(app, "How should Claude Code sign in?")).toMatch(/› 1\. API key/);
  });

  test("setup back navigation/the footers: esc to cancel on the first screen, esc to go back after it @full", async () => {
    const app = run(["setup"], { GLUON_CONFIG: freshConfig("back-footer") }, { agents: ["claude"] });
    await app.waitFor("Connect your coding agents");
    expect(app.screen()).toContain("space or 1-6 to check · enter to continue · esc to cancel · ctrl+c to quit");
    await app.press(KEY.enter);
    await app.waitFor("How should Claude Code sign in?");
    expect(app.screen()).toContain("enter to select · esc to go back · ctrl+c to quit");
    const connect = run(["connect", "claude-code"], { GLUON_CONFIG: freshConfig("back-footer-connect") });
    await connect.waitFor("How should Claude Code sign in?");
    expect(connect.screen()).toContain("enter to select · esc to cancel · ctrl+c to quit");
  });
});

describe("menus: keys (QA pass 2)", () => {
  test("BUG-50/2.9: a digit then Enter picks in this menu only; the login menu still needs its own answer @full", async () => {
    const cfg = freshConfig("bug50");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg, FAKE_CLAUDE_LOGGED_OUT: "1" });
    await app.waitFor("How should Claude Code sign in?");
    app.write("2");
    await Bun.sleep(150);
    app.write("\r");
    await app.waitFor("You're not signed in to Claude Code");
    await app.settle(800);
    expect(app.screen()).toContain("enter to select · esc to go back");
    expect(app.history()).not.toContain("FAKE-CLAUDE LOGIN");
    expect(existsSync(cfg)).toBe(false);
    // One esc (back() sends it): a second one raced the redraw and could leave the menu early.
    await back(app, "How should Claude Code sign in?");
    await app.press(KEY.esc);
    expect(await app.exitCode(5000)).toBe(1);
  });

  test("BUG-50/4.2: a digit alone only moves the selection", async () => {
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: freshConfig("bug50-move") });
    await app.waitFor("How should Claude Code sign in?");
    await app.press("2");
    await app.settle(500);
    expect(app.screen()).toMatch(/› 2\. Subscription/);
    expect(app.screen()).not.toContain("Signed in to");
  });

  test("BUG-61/4.1: keys that arrive in one read are handled one by one ('13', two spaces)", async () => {
    const app = run(["setup"], { GLUON_CONFIG: freshConfig("bug61") }, { agents: ALL });
    await app.waitFor("Connect your coding agents");
    // All five installed: all checked. "13" unchecks rows 1 and 3, the cursor on row 3.
    app.write("13");
    await app.waitFor((s) => /1\. \[ \] Claude Code/.test(s) && /› 3\. \[ \] Antigravity/.test(s));
    expect(app.screen()).toMatch(/2\. \[x\] Codex/);
    // Two spaces in one read toggle row 3 twice: no change to wait for, so Down follows them; once
    // the cursor has moved, both spaces were handled.
    app.write("  ");
    await app.press(KEY.down);
    await app.waitFor(/› 4\. \[x\] Grok Build/);
    expect(app.screen()).toMatch(/3\. \[ \] Antigravity/);
  });

  test("BUG-133: a digit pressed the moment the next menu appears is honoured (on Windows it was lost: raw mode came on a turn after the menu's first frame) @full", async () => {
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: freshConfig("bug133") });
    await app.waitFor("How should Claude Code sign in?");
    // From the sign-in menu, then back and forth between the provider menu and the key prompts:
    // each time the digit goes in with the provider menu's first frame, and it differs from the
    // row the menu starts on (Anthropic, then the previous answer).
    const rounds: [string, string, string][] = [
      [KEY.enter, "3", "Paste your OpenRouter API key"],
      [KEY.esc, "1", "Paste your Anthropic API key"],
      [KEY.esc, "3", "Paste your OpenRouter API key"],
      [KEY.esc, "1", "Paste your Anthropic API key"],
    ];
    const latest = (title: string) => app.history().slice(app.history().lastIndexOf(title));
    for (const [key, digit, prompt] of rounds) {
      const menus = printed(app, "Which provider?");
      const prompts = printed(app, prompt);
      const shown = app.writeWhen("Which provider?", digit);
      app.write(key);
      await shown;
      const row = new RegExp(`› ${digit}\\. ${digit === "3" ? "OpenRouter" : "Anthropic"}`);
      await app.waitFor(() => printed(app, "Which provider?") > menus && row.test(latest("Which provider?")));
      await app.press(KEY.enter);
      await app.waitFor(() => printed(app, prompt) > prompts);
    }
  });

  test("BUG-57/2.10: Ctrl+C in a setup menu quits setup at once: exit 130, nothing probed, config untouched", async () => {
    const before = "# mine\nbedrock: { region: eu-west-1 }\n";
    const cfg = freshConfig("bug57", before);
    const app = run(["setup"], { GLUON_CONFIG: cfg }, { agents: ALL });
    await app.waitFor("Connect your coding agents");
    await app.press(KEY.enter);
    await app.waitFor("How should Claude Code sign in?");
    await app.press(KEY.ctrlC);
    expect(await app.exitCode(2000)).toBe(130);
    const h = app.history();
    expect(h).toContain("Setup cancelled.");
    expect(h).not.toMatch(/Intake agent ·|Checking|How should Codex/);
    expect(read(cfg)).toBe(before);
  });

  test("BUG-57/2.10: Ctrl+C in a key prompt quits too @full", async () => {
    const cfg = freshConfig("bug57-key");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 1);
    await app.waitFor("Paste your Anthropic API key");
    await app.press(KEY.ctrlC);
    expect(await app.exitCode(2000)).toBe(130);
    expect(existsSync(cfg)).toBe(false);
  });
});

describe("menus: late OSC replies (QA pass 2)", () => {
  test("BUG-54/3.2: a light terminal's late reply (ESC \\ terminator) types nothing into the key @full", async () => {
    const cfg = freshConfig("bug54");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg }, { osc11: { delayMs: 1500, light: true } });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 1);
    await app.waitFor("Paste your Anthropic API key");
    await app.oscReplied();
    await app.paste("sk-ant-api03-lightlightlight");
    await app.press(KEY.enter);
    await app.waitFor("Intake agent ·", 20_000);
    expect(read(join(dirname(cfg), ".env")).trim()).toBe("ANTHROPIC_API_KEY=sk-ant-api03-lightlightlight");
  });

  test("BUG-54/3.2: … nor into the composer, whole or split @full", async () => {
    for (const splitMs of [undefined, 30]) {
      const app = new App({ cwd: repo.tiny(), cols: 80, rows: 24, osc11: { delayMs: 300, splitMs, light: true } });
      await app.waitFor(HOME_VIEW);
      await app.oscReplied();
      await app.type("x");
      expect(app.lines().at(-2)).toMatch(/^ {3}› x$/);
    }
  });

  test("BUG-63/3.1: a reply whose rest comes 250 ms after its ESC doesn't close the menu; a real Esc still does @full", async () => {
    for (const light of [false, true]) {
      const app = run(["connect", "claude-code"], { GLUON_CONFIG: freshConfig(`bug63-${light}`) }, { osc11: { delayMs: 300, splitMs: 250, light } });
      await app.waitFor("How should Claude Code sign in?");
      await app.oscReplied();
      expect(app.screen()).toContain("enter to select · esc to cancel");
      expect(app.screen()).not.toMatch(/rgb:|11;|\\/);
      await app.press(KEY.esc);
      expect(await app.exitCode(5000)).toBe(1);
    }
  });
});

describe("menus: short terminals (QA pass 2)", () => {
  test("BUG-58/4.4: at 80×15 the checklist and a picker never clear the screen and keep their title", async () => {
    const cfg = freshConfig("bug58");
    const app = new App({ cwd: repo.tiny(), args: ["setup"], env: { GLUON_CONFIG: cfg }, agents: ALL, noDemo: true, rows: 15, cols: 80 });
    await app.waitFor("Connect your coding agents");
    app.mark();
    await app.press(KEY.down, KEY.down);
    expect(app.clears()).toEqual({ screen: 0, scrollback: 0 });
    expect(app.screen()).toContain("Connect your coding agents");
    await app.press("2", "3", "4", "5", KEY.enter);
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    app.mark();
    await app.press(KEY.down);
    expect(app.clears()).toEqual({ screen: 0, scrollback: 0 });
    expect(app.screen()).toContain("Which provider?");
    expect(app.screen()).toContain("enter to select");
  });
});

describe("setup: what it changes (QA pass 2)", () => {
  test("BUG-66/2.1: unchecking a connected agent disconnects it, once confirmed", async () => {
    const cfg = freshConfig("bug66", "notices: { xai: 2026-01-01 }\nconnections:\n  grok-build: { auth: subscription }\n");
    const app = run(["setup"], { GLUON_CONFIG: cfg }, { agents: ALL });
    await app.waitFor("Connect your coding agents");
    expect(app.screen()).toMatch(/4\. \[x\] Grok Build/);
    await app.press("4", KEY.enter);
    await app.waitFor("Disconnect Grok Build?");
    await choose(app, 1);
    await app.waitFor("Grok Build disconnected");
    expect(await app.exitCode(5000)).toBe(1);
    expect(yaml(cfg).connections ?? {}).toEqual({});
  });

  test("BUG-66/2.1: … and 'Keep connected' keeps it", async () => {
    const cfg = freshConfig("bug66-keep", "notices: { xai: 2026-01-01 }\nconnections:\n  grok-build: { auth: subscription }\n");
    const app = run(["setup"], { GLUON_CONFIG: cfg }, { agents: ALL });
    await app.waitFor("Connect your coding agents");
    await app.press("4", KEY.enter);
    await app.waitFor("Disconnect Grok Build?");
    await choose(app, 2);
    await app.exitCode(5000);
    expect(yaml(cfg).connections).toEqual({ "grok-build": { auth: "subscription" } });
  });

  test("BUG-69/2.13: nothing chosen on the first run: no probe, no config, and it says what to do", async () => {
    const cfg = freshConfig("bug69");
    const app = run([], { GLUON_CONFIG: cfg, ANTHROPIC_API_KEY: "sk-ant-api03-envenvenvenvenvenv", GLUON_TEST_PROBES: probes("bug69", { "anthropic-api/*": "a probe ran" }) }, { agents: [] });
    await app.waitFor("Connect your coding agents");
    await app.press(KEY.enter);
    expect(await app.exitCode(8000)).toBe(0);
    const h = app.history();
    expect(h).not.toMatch(/Intake agent ·|Checking|a probe ran/);
    expect(h).toContain("No coding agent is installed yet");
    expect(existsSync(cfg)).toBe(false);
  });

  test("BUG-73/2.6: Esc at OpenCode's 'Done / Add another' goes back (never 'Done'); leaving keeps the previous connection", async () => {
    const before = "connections:\n  opencode: { providers: [openrouter] }\n";
    const cfg = freshConfig("bug73", before);
    const app = run(["connect", "opencode"], { GLUON_CONFIG: cfg, OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef0123456789abcdef" }, { agents: ["opencode"] });
    await app.waitFor("Which providers should OpenCode use?");
    await app.press("1", "2", KEY.enter);
    await app.waitFor("OpenCode: OpenCode Go plan");
    expect(await back(app, "Which providers should OpenCode use?")).toMatch(/1\. \[ \] OpenRouter[\s\S]*2\. \[x\] OpenCode Go plan/);
    await app.press(KEY.esc);
    expect(await app.exitCode(5000)).toBe(1);
    expect(read(cfg)).toBe(before);
    expect(existsSync(join(dirname(cfg), ".env"))).toBe(false);
  });

  test("BUG-52/2.7: a pasted replacement key is what Gluon and the agent use, not the environment's @full", async () => {
    const cfg = freshConfig("bug52");
    const env = { GLUON_CONFIG: cfg, ANTHROPIC_API_KEY: "sk-ant-api03-FROMTHEENVIRONMENTenv1" };
    const app = run(["connect", "claude-code"], env);
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 1);
    await app.waitFor("Anthropic: use what's already set up?");
    expect(app.screen().replace(/\s+/g, " ")).toContain("used instead of the one in your environment");
    await choose(app, 2);
    await app.waitFor("Paste your Anthropic API key");
    await app.paste("sk-ant-api03-PASTEDREPLACEMENTpst2");
    await app.press(KEY.enter);
    await app.waitFor("Intake agent ·", 20_000);
    const launch = run(["--launch", "claude-code", "--model", "sonnet", "--", "x"], env);
    await launch.waitFor("type a line>");
    expect(launch.screen()).toContain("TAIL ANTHROPIC_API_KEY=pst2");
    const doctor = await cli(["doctor"], { env });
    expect(doctor.stdout).toContain("Anthropic key (from ");
  });
});

describe("doctor and the brain (QA pass 2)", () => {
  test("BUG-70/5.1: doctor exits 1 when it prints a ✗, even if other models work", async () => {
    const cfg = freshConfig("bug70", "notices: { claude: 2026-01-01 }\nconnections: { claude-code: { auth: subscription } }\n");
    const r = await cli(["doctor"], { env: { GLUON_CONFIG: cfg, FAKE_CLAUDE_BAD_MODELS: "fable" } });
    expect(r.stdout).toContain("✗ fable · fable");
    expect(r.stdout).toContain("✓ 1. Sonnet 5.5 on your Claude plan (personal)   ← in use");
    expect(r.code).toBe(1);
    const ok = await cli(["doctor"], { env: { GLUON_CONFIG: cfg } });
    expect(ok.stdout).not.toMatch(/^\s*✗/m);
    expect(ok.code).toBe(0);
  });

  test("BUG-65/6.4: a stale brain.active (order edited) is dropped and the order tried again", async () => {
    const cfg = freshConfig("bug65", "notices: { claude: 2026-01-01 }\nconnections: { claude-code: { auth: subscription } }\nbrain:\n  order:\n    - { route: claude-plan, model: claude-sonnet-5-5 }\n  active: 3\n");
    const r = await cli(["brain"], { env: { GLUON_CONFIG: cfg } });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ 1. Sonnet 5.5 on your Claude plan (personal)   ← in use");
    expect(yaml(cfg).brain.active).toEqual({ route: "claude-plan", model: "claude-sonnet-5-5" });
    // Reordered: the saved step is found where it moved to, never another step.
    const moved = freshConfig("bug65-moved", "notices: { claude: 2026-01-01 }\nconnections: { claude-code: { auth: subscription } }\nbrain:\n  order:\n    - { route: openrouter, model: anthropic/claude-sonnet-5.5 }\n    - { route: claude-plan, model: claude-sonnet-5-5 }\n  active: { route: claude-plan, model: claude-sonnet-5-5 }\n");
    const m = await cli(["brain"], { env: { GLUON_CONFIG: moved } });
    expect(m.stdout).toContain("✓ 2. Sonnet 5.5 on your Claude plan (personal)   ← in use");
  });
});

describe("review of PR #1", () => {
  test("BUG-87/12: Enter on the empty AWS prompts pins nothing, and shows what Bedrock will use (AWS_PROFILE, AWS_DEFAULT_REGION)", async () => {
    const cfg = freshConfig("aws-unpinned");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg, AWS_PROFILE: "envprof", AWS_REGION: undefined, AWS_DEFAULT_REGION: "eu-central-1" });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 2);
    await app.waitFor("Which AWS profile should Bedrock use?");
    expect(app.screen()).toContain("Enter on an empty line doesn't pin one: Bedrock uses AWS_PROFILE (now envprof).");
    expect(app.screen()).toContain("› envprof (AWS_PROFILE)");
    await app.press(KEY.enter);
    await app.waitFor("Which AWS region?");
    expect(app.screen()).toContain("Bedrock uses AWS_DEFAULT_REGION (now eu-central-1).");
    expect(app.screen()).toContain("› eu-central-1 (AWS_DEFAULT_REGION)");
    await app.press(KEY.enter);
    expect(await app.exitCode(20_000)).toBe(0);
    expect(app.history()).toContain("Intake agent · ");
    const c = yaml(cfg);
    expect(c.connections).toEqual({ "claude-code": { auth: "api", provider: "bedrock" } });
    // Nothing pinned: the environment's profile and region stay the ones used.
    expect(c.bedrock ?? {}).toEqual({});
    expect(read(cfg)).not.toMatch(/envprof|eu-central-1/);
  });

  test("BUG-87/12: a configured profile and region are pre-filled; typing one pins it", async () => {
    const cfg = freshConfig("aws-pinned", "bedrock: { profile: work, region: us-west-2 }\n");
    const app = run(["connect", "claude-code"], { GLUON_CONFIG: cfg, AWS_PROFILE: undefined, AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined });
    await app.waitFor("How should Claude Code sign in?");
    await choose(app, 1);
    await app.waitFor("Which provider?");
    await choose(app, 2);
    await app.waitFor("Amazon Bedrock: use what's already set up?");
    await choose(app, 2);
    await app.waitFor("Which AWS profile should Bedrock use?");
    expect(app.screen()).toContain("› work");
    await app.press(KEY.enter);
    await app.waitFor("Which AWS region?");
    expect(app.screen()).toContain("› us-west-2");
    await app.press(KEY.ctrlU);
    await app.type("eu-west-1");
    await app.press(KEY.enter);
    expect(await app.exitCode(20_000)).toBe(0);
    expect(yaml(cfg).bedrock).toEqual({ profile: "work", region: "eu-west-1" });
  });
});
