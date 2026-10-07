/**
 * Output throughput and what it does to the rest: a flood of coloured output into the shown session
 * and into a background one (while the keys typed meanwhile go to the shown session), and the
 * latency of a tab switch. Latencies are held to the perception limits on Gluon's share (measured
 * minus the harness floor; `perf-kit.ts`); burst typing during a flood is in `typing.perf.test.ts`. `bun run test:perf`.
 */
import { afterAll, describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { KEY, stopAll } from "../e2e/harness.ts";
import { addLatency, CAN_MEASURE_PROCS, footprint, keyLatencies, measureFloor, Metrics, openSession, PERF, perfApp, pct, QUICK, tell, timed, until } from "./perf-kit.ts";

const m = new Metrics("throughput, background output and tab switches");
afterAll(() => {
  stopAll();
  m.check();
});

/** The kilobytes a flood writes (the fake counts bytes of escape sequences too). */
const FLOOD_KB = QUICK ? 4096 : 16_384;
const ARROW_LEFT = KEY.left;
const ARROW_RIGHT = KEY.right;
const DONE = /FLOOD-DONE (\d+)/;

describe.skipIf(!PERF)("perf: throughput", () => {
  test("a flood in the shown session", async () => {
    const p = await perfApp();
    await openSession(p);
    const times: number[] = [];
    let rows = 0;
    for (let i = 0; i < (QUICK ? 1 : 3); i++) {
      // Another size each time: the last run's marker may still be on screen.
      const kb = FLOOD_KB + i;
      const before = DONE.exec(p.app.screen())?.[0];
      const ms = await timed(p.app, `!flood ${kb}\r`, (s) => {
        const hit = DONE.exec(s)?.[0];
        return !!hit && hit !== before;
      }, 120_000);
      times.push(ms);
      rows = Number(DONE.exec(p.app.screen())![1]);
    }
    const ms = pct(times, 0.5);
    m.add("flood.visible_ms", ms, "ms", 20_000);
    m.add("flood.visible_krows_s", rows / ms, "krows/s", undefined, true);
    if (CAN_MEASURE_PROCS) m.add("flood.visible_gluon_rss_mb", footprint(p.app.pid).self, "MB", 600);
    p.app.kill();
  }, 300_000);

  test("a flood in a background session: keys meanwhile, and the tab after", async () => {
    const p = await perfApp();
    await openSession(p);
    await tell(p.app, "ID-1");
    await openSession(p);
    await tell(p.app, "ID-2");
    // The second session floods; the first is shown at once (←).
    const t0 = Date.now();
    p.app.write(`!flood ${FLOOD_KB * 4}\r`);
    await Bun.sleep(30);
    await timed(p.app, ARROW_LEFT, (s) => s.includes("GOT <ID-1>") && !s.includes("GOT <ID-2>"));
    const keys: number[] = [];
    const flooded = () => {
      try {
        return readFileSync(p.floodLog, "utf8").trim().split("\n").at(-1)?.split(" ");
      } catch {
        return undefined;
      }
    };
    // Type until the flood has been written (at least a few keys either way).
    for (let i = 0; i < 400 && (i < 5 || !flooded()); i++) keys.push(...(await keyLatencies(p.app, "agent", 1, 10)));
    const wrote = flooded();
    const writeMs = wrote ? Number(wrote[1]) - t0 : NaN;
    // Show it: the end of the flood is drawn once Gluon has taken in everything the agent wrote.
    const show = await timed(p.app, ARROW_RIGHT, (s) => DONE.test(s), 120_000);
    m.add("flood.background_agent_write_ms", writeMs, "ms", 30_000);
    m.add("flood.background_total_ms", Date.now() - t0 + 0, "ms", 40_000);
    const floor = (await measureFloor()).p50;
    // Showing the flooded session is a tab switch: the key to the frame, held to the same limit.
    addLatency(m, "flood.background_show_ms", show, floor, true);
    m.add("flood.background_keys", keys.length, "keys", undefined, true);
    // Recorded, not held to the limit here: the typed-while-another-floods case is held in `typing.perf.test.ts`.
    addLatency(m, "flood.background_key_p50_ms", pct(keys, 0.5), floor, false, false);
    addLatency(m, "flood.background_key_p95_ms", pct(keys, 0.95), floor, true, false);
    p.app.kill();
  }, 300_000);

  test("tab switch latency", async () => {
    const p = await perfApp();
    await openSession(p);
    await tell(p.app, "ID-1");
    await openSession(p);
    await tell(p.app, "ID-2");
    const ms: number[] = [];
    for (let i = 0; i < (QUICK ? 10 : 40); i++) {
      // ← from the second session to the first, → back: each shows the other's line.
      ms.push(await timed(p.app, ARROW_LEFT, (s) => s.includes("GOT <ID-1>") && !s.includes("GOT <ID-2>")));
      await Bun.sleep(20);
      ms.push(await timed(p.app, ARROW_RIGHT, (s) => s.includes("GOT <ID-2>") && !s.includes("GOT <ID-1>")));
      await Bun.sleep(20);
    }
    // And to home and back (the home key twice, then a click-free way back: →).
    const floor = (await measureFloor()).p50;
    addLatency(m, "switch.p50_ms", pct(ms, 0.5), floor, false);
    addLatency(m, "switch.p95_ms", pct(ms, 0.95), floor, true);
    await until(p.app, (s) => s.includes("GOT <ID-2>"));
    p.app.kill();
  }, 180_000);
});
