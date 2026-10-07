/**
 * `src/status.ts` on its own: what each official binary's output (signed in, signed out, garbage, a hang)
 * becomes, with fake binaries on PATH (shell scripts, so POSIX only: the Windows fakes are compiled and
 * covered by the e2e suite). Never a real `claude` / `agy` / `grok`. Security QA pass.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { claudeStatus, firstLine, isTransient, listedModels, loginStatus, onPlan, planLabel, run, versionOf, type ClaudeStatus } from "../src/status.ts";

const POSIX = process.platform !== "win32";
const TMP = mkdtempSync(join(tmpdir(), "gluon-status-login-"));
const saved = { ...process.env };
let n = 0;

/** A PATH with only the fakes named (name → shell body), and `/bin` for the shell. */
function fakes(bins: Record<string, string>): string {
  const dir = join(TMP, `bin${++n}`);
  mkdirSync(dir);
  for (const [name, body] of Object.entries(bins)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  process.env.PATH = [dir, "/usr/bin", "/bin"].join(delimiter);
  return dir;
}

beforeAll(() => {
  process.env.GLUON_CONFIG = join(TMP, "config.yaml");
});
afterEach(() => {
  process.env.PATH = saved.PATH;
});
afterAll(() => {
  Object.assign(process.env, saved);
  rmSync(TMP, { recursive: true, force: true });
});

describe("the small pure pieces", () => {
  test("isTransient: a timeout, the network, a limit or a 5xx pass; a signed-out answer or a rejected key doesn't", () => {
    for (const m of ["timed out", "request timeout", "fetch failed", "ECONNRESET", "getaddrinfo ENOTFOUND api.x.com", "rate limit exceeded", "429 Too Many Requests", "503 Service Unavailable", "server error", "overloaded", "try again later", "usage limit reached"]) expect(isTransient(m), m).toBe(true);
    for (const m of ["not logged in", "invalid API key", "401 Unauthorized", "model not found", "access denied"]) expect(isTransient(m), m).toBe(false);
  });
  test("firstLine is the first line of the trimmed text; empty for nothing", () => {
    expect(firstLine("\n  hello\nworld")).toBe("hello");
    expect(firstLine("")).toBe("");
  });
  test("planLabel / onPlan: a plan by its type or by claude.ai; a key or another method is not a plan", () => {
    const s = (o: Partial<ClaudeStatus>): ClaudeStatus => ({ installed: true, loggedIn: true, ...o });
    expect(planLabel(s({ subscriptionType: "max" }))).toBe("Claude Max plan");
    expect(planLabel(s({ authMethod: "claude.ai" }))).toBe("Claude plan");
    expect(planLabel(s({ authMethod: "api_key" }))).toBe("api_key (not a Claude plan)");
    expect(planLabel(s({}))).toBe("signed in");
    expect(onPlan(s({ subscriptionType: "pro" }))).toBe(true);
    expect(onPlan(s({ authMethod: "claude.ai" }))).toBe(true);
    expect(onPlan(s({ authMethod: "api_key" }))).toBe(false);
  });
});

describe.skipIf(!POSIX)("run", () => {
  test("runs in an empty private directory, never the caller's cwd (a repository's bunfig.toml / .env must not be seen), with the env it is given", async () => {
    fakes({ probe: 'pwd; ls -A | wc -l; echo "VAR=$PROBE_VAR"' });
    const r = await run([join(process.env.PATH!.split(delimiter)[0]!, "probe")], 5000, { ...process.env, PROBE_VAR: "x" });
    const [cwd, count, v] = r.stdout.trim().split("\n");
    expect(cwd).toContain("gluon-cwd-");
    expect(Number(count)).toBe(1); // its own `pid` file only
    expect(v).toBe("VAR=x");
    expect(r.code).toBe(0);
  });
  test("a command that hangs is killed at its timeout (code null) and a child holding the pipe doesn't hold the call", async () => {
    const dir = fakes({ hang: "sleep 30 &\nsleep 30" });
    const t = performance.now();
    const r = await run([join(dir, "hang")], 300);
    expect(r.code).toBeNull();
    expect(performance.now() - t).toBeLessThan(3000);
  });
  test("a binary killed by a signal is null too; a plain non-zero exit keeps its code and both streams", async () => {
    const dir = fakes({ boom: "echo out; echo err >&2; exit 7", sig: "kill -9 $$" });
    expect(await run([join(dir, "boom")], 5000)).toEqual({ stdout: "out\n", stderr: "err\n", code: 7 });
    expect((await run([join(dir, "sig")], 5000)).code).toBeNull();
  });
});

describe.skipIf(!POSIX)("claude auth status", () => {
  test("not installed", async () => {
    fakes({});
    expect(await claudeStatus()).toEqual({ installed: false, loggedIn: false });
    expect(await loginStatus("claude-code")).toEqual({ installed: false, loggedIn: false });
  });
  test("signed in to a plan: its label, and nothing of the account (an email in the JSON never comes through)", async () => {
    fakes({ claude: `echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"me@example.com","orgId":"org-123"}'` });
    const s = await claudeStatus();
    expect(s).toEqual({ installed: true, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
    expect(JSON.stringify(s)).not.toContain("me@example.com");
    expect(await loginStatus("claude-code")).toEqual({ installed: true, loggedIn: true, detail: "Claude Max plan" });
  });
  test("signed in with an API key: signed in, but the wrong method", async () => {
    fakes({ claude: `echo '{"loggedIn":true,"authMethod":"api_key"}'` });
    const s = await loginStatus("claude-code");
    expect(s).toMatchObject({ installed: true, loggedIn: true, detail: "api_key (not a Claude plan)", wrongMethod: expect.stringContaining("not a Claude plan") });
  });
  test("signed out is a definitive answer (no error, not transient)", async () => {
    fakes({ claude: `echo '{"loggedIn":false}'; exit 1` });
    expect(await loginStatus("claude-code")).toEqual({ installed: true, loggedIn: false });
  });
  test("garbage, an empty answer and a crash are transient failures that say what the binary printed, with keys masked", async () => {
    fakes({ claude: "echo 'oops sk-ant-api03-abcdefghijklmnopqrstuvwx' >&2; exit 3" });
    const a = await loginStatus("claude-code");
    expect(a).toMatchObject({ installed: true, loggedIn: false, transient: true });
    expect(a.error).toContain("`claude auth status` failed: oops sk-ant-••••");
    expect(a.error).not.toContain("abcdefghijklmnopqrstuvwx");
    fakes({ claude: "exit 0" });
    expect((await loginStatus("claude-code")).error).toContain("failed: exit 0");
    fakes({ claude: "echo '<html>captive portal</html>'" });
    expect((await loginStatus("claude-code")).error).toContain("<html>captive portal</html>");
  });
  test("a JSON that isn't an object (`null`, `[]`, `7`) is read as garbage, never as a crash", async () => {
    for (const out of ["null", "[]", "7", '"x"']) {
      fakes({ claude: `echo '${out}'` });
      const s = await claudeStatus();
      expect(s.loggedIn, out).toBe(false);
    }
  });
});

describe.skipIf(!POSIX)("agy models / grok models", () => {
  test("agy: its tab-separated list is signed in, with the ids", async () => {
    fakes({ agy: "printf 'gemini-3.8-pro\\tGemini 3.8 Pro\\ngemini-3.8-flash\\tGemini Flash\\n'" });
    expect(await listedModels("agy")).toEqual({ loggedIn: true, models: ["gemini-3.8-pro", "gemini-3.8-flash"] });
    expect(await loginStatus("antigravity")).toMatchObject({ installed: true, loggedIn: true, detail: "Google account", models: ["gemini-3.8-pro", "gemini-3.8-flash"] });
  });
  test("grok: the default marker, colour codes and the account line are understood; ids without a digit are not models", async () => {
    fakes({ grok: "printf '\\033[1mFetching available models...\\033[0m\\nlogged in with SuperGrok.\\n* grok-build-1 (default)\\n  grok-build-2\\n  notes\\n'" });
    const r = await listedModels("grok");
    expect(r.models).toEqual(["grok-build-1", "grok-build-2"]);
    expect(r.loggedIn).toBe(true);
    expect(r.account).toBe("SuperGrok");
    expect(await loginStatus("grok-build")).toMatchObject({ detail: "SuperGrok account" });
  });
  test("signed out: a non-zero exit or an empty list says why, as one masked line; a rate limit is transient, a sign-out is not", async () => {
    fakes({ grok: "echo 'Not logged in. Run grok login.' >&2; exit 1" });
    expect(await loginStatus("grok-build")).toMatchObject({ installed: true, loggedIn: false, error: "Not logged in. Run grok login." });
    expect((await loginStatus("grok-build")).transient).toBeUndefined();
    fakes({ grok: "echo '429 rate limit'; exit 1" });
    expect(await loginStatus("grok-build")).toMatchObject({ loggedIn: false, transient: true });
    fakes({ agy: "exit 0" });
    expect(await listedModels("agy")).toMatchObject({ loggedIn: false, models: [], error: "exit 0" });
  });
  test("not installed", async () => {
    fakes({});
    expect(await listedModels("grok")).toMatchObject({ loggedIn: false, error: "grok is not installed (not found on PATH)" });
    expect(await loginStatus("grok-build")).toEqual({ installed: false, loggedIn: false });
  });
  test("a key printed by the binary is masked in the error", async () => {
    fakes({ agy: "echo 'AIzaSyA1234567890abcdefghijklmnopqrstu rejected'; exit 2" });
    const r = await listedModels("agy");
    expect(r.error).toBe("AIza•••• rejected");
  });
});

describe.skipIf(!POSIX)("versionOf", () => {
  test("the first number of the first line; stderr when stdout is empty; null on failure or silence", async () => {
    fakes({ claude: "echo '2.1.140 (Claude Code)'" });
    expect(await versionOf("claude-code")).toBe("2.1.140");
    fakes({ codex: "echo 'codex-cli 0.159.0-beta.1' >&2" });
    expect(await versionOf("codex")).toBe("0.159.0-beta.1");
    fakes({ claude: "echo 2.1.140; exit 1" });
    expect(await versionOf("claude-code")).toBeNull();
    fakes({ claude: "exit 0" });
    expect(await versionOf("claude-code")).toBeNull();
    fakes({});
    expect(await versionOf("claude-code")).toBeNull();
  });
  test("a binary that prints a version with no number is shown as it is", async () => {
    fakes({ claude: "echo 'nightly'" });
    expect(await versionOf("claude-code")).toBe("nightly");
  });
});

test.skipIf(!POSIX)("the status checks never run in the repository: a fake `claude` that records its cwd sees the neutral directory", async () => {
  const log = join(TMP, "cwd.log");
  fakes({ claude: `pwd > '${log}'; echo '{"loggedIn":false}'` });
  const prev = process.cwd();
  const repo = mkdtempSync(join(tmpdir(), "gluon-hostile-repo-"));
  writeFileSync(join(repo, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  process.chdir(repo);
  try {
    await claudeStatus();
  } finally {
    process.chdir(prev);
  }
  expect(readFileSync(log, "utf8").trim()).toContain("gluon-cwd-");
});
