/**
 * The local table store (issue #89): the price and window tables Gluon builds on the user's machine
 * (prices from the network at start and launch, windows from the installed binaries) are kept in
 * `<state dir>/gluon/tables/`, one file per table (`tableFile`). `tables.ts` reads them at start; nothing
 * ships in the repository but the hand-maintained observed Grok windows. Light on purpose (fs, the
 * pure validator and the private-file writer only): `gluon hook` never loads it.
 *
 * A stored table is used only when it is VALID (the allowlist and bounds of `table-schema.ts`, the same
 * rules wherever a table comes from): a regular file (never a link), within `MAX_TABLE_BYTES`, in a real directory of the user's (never a link, tightened to 0700). Anything
 * else, or any error, is no table. A write never leaves a half-written one: private directory first,
 * the text written to a temp file beside it, then renamed over the old file (`writePrivate`).
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renameOver, restrictToUser, writePrivate } from "../secrets.ts";
import { pathFor, xdgBase } from "../xdg.ts";
import { MAX_TABLE_BYTES, parseTable, tableFile, type TableName } from "./table-schema.ts";

/** `XDG_STATE_HOME/gluon/tables`, else `%LOCALAPPDATA%\gluon\tables` on Windows, else `~/.local/state/gluon/tables` (beside the ledger's `cost-audit`). */
export function tablesDir(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const p = pathFor(platform);
  const base = xdgBase(env.XDG_STATE_HOME, platform) || (platform === "win32" ? env.LOCALAPPDATA || p.join(home, "AppData", "Local") : p.join(home, ".local", "state"));
  return p.join(base, "gluon", "tables");
}

/** The valid stored table `name`, or undefined (absent, invalid, a link, too large, another schema). */
export function readStoredTable<T>(name: TableName, dir = tablesDir()): T | undefined {
  try {
    if (lstatSync(dir).isSymbolicLink()) return undefined;
    const path = join(dir, tableFile(name));
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_TABLE_BYTES) return undefined;
    const parsed = parseTable(name, readFileSync(path, "utf8"));
    return "table" in parsed ? (parsed.table as unknown as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory (and its parents), private from the moment it exists (0700; on Windows, limited to the user with icacls). One that exists
 * already must be a real directory (not a symlink) of ours, as the ledger's (`ledger-file.ts`): a looser POSIX mode is put back to 0700,
 * a symlink or another user's directory throws (nothing is stored; a table is only read from a real file).
 */
export function privateTree(dir: string, restrict = process.platform === "win32"): void {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("the tables directory is not a real directory");
    if (process.platform === "win32") return;
    if (process.getuid !== undefined && st.uid !== process.getuid()) throw new Error("the tables directory is not ours");
    if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (restrict) restrictToUser(dir, true);
}

/** A killed write leaves its temp directory (`writePrivate`'s `.gluon-*`) behind: one this old is no write in progress. */
export const STALE_TEMP_MS = 3_600_000;

/** Removes the temp entries (`.gluon-*`) older than `STALE_TEMP_MS` from the store; never throws. A link is unlinked, never followed. */
export function cleanStaleTemps(dir: string, now = Date.now()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(".gluon-")) continue;
      try {
        const path = join(dir, name);
        const st = lstatSync(path);
        if (now - st.mtimeMs < STALE_TEMP_MS) continue;
        if (st.isSymbolicLink()) unlinkSync(path);
        else rmSync(path, { recursive: true, force: true });
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}

/**
 * Stores a table: refused (throws) when it would not read back as valid, else written in a private directory and renamed into place.
 * Returns the warning of the Windows ACL step, if any (`writePrivate`).
 */
export function writeStoredTable(name: TableName, table: unknown, dir = tablesDir(), restrict = process.platform === "win32", rename: (from: string, to: string) => void = renameOver, now = Date.now()): string | undefined {
  const text = `${JSON.stringify(table, null, 1)}\n`;
  const parsed = parseTable(name, text);
  if ("problem" in parsed) throw new Error(`${name}: not stored, ${parsed.problem}`);
  privateTree(dir, restrict);
  cleanStaleTemps(dir, now);
  return writePrivate(join(dir, tableFile(name)), text, rename);
}
