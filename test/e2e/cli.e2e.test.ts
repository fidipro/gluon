/** G. The command line and the config file. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { readEvents } from "../../src/events.ts";
import { DEFAULT_ROUTING_YAML } from "../../src/routing-config.ts";
import { config, fakeAgents, repo, WIN } from "./fixtures.ts";
import { App, baseEnv, BUN_FLAGS, cli, GLUON, QUESTION, SLOW, start, stopAll, SYSTEM_PATH, tracked } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

describe("arguments (BUG-21/22)", () => {
  test("G1: --help lists the harnesses and their models", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    // Efforts are the model's: Haiku 5.5 takes every level, DeepSeek low, high, max, Kimi K2.7 Code none.
    expect(r.stdout).toContain("claude-code (models: haiku [low, medium, high, xhigh, max], sonnet [low, medium, high, xhigh, max], opus [low, medium, high, xhigh, max], fable [");
    expect(r.stdout).toContain("opencode (models: deepseek-flash [low, high, max], muse-spark-1.3 [low, medium, high, xhigh, max], muse-spark-1.3-contributor [low, medium, high, xhigh])");
    for (const h of ["codex", "antigravity", "grok-build", "opencode"]) expect(r.stdout).toContain(`${h} (models: `);
  });

  test("BUG-454/routing: `routing path` says where routing.yaml is (next to the config), `routing check` reports a typo and exits 1, and a clean file exits 0 @full", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-routing-"));
    const env = { GLUON_CONFIG: join(dir, "config.yaml") };
    writeFileSync(env.GLUON_CONFIG, "connections: {}\n");
    const path = await cli(["routing", "path"], { env });
    expect([path.code, path.stdout.trim()]).toEqual([0, join(dir, "routing.yaml")]);
    expect(existsSync(join(dir, "routing.yaml"))).toBe(false); // path writes nothing
    const types = "types:\n  feature: { means: build something, mode: build, model: standard, effort: medium }\n";
    writeFileSync(join(dir, "routing.yaml"), `rank:\n  strong: [claude-code/sonet]\n  standard: [codex/gpt-6-luna]\n${types}`);
    const bad = await cli(["routing", "check"], { env });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("1 problem");
    expect(bad.stdout).toContain("rank.strong: unknown model claude-code/sonet");
    writeFileSync(join(dir, "routing.yaml"), `rank:\n  strong: [claude-code/sonnet]\n${types}`);
    const ok = await cli(["routing", "check"], { env });
    expect([ok.code, ok.stdout.trim()]).toEqual([0, `${join(dir, "routing.yaml")}: ok`]);
    writeFileSync(join(dir, "routing.yaml"), "rank: [unclosed\n");
    const broken = await cli(["routing", "check"], { env });
    expect([broken.code, broken.stderr]).toEqual([2, expect.stringMatching(/bad routing\.yaml: .*routing\.yaml:\d+: not valid YAML/)]);
    for (const args of [["routing"], ["routing", "fix"], ["routing", "check", "now"]]) {
      const r = await cli(args, { env });
      expect([args.join(" "), r.code, r.stderr]).toEqual([args.join(" "), 2, expect.stringContaining("check")]);
    }
    expect((await cli(["--help"])).stdout).toContain("gluon routing check");
  });

  test("BUG-454/routing: a missing routing.yaml is written from the default (private), and the default has no problems", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-routing-"));
    const env = { GLUON_CONFIG: join(dir, "config.yaml") };
    writeFileSync(env.GLUON_CONFIG, "connections: {}\n");
    const r = await cli(["routing", "check"], { env });
    expect(existsSync(join(dir, "routing.yaml"))).toBe(true);
    expect(readFileSync(join(dir, "routing.yaml"), "utf8")).toContain("rank:");
    expect([r.code, r.stdout.trim()]).toEqual([0, `${join(dir, "routing.yaml")}: ok`]);
  });

  test("BUG-463/routing default: prints the embedded default (writes nothing); `routing check` on an edited file of an older default says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-routing-"));
    const env = { GLUON_CONFIG: join(dir, "config.yaml") };
    writeFileSync(env.GLUON_CONFIG, "connections: {}\n");
    const d = await cli(["routing", "default"], { env });
    expect(d.code).toBe(0);
    expect(d.stdout).toBe(DEFAULT_ROUTING_YAML);
    expect(existsSync(join(dir, "routing.yaml"))).toBe(false);
    writeFileSync(join(dir, "routing.yaml"), "version: 1\nrank:\n  strong: [claude-code/sonnet]\n");
    const old = await cli(["routing", "check"], { env });
    expect(old.code).toBe(1);
    expect(old.stdout).toContain("your routing.yaml predates this Gluon's default; compare with `gluon routing default`");
    expect(old.stdout).toContain("1 problem");
    expect((await cli(["--help"])).stdout).toContain("gluon routing default");
  });

  test("issue 39/pricing: `pricing update` is in --help, has its own help, takes no other words, and needs no config", async () => {
    expect((await cli(["--help"])).stdout).toContain("gluon pricing update");
    const help = await cli(["pricing", "update", "--help"]);
    expect([help.code, help.stdout]).toEqual([0, expect.stringContaining("only network use")]);
    expect(help.stdout).toContain("'gluon uninstall' removes them");
    for (const args of [["pricing"], ["pricing", "update", "--force"], ["pricing", "show"]]) {
      const r = await cli(args);
      expect([args.join(" "), r.code, r.stderr]).toEqual([args.join(" "), 2, expect.stringContaining("gluon pricing update")]);
    }
  });

  test("G2: --version prints the version", async () => {
    const r = await cli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("G3/G4: bad flags get a short error, no stack trace", async () => {
    for (const args of [["--foo"], ["--launch"]]) {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toStartWith("gluon: ");
      expect(r.stderr).not.toContain("    at ");
    }
  });

  test("G15: a mistyped subcommand is caught", async () => {
    const r = await cli(["doctr"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('did you mean "gluon doctor"');
  });

  test("G15: a task on the command line is the first message @full", async () => {
    const app = await start({ cwd: repo.tiny(), args: ["fix the add bug"], rows: 40 });
    await app.waitFor(QUESTION, 20_000);
    expect(app.screen()).toContain("›  fix the add bug");
    expect(app.screen()).toMatch(/Drafting\n.*◌/);
  });
});

describe("config (BUG-23)", () => {
  const cases: [string, string, string][] = [
    ["bad-yaml", "brain: { order: [\n  model: [unclosed\n", "is not valid YAML"],
    ["bad-route", "brain: { order: [{ route: gemini-plan, model: x }] }\n", "brain.order[0].route must be one of claude-plan, chatgpt-plan, anthropic-api, openai-api, bedrock, openrouter"],
    ["empty-order", "brain: { order: [] }\n", "brain.order must be a non-empty list"],
    ["unknown-harness", "connections: { pi: { auth: api } }\n", "connections.pi: unknown harness (one of claude-code, codex, antigravity, grok-build, opencode, kimi-code)"],
    ["bad-provider", "connections: { codex: { auth: api, provider: gemini } }\n", "connections.codex.provider must be one of openai, bedrock, openrouter"],
    ["opencode-providers", "connections: { opencode: { providers: opencode-go } }\n", "connections.opencode.providers must be a list"],
    ["scalar-string", "just a string\n", "expected a mapping"],
  ];
  test.each(cases)("%s is refused with a readable message", async (name, yaml, message) => {
    const r = await cli(["--help"], { env: { GLUON_CONFIG: config(name, yaml) } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(r.stderr).not.toContain("    at ");
  });

  test("BUG-421/models-key-removed: a `models:` key is ignored with one notice: --help lists the built-in catalog, never the config's", async () => {
    const r = await cli(["--help"], { env: { GLUON_CONFIG: config("models-ignored", "models:\n  claude-code:\n    - id: sonnet\n    - { id: sonnet-6, label: Sonnet 6, ids: { plan: sonnet, anthropic: claude-sonnet-6 } }\n") } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("claude-code (models: haiku [low, medium, high, xhigh, max], sonnet [");
    expect(r.stdout).not.toContain("sonnet-6");
    expect(r.stderr).toContain("`models:` is no longer read");
  });

  test("A18: an empty config uses the defaults", async () => {
    const r = await cli(["--help"], { env: { GLUON_CONFIG: config("empty", "") } });
    expect(r.code).toBe(0);
  });
});

describe("doctor (BUG-24)", () => {
  test("reports a brain problem with ✗, a hint and exit 1, without the aws CLI", async () => {
    const r = await cli(["doctor"], { env: { GLUON_CONFIG: config("anthropic", "connections: { claude-code: { auth: api, provider: anthropic } }\n"), ANTHROPIC_API_KEY: undefined, PATH: [fakeAgents(["claude", "opencode"]), ...SYSTEM_PATH].join(delimiter) } });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗ Claude Code (claude 2.1.284) · Anthropic key");
    expect(r.stdout).toContain("ANTHROPIC_API_KEY isn't set");
    expect(r.stdout).toContain("· 3. Sonnet 5.5 · Anthropic API · not connected (ANTHROPIC_API_KEY isn't set)");
    expect(r.stdout).toContain("No step works");
  });
});

describe("BUG-98: status checks run outside the repository", () => {
  test("doctor runs every harness's status and version check in a neutral directory, never the repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-cwdlog-"));
    const log = join(dir, "cwd.log");
    const yaml = "connections: { claude-code: { auth: subscription }, codex: { auth: subscription }, antigravity: { auth: subscription }, grok-build: { auth: subscription }, opencode: { providers: [opencode-go] } }\n";
    await cli(["doctor"], { cwd: repo.tiny(), agents: ["claude", "codex", "agy", "grok", "opencode"], env: { GLUON_CONFIG: config("cwd-log", yaml), FAKE_CWD_LOG: log } });
    const lines = (await Bun.file(log).text()).trim().split("\n");
    for (const bin of ["claude", "codex", "agy", "grok", "opencode"]) expect(lines.some((l) => l.startsWith(`${bin} `))).toBe(true);
    for (const l of lines) expect(l).not.toContain(repo.tiny());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("QA pass 2", () => {
  const conn = (name: string, yaml: string) => config(name, yaml);
  // One config file per call: two concurrent tests with the same arguments and different YAML must not share one.
  let dryN = 0;
  const dry = async (yaml: string, args: string[], env: Record<string, string | undefined> = {}) => cli(["--launch", ...args, "--dry-run", "--", "- a spec"], { env: { GLUON_CONFIG: conn(`dry-${++dryN}-${args.join("-")}`, yaml), ...env } });

  test("BUG-56/8.4: a repository's bunfig.toml preload never runs inside gluon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-bunfig-"));
    const marker = join(dir, "PRELOAD-RAN");
    writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./p.ts"]\n');
    writeFileSync(join(dir, "p.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
    // The flags come from the entry's shebang (harness BUN_FLAGS): what the installed command runs with.
    expect(BUN_FLAGS).toContain(WIN ? `--config=${join(import.meta.dir, "../../scripts/empty-bunfig.toml")}` : "--config=/dev/null");
    expect((await cli(["--version"], { cwd: dir })).code).toBe(0);
    expect((await cli(["--launch", "claude-code", "--model", "sonnet", "--dry-run", "--", "x"], { cwd: dir })).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // Bun itself does run it without the flag: the check above means something.
    Bun.spawnSync([process.execPath, "--no-env-file", "-e", "1"], { cwd: dir });
    expect(existsSync(marker)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("BUG-64/9.3: a read-only config: a warning, the normal output and exit code, no stack trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-ro-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, "notices: { claude: 2026-01-01 }\nconnections: { claude-code: { auth: subscription } }\n");
    chmodSync(path, 0o444);
    const r = await cli(["doctor"], { env: { GLUON_CONFIG: path } });
    expect(r.stderr).not.toContain("    at ");
    expect(r.stderr).toContain(`couldn't save to ${path}: permission denied`);
    expect(r.stdout).toContain("✓ 1. Sonnet 5.5 on your Claude plan (personal)   ← in use");
    expect(r.code).toBe(0);
    // A first-pass config that can't be migrated on disk is migrated in memory.
    const old = join(dir, "old.yaml");
    writeFileSync(old, "brain: { provider: subscription, subscriptionNotice: 2026-01-01 }\nauth: { claude-code: subscription }\n");
    chmodSync(old, 0o444);
    const b = await cli(["brain"], { env: { GLUON_CONFIG: old } });
    expect(b.stderr).not.toContain("    at ");
    expect(b.stdout).toContain("✓ 1. Sonnet 5.5 on your Claude plan (personal)   ← in use");
    expect(b.code).toBe(0);
    chmodSync(path, 0o644);
    chmodSync(old, 0o644);
    rmSync(dir, { recursive: true, force: true });
  });

  test("BUG-72/2.12: a subcommand with extra words is an error, not a task", async () => {
    for (const args of [["doctor", "now"], ["connect", "claude-code", "extra"], ["setup", "again"], ["brain", "please"]]) {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`^gluon: ${args[0]} takes (no arguments|one agent)`));
    }
  });

  test("BUG-60/7.4: --launch refuses a model the harness has no such model of, or the connection can't serve @full", async () => {
    const cases: [string, string[], string][] = [
      ["connections: { claude-code: { auth: subscription } }\n", ["claude-code", "--model", "opus-4.6"], 'Claude Code has no model "opus-4.6" (models: haiku, sonnet, opus, fable)'],
      ["connections: { codex: { auth: api, provider: openai } }\n", ["codex", "--model", "gpt-oss-120b"], 'Codex has no model "gpt-oss-120b" (models: gpt-6-luna, gpt-6.1-sol, gpt-6-astra)'],
      // Muse Spark 1.3 is on OpenRouter, not on the OpenCode Go plan.
      ["connections: { opencode: { providers: [opencode-go] } }\n", ["opencode", "--model", "muse-spark-1.3"], "muse-spark-1.3 isn't available on OpenCode's OpenCode Go plan (models: deepseek-flash, muse-spark-1.3-contributor)"],
    ];
    for (const [yaml, args, message] of cases) {
      const r = await dry(yaml, args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(message);
    }
    // What the connection serves still launches: the plan needs no key.
    expect((await dry("connections: { opencode: { providers: [opencode-go] } }\n", ["opencode", "--model", "deepseek-flash"])).code).toBe(0);
    expect((await dry("connections: { opencode: { providers: [openrouter] } }\n", ["opencode", "--model", "muse-spark-1.3"], { OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef0123" })).code).toBe(0);
  });

  test("BUG-55/7.1: --dry-run never prints a key, whatever its shape, for every provider (the OpenCode plan has none)", async () => {
    const keys: Record<string, string> = {
      XAI_API_KEY: "xai-EEEEEEEEEEEEEEEEEEEE",
      OPENROUTER_API_KEY: "sk-or-v1-CCCCCCCCCCCCCCCCCCCC",
      OPENCODE_API_KEY: "ocKEYKKKKKKKKKKKKKKKKKK",
    };
    for (const p of ["openrouter", "opencode-go"]) {
      const r = await dry(`connections: { opencode: { providers: [${p}] } }\n`, ["opencode", "--model", "deepseek-flash"], keys);
      expect([p, r.code]).toEqual([p, 0]);
      const { OPENCODE_CONFIG_CONTENT: config, ...env } = JSON.parse(r.stdout).env as Record<string, string>;
      expect(JSON.parse(config!)).toEqual({ model: expect.any(String) });
      // The plan hands OpenCode no key at all, not even the user's own OPENCODE_API_KEY from this environment (it is the user's, not Gluon's to pass).
      expect([p, Object.keys(env)]).toEqual([p, p === "opencode-go" ? [] : ["OPENROUTER_API_KEY"]]);
      for (const [k, v] of Object.entries(env)) expect([p, k, v]).not.toEqual([p, k, keys[k]]);
      for (const key of Object.values(keys)) expect(r.stdout).not.toContain(key);
    }
  });

  test("BUG-51/2.3: an API-key connection forces the key over the harness's own subscription login", async () => {
    const codex = await dry("connections: { codex: { auth: api, provider: openai } }\n", ["codex", "--model", "gpt-6.1-sol"], { OPENAI_API_KEY: "sk-proj-0123456789abcdef0123" });
    const c = JSON.parse(codex.stdout);
    expect(c.argv).toEqual([
      "codex", "-m", "gpt-6.1-sol",
      "-c", 'model_providers.openai-api-key={name="OpenAI API key",base_url="https://api.openai.com/v1",env_key="OPENAI_API_KEY",wire_api="responses"}',
      "-c", 'model_provider="openai-api-key"', "--", "- a spec",
    ]);
    expect(c.env).toEqual({ OPENAI_API_KEY: "sk-proj-••••" });
    const plan = JSON.parse((await dry("connections: { codex: { auth: subscription } }\n", ["codex", "--model", "gpt-6.1-sol"])).stdout);
    expect(plan.argv.join(" ")).not.toContain("model_provider");
    const grok = JSON.parse((await dry("connections: { grok-build: { auth: api, provider: xai } }\n", ["grok-build", "--model", "grok-4.7"], { XAI_API_KEY: "xai-0123456789abcdef0123" })).stdout);
    expect(grok.env).toEqual({ XAI_API_KEY: "xai-••••", GROK_AUTH_PATH: expect.stringMatching(/grok-key-launch[\\/]no-login\.json$/) });
    const grokPlan = JSON.parse((await dry("connections: { grok-build: { auth: subscription } }\n", ["grok-build", "--model", "grok-4.7"])).stdout);
    expect(grokPlan.env).toEqual({});
  });
});

describe("subcommands inside a launched agent, and uninstall (issue #13)", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "gluon-g-"));
  const events = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".event")).map((n) => readFileSync(join(dir, n), "utf8"));
  const channel = (dir: string, pieces = "clear,compact") => ({ GLUON_EVENTS: dir, GLUON_HANDOFF: pieces });

  test("G16: signal outside a launch does nothing: exit 0, no output", async () => {
    for (const args of [["signal", "clear"], ["signal"], ["signal", "back", "x"]]) {
      const r = await cli(args);
      expect([args, r.code, r.stdout, r.stderr]).toEqual([args, 0, "", ""]);
    }
  });

  test("BUG-141/v1 fixes: an unquoted session starting with signal or hook, typed in a terminal, says how to quote it", async () => {
    for (const args of [["signal", "is", "flaky"], ["hook", "up", "the", "logger"]]) {
      const app = new App({ cwd: repo.tiny(), args, noDemo: true, cols: 200 });
      expect(await app.exitCode()).toBe(2);
      expect(app.history()).toContain(`To give it as a session, quote it: gluon "${args.join(" ")}"`);
    }
    // Inside an agent (no terminal) the same words stay silent.
    for (const args of [["signal", "is", "flaky"], ["hook", "up", "the", "logger"]]) {
      const r = await cli(args, { env: { GLUON_EVENTS: join(tmpdir(), "gluon-g-none") } });
      expect([args, r.code, r.stdout, r.stderr]).toEqual([args, 0, "", ""]);
    }
  });

  test("G17: signal writes `back` and nothing else (v1's clear and session-start, a compact without its hook, bad words); a missing dir is never created", async () => {
    const dir = scratch();
    const ok = await cli(["signal", "back"], { env: channel(dir) });
    expect([ok.code, ok.stdout, ok.stderr]).toEqual([0, "", ""]);
    expect(events(dir)).toEqual(["back"]);
    expect(readEvents(dir, new Set())).toEqual([{ name: "back" }]);
    const bad = [["signal", "clear"], ["signal", "session-start", "ab-12"], ["signal", "compact", "ab-12"], ["signal", "back", "ab-12"], ["signal", "rm"], ["signal", "back", "a/b"], ["signal", "back back"], ["signal", ""], ["signal"]];
    for (const args of bad) {
      const r = await cli(args, { env: channel(dir) });
      expect([args, r.code, r.stdout]).toEqual([args, 0, ""]);
    }
    expect(events(dir)).toHaveLength(1);
    const missing = join(dir, "gone");
    const r = await cli(["signal", "back"], { env: channel(missing) });
    expect(r.code).toBe(0);
    expect(existsSync(missing)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("G18: `back` doesn't depend on GLUON_HANDOFF (the user asked)", async () => {
    const dir = scratch();
    await cli(["signal", "back"], { env: channel(dir, "") });
    expect(events(dir)).toEqual(["back"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("G19: `gluon mcp` is no subcommand any more: it's handled like any other first word, and nothing speaks MCP", async () => {
    const dir = scratch();
    const r = await cli(["mcp"], { cwd: repo.tiny(), env: channel(dir) });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("jsonrpc");
    expect(r.stderr).toContain("needs an interactive terminal");
    expect(events(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("G20: hook: a waiting PreCompact hook asks through the events dir and answers the harness (Claude: block on yes)", async () => {
    const dir = scratch();
    const proc = tracked(Bun.spawn([...GLUON, "hook", "claude-code", "pre-compact"], { cwd: repo.tiny(), env: baseEnv(undefined, channel(dir)), stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
    proc.stdin.write('{"hook_event_name":"PreCompact","trigger":"auto"}');
    await proc.stdin.end();
    let asked: { name: string; id?: string }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 400 && !asked.length; i++) {
      asked = readEvents(dir, seen);
      await Bun.sleep(25);
    }
    expect(asked).toEqual([{ name: "compact", id: expect.any(String) }]);
    writeFileSync(join(dir, `${asked[0]!.id}.answer`), "yes");
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect([code, JSON.parse(out)]).toEqual([0, { decision: "block", reason: "Gluon ends this session instead of compacting." }]);
    rmSync(dir, { recursive: true, force: true });
  });

  /** A home, config home and temp dir of the test's own: uninstall sweeps the temp dir. */
  function sandbox() {
    const root = scratch();
    const dirs = { home: join(root, "home"), xdg: join(root, "xdg"), tmp: join(root, "tmp") };
    for (const d of Object.values(dirs)) mkdirSync(d);
    const env = { HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.home, LOCALAPPDATA: dirs.home, XDG_CONFIG_HOME: dirs.xdg, TMPDIR: dirs.tmp, TEMP: dirs.tmp, TMP: dirs.tmp, GLUON_CONFIG: undefined,
      // On Windows the sandbox is also the state directory (LOCALAPPDATA): not seeded with price tables on every call, which a second uninstall would find and remove.
      GLUON_TEST_EMPTY_TABLES: "1" };
    return { root, ...dirs, env };
  }

  test("G21: uninstall --yes removes the config, keys, grok-key-launch and stale temp dirs, then the empty default config dir; a live launch's dir stays", async () => {
    const s = sandbox();
    const cfg = join(s.xdg, "gluon");
    mkdirSync(join(cfg, "grok-key-launch"), { recursive: true });
    writeFileSync(join(cfg, "config.yaml"), "agents: {}\n");
    writeFileSync(join(cfg, ".env"), "OPENAI_API_KEY=sk-test\n");
    for (const d of ["gluon-events-live", "gluon-events-dead", "gluon-spec-a", "gluon-adapter-b", "gluon-cwd-c", "someone-else"]) mkdirSync(join(s.tmp, d));
    writeFileSync(join(s.tmp, "gluon-events-live", "pid"), String(process.pid));
    writeFileSync(join(s.tmp, "gluon-events-dead", "pid"), "2147483646");
    const r = await cli(["uninstall", "--yes"], { env: s.env });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(cfg)).toBe(false);
    expect(readdirSync(s.tmp).sort()).toEqual(["gluon-events-live", "someone-else"]);
    for (const p of [join(cfg, "config.yaml"), join(cfg, ".env"), join(cfg, "grok-key-launch"), join(s.tmp, "gluon-spec-a"), cfg]) expect(r.stdout).toContain(`Removed ${p}\n`);
    expect(r.stdout).toContain("no binary to remove");
    rmSync(s.root, { recursive: true, force: true });
  });

  test("BUG-356/uninstall-ledger: uninstall --yes removes the audit ledger (every file and the directory); the state directory around it stays, and a symlink at its path is never followed", async () => {
    const s = sandbox();
    const state = join(s.root, "state");
    const ledger = join(state, "gluon", "cost-audit");
    mkdirSync(ledger, { recursive: true });
    writeFileSync(join(ledger, "20260101T000000-1.jsonl"), '{"kind":"dropped","t":1,"harness":"codex","what":"usage","reason":"x","count":1}\n');
    writeFileSync(join(state, "someone-elses.txt"), "keep");
    const env = { ...s.env, XDG_STATE_HOME: state, LOCALAPPDATA: state };
    const r = await cli(["uninstall", "--yes"], { env });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toContain(`Removed ${ledger}\n`);
    expect(existsSync(ledger)).toBe(false);
    expect(readFileSync(join(state, "someone-elses.txt"), "utf8")).toBe("keep");
    if (!WIN) {
      const target = join(s.root, "not-gluons");
      mkdirSync(target);
      writeFileSync(join(target, "keep.txt"), "keep");
      symlinkSync(target, ledger);
      const again = await cli(["uninstall", "--yes"], { env });
      expect([again.code, again.stderr]).toEqual([0, ""]);
      expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
    }
  });

  test("BUG-364/pricing-update: uninstall --yes removes the price-table overlay `gluon pricing update` kept, in the state directory", async () => {
    const s = sandbox();
    const state = join(s.root, "state");
    const tables = join(state, "gluon", "tables");
    mkdirSync(tables, { recursive: true });
    writeFileSync(join(tables, "claude-catalog.json"), "{}");
    const r = await cli(["uninstall", "--yes"], { env: { ...s.env, XDG_STATE_HOME: state } });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(tables)).toBe(false);
    expect(r.stdout).toContain(`Removed ${tables}\n`);
    rmSync(s.root, { recursive: true, force: true });
  });

  test("analytics: uninstall --yes removes the analytics database with its -wal and -shm, in the state directory, and leaves the rest of it", async () => {
    const s = sandbox();
    const state = join(s.root, "state");
    const gluon = join(state, "gluon");
    mkdirSync(gluon, { recursive: true });
    const files = ["analytics.db", "analytics.db-wal", "analytics.db-shm"].map((f) => join(gluon, f));
    for (const f of files) writeFileSync(f, "x");
    writeFileSync(join(gluon, "other.txt"), "mine");
    const r = await cli(["uninstall", "--yes"], { env: { ...s.env, XDG_STATE_HOME: state } });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    for (const f of files) {
      expect(existsSync(f)).toBe(false);
      expect(r.stdout).toContain(`Removed ${f}\n`);
    }
    expect(existsSync(join(gluon, "other.txt"))).toBe(true);
    rmSync(s.root, { recursive: true, force: true });
  });

  test("BUG-289/resume: uninstall --yes removes the saved sessions (workspaces/) and a failed save's leftovers, and the config dir with them; with GLUON_CONFIG only that directory", async () => {
    const s = sandbox();
    const cfg = join(s.xdg, "gluon");
    mkdirSync(join(cfg, "workspaces", ".gluon-abc123"), { recursive: true });
    writeFileSync(join(cfg, "config.yaml"), "agents: {}\n");
    writeFileSync(join(cfg, "workspaces", "abcdef.json"), "{}");
    writeFileSync(join(cfg, "workspaces", ".gluon-abc123", "abcdef.json"), "{}");
    const r = await cli(["uninstall", "--yes"], { env: s.env });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toContain(`Removed ${join(cfg, "workspaces")}\n`);
    expect(existsSync(cfg)).toBe(false);
    // Beside a config of the user's own: the saved sessions go, the rest stays.
    const mine = join(s.root, "dotfiles");
    mkdirSync(join(mine, "workspaces"), { recursive: true });
    writeFileSync(join(mine, "gluon.yaml"), "agents: {}\n");
    writeFileSync(join(mine, "notes.txt"), "keep me\n");
    writeFileSync(join(mine, "workspaces", "abcdef.json"), "{}");
    const own = await cli(["uninstall", "--yes"], { env: { ...s.env, GLUON_CONFIG: join(mine, "gluon.yaml") } });
    expect(own.code).toBe(0);
    expect(readdirSync(mine)).toEqual(["notes.txt"]);
    rmSync(s.root, { recursive: true, force: true });
  });

  test("BUG-293/resume: uninstall --yes with GLUON_CONFIG beside a directory of the user's own named workspaces removes only Gluon's session files from it", async () => {
    const s = sandbox();
    const mine = join(s.root, "dotfiles");
    mkdirSync(join(mine, "workspaces", "project"), { recursive: true });
    mkdirSync(join(mine, "workspaces", ".gluon-abc123"), { recursive: true });
    writeFileSync(join(mine, "gluon.yaml"), "agents: {}\n");
    writeFileSync(join(mine, "workspaces", "abcdef.json"), "{}");
    writeFileSync(join(mine, "workspaces", ".gluon-abc123", "abcdef.json"), "{}");
    writeFileSync(join(mine, "workspaces", "project", "code.ts"), "keep me\n");
    writeFileSync(join(mine, "workspaces", "notes.json"), "keep me\n");
    writeFileSync(join(mine, "workspaces", "abcdef.json.bak"), "keep me\n");
    const r = await cli(["uninstall", "--yes"], { env: { ...s.env, GLUON_CONFIG: join(mine, "gluon.yaml") } });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(readdirSync(join(mine, "workspaces")).sort()).toEqual(["abcdef.json.bak", "notes.json", "project"]);
    expect(readFileSync(join(mine, "workspaces", "project", "code.ts"), "utf8")).toBe("keep me\n");
    expect(r.stdout).not.toContain(`Removed ${join(mine, "workspaces")}\n`);
    rmSync(s.root, { recursive: true, force: true });
  });

  test("BUG-143/v1 fixes: uninstall keeps a running Gluon's spec and neutral-cwd dirs (their pid file)", async () => {
    const s = sandbox();
    for (const d of ["gluon-spec-live", "gluon-cwd-live", "gluon-spec-dead", "gluon-cwd-dead"]) {
      mkdirSync(join(s.tmp, d));
      writeFileSync(join(s.tmp, d, "pid"), d.endsWith("live") ? String(process.pid) : "2147483646");
    }
    const r = await cli(["uninstall", "--yes"], { env: s.env });
    expect(r.code).toBe(0);
    expect(readdirSync(s.tmp).filter((n) => n.startsWith("gluon-")).sort()).toEqual(["gluon-cwd-live", "gluon-spec-live"]);
    rmSync(s.root, { recursive: true, force: true });
  });

  test("BUG-456/routing: uninstall --yes removes routing.yaml with the config, also beside a GLUON_CONFIG, and never anything else in that directory", async () => {
    const s = sandbox();
    const cfg = join(s.xdg, "gluon");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "config.yaml"), "agents: {}\n");
    writeFileSync(join(cfg, "routing.yaml"), "rank: {}\n");
    const r = await cli(["uninstall", "--yes"], { env: s.env });
    expect([r.code, existsSync(cfg)]).toEqual([0, false]);
    expect(r.stdout).toContain(`Removed ${join(cfg, "routing.yaml")}\n`);
    const mine = join(s.root, "dotfiles");
    mkdirSync(mine);
    writeFileSync(join(mine, "gluon.yaml"), "agents: {}\n");
    writeFileSync(join(mine, "routing.yaml"), "rank: {}\n");
    writeFileSync(join(mine, "notes.txt"), "keep me\n");
    const own = await cli(["uninstall", "--yes"], { env: { ...s.env, GLUON_CONFIG: join(mine, "gluon.yaml") } });
    expect(own.code).toBe(0);
    expect(readdirSync(mine)).toEqual(["notes.txt"]);
    rmSync(s.root, { recursive: true, force: true });
  });

  test("G22: uninstall with GLUON_CONFIG removes only Gluon's files there, never the directory or anything else in it", async () => {
    const s = sandbox();
    const mine = join(s.root, "dotfiles");
    mkdirSync(mine);
    writeFileSync(join(mine, "gluon.yaml"), "agents: {}\n");
    writeFileSync(join(mine, "notes.txt"), "keep me\n");
    const env = { ...s.env, GLUON_CONFIG: join(mine, "gluon.yaml") };
    const r = await cli(["uninstall", "--yes"], { env });
    expect(r.code).toBe(0);
    expect(readdirSync(mine)).toEqual(["notes.txt"]);
    // Nothing left to remove: still a success.
    const again = await cli(["uninstall", "--yes"], { env });
    expect([again.code, existsSync(mine)]).toEqual([0, true]);
    expect(again.stdout).toContain("Nothing to remove.");
    rmSync(s.root, { recursive: true, force: true });
  });

  test("BUG-156/v1 fixes: uninstall with GLUON_CONFIG in the user's directory keeps their .env, minus Gluon's keys, and their own .gluon-* dirs", async () => {
    const s = sandbox();
    const mine = join(s.root, "project");
    mkdirSync(mine);
    writeFileSync(join(mine, "gluon.yaml"), "agents: {}\n");
    writeFileSync(join(mine, ".env"), "# mine\nDATABASE_URL=postgres://x\nOPENAI_API_KEY=sk-test\nexport XAI_API_KEY=xai-test\n");
    for (const d of [".gluon-aB3xY9", ".gluon-notes", ".gluon-zz1234"]) mkdirSync(join(mine, d));
    writeFileSync(join(mine, ".gluon-aB3xY9", ".env"), "OPENAI_API_KEY=sk-left\n");
    writeFileSync(join(mine, ".gluon-zz1234", "todo.txt"), "mine\n");
    const env = { ...s.env, GLUON_CONFIG: join(mine, "gluon.yaml") };
    const r = await cli(["uninstall", "--yes"], { env });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(mine, ".env"), "utf8")).toBe("# mine\nDATABASE_URL=postgres://x\n");
    expect(r.stdout).toContain(`Removed Gluon's keys from ${join(mine, ".env")}\n`);
    expect(readdirSync(mine).sort()).toEqual([".env", ".gluon-notes", ".gluon-zz1234"]);
    // A .env with none of Gluon's keys isn't touched or listed.
    const again = await cli(["uninstall", "--yes"], { env });
    expect(again.stdout).toContain("Nothing to remove.");
    expect(readFileSync(join(mine, ".env"), "utf8")).toBe("# mine\nDATABASE_URL=postgres://x\n");
    rmSync(s.root, { recursive: true, force: true });
  });

  test("G23: uninstall without a terminal asks for --yes and removes nothing; it's in --help and takes no other words", async () => {
    const s = sandbox();
    const cfg = join(s.xdg, "gluon", "config.yaml");
    mkdirSync(dirname(cfg));
    writeFileSync(cfg, "agents: {}\n");
    const r = await cli(["uninstall"], { env: s.env });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("gluon uninstall --yes");
    expect((await cli(["uninstall", "now"], { env: s.env })).code).toBe(2);
    expect((await cli(["--yes"], { env: s.env })).code).toBe(2);
    expect(existsSync(cfg)).toBe(true);
    expect((await cli(["--help"])).stdout).toContain("gluon uninstall [--yes]");
    rmSync(s.root, { recursive: true, force: true });
  });

  test("G24: uninstall in a terminal lists what it removes and asks; no keeps everything, yes removes it", async () => {
    const s = sandbox();
    const cfg = join(s.xdg, "gluon", "config.yaml");
    mkdirSync(dirname(cfg));
    writeFileSync(cfg, "agents: {}\n");
    const run = async (answer: string) => {
      const app = new App({ cwd: repo.tiny(), args: ["uninstall"], noDemo: true, env: s.env, cols: 400 });
      await app.waitFor("[y/N]");
      expect(app.screen()).toContain(cfg);
      app.write(`${answer}\r`);
      return { code: await app.exitCode(), screen: app.history() };
    };
    const no = await run("n");
    expect([no.code, existsSync(cfg)]).toEqual([0, true]);
    expect(no.screen).toContain("Nothing removed.");
    const yes = await run("y");
    expect([yes.code, existsSync(cfg)]).toEqual([0, false]);
    expect(yes.screen).toContain(`Removed ${cfg}`);
    rmSync(s.root, { recursive: true, force: true });
  });
});

describe("gluon stats (local analytics)", () => {
  async function seeded() {
    const [{ Database }, { MIGRATIONS }] = await Promise.all([import("bun:sqlite"), import("../../src/analytics.ts")]);
    const state = mkdtempSync(join(tmpdir(), "gluon-stats-e2e-"));
    mkdirSync(join(state, "gluon"));
    const path = join(state, "gluon", "analytics.db");
    const db = new Database(path, { create: true });
    for (const m of MIGRATIONS) db.exec(m);
    db.run(`PRAGMA user_version=${MIGRATIONS.length}`);
    const insert = db.prepare("INSERT INTO sessions (id, kind, name, repo, harness, model, spec, started_at, ended_at, duration_ms, cost_usd, updated_at) VALUES (?, 'new', ?, 'proj', ?, ?, ?, ?, ?, ?, ?, ?)");
    const t = Date.now() - 3_600_000;
    insert.run("aaaaaaaa-1111-4000-8000-000000000001", "fix the bug", "claude-code", "sonnet", "fix it\nand test", t, t + 60_000, 60_000, 1.5, t + 60_000);
    insert.run("bbbbbbbb-2222-4000-8000-000000000002", "add a feature", "codex", "gpt-6-luna", "build it", t + 1000, t + 121_000, 120_000, 0.25, t + 121_000);
    db.close();
    return { state, path, env: { XDG_STATE_HOME: state } };
  }

  test("stats: a summary per agent; sessions --json; one session by id prefix; sql; --delete needs --yes without a terminal and then wipes @full", async () => {
    const s = await seeded();
    try {
      const sum = await cli(["stats"], { env: s.env });
      expect([sum.code, sum.stderr]).toEqual([0, ""]);
      expect(sum.stdout).toMatch(/claude-code\s+1\s+1m00s\s+\$1\.50/);
      expect(sum.stdout).toMatch(/total\s+2\s+3m00s\s+\$1\.75/);
      const list = await cli(["stats", "sessions", "--json"], { env: s.env });
      const rows = JSON.parse(list.stdout);
      expect(rows.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([["add a feature", "ended"], ["fix the bug", "ended"]]);
      const one = await cli(["stats", "aaaa"], { env: s.env });
      expect(one.code).toBe(0);
      expect(one.stdout).toContain("spec:\n    fix it\n    and test");
      const sql = await cli(["stats", "sql", "SELECT count(*) AS n FROM sessions"], { env: s.env });
      expect(sql.stdout.trimEnd().split("\n")).toEqual(["n", "2", "(1 row)"]);
      expect((await cli(["stats", "sql", "DELETE FROM sessions"], { env: s.env })).code).toBe(2);
      const refused = await cli(["stats", "--delete"], { env: s.env });
      expect([refused.code, refused.stderr]).toEqual([2, expect.stringContaining("gluon stats --delete --yes")]);
      const gone = await cli(["stats", "--delete", "--yes"], { env: s.env });
      expect([gone.code, gone.stdout.trim()]).toEqual([0, "Deleted 2 recorded sessions."]);
      expect(existsSync(s.path)).toBe(true);
      expect((await cli(["stats", "sql", "SELECT count(*) AS n FROM sessions", "--json"], { env: s.env })).stdout).toContain('"n": 0');
    } finally {
      rmSync(s.state, { recursive: true, force: true });
    }
  });

  test("stats --delete while a Gluon holds the database open (its -wal and -shm there, Windows locks included): wipes it, never removes the file, and the recorder goes on", async () => {
    const { Analytics } = await import("../../src/analytics.ts");
    const s = await seeded();
    // Gluon's recorder in this process, the CLI in another: two connections on one file.
    const a = new Analytics({ enabled: true, path: s.path });
    try {
      const run = a.begin({ kind: "new", name: "live", harness: "claude-code", model: "sonnet", spec: "keep going" });
      run?.set({ contextPct: 5 });
      expect(existsSync(`${s.path}-wal`)).toBe(true);
      const gone = await cli(["stats", "--delete", "--yes"], { env: s.env });
      expect([gone.code, gone.stderr, gone.stdout.trim()]).toEqual([0, "", "Deleted 3 recorded sessions."]);
      expect(existsSync(s.path)).toBe(true);
      // The open session stays wiped (BUG-565), and a session that begins after is recorded.
      run?.set({ contextPct: 9 });
      a.begin({ kind: "new", name: "after", harness: "codex", model: "gpt-6-luna", spec: "later" })?.end({ code: 0, reason: "exit" });
      a.tick();
      const list = await cli(["stats", "sessions", "--json"], { env: s.env });
      expect(JSON.parse(list.stdout).map((r: { name: string }) => r.name)).toEqual(["after"]);
    } finally {
      a.close();
      rmSync(s.state, { recursive: true, force: true });
    }
  });

  test("stats: no database says so (exit 0) and creates nothing; a bad flag exits 2; it is in --help and needs no config", async () => {
    const state = mkdtempSync(join(tmpdir(), "gluon-stats-e2e-"));
    try {
      const none = await cli(["stats"], { env: { XDG_STATE_HOME: state } });
      expect([none.code, none.stdout.trim(), none.stderr]).toEqual([0, "No analytics recorded yet.", ""]);
      expect(readdirSync(join(state, "gluon")).filter((f) => f.startsWith("analytics"))).toEqual([]);
      const bad = await cli(["stats", "--by", "week"], { env: { XDG_STATE_HOME: state } });
      expect([bad.code, bad.stderr]).toEqual([2, expect.stringContaining("gluon: --by takes one of: agent, model, day, repo")]);
      expect((await cli(["stats", "--help"], { env: { XDG_STATE_HOME: state } })).stdout).toContain("gluon stats sql");
      expect((await cli(["--help"])).stdout).toContain("gluon stats");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});

// QA pass B5 (CLI flag matrix). A `test.failing` below is a confirmed defect: it passes while the bug exists and fails once fixed (then drop `.failing`).
describe("QA B5: the flag matrix", () => {
  /** A launch of a fake claude that records its argv when it is run: `ran` says whether it was started; `argv` is the dry run's, when it printed one. */
  const launched = async (args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-cli-flags-"));
    try {
      const log = join(dir, "argv.log");
      const r = await cli(["--launch", "claude-code", "--model", "sonnet", ...args], { env: { FAKE_ARGV_LOG: log }, agents: ["claude"] });
      return { ...r, ran: existsSync(log), spec: existsSync(log) ? readFileSync(log, "utf8") : "", argv: r.code === 0 && !existsSync(log) ? (JSON.parse(r.stdout).argv as string[]) : [] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("BUG-599/QA-cli-02: a flag after a prompt that starts with `- ` is a flag, not part of the spec: `--dry-run` there never starts the agent", async () => {
    const r = await launched(["- fix the bug", "--dry-run"]);
    expect([r.code, r.ran]).toEqual([0, false]);
    expect(r.argv).toEqual(["claude", "--model", "sonnet", "--", "- fix the bug"]);
  });

  test("BUG-599/variants: flags before, after and around a `- ` prompt; a spec that looks like a flag; an explicit `--`; an unknown later flag still errors @full", async () => {
    // Flags on both sides of the prompt, and --mode after it.
    const around = await launched(["--dry-run", "- fix the bug", "--mode", "explore"]);
    expect([around.code, around.ran]).toEqual([0, false]);
    expect(around.argv.slice(-2)).toEqual(["--", "- fix the bug"]);
    expect(around.argv).toContain("dontAsk");
    // A word that starts with `--` but has spaces is the prompt; the flag after it is still a flag.
    const help = await launched(["--help me", "--dry-run"]);
    expect([help.code, help.ran, help.argv.slice(-2)]).toEqual([0, false, ["--", "--help me"]]);
    // More prompt words after the bullet join the spec; a flag between prompt words is a flag.
    const words = await launched(["- fix", "--dry-run", "the bug"]);
    expect([words.code, words.ran, words.argv.slice(-1)]).toEqual([0, false, ["- fix the bug"]]);
    // An explicit `--` ends the options, as ever: what follows is spec, `--dry-run` included (so this one starts the fake agent).
    const explicit = await launched(["--", "- fix", "--dry-run"]);
    expect([explicit.ran, explicit.spec]).toEqual([true, expect.stringContaining("ARG4=<- fix --dry-run>")]);
    // Options before an explicit `--` still count.
    const before = await launched(["--dry-run", "--", "- fix"]);
    expect([before.code, before.ran, before.argv.slice(-2)]).toEqual([0, false, ["--", "- fix"]]);
    // An unknown flag after the prompt is an error as usual, and nothing starts.
    const unknown = await launched(["- fix the bug", "--dry-runn"]);
    expect([unknown.code, unknown.ran, unknown.stderr]).toEqual([2, false, expect.stringContaining("Unknown option '--dry-runn'")]);
    // A bare `-x` has no space: it is a flag (unknown), not a prompt.
    const x = await launched(["-x"]);
    expect([x.code, x.ran, x.stderr]).toEqual([2, false, expect.stringContaining("Unknown option '-x'")]);
  });

  test("BUG-600/QA-cli-03: --model, --effort and --dry-run without --launch are refused like --mode is (\"goes with --launch\"), not silently ignored @full", async () => {
    const seen: string[] = [];
    for (const flag of [["--model", "sonnet"], ["--effort", "high"], ["--dry-run"], ["--mode", "explore"]]) {
      // A subcommand that reads files only, one that needs a config, an installer and a bare prompt.
      for (const rest of [["routing", "path"], ["sessions"], ["install"], ["fix it"]]) {
        const r = await cli([...rest, ...flag]);
        seen.push(`${rest[0]} ${flag[0]}: ${r.code} ${r.stderr.includes(`${flag[0]} goes with --launch`) ? "refused" : `ignored (${r.stderr.trim().slice(0, 60)})`}`);
      }
    }
    expect(seen.filter((s) => !s.endsWith(": 2 refused"))).toEqual([]);
    // With --launch they are taken, as ever; `--help` still wins over them.
    expect((await cli(["--help", "--model", "sonnet"])).code).toBe(0);
    expect((await launched(["--effort", "high", "--dry-run", "x"])).code).toBe(0);
  });

  test("BUG-601/QA-cli-04: an empty `--launch=` is an error that names --launch, not a silent fall-through to the chat's \"needs an interactive terminal\"", async () => {
    for (const args of [["--launch=", "--model", "sonnet", "fix it"], ["--launch", "", "--model", "sonnet", "fix it"], ["--launch", "", "fix it"]]) {
      const r = await cli(args);
      expect([args.join(" "), r.code, r.stderr]).toEqual([args.join(" "), 2, expect.stringContaining("--launch needs an agent")]);
      expect(r.stderr).not.toContain("needs an interactive terminal");
    }
  });

  test("BUG-601/variants: an empty --effort (with or without --launch) and an empty --model name their flag", async () => {
    const effort = await launched(["--effort", "", "--dry-run", "x"]);
    expect([effort.code, effort.ran, effort.stderr]).toEqual([2, false, expect.stringContaining("--effort needs a value")]);
    const effort2 = await cli(["--effort=", "fix it"]);
    expect([effort2.code, effort2.stderr]).toEqual([2, expect.stringContaining("--effort needs a value")]);
    const model = await cli(["--launch", "claude-code", "--model", "", "--dry-run", "x"], { agents: ["claude"] });
    expect([model.code, model.stderr]).toEqual([2, expect.stringContaining("--model is required")]);
    const loose = await cli(["--model=", "fix it"]);
    expect([loose.code, loose.stderr]).toEqual([2, expect.stringContaining("--model goes with --launch")]);
  });

  test("BUG-617/QA-cli-05: `--help` after cost-report or uninstall prints the usage (it is refused as \"takes no arguments\" / \"quote it as a session\")", async () => {
    const results: string[] = [];
    for (const sub of ["cost-report", "uninstall"]) {
      const r = await cli([sub, "--help"]);
      results.push(`${sub}: ${r.code} ${r.stdout.includes(`gluon ${sub}`) ? "usage" : "no usage"}`);
    }
    expect(results).toEqual(["cost-report: 0 usage", "uninstall: 0 usage"]);
  });

  test("BUG-618/QA-cli-06: a mistyped `stats`, `pricing` or `cost-report` gets a \"did you mean\" like the other subcommands (SUBCOMMANDS lacks them), not a chat with the typo as its first message @full", async () => {
    const hints: string[] = [];
    for (const word of ["stat", "pricin", "cost-reprot"]) hints.push(`${word}: ${(await cli([word])).stderr.includes("did you mean") ? "hint" : "no hint"}`);
    expect(hints).toEqual(["stat: hint", "pricin: hint", "cost-reprot: hint"]);
  });

  test("BUG-617/variants: -h works after cost-report and uninstall, with a broken config and without it removing anything", async () => {
    for (const sub of ["cost-report", "uninstall"]) {
      const r = await cli([sub, "-h"], { env: { GLUON_CONFIG: config("qa-cli-05-broken", "connections: [\n") } });
      expect([sub, r.code, r.stdout.includes(`gluon ${sub}`)]).toEqual([sub, 0, true]);
    }
    expect((await cli(["uninstall", "--yes", "--help"])).stdout).toContain("gluon uninstall");
    expect((await cli(["uninstall", "--nope"])).stderr).toContain("uninstall takes only --yes");
  });

  test("BUG-618/variants: the hint names the command it is near", async () => {
    const r = await cli(["pricin"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('did you mean "gluon pricing"');
  });

  test("BUG-602/QA-cli-07: `--launch <harness>` without --model says --model is missing, not `has no model \"\"`", async () => {
    const r = await cli(["--launch", "claude-code", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--model is required with --launch (claude-code models: haiku, sonnet, opus, fable)");
    expect(r.stderr).not.toContain("has no model");
    // An unknown harness is still the first complaint; a wrong model is still validateChoice's.
    expect((await cli(["--launch", "pi", "x"])).stderr).toContain('unknown harness "pi"');
    expect((await cli(["--launch", "claude-code", "--model", "nope", "x"])).stderr).toContain('has no model "nope"');
  });
});

describe("QA B5: config and paths", () => {
  test("BUG-619/QA-onb-01: a config that has the first version's `auth:` key and a malformed `connections:` is \"bad config\" (exit 2), not a raw YAML library stack (exit 1)", async () => {
    const r = await cli(["--help"], { env: { GLUON_CONFIG: config("qa-onb-01", "auth: { claude-code: api }\nconnections: 5\n") } });
    expect(r.stderr).not.toContain("node_modules");
    expect(r.stderr).toContain("bad config");
    expect(r.code).toBe(2);
  });

  test("BUG-619/variants: a first-version `auth:` with an empty or valid `connections:` still migrates (no crash, no bad config)", async () => {
    const empty = await cli(["--help"], { env: { GLUON_CONFIG: config("qa-onb-01-null", "auth: { claude-code: api }\nconnections:\n") } });
    expect([empty.code, empty.stderr]).toEqual([0, ""]);
    const list = await cli(["--help"], { env: { GLUON_CONFIG: config("qa-onb-01-list", "auth: { claude-code: api }\nconnections: [a]\n") } });
    expect([list.code, list.stderr]).toEqual([2, expect.stringContaining("connections must be a mapping")]);
  });

  test("BUG-620/QA-onb-02: a relative XDG_CONFIG_HOME is ignored (the XDG spec says so): Gluon's config, saved keys and routing.yaml never land in the repository it runs in", async () => {
    const r = await cli(["routing", "path"], { cwd: repo.tiny(), env: { GLUON_CONFIG: "", XDG_CONFIG_HOME: "qa-relative-xdg" } });
    expect(r.code).toBe(0);
    expect(isAbsolute(r.stdout.trim())).toBe(true);
    expect(r.stdout).not.toContain("qa-relative-xdg");
  });

  test("BUG-621/QA-onb-03: a relative GLUON_CONFIG is made absolute at startup (BUG-291 does it only for `resume`): its `.env` of keys is not whatever `.env` the repository has", async () => {
    const r = await cli(["routing", "path"], { cwd: repo.tiny(), env: { GLUON_CONFIG: "config.yaml" } });
    expect(r.code).toBe(0);
    expect(isAbsolute(r.stdout.trim())).toBe(true);
  });

  test("BUG-622/QA-onb-04: a config path that can't be read (a directory) is reported as unreadable, not as \"is not valid YAML\"", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-qa-onb04-"));
    const r = await cli(["--help"], { env: { GLUON_CONFIG: dir } });
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain("not valid YAML");
    rmSync(dir, { recursive: true, force: true });
  });

  test("BUG-623/QA-onb-05: `uninstall` doesn't say it removed session files when the workspaces directory holds none of Gluon's (only the user's own file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-qa-onb05-"));
    const env = { GLUON_CONFIG: join(dir, "config.yaml"), XDG_STATE_HOME: join(dir, "state") };
    mkdirSync(join(dir, "workspaces"));
    writeFileSync(join(dir, "workspaces", "mine.txt"), "the user's own file\n");
    const r = await cli(["uninstall", "--yes"], { env });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "workspaces", "mine.txt"))).toBe(true); // never touched
    expect(r.stdout).not.toContain("Removed the session files");
    rmSync(dir, { recursive: true, force: true });
  });
});
