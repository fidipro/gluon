/**
 * A soak: 5 sessions printing 20 lines a second each for `GLUON_PERF_SOAK_MIN` minutes (default 20;
 * at least 6; skipped in quick mode). Gluon's memory is sampled every minute: it grows while the
 * scrollbacks fill (a few minutes), then must stay flat; the key latency at the end must match the
 * start. `bun run test:perf`.
 */
import { afterAll, describe, test } from "bun:test";
import { KEY, stopAll } from "../e2e/harness.ts";
import { CAN_MEASURE_PROCS, footprint, keyLatencies, Metrics, openSession, PERF, perfApp, pct, QUICK, slope } from "./perf-kit.ts";

const MINUTES = Number(process.env.GLUON_PERF_SOAK_MIN) || 20;
const m = new Metrics(`soak, ${MINUTES} min`);
afterAll(() => {
  stopAll();
  if (PERF && !QUICK) m.check();
});

describe.skipIf(!PERF || QUICK || !CAN_MEASURE_PROCS)("perf: soak", () => {
  test(`5 sessions printing for ${MINUTES} minutes: no unbounded growth`, async () => {
    if (MINUTES < 6) throw new Error("GLUON_PERF_SOAK_MIN must be at least 6: the last third needs samples");
    const p = await perfApp();
    for (let i = 0; i < 5; i++) {
      await openSession(p);
      await p.app.type("!tick 50");
      await p.app.press(KEY.enter);
      await p.app.waitFor("TICK 3");
    }
    // The shown session is still printing: its input line is the agent's, so keys are timed there.
    const first = await keyLatencies(p.app, "agent", 30);
    const series: { min: number; self: number; total: number }[] = [];
    const t0 = performance.now();
    for (let minute = 1; minute <= MINUTES; minute++) {
      await Bun.sleep(Math.max(0, t0 + minute * 60_000 - performance.now()));
      const f = footprint(p.app.pid);
      series.push({ min: minute, self: f.self, total: f.total });
    }
    const last = await keyLatencies(p.app, "agent", 30);
    console.log(`soak: gluon RSS by minute (MB): ${series.map((s) => s.self).join(" ")}\nsoak: gluon + agents RSS by minute (MB): ${series.map((s) => s.total).join(" ")}`);
    const third = series.filter((s) => s.min > (MINUTES * 2) / 3);
    m.add("soak.gluon_rss_min1_mb", series[0]!.self, "MB", undefined, true);
    m.add("soak.gluon_rss_end_mb", series.at(-1)!.self, "MB", 800);
    // The leak check is on Gluon's own RSS slope (about 0.3 MB/min measured; it must stay flat: 1 is the ceiling). The total
    // (Gluon plus the fake agents) is only recorded: the fakes keep their own scrollback and grow about 1.5 MB/min, which is
    // not Gluon's, and a ceiling of 2 on 1.87 was flaky by design.
    m.add("soak.gluon_slope_last_third_mb_min", slope(third.map((s) => [s.min, s.self])), "MB/min", 1);
    m.add("soak.total_slope_last_third_mb_min", slope(third.map((s) => [s.min, s.total])), "MB/min", undefined, true);
    m.add("soak.key_p95_start_ms", pct(first, 0.95), "ms", 150, false, undefined, true);
    m.add("soak.key_p95_end_ms", pct(last, 0.95), "ms", 150, false, undefined, true);
    p.app.kill();
  }, (MINUTES + 10) * 60_000);
});
