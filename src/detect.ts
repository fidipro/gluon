/**
 * Where a binary is, and what kind: the one detector every install check and every spawn of a
 * harness goes through. A harness is spawned by the path found here, never by its bare name.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join, win32 } from "node:path";
import { HARNESS_INFO, type Harness } from "./harnesses.ts";

/** Set only by `scripts/build.ts` / `scripts/pack.ts` (a `define`): no environment variable can change it. */
declare const GLUON_BUILD: string | undefined;
/** "release" or "test" in a compiled binary, "npm" in the npm package's bundle; undefined when run from source. */
export const BUILD: "release" | "test" | "npm" | undefined =
  typeof GLUON_BUILD === "string" && (GLUON_BUILD === "release" || GLUON_BUILD === "test" || GLUON_BUILD === "npm") ? GLUON_BUILD : undefined;
/** A standalone executable (`bun build --compile`), whose embedded files are named by their source path. */
export const COMPILED = BUILD === "release" || BUILD === "test";

let neutral: string | undefined;
/**
 * An empty private directory to run status checks, version checks, probes and logins in: never the
 * user's repository, whose `bunfig.toml` preload or `.env` a Bun-built harness (opencode, …) would
 * load (BUG-98). Only the handoff to an agent and the brain session work in the repository.
 */
export function neutralCwd(): string {
  if (!neutral) {
    const dir = (neutral = mkdtempSync(join(tmpdir(), "gluon-cwd-")));
    // Its owner, so a sweep (`gluon uninstall`) keeps a running Gluon's (BUG-143).
    writeFileSync(join(dir, "pid"), String(process.pid), { mode: 0o600 });
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return neutral;
}

/**
 * Where a binary is on the current PATH (read now, so a PATH set after start counts), or null.
 * Relative entries (`.`, empty) are dropped: they would find a binary in the user's repository.
 */
export const onPath = (bin: string, PATH = process.env.PATH ?? "") =>
  Bun.which(bin, { PATH: PATH.split(delimiter).filter((d) => d && isAbsolute(d)).join(delimiter) });

export interface Resolved {
  path: string;
  /** exe: runs directly; shim: a Windows .cmd/.bat/.ps1 wrapper; script: anything else on Windows. */
  kind: "exe" | "shim" | "script";
  /** Found, but not usable here: a Windows install seen from WSL (under /mnt/<drive>/). */
  foreign?: "wsl-windows";
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  wsl?: boolean;
  PATH?: string;
  /** Where Windows' drives are mounted under WSL (tests point it elsewhere). */
  windowsDrive?: (path: string) => boolean;
}

let wslCached: boolean | undefined;

/** Running under WSL: WSL_DISTRO_NAME is set, or the kernel says "microsoft". */
export function isWsl(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME) return true;
  if (wslCached === undefined) {
    try {
      wslCached = /microsoft/i.test(readFileSync("/proc/version", "utf8"));
    } catch {
      wslCached = false;
    }
  }
  return wslCached;
}

const onWindowsDrive = (path: string) => /^\/mnt\/[a-z]\//i.test(path);

/** What kind of binary a path is. */
export function classify(path: string, { platform = process.platform, wsl = isWsl(process.env, platform), windowsDrive = onWindowsDrive }: DetectOptions = {}): Resolved {
  if (platform === "win32") {
    const ext = extname(path).toLowerCase();
    return { path, kind: ext === ".exe" || ext === ".com" ? "exe" : [".cmd", ".bat", ".ps1"].includes(ext) ? "shim" : "script" };
  }
  return wsl && windowsDrive(path) ? { path, kind: "exe", foreign: "wsl-windows" } : { path, kind: "exe" };
}

/**
 * A binary on PATH. On WSL, a Linux install anywhere on PATH wins over a Windows one (under
 * /mnt/<drive>/); a Windows one alone is foreign.
 */
export function resolveBin(bin: string, opts: DetectOptions = {}): Resolved | undefined {
  const PATH = opts.PATH ?? process.env.PATH ?? "";
  const found = onPath(bin, PATH);
  const r = found ? classify(found, opts) : undefined;
  if (r && !r.foreign) return r;
  const { platform = process.platform, wsl = isWsl(process.env, platform), windowsDrive = onWindowsDrive } = opts;
  if (!wsl) return r;
  const native = onPath(bin, PATH.split(":").filter((d) => !windowsDrive(`${d}/`)).join(":"));
  if (native) return classify(native, opts);
  if (r) return r;
  // A Windows install is often only `claude.exe` / `codex.cmd`, which a Linux lookup of the bare name misses.
  const windows = PATH.split(":").filter((d) => windowsDrive(`${d}/`)).join(":");
  for (const ext of [".exe", ".cmd", ".bat"]) {
    const path = onPath(bin + ext, windows);
    if (path) return { path, kind: ext === ".exe" ? "exe" : "shim", foreign: "wsl-windows" };
  }
  return undefined;
}

export const resolveHarness = (h: Harness, opts?: DetectOptions) => resolveBin(HARNESS_INFO[h].binary, opts);

/** The path to spawn for a binary: found and usable here; for a Windows shim, the native exe it runs when that can be found. */
export function binPath(bin: string, opts?: DetectOptions): string | undefined {
  const r = resolveBin(bin, opts);
  if (!r || r.foreign) return undefined;
  return (r.kind === "shim" && nativeExe(r.path)) || r.path;
}

/** A Windows system tool by full path: Windows may search the current directory (the user's repository) first. */
export const windowsTool = (name: string, env: Record<string, string | undefined> = process.env) => win32.join(env.SystemRoot || "C:\\Windows", "System32", `${name}.exe`);

/** Whether a path is a Windows `.cmd` / `.bat` shim, which Windows can only run through cmd.exe. */
export const isShim = (path: string) => /\.(cmd|bat)$/i.test(path);

/**
 * The native exe an npm `.cmd` shim runs, or null: the shim's target when it is an `.exe`
 * (`@anthropic-ai/claude-code`, `@opencode/cli`), or the exe `@openai/codex`'s `bin/codex.js` starts
 * (its platform package, nested or hoisted). Anything else stays a shim. `exists`/`read`/`arch` are for tests.
 */
export function nativeExe(shim: string, { read = (p: string) => readFileSync(p, "utf8"), exists = existsSync, arch = process.arch }: { read?: (p: string) => string; exists?: (p: string) => boolean; arch?: string } = {}): string | null {
  if (!/\.cmd$/i.test(shim)) return null;
  let text: string;
  try {
    text = read(shim);
  } catch {
    return null;
  }
  // npm's cmd-shim: … "%dp0%\node_modules\<package>\<file>" %*
  const target = [...text.matchAll(/"%dp0%\\(node_modules\\[^"%]+)"/gi)].at(-1)?.[1];
  if (!target) return null;
  const dir = win32.dirname(shim);
  const abs = win32.join(dir, target);
  // Only inside the shim's own node_modules, whatever the target spells (`..`, `/`, a drive).
  const rel = win32.relative(win32.join(dir, "node_modules"), abs);
  if (!rel || rel === ".." || rel.startsWith("..\\") || win32.isAbsolute(rel)) return null;
  if (/\.exe$/i.test(target)) return exists(abs) ? abs : null;
  if (!/^node_modules\\@openai\\codex\\bin\\codex\.js$/i.test(target)) return null;
  const [pkg, triple] = arch === "arm64" ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"] : ["codex-win32-x64", "x86_64-pc-windows-msvc"];
  const tail = ["vendor", triple, "bin", "codex.exe"];
  const root = win32.join(dir, "node_modules", "@openai", "codex");
  for (const c of [win32.join(root, "node_modules", "@openai", pkg, ...tail), win32.join(dir, "node_modules", "@openai", pkg, ...tail), win32.join(root, ...tail)]) if (exists(c)) return c;
  return null;
}

/**
 * An argument cmd.exe passes through unchanged. Bun runs a `.cmd` / `.bat` through cmd.exe with
 * quoting cmd.exe doesn't honour: a `"` ends the quoting and `&`, `|`, `%VAR%`, `^` and a newline
 * act (BatBadBut; Bun 1.3.14). Only plain words, paths and spaces go to a shim.
 */
export const cmdSafe = (arg: string) => unsafeChar(arg) === null;

/** The first character of `arg` cmd.exe would act on (letters in any script, digits, spaces and path punctuation are safe), or null. */
export function unsafeChar(arg: string): string | null {
  for (const ch of arg) if (!/^[\p{L}\p{M}\p{N}_ .,:/\\@+=~'-]$/u.test(ch)) return ch;
  return null;
}

/** A character for a message: `"&"`, or its code point when it doesn't print (`U+000A`). */
export const showChar = (ch: string) => (/^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(ch) ? JSON.stringify(ch) : `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);

/** Throws unless every argument can go through cmd.exe to a shim as it is; the message names the character. */
export function assertShimArgs(argv: string[]): void {
  if (!isShim(argv[0] ?? "")) return;
  for (const a of argv.slice(1)) {
    const ch = unsafeChar(a);
    if (ch !== null) throw new Error(`${win32.basename(argv[0]!)} is a Windows .cmd shim, which runs through cmd.exe, and an argument has ${showChar(ch)} in it, which cmd.exe would act on: ${JSON.stringify(a.length > 80 ? `${a.slice(0, 80)}…` : a)}. Install the agent's native .exe`);
  }
}

/** A Windows path's 8.3 short form (GetShortPathNameW; no spaces or non-ASCII where 8.3 names exist), or null. */
export function shortPath(path: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const k = dlopen("kernel32.dll", { GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 } });
    try {
      const input = Buffer.from(`${path}\0`, "utf16le");
      const out = Buffer.alloc(2 * 1024);
      const n = k.symbols.GetShortPathNameW(ptr(input), ptr(out), 1024);
      return n > 0 && n < 1024 ? out.toString("utf16le", 0, n * 2) : null;
    } finally {
      k.close();
    }
  } catch {
    return null;
  }
}

/**
 * A Windows path's long form (GetLongPathNameW: `C:\Users\RUNNER~1\…` → `C:\Users\runneradmin\…`),
 * for comparing paths. A part that doesn't exist yet is kept as given, after its longest existing
 * parent's long form; links are not followed. Elsewhere, or on any failure, the path unchanged.
 */
export function longPath(path: string): string {
  if (process.platform !== "win32") return path;
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const k = dlopen("kernel32.dll", { GetLongPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 } });
    try {
      const out = Buffer.alloc(2 * 32768);
      const rest: string[] = [];
      for (let head = win32.resolve(path); ; ) {
        const n = k.symbols.GetLongPathNameW(ptr(Buffer.from(`${head}\0`, "utf16le")), ptr(out), 32768);
        if (n > 0 && n < 32768) return win32.join(out.toString("utf16le", 0, n * 2), ...rest);
        const up = win32.dirname(head);
        if (up === head) return path;
        rest.unshift(win32.basename(head));
        head = up;
      }
    } finally {
      k.close();
    }
  } catch {
    return path;
  }
}

/** Whether a process runs (EPERM: it does, as another user). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const DAY_MS = 86_400_000;

/**
 * What a hard-killed Gluon left in the temp dir: launch spec files (`launchPlan`) and a UI
 * launch's events and adapter directories (`handOffSession`), the directory checks ran in
 * (`neutralCwd`), removed once the Gluon named by
 * their `pid` file is gone (without one: once a day old). Another running Gluon's are kept.
 */
export function cleanStaleSpecs(dir = tmpdir(), now = Date.now(), alive: (pid: number) => boolean = pidAlive): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!["gluon-spec-", "gluon-events-", "gluon-adapter-", "gluon-cwd-"].some((p) => name.startsWith(p))) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        // Ours only (POSIX: the owner; Windows: %TEMP% is the user's own).
        if (!st.isDirectory() || (process.getuid !== undefined && st.uid !== process.getuid())) continue;
        const old = now - st.mtimeMs > DAY_MS;
        let pid: number | null = null;
        try {
          const text = readFileSync(join(p, "pid"), "utf8").trim();
          if (/^\d{1,10}$/.test(text)) pid = Number(text);
        } catch {}
        if (pid === null ? old : pid !== process.pid && !alive(pid)) rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

/**
 * Stops a process and everything it started. On Windows, killing a process leaves its children
 * running (an npm shim's node, a harness's tools): `taskkill /T /F` by full path ends the tree.
 */
export function killTree(proc: { pid?: number; exitCode?: number | null; signalCode?: string | null; kill(): void }, platform: NodeJS.Platform = process.platform): void {
  // Already gone: its PID may be someone else's by now.
  if ((proc.exitCode ?? null) !== null || proc.signalCode) return;
  if (platform === "win32" && proc.pid) {
    try {
      Bun.spawn([windowsTool("taskkill"), "/PID", String(proc.pid), "/T", "/F"], { stdio: ["ignore", "ignore", "ignore"] }).exited.finally(() => {
        try {
          proc.kill();
        } catch {}
      });
      return;
    } catch {}
  }
  proc.kill();
}

export const installed = (h: Harness, opts?: DetectOptions) => binPath(HARNESS_INFO[h].binary, opts) !== undefined;

/** Why a binary can't be run: not on PATH, or only a Windows install seen from WSL. */
export function missingReason(bin: string, opts?: DetectOptions): string {
  const r = resolveBin(bin, opts);
  return r?.foreign ? `a Windows install of ${bin} was found on PATH (${r.path}); install it inside WSL` : `${bin} is not installed (not found on PATH)`;
}

/** "not installed", or on WSL, that only a Windows install was found. */
export function absentLabel(h: Harness, opts?: DetectOptions): string {
  return resolveHarness(h, opts)?.foreign ? "a Windows install was found on PATH; install it inside WSL" : "not installed";
}
