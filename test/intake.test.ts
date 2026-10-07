import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../src/config.ts";
import { HARNESS_INFO } from "../src/harnesses.ts";
import { allRouteCatalog, launcherLines, optedInBy, readInstructionLine, routeCatalog, routeEnv, unloadedInstructionFiles, withLauncherLines } from "../src/intake.ts";
import { offeredAgents } from "../src/models.ts";
import { repoContext, systemPrompt } from "../src/agent/prompt.ts";
import { defaultRouting } from "../src/routing-config.ts";
import { checkConfig, renderAvailableAgents, route, subagentNote } from "../src/routing.ts";

// Defaults, never the developer's own config.
const config = defaults();
const routing = defaultRouting();
const everything = { ...config, agents: offeredAgents(config, { installed: () => true, demo: true, optedIn: optedInBy(routing) }) };

test("the route catalog is the build's catalog: ids, labels, per-model efforts, families, opt-ins; OpenCode delegates in its family", () => {
  const cat = routeCatalog(everything, everything.agents, routing);
  expect(cat.map((h) => h.id)).toEqual(Object.keys(HARNESS_INFO));
  const model = (h: string, m: string) => cat.find((x) => x.id === h)!.models.find((x) => x.id === m)!;
  expect(cat.find((h) => h.id === "claude-code")).toMatchObject({ name: "Claude Code" });
  expect(model("claude-code", "haiku")).toMatchObject({ name: "Haiku 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" });
  expect(model("claude-code", "sonnet")).toMatchObject({ name: "Sonnet 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" });
  expect(model("opencode", "deepseek-flash")).toMatchObject({ family: "deepseek", current: "deepseek-v4.1-flash", defaultEffort: "max" });
  expect(model("opencode", "muse-spark-1.3-contributor")).toMatchObject({ optIn: "allow_muse_contributor", sharesDataWith: "Meta" });
  expect(cat.filter((h) => h.delegatesInFamily).map((h) => h.id)).toEqual(["opencode"]);
  // Nothing of the connection's ids leaks into routing.
  expect(JSON.stringify(cat)).not.toContain("openrouter");
});

test("route sees only the models Gluon offers (reachable), and only the harnesses connected", () => {
  const offered = { ...config, agents: config.agents.filter((a) => a.harness === "claude-code").map((a) => ({ ...a, models: a.models.filter((m) => m.id !== "opus") })) };
  const cat = routeCatalog(offered, offered.agents, routing);
  expect(cat.map((h) => h.id)).toEqual(["claude-code"]);
  expect(cat[0]!.models.map((m) => m.id)).toEqual(["haiku", "sonnet", "fable"]);
  expect(routeEnv(offered)).toEqual({ connected: ["claude-code"] });
  const out = route(routing, cat, { types: [{ type: "feature", model_steps: 2, effort_steps: 0 }] }, routeEnv(offered));
  // Extra (Opus) isn't offered: rounded up to frontier, Fable.
  expect(out).toMatchObject({ recommended: { harness: "claude-code", model: "fable" } });
  expect(route(routing, cat, { types: [{ type: "feature", model_steps: 0, effort_steps: 0 }], pinned: "codex" }, routeEnv(offered))).toEqual({ error: expect.stringContaining("codex isn't available") });
});

test("an opt-in model stays in the catalog only to explain a pin; routing.yaml's opt-in turns it on", () => {
  const off = routeCatalog({ ...config, agents: offeredAgents(config, { installed: () => true, demo: true }) }, undefined, routing);
  const contributor = off.find((h) => h.id === "opencode")!.models.find((m) => m.id === "muse-spark-1.3-contributor");
  expect(contributor).toBeDefined();
  const env = { connected: off.map((h) => h.id) };
  expect(route(routing, off, { types: [{ type: "feature", model_steps: 0, effort_steps: 0 }], pinned: "opencode/muse-spark-1.3-contributor" }, env)).toEqual({ error: expect.stringContaining("allow_muse_contributor: true") });
  expect(renderAvailableAgents(routing, off, env, allRouteCatalog(config))).toContain("muse-spark-1.3-contributor (Muse Spark 1.3 Contributor): shares data with Meta");
  const on = { ...routing, allow_muse_contributor: true };
  const out = route(on, off, { types: [{ type: "feature", model_steps: 0, effort_steps: 0 }] }, env);
  expect(out).toMatchObject({ recommended: { harness: "opencode", model: "muse-spark-1.3-contributor" } });
});

test("the default routing.yaml names only models of this build, kimi-code's included", () => {
  expect(checkConfig(routing, allRouteCatalog(config))).toEqual([]);
});

// Over the real catalog (`routeCatalog`), everything connected: the default rank's Kimi entries are real models.
const fmt = (a: { harness: string; model: string; effort?: string }) => `${a.harness}/${a.model}${a.effort ? "@" + a.effort : ""}`;
const routed = (input: Parameters<typeof route>[2]) => {
  const cat = routeCatalog(everything, everything.agents, routing);
  const out = route(routing, cat, input, routeEnv(everything));
  return "error" in out ? out.error : `${out.mode} ${fmt(out.recommended)} | ${out.alternatives.map(fmt).join(", ")}`;
};
const call = (type: string, model_steps = 0, effort_steps = 0) => ({ type, model_steps, effort_steps });

test("BUG-462/light on the real catalog: Haiku 5.5 first, then Luna", () => {
  expect(routed({ types: [call("docs")] })).toBe("build claude-code/haiku@medium | codex/gpt-6-luna@high");
});

test("BUG-462/prefer kimi-code on the real catalog: K2.7 Code (no effort) at light, K3 at standard, Haiku when the effort asked is above Kimi's", () => {
  const kimi = { harness: "kimi-code", because: "Prefer Kimi." };
  expect(routed({ types: [call("docs")], ...kimi })).toMatch(/^build kimi-code\/kimi-k2.7-code( |$)/);
  expect(routed({ types: [call("docs", 0, 1)], ...kimi })).toMatch(/^build claude-code\/haiku@high/);
  expect(routed({ types: [call("feature")], ...kimi })).toMatch(/^build kimi-code\/kimi-k3@high/);
});

test("BUG-462/a pin to kimi-code reaches K3 at its default effort, and K2.7 Code refuses an effort", () => {
  expect(routed({ types: [call("debug", 1)], pinned: "kimi-code" })).toMatch(/^build kimi-code\/kimi-k3@high/);
  expect(routed({ types: [call("feature")], pinned: "kimi-code/kimi-k2.7-code@high" })).toBe("kimi-k2.7-code accepts efforts: none");
});

test("BUG-462/the available-agents block lists the Kimi Code models when connected", () => {
  const text = renderAvailableAgents(routing, routeCatalog(everything, everything.agents, routing), routeEnv(everything), allRouteCatalog(config));
  expect(text).toContain("- kimi-code (Kimi Code)\n  models: kimi-k2.7-code (Kimi K2.7 Code)");
  expect(text).toContain("kimi-k3 (Kimi K3)");
});

test("the available-agents block lists what is connected and says why the rest isn't", () => {
  const only = { ...config, agents: config.agents.filter((a) => a.harness === "claude-code" || a.harness === "codex") };
  const text = renderAvailableAgents(routing, routeCatalog(only, only.agents, routing), routeEnv(only), allRouteCatalog(config));
  expect(text).toContain("- claude-code (Claude Code)\n  models: haiku (Haiku 5.5), sonnet (Sonnet 5.5), opus (Opus 5.5), fable");
  expect(text).toContain("- codex (Codex)\n  models: ");
  expect(text).toContain("antigravity (Antigravity): not connected");
  expect(text).not.toContain("never_models");
  expect(text).not.toContain("opencode (OpenCode)\n  models");
});

test("the launcher tells an agent to read the instruction file its harness doesn't load", () => {
  expect(unloadedInstructionFiles("codex", ["AGENTS.md", "CLAUDE.md"])).toEqual(["CLAUDE.md"]);
  expect(unloadedInstructionFiles("codex", ["AGENTS.md"])).toEqual([]);
  expect(unloadedInstructionFiles("codex", ["CLAUDE.md"])).toEqual(["CLAUDE.md"]);
  // Claude Code reads AGENTS.md only in a repository that has no CLAUDE.md.
  expect(unloadedInstructionFiles("claude-code", ["AGENTS.md"])).toEqual([]);
  expect(unloadedInstructionFiles("claude-code", ["CLAUDE.md"])).toEqual([]);
  expect(unloadedInstructionFiles("claude-code", ["AGENTS.md", "CLAUDE.md"])).toEqual(["AGENTS.md"]);
  expect(unloadedInstructionFiles("grok-build", ["AGENTS.md", "CLAUDE.md"])).toEqual([]);
  expect(unloadedInstructionFiles("opencode", ["CLAUDE.md"])).toEqual(["CLAUDE.md"]);
  expect(unloadedInstructionFiles("antigravity", ["CLAUDE.md"])).toEqual(["CLAUDE.md"]);
  // Kimi Code loads AGENTS.md, not CLAUDE.md.
  expect(unloadedInstructionFiles("kimi-code", ["AGENTS.md", "CLAUDE.md"])).toEqual(["CLAUDE.md"]);
  expect(unloadedInstructionFiles("kimi-code", ["AGENTS.md"])).toEqual([]);
  // A harness this build has no row for gets no line.
  expect(unloadedInstructionFiles("nonesuch" as never, ["CLAUDE.md"])).toEqual([]);
  expect(readInstructionLine("CLAUDE.md")).toBe("Read `CLAUDE.md` before you start: it is this project's instructions for coding agents, and your harness doesn't load it.");
});

test("launcher lines: the instruction-file line, and OpenCode's subagent models only when the family has several ranked models", () => {
  const catalog = routeCatalog(everything, everything.agents, routing);
  const lines = (harness: string, model: string, files: string[], r = routing) => launcherLines({ routing: r, catalog, harness: harness as never, model, instructionFiles: files });
  expect(lines("codex", "gpt-6.1-sol", ["AGENTS.md", "CLAUDE.md"])).toEqual([readInstructionLine("CLAUDE.md")]);
  expect(lines("claude-code", "sonnet", ["AGENTS.md"])).toEqual([]);
  // Dormant by default: DeepSeek has one model and Contributor is off.
  expect(lines("opencode", "deepseek-flash", [])).toEqual([]);
  expect(subagentNote(routing, catalog, { harness: "opencode", model: "muse-spark-1.3" })).toBeUndefined();
  // Opted in, the Muse family has two.
  const on = { ...routing, allow_muse_contributor: true };
  const withNote = lines("opencode", "muse-spark-1.3", ["CLAUDE.md"], on);
  expect(withNote).toHaveLength(2);
  expect(withNote[1]).toContain("muse-spark-1.3-contributor");
  expect(withLauncherLines("Do it.\n", withNote)).toBe(`Do it.\n\n${withNote[0]}\n\n${withNote[1]}`);
  expect(withLauncherLines("Do it.", [])).toBe("Do it.");
});

test("BUG-462/the brain's prompt lists the kimi-code models when connected, and says it isn't connected otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "gluon-kimi-prompt-"));
  const on = systemPrompt(everything, repoContext(dir), routing);
  expect(on).toContain("- kimi-code (Kimi Code)\n  models: kimi-k2.7-code (Kimi K2.7 Code)");
  const without = { ...config, agents: config.agents.filter((a) => a.harness === "claude-code") };
  expect(systemPrompt(without, repoContext(dir), routing)).toContain("kimi-code (Kimi Code): not connected");
});

// --- BUG-432/433 on the real catalog (`routeCatalog`): what Kimi Code can't do is never routed to it.

/** Kimi Code connected as given, Codex on its plan: what route sees through the real `routeCatalog`. */
function withKimi(conn: "plan" | "openrouter") {
  const c = { ...defaults(), connections: { "kimi-code": conn === "plan" ? { auth: "subscription" } : { auth: "api", provider: "openrouter" }, codex: { auth: "subscription" } } } as typeof config;
  return { ...c, agents: offeredAgents(c, { installed: () => true, optedIn: optedInBy(routing) }) };
}
const routeOn = (cfg: typeof config, input: Parameters<typeof route>[2], r = routing) => {
  const out = route(r, routeCatalog(cfg, cfg.agents, r), input, routeEnv(cfg));
  return "error" in out ? out.error : `${out.mode} ${fmt(out.recommended)} | ${out.alternatives.map(fmt).join(", ")} | ${out.why.join("; ")}`;
};

test("BUG-433/the real catalog gives Kimi K3 efforts only on the plan: route never picks an effort Kimi can't receive", () => {
  const k3 = (cfg: typeof config) => routeCatalog(cfg, cfg.agents, routing).find((h) => h.id === "kimi-code")!.models.find((m) => m.id === "kimi-k3")!;
  expect(k3(withKimi("openrouter"))).toMatchObject({ efforts: [] });
  expect(k3(withKimi("openrouter"))).not.toHaveProperty("defaultEffort");
  expect(k3(withKimi("plan"))).toMatchObject({ efforts: ["low", "high", "max"], defaultEffort: "high" });
  // Other harnesses keep theirs.
  expect(routeCatalog(withKimi("openrouter"), withKimi("openrouter").agents, routing).find((h) => h.id === "codex")!.models.every((m) => m.efforts.length > 0)).toBe(true);
  // K3 on OpenRouter: chosen (standard level, preferred) with no effort; an effort pin is refused; on the plan it is applied.
  expect(routeOn(withKimi("openrouter"), { types: [call("feature")], harness: "kimi-code", because: "Prefer Kimi." })).toMatch(/^build kimi-code\/kimi-k3 \|/);
  expect(routeOn(withKimi("openrouter"), { types: [call("feature")], pinned: "kimi-code/kimi-k3@high" })).toBe("kimi-k3 accepts efforts: none");
  expect(routeOn(withKimi("openrouter"), { types: [call("feature")], pinned: "kimi-code/kimi-k3" })).toMatch(/^build kimi-code\/kimi-k3 \|/);
  expect(routeOn(withKimi("plan"), { types: [call("feature")], pinned: "kimi-code/kimi-k3@max" })).toMatch(/^build kimi-code\/kimi-k3@max/);
});

test("BUG-432/the real catalog marks Kimi Code as unable to explore; a session in explore never reaches it: not first, not an alternative, not a preference, not a pin; `use:` falls back", () => {
  for (const conn of ["plan", "openrouter"] as const) {
    const cfg = withKimi(conn);
    const cat = routeCatalog(cfg, cfg.agents, routing);
    expect(cat.filter((h) => h.noModes).map((h) => [h.id, h.noModes])).toEqual([["kimi-code", ["explore"]]]);
    // Light, standard and heavy explore, and with Kimi preferred: always another agent.
    for (const model_steps of [-1, 0, 1, 2]) {
      for (const extra of [{}, { harness: "kimi-code", because: "Prefer Kimi." }]) {
        const out = routeOn(cfg, { types: [call("understand", model_steps)], ...extra });
        expect(out).toStartWith("explore ");
        expect(out.split(" | ").slice(0, 2).join(" | ")).not.toContain("kimi-code");
        expect(out).toContain("kimi-code can't run explore mode: left out");
      }
    }
    // Pins by harness or model are refused with the reason; build is fine.
    for (const pinned of ["kimi-code", "kimi-code/kimi-k3", "kimi-code/kimi-k2.7-code"]) {
      expect(routeOn(cfg, { types: [call("understand")], pinned })).toBe("kimi-code can't run explore mode; pick another agent or another mode");
    }
    expect(routeOn(cfg, { types: [call("understand")], pinned: "kimi-code/kimi-k3", mode: "build" })).toStartWith("build kimi-code/kimi-k3");
    // A type's `use:` pin to Kimi in explore is not the developer's word: routed normally, with a why line.
    const useKimi = { ...routing, types: { ...routing.types, understand: { ...routing.types.understand!, use: "kimi-code/kimi-k3" } } };
    const out = routeOn(cfg, { types: [call("understand")] }, useKimi);
    expect(out).toStartWith("explore ");
    expect(out.split(" | ").slice(0, 2).join(" | ")).not.toContain("kimi-code");
    expect(out).toContain("use: kimi-code/kimi-k3 isn't available (kimi-code can't run explore mode");
    // Plan and build still reach it, and the brain's block explains.
    expect(routeOn(cfg, { types: [call("feature")], harness: "kimi-code", because: "Prefer Kimi." })).toMatch(/^build kimi-code\//);
    expect(renderAvailableAgents(routing, cat, routeEnv(cfg), allRouteCatalog(cfg))).toContain("- kimi-code (Kimi Code)\n  models: ");
    expect(renderAvailableAgents(routing, cat, routeEnv(cfg), allRouteCatalog(cfg))).toContain("  can't run explore mode: never route such a session to it");
  }
});

// --- QA pass (brain, offline): the shipped routing against the shipped catalog

test("QA: whatever the default routing.yaml routes to, on the real catalog, is a launch a proposal accepts (every type × steps × mode; nothing connected in the demo, every plan, Bedrock)", async () => {
  const { parseProposal } = await import("../src/agent/choices.ts");
  const subscriptions = Object.fromEntries(Object.entries(HARNESS_INFO).filter(([, i]) => i.subscription).map(([h]) => [h, { auth: "subscription" as const }]));
  const setups: Record<string, { cfg: typeof config; demo: boolean }> = {
    demo: { cfg: config, demo: true },
    "every plan": { cfg: { ...config, connections: subscriptions }, demo: false },
    bedrock: { cfg: { ...config, bedrock: { region: "us-east-1" }, connections: { "claude-code": { auth: "api", provider: "bedrock" }, codex: { auth: "api", provider: "bedrock" } } }, demo: false },
  };
  let routed = 0;
  for (const [name, { cfg, demo }] of Object.entries(setups)) {
    const agents = offeredAgents(cfg, { installed: () => true, demo });
    const c = { ...cfg, agents };
    const catalog = routeCatalog(c, agents, routing);
    for (const type of Object.keys(routing.types)) for (let ms = -2; ms <= 2; ms++) for (let es = 0; es <= 2; es++) for (const mode of [undefined, "explore", "build", "plan"] as const) {
      const out = route(routing, catalog, { types: [{ type, model_steps: ms, effort_steps: es }], ...(mode ? { mode } : {}) }, routeEnv(c));
      if ("error" in out) continue;
      routed++;
      const p = parseProposal(c, { spec: "x" }, { mode: out.mode, recommended: out.recommended as never, alternatives: out.alternatives as never, why: out.why, types: [type] });
      const where = `${name} ${type} ${ms} ${es} ${mode} ${JSON.stringify(out.recommended)}`;
      expect([where, typeof p === "string" ? p : "ok"]).toEqual([where, "ok"]);
      if (typeof p === "string") continue;
      // An alternative that is dropped is one the connection can't serve: in the demo, Kimi K2.7 Code (the plan serves only K3); nowhere else.
      const dropped = out.alternatives.filter((a) => !p.choices.some((x) => x.harness === a.harness && x.model === a.model));
      if (name !== "demo") expect([where, dropped]).toEqual([where, []]);
      else for (const d of dropped) expect(`${d.harness}/${d.model}`).toBe("kimi-code/kimi-k2.7-code");
    }
  }
  expect(routed).toBeGreaterThan(1000);
});
