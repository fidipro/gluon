import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cycleEffort, cycleMode, cycleModel, MAX_NAME, nameFromSpec, numberedName, parseProposal, pickChoice, sessionName, slugName, type AgentTriple, type Proposal, type Routed } from "../src/agent/choices.ts";
import { demoClient } from "../src/agent/clients.ts";
import { systemPrompt } from "../src/agent/prompt.ts";
import { TOOLS } from "../src/agent/tools.ts";
import { z } from "zod";
import { join } from "node:path";
import { Session } from "../src/agent/session.ts";
import { defaults } from "../src/config.ts";
import { MAX_SPEC } from "../src/workspaces.ts";

// Defaults, never the developer's own config.
const config = defaults();
const agents = config.agents;
// Kimi on OpenRouter: Kimi K2.7 Code, the model that takes no effort, is offered there (not on the plan).
const kimiOnOpenRouter = { ...config, connections: { "kimi-code": { auth: "api", provider: "openrouter" } } } as typeof config;
// What the intake sends to propose_launch, and what route returned before it.
const main = { reason: "fits", spec: "Fix the flaky launcher test.", types: ["debug"] };
const R: Routed = { mode: "build", recommended: { harness: "claude-code", model: "sonnet", effort: "medium" }, alternatives: [], why: ["debug: build, standard, effort +0", "session: build, strong, effort +0 → claude-code/sonnet@medium"], types: ["debug"] };
const routed = (patch: Partial<Routed>): Routed => ({ ...R, ...patch });

describe("the session name", () => {
  test("is slugged: kebab-case, lowercase, ASCII, at most 24 characters cut at a word", () => {
    expect(slugName("pty-return-flow")).toBe("pty-return-flow");
    expect(slugName("  Flaky Launcher_Test!! ")).toBe("flaky-launcher-test");
    expect(slugName("Café résumé")).toBe("cafe-resume");
    expect(slugName("add a resume flag so a finished session can be reopened")).toBe("add-a-resume-flag-so-a");
    expect(slugName("supercalifragilisticexpialidocious")).toBe("supercalifragilisticexpi");
    for (const raw of ["add a resume flag so a finished session can be reopened", "x".repeat(40), "a-".repeat(30)]) expect(slugName(raw)!.length).toBeLessThanOrEqual(24);
  });

  test("BUG-198/C: starts with Gluon-, capital G, at most 24 characters in all, never prefixed twice", () => {
    expect(sessionName("flaky-launcher")).toBe("Gluon-flaky-launcher");
    // Cut at a word to fit after the prefix.
    expect(sessionName("flaky-launcher-test-fix")).toBe("Gluon-flaky-launcher");
    expect(sessionName("supercalifragilisticexpi")).toBe("Gluon-supercalifragilist");
    // The brain's own `gluon-` slug.
    expect(sessionName("gluon-tab-strip")).toBe("Gluon-tab-strip");
    expect(sessionName("gluon")).toBe("Gluon-session");
    for (const slug of ["a", "x".repeat(24), "add-a-resume-flag-so-a", "gluon-gluon-x"]) {
      expect(sessionName(slug)).toStartWith("Gluon-");
      expect(sessionName(slug).length).toBeLessThanOrEqual(MAX_NAME);
    }
  });

  test("BUG-202/C: strips every leading gluon-, from the brain's slug or the spec's first line", () => {
    expect(sessionName("gluon-gluon-fix")).toBe("Gluon-fix");
    expect(sessionName("Gluon--GLUON-gluon-tabs")).toBe("Gluon-tabs");
    expect(sessionName("gluon-gluon")).toBe("Gluon-session");
    expect(sessionName(nameFromSpec("Gluon gluon tabs"))).toBe("Gluon-tabs");
    // Only a leading one: a gluon later in the slug stays.
    expect(sessionName("fix-gluon-tabs")).toBe("Gluon-fix-gluon-tabs");
  });

  test("BUG-219/C: a name another session has gets -2, then -3 …, still within MAX_NAME", () => {
    expect(numberedName("Gluon-fix-add-bug", [])).toBe("Gluon-fix-add-bug");
    expect(numberedName("Gluon-fix-add-bug", ["Gluon-other"])).toBe("Gluon-fix-add-bug");
    expect(numberedName("Gluon-fix-add-bug", ["Gluon-fix-add-bug"])).toBe("Gluon-fix-add-bug-2");
    expect(numberedName("Gluon-fix-add-bug", ["Gluon-fix-add-bug", "Gluon-fix-add-bug-2"])).toBe("Gluon-fix-add-bug-3");
    // The first free number: one that ended leaves its number free.
    expect(numberedName("Gluon-fix-add-bug", ["Gluon-fix-add-bug", "Gluon-fix-add-bug-3"])).toBe("Gluon-fix-add-bug-2");
    // At the limit, the slug's end makes room (no dash left dangling before the number).
    const full = sessionName("supercalifragilisticexpi");
    expect(full).toHaveLength(MAX_NAME);
    expect(numberedName(full, [full])).toBe("Gluon-supercalifragili-2");
    expect(numberedName("Gluon-flaky-launcher-ab", ["Gluon-flaky-launcher-ab"])).toBe("Gluon-flaky-launcher-2");
    const taken = [full];
    for (let i = 0; i < 12; i++) taken.push(numberedName(full, taken));
    expect(new Set(taken).size).toBe(13);
    for (const n of taken) expect(n.length).toBeLessThanOrEqual(MAX_NAME);
    expect(taken.at(-1)).toBe("Gluon-supercalifragil-13");
  });

  test("is null when nothing is left", () => {
    for (const raw of ["", "  ", "---", "שלום", 42, null, undefined, {}]) expect(slugName(raw)).toBeNull();
  });

  test("falls back to a name from the spec's first line, without filler words, short enough for the prefix", () => {
    expect(nameFromSpec("Fix the flaky launcher test.\n\nMore.")).toBe("fix-flaky-launcher");
    expect(nameFromSpec("\n# Add a resume flag so a finished session can be reopened")).toBe("add-resume-flag");
    expect(nameFromSpec("- **Refactor** `src/pty/proxy.ts` into sessions")).toBe("refactor-src-pty");
    expect(nameFromSpec("תקן את הבאג in parser")).toBe("parser");
    expect(nameFromSpec("Supercalifragilisticexpialidocious words")).toBe("supercalifragilist");
    expect(nameFromSpec("")).toBe("session");
    expect(nameFromSpec("שלום")).toBe("session");
  });
});

describe("propose_launch's input", () => {
  test("the schema takes the intake's fields only: no agent fields; route carries the agents", () => {
    const schema = TOOLS.find((t) => t.name === "propose_launch")!.input_schema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(["name", "spec", "types", "reason"]);
    expect(schema.required).toEqual(["name", "spec", "types", "reason"]);
    const route = TOOLS.find((t) => t.name === "route")!.input_schema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(route.properties)).toEqual(["types", "mode", "pinned", "harness", "because"]);
    expect(route.required).toEqual(["types"]);
  });

  test("the Claude-plan brain's MCP tools (zod from the schemas) take the intake's input and refuse a step out of range", () => {
    // As `subscriptionBrain` builds them: the SDK wraps the shape in an object.
    const zod = (name: string) => z.object((z.fromJSONSchema(TOOLS.find((t) => t.name === name)!.input_schema as never) as z.ZodObject).shape);
    const propose = { ...main, name: "flaky" };
    expect(zod("propose_launch").parse(propose)).toEqual(propose);
    expect(zod("propose_launch").safeParse(main).success).toBe(false); // the name is required
    const call = { types: [{ type: "debug", model_steps: 1, effort_steps: 0, reasons: "unknown cause" }, { type: "test", model_steps: 0, effort_steps: 1 }], pinned: "codex", mode: "plan" };
    expect(zod("route").parse(call)).toEqual(call);
    expect(zod("route").safeParse({ types: [{ type: "debug", model_steps: 3, effort_steps: 0 }] }).success).toBe(false);
    expect(zod("route").safeParse({ types: [{ type: "debug", model_steps: 0, effort_steps: -1 }] }).success).toBe(false);
    expect(zod("route").safeParse({ types: [] }).success).toBe(false);
  });

  test("the proposal is route's: the recommended agent, the alternatives and the mode come from it, the types from the call", () => {
    expect(parseProposal(config, main, R)).toEqual({ name: "Gluon-fix-flaky-launcher", choices: [{ harness: "claude-code", model: "sonnet", effort: "medium" }], spec: main.spec, reason: "fits", types: ["debug"], why: R.why });
    const more = routed({ alternatives: [{ harness: "codex", model: "gpt-6.1-sol", effort: "medium" }], types: ["debug", "test"] });
    const p = parseProposal(config, { ...main, types: ["test", "bogus", 7, "test"] }, more) as Proposal;
    expect(p.choices).toEqual([{ harness: "claude-code", model: "sonnet", effort: "medium" }, { harness: "codex", model: "gpt-6.1-sol", effort: "medium" }]);
    // The input's types are those route was given, once each; none valid: all of route's.
    expect(p.types).toEqual(["test"]);
    expect((parseProposal(config, { ...main, types: ["bogus"] }, more) as Proposal).types).toEqual(["debug", "test"]);
    expect((parseProposal(config, { ...main, types: undefined }, more) as Proposal).types).toEqual(["debug", "test"]);
    // Agent fields in the input are ignored: route decides.
    expect((parseProposal(config, { ...main, harness: "codex", model: "gpt-6-luna", effort: "low", alternatives: [{ harness: "codex", model: "gpt-6-luna", effort: "low" }] }, R) as Proposal).choices).toEqual([R.recommended]);
  });

  test("launch modes: the proposal's mode is route's: explore or plan; build is none; alternatives don't carry one", () => {
    expect(parseProposal(config, main, R)).not.toHaveProperty("mode");
    expect((parseProposal(config, main, routed({ mode: "explore" })) as Proposal).mode).toBe("explore");
    expect((parseProposal(config, main, routed({ mode: "plan" })) as Proposal).mode).toBe("plan");
    // The input's own mode is ignored.
    expect(parseProposal(config, { ...main, mode: "explore" }, R)).not.toHaveProperty("mode");
    expect((parseProposal(config, main, routed({ mode: "plan", alternatives: [{ harness: "codex", model: "gpt-6-luna", effort: "medium" }] })) as Proposal).choices.every((c) => !("mode" in c))).toBe(true);
  });

  test("the intake's prompt says what the spec is, how routing works, and tells each mode's route; the agents come from the block", () => {
    const prompt = systemPrompt(config, { cwd: "/r", isRepo: true, branch: "main", topLevel: [] });
    expect(prompt).toContain("You are Gluon's intake agent");
    expect(prompt).toContain("**Route.** Call route with the types.");
    expect(prompt).toContain("<available_agents>");
    expect(prompt).toContain("<types>\nunderstand\n  means: ");
    expect(prompt).toContain("<instructions>\nnone\n</instructions>");
    expect(prompt).toContain("<preferences>\nnone\n</preferences>");
    expect(prompt).toContain("Path: /r (git, branch main)");
  });

  test("launch modes: pickChoice carries the proposal's mode; an override wins, and build drops it", () => {
    const proposal = parseProposal(config, main, routed({ mode: "explore" })) as Proposal;
    expect(pickChoice(config, proposal)).toMatchObject({ mode: "explore" });
    expect(pickChoice(config, proposal, 0, { mode: "plan" })).toMatchObject({ mode: "plan" });
    expect(pickChoice(config, proposal, 0, { mode: "build" })).not.toHaveProperty("mode");
    expect(pickChoice(config, parseProposal(config, main, R) as Proposal, 0, { mode: "plan" })).toMatchObject({ mode: "plan" });
    expect(pickChoice(config, parseProposal(config, main, R) as Proposal)).not.toHaveProperty("mode");
  });

  test("launch modes: ctrl+t cycles build, explore, plan, build", () => {
    expect(cycleMode(undefined)).toBe("explore");
    expect(cycleMode("build")).toBe("explore");
    expect(cycleMode("explore")).toBe("plan");
    expect(cycleMode("plan")).toBe("build");
  });

  test("BUG-672/F08: ctrl+t skips a mode the harness can't run: on Kimi Code it never lands on explore; an agent that runs every mode cycles as before", () => {
    expect(cycleMode(undefined, "kimi-code")).toBe("plan");
    expect(cycleMode("build", "kimi-code")).toBe("plan");
    expect(cycleMode("plan", "kimi-code")).toBe("build");
    expect(cycleMode("explore", "kimi-code")).toBe("plan");
    for (const m of [undefined, "build", "plan", "explore"] as const) expect(cycleMode(m, "kimi-code")).not.toBe("explore");
    expect(cycleMode("build", "claude-code")).toBe("explore");
    expect(cycleMode("explore", "codex")).toBe("plan");
  });

  test("BUG-198/C: the name is slugged, or derived from the spec when invalid, and starts with Gluon-", () => {
    expect((parseProposal(config, { ...main, name: "Flaky Launcher" }, R) as Proposal).name).toBe("Gluon-flaky-launcher");
    expect((parseProposal(config, { ...main, name: "Flaky Launcher Test" }, R) as Proposal).name).toBe("Gluon-flaky-launcher");
    expect((parseProposal(config, { ...main, name: "Gluon Tabs" }, R) as Proposal).name).toBe("Gluon-tabs");
    expect((parseProposal(config, { ...main, name: "!!!" }, R) as Proposal).name).toBe("Gluon-fix-flaky-launcher");
    expect((parseProposal(config, { ...main, name: 7 }, R) as Proposal).name).toBe("Gluon-fix-flaky-launcher");
  });

  test("a recommended agent that can't be launched is an error, an empty spec too", () => {
    expect(parseProposal(config, main, routed({ recommended: { harness: "pi" as never, model: "x" } }))).toContain('unknown harness "pi"');
    expect(parseProposal(config, main, routed({ recommended: { harness: "claude-code", model: "sonnet" } }))).toContain("needs an effort");
    expect(parseProposal(config, { ...main, spec: " " }, R)).toBe("spec is empty");
  });

  test("alternatives: invalid ones and repeats dropped, at most two kept, in order", () => {
    const p = parseProposal(kimiOnOpenRouter, main, routed({
      alternatives: [
        { harness: "claude-code", model: "sonnet", effort: "medium" }, // the recommended again
        { harness: "codex", model: "sonnet", effort: "low" }, // no such model
        { harness: "opencode", model: "deepseek-flash", effort: "medium" }, // not one of its efforts (low, high, max)
        { harness: "codex", model: "gpt-6-luna" }, // effort missing
        { harness: "codex", model: "gpt-6-luna", effort: "medium" },
        { harness: "codex", model: "gpt-6-luna", effort: "medium" }, // repeat
        { harness: "kimi-code", model: "kimi-k2.7-code" }, // K2.7 Code takes no effort
        { harness: "opencode", model: "deepseek-flash", effort: "high" }, // a third
      ],
    })) as Proposal;
    expect(p.choices).toEqual([
      { harness: "claude-code", model: "sonnet", effort: "medium" },
      { harness: "codex", model: "gpt-6-luna", effort: "medium" },
      { harness: "kimi-code", model: "kimi-k2.7-code" },
    ]);
  });
});

describe("picking an option", () => {
  const proposal = parseProposal(config, { ...main, name: "flaky" }, routed({ alternatives: [{ harness: "codex", model: "gpt-6-luna", effort: "medium" }, { harness: "opencode", model: "deepseek-flash", effort: "max" }] })) as Proposal;

  test("by index, with the shared spec and reason", () => {
    expect(pickChoice(config, proposal)).toEqual({ harness: "claude-code", model: "sonnet", effort: "medium", spec: main.spec, reason: "fits" });
    expect(pickChoice(config, proposal, 1)).toEqual({ harness: "codex", model: "gpt-6-luna", effort: "medium", spec: main.spec, reason: "fits" });
    expect(pickChoice(config, proposal, 2)).toEqual({ harness: "opencode", model: "deepseek-flash", effort: "max", spec: main.spec, reason: "fits" });
    expect(pickChoice(config, proposal, 3)).toBe("no option 4");
  });

  test("an override changes model or effort, validated again for that agent", () => {
    expect(pickChoice(config, proposal, 0, { model: "opus", effort: "high" })).toMatchObject({ harness: "claude-code", model: "opus", effort: "high" });
    expect(pickChoice(config, proposal, 1, { effort: "xhigh" })).toMatchObject({ harness: "codex", model: "gpt-6-luna", effort: "xhigh" });
    expect(pickChoice(config, proposal, 1, { model: "sonnet" })).toContain('has no model "sonnet"');
    expect(pickChoice(config, proposal, 1, { effort: "max" })).toContain('does not take effort "max"');
    // Efforts are the model's: DeepSeek takes low, high, max; Haiku every level (Sonnet's medium carries over); Kimi K2.7 Code none.
    expect(pickChoice(config, proposal, 2, { effort: "medium" })).toContain('does not take effort "medium" (efforts: low, high, max)');
    expect(pickChoice(config, proposal, 0, { model: "haiku" })).toEqual({ harness: "claude-code", model: "haiku", effort: "medium", spec: main.spec, reason: "fits" });
    const kimi = parseProposal(kimiOnOpenRouter, main, routed({ recommended: { harness: "kimi-code", model: "kimi-k3" } })) as Proposal;
    expect(pickChoice(kimiOnOpenRouter, kimi, 0, { model: "kimi-k2.7-code", effort: "high" })).toContain("takes no effort");
    expect(pickChoice(kimiOnOpenRouter, kimi, 0, { model: "kimi-k2.7-code" })).toEqual({ harness: "kimi-code", model: "kimi-k2.7-code", spec: main.spec, reason: "fits" });
    expect(pickChoice(config, proposal, 2, { model: "muse-spark-1.3" })).toMatchObject({ model: "muse-spark-1.3", effort: "max" });
  });
});

describe("Tab adjust", () => {
  const claude: AgentTriple = { harness: "claude-code", model: "sonnet", effort: "medium" };
  const ids = agents.find((a) => a.harness === "claude-code")!.models.map((m) => m.id);

  test("cycleModel moves through the agent's models, both ways, wrapping; the effort stays where the new model takes it, else it is that model's default (a model that takes none: none)", () => {
    expect(ids).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(cycleModel(claude, agents)).toEqual({ ...claude, model: "opus" });
    expect(cycleModel(claude, agents, -1)).toEqual({ ...claude, model: "haiku" });
    expect(cycleModel({ ...claude, model: "fable" }, agents)).toEqual({ ...claude, model: "haiku" });
    expect(cycleModel({ harness: "claude-code", model: "haiku" }, agents, -1)).toEqual({ harness: "claude-code", model: "fable", effort: "high" });
    // Walking all the way round: every Claude model takes medium, so it stays.
    let c = claude;
    for (const _ of ids) c = cycleModel(c, agents);
    expect(c).toEqual(claude);
    // Kimi K2.7 Code takes none: the effort is dropped, and K3 starts at its own default.
    expect(cycleModel({ harness: "kimi-code", model: "kimi-k3", effort: "low" }, agents, -1)).toEqual({ harness: "kimi-code", model: "kimi-k2.7-code" });
    expect(cycleModel({ harness: "kimi-code", model: "kimi-k2.7-code" }, agents)).toEqual({ harness: "kimi-code", model: "kimi-k3", effort: "high" });
    // OpenCode's models take different efforts: kept where the next one has it, else its default.
    const oc = (model: string, effort: AgentTriple["effort"]): AgentTriple => ({ harness: "opencode", model, ...(effort ? { effort } : {}) });
    expect(cycleModel(oc("deepseek-flash", "max"), agents)).toEqual(oc("muse-spark-1.3", "max"));
    expect(cycleModel(oc("muse-spark-1.3", "max"), agents)).toEqual(oc("muse-spark-1.3-contributor", "xhigh"));
    expect(cycleModel(oc("muse-spark-1.3-contributor", "medium"), agents)).toEqual(oc("deepseek-flash", "max"));
    expect(cycleModel(oc("muse-spark-1.3-contributor", "high"), agents)).toEqual(oc("deepseek-flash", "high"));
  });

  test("cycleEffort moves through the model's efforts, wrapping; none for a model that takes none", () => {
    expect(cycleEffort(claude, agents)).toEqual({ ...claude, effort: "high" });
    expect(cycleEffort(claude, agents, -1)).toEqual({ ...claude, effort: "low" });
    expect(cycleEffort({ ...claude, effort: "max" }, agents)).toEqual({ ...claude, effort: "low" });
    expect(cycleEffort({ harness: "claude-code", model: "sonnet" }, agents)).toEqual({ ...claude, effort: "low" });
    const k27 = { harness: "kimi-code" as const, model: "kimi-k2.7-code" };
    expect(cycleEffort(k27, agents)).toEqual(k27);
    // DeepSeek takes low, high, max only.
    const flash = { harness: "opencode" as const, model: "deepseek-flash", effort: "high" as const };
    expect(cycleEffort(flash, agents)).toEqual({ ...flash, effort: "max" });
    expect(cycleEffort({ ...flash, effort: "max" }, agents)).toEqual({ ...flash, effort: "low" });
  });

  test("an agent not offered, or with one model, stays as it is", () => {
    const one = agents.map((a) => (a.harness === "grok-build" ? { ...a, models: a.models.slice(0, 1) } : a));
    const grok = { harness: "grok-build" as const, model: one.find((a) => a.harness === "grok-build")!.models[0]!.id, effort: "low" as const };
    expect(cycleModel(grok, one)).toEqual(grok);
    expect(cycleModel(claude, [])).toEqual(claude);
    expect(cycleEffort(claude, [])).toEqual(claude);
  });

  test("every adjusted option of an offered agent can be picked", () => {
    // The offered agents (`offeredAgents`): here, the Claude plan's own models.
    const offered = { ...config, agents: agents.map((a) => (a.harness === "claude-code" ? { ...a, models: a.models.filter((m) => ["haiku", "sonnet", "opus", "fable"].includes(m.id)) } : a)) };
    const proposal: Proposal = { name: "x", choices: [claude], spec: "s", reason: "r" };
    let c = claude;
    for (let i = 0; i < 20; i++) {
      c = i % 3 ? cycleEffort(c, offered.agents) : cycleModel(c, offered.agents);
      // The way Home passes it: an effort that is now none is an `effort` key set to undefined.
      const picked = pickChoice(offered, proposal, 0, { model: c.model, effort: c.effort });
      expect(picked).toMatchObject({ model: c.model, ...(c.effort ? { effort: c.effort } : {}) });
      expect((picked as { effort?: string }).effort).toBe(c.effort);
    }
  });
});

describe("the demo brain", () => {
  // Its pauses (700 ms a turn) tell nothing here: the demo's test seam (`demoPace`) all but drops them.
  const pace = process.env.GLUON_TEST_DEMO_PACE;
  beforeAll(() => void (process.env.GLUON_TEST_DEMO_PACE = "0.01"));
  afterAll(() => {
    if (pace === undefined) delete process.env.GLUON_TEST_DEMO_PACE;
    else process.env.GLUON_TEST_DEMO_PACE = pace;
  });

  /** A session on the demo brain, through its question, to the proposal; `replies` answer it after that. */
  const play = async (task: string, cfg = config, replies: string[] = []) => {
    const s = new Session(demoClient(), cfg, "sys", join(import.meta.dir, ".."));
    await s.submit(task);
    expect(s.snapshot.pending?.kind).toBe("question");
    await s.submit("Add a regression test");
    for (const reply of replies) await s.submit(reply);
    const pending = s.snapshot.pending;
    if (pending?.kind !== "proposal") throw new Error(`no proposal: ${JSON.stringify(s.snapshot.items.slice(-2))}`);
    return pending;
  };

  test("routes, then proposes a named session with route's alternatives, the recommended one first", async () => {
    const p = await play("Fix the flaky launcher test");
    expect(p.name).toBe("Gluon-fix-flaky-launcher");
    expect(p.choices[0]).toEqual({ harness: "claude-code", model: "sonnet", effort: "high" });
    expect(p.choices).toHaveLength(3);
    expect(new Set(p.choices.map((c) => `${c.harness}/${c.model}/${c.effort}`)).size).toBe(3);
    expect(p.types).toEqual(["feature"]);
    expect(p.why?.at(-1)).toContain("→ claude-code/sonnet@high");
  }, 15_000);

  test("launch modes: explore when the developer asks to understand, plan when they ask for a plan, else none", async () => {
    expect(await play("explain how the launcher picks a model")).toMatchObject({ mode: "explore", types: ["understand"] });
    expect(await play("design the tab strip, plan first")).toMatchObject({ mode: "plan" });
    expect(await play("rename a helper")).not.toHaveProperty("mode");
  }, 15_000);

  test("a reply goes through route again: cheaper is a level lower; with one agent it stays on it", async () => {
    const p = await play("rename a helper", config, ["cheaper please"]);
    expect(p.choices[0]).toMatchObject({ harness: "opencode", model: "deepseek-flash" });
    const only = { ...config, agents: agents.filter((a) => a.harness === "claude-code") };
    const q = await play("rename a helper", only, ["cheaper please"]);
    // Standard has no Claude Code model, so it rounds up to Sonnet; Haiku 5.5, a level down, is the alternative.
    expect(q.choices.map((c) => `${c.harness}/${c.model}`)).toEqual(["claude-code/sonnet", "claude-code/haiku"]);
  }, 15_000);
});

// --- QA pass (brain, offline): propose_launch's input in odd shapes

describe("QA: parseProposal on odd input", () => {
  const ok = (input: Record<string, unknown>, r: Routed = R) => {
    const p = parseProposal(config, input, r);
    if (typeof p === "string") throw new Error(p);
    return p;
  };

  test("a spec that isn't text, or is only blanks, is refused with 'spec is empty'; the agent fields of the input are never read", () => {
    for (const spec of [undefined, null, 5, ["a"], { text: "a" }, "", " \n\t "]) expect(parseProposal(config, { ...main, spec }, R)).toBe("spec is empty");
    const p = ok({ ...main, harness: "codex", model: "gpt-6-astra", effort: "max", mode: "plan", choices: [{ harness: "grok-build", model: "grok-4.7" }] });
    expect(p.choices[0]).toEqual({ harness: "claude-code", model: "sonnet", effort: "medium" });
    expect(p.mode).toBeUndefined();
  });

  test("the route's recommended agent is checked again: an effort a model doesn't take, a missing one, an unknown model or harness are errors that name the problem; a bad alternative is dropped", () => {
    expect(parseProposal(config, main, routed({ recommended: { harness: "claude-code", model: "sonnet" } }))).toContain("needs an effort");
    expect(parseProposal(kimiOnOpenRouter, main, routed({ recommended: { harness: "kimi-code", model: "kimi-k2.7-code", effort: "high" } }))).toContain("takes no effort");
    expect(parseProposal(config, main, routed({ recommended: { harness: "claude-code", model: "nonesuch", effort: "low" } }))).toContain('has no model "nonesuch"');
    expect(parseProposal(config, main, routed({ recommended: { harness: "nonesuch" as never, model: "x" } }))).toContain('unknown harness "nonesuch"');
    const p = ok(main, routed({ alternatives: [{ harness: "codex", model: "nonesuch", effort: "low" }, { harness: "codex", model: "gpt-6.1-sol", effort: "medium" }, { harness: "codex", model: "gpt-6.1-sol", effort: "medium" }] }));
    expect(p.choices.map((c) => `${c.harness}/${c.model}`)).toEqual(["claude-code/sonnet", "codex/gpt-6.1-sol"]);
  });

  test("a missing reason is kept empty; a reason that isn't text too; the name falls back to the spec, then to 'session'; types the route wasn't given are dropped", () => {
    expect(ok({ spec: "Fix the flaky launcher test." }).reason).toBe("");
    expect(ok({ spec: "Fix the flaky launcher test.", reason: 5 }).reason).toBe("");
    expect(ok({ spec: "Fix the flaky launcher test.", name: { a: 1 } }).name).toBe("Gluon-fix-flaky-launcher");
    expect(ok({ spec: "!!!", name: "🚀" }).name).toBe("Gluon-session");
    expect(ok({ ...main, types: ["nonesuch", "debug", "debug"] }).types).toEqual(["debug"]);
    expect(ok({ ...main, types: "debug" }).types).toEqual(R.types);
  });

  test("BUG-639/QA-brain-12: a spec too big to be saved with its session (the workspace file drops a spec over 1 000 000 characters) is refused when proposed, not launched into a session that can't be resumed", () => {
    const p = parseProposal(config, { ...main, spec: "x".repeat(1_000_001) }, R);
    expect(typeof p).toBe("string");
    expect(p).toContain("1,000,001 characters");
  });

  test("BUG-639/variants: a spec of exactly the saved limit is proposed; the limit is the workspace reader's own", () => {
    expect(typeof parseProposal(config, { ...main, spec: "x".repeat(MAX_SPEC) }, R)).toBe("object");
    expect(typeof parseProposal(config, { ...main, spec: ` ${"x".repeat(MAX_SPEC)} ` }, R)).toBe("object");
  });
});
