/**
 * Gluon's own updates end to end (`src/update/`): a loopback server stands in for GitHub's releases (`test/fixtures/fake-release.ts`; the
 * test seam `GLUON_TEST_UPDATE` points Gluon at it; release builds have no seam). At start Gluon says a newer release exists (notify),
 * installs it (auto) or asks nothing (off); `gluon update --check` and `gluon update` from the command line.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, hostTarget } from "../../src/update/target.ts";
import { fakeRelease, sumsOf } from "../fixtures/fake-release.ts";
import { WIN } from "./fixtures.ts";
import { gluon } from "./gluon-kit.ts";
import { cli, SLOW, stopAll } from "./harness.ts";

setDefaultTimeout(60_000 * SLOW);
afterAll(stopAll);

const LATEST = "99.0.0";
const ASSET = assetName(hostTarget() ?? "bun-linux-x64");
/** A "new Gluon" that answers `--version` as the release it came from (a script: POSIX only). */
const NEW_BIN = `#!/bin/sh\necho ${LATEST}\n`;

function sandbox(opts: { exe?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gluon-update-e2e-"));
  const files = { [ASSET]: NEW_BIN };
  const server = fakeRelease(LATEST, { [LATEST]: { ...files, SHA256SUMS: sumsOf(files) } });
  const exe = join(dir, "gluon");
  if (opts.exe) {
    writeFileSync(exe, "#!/bin/sh\necho 1.0.0\n");
    chmodSync(exe, 0o755);
  }
  const seam = server.seam({ unsigned: true, ...(opts.exe ? { exe } : {}) });
  const env = { XDG_STATE_HOME: join(dir, "state"), GLUON_TEST_UPDATE: seam };
  return { dir, server, exe, env, done: () => (server.stop(), rmSync(dir, { recursive: true, force: true })) };
}

test("update/e2e: notify says at start that a newer Gluon exists, without waiting for it", async () => {
  const s = sandbox();
  try {
    const app = await gluon(110, 30, { ...s.env, GLUON_UPDATES: "notify" });
    await app.waitFor((t) => t.replace(/\s+/g, " ").includes(`Gluon ${LATEST} is available`), 20_000 * SLOW);
    expect(app.screen().replace(/\s+/g, " ")).toContain("run gluon update to install it.");
    expect(s.server.requests).toEqual(["/releases/latest"]);
  } finally {
    s.done();
  }
});

test("update/e2e: off asks GitHub nothing", async () => {
  const s = sandbox();
  try {
    const app = await gluon(110, 30, { ...s.env, GLUON_UPDATES: "off" });
    await app.idle();
    await Bun.sleep(500 * SLOW);
    expect(s.server.requests).toEqual([]);
  } finally {
    s.done();
  }
});

test.skipIf(WIN)("update/e2e: auto installs the new release in the background and says it starts next time", async () => {
  const s = sandbox({ exe: true });
  try {
    const app = await gluon(110, 30, s.env);
    await app.waitFor((t) => t.replace(/\s+/g, " ").includes(`Gluon ${LATEST} is installed: it starts the next time you open Gluon`), 20_000 * SLOW);
    expect(readFileSync(s.exe, "utf8")).toBe(NEW_BIN);
  } finally {
    s.done();
  }
});

test.skipIf(WIN)("update/e2e: gluon update --check, then gluon update replaces the executable", async () => {
  const s = sandbox({ exe: true });
  try {
    const check = await cli(["update", "--check"], { env: s.env });
    expect([check.code, check.stderr]).toEqual([0, ""]);
    expect(check.stdout).toContain(`Gluon ${LATEST} is available`);
    expect(readFileSync(s.exe, "utf8")).not.toBe(NEW_BIN);
    const r = await cli(["update"], { env: s.env });
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toContain(`Installed Gluon ${LATEST} at ${s.exe}.`);
    expect(readFileSync(s.exe, "utf8")).toBe(NEW_BIN);
  } finally {
    s.done();
  }
});

test("update/e2e: without the seam a test run reaches no network", async () => {
  const r = await cli(["update", "--check"], {});
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("this run reaches no network");
});
