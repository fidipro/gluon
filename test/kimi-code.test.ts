/**
 * Kimi Code, the sixth harness: its catalog, argv and environment per mode and connection (OpenRouter's
 * environment model; the Kimi Code plan through `kimi login`), the brief that is typed because Kimi takes no prompt in argv,
 * explore (unavailable: BUG-432) and the effort (the plan's only: BUG-433), the plan's sign-in read from `kimi provider list`, and what is deliberately absent (resume, a figure of ours).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { adapterOutput } from "../src/adapters/index.ts";
import { cycleEffort, cycleModel, parseProposal, pickChoice, type Proposal, type Routed } from "../src/agent/choices.ts";
import { systemPrompt } from "../src/agent/prompt.ts";
import { defaults, type Config } from "../src/config.ts";
import { handoffDefaults, handoffFor } from "../src/handoff.ts";
import { DEFAULT_MODELS, effortsOn, HARNESS_INFO, installHint, installMethods, isPlanConn, subscriptionOf } from "../src/harnesses.ts";
import { installDirs, installArgv } from "../src/install.ts";
import { assertSafeEnv, buildCommand, handOff, handOffSession, launchPlan, launchProblem, typedModeProblem, validateChoice, type LaunchChoice } from "../src/launchers.ts";
import { offeredAgents, resolveModel, unservedModel } from "../src/models.ts";
import { ownWindow } from "../src/cost/context.ts";
import { priceKey } from "../src/cost/keys.ts";
import { kimiPriceKey } from "../src/cost/kimi.ts";
import { priceEntry } from "../src/cost/tables.ts";
import { maskSecrets } from "../src/secrets.ts";
import { kimiPlanStatus,loginStatus, parseKimiProviders } from "../src/status.ts";
import { fakeAgents } from "./e2e/fixtures.ts";

const saved = { path: process.env.PATH, key: process.env.OPENROUTER_API_KEY, moonshot: process.env.MOONSHOT_API_KEY };
const FAKES = ["FAKE_KIMI_LOGGED_OUT", "FAKE_KIMI_STATE", "FAKE_KIMI_LIST_ODD"];
const TMP = mkdtempSync(join(tmpdir(), "gluon-kimi-"));
beforeAll(() => {
  process.env.PATH = `${fakeAgents(["kimi"])}${delimiter}${saved.path}`;
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test-0123456789abcdef";
  process.env.MOONSHOT_API_KEY = "sk-moonshot-test-0123456789abcdef";
});
afterAll(() => {
  process.env.PATH = saved.path;
  if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = saved.key;
  if (saved.moonshot === undefined) delete process.env.MOONSHOT_API_KEY;
  else process.env.MOONSHOT_API_KEY = saved.moonshot;
  for (const k of FAKES) delete process.env[k];
  rmSync(TMP, { recursive: true, force: true });
});

const on = (conn: "plan" | "openrouter" | "moonshot"): Config => ({ ...defaults(), connections: { "kimi-code": conn === "plan" ? { auth: "subscription" } : { auth: "api", provider: conn } } }) as Config;
const choice = (model: string, over: Partial<LaunchChoice> = {}): LaunchChoice => ({ harness: "kimi-code", model, spec: "- fix the bug", reason: "", ...over });

describe("the harness", () => {
  const info = HARNESS_INFO["kimi-code"];

  test("the binary `kimi`, Moonshot's installers verbatim, AGENTS.md (not CLAUDE.md), no prompt in argv", () => {
    expect(info).toMatchObject({ binary: "kimi", vendor: "Moonshot AI", typedSpec: true });
    expect(info.instructionFiles).toEqual({ files: ["AGENTS.md"] });
    expect(installMethods("kimi-code", "linux").map((m) => m.command)).toEqual(["curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"]);
    expect(installMethods("kimi-code", "win32").map((m) => m.command)).toEqual(["irm https://code.kimi.com/kimi-code/install.ps1 | iex"]);
    expect(installHint("kimi-code", "darwin")).toBe("curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash");
    // The installer's limits are said where it is offered: glibc only (no Alpine), a shell-profile edit, the legacy shim rename.
    const [posix] = installMethods("kimi-code", "linux");
    expect(posix!.note).toMatch(/glibc.*Alpine \(musl\)/);
    expect(posix!.note).toMatch(/shell profile/);
    expect(posix!.note).toMatch(/kimi-legacy/);
    expect(installMethods("kimi-code", "win32")[0]!.note).toMatch(/Git for Windows/);
    // `bash` on POSIX, Windows PowerShell on Windows; never an npm route.
    expect(installMethods("kimi-code", "linux").flatMap((m) => m.needs)).toEqual(["curl", "bash"]);
    expect(installMethods("kimi-code", "win32").flatMap((m) => m.needs)).toEqual(["powershell"]);
  });

  test("where the installer puts it: ~/.kimi-code/bin, or $KIMI_INSTALL_DIR/bin", () => {
    expect(installDirs("kimi-code", { platform: "linux", env: {}, home: "/home/u" })).toEqual(["/home/u/.kimi-code/bin"]);
    expect(installDirs("kimi-code", { platform: "linux", env: { KIMI_INSTALL_DIR: "/opt/k" }, home: "/home/u" })).toEqual(["/opt/k/bin"]);
    expect(installDirs("kimi-code", { platform: "win32", env: { USERPROFILE: "C:\\Users\\u" }, home: "x" })).toEqual(["C:\\Users\\u\\.kimi-code\\bin"]);
  });

  // `sh` is looked up on the host's PATH: a Windows host has none (the installer there is PowerShell).
  test.skipIf(process.platform === "win32")("the install argv is the constant, run as it is", () => {
    const [m] = installMethods("kimi-code", "linux");
    const argv = installArgv(m!, { platform: "linux" });
    expect(argv?.slice(1)).toEqual(["-c", m!.command]);
  });

  test("two models: K2.7 Code (no effort) and K3 (low, high, max; high by default); each with its id per connection", () => {
    const [k27, k3] = DEFAULT_MODELS["kimi-code"];
    expect(k27).toMatchObject({ id: "kimi-k2.7-code", efforts: [], ids: { moonshot: "kimi-k2.7-code", openrouter: "moonshotai/kimi-k2.7-code" } });
    expect(k27!.defaultEffort).toBeUndefined();
    expect(k3).toMatchObject({ id: "kimi-k3", efforts: ["low", "high", "max"], defaultEffort: "high", ids: { plan: "k3", moonshot: "kimi-k3", openrouter: "moonshotai/kimi-k3" } });
    // K2.7 Code is not on the plan (its plan ids are K3, K2.8 Preview and a HighSpeed variant): never offered there.
    expect(k27!.ids.plan).toBeUndefined();
    expect(unservedModel(on("plan"), "kimi-code", "kimi-k2.7-code")).toBe("kimi-k2.7-code isn't available on Kimi Code's Kimi Code plan (models: kimi-k3)");
    expect(validateChoice(on("plan"), choice("kimi-k2.7-code"))).toContain("isn't available");
    expect(validateChoice(on("openrouter"), choice("kimi-k2.7-code"))).toBeNull();
    expect(validateChoice(on("moonshot"), choice("kimi-k2.7-code"))).toBeNull();
  });

  test("efforts belong to the model: K3 takes low, high, max on the plan; K2.7 Code takes none", () => {
    const config = on("plan");
    expect(validateChoice(config, choice("kimi-k3", { effort: "max" }))).toBeNull();
    expect(validateChoice(config, choice("kimi-k3", { effort: "medium" }))).toContain('does not take effort "medium"');
    expect(validateChoice(on("openrouter"), choice("kimi-k2.7-code", { effort: "low" }))).toContain("takes no effort");
  });

  test("BUG-433/K3 takes no effort over OpenRouter: Kimi's effort variable reaches only its own provider, an OpenRouter one (type openai) ignores it", () => {
    const config = on("openrouter");
    expect(validateChoice(config, choice("kimi-k3"))).toBeNull();
    expect(validateChoice(config, choice("kimi-k3"), { requireEffort: true })).toBeNull();
    expect(validateChoice(config, choice("kimi-k3", { effort: "low" }))).toBe("Kimi Code's kimi-k3 takes no effort; omit it");
    expect(validateChoice(on("plan"), choice("kimi-k3", { effort: "low" }))).toBeNull();
    // Offered to the brain and the UI's Tab without efforts there, with them on the plan.
    const model = (conn: "plan" | "openrouter") => offeredAgents(on(conn), { installed: () => true }).find((a) => a.harness === "kimi-code")!.models.find((m) => m.id === "kimi-k3")!;
    expect(model("openrouter")).toMatchObject({ efforts: [] });
    expect(model("openrouter").defaultEffort).toBeUndefined();
    expect(model("plan")).toMatchObject({ efforts: ["low", "high", "max"], defaultEffort: "high" });
    expect(effortsOn(DEFAULT_MODELS["kimi-code"][1]!, "openrouter")).toEqual([]);
    expect(effortsOn(DEFAULT_MODELS["kimi-code"][1]!, "plan")).toEqual(["low", "high", "max"]);
    // Every other model keeps its efforts on every connection.
    for (const h of Object.keys(DEFAULT_MODELS) as (keyof typeof DEFAULT_MODELS)[]) for (const m of DEFAULT_MODELS[h]) if (m.id !== "kimi-k3") expect([h, m.id, m.effortConns]).toEqual([h, m.id, undefined]);
  });

  test("BUG-433/the proposal's Tab (`cycleEffort`, `cycleModel`) over the offered agents: K3's effort cycles on the plan only, and a model picked by Tab starts without one over OpenRouter", () => {
    const agents = (conn: "plan" | "openrouter") => offeredAgents(on(conn), { installed: () => true });
    const k3 = { harness: "kimi-code", model: "kimi-k3", effort: "high" } as const;
    expect(cycleEffort(k3, agents("plan")).effort).toBe("max");
    expect(cycleEffort(cycleEffort(k3, agents("plan")), agents("plan")).effort).toBe("low");
    expect(cycleEffort({ harness: "kimi-code", model: "kimi-k3" }, agents("openrouter"))).toEqual({ harness: "kimi-code", model: "kimi-k3" });
    expect(cycleModel({ harness: "kimi-code", model: "kimi-k2.7-code" }, agents("openrouter"))).toEqual({ harness: "kimi-code", model: "kimi-k3" });
    expect(cycleModel({ harness: "kimi-code", model: "kimi-k2.7-code" }, agents("openrouter")).effort).toBeUndefined();
  });

  test("the plan is a subscription (personal use, `kimi login`); a Moonshot or an OpenRouter key are the key providers (the vendor's own first)", () => {
    expect(info.providers).toEqual(["moonshot", "openrouter"]);
    expect(isPlanConn("plan")).toBe(true);
    expect(subscriptionOf("kimi-code", "plan")).toMatchObject({ vendor: "moonshot", plan: "Kimi Code plan", loginArgv: ["kimi", "login"] });
  });

  test("every offered model has a price key, a price and a window; the plan is priced as Moonshot's API price of the same model (an API-equivalent), OpenRouter's at its listing", () => {
    for (const m of DEFAULT_MODELS["kimi-code"]) {
      for (const conn of Object.keys(m.ids) as ("plan" | "openrouter" | "moonshot")[]) {
        const key = priceKey("kimi-code", m.ids, conn);
        expect([m.id, conn, key !== undefined && priceEntry(key) !== undefined]).toEqual([m.id, conn, true]);
      }
      expect(ownWindow("kimi-code", m.id).window).toBe(priceEntry(priceKey("kimi-code", m.ids, "openrouter"))!.context!);
    }
    expect(priceKey("kimi-code", DEFAULT_MODELS["kimi-code"][1]!.ids, "plan")).toBe("moonshotai/kimi-k3");
    // Moonshot's own API: the models.dev `moonshotai` provider, the model's own id (the same key the plan is priced by).
    expect(priceKey("kimi-code", DEFAULT_MODELS["kimi-code"][1]!.ids, "moonshot")).toBe("moonshotai/kimi-k3");
    expect(priceKey("kimi-code", DEFAULT_MODELS["kimi-code"][0]!.ids, "moonshot")).toBe("moonshotai/kimi-k2.7-code");
    expect(kimiPriceKey("kimi-k3", "moonshot")).toEqual({ key: "moonshotai/kimi-k3", known: true });
    expect(kimiPriceKey("kimi-k2.7-code", "moonshot")).toEqual({ key: "moonshotai/kimi-k2.7-code", known: true });
    expect(ownWindow("kimi-code", "moonshotai/kimi-k3")).toEqual({ window: 1_048_576, source: "kimi-models-dev" });
    expect(ownWindow("kimi-code", "k3").window).toBe(1_048_576);
    expect(ownWindow("kimi-code", "no-such-model").window).toBeUndefined();
  });

  test("no resume: Kimi can't be given a session id and has no hook that reports one", () => {
    expect(info.resume).toBeUndefined();
    expect(() => buildCommand(on("openrouter"), choice("kimi-k3"), undefined, { id: "11111111-2222-4333-8444-555555555555", resume: true })).toThrow("Kimi Code can't resume a session");
  });
});

describe("the launch: OpenRouter", () => {
  test("Kimi's environment model: its own variable names, OpenRouter's endpoint, the model's id and window; the key is the only secret and no OPENROUTER_API_KEY is passed", () => {
    const cmd = buildCommand(on("openrouter"), choice("kimi-k3"));
    expect(cmd.env).toEqual({
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_MODEL_PROVIDER_TYPE: "openai",
      KIMI_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      KIMI_MODEL_API_KEY: "sk-or-v1-test-0123456789abcdef",
      KIMI_MODEL_NAME: "moonshotai/kimi-k3",
      KIMI_MODEL_MAX_CONTEXT_SIZE: "1048576",
    });
    // No model flag: the environment model is the default; no spec in argv.
    expect(cmd.argv).toEqual(["kimi"]);
    expect(cmd.conn).toBe("openrouter");
    expect(cmd.resumed).toBeUndefined();
  });

  test("BUG-433/no effort variable over OpenRouter, even for a caller that names one: it would do nothing there", () => {
    expect(buildCommand(on("openrouter"), choice("kimi-k3", { effort: "max" })).env.KIMI_MODEL_THINKING_EFFORT).toBeUndefined();
  });

  test("K2.7 Code: its own id and window, no effort variable", () => {
    const env = buildCommand(on("openrouter"), choice("kimi-k2.7-code")).env;
    expect(env.KIMI_MODEL_NAME).toBe("moonshotai/kimi-k2.7-code");
    expect(env.KIMI_MODEL_MAX_CONTEXT_SIZE).toBe("262144");
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBeUndefined();
  });

  test("without a key Kimi is given none (the launch problem says so first)", () => {
    const key = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(buildCommand(on("openrouter"), choice("kimi-k3")).env.KIMI_MODEL_API_KEY).toBeUndefined();
      expect(launchProblem(on("openrouter"), "kimi-code")).toContain("OPENROUTER_API_KEY isn't set");
    } finally {
      process.env.OPENROUTER_API_KEY = key;
    }
  });
});

describe("the launch: Moonshot's own API (issue #107)", () => {
  test("BUG-700/Kimi's environment model with Moonshot's key: no base URL (the default is Moonshot's global API), type `kimi` pinned, the model's own id and window; the key is the only secret", () => {
    const cmd = buildCommand(on("moonshot"), choice("kimi-k3"));
    expect(cmd.env).toEqual({
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_MODEL_PROVIDER_TYPE: "kimi",
      KIMI_MODEL_API_KEY: "sk-moonshot-test-0123456789abcdef",
      KIMI_MODEL_NAME: "kimi-k3",
      KIMI_MODEL_MAX_CONTEXT_SIZE: "1048576",
    });
    expect(Object.keys(cmd.env).filter((k) => /_BASE_URL$|_API_BASE$/.test(k))).toEqual([]);
    expect(cmd.argv).toEqual(["kimi"]);
    expect(cmd.conn).toBe("moonshot");
    // Never the other provider's key, nor Moonshot's under its own name.
    expect(cmd.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(cmd.env.MOONSHOT_API_KEY).toBeUndefined();
    expect(Object.values(cmd.env)).not.toContain(process.env.OPENROUTER_API_KEY);
    // And OpenRouter's launch never carries Moonshot's.
    expect(Object.values(buildCommand(on("openrouter"), choice("kimi-k3")).env)).not.toContain(process.env.MOONSHOT_API_KEY);
  });

  test("K2.7 Code is served on Moonshot's key too (the plan has none): its own id and window", () => {
    const env = buildCommand(on("moonshot"), choice("kimi-k2.7-code")).env;
    expect(env.KIMI_MODEL_NAME).toBe("kimi-k2.7-code");
    expect(env.KIMI_MODEL_MAX_CONTEXT_SIZE).toBe("262144");
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBeUndefined();
  });

  test("BUG-701/no effort on Moonshot's key either (same as OpenRouter's: K3's effort is the plan's alone), even for a caller that names one", () => {
    expect(buildCommand(on("moonshot"), choice("kimi-k3", { effort: "max" })).env.KIMI_MODEL_THINKING_EFFORT).toBeUndefined();
    expect(validateChoice(on("moonshot"), choice("kimi-k3"))).toBeNull();
    expect(validateChoice(on("moonshot"), choice("kimi-k3", { effort: "low" }))).toBe("Kimi Code's kimi-k3 takes no effort; omit it");
    expect(effortsOn(DEFAULT_MODELS["kimi-code"][1]!, "moonshot")).toEqual([]);
  });

  test("without a key Kimi is given none (the launch problem says so first, naming Moonshot's variable)", () => {
    const key = process.env.MOONSHOT_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    try {
      expect(buildCommand(on("moonshot"), choice("kimi-k3")).env.KIMI_MODEL_API_KEY).toBeUndefined();
      expect(launchProblem(on("moonshot"), "kimi-code")).toContain("MOONSHOT_API_KEY isn't set");
    } finally {
      process.env.MOONSHOT_API_KEY = key;
    }
  });

  test("BUG-703/a Moonshot key is masked wherever Gluon prints a launch, whatever its shape (Kimi's own variable name too)", () => {
    const shaped = process.env.MOONSHOT_API_KEY!;
    const plain = "plainMoonshotKeyNoKnownShape42";
    process.env.MOONSHOT_API_KEY = plain;
    try {
      expect(maskSecrets(`KIMI_MODEL_API_KEY=${plain} and ${shaped}`)).not.toContain(plain);
      expect(maskSecrets(`KIMI_MODEL_API_KEY=${plain} and ${shaped}`)).not.toContain(shaped);
    } finally {
      process.env.MOONSHOT_API_KEY = shaped;
    }
  });

  test("a model is resolved to its id on the connection configured: Moonshot's own, not OpenRouter's `moonshotai/…`", () => {
    expect(resolveModel(on("moonshot"), "kimi-code", "kimi-k3")).toEqual({ conn: "moonshot", id: "kimi-k3" });
    expect(resolveModel(on("openrouter"), "kimi-code", "kimi-k3")).toEqual({ conn: "openrouter", id: "moonshotai/kimi-k3" });
  });
});

describe("the launch: the Kimi Code plan", () => {
  test("the model by Kimi's alias (`kimi-code/k3`), no key, no URL: only the auto-update switch and the effort", () => {
    const cmd = buildCommand(on("plan"), choice("kimi-k3", { effort: "low" }));
    expect(cmd.argv).toEqual(["kimi", "-m", "kimi-code/k3"]);
    expect(cmd.env).toEqual({ KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_MODEL_THINKING_EFFORT: "low" });
    expect(buildCommand(on("plan"), choice("kimi-k3")).env).toEqual({ KIMI_CODE_NO_AUTO_UPDATE: "1" });
    expect(cmd.conn).toBe("plan");
    // Not connected at all: a harness with a subscription runs on its own login.
    expect(resolveModel(defaults(), "kimi-code", "kimi-k3")).toEqual({ conn: "plan", id: "k3" });
  });
});

describe("the brief is typed", () => {
  test("every launch types the brief line (an empty prefix), the spec is in no argument, and the command says so", () => {
    for (const conn of ["plan", "openrouter"] as const) {
      for (const mode of [undefined, "build", "plan"] as const) {
        const cmd = buildCommand(on(conn), choice(conn === "plan" ? "kimi-k3" : "kimi-k2.7-code", { ...(mode ? { mode } : {}), spec: "- fix the bug" }));
        expect([conn, mode, cmd.firstLine, cmd.typedSpec, cmd.spec]).toEqual([conn, mode, "", true, "- fix the bug"]);
        expect([conn, mode, cmd.argv.some((a) => a.includes("fix the bug"))]).toEqual([conn, mode, false]);
      }
    }
  });

  test("launchPlan: the spec goes into a private file, argv stays as built (its last argument too), the line is the brief alone", () => {
    const cmd = buildCommand(on("plan"), choice("kimi-k3", { mode: "plan", spec: "- fix the bug\n- and more" }));
    const plan = launchPlan(cmd, "/usr/bin/kimi", { tmp: TMP });
    try {
      expect(plan.argv).toEqual(["/usr/bin/kimi", "-m", "kimi-code/k3", "--plan"]);
      expect(readFileSync(plan.specFile!, "utf8")).toBe("- fix the bug\n- and more\n");
      expect(readFileSync(join(dirname(plan.specFile!), "pid"), "utf8")).toBe(String(process.pid));
      // Plain words: nothing at its start Kimi would take for a command (`/`) or a shell line (`!`).
      expect(plan.firstLine).toBe(`Read the session brief in ${plan.specFile} and start.`);
      expect(plan.firstLine).toMatch(/^[A-Za-z]/);
    } finally {
      rmSync(dirname(plan.specFile!), { recursive: true, force: true });
    }
  });

  test("where nothing can type (`--launch`, no pseudo-terminal) it is refused in every mode, before anything starts", async () => {
    for (const mode of [undefined, "build", "explore", "plan"] as const) expect([mode, typedModeProblem("kimi-code", mode)]).toEqual([mode, expect.stringContaining("Kimi Code takes no prompt on its command line")]);
    const cmd = buildCommand(on("plan"), choice("kimi-k3"));
    await expect(handOff(cmd)).rejects.toThrow("takes no prompt on its command line");
    await expect(handOffSession(cmd, handoffFor(handoffDefaults(), "kimi-code"), undefined, TMP)).rejects.toThrow("takes no prompt on its command line");
    expect(typedModeProblem("claude-code", "build")).toBeNull();
  });
});

describe("modes", () => {
  const info = HARNESS_INFO["kimi-code"];
  test("plan: `--plan`, nothing else", () => {
    expect(buildCommand(on("plan"), choice("kimi-k3", { mode: "plan" })).argv).toEqual(["kimi", "-m", "kimi-code/k3", "--plan"]);
    expect(buildCommand(on("openrouter"), choice("kimi-k3", { mode: "plan" })).argv).toEqual(["kimi", "--plan"]);
  });

  test("BUG-432/explore is unavailable: Kimi's interactive mode ignores `--agent-file` and `--agent`, so nothing could take its writing and shell tools away", () => {
    const explore = info.modes.explore;
    expect(explore.unavailable).toContain("ignores an agent file");
    expect(explore.argv).toBeUndefined();
    // Never started: not by a direct launch, not by the brain, not by ctrl+t over a proposal.
    for (const conn of ["plan", "openrouter"] as const) {
      const model = conn === "plan" ? "kimi-k3" : "kimi-k2.7-code";
      expect(() => buildCommand(on(conn), choice(model, { mode: "explore" }))).toThrow("Kimi Code can't start in explore mode");
      expect(validateChoice(on(conn), choice(model, { mode: "explore" }))).toBe(`Kimi Code can't start in explore mode: ${explore.unavailable}`);
      expect(validateChoice(on(conn), choice(model, { mode: "plan" }))).toBeNull();
      expect(validateChoice(on(conn), choice(model, { mode: "build" }))).toBeNull();
    }
    const config = on("openrouter");
    // The proposal is route's (`Routed`): a route that offered Kimi in explore (it never does: `RouteHarness.noModes`) is refused here too.
    const routedTo = (over: Partial<Routed>): Routed => ({ mode: "build", recommended: { harness: "kimi-code", model: "kimi-k2.7-code" }, alternatives: [], why: [], types: ["docs"], ...over });
    const proposal = (over: Partial<Routed>) => parseProposal(config, { spec: "- read it", reason: "r" }, routedTo(over));
    expect(proposal({ mode: "explore" })).toBe(`Kimi Code can't start in explore mode: ${explore.unavailable}`);
    expect(proposal({ mode: "plan" })).toMatchObject({ mode: "plan" });
    expect(pickChoice(config, proposal({}) as Proposal, 0, { mode: "explore" })).toBe(`Kimi Code can't start in explore mode: ${explore.unavailable}`);
    // An alternative that can't run the mode is dropped; another agent's stays.
    const mixedConfig = { ...config, connections: { ...config.connections, codex: { auth: "subscription" } } } as Config;
    const mixed = parseProposal(mixedConfig, { spec: "- read it", reason: "r" }, routedTo({ mode: "explore", recommended: { harness: "codex", model: "gpt-6-luna", effort: "high" }, alternatives: [{ harness: "kimi-code", model: "kimi-k2.7-code" }] }));
    expect(typeof mixed === "string" ? mixed : mixed.choices.map((c) => c.harness)).toEqual(["codex"]);
  });

  test("BUG-432/the brain is told, per harness, that Kimi Code can't run explore (and nothing is said of the agent file)", () => {
    const config = { ...on("openrouter"), agents: offeredAgents(on("openrouter"), { installed: () => true }) };
    const text = systemPrompt(config, { cwd: "/r", isRepo: false, branch: null, topLevel: [], instructions: [] });
    expect(text).toContain("- kimi-code (Kimi Code)\n  models: kimi-k2.7-code (Kimi K2.7 Code), kimi-k3 (Kimi K3)\n  can't run explore mode: never route such a session to it");
    expect(info.modes.plan).toEqual({ argv: ["--plan"] });
  });

  test("BUG-432/no explore agent file is written: no file, no skills directory, no `--agent-file` in any argv", () => {
    for (const conn of ["plan", "openrouter"] as const) for (const mode of [undefined, "build", "plan"] as const) {
      const cmd = buildCommand(on(conn), choice(conn === "plan" ? "kimi-k3" : "kimi-k2.7-code", mode ? { mode } : {}));
      expect(cmd.argv.some((a) => a.startsWith("--agent") || a === "--skills-dir")).toBe(false);
      expect(cmd.adapter).toBeUndefined();
    }
    expect(adapterOutput({ harness: "kimi-code", version: "2.1.1", handoff: handoffFor(handoffDefaults(), "kimi-code") })).toEqual({ argv: [], env: {}, files: {} });
  });

  test("build adds nothing: no agent file, no skills directory", () => {
    const cmd = buildCommand(on("plan"), choice("kimi-k3"));
    expect(cmd.argv.some((a) => a.startsWith("--agent") || a === "--skills-dir")).toBe(false);
    expect(cmd.adapter).toBeUndefined();
  });
});

describe("the key variable", () => {
  test("BUG-431/KIMI_MODEL_API_KEY is Kimi Code's key on OpenRouter or Moonshot only: no other harness, connection or caller may carry it", () => {
    const env = { KIMI_MODEL_API_KEY: "sk-or-v1-x" };
    expect(() => assertSafeEnv(env, "openrouter", "kimi-code")).not.toThrow();
    expect(() => assertSafeEnv(env, "moonshot", "kimi-code")).not.toThrow();
    for (const [conn, harness] of [["plan", "kimi-code"], [undefined, "kimi-code"], ["anthropic", "kimi-code"], ["bedrock", "kimi-code"], ["openrouter", "claude-code"], ["openrouter", "opencode"], ["openrouter", undefined], ["plan", undefined], ["moonshot", "opencode"], ["moonshot", "claude-code"], ["moonshot", undefined]] as const) {
      expect(() => assertSafeEnv(env, conn, harness), `${harness}/${conn}`).toThrow("KIMI_MODEL_API_KEY");
    }
  });

  test("BUG-702/Moonshot's endpoint is never set by Gluon: a base URL on Kimi + Moonshot is refused, whatever its name or value (the default endpoint needs none)", () => {
    for (const k of ["KIMI_MODEL_BASE_URL", "KIMI_BASE_URL", "KIMI_CODE_BASE_URL", "MOONSHOT_BASE_URL", "OPENAI_BASE_URL"]) {
      for (const url of ["https://api.moonshot.ai/v1", "https://api.moonshot.cn/v1", "https://api.kimi.com/coding/v1", "https://openrouter.ai/api/v1"]) {
        expect(() => assertSafeEnv({ [k]: url }, "moonshot", "kimi-code"), `${k}=${url}`).toThrow("only an API-key aggregator's documented endpoint is allowed");
      }
    }
    // OpenRouter's own is still OpenRouter's alone.
    expect(() => assertSafeEnv({ KIMI_MODEL_BASE_URL: "https://openrouter.ai/api/v1" }, "openrouter", "kimi-code")).not.toThrow();
  });
});

describe("the plan's sign-in (`kimi provider list`)", () => {
  const fake = async <T>(env: Record<string, string>, f: () => Promise<T>): Promise<T> => {
    for (const k of FAKES) delete process.env[k];
    Object.assign(process.env, env);
    try {
      return await f();
    } finally {
      for (const k of FAKES) delete process.env[k];
    }
  };

  test("a provider whose source is `oauth` is the plan; `No providers configured.` is signed out", async () => {
    expect(await fake({}, kimiPlanStatus)).toEqual({ installed: true, loggedIn: true, detail: "Kimi Code plan" });
    expect(await fake({ FAKE_KIMI_LOGGED_OUT: "1" }, kimiPlanStatus)).toEqual({ installed: true, loggedIn: false });
    expect((await fake({}, () => loginStatus("kimi-code"))).loggedIn).toBe(true);
  });

  test("an answer Gluon can't read says nothing about it: not signed in, but `transient` (the models stay offered, the user can launch and `/login`)", async () => {
    const s = await fake({ FAKE_KIMI_LIST_ODD: "1" }, kimiPlanStatus);
    expect(s).toMatchObject({ installed: true, loggedIn: false, transient: true, error: expect.stringContaining("no answer Gluon can read") });
  });

  test("the parse: keyed providers alone are not the plan; colours and blank lines pass; junk is unknown", () => {
    expect(parseKimiProviders("managed:kimi-code  type=kimi  models=3  source=oauth\n")).toEqual({ signedIn: true });
    expect(parseKimiProviders("\x1b[1mmanaged:kimi-code\x1b[0m  type=kimi  models=3  source=oauth\nmine  type=openai  models=1  source=inline\n")).toEqual({ signedIn: true });
    expect(parseKimiProviders("mine  type=openai  models=1  source=inline\nother  type=kimi  models=2  source=apiJson(https://x.test/api.json)\n")).toEqual({ signedIn: false });
    // Whatever its source is called, the managed provider `kimi login` adds is the plan.
    expect(parseKimiProviders("managed:kimi-code  type=kimi  models=3  source=managed\n")).toEqual({ signedIn: true });
    expect(parseKimiProviders("No providers configured.\n")).toEqual({ signedIn: false });
    for (const odd of ["", "error: unknown command 'provider'", "providers: none", "No providers configured, but see the docs"]) expect(parseKimiProviders(odd)).toBeNull();
  });

  test("BUG-430/managed id only counts for the plan when its source isn't a key or a registry: `managed:kimi-code` with `inline` or `apiJson` is not a sign-in", () => {
    expect(parseKimiProviders("managed:kimi-code  type=kimi  models=1  source=inline\n")).toEqual({ signedIn: false });
    expect(parseKimiProviders("managed:kimi-code  type=kimi  models=2  source=apiJson(https://x.test/api.json)\n")).toEqual({ signedIn: false });
    expect(parseKimiProviders("managed:kimi-code  type=kimi  models=3  source=inline\nmanaged:kimi-code  type=kimi  models=3  source=oauth\n")).toEqual({ signedIn: true });
  });

  test("not installed: not installed, never a sign-in", async () => {
    const path = process.env.PATH;
    process.env.PATH = TMP;
    try {
      expect(await kimiPlanStatus()).toEqual({ installed: false, loggedIn: false });
    } finally {
      process.env.PATH = path;
    }
  });

  test("a connected plan is offered both ways round: the catalog before a probe, and K2.7 Code only on OpenRouter (K3 without efforts there: BUG-433)", () => {
    const plan = offeredAgents(on("plan"), { installed: () => true }).find((a) => a.harness === "kimi-code")!;
    expect(plan.models.map((m) => m.id)).toEqual(["kimi-k3"]);
    const router = offeredAgents(on("openrouter"), { installed: () => true }).find((a) => a.harness === "kimi-code")!;
    expect(router.models.map((m) => [m.id, m.efforts])).toEqual([["kimi-k2.7-code", []], ["kimi-k3", []]]);
  });
});
