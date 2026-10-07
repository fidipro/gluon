/**
 * Many sessions: Gluon's memory, idle CPU, keystroke latency and tab switches with 1, 5, 10, 20 and
 * 40 sessions open (each its own worktree and fake agent), and its memory with every session's
 * scrollback full (5000 rows of 200 cells). Latencies are held to the perception limits on Gluon's
 * share (measured minus the harness floor; `perf-kit.ts`), except the home composer's, which has
 * its own test (`typing.perf.test.ts`). `bun run test:perf`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { HOME_TWICE } from "../e2e/actions.ts";
import { HOME_VIEW, KEY, stopAll } from "../e2e/harness.ts";
import { addLatency, CAN_MEASURE_PROCS, footprint, idleCpu, keyLatencies, measureFloor, Metrics, openSession, PERF, PLATFORM_ADDED_P95_MS, perfApp, pct, QUICK, tell, timed } from "./perf-kit.ts";

const m = new Metrics("sessions at scale");
afterAll(() => {
  stopAll();
  m.check();
});

/** `GLUON_PERF_MAX_SESSIONS=20`: no run with more sessions than that (a machine short of memory: Windows' agents are 100 MB executables). */
const MAX = Number(process.env.GLUON_PERF_MAX_SESSIONS) || Infinity;
const COUNTS = (QUICK ? [1, 3] : [1, 5, 10, 20, 40]).filter((n) => n <= MAX);
/** Ceiling by session count: Gluon's own RSS (MB). The latency limits are the perception ones, whatever the count. */
const rssCeiling = (n: number) => 250 + 10 * n;

describe.skipIf(!PERF)("perf: sessions", () => {
  test("1, 5, 10, 20 and 40 sessions", async () => {
    const p = await perfApp();
    for (const n of COUNTS) {
      let open = 0;
      while (p.sessions < n) {
        open = await openSession(p);
        await tell(p.app, `ID-${p.sessions}`);
      }
      m.add(`scale.n${n}.open_ms`, open, "ms", 15_000);
      await Bun.sleep(1500);
      const k = `scale.n${n}`;
      if (CAN_MEASURE_PROCS) {
        const [self, all] = await idleCpu(p.app.pid, QUICK ? 3000 : 10_000);
        const f = footprint(p.app.pid);
        expect(f.count).toBeGreaterThanOrEqual(n);
        m.add(`${k}.gluon_rss_mb`, f.self, "MB", rssCeiling(n));
        m.add(`${k}.agents_rss_mb`, f.children, "MB", undefined, true);
        m.add(`${k}.idle_cpu_pct`, self, "%", 10 + 0.5 * n);
        m.add(`${k}.idle_cpu_all_pct`, all, "%", undefined, true);
      }
      const floor = (await measureFloor()).p50;
      const keys = await keyLatencies(p.app, "agent", QUICK ? 10 : 30);
      addLatency(m, `${k}.key_p50_ms`, pct(keys, 0.5), floor, false);
      addLatency(m, `${k}.key_p95_ms`, pct(keys, 0.95), floor, true, true, PLATFORM_ADDED_P95_MS);
      if (n > 1) {
        // The last two sessions: ← to the one before, → back.
        const sw: number[] = [];
        for (let i = 0; i < (QUICK ? 5 : 15); i++) {
          sw.push(await timed(p.app, KEY.left, (s) => s.includes(`GOT <ID-${n - 1}>`) && !s.includes(`GOT <ID-${n}>`)));
          await Bun.sleep(15);
          sw.push(await timed(p.app, KEY.right, (s) => s.includes(`GOT <ID-${n}>`) && !s.includes(`GOT <ID-${n - 1}>`)));
          await Bun.sleep(15);
        }
        addLatency(m, `${k}.switch_p95_ms`, pct(sw, 0.95), floor, true);
      }
      // The home composer with that many tabs: recorded, not held to a limit here; its limit is the
      // BUG-615 test in `typing.perf.test.ts` (it failed at 10 sessions and more before the string-width patch).
      await p.app.press(...HOME_TWICE);
      await p.app.waitFor(HOME_VIEW);
      await Bun.sleep(1000);
      const home = await keyLatencies(p.app, "home", QUICK ? 8 : 30);
      m.add(`${k}.home_key_p95_ms`, pct(home, 0.95), "ms", undefined, true);
      m.add(`${k}.home_key_added_p95_ms`, pct(home, 0.95) - floor, "ms", undefined, true);
    }
    p.app.kill();
  }, 900_000);

  test("every session's scrollback full: 5000 rows of 200 cells", async () => {
    const N = QUICK ? 3 : 10;
    const p = await perfApp(200, 40);
    for (let i = 0; i < N; i++) await openSession(p);
    await Bun.sleep(1000);
    const before = CAN_MEASURE_PROCS ? footprint(p.app.pid) : undefined;
    // The last session is shown: fill it, then walk back through the others with ←.
    const rows: number[] = [];
    for (let i = 0; i < N; i++) {
      const hit = /FLOOD-DONE (\d+)/;
      await timed(p.app, "!flood 4096\r", (s) => hit.test(s), 120_000);
      rows.push(Number(hit.exec(p.app.screen())![1]));
      if (i < N - 1) await timed(p.app, KEY.left, (s) => !hit.test(s) && s.includes("TUI ready"));
    }
    expect(Math.min(...rows)).toBeGreaterThan(5000);
    await Bun.sleep(1500);
    if (before) {
      const after = footprint(p.app.pid);
      m.add("scrollback.gluon_rss_mb", after.self, "MB", 1500);
      m.add("scrollback.per_session_mb", (after.self - before.self) / N, "MB", 40);
      m.add("scrollback.agents_rss_mb", after.children, "MB", undefined, true);
    }
    const floor = (await measureFloor()).p50;
    const keys = await keyLatencies(p.app, "agent", QUICK ? 10 : 30);
    addLatency(m, "scrollback.key_p95_ms", pct(keys, 0.95), floor, true, true, PLATFORM_ADDED_P95_MS);
    p.app.kill();
  }, 900_000);
});
