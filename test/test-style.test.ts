/**
 * How tests are written (test/AGENTS.md, docs/contributing/testing.md), checked over every test file (the rules:
 * `test/test-style.ts`). Rules the suite already keeps must hold everywhere; the ones it doesn't yet are a ratchet:
 * `test/test-style.baseline.json` holds each file's count today, a count may only go down, and a new file starts at none.
 * When yours went down, lower the baseline:
 *   GLUON_TEST_STYLE_UPDATE=1 bun test test/test-style.test.ts
 * (it never raises one: a higher count is fixed in the test, not in the baseline).
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./areas.ts";
import { bareTimeBounds, bugIds, CODE, current, fixedWaits, read, type Baseline } from "./test-style.ts";

const BASELINE = join(ROOT, "test", "test-style.baseline.json");
const UPDATE = !!process.env.GLUON_TEST_STYLE_UPDATE;

const base = JSON.parse(read("test/test-style.baseline.json")) as Baseline;
const now = current();
const LOWER = "lower the baseline: GLUON_TEST_STYLE_UPDATE=1 bun test test/test-style.test.ts";

/** Each key's count against the baseline: over it (a problem to fix in the test), or under it (the baseline to lower). */
function ratchet(name: string, have: Record<string, number>, had: Record<string, number>, fix: string): { over: string[]; under: string[] } {
  const over: string[] = [];
  const under: string[] = [];
  for (const k of new Set([...Object.keys(have), ...Object.keys(had)])) {
    const n = have[k] ?? 0;
    const was = had[k] ?? 0;
    if (n > was) over.push(`${k}: ${n} ${name}, the baseline allows ${was}: ${fix}`);
    if (n < was) under.push(`${k}: ${n} ${name}, the baseline still says ${was}: ${LOWER}`);
  }
  return { over, under };
}

if (UPDATE) {
  // Lower only: a count over the baseline stays a failure.
  const low = (have: Record<string, number>, had: Record<string, number>) => Object.fromEntries(Object.entries(had).map(([k, v]) => [k, Math.min(v, have[k] ?? 0)]).filter(([, v]) => (v as number) > 0));
  const next: Baseline = { waits: low(now.waits, base.waits), mocks: low(now.mocks, base.mocks), bothLayers: base.bothLayers.filter((id) => now.bothLayers.includes(id)) };
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 1)}\n`);
  Object.assign(base, next);
}

describe("test style: the rules hold everywhere", () => {
  test("no upper bound on a measured time is a bare number: it is `ms * SLOW` (test/fixtures/slow.ts), or a perception limit in test/perf", () => {
    expect(CODE.flatMap((f) => bareTimeBounds(read(f)).map((b) => `${f}: ${b}`))).toEqual([]);
  });

  test("no snapshot outside test/visual: assert the state or the region that matters, not a whole screen", () => {
    expect(CODE.filter((f) => !f.startsWith("test/visual/") && /toMatch(Inline)?Snapshot\(/.test(read(f)))).toEqual([]);
  });
});

describe("test style: the ratchet (test/test-style.baseline.json only goes down)", () => {
  test("fixed waits: wait for a state (`waitFor`, `until`, `exitCode()`, `oscReplied()`), or mark a window in which something must not happen with `// sleep-ok: <what>`", () => {
    const r = ratchet("fixed waits", now.waits, base.waits, "wait for the state instead, or mark a no-change window `// sleep-ok: <what must not happen>`");
    expect(r.over).toEqual([]);
    expect(r.under).toEqual([]);
  });

  test("module mocks: a fake at the process or network boundary instead (test/fixtures)", () => {
    const r = ratchet("mock.module calls", now.mocks, base.mocks, "use a fake at the process or network boundary (test/fixtures) instead of mocking a module");
    expect(r.over).toEqual([]);
    expect(r.under).toEqual([]);
  });

  test("one layer per bug: a bug is tested where it can be caught most cheaply (unit unless it lives in terminal I/O), not in both", () => {
    const fresh = now.bothLayers.filter((id) => !base.bothLayers.includes(id));
    expect(fresh.map((id) => `${id}: tested in a unit file and an e2e file; keep the cheaper one (test/AGENTS.md)`)).toEqual([]);
    const gone = base.bothLayers.filter((id) => !now.bothLayers.includes(id));
    expect(gone.map((id) => `${id}: no longer at two layers: ${LOWER}`)).toEqual([]);
  });
});

describe("test style: the rules' own cases", () => {
  test("a fixed wait counts; a race's bound, a poll's interval, a child's code and a marked window don't", () => {
    const t = [
      "await Bun.sleep(1500);",
      "await app.settle(800);",
      "await new Promise((r) => setTimeout(r, 250));",
      "await Bun.sleep(1000 * SLOW);",
      "await Bun.sleep(50);",
      "await app.settle(150);",
      "await Promise.race([p, Bun.sleep(3000)]);",
      "while (!done()) await Bun.sleep(100);",
      'Bun.spawn([bun, "-e", "await Bun.sleep(30000)"]);',
      "await Bun.sleep(600); // sleep-ok: no second prompt",
      "// sleep-ok: the menu must stay open",
      "await Bun.sleep(900);",
    ].join("\n");
    expect(fixedWaits(t)).toEqual([1, 2, 3, 4]);
  });

  test("a bare bound on a measured time counts; one scaled by SLOW, or on a size, doesn't", () => {
    const t = ["expect(Date.now() - t0).toBeLessThan(1500);", "expect(r.ms).toBeLessThan(500);", "expect(performance.now() - started).toBeLessThan(2000 * SLOW);", "expect(text.length).toBeLessThan(400);"].join("\n");
    expect(bareTimeBounds(t)).toEqual(["expect(Date.now() - t0).toBeLessThan(1500)", "expect(r.ms).toBeLessThan(500)"]);
  });

  test("bug ids come from titles, not comments", () => {
    expect([...bugIds('test("BUG-12/a: x", () => {});\n// BUG-13: a note\ntest("BUG-14: y", () => {});')]).toEqual(["BUG-12", "BUG-14"]);
  });

  test("the ratchet: over is fixed in the test, under lowers the baseline", () => {
    expect(ratchet("waits", { a: 3, b: 1 }, { a: 2, b: 2 }, "fix it")).toEqual({ over: ["a: 3 waits, the baseline allows 2: fix it"], under: [`b: 1 waits, the baseline still says 2: ${LOWER}`] });
    expect(ratchet("waits", { c: 1 }, {}, "fix it").over).toEqual(["c: 1 waits, the baseline allows 0: fix it"]);
  });
});
