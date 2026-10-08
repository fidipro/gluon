/**
 * Putting a downloaded, verified executable in place of this one. It is staged in the executable's own directory (one rename,
 * never a copy across file systems), must answer `--version` with the version it was downloaded as, and is renamed over the old
 * one. On Linux and macOS a running Gluon keeps the old file (its inode); Windows can't replace a running .exe, but can rename
 * it: the old one moves aside to `<exe>.old` (swept at a later start) and goes back if the new one can't be moved in.
 */
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { neutralCwd } from "../detect.ts";
import { defaultSpawn } from "../cost/grok-usage.ts";
import { renameOver } from "../secrets.ts";
import { UpdateError } from "./fetch.ts";

const STAGED_PREFIX = ".gluon-update-";
/** A staged file older than this is a crashed update's (one in progress is minutes old at most). */
const STALE_STAGED_MS = 24 * 3_600_000;
const VERSION_TIMEOUT_MS = 30_000;

/** A new, unused path to stage the download at, next to `exe`. */
export function stagedPath(exe: string, platform: NodeJS.Platform = process.platform): string {
  return join(dirname(exe), `${STAGED_PREFIX}${crypto.randomUUID().slice(0, 8)}${platform === "win32" ? ".exe" : ""}`);
}

/** What an executable prints for `--version` (run in a neutral directory), or null. */
export type VersionOf = (path: string) => Promise<string | null>;
const versionOf: VersionOf = async (path) => (await defaultSpawn([path, "--version"], { cwd: neutralCwd(), env: process.env, timeoutMs: VERSION_TIMEOUT_MS }).catch(() => null))?.trim() ?? null;

export interface ReplaceOptions {
  exe: string;
  staged: string;
  version: string;
  platform?: NodeJS.Platform;
  versionOf?: VersionOf;
}

/** Replaces `exe` with `staged` once it says it is `version`; throws (with `exe` unchanged) otherwise. */
export async function replaceExecutable(o: ReplaceOptions): Promise<void> {
  const platform = o.platform ?? process.platform;
  chmodSync(o.staged, 0o755);
  const said = await (o.versionOf ?? versionOf)(o.staged);
  if (said !== o.version) throw new UpdateError(`the downloaded Gluon doesn't run here (it answered ${said === null ? "nothing" : `"${said.slice(0, 40)}"`} to --version)`);
  try {
    if (platform !== "win32") return renameOver(o.staged, o.exe);
    const old = freeOldPath(o.exe);
    renameOver(o.exe, old);
    try {
      renameOver(o.staged, o.exe);
    } catch (e) {
      renameOver(old, o.exe);
      throw e;
    }
  } catch (e) {
    throw new UpdateError(`couldn't replace ${o.exe}: ${(e as Error).message}`);
  }
}

/** `<exe>.old`, or a numbered one when that is still in use (a Gluon started before the last update still runs from it). */
function freeOldPath(exe: string): string {
  for (let i = 0; ; i++) {
    const p = i === 0 ? `${exe}.old` : `${exe}.old${i}`;
    try {
      rmSync(p, { force: true });
      return p;
    } catch {
      if (i >= 20) throw new UpdateError(`too many old copies of ${basename(exe)} are in use`);
    }
  }
}

/** Removes what an earlier update left next to `exe`: old copies (`<exe>.old*`, once nothing runs them) and stale staged files. Never throws. */
export function sweepLeftovers(exe: string, now = Date.now()): void {
  try {
    const dir = dirname(exe);
    const name = basename(exe);
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (f.startsWith(`${name}.old`) && /^\d*$/.test(f.slice(name.length + 4))) rmSync(p, { force: true });
        else if (f.startsWith(STAGED_PREFIX) && now - statSync(p).mtimeMs > STALE_STAGED_MS) rmSync(p, { force: true });
      } catch {}
    }
  } catch {}
}

/** Removes a staged file that wasn't used. Never throws. */
export function removeStaged(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {}
}
