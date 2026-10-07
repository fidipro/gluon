/**
 * Gluon's own files in Grok Build's hooks directory and Antigravity's plugins directory
 * (`src/adapters/permanent.ts`, issue #13), and the hooks they run (`grok-build.ts`,
 * `antigravity.ts`). Always under a temp HOME: never the real ~/.grok or ~/.gemini. Today only
 * grok's file is written; v1's agy plugin is only removed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { antigravity } from "../src/adapters/antigravity.ts";
import { COMPACT_HOOK_TIMEOUT_S } from "../src/adapters/common.ts";
import { grokBuild } from "../src/adapters/grok-build.ts";
import { adapterOutput } from "../src/adapters/index.ts";
import { ensurePermanentFiles, grokHooks, listPermanentFiles, removePermanentFiles } from "../src/adapters/permanent.ts";
import type { HookResult } from "../src/adapters/types.ts";
import type { StatusInfo } from "../src/events.ts";
import { defaults } from "../src/config.ts";
import { handoffLines } from "../src/doctor.ts";
import { readEvents, writeAnswer } from "../src/events.ts";
import { handoffDefaults, handoffFor } from "../src/handoff.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-permanent-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const ROOT = join(import.meta.dir, "..");
const POSIX = process.platform !== "win32";

let n = 0;
const newHome = () => {
  const home = join(TMP, `home-${++n}`);
  mkdirSync(home);
  return home;
};

/** Every file under `dir`, relative, sorted. */
const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll("\\", "/"))
    .sort();

const GROK = ".grok/hooks/gluon.json";
const AGY = [".gemini/config/plugins/fidicode/hooks.json", ".gemini/config/plugins/fidicode/plugin.json"];
/** v1's agy plugin, as an older Gluon left it. */
const oldAgyPlugin = (home: string) => {
  mkdirSync(join(home, ".gemini/config/plugins/fidicode"), { recursive: true });
  for (const f of AGY) writeFileSync(join(home, f), "{}");
};

describe("permanent files", () => {
  test("write exactly ~/.grok/hooks/gluon.json, private; agy gets nothing; list and remove only them (v1's agy plugin too)", () => {
    const home = newHome();
    const opts = { home, env: {} };
    expect(ensurePermanentFiles("grok-build", opts)).toBeNull();
    for (const h of ["antigravity", "claude-code", "codex", "opencode"] as const) expect(ensurePermanentFiles(h, opts)).toBeNull();
    expect(tree(home)).toEqual([GROK]);
    expect(readFileSync(join(home, GROK), "utf8")).toBe(grokHooks());
    if (POSIX) expect(statSync(join(home, GROK)).mode & 0o777).toBe(0o600);
    oldAgyPlugin(home);
    // The name before the rename (`fidicode`): listed and removed, never written.
    const legacy = ".grok/hooks/fidicode.json";
    writeFileSync(join(home, legacy), "{}");
    expect(listPermanentFiles(opts)).toEqual([join(home, GROK), join(home, legacy), join(home, ".gemini/config/plugins/fidicode")]);
    expect(removePermanentFiles(opts)).toEqual([join(home, GROK), join(home, legacy), join(home, ".gemini/config/plugins/fidicode")]);
    expect(tree(home)).toEqual([]);
    expect(listPermanentFiles(opts)).toEqual([]);
    expect(removePermanentFiles(opts)).toEqual([]);
  });

  test("an Antigravity launch removes v1's agy plugin (its hook has no job any more), nothing else", () => {
    const home = newHome();
    oldAgyPlugin(home);
    mkdirSync(join(home, ".gemini/config/plugins/other"), { recursive: true });
    writeFileSync(join(home, ".gemini/config/plugins/other/plugin.json"), "{}");
    expect(ensurePermanentFiles("antigravity", { home, env: {} })).toBeNull();
    expect(tree(home)).toEqual([".gemini/config/plugins/other/plugin.json"]);
  });

  test("leave everything else in those directories alone, and don't read it", () => {
    const home = newHome();
    const others = [".grok/hooks/mine.json", ".grok/config.toml", ".grok/auth.json", ".gemini/config/plugins/other/plugin.json", ".gemini/config/hooks.json", ".gemini/settings.json"];
    for (const f of others) {
      mkdirSync(join(home, f, ".."), { recursive: true });
      writeFileSync(join(home, f), `{"owner":"${f}"}`);
      // Unreadable: a read would throw (unless the tests run as root).
      if (POSIX) chmodSync(join(home, f), 0o000);
    }
    const opts = { home, env: {} };
    expect(ensurePermanentFiles("grok-build", opts)).toBeNull();
    expect(ensurePermanentFiles("antigravity", opts)).toBeNull();
    expect(tree(home)).toEqual([...others, GROK].sort());
    removePermanentFiles(opts);
    for (const f of others) {
      if (POSIX) chmodSync(join(home, f), 0o600);
      expect(readFileSync(join(home, f), "utf8")).toBe(`{"owner":"${f}"}`);
    }
    expect(tree(home)).toEqual([...others].sort());
  });

  test("written only when missing or different", () => {
    const home = newHome();
    const opts = { home, env: {} };
    ensurePermanentFiles("grok-build", opts);
    const file = join(home, GROK);
    const before = statSync(file);
    ensurePermanentFiles("grok-build", opts);
    expect(statSync(file).ino).toBe(before.ino);
    writeFileSync(file, "{}");
    ensurePermanentFiles("grok-build", opts);
    expect(readFileSync(file, "utf8")).toBe(grokHooks());
    expect(tree(home)).toEqual([GROK]);
  });

  test("GROK_HOME wins, as in grok", () => {
    const home = newHome();
    const grokHome = join(home, "elsewhere");
    ensurePermanentFiles("grok-build", { home, env: { GROK_HOME: grokHome } });
    expect(tree(home)).toEqual(["elsewhere/hooks/gluon.json"]);
    expect(removePermanentFiles({ home, env: { GROK_HOME: grokHome } })).toEqual([join(grokHome, "hooks", "gluon.json")]);
  });

  test("a failure is a note, not an error", () => {
    if (!POSIX || process.getuid?.() === 0) return;
    const home = newHome();
    mkdirSync(join(home, ".grok"));
    chmodSync(join(home, ".grok"), 0o500);
    const note = ensurePermanentFiles("grok-build", { home, env: {} });
    chmodSync(join(home, ".grok"), 0o700);
    expect(note).toStartWith("couldn't write ~/.grok/hooks/gluon.json (EACCES)");
  });

  test("Windows: grok gets the PowerShell form; with GROK_SHELL=bash or cmd none (and an old one goes); agy gets no plugin", () => {
    const home = newHome();
    expect(ensurePermanentFiles("grok-build", { home, env: {}, platform: "win32" })).toBeNull();
    expect(readFileSync(join(home, GROK), "utf8")).toBe(grokHooks("win32"));
    expect(grokHooks("win32")).toContain("if (${env:GLUON_EVENTS} -and ${env:GLUON_SELF}) { & ${env:GLUON_SELF} hook grok-build pre-compact }");
    expect(ensurePermanentFiles("grok-build", { home, env: { GROK_SHELL: "cmd" }, platform: "win32" })).toContain("GROK_SHELL=cmd");
    expect(existsSync(join(home, GROK))).toBe(false);
    expect(ensurePermanentFiles("antigravity", { home, env: {}, platform: "win32" })).toBeNull();
    expect(tree(home)).toEqual([]);
  });

  test("the contents never change between installs: no path, no environment value", async () => {
    const texts = () => [grokHooks("linux"), grokHooks("darwin"), grokHooks("win32")].join("\n");
    const saved = process.env.GLUON_SELF;
    process.env.GLUON_SELF = "/opt/one/gluon";
    const a = texts();
    process.env.GLUON_SELF = "C:\\Two Words\\gluon.exe";
    const b = texts();
    if (saved === undefined) delete process.env.GLUON_SELF;
    else process.env.GLUON_SELF = saved;
    expect(a).toBe(b);
    for (const bad of [process.execPath, ROOT, tmpdir(), "/opt/one", "Two Words"]) expect(a).not.toContain(bad);
    // Two homes, two ways of running Gluon: the same bytes.
    const [h1, h2] = [newHome(), newHome()];
    process.env.GLUON_SELF = "/x";
    ensurePermanentFiles("grok-build", { home: h1, env: { GLUON_SELF: "/x" } });
    process.env.GLUON_SELF = "/y";
    ensurePermanentFiles("grok-build", { home: h2, env: { GLUON_SELF: "/y" } });
    if (saved === undefined) delete process.env.GLUON_SELF;
    else process.env.GLUON_SELF = saved;
    expect(readFileSync(join(h1, GROK), "utf8")).toBe(readFileSync(join(h2, GROK), "utf8"));
  });

  test("grok's file: one PreCompact hook for both triggers, with a timeout above the hook's wait; the status hooks", () => {
    // The POSIX file (Windows gets the PowerShell form, checked above).
    const grok = JSON.parse(grokHooks("linux"));
    const cmd = (name: string) => `[ -z "\${GLUON_EVENTS:-}" ] || [ -z "\${GLUON_SELF:-}" ] || exec "\${GLUON_SELF:-}" hook grok-build ${name}`;
    const status = (name: string, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd(name), timeout: 5 }] });
    expect(grok.hooks).toEqual({
      PreCompact: [{ hooks: [{ type: "command", command: cmd("pre-compact"), timeout: COMPACT_HOOK_TIMEOUT_S }] }],
      UserPromptSubmit: [status("prompt")],
      PreToolUse: [status("tool")],
      PostToolUse: [status("tool-done")],
      // grok's Notification matcher is the notification's type.
      Notification: [status("permission", "permission_prompt"), status("idle", "idle_prompt")],
      Stop: [status("stop")],
      StopFailure: [status("stop")],
      StopCancelled: [status("stop")],
    });
    // On Windows, per turn only: every grok session would start PowerShell twice per tool call.
    const win = JSON.parse(grokHooks("win32")).hooks;
    expect(Object.keys(win)).toEqual(["PreCompact", "UserPromptSubmit", "Notification", "Stop", "StopFailure", "StopCancelled"]);
    expect(win.Notification[0]).toEqual({ matcher: "permission_prompt", hooks: [{ type: "command", command: "if (${env:GLUON_EVENTS} -and ${env:GLUON_SELF}) { & ${env:GLUON_SELF} hook grok-build permission }", timeout: 5 }] });
    // Seconds: Gluon's 2-minute question plus slack.
    expect(COMPACT_HOOK_TIMEOUT_S).toBe(130);
    // grok runs a command naming a plain unset $VAR / ${VAR} not at all, and says so: only modifier forms.
    for (const text of [grokHooks("linux"), grokHooks("win32")]) expect(text).not.toMatch(/\$[A-Za-z_]|\$\{[A-Za-z_]\w*\}/);
  });
});

/** Every POSIX command in the files. */
const posixCommands = (): string[] => {
  const grok = JSON.parse(grokHooks("linux"));
  return Object.values(grok.hooks).flatMap((groups) => (groups as { hooks: { command: string }[] }[]).flatMap((g) => g.hooks.map((h) => h.command)));
};

describe.if(POSIX)("the commands, run by sh -c", () => {
  const sh = (command: string, env: Record<string, string>, stdin = "") => {
    const r = Bun.spawnSync(["/bin/sh", "-c", command], { env, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("exit 0 and print nothing outside a Gluon launch (no environment at all), or with half of it", () => {
    expect(posixCommands().length).toBe(9);
    for (const c of posixCommands()) {
      expect(sh(c, {})).toEqual({ code: 0, out: "", err: "" });
      expect(sh(c, { GLUON_EVENTS: TMP })).toEqual({ code: 0, out: "", err: "" });
      expect(sh(c, { GLUON_SELF: "/nonexistent/gluon" })).toEqual({ code: 0, out: "", err: "" });
    }
  });

  test("inside a launch they run $GLUON_SELF hook <harness> <name> with the harness's input", () => {
    const self = join(TMP, "self with space");
    writeFileSync(self, `#!/bin/sh\nprintf '%s|' "$@"; cat\n`, { mode: 0o700 });
    const [compact] = posixCommands();
    expect(sh(compact!, { GLUON_EVENTS: TMP, GLUON_SELF: self }, '{"x":1}')).toEqual({ code: 0, out: 'hook|grok-build|pre-compact|{"x":1}', err: "" });
  });

  test("end to end: grok's PreCompact hook sends `compact <id>` and waits for Gluon's answer; a marker from a typed /compact skips the question", async () => {
    const events = mkdtempSync(join(TMP, "events-"));
    const self = join(TMP, "gluon-src");
    writeFileSync(self, `#!/bin/sh\nexec '${process.execPath}' --no-env-file --config=/dev/null '${join(ROOT, "src", "cli.tsx")}' "$@"\n`, { mode: 0o700 });
    const [compact] = posixCommands();
    const env = { GLUON_EVENTS: events, GLUON_SELF: self, GLUON_HANDOFF: "clear,compact", PATH: process.env.PATH ?? "" };
    const proc = Bun.spawn(["/bin/sh", "-c", compact!], { env, stdin: Buffer.from('{"trigger":"auto"}'), stdout: "pipe", stderr: "pipe" });
    const seen = new Set<string>();
    let asked: { name: string; id?: string }[] = [];
    for (let i = 0; i < 200 && !asked.length; i++) {
      asked = readEvents(events, seen);
      await Bun.sleep(25);
    }
    expect(asked).toEqual([{ name: "compact", id: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    writeAnswer(events, asked[0]!.id!, true);
    // grok can't be stopped by a hook: it prints nothing either way (Gluon ends grok).
    expect([await proc.exited, await new Response(proc.stdout).text()]).toEqual([0, ""]);
  });
});

describe.if(process.platform === "win32")("the PowerShell command (grok on Windows)", () => {
  test("exits 0 and prints nothing without the environment", () => {
    const ps = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const command = JSON.parse(grokHooks("win32")).hooks.PreCompact[0].hooks[0].command;
    const r = Bun.spawnSync([ps, "-NoProfile", "-NonInteractive", "-Command", command], { env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }, stdin: Buffer.from("{}"), stdout: "pipe", stderr: "pipe" });
    expect({ code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }).toEqual({ code: 0, out: "", err: "" });
  });
});

describe("Grok Build adapter", () => {
  const ctx = (over: object = {}) => ({ harness: "grok-build" as const, version: "1.0.46", handoff: { ...handoffFor(handoffDefaults(), "grok-build"), ...over } });

  test("adds nothing per launch (no --rules: the brief line is in the spec)", () => {
    expect(adapterOutput(ctx())).toEqual({ argv: [], env: {}, files: {} });
    expect(adapterOutput(ctx({ on_clear: "stay", on_compact: "stay" }))).toEqual({ argv: [], env: {}, files: {} });
  });

  test("pre-compact: asks (an event, then waits), prints nothing whatever the answer; nothing with on_compact: stay or another hook", async () => {
    const dir = mkdtempSync(join(TMP, "grok-events-"));
    const run = grokBuild.hook!("pre-compact", "{}", { eventsDir: dir, pieces: ["compact"], answerTimeoutMs: 5000 });
    let asked: { name: string; id?: string }[] = [];
    for (let i = 0; i < 100 && !asked.length; i++) {
      asked = readEvents(dir, new Set());
      await Bun.sleep(10);
    }
    expect(asked[0]!.name).toBe("compact");
    writeAnswer(dir, asked[0]!.id!, true);
    expect(await run).toEqual({});
    const off = mkdtempSync(join(TMP, "grok-events-"));
    expect(await grokBuild.hook!("pre-compact", "{}", { eventsDir: off, pieces: ["clear"] })).toEqual({});
    expect(await grokBuild.hook!("session-start", "{}", { eventsDir: off, pieces: ["clear", "compact"] })).toEqual({});
    expect(readdirSync(off)).toEqual([]);
  });

  test("notes say what each setting does", () => {
    const status = "its status and latest activity show in Gluon, through the same hook file";
    expect(grokBuild.notes(ctx())).toEqual([expect.stringContaining("auto-compaction asks first"), status]);
    expect(grokBuild.notes(ctx({ on_compact: "stay" }))).toEqual(["auto-compaction: Grok Build compacts (on_compact: stay)", status]);
  });

  test("status hooks, with grok's camelCase inputs: working, the activity line, awaiting, done; a subagent's own say nothing", async () => {
    const dir = mkdtempSync(join(TMP, "grok-events-"));
    const run = (name: string, input: object) => grokBuild.hook!(name, JSON.stringify({ sessionId: "s", cwd: "/w/repo", ...input }), { eventsDir: dir, pieces: ["compact"] });
    const st = (status: StatusInfo): HookResult => ({ events: [{ name: "status", status }] });
    expect(await run("prompt", { hookEventName: "user_prompt_submit", hook_event_name: "UserPromptSubmit", prompt: "go" })).toEqual(st({ state: "working" }));
    expect(await run("tool", { hook_event_name: "PreToolUse", toolName: "run_terminal_command", toolInput: { command: "bun test" } })).toEqual(st({ state: "working", activity: "run_terminal_command: bun test" }));
    expect(await run("tool", { hook_event_name: "PreToolUse", tool_name: "read_file", tool_input: { target_file: "/w/repo/src/a.ts" } })).toEqual(st({ state: "working", activity: "read_file src/a.ts" }));
    expect(await run("permission", { hook_event_name: "Notification" })).toEqual(st({ state: "awaiting" }));
    expect(await run("idle", { hook_event_name: "Notification" })).toEqual(st({ state: "done" }));
    expect(await run("stop", { hook_event_name: "StopCancelled", reason: "user_interrupt" })).toEqual(st({ state: "done" }));
    expect(await run("stop", { hook_event_name: "Stop", subagentType: "explore" })).toEqual({});
    expect(await run("tool", { toolName: "read_file", subagentType: "explore" })).toEqual({});
  });
});

describe("Antigravity adapter", () => {
  const ctx = (over: object = {}) => ({ harness: "antigravity" as const, version: "1.2.14", handoff: { ...handoffFor(handoffDefaults(), "antigravity"), ...over } });

  test("adds nothing per launch; its only hook is its status line's (test/agy-settings.test.ts); auto-compaction can't ask", async () => {
    expect(adapterOutput(ctx())).toEqual({ argv: [], env: {}, files: {} });
    // Nothing waits or asks: a compaction hook answers nothing and writes nothing.
    expect(await antigravity.hook!("pre-compact", "{}", { eventsDir: "/x", pieces: ["compact"] })).toEqual({});
    expect(antigravity.notes(ctx())).toEqual([expect.stringContaining("auto-compaction: Antigravity compacts without asking")]);
    expect(antigravity.notes(ctx({ on_compact: "stay" }))).toEqual([]);
  });
});

describe("doctor", () => {
  test("per connected agent: the effective settings and the adapter's notes; the permanent files; never a ✗", () => {
    const config = defaults();
    config.handoff.agents = { codex: { on_clear: "stay" } };
    const lines = handoffLines(config, [{ harness: "grok-build", version: "1.0.46" }, { harness: "codex", version: "0.159.3" }, { harness: "grok-build", version: "1.0.40" }], [join("/h", GROK)]);
    expect(lines[0]).toBe("\nAgent sessions in Gluon (`handoff` in the config)");
    expect(lines[1]).toContain("Gluon asks on a typed /clear or /compact");
    expect(lines).toContain("  · Grok Build · on exit: return · /clear: ask · /compact: ask · key: ctrl+\\");
    expect(lines).toContain("      · auto-compaction asks first whether to end the session instead, through Gluon's hook file in Grok Build's hooks directory");
    expect(lines).toContain("  · Codex · on exit: return · /clear: stay · /compact: ask · key: ctrl+\\");
    expect(lines).toContain("      ! needs grok 1.0.46 or newer for Gluon's hooks and plugins");
    expect(lines.at(-1)).toContain(`${join("/h", GROK)} (\`gluon uninstall\` removes them)`);
    expect(lines.some((l) => /^\s*✗/.test(l))).toBe(false);
    expect(handoffLines(config, [], []).slice(2)).toEqual(["  · no connected agent", "  · Gluon has no files in other tools' directories"]);
  });
});
