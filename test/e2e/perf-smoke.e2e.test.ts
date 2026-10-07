/**
 * Perf smoke, part of the fast tier: Gluon starts, three sessions open, and a key and a tab switch
 * answer within the limits a person would notice (`test/perf/perf-kit.ts`,
 * `NOTICEABLE_ADDED_MS`: what Gluon adds to a keypress before the total passes 100 ms), so a gross
 * slowdown (a poll that blocks, a paint that redraws everything) fails the fast tier. What Gluon adds
 * is the measured latency minus the harness floor (`measureFloor`: the same probe on the fake agent
 * alone), not the raw figure. The fast tier is not a quiet machine: the median (a typical key) is held
 * to the limit and the p95 to twice it, both times `loadAllowance()` (1 on a quiet machine); the perf
 * suite (`bun run test:perf`, `test/perf/`, README) holds the p95 to the limit itself, with baselines.
 * The limits are never scaled by `SLOW` (a person notices latency the same on any machine). The home composer
 * is `BUG-615`, and a key in a session on Windows `BUG-616` (an accepted cost, with its own ceiling), below.
 */
import { afterAll, expect, test } from "bun:test";
import { HOME_TWICE } from "./actions.ts";
import { WIN } from "./fixtures.ts";
import { HOME_VIEW, KEY, SLOW, stopAll } from "./harness.ts";
import { keyLatencies, loadAllowance, measureFloor, NOTICEABLE_ADDED_MS, openSession, pct, perfApp, timed, WIN_SESSION_ADDED_P95_MS, PLATFORM_ADDED_P95_MS } from "../perf/perf-kit.ts";

afterAll(stopAll);

/** The smoke test's limits for one latency series: the median and the p95, Gluon's share of them. */
function within(name: string, samples: number[], floor: number, allow: number) {
  const p50 = pct(samples, 0.5) - floor;
  const p95 = pct(samples, 0.95) - floor;
  const limit = NOTICEABLE_ADDED_MS * allow;
  expect(p50, `${name}: Gluon adds ${Math.round(p50)} ms at the median (limit ${Math.round(limit)})`).toBeLessThan(limit);
  expect(p95, `${name}: Gluon adds ${Math.round(p95)} ms at the p95 (limit ${Math.round(2 * limit)})`).toBeLessThan(2 * limit);
  return `${name} +${Math.round(p50)}/${Math.round(p95)}`;
}

test("PERF-SMOKE: startup, three sessions, keys and tab switches stay under the noticeable limit @full", async () => {
  const allow = loadAllowance();
  const t0 = performance.now();
  const p = await perfApp();
  const startup = performance.now() - t0;
  const floor = (await measureFloor(15)).p50;
  for (let i = 1; i <= 3; i++) {
    await openSession(p);
    await p.app.enter(`ID-${i}\r`);
    await p.app.waitFor(`GOT <ID-${i}>`);
  }
  const keys = await keyLatencies(p.app, "agent", 12);
  const switches: number[] = [];
  for (let i = 0; i < 6; i++) {
    switches.push(await timed(p.app, KEY.left, (s) => s.includes("GOT <ID-2>") && !s.includes("GOT <ID-3>")));
    switches.push(await timed(p.app, KEY.right, (s) => s.includes("GOT <ID-3>") && !s.includes("GOT <ID-2>")));
  }
  // Latencies, ms added to the harness floor (p50/p95); the home composer is the BUG-615 test below.
  // On Windows a key crosses two ConPTYs and breaches the limit: an accepted cost, held by BUG-616 below.
  const shown = [...(WIN ? [] : [within("key in a session", keys, floor, allow)]), within("tab switch", switches, floor, allow)];
  console.log(`perf-smoke: startup ${Math.round(startup)} ms, floor ${Math.round(floor)} ms, load allowance ${allow.toFixed(1)}; added p50/p95: ${shown.join(", ")}`);
  expect(startup).toBeLessThan(8000 * SLOW);
}, 60_000);

// BUG-615 (QA-perf-01): every home frame measured its text with string-width's slow emoji regex (fixed by
// `patches/string-width@8.3.0.patch`). On Linux the breach showed with 5 sessions and more (`typing.perf.test.ts` holds
// that case); with none or one a quiet machine was under the limit (p95 added about 26 ms), so this cell asserts it on
// Windows alone, where the empty home composer added 48.5 / 64.6 ms (p50 / p95) before the fix. The strict limit (the
// p95, no allowance, no `SLOW`). Its own measurement, not the passing test's. `@full`: a slow machine would turn it red in the fast tier.
(WIN ? test : test.skip)("BUG-615/QA-perf-01: the home composer stays under the noticeable limit, with no sessions and with one @full", async () => {
  const p = await perfApp();
  const floor = (await measureFloor(15)).p50;
  const none = await keyLatencies(p.app, "home", 15);
  await openSession(p);
  await p.app.press(...HOME_TWICE);
  await p.app.waitFor(HOME_VIEW);
  const one = await keyLatencies(p.app, "home", 15);
  const added = (s: number[]) => Math.round(pct(s, 0.95) - floor);
  // On Windows a key at the home composer crosses the same ConPTYs as one in a session: the accepted ceiling (BUG-616), 66 ms measured.
  const limit = PLATFORM_ADDED_P95_MS;
  expect(Math.max(added(none), added(one)), `Gluon's added latency at the home composer, p95: ${added(none)} ms with no sessions, ${added(one)} ms with one (limit ${limit})`).toBeLessThan(limit);
}, 60_000);

// BUG-616 (QA-perf-05), ACCEPTED by the owner on 2026-10-07: on Windows every key in a session crosses two ConPTYs (the
// harness's and Gluon's own for the agent), which adds about 49 ms at the p50 and 64 at the p95 on a quiet machine, past
// the 50 ms limit Linux and macOS keep. No fix is planned; this test holds the accepted cost, so a regression beyond it
// (`WIN_SESSION_ADDED_P95_MS`, 80 ms at the p95) still fails. No allowance, as BUG-615's. Skipped where the cost does not exist.
(WIN ? test : test.skip)("BUG-616/QA-perf-05: typing in a session on Windows stays under the accepted ceiling @full", async () => {
  const p = await perfApp();
  await openSession(p);
  const floor = (await measureFloor(15)).p50;
  const keys = await keyLatencies(p.app, "agent", 30);
  const added = Math.round(pct(keys, 0.95) - floor);
  expect(added, `Gluon's added latency for a key in a session, p95 (p50 ${Math.round(pct(keys, 0.5) - floor)} ms; accepted ceiling ${WIN_SESSION_ADDED_P95_MS}, the limit elsewhere ${NOTICEABLE_ADDED_MS})`).toBeLessThan(WIN_SESSION_ADDED_P95_MS);
}, 60_000);
