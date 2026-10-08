/**
 * The test-style rules (test/AGENTS.md, docs/contributing/testing.md) as pure functions, and the suite's counts today.
 * `test/test-style.test.ts` checks them against `test/test-style.baseline.json`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./areas.ts";

export type Baseline = { waits: Record<string, number>; mocks: Record<string, number>; bothLayers: string[] };
// ——— the rules, pure (their own cases are below) ———

/**
 * The fixed waits in a file: `Bun.sleep(n)`, a `setTimeout` promise of n ms (n ≥ 100) and `settle(n)` (n ≥ 200, past the
 * harness's own default). Not a wait: one bounding a race (`Promise.race`), a poll's interval (on a `while` / `for` line), a
 * child process's own code (`-e "…"`), or a line marked `// sleep-ok: <what must not happen meanwhile>` (or the line above it).
 */
export function fixedWaits(text: string): number[] {
  const lines = text.split("\n");
  const at: number[] = [];
  lines.forEach((l, i) => {
    if (/sleep-ok:/.test(l) || /sleep-ok:/.test(lines[i - 1] ?? "")) return;
    if (/Promise\.race|\bwhile\s*\(|\bfor\s*\(|-e\s*"|"-e",/.test(l)) return;
    for (const m of l.matchAll(/Bun\.sleep\(\s*(\d[\d_]*)|settle\(\s*(\d[\d_]*)|setTimeout\(\s*r\w*\s*,\s*(\d[\d_]*)/g)) {
      const n = Number((m[1] ?? m[2] ?? m[3])!.replaceAll("_", ""));
      if (m[2] !== undefined ? n >= 200 : n >= 100) at.push(i + 1);
    }
  });
  return at;
}

/** Upper bounds on a measured time with a bare number (no `* SLOW`): a slow runner fails them. */
export function bareTimeBounds(text: string): string[] {
  const re = /expect\(([^;]*?(?:now\(\)|\bms\b|Ms\b|elapsed|\bstarted\b|\bt0\b))\)\.toBeLessThan(?:OrEqual)?\(\s*[\d_]+\s*\)/g;
  return [...text.matchAll(re)].map((m) => m[0]);
}

/** The bug ids a file's tests name (`BUG-nn/…` or `BUG-nn:`), outside comments. */
export function bugIds(text: string): Set<string> {
  const code = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  return new Set([...code.matchAll(/\b(BUG-\d+)[/:]/g)].map((m) => m[1]!));
}

// ——— the suite as it is ———

export const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const scan = (g: string) => [...new Bun.Glob(g).scanSync({ cwd: ROOT })].map((f) => f.replaceAll("\\", "/")).sort();
/** Test code: the test files and their helpers. Not the perf suite (timing is its subject), the fakes (they act an agent's timing) or the harness's wait primitives. */
/** The tests of these rules and the health check: their samples break the rules on purpose. */
const SAMPLES = ["test/test-style.test.ts", "test/test-guards.test.ts", "test/test-health.test.ts"];
export const CODE = scan("test/**/*.{ts,tsx}").filter((f) => !f.startsWith("test/perf/") && !/^test\/fixtures\/fake-/.test(f) && f !== "test/e2e/harness.ts" && !SAMPLES.includes(f));
const UNIT = scan("test/*.test.{ts,tsx}").filter((f) => !SAMPLES.includes(f));
const E2E = scan("test/e2e/*.e2e.test.ts");

export function current(): Baseline {
  const waits: Record<string, number> = {};
  const mocks: Record<string, number> = {};
  for (const f of CODE) {
    const t = read(f);
    const w = fixedWaits(t).length;
    if (w) waits[f] = w;
    const m = (t.match(/mock\.module\(/g) ?? []).length;
    if (m) mocks[f] = m;
  }
  const ids = (fs: string[]) => new Set(fs.flatMap((f) => [...bugIds(read(f))]));
  const e2e = ids(E2E);
  const bothLayers = [...ids(UNIT)].filter((id) => e2e.has(id)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  return { waits, mocks, bothLayers };
}

if (import.meta.main) console.log(JSON.stringify(current(), null, 1));
