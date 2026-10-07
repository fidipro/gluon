/**
 * `gluon doctor` and `gluon brain` as functions: the lines they print, their exit codes, and that nothing
 * they print carries a key. Offline: API probes are answered by GLUON_TEST_PROBES, the agents are fakes on
 * PATH, the config and its `.env` are in a temp directory. (e2e/auth.e2e.test.ts drives the same through the
 * CLI for the plan routes.) Security QA pass.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { chooseBrain, type StepResult } from "../src/brain.ts";
import { defaults, loadConfig } from "../src/config.ts";
import { awsLabel, doctor, showBrain, stepLine } from "../src/doctor.ts";
import { loadSecrets } from "../src/secrets.ts";
import { fakeAgents } from "./e2e/fixtures.ts";

const POSIX = process.platform !== "win32";
const TMP = mkdtempSync(join(tmpdir(), "gluon-doctor-"));
const saved = { ...process.env };
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_BEARER_TOKEN_BEDROCK", "XAI_API_KEY"];
let n = 0;

/** A fresh config (YAML text) with the probes' answers and the agents on PATH; returns the work directory. */
function setup(yaml: string, answers: Record<string, true | string>, agents: Parameters<typeof fakeAgents>[0] = ["codex"]): string {
  const d = join(TMP, `d${++n}`);
  Bun.spawnSync(["mkdir", "-p", d]);
  process.env.GLUON_CONFIG = join(d, "config.yaml");
  writeFileSync(process.env.GLUON_CONFIG, yaml);
  writeFileSync(join(d, "probes.json"), JSON.stringify(answers));
  process.env.GLUON_TEST_PROBES = join(d, "probes.json");
  process.env.PATH = [fakeAgents(agents), "/usr/bin", "/bin"].join(delimiter);
  for (const k of KEYS) delete process.env[k];
  loadSecrets();
  return d;
}

/** Runs `fn` and returns what it printed with console.log. */
async function printed(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  try {
    return { code: await fn(), text: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

const OPENAI = "connections: { codex: { auth: api, provider: openai } }\n";
const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";

beforeAll(() => {
  process.env.GLUON_CONFIG = join(TMP, "config.yaml");
});
afterEach(() => {
  Object.assign(process.env, saved);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
});
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe.skipIf(!POSIX)("doctor", () => {
  test("everything works: ✓ lines only, exit 0, the brain step in use is marked, and the key's source is named, never the key", async () => {
    const d = setup(OPENAI, {});
    process.env.OPENAI_API_KEY = KEY;
    const { code, text } = await printed(() => doctor(loadConfig(), d));
    expect(code).toBe(0);
    expect(text).not.toMatch(/^\s*✗/m);
    expect(text).toContain("✓ Codex (codex 0.158.0) · OpenAI key (from your environment)");
    expect(text).toContain("✓ gpt-6-luna · gpt-6-luna");
    expect(text).toMatch(/✓ 4\. GPT-6 Sol · OpenAI API {3}← in use/);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("abcdefghijklmnop");
  });

  test("mixed: one model refused is a ✗ line and exit 1, the others stay ✓, and the brain still works", async () => {
    const d = setup(OPENAI, { "openai/gpt-6-luna": "model not found" });
    process.env.OPENAI_API_KEY = KEY;
    const { code, text } = await printed(() => doctor(loadConfig(), d));
    expect(code).toBe(1);
    expect(text).toContain("✗ gpt-6-luna · gpt-6-luna · model not found");
    expect(text).toContain("✓ gpt-6.1-sol · gpt-6.1-sol");
    expect(text).toContain("← in use");
  });

  test("all ✗: every agent model refused, so no agent can be launched: exit 1; the next run on the same config starts clean (exit 0 once they answer)", async () => {
    const d = setup(OPENAI, { "openai/gpt-6-luna": "denied", "openai/gpt-6.1-sol": "denied", "openai/gpt-6-astra": "denied" });
    process.env.OPENAI_API_KEY = KEY;
    const bad = await printed(() => doctor(loadConfig(), d));
    expect(bad.code).toBe(1);
    expect(bad.text).toContain("✗ gpt-6-luna · gpt-6-luna · denied");
    expect(bad.text).toContain("✗ No connected agent can be launched yet: `gluon setup`");
    writeFileSync(process.env.GLUON_TEST_PROBES!, "{}");
    // Module state (`failed`) must not leak from one run to the next: the same config, now answering, is exit 0.
    const good = await printed(() => doctor(loadConfig(), d));
    expect(good.text).not.toMatch(/^\s*✗/m);
    expect(good.code).toBe(0);
  });

  test("nothing installed and nothing connected: a ✗ for the missing launch, exit 1, install commands shown", async () => {
    const d = setup("", {}, []);
    const { code, text } = await printed(() => doctor(loadConfig(), d));
    expect(code).toBe(1);
    expect(text).toContain("✗ No connected agent can be launched yet");
    expect(text).toContain("No step works");
    expect(text).toContain("install: curl -fsSL https://claude.ai/install.sh | bash (or `gluon install claude-code`)");
  });

  test("a key in a probe's error text is masked, by shape and by value (a key of no known shape saved in Gluon's own .env)", async () => {
    const d = setup(OPENAI, { "openai/gpt-6-luna": `Incorrect API key provided: ${KEY}`, "openai/gpt-6.1-sol": "bad key plainshapelesskeyvalue99", "openai/gpt-6-astra": "ok?" });
    writeFileSync(join(d, ".env"), "OPENAI_API_KEY=plainshapelesskeyvalue99\n");
    loadSecrets();
    const { text } = await printed(() => doctor(loadConfig(), d));
    expect(text).toContain("Incorrect API key provided: sk-proj-••••");
    expect(text).toContain("bad key ••••");
    expect(text).not.toContain("plainshapelesskeyvalue99");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  test("`gluon brain`: the step in use with its effort, exit 0; with no working step, ✗ and exit 1", async () => {
    const d = setup(OPENAI, {});
    process.env.OPENAI_API_KEY = KEY;
    const ok = await printed(() => showBrain(loadConfig(), d));
    expect(ok.code).toBe(0);
    expect(ok.text).toMatch(/✓ 4\. GPT-6 Sol · OpenAI API {3}← in use · effort /);
    const none = setup("", {}, []);
    const bad = await printed(() => showBrain(loadConfig(), none));
    expect(bad.code).toBe(1);
    expect(bad.text).toContain("✗ No step works: `gluon doctor` shows why");
  });
});

describe("stepLine and awsLabel", () => {
  const step = (route: string, model: string) => ({ route, model }) as StepResult["step"];
  const at = (i: number, result: StepResult["result"]): StepResult => ({ index: i, step: step("openai-api", "gpt-6-sol"), result }) as StepResult;
  test("every state: in use, working, failed, not connected (·, not ✗), not tried", () => {
    expect(stepLine(at(3, { ok: true } as never), 3)).toMatch(/^ {2}✓ 4\. .* {3}← in use$/);
    expect(stepLine(at(0, { ok: true } as never), 3)).toMatch(/^ {2}✓ 1\. /);
    expect(stepLine(at(1, { ok: false, error: "key rejected" } as never), 3)).toMatch(/^ {2}✗ 2\. .* · key rejected$/);
    expect(stepLine(at(1, { ok: false, error: "not connected (no key)" } as never), 3)).toMatch(/^ {2}· 2\. .* · not connected \(no key\)$/);
    expect(stepLine(at(5, null), 3)).toContain("· 6. ");
    expect(stepLine(at(5, null), 3)).toContain("not tried (step 4 is in use)");
    expect(stepLine(at(5, null), null)).toContain("not tried (step 1 is in use)");
  });
  test("with effort: the step's own, the default marked, or no effort setting", () => {
    expect(stepLine({ ...at(0, { ok: true } as never), step: { route: "openai-api", model: "gpt-6-sol", effort: "high" } } as StepResult, 0, true)).toContain("· effort high");
    expect(stepLine(at(0, { ok: true } as never), 0, true)).toMatch(/· effort \w+ \(default\)|· no effort setting/);
  });
  test("awsLabel names the profile and region, never a key", () => {
    const config = defaults();
    config.bedrock = { profile: "work", region: "eu-west-1" };
    expect(awsLabel(config)).toBe("AWS profile work, eu-west-1");
    config.bedrock = {};
    expect(awsLabel(config)).toMatch(/^AWS default credentials, /);
  });
});

test("chooseBrain with nothing connected finds no step and probes none (the seam off the network)", async () => {
  if (!POSIX) return;
  const d = setup("", {}, []);
  const { active, steps } = await chooseBrain(loadConfig(), d, { all: true });
  expect(active).toBeNull();
  expect(steps.every((s) => s.result !== null && !s.result.ok)).toBe(true);
});
