/**
 * `gluon uninstall`: removes what Gluon wrote, and on a standalone POSIX install the binary
 * itself. Only Gluon's own files: the config file (never a directory GLUON_CONFIG merely
 * points into), the saved keys next to it (only its own lines of a `.env` that holds more: BUG-156),
 * the saved sessions next to it (`workspaces/`), its files in the agents' directories
 * (`removePermanentFiles`), its cost audit ledger, the price tables `gluon pricing update` kept, and its temporary directories.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agyStatusLineInstalled, removeAgyStatusLine } from "./adapters/agy-settings.ts";
import { listPermanentFiles, removePermanentFiles } from "./adapters/permanent.ts";
import { analyticsPath } from "./analytics.ts";
import { configPath } from "./config.ts";
import { routingPath } from "./routing-config.ts";
import { ledgerDir, registryDir, removeLedger } from "./cost/ledger-file.ts";
import { tablesDir } from "./cost/tables-store.ts";
import { BUILD, COMPILED } from "./detect.ts";
import { EVENTS_PREFIX } from "./events.ts";
import { grokKeyAuthPath } from "./launchers.ts";
import { secretsPath, withoutSavedKeys } from "./secrets.ts";
import { runningGluons, workspacesDir } from "./workspaces.ts";

/** Temporary directories Gluon makes (launch specs, events, adapter files, neutral working dirs). */
export const TEMP_PREFIXES = ["gluon-spec-", EVENTS_PREFIX, "gluon-adapter-", "gluon-cwd-"];

/** Whether a process with this pid is running (EPERM: it is, someone else's). */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Gluon's temp directories in `tmp`: real directories (not links), the user's own, not of a running Gluon (its `pid` file). */
export function staleTempDirs(tmp = tmpdir()): string[] {
  let names: string[];
  try {
    names = readdirSync(tmp);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!TEMP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const p = join(tmp, name);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory() || !owned(st)) continue;
      const pidFile = join(p, "pid");
      if (existsSync(pidFile) && alive(Number(readFileSync(pidFile, "utf8").trim()))) continue;
      out.push(p);
    } catch {}
  }
  return out;
}

const isFile = (p: string) => {
  try {
    const st = lstatSync(p);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
};
const isDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isEmptyDir = (p: string) => {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
};

const owned = (st: { uid: number }) => process.getuid === undefined || st.uid === process.getuid();

/**
 * What uninstall does with the `.env` next to the config: `delete` when it holds only Gluon's
 * keys, `strip` (those lines out, the rest kept) when it holds more — a GLUON_CONFIG may point
 * into a directory with the user's own `.env` (BUG-156) — else `keep`.
 */
export function envPlan(path = secretsPath()): "delete" | "strip" | "keep" {
  if (!isFile(path)) return "keep";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "keep";
  }
  const rest = withoutSavedKeys(text);
  return rest === null ? "delete" : rest === text ? "keep" : "strip";
}

/**
 * Private directories a failed key save or adapter write left behind in `dir`: exactly
 * `.gluon-` + mkdtemp's 6 characters, a real directory of the user's, holding at most a `.env`.
 */
export function keySaveLeftovers(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => /^\.gluon-[A-Za-z0-9]{6}$/.test(n))
      .map((n) => join(dir, n))
      .filter((p) => {
        try {
          const st = lstatSync(p);
          return st.isDirectory() && owned(st) && readdirSync(p).every((n) => n === ".env");
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Gluon's own in the saved sessions' directory: its `<id>.json` files, their `<id>.lock` claims (and a takeover's `<id>.lock.takeover`) and a failed write's
 * `.gluon-` directory. Never anything else there: a GLUON_CONFIG may point beside a directory of
 * the user's own named `workspaces` (BUG-293).
 */
export function workspaceFiles(dir = workspacesDir()): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => (/^[a-z2-7]{6}\.(json|lock|lock\.takeover)$/.test(n) ? isFile(join(dir, n)) : /^\.gluon-[A-Za-z0-9]{6}$/.test(n) && isDir(join(dir, n))))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** The files and directories `uninstall` removes, before the config dir and the binary. */
export function uninstallTargets(tmp = tmpdir()): string[] {
  const config = configPath();
  const dir = dirname(config);
  return [
    ...listPermanentFiles(),
    ...[config, routingPath()].filter(isFile),
    ...(envPlan() === "keep" ? [] : [secretsPath()]),
    ...[dirname(grokKeyAuthPath()), ...keySaveLeftovers(dir), ledgerDir(), registryDir()].filter(isDir),
    // Only where Gluon has files in it, or it is empty: a directory of the user's own is no target, and is not reported as removed (BUG-623).
    ...(isDir(workspacesDir()) && (workspaceFiles().length > 0 || isEmptyDir(workspacesDir())) ? [workspacesDir()] : []),
    ...[tablesDir()].filter(isDir),
    ...[analyticsPath(), `${analyticsPath()}-wal`, `${analyticsPath()}-shm`].filter(isFile),
    ...staleTempDirs(tmp),
  ];
}

export interface UninstallOptions {
  yes: boolean;
  /** stdin and stdout are a terminal (a question can be asked). */
  tty: boolean;
  tmp?: string;
  platform?: NodeJS.Platform;
  /** Asks the user; true to go on. */
  ask?: (question: string) => boolean;
  log?: (line: string) => void;
}

/** Runs `gluon uninstall`; returns the exit code. */
export function uninstall(o: UninstallOptions): number {
  const platform = o.platform ?? process.platform;
  const log = o.log ?? ((l: string) => console.log(l));
  // A running Gluon writes its saved workspace back at its next change, undoing the removal: refused, with nothing removed (QA-resume-12).
  const running = runningGluons();
  if (running.length > 0) {
    console.error(`gluon: ${running.length === 1 ? `a Gluon is running (process ${running[0]})` : `Gluons are running (processes ${running.join(", ")})`}; nothing was removed. Quit ${running.length === 1 ? "it" : "them"}, then run gluon uninstall again.`);
    return 1;
  }
  const targets = uninstallTargets(o.tmp);
  const binary = COMPILED && BUILD === "release" && platform !== "win32" ? process.execPath : null;
  const env = secretsPath();
  const strip = envPlan(env) === "strip";
  const sessions = workspacesDir();
  const shown = (p: string) => (strip && p === env ? `${p} (only Gluon's keys in it)` : p === sessions ? `${p} (only its session files)` : p);
  if (!o.yes) {
    if (!o.tty) {
      console.error("gluon: uninstall needs a terminal to ask first; to remove without asking: gluon uninstall --yes");
      return 2;
    }
    const agy = agyStatusLineInstalled({ configDir: dirname(configPath()) });
    const all = [...targets, ...(agy ? [`${agy} (only Gluon's statusLine key)`] : []), ...(binary ? [binary] : [])];
    log(all.length ? `This removes:\n${all.map((p) => `  ${shown(p)}`).join("\n")}` : "Gluon has no files to remove here.");
    const ask = o.ask ?? ((q: string) => /^y(es)?$/i.test((prompt(q) ?? "").trim()));
    if (all.length && !ask("Uninstall Gluon? [y/N]")) {
      log("Nothing removed.");
      return 0;
    }
  }
  const removed: string[] = [];
  const failed: string[] = [];
  const remove = (p: string) => {
    try {
      if (strip && p === env) writeFileSync(env, withoutSavedKeys(readFileSync(env, "utf8")) ?? "");
      else if (p === sessions) {
        for (const f of workspaceFiles(p)) rmSync(f, { recursive: true, force: true });
        // The directory goes once empty; with anything of the user's in it, it stays.
        if (readdirSync(p).length === 0) rmdirSync(p);
        else return void removed.push(`the session files in ${p}`);
      } else if (p === ledgerDir()) removeLedger(p);
      else rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch (e) {
      failed.push(`${p}: ${(e as Error).message}`);
    }
  };
  try {
    removed.push(...removePermanentFiles());
    // Antigravity's own settings file: only Gluon's key goes (and its script in Gluon's directory), never the file.
    removed.push(...removeAgyStatusLine({ configDir: dirname(configPath()) }));
    // A key that couldn't be removed stays, with its script: said, not left as if it were gone (BUG-404).
    const left = agyStatusLineInstalled({ configDir: dirname(configPath()) });
    if (left) failed.push(`${left}: Gluon's statusLine key is still there (the file changed or has a layout Gluon can't edit safely); remove "statusLine" by hand`);
  } catch (e) {
    failed.push((e as Error).message);
  }
  for (const p of targets) if (existsSync(p) && !removed.includes(p)) remove(p);
  // The config directory only where Gluon chose it, and only once empty: a GLUON_CONFIG
  // may point into a directory of the user's own.
  const configDir = dirname(configPath());
  if (!process.env.GLUON_CONFIG && isDir(configDir)) {
    try {
      if (readdirSync(configDir).length === 0) {
        rmdirSync(configDir);
        removed.push(configDir);
      }
    } catch {}
  }
  for (const p of removed) log(strip && p === env ? `Removed Gluon's keys from ${p}` : `Removed ${p}`);
  for (const f of failed) console.error(`gluon: couldn't remove ${f}`);
  if (binary) {
    // Last: this process keeps running from memory.
    remove(binary);
    if (removed.at(-1) === binary) log(`Removed ${binary}`);
  } else if (COMPILED && BUILD === "release") {
    log(`To finish, delete ${process.execPath}`);
    log("and, if install.ps1 -AddToPath added its directory to your user PATH, take it out (Settings > Environment variables).");
  } else if (BUILD === "npm") {
    log("To finish: bun remove -g gluon");
  } else if (!COMPILED) {
    log("Running from source: no binary to remove.");
  }
  log(removed.length ? "Gluon is uninstalled." : "Nothing to remove.");
  return failed.length ? 1 : 0;
}
