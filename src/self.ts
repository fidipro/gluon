/**
 * How a hook or plugin inside a launched agent, or the agent itself, runs Gluon again
 * (`gluon signal`, `gluon hook`): one executable path, handed to the agent as
 * `GLUON_SELF`, so the commands Gluon gives a harness never change between installs,
 * upgrades or ways of running it.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPILED } from "./detect.ts";

/**
 * The argv that runs this Gluon. From source or the npm bundle that's Bun with the shebang's
 * flags (no `.env`, no `bunfig.toml` from the cwd, which is the user's repo: BUG-56).
 */
export function selfArgv(platform: NodeJS.Platform = process.platform): string[] {
  if (COMPILED) return [process.execPath];
  const config = platform === "win32" ? join(import.meta.dir, "..", "scripts", "empty-bunfig.toml") : "/dev/null";
  return [process.execPath, "--no-env-file", `--config=${config}`, Bun.main];
}

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The Windows wrapper's text (BUG-144). Who starts it: Bun.spawn runs a `.cmd` through cmd.exe
 * (OpenCode's plugin; checked by windows.test.ts "real Windows"), PowerShell's `&` (Claude Code's
 * hooks) and cmd.exe (Codex's `command_windows`) do too; Node's child_process refuses one without a
 * shell (CVE-2024-27980), so a harness must never be given it as a bare command for Node to spawn.
 * Only fixed words follow it (`signal back`, `hook <harness> <name>`). Inside the file, cmd.exe
 * still expands `%` (doubled here) and, if the user turned it on, `!` (delayed expansion off).
 */
export function cmdWrapper(argv: string[]): string {
  for (const a of argv) if (/["\r\n]/.test(a)) throw new Error(`a path cmd.exe can't quote: ${a}`);
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${argv.map((a) => `"${a.replaceAll("%", "%%")}"`).join(" ")} %*\r\n`;
}

/**
 * The executable for `GLUON_SELF`: the binary itself when compiled, else a small wrapper written
 * into `dir` (a private directory of the launch) that runs `selfArgv()` with its arguments.
 */
export function selfExecutable(dir: string, platform: NodeJS.Platform = process.platform): string {
  const argv = selfArgv(platform);
  if (argv.length === 1) return argv[0]!;
  if (platform === "win32") {
    const path = join(dir, "gluon.cmd");
    writeFileSync(path, cmdWrapper(argv), { mode: 0o600 });
    return path;
  }
  const path = join(dir, "gluon");
  writeFileSync(path, `#!/bin/sh\nexec ${argv.map(sh).join(" ")} "$@"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
