/** The brain order, the offered-models filter, model mapping, config migration and the runtime fallback. */
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Session, type ModelClient } from "../src/agent/session.ts";
import { clip, describeConverseError } from "../src/agent/bedrock-converse.ts";
import { activeStep, brainErrorHint, chooseBrain, modelName, modelUnavailable, notConnected, stepLabel } from "../src/brain.ts";
import { awsConfigRegion, awsSetup, DEFAULT_ORDER, defaults, loadConfig, migrate, setConfigNotices, type Config } from "../src/config.ts";
import { DEFAULT_MODELS, HARNESSES, PROVIDERS } from "../src/harnesses.ts";
import { buildCommand } from "../src/launchers.ts";
import { offeredAgents, reach, resolveModel } from "../src/models.ts";
import { loadSecrets } from "../src/secrets.ts";
import { probeConnection, recordProbes, type ConnectionProbe } from "../src/verify.ts";
import { parse } from "yaml";

const TMP = mkdtempSync(join(tmpdir(), "gluon-brain-"));
const saved = { ...process.env };
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AWS_PROFILE"];

beforeAll(() => {
  process.env.GLUON_CONFIG = join(TMP, "config.yaml");
  for (const k of KEYS) delete process.env[k];
  loadSecrets();
});
beforeEach(() => {
  rmSync(join(TMP, "config.yaml"), { force: true });
  for (const k of KEYS) delete process.env[k];
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(TMP, { recursive: true, force: true });
});

const probeFile = (answers: Record<string, true | string>) => {
  const path = join(TMP, `probes-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(answers));
  process.env.GLUON_TEST_PROBES = path;
};

describe("labels", () => {
  test("model names read well from every provider's id", () => {
    expect(modelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelName("us.anthropic.claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(modelName("anthropic/claude-sonnet-5.5")).toBe("Sonnet 5.5");
    expect(modelName("us.openai.gpt-6-sol")).toBe("GPT-6 Sol");
    expect(modelName("openai/gpt-6-sol")).toBe("GPT-6 Sol");
    expect(modelName("something-else")).toBe("something-else");
  });

  test("each route's label says where the brain runs", () => {
    const labels = defaults().brain.order.map(stepLabel);
    expect(labels).toEqual([
      "Sonnet 5.5 on your Claude plan (personal)",
      "GPT-6 Luna on your ChatGPT plan (personal)",
      "Sonnet 5.5 · Anthropic API",
      "GPT-6 Sol · OpenAI API",
      "Sonnet 5.5 on Bedrock",
      "GPT-6 Sol on Bedrock",
      "Sonnet 5.5 via OpenRouter",
      "GPT-6 Sol via OpenRouter",
      "Sonnet 4.6 on Bedrock",
      "Sonnet 4.6 via OpenRouter",
    ]);
  });

  test("a model-unavailable error is told apart from others", () => {
    expect(modelUnavailable("access denied to us.openai.gpt-6-sol in us-east-1")).toBe(true);
    expect(modelUnavailable("model not found or not available to this key (404)")).toBe(true);
    expect(modelUnavailable("There's an issue with the selected model (x). It may not exist or you may not have access to it.")).toBe(true);
    expect(modelUnavailable("the API key was rejected (401)")).toBe(false);
    expect(modelUnavailable("rate limited (429); try again shortly")).toBe(false);
  });
});

describe("the brain order", () => {
  const with_ = (patch: Partial<Config>): Config => ({ ...defaults(), ...patch });

  test("a plan step needs its harness connected on the plan (no notice); key steps need the key", () => {
    const order = defaults().brain.order;
    expect(notConnected(defaults(), order[0]!)).toContain("not connected");
    expect(notConnected(with_({ connections: { "claude-code": { auth: "subscription" } } }), order[0]!)).toBeNull();
    expect(notConnected(with_({ connections: { codex: { auth: "subscription" } } }), order[1]!)).toBeNull();
    expect(notConnected(with_({ connections: { codex: { auth: "api", provider: "openai" } } }), order[1]!)).toContain("not connected");
    expect(notConnected(defaults(), order[3]!)).toBe("not connected (OPENAI_API_KEY isn't set)");
    process.env.OPENAI_API_KEY = "sk-proj-test0123456789abcdef";
    expect(notConnected(defaults(), order[3]!)).toBeNull();
    expect(notConnected(defaults(), order[4]!)).toContain("no AWS setup");
    expect(notConnected(with_({ connections: { codex: { auth: "api", provider: "bedrock" } } }), order[4]!)).toBeNull();
  });

  test("the first connected step whose probe works becomes brain.active, saved to the config", async () => {
    process.env.OPENAI_API_KEY = "sk-proj-test0123456789abcdef";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test0123456789abcdef";
    probeFile({ "openai-api/gpt-6-sol": "model not found (404)" });
    const config = defaults();
    const seen: number[] = [];
    const { active, steps } = await chooseBrain(config, TMP, { onStep: (r) => seen.push(r.index) });
    expect(active).toBe(6);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(steps[3]!.result).toEqual({ ok: false, error: "model not found (404)" });
    expect(steps[7]!.result).toBeNull(); // not tried: step 7 works
    expect(loadConfig().brain.active).toBe(6);
    expect(activeStep(loadConfig())).toEqual({ route: "openrouter", model: "anthropic/claude-sonnet-5.5" });
  });

  test("`all` probes every connected step (doctor); nothing working clears brain.active", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test0123456789";
    probeFile({ "anthropic-api/*": "the API key was rejected (401)" });
    writeFileSync(process.env.GLUON_CONFIG!, "brain: { active: 2 }\n");
    const config = loadConfig();
    const { active, steps } = await chooseBrain(config, TMP, { all: true });
    expect(active).toBeNull();
    expect(steps[2]!.result).toEqual({ ok: false, error: "the API key was rejected (401)" });
    expect(readFileSync(process.env.GLUON_CONFIG!, "utf8")).not.toContain("active");
  });

  test("the active step is dropped once it is no longer connected", () => {
    const config = with_({ brain: { order: defaults().brain.order, active: 3 } });
    expect(activeStep(config)).toBeNull();
    process.env.OPENAI_API_KEY = "sk-proj-test0123456789abcdef";
    expect(activeStep(config)?.route).toBe("openai-api");
  });
});

describe("offered models", () => {
  const installed = () => true;
  const cfg = (patch: Partial<Config>): Config => ({ ...defaults(), ...patch });

  test("nothing connected: nothing offered (the demo offers every installed harness's main models)", () => {
    expect(offeredAgents(defaults(), { installed })).toEqual([]);
    const demo = offeredAgents(defaults(), { installed, demo: true });
    expect(demo.map((a) => a.harness)).toEqual(HARNESSES);
    expect(demo[0]!.models.map((m) => m.id)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(offeredAgents(defaults(), { installed: (h) => h === "codex", demo: true }).map((a) => a.harness)).toEqual(["codex"]);
  });

  test("a connection never probed offers its configured models; once probed, one that failed is hidden", () => {
    const connections: Config["connections"] = { "claude-code": { auth: "subscription" } };
    expect(offeredAgents(cfg({ connections }), { installed })[0]!.models.map((m) => m.id)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    const probed = cfg({ connections, checked: { "claude-code/plan": "2026-09-29" }, verified: { "claude-code/plan/sonnet": "2026-09-29", "claude-code/plan/haiku": "2026-09-29" }, unreached: { "claude-code/plan/opus": "2026-09-29", "claude-code/plan/fable": "2026-09-29" } });
    expect(offeredAgents(probed, { installed })[0]!.models.map((m) => m.id)).toEqual(["haiku", "sonnet"]);
  });

  test("BUG-425/old config: a model id the connection never probed (new in this catalog) is offered on a checked connection; one that failed stays hidden", () => {
    const connections: Config["connections"] = { codex: { auth: "api", provider: "bedrock" } };
    // An old file: the connection was checked when the ids were `us.openai.*`; there is no `unreached` key at all.
    const old = cfg({ connections, checked: { "codex/bedrock": "2026-09-01" }, verified: { "codex/bedrock/us.openai.gpt-6-luna": "2026-09-01" } });
    expect(offeredAgents(old, { installed })[0]!.models.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
    expect(reach(old, "codex", "bedrock", DEFAULT_MODELS.codex[1]!)).toBeNull();
    // A probe of the new ids: one reached, one refused (definitive) -> hidden; the third was transient -> still never probed.
    recordProbes(old, [{ harness: "codex", conn: "bedrock", problem: null, models: [{ id: "global.openai.gpt-6-luna", result: { ok: true } }, { id: "global.openai.gpt-6.1-sol", result: { ok: false, error: "access denied" } }, { id: "global.openai.gpt-6-astra", result: { ok: false, error: "timeout", transient: true } }] } as unknown as ConnectionProbe]);
    expect(offeredAgents(old, { installed })[0]!.models.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-6-astra"]);
    expect(loadConfig().unreached["codex/bedrock/global.openai.gpt-6.1-sol"]).toBeTruthy();
    // It reaches it on a later probe: offered again.
    recordProbes(old, [{ harness: "codex", conn: "bedrock", problem: null, models: [{ id: "global.openai.gpt-6.1-sol", result: { ok: true } }] } as unknown as ConnectionProbe]);
    expect(offeredAgents(old, { installed })[0]!.models.map((m) => m.id)).toContain("gpt-6.1-sol");
    expect(loadConfig().unreached["codex/bedrock/global.openai.gpt-6.1-sol"]).toBeUndefined();
  });

  test("an installed harness only; OpenCode offers a model when any of its providers reaches it (the plan's id and OpenRouter's differ)", () => {
    const connections: Config["connections"] = { opencode: { auth: "api", providers: ["opencode-go", "openrouter"] }, codex: { auth: "subscription" } };
    const checked = { "opencode/opencode-go": "d", "opencode/openrouter": "d" };
    const verified = { "opencode/opencode-go/deepseek-v4.1-flash": "d", "opencode/openrouter/meta/muse-spark-1.3": "d" };
    const offered = offeredAgents(cfg({ connections, checked, verified }), { installed: (h) => h === "opencode" });
    expect(offered.map((a) => a.harness)).toEqual(["opencode"]);
    expect(offered[0]!.models.map((m) => m.id)).toEqual(["deepseek-flash", "muse-spark-1.3"]);
  });

  test("a model with an opt-in (the contributor: Meta gets the code) is offered only where the opt-in is on; never by default", () => {
    const connections: Config["connections"] = { opencode: { auth: "api", providers: ["opencode-go"] } };
    const ids = (opts?: { optedIn: (k: string) => boolean }) => offeredAgents(cfg({ connections }), { installed, ...opts })[0]!.models.map((m) => m.id);
    expect(ids()).toEqual(["deepseek-flash"]);
    expect(ids({ optedIn: (k) => k === "allow_muse_contributor" })).toEqual(["deepseek-flash", "muse-spark-1.3-contributor"]);
    expect(ids({ optedIn: (k) => k === "something_else" })).toEqual(["deepseek-flash"]);
  });

  test("a connection that couldn't be probed (signed out) is checked and offers nothing", () => {
    const config = cfg({ connections: { codex: { auth: "subscription" } }, verified: { "codex/plan/gpt-6.1-sol": "2026-01-01" } });
    expect(offeredAgents(config, { installed })[0]!.models.length).toBe(3);
    recordProbes(config, [{ harness: "codex", conn: "plan", problem: "not signed in", models: [] }]);
    expect(config.checked["codex/plan"]).toBeTruthy();
    expect(config.verified).toEqual({});
    expect(offeredAgents(config, { installed })).toEqual([]);
    expect(loadConfig().checked["codex/plan"]).toBeTruthy();
  });

  test("a launch resolves an alias to the id of the first connection that reaches it; the plan needs no key in env", () => {
    const connections: Config["connections"] = { opencode: { auth: "api", providers: ["opencode-go", "openrouter"] } };
    const checked = { "opencode/opencode-go": "d", "opencode/openrouter": "d" };
    const config = cfg({ connections, checked, verified: { "opencode/openrouter/deepseek/deepseek-v4.1-flash": "d" }, unreached: { "opencode/opencode-go/deepseek-v4.1-flash": "d" } });
    // The plan didn't reach it in the probe, OpenRouter did.
    expect(resolveModel(config, "opencode", "deepseek-flash")).toEqual({ conn: "openrouter", id: "deepseek/deepseek-v4.1-flash" });
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test0123456789abcdef";
    const cmd = buildCommand(config, { harness: "opencode", model: "deepseek-flash", spec: "x", reason: "" });
    expect(cmd.argv).toEqual(["opencode", "--standalone", "--prompt=x"]);
    expect(cmd.env).toEqual({ OPENCODE_CONFIG_CONTENT: '{"model":"openrouter/deepseek/deepseek-v4.1-flash"}', OPENROUTER_API_KEY: "sk-or-v1-test0123456789abcdef" });
    // Verified on the plan too: the plan wins (it is first), and the launch carries no key at all.
    const plan = cfg({ connections, checked, verified: { "opencode/opencode-go/deepseek-v4.1-flash": "d", "opencode/openrouter/deepseek/deepseek-v4.1-flash": "d" } });
    expect(resolveModel(plan, "opencode", "deepseek-flash")).toEqual({ conn: "opencode-go", id: "deepseek-v4.1-flash" });
    const onPlan = buildCommand(plan, { harness: "opencode", model: "deepseek-flash", spec: "x", reason: "" });
    expect(onPlan.env).toEqual({ OPENCODE_CONFIG_CONTENT: '{"model":"opencode-go/deepseek-v4.1-flash"}' });
    expect(onPlan.conn).toBe("opencode-go");
  });

  test("the catalog maps every model to the vendors' published ids", () => {
    const sonnet = DEFAULT_MODELS["claude-code"].find((m) => m.id === "sonnet")!;
    expect(sonnet.ids).toEqual({ plan: "sonnet", anthropic: "claude-sonnet-5-5", bedrock: "global.anthropic.claude-sonnet-5-5", openrouter: "anthropic/claude-sonnet-5.5" });
    // Bedrock's Claude ids are `global.` inference profiles; Codex's are the runtime ones, `global.openai.*`.
    for (const m of DEFAULT_MODELS["claude-code"]) expect(m.ids.bedrock).toMatch(/^global\.anthropic\./);
    for (const m of DEFAULT_MODELS.codex) expect(m.ids.bedrock).toBe(`global.openai.${m.id}`);
    expect(DEFAULT_MODELS.codex.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
    expect(DEFAULT_MODELS.antigravity.map((m) => m.id)).toEqual(["gemini-3.8-flash"]);
    expect(DEFAULT_MODELS["grok-build"].map((m) => m.id)).toEqual(["grok-4.7"]);
    expect(DEFAULT_MODELS.opencode.map((m) => m.id)).toEqual(["deepseek-flash", "muse-spark-1.3", "muse-spark-1.3-contributor"]);
    // Bedrock only on Claude Code and Codex; no fallback anywhere; the OpenCode alias's ids come from its `current`.
    for (const [h, models] of Object.entries(DEFAULT_MODELS)) for (const m of models) expect([h, m.id, "bedrock" in m.ids && h !== "claude-code" && h !== "codex"]).toEqual([h, m.id, false]);
    const flash = DEFAULT_MODELS.opencode[0]!;
    expect(flash).toMatchObject({ current: "deepseek-v4.1-flash", ids: { "opencode-go": "deepseek-v4.1-flash", openrouter: "deepseek/deepseek-v4.1-flash" }, efforts: ["low", "high", "max"], defaultEffort: "max" });
    expect(DEFAULT_MODELS.opencode[2]).toMatchObject({ optIn: "allow_muse_contributor", sharesDataWith: "Meta", efforts: ["low", "medium", "high", "xhigh"] });
    // Every default effort is one the model takes.
    for (const models of Object.values(DEFAULT_MODELS)) for (const m of models) if (m.defaultEffort) expect([m.id, m.efforts.includes(m.defaultEffort)]).toEqual([m.id, true]);
  });

  test("the maintainers' Sonnet 4.6 exists only behind the seam, on Claude Code over Bedrock only", () => {
    expect(defaults().models["claude-code"].map((m) => m.id)).not.toContain("sonnet-4.6");
    process.env.GLUON_TEST_MAINTAINER_MODELS = "1";
    try {
      const entry = defaults().models["claude-code"].find((m) => m.id === "sonnet-4.6")!;
      expect(entry.ids).toEqual({ bedrock: "global.anthropic.claude-sonnet-4-6" });
      expect(defaults().models.codex.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
    } finally {
      delete process.env.GLUON_TEST_MAINTAINER_MODELS;
    }
  });
});

describe("config migration", () => {
  test("first-pass keys map to connections and bedrock, once; brain.subscriptionNotice goes", () => {
    const text = "brain: { provider: subscription, model: sonnet, subscriptionNotice: 2026-09-01 }\nauth: { opencode: api }\naws: { profile: dev }\n";
    const out = parse(migrate(text)!);
    expect(out.connections).toEqual({ "claude-code": { auth: "subscription" } });
    expect(out.bedrock).toEqual({ profile: "dev" });
    expect(out.notices).toBeUndefined();
    expect(out.brain.subscriptionNotice).toBeUndefined();
    expect(out.auth).toBeUndefined();
    expect(out.brain.provider).toBeUndefined();
    expect(out.brain.order[0]).toEqual({ route: "claude-plan", model: "sonnet" });
    expect(migrate("connections: {}\nbrain: { order: [] }\n")).toBeNull();
  });

  test("BUG-71/9.1: brain.model becomes the first step, comments come along, no empty OpenCode connection", () => {
    const dir = join(import.meta.dir, "fixtures");
    const a = migrate(readFileSync(join(dir, "first-pass-a.yaml"), "utf8"))!;
    expect(a).toContain("# my gluon config (first pass)");
    expect(a).toContain("# the brain on Bedrock");
    expect(a).toContain("# my SSO profile");
    expect(parse(a).brain.order[0]).toEqual({ route: "bedrock", model: "us.anthropic.claude-sonnet-4-6" });
    expect(parse(a).bedrock).toEqual({ profile: "work", region: "eu-west-1" });
    expect(parse(a).agents).toBeUndefined();
    expect(migrate(a)).toBeNull();
    const b = migrate(readFileSync(join(dir, "first-pass-b.yaml"), "utf8"))!;
    expect(b).toContain("# uncommitted first pass");
    expect(parse(b).connections).toEqual({ "claude-code": { auth: "subscription" } });
    expect(parse(b).brain).toBeUndefined();
    const c = parse(migrate(readFileSync(join(dir, "first-pass-c.yaml"), "utf8"))!);
    expect(c.brain.order).toEqual([{ route: "anthropic-api", model: "claude-sonnet-4-6" }, { route: "anthropic-api", model: "claude-sonnet-5-5" }]);
    expect(c.connections).toEqual({ "claude-code": { auth: "api", provider: "bedrock" } });
    expect(c.bedrock).toEqual({ region: "us-west-2", profile: "work" });
  });

  test("loadConfig migrates the file, and a second load changes nothing", () => {
    const path = process.env.GLUON_CONFIG!;
    writeFileSync(path, "# keep me\nbrain: { provider: anthropic, model: claude-sonnet-5 }\nauth: { claude-code: api }\n");
    const config = loadConfig();
    expect(config.connections).toEqual({ "claude-code": { auth: "api", provider: "anthropic" } });
    const once = readFileSync(path, "utf8");
    expect(once).toContain("# keep me");
    expect(once).not.toContain("provider: anthropic, model");
    loadConfig();
    expect(readFileSync(path, "utf8")).toBe(once);
  });
});

describe("runtime fallback", () => {
  test("a model that turns out unavailable moves the session to the next brain, and says so", async () => {
    const failing: ModelClient = async () => {
      throw new Error("access denied to us.openai.gpt-6-sol in us-east-1");
    };
    const calls: string[] = [];
    const next: ModelClient = async ({ messages }, onText) => {
      calls.push(JSON.stringify(messages.at(-1)!.content));
      onText("Hi from the next brain.");
      return { content: [{ type: "text", text: "Hi from the next brain.", citations: null } as Anthropic.TextBlock], stop_reason: "end_turn" };
    };
    let asked = "";
    const s = new Session(failing, defaults(), "sys", TMP, () => "", async (message) => {
      asked = message;
      return { client: next, label: "Sonnet 4.6 on Bedrock" };
    });
    await s.submit("fix the bug");
    expect(asked).toContain("access denied");
    const notice = s.snapshot.items.at(-1)!;
    expect(notice).toMatchObject({ kind: "notice", tone: "error" });
    expect(notice.kind === "notice" && notice.text).toContain("the intake agent moved to Sonnet 4.6 on Bedrock. Send your message again.");
    expect(s.snapshot.brain).toBe("Sonnet 4.6 on Bedrock");
    await s.submit("fix the bug");
    expect(calls).toEqual(['"fix the bug"']);
    expect(s.snapshot.items.at(-1)).toMatchObject({ kind: "assistant", text: "Hi from the next brain." });
  });

  test("with no next brain, the error is shown as before", async () => {
    const failing: ModelClient = async () => {
      throw new Error("model not found (404)");
    };
    const s = new Session(failing, defaults(), "sys", TMP, () => "a hint", async () => null);
    await s.submit("go");
    const last = s.snapshot.items.at(-1)!;
    expect(last.kind === "notice" && last.text).toBe("Error: model not found (404)\na hint");
    expect(s.snapshot.brain).toBeUndefined();
  });
});

describe("QA pass 2", () => {
  const with_ = (patch: Partial<Config>): Config => ({ ...defaults(), ...patch });
  test("BUG-74: Bedrock ids read as model names; long AWS errors keep the part that matters", () => {
    expect(modelName("openai.gpt-oss-120b-1:0")).toBe("gpt-oss-120b");
    expect(modelName("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("Haiku 4.5");
    expect(modelName("us.anthropic.claude-opus-4-6-v1")).toBe("Opus 4.6");
    expect(stepLabel({ route: "bedrock", model: "openai.gpt-oss-120b-1:0" })).toBe("gpt-oss-120b on Bedrock");
    const e = Object.assign(new Error("anthropic.claude-sonnet-5-5 is not available for this account. You can explore other available models on Amazon Bedrock. For additional access options, contact AWS Sales at https://aws.amazon.com/contact-us/sales-support/"), { name: "AccessDeniedException" });
    const reason = describeConverseError(e, { model: "global.anthropic.claude-sonnet-5-5", region: "us-east-1" });
    expect(reason).toBe("access denied to global.anthropic.claude-sonnet-5-5 in us-east-1: anthropic.claude-sonnet-5-5 is not available for this account (enable model access in the Bedrock console)");
    expect(clip(`see ${"x".repeat(20)} https://aws.amazon.com/contact-us/sales-support/`, 40)).toBe(`see ${"x".repeat(20)}…`);
  });

  test("BUG-624/QA-config-01: with no AWS_REGION and no configured region, Bedrock uses the AWS config profile's region, not us-east-1", () => {
    const home = mkdtempSync(join(TMP, "aws-home-"));
    const names = ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_CONFIG_FILE"];
    const env = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    try {
      // The AWS config by AWS_CONFIG_FILE, never by HOME: the real ~/.aws is not touched (the default path is the variants' test).
      writeFileSync(join(home, "aws-config"), "[default]\nregion = us-east-2\n");
      for (const k of names) delete process.env[k];
      process.env.AWS_CONFIG_FILE = join(home, "aws-config");
      const config = with_({ connections: { "claude-code": { auth: "api", provider: "bedrock" } } });
      // Was "us-east-1" (awsSetup's fallback), forced into the launched agent as AWS_REGION (src/launchers.ts awsEnv).
      expect(awsSetup(config).region).toBe("us-east-2");
      expect(buildCommand(config, { harness: "claude-code", model: "sonnet", spec: "x", reason: "" }).env.AWS_REGION).toBe("us-east-2");
    } finally {
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("BUG-624/variants: the AWS config's region follows the profile and the default path, and the configured and the environment's regions come first", () => {
    const home = mkdtempSync(join(TMP, "aws-home-"));
    const names = ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_CONFIG_FILE"];
    const env = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    try {
      mkdirSync(join(home, ".aws"));
      writeFileSync(join(home, ".aws/config"), "# a comment\n[default]\nregion = us-east-2\n\n[profile work]\n; another\nsso_start_url = https://x\nregion=eu-west-1\n\n[sso-session work]\nregion = ap-south-1\n");
      expect(awsConfigRegion(undefined, {}, home)).toBe("us-east-2"); // the default location, the default profile
      expect(awsConfigRegion("default", {}, home)).toBe("us-east-2");
      expect(awsConfigRegion("work", {}, home)).toBe("eu-west-1"); // [profile work], not the sso-session's
      expect(awsConfigRegion("missing", {}, home)).toBeUndefined();
      expect(awsConfigRegion(undefined, { AWS_CONFIG_FILE: join(home, "nowhere") }, home)).toBeUndefined(); // AWS_CONFIG_FILE wins over ~/.aws/config
      expect(awsConfigRegion(undefined, {}, join(home, "no-home"))).toBeUndefined();
      for (const k of names) delete process.env[k];
      process.env.AWS_CONFIG_FILE = join(home, ".aws/config");
      process.env.AWS_REGION = "ca-central-1";
      expect(awsSetup(with_({})).region).toBe("ca-central-1");
      delete process.env.AWS_REGION;
      expect(awsSetup(with_({ bedrock: { profile: "work" } }))).toEqual({ profile: "work", region: "eu-west-1" });
      expect(awsSetup(with_({ bedrock: { profile: "work", region: "us-west-2" } })).region).toBe("us-west-2");
    } finally {
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("BUG-68: one AWS profile and region for the brain, the probes and the launches", () => {
    process.env.AWS_PROFILE = "personal";
    const config = with_({ bedrock: { profile: "work", region: "eu-west-1" }, connections: { "claude-code": { auth: "api", provider: "bedrock" } } });
    expect(awsSetup(config)).toEqual({ profile: "work", region: "eu-west-1" });
    const cmd = buildCommand(config, { harness: "claude-code", model: "sonnet", spec: "x", reason: "" });
    expect(cmd.env).toMatchObject({ AWS_PROFILE: "work", AWS_REGION: "eu-west-1" });
    expect(brainErrorHint({ route: "bedrock", model: "us.anthropic.claude-sonnet-4-6" }, "The security token included in the request is expired", config)).toContain("aws sso login --profile work");
    // Without a configured profile, the environment's is the one, everywhere.
    const none = with_({ connections: { "claude-code": { auth: "api", provider: "bedrock" } } });
    expect(awsSetup(none).profile).toBe("personal");
    expect(buildCommand(none, { harness: "claude-code", model: "sonnet", spec: "x", reason: "" }).env.AWS_PROFILE).toBe("personal");
    // Nothing else picks a profile on its own.
    for (const f of ["src/agent/clients.ts", "src/agent/bedrock-converse.ts", "src/launchers.ts", "src/brain.ts", "src/verify.ts"]) {
      const text = readFileSync(join(import.meta.dir, "..", f), "utf8");
      expect([f, /process\.env\.AWS_PROFILE|config\.bedrock\.(profile|region)/.test(text)]).toEqual([f, false]);
    }
    delete process.env.AWS_PROFILE;
  });

  test("BUG-53/5.4: OpenRouter's public model listing never verifies a key: its key endpoint does", async () => {
    delete process.env.GLUON_TEST_PROBES;
    const realFetch = globalThis.fetch;
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "meta/muse-spark-1.3" }] }));
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer sk-or-v1-goodgoodgood0123" ? new Response("{}") : new Response('{"error":{"message":"No auth credentials found"}}', { status: 401 });
    }) as typeof fetch;
    try {
      const config = with_({ connections: { opencode: { auth: "api", providers: ["openrouter"] } } });
      process.env.OPENROUTER_API_KEY = "sk-or-v1-badbadbadbad01234";
      const bad = await probeConnection(config, "opencode", "openrouter");
      expect(bad.problem).toBe("OpenRouter: the API key was rejected (401)");
      expect(bad.models).toEqual([]);
      process.env.OPENROUTER_API_KEY = "sk-or-v1-goodgoodgood0123";
      const good = await probeConnection(config, "opencode", "openrouter");
      expect(good.problem).toBeNull();
      expect(good.models.filter((m) => m.result.ok).map((m) => m.id)).toEqual(["deepseek/deepseek-v4.1-flash", "meta/muse-spark-1.3"]);
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  test("the OpenCode plan: signed in by OpenCode's own `auth list`, its models from the plan's public listing (no key is ever sent)", async () => {
    delete process.env.GLUON_TEST_PROBES;
    const realFetch = globalThis.fetch;
    const calls: { url: string; auth: string | null }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4.1-flash" }, { id: "muse-spark-1.3-contributor" }] }));
    }) as typeof fetch;
    try {
      const config = with_({ connections: { opencode: { auth: "api", providers: ["opencode-go"] } } });
      const signedOut = await probeConnection(config, "opencode", "opencode-go", { status: { installed: true, loggedIn: false } });
      expect(signedOut.problem).toBe("not signed in");
      expect(calls).toEqual([]);
      const signedIn = await probeConnection(config, "opencode", "opencode-go", { status: { installed: true, loggedIn: true, detail: "OpenCode Go plan" } });
      expect(signedIn.problem).toBeNull();
      expect(signedIn.models.filter((m) => m.result.ok).map((m) => m.id)).toEqual(["deepseek-v4.1-flash", "muse-spark-1.3-contributor"]);
      expect(calls).toEqual([{ url: "https://opencode.ai/zen/go/v1/models", auth: null }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("key listings (BUG-75)", () => {
  test("BUG-75: an alias counts as listed when the listing names only its dated snapshot", async () => {
    const { isListed } = await import("../src/verify.ts");
    const listed = new Set(["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-opus-4-5-20251101"]);
    expect(isListed(listed, "claude-haiku-4-5")).toBe(true);
    expect(isListed(listed, "claude-sonnet-5-5")).toBe(true);
    expect(isListed(listed, "claude-opus-4-5")).toBe(true);
    // Not a prefix match: another model, or a non-date suffix, doesn't count.
    expect(isListed(listed, "claude-haiku-4")).toBe(false);
    expect(isListed(new Set(["claude-haiku-4-5-latest"]), "claude-haiku-4-5")).toBe(false);
    expect(isListed(listed, "claude-fable-5-1")).toBe(false);
  });
});

describe("review of PR #1", () => {
  test("BUG-76/1: the runtime fallback fires on the providers' raw 'no access' errors, not on any 404", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { default: OpenAI } = await import("openai");
    const { AccessDeniedException, ValidationException, ResourceNotFoundException, ThrottlingException } = await import("@aws-sdk/client-bedrock-runtime");
    const headers = new Headers();
    const aws = <T>(C: new (o: any) => T, message: string) => new C({ message, $metadata: {} });
    const unavailable: [string, unknown][] = [
      // Bedrock, Converse: the SDK's own exceptions, as converseClient throws them.
      ["converse access denied", aws(AccessDeniedException, "anthropic.claude-sonnet-5-5 is not available for this account. You can explore other available models on Amazon Bedrock.")],
      ["converse no access", aws(AccessDeniedException, "You don't have access to the model with the specified model ID.")],
      ["converse invalid id", aws(ValidationException, "The provided model identifier is invalid.")],
      ["converse not found", aws(ResourceNotFoundException, "Model not found.")],
      // Bedrock, Claude through AnthropicBedrock: Anthropic SDK errors with the raw JSON body.
      ["bedrock claude 403", Anthropic.APIError.generate(403, { message: "You don't have access to the model with the specified model ID." }, undefined, headers)],
      ["bedrock claude 400", Anthropic.APIError.generate(400, { message: "The provided model identifier is invalid." }, undefined, headers)],
      ["anthropic 404", Anthropic.APIError.generate(404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } }, undefined, headers)],
      // OpenAI and OpenRouter.
      ["openai 404", OpenAI.APIError.generate(404, { error: { message: "The model `gpt-9` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } }, undefined, headers)],
      ["openrouter 404", OpenAI.APIError.generate(404, { error: { message: "No endpoints found for openai/gpt-6-sol.", code: 404 } }, undefined, headers)],
      // The same, as text only (a loop brain's message).
      ["text: not available", "anthropic.claude-sonnet-5-5 is not available for this account. You can explore other available models…"],
      ["text: no access", "You don't have access to the model with the specified model ID."],
      ["text: 403 json", '403 {"message":"You don\'t have access to the model with the specified model ID."}'],
      ["text: invalid id", "The provided model identifier is invalid."],
    ];
    for (const [name, e] of unavailable) expect([name, modelUnavailable(e)]).toEqual([name, true]);
    const other: [string, unknown][] = [
      ["bare 404", "404 page not found"],
      ["proxy 404", Anthropic.APIError.generate(404, { message: "Not Found" }, undefined, headers)],
      ["401", OpenAI.APIError.generate(401, { error: { message: "Incorrect API key provided", code: "invalid_api_key" } }, undefined, headers)],
      ["429", OpenAI.APIError.generate(429, { error: { message: "Rate limit reached for model gpt-6-sol" } }, undefined, headers)],
      ["503", Anthropic.APIError.generate(503, { message: "The model is temporarily unavailable" }, undefined, headers)],
      ["throttled", aws(ThrottlingException, "Too many requests for model x, please wait.")],
      ["network", new Error("fetch failed")],
    ];
    for (const [name, e] of other) expect([name, modelUnavailable(e)]).toEqual([name, false]);

    // Through the session: the fallback gets the raw error and moves on.
    const raw = aws(AccessDeniedException, "You don't have access to the model with the specified model ID.");
    const failing: ModelClient = async () => {
      throw raw;
    };
    const next: ModelClient = async () => ({ content: [{ type: "text", text: "ok", citations: null } as Anthropic.TextBlock], stop_reason: "end_turn" });
    let got: unknown = null;
    const s = new Session(failing, defaults(), "sys", TMP, () => "", async (_m, error) => {
      got = error;
      return modelUnavailable(error) ? { client: next, label: "next" } : null;
    });
    await s.submit("go");
    expect(got).toBe(raw);
    expect(s.snapshot.brain).toBe("next");
  });

  test("BUG-77/2: a transient probe failure keeps a connection's verified models; a definitive one clears them", async () => {
    const connections: Config["connections"] = { codex: { auth: "api", provider: "openai" }, "claude-code": { auth: "subscription" } };
    const verified = { "codex/openai/gpt-6.1-sol": "2026-09-01", "claude-code/plan/sonnet": "2026-09-01", "claude-code/bedrock/global.anthropic.claude-sonnet-5-5": "2026-09-01", "claude-code/bedrock/global.anthropic.claude-opus-5-5": "2026-09-01" };
    const checked = { "codex/openai": "2026-09-01", "claude-code/plan": "2026-09-01", "claude-code/bedrock": "2026-09-01" };
    const config: Config = { ...defaults(), connections, verified: { ...verified }, checked: { ...checked } };
    const realFetch = globalThis.fetch;
    const realPath = process.env.PATH;
    delete process.env.GLUON_TEST_PROBES;
    process.env.OPENAI_API_KEY = "sk-proj-test0123456789abcdef";
    let status = 503;
    globalThis.fetch = (async () => (status === 0 ? Promise.reject(new TypeError("fetch failed")) : new Response('{"error":{"message":"upstream trouble"}}', { status }))) as unknown as typeof fetch;
    try {
      // A server error, the network, a rate limit on the listing: transient, the last results stand.
      for (const s of [503, 0, 429]) {
        status = s;
        const p = await probeConnection(config, "codex", "openai");
        expect([s, p.transient, p.problem]).toEqual([s, true, expect.stringContaining("the last check's results are kept")]);
        recordProbes(config, [p]);
        expect(config.verified["codex/openai/gpt-6.1-sol"]).toBe("2026-09-01");
        expect(config.checked["codex/openai"]).toBe("2026-09-01");
      }
      // `claude auth status` that gives no answer isn't a sign-out.
      const { fakeAgents } = await import("./e2e/fixtures.ts");
      process.env.PATH = `${fakeAgents(["claude"])}${delimiter}${realPath}`;
      process.env.FAKE_CLAUDE_STATUS_FAIL = "1";
      const plan = await probeConnection(config, "claude-code", "plan");
      expect(plan.transient).toBe(true);
      recordProbes(config, [plan]);
      expect(config.verified["claude-code/plan/sonnet"]).toBe("2026-09-01");
      // A throttled Bedrock model keeps its date; one refused loses it.
      probeFile({ "bedrock/global.anthropic.claude-sonnet-5-5": "rate limited: Too many requests, please wait before trying again.", "bedrock/global.anthropic.claude-opus-5-5": "access denied to global.anthropic.claude-opus-5-5 in us-east-1" });
      const onBedrock = { ...config, connections: { "claude-code": { auth: "api", provider: "bedrock" } } } as Config;
      const bedrock = await probeConnection(onBedrock, "claude-code", "bedrock");
      recordProbes(config, [bedrock]);
      expect(config.verified["claude-code/bedrock/global.anthropic.claude-sonnet-5-5"]).toBe("2026-09-01");
      expect(config.verified["claude-code/bedrock/global.anthropic.claude-opus-5-5"]).toBeUndefined();
      delete process.env.GLUON_TEST_PROBES;
      // Definitive: the key is rejected; the connection reaches nothing.
      status = 401;
      const rejected = await probeConnection(config, "codex", "openai");
      expect(rejected.transient).toBeUndefined();
      expect(rejected.problem).toBe("OpenAI: the API key was rejected (401): upstream trouble");
      recordProbes(config, [rejected]);
      expect(config.verified["codex/openai/gpt-6.1-sol"]).toBeUndefined();
      expect(config.checked["codex/openai"]).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      globalThis.fetch = realFetch;
      process.env.PATH = realPath;
      delete process.env.FAKE_CLAUDE_STATUS_FAIL;
    }
  });

  test("BUG-421/models-key-removed: a `models:` key in the config is ignored with one notice: the catalog is Gluon's own, an extra model is never offered", () => {
    writeFileSync(process.env.GLUON_CONFIG!, "connections: { claude-code: { auth: subscription } }\nmodels:\n  claude-code:\n    - { id: sonnet }\n    - { id: claude-next-preview, label: Next, note: trial }\n");
    const seen: string[] = [];
    setConfigNotices((m) => seen.push(m));
    try {
      const config = loadConfig();
      expect(config.models["claude-code"].map((m) => m.id)).toEqual(["haiku", "sonnet", "opus", "fable"]);
      expect(offeredAgents(config, { installed: () => true })[0]!.models.map((m) => m.id)).toEqual(["haiku", "sonnet", "opus", "fable"]);
      expect(seen).toEqual([expect.stringContaining("`models:` is no longer read")]);
      expect(resolveModel(config, "claude-code", "claude-next-preview")).toBeNull();
    } finally {
      setConfigNotices(null);
    }
  });

  test("BUG-422/connections-retired-providers: OpenCode's old providers (Zen, Moonshot, …) are dropped with a notice, not an error: what remains still loads", () => {
    writeFileSync(process.env.GLUON_CONFIG!, "connections: { opencode: { auth: api, providers: [opencode-zen, moonshot, openrouter, opencode-go] } }\n");
    const seen: string[] = [];
    setConfigNotices((m) => seen.push(m));
    try {
      expect(loadConfig().connections.opencode).toEqual({ auth: "api", providers: ["openrouter", "opencode-go"] });
      expect(seen).toEqual([expect.stringMatching(/"opencode-zen", "moonshot" are no longer offered.*gluon connect opencode/)]);
    } finally {
      setConfigNotices(null);
    }
  });

  test("BUG-84/9: a first-pass `agents:` block isn't dropped silently: the user is told once what it listed", () => {
    const text = readFileSync(join(import.meta.dir, "fixtures", "first-pass-a.yaml"), "utf8");
    const warnings: string[] = [];
    expect(parse(migrate(text, warnings)!).agents).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining("`agents:` list was dropped from the config (claude-code: sonnet)")]);
    expect(warnings[0]).not.toContain("`models:`");
    // Nothing to tell when there was no agents block.
    const none: string[] = [];
    migrate("auth: { claude-code: subscription }\n", none);
    expect(none).toEqual([]);
    // Through loadConfig: said on stderr on the load that migrates, not again.
    writeFileSync(process.env.GLUON_CONFIG!, text);
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      loadConfig();
      loadConfig();
    } finally {
      console.error = realError;
    }
    expect(errors).toEqual([expect.stringContaining("`agents:` list was dropped")]);
  });

  test("BUG-88: agy's listing counts a model only by its own id plus an effort, not a longer model's id", async () => {
    const { offersModel } = await import("../src/verify.ts");
    expect(offersModel("gemini-3.8-flash-high", "gemini-3.8-flash")).toBe(true);
    expect(offersModel("gemini-3.8-flash", "gemini-3.8-flash")).toBe(true);
    expect(offersModel("gemini-3.8-flash-lite-high", "gemini-3.8-flash")).toBe(false);
    expect(offersModel("gemini-3.8-flash-lite", "gemini-3.8-flash")).toBe(false);
    const { fakeAgents } = await import("./e2e/fixtures.ts");
    const path = process.env.PATH;
    process.env.PATH = `${fakeAgents(["agy"])}${delimiter}${path}`;
    process.env.FAKE_AGY_MODELS = "gemini-3.8-flash-lite";
    try {
      const probe = () => probeConnection({ ...defaults(), connections: { antigravity: { auth: "subscription" } } }, "antigravity", "plan");
      expect((await probe()).models.map((m) => [m.id, m.result.ok])).toEqual([["gemini-3.8-flash", false]]);
      process.env.FAKE_AGY_MODELS = "gemini-3.8-flash-lite gemini-3.8-flash";
      expect((await probe()).models.map((m) => [m.id, m.result.ok])).toEqual([["gemini-3.8-flash", true]]);
    } finally {
      process.env.PATH = path;
      delete process.env.FAKE_AGY_MODELS;
    }
  });
});

// --- QA pass (brain, offline)

describe("QA: what counts as a model that can't be used (the runtime fallback's test)", () => {
  const http = (status: number, message: string) => Object.assign(new Error(message), { status });
  const aws = (name: string, message: string) => Object.assign(new Error(message), { name });

  test("the providers' own wording for a missing or refused model moves the order on; rate limits, outages, bad keys and plan limits don't", () => {
    const unavailable: [string, unknown][] = [
      ["Anthropic 404", http(404, '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-foo"}}')],
      ["OpenAI 404", http(404, "404 The model `gpt-9` does not exist or you do not have access to it.")],
      ["OpenAI code", Object.assign(new Error("x"), { code: "model_not_found" })],
      ["OpenRouter 404", http(404, "404 No endpoints found for anthropic/claude-foo.")],
      ["Bedrock not found", aws("ResourceNotFoundException", "Could not resolve the foundation model from the provided model identifier.")],
      ["Bedrock denied", aws("AccessDeniedException", "You don't have access to the model with the specified model ID.")],
      ["Bedrock bad id", aws("ValidationException", "The provided model identifier is invalid.")],
      ["Claude Code", new Error("There's an issue with the selected model (x). It may not exist or you may not have access to it. Run --model to pick a different model.")],
      ["Codex", new Error("The 'gpt-9' model is not supported when using Codex with a ChatGPT account.")],
    ];
    for (const [name, e] of unavailable) expect([name, modelUnavailable(e)]).toEqual([name, true]);
    const passes: [string, unknown][] = [
      ["Anthropic 401", http(401, '401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}')],
      ["Anthropic 403 permission", http(403, '403 {"error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}')],
      ["Anthropic 429", http(429, "429 rate_limit_error")],
      ["Anthropic 529", http(529, "529 overloaded_error")],
      ["Anthropic effort 400", http(400, '400 {"error":{"message":"This model does not support the effort parameter"}}')],
      ["OpenRouter 402", http(402, "402 Insufficient credits")],
      ["Bedrock throttled", aws("ThrottlingException", "Too many requests, please wait before trying again.")],
      ["Bedrock stream error", aws("ModelStreamErrorException", "model stream error")],
      ["Bedrock 5xx", Object.assign(aws("InternalServerException", "x"), { status: 500 })],
      ["Claude plan limit", new Error("Claude AI usage limit reached|1728000000")],
      ["network", new Error("Connection error.")],
      ["a proxy's 404", "404 page not found"],
      ["reply cut off", new Error("The intake agent's reply was cut off (too long).")],
      ["nothing", undefined],
    ];
    for (const [name, e] of passes) expect([name, modelUnavailable(e)]).toEqual([name, false]);
  });
});

test("BUG-626/QA-brain-07: OpenRouter's answer to an id it doesn't know (400, \"… is not a valid model ID\") counts as an unavailable model, so the order moves on and the probe says the model isn't reachable", () => {
  const e = Object.assign(new Error('400 {"error":{"message":"anthropic/claude-foo is not a valid model ID","code":400}}'), { status: 400 });
  expect(modelUnavailable(e)).toBe(true);
});

test("BUG-627/QA-brain-08: a too-long prompt (Bedrock's ValidationException \"Input is too long for requested model\") is not read as 'that model isn't available': the order must not move on, nor say so", () => {
  const e = Object.assign(new Error("Input is too long for requested model."), { name: "ValidationException" });
  expect(modelUnavailable(e)).toBe(false);
});

test("BUG-627/variants: a ValidationException about the model's id still moves the order on; one about the prompt's size doesn't, in the words of either provider", () => {
  const aws = (message: string) => Object.assign(new Error(message), { name: "ValidationException" });
  expect(modelUnavailable(aws("The provided model identifier is invalid."))).toBe(true);
  for (const m of ["Input is too long for requested model.", "Too many input tokens for this model.", "The input exceeds the maximum context length of the model."]) expect([m, modelUnavailable(aws(m))]).toEqual([m, false]);
  expect(modelUnavailable("Input is too long for requested model.")).toBe(false);
});

test("QA: every default brain step sends an effort its model takes, or none where the model takes none (the ChatGPT plan's catalog is read at run time)", async () => {
  const { sentEffort, stepEfforts } = await import("../src/agent/effort.ts");
  for (const step of DEFAULT_ORDER) {
    const takes = stepEfforts(step);
    const sent = sentEffort(step);
    if (takes === null) expect([step.route, sent]).toEqual([step.route, "medium"]);
    else if (takes.length) expect([step.route, step.model, takes.includes(sent as never)]).toEqual([step.route, step.model, true]);
    else expect([step.route, step.model, sent]).toEqual([step.route, step.model, null]);
  }
});
