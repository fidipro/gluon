/**
 * Installing a missing harness with its vendor's official installer, only when the developer says
 * so: the exact command is shown first (with where it downloads from and the vendor's docs), and it
 * runs only on "Run it" + Enter. No flag skips the question; without a terminal the command is only
 * printed. What runs is the constant from `harnesses.ts`, as shown: `sh -c <command>`, Windows
 * PowerShell by its full path, or npm by the path found on PATH — in an empty directory (never the
 * user's repository), as the user, never with sudo.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { binPath, installed, neutralCwd, resolveBin, resolveHarness, type DetectOptions } from "./detect.ts";
import { HARNESS_INFO, HARNESSES, installHint, installMethods, type Harness, type InstallMethod } from "./harnesses.ts";
import { inTerminal } from "./launchers.ts";
import { Cancelled, pick, pickMany, type EscAction } from "./ui/signin.tsx";
import type { Theme } from "./ui/theme.ts";

/** Windows PowerShell by its full path: a bare name could be found in the current directory first. */
export const powershellPath = (env: Record<string, string | undefined> = process.env) => win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const NEED_LABEL: Record<string, string> = { npm: "npm (Node.js)", powershell: "Windows PowerShell" };

export interface Offer {
  method: InstallMethod;
  /** Prerequisites not found ("npm (Node.js)"); empty when it can run. */
  missing: string[];
  /** What runs, when nothing is missing and the method is verified. */
  argv?: string[];
}

export interface InstallEnv extends DetectOptions {
  env?: Record<string, string | undefined>;
  /** Whether a file exists (tests). */
  exists?: (path: string) => boolean;
}

/** The argv a method runs as, or undefined while a prerequisite is missing. */
export function installArgv(m: InstallMethod, { env = process.env, exists = existsSync, ...detect }: InstallEnv = {}): string[] | undefined {
  if (m.shell === "powershell") {
    const ps = powershellPath(env);
    return exists(ps) ? [ps, "-NoProfile", "-Command", m.command] : undefined;
  }
  const bin = binPath(m.shell === "sh" ? "sh" : m.argv![0]!, detect);
  return bin ? (m.shell === "sh" ? [bin, "-c", m.command] : [bin, ...m.argv!.slice(1)]) : undefined;
}

/** The official methods for a harness on this platform, each with the prerequisites it lacks here. */
export function methodsFor(h: Harness, opts: InstallEnv = {}): Offer[] {
  const { env = process.env, exists = existsSync, ...detect } = opts;
  return installMethods(h, detect.platform).map((method) => {
    const missing = method.needs
      .filter((n) => (n === "powershell" ? !exists(powershellPath(env)) : !binPath(n, detect)))
      // On WSL a Windows npm (or curl) on PATH can't install a Linux agent.
      .map((n) => `${NEED_LABEL[n] ?? n}${n !== "powershell" && resolveBin(n, detect)?.foreign ? " inside WSL (only a Windows one is on PATH)" : ""}`);
    const argv = missing.length || !method.verified ? undefined : installArgv(method, opts);
    return { method, missing, ...(argv ? { argv } : {}) };
  });
}

/** Where each installer puts the binary (read from the installers, 2026-09-30); npm's own prefix is asked separately. */
export function installDirs(h: Harness, { platform = process.platform, env = process.env, home = homedir() }: { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; home?: string } = {}): string[] {
  if (platform === "win32") {
    const profile = env.USERPROFILE || home;
    const local = env.LOCALAPPDATA || win32.join(profile, "AppData", "Local");
    const dirs: Record<Harness, string[]> = {
      "claude-code": [win32.join(profile, ".local", "bin")],
      codex: [env.CODEX_INSTALL_DIR || win32.join(local, "Programs", "OpenAI", "Codex", "bin")],
      antigravity: [win32.join(local, "agy", "bin")],
      "grok-build": [env.GROK_BIN_DIR || win32.join(profile, ".grok", "bin")],
      opencode: [],
      "kimi-code": [env.KIMI_INSTALL_DIR ? win32.join(env.KIMI_INSTALL_DIR, "bin") : win32.join(profile, ".kimi-code", "bin")],
    };
    return dirs[h];
  }
  const dirs: Record<Harness, string[]> = {
    "claude-code": [posix.join(home, ".local", "bin")],
    codex: [env.CODEX_INSTALL_DIR || posix.join(home, ".local", "bin")],
    antigravity: [posix.join(home, ".local", "bin")],
    "grok-build": [env.GROK_BIN_DIR || posix.join(home, ".grok", "bin")],
    opencode: [posix.join(home, ".opencode", "bin")],
    "kimi-code": [env.KIMI_INSTALL_DIR ? posix.join(env.KIMI_INSTALL_DIR, "bin") : posix.join(home, ".kimi-code", "bin")],
  };
  return dirs[h];
}

/** npm's global bin directory (`npm prefix -g`), or null. */
async function npmBin(platform = process.platform): Promise<string | null> {
  const npm = binPath("npm");
  if (!npm) return null;
  try {
    const p = Bun.spawn([npm, "prefix", "-g"], { cwd: neutralCwd(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    const prefix = out.trim();
    return code === 0 && prefix ? (platform === "win32" ? prefix : join(prefix, "bin")) : null;
  } catch {
    return null;
  }
}

export type Found = { on: "path"; path: string } | { on: "elsewhere"; path: string; dir: string } | { on: "nowhere" };

/**
 * After an install: on PATH now, or in a directory an installer uses that isn't on PATH yet (it
 * isn't used from there: the developer's own PATH decides what runs), or nowhere.
 */
export function findInstalled(h: Harness, dirs: string[], { platform = process.platform, exists = existsSync, ...detect }: DetectOptions & { exists?: (p: string) => boolean } = {}): Found {
  const r = resolveHarness(h, { platform, ...detect });
  if (r && !r.foreign) return { on: "path", path: r.path };
  const bin = HARNESS_INFO[h].binary;
  const names = platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`] : [bin];
  const j = platform === "win32" ? win32.join : posix.join;
  for (const dir of dirs) for (const n of names) if (exists(j(dir, n))) return { on: "elsewhere", path: j(dir, n), dir };
  return { on: "nowhere" };
}

const say = (s: string) => console.log(`  ${s}`);

/** What a method does, in words. */
const what = (h: Harness, m: InstallMethod) =>
  m.shell === "exec" ? `Installs ${HARNESS_INFO[h].vendor}'s official npm package ${m.argv!.at(-1)} from ${m.host}.` : `Downloads ${HARNESS_INFO[h].vendor}'s official installer from ${m.host} and runs it, as you (no sudo).`;

/** What to do about a binary in a directory that isn't on PATH. Some installers edit shell profiles, some (grok) never do. */
export const offPathAdvice = (dir: string) => `add ${dir} to your PATH (or open a new terminal, if the installer added it)`;

/** The commands, printed to run by hand. */
export function printInstall(h: Harness, offers = methodsFor(h)): void {
  const info = HARNESS_INFO[h];
  if (!offers.length) return say(`${info.label} (${info.binary}): no official installer for this system; see its docs.`);
  say(`${info.label} (${info.binary}), from ${info.vendor}'s docs (${offers[0]!.method.docs}):`);
  for (const [i, o] of offers.entries()) {
    const extra = [o.method.verified ? "" : "not checked by Gluon", o.missing.length ? `needs ${o.missing.join(", ")}` : "", o.method.note ?? ""].filter(Boolean);
    say(`${i ? "or  " : "    "}${o.method.command}${extra.length ? `   (${extra.join("; ")})` : ""}`);
  }
}

export type Outcome = "installed" | "elsewhere" | "skipped" | "shown" | "failed";
export interface Result {
  outcome: Outcome;
  /** "elsewhere": the directory it landed in, not on PATH. */
  dir?: string;
}

/** Ctrl+C in the child: 130 (a POSIX shell), a SIGINT, or Windows' STATUS_CONTROL_C_EXIT. */
const interrupted = (code: number) => code === 130 || code === 0xc000013a || code === -1073741510;

/**
 * Offers to install a harness: the command, where it comes from and its docs, then Skip (the
 * default) / Show the command only / Run it. Esc skips; Ctrl+C throws `Cancelled`. Only a verified
 * method whose prerequisites are here can be run, and only by a key pressed on its own (`guard`).
 */
export async function offerInstall(h: Harness, theme: Theme, esc: EscAction = "skip"): Promise<Result> {
  const info = HARNESS_INFO[h];
  const offers = methodsFor(h);
  const runnable = offers.filter((o) => o.argv);
  const foreign = resolveHarness(h)?.foreign;
  const old = findInstalled(h, installDirs(h));
  const body = [
    ...(offers.length
      ? offers.flatMap((o, i) => [
          `${i ? "Or: " : ""}\`${o.method.command}\``,
          o.method.verified ? what(h, o.method) : `Not checked by Gluon: see ${o.method.docs}`,
          ...(o.missing.length ? [`Needs ${o.missing.join(", ")}, which isn't on PATH.`] : []),
          ...(o.method.note ? [o.method.note] : []),
          "",
        ])
      : ["No official installer for this system.", ""]),
    ...(foreign ? [`A Windows install of ${info.binary} is on PATH; this installs ${info.label} inside WSL.`, ""] : []),
    ...(old.on === "elsewhere" ? [`There's already a ${info.binary} in ${old.dir}, which isn't on your PATH: ${offPathAdvice(old.dir)} instead of installing again.`, ""] : []),
    `Docs: ${offers[0]?.method.docs ?? "see the vendor's site"}`,
  ];
  const run = runnable.map((o) => ({ label: runnable.length > 1 && o.method.shell === "exec" ? `Run ${o.method.argv![0]} install` : "Run it", description: `\`${o.method.command}\`` }));
  const choice = await pick({
    theme,
    esc,
    guard: true,
    title: `${info.label} (${info.binary}) isn't installed${foreign ? " in WSL" : ""}. Install it?`,
    body,
    options: [{ label: "Skip", description: "Install nothing" }, { label: "Show the command only", description: "Print it to run yourself" }, ...run],
    initial: 0,
  });
  if (choice === null || choice === 0) return { outcome: "skipped" };
  if (choice === 1) {
    printInstall(h, offers);
    return { outcome: "shown" };
  }
  return runOffer(h, runnable[choice - 2]!);
}

/** Runs one method in the terminal, then looks for the binary. A non-zero exit is a failure, whatever is found; Ctrl+C in it throws `Cancelled`. */
export async function runOffer(h: Harness, o: Offer): Promise<Result> {
  const info = HARNESS_INFO[h];
  console.log(`\n  Running: ${o.method.command}\n`);
  let code: number;
  try {
    code = await inTerminal(o.argv!, process.env, neutralCwd());
  } catch (e) {
    say(`✗ couldn't run it: ${(e as Error).message}`);
    return { outcome: "failed" };
  }
  console.log("");
  if (interrupted(code)) throw new Cancelled();
  const npm = o.method.shell === "exec" && o.method.argv![0] === "npm";
  if (code !== 0) {
    say(`✗ The installer failed (exit code ${code}); ${info.label} may not be installed. See ${o.method.docs}.`);
    // npm's EACCES on a system-owned prefix: a user prefix, never sudo.
    if (npm && process.platform !== "win32") say("  If npm said EACCES, don't use sudo: give npm a prefix of your own (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).");
    return { outcome: "failed" };
  }
  const prefix = npm ? await npmBin() : null;
  const found = findInstalled(h, [...installDirs(h), ...(prefix ? [prefix] : [])]);
  if (found.on === "path") {
    say(`✓ ${info.label} is installed (${found.path}).`);
    return { outcome: "installed" };
  }
  if (found.on === "elsewhere") {
    say(`! ${info.label} was installed to ${found.dir}, which isn't on your PATH yet: ${offPathAdvice(found.dir)}.`);
    return { outcome: "elsewhere", dir: found.dir };
  }
  say(`✗ ${info.binary} isn't on PATH after the installer. See ${o.method.docs}.`);
  return { outcome: "failed" };
}

/** A harness by its id or its binary's name (`claude-code` or `claude`). */
export const harnessNamed = (name: string): Harness | undefined => HARNESSES.find((h) => h === name || HARNESS_INFO[h].binary === name);

/**
 * `gluon install [agent…]`: the named agents, or a checklist of the missing ones, each offered
 * in turn. Without a terminal it only prints the commands. Exit code: 0 when every agent asked for
 * is installed at the end (nothing asked: 0), else 1.
 */
export async function installCommand(names: string[], { tty, theme }: { tty: boolean; theme: () => Promise<Theme> }): Promise<number> {
  const asked = names.map((n) => harnessNamed(n)!);
  for (const h of asked) if (installed(h)) say(`✓ ${HARNESS_INFO[h].label} is installed (${binPath(HARNESS_INFO[h].binary)}).`);
  const missing = (asked.length ? asked : HARNESSES).filter((h, i, a) => !installed(h) && a.indexOf(h) === i);
  if (!missing.length) {
    if (!asked.length) say("All six coding agents are installed.");
    return 0;
  }
  if (!tty) {
    for (const h of missing) printInstall(h);
    say(`Run these yourself, or \`gluon install\` in a terminal (it shows each command and asks first).`);
    return 1;
  }
  const t = await theme();
  let chosen = missing;
  if (!asked.length) {
    const picked = await pickMany({
      theme: t,
      title: "Install coding agents",
      body: ["These aren't installed. Check the ones to install: each shows its official install command and runs it only if you say so."],
      options: missing.map((h) => ({ label: HARNESS_INFO[h].label, description: `${HARNESS_INFO[h].vendor} · from ${installMethods(h)[0]?.host ?? "its docs"}` })),
    });
    if (!picked?.length) {
      say("Nothing installed.");
      return 0;
    }
    chosen = picked.map((i) => missing[i]!);
  }
  let ok = true;
  for (const h of chosen) {
    const r = await offerInstall(h, t);
    if (r.outcome === "skipped") say(`Skipped ${HARNESS_INFO[h].label}. To install it later: \`${installHint(h)}\` (or \`gluon install ${h}\`).`);
    if (r.outcome !== "installed") ok = false;
  }
  return ok ? 0 : 1;
}
