/** Gluon's pieces outside the terminal: files changed, the quit question, `handoff.mouse_capture`. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSince, statusSnapshot } from "../src/agent/tools.ts";
import { loadConfig, saveConfig, setConfigNotices } from "../src/config.ts";
import { directNotice, endQuestion, exitNotice, homeQuestions, initialReadiness, quitQuestion, READINESS_ORDER, RESUME_EARLY_MS, resumeModeProblem, resumeRefused } from "../src/gluon.ts";
import { readinessSegs } from "../src/ui/layout.ts";
import { handoffFor } from "../src/handoff.ts";
import { tryStartTelemetry } from "../src/telemetry.ts";
import { ADAPTERS } from "../src/adapters/index.ts";
import { tooOld } from "../src/harnesses.ts";
import { assertSafeEnv } from "../src/launchers.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

describe("files changed", () => {
  test("changedSince counts paths whose status differs: new, changed, back to clean", () => {
    const base = new Map([
      ["a.ts", " M"],
      ["b.ts", "??"],
    ]);
    expect(changedSince(base, base)).toBe(0);
    expect(changedSince(base, new Map([["a.ts", " M"], ["b.ts", "??"], ["c.ts", " M"]]))).toBe(1);
    expect(changedSince(base, new Map([["a.ts", "M "], ["b.ts", "??"]]))).toBe(1);
    expect(changedSince(base, new Map([["a.ts", " M"]]))).toBe(1);
  });

  test("statusSnapshot reads the work tree's changes (renames as one path); null outside a repository", async () => {
    const repo = join(TMP, "repo");
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "a.txt"), "1\n");
    writeFileSync(join(repo, "b.txt"), "1\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"); // a runner may have no git identity (#29)
    const base = await statusSnapshot(repo);
    expect(base).toEqual(new Map());
    writeFileSync(join(repo, "a.txt"), "2\n");
    writeFileSync(join(repo, "new file.txt"), "x\n");
    git(repo, "mv", "b.txt", "c.txt");
    const now = (await statusSnapshot(repo))!;
    expect([...now.keys()].sort()).toEqual(["a.txt", "c.txt", "new file.txt"]);
    expect(changedSince(base!, now)).toBe(3);
    const plain = join(TMP, "plain");
    mkdirSync(plain, { recursive: true });
    expect(await statusSnapshot(plain)).toBeNull();
  });
});

test("the quit question names how many sessions are running", () => {
  expect(quitQuestion(1)).toBe("1 session running — quit and end it?");
  expect(quitQuestion(3)).toBe("3 sessions running — quit and end them?");
});

test("BUG-213/question: Delete's end question names the session, a long name cut so it stays one line", () => {
  expect(endQuestion("Gluon-fix-add-bug")).toBe("End Gluon-fix-add-bug?");
  const long = endQuestion(`Gluon-${"x".repeat(60)}`);
  expect(long).toMatch(/^End Gluon-x+…\?$/);
  expect(Bun.stringWidth(long)).toBe(4 + 32 + 1);
});

test("BUG-192/notice: a closed session's line in the chat says how it ended, with or without a pseudo-terminal", () => {
  expect(exitNotice("fix-add-bug", 1)).toBe("fix-add-bug exited (code 1)");
  expect(directNotice("Claude Code", { reason: "exit", code: 7 })).toStartWith("Claude Code exited (code 7).");
  expect(directNotice("Claude Code", { reason: "back", code: 0 })).toStartWith("Back from Claude Code.");
});

describe("handoff.mouse_capture", () => {
  const saved = process.env.GLUON_CONFIG;
  const cfg = join(TMP, "config.yaml");
  afterAll(() => {
    if (saved === undefined) delete process.env.GLUON_CONFIG;
    else process.env.GLUON_CONFIG = saved;
  });

  test("on by default; false turns it off; anything else is refused; never per agent", () => {
    process.env.GLUON_CONFIG = cfg;
    rmSync(cfg, { force: true });
    expect(loadConfig().handoff.mouse_capture).toBe(true);
    writeFileSync(cfg, "handoff:\n  mouse_capture: false\n");
    const h = loadConfig().handoff;
    expect(h.mouse_capture).toBe(false);
    // Not one of an agent's settings.
    expect(handoffFor(h, "codex")).not.toHaveProperty("mouse_capture");
    writeFileSync(cfg, "handoff:\n  mouse_capture: maybe\n");
    expect(() => loadConfig()).toThrow("handoff.mouse_capture must be true or false");
    writeFileSync(cfg, "handoff:\n  agents: { codex: { mouse_capture: false } }\n");
    expect(() => loadConfig()).toThrow("handoff.agents.codex.mouse_capture: unknown setting");
  });
});

describe("Gluon never writes to the console", () => {
  test("BUG-173/F: a telemetry listener that can't start leaves Gluon running without figures, with one notice", () => {
    const r = tryStartTelemetry(() => {
      throw new Error("EADDRNOTAVAIL");
    });
    expect(r.server).toBeNull();
    expect(r.notice).toBe("Cost and context figures are off: couldn't listen on 127.0.0.1 (EADDRNOTAVAIL).");
    const ok = tryStartTelemetry();
    expect(ok.server?.port).toBeGreaterThan(0);
    expect(ok.notice).toBeUndefined();
    ok.server?.stop();
  });

  test("BUG-174/F: while a sink is set, a config Gluon can't save is said there, not on the console", () => {
    const file = join(TMP, "not-a-dir");
    writeFileSync(file, "");
    const before = process.env.GLUON_CONFIG;
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    const said: string[] = [];
    try {
      process.env.GLUON_CONFIG = join(file, "config.yaml");
      setConfigNotices((m) => said.push(m));
      saveConfig([[["brain", "active"], 1]]);
    } finally {
      setConfigNotices(null);
      console.error = origError;
      if (before === undefined) delete process.env.GLUON_CONFIG;
      else process.env.GLUON_CONFIG = before;
    }
    expect(errors).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith(`couldn't save to ${join(file, "config.yaml")}`);
  });
});

describe("first run: agents available", () => {
  test("BUG-182/F: an API-key connection whose key isn't set reads key missing; the brief's order; OpenCode is the open-weight lane", () => {
    const config = loadConfig();
    config.connections = {
      "claude-code": { auth: "subscription" },
      codex: { auth: "api", provider: "openai" },
      "grok-build": { auth: "api", provider: "xai" },
      opencode: { providers: ["openrouter"] },
    } as typeof config.connections;
    const keys = ["OPENAI_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY"];
    const before = keys.map((k) => process.env[k]);
    try {
      for (const k of keys) delete process.env[k];
      process.env.XAI_API_KEY = "xai-test-key";
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      const r = initialReadiness(config, (h) => h !== "antigravity");
      expect(r.map((x) => [x.harness, x.state, x.note])).toEqual([
        ["claude-code", "checking", undefined],
        ["codex", "nokey", undefined],
        ["grok-build", "ready", "api key"],
        ["antigravity", "missing", undefined],
        ["opencode", "ready", "open-weight models · api key"],
        ["kimi-code", "signin", "not connected"],
      ]);
      expect(READINESS_ORDER).toEqual(["claude-code", "codex", "grok-build", "antigravity", "opencode", "kimi-code"]);
      const segs = readinessSegs(r[1]!, 14);
      expect(segs.map((s) => s.text).join("")).toBe(" ○  codex         key missing");
      expect(segs[1]!.role).toBe("dim");
    } finally {
      keys.forEach((k, i) => (before[i] === undefined ? delete process.env[k] : (process.env[k] = before[i])));
    }
  });
});

test("BUG-184/copy: what Gluon shows says Gluon or intake agent — never brain or task", () => {
  const shown: string[] = [];
  for (const h of Object.keys(ADAPTERS) as (keyof typeof ADAPTERS)[])
    for (const on_compact of ["ask", "stay"] as const)
      shown.push(...ADAPTERS[h].notes({ harness: h, version: null, handoff: { ...handoffFor(loadConfig().handoff, h), on_compact }, env: { OPENCODE_CLI_CONFIG_CONTENT: "[]" } }));
  shown.push(tooOld("opencode", "1.0.0", "linux")!);
  for (const env of [{ CLAUDE_CODE_OAUTH_TOKEN: "x" }, { ANTHROPIC_BASE_URL: "https://x" }, { ANTHROPIC_AUTH_TOKEN: "x" }])
    try {
      assertSafeEnv(env, "anthropic");
    } catch (e) {
      shown.push((e as Error).message);
    }
  expect(shown.length).toBeGreaterThan(10);
  for (const line of shown) expect([line, /\bbrain\b|\btask\b/.test(line)]).toEqual([line, false]);
});

test("BUG-189/F10: without a pseudo-terminal, what Gluon prints before the agent goes to stderr, never through process.stdout", () => {
  // A process.stdout write right before the agent started left its terminal dead on macOS (F10–F19
  // failed there alone): the hand-over prints through stderr only, as the notes always did.
  const src = readFileSync(join(import.meta.dir, "..", "src", "gluon.ts"), "utf8");
  const at = src.indexOf("compositor.handOver(");
  const body = src.slice(at, src.indexOf("return handOffSession(", at));
  expect(at).toBeGreaterThan(0);
  expect(body).toContain("process.stderr.write(");
  expect(body).toContain("to come back to Gluon");
  expect(body).not.toContain("process.stdout");
});

test("BUG-305/resume: only a non-zero exit under 128, soon after the resume, is a refusal (a signal, the user's Ctrl+C, a clean exit or a late one are not)", () => {
  const t0 = 1_000_000;
  const soon = t0 + 3_000;
  expect([1, 2, 3, 127].map((c) => resumeRefused(c, t0, soon))).toEqual([true, true, true, true]);
  expect([0, 128, 130, 137, 143, 255].map((c) => resumeRefused(c, t0, soon))).toEqual([false, false, false, false, false, false]);
  expect(resumeRefused(3, t0, t0 + RESUME_EARLY_MS - 1)).toBe(true);
  expect(resumeRefused(3, t0, t0 + RESUME_EARLY_MS)).toBe(false);
});

test("BUG-612/resume-modes: a saved Codex, Grok Build or OpenCode session with no mode (saved before Gluon recorded it) is refused with a message naming `gluon sessions --delete <id>`; any with a mode, and Claude Code with none, are not", () => {
  for (const harness of ["codex", "grok-build", "opencode"] as const) {
    const why = resumeModeProblem({ harness }, "abc234")!;
    expect(why).toContain("`gluon sessions --delete abc234`");
    expect(why).toContain("was saved before Gluon recorded a session's mode");
    expect(why).not.toMatch(/[\x00-\x1f\x7f]/);
    for (const mode of ["build", "explore", "plan"] as const) expect(resumeModeProblem({ harness, mode }, "abc234")).toBeNull();
  }
  // Claude Code's session holds its mode; Antigravity and Kimi Code have no resume at all (their own problem is another message).
  for (const harness of ["claude-code", "antigravity", "kimi-code"] as const) expect(resumeModeProblem({ harness }, "abc234")).toBeNull();
});

test("BUG-304/resume: the reason in the start-again question is masked and one safe line (it can hold an agent's or a launch's message)", () => {
  const key = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8".repeat(3);
  const forms = homeQuestions.again("Gluon-fix", "Claude Code", `exited: bad ${key}\x1b]0;PWNED\x07\nsecond line`);
  for (const f of forms) {
    expect(f).not.toContain(key);
    expect(f).not.toMatch(/[\x00-\x1f\x7f]/);
  }
  expect(forms[0]).toContain("exited: bad");
});
