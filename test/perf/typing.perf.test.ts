/**
 * Typing: what a person feels while typing fast. A burst of keys at the clock's pace (12 a second
 * for 5 s, and 25 a second for 4 s, the rate of key repeat) at the home composer and inside a
 * session, with 0, 1, 10 and 40 sessions open, and in a session while another floods. Per key:
 * p50, p95, max, whether the keys queue up (drift) and whether any is lost.
 *
 * The assertions are on Gluon's ADDED latency: the measured one minus the harness floor (`measureFloor`:
 * the same probe on the fake agent's TUI alone, no Gluon in between), against the perception limits of
 * `perf-kit.ts` (`NOTICEABLE_ADDED_MS`, `GOOD_ADDED_MS`; sources in `test/e2e/README.md`). `bun run test:perf`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HOME_TWICE } from "../e2e/actions.ts";
import { WIN } from "../e2e/fixtures.ts";
import { HOME_VIEW, KEY, stopAll } from "../e2e/harness.ts";
import { type Burst, BURST_DRIFT_MS, burstType, clearLine, cpuPressure, GOOD_ADDED_MS, measureFloor, Metrics, NOTICEABLE_ADDED_MS, PLATFORM_ADDED_P95_MS, PLATFORM_REPEAT_ADDED_P95_MS, openSession, PERF, perfApp, type PerfApp, QUICK, tell } from "./perf-kit.ts";

const m = new Metrics("burst typing: home composer, sessions, a flood");
afterAll(() => {
  stopAll();
  m.check();
});

/** 12 keys a second for 5 s (a fast typist), 25 a second for 4 s (key repeat). Quick mode: shorter. */
const RATES: [number, number][] = QUICK ? [[12, 3], [25, 2]] : [[12, 5], [25, 4]];
/** Sessions open for the scale tests. */
const COUNTS = QUICK ? [1, 3] : [1, 10, 40];
/** Sessions open behind the home composer (BUG-615). */
const HOME_COUNTS = QUICK ? [0, 3] : [0, 10, 40];
const WIDE = 120;

interface Row {
  rate: number;
  b: Burst;
  /** p95 minus the floor's median: Gluon's added latency in the tail. */
  added95: number;
  added50: number;
  addedMax: number;
}

/** Types the bursts of `RATES` in the shown view; `kind` is the line they go to. */
async function bursts(p: PerfApp, kind: "home" | "agent", floor: number): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [rate, seconds] of RATES) {
    const b = await burstType(p.app, rate, seconds);
    await clearLine(p.app, kind);
    rows.push({ rate, b, added95: b.p95 - floor, added50: b.p50 - floor, addedMax: b.max - floor });
  }
  return rows;
}

/** The metrics of one group of bursts; `limits` false records them without failing (asserted by the test itself, or accepted: BUG-616 on Windows). */
function record(where: string, floor: number, rows: Row[], limits: boolean) {
  m.add(`typing.${where}.floor_ms`, floor, "ms", undefined, true);
  // How contended the machine was (percent of the last 10 s a task waited for a core): above ~5 the latencies say little.
  m.add(`typing.${where}.cpu_pressure_pct`, cpuPressure(), "%", undefined, true);
  for (const { rate, b, added50, added95, addedMax } of rows) {
    const k = `typing.${where}.r${rate}`;
    m.add(`${k}.p50_ms`, b.p50, "ms", undefined, true);
    m.add(`${k}.p95_ms`, b.p95, "ms", undefined, true);
    m.add(`${k}.max_ms`, b.max, "ms", undefined, true);
    m.add(`${k}.added_p50_ms`, added50, "ms", undefined, true, GOOD_ADDED_MS);
    m.add(`${k}.added_p95_ms`, added95, "ms", limits ? NOTICEABLE_ADDED_MS : undefined, !limits, undefined, true);
    m.add(`${k}.added_max_ms`, addedMax, "ms", limits ? 2 * NOTICEABLE_ADDED_MS : undefined, !limits, undefined, true);
    m.add(`${k}.drift_ms`, b.drift, "ms", limits ? BURST_DRIFT_MS : undefined, !limits, undefined, true);
    m.add(`${k}.last_key_ms`, b.last, "ms", undefined, true);
    m.add(`${k}.lost_keys`, b.sent - b.seen, "keys", limits ? 0 : undefined, !limits);
  }
}

/** Opens sessions up to `n` (each told a line, as the scale test does) and goes home. */
async function openTo(p: PerfApp, n: number) {
  while (p.sessions < n) {
    await openSession(p);
    await tell(p.app, `ID-${p.sessions}`);
  }
}
async function goHome(p: PerfApp) {
  if (!HOME_VIEW.test(p.app.screen())) {
    await p.app.press(...HOME_TWICE);
    await p.app.waitFor(HOME_VIEW);
  }
  await Bun.sleep(1000);
}

/** Opens the flooding session behind the shown one and types a burst in the shown one: its rows, and whether the flood ran throughout. */
async function duringFlood(): Promise<{ p: PerfApp; floor: number; rows: Row[]; flooding: boolean }> {
  const p = await perfApp(WIDE, 30);
  await openSession(p);
  await tell(p.app, "ID-1");
  await openSession(p);
  await tell(p.app, "ID-2");
  // The second session floods 512 MB (quick mode 256): about 32 s (16) at the 16 MB/s of a quiet Linux machine, more than
  // the setup, the floor and the bursts take (about 15 s, quick about 9). The tests assert it was still flooding at the end.
  p.app.write(`!flood ${QUICK ? 262_144 : 524_288}\r`);
  await Bun.sleep(30);
  await p.app.press(KEY.left);
  await p.app.waitFor("GOT <ID-1>");
  const floor = (await measureFloor()).p50;
  const rows = await bursts(p, "agent", floor);
  const flooding = (() => {
    try {
      return !readFileSync(p.floodLog, "utf8").trim();
    } catch {
      return true;
    }
  })();
  return { p, floor, rows, flooding };
}

/** The bursts that went over a limit, one line each, for an assertion's message. */
function breaches(label: string, rows: Row[], singleLimit = NOTICEABLE_ADDED_MS, repeatLimit = singleLimit): string[] {
  return rows.flatMap((r) => (r.added95 > (r.rate === 25 ? repeatLimit : singleLimit) || r.b.drift > BURST_DRIFT_MS || r.b.seen < r.b.sent ? [`${label}, ${r.rate} keys/s: added p95 ${Math.round(r.added95)} ms (p50 ${Math.round(r.added50)}), drift ${Math.round(r.b.drift)} ms, ${r.b.sent - r.b.seen} lost`] : []));
}

describe.skipIf(!PERF)("perf: burst typing", () => {
  test("the harness floor: pty, xterm and polling, with the fake agent's TUI alone", async () => {
    const f = await measureFloor();
    m.add("typing.floor_p50_ms", f.p50, "ms", undefined, true);
    m.add("typing.floor_p95_ms", f.p95, "ms", undefined, true);
    m.add("typing.floor_max_ms", f.max, "ms", undefined, true);
    // The floor is only worth subtracting while it is small: a harness slower than this measures the machine.
    // (Windows' ConPTY puts the floor at about 30 ms: a validity check of the harness, not a perception limit.)
    expect(f.p50).toBeLessThan(WIN ? NOTICEABLE_ADDED_MS * 0.8 : NOTICEABLE_ADDED_MS / 2);
  }, 60_000);

  test("burst typing inside a session, with 1, 10 and 40 sessions open", async () => {
    const p = await perfApp(WIDE, 30);
    for (const n of COUNTS) {
      await openTo(p, n);
      await Bun.sleep(1500);
      const floor = (await measureFloor()).p50;
      // Not held on Windows (two ConPTYs breach the limit there, an accepted cost: BUG-616, `WIN_SESSION_ADDED_P95_MS` in `perf-kit.ts`;
      // the held ceiling for it is the p95 of a key in a session in `perf-smoke.e2e.test.ts`).
      record(`session.n${n}`, floor, await bursts(p, "agent", floor), !WIN);
    }
    p.app.kill();
  }, 900_000);

  // BUG-615 (QA-perf-01): every home frame measured the width of its text with string-width's slow emoji regex, so a
  // burst of keys queued at the home composer, with no sessions and worse with 10 and 40 (fixed by
  // `patches/string-width@8.3.0.patch`). Its own measurement, recorded without the baseline's ceilings.
  const homeBursts = async () => {
    const p = await perfApp(WIDE, 30);
    const worst: string[] = [];
    for (const n of HOME_COUNTS) {
      await openTo(p, n);
      await goHome(p);
      const floor = (await measureFloor()).p50;
      const rows = await bursts(p, "home", floor);
      record(`home.n${n}`, floor, rows, false);
      worst.push(...breaches(`${n} sessions`, rows, PLATFORM_ADDED_P95_MS, PLATFORM_REPEAT_ADDED_P95_MS));
    }
    p.app.kill();
    expect(worst, `typing latency at the home composer, over its limit (p95 added ${PLATFORM_ADDED_P95_MS} ms, ${PLATFORM_REPEAT_ADDED_P95_MS} at 25 keys/s):\n${worst.join("\n")}`).toEqual([]);
  };
  (WIN ? test.skip : test)("BUG-615/QA-perf-01: the home composer keeps typing latency under the noticeable limit, with no sessions and with 10 and 40", homeBursts, 900_000);
  // On Windows the bursts at the home composer stay over the accepted two-ConPTY ceiling (BUG-616). p95 added, 0 / 10 / 40 sessions,
  // production React build (2026-10-07): 50 / 51 / 119 ms at 12 keys/s and 111 / 122 / 156 ms at 25 keys/s. Open: the owner left it.
  (WIN && !QUICK ? test.failing : test.skip)("BUG-CANDIDATE/QA-perf-06: win32 home bursts (12 and 25 keys/s) exceed the accepted 80 ms ConPTY ceiling", homeBursts, 900_000);

  // Typing in a session while another floods (QA-perf-02: a candidate once, when the flood ended before the bursts did and
  // the measurement was of nothing; with a flood that lasts, a quiet Linux machine adds about 20 ms at p95, so it is no
  // bug there). The flood must still run when the bursts end, or the test is wrong.
  test("burst typing in a session while another session floods: no key is lost, none queues up, the latency stays under the noticeable limit", async () => {
    const { p, floor, rows, flooding } = await duringFlood();
    // On Windows two ConPTYs breach the limit with or without a flood (an accepted cost, BUG-616): recorded, not held.
    record("flood.session", floor, rows, !WIN);
    m.add("typing.flood.session.still_flooding", flooding ? 1 : 0, "keys", undefined, true);
    p.app.kill();
    expect(flooding, "the flood ended before the bursts did: make it longer").toBe(true);
    for (const r of rows) {
      expect(r.b.seen, `${r.rate} keys/s during a flood: keys lost`).toBe(r.b.sent);
      expect(r.b.drift, `${r.rate} keys/s during a flood: the keys queue up`).toBeLessThan(BURST_DRIFT_MS);
    }
    if (!WIN) {
      const worst = breaches("while another session floods", rows);
      expect(worst, `typing latency in a session during a flood, over the noticeable limit (${NOTICEABLE_ADDED_MS} ms added):\n${worst.join("\n")}`).toEqual([]);
    }
  }, 300_000);
});
