/**
 * Gluon's own updates (`src/update/`): the release's signature and checksum, the hops a download may take, putting the new
 * executable in place (Windows' rename-aside too), the daily check at start and `gluon update`. Offline: the real v1.0.0
 * `SHA256SUMS` and its Sigstore bundle are checked against a pinned trusted root (`test/fixtures/update/`), and a loopback
 * server stands in for GitHub (`test/fixtures/fake-release.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { ConfigError, loadConfig } from "../src/config.ts";
import { REPO_SLUG } from "../src/repo.ts";
import { replaceExecutable, stagedPath, sweepLeftovers } from "../src/update/apply.ts";
import { allowedUrl, fetchFile, latestVersion, newer, RELEASES, UpdateError } from "../src/update/fetch.ts";
import { assetName, hostTarget, TARGETS } from "../src/update/target.ts";
import { backgroundUpdate, CHECK_EVERY_MS, installRelease, readState, takeLock, updateCommand, updateMode, updateSource, writeState, type UpdateSource } from "../src/update/update.ts";
import { CERT_IDENTITY, CERT_ISSUER, expectedHash, verifySignature } from "../src/update/verify.ts";
import { fakeRelease, sha256, sumsOf, type FakeRelease } from "./fixtures/fake-release.ts";

const ROOT = join(import.meta.dir, "..");
const FIX = join(import.meta.dir, "fixtures", "update");
const SUMS = readFileSync(join(FIX, "SHA256SUMS"));
const BUNDLE = JSON.parse(readFileSync(join(FIX, "SHA256SUMS.sigstore.json"), "utf8"));
const TRUSTED_ROOT = TrustedRoot.fromJSON(JSON.parse(readFileSync(join(FIX, "trusted_root.json"), "utf8")));
const TARGET = "bun-linux-x64" as const;
const ASSET = assetName(TARGET);

const scratches: string[] = [];
const servers: FakeRelease[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "gluon-update-"));
  scratches.push(d);
  return d;
};
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake release `version` whose binary is `bin`, served with a SHA256SUMS (unsigned). */
function serve(version: string, bin: string | Uint8Array = `gluon ${version}`, extra: Record<string, string | Uint8Array> = {}): FakeRelease {
  const files = { [ASSET]: bin, ...extra };
  const r = fakeRelease(version, { [version]: { ...files, SHA256SUMS: sumsOf(files) } });
  servers.push(r);
  return r;
}
const sourceOf = (r: FakeRelease, o: Partial<UpdateSource> = {}): UpdateSource => ({ releases: { base: r.base, hosts: new Set() }, unsigned: true, target: TARGET, ...o });
/** An "executable" (any bytes: `versionOf` is injected) in a fresh directory. */
function exeIn(dir = scratch(), body = "gluon 1.0.0"): string {
  const exe = join(dir, "gluon");
  writeFileSync(exe, body);
  return exe;
}
const says = (version: string) => async () => version;

describe("update: the release's signature", () => {
  test("the real v1.0.0 SHA256SUMS verifies against its Sigstore bundle (the release workflow on main of this repository)", () => {
    expect(() => verifySignature(SUMS, BUNDLE, TRUSTED_ROOT)).not.toThrow();
  });

  test("one changed byte of SHA256SUMS is refused", () => {
    const bad = Buffer.from(SUMS);
    bad[10] = bad[10]! ^ 1;
    expect(() => verifySignature(bad, BUNDLE, TRUSTED_ROOT)).toThrow(/signature doesn't verify \(SIGNATURE_ERROR\)/);
  });

  test("a signature by another workflow, branch or repository is refused", () => {
    for (const other of [CERT_IDENTITY.replace("@refs/heads/main", "@refs/heads/dev"), CERT_IDENTITY.replace("release.yml", "ci.yml"), CERT_IDENTITY.replace(REPO_SLUG, "someone/gluon")])
      expect(() => verifySignature(SUMS, BUNDLE, TRUSTED_ROOT, other)).toThrow(/UNTRUSTED_SIGNER_ERROR/);
  });

  test("a bundle that isn't one is refused", () => {
    expect(() => verifySignature(SUMS, { not: "a bundle" }, TRUSTED_ROOT)).toThrow(UpdateError);
  });

  test("the identity and issuer are install.sh's (cosign checks the same signature there)", () => {
    const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
    const repo = /^REPO="([^"]+)"$/m.exec(sh)![1]!;
    expect(/^CERT_IDENTITY="([^"]+)"$/m.exec(sh)![1]!.replace("$REPO", repo)).toBe(CERT_IDENTITY);
    expect(/^CERT_ISSUER="([^"]+)"$/m.exec(sh)![1]).toBe(CERT_ISSUER);
  });
});

describe("update: SHA256SUMS, versions, targets and hosts", () => {
  test("a file's hash is found in either line form, CRLF or LF; a missing name is null", () => {
    const h = "a".repeat(64);
    expect(expectedHash(`${h}  gluon-bun-linux-x64\n`, "gluon-bun-linux-x64")).toBe(h);
    expect(expectedHash(`${"B".repeat(64)} *gluon-bun-linux-x64\r\n`, "gluon-bun-linux-x64")).toBe("b".repeat(64));
    expect(expectedHash(`${h}  gluon-bun-linux-x64-musl\n`, "gluon-bun-linux-x64")).toBeNull();
    expect(expectedHash(SUMS.toString("utf8"), "gluon-bun-windows-x64.exe")).toBe("2847442477460271e7537279977644b599ffec984afbc74426f66d9fff1f92d3");
  });

  test("newer compares x.y.z numerically; a pre-release or junk is never newer", () => {
    expect(newer("1.1.0", "1.0.0")).toBe(true);
    expect(newer("1.10.0", "1.9.9")).toBe(true);
    expect(newer("2.0.0", "10.0.0")).toBe(false);
    expect(newer("1.0.0", "1.0.0")).toBe(false);
    expect(newer("1.2.0-rc.1", "1.0.0")).toBe(false);
    expect(newer("latest", "1.0.0")).toBe(false);
  });

  test("each target has its release file; the host's is found (musl only on Linux)", () => {
    expect(TARGETS.map(assetName)).toContain("gluon-bun-windows-x64.exe");
    expect(hostTarget("linux", "x64", true)).toBe("bun-linux-x64-musl");
    expect(hostTarget("linux", "arm64", false)).toBe("bun-linux-arm64");
    expect(hostTarget("darwin", "arm64", true)).toBe("bun-darwin-arm64");
    expect(hostTarget("win32", "x64")).toBe("bun-windows-x64");
    expect(hostTarget("win32", "arm64")).toBeNull();
    expect(hostTarget("freebsd", "x64")).toBeNull();
  });

  test("a request goes only to GitHub's release hosts over https (or the seam's own loopback origin)", () => {
    expect(allowedUrl(new URL(`${RELEASES.base}/latest`), RELEASES)).toBe(true);
    expect(allowedUrl(new URL("https://release-assets.githubusercontent.com/x"), RELEASES)).toBe(true);
    expect(allowedUrl(new URL(`${RELEASES.base.replace("https:", "http:")}/latest`), RELEASES)).toBe(false);
    expect(allowedUrl(new URL("https://evil.example/x"), RELEASES)).toBe(false);
    const seam = { base: "http://127.0.0.1:4000/releases", hosts: new Set<string>() };
    expect(allowedUrl(new URL("http://127.0.0.1:4000/cdn/x"), seam)).toBe(true);
    expect(allowedUrl(new URL("http://127.0.0.1:4001/cdn/x"), seam)).toBe(false);
    expect(allowedUrl(new URL("https://github.com/x"), seam)).toBe(false);
  });
});

describe("update: reading the releases", () => {
  test("the latest version comes from the /latest redirect", async () => {
    const r = serve("1.4.2");
    expect(await latestVersion(sourceOf(r).releases)).toBe("1.4.2");
    r.latest = "nightly";
    await expect(latestVersion(sourceOf(r).releases)).rejects.toThrow("couldn't read the latest release's version");
  });

  test("a download redirected off the release hosts is refused", async () => {
    const r = serve("1.4.2");
    const other = serve("1.4.2");
    r.redirectTo = other.base.replace("/releases", "");
    await expect(fetchFile(sourceOf(r).releases, "1.4.2", "SHA256SUMS")).rejects.toThrow(/refused to fetch http:\/\/127\.0\.0\.1:\d+: not one of the release hosts/);
    expect(other.requests).toEqual([]);
  });

  test("a file larger than its cap is refused", async () => {
    const r = serve("1.4.2", "x", { big: "y".repeat(2000) });
    await expect(fetchFile(sourceOf(r).releases, "1.4.2", "big", 1000)).rejects.toThrow("larger than 1000 bytes");
  });

  test("the seam is loopback http only, and nothing at all in a test run without it", () => {
    const seam = (o: unknown) => {
      const p = join(scratch(), "seam.json");
      writeFileSync(p, JSON.stringify(o));
      return p;
    };
    expect(updateSource({ NODE_ENV: "test" })).toBeNull();
    expect(updateSource({ GLUON_TEST_PROBES: "/x" })).toBeNull();
    expect(updateSource({ GLUON_TEST_UPDATE: seam({ base: "http://127.0.0.1:1/releases", unsigned: true }) })).toEqual({ releases: { base: "http://127.0.0.1:1/releases", hosts: new Set() }, unsigned: true });
    for (const bad of [{ base: "https://127.0.0.1:1/releases" }, { base: "http://example.com/releases" }, "not json"]) expect(updateSource({ GLUON_TEST_UPDATE: seam(bad) })).toBeNull();
    expect(updateSource({})).toEqual({ releases: RELEASES });
  });

  test("the seam is compiled out of a release build and kept in a test build; the pack and dist checks name it", async () => {
    const build = async (flavor: string) => {
      const r = await Bun.build({ entrypoints: [join(ROOT, "src/update/update.ts")], target: "bun", minify: true, define: { GLUON_BUILD: JSON.stringify(flavor), "process.env.NODE_ENV": JSON.stringify("production") } });
      expect(r.success).toBe(true);
      return (await Promise.all(r.outputs.map((o) => o.text()))).join("\n");
    };
    expect(await build("release")).not.toContain("GLUON_TEST_UPDATE");
    expect(await build("npm")).not.toContain("GLUON_TEST_UPDATE");
    expect(await build("test")).toContain("GLUON_TEST_UPDATE");
    expect(readFileSync(join(ROOT, "scripts/pack.ts"), "utf8")).toContain('text.includes("GLUON_TEST_UPDATE")');
    expect(readFileSync(join(ROOT, "test/dist.test.ts"), "utf8")).toContain('"GLUON_TEST_UPDATE"');
  });
});

describe("update: installing a release", () => {
  test("a verified download replaces the executable, and nothing is left beside it", async () => {
    const r = serve("1.1.0", "NEW BINARY");
    const exe = exeIn();
    await installRelease("1.1.0", sourceOf(r), exe, { versionOf: says("1.1.0"), dir: scratch() });
    expect(readFileSync(exe, "utf8")).toBe("NEW BINARY");
    expect(readdirSync(join(exe, ".."))).toEqual(["gluon"]);
  });

  test("a binary that doesn't match SHA256SUMS is refused, and the executable is unchanged", async () => {
    const r = serve("1.1.0", "NEW BINARY");
    r.files["1.1.0"]![ASSET] = "TAMPERED";
    const exe = exeIn();
    await expect(installRelease("1.1.0", sourceOf(r), exe, { versionOf: says("1.1.0"), dir: scratch() })).rejects.toThrow(`${ASSET} doesn't match SHA256SUMS`);
    expect(readFileSync(exe, "utf8")).toBe("gluon 1.0.0");
    expect(readdirSync(join(exe, ".."))).toEqual(["gluon"]);
  });

  test("a signed release: the signature is checked first, then the binary against the signed SHA256SUMS", async () => {
    // v1.0.0's real signed SHA256SUMS, served with a binary that isn't the real one: the signature passes, the checksum doesn't.
    const r = fakeRelease("1.0.0", { "1.0.0": { SHA256SUMS: SUMS, "SHA256SUMS.sigstore.json": JSON.stringify(BUNDLE), [ASSET]: "NOT THE REAL BINARY" } });
    servers.push(r);
    const log: string[] = [];
    const exe = exeIn();
    await expect(installRelease("1.0.0", sourceOf(r, { unsigned: false }), exe, { root: async () => TRUSTED_ROOT, versionOf: says("1.0.0"), log: (l) => log.push(l), dir: scratch() })).rejects.toThrow("doesn't match SHA256SUMS");
    expect(log[0]).toStartWith("Signature verified");
    // SHA256SUMS changed to match the fake binary: now the signature fails, before any binary is downloaded.
    r.files["1.0.0"]!.SHA256SUMS = SUMS.toString("utf8").replace(/^\w+(?=  gluon-bun-linux-x64$)/m, sha256("NOT THE REAL BINARY"));
    r.requests.length = 0;
    await expect(installRelease("1.0.0", sourceOf(r, { unsigned: false }), exe, { root: async () => TRUSTED_ROOT, versionOf: says("1.0.0"), dir: scratch() })).rejects.toThrow("signature doesn't verify");
    expect(r.requests.some((p) => p.endsWith(ASSET))).toBe(false);
    // No signature file at all: refused.
    delete r.files["1.0.0"]!["SHA256SUMS.sigstore.json"];
    await expect(installRelease("1.0.0", sourceOf(r, { unsigned: false }), exe, { root: async () => TRUSTED_ROOT, versionOf: says("1.0.0"), dir: scratch() })).rejects.toThrow("HTTP 404");
    expect(readFileSync(exe, "utf8")).toBe("gluon 1.0.0");
  });

  test("a new executable that doesn't answer --version with its version is not put in place", async () => {
    const exe = exeIn();
    const staged = stagedPath(exe);
    writeFileSync(staged, "x");
    await expect(replaceExecutable({ exe, staged, version: "1.1.0", versionOf: says("1.0.0") })).rejects.toThrow('answered "1.0.0" to --version');
    await expect(replaceExecutable({ exe, staged, version: "1.1.0", versionOf: async () => null })).rejects.toThrow("answered nothing");
    expect(readFileSync(exe, "utf8")).toBe("gluon 1.0.0");
  });

  test("Windows: the running .exe moves aside to .old and the new one takes its name; a later start sweeps the old copy", async () => {
    const dir = scratch();
    const exe = join(dir, "gluon.exe");
    writeFileSync(exe, "OLD");
    const staged = stagedPath(exe, "win32");
    expect(staged).toEndWith(".exe");
    writeFileSync(staged, "NEW");
    await replaceExecutable({ exe, staged, version: "1.1.0", platform: "win32", versionOf: says("1.1.0") });
    expect(readFileSync(exe, "utf8")).toBe("NEW");
    expect(readFileSync(`${exe}.old`, "utf8")).toBe("OLD");
    sweepLeftovers(exe);
    expect(readdirSync(dir)).toEqual(["gluon.exe"]);
  });

  test("a staged file a crashed update left is swept once it is a day old, not before", () => {
    const exe = exeIn();
    const staged = stagedPath(exe);
    writeFileSync(staged, "x");
    sweepLeftovers(exe);
    expect(existsSync(staged)).toBe(true);
    const old = (Date.now() - 25 * 3_600_000) / 1000;
    utimesSync(staged, old, old);
    sweepLeftovers(exe);
    expect(existsSync(staged)).toBe(false);
  });

  test("one update at a time: the lock is exclusive, and one a crash left is taken over after 30 minutes", () => {
    const dir = scratch();
    const unlock = takeLock(dir)!;
    expect(unlock).toBeFunction();
    expect(takeLock(dir)).toBeNull();
    expect(takeLock(dir, Date.now() + 31 * 60_000)).toBeFunction();
    unlock();
  });
});

describe("update: at start", () => {
  const start = async (r: FakeRelease, mode: "auto" | "notify" | "off", o: { dir: string; exe?: string; now?: number; current?: string; version?: string }) => {
    const notices: string[] = [];
    const seam = r.seam({ unsigned: true, target: TARGET, ...(o.exe ? { exe: o.exe } : {}) });
    await backgroundUpdate({ mode, current: o.current ?? "1.0.0", notice: (m) => notices.push(m), env: { GLUON_TEST_UPDATE: seam }, dir: o.dir, ...(o.now ? { now: () => o.now! } : {}), deps: { versionOf: says(o.version ?? r.latest) } });
    return notices;
  };

  test("off checks nothing", async () => {
    const r = serve("1.1.0");
    expect(await start(r, "off", { dir: scratch() })).toEqual([]);
    expect(r.requests).toEqual([]);
  });

  test("notify says a newer release exists, and checks GitHub at most once a day", async () => {
    const r = serve("1.1.0");
    const dir = scratch();
    expect(await start(r, "notify", { dir })).toEqual(["Gluon 1.1.0 is available (you have 1.0.0): run gluon update to install it."]);
    expect(r.requests).toEqual(["/releases/latest"]);
    expect(readState(dir).latest).toBe("1.1.0");
    // A second start the same day: the notice again, from what the check found; no request.
    expect(await start(r, "notify", { dir })).toHaveLength(1);
    expect(r.requests).toEqual(["/releases/latest"]);
    // A day later: checked again.
    await start(r, "notify", { dir, now: Date.now() + CHECK_EVERY_MS + 1000 });
    expect(r.requests).toEqual(["/releases/latest", "/releases/latest"]);
  });

  test("nothing is said when this is the latest, or GitHub can't be reached", async () => {
    const r = serve("1.0.0");
    expect(await start(r, "auto", { dir: scratch() })).toEqual([]);
    r.stop();
    expect(await start(r, "auto", { dir: scratch() })).toEqual([]);
  });

  test("auto installs a newer release for the next start, and says so", async () => {
    const r = serve("1.1.0", "NEW BINARY");
    const exe = exeIn();
    expect(await start(r, "auto", { dir: scratch(), exe })).toEqual(["Gluon 1.1.0 is installed: it starts the next time you open Gluon (this one stays 1.0.0)."]);
    expect(readFileSync(exe, "utf8")).toBe("NEW BINARY");
  });

  test("auto that fails says why, and doesn't try that version again before the next check", async () => {
    const r = serve("1.1.0", "NEW BINARY");
    r.files["1.1.0"]![ASSET] = "TAMPERED";
    const exe = exeIn();
    const dir = scratch();
    const [notice] = await start(r, "auto", { dir, exe });
    expect(notice).toStartWith("Gluon 1.1.0 is available (you have 1.0.0), but installing it automatically failed: gluon-bun-linux-x64 doesn't match SHA256SUMS");
    expect(notice).toEndWith("Run gluon update to try again.");
    expect(readFileSync(exe, "utf8")).toBe("gluon 1.0.0");
    const asked = r.requests.length;
    expect(await start(r, "auto", { dir, exe })).toEqual([notice!]);
    expect(r.requests.length).toBe(asked);
  });

  test("auto without an executable to replace (the npm package, source) says how to update instead", async () => {
    const r = serve("1.1.0");
    const [notice] = await start(r, "auto", { dir: scratch() });
    expect(notice).toStartWith("Gluon 1.1.0 is available (you have 1.0.0): this Gluon runs from source");
  });

  test("another Gluon updating (the lock) is left alone", async () => {
    const r = serve("1.1.0", "NEW BINARY");
    const dir = scratch();
    const exe = exeIn();
    const unlock = takeLock(dir)!;
    expect(await start(r, "auto", { dir, exe })).toEqual([]);
    expect(readFileSync(exe, "utf8")).toBe("gluon 1.0.0");
    unlock();
  });

  test("GLUON_UPDATES wins over the config; anything else in it is ignored", () => {
    expect(updateMode("auto", {})).toBe("auto");
    expect(updateMode("auto", { GLUON_UPDATES: "off" })).toBe("off");
    expect(updateMode("off", { GLUON_UPDATES: " Notify " })).toBe("notify");
    expect(updateMode("notify", { GLUON_UPDATES: "never" })).toBe("notify");
  });

  test("a state file that isn't one reads as no check", () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "update.json"), "{nope");
    expect(readState(dir)).toEqual({});
    writeState({ checkedAt: "2026-10-08T00:00:00.000Z", latest: "1.1.0" }, dir);
    expect(readState(dir)).toEqual({ checkedAt: "2026-10-08T00:00:00.000Z", latest: "1.1.0" });
  });
});

describe("update: gluon update", () => {
  const run = async (args: string[], r: FakeRelease | null, exe?: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const env = r ? { GLUON_TEST_UPDATE: r.seam({ unsigned: true, target: TARGET, ...(exe ? { exe } : {}) }) } : { NODE_ENV: "test" };
    const code = await updateCommand(args, { current: "1.0.0", env, log: (l) => out.push(l), error: (l) => err.push(l), dir: scratch(), deps: { versionOf: says(r?.latest ?? "") } });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  test("--check says whether a newer release exists and installs nothing", async () => {
    const r = serve("1.1.0");
    const exe = exeIn();
    expect(await run(["--check"], r, exe)).toEqual({ code: 0, out: "Gluon 1.1.0 is available (you have 1.0.0).\nRun gluon update to install it.", err: "" });
    expect(readFileSync(exe, "utf8")).toBe("gluon 1.0.0");
    expect(await run(["--check"], serve("1.0.0"), exe)).toMatchObject({ code: 0, out: "Gluon 1.0.0 is up to date (the latest release is 1.0.0)." });
  });

  test("it installs the newer release and says where", async () => {
    const r = serve("1.1.0", "NEW BINARY");
    const exe = exeIn();
    const res = await run([], r, exe);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`Installed Gluon 1.1.0 at ${exe}.`);
    expect(readFileSync(exe, "utf8")).toBe("NEW BINARY");
  });

  test("a failure says nothing was changed; a bad argument is refused; a test run reaches no network", async () => {
    const r = serve("1.1.0");
    r.files["1.1.0"]![ASSET] = "TAMPERED";
    expect(await run([], r, exeIn())).toMatchObject({ code: 1, err: expect.stringMatching(/^gluon: update failed: .* doesn't match SHA256SUMS .*\. Nothing was changed\.$/) });
    expect(await run(["--yes"], r)).toMatchObject({ code: 2, err: "gluon: update takes only --check: gluon update [--check]" });
    expect(await run([], null)).toMatchObject({ code: 1, err: "gluon: this run reaches no network (a test): nothing to check" });
  });
});

describe("update: the config key", () => {
  const saved = process.env.GLUON_CONFIG;
  afterEach(() => {
    if (saved === undefined) delete process.env.GLUON_CONFIG;
    else process.env.GLUON_CONFIG = saved;
  });

  test("auto by default; auto, notify and off are read (false as off, true as auto); anything else names the key", () => {
    const cfg = join(scratch(), "config.yaml");
    process.env.GLUON_CONFIG = cfg;
    expect(loadConfig().updates).toBe("auto");
    for (const [yaml, want] of [["updates: notify\n", "notify"], ["updates: off\n", "off"], ["updates: false\n", "off"], ["updates: true\n", "auto"], ["updates:\n", "auto"]] as const) {
      writeFileSync(cfg, yaml);
      expect([yaml, loadConfig().updates]).toEqual([yaml, want]);
    }
    for (const bad of ["updates: sometimes\n", "updates: [auto]\n"]) {
      writeFileSync(cfg, bad);
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow("updates must be one of auto, notify, off");
    }
  });
});
