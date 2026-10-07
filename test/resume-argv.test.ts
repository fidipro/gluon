/**
 * How each harness starts a session under an id Gluon names and how it resumes one (issue #42):
 * the argv `buildCommand` makes, that a spec starting with `-` stays after `--`, that telemetry
 * options still go before the `--` of a resume, and that a resume id never reads as an option.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_DIR } from "../src/adapters/types.ts";
import { loadConfig } from "../src/config.ts";
import { HARNESS_INFO, HARNESSES, type Harness } from "../src/harnesses.ts";
import { buildCommand, launchPlan, substituteTokens, withTelemetry, type Command } from "../src/launchers.ts";
import { telemetryLaunch } from "../src/telemetry.ts";

const config = loadConfig();
const ID = "0b1f3c5e-1111-4222-8333-444455556666";
const SPEC = "- fix the add bug";
const modelOf = (h: Harness) => (h === "codex" ? "gpt-6.1-sol" : h === "claude-code" ? "sonnet" : config.agents.find((a) => a.harness === h)!.models[0]!.id);
const build = (h: Harness, session?: { id: string; resume: boolean }) => buildCommand(config, { harness: h, model: modelOf(h), spec: SPEC, reason: "" }, undefined, session);

describe("BUG-313/resume: argv per harness", () => {
  test("Claude Code: --session-id <id> before the --; a resume is --resume=<id> with no spec", () => {
    expect(build("claude-code").argv).toEqual(["claude", "--model", "sonnet", "--", SPEC]);
    expect(build("claude-code", { id: ID, resume: false }).argv).toEqual(["claude", "--model", "sonnet", "--session-id", ID, "--", SPEC]);
    const r = build("claude-code", { id: ID, resume: true });
    expect(r.argv).toEqual(["claude", "--model", "sonnet", `--resume=${ID}`]);
    expect(r.spec).toBeUndefined();
    expect(r.resumed).toBe(true);
  });

  test("Grok Build: the same flags", () => {
    expect(build("grok-build", { id: ID, resume: false }).argv).toEqual(["grok", "-m", "grok-4.7", "--session-id", ID, "--", SPEC]);
    expect(build("grok-build", { id: ID, resume: true }).argv).toEqual(["grok", "-m", "grok-4.7", `--resume=${ID}`]);
  });

  test("Codex: a new session is as before (its id comes by hook); a resume is `codex resume -m … -- <id>`", () => {
    const fresh = ["codex", "-m", "gpt-6.1-sol", "--", SPEC];
    expect(build("codex").argv).toEqual(fresh);
    expect(build("codex", { id: ID, resume: false }).argv).toEqual(fresh);
    const r = build("codex", { id: "019a1b2c-d3e4", resume: true });
    expect(r.argv).toEqual(["codex", "resume", "-m", "gpt-6.1-sol", "--", "019a1b2c-d3e4"]);
    expect(r.spec).toBeUndefined();
  });

  test("OpenCode: a resume is --session=<id> instead of --prompt=<spec>", () => {
    expect(build("opencode").argv).toEqual(["opencode", "--standalone", `--prompt=${SPEC}`]);
    expect(build("opencode", { id: "ses_3f2a9c", resume: false }).argv).toEqual(["opencode", "--standalone", `--prompt=${SPEC}`]);
    expect(build("opencode", { id: "ses_3f2a9c", resume: true }).argv).toEqual(["opencode", "--standalone", "--session=ses_3f2a9c"]);
  });

  test("Antigravity: unchanged, and a resume is refused (its argv would start a new session)", () => {
    const argv = build("antigravity").argv;
    expect(argv.at(-1)).toBe(`--prompt-interactive=${SPEC}`);
    expect(build("antigravity", { id: ID, resume: false }).argv).toEqual(argv);
    expect(HARNESS_INFO.antigravity.resume).toBeUndefined();
    expect(() => build("antigravity", { id: ID, resume: true })).toThrow("can't resume a session");
  });

  test("every harness says how it resumes, and only those with an argv for it", () => {
    expect(Object.fromEntries(HARNESSES.map((h) => [h, HARNESS_INFO[h].resume]))).toEqual({ "claude-code": "minted", codex: "captured", antigravity: undefined, "grok-build": "minted", opencode: "captured" });
  });

  test("an id that could be read as an option never reaches an argv", () => {
    for (const h of HARNESSES) for (const id of ["-x", "--resume=evil", "a b", "", "x".repeat(65), "a\nb"]) for (const resume of [true, false]) expect(() => build(h, { id, resume })).toThrow("not a valid session id");
  });
});

describe("BUG-287/resume: a resume through telemetry, tokens and Windows shims", () => {
  const session = { token: "ab".repeat(24), endpoint: "http://127.0.0.1:4318" };

  test("withTelemetry still puts Codex's options before the -- of a resume, and Claude's variables in", () => {
    const codex = build("codex", { id: "019a1b2c-d3e4", resume: true });
    const t = telemetryLaunch("codex", session, {})!;
    const r = withTelemetry(codex, t);
    expect(r.argv).toEqual(["codex", "resume", "-m", "gpt-6.1-sol", ...t.argv, "--", "019a1b2c-d3e4"]);
    const claude = build("claude-code", { id: ID, resume: true });
    const c = withTelemetry(claude, telemetryLaunch("claude-code", session, {}));
    expect(c.argv).toEqual(claude.argv);
    expect(c.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(session.endpoint);
    // OpenCode's resume has no `--`: nothing is inserted into it.
    const oc = build("opencode", { id: "ses_3f2a9c", resume: true });
    expect(withTelemetry(oc, { env: {}, argv: ["-c", "y"] }).argv).toEqual(oc.argv);
  });

  test("tokens are substituted in every argument of a resume (there is no spec to leave alone)", () => {
    const cmd: Command = { argv: ["claude", "--settings", ADAPTER_DIR, `--resume=${ID}`], env: {}, resumed: true, harness: "claude-code" };
    expect(substituteTokens(cmd, "/a", "/s").argv).toEqual(["claude", "--settings", "/a", `--resume=${ID}`]);
    const codex = build("codex", { id: "019a1b2c-d3e4", resume: true });
    expect(substituteTokens(codex, "/a", "/s").argv).toEqual(codex.argv);
  });

  test("a Windows .cmd shim: a resume has no spec, so launchPlan leaves every argument as it is and writes no file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gluon-resume-plan-"));
    try {
      for (const h of ["claude-code", "codex", "grok-build", "opencode"] as const) {
        const cmd = build(h, { id: h === "opencode" ? "ses_3f2a9c" : ID, resume: true });
        const p = launchPlan(cmd, `C:\\npm\\${HARNESS_INFO[h].binary}.cmd`, { tmp });
        expect(p.specFile).toBeUndefined();
        expect(p.argv).toEqual([`C:\\npm\\${HARNESS_INFO[h].binary}.cmd`, ...cmd.argv.slice(1)]);
      }
      expect(readdirSync(tmp)).toEqual([]);
      // A new session through the shim still gets its spec in a file, the minted id kept as an option.
      const fresh = launchPlan(build("claude-code", { id: ID, resume: false }), "C:\\npm\\claude.cmd", { tmp });
      expect(fresh.specFile).toBeDefined();
      expect(fresh.argv).toContain(`${ID}`);
      expect(fresh.argv.at(-1)).toContain("Read the session brief in");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
