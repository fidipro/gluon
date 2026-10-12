/**
 * install.sh, run whole against a local release directory (`GLUON_RELEASE_URL`): the SHA-256 check against
 * SHA256SUMS and, with cosign on the PATH, SHA256SUMS's signature (a fake cosign plays each version). Nothing is
 * downloaded and nothing outside a temporary directory is written. install.ps1 runs in CI's Windows job.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// A release directory with the asset under every name install.sh may pick, and a fake cosign: "v2" needs
// --new-bundle-format (cosign 2.4 or later), "bad" rejects the bundle either way, "old" has no such flag; "none"
// puts no cosign first on the PATH (the checksum check comes before any signature check). `sums` spoils SHA256SUMS:
// "wrong" lists another file's hash, "missing" leaves the assets out.
function install(cosign: "v2" | "bad" | "old" | "none", sums: "ok" | "wrong" | "missing" = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "gluon-cosign-"));
  try {
    const rel = join(dir, "rel");
    const bin = join(dir, "bin");
    mkdirSync(rel);
    mkdirSync(bin);
    const body = "#!/bin/sh\necho 1.0.0\n";
    const hash = new Bun.CryptoHasher("sha256").update(sums === "wrong" ? "not the released file" : body).digest("hex");
    const names = ["linux", "darwin"].flatMap((os) => ["x64", "arm64"].flatMap((a) => [`gluon-bun-${os}-${a}`, `gluon-bun-${os}-${a}-musl`]));
    for (const n of names) writeFileSync(join(rel, n), body);
    writeFileSync(join(rel, "SHA256SUMS"), sums === "missing" ? `${hash}  gluon-bun-other\n` : names.map((n) => `${hash}  ${n}\n`).join(""));
    writeFileSync(join(rel, "SHA256SUMS.sigstore.json"), "{}");
    const script = {
      v2: 'case "$*" in *--new-bundle-format*) exit 0 ;; esac\necho "Error: bundle does not contain cert for verification, please provide public key" >&2\nexit 1\n',
      bad: 'echo "Error: none of the expected identities matched what was in the certificate" >&2\nexit 1\n',
      old: 'case "$*" in *--new-bundle-format*) echo "Error: unknown flag: --new-bundle-format" >&2 ;; *) echo "Error: bundle does not contain cert" >&2 ;; esac\nexit 1\n',
      none: undefined,
    }[cosign];
    if (script) writeFileSync(join(bin, "cosign"), `#!/bin/sh\n${script}`, { mode: 0o755 });
    const r = Bun.spawnSync(["sh", join(ROOT, "install.sh")], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, GLUON_RELEASE_URL: rel, GLUON_INSTALL_DIR: join(dir, "out") },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), installed: readdirSync(dir).includes("out") && readdirSync(join(dir, "out")).includes("gluon") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("install.sh: the signature check with cosign 2 and 3", () => {
  test("installers/signature: a cosign that needs --new-bundle-format is retried with it and installs #BUG-676/cosign-v2", () => {
    const r = install("v2");
    expect(r.out).toContain("signature ok");
    expect(r.code).toBe(0);
    expect(r.installed).toBe(true);
  });

  test("installers/signature: a signature that fails both ways still dies 'does not verify', nothing installed #BUG-676/cosign-v2", () => {
    const r = install("bad");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does not verify");
    expect(r.out).not.toContain("older than 2.4");
    expect(r.installed).toBe(false);
  });

  test("installers/signature: a cosign without the flag dies asking for an upgrade, nothing installed #BUG-676/cosign-v2", () => {
    const r = install("old");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("older than 2.4");
    expect(r.out).toContain("upgrade cosign");
    expect(r.out).not.toContain("signature ok");
    expect(r.installed).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("install.sh: the SHA-256 check", () => {
  test("installers/checksum: a binary SHA256SUMS doesn't match, or doesn't list, stops install.sh with nothing installed", () => {
    const wrong = install("none", "wrong");
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain("checksum mismatch");
    expect(wrong.out).toContain("the download is not the released file; nothing installed");
    expect(wrong.installed).toBe(false);
    const missing = install("none", "missing");
    expect(missing.code).not.toBe(0);
    expect(missing.out).toMatch(/SHA256SUMS has no entry for gluon-bun-\S+; nothing installed/);
    expect(missing.installed).toBe(false);
  });
});
