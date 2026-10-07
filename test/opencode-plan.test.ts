/**
 * OpenCode's connections: the OpenCode Go plan (a subscription: a stored sign-in of OpenCode's own,
 * read through `opencode auth list` only) and OpenRouter; and the effort OpenCode takes per model in the
 * config Gluon hands it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { defaults } from "../src/config.ts";
import { initialReadiness } from "../src/gluon.ts";
import { resolveModel } from "../src/models.ts";
import { catalog, DEFAULT_MODELS, HARNESS_INFO, isPlanConn, PROVIDERS, subscriptionOf } from "../src/harnesses.ts";
import { buildCommand, launchProblem, opencodeEffort } from "../src/launchers.ts";
import { loginStatus, opencodeCredentials, opencodePlanStatus } from "../src/status.ts";
import { fakeAgents } from "./e2e/fixtures.ts";

const saved = { path: process.env.PATH, state: process.env.FAKE_OPENCODE_STATE };
const FAKES = ["FAKE_OPENCODE_LOGGED_OUT", "FAKE_OPENCODE_STATE", "FAKE_OPENCODE_ENV_ONLY", "FAKE_OPENCODE_NEEDS_AUTH", "FAKE_OPENCODE_CREDENTIALS"];
const TMP = mkdtempSync(join(tmpdir(), "gluon-oc-plan-"));
beforeAll(() => {
  process.env.PATH = `${fakeAgents(["opencode"])}${delimiter}${saved.path}`;
});
afterAll(() => {
  process.env.PATH = saved.path;
  for (const k of FAKES) delete process.env[k];
  rmSync(TMP, { recursive: true, force: true });
});
const fake = async <T>(env: Record<string, string>, f: () => Promise<T>): Promise<T> => {
  for (const k of FAKES) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await f();
  } finally {
    for (const k of FAKES) delete process.env[k];
  }
};

describe("the plan's sign-in", () => {
  test("a stored sign-in of the opencode-go integration is the plan; nothing listed is not", async () => {
    expect(await fake({}, opencodePlanStatus)).toEqual({ installed: true, loggedIn: true, detail: "OpenCode Go plan" });
    expect(await fake({ FAKE_OPENCODE_LOGGED_OUT: "1" }, opencodePlanStatus)).toEqual({ installed: true, loggedIn: false });
    // `loginStatus` is the same check for OpenCode.
    expect((await fake({}, () => loginStatus("opencode"))).loggedIn).toBe(true);
  });

  test("an OPENCODE_API_KEY variable (`type: env`) is not the plan, and a sign-in OpenCode wants redone is not signed in", async () => {
    expect(await fake({ FAKE_OPENCODE_ENV_ONLY: "1" }, opencodePlanStatus)).toEqual({ installed: true, loggedIn: false });
    const s = await fake({ FAKE_OPENCODE_NEEDS_AUTH: "1" }, opencodePlanStatus);
    expect(s).toMatchObject({ installed: true, loggedIn: false, error: expect.stringContaining("needs to be signed in to again") });
  });

  test("other stored sign-ins are counted for doctor's note, not as the plan", async () => {
    expect(await fake({ FAKE_OPENCODE_CREDENTIALS: "2", FAKE_OPENCODE_LOGGED_OUT: "1" }, opencodeCredentials)).toBe(2);
    expect(await fake({ FAKE_OPENCODE_CREDENTIALS: "2", FAKE_OPENCODE_LOGGED_OUT: "1" }, opencodePlanStatus)).toMatchObject({ loggedIn: false });
    expect(await fake({}, opencodeCredentials)).toBe(0);
  });

  test("not installed: not installed, never a sign-in", async () => {
    const path = process.env.PATH;
    process.env.PATH = TMP;
    try {
      expect(await opencodePlanStatus()).toEqual({ installed: false, loggedIn: false });
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("the plan as a connection", () => {
  test("a subscription of the OpenCode vendor: signed in by `opencode auth login opencode-go`, no key, launched with none", () => {
    expect(isPlanConn("opencode-go")).toBe(true);
    expect(isPlanConn("openrouter")).toBe(false);
    expect(subscriptionOf("opencode", "opencode-go")).toMatchObject({ vendor: "opencode", loginArgv: ["opencode", "auth", "login", "opencode-go"] });
    expect(PROVIDERS["opencode-go"].env).toBeUndefined();
    const config = { ...defaults(), connections: { opencode: { auth: "api", providers: ["opencode-go"] } } } as ReturnType<typeof defaults>;
    expect(launchProblem(config, "opencode", "opencode-go")).toBeNull();
    const cmd = buildCommand(config, { harness: "opencode", model: "deepseek-flash", spec: "x", reason: "" });
    expect(cmd.conn).toBe("opencode-go");
    expect(Object.keys(cmd.env)).toEqual(["OPENCODE_CONFIG_CONTENT"]);
  });

  test("BUG-424/plan-first: a model both the plan and OpenRouter serve goes through the plan, whatever order the config lists them in", () => {
    const connected = (providers: string[]) => ({ ...defaults(), connections: { opencode: { auth: "api", providers } } }) as ReturnType<typeof defaults>;
    for (const providers of [["openrouter", "opencode-go"], ["opencode-go", "openrouter"]]) {
      expect(resolveModel(connected(providers), "opencode", "deepseek-flash")).toEqual({ conn: "opencode-go", id: "deepseek-v4.1-flash" });
      expect(resolveModel(connected(providers), "opencode", "muse-spark-1.3-contributor")?.conn).toBe("opencode-go");
      // Served by OpenRouter alone: OpenRouter.
      expect(resolveModel(connected(providers), "opencode", "muse-spark-1.3")?.conn).toBe("openrouter");
    }
    // A plan probed and not reached (not signed in) falls back to OpenRouter.
    const probed = connected(["openrouter", "opencode-go"]);
    probed.checked["opencode/opencode-go"] = "2026-10-01";
    probed.unreached["opencode/opencode-go/deepseek-v4.1-flash"] = "2026-10-01";
    expect(resolveModel(probed, "opencode", "deepseek-flash")?.conn).toBe("openrouter");
  });

  test("menu order: the API-key provider (OpenRouter) is listed above the plan, as for every harness; routing is unaffected", () => {
    expect(HARNESS_INFO.opencode.providers).toEqual(["openrouter", "opencode-go"]);
    const config = { ...defaults(), connections: { opencode: { auth: "api", providers: ["openrouter", "opencode-go"] } } } as ReturnType<typeof defaults>;
    expect(resolveModel(config, "opencode", "deepseek-flash")?.conn).toBe("opencode-go");
  });

  test("readiness: the plan is asked of OpenCode itself; an OpenRouter key that works makes it ready without that", () => {
    const connected = (providers: string[]) => ({ ...defaults(), connections: { opencode: { auth: "api", providers } } }) as ReturnType<typeof defaults>;
    const opencode = (providers: string[]) => initialReadiness(connected(providers), (h) => h === "opencode").find((r) => r.harness === "opencode")!.state;
    const key = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(opencode(["opencode-go"])).toBe("checking");
      expect(opencode(["opencode-go", "openrouter"])).toBe("checking");
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test0123456789abcdef";
      expect(opencode(["opencode-go", "openrouter"])).toBe("ready");
      expect(opencode(["openrouter"])).toBe("ready");
    } finally {
      if (key === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = key;
    }
  });
});

describe("OpenCode's effort: the model's `settings` in its config", () => {
  const flash = DEFAULT_MODELS.opencode[0]!;
  const muse = DEFAULT_MODELS.opencode[1]!;

  test("OpenRouter: reasoning.effort; the plan: reasoningEffort; no effort, no settings", () => {
    expect(opencodeEffort("openrouter", "deepseek/deepseek-v4.1-flash", flash, "max")).toEqual({ providers: { openrouter: { models: { "deepseek/deepseek-v4.1-flash": { settings: { reasoning: { effort: "max" } } } } } } });
    expect(opencodeEffort("opencode-go", "deepseek-v4.1-flash", flash, "low")).toEqual({ providers: { "opencode-go": { models: { "deepseek-v4.1-flash": { settings: { reasoningEffort: "low" } } } } } });
    expect(opencodeEffort("openrouter", "meta/muse-spark-1.3", muse, undefined)).toEqual({});
  });

  test("Muse on the plan has no max: it is asked for xhigh; DeepSeek on the plan keeps max; OpenRouter's Muse keeps max", () => {
    const settings = (r: ReturnType<typeof opencodeEffort>, provider: string, id: string) => (r.providers as any)[provider].models[id].settings;
    expect(settings(opencodeEffort("opencode-go", "muse-spark-1.3-contributor", muse, "max"), "opencode-go", "muse-spark-1.3-contributor")).toEqual({ reasoningEffort: "xhigh" });
    expect(settings(opencodeEffort("opencode-go", "deepseek-v4.1-flash", flash, "max"), "opencode-go", "deepseek-v4.1-flash")).toEqual({ reasoningEffort: "max" });
    expect(settings(opencodeEffort("openrouter", "meta/muse-spark-1.3", muse, "max"), "openrouter", "meta/muse-spark-1.3")).toEqual({ reasoning: { effort: "max" } });
  });

  test("a mode's config joins the effort's `providers` without replacing `model` or it", () => {
    const config = { ...defaults(), connections: { opencode: { auth: "api", providers: ["opencode-go"] } } } as ReturnType<typeof defaults>;
    const content = JSON.parse(buildCommand(config, { harness: "opencode", model: "deepseek-flash", effort: "high", mode: "explore", spec: "x", reason: "" }).env.OPENCODE_CONFIG_CONTENT!);
    expect(content.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(content.providers).toEqual({ "opencode-go": { models: { "deepseek-v4.1-flash": { settings: { reasoningEffort: "high" } } } } });
    expect(content.default_agent).toBe("gluon-explore");
  });

  test("the maintainers' catalog adds Sonnet 4.6 on Claude Code over Bedrock only, behind its seam", () => {
    expect(catalog()["claude-code"].map((m) => m.id)).toEqual(["haiku", "sonnet", "opus", "fable"]);
  });
});
