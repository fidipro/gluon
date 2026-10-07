/**
 * Startup and keystroke latency: how long Gluon takes to show the home view (first run with an empty
 * transpiler cache, and after), and how long a key takes to come back as a drawn frame at the home
 * composer and inside a session (key, fake agent's echo, frame). Key latencies are held to the
 * perception limits on Gluon's share (measured minus the harness floor; `perf-kit.ts`). `bun run test:perf`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshConfig, WIN } from "../e2e/fixtures.ts";
import { App, HOME_VIEW, stopAll } from "../e2e/harness.ts";
import { ASK_YAML } from "../e2e/gluon-kit.ts";
import { addLatency, CAN_MEASURE_PROCS, GLUON_PERF_ENV, GOOD_ADDED_MS, NOTICEABLE_ADDED_MS, PLATFORM_ADDED_P95_MS, footprint, freshRepo, idleCpu, keyLatencies, measureFloor, Metrics, openSession, PERF, perfApp, pct, QUICK, until } from "./perf-kit.ts";

const m = new Metrics("startup and keystroke latency");
afterAll(() => {
  stopAll();
  m.check();
});

/** Spawns Gluon and times until the home view (header and composer) is drawn; returns the app too. */
async function startup(cwd: string, env: Record<string, string>): Promise<{ ms: number; app: App }> {
  const t0 = performance.now();
  const app = new App({ cwd, cols: 120, rows: 30, agents: ["claude"], env: { GLUON_CONFIG: freshConfig(`startup-${Math.random().toString(36).slice(2)}`, ASK_YAML), FAKE_TUI: "1", ...GLUON_PERF_ENV, ...env } });
  await until(app, (s) => /Gluon v\d/.test(s) && HOME_VIEW.test(s), 30_000);
  return { ms: performance.now() - t0, app };
}

describe.skipIf(!PERF)("perf: startup and latency", () => {
  test("startup to the home view, first run and after; the idle home view", async () => {
    const cwd = freshRepo();
    // Bun's transpiler cache: empty for the first run (a fresh install), filled after it.
    const cache = mkdtempSync(join(tmpdir(), "gluon-perf-cache-"));
    const env = { BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache };
    const cold = await startup(cwd, env);
    cold.app.kill();
    const warm: number[] = [];
    let last: App | undefined;
    for (let i = 0; i < (QUICK ? 2 : 5); i++) {
      last?.kill();
      const r = await startup(cwd, env);
      warm.push(r.ms);
      last = r.app;
    }
    m.add("startup.cold_ms", cold.ms, "ms", 4000);
    m.add("startup.warm_median_ms", pct(warm, 0.5), "ms", 2000);
    if (CAN_MEASURE_PROCS && last) {
      await Bun.sleep(1000);
      const f = footprint(last.pid);
      m.add("home.rss_mb", f.self, "MB", 400);
      const [cpu] = await idleCpu(last.pid, QUICK ? 3000 : 10_000);
      m.add("home.idle_cpu_pct", cpu, "%", 10);
    }
    last?.kill();
    expect(warm.length).toBeGreaterThan(0);
  }, 120_000);

  test("key to frame at the home composer", async () => {
    const p = await perfApp();
    // Gluon's share: the measured latency minus the floor (`measureFloor`). Recorded, not held to the perception
    // limit here: that is the BUG-615 test below (the same measurement).
    const floor = (await measureFloor()).p50;
    const s = await keyLatencies(p.app, "home", QUICK ? 15 : 60);
    m.add("home.key_p50_ms", pct(s, 0.5), "ms");
    m.add("home.key_p95_ms", pct(s, 0.95), "ms");
    m.add("home.key_p50_added_ms", pct(s, 0.5) - floor, "ms", undefined, true, GOOD_ADDED_MS);
    m.add("home.key_p95_added_ms", pct(s, 0.95) - floor, "ms", undefined, true);
    m.add("home.floor_ms", floor, "ms", undefined, true);
    p.app.kill();
  }, 120_000);

  // BUG-615 (QA-perf-01): a home frame measured all its text with string-width's slow emoji regex (fixed by
  // `patches/string-width@8.3.0.patch`). Its own measurement. On Linux the empty home composer was under the limit
  // even before (p95 added about 29 ms; the breach started at about 5 sessions: `typing.perf.test.ts`), so this cell is
  // Windows's alone (48.5 / 64.6 ms p50 / p95 added before the fix); skipped in quick mode (15 pairs would flip it by chance).
  (QUICK || !WIN ? test.skip : test)("BUG-615/QA-perf-01: key to frame at the home composer stays under the noticeable limit", async () => {
    const p = await perfApp();
    const floor = (await measureFloor()).p50;
    const s = await keyLatencies(p.app, "home", 60);
    p.app.kill();
    // Windows only (the test is skipped elsewhere): the accepted two-ConPTY ceiling (BUG-616), 66 ms measured at home.
    expect(pct(s, 0.95) - floor, "Gluon's added latency at the home composer, p95").toBeLessThan(PLATFORM_ADDED_P95_MS);
  }, 120_000);

  test("key to agent to frame inside a session", async () => {
    const p = await perfApp();
    await openSession(p);
    const floor = (await measureFloor()).p50;
    const s = await keyLatencies(p.app, "agent", QUICK ? 15 : 60);
    addLatency(m, "session.key_p50_ms", pct(s, 0.5), floor, false);
    // On Windows a key crosses two ConPTYs: held to the ceiling of the accepted cost (BUG-616; `WIN_SESSION_ADDED_P95_MS`).
    addLatency(m, "session.key_p95_ms", pct(s, 0.95), floor, true, true, PLATFORM_ADDED_P95_MS);
    m.add("session.floor_ms", floor, "ms", undefined, true);
    p.app.kill();
  }, 120_000);
});
