/**
 * Native Windows: launching through `.cmd` shims without cmd.exe acting on the spec (BatBadBut),
 * native exes behind npm shims, process trees, the Claude-plan brain's exe, the footer. The logic
 * runs everywhere (path.win32, injected file reads); the "real Windows" block checks Bun itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { claudeExecutable } from "../src/agent/subscription.ts";
import { assertShimArgs, binPath, cleanStaleSpecs, cmdSafe, killTree, nativeExe, shortPath } from "../src/detect.ts";
import { SYSTEM_ENV, SYSTEM_PATH } from "./e2e/harness.ts";
import { HARNESS_INFO, HARNESSES } from "../src/harnesses.ts";
import { launchPlan } from "../src/launchers.ts";
import { cmdWrapper } from "../src/self.ts";
import { makeTheme } from "../src/ui/theme.ts";
import { isPrivate, WIN } from "./e2e/fixtures.ts";

/** Everything cmd.exe acts on, and what CommandLineToArgvW gets wrong when quoting is naive. */
const HOSTILE = ["& echo INJECTED", "a | b", "%PATH%", "^caret", '" & echo INJECTED2', "multi\nline & echo INJECTED3", "trail\\", "trail2\\\\", 'both "\\', "", "!bang!", "(paren)", "<in >out", "tab\there", "unicode ✓ ž"];
const SPEC = `- fix the bug\n- then run: a && b | c; echo "%USERPROFILE%" ^& done\\`;

const NPM_EXE_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n`;
const NPM_JS_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;

describe("the native exe behind an npm shim", () => {
  const files = (map: Record<string, string>) => ({ read: (p: string) => map[p] ?? (() => { throw new Error("ENOENT"); })(), exists: (p: string) => p in map });
  test("a shim whose target is an exe (claude-code, @opencode/cli): that exe", () => {
    const fs = files({ "C:\\npm\\opencode.cmd": NPM_EXE_SHIM, "C:\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe": "" });
    expect(nativeExe("C:\\npm\\opencode.cmd", fs)).toBe("C:\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe");
    expect(nativeExe("C:\\npm\\opencode.cmd", files({ "C:\\npm\\opencode.cmd": NPM_EXE_SHIM }))).toBeNull();
  });
  // The arch is always given: the host's (arm64 on macos-latest) must not decide the result.
  test("@openai/codex: its platform package's codex.exe, nested or hoisted, for the machine's arch", () => {
    const tail = (arch: string, triple: string) => `@openai\\codex-win32-${arch}\\vendor\\${triple}\\bin\\codex.exe`;
    const x64 = tail("x64", "x86_64-pc-windows-msvc");
    const arm64 = tail("arm64", "aarch64-pc-windows-msvc");
    for (const [arch, mine, other] of [["x64", x64, arm64], ["arm64", arm64, x64]] as const) {
      const nested = `C:\\npm\\node_modules\\@openai\\codex\\node_modules\\${mine}`;
      const hoisted = `C:\\npm\\node_modules\\${mine}`;
      const shim = (extra: Record<string, string>) => ({ ...files({ "C:\\npm\\codex.cmd": NPM_JS_SHIM, ...extra }), arch });
      expect(nativeExe("C:\\npm\\codex.cmd", shim({ [nested]: "" }))).toBe(nested);
      expect(nativeExe("C:\\npm\\codex.cmd", shim({ [hoisted]: "" }))).toBe(hoisted);
      // Only the other arch's package: not this machine's exe.
      expect(nativeExe("C:\\npm\\codex.cmd", shim({ [`C:\\npm\\node_modules\\${other}`]: "" }))).toBeNull();
      expect(nativeExe("C:\\npm\\codex.cmd", shim({}))).toBeNull();
    }
  });
  test("anything else stays a shim: another script, a .bat, a path out of the shim's node_modules", () => {
    const other = NPM_JS_SHIM.replace("@openai\\codex\\bin\\codex.js", "some-tool\\cli.js");
    expect(nativeExe("C:\\npm\\tool.cmd", files({ "C:\\npm\\tool.cmd": other, "C:\\npm\\node_modules\\some-tool\\cli.js": "" }))).toBeNull();
    expect(nativeExe("C:\\npm\\x.bat", files({ "C:\\npm\\x.bat": NPM_EXE_SHIM }))).toBeNull();
    const out = NPM_EXE_SHIM.replace("node_modules\\@opencode\\cli\\bin", "node_modules\\..\\..\\evil");
    expect(nativeExe("C:\\npm\\opencode.cmd", files({ "C:\\npm\\opencode.cmd": out, "C:\\evil\\opencode.exe": "" }))).toBeNull();
    expect(nativeExe("C:\\npm\\missing.cmd", files({}))).toBeNull();
  });
});

describe("BatBadBut: nothing cmd.exe would act on reaches a shim", () => {
  test("cmdSafe passes words, paths and spaces, and nothing cmd.exe acts on", () => {
    for (const a of ["auth", "login", "--model", "gpt-6-sol", "C:\\Users\\me\\AppData\\Local\\Temp\\gluon-spec-x\\session.md", "Read the session brief in C:\\t\\session.md and start.", "--prompt=Read it.", ""]) expect([a, cmdSafe(a)]).toEqual([a, true]);
    for (const a of HOSTILE.filter((h) => !/^(trail2?\\+|)$/.test(h))) expect([a, cmdSafe(a)]).toEqual([a, false]);
  });
  test("assertShimArgs checks only .cmd / .bat argv", () => {
    expect(() => assertShimArgs(["C:\\npm\\codex.cmd", "login", "status"])).not.toThrow();
    expect(() => assertShimArgs(["C:\\npm\\codex.CMD", "-c", 'model_reasoning_effort="high"'])).toThrow("which cmd.exe would act on");
    expect(() => assertShimArgs(["C:\\x\\agent.bat", "a & b"])).toThrow(".cmd shim");
    expect(() => assertShimArgs(["C:\\x\\codex.exe", ...HOSTILE])).not.toThrow();
    expect(() => assertShimArgs(["/usr/bin/codex", ...HOSTILE])).not.toThrow();
  });
  // A harness that takes no prompt in argv (Kimi Code, `typedSpec`) has no spec argument: Gluon types the brief (`launchPlan`).
  const carriers = HARNESSES.filter((h) => !HARNESS_INFO[h].typedSpec);
  test("every harness carries the spec in its last argument (what the shim route replaces)", () => {
    for (const h of carriers) expect([h, HARNESS_INFO[h].argv("m", undefined, SPEC, []).at(-1)!.endsWith(SPEC)]).toEqual([h, true]);
  });
  test("the spec stays last with a mode's options in `extra` (they come before it)", () => {
    for (const h of carriers) {
      for (const mode of ["explore", "plan"] as const) {
        const argv = HARNESS_INFO[h].argv("m", undefined, SPEC, HARNESS_INFO[h].modes[mode].argv ?? []);
        expect([h, mode, argv.at(-1)!.endsWith(SPEC)]).toEqual([h, mode, true]);
      }
    }
  });
});

test("BUG-144/v1 fixes: GLUON_SELF's Windows wrapper quotes every word, doubles % and turns delayed expansion off", () => {
  const text = cmdWrapper(["C:\\Program Files\\bun 100%\\bun.exe", "--no-env-file", "--config=C:\\a&b (x)\\empty-bunfig.toml", "C:\\src\\cli.tsx"]);
  expect(text).toBe('@echo off\r\nsetlocal DisableDelayedExpansion\r\n"C:\\Program Files\\bun 100%%\\bun.exe" "--no-env-file" "--config=C:\\a&b (x)\\empty-bunfig.toml" "C:\\src\\cli.tsx" %*\r\n');
  expect(() => cmdWrapper(['C:\\a"b\\bun.exe'])).toThrow("can't quote");
});

describe("launchPlan", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gluon-plan-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const cmd = (h: (typeof HARNESSES)[number], effort?: "high") => ({ argv: HARNESS_INFO[h].argv("m1", effort, SPEC, []), env: {}, spec: SPEC });

  test("an exe gets the spec as it is, in its argv; no file", () => {
    const p = launchPlan(cmd("claude-code"), "C:\\bin\\claude.exe", { tmp });
    expect(p).toEqual({ argv: ["C:\\bin\\claude.exe", "--model", "m1", "--", SPEC] });
    expect(launchPlan({ argv: ["claude", "--", ...HOSTILE], env: {}, spec: HOSTILE.at(-1) }, "/usr/bin/claude", { tmp }).argv.slice(2)).toEqual(HOSTILE);
  });

  test("a shim gets a one-line prompt naming a private file that holds the spec", () => {
    for (const h of ["claude-code", "opencode", "antigravity", "grok-build"] as const) {
      const p = launchPlan(cmd(h), `C:\\npm\\${HARNESS_INFO[h].binary}.cmd`, { tmp });
      expect(p.specFile).toBeDefined();
      expect(readFileSync(p.specFile!, "utf8")).toBe(`${SPEC}\n`);
      const last = p.argv.at(-1)!;
      expect(last.endsWith(`Read the session brief in ${p.specFile} and start.`)).toBe(true);
      expect(p.argv.slice(0, -1)).toEqual([`C:\\npm\\${HARNESS_INFO[h].binary}.cmd`, ...cmd(h).argv.slice(1, -1)]);
      expect(p.argv.every((a) => !a.includes("&") && !a.includes("%") && !a.includes("\n"))).toBe(true);
      if (!WIN) expect(statSync(p.specFile!).mode & 0o777).toBe(0o600);
      rmSync(dirname(p.specFile!), { recursive: true });
    }
  });

  test("a shim with an argument cmd.exe would act on is refused, and leaves no file", () => {
    const before = new Set(existsSync(tmp) ? require("node:fs").readdirSync(tmp) : []);
    expect(() => launchPlan(cmd("codex", "high"), "C:\\npm\\codex.cmd", { tmp })).toThrow("which cmd.exe would act on");
    expect(require("node:fs").readdirSync(tmp).filter((f: string) => !before.has(f))).toEqual([]);
  });

  test("a login (no spec) through a shim passes its fixed words", () => {
    expect(launchPlan({ argv: ["codex", "login"], env: {} }, "C:\\npm\\codex.cmd", { tmp })).toEqual({ argv: ["C:\\npm\\codex.cmd", "login"] });
  });
});

describe("the rest of native Windows", () => {
  test("killTree: taskkill /T /F by full path on win32 (kill() when it can't run); kill() elsewhere", () => {
    let killed = 0;
    killTree({ pid: 123, kill: () => killed++ }, "linux");
    expect(killed).toBe(1);
    if (!WIN) {
      // No taskkill here: it falls back to kill().
      killTree({ pid: 123, kill: () => killed++ }, "win32");
      expect(killed).toBe(2);
    }
    const src = readFileSync(join(import.meta.dir, "../src/detect.ts"), "utf8");
    expect(src).toContain('windowsTool("taskkill"), "/PID", String(proc.pid), "/T", "/F"');
    for (const f of ["status.ts", "agent/codex.ts", "agent/tools.ts"]) expect([f, /\b(proc|child)\.kill\(\)/.test(readFileSync(join(import.meta.dir, "../src", f), "utf8"))]).toEqual([f, false]);
  });

  test("the Claude-plan brain needs claude.exe on Windows, with the native installer named", () => {
    expect(claudeExecutable("win32", () => "C:\\Users\\me\\.local\\bin\\claude.exe")).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
    expect(() => claudeExecutable("win32", () => "C:\\npm\\claude.cmd")).toThrow("native claude.exe");
    expect(() => claudeExecutable("win32", () => "C:\\npm\\claude.cmd")).toThrow("install.ps1");
    expect(() => claudeExecutable("win32", () => undefined)).toThrow("not installed");
    expect(claudeExecutable("linux", () => "/usr/bin/claude")).toBe("/usr/bin/claude");
  });

  test("BUG-56 on every OS: package scripts run Bun with an empty bunfig (Windows can't open /dev/null), shebangs with /dev/null", () => {
    const root = join(import.meta.dir, "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const runs = Object.entries(pkg.scripts).filter(([, cmd]) => /^bun (?!test|run|install)/.test(cmd));
    expect(runs.length).toBeGreaterThan(3);
    for (const [name, cmd] of runs) expect([name, cmd]).toEqual([name, expect.stringMatching(/^bun --no-env-file --config=scripts\/empty-bunfig\.toml /)]);
    expect(Bun.TOML.parse(readFileSync(join(root, "scripts/empty-bunfig.toml"), "utf8"))).toEqual({});
    for (const f of ["src/cli.tsx", "scripts/build.ts", "scripts/live.ts"]) expect(readFileSync(join(root, f), "utf8").split(/\r?\n/)[0]).toBe("#!/usr/bin/env -S bun --no-env-file --config=/dev/null");
  });

  test("no OSC 11 reply and no COLORFGBG (a Windows console): the dark theme", () => {
    const saved = process.env.COLORFGBG;
    delete process.env.COLORFGBG;
    try {
      expect(makeTheme(null).dark).toBe(true);
    } finally {
      if (saved !== undefined) process.env.COLORFGBG = saved;
    }
  });
});

describe("review of phase 3", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gluon-review-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test.skipIf(WIN)("BUG-102: a `git` / `rg` planted in the repository never runs, even with . on PATH", () => {
    const repo = join(tmp, "planted");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.txt"), "needle\n");
    const marker = join(tmp, "PLANTED-RAN");
    for (const b of ["git", "rg"]) {
      writeFileSync(join(repo, b), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
      require("node:fs").chmodSync(join(repo, b), 0o755);
    }
    const src = join(import.meta.dir, "../src");
    const code = `const { repoContext } = await import(${JSON.stringify(join(src, "agent/prompt.ts"))});
const { runRepoTool } = await import(${JSON.stringify(join(src, "agent/tools.ts"))});
console.log(JSON.stringify({ repo: repoContext(process.cwd()).isRepo, grep: await runRepoTool(process.cwd(), "grep", { pattern: "needle" }), list: await runRepoTool(process.cwd(), "list_files", {}) }));`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { cwd: repo, env: { PATH: [".", ...SYSTEM_PATH].join(":") }, stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ repo: false, grep: "a.txt:1:needle" });
    expect(existsSync(marker)).toBe(false);
  });

  test("BUG-102: no Bun.spawn / spawnSync in src names its binary by a bare name (binPath or windowsTool give the absolute path)", () => {
    const src = join(import.meta.dir, "../src");
    const all = (d: string): string[] => require("node:fs").readdirSync(d, { withFileTypes: true }).flatMap((e: { name: string; isDirectory(): boolean }) => (e.isDirectory() ? all(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
    for (const f of all(src)) {
      const text = readFileSync(f, "utf8");
      expect([f, [...text.matchAll(/Bun\.spawn(?:Sync)?\(\s*\[\s*(["'`][^"'`]*["'`])/g)].map((m) => m[1])]).toEqual([f, []]);
    }
    // cli.tsx imports nothing statically: only the hidden `signal`/`mcp` (which spawn nothing) run before startup.ts.
    const cli = readFileSync(join(src, "cli.tsx"), "utf8");
    expect(cli).not.toMatch(/^import /m);
    expect(cli).toMatch(/\nawait import\("\.\/startup\.ts"\);\nawait import\("\.\/main\.tsx"\);\n$/);
    expect(readFileSync(join(src, "startup.ts"), "utf8")).toContain('process.env.NoDefaultCurrentDirectoryInExePath = "1"');
  });

  test("BUG-103: a temp path cmd.exe would act on goes by its short name; with none, the error names the character", () => {
    const odd = join(tmp, "John (Work)");
    const plain = join(tmp, "JOHNWO~1");
    mkdirSync(odd);
    mkdirSync(plain);
    const cmd = { argv: ["claude", "--", SPEC], env: {}, spec: SPEC };
    const p = launchPlan(cmd, "C:\\npm\\claude.cmd", { tmp: odd, short: () => plain });
    expect(dirname(dirname(p.specFile!))).toBe(plain);
    expect(() => launchPlan(cmd, "C:\\npm\\claude.cmd", { tmp: odd, short: () => null })).toThrow('has "(" in its path');
    expect(() => launchPlan(cmd, "C:\\npm\\claude.cmd", { tmp: odd, short: () => odd })).toThrow('has "(" in its path');
    // Letters in any script are fine as they are (José's profile).
    const jose = join(tmp, "José");
    mkdirSync(jose);
    expect(dirname(dirname(launchPlan(cmd, "C:\\npm\\claude.cmd", { tmp: jose, short: () => null }).specFile!))).toBe(jose);
    // The error shows the character, not a cut-off argument.
    expect(() => assertShimArgs(["C:\\npm\\x.cmd", `${"a".repeat(60)}&b`])).toThrow('has "&" in it');
    expect(() => assertShimArgs(["C:\\npm\\x.cmd", "a\nb"])).toThrow("has U+000A in it");
  });

  test("BUG-106: killTree leaves a process that already exited alone (its PID may be reused)", () => {
    let kills = 0;
    killTree({ pid: 4242, exitCode: 0, kill: () => kills++ }, "win32");
    killTree({ pid: 4242, exitCode: null, signalCode: "SIGTERM", kill: () => kills++ }, "linux");
    expect(kills).toBe(0);
  });

  test("BUG-107: a shim's target must resolve inside its own node_modules, whatever separators it uses", () => {
    const files = (map: Record<string, string>) => ({ read: (p: string) => map[p]!, exists: (p: string) => p in map });
    for (const target of ["node_modules\\a/../../../evil.exe", "node_modules\\a\\..\\..\\evil.exe", "node_modules/../evil.exe", "node_modules\\..\\npm2\\node_modules\\x.exe"]) {
      const shim = NPM_EXE_SHIM.replace("node_modules\\@opencode\\cli\\bin\\opencode.exe", target);
      const fs = files({ "C:\\npm\\opencode.cmd": shim, "C:\\evil.exe": "", "C:\\npm2\\node_modules\\x.exe": "", "C:\\npm\\evil.exe": "" });
      expect([target, nativeExe("C:\\npm\\opencode.cmd", fs)]).toEqual([target, null]);
    }
  });

  test("BUG-108: a spec too long for a command line goes by file on an exe too; old spec dirs are cleaned", () => {
    const long = "x".repeat(40_000);
    const cmd = { argv: ["claude", "--", long], env: {}, spec: long };
    const w = launchPlan(cmd, "C:\\bin\\claude.exe", { tmp, platform: "win32" });
    expect(w.specFile).toBeDefined();
    expect(w.argv.at(-1)).toBe(`Read the session brief in ${w.specFile} and start.`);
    expect(launchPlan(cmd, "/usr/bin/claude", { tmp, platform: "linux" }).specFile).toBeUndefined();
    const huge = "y".repeat(200_000);
    expect(launchPlan({ argv: ["claude", "--", huge], env: {}, spec: huge }, "/usr/bin/claude", { tmp, platform: "linux" }).specFile).toBeDefined();
    const clean = join(tmp, "clean");
    mkdirSync(clean);
    for (const d of ["gluon-spec-old", "gluon-spec-new", "other-old"]) mkdirSync(join(clean, d));
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const d of ["gluon-spec-old", "other-old"]) require("node:fs").utimesSync(join(clean, d), old, old);
    cleanStaleSpecs(clean);
    expect(require("node:fs").readdirSync(clean).sort()).toEqual(["gluon-spec-new", "other-old"]);
  });
});

/** Bun's own behaviour on Windows, which the code above relies on. */
describe.skipIf(!WIN)("real Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "gluon-win-"));
  const echo = join(dir, "echo-argv.exe");
  const sys = (tool: string) => win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", tool);
  /** Runs a compiled exe; its exit code and stderr come along, so a failure says why. */
  const runExe = (argv: string[], opts: Parameters<typeof Bun.spawnSync>[1] = {}) => {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", ...opts });
    return { code: r.exitCode, stderr: r.stderr?.toString() ?? "", out: r.stdout?.toString() ?? "" };
  };
  beforeAll(() => {
    // Prints its argv as JSON; with MARKER set, also creates that file (a planted binary that ran).
    writeFileSync(join(dir, "echo-argv.ts"), 'if (process.env.MARKER) require("node:fs").writeFileSync(process.env.MARKER, "x");\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
    const r = Bun.spawnSync([process.execPath, "build", "--compile", join(dir, "echo-argv.ts"), "--outfile", echo], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    // Warm up: the first start of a fresh exe can be slow or come back empty while it is scanned.
    for (let i = 0; i < 5 && runExe([echo, "warm"]).out.trim() !== '["warm"]'; i++) Bun.sleepSync(500);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("Bun quotes argv for an .exe so CommandLineToArgvW gets every argument back as it was", () => {
    const r = runExe([echo, ...HOSTILE, SPEC]);
    expect({ ...r, out: r.out ? JSON.parse(r.out) : r.out }).toEqual({ code: 0, stderr: "", out: [...HOSTILE, SPEC] });
  });

  test("Bun runs a .cmd through cmd.exe, which acts on a quote, & and a newline (if this fails, Bun changed: revisit launchPlan)", () => {
    const cmd = join(dir, "echo.cmd");
    writeFileSync(cmd, "@echo off\r\necho ARGS=[%*]\r\n");
    const out = (arg: string) => Bun.spawnSync([cmd, arg], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
    expect(out('" & echo INJECTED')).toMatch(/^INJECTED/m);
    expect(out("line1\nline2")).not.toContain("line2");
    expect(out("%OS%")).toContain("Windows_NT");
  });

  test("a spec through a shim arrives whole: the one-line prompt passes cmd.exe, the file holds the spec", () => {
    const shim = join(dir, "agent.cmd");
    writeFileSync(shim, `@echo off\r\n"${echo}" %*\r\n`);
    const plan = launchPlan({ argv: ["claude", "--model", "m", "--", SPEC], env: {}, spec: SPEC }, shim, { tmp: dir });
    const r = runExe(plan.argv);
    expect({ ...r, out: r.out ? JSON.parse(r.out) : r.out }).toEqual({ code: 0, stderr: "", out: ["--model", "m", "--", `Read the session brief in ${plan.specFile} and start.`] });
    expect(readFileSync(plan.specFile!, "utf8")).toBe(`${SPEC}\n`);
    // Limited to the user (icacls), whatever the directory.
    expect(plan.warning).toBeUndefined();
    expect(isPrivate(plan.specFile!, "Z:\\nowhere")).toBe(true);
  });

  test("killTree ends the children too (a plain kill leaves them running)", async () => {
    const pings = () => (Bun.spawnSync([sys("tasklist.exe"), "/FI", "IMAGENAME eq PING.EXE", "/FO", "CSV", "/NH"], { stdout: "pipe" }).stdout.toString().match(/PING\.EXE/gi) ?? []).length;
    const before = pings();
    const parent = Bun.spawn([sys("cmd.exe"), "/d", "/c", sys("PING.EXE"), "-n", "30", "127.0.0.1"], { stdout: "ignore" });
    for (let i = 0; i < 50 && pings() === before; i++) await Bun.sleep(100);
    expect(pings()).toBe(before + 1);
    killTree(parent);
    await parent.exited;
    for (let i = 0; i < 50 && pings() > before; i++) await Bun.sleep(100);
    expect(pings()).toBe(before);
  });

  test("an npm install on PATH (only opencode.cmd there) is spawned through its native exe", () => {
    const npm = join(dir, "npm");
    const exe = join(npm, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
    mkdirSync(dirname(exe), { recursive: true });
    require("node:fs").copyFileSync(echo, exe);
    writeFileSync(join(npm, "opencode.cmd"), NPM_EXE_SHIM);
    const saved = process.env.PATH;
    process.env.PATH = npm;
    try {
      expect(binPath("opencode")).toBe(exe);
      const plan = launchPlan({ argv: ["opencode", "--standalone", `--prompt=${SPEC}`], env: {}, spec: SPEC }, binPath("opencode")!, { tmp: dir });
      const r = runExe(plan.argv);
      expect({ ...r, out: r.out ? JSON.parse(r.out) : r.out }).toEqual({ code: 0, stderr: "", out: ["--standalone", `--prompt=${SPEC}`] });
    } finally {
      process.env.PATH = saved;
    }
  });

  test("BUG-144/v1 fixes: GLUON_SELF's .cmd, started the way OpenCode's plugin does (Bun.spawn, fixed words), runs Gluon with them", () => {
    const odd = join(dir, "p 100%OS% (x) & y");
    mkdirSync(odd);
    const target = join(odd, "echo-argv.exe");
    require("node:fs").copyFileSync(echo, target);
    const self = join(dir, "self", "gluon.cmd");
    mkdirSync(dirname(self));
    writeFileSync(self, cmdWrapper([target, "--config=C:\\a&b\\x.toml"]));
    const r = runExe([self, "signal", "back"]);
    expect({ ...r, out: r.out ? JSON.parse(r.out) : r.out }).toEqual({ code: 0, stderr: "", out: ["--config=C:\\a&b\\x.toml", "signal", "back"] });
  });

  test("BUG-144/v1 fixes: GLUON_SELF's .cmd runs from cmd.exe (Codex's command_windows) and PowerShell (Claude Code's hooks)", () => {
    const odd = join(dir, "q 100%OS% (x) & y");
    mkdirSync(odd);
    const target = join(odd, "echo-argv.exe");
    require("node:fs").copyFileSync(echo, target);
    const self = join(dir, "self2", "gluon.cmd");
    mkdirSync(dirname(self));
    writeFileSync(self, cmdWrapper([target, "--config=C:\\a&b\\x.toml"]));
    const env = { ...SYSTEM_ENV, GLUON_SELF: self };
    const want = { code: 0, stderr: "", out: ["--config=C:\\a&b\\x.toml", "hook", "codex", "stop"] };
    const parsed = (r: ReturnType<typeof runExe>) => ({ ...r, out: r.out ? JSON.parse(r.out) : r.out });
    // `%COMSPEC% /C "<command_windows>"`: the command line as Codex builds it.
    expect(parsed(runExe([sys("cmd.exe"), "/d", "/s", "/c", '""%GLUON_SELF%" hook codex stop"'], { env, windowsVerbatimArguments: true }))).toEqual(want);
    const ps = sys("WindowsPowerShell\\v1.0\\powershell.exe");
    expect(parsed(runExe([ps, "-NoProfile", "-NonInteractive", "-Command", "& $env:GLUON_SELF hook codex stop"], { env }))).toEqual(want);
  });

  test("BUG-103: letters in any script pass through a shim intact; a temp path with ( or spaces goes by its 8.3 short name", () => {
    const shim = join(dir, "agent2.cmd");
    writeFileSync(shim, `@echo off\r\n"${echo}" %*\r\n`);
    const r = runExe([shim, "José", "Müller-Łódź", "C:\\Users\\José\\task.md"]);
    expect({ ...r, out: r.out ? JSON.parse(r.out) : r.out }).toEqual({ code: 0, stderr: "", out: ["José", "Müller-Łódź", "C:\\Users\\José\\task.md"] });
    const odd = join(dir, "John (Work) & Co");
    mkdirSync(odd);
    const short = shortPath(odd);
    const cmd = { argv: ["claude", "--", SPEC], env: {}, spec: SPEC };
    if (short && cmdSafe(short)) {
      const plan = launchPlan(cmd, shim, { tmp: odd });
      expect(plan.specFile!.startsWith(short)).toBe(true);
      const got = runExe(plan.argv);
      expect({ ...got, out: got.out ? JSON.parse(got.out) : got.out }).toEqual({ code: 0, stderr: "", out: ["--", `Read the session brief in ${plan.specFile} and start.`] });
      expect(readFileSync(plan.specFile!, "utf8")).toBe(`${SPEC}\n`);
    } else expect(() => launchPlan(cmd, shim, { tmp: odd })).toThrow('has "(" in its path'); // no 8.3 names on this volume
  });

  test("BUG-102: given a cwd and an env with Windows' own `Path` (as the repo tools did), Bun looks up a bare name in the cwd first unless NoDefaultCurrentDirectoryInExePath is set (a fact; Gluon sets it and spawns by absolute path)", () => {
    const repo = join(dir, "repo-fact");
    mkdirSync(repo);
    require("node:fs").copyFileSync(echo, join(repo, "git.exe"));
    const code = 'const r = Bun.spawnSync(["git", "--version"], { cwd: process.cwd(), stdout: "pipe", env: process.env }); console.log(r.stdout.toString().trim());';
    // Windows spells it "Path": then Bun, given an env, finds a bare name in the cwd first. (With
    // "PATH" it doesn't; the user's environment is what Gluon passes on.)
    const env = { ...SYSTEM_ENV, Path: SYSTEM_PATH.join(";") };
    // A process that never loaded the Claude Agent SDK (which sets the variable as a side effect).
    expect(runExe([process.execPath, "-e", code], { cwd: repo, env }).out.trim()).toBe('["--version"]');
    expect(runExe([process.execPath, "-e", code], { cwd: repo, env: { ...env, NoDefaultCurrentDirectoryInExePath: "1" } }).out.trim()).toMatch(/^git version /);
  });

  // The Claude Agent SDK sets NoDefaultCurrentDirectoryInExePath on import, which hides bare-name spawn bugs: such cases are
  // tested in a subprocess that doesn't load it (the one below prints `sdk: null` to prove it).
  test("BUG-102: a git.exe planted in the repository never runs (repo context, list, grep), in a process without the SDK", () => {
    const repo = join(dir, "repo-git");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.txt"), "needle\n");
    require("node:fs").copyFileSync(echo, join(repo, "git.exe"));
    require("node:fs").copyFileSync(echo, join(repo, "rg.exe"));
    const marker = join(dir, "PLANTED-GIT-RAN");
    const src = join(import.meta.dir, "../src");
    const code = `const { repoContext } = await import(${JSON.stringify(join(src, "agent/prompt.ts"))});
const { runRepoTool } = await import(${JSON.stringify(join(src, "agent/tools.ts"))});
console.log(JSON.stringify({ sdk: process.env.NoDefaultCurrentDirectoryInExePath ?? null, repo: repoContext(process.cwd()).isRepo, list: await runRepoTool(process.cwd(), "list_files", {}), grep: await runRepoTool(process.cwd(), "grep", { pattern: "needle" }) }));`;
    const r = runExe([process.execPath, "-e", code], { cwd: repo, env: { ...SYSTEM_ENV, Path: SYSTEM_PATH.join(";"), MARKER: marker } });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.out)).toMatchObject({ sdk: null, repo: false, grep: "a.txt:1:needle" });
    expect(existsSync(marker)).toBe(false);
  });
});
