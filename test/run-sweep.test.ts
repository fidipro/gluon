/**
 * A killed or timed-out test run leaves no processes of its own: `test/preload.ts` marks every process the run starts
 * (`GLUON_TEST_RUN=<pid>:<the run's directory>`) and ends the marked ones when the run ends, on a signal included; a run killed
 * outright is swept by the next run's start (`test/fixtures/run-sweep.ts`). A real `bun test` of a throwaway file, killed from
 * outside, stands in for a developer's Ctrl+C or a CI timeout.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive, marked, marker, RUN_ENV, sweepDeadRuns, sweepRun } from "./fixtures/run-sweep.ts";

const ROOT = join(import.meta.dir, "..");
const posix = process.platform !== "win32";
// Finding a run's processes needs /proc (test/fixtures/run-sweep.ts); elsewhere only the run's directory is checked.
const linux = process.platform === "linux";

const gone = async (pid: number) => {
  for (const end = Date.now() + 3000; isAlive(pid) && Date.now() < end; await Bun.sleep(20));
  return !isAlive(pid);
};

/** Runs a one-test file whose test starts `sleep 300` (as the app starts its agent: the environment passed on) and then hangs. */
async function hangingRun(dir: string) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "straggler.test.ts");
  const facts = join(dir, "facts.json");
  writeFileSync(
    file,
    `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("starts a straggler and hangs", async () => {
  const p = Bun.spawn(["sleep", "300"], { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ straggler: p.pid, root: process.env.TMPDIR }));
  await Bun.sleep(120_000);
}, 130_000);
`,
  );
  const run = Bun.spawn([process.execPath, "test", file], { cwd: ROOT, env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  for (const end = Date.now() + 15_000; !existsSync(facts) && Date.now() < end; await Bun.sleep(50));
  const { straggler, root } = JSON.parse(readFileSync(facts, "utf8")) as { straggler: number; root: string };
  return { run, straggler, root };
}

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
};

for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
  (posix ? test : test.skip)(`BUG-573/run-sweep: ${signal} to a running \`bun test\` ends the processes the run started and removes its directory`, async () => {
    const { run, straggler, root } = await hangingRun(join(tmpdir(), `sweep-${signal}`));
    try {
      expect(isAlive(straggler)).toBe(true);
      run.kill(signal);
      await Promise.race([run.exited, Bun.sleep(8000)]);
      if (linux) expect(await gone(straggler)).toBe(true);
      expect(existsSync(root)).toBe(false);
    } finally {
      kill(straggler);
      run.kill(9);
    }
  });
}

/** `sleep 300` with a marker (none when `value` is undefined). */
const sleeper = (value?: string) => {
  const env: Record<string, string | undefined> = { ...process.env, [RUN_ENV]: value };
  if (value === undefined) delete env[RUN_ENV];
  return Bun.spawn(["sleep", "300"], { env: env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
};

(linux ? test : test.skip)("BUG-573/run-sweep: sweepRun ends the processes with this run's marker and no others", async () => {
  const mine = sleeper("1234:/a");
  const other = sleeper("1234:/b");
  const plain = sleeper();
  try {
    expect(marked().map((m) => m.pid)).toEqual(expect.arrayContaining([mine.pid, other.pid]));
    expect(marked().map((m) => m.pid)).not.toContain(plain.pid);
    expect(sweepRun("1234:/a")).toEqual([mine.pid]);
    expect(await gone(mine.pid)).toBe(true);
    expect([isAlive(other.pid), isAlive(plain.pid)]).toEqual([true, true]);
  } finally {
    for (const p of [mine, other, plain]) p.kill(9);
  }
});

(linux ? test : test.skip)("BUG-573/run-sweep: sweepDeadRuns ends the processes of a run whose process is gone, never a live run's, this run's, or a value it didn't write", async () => {
  const done = Bun.spawn(["true"]);
  await done.exited;
  const orphan = sleeper(marker(done.pid, "/gone"));
  const live = sleeper(marker(process.pid, "/other-live-run"));
  const own = sleeper(marker(process.pid, "/own"));
  const foreign = sleeper("whatever");
  try {
    expect(sweepDeadRuns(marker(process.pid, "/own"))).toContain(orphan.pid);
    expect(await gone(orphan.pid)).toBe(true);
    expect([live, own, foreign].map((p) => isAlive(p.pid))).toEqual([true, true, true]);
  } finally {
    for (const p of [orphan, live, own, foreign]) p.kill(9);
  }
});

(linux ? test : test.skip)("BUG-573/run-sweep: a run killed outright (SIGKILL) leaves its straggler, and the next run's start ends it", async () => {
  const dir = join(tmpdir(), "sweep-next-run");
  const { run, straggler } = await hangingRun(dir);
  try {
    run.kill(9);
    await run.exited;
    expect(isAlive(straggler)).toBe(true);
    const next = join(dir, "next.test.ts");
    writeFileSync(next, 'import { test } from "bun:test";\ntest("starts", () => {});\n');
    const r = Bun.spawn([process.execPath, "test", next], { cwd: ROOT, env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    expect(await r.exited).toBe(0);
    expect(await gone(straggler)).toBe(true);
  } finally {
    kill(straggler);
    run.kill(9);
  }
});
