/**
 * A test run's own processes, found by a marker and ended with the run (BUG-573). `test/preload.ts` sets
 * `GLUON_TEST_RUN=<pid>:<the run's directory>` in the environment of the run; every process the tests start (the app, the
 * fake agents it starts, a raw `Bun.spawn` of either) inherits it, whatever its parent became: a gluon killed by a test's
 * timeout leaves its agent reparented to init, and this is how the agent is still found.
 *
 * Linux only (`/proc/<pid>/environ`, readable for one's own processes alone, which is the safety: a process of another user
 * or without the marker is never looked at, let alone ended). macOS has no such file and Windows has none either: there
 * the run ends the trees it tracked (`App.dispose`, `spawnTracked` in test/e2e/harness.ts: taskkill /T), and a process whose
 * parent died first stays. A process is ended only when its marker names THIS run (`sweepRun`) or a run whose process is
 * gone (`sweepDeadRuns`): other sessions' live runs on the same machine are never touched.
 */
import { readdirSync, readFileSync } from "node:fs";

/** The marker variable. */
export const RUN_ENV = "GLUON_TEST_RUN";

/** What a run's marker says: its process and its directory. */
export const marker = (pid: number, root: string) => `${pid}:${root}`;

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it is not ours.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The marker value of a process's environment, if it has one (Linux; undefined elsewhere or when unreadable). */
function markerOf(pid: number): string | undefined {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "latin1");
    for (const entry of env.split("\0")) if (entry.startsWith(`${RUN_ENV}=`)) return entry.slice(RUN_ENV.length + 1);
  } catch {}
  return undefined;
}

/** Every process that carries a marker (not this one), with its value. Empty where there is no /proc. */
export function marked(self = process.pid): { pid: number; value: string }[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const found: { pid: number; value: string }[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1 || pid === self) continue;
    const value = markerOf(pid);
    if (value !== undefined) found.push({ pid, value });
  }
  return found;
}

function killAll(pids: number[]): number[] {
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {}
  }
  return killed;
}

/** Ends every process carrying exactly this run's marker (never the caller's own); returns their pids. */
export function sweepRun(value: string, self = process.pid): number[] {
  return killAll(marked(self).filter((m) => m.value === value).map((m) => m.pid));
}

/**
 * Ends the processes of runs that are over: a marker whose run process is gone (a `bun test` that was killed outright, so it
 * could not sweep). A marker that doesn't parse, or names a live process, is left alone: a live run on the machine is
 * someone's, and so is a value this code didn't write.
 */
export function sweepDeadRuns(own: string, self = process.pid): number[] {
  const dead = marked(self).filter((m) => {
    if (m.value === own) return false;
    const pid = /^(\d+):/.exec(m.value)?.[1];
    return pid !== undefined && !isAlive(Number(pid));
  });
  return killAll(dead.map((m) => m.pid));
}
