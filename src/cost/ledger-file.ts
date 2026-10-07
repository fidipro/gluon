/**
 * The ledger on disk (issue #39): one JSON line per entry in `<state dir>/gluon/cost-audit/`, one
 * file per Gluon process. The directory is private from the moment it exists (0700; icacls on
 * Windows), files 0600, a line is one `O_APPEND` write (two Gluon instances never share a file; a
 * crash leaves at most a partial last line, which a reader skips). Capped: a file stops at
 * `MAX_FILE_BYTES`, at most `MAX_FILES` files are kept, and a launch writes at most `MAX_PER_MINUTE`
 * entries a minute (an agent's processes can send status events: they can't fill the disk). A cap is
 * never silent: the first entry it refuses is followed by one `dropped` marker (counts only), and the
 * next minute's first write (or `close`, at quit) adds the rest of that minute's count; the last `MARKER_RESERVE` bytes of a
 * file are kept for markers, so a marker never overflows the size cap. An existing directory must be a
 * real directory of ours: a looser mode is fixed to 0700, a symlink or another user's is refused.
 * Counts and names only (`ledger.ts` `sanitize`); `cost.audit: off` (at launch) and `gluon uninstall`
 * remove it (`removeLedger`).
 */
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeSync, constants as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { restrictToUser } from "../secrets.ts";
import { pathFor, xdgBase } from "../xdg.ts";
import type { Harness } from "../harnesses.ts";
import { sanitize, type LedgerEntry } from "./ledger.ts";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES = 20;
export const MAX_PER_MINUTE = 600;
/** The end of a file kept for `dropped` markers: an entry never uses it. */
export const MARKER_RESERVE = 1024;

/** Gluon's state directory: `XDG_STATE_HOME/gluon` (an absolute one only), else `%LOCALAPPDATA%\gluon` on Windows, else `~/.local/state/gluon`. */
export function stateDir(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const p = pathFor(platform);
  const base = xdgBase(env.XDG_STATE_HOME, platform) || (platform === "win32" ? env.LOCALAPPDATA || p.join(home, "AppData", "Local") : p.join(home, ".local", "state"));
  return p.join(base, "gluon");
}

/** `<state dir>/cost-audit`. */
export function ledgerDir(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  return pathFor(platform).join(stateDir(env, platform, home), "cost-audit");
}

/** `<state dir>/openrouter-sessions`: the windows of Gluon's OpenRouter sessions on a key (`src/openrouter-billed.ts` `Registry`). */
export function registryDir(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  return pathFor(platform).join(stateDir(env, platform, home), "openrouter-sessions");
}

/**
 * Creates the directory (and its parents) private before anything is put in it. One that exists
 * already must be a real directory (not a symlink) of ours: POSIX mode 0700 is restored if it was
 * loosened; anything else throws (`openLedgerFile` then writes nothing).
 */
export function privateTree(dir: string, restrict: boolean): void {
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("the audit directory is not a real directory");
    if (process.platform === "win32") return;
    if (process.getuid !== undefined && st.uid !== process.getuid()) throw new Error("the audit directory is not ours");
    if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (restrict) restrictToUser(dir, true);
}

/** Keeps the newest `MAX_FILES - 1` files (the one about to be created is the last); returns how many it removed. */
function prune(dir: string): number {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const old = files.slice(0, Math.max(0, files.length - (MAX_FILES - 1)));
  for (const f of old) rmSync(join(dir, f), { force: true });
  return old.length;
}

type What = "cost" | "context" | "usage";
/** The figure an entry was for, for the `dropped` marker that stands for it. */
const whatOf = (e: LedgerEntry): What => (e.kind === "context" || (e.kind === "observation" && e.what === "context") ? "context" : e.kind === "observation" ? "cost" : "usage");
/** The harness a `dropped` marker is filed under: a table refresh at start belongs to none, and so does its marker. */
const harnessOf = (e: LedgerEntry): Harness | undefined => e.harness;

/** `write(entry)`, and `close()` at quit: adds what the rate cap refused since its marker, then writes nothing more. */
export type LedgerWriter = ((e: LedgerEntry) => void) & { close: () => void };

/** The writer for one process: `write(entry)` appends a line; never throws; a cap leaves one `dropped` marker, then silence. */
export function openLedgerFile(dir = ledgerDir(), { now = Date.now, pid = process.pid, restrict = process.platform === "win32" }: { now?: () => number; pid?: number; restrict?: boolean } = {}): LedgerWriter | null {
  try {
    privateTree(dir, restrict);
    let pruned = prune(dir);
    const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").slice(0, 15);
    const path = join(dir, `${stamp}-${pid}.jsonl`);
    const fd = openSync(path, fs.O_WRONLY | fs.O_CREAT | fs.O_APPEND | (fs.O_NOFOLLOW ?? 0), 0o600);
    let bytes = 0;
    let minute = 0;
    let inMinute = 0;
    /** What the per-minute cap refused after its marker was written (the next minute adds it). */
    let refused: { harness: Harness | undefined; what: What; count: number } | null = null;
    let sizeMarked = false;
    const put = (e: LedgerEntry, limit: number): boolean => {
      const line = `${JSON.stringify(e)}\n`;
      if (bytes + line.length > limit) return false;
      writeSync(fd, line);
      bytes += line.length;
      return true;
    };
    const marker = (harness: Harness | undefined, what: What, reason: string, count: number) => put({ kind: "dropped", t: now(), ...(harness ? { harness } : {}), what, reason, count }, MAX_FILE_BYTES);
    let closed = false;
    const write = (e: LedgerEntry) => {
      if (closed) return;
      try {
        const t = Math.floor(now() / 60_000);
        if (t !== minute) {
          [minute, inMinute] = [t, 0];
          if (refused && refused.count > 0) marker(refused.harness, refused.what, "rate-cap", refused.count);
          refused = null;
        }
        // Files the launch pruned (the oldest, past MAX_FILES) are a cap too.
        if (pruned) {
          marker(harnessOf(e), "usage", "files-pruned", pruned);
          pruned = 0;
        }
        if (++inMinute > MAX_PER_MINUTE) {
          if (!refused) {
            marker(harnessOf(e), whatOf(e), "rate-cap", 1);
            refused = { harness: harnessOf(e), what: whatOf(e), count: 0 };
          } else refused.count++;
          return;
        }
        if (!put(e, MAX_FILE_BYTES - MARKER_RESERVE) && !sizeMarked) {
          sizeMarked = true;
          marker(harnessOf(e), whatOf(e), "file-size-cap", 1);
        }
      } catch {}
    };
    // The count of a cap's last minute has no later write to carry it: it goes out here (a marker uses the reserve, never beyond the size cap).
    const close = () => {
      if (closed) return;
      try {
        if (refused && refused.count > 0) marker(refused.harness, refused.what, "rate-cap", refused.count);
        refused = null;
        closeSync(fd);
      } catch {}
      closed = true;
    };
    return Object.assign(write, { close });
  } catch {
    return null;
  }
}

/** Every entry of every ledger file in `dir`, oldest first; lines that aren't valid entries (a partial last line) are skipped. */
export function readLedger(dir = ledgerDir()): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return out;
  }
  for (const f of names) {
    let text = "";
    try {
      if (statSync(join(dir, f)).size > MAX_FILE_BYTES + 4096) continue;
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const e = sanitize(JSON.parse(line));
        if (e) out.push(e);
      } catch {}
    }
  }
  return out;
}

/**
 * `gluon uninstall` and `cost.audit: off` at launch: removes every ledger file and the directory.
 * A symlink planted at the path is unlinked, never followed (what it points to is not Gluon's).
 */
export function removeLedger(dir = ledgerDir()): void {
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(dir);
  else rmSync(dir, { recursive: true, force: true });
}
