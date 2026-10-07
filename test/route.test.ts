import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkConfig, levelOf, renderAvailableAgents, route, subagentNote, usableCatalog,
  type Config, type Env, type RouteInput, type TypeCall,
} from "../src/routing.ts";
import { DEFAULT_ROUTING_YAML, loadRouting, parseRouting, RoutingError, routingPath } from "../src/routing-config.ts";
import { ROUTE_CATALOG as CATALOG } from "./fixtures/route-catalog.ts";

const base = parseRouting(DEFAULT_ROUTING_YAML, "routing.yaml");
const cfg = (patch: Partial<Config> = {}): Config => ({ ...base, ...patch });
const r = (input: RouteInput, c = cfg(), env: Env = {}) => {
  const out = route(c, CATALOG, input, env);
  if ("error" in out) return out.error;
  const f = (a: { harness: string; model: string; effort?: string }) =>
    `${a.harness}/${a.model}${a.effort ? "@" + a.effort : ""}`;
  return `${out.mode} ${f(out.recommended)} | ${out.alternatives.map(f).join(", ")}`;
};
const T = (type: string, model_steps = 0, effort_steps = 0, extra: Partial<TypeCall> = {}): TypeCall =>
  ({ type, model_steps, effort_steps, ...extra });
const claudeOnly: Env = { connected: ["claude-code"] };
const limits = (l: Partial<NonNullable<Config["limits"]>>) => cfg({ limits: { ...base.limits, ...l } });

// --- the default rank, everything connected

test("light: Haiku 5.5 first (at its medium default), then Luna", () => {
  expect(r({ types: [T("docs")] })).toBe("build claude-code/haiku@medium | codex/gpt-6-luna@high");
  expect(r({ types: [T("understand")] })).toMatch(/^explore claude-code\/haiku@medium/);
});

test("standard: cheapest first (DeepSeek Flash at its max default, then Gemini 3.8 Flash), then one level down", () => {
  expect(r({ types: [T("feature")] }))
    .toBe("build opencode/deepseek-flash@max | antigravity/gemini-3.8-flash@high, claude-code/haiku@medium");
});

test("strong: Sonnet before Sol", () => {
  expect(r({ types: [T("debug", 1)] }))
    .toBe("build claude-code/sonnet@high | codex/gpt-6.1-sol@medium, opencode/deepseek-flash@max");
});

test("extra: only Opus, at its medium default", () => {
  expect(r({ types: [T("feature", 2, 0, { mode: "plan" })] })).toBe("plan claude-code/opus@medium | claude-code/sonnet@high");
});

test("frontier: Fable before Astra", () => {
  expect(r({ types: [T("research", 2)] }))
    .toBe("explore claude-code/fable@high | codex/gpt-6-astra@medium, claude-code/opus@medium");
});

// --- the intake agent's steps

test("steps are validated", () => {
  expect(r({ types: [T("feature", 3)] })).toBe("feature: model_steps must be an integer from -2 to 2");
  expect(r({ types: [T("feature", 0, -1)] })).toBe("feature: effort_steps must be an integer from 0 to 2");
  expect(r({ types: [T("feature", 0, 0, { mode: "fast" as never })] })).toBe("feature: mode must be explore, build or plan");
  expect(r({ types: [] })).toBe("route needs at least one type");
});

test("lighter steps go down but never below light", () => {
  expect(r({ types: [T("feature", -1)] })).toMatch(/^build claude-code\/haiku@medium/);
  expect(r({ types: [T("docs", -2)] })).toMatch(/^build claude-code\/haiku@medium/);
});

test("several types take the strongest mode, level and effort", () => {
  expect(r({ types: [T("research"), T("feature")] })).toMatch(/^build claude-code\/sonnet@high/);
  expect(r({ types: [T("feature", -1), T("debug", 0, 1)] })).toMatch(/^build opencode\/deepseek-flash@max/);
});

test("the developer's mode overrides the computed one", () => {
  expect(r({ types: [T("feature")], mode: "explore" })).toMatch(/^explore /);
});

test("effort: one step above the model's default, then two", () => {
  expect(r({ types: [T("debug", 1, 1)] })).toMatch(/^build claude-code\/sonnet@xhigh/);
  expect(r({ types: [T("debug", 1, 2)] })).toMatch(/^build claude-code\/sonnet@xhigh/);   // max only when pinned
  expect(r({ types: [T("debug", 1, 1)], pinned: "codex" })).toMatch(/^build codex\/gpt-6.1-sol@high/);
});

test("a model that can't give the effort is skipped for the next one that can", () => {
  const gemini = { harness: "antigravity", because: "Gemini please." };
  expect(r({ types: [T("feature")], ...gemini })).toMatch(/^build antigravity\/gemini-3.8-flash@high/);
  expect(r({ types: [T("feature", 0, 1)], ...gemini })).toMatch(/^build opencode\/deepseek-flash@max/);   // Gemini tops out at high
});

test("Kimi: K2.7 Code has no effort control, so more effort moves on to a model that has it", () => {
  const kimi = { harness: "kimi-code", because: "Prefer Kimi." };
  expect(r({ types: [T("docs")], ...kimi })).toMatch(/^build kimi-code\/kimi-k2.7-code /);
  expect(r({ types: [T("docs", 0, 1)], ...kimi })).toMatch(/^build claude-code\/haiku@high/);
  expect(r({ types: [T("feature")], ...kimi })).toMatch(/^build kimi-code\/kimi-k3@high/);
});

// --- rounding up lowers effort

test("Claude Code only: light → Haiku medium, standard → Sonnet medium, strong → Sonnet high", () => {
  expect(r({ types: [T("docs")] }, cfg(), claudeOnly)).toMatch(/^build claude-code\/haiku@medium/);
  expect(r({ types: [T("feature")] }, cfg(), claudeOnly)).toMatch(/^build claude-code\/sonnet@medium/);
  expect(r({ types: [T("debug", 1)] }, cfg(), claudeOnly)).toMatch(/^build claude-code\/sonnet@high/);
});

test("Bedrock-only (Claude Code + Codex): standard rounds up to strong at one step less effort", () => {
  expect(r({ types: [T("feature")] }, cfg(), { connected: ["claude-code", "codex"] }))
    .toBe("build claude-code/sonnet@medium | codex/gpt-6.1-sol@low, claude-code/haiku@medium");
});

test("nothing connected at or above the level is an error", () => {
  expect(r({ types: [T("research", 2)] }, cfg(), { connected: ["kimi-code"] })).toBe("no connected model at frontier or above");
});

// --- pins and preferences

test("developer pin: kept, no alternatives", () => {
  expect(r({ types: [T("feature")], pinned: "codex" })).toBe("build codex/gpt-6.1-sol@low | ");
  expect(r({ types: [T("feature")], pinned: "claude-code/opus@high" })).toBe("build claude-code/opus@high | ");
});

test("a pinned effort the model doesn't take is refused", () => {
  expect(r({ types: [T("feature")], pinned: "opencode/deepseek-flash@medium" })).toBe("deepseek-flash accepts efforts: low, high, max");
  expect(r({ types: [T("feature")], pinned: "kimi-code/kimi-k2.7-code@high" })).toBe("kimi-k2.7-code accepts efforts: none");
});

test("a named harness with nothing at the level falls back to its best model below", () => {
  expect(r({ types: [T("debug", 1)], pinned: "kimi-code" })).toBe("build kimi-code/kimi-k3@high | ");
});

test("a pin the user hasn't connected is refused", () => {
  expect(r({ types: [T("feature")], pinned: "kimi-code" }, cfg(), { connected: ["claude-code", "codex"] }))
    .toBe("kimi-code isn't available (not connected, or denied in your config)");
});

test("type use: pins apply only when every type shares the same one", () => {
  const types = { ...base.types, feature: { ...base.types.feature!, use: "codex/gpt-6-luna" }, test: { ...base.types.test!, use: "codex/gpt-6-luna" } };
  expect(r({ types: [T("feature"), T("test")] }, cfg({ types }))).toBe("build codex/gpt-6-luna@high | ");
  expect(r({ types: [T("feature"), T("debug")] }, cfg({ types }))).toMatch(/^build opencode\/deepseek-flash@max/);
});

test("preference: a harness's models go first within each level; `because` is required", () => {
  expect(r({ types: [T("feature")], harness: "grok-build", because: "I like Grok." })).toMatch(/^build grok-build\/grok-4.7@high/);
  expect(r({ types: [T("feature")], harness: "grok-build" })).toBe("`harness` comes from a preference: quote the note in `because`");
});

test("maintainer test models never reach users", () => {
  expect(r({ types: [T("feature")], pinned: "codex/gpt-oss-120b" })).toBe("codex/gpt-oss-120b isn't available (unknown, or denied in your config)");
});

// --- limits

test("max_model caps the level", () => {
  expect(r({ types: [T("research", 2)] }, limits({ max_model: "extra" }))).toMatch(/^explore claude-code\/opus@medium/);
  expect(r({ types: [T("feature")], pinned: "codex/gpt-6-astra" }, limits({ max_model: "extra" }))).toBe("gpt-6-astra is above your max_model (extra)");
});

test("max_effort is never crossed", () => {
  expect(r({ types: [T("feature")], pinned: "claude-code/opus@max" }, limits({ max_effort: "high" })))
    .toBe("max is above your max_effort (high)");
  // DeepSeek Flash can only give low under a medium cap, so the next model that has medium is picked
  expect(r({ types: [T("feature")] }, limits({ max_effort: "medium" }))).toMatch(/^build antigravity\/gemini-3.8-flash@medium/);
});

test("max_effort defaults to max, so models whose default is max keep it", () => {
  const { max_effort: _, ...rest } = base.limits!;
  expect(r({ types: [T("feature")], pinned: "opencode/muse-spark-1.3" }, cfg({ limits: rest }))).toMatch(/@max/);
});

test("a denied harness is skipped", () => {
  expect(r({ types: [T("debug", 1)] }, limits({ never_harnesses: ["claude-code"] }))).toMatch(/^build codex\/gpt-6.1-sol@medium/);
});

// --- rank is the user's to edit

test("moving a model between levels changes routing", () => {
  const rank = { ...base.rank, standard: base.rank.standard!.filter((m) => m !== "kimi-code/kimi-k3"), frontier: ["kimi-code/kimi-k3", ...base.rank.frontier!] };
  expect(r({ types: [T("research", 2)] }, cfg({ rank }))).toMatch(/^explore kimi-code\/kimi-k3@high/);
  expect(levelOf(cfg({ rank }), "kimi-code", "kimi-k3")).toBe(4);
  expect(levelOf(cfg({ rank }), "claude-code", "haiku")).toBe(0);
  expect(levelOf(cfg({ rank }), "claude-code", "nothing")).toBe(-1);
});

// --- checkConfig

test("checkConfig: the shipped config is clean; mistakes are flagged", () => {
  expect(checkConfig(base, CATALOG)).toEqual([]);
  const bad = cfg({
    rank: { ...base.rank, light: ["codex/gpt-6-luna", "codex/no-such-model"], extra: ["claude-code/opus", "codex/gpt-6-luna"] },
    types: { ...base.types, feature: { ...base.types.feature!, model: "huge" as never, use: "codex/nope" } },
  });
  expect(checkConfig(bad, CATALOG)).toEqual([
    "rank.light: unknown model codex/no-such-model",
    "rank.extra: codex/gpt-6-luna is already in rank.light",
    "types.feature.model: unknown level huge",
    "types.feature.use: unknown agent codex/nope",
  ]);
});

test("checkConfig: limits, lists, use efforts and unknown levels", () => {
  const bad = cfg({
    rank: { ...base.rank, huge: ["codex/gpt-6-luna"] } as never,
    limits: { never_harnesses: ["codx"], never_models: ["haiku", "opus-9", "codex/gpt-6-luna"], max_model: "giant" as never, max_effort: "ultra" as never },
    prefer: "use codex" as never,
    instructions: ["x"] as never,
    types: { ...base.types, feature: { ...base.types.feature!, use: "codex/gpt-6-luna@max", ask: "scope" as never }, test: { ...base.types.test!, mode: "fast" as never, effort: "nope" as never, use: "codex@fast" } },
  });
  expect(checkConfig(bad, CATALOG)).toEqual([
    "rank: unknown level huge",
    "limits.max_model: unknown level giant",
    "limits.max_effort: unknown effort ultra",
    "limits.never_harnesses: unknown harness codx",
    "limits.never_models: unknown model opus-9",
    "prefer: must be a list of notes",
    "instructions: must be text",
    "types.feature.ask: must be a list",
    "types.feature.use: gpt-6-luna doesn't accept effort max",
    "types.test.mode: unknown mode fast",
    "types.test.effort: unknown effort nope",
    "types.test.use: unknown effort fast",
  ]);
});

test("BUG-440/checkConfig: wrong shapes are reported, never a crash", () => {
  const odd = { rank: "codex/gpt-6-luna", limits: { never_models: "haiku" }, types: { feature: null, debug: "x" } } as never;
  expect(checkConfig(odd, CATALOG)).toEqual([
    "rank: must be a mapping from level to a list of harness/model",
    "limits.never_models: must be a list",
    "types.feature: must be a mapping",
    "types.debug: must be a mapping",
  ]);
  expect(checkConfig({} as never, CATALOG)).toEqual([
    "rank: must be a mapping from level to a list of harness/model",
    "types: must be a mapping from a type's name to its fields",
  ]);
  expect(checkConfig({ ...base, rank: { light: "codex/gpt-6-luna" as never } }, CATALOG)).toEqual(["rank.light: must be a list"]);
});

test("BUG-441/a scalar in a list setting is not matched as a substring, and routing doesn't crash on a missing rank", () => {
  // `never_models: haiku` (no list) used to make "haiku".includes(id) true for any id inside the word.
  const scalar = cfg({ limits: { ...base.limits, never_models: "claude-code/haiku" as never, never_harnesses: "codex" as never } });
  expect(usableCatalog(scalar, CATALOG).find((h) => h.id === "codex")!.models).toHaveLength(3);
  expect(usableCatalog(scalar, CATALOG).find((h) => h.id === "claude-code")!.models.map((m) => m.id)).toContain("haiku");
  expect(r({ types: [T("feature")] }, { ...base, rank: undefined as never })).toBe("no connected model at standard or above");
});

test("BUG-442/a developer mode that isn't one is refused, and so is a config with an unknown limit", () => {
  expect(r({ types: [T("feature")], mode: "fast" as never })).toBe("mode must be explore, build or plan");
  expect(r({ types: [T("feature")] }, limits({ max_model: "giant" as never })))
    .toBe("routing.yaml has an unknown limits.max_model or limits.max_effort; `gluon routing check` says which");
  expect(r({ types: [T("feature")] }, cfg({ types: { feature: { ...base.types.feature!, mode: "fast" as never } } })))
    .toMatch(/^types.feature in routing.yaml has an unknown mode/);
});

// --- Haiku, Muse Contributor, subagents

test("Haiku 5.5 is first in light and denied nothing by default; never_models still takes it out", () => {
  expect(base.rank.light![0]).toBe("claude-code/haiku");
  expect(base.limits?.never_models).toEqual([]);
  expect(r({ types: [T("docs", 0, 1)], pinned: "claude-code/haiku" })).toBe("build claude-code/haiku@high | ");
  expect(r({ types: [T("docs")] }, limits({ never_models: ["haiku"] }))).toBe("build codex/gpt-6-luna@high | kimi-code/kimi-k2.7-code");
  expect(r({ types: [T("docs")], pinned: "claude-code/haiku" }, limits({ never_models: ["haiku"] }))).toBe("claude-code/haiku isn't available (unknown, or denied in your config)");
});

test("Muse Contributor shares data with Meta: off by default, first once allowed, xhigh at most", () => {
  expect(r({ types: [T("feature")], pinned: "opencode/muse-spark-1.3-contributor" }))
    .toBe("muse-spark-1.3-contributor shares data with Meta; set allow_muse_contributor: true in routing.yaml to use it");
  const on = cfg({ allow_muse_contributor: true });
  expect(r({ types: [T("feature")] }, on)).toMatch(/^build opencode\/muse-spark-1.3-contributor@xhigh /);
  expect(r({ types: [T("feature", 0, 1)] }, on)).toMatch(/^build opencode\/muse-spark-1.3-contributor@xhigh /);
});

test("BUG-443/an opted-in model that is denied is not blamed on the opt-in", () => {
  const denied = cfg({ allow_muse_contributor: true, limits: { ...base.limits, never_models: ["muse-spark-1.3-contributor"] } });
  expect(r({ types: [T("feature")], pinned: "opencode/muse-spark-1.3-contributor" }, denied))
    .toBe("opencode/muse-spark-1.3-contributor isn't available (unknown, or denied in your config)");
});

test("subagent note: cheapest first; none for a one-model family or other harnesses", () => {
  const note = (c: Config, harness: string, model: string) => subagentNote(c, CATALOG, { harness, model });
  expect(note(cfg({ allow_muse_contributor: true }), "opencode", "muse-spark-1.3"))
    .toBe("For subagents, you may set the model to one of these, cheapest first: muse-spark-1.3-contributor (everyday subtasks), muse-spark-1.3 (everyday subtasks). Use the cheapest one that fits the subtask; use no other model.");
  expect(note(cfg(), "opencode", "muse-spark-1.3")).toBeUndefined();
  expect(note(cfg(), "opencode", "deepseek-flash")).toBeUndefined();
  expect(note(cfg(), "claude-code", "opus")).toBeUndefined();
});

test("subagent note names the concrete id of a latest alias", () => {
  const rank = { ...base.rank, strong: [...base.rank.strong!, "opencode/muse-spark-1.3-contributor"] };
  const catalog = CATALOG.map((h) => h.id !== "opencode" ? h : { ...h, models: h.models.map((m) => m.id === "deepseek-flash" ? { ...m, family: "muse" } : m) });
  expect(subagentNote(cfg({ rank, allow_muse_contributor: true }), catalog, { harness: "opencode", model: "muse-spark-1.3" }))
    .toContain("deepseek-v4.1-flash (everyday subtasks)");
});

// --- the config itself

test("every type lists the same fields and starts at medium effort", () => {
  const fields = Object.keys(base.types.feature!);
  for (const [name, t] of Object.entries(base.types)) {
    expect(Object.keys(t), name).toEqual(fields);
    expect(t.effort, name).toBe("medium");
  }
  expect(base.types.research!.lighter_model_when).toEqual([]);
});

test("the commented examples in prefer and instructions parse when uncommented", () => {
  let s = DEFAULT_ROUTING_YAML;
  s = s.replace(/^  # (- .*)$/gm, "  $1").replace(/^# instructions: \|\n#   (.*)\n#   (.*)\ninstructions:$/m, "instructions: |\n  $1\n  $2");
  const c = parseRouting(s, "routing.yaml");
  expect(c.prefer).toEqual(["Use codex for test sessions.", "Anything under src/pty is delicate, so go one level stronger."]);
  expect(c.instructions).toContain("Talk to me in Hebrew.");
  expect(checkConfig(c, CATALOG)).toEqual([]);
});

test("run and scaffold are gone", () => {
  expect(r({ types: [T("run")] })).toBe('unknown type "run"; use one from <types>');
  expect(r({ types: [T("scaffold")] })).toBe('unknown type "scaffold"; use one from <types>');
});

test("the default routing.yaml points at gluon --help, not at a command that doesn't exist", () => {
  expect(DEFAULT_ROUTING_YAML).toContain("`gluon --help` lists them");
  expect(DEFAULT_ROUTING_YAML).not.toContain("gluon agents");
});

// --- <available_agents>

test("renderAvailableAgents: the proposal's example (Antigravity not connected, grok-build denied, max_model extra)", () => {
  const out = renderAvailableAgents(
    limits({ never_harnesses: ["grok-build"], max_model: "extra" }),
    CATALOG,
    { connected: ["claude-code", "codex", "kimi-code", "grok-build", "opencode"] },
  );
  expect(out).toBe(`<available_agents>
Harness and model ids are what route's \`pinned\` and \`harness\` take. Names in parentheses are what the developer may call them.
- claude-code (Claude Code)
  models: haiku (Haiku 5.5), sonnet (Sonnet 5.5), opus (Opus 5.5)
- codex (Codex)
  models: gpt-6-luna (GPT-6 Luna), gpt-6.1-sol (GPT-6.1 Sol)
- kimi-code (Kimi Code)
  models: kimi-k2.7-code (Kimi K2.7 Code), kimi-k3 (Kimi K3)
- opencode (OpenCode)
  models: deepseek-flash (DeepSeek Flash, latest), muse-spark-1.3 (Muse Spark 1.3)
Unavailable. If the developer asks for one of these, say why in one sentence and pass nothing:
- grok-build (Grok Build): denied in your config
- antigravity (Antigravity): not connected (\`gluon connect antigravity\`)
- fable (Fable 5.1): above your max_model (extra)
- gpt-6-astra (GPT-6 Astra): above your max_model (extra)
- muse-spark-1.3-contributor (Muse Spark 1.3 Contributor): shares data with Meta; set \`allow_muse_contributor: true\` in routing.yaml
</available_agents>`);
});

test("renderAvailableAgents: nothing unavailable leaves the list out; models in no rank list come last; a name equal to the id is not repeated", () => {
  const catalog = [{ id: "solo", name: "solo", models: [{ id: "b", name: "b", efforts: [] }, { id: "a", name: "A", efforts: [] }, { id: "c", efforts: [] }] }];
  const c = cfg({ rank: { light: ["solo/a"] }, limits: {} });
  expect(renderAvailableAgents(c, catalog)).toBe(`<available_agents>
Harness and model ids are what route's \`pinned\` and \`harness\` take. Names in parentheses are what the developer may call them.
- solo
  models: a (A), b, c
</available_agents>`);
});

test("renderAvailableAgents: opting in lists the opt-in model first among its rank; allCatalog lists what is not connected even if the catalog lacks it", () => {
  const out = renderAvailableAgents(cfg({ allow_muse_contributor: true }), CATALOG.filter((h) => h.id !== "antigravity"), { connected: ["claude-code", "codex", "opencode"] }, CATALOG);
  expect(out).toContain("models: muse-spark-1.3-contributor (Muse Spark 1.3 Contributor), deepseek-flash");
  expect(out).toContain("- antigravity (Antigravity): not connected (`gluon connect antigravity`)");
  expect(out).not.toContain("muse-spark-1.3-contributor (Muse Spark 1.3 Contributor): shares");
});

// --- routing.yaml on disk

let dir: string, savedConfig: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gluon-routing-test-"));
  savedConfig = process.env.GLUON_CONFIG;
  process.env.GLUON_CONFIG = join(dir, "sub", "config.yaml");
});
afterEach(() => {
  if (savedConfig === undefined) delete process.env.GLUON_CONFIG;
  else process.env.GLUON_CONFIG = savedConfig;
});

test("routingPath is routing.yaml next to config.yaml", () => {
  expect(routingPath()).toBe(join(dir, "sub", "routing.yaml"));
  expect(dirname(routingPath())).toBe(dirname(process.env.GLUON_CONFIG!));
});

test("loadRouting: a missing file is written from the embedded default and returned", () => {
  const warnings: string[] = [];
  const c = loadRouting((m) => warnings.push(m));
  expect(existsSync(routingPath())).toBe(true);
  expect(readFileSync(routingPath(), "utf8")).toBe(DEFAULT_ROUTING_YAML);
  expect(c).toEqual(base);
  expect(warnings).toEqual([]);
  if (process.platform !== "win32") expect(statSync(routingPath()).mode & 0o777).toBe(0o600);
  expect(readdirLeftovers(dirname(routingPath()))).toEqual([]);
});

test("loadRouting: an existing file is read, never overwritten", () => {
  mkdirSync(dirname(routingPath()), { recursive: true });
  writeFileSync(routingPath(), "rank:\n  light: [codex/gpt-6-luna]\ntypes: {}\n");
  const c = loadRouting();
  expect(c.rank).toEqual({ light: ["codex/gpt-6-luna"] });
  expect(readFileSync(routingPath(), "utf8")).toBe("rank:\n  light: [codex/gpt-6-luna]\ntypes: {}\n");
});

test("loadRouting: an empty file or one without rank and types gives empty ones", () => {
  mkdirSync(dirname(routingPath()), { recursive: true });
  writeFileSync(routingPath(), "# nothing yet\n");
  expect(loadRouting()).toEqual({ rank: {}, types: {} });
});

test("loadRouting: malformed YAML is an error naming the path and the line", () => {
  mkdirSync(dirname(routingPath()), { recursive: true });
  writeFileSync(routingPath(), "rank:\n  light: [codex/gpt-6-luna\nlimits: {}\n");
  let err: unknown;
  try { loadRouting(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(RoutingError);
  expect((err as Error).message).toMatch(new RegExp(`^${routingPath().replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}:\\d+: not valid YAML: `));
  writeFileSync(routingPath(), "- a\n- b\n");
  expect(() => loadRouting()).toThrow(`${routingPath()}: expected a mapping`);
});

test("loadRouting: a directory Gluon can't write is a warning and the default still applies", () => {
  mkdirSync(join(dir, "sub"), { recursive: true });
  // A file where the directory should be: the write fails on every platform, even as root.
  process.env.GLUON_CONFIG = join(dir, "sub", "config.yaml", "config.yaml");
  writeFileSync(join(dir, "sub", "config.yaml"), "");
  const warnings: string[] = [];
  expect(loadRouting((m) => warnings.push(m))).toEqual(base);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("Using the default routing for this run");
});

test("BUG-444/route with no `types` is an error, not a crash", () => {
  expect(r({} as never)).toBe("route needs at least one type");
  expect(r({ types: "debug" } as never)).toBe("route needs at least one type");
});

test("BUG-445/a type named like an Object property is unknown, not 'in routing.yaml' with a bad mode", () => {
  expect(r({ types: [T("constructor")] })).toBe('unknown type "constructor"; use one from <types>');
  expect(r({ types: [T("__proto__")] })).toBe('unknown type "__proto__"; use one from <types>');
});

test("BUG-446/the subagent note never lists a family model above max_model", () => {
  const rank = { ...base.rank, standard: ["opencode/deepseek-flash", "opencode/muse-spark-1.3"], extra: ["opencode/muse-spark-1.3-contributor"] };
  const open = cfg({ rank, allow_muse_contributor: true });
  const agent = { harness: "opencode", model: "muse-spark-1.3" };
  expect(subagentNote(open, CATALOG, agent)).toContain("muse-spark-1.3-contributor");
  expect(subagentNote({ ...open, limits: { ...base.limits, max_model: "standard" } }, CATALOG, agent)).toBeUndefined();
});

test("BUG-447/a routing.yaml that can't be read is a RoutingError naming the path", () => {
  mkdirSync(routingPath(), { recursive: true });   // a directory where the file should be
  let err: unknown;
  try { loadRouting(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(RoutingError);
  expect((err as Error).message).toStartWith(`${routingPath()}: can't be read`);
});

test("BUG-448/allow_muse_contributor that isn't true or false is flagged, since only `true` turns it on", () => {
  expect(checkConfig(cfg({ allow_muse_contributor: "yes" as never }), CATALOG)).toEqual([expect.stringMatching(/^allow_muse_contributor: must be true or false/)]);
  expect(checkConfig(cfg({ allow_muse_contributor: true }), CATALOG)).toEqual([]);
});

function readdirLeftovers(d: string): string[] {
  return readdirSync(d).filter((f) => f !== "routing.yaml");
}

// --- PR D: routing edge cases found in review

test("BUG-450/harness pin with an effort: the effort is applied, or refused when no model of the harness takes it", () => {
  expect(r({ types: [T("debug", 1)], pinned: "codex@xhigh" })).toBe("build codex/gpt-6.1-sol@xhigh | ");
  expect(r({ types: [T("debug", 1)], pinned: "claude-code@low" })).toMatch(/^build claude-code\/sonnet@low/);
  expect(r({ types: [T("debug", 1)], pinned: "codex@bogus" })).toMatch(/unknown effort bogus/);
  expect(r({ types: [T("debug", 1)], pinned: "antigravity@xhigh" })).toMatch(/effort xhigh/);
  expect(r({ types: [T("debug", 1)], pinned: "codex@max" })).toMatch(/effort max/);
});

test("BUG-451/a preference naming an unavailable harness is dropped and said so, not shown as applied", () => {
  const out = route(cfg(), CATALOG, { types: [T("debug", 1)], harness: "nonesuch", because: "Use nonesuch for debugging." }, {});
  if ("error" in out) throw new Error(out.error);
  expect(out.recommended.harness).toBe("claude-code");
  expect(out.why.join("\n")).toContain('names nonesuch, which isn\'t available; ignored');
  expect(out.why.join("\n")).not.toContain('preference: "Use nonesuch');
  const notConnected = route(cfg(), CATALOG, { types: [T("debug", 1)], harness: "codex", because: "Use codex." }, claudeOnly);
  if ("error" in notConnected) throw new Error(notConnected.error);
  expect(notConnected.why.join("\n")).toContain("codex, which isn't available; ignored");
});

test("BUG-452/a type's use: pin to an unavailable agent falls back to normal routing with a why line", () => {
  const c = cfg({ types: { ...base.types, docs: { ...base.types.docs!, use: "codex/gpt-6-luna@low" } } });
  const ok = route(c, CATALOG, { types: [T("docs")] }, {});
  if ("error" in ok) throw new Error(ok.error);
  expect(ok.recommended).toMatchObject({ harness: "codex", model: "gpt-6-luna", effort: "low" });
  const out = route(c, CATALOG, { types: [T("docs")] }, claudeOnly);
  if ("error" in out) throw new Error(out.error);
  expect(out.recommended.harness).toBe("claude-code");
  expect(out.why.join("\n")).toContain("use: codex/gpt-6-luna@low isn't available");
  expect(out.why.join("\n")).toContain("routing normally");
  // The developer's own pin is still refused.
  expect(route(c, CATALOG, { types: [T("docs")], pinned: "codex/gpt-6-luna" }, claudeOnly)).toHaveProperty("error");
});

test("BUG-453/the available-agents block lists no model route refuses for max_effort", () => {
  const catalog = CATALOG.map((h) => (h.id === "claude-code" ? { ...h, models: [...h.models, { id: "maxonly", name: "Max Only", efforts: ["max" as const], defaultEffort: "max" as const }, { id: "xonly", name: "X Only", efforts: ["xhigh" as const], defaultEffort: "xhigh" as const }] } : h));
  const c = limits({ max_effort: "high" });
  const text = renderAvailableAgents(c, catalog, {});
  expect(text).not.toMatch(/models:.*xonly/);
  expect(text).toContain("xonly (X Only): no effort within your max_effort (high)");
  expect(route(c, catalog, { types: [T("debug")], pinned: "claude-code/xonly" })).toHaveProperty("error");
});

test("BUG-460/a routing.yaml with a non-text use: pin or a type that isn't a mapping doesn't crash route or the prompt; `routing check` says what is wrong", async () => {
  const c = cfg({ types: { ...base.types, docs: { ...base.types.docs!, use: 5 as never }, broken: null as never, text: "hi" as never } });
  const out = route(c, CATALOG, { types: [T("docs")] }, {});
  if ("error" in out) throw new Error(out.error);
  expect(out.why.join("\n")).not.toContain("pinned by every type's use");
  const problems = checkConfig(c, CATALOG).join("\n");
  expect(problems).toContain("types.docs.use: must be");
  expect(problems).toContain("types.broken: must be a mapping");
  const { renderTypes } = await import("../src/agent/prompt.ts");
  const text = renderTypes(c);
  expect(text).toContain("docs\n");
  expect(text).not.toContain("broken");
  expect(renderTypes({ ...c, types: "hello" as never })).toBe("");
});

// --- a harness that can't run a mode (BUG-432: Kimi Code's explore)

const NO_KIMI_EXPLORE = CATALOG.map((h) => (h.id === "kimi-code" ? { ...h, noModes: ["explore" as const] } : h));
const rk = (input: RouteInput, env: Env = {}) => {
  const out = route(cfg(), NO_KIMI_EXPLORE, input, env);
  return "error" in out ? out.error : `${out.mode} ${out.recommended.harness}/${out.recommended.model} | ${out.alternatives.map((a) => `${a.harness}/${a.model}`).join(", ")} | ${out.why.join("; ")}`;
};

test("BUG-432/routing: a session in a mode a harness can't run never goes to it: not the first pick, not an alternative, not a preference or a pin", () => {
  // Light, explore: Kimi K2.7 Code is ranked third in light; it is left out, not an alternative.
  const light = rk({ types: [T("understand")] });
  expect(light).toStartWith("explore claude-code/haiku | codex/gpt-6-luna");
  expect(light).not.toMatch(/\| kimi-code|, kimi-code/);
  expect(light).toContain("kimi-code can't run explore mode: left out");
  // A preference for Kimi in explore falls to the others.
  expect(rk({ types: [T("understand")], harness: "kimi-code", because: "Prefer Kimi." })).toStartWith("explore claude-code/haiku");
  // A pin is refused, by harness or by model.
  expect(rk({ types: [T("understand")], pinned: "kimi-code" })).toBe("kimi-code can't run explore mode; pick another agent or another mode");
  expect(rk({ types: [T("understand")], pinned: "kimi-code/kimi-k3" })).toBe("kimi-code can't run explore mode; pick another agent or another mode");
  // The developer's mode wins over the type's: build with the same pin is fine.
  expect(rk({ types: [T("understand")], pinned: "kimi-code/kimi-k3", mode: "build" })).toStartWith("build kimi-code/kimi-k3");
  // Plan and build still reach it (third in light, so through a preference).
  expect(rk({ types: [T("docs")], harness: "kimi-code", because: "Prefer Kimi." })).toStartWith("build kimi-code/kimi-k2.7-code");
});

test("BUG-432/routing: the intake agent's block says which harness can't run which mode", () => {
  expect(renderAvailableAgents(cfg(), NO_KIMI_EXPLORE, { connected: ["kimi-code"] })).toContain("- kimi-code (Kimi Code)\n  models: kimi-k2.7-code (Kimi K2.7 Code), kimi-k3 (Kimi K3)\n  can't run explore mode: never route such a session to it");
});

// --- QA pass (brain, offline): routing.yaml in odd shapes, pins, limits

/** A YAML alias bomb: nine levels of nine aliases each. */
const ALIAS_BOMB = (() => {
  let text = "a0: &a0 [l, l, l, l, l, l, l, l, l]\n";
  for (let i = 1; i <= 9; i++) text += `a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(", ")}]\n`;
  return `${text}rank: {light: *a9}\ntypes: {}\n`;
})();

test("BUG-645/QA-brain-03: `routing check` flags a key routing.yaml doesn't have (a typo: `limit:` for `limits:`), as it flags a typo in a model name", () => {
  const typo = { ...base, limit: { never_harnesses: ["codex"] } } as unknown as Config;
  // Today: nothing is said, `limits` stays unset and codex is routed to as before; `gluon routing check` prints "ok".
  expect(checkConfig(typo, CATALOG).join("\n")).toContain("limit");
});

test("BUG-646/QA-brain-04: a routing.yaml that is a YAML alias bomb is a RoutingError naming the file, like any other file that can't be used (today: a bare ReferenceError with a stack trace)", () => {
  expect(() => parseRouting(ALIAS_BOMB, "routing.yaml")).toThrow(RoutingError);
});

test("BUG-647/QA-brain-05: a malformed pin is refused, not half-read: `claude-code/sonnet@` (an empty effort) is no agent with effort \"\", and `claude-code/sonnet@max@low` doesn't drop its second effort", () => {
  const empty = route(cfg(), CATALOG, { types: [T("feature")], pinned: "claude-code/sonnet@" });
  if (!("error" in empty)) expect(empty.recommended.effort).not.toBe(""); // refusing it, or the model's own effort, is fine too
  expect(route(cfg(), CATALOG, { types: [T("feature")], pinned: "claude-code/sonnet@max@low" })).toHaveProperty("error");
});

test("BUG-645/variants: a near-miss key is flagged at the top, in limits and in a type, with the key it looks like; the default file and a helper anchor key are not", () => {
  const text = (extra: string) => `${DEFAULT_ROUTING_YAML}\n${extra}\n`;
  expect(checkConfig(parseRouting(DEFAULT_ROUTING_YAML, "r.yaml"), CATALOG)).toEqual([]);
  expect(checkConfig(parseRouting(text("rankk: {}"), "r.yaml"), CATALOG).join("\n")).toContain("rankk: not a key routing.yaml has (it is ignored); did you mean rank?");
  expect(checkConfig({ ...base, limits: { ...base.limits, max_modle: "light" } } as unknown as Config, CATALOG)).toContain("limits.max_modle: not a key routing.yaml has (it is ignored); did you mean max_model?");
  const typo = { ...base, types: { ...base.types, feature: { ...base.types.feature!, modle: "light" } } } as unknown as Config;
  expect(checkConfig(typo, CATALOG).join("\n")).toContain("types.feature.modle: not a key routing.yaml has (it is ignored); did you mean model?");
  expect(checkConfig(parseRouting(text("common: &c light"), "r.yaml"), CATALOG)).toEqual([]);
});

test("BUG-646/variants: the alias bomb's error names the file; a file that reuses an anchor a few times is fine", () => {
  expect(() => parseRouting(ALIAS_BOMB, "my/routing.yaml")).toThrow(/^my\/routing\.yaml: can't be used: Excessive alias count/);
  const reused = `l: &l [codex/gpt-6-luna]\nrank: {light: *l, standard: [], strong: []}\ntypes: {}\n`;
  expect(parseRouting(reused, "r.yaml").rank.light).toEqual(["codex/gpt-6-luna"]);
});

test("BUG-647/variants: a pin with an empty part or a part too many is refused with what a pin looks like; a well-formed one still routes; a bad `use:` is a mistake `routing check` names", () => {
  const refuse = (pinned: string) => r({ types: [T("feature")], pinned });
  for (const bad of ["claude-code/sonnet@", "claude-code@", "claude-code/sonnet@max@low", "claude-code/", "/sonnet", "@high", "claude-code/sonnet/x", "claude-code//sonnet"]) {
    expect([bad, refuse(bad)]).toEqual([bad, `"${bad}" isn't a pin: use harness, harness/model or harness/model@effort`]);
  }
  expect(refuse("claude-code/sonnet@high")).toMatch(/^build claude-code\/sonnet@high/);
  expect(refuse("claude-code/sonnet")).toMatch(/^build claude-code\/sonnet@/);
  const bad = parseRouting(DEFAULT_ROUTING_YAML.replace("  feature:", "  feature:\n    use_: x").replace(/(  feature:[\s\S]*?\n    use:)\s*\n/, "$1 claude-code/sonnet@\n"), "r.yaml");
  expect(checkConfig(bad, CATALOG)).toContain("types.feature.use: must be harness, harness/model or harness/model@effort");
});

test("BUG-648/variants: a merge key brings in the anchor's fields and the local ones win; routing uses the merged type", () => {
  const text = "types:\n  a: &t { means: x, mode: build, model: light, effort: low }\n  b: { <<: *t, mode: plan }\nrank:\n  light: [codex/gpt-6-luna]\n";
  const c = parseRouting(text, "r.yaml");
  expect(c.types.b).toEqual({ means: "x", mode: "plan", model: "light", effort: "low" });
  expect(checkConfig(c, CATALOG)).toEqual([]);
  expect(r({ types: [T("b")] }, c)).toMatch(/^plan codex\/gpt-6-luna@/);
});

test("QA: a routing.yaml that is a scalar, a list, or has a duplicate key is a RoutingError naming the file (and the line, for a YAML mistake); an empty one is an empty config", () => {
  expect(() => parseRouting("hello", "r.yaml")).toThrow(RoutingError);
  expect(() => parseRouting("- a\n- b\n", "r.yaml")).toThrow("r.yaml: expected a mapping");
  expect(() => parseRouting("rank:\n  light: [a/b]\nrank:\n  light: [c/d]\n", "r.yaml")).toThrow(/r\.yaml:3: not valid YAML: Map keys must be unique/);
  for (const empty of ["", "# only a comment\n", "~", "null"]) expect(parseRouting(empty, "r.yaml")).toEqual({ rank: {}, types: {} });
});

test("QA: YAML anchors and aliases work: two types sharing a value, and a rank list reused", () => {
  const text = "x: &lvl light\ntypes:\n  a: { means: x, mode: build, model: *lvl, effort: low }\n  b: { means: y, mode: plan, model: *lvl, effort: low }\nrank:\n  light: [codex/gpt-6-luna]\n";
  const c = parseRouting(text, "r.yaml");
  expect(c.types.b).toMatchObject({ mode: "plan", model: "light", effort: "low" });
  expect(checkConfig(c, CATALOG)).toEqual([]);
  expect(r({ types: [T("b")] }, c)).toMatch(/^plan codex\/gpt-6-luna@/);
});

test("BUG-648/QA-brain-06: a YAML merge key (`<<: *anchor`) in routing.yaml works, or `routing check` says it isn't supported (today the key is read as a literal `<<` field and the check blames `model: unknown level undefined`)", () => {
  const text = "types:\n  a: &t { means: x, mode: build, model: light, effort: low }\n  b: { <<: *t, mode: plan }\nrank:\n  light: [codex/gpt-6-luna]\n";
  const c = parseRouting(text, "r.yaml");
  const problems = checkConfig(c, CATALOG).join("\n");
  expect(c.types.b?.model === "light" || /merge|<</.test(problems)).toBe(true);
});

test("QA: limits that leave nothing give an error that says so, never a throw; the intake agent's block still renders", () => {
  const allHarnesses = CATALOG.map((h) => h.id);
  const allModels = CATALOG.flatMap((h) => h.models.map((m) => m.id));
  const leaving: Record<string, Config> = {
    "every harness denied": limits({ never_harnesses: allHarnesses }),
    "every model denied": limits({ never_models: allModels }),
    "nothing ranked": cfg({ rank: {} }),
    "nothing connected": cfg(),
  };
  for (const [name, c] of Object.entries(leaving)) {
    const env: Env = name === "nothing connected" ? { connected: [] } : {};
    const out = route(c, CATALOG, { types: [T("feature")] }, env);
    expect([name, "error" in out ? out.error : "routed"]).toEqual([name, expect.stringContaining("no connected model at")]);
    expect(renderAvailableAgents(c, CATALOG, env)).toContain("<available_agents>");
  }
  // max_effort below every model's lowest effort leaves only models with no effort control.
  const tight = limits({ max_effort: "low" });
  expect(r({ types: [T("feature")] }, tight)).toMatch(/@low/);
  expect(r({ types: [T("feature")], pinned: "claude-code/sonnet@medium" }, tight)).toBe("medium is above your max_effort (low)");
});

test("QA: pins: a harness that isn't connected, an unknown one, a model of another harness, a wrong case or stray spaces are each refused with the name that was given", () => {
  const only: Env = { connected: ["claude-code"] };
  const refuse = (pinned: string, env: Env = only) => r({ types: [T("feature")], pinned }, cfg(), env);
  expect(refuse("codex@high")).toBe("codex isn't available (not connected, or denied in your config)");
  expect(refuse("codex/gpt-6-luna@low")).toBe("codex isn't available (not connected, or denied in your config)");
  expect(refuse("nonesuch")).toBe("nonesuch isn't available (not connected, or denied in your config)");
  expect(refuse("Claude-Code")).toBe("Claude-Code isn't available (not connected, or denied in your config)");
  expect(refuse(" claude-code")).toContain("isn't available");
  expect(refuse("claude-code/gpt-6-luna")).toBe("claude-code/gpt-6-luna isn't available (unknown, or denied in your config)");
  // A harness alone, with an effort it takes, on the harness that is connected.
  expect(refuse("claude-code@high")).toMatch(/^build claude-code\/sonnet@high/);
});

test("QA: whatever the default routing.yaml and the catalog return is valid: an agent that is connected, not denied, within the limits, with an effort its model takes (every type × steps × mode × limits × connected set)", () => {
  const envs: Env[] = [{}, { connected: ["claude-code"] }, { connected: ["codex", "opencode"] }, { connected: ["kimi-code", "antigravity"] }, { connected: ["grok-build"] }];
  const configs: Config[] = [cfg(), limits({ max_model: "standard" }), limits({ max_effort: "high" }), limits({ max_effort: "low", max_model: "strong" }), limits({ never_harnesses: ["codex"], never_models: ["opencode/deepseek-flash"] })];
  const find = (a: { harness: string; model: string }) => CATALOG.find((h) => h.id === a.harness)?.models.find((m) => m.id === a.model);
  let routed = 0;
  for (const env of envs) for (const c of configs) for (const type of Object.keys(c.types)) for (let ms = -2; ms <= 2; ms++) for (let es = 0; es <= 2; es++) for (const mode of [undefined, "explore", "build", "plan"] as const) {
    const out = route(c, CATALOG, { types: [{ type, model_steps: ms, effort_steps: es }], ...(mode ? { mode } : {}) }, env);
    if ("error" in out) continue;
    routed++;
    const where = `${JSON.stringify(env)} ${JSON.stringify(c.limits)} ${type} ${ms} ${es} ${mode}`;
    const maxEffort = ["low", "medium", "high", "xhigh", "max"].indexOf(c.limits?.max_effort ?? "max");
    for (const a of [out.recommended, ...out.alternatives]) {
      const model = find(a);
      expect([where, a.harness, a.model, !!model]).toEqual([where, a.harness, a.model, true]);
      expect([where, env.connected === undefined || env.connected.includes(a.harness)]).toEqual([where, true]);
      expect(c.limits?.never_harnesses ?? []).not.toContain(a.harness);
      expect(c.limits?.never_models ?? []).not.toContain(`${a.harness}/${a.model}`);
      if (model!.efforts.length) {
        expect([where, a.model, model!.efforts.includes(a.effort!)]).toEqual([where, a.model, true]);
        expect(["low", "medium", "high", "xhigh", "max"].indexOf(a.effort!)).toBeLessThanOrEqual(maxEffort);
      } else expect(a.effort).toBeUndefined();
    }
    expect(out.alternatives.length).toBeLessThanOrEqual(2);
    expect(out.alternatives.some((a) => a.harness === out.recommended.harness && a.model === out.recommended.model)).toBe(false);
    expect(["explore", "build", "plan"]).toContain(out.mode);
    if (mode) expect(out.mode).toBe(mode);
  }
  expect(routed).toBeGreaterThan(1000);
});
