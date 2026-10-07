/**
 * The one exception to "never edit another tool's files" (owner-approved, issue #13): a file or
 * folder of Gluon's own in Grok Build's hooks directory and Antigravity's plugins directory,
 * inert unless `GLUON_EVENTS` is set (only Gluon's launches set it), removed by
 * `gluon uninstall`. Only this module names those paths (`test/rules.test.ts`); it reads and
 * writes only its own file and folder there, never anything beside them.
 *
 * The content never changes between installs, upgrades or ways of running Gluon: the commands
 * call `$GLUON_SELF` (`self.ts`), set per launch, never a path written here. It may differ by
 * OS (the harness's shell), never by machine.
 *
 * Today only grok's file has a job: its `PreCompact` hook asks before an auto-compaction, and its
 * status hooks tell Gluon what grok is doing (`statusHook`, display only); the agy plugin v1
 * wrote is no longer written, removed at the next agy launch and by uninstall. Files written under
 * the name before the rename (`fidicode`: agy's plugin folder, grok's `fidicode.json`) are only
 * ever removed, by uninstall (and the grok one at the next grok launch).
 *
 * grok's status events, from its embedded hooks guide (1.0.46; `strings` on the binary, not run):
 * `UserPromptSubmit` (busy), `Stop` / `StopFailure` / `StopCancelled` (the turn ended, however),
 * `Notification` matched on its type (`permission_prompt` waits for the user; `idle_prompt` is the
 * backstop for a turn that reported no end), `PreToolUse` / `PostToolUse` (`tool_name`,
 * `tool_input`). A subagent's own hooks carry `subagentType` and are ignored. `Stop` and
 * `UserPromptSubmit` can block, by exit 2 or a decision on stdout: Gluon's print nothing and
 * exit 0. Every grok session runs these commands; outside a Gluon launch each is one `sh` test.
 *
 * Checked by hand on 2026-10-01 against grok 1.0.46 (source rev 559751f, a scratch HOME) and agy
 * 1.2.14 (embedded docs, a scratch HOME, all network sent to a dead proxy):
 * - grok loads every `*.json` in `$GROK_HOME/hooks` (default `~/.grok/hooks`, no trust needed;
 *   names starting with "." are skipped), re-read at each session start. The hooks run in the
 *   grok process the user started, with its environment, also in leader mode.
 * - grok expands `$VAR` / `${VAR}` when it loads the file and refuses to run a command naming an
 *   unset one ("hook not executed", shown as a failed hook in the scrollback); `${VAR:-}` and other
 *   modifier forms are left to the shell. Hence `${GLUON_EVENTS:-}` and `${env:...}` below.
 * - grok runs a hook through `sh -c`; on Windows through pwsh / powershell.exe (`-NoProfile
 *   -NonInteractive -Command`), unless `GROK_SHELL` picks Git Bash or cmd. The PowerShell form was
 *   run in Windows PowerShell 5.1: stdin reaches the command, and it is silent without the env.
 * - A hook that succeeds leaves no trace. `timeout` is in seconds (default 5); the `PreCompact`
 *   matcher is the trigger (`manual`, `auto`), none matches both (grok's hooks guide).
 * - agy loads `~/.gemini/config/plugins/<name>/` (`plugin.json` + `hooks.json`).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Harness } from "../harnesses.ts";
import { privateDir, renameOver } from "../secrets.ts";
import { COMPACT_HOOK_TIMEOUT_S } from "./common.ts";

export interface PermanentOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

type Resolved = Required<PermanentOptions>;
const resolve = (o: PermanentOptions = {}): Resolved => ({ home: o.home ?? homedir(), env: o.env ?? process.env, platform: o.platform ?? process.platform });

/** Grok Build's hooks file of Gluon's own (`$GROK_HOME` wins, as in grok). */
const grokFile = ({ home, env }: Resolved) => join(env.GROK_HOME || join(home, ".grok"), "hooks", "gluon.json");
/** The same file under the name before the rename to Gluon (never written; removed). */
const legacyGrokFile = ({ home, env }: Resolved) => join(env.GROK_HOME || join(home, ".grok"), "hooks", "fidicode.json");
/** Antigravity's plugin folder v1 wrote, under the name of the time (never written now; removed). */
const agyDir = ({ home }: Resolved) => join(home, ".gemini", "config", "plugins", "fidicode");

/** A POSIX `sh -c` command: exits 0 and prints nothing unless Gluon launched this agent. */
const posix = (harness: Harness, name: string) => `[ -z "\${GLUON_EVENTS:-}" ] || [ -z "\${GLUON_SELF:-}" ] || exec "\${GLUON_SELF:-}" hook ${harness} ${name}`;
/** The same for PowerShell (grok on Windows); `${env:X}` is a form grok leaves alone. */
const powershell = (harness: Harness, name: string) => `if (\${env:GLUON_EVENTS} -and \${env:GLUON_SELF}) { & \${env:GLUON_SELF} hook ${harness} ${name} }`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const DESCRIPTION = "Gluon (issue #13): lets a session Gluon started return to it. Does nothing in any other session. `gluon uninstall` removes it.";

/** Why grok on Windows can't run the PowerShell command, or null. */
function grokShellProblem({ env, platform }: Resolved): string | null {
  if (platform !== "win32") return null;
  const shell = (env.GROK_SHELL ?? "").trim().toLowerCase();
  return ["bash", "gitbash", "git-bash", "cmd", "cmd.exe"].includes(shell) ? `GROK_SHELL=${env.GROK_SHELL}: Gluon's Grok Build hook needs PowerShell` : null;
}

/** A status hook's timeout (seconds): it only writes one small file. */
const STATUS_TIMEOUT_S = 5;

/** The contents of `~/.grok/hooks/gluon.json` on this OS. */
export function grokHooks(platform: NodeJS.Platform = process.platform): string {
  const cmd = platform === "win32" ? powershell : posix;
  const one = (name: string, timeout = STATUS_TIMEOUT_S) => ({ type: "command", command: cmd("grok-build", name), timeout });
  const status = (name: string, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [one(name)] });
  // Per tool call only where the inert check is a cheap `sh` test: on Windows every grok session
  // would start PowerShell twice per tool call. There the status is per turn, with no activity.
  const tools = platform === "win32" ? {} : { PreToolUse: [status("tool")], PostToolUse: [status("tool-done")] };
  return json({
    description: DESCRIPTION,
    hooks: {
      // Waits for the user's answer: grok must not kill it first. Both triggers (no matcher).
      PreCompact: [{ hooks: [one("pre-compact", COMPACT_HOOK_TIMEOUT_S)] }],
      UserPromptSubmit: [status("prompt")],
      ...tools,
      Notification: [status("permission", "permission_prompt"), status("idle", "idle_prompt")],
      Stop: [status("stop")],
      StopFailure: [status("stop")],
      StopCancelled: [status("stop")],
    },
  });
}

const readOr = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The path to show: `~/…` under the home directory. */
const tilde = (path: string, home: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

/** Writes `text` as the file `target`, directory first. */
function writeFile(target: string, text: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const { dir } = privateDir(dirname(target), ".gluon-", false);
  try {
    const tmp = join(dir, "gluon.json");
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameOver(tmp, target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Writes this harness's permanent file when it's missing or different (agy: removes v1's plugin);
 * returns a note when it can't (the launch goes on without it). Nothing for the other harnesses.
 */
export function ensurePermanentFiles(harness: Harness, opts: PermanentOptions = {}): string | null {
  const o = resolve(opts);
  try {
    if (harness === "grok-build") {
      const file = grokFile(o);
      const problem = grokShellProblem(o);
      if (problem) {
        // Its command would fail (and say so) in every Grok session: none is better.
        rmSync(file, { force: true });
        return `${problem}; auto-compaction won't ask whether to end the session`;
      }
      rmSync(legacyGrokFile(o), { force: true });
      const text = grokHooks(o.platform);
      if (readOr(file) !== text) writeFile(file, text);
    } else if (harness === "antigravity") {
      // v1's plugin has no job any more: its hook would only start Gluon for nothing.
      const dir = agyDir(o);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    return null;
  } catch (e) {
    const path = harness === "grok-build" ? grokFile(o) : agyDir(o);
    return `couldn't ${harness === "grok-build" ? "write" : "remove"} ${tilde(path, o.home)} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})${harness === "grok-build" ? ": auto-compaction won't ask whether to end the session" : ""}`;
  }
}

/** The permanent files that exist now. */
export function listPermanentFiles(opts: PermanentOptions = {}): string[] {
  const o = resolve(opts);
  const grok = grokFile(o);
  const legacy = legacyGrokFile(o);
  const agy = agyDir(o);
  return [...(existsSync(grok) && statSync(grok).isFile() ? [grok] : []), ...(existsSync(legacy) && statSync(legacy).isFile() ? [legacy] : []), ...(existsSync(agy) && statSync(agy).isDirectory() ? [agy] : [])];
}

/** Removes them; returns what was removed. */
export function removePermanentFiles(opts: PermanentOptions = {}): string[] {
  const removed = listPermanentFiles(opts);
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  return removed;
}
