/**
 * The harness versions the tests run on, and a cache of their release binaries (issue #31).
 *
 * `test/harnesses.json` (the pin) names, per harness, a version and, per host, the vendor's release file and its hash.
 * `bun scripts/harness-pin.ts --bump` writes it from the vendors' own sources; nothing else does. The fakes report the
 * pinned versions (`test/fixtures/harness-versions.ts`), the live checks run the pinned binaries (`harnessBin`), and `--newest` runs the
 * newest release instead (before a merge and before a release).
 *
 * A binary is the vendor's release file itself, checked against its hash before anything is written: an npm
 * package's tarball (Claude Code, Codex, OpenCode: the registry's `integrity`), a manifest's file (Antigravity, Kimi
 * Code: the manifest's hash) or Grok Build's binary (no hash published: the one `--bump` saw, reviewed in its PR).
 * No vendor install script or postinstall step ever runs. Research code: never imported by src/.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Harness } from "../src/harnesses.ts";

export const HARNESS_IDS = ["claude-code", "codex", "antigravity", "grok-build", "opencode", "kimi-code"] as const satisfies readonly Harness[];

/** The hosts a pin carries files for: CI's three runners and the arm64/x64 halves of each. */
export const HOSTS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"] as const;
export type Host = (typeof HOSTS)[number];

/** One release file: where it is, its hash (hex), and the binary's path inside it when it's a tarball. */
export interface HarnessFile {
  url: string;
  sha512?: string;
  sha256?: string;
  /** The binary's path inside the `.tgz` / `.tar.gz`; absent when the file is the binary itself. */
  bin?: string;
}

export interface PinEntry {
  version: string;
  files: Partial<Record<Host, HarnessFile>>;
}

export type Pin = Record<Harness, PinEntry>;

export const PIN_PATH = join(import.meta.dir, "..", "test", "harnesses.json");

export function readPin(path = PIN_PATH): Pin {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const pin = {} as Pin;
  for (const h of HARNESS_IDS) {
    const e = raw[h] as PinEntry | undefined;
    if (!e || typeof e.version !== "string" || typeof e.files !== "object") throw new Error(`${path}: no entry for ${h}`);
    pin[h] = e;
  }
  return pin;
}

export function writePin(pin: Pin, path = PIN_PATH): void {
  const out: Record<string, unknown> = { "//": "Written by `bun scripts/harness-pin.ts --bump`, never by hand (scripts/harness-cache.ts)." };
  for (const h of HARNESS_IDS) out[h] = pin[h];
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
}

/** This machine's host, or null when no pin has files for it (musl, Windows on arm). */
export function hostOf(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Host | null {
  const h = `${platform}-${arch}`;
  return (HOSTS as readonly string[]).includes(h) ? (h as Host) : null;
}

// ——— the vendors' sources ———

/** A GET; tests pass their own (no network in the suite). */
export type Get = (url: string) => Promise<Response>;

const defaultGet: Get = (url) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });

async function getOk(get: Get, url: string): Promise<Response> {
  const r = await get(url);
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  return r;
}
const getJson = async <T>(get: Get, url: string) => (await (await getOk(get, url)).json()) as T;
const getText = async (get: Get, url: string) => (await (await getOk(get, url)).text()).trim();

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
function checkVersion(h: Harness, v: string): string {
  if (!VERSION_RE.test(v)) throw new Error(`${h}: not a version: ${JSON.stringify(v.slice(0, 40))}`);
  return v;
}

/** npm's `sha512-<base64>` as hex. */
export function integrityHex(integrity: string): string {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!m) throw new Error(`not an npm sha512 integrity: ${integrity.slice(0, 30)}`);
  return Buffer.from(m[1]!, "base64").toString("hex");
}

type NpmVersion = { version: string; dist: { tarball: string; integrity: string } };
const npmUrl = (pkg: string, version: string) => `https://registry.npmjs.org/${pkg}/${version}`;

/** One npm platform package per host: its package spec (name, version) and the binary inside. */
async function npmFiles(get: Get, specs: Partial<Record<Host, { pkg: string; version: string; bin: string }>>): Promise<PinEntry["files"]> {
  const files: PinEntry["files"] = {};
  for (const host of HOSTS) {
    const s = specs[host];
    if (!s) continue;
    const meta = await getJson<NpmVersion>(get, npmUrl(s.pkg, s.version));
    files[host] = { url: meta.dist.tarball, sha512: integrityHex(meta.dist.integrity), bin: s.bin };
  }
  return files;
}

const CODEX_TRIPLE: Record<Host, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const exe = (host: Host) => (host.startsWith("win32") ? ".exe" : "");
const AGY_PLATFORM: Record<Host, string> = { "linux-x64": "linux_amd64", "linux-arm64": "linux_arm64", "darwin-x64": "darwin_amd64", "darwin-arm64": "darwin_arm64", "win32-x64": "windows_amd64" };
const GROK_PLATFORM: Record<Host, string> = { "linux-x64": "linux-x86_64", "linux-arm64": "linux-aarch64", "darwin-x64": "macos-x86_64", "darwin-arm64": "macos-aarch64", "win32-x64": "windows-x86_64" };
const AGY_MANIFESTS = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const KIMI_BASE = "https://code.kimi.com/kimi-code";

async function sha256Of(get: Get, url: string): Promise<string | null> {
  const r = await get(url);
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  return new Bun.CryptoHasher("sha256").update(await r.arrayBuffer()).digest("hex");
}

/** Each harness's newest release, read from where its vendor publishes it (the table in issue #31). */
export const SOURCES: Record<Harness, (get: Get, hosts: readonly Host[]) => Promise<PinEntry>> = {
  "claude-code": async (get, hosts) => {
    const v = checkVersion("claude-code", (await getJson<NpmVersion>(get, npmUrl("@anthropic-ai/claude-code", "latest"))).version);
    const spec = (host: Host) => ({ pkg: `@anthropic-ai/claude-code-${host}`, version: v, bin: `package/claude${exe(host)}` });
    return { version: v, files: await npmFiles(get, Object.fromEntries(hosts.map((h) => [h, spec(h)]))) };
  },
  codex: async (get, hosts) => {
    const v = checkVersion("codex", (await getJson<NpmVersion>(get, npmUrl("@openai/codex", "latest"))).version);
    const spec = (host: Host) => ({ pkg: "@openai/codex", version: `${v}-${host}`, bin: `package/vendor/${CODEX_TRIPLE[host]}/bin/codex${exe(host)}` });
    return { version: v, files: await npmFiles(get, Object.fromEntries(hosts.map((h) => [h, spec(h)]))) };
  },
  opencode: async (get, hosts) => {
    const v = checkVersion("opencode", (await getJson<NpmVersion>(get, npmUrl("@opencode/cli", "latest"))).version);
    const spec = (host: Host) => ({ pkg: `@opencode/cli-${host.replace("win32", "windows")}`, version: v, bin: `package/bin/opencode${exe(host)}` });
    return { version: v, files: await npmFiles(get, Object.fromEntries(hosts.map((h) => [h, spec(h)]))) };
  },
  antigravity: async (get, hosts) => {
    let version = "";
    const files: PinEntry["files"] = {};
    // The version is only in the manifests: with no host asked for, one is read for it alone.
    for (const host of hosts.length ? hosts : (["linux-x64"] as const)) {
      const m = await getJson<{ version: string; url: string; sha512: string }>(get, `${AGY_MANIFESTS}/${AGY_PLATFORM[host]}.json`);
      checkVersion("antigravity", m.version);
      if (version && m.version !== version) throw new Error(`antigravity: manifests disagree (${version}, ${m.version}): try again later`);
      version = m.version;
      if (!/^[0-9a-f]{128}$/.test(m.sha512)) throw new Error(`antigravity: bad sha512 for ${host}`);
      if (hosts.includes(host)) files[host] = { url: m.url, sha512: m.sha512, ...(m.url.endsWith(".tar.gz") ? { bin: "antigravity" } : {}) };
    }
    return { version, files };
  },
  "grok-build": async (get, hosts) => {
    const v = checkVersion("grok-build", await getText(get, "https://x.ai/cli/stable"));
    const files: PinEntry["files"] = {};
    for (const host of hosts) {
      const url = `https://x.ai/cli/grok-${v}-${GROK_PLATFORM[host]}${exe(host)}`;
      const sha256 = await sha256Of(get, url);
      if (sha256) files[host] = { url, sha256 };
    }
    return { version: v, files };
  },
  "kimi-code": async (get, hosts) => {
    const v = checkVersion("kimi-code", await getText(get, `${KIMI_BASE}/latest`));
    const m = await getJson<{ version: string; platforms: Record<string, { filename: string; checksum: string }> }>(get, `${KIMI_BASE}/binaries/${v}/manifest.json`);
    if (m.version !== v) throw new Error(`kimi-code: manifest says ${m.version}, latest says ${v}`);
    const files: PinEntry["files"] = {};
    for (const host of hosts) {
      const p = m.platforms[host];
      if (!p) continue;
      if (!/^[0-9a-f]{64}$/.test(p.checksum) || !/^[\w.-]+$/.test(p.filename)) throw new Error(`kimi-code: bad manifest entry for ${host}`);
      files[host] = { url: `${KIMI_BASE}/binaries/${v}/${p.filename}`, sha256: p.checksum };
    }
    return { version: v, files };
  },
};

/** The newest release of each harness asked for (all by default), with files for `hosts` (all by default). */
export async function resolveNewest(harnesses: readonly Harness[] = HARNESS_IDS, get: Get = defaultGet, hosts: readonly Host[] = HOSTS): Promise<Partial<Pin>> {
  const out: Partial<Pin> = {};
  for (const h of harnesses) out[h] = await SOURCES[h](get, hosts);
  return out;
}

// ——— the cache ———

/** Where binaries are kept: `GLUON_HARNESS_CACHE`, else the user's cache directory. Never inside the repository. */
export function cacheDir(env: Record<string, string | undefined> = process.env): string {
  if (env.GLUON_HARNESS_CACHE) return env.GLUON_HARNESS_CACHE;
  const base = process.platform === "win32" ? env.LOCALAPPDATA || join(homedir(), "AppData", "Local") : env.XDG_CACHE_HOME?.startsWith("/") ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(base, "gluon-test", "harness");
}

/** Whether `bytes` match the file's hash; the hash it should have had otherwise. */
export function checkHash(file: HarnessFile, bytes: Uint8Array): string | null {
  const [algo, want] = file.sha512 ? (["sha512", file.sha512] as const) : file.sha256 ? (["sha256", file.sha256] as const) : [null, null];
  if (!algo) return "no hash in the pin";
  const got = new Bun.CryptoHasher(algo).update(bytes).digest("hex");
  return got === want.toLowerCase() ? null : `${algo} mismatch: expected ${want.slice(0, 16)}…, got ${got.slice(0, 16)}…`;
}

/** Where a harness version's binary lives in the cache (whether or not it's there yet). */
export function cachedPath(h: Harness, version: string, file: HarnessFile, host: Host, cache = cacheDir()): string {
  const dir = join(cache, h, version, host);
  return file.bin ? join(dir, ...file.bin.split("/")) : join(dir, `${binaryName(h)}${exe(host)}`);
}

const BINARY: Record<Harness, string> = { "claude-code": "claude", codex: "codex", antigravity: "agy", "grok-build": "grok", opencode: "opencode", "kimi-code": "kimi" };
export const binaryName = (h: Harness): string => BINARY[h];

const DONE = ".verified";

/** The binary when it's already installed and verified (no network), else null. */
export function cachedBin(h: Harness, entry: PinEntry, host: Host | null = hostOf(), cache = cacheDir()): string | null {
  const file = host ? entry.files[host] : undefined;
  if (!host || !file) return null;
  const bin = cachedPath(h, entry.version, file, host, cache);
  return existsSync(join(cache, h, entry.version, host, DONE)) && existsSync(bin) ? bin : null;
}

/**
 * The harness's binary for this host, downloaded and verified into the cache unless it's there already. A download that
 * fails its hash writes nothing. Returns the binary's path.
 */
export async function install(h: Harness, entry: PinEntry, o: { host?: Host | null; cache?: string; get?: Get; log?: (s: string) => void } = {}): Promise<string> {
  const host = o.host === undefined ? hostOf() : o.host;
  if (!host) throw new Error(`no ${h} release for ${process.platform}-${process.arch} in the pin`);
  const file = entry.files[host];
  if (!file) throw new Error(`${h} ${entry.version} has no release for ${host}`);
  const cache = o.cache ?? cacheDir();
  const dir = join(cache, h, entry.version, host);
  const bin = cachedPath(h, entry.version, file, host, cache);
  if (existsSync(join(dir, DONE)) && existsSync(bin)) return bin;
  o.log?.(`downloading ${h} ${entry.version} (${host}) from ${new URL(file.url).host}`);
  const bytes = new Uint8Array(await (await getOk(o.get ?? defaultGet, file.url)).arrayBuffer());
  const bad = checkHash(file, bytes);
  if (bad) throw new Error(`${h} ${entry.version}: ${file.url}: ${bad}; nothing written`);
  const tmp = `${dir}.part-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    if (file.bin) await new Bun.Archive(bytes).extract(tmp);
    else writeFileSync(join(tmp, basename(bin)), bytes);
    const inTmp = join(tmp, bin.slice(dir.length + 1));
    if (!existsSync(inTmp)) throw new Error(`${h} ${entry.version}: ${file.bin} is not in ${file.url}`);
    chmodSync(inTmp, 0o755);
    writeFileSync(join(tmp, DONE), `${file.url}\n`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(tmp, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return bin;
}

/** The binary a test runs for `h`: the pinned version's, or with `newest` the newest release's; installed when missing. */
export async function harnessBin(h: Harness, o: { newest?: boolean; pin?: Pin; cache?: string; get?: Get; log?: (s: string) => void } = {}): Promise<{ path: string; version: string }> {
  const host = hostOf();
  const entry = o.newest ? (await resolveNewest([h], o.get, host ? [host] : []))[h]! : (o.pin ?? readPin())[h];
  return { path: await install(h, entry, o), version: entry.version };
}
