/**
 * The performance suite's kit (`bun run test:perf`; how-to in `test/e2e/README.md`): Gluon started
 * on the demo with the TUI fakes as the e2e scenarios do, latency probes that watch the screen
 * every millisecond (the harness's `press` waits for a quiet screen: it can't time anything), the
 * process tree's memory and CPU, and the metrics table with its baselines and ceilings.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAgents, freshConfig, WIN, type FakeAgent } from "../e2e/fixtures.ts";
import { ASK_YAML, EVENT_HOOK } from "../e2e/gluon-kit.ts";
import { App, HOME_VIEW, KEY, SLOW, start } from "../e2e/harness.ts";
import { HOME_TWICE } from "../e2e/actions.ts";

/** `bun run test:perf` sets it: the perf files skip themselves otherwise, so `bun test` never runs them. */
export const PERF = process.env.GLUON_PERF === "1";
/** Fewer sessions, fewer samples, short windows, no soak; only the absolute ceilings count (no baseline). */
export const QUICK = process.env.GLUON_PERF_QUICK === "1";
/** Rewrite this platform's entries of `baseline.json` with what this run measured. */
export const UPDATE = process.env.GLUON_PERF_UPDATE === "1";

const BASELINE = join(import.meta.dir, "baseline.json");
const PLATFORM = process.platform;

// ---------------------------------------------------------------------------------------------
// Metrics, baselines, ceilings

export type Unit = "ms" | "MB" | "%" | "MB/min" | "krows/s" | "keys";
/** What a run may exceed its baseline by before it fails, on top of 1.5x: noise below this means nothing. */
const SLACK: Record<Unit, number> = { ms: 15, MB: 30, "%": 4, "MB/min": 1, "krows/s": 0, keys: 0 };
/** How far above its baseline a metric may go. */
export const FACTOR = 1.5;

interface Row {
  name: string;
  value: number;
  unit: Unit;
  ceiling?: number;
  /** Informational: printed (and kept in the baseline) but never fails. */
  info?: boolean;
  /** A target, not a limit: the table says so when the value is above it, and nothing fails. */
  good?: number;
}

/** One file's metrics. `check()` prints the table and fails the test run that measured something above its limit. */
export class Metrics {
  private rows: Row[] = [];
  private static all: Metrics[] = [];
  constructor(readonly title: string) {
    Metrics.all.push(this);
  }

  /**
   * Records a metric (lower is better). `ceiling` is in the units of a developer's laptop: scaled by
   * `SLOW` (a slow machine waits longer), unless `perceived`: a limit a person feels (a key's latency, keys
   * queueing up) is the same on every machine, so a slow one breaches it and is not excused (`SLOW` is for waits).
   */
  add(name: string, value: number, unit: Unit, ceiling?: number, info = false, good?: number, perceived = false) {
    this.rows.push({ name, value: Math.round(value * 100) / 100, unit, ...(ceiling !== undefined ? { ceiling: perceived ? ceiling : ceiling * SLOW } : {}), ...(info ? { info } : {}), ...(good !== undefined ? { good } : {}) });
  }

  /** The limit a metric is held to, and why; null when nothing holds it. */
  private limit(r: Row, base: number | undefined): { limit: number; by: "baseline" | "ceiling" } | null {
    const fromBase = base !== undefined && !QUICK ? Math.max(base * FACTOR, base + SLACK[r.unit]) : undefined;
    if (fromBase !== undefined && (r.ceiling === undefined || fromBase <= r.ceiling)) return { limit: fromBase, by: "baseline" };
    return r.ceiling !== undefined ? { limit: r.ceiling, by: "ceiling" } : null;
  }

  /** Prints the table; throws listing every metric over its limit. */
  check() {
    if (!this.rows.length) return;
    const base = readBaseline()[PLATFORM] ?? {};
    const lines = [`\nperf: ${this.title} (${PLATFORM}${QUICK ? ", quick: ceilings only" : ""})`, `${"metric".padEnd(44)}${"value".padStart(10)}${"baseline".padStart(10)}${"limit".padStart(10)}  unit`];
    const bad: string[] = [];
    for (const r of this.rows) {
      const l = r.info ? null : this.limit(r, base[r.name]);
      const over = l && r.value > l.limit;
      lines.push(`${r.name.padEnd(44)}${String(r.value).padStart(10)}${String(base[r.name] ?? "-").padStart(10)}${(l ? `${Math.round(l.limit * 10) / 10}` : "-").padStart(10)}  ${r.unit}${over ? `   <-- OVER the ${l!.by}` : r.good !== undefined && r.value > r.good ? `   (above the good target, ${r.good})` : ""}`);
      if (over) bad.push(`${r.name} = ${r.value} ${r.unit} is over its ${l!.by} (${Math.round(l!.limit * 10) / 10})`);
    }
    console.log(lines.join("\n"));
    if (UPDATE) this.update();
    if (bad.length) throw new Error(`perf: ${bad.length} metric(s) over their limit:\n  ${bad.join("\n  ")}`);
  }

  private update() {
    if (QUICK) throw new Error("GLUON_PERF_UPDATE needs a full run: quick mode samples too little to be a baseline");
    const all = readBaseline();
    const mine = (all[PLATFORM] ??= {});
    for (const r of this.rows) mine[r.name] = r.value;
    writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(all).sort().map(([p, m]) => [p, Object.fromEntries(Object.entries(m).sort())])), null, 2)}\n`);
    console.log(`perf: baseline for ${PLATFORM} updated (${this.rows.length} metrics from ${this.title})`);
  }
}

type BaselineFile = Record<string, Record<string, number>>;
function readBaseline(): BaselineFile {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8")) as BaselineFile;
  } catch {
    return {};
  }
}

/** The p-th percentile (0..1, nearest rank) of samples. */
export function pct(samples: number[], p: number): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? NaN;
}

// ---------------------------------------------------------------------------------------------
// Gluon on the fakes

let n = 0;
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"];
const tmps: string[] = [];
process.on("exit", () => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/** A repo of its own for one app: its sessions' worktrees go in it, and no other app's. */
export function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gluon-perf-repo-"));
  tmps.push(dir);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "README.md"), "# perf\n");
  writeFileSync(join(dir, "package.json"), '{ "name": "perf", "type": "module" }\n');
  writeFileSync(join(dir, "src/math.ts"), "export const add = (a: number, b: number) => a - b;\n");
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "init"]]) Bun.spawnSync(["git", ...GIT, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  return dir;
}

export interface PerfApp {
  app: App;
  /** Sessions opened so far (the last one is shown, or home after `home()`). */
  sessions: number;
  /** The file the fake agents report the end of a `!flood` in (`FAKE_FLOOD_LOG`). */
  floodLog: string;
}

/**
 * What every Gluon the perf suite and the perf smoke start gets (`perfApp`, `startup` in `latency.perf.test.ts`): the production React build.
 * Every shipped build (`scripts/build.ts`, `pack.ts`) defines `process.env.NODE_ENV` as "production"; from source React runs its development
 * build (jsx checks, owner stacks, `Error` objects per element), which is slower and not what a user runs. Decided 2026-10-07 (QA-perf-01).
 */
export const GLUON_PERF_ENV = { NODE_ENV: "production" } as const;

/** Gluon on the demo with the `claude` TUI fake alone on PATH. */
export async function perfApp(cols = 120, rows = 30, env: Record<string, string> = {}): Promise<PerfApp> {
  const id = `perf-${process.pid}-${++n}`;
  const dir = mkdtempSync(join(tmpdir(), "gluon-perf-"));
  tmps.push(dir);
  const floodLog = join(dir, "flood.log");
  const app = await start({ cwd: freshRepo(), cols, rows, agents: ["claude" satisfies FakeAgent], env: { GLUON_CONFIG: freshConfig(id, ASK_YAML), FAKE_TUI: "1", FAKE_EVENT_HOOK: EVENT_HOOK, FAKE_FLOOD_LOG: floodLog, ...GLUON_PERF_ENV, ...env } });
  return { app, sessions: 0, floodLog };
}

const inFrame = (s: string) => s.includes("TUI ready") && s.includes("◆ gluon");

/**
 * Walks the demo to a new session, going home first when one is shown (a lean `openSessions`: no
 * idle waits, so the time is the app's). Returns how long it took, in ms.
 */
export async function openSession(p: PerfApp, label = "perf"): Promise<number> {
  const { app } = p;
  const t0 = performance.now();
  if (p.sessions > 0 && !HOME_VIEW.test(app.screen())) {
    await app.press(...HOME_TWICE);
    await app.waitFor(HOME_VIEW);
  }
  await app.enter(`${label} ${++p.sessions}`);
  await app.press(KEY.enter);
  await app.waitFor((s) => s.replace(/\s+/g, " ").includes("Should the fix include a regression test"), 30_000);
  await app.press(KEY.enter);
  await app.waitFor("keep talking", 30_000);
  await app.press(KEY.enter);
  await app.waitFor(inFrame, 30_000);
  return performance.now() - t0;
}

/** Types `line` into the shown session's agent and waits for its answer (`GOT <line>`). */
export async function tell(app: App, line: string) {
  await app.type(line);
  await app.press(KEY.enter);
  await app.waitFor(`GOT <${line}>`);
}

// ---------------------------------------------------------------------------------------------
// Latency

/** Milliseconds from now until `ok(screen)` holds, polled every millisecond; throws after `limitMs`. */
export async function until(app: App, ok: (screen: string) => boolean, limitMs = 15_000): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    if (ok(app.screen())) return performance.now() - t0;
    if (performance.now() - t0 > limitMs * SLOW) throw new Error(`perf: timed out; screen:\n${app.screen()}`);
    await Bun.sleep(1);
  }
}

/** Writes `bytes` and times until `ok(screen)` holds: the app's answer to the keys, as a person would see it. */
export async function timed(app: App, bytes: string, ok: (screen: string) => boolean, limitMs?: number): Promise<number> {
  const t0 = performance.now();
  app.write(bytes);
  await until(app, ok, limitMs);
  return performance.now() - t0;
}

/** What the home view's composer holds when a key was typed / nothing is typed. */
export const HOME_TYPED = (s: string) => s.includes("› x");
/** The fake `claude`'s input line holding / not holding the typed key. */
export const AGENT_TYPED = (s: string) => /❯ x/.test(s);

/**
 * `pairs` times: types `x` and waits for it on screen, then Backspace and waits for it to go; the
 * latencies of all the keys, in ms. Spaced `gapMs` apart after the frame: 60 ms is 16 keys a second, faster
 * than anyone types steadily. A shorter gap puts a key inside Ink's 33 ms render throttle (`maxFps` 30), which
 * adds up to a frame to it: burst typing (`burstType`) is what measures that on purpose.
 */
export async function keyLatencies(app: App, kind: "home" | "agent", pairs: number, gapMs = 60): Promise<number[]> {
  const typed = kind === "home" ? HOME_TYPED : AGENT_TYPED;
  const out: number[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push(await timed(app, "x", typed));
    await Bun.sleep(gapMs);
    out.push(await timed(app, KEY.backspace, (s) => !typed(s)));
    await Bun.sleep(gapMs);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Processes: memory and CPU of Gluon and what it started

export interface Proc {
  pid: number;
  ppid: number;
  rssKB: number;
  /** CPU seconds used so far. */
  cpu: number;
  /** The command's name. */
  comm: string;
}

/** Whether process figures can be read here (Linux's /proc, macOS's ps). */
export const CAN_MEASURE_PROCS = PLATFORM === "linux" || PLATFORM === "darwin";

/** Every process, from /proc (Linux) or `ps` (macOS). */
export function processes(): Map<number, Proc> {
  const all = new Map<number, Proc>();
  if (PLATFORM === "linux") {
    const ticks = 100; // CLK_TCK, always 100 on Linux
    const page = 4096;
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        // `pid (comm) S ppid …`: comm may hold spaces and parentheses.
        const close = stat.lastIndexOf(")");
        const f = stat.slice(close + 2).split(" ");
        const comm = stat.slice(stat.indexOf("(") + 1, close);
        // After comm: state(0) ppid(1) … utime(11) stime(12) … rss in pages is field 21 here.
        all.set(Number(name), { pid: Number(name), ppid: Number(f[1]), cpu: (Number(f[11]) + Number(f[12])) / ticks, rssKB: (Number(f[21]) * page) / 1024, comm });
      } catch {
        // exited meanwhile
      }
    }
  } else if (PLATFORM === "darwin") {
    const r = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,rss=,cputime=,comm="], { stdout: "pipe", stderr: "pipe" });
    for (const line of r.stdout.toString().split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const parts = m[4]!.split(":").map(Number);
      const cpu = parts.reduce((acc, v) => acc * 60 + v, 0);
      all.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), cpu, comm: m[5]! });
    }
  }
  return all;
}

/** Gluon (`pid`) and all it started, directly or not. */
export function tree(pid: number, all = processes()): Proc[] {
  const out: Proc[] = [];
  const todo = [pid];
  while (todo.length) {
    const p = todo.pop()!;
    const me = all.get(p);
    if (me) out.push(me);
    for (const q of all.values()) if (q.ppid === p) todo.push(q.pid);
  }
  return out;
}

export interface Footprint {
  /** Gluon's own resident memory, MB. */
  self: number;
  /** Everything Gluon started (the agents), MB. */
  children: number;
  total: number;
  /** How many processes Gluon has started. */
  count: number;
  /** Seconds of CPU used so far by Gluon alone, and by all of them. */
  cpuSelf: number;
  cpuAll: number;
}

export function footprint(pid: number): Footprint {
  const procs = tree(pid);
  const self = procs.find((p) => p.pid === pid);
  const kids = procs.filter((p) => p.pid !== pid);
  const mb = (kb: number) => Math.round((kb / 1024) * 10) / 10;
  const cpuAll = procs.reduce((a, p) => a + p.cpu, 0);
  return { self: mb(self?.rssKB ?? 0), children: mb(kids.reduce((a, p) => a + p.rssKB, 0)), total: mb(procs.reduce((a, p) => a + p.rssKB, 0)), count: kids.length, cpuSelf: self?.cpu ?? 0, cpuAll };
}

/** CPU use over `ms` of an idle app, in percent of one core: [Gluon alone, Gluon and its children]. */
export async function idleCpu(pid: number, ms: number): Promise<[number, number]> {
  const a = footprint(pid);
  const t0 = performance.now();
  await Bun.sleep(ms);
  const b = footprint(pid);
  const s = (performance.now() - t0) / 1000;
  const round = (v: number) => Math.round(v * 10) / 10;
  return [round(((b.cpuSelf - a.cpuSelf) / s) * 100), round(((b.cpuAll - a.cpuAll) / s) * 100)];
}

/** Least-squares slope of (x, y) points, in y per x. */
export function slope(points: [number, number][]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) (num += (x - mx) * (y - my)), (den += (x - mx) ** 2);
  return den ? num / den : 0;
}

// ---------------------------------------------------------------------------------------------
// Perception: what a person notices, and what is Gluon's share of it

/**
 * Keypress to visible character, in ms, as a person experiences it. The research and the arithmetic
 * are in `test/e2e/README.md` ("Performance suite"). Sources: Boyle and Lanzetta 1984 (typing a string:
 * a display delay is noticed at about 100 ms), Nielsen's 0.1 s, Forch et al. 2017 (mean threshold 65 ms,
 * median 54), Deber et al. 2015 (indirect input 55 to 96 ms), Dan Luu's keyboard and terminal tables.
 */
export const NOTICEABLE_TOTAL_MS = 100;
/** A fast setup's total (about 20 ms of keyboard and terminal) stays under the median threshold, 54 ms. */
export const GOOD_TOTAL_MS = 50;
/** What the user's keyboard (median 30 ms, Luu) and terminal emulator (6 to 44 ms idle, about 20 typical, Luu) add before Gluon's share. */
export const TERMINAL_PIPELINE_MS = 50;
/**
 * What Gluon (with the agent's echo) may add to a keypress, p95: the limit above which the total
 * reaches `NOTICEABLE_TOTAL_MS` on a typical keyboard and terminal. Measured as the total minus the
 * harness floor (`measureFloor`), so the figure is Gluon's, not the pty's or xterm's. Tests fail above it.
 */
export const NOTICEABLE_ADDED_MS = NOTICEABLE_TOTAL_MS - TERMINAL_PIPELINE_MS;
/**
 * BUG-616 (QA-perf-05; the owner accepted it on 2026-10-07): on Windows a key in a session crosses two ConPTYs (the
 * harness's own and Gluon's for the agent), which adds about 49 ms at the p50 and 64 at the p95 over the floor, past
 * `NOTICEABLE_ADDED_MS`. This is the p95 ceiling that encodes that accepted cost, for a key in a session on win32 (a
 * regression beyond it still fails); Linux and macOS keep `NOTICEABLE_ADDED_MS`.
 */
export const WIN_SESSION_ADDED_P95_MS = 80;
/**
 * The p95 limit for a single key on this platform: the perception limit, or on Windows the accepted ceiling above. Used for a key in a
 * session and for one at the home composer: both cross the same ConPTY(s) there (measured on Windows: 64 ms in a session, 66 at home).
 */
export const PLATFORM_ADDED_P95_MS = WIN ? WIN_SESSION_ADDED_P95_MS : NOTICEABLE_ADDED_MS;
/**
 * The p95 limit for the home composer at 25 keys a second (key repeat), decided 2026-10-07: looser than `NOTICEABLE_ADDED_MS`
 * because Ink renders at most 30 times a second (`maxFps`, a throttle of about 34 ms): a key that lands just after a frame waits
 * for the next one. Gluon stays at Ink's 30 fps; single keys and 12 keys a second keep the 50 ms limit. Measured on quiet Linux: 44 / 51 / 54 ms
 * with 0 / 10 / 40 sessions.
 */
export const HOME_REPEAT_ADDED_P95_MS = 60;
/** The same at 25 keys a second on this platform: `HOME_REPEAT_ADDED_P95_MS`, or the accepted Windows ceiling when that is higher (BUG-616). */
export const PLATFORM_REPEAT_ADDED_P95_MS = Math.max(HOME_REPEAT_ADDED_P95_MS, PLATFORM_ADDED_P95_MS);
/** The target, p50: a typical setup stays under 75 ms, a fast one under `GOOD_TOTAL_MS`. Printed, never fails. */
export const GOOD_ADDED_MS = 25;
/**
 * CPU contention right now, in percent: Linux's pressure stall figure (`some`, last 10 s: the share
 * of time a runnable task waited for a core), else the one-minute load average per core. 0 on Windows. The figure
 * is printed with every typing measurement: latencies on a contended machine (above ~5) say little.
 */
export function cpuPressure(): number {
  try {
    const m = /some avg10=([\d.]+)/.exec(readFileSync("/proc/pressure/cpu", "utf8"));
    if (m) return Number(m[1]);
  } catch {
    // no pressure file (macOS, old kernels)
  }
  return (loadavg()[0]! / Math.max(1, cpus().length)) * 50;
}

/**
 * How much more the fast tier's smoke test lets a figure be on a busy machine: 1 while the CPU pressure
 * is under 5 %, then growing with it (1 more per 10 points, at most 4). The real limits are the perf
 * suite's, run serially on a machine of its own; the smoke test shares the machine with two other e2e
 * processes and with whatever else the developer runs.
 */
export function loadAllowance(): number {
  return Math.min(4, Math.max(1, 1 + (cpuPressure() - 5) / 10));
}

/** Typing may not queue up: the last fifth of a burst's keys may be this much slower (median) than the first fifth. */
export const BURST_DRIFT_MS = 25;

/**
 * The harness's own share of a measured latency: the pty, the headless xterm, the polling every
 * millisecond, and the fake agent's echo, measured the same way (`keyLatencies`) on the fake `claude`'s
 * TUI alone in the pty, with Gluon not in between. Gluon's added latency is the measured one minus
 * this median (the median, not the tail: the tail is load, and a load spike during a test counts
 * against Gluon on purpose, as it would for the user). Taken fresh by each test: the machine's load changes.
 */
export async function measureFloor(pairs = 40): Promise<{ p50: number; p95: number; max: number }> {
  const dir = mkdtempSync(join(tmpdir(), "gluon-perf-floor-"));
  tmps.push(dir);
  const app = new App({ cwd: dir, cols: 120, rows: 30, agents: ["claude"], argv: [join(fakeAgents(["claude"]), "claude")], env: { FAKE_TUI: "1" } });
  try {
    await app.waitFor("TUI ready", 15_000);
    const s = await keyLatencies(app, "agent", pairs);
    return { p50: pct(s, 0.5), p95: pct(s, 0.95), max: Math.max(...s) };
  } finally {
    app.kill();
  }
}

/**
 * Records a latency percentile twice: as measured (`name`, held to its baseline only, as before) and as
 * Gluon's share (`name` with `_ms` -> `_added_ms`: the measured value minus the floor, held to the
 * noticeable limit when it is a p95 and compared with the good target when it is a p50). `held` false: only
 * recorded (a known defect, whose own `test.failing` asserts the limit).
 */
export function addLatency(m: Metrics, name: string, value: number, floor: number, tail: boolean, held = true, limit = NOTICEABLE_ADDED_MS) {
  m.add(name, value, "ms");
  m.add(name.replace(/_ms$/, "_added_ms"), value - floor, "ms", tail && held ? limit : undefined, !held, tail ? undefined : GOOD_ADDED_MS, true);
}

export interface Burst {
  /** Key to visible character, one per key seen, in ms. */
  lat: number[];
  sent: number;
  seen: number;
  p50: number;
  p95: number;
  max: number;
  /** The median latency of the last fifth of the keys minus that of the first fifth: queueing shows as growth. */
  drift: number;
  /** The last key's latency. */
  last: number;
}

/** The letters a burst types (`[a-z]` only: nothing a composer or a menu takes as a command). */
const burstText = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join("");

/** The typed line shown by the home composer (`› abc`) or a fake agent's input (`❯ abc`): the last such line on the screen. */
const shownLine = (screen: string): string => {
  const m = [...screen.matchAll(/^[\s│]*[›❯] ([a-z]*)/gm)].at(-1);
  return m?.[1] ?? "";
};

/**
 * Types continuously, `rate` keys a second for `seconds`, at the clock's pace (a key is written when it
 * is due, however long the last took to show), and times each key from its write to the screen
 * showing it. The screen is read every millisecond; a key counts as seen when the line shown holds
 * it and all the keys before it. The line must not wrap: at most about 100 keys on a 120-column terminal.
 */
export async function burstType(app: App, rate: number, seconds: number): Promise<Burst> {
  const n = Math.round(rate * seconds);
  const text = burstText(n);
  const period = 1000 / rate;
  const sentAt: number[] = [];
  const seenAt: number[] = [];
  const t0 = performance.now();
  const end = t0 + n * period + 4000 * SLOW;
  for (;;) {
    const now = performance.now();
    while (sentAt.length < n && now >= t0 + sentAt.length * period) {
      sentAt.push(performance.now());
      app.write(text[sentAt.length - 1]!);
    }
    const line = shownLine(app.screen());
    let k = 0;
    while (k < line.length && k < sentAt.length && line[k] === text[k]) k++;
    const at = performance.now();
    while (seenAt.length < k) seenAt.push(at);
    if (seenAt.length >= n || at > end) break;
    await Bun.sleep(1);
  }
  const lat = seenAt.map((t, i) => t - sentAt[i]!);
  const fifth = Math.max(1, Math.floor(lat.length / 5));
  return {
    lat,
    sent: sentAt.length,
    seen: seenAt.length,
    p50: pct(lat, 0.5),
    p95: pct(lat, 0.95),
    max: Math.max(...lat),
    drift: lat.length ? pct(lat.slice(-fifth), 0.5) - pct(lat.slice(0, fifth), 0.5) : NaN,
    last: lat.at(-1) ?? NaN,
  };
}

/** Empties the line a burst typed (Esc Esc clears the home composer; Ctrl+U the fake agent's input), so the next burst starts from nothing. */
export async function clearLine(app: App, kind: "home" | "agent") {
  if (kind === "agent") app.write("\x15");
  else {
    app.write("\x1b");
    await Bun.sleep(120);
    app.write("\x1b");
  }
  // The home composer's placeholder is letters too: "cleared" is not starting with the burst's first letter.
  await until(app, (s) => shownLine(s)[0] !== burstText(1));
  await Bun.sleep(150);
}
