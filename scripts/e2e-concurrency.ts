#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * How many e2e apps (tests in flight) a machine runs at once: `GLUON_E2E_CONCURRENCY` when set, else
 * `min(MAX_APPS, cores / 3, free GB / GB_PER_APP)`, at least 1. Shared by `scripts/regression.ts`, `scripts/windows-test.ts` and
 * `scripts/docker-test.sh` (`bun scripts/e2e-concurrency.ts` prints it), so every runner is RAM-aware.
 */
import { readFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";

/**
 * What one test in flight costs: its gluon app (~180 MB), the fake agent and the screen model, about 0.21 GB of RSS
 * measured as the slope of `bun run regression`'s e2e peak over `GLUON_E2E_CONCURRENCY`; a little more is left free for it.
 */
export const GB_PER_APP = 0.25;
/**
 * The most apps at once by default: the tree's RSS is about 0.35 GB (the test process, bun) plus 0.21 GB per app, and the fast
 * tier aims at 1.2 GB peak. A bigger machine can ask for more with `GLUON_E2E_CONCURRENCY`.
 */
export const MAX_APPS = 4;

export function defaultApps(): number {
  const set = Number(process.env.GLUON_E2E_CONCURRENCY);
  if (set >= 1) return Math.floor(set);
  let avail = freemem();
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    if (m) avail = Number(m[1]) * 1024;
  } catch {}
  return Math.max(1, Math.min(MAX_APPS, Math.floor(availableParallelism() / 3), Math.floor(avail / 2 ** 30 / GB_PER_APP)));
}

if (import.meta.main) console.log(defaultApps());
