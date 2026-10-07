/** Installing a missing harness: methods per platform, prerequisites, what runs, where it landed. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertShimArgs } from "../src/detect.ts";
import { HARNESS_INFO, HARNESSES, installHint, installMethods } from "../src/harnesses.ts";
import { findInstalled, harnessNamed, installArgv, installDirs, methodsFor, powershellPath } from "../src/install.ts";
import { wholeLines } from "../src/ui/signin.tsx";

const WIN = process.platform === "win32";
const TMP = mkdtempSync(join(tmpdir(), "gluon-install-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** A directory with these programs (empty scripts, or links to the real one). */
function binDir(name: string, progs: string[]): string {
  const d = join(TMP, name);
  mkdirSync(d, { recursive: true });
  for (const p of progs) {
    const f = join(d, WIN ? `${p}.exe` : p);
    writeFileSync(f, "#!/bin/sh\nexit 0\n");
    chmodSync(f, 0o755);
  }
  return d;
}

describe("the official commands", () => {
  test("installHint: the recommended command per platform", () => {
    expect(installHint("claude-code", "linux")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(installHint("claude-code", "darwin")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(installHint("claude-code", "win32")).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(installHint("codex", "linux")).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
    expect(installHint("codex", "win32")).toBe("irm https://chatgpt.com/codex/install.ps1 | iex");
    expect(installHint("antigravity", "linux")).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash");
    expect(installHint("antigravity", "win32")).toBe("irm https://antigravity.google/cli/install.ps1 | iex");
    expect(installHint("grok-build", "linux")).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
    expect(installHint("grok-build", "win32")).toBe("irm https://x.ai/cli/install.ps1 | iex");
    expect(installHint("opencode", "linux")).toBe("curl -fsSL https://opencode.ai/v2/install | bash");
    expect(installHint("opencode", "win32")).toBe("npm install -g @opencode/cli");
  });

  test("codex and opencode have npm as their alternative; opencode is 2.x (@opencode/cli)", () => {
    expect(installMethods("codex", "linux").map((m) => m.command)).toEqual(["curl -fsSL https://chatgpt.com/codex/install.sh | sh", "npm install -g @openai/codex"]);
    expect(installMethods("codex", "win32")[1]!.argv).toEqual(["npm", "install", "-g", "@openai/codex"]);
    expect(installMethods("opencode", "linux").map((m) => m.command)).toEqual(["curl -fsSL https://opencode.ai/v2/install | bash", "npm install -g @opencode/cli"]);
    expect(installMethods("opencode", "win32")[0]!.argv).toEqual(["npm", "install", "-g", "@opencode/cli"]);
  });

  test("a harness by id or binary name", () => {
    expect(harnessNamed("claude")).toBe("claude-code");
    expect(harnessNamed("grok-build")).toBe("grok-build");
    expect(harnessNamed("agy")).toBe("antigravity");
    expect(harnessNamed("gemini")).toBeUndefined();
  });

  test("every npm command passes through cmd.exe as it is (npm is npm.cmd on Windows)", () => {
    for (const h of HARNESSES) for (const p of ["linux", "win32"] as const) for (const m of installMethods(h, p)) if (m.argv) expect(() => assertShimArgs(["C:\\nodejs\\npm.cmd", ...m.argv!.slice(1)])).not.toThrow();
  });
});

describe.skipIf(WIN)("methodsFor: prerequisites (POSIX)", () => {
  const sh = Bun.which("sh")!;
  test("all there: sh -c <the command>, sh by its absolute path", () => {
    const d = binDir("all", ["curl", "bash", "npm"]);
    symlinkSync(sh, join(d, "sh"));
    const [curl, npm] = methodsFor("codex", { PATH: d, wsl: false });
    expect(curl!.missing).toEqual([]);
    expect(curl!.argv).toEqual([join(d, "sh"), "-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"]);
    expect(npm!.argv).toEqual([join(d, "npm"), "install", "-g", "@openai/codex"]);
  });

  test("missing ones are named, and nothing runs", () => {
    const d = binDir("nocurl", []);
    symlinkSync(sh, join(d, "sh"));
    const [curl, npm] = methodsFor("codex", { PATH: d, wsl: false });
    expect(curl!.missing).toEqual(["curl"]);
    expect(curl!.argv).toBeUndefined();
    expect(npm!.missing).toEqual(["npm (Node.js)"]);
    expect(methodsFor("claude-code", { PATH: d, wsl: false })[0]!.missing).toEqual(["curl", "bash"]);
  });

  test("a relative PATH entry doesn't count (it would be the user's repository)", () => {
    const d = binDir("relative", ["curl", "bash"]);
    expect(methodsFor("claude-code", { PATH: `.${delimiter}${d}`, wsl: false })[0]!.missing).toEqual([]);
    expect(methodsFor("claude-code", { PATH: ".", wsl: false })[0]!.missing).toEqual(["curl", "bash"]);
  });

  test("an unchecked method is never runnable", () => {
    const d = binDir("unverified", ["curl", "bash"]);
    symlinkSync(sh, join(d, "sh"));
    const saved = HARNESS_INFO["grok-build"].install;
    HARNESS_INFO["grok-build"].install = { posix: [{ ...saved.posix![0]!, verified: false }] };
    try {
      const [m] = methodsFor("grok-build", { PATH: d, wsl: false });
      expect(m!.missing).toEqual([]);
      expect(m!.argv).toBeUndefined();
      expect(installHint("grok-build", "linux")).toBe("see https://docs.x.ai/build/overview");
    } finally {
      HARNESS_INFO["grok-build"].install = saved;
    }
  });
});

describe("Windows PowerShell", () => {
  test("by its full path under SystemRoot, -NoProfile, the command as one argument", () => {
    const env = { SystemRoot: "D:\\Win" };
    const m = installMethods("claude-code", "win32")[0]!;
    expect(powershellPath(env)).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(installArgv(m, { env, exists: (p) => p === powershellPath(env) })).toEqual([powershellPath(env), "-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"]);
    expect(installArgv(m, { env, exists: () => false })).toBeUndefined();
    const [o] = methodsFor("claude-code", { platform: "win32", env, exists: () => false });
    expect(o!.missing).toEqual(["Windows PowerShell"]);
  });

  test.skipIf(!WIN)("real Windows: the argv runs a constant command with a pipe in it", () => {
    const argv = installArgv({ shell: "powershell", command: "Write-Output 'gluon-ok' | Write-Output", needs: ["powershell"], host: "example.invalid", docs: "", verified: true })!;
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe("gluon-ok");
  });
});

describe("after an install", () => {
  test("installDirs: where each installer puts its binary", () => {
    expect(installDirs("claude-code", { platform: "linux", env: {}, home: "/h" })).toEqual(["/h/.local/bin"]);
    expect(installDirs("opencode", { platform: "linux", env: {}, home: "/h" })).toEqual(["/h/.opencode/bin"]);
    expect(installDirs("grok-build", { platform: "linux", env: { GROK_BIN_DIR: "/g" }, home: "/h" })).toEqual(["/g"]);
    expect(installDirs("codex", { platform: "win32", env: { USERPROFILE: "C:\\U", LOCALAPPDATA: "C:\\U\\L" } })).toEqual(["C:\\U\\L\\Programs\\OpenAI\\Codex\\bin"]);
    expect(installDirs("antigravity", { platform: "win32", env: { USERPROFILE: "C:\\U", LOCALAPPDATA: "C:\\U\\L" } })).toEqual(["C:\\U\\L\\agy\\bin"]);
    expect(installDirs("claude-code", { platform: "win32", env: { USERPROFILE: "C:\\U" } })).toEqual(["C:\\U\\.local\\bin"]);
  });

  test("on PATH, in an install dir not on PATH (not used, only named), or nowhere", () => {
    const on = binDir("on", ["opencode"]);
    const off = binDir("off", ["opencode"]);
    const none = binDir("none", []);
    expect(findInstalled("opencode", [off], { PATH: on, wsl: false })).toMatchObject({ on: "path" });
    expect(findInstalled("opencode", [off], { PATH: none, wsl: false })).toEqual({ on: "elsewhere", dir: off, path: join(off, WIN ? "opencode.exe" : "opencode") });
    expect(findInstalled("opencode", [none], { PATH: none, wsl: false })).toEqual({ on: "nowhere" });
    // Windows names, without touching the disk.
    expect(findInstalled("codex", ["C:\\npm"], { PATH: none, platform: "win32", exists: (p) => p === "C:\\npm\\codex.cmd" })).toEqual({ on: "elsewhere", dir: "C:\\npm", path: "C:\\npm\\codex.cmd" });
  });
});

describe("review of phase 4", () => {
  test.skipIf(WIN)("BUG-116: on WSL, a Windows npm on PATH is named as not usable, not just missing", () => {
    const d = binDir("wsl-npm", ["npm"]);
    const [o] = methodsFor("opencode", { platform: "win32" });
    expect(o!.method.argv![0]).toBe("npm");
    const [, npm] = methodsFor("codex", { PATH: d, wsl: true, windowsDrive: (p) => p.startsWith(d) });
    expect(npm!.missing).toEqual(["npm (Node.js) inside WSL (only a Windows one is on PATH)"]);
  });

  test("BUG-115: a clipped menu body keeps whole lines, from the first", () => {
    const body = ["`curl -fsSL https://chatgpt.com/codex/install.sh | sh`", "Downloads OpenAI's official installer from chatgpt.com and runs it, as you (no sudo).", "", "Docs"];
    expect(wholeLines(body, null, 40)).toEqual(body);
    expect(wholeLines(body, 2, 60)).toEqual(body.slice(0, 1));
    expect(wholeLines(body, 3, 60)).toEqual(body.slice(0, 2));
    expect(wholeLines(body, 0, 60)).toEqual([]);
  });
});
