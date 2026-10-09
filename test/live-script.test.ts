/**
 * The pure parts of `bun run test:live` (scripts/live-lib.ts, and the planning half of scripts/live-harness.ts): flags and caps, bucket
 * math, the plan-cost estimate, tier selection, the AWS region, which connection and model a harness check uses, and a dry run of the
 * whole script (spawned: it must call nothing and write nothing). Offline: no key, no AWS and no harness is ever used.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODELS } from "../src/harnesses.ts";
import { brainAsks, brainBusy, brainProposes, checkConfig, inputRegion, planHarness, proposalMode, regionDiff, saysOK, verdict } from "../scripts/live-harness.ts";
import {
  awsRegion, bucketOf, cheapestModel, chatStep, regressionSubset, costFigure, DEFAULT_CAPS, harnessWorstCase, HARNESS_TOKENS, parseArgs, parseCaps, pickConn, planCharged, planEstimate,
  JOURNEY_AGENT_CAP, JOURNEY_BRAIN_CAP, JOURNEY_HARNESS_CAP, JOURNEY_MONTH_CAP, JOURNEY_RUN_CAP, journeyMonthSpend, planLines, planRouteBlock, planTotal, price, runCapOf, sectionsOf, Spend, usd, type Available,
} from "../scripts/live-lib.ts";

const ROOT = join(import.meta.dir, "..");
const tmp = () => mkdtempSync(join(tmpdir(), "live-script-"));

describe("--caps", () => {
  test("parses the campaign's caps; a key left out keeps its default; openrouter has no default", () => {
    expect(parseCaps("bedrock=30,other=10,openrouter=0.5")).toEqual({ bedrock: 30, other: 10, openrouter: 0.5 });
    expect(parseCaps("other=10")).toEqual({ bedrock: 5, other: 10 });
    expect(parseCaps(" bedrock = 1 ".replace(/ /g, ""))).toEqual({ bedrock: 1, other: 3 });
  });
  test("refuses an unknown bucket, a repeat, a bad amount and nothing at all", () => {
    expect(() => parseCaps("gemini=1")).toThrow(/unknown bucket/);
    expect(() => parseCaps("other=1,other=2")).toThrow(/twice/);
    expect(() => parseCaps("other=-1")).toThrow(/not an amount/);
    expect(() => parseCaps("other=abc")).toThrow(/not an amount/);
    expect(() => parseCaps("other")).toThrow(/name=amount/);
    expect(() => parseCaps("")).toThrow(/at least one/);
  });
});

describe("buckets and prices", () => {
  test("without --caps: OpenRouter is plain `other`, every plan is a subscription (as before)", () => {
    expect(bucketOf("bedrock", false)).toBe("bedrock");
    expect(bucketOf("openrouter", false)).toBe("other");
    expect(bucketOf("anthropic-api", false)).toBe("other");
    expect(bucketOf("claude-plan", false)).toBe("subscription");
    expect(bucketOf("chatgpt-plan", false)).toBe("subscription");
    expect(planCharged("claude-plan", false)).toBe(false);
  });
  test("with --caps: OpenRouter is a sub-bucket, the Claude plan is charged to `other` (estimated), the ChatGPT plan stays free", () => {
    expect(bucketOf("openrouter", true)).toBe("openrouter");
    expect(bucketOf("claude-plan", true)).toBe("other");
    expect(bucketOf("chatgpt-plan", true)).toBe("subscription");
    expect(planCharged("claude-plan", true)).toBe(true);
    expect(planCharged("anthropic-api", true)).toBe(false);
  });
  test("the plan estimate is the Anthropic API's price for the same tokens; Bedrock carries its markup", () => {
    expect(planEstimate("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBeCloseTo(3 + 15, 9);
    expect(planEstimate("claude-sonnet-5-5", 60_000, 8_000)).toBeCloseTo(usd("claude-sonnet-5-5", "other", 60_000, 8_000), 12);
    expect(price("global.anthropic.claude-sonnet-5-5", "bedrock")[0]).toBeCloseTo(3.3, 9);
    expect(price("some-unknown-model", "other")).toEqual([20, 100]);
  });
});

describe("the spend ledger", () => {
  test("a call is refused when its worst case would pass its bucket's cap, and logged", () => {
    const s = new Spend(null, { bedrock: 5, other: 1 }, Infinity, false);
    expect(s.allow("other", "a", "claude-sonnet-5-5", 60_000, 8_000)).toBe(true); // $0.30
    s.charge("other", "a", "claude-sonnet-5-5", 60_000, 8_000);
    s.charge("other", "b", "claude-sonnet-5-5", 100_000, 20_000); // $0.60 more
    expect(s.spent("other")).toBeCloseTo(0.3 + 0.6, 6);
    expect(s.allow("other", "c", "claude-sonnet-5-5", 60_000, 8_000)).toBe(false);
    expect(s.run.refused[0]).toContain("other over $1");
    expect(s.allow("bedrock", "d", "global.anthropic.claude-sonnet-5-5", 60_000, 8_000)).toBe(true);
  });
  test("the run's cap counts every bucket together", () => {
    const s = new Spend(null, { bedrock: 30, other: 10 }, 0.5, false);
    s.charge("bedrock", "a", "global.anthropic.claude-sonnet-5-5", 60_000, 8_000); // $0.33
    expect(s.allow("other", "b", "claude-sonnet-5-5", 60_000, 8_000)).toBe(false); // $0.30 → $0.63 > $0.5
    expect(s.run.refused[0]).toContain("this run over $0.5");
    expect(s.runTotal()).toBeCloseTo(0.33, 6);
  });
  test("OpenRouter counts inside `other` and in its own sub-cap; either can refuse a call", () => {
    const s = new Spend(null, { bedrock: 30, other: 10, openrouter: 0.5 }, Infinity, true);
    s.charge("openrouter", "a", "anthropic/claude-sonnet-5.5", 60_000, 8_000); // $0.30
    expect(s.spent("openrouter")).toBeCloseTo(0.3, 6);
    expect(s.spent("other")).toBeCloseTo(0.3, 6);
    expect(s.runTotal()).toBeCloseTo(0.3, 6); // once, not twice
    expect(s.allow("openrouter", "b", "anthropic/claude-sonnet-5.5", 60_000, 8_000)).toBe(false); // 0.3 + 0.3 > 0.5
    expect(s.run.refused[0]).toContain("openrouter over $0.5");
    const t = new Spend(null, { bedrock: 30, other: 0.4, openrouter: 5 }, Infinity, true);
    t.charge("other", "x", "claude-sonnet-5-5", 100_000, 0); // $0.30
    expect(t.allow("openrouter", "y", "anthropic/claude-sonnet-5.5", 60_000, 8_000)).toBe(false);
    expect(t.run.refused[0]).toContain("other over $0.4");
  });
  test("a Claude-plan charge in a campaign lands in `other`, flagged estimated; a plan without caps costs nothing", () => {
    const camp = new Spend(null, { bedrock: 30, other: 10 }, Infinity, true);
    camp.charge(bucketOf("claude-plan", true), "probe", "claude-sonnet-5-5", 1_000_000, 0, planCharged("claude-plan", true));
    expect(camp.spent("other")).toBeCloseTo(3, 6);
    expect(camp.run.calls[0]).toMatchObject({ bucket: "other", estimated: true });
    const plain = new Spend(null, { ...DEFAULT_CAPS }, Infinity, false);
    plain.charge(bucketOf("claude-plan", false), "probe", "claude-sonnet-5-5", 1_000_000, 0);
    expect(plain.spent("other")).toBe(0);
    expect(plain.run.calls[0]).toMatchObject({ bucket: "subscription", usd: 0 });
    expect(plain.allow("subscription", "x", "claude-sonnet-5-5", 1e9, 1e9)).toBe(true);
  });
  test("the ledger file keeps every run; the defaults and an old file without `openrouter` still read", () => {
    const dir = tmp();
    try {
      const file = join(dir, "sub", "ledger.json");
      const a = new Spend(file, { ...DEFAULT_CAPS }, Infinity, false);
      a.chargeUsd("other", "first", "m", 0.25, 1, 1, true);
      const b = new Spend(file, { ...DEFAULT_CAPS }, Infinity, false);
      b.chargeUsd("bedrock", "second", "m", 0.5);
      const saved = JSON.parse(readFileSync(file, "utf8"));
      expect(saved.spent).toEqual({ bedrock: 0.5, other: 0.25 });
      expect(saved.runs.map((r: { calls: { what: string }[] }) => r.calls[0]?.what)).toEqual(["first", "second"]);
      expect(saved.caps).toEqual({ bedrock: 5, other: 3 });
      // A dry run reads the file and never writes it.
      const before = readFileSync(file, "utf8");
      const dry = new Spend(file, { ...DEFAULT_CAPS }, Infinity, false, false);
      dry.chargeUsd("other", "never saved", "m", 1);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(dry.spent("other")).toBeCloseTo(1.25, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("flags and tiers", () => {
  test("--name=value and --name value; the campaign flags", () => {
    const a = parseArgs(["--tier=regression", "--ledger", "qa/logs/campaign.json", "--caps", "bedrock=30,other=10,openrouter=0.5", "--dry-run"]);
    expect(a).toEqual({ tier: "regression", ledger: "qa/logs/campaign.json", caps: { bedrock: 30, other: 10, openrouter: 0.5 }, dryRun: true });
    expect(parseArgs(["--ledger=x.json", "--only=git-tools"])).toMatchObject({ ledger: "x.json", only: "git-tools", dryRun: false });
    expect(parseArgs([])).toEqual({ dryRun: false });
  });
  test("refuses what contradicts or is unknown", () => {
    expect(() => parseArgs(["--tier=harness"])).toThrow(/needs --harness/);
    expect(() => parseArgs(["--tier=regression", "--only=git-tools"])).toThrow(/use one/);
    expect(() => parseArgs(["--tier=nightly"])).toThrow(/unknown tier/);
    expect(() => parseArgs(["--only=other"])).toThrow(/unknown check/);
    expect(() => parseArgs(["--ledger"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--ledger", "--dry-run"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--harness=codex"])).toThrow(/goes with --tier/);
  });
  test("each tier's sections and whole-run cap; the plain run and --only are unchanged", () => {
    expect(sectionsOf({ tier: "regression" })).toEqual(["probes", "brain-chat", "git-tools", "nested-instructions", "real-harness"]);
    expect(sectionsOf({ tier: "harness", harness: "codex" })).toEqual(["real-harness"]);
    expect(sectionsOf({ tier: "regression", harness: "codex" })).toEqual(["real-harness"]);
    expect(sectionsOf({ only: "git-tools" })).toEqual(["git-tools"]);
    expect(sectionsOf({ only: "nested-instructions" })).toEqual(["nested-instructions"]);
    expect(sectionsOf({})).toEqual(["harnesses", "connections", "brain-order"]);
    expect(runCapOf({ tier: "regression" })).toBe(3);
    expect(runCapOf({ tier: "harness" })).toBe(1);
    expect(runCapOf({ only: "git-tools" })).toBe(1);
    expect(runCapOf({ only: "nested-instructions" })).toBe(0.5);
    expect(runCapOf({})).toBe(Infinity);
  });
  test("the one brain chat: the cheapest working API route, a plan only when no API works", () => {
    const steps = [
      { route: "claude-plan", model: "claude-sonnet-5-5" },
      { route: "anthropic-api", model: "claude-sonnet-5-5" },
      { route: "openai-api", model: "gpt-6-sol" },
      { route: "bedrock", model: "global.anthropic.claude-sonnet-5-5" },
    ];
    expect(chatStep(steps, false)).toEqual(steps[1]!);
    expect(chatStep([steps[0]!, steps[2]!], false)).toEqual(steps[2]!);
    expect(chatStep([steps[0]!], false)).toEqual(steps[0]!);
    expect(chatStep([], false)).toBeNull();
  });
});

describe("the regression tier's brain subset", () => {
  const order = [
    { route: "claude-plan", model: "claude-sonnet-5-5" },
    { route: "chatgpt-plan", model: "gpt-6-luna" },
    { route: "anthropic-api", model: "claude-sonnet-5-5" },
    { route: "openai-api", model: "gpt-6-sol" },
    { route: "bedrock", model: "global.anthropic.claude-sonnet-5-5" },
  ];
  test("the plan routes and the one cheapest usable API route, in the order's own order", () => {
    expect(regressionSubset(order, () => true, false)).toEqual([order[0]!, order[1]!, order[2]!]);
    expect(regressionSubset(order, (s) => s.route === "openai-api" || s.route === "bedrock", false)).toEqual([order[0]!, order[1]!, order[4]!]);
    expect(regressionSubset(order, (s) => s.route === "openai-api", false)).toEqual([order[0]!, order[1]!, order[3]!]);
  });
  test("no usable API route: the plan routes alone", () => {
    expect(regressionSubset(order, () => false, false)).toEqual([order[0]!, order[1]!]);
  });
});

describe("the plan routes in a live run", () => {
  test("the Claude plan needs the user's own token (its scratch HOME has no login); the ChatGPT plan needs an explicit opt-in", () => {
    expect(planRouteBlock("claude-plan", {})).toMatch(/^not connected .*CLAUDE_CODE_OAUTH_TOKEN/);
    expect(planRouteBlock("claude-plan", { CLAUDE_CODE_OAUTH_TOKEN: "x" })).toBeNull();
    expect(planRouteBlock("chatgpt-plan", {})).toMatch(/^not connected .*GLUON_LIVE_CHATGPT_PLAN=1/);
    expect(planRouteBlock("chatgpt-plan", { GLUON_LIVE_CHATGPT_PLAN: "1" })).toBeNull();
    for (const r of ["anthropic-api", "openai-api", "bedrock", "openrouter"]) expect(planRouteBlock(r, {})).toBeNull();
  });
});

describe("the AWS region", () => {
  const cfg = "[default]\nregion = us-east-2\n\n[profile work]\nsso_session = x\nregion = eu-west-1\n\n[profile Odd Name]\nregion=ap-south-1\n";
  test("AWS_REGION, then AWS_DEFAULT_REGION, then the profile's region in the AWS config", () => {
    expect(awsRegion({ AWS_REGION: "us-west-2" }, cfg)).toEqual({ region: "us-west-2", from: "AWS_REGION" });
    expect(awsRegion({ AWS_DEFAULT_REGION: "us-west-1" }, cfg)?.region).toBe("us-west-1");
    expect(awsRegion({}, cfg)).toEqual({ region: "us-east-2", from: "the AWS config's [default]" });
    expect(awsRegion({ AWS_PROFILE: "work" }, cfg)?.region).toBe("eu-west-1");
    expect(awsRegion({ AWS_PROFILE: "Odd Name" }, cfg)?.region).toBe("ap-south-1");
  });
  test("nothing known: null, never a guess (no us-east-1 default)", () => {
    expect(awsRegion({}, null)).toBeNull();
    expect(awsRegion({}, "[profile work]\nregion = eu-west-1\n")).toBeNull();
    expect(awsRegion({ AWS_PROFILE: "missing" }, cfg)).toBeNull();
  });
  test("the script no longer hard-codes a region", () => {
    expect(readFileSync(join(ROOT, "scripts/live.ts"), "utf8")).not.toMatch(/us-east-1/);
    expect(readFileSync(join(ROOT, "scripts/live-harness.ts"), "utf8")).not.toMatch(/us-east-1/);
  });
});

describe("which connection and model a harness check uses", () => {
  const have = (keys: string[], bedrock: boolean): Available => ({ hasKey: (n) => keys.includes(n), bedrock });
  test("Bedrock first, then the provider's key, then OpenRouter; never a plan", () => {
    expect(pickConn("claude-code", have(["ANTHROPIC_API_KEY"], true))).toEqual({ ok: true, conn: "bedrock" });
    expect(pickConn("claude-code", have(["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"], false))).toEqual({ ok: true, conn: "anthropic", key: "ANTHROPIC_API_KEY" });
    expect(pickConn("claude-code", have(["OPENROUTER_API_KEY"], false))).toEqual({ ok: true, conn: "openrouter", key: "OPENROUTER_API_KEY" });
    expect(pickConn("codex", have(["OPENAI_API_KEY"], false))).toMatchObject({ ok: true, conn: "openai" });
    expect(pickConn("antigravity", have(["GEMINI_API_KEY"], true))).toMatchObject({ ok: true, conn: "gemini" });
    expect(pickConn("opencode", have(["OPENROUTER_API_KEY"], true))).toMatchObject({ ok: true, conn: "openrouter" });
  });
  test("a harness with no usable connection is skipped with a reason; Grok Build has none", () => {
    const none = pickConn("antigravity", have([], true));
    expect(none).toMatchObject({ ok: false });
    expect((none as { why: string }).why).toContain("GEMINI_API_KEY");
    expect(pickConn("grok-build", have(["XAI_API_KEY"], true))).toMatchObject({ ok: false, why: expect.stringContaining("no API-key route") });
    expect(pickConn("claude-code", have([], false))).toMatchObject({ ok: false });
  });
  test("--conn picks one; an unusable or unknown one is refused", () => {
    expect(pickConn("claude-code", have(["ANTHROPIC_API_KEY"], true), "anthropic")).toMatchObject({ ok: true, conn: "anthropic" });
    expect(pickConn("claude-code", have([], true), "anthropic")).toMatchObject({ ok: false });
    expect(pickConn("antigravity", have(["GEMINI_API_KEY"], true), "bedrock")).toMatchObject({ ok: false });
  });
  test("the cheapest model of a harness on a connection, by the price table; an opt-in model is never picked alone", () => {
    expect(cheapestModel(DEFAULT_MODELS["claude-code"], "bedrock")?.entry.id).toBe("haiku");
    expect(cheapestModel(DEFAULT_MODELS["claude-code"], "bedrock")?.id).toContain("haiku-5-5");
    expect(cheapestModel(DEFAULT_MODELS.codex, "openai")?.entry.id).toBe("gpt-6-luna");
    expect(cheapestModel(DEFAULT_MODELS.opencode, "openrouter")?.entry.id).toBe("deepseek-flash");
    expect(cheapestModel(DEFAULT_MODELS["kimi-code"], "openrouter")?.entry.id).toBe("kimi-k2.7-code");
    expect(cheapestModel(DEFAULT_MODELS.codex, "gemini")).toBeNull();
    expect(cheapestModel(DEFAULT_MODELS["claude-code"], "bedrock", "Sonnet 5.5")?.entry.id).toBe("sonnet");
    expect(cheapestModel(DEFAULT_MODELS["claude-code"], "bedrock", "nope")).toBeNull();
  });
  test("a check's worst case is its token budget at the model's price; the plan carries the connection's bucket", () => {
    expect(harnessWorstCase("claude-haiku-4-5", "anthropic")).toBeCloseTo((HARNESS_TOKENS.input * 1 + HARNESS_TOKENS.output * 5) / 1e6, 9);
    // Haiku 5.5 at its long-prompt row, the conservative one.
    expect(harnessWorstCase("claude-haiku-5-5", "anthropic")).toBeCloseTo((HARNESS_TOKENS.input * 0.5 + HARNESS_TOKENS.output * 2.5) / 1e6, 9);
    const config = { models: DEFAULT_MODELS } as never;
    const p = planHarness("opencode", config, have(["OPENROUTER_API_KEY"], false), { campaign: true });
    expect(p).toMatchObject({ pick: { ok: true, conn: "openrouter" }, bucket: "openrouter", model: { label: "DeepSeek Flash" } });
    expect(p.worst).toBeGreaterThan(0);
    expect(planHarness("opencode", config, have(["OPENROUTER_API_KEY"], false), { campaign: false }).bucket).toBe("other");
    expect(planHarness("grok-build", config, have([], true)).pick.ok).toBe(false);
  });
  test("each check's Gluon config: the harness on one API-key connection, /clear asks first", () => {
    expect(checkConfig("claude-code", "bedrock", { region: "us-east-2" })).toContain("provider: bedrock");
    expect(checkConfig("claude-code", "bedrock", { region: "us-east-2" })).toContain("region: us-east-2");
    expect(checkConfig("claude-code", "anthropic", { region: "us-east-2" })).not.toContain("bedrock:");
    expect(checkConfig("opencode", "openrouter", { region: null })).toMatch(/providers:\s*\n\s*- openrouter/);
    expect(checkConfig("codex", "openai", { region: null })).toContain("on_clear: ask");
  });
});

describe("reading the screen and the verdict", () => {
  test("Gluon's cost figure on the info row", () => {
    expect(costFigure("claude code × haiku × low · 2m · ~$0.0123 · 4% context · awaiting your input")).toEqual({ usd: 0.0123, approx: true });
    expect(costFigure("codex × gpt-6 luna × high · now · $0.04 · awaiting your input")).toEqual({ usd: 0.04, approx: false });
    expect(costFigure("codex × gpt-6 luna × high · now · <$0.0001")).toEqual({ usd: 0.0001, approx: false });
    expect(costFigure("opencode × x × low · $1.20✓ · done")).toEqual({ usd: 1.2, approx: false });
    expect(costFigure("claude code × haiku × low · now · — · awaiting your input")).toBeNull();
  });
  test("the agent's reply: a line that is just OK, whatever it draws before it", () => {
    expect(saysOK(["", "⏺ OK", ""])).toBe(true);
    expect(saysOK(["│ • OK   │"])).toBe(true);
    expect(saysOK(["OK"])).toBe(true);
    expect(saysOK(["Reply with just OK. Do not read, run or change anything. (claude)", "> OKAY then"])).toBe(false);
  });
  test("BUG-665/live-harness: the proposal's mode is read from the harness's own row, where the mode ends it", () => {
    const rows = (mode: string) => ["  which agent?", "  1. claude code × sonnet 4.6 × low · recommended", `  ❯ 2. codex × gpt-6 luna × low${mode}`, "  3. keep talking"];
    expect(proposalMode(rows(""), "codex")).toBe("build");
    expect(proposalMode(rows(" · explore"), "codex")).toBe("explore");
    expect(proposalMode(rows(" · plan"), "codex")).toBe("plan");
    // Antigravity's explore is its plan mode, and says so: still explore (the whole screen said plan, so one press too many and then build).
    expect(proposalMode(["  ❯ 1. antigravity × gemini 3.8 flash × low · explore (plan mode)"], "antigravity")).toBe("explore");
    // Other rows and other text on screen don't count; no row, no answer.
    expect(proposalMode(["  mode: plan", "  1. claude code × sonnet 4.6 × low · plan", "  ❯ 2. codex × gpt-6 luna × low"], "codex")).toBe("build");
    expect(proposalMode(["  ❯ 1. codex × gpt-6 luna × low · explore · recommended"], "codex")).toBe("explore");
    expect(proposalMode(["  keep talking"], "codex")).toBeNull();
  });
  test("the input-line region and its diff", () => {
    const live = ["", "  ╭────╮", "  │ > │", "  ╰────╯", "  ? for shortcuts", "", ""];
    expect(inputRegion(live, 3)).toEqual(["  │ > │", "  ╰────╯", "  ? for shortcuts"]);
    expect(regionDiff(["a", "b"], ["a", "b"])).toBe("same 2 lines");
    expect(regionDiff(["a", "new"], ["a", "old"])).toMatch(/only live \(1\)[\s\S]*"new"[\s\S]*only fixture \(1\)[\s\S]*"old"/);
  });
  test("PASS / FAIL / SKIP counts, and the exit code: 1 on a FAIL, 2 when only a cap stopped it", () => {
    expect(verdict([{ status: "PASS" }, { status: "SKIP" }], false)).toEqual({ line: "PASS 1 · FAIL 0 · SKIP 1", code: 0 });
    expect(verdict([{ status: "PASS" }, { status: "FAIL" }], false).code).toBe(1);
    expect(verdict([{ status: "PASS" }], true)).toMatchObject({ code: 2 });
    expect(verdict([{ status: "FAIL" }], true).code).toBe(1);
  });
  test("the dry run's lines: each item with its worst case, then the total", () => {
    const items = [
      { section: "probes" as const, what: "probe 1", worst: 0.0004, bucket: "other" as const },
      { section: "probes" as const, what: "probe 2", worst: 0, bucket: "subscription" as const, note: "plan" },
      { section: "real-harness" as const, what: "codex", worst: 0.5, bucket: "bedrock" as const },
    ];
    expect(planTotal(items)).toBeCloseTo(0.5004, 9);
    const lines = planLines(items, 0.25).join("\n");
    expect(lines).toContain("[probes]");
    expect(lines).toContain("[real-harness]");
    expect(lines).toContain("≤ $0.0004");
    expect(lines).toContain("free");
    expect(lines).toContain("Worst case, every item at its maximum: $0.5004");
    expect(lines).toContain("over it in this worst case");
  });
});

describe("a dry run of the script", () => {
  test("--tier=regression --dry-run lists every call with its worst case, calls nothing, writes nothing", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, ".aws"));
      writeFileSync(join(dir, ".aws/config"), "[default]\nregion = us-test-9\n");
      writeFileSync(join(dir, "dev.env"), "ANTHROPIC_API_KEY=sk-ant-not-a-real-key-1234567890\nOPENROUTER_API_KEY=sk-or-not-a-real-key-1234567890\n");
      const ledger = join(dir, "ledger.json");
      const r = Bun.spawnSync([process.execPath, "--no-env-file", "--config=scripts/empty-bunfig.toml", "scripts/live.ts", "--tier=regression", "--dry-run", "--ledger", ledger, "--caps", "bedrock=30,other=10,openrouter=0.5"], {
        cwd: ROOT,
        env: { PATH: process.env.PATH!, HOME: dir, GLUON_DEV_ENV: join(dir, "dev.env"), XDG_STATE_HOME: join(dir, "state"), CLAUDE_CODE_OAUTH_TOKEN: "not-a-real-token", GLUON_LIVE_CHATGPT_PLAN: "1" },
      });
      const text = r.stdout.toString();
      expect(r.exitCode).toBe(0);
      expect(text).not.toContain("not-a-real-token");
      expect(text).toContain("DRY RUN --tier=regression");
      expect(text).toContain("Bedrock region: us-test-9 (the AWS config's [default])");
      expect(text).toContain("keys present in");
      expect(text).toContain("ANTHROPIC_API_KEY, OPENROUTER_API_KEY");
      expect(text).not.toContain("sk-ant-not-a-real-key");
      for (const section of ["[probes]", "[brain-chat]", "[git-tools]", "[nested-instructions]", "[real-harness]"]) expect(text).toContain(section);
      expect(text).toMatch(/openrouter\s+probe 7/);
      expect(text).toContain("Claude plan, charged at API-equivalent (estimated)");
      const total = Number(/Worst case, every item at its maximum: \$(\d+\.\d{4})/.exec(text)?.[1]);
      expect(total).toBeGreaterThan(0);
      // The tier's fixed set fits its $3 cap with headroom, in the worst case.
      expect(total).toBeLessThanOrEqual(2.5);
      expect(text).not.toContain("over it in this worst case");
      expect(existsSync(ledger)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("without the plan token and the opt-in, both plan routes are skipped in the plan, and the run is still within its cap", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "dev.env"), "ANTHROPIC_API_KEY=sk-ant-not-a-real-key\n");
      const r = Bun.spawnSync([process.execPath, "--no-env-file", "--config=scripts/empty-bunfig.toml", "scripts/live.ts", "--tier=regression", "--dry-run", "--ledger", join(dir, "l.json"), "--caps", "bedrock=30,other=10,openrouter=0.5"], {
        cwd: ROOT,
        env: { PATH: process.env.PATH!, HOME: dir, GLUON_DEV_ENV: join(dir, "dev.env"), XDG_STATE_HOME: join(dir, "state") },
      });
      const text = r.stdout.toString();
      expect(r.exitCode).toBe(0);
      expect(text).toMatch(/probe 1\. .*Claude plan.* skipped: not connected \(the Claude plan runs in a scratch HOME/);
      expect(text).toMatch(/probe 2\. .*ChatGPT plan.* skipped: not connected \(the ChatGPT plan uses the real HOME/);
      expect(text).not.toContain("Claude plan, charged at API-equivalent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a bad flag exits 2 with the reason", () => {
    const r = Bun.spawnSync([process.execPath, "--no-env-file", "--config=scripts/empty-bunfig.toml", "scripts/live.ts", "--caps", "bedrock=lots", "--dry-run"], { cwd: ROOT, env: { PATH: process.env.PATH!, HOME: tmpdir() } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("--caps: bedrock=lots is not an amount");
  });
});

describe("--tier=journey: the real brain to an agent's reply, on hard caps", () => {
  test("the tier takes --harness or none; its run cap is one journey's or every harness's; its section is the journey", () => {
    expect(parseArgs(["--tier=journey"])).toMatchObject({ tier: "journey" });
    expect(parseArgs(["--tier=journey", "--harness=codex"])).toMatchObject({ tier: "journey", harness: "codex" });
    expect(() => parseArgs(["--harness=codex"])).toThrow(/--harness goes with/);
    expect(runCapOf({ tier: "journey", harness: "codex" })).toBe(JOURNEY_HARNESS_CAP);
    expect(runCapOf({ tier: "journey" })).toBe(JOURNEY_RUN_CAP);
    expect(sectionsOf({ tier: "journey" })).toEqual(["journey"]);
  });

  test("the caps are small and nest: a journey's brain and agent parts fit its cap; every harness's fits the month's", () => {
    expect(JOURNEY_BRAIN_CAP + JOURNEY_AGENT_CAP).toBeLessThanOrEqual(JOURNEY_HARNESS_CAP);
    expect(JOURNEY_RUN_CAP).toBeLessThanOrEqual(JOURNEY_MONTH_CAP);
    expect(JOURNEY_MONTH_CAP).toBeLessThanOrEqual(5);
  });

  test("the month's journeys: only journey calls, only this calendar month", () => {
    const runs = [
      { at: "2026-10-01T10:00:00Z", calls: [{ what: "journey codex (openrouter)", usd: 0.1 }, { what: "journey codex brain (Haiku)", usd: 0.04 }, { what: "real-harness codex (openrouter)", usd: 0.5 }] },
      { at: "2026-09-30T23:00:00Z", calls: [{ what: "journey codex (openrouter)", usd: 3 }] },
    ];
    expect(journeyMonthSpend(runs, new Date("2026-10-09T00:00:00Z"))).toBeCloseTo(0.14, 6);
  });

  test("whose turn it is, from the screen (the screens of the first live journey): busy, asking or proposing", () => {
    const working = ["   ›  Your call, keep it minimal.", "   ◆  Working (1s · esc to interrupt)", "   › reply to the intake agent"];
    const proposal = ["      ❯ 1. claude code × haiku 5.5 × medium · explore · recommended", "        2. keep talking", "   › reply to the intake agent"];
    // The composer's placeholder is up while the brain works: that is no question (the first journey typed its answer into the proposal).
    expect([brainBusy(working), brainAsks(working), brainProposes(working)]).toEqual([true, false, false]);
    expect([brainBusy(proposal), brainAsks(proposal), brainProposes(proposal)]).toEqual([false, false, true]);
    expect(brainAsks(["   3. type your own answer", "   › reply to the intake agent"])).toBe(true);
    expect(brainAsks(["   ◆  Which file?", "   › reply to the intake agent"])).toBe(true);
    expect([brainAsks(["   › describe the session you want"]), brainProposes(["   › describe the session you want"])]).toEqual([false, false]);
  });

  test("a journey's config puts the brain at the one step it was given", () => {
    const yaml = checkConfig("codex", "openrouter", { region: null }, { route: "anthropic-api", model: "claude-haiku-5-5" });
    expect(yaml).toContain("brain:");
    expect(yaml).toContain("route: anthropic-api");
    expect(checkConfig("codex", "openrouter", { region: null })).not.toContain("brain:");
  });
});
