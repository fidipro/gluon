/**
 * Test durations kept between runs (`qa/logs/test-times.json`, written by `scripts/regression.ts`) and
 * the unit shards they balance (also used by `scripts/coverage.ts`). A missing or stale file only
 * costs balance: files it doesn't know get `SECONDS`, then a guess from their size.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ROOT } from "../test/areas.ts";

/** A test slower than this (the e2e ones measured with the apps at once) gets `@full`: the meter and `bun run test:health` list those still without it. */
export const FULL_OVER_S = 3;

export const TIMES = join(ROOT, "qa", "logs", "test-times.json");
export type TierTimes = { files: Record<string, number>; tests: Record<string, Record<string, number>> };
export type TimesFile = { version: 1; updated: string; cores: number; tiers: Record<string, TierTimes> };

export function readTimes(): TimesFile {
  try {
    const t = JSON.parse(readFileSync(TIMES, "utf8")) as TimesFile;
    if (t.version === 1 && t.tiers) return t;
  } catch {}
  return { version: 1, updated: "", cores: availableParallelism(), tiers: {} };
}

/** Merge one run's per-file seconds (and its tests of 1 s or more) into the file; never fails a run. */
export function saveTimes(times: TimesFile, tier: string, cases: { file: string; name: string; s: number }[]) {
  if (!cases.length) return;
  try {
    const t = (times.tiers[tier] ??= { files: {}, tests: {} });
    for (const f of new Set(cases.map((c) => c.file))) {
      const mine = cases.filter((c) => c.file === f);
      t.files[f] = Math.round(mine.reduce((a, c) => a + c.s, 0) * 1000) / 1000;
      const slow = Object.fromEntries(mine.filter((c) => c.s >= 1).map((c) => [c.name, Math.round(c.s * 1000) / 1000]));
      if (Object.keys(slow).length) t.tests[f] = slow;
      else delete t.tests[f];
    }
    times.updated = new Date().toISOString();
    times.cores = availableParallelism();
    mkdirSync(join(ROOT, "qa", "logs"), { recursive: true });
    writeFileSync(TIMES, JSON.stringify(times, null, 1) + "\n");
  } catch {}
}

/** Rough seconds per unit file when no run has measured it: a few known heavy ones, then by size. */
const SECONDS: Record<string, number> = {
  "home.test.tsx": 40,
  "pty-session.test.ts": 18,
  "pty-compositor.test.ts": 12,
  "tools.test.ts": 11,
  "figures.test.ts": 10,
  "fakes.test.ts": 8,
  "adapters-opencode.test.ts": 5.5,
};

function weight(times: TimesFile, tier: string, f: string): number {
  const measured = times.tiers[tier]?.files[f] ?? times.tiers[tier === "full" ? "fast" : "full"]?.files[f];
  if (measured !== undefined) return Math.max(0.2, measured + 0.3);
  return SECONDS[f.slice(5)] ?? Math.max(0.3, Bun.file(join(ROOT, f)).size / 20_000);
}

/**
 * The unit files in up to `shards` groups of about the same time: measured seconds first (the last
 * run of this tier, else the other tier's), then `SECONDS`, then size; each file into the lightest
 * group. A small set gets fewer groups (a process costs ~1 s). Never an empty group: `bun test` with
 * no file would run all of test/, e2e and visual included.
 */
export function unitShards(times: TimesFile, tier: string, files: string[], shards: number): string[][] {
  if (!files.length) return [];
  const ws = files.map((f) => ({ f, s: weight(times, tier, f) }));
  const total = ws.reduce((a, b) => a + b.s, 0);
  const groups = Array.from({ length: Math.max(1, Math.min(shards, files.length, Math.round(total / 8))) }, () => ({ s: 0, files: [] as string[] }));
  for (const { f, s } of ws.sort((a, b) => b.s - a.s)) {
    const g = groups.reduce((a, b) => (b.s < a.s ? b : a));
    g.s += s;
    g.files.push(`./${f}`);
  }
  return groups.map((g) => g.files);
}
