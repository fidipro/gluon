/** The e2e harness ends a test's apps with the test (`scoped`, `test/e2e/scoped-test.ts`): gluon and the agent it started, not at the file's end. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { repo, WIN } from "./fixtures.ts";
import { baseEnv, cli, descendants, GLUON, inScope, scoped, SLOW, start, stopAll, toLaunch, tracked } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("every e2e test body runs scoped (test/preload.ts reroutes the file's bun:test)", () => {
  expect(inScope()).toBe(true);
});

test("when a scoped body ends, gluon and the agent it started are gone, whatever the body left running @full", async () => {
  let pids: number[] = [];
  await scoped(async () => {
    const app = await start({ cwd: repo.tiny(), rows: 40, env: { FAKE_HANG: "1" } });
    await toLaunch(app);
    pids = [app.pid, ...descendants(app.pid)];
    // Windows: the process table also holds what ran for a moment (a git, a cmd).
    if (WIN) pids = pids.filter(alive);
    // gluon, and at least the agent: the point is that the agent's own session is ended too.
    expect(pids.length).toBeGreaterThan(1);
    expect(pids.every(alive)).toBe(true);
  })();
  await Bun.sleep(300 * SLOW);
  expect(pids.filter(alive)).toEqual([]);
});

// BUG-573: a process a test starts from the app ends with the run, however its test ended. Linux: the processes are found by an
// environment variable only they carry (/proc), the way the run's sweep finds them (test/fixtures/run-sweep.ts).
const linux = process.platform === "linux";
const withTag = (tag: string): number[] => tagged(tag).map((t) => t.pid);
/** The processes carrying the tag, with what one read of each told: its cmdline and whether it carries the run's marker. A process that can't be read (a `sleep` mid-exec or just gone: EACCES, ENOENT) is not one of them. */
const tagged = (tag: string): { pid: number; cmd: string; run: boolean }[] => {
  const found: { pid: number; cmd: string; run: boolean }[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
      if (!env.includes(`GLUON_TEST_TAG=${tag}`)) continue;
      found.push({ pid, cmd: readFileSync(`/proc/${pid}/cmdline`, "latin1").replaceAll("\0", " "), run: env.includes(`GLUON_TEST_RUN=${process.env.GLUON_TEST_RUN}`) });
    } catch {}
  }
  return found;
};
const waitFor = async (what: () => boolean, ms = 10_000 * SLOW) => {
  for (const end = Date.now() + ms; !what() && Date.now() < end; await Bun.sleep(50));
  return what();
};

(linux ? test : test.skip)("BUG-573/orphan-agents: a raw spawn of the app, tracked, ends with its test, the agent too; both carry the run's marker", async () => {
  const tag = `tracked-${process.pid}-${Date.now()}`;
  let pids: number[] = [];
  await scoped(async () => {
    const gluon = tracked(Bun.spawn([...GLUON, "--launch", "claude-code", "--model", "sonnet", "fix it"], { cwd: repo.tiny(), env: baseEnv(["claude"], { FAKE_HANG: "1", GLUON_TEST_TAG: tag }), stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
    // gluon and its agent (a bash fake, `bin-claude/claude`), found by what they run: the fake's `sleep`s come and go and are not what is asserted.
    const both = () => {
      const t = tagged(tag);
      return { gluon: t.find((x) => x.pid === gluon.pid), agent: t.find((x) => /bin-claude\/claude /.test(x.cmd)), all: t };
    };
    expect(await waitFor(() => !!both().gluon && !!both().agent)).toBe(true);
    const seen = both();
    expect(seen.gluon?.run).toBe(true);
    expect(seen.agent?.run).toBe(true);
    // whatever else carries the tag (a `sleep` of the fake) carries the marker too
    expect(seen.all.filter((x) => !x.run)).toEqual([]);
    pids = [gluon.pid, seen.agent!.pid];
  })();
  expect(await waitFor(() => pids.every((p) => !alive(p)), 3000 * SLOW)).toBe(true);
});

(linux ? test : test.skip)("BUG-573/orphan-agents: a cli() that times out ends the agent, not gluon alone @full", async () => {
  const tag = `timeout-${process.pid}-${Date.now()}`;
  let pids: number[] = [];
  const poll = setInterval(() => (pids = [...new Set([...pids, ...withTag(tag)])]), 50);
  try {
    const r = await cli(["--launch", "claude-code", "--model", "sonnet", "fix it"], { env: { FAKE_HANG: "1", GLUON_TEST_TAG: tag }, agents: ["claude"], cwd: repo.tiny(), timeoutMs: 3000 * SLOW });
    expect(r.code).not.toBe(0);
  } finally {
    clearInterval(poll);
  }
  expect(pids.length).toBeGreaterThanOrEqual(2);
  expect(await waitFor(() => pids.every((p) => !alive(p)), 3000 * SLOW)).toBe(true);
});
