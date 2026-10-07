/** Launch modes (build, explore, plan): what `buildCommand` and `launchPlan` make of each harness's `HarnessInfo.modes`. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaults } from "../src/config.ts";
import { HARNESS_INFO, HARNESSES, MODES, type Harness, type Mode } from "../src/harnesses.ts";
import { buildCommand, handOff, handOffSession, launchPlan, modeBrief, modeLostOnResume, typedModeProblem, typedModeRefusal, withMode, type LaunchChoice } from "../src/launchers.ts";
import { handoffFor } from "../src/handoff.ts";

const config = defaults();
const MODEL: Record<Harness, string> = { "claude-code": "sonnet", codex: "gpt-6.1-sol", antigravity: "gemini-3.8-flash", "grok-build": "grok-4.7", opencode: "deepseek-flash", "kimi-code": "kimi-k3" };
const choice = (harness: Harness, mode?: Mode, effort?: LaunchChoice["effort"], spec = "- fix the bug"): LaunchChoice => ({ harness, model: MODEL[harness], ...(effort ? { effort } : {}), ...(mode ? { mode } : {}), spec, reason: "" });
const tmp = mkdtempSync(join(tmpdir(), "gluon-modes-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("buildCommand", () => {
  test("build adds nothing: no mode flag, no mode on the command, the same argv and env as no mode at all", () => {
    for (const h of HARNESSES) {
      const none = buildCommand(config, choice(h, undefined, h === "opencode" ? undefined : "low"));
      const build = buildCommand(config, choice(h, "build", h === "opencode" ? undefined : "low"));
      expect([h, build]).toEqual([h, none]);
      expect(build.mode).toBeUndefined();
      // A harness that takes no prompt in argv (Kimi Code) types the brief on every launch: an empty prefix.
      expect(build.firstLine).toBe(HARNESS_INFO[h].typedSpec ? "" : undefined);
    }
    expect(buildCommand(config, choice("claude-code", "build", "high")).argv).toEqual(["claude", "--model", "sonnet", "--effort", "high", "--", "- fix the bug"]);
    expect(buildCommand(config, choice("opencode", "build")).env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"opencode-go/deepseek-v4.1-flash"}');
  });

  test("explore and plan: the mode's options come before the spec, which stays last; the command says its mode", () => {
    for (const h of HARNESSES) {
      for (const mode of ["explore", "plan"] as const) {
        // A mode the harness can't run is refused (Kimi Code's explore: BUG-432).
        if (HARNESS_INFO[h].modes[mode].unavailable) {
          expect(() => buildCommand(config, choice(h, mode, h === "opencode" ? undefined : "low", "x")), `${h} ${mode}`).toThrow(`can't start in ${mode} mode`);
          continue;
        }
        const spec = "- fix the bug";
        const cmd = buildCommand(config, choice(h, mode, h === "opencode" ? undefined : "low", spec));
        expect([h, mode, cmd.mode]).toEqual([h, mode, mode]);
        expect([h, mode, HARNESS_INFO[h].typedSpec ? !cmd.argv.some((a) => a.includes(spec)) : cmd.argv.at(-1)!.endsWith(spec)]).toEqual([h, mode, true]);
        for (const a of HARNESS_INFO[h].modes[mode].argv ?? []) expect([h, mode, a, cmd.argv.includes(a)]).toEqual([h, mode, a, true]);
        const build = buildCommand(config, choice(h, undefined, h === "opencode" ? undefined : "low", spec));
        // Nothing of build's is taken away (the mode's words are added; Codex's typed plan adds an effort).
        for (const a of build.argv.filter((x) => x !== spec)) expect([h, mode, a, cmd.argv.includes(a)]).toEqual([h, mode, a, true]);
      }
    }
  });

  test("argv per harness", () => {
    const argv = (h: Harness, mode: Mode, effort?: LaunchChoice["effort"]) => buildCommand(config, choice(h, mode, effort, "x")).argv;
    expect(argv("claude-code", "explore", "high")).toEqual([
      "claude", "--model", "sonnet", "--effort", "high",
      "--permission-mode", "dontAsk", "--disallowedTools", "Edit", "Write", "NotebookEdit", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "--", "x",
    ]);
    expect(argv("claude-code", "plan", "high")).toEqual(["claude", "--model", "sonnet", "--effort", "high", "--permission-mode", "plan", "--", "x"]);
    expect(argv("codex", "explore", "high")).toEqual(["codex", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "-s", "read-only", "-a", "never", "--", "x"]);
    expect(argv("antigravity", "explore", "low")).toEqual(["agy", "--model=gemini-3.8-flash-low", "--mode=plan", "--prompt-interactive=x"]);
    expect(argv("antigravity", "plan", "low")).toEqual(["agy", "--model=gemini-3.8-flash-low", "--mode=plan", "--prompt-interactive=x"]);
    expect(argv("grok-build", "explore", "high")).toEqual(["grok", "-m", "grok-4.7", "--reasoning-effort", "high", "--sandbox", "read-only", "--deny", "Edit", "--deny", "Write", "--deny", "Bash", "--", "x"]);
    // Plan: no flag (Grok's TUI ignores --permission-mode); `/plan` is typed, so the spec is not in argv as built here but still last.
    expect(argv("grok-build", "plan", "high")).toEqual(["grok", "-m", "grok-4.7", "--reasoning-effort", "high", "--", "x"]);
    // OpenCode's modes are config only.
    expect(argv("opencode", "explore")).toEqual(["opencode", "--standalone", "--prompt=x"]);
    expect(argv("opencode", "plan")).toEqual(["opencode", "--standalone", "--prompt=x"]);
  });

  test("an adapter's options come after the mode's, and the spec is still last", () => {
    const adapter = { argv: ["--settings", "ADAPTER"], env: {}, files: {} };
    const argv = buildCommand(config, choice("claude-code", "plan", "high", "x"), adapter).argv;
    expect(argv).toEqual(["claude", "--model", "sonnet", "--effort", "high", "--permission-mode", "plan", "--settings", "ADAPTER", "--", "x"]);
  });

  test("OpenCode: the mode's config is merged into the one passed in the environment", () => {
    const explore = JSON.parse(buildCommand(config, choice("opencode", "explore")).env.OPENCODE_CONFIG_CONTENT!);
    expect(explore.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(explore.default_agent).toBe("gluon-explore");
    const rules = explore.agents["gluon-explore"].permissions as { action: string; resource: string; effect: string }[];
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(rules.some((r) => r.action === "edit" && r.effect === "allow")).toBe(false);
    // The top-level backstop: whatever agent OpenCode restores from a previous tab has no edit, shell or subagent.
    expect(explore.permissions).toEqual(["edit", "shell", "subagent"].map((action) => ({ action, resource: "*", effect: "deny" })));
    expect(JSON.parse(buildCommand(config, choice("opencode", "plan")).env.OPENCODE_CONFIG_CONTENT!)).toEqual({ model: "opencode-go/deepseek-v4.1-flash", default_agent: "plan" });
    // Not for the others.
    for (const h of HARNESSES.filter((x) => x !== "opencode" && !HARNESS_INFO[x].modes.explore.unavailable)) expect(buildCommand(config, choice(h, "explore", "low")).env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  test("the mode's config never replaces `model` or `providers`", () => {
    const info = HARNESS_INFO.opencode;
    const was = info.modes.explore;
    info.modes.explore = { opencodeConfig: { model: "evil/model", providers: { evil: {} }, default_agent: "x" } };
    try {
      expect(JSON.parse(buildCommand(config, choice("opencode", "explore")).env.OPENCODE_CONFIG_CONTENT!)).toEqual({ model: "opencode-go/deepseek-v4.1-flash", default_agent: "x" });
    } finally {
      info.modes.explore = was;
    }
  });

  test("Codex plan: typed /plan, the effort of plan mode follows the effort, no flag of its own", () => {
    const cmd = buildCommand(config, choice("codex", "plan", "high", "x"));
    expect(cmd.firstLine).toBe("/plan");
    expect(cmd.mode).toBe("plan");
    expect(cmd.argv).toEqual(["codex", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "-c", 'plan_mode_reasoning_effort="high"', "--", "x"]);
    expect(buildCommand(config, choice("codex", "plan", undefined, "x")).argv).toEqual(["codex", "-m", "gpt-6.1-sol", "--", "x"]);
    for (const h of HARNESSES.filter((x) => !HARNESS_INFO[x].modes.explore.unavailable)) expect([h, buildCommand(config, choice(h, "explore", "low")).firstLine]).toEqual([h, HARNESS_INFO[h].typedSpec ? "" : undefined]);
  });

  test("Grok plan: typed /plan like Codex, and no Codex-only plan effort; its refusal names Grok Build", () => {
    const cmd = buildCommand(config, choice("grok-build", "plan", "high", "x"));
    expect(cmd.firstLine).toBe("/plan");
    expect(cmd.mode).toBe("plan");
    expect(cmd.argv.join(" ")).not.toContain("plan_mode_reasoning_effort");
    expect(cmd.argv).not.toContain("--permission-mode");
    expect(typedModeRefusal("grok-build")).toBe("Grok Build starts in plan mode only in Gluon's frame (Gluon types /plan into it); use --mode explore or build");
    expect(typedModeProblem("grok-build", "plan")).toBe(typedModeRefusal("grok-build"));
    expect(typedModeProblem("grok-build", "explore")).toBeNull();
    expect(typedModeProblem("claude-code", "plan")).toBeNull();
  });

  test("BUG-612/resume-modes: a resume applies explore's launch-time enforcement again (never a typed line, a spec or a brief), plan nothing, build nothing", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const ref = { id, resume: true };
    for (const h of HARNESSES) {
      if (!HARNESS_INFO[h].resume) continue;
      const plain = buildCommand(config, choice(h, "build", "high"), undefined, ref);
      // Plan is the conversation's state: nothing of it is applied again; a build record and no mode are the plain resume.
      for (const mode of [undefined, "build", "plan"] as const) expect([h, mode, buildCommand(config, choice(h, mode, "high"), undefined, ref)]).toEqual([h, mode, plain]);
      // Explore: every resumable harness gets its argv and OpenCode config again (Claude Code's too, as defence in depth).
      const explore = buildCommand(config, choice(h, "explore", "high"), undefined, ref);
      expect([h, explore]).not.toEqual([h, plain]);
      for (const cmd of [explore, plain]) {
        expect(cmd.firstLine).toBeUndefined();
        expect(cmd.mode).toBeUndefined();
        expect(cmd.spec).toBeUndefined();
        expect(cmd.resumed).toBe(true);
      }
    }
    expect(buildCommand(config, choice("claude-code", "plan", "high"), undefined, ref).argv.at(-1)).toBe(`--resume=${id}`);
    expect(buildCommand(config, choice("claude-code", "explore", "high"), undefined, ref).argv).toEqual(["claude", "--model", "sonnet", "--effort", "high", ...HARNESS_INFO["claude-code"].modes.explore.argv!, `--resume=${id}`]);
    expect(buildCommand(config, choice("claude-code", "explore", "high"), undefined, ref).argv.join(" ")).toContain("--permission-mode dontAsk --disallowedTools Edit Write");
    // Codex plan: `codex resume` alone, no typed /plan and no plan-mode effort.
    expect(buildCommand(config, choice("codex", "plan", "high"), undefined, ref).argv).toEqual(["codex", "resume", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "--", id]);
    expect(buildCommand(config, choice("codex", "plan", "high"), undefined, ref).firstLine).toBeUndefined();
  });

  test("BUG-612/resume-modes: Codex explore resumes with -s read-only -a never, before the --, the id last", () => {
    const id = "019a1b2c-d3e4";
    const cmd = buildCommand(config, choice("codex", "explore", "high"), undefined, { id, resume: true });
    expect(cmd.argv).toEqual(["codex", "resume", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "-s", "read-only", "-a", "never", "--", id]);
  });

  test("BUG-612/resume-modes: Grok Build explore resumes under its sandbox and deny rules (a launch-time process profile, not kept by the session)", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const argv = buildCommand(config, choice("grok-build", "explore", "high"), undefined, { id, resume: true }).argv;
    expect(argv).toEqual(["grok", "-m", "grok-4.7", "--reasoning-effort", "high", ...HARNESS_INFO["grok-build"].modes.explore.argv!, `--resume=${id}`]);
  });

  test("BUG-612/resume-modes: OpenCode explore resumes with the gluon-explore agent as default and its deny rules; OpenCode plan and build resume with neither; the model and effort stay Gluon's", () => {
    const id = "ses_3f2a9c0d1e8b";
    const cfgOf = (mode?: Mode) => JSON.parse(buildCommand(config, choice("opencode", mode, "high"), undefined, { id, resume: true }).env.OPENCODE_CONFIG_CONTENT!);
    const explore = cfgOf("explore");
    expect(explore.default_agent).toBe("gluon-explore");
    expect(Object.keys(explore.agents)).toEqual(["gluon-explore"]);
    expect(explore.permissions).toEqual(HARNESS_INFO.opencode.modes.explore.opencodeConfig!.permissions);
    expect(explore.model).toBe(cfgOf("build").model);
    expect(explore.providers).toEqual(cfgOf("build").providers);
    for (const mode of [undefined, "build", "plan"] as const) {
      expect(cfgOf(mode).default_agent).toBeUndefined();
      expect(cfgOf(mode).agents).toBeUndefined();
    }
    const cmd = buildCommand(config, choice("opencode", "explore", "high"), undefined, { id, resume: true });
    expect(cmd.argv).toEqual(["opencode", "--standalone", `--session=${id}`]);
  });

  test("BUG-612/resume-modes: modeLostOnResume names the harnesses whose explore is in the launch and that can resume: Codex, Grok Build, OpenCode", () => {
    expect(HARNESSES.filter((h) => modeLostOnResume(h))).toEqual(["codex", "grok-build", "opencode"]);
  });
});

describe("a resumed explore session (QA-live-02)", () => {
  // Live (Codex 0.160.0 on Bedrock, OpenCode 2.0.21 on OpenRouter): after `gluon resume`, a session started in explore was no longer read-only.
  // Codex's /status said "Read Only (never)" at the launch and "Workspace (never)" after the resume; OpenCode's footer said Build, not
  // Gluon-Explore (its deny rules gone). Claude Code keeps its permission mode in the session, so it stayed read-only.
  test("BUG-612/resume-modes: resuming an explore session of Codex keeps -s read-only -a never", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const argv = buildCommand(config, choice("codex", "explore", "high"), undefined, { id, resume: true }).argv;
    expect(argv.join(" ")).toContain("-s read-only");
    expect(argv.join(" ")).toContain("-a never");
  });
});

describe("launchPlan with a typed first line", () => {
  test("the spec goes into a private file and out of argv (and its `--`); the line names the file", () => {
    const cmd = buildCommand(config, choice("codex", "plan", "high", "- fix the bug\n- and more"));
    const plan = launchPlan(cmd, "/usr/bin/codex", { tmp });
    try {
      expect(plan.argv).toEqual(["/usr/bin/codex", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"', "-c", 'plan_mode_reasoning_effort="high"']);
      expect(plan.specFile).toBeDefined();
      expect(readFileSync(plan.specFile!, "utf8")).toBe("- fix the bug\n- and more\n");
      expect(readFileSync(join(dirname(plan.specFile!), "pid"), "utf8")).toBe(String(process.pid));
      expect(plan.firstLine).toBe(`/plan Read the session brief in ${plan.specFile} and start.`);
    } finally {
      rmSync(dirname(plan.specFile!), { recursive: true, force: true });
    }
  });

  test("through a Windows shim: the file path is cmd-safe and the argv passes assertShimArgs (an effort's quotes are refused there, as for build)", () => {
    const plan = launchPlan(buildCommand(config, choice("codex", "plan")), "C:\\npm\\codex.cmd", { tmp });
    try {
      expect(plan.argv).toEqual(["C:\\npm\\codex.cmd", "-m", "gpt-6.1-sol"]);
      expect(plan.firstLine).toBe(`/plan Read the session brief in ${plan.specFile} and start.`);
      expect(readFileSync(plan.specFile!, "utf8")).toBe("- fix the bug\n");
    } finally {
      rmSync(dirname(plan.specFile!), { recursive: true, force: true });
    }
    expect(() => launchPlan(buildCommand(config, choice("codex", "plan", "high")), "C:\\npm\\codex.cmd", { tmp })).toThrow("which cmd.exe would act on");
  });

  test("a command without a first line is as before: no firstLine, the spec in argv", () => {
    const plan = launchPlan(buildCommand(config, choice("claude-code", "explore", "high")), "/usr/bin/claude", { tmp });
    expect(plan.firstLine).toBeUndefined();
    expect(plan.specFile).toBeUndefined();
    expect(plan.argv.at(-1)).toBe("- fix the bug");
  });
});

describe("where nothing can type", () => {
  test("handOff and handOffSession refuse a command with a first line, before anything starts", async () => {
    const cmd = buildCommand(config, choice("codex", "plan", "high"));
    await expect(handOff(cmd)).rejects.toThrow(typedModeRefusal("codex"));
    await expect(handOffSession(cmd, handoffFor(config.handoff, "codex"), undefined, tmp)).rejects.toThrow(typedModeRefusal("codex"));
    expect(typedModeRefusal("codex")).toBe("Codex starts in plan mode only in Gluon's frame (Gluon types /plan into it); use --mode explore or build");
    expect(existsSync(tmp)).toBe(true);
  });
});

describe("BUG-410/launch-modes: the brief says what the mode allows, whatever the spec says", () => {
  test("build adds nothing; explore and plan add a short block after the spec, naming no harness", () => {
    expect(withMode("Do it.", undefined)).toBe("Do it.");
    expect(withMode("Do it.", "build")).toBe("Do it.");
    expect(modeBrief("build")).toBeNull();
    const explore = withMode("  Fix the add bug.\n", "explore");
    expect(explore).toStartWith("Fix the add bug.\n\n## Mode: explore\n");
    expect(explore).toMatch(/read-only/);
    expect(explore).toMatch(/no changes/i);
    const plan = withMode("Fix the add bug.", "plan");
    expect(plan).toStartWith("Fix the add bug.\n\n## Mode: plan\n");
    expect(plan).toMatch(/don't implement/);
    expect(plan).toMatch(/approve/);
    for (const text of [explore, plan]) {
      expect(text.length).toBeLessThan(900);
      for (const h of HARNESSES) expect(text.toLowerCase()).not.toContain(HARNESS_INFO[h].label.toLowerCase());
    }
  });
});

test("every mode has a launch for every harness", () => {
  for (const h of HARNESSES) for (const m of MODES.filter((x) => x !== "build")) expect([h, m, HARNESS_INFO[h].modes[m]]).toEqual([h, m, expect.any(Object)]);
});
