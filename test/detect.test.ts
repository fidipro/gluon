/** The one binary detector: kinds per platform, and a Windows install seen from WSL. */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { absentLabel, binPath, classify, installed, isWsl, missingReason, resolveBin, resolveHarness } from "../src/detect.ts";

const WIN = process.platform === "win32";
/** A runnable file: on Windows it needs an extension from PATHEXT (`.exe` unless the name has one). */
const bin = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, WIN && !/\.\w+$/.test(name) ? `${name}.exe` : name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
};

describe("classify", () => {
  test("win32: .exe runs directly, .cmd/.bat/.ps1 are shims, anything else a script", () => {
    expect(classify("C:\\Tools\\claude.exe", { platform: "win32" })).toEqual({ path: "C:\\Tools\\claude.exe", kind: "exe" });
    expect(classify("C:\\npm\\codex.CMD", { platform: "win32" }).kind).toBe("shim");
    expect(classify("C:\\npm\\codex.bat", { platform: "win32" }).kind).toBe("shim");
    expect(classify("C:\\npm\\codex.ps1", { platform: "win32" }).kind).toBe("shim");
    expect(classify("C:\\npm\\codex", { platform: "win32" }).kind).toBe("script");
  });
  test("POSIX: an exe; on WSL, one under /mnt/<drive>/ is a Windows install", () => {
    expect(classify("/usr/bin/claude", { platform: "linux", wsl: false })).toEqual({ path: "/usr/bin/claude", kind: "exe" });
    expect(classify("/mnt/c/Users/me/AppData/Roaming/npm/claude", { platform: "linux", wsl: false }).foreign).toBeUndefined();
    expect(classify("/mnt/c/Users/me/AppData/Roaming/npm/claude", { platform: "linux", wsl: true }).foreign).toBe("wsl-windows");
    expect(classify("/mnt/data/claude", { platform: "linux", wsl: true }).foreign).toBeUndefined();
    expect(classify("/home/me/.local/bin/claude", { platform: "linux", wsl: true }).foreign).toBeUndefined();
  });
  test("WSL is detected from WSL_DISTRO_NAME, never off Linux", () => {
    expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(true);
    expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "darwin")).toBe(false);
  });
});

describe("resolveBin", () => {
  const saved = process.env.PATH;
  afterEach(() => {
    process.env.PATH = saved;
  });
  test("reads the current PATH, and resolves to the absolute path", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-detect-"));
    const path = bin(dir, "gluon-fake-tool");
    expect(resolveBin("gluon-fake-tool")).toBeUndefined();
    process.env.PATH = `${dir}${delimiter}${saved}`;
    expect(resolveBin("gluon-fake-tool", { platform: "linux", wsl: false })).toEqual({ path, kind: "exe" });
    expect(binPath("gluon-fake-tool")).toBe(path);
  });
  test("a harness: installed, or why not", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-detect-"));
    process.env.PATH = dir;
    expect(installed("grok-build")).toBe(false);
    expect(absentLabel("grok-build")).toBe("not installed");
    expect(missingReason("grok")).toBe("grok is not installed (not found on PATH)");
    const path = bin(dir, "grok");
    expect(resolveHarness("grok-build", { wsl: false })).toEqual({ path, kind: "exe" });
    expect(installed("grok-build", { wsl: false })).toBe(true);
  });
  test("an explicit PATH is searched instead of the environment's", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-detect-"));
    const path = bin(dir, "agy");
    expect(resolveBin("agy", { PATH: dir, platform: "linux", wsl: true })).toEqual({ path, kind: "exe" });
  });
  // WSL paths (/mnt/<drive>/, `:`-separated PATH): Linux only.
  test.skipIf(WIN)("WSL: a Windows install alone is found but foreign (not installed); a Linux one later on PATH wins", () => {
    const root = mkdtempSync(join(tmpdir(), "gluon-detect-"));
    const drive = (p: string) => p.startsWith(join(root, "mnt") + "/");
    const windows = bin(join(root, "mnt", "npm"), "claude");
    const opts = { platform: "linux" as const, wsl: true, windowsDrive: drive };
    process.env.PATH = join(root, "mnt", "npm");
    expect(resolveBin("claude", opts)).toEqual({ path: windows, kind: "exe", foreign: "wsl-windows" });
    expect(binPath("claude", opts)).toBeUndefined();
    expect(installed("claude-code", opts)).toBe(false);
    expect(absentLabel("claude-code", opts)).toBe("a Windows install was found on PATH; install it inside WSL");
    expect(missingReason("claude", opts)).toContain("a Windows install of claude was found on PATH");
    const linux = bin(join(root, "local"), "claude");
    process.env.PATH = `${join(root, "mnt", "npm")}:${join(root, "local")}`;
    expect(resolveBin("claude", opts)).toEqual({ path: linux, kind: "exe" });
    expect(installed("claude-code", opts)).toBe(true);
  });
});

describe("phase 1 review", () => {
  const saved = process.env.PATH;
  const cwd = process.cwd();
  afterEach(() => {
    process.env.PATH = saved;
    process.chdir(cwd);
  });
  test.skipIf(WIN)("BUG-94/D1: on WSL a Windows claude.exe / codex.cmd alone is reported as a Windows install", () => {
    const root = mkdtempSync(join(tmpdir(), "gluon-detect-"));
    const opts = { platform: "linux" as const, wsl: true, windowsDrive: (p: string) => p.startsWith(join(root, "mnt") + "/") };
    const exe = bin(join(root, "mnt", "bin"), "claude.exe");
    const cmd = bin(join(root, "mnt", "npm"), "codex.cmd");
    process.env.PATH = `${join(root, "mnt", "bin")}:${join(root, "mnt", "npm")}`;
    expect(resolveBin("claude", opts)).toEqual({ path: exe, kind: "exe", foreign: "wsl-windows" });
    expect(resolveBin("codex", opts)).toEqual({ path: cmd, kind: "shim", foreign: "wsl-windows" });
    expect(installed("claude-code", opts)).toBe(false);
    expect(absentLabel("codex", opts)).toBe("a Windows install was found on PATH; install it inside WSL");
    expect(resolveBin("claude", { ...opts, wsl: false })).toBeUndefined();
    expect(resolveBin("grok", opts)).toBeUndefined();
  });
  test("BUG-95/D2: a relative PATH entry (., empty) never finds a binary in the current directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-detect-"));
    bin(dir, "claude");
    process.chdir(dir);
    for (const PATH of [".", "", delimiter, "./", `sub${delimiter}.`]) expect(resolveBin("claude", { PATH, wsl: false })).toBeUndefined();
    process.env.PATH = ".";
    expect(installed("claude-code", { wsl: false })).toBe(false);
    process.env.PATH = dir;
    expect(binPath("claude", { wsl: false })).toBe(join(dir, WIN ? "claude.exe" : "claude"));
  });
});

test("every binary lookup goes through detect.ts, and no POSIX tool is spawned", () => {
  const src = join(import.meta.dir, "..", "src");
  const all = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? all(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
  for (const file of all(src)) {
    const text = readFileSync(file, "utf8");
    if (!file.endsWith("detect.ts")) expect(`${file}: ${/Bun\.which\(/.test(text)}`).toBe(`${file}: false`);
    expect(`${file}: ${/spawn(?:Sync)?\(\s*\[\s*"(?:ls|find|grep)"/.test(text)}`).toBe(`${file}: false`);
  }
});
