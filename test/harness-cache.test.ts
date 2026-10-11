/**
 * The harness pin and its binary cache (scripts/harness-cache.ts, issue #31): the pin is complete and never behind
 * Gluon's own minimums, the fakes claim its versions, each vendor's source is read right, and a binary is installed
 * only when its hash matches. Offline: every GET is answered here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, versionAtLeast } from "../src/adapters/index.ts";
import { cacheDir, checkHash, HARNESS_IDS, HOSTS, install, integrityHex, readPin, SOURCES, type Get, type PinEntry } from "../scripts/harness-cache.ts";
import { FAKE_VERSIONS, PINNED } from "./fixtures/harness-versions.ts";

const POSIX = process.platform !== "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "harness-cache-"));
const hex = (algo: "sha256" | "sha512", b: Uint8Array | string) => new Bun.CryptoHasher(algo).update(b).digest("hex");

/** A GET that serves `routes` (url → body or status) and records what was asked. */
function server(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const get: Get = async (url) => {
    asked.push(url);
    const r = routes[url];
    if (r === undefined) return new Response("not found", { status: 404 });
    if (typeof r === "number") return new Response("", { status: r });
    if (r instanceof Uint8Array || typeof r === "string") return new Response(r);
    return Response.json(r);
  };
  return { get, asked };
}

describe("the pin (test/harnesses.json)", () => {
  const pin = readPin();
  const VENDOR_HOSTS = new Set(["registry.npmjs.org", "storage.googleapis.com", "x.ai", "code.kimi.com"]);

  test("every harness, every host: an https file on its vendor's host with a hash", () => {
    for (const h of HARNESS_IDS) {
      for (const host of HOSTS) {
        const f = pin[h].files[host];
        expect([h, host, !!f]).toEqual([h, host, true]);
        const u = new URL(f!.url);
        expect([h, host, u.protocol, VENDOR_HOSTS.has(u.hostname)]).toEqual([h, host, "https:", true]);
        expect([h, host, /^[0-9a-f]{128}$/.test(f!.sha512 ?? "") || /^[0-9a-f]{64}$/.test(f!.sha256 ?? "")]).toEqual([h, host, true]);
      }
    }
  });

  test("no pinned version is older than the adapter's minimum (a fake below it gets no adapter: codex 0.158 < 0.159)", () => {
    for (const h of HARNESS_IDS) {
      const min = ADAPTERS[h].minVersion;
      if (min) expect([h, pin[h].version, versionAtLeast(pin[h].version, min)]).toEqual([h, pin[h].version, true]);
    }
  });

  test("the fakes claim the pinned versions", () => {
    expect(PINNED).toEqual({ claude: pin["claude-code"].version, codex: pin.codex.version, agy: pin.antigravity.version, grok: pin["grok-build"].version, opencode: pin.opencode.version, kimi: pin["kimi-code"].version });
    for (const [name, line] of Object.entries(FAKE_VERSIONS)) expect([name, line.includes(PINNED[name as keyof typeof PINNED])]).toEqual([name, true]);
  });
});

describe("the vendors' sources", () => {
  test("npm (Claude Code): latest, then each host's platform package, its integrity as hex", async () => {
    const integrity = `sha512-${Buffer.from(hex("sha512", "x"), "hex").toString("base64")}`;
    const routes: Record<string, unknown> = { "https://registry.npmjs.org/@anthropic-ai/claude-code/latest": { version: "2.2.0", dist: { tarball: "-", integrity } } };
    for (const h of HOSTS) routes[`https://registry.npmjs.org/@anthropic-ai/claude-code-${h}/2.2.0`] = { version: "2.2.0", dist: { tarball: `https://registry.npmjs.org/t/${h}.tgz`, integrity } };
    const e = await SOURCES["claude-code"](server(routes).get, HOSTS);
    expect(e.version).toBe("2.2.0");
    expect(e.files["win32-x64"]).toEqual({ url: "https://registry.npmjs.org/t/win32-x64.tgz", sha512: hex("sha512", "x"), bin: "package/claude.exe" });
    expect(e.files["linux-x64"]!.bin).toBe("package/claude");
  });

  test("Codex: one package, a version per host; the binary under its target triple", async () => {
    const integrity = `sha512-${Buffer.from(hex("sha512", "c"), "hex").toString("base64")}`;
    const routes: Record<string, unknown> = { "https://registry.npmjs.org/@openai/codex/latest": { version: "0.170.0", dist: { tarball: "-", integrity } } };
    routes["https://registry.npmjs.org/@openai/codex/0.170.0-darwin-arm64"] = { version: "0.170.0-darwin-arm64", dist: { tarball: "https://registry.npmjs.org/c.tgz", integrity } };
    const e = await SOURCES.codex(server(routes).get, ["darwin-arm64"]);
    expect(e.files).toEqual({ "darwin-arm64": { url: "https://registry.npmjs.org/c.tgz", sha512: hex("sha512", "c"), bin: "package/vendor/aarch64-apple-darwin/bin/codex" } });
  });

  test("Antigravity: one manifest per host; manifests that disagree (a release half out) are an error, not a mixed pin", async () => {
    const M = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
    const ok = { version: "1.4.0", url: "https://storage.googleapis.com/a/cli.tar.gz", sha512: hex("sha512", "a") };
    const e = await SOURCES.antigravity(server({ [`${M}/linux_amd64.json`]: ok, [`${M}/windows_amd64.json`]: { ...ok, url: "https://storage.googleapis.com/a/cli.exe" } }).get, ["linux-x64", "win32-x64"]);
    expect(e.files["linux-x64"]).toEqual({ url: ok.url, sha512: ok.sha512, bin: "antigravity" });
    expect(e.files["win32-x64"]).toEqual({ url: "https://storage.googleapis.com/a/cli.exe", sha512: ok.sha512 });
    await expect(SOURCES.antigravity(server({ [`${M}/linux_amd64.json`]: ok, [`${M}/darwin_arm64.json`]: { ...ok, version: "1.3.9" } }).get, ["linux-x64", "darwin-arm64"])).rejects.toThrow(/disagree/);
    // Asked for the version alone (`--check`): one manifest read for it, no files.
    expect(await SOURCES.antigravity(server({ [`${M}/linux_amd64.json`]: ok }).get, [])).toEqual({ version: "1.4.0", files: {} });
  });

  test("Grok Build: the stable channel's version; no published hash, so the bytes it served are hashed; a host it has no build for is left out", async () => {
    const bin = new Uint8Array([1, 2, 3]);
    const { get } = server({ "https://x.ai/cli/stable": "1.1.0\n", "https://x.ai/cli/grok-1.1.0-linux-x86_64": bin });
    const e = await SOURCES["grok-build"](get, ["linux-x64", "darwin-x64"]);
    expect(e).toEqual({ version: "1.1.0", files: { "linux-x64": { url: "https://x.ai/cli/grok-1.1.0-linux-x86_64", sha256: hex("sha256", bin) } } });
  });

  test("Kimi Code: latest, then that version's manifest; a manifest for another version is an error", async () => {
    const K = "https://code.kimi.com/kimi-code";
    const manifest = { version: "2.2.0", platforms: { "linux-x64": { filename: "kimi-code-linux-x64", checksum: hex("sha256", "k") } } };
    const e = await SOURCES["kimi-code"](server({ [`${K}/latest`]: "2.2.0", [`${K}/binaries/2.2.0/manifest.json`]: manifest }).get, ["linux-x64", "win32-x64"]);
    expect(e.files).toEqual({ "linux-x64": { url: `${K}/binaries/2.2.0/kimi-code-linux-x64`, sha256: hex("sha256", "k") } });
    await expect(SOURCES["kimi-code"](server({ [`${K}/latest`]: "2.2.1", [`${K}/binaries/2.2.1/manifest.json`]: manifest }).get, ["linux-x64"])).rejects.toThrow(/manifest says 2\.2\.0/);
  });

  test("a version that isn't one (an error page, a redirect body) is refused", async () => {
    await expect(SOURCES["grok-build"](server({ "https://x.ai/cli/stable": "<html>302 Found</html>" }).get, [])).rejects.toThrow(/not a version/);
  });

  test("npm's integrity is read as hex; anything but sha512 is refused", () => {
    expect(integrityHex(`sha512-${Buffer.from("ab", "hex").toString("base64")}`)).toBe("ab");
    expect(() => integrityHex("sha1-abc=")).toThrow(/sha512/);
  });
});

describe("install: verified first, then written", () => {
  const tgz = async (files: Record<string, string>) => new Bun.Archive(files, { compress: "gzip" }).bytes();

  test("a tarball whose hash matches: extracted, the binary executable, marked done; a second install downloads nothing", async () => {
    const bytes = await tgz({ "package/bin/opencode": "#!/bin/sh\necho 9.9.9\n", "package/package.json": "{}" });
    const entry: PinEntry = { version: "9.9.9", files: { "linux-x64": { url: "https://registry.npmjs.org/o.tgz", sha512: hex("sha512", bytes), bin: "package/bin/opencode" } } };
    const cache = tmp();
    const s = server({ "https://registry.npmjs.org/o.tgz": bytes });
    const bin = await install("opencode", entry, { host: "linux-x64", cache, get: s.get });
    expect(bin).toBe(join(cache, "opencode", "9.9.9", "linux-x64", "package", "bin", "opencode"));
    if (POSIX) expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(await install("opencode", entry, { host: "linux-x64", cache, get: s.get })).toBe(bin);
    expect(s.asked).toEqual(["https://registry.npmjs.org/o.tgz"]);
  });

  test("a bare binary is written under the harness's own name", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const entry: PinEntry = { version: "1.0.0", files: { "win32-x64": { url: "https://x.ai/g", sha256: hex("sha256", bytes) } } };
    const cache = tmp();
    expect(await install("grok-build", entry, { host: "win32-x64", cache, get: server({ "https://x.ai/g": bytes }).get })).toBe(join(cache, "grok-build", "1.0.0", "win32-x64", "grok.exe"));
  });

  test("a hash that doesn't match: an error, and nothing in the cache", async () => {
    const entry: PinEntry = { version: "1.0.0", files: { "linux-x64": { url: "https://code.kimi.com/k", sha256: hex("sha256", "good") } } };
    const cache = tmp();
    await expect(install("kimi-code", entry, { host: "linux-x64", cache, get: server({ "https://code.kimi.com/k": "evil" }).get })).rejects.toThrow(/sha256 mismatch.*nothing written/);
    expect(existsSync(join(cache, "kimi-code")) ? readdirSync(join(cache, "kimi-code")) : []).toEqual([]);
  });

  test("a tarball without the named binary: an error, nothing kept", async () => {
    const bytes = await tgz({ "package/README.md": "x" });
    const entry: PinEntry = { version: "1.0.0", files: { "linux-x64": { url: "https://registry.npmjs.org/c.tgz", sha512: hex("sha512", bytes), bin: "package/claude" } } };
    const cache = tmp();
    await expect(install("claude-code", entry, { host: "linux-x64", cache, get: server({ "https://registry.npmjs.org/c.tgz": bytes }).get })).rejects.toThrow(/package\/claude is not in/);
    expect(existsSync(join(cache, "claude-code", "1.0.0", "linux-x64"))).toBe(false);
  });

  test("a host the pin has no file for, and a file with no hash, are errors", async () => {
    await expect(install("codex", { version: "1.0.0", files: {} }, { host: "linux-arm64", cache: tmp() })).rejects.toThrow(/no release for linux-arm64/);
    expect(checkHash({ url: "https://x.ai/g" }, new Uint8Array())).toBe("no hash in the pin");
  });

  test("the cache lives outside the repository: GLUON_HARNESS_CACHE, else the user's cache directory", () => {
    expect(cacheDir({ GLUON_HARNESS_CACHE: "/c" })).toBe("/c");
    if (POSIX) expect(cacheDir({ XDG_CACHE_HOME: "/xdg" })).toBe(join("/xdg", "gluon-test", "harness"));
    if (POSIX) expect(cacheDir({ XDG_CACHE_HOME: "relative" })).not.toContain("relative");
  });
});
