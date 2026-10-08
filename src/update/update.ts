/**
 * Gluon's own updates: at start, in the background (`backgroundUpdate`, never before the first screen, at most one check of
 * GitHub a day), and `gluon update` in the foreground. `updates: auto` (the default) installs a new release by itself, `notify`
 * only says it exists, `off` checks nothing; `GLUON_UPDATES` wins over the config. Only a standalone binary replaces itself; the
 * npm package and a source checkout are told how to update. Nothing is installed unless the release's signature and checksum
 * verify (`verify.ts`).
 *
 * Tests reach no network: no source under `NODE_ENV=test`, a test build or the offline suite's probes seam, unless
 * `GLUON_TEST_UPDATE` names a loopback server (compiled out of release builds, like `GLUON_TEST_PRICING`).
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TrustedRoot } from "@sigstore/protobuf-specs";
import { UPDATE_MODES, type UpdateMode } from "../config.ts";
import { stateDir } from "../cost/ledger-file.ts";
import { BUILD, COMPILED } from "../detect.ts";
import { REPO_URL } from "../repo.ts";
import { removeStaged, replaceExecutable, stagedPath, sweepLeftovers, type VersionOf } from "./apply.ts";
import { downloadTo, fetchFile, latestVersion, newer, RELEASES, UpdateError, type ReleaseSource } from "./fetch.ts";
import { assetName, hostTarget, type Target } from "./target.ts";
import { expectedHash, sigstoreRoot, verifySignature } from "./verify.ts";

/** The mode in force: `GLUON_UPDATES` (one of `UPDATE_MODES`) wins over the config's `updates`. */
export function updateMode(configured: UpdateMode, env: Record<string, string | undefined> = process.env): UpdateMode {
  const v = env.GLUON_UPDATES?.trim().toLowerCase();
  return (UPDATE_MODES as readonly string[]).includes(v ?? "") ? (v as UpdateMode) : configured;
}

/** Between two checks of GitHub at start. */
export const CHECK_EVERY_MS = 24 * 3_600_000;
/** A lock older than this is a crashed update's. */
const STALE_LOCK_MS = 30 * 60_000;

declare const GLUON_BUILD: string | undefined;
const seamPath = (env: Record<string, string | undefined>): string | undefined => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? undefined : env.GLUON_TEST_UPDATE);
const probesPath = (env: Record<string, string | undefined>): string | undefined => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? undefined : env.GLUON_TEST_PROBES);

/** Where releases come from, and what a test may change about installing one. */
export interface UpdateSource {
  releases: ReleaseSource;
  /** Test seam: Sigstore's trusted root from this file, not TUF. */
  trustedRoot?: string;
  /** Test seam: no signature check (a fake release has none). */
  unsigned?: boolean;
  /** Test seam: the executable to replace, in place of this one (from source too). */
  exe?: string;
  /** Test seam: the release target to download. */
  target?: Target;
}

/**
 * The real releases, a test's loopback server, or null: no network at all. The seam (`GLUON_TEST_UPDATE`) is a JSON file
 * `{ "base": "http://127.0.0.1:<port>/releases", "trustedRoot"?, "unsigned"?, "exe"?, "target"? }`, loopback http only. Fails closed.
 */
export function updateSource(env: Record<string, string | undefined> = process.env): UpdateSource | null {
  const path = seamPath(env);
  if (path) {
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const base = new URL(String(j.base));
      if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) return null;
      return {
        releases: { base: String(j.base).replace(/\/+$/, ""), hosts: new Set() },
        ...(typeof j.trustedRoot === "string" ? { trustedRoot: j.trustedRoot } : {}),
        ...(j.unsigned === true ? { unsigned: true } : {}),
        ...(typeof j.exe === "string" ? { exe: j.exe } : {}),
        ...(typeof j.target === "string" ? { target: j.target as Target } : {}),
      };
    } catch {
      return null;
    }
  }
  const release = typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test";
  if ((typeof GLUON_BUILD === "string" && GLUON_BUILD === "test") || probesPath(env) || (!release && env.NODE_ENV === "test")) return null;
  return { releases: RELEASES };
}

/** The executable an update replaces, or null when this Gluon isn't one (the npm package, a source checkout). */
export const updatableExe = (src: UpdateSource): string | null => src.exe ?? (COMPILED ? process.execPath : null);

/** How to update by hand where Gluon can't replace itself. */
export function manualUpdate(version: string): string {
  if (BUILD === "npm") return `download gluon-${version}.tgz from ${REPO_URL}/releases/tag/v${version} and run: bun add -g "$PWD/gluon-${version}.tgz"`;
  return "this Gluon runs from source: pull the new version (git pull, then bun install)";
}

// ---- what the last check found (`<state dir>/update.json`) ----

export interface UpdateState {
  checkedAt?: string;
  latest?: string;
  /** The version an automatic update last failed to install, and why: it is not tried again before the next check. */
  failed?: { version: string; error: string };
}

export const statePath = (dir = stateDir()): string => join(dir, "update.json");

export function readState(dir = stateDir()): UpdateState {
  try {
    const j = JSON.parse(readFileSync(statePath(dir), "utf8")) as UpdateState;
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** Writes the state (a temp file renamed into place); a failure is ignored (the next start checks again). */
export function writeState(state: UpdateState, dir = stateDir()): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${statePath(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tmp, statePath(dir));
  } catch {}
}

/** Takes the update lock (`<state dir>/update.lock`); its release, or null when another Gluon is updating. */
export function takeLock(dir = stateDir(), now = Date.now()): (() => void) | null {
  const path = join(dir, "update.lock");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < 2; i++) {
      try {
        closeSync(openSync(path, "wx", 0o600));
        return () => rmSync(path, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || now - statSync(path).mtimeMs < STALE_LOCK_MS) return null;
        rmSync(path, { force: true });
      }
    }
  } catch {}
  return null;
}

// ---- installing a release ----

export interface InstallDeps {
  /** Sigstore's trusted root (default: the seam's file, else TUF cached in the state dir). */
  root?: () => Promise<TrustedRoot>;
  versionOf?: VersionOf;
  log?: (line: string) => void;
  dir?: string;
}

async function rootFor(src: UpdateSource, dir: string): Promise<TrustedRoot> {
  if (src.trustedRoot) {
    const { TrustedRoot } = await import("@sigstore/protobuf-specs");
    return TrustedRoot.fromJSON(JSON.parse(readFileSync(src.trustedRoot, "utf8")));
  }
  return sigstoreRoot(join(dir, "tuf"));
}

/** Downloads `version`, verifies it and puts it in place of `exe`; throws an `UpdateError` (with `exe` unchanged) otherwise. */
export async function installRelease(version: string, src: UpdateSource, exe: string, deps: InstallDeps = {}): Promise<void> {
  const log = deps.log ?? (() => {});
  const dir = deps.dir ?? stateDir();
  const target = src.target ?? hostTarget();
  if (!target) throw new UpdateError(`no release is built for ${process.platform}-${process.arch}`);
  const sums = await fetchFile(src.releases, version, "SHA256SUMS");
  if (!src.unsigned) {
    let bundle: unknown;
    try {
      bundle = JSON.parse((await fetchFile(src.releases, version, "SHA256SUMS.sigstore.json")).toString("utf8"));
    } catch (e) {
      throw e instanceof UpdateError ? e : new UpdateError("the release's signature file isn't JSON");
    }
    verifySignature(sums, bundle, await (deps.root ?? (() => rootFor(src, dir)))());
    log(`Signature verified: SHA256SUMS was signed by ${REPO_URL}'s release workflow on main.`);
  }
  const name = assetName(target);
  const want = expectedHash(sums.toString("utf8"), name);
  if (!want) throw new UpdateError(`SHA256SUMS lists no ${name}`);
  const staged = stagedPath(exe);
  try {
    log(`Downloading ${name}…`);
    let got: string;
    try {
      got = await downloadTo(src.releases, version, name, staged);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A binary in a directory that isn't the user's (a system-wide install): Gluon never asks for more rights.
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw new UpdateError(`can't write in ${dirname(exe)} (${code}): install the new version with ${process.platform === "win32" ? "install.ps1" : "install.sh"} instead (see the install guide)`);
      throw e;
    }
    if (got !== want) throw new UpdateError(`${name} doesn't match SHA256SUMS (got ${got}, expected ${want})`);
    log("Checksum verified.");
    await replaceExecutable({ exe, staged, version, ...(deps.versionOf ? { versionOf: deps.versionOf } : {}) });
  } finally {
    removeStaged(staged);
  }
}

// ---- at start ----

export interface BackgroundOptions {
  mode: UpdateMode;
  /** The demo makes no network call by design: none, unless a test build names its server (`GLUON_TEST_UPDATE`, as `refreshAllowed`). */
  demo?: boolean;
  current: string;
  /** Says something in the chat. */
  notice: (text: string) => void;
  env?: Record<string, string | undefined>;
  now?: () => number;
  dir?: string;
  deps?: InstallDeps;
}

const available = (latest: string, current: string) => `Gluon ${latest} is available (you have ${current})`;

/** The start's update: a check at most once a day, then a notice or, with `auto`, the install. Never throws, never waits on anything. */
export async function backgroundUpdate(o: BackgroundOptions): Promise<void> {
  try {
    if (o.mode === "off" || (o.demo && seamPath(o.env ?? process.env) === undefined)) return;
    const src = updateSource(o.env);
    if (!src) return;
    const now = (o.now ?? Date.now)();
    const dir = o.dir ?? stateDir();
    const exe = updatableExe(src);
    if (exe) sweepLeftovers(exe, now);
    const state = readState(dir);
    const due = !state.checkedAt || !(now - Date.parse(state.checkedAt) < CHECK_EVERY_MS);
    let latest = state.latest;
    let failed = state.failed;
    if (due) {
      try {
        latest = await latestVersion(src.releases);
        failed = undefined;
      } catch {
        // Offline or GitHub unreachable: quiet; the next start tries again.
        return;
      }
      writeState({ checkedAt: new Date(now).toISOString(), latest }, dir);
    }
    if (!latest || !newer(latest, o.current)) return;
    if (o.mode === "notify") return o.notice(`${available(latest, o.current)}: run gluon update to install it.`);
    if (!exe) return o.notice(`${available(latest, o.current)}: ${manualUpdate(latest)}.`);
    if (failed?.version === latest) return o.notice(`${available(latest, o.current)}, but installing it automatically failed: ${failed.error}. Run gluon update to try again.`);
    const unlock = takeLock(dir);
    if (!unlock) return;
    try {
      await installRelease(latest, src, exe, { ...o.deps, dir });
      o.notice(`Gluon ${latest} is installed: it starts the next time you open Gluon (this one stays ${o.current}).`);
    } catch (e) {
      const error = e instanceof UpdateError ? e.message : String(e);
      writeState({ ...readState(dir), failed: { version: latest, error } }, dir);
      o.notice(`${available(latest, o.current)}, but installing it automatically failed: ${error}. Run gluon update to try again.`);
    } finally {
      unlock();
    }
  } catch {}
}

// ---- `gluon update` ----

export const UPDATE_HELP = `gluon update [--check]

Installs the latest Gluon release in place of this one, after checking its Sigstore signature (made by
${REPO_URL}'s release workflow on main) and its SHA-256. Gluons already running keep their version
until you restart them.

  --check   only say whether a newer release exists

Gluon also does this by itself at start (at most one check a day): the config key \`updates\` is
auto (install), notify (only say) or off; GLUON_UPDATES=auto|notify|off wins over it.`;

export interface CommandOptions {
  current: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  dir?: string;
  deps?: InstallDeps;
}

/** Runs `gluon update [--check]`; returns the exit code. */
export async function updateCommand(args: string[], o: CommandOptions): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  const error = o.error ?? ((l: string) => console.error(l));
  if (args.some((a) => a === "--help" || a === "-h")) {
    log(UPDATE_HELP);
    return 0;
  }
  if (args.some((a) => a !== "--check")) {
    error("gluon: update takes only --check: gluon update [--check]");
    return 2;
  }
  const check = args.includes("--check");
  const src = updateSource(o.env);
  if (!src) {
    error("gluon: this run reaches no network (a test): nothing to check");
    return 1;
  }
  const dir = o.dir ?? stateDir();
  try {
    const latest = await latestVersion(src.releases);
    writeState({ checkedAt: new Date().toISOString(), latest }, dir);
    if (!newer(latest, o.current)) {
      log(`Gluon ${o.current} is up to date (the latest release is ${latest}).`);
      return 0;
    }
    log(`${available(latest, o.current)}.`);
    if (check) {
      log("Run gluon update to install it.");
      return 0;
    }
    const exe = updatableExe(src);
    if (!exe) {
      log(`To update, ${manualUpdate(latest)}.`);
      return 1;
    }
    const unlock = takeLock(dir);
    if (!unlock) {
      error("gluon: another Gluon is installing an update right now; try again in a minute");
      return 1;
    }
    try {
      await installRelease(latest, src, exe, { ...o.deps, dir, log });
    } finally {
      unlock();
    }
    log(`Installed Gluon ${latest} at ${exe}. Gluons already running stay ${o.current} until you restart them.`);
    return 0;
  } catch (e) {
    error(`gluon: update failed: ${e instanceof UpdateError ? e.message : String(e)}. Nothing was changed.`);
    return 1;
  }
}
