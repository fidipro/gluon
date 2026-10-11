/**
 * `bun run regression`'s live stage (issue #31): after the offline stages pass, the live checks the change needs (`liveChecks`,
 * test/areas.ts) run for real, on the pinned harness binaries (`--newest`: the newest releases), with the user's own credentials:
 * Bedrock first, then a plan its harness is signed in to, then an API key (scripts/live-lib.ts `pickConn`).
 *
 * - The stage is capped per run and per bucket (`REGRESSION_LIVE_CAPS`: plans in tokens; Bedrock, OpenRouter and API keys in
 *   dollars; no monthly cap). The checks run at once (`LIVE_PARALLEL`) and share one budget (`StageBudget`, in the run's
 *   `--stage-dir`): each reserves a call's worst case before it. A check over a cap is a SKIP that says so: the user is asked, and
 *   `--live-caps` raises a cap for one run. Each check keeps its own ledger there; the stage merges them into its ledger.
 * - A check that passed is not paid for again while nothing it depends on changed: its result is kept in qa/logs/live-cache.json
 *   under a hash of src/, the live scripts and the harness version. Only a pass is kept.
 * - Never in CI (`CI` set), never offline, never after a failed stage; without credentials each check SKIPs. A SKIP never fails
 *   the run; a FAIL does. Checks never retry (a retry costs money).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Harness } from "../src/harnesses.ts";
import type { LiveCheck } from "../test/areas.ts";
import { availableGB } from "./e2e-concurrency.ts";
import { readPin, resolveNewest } from "./harness-cache.ts";
import { describeStageCaps, mergeLedgers, REGRESSION_LIVE_CAPS, REGRESSION_LIVE_LEDGER, STAGE_BUCKETS, StageBudget, stageLedgerName, stageUse, type LedgerFile, type StageCaps } from "./live-lib.ts";

export const LIVE_CACHE = "qa/logs/live-cache.json";

type CacheFile = Record<string, { at: string; check: string; version: string; usd: number }>;

/** What a check's result depends on: the code under test, the live scripts and the harness's version. */
export function liveKey(c: LiveCheck, version: string, root: string): string {
  const h = new Bun.CryptoHasher("sha256").update(`${c.kind} ${c.harness} ${version}\n`);
  const files = [...new Bun.Glob("src/**/*").scanSync({ cwd: root, onlyFiles: true }), ...new Bun.Glob("scripts/{live*,harness-cache}.ts").scanSync({ cwd: root })].sort();
  for (const f of files) h.update(`${f}\0`).update(readFileSync(join(root, f))).update("\0");
  return h.digest("hex");
}

/** "PASS 3 · FAIL 0 · SKIP 1" from a live run's last verdict line. */
export function parseVerdict(out: string): { pass: number; fail: number; skip: number } | null {
  const m = [...out.matchAll(/PASS (\d+) · FAIL (\d+) · SKIP (\d+)/g)].at(-1);
  return m ? { pass: Number(m[1]), fail: Number(m[2]), skip: Number(m[3]) } : null;
}

/** What a check's own ledger (the stage's directory) says it used, per bucket. */
export function usedBy(ledger: string): StageCaps {
  if (!existsSync(ledger)) return stageUse([]);
  return stageUse((JSON.parse(readFileSync(ledger, "utf8")) as LedgerFile).runs.flatMap((r) => r.calls));
}
const dollars = (u: StageCaps) => u.bedrock + u.openrouter + u.keys;
/** Checks at once, at most: each is a Gluon and a harness in a tmux of its own, waiting on a model most of the time. */
export const LIVE_PARALLEL = 4;
/** What one check in flight costs: Gluon, the real harness, tmux and the driver, ~1.4 GB of RSS measured (5.7 GB for 4). */
export const GB_PER_LIVE_CHECK = 1.5;
/** `GLUON_LIVE_PARALLEL` when set, else `LIVE_PARALLEL` or what the free memory holds, at least 1. */
export function liveParallel(env: Record<string, string | undefined> = process.env, freeGB = availableGB()): number {
  const set = Math.floor(Number(env.GLUON_LIVE_PARALLEL));
  if (set >= 1) return set;
  return Math.max(1, Math.min(LIVE_PARALLEL, Math.floor(freeGB / GB_PER_LIVE_CHECK)));
}

export interface StageOptions {
  root: string;
  newest?: boolean;
  /** This run's caps (`--live-caps`, after the user agreed), else `REGRESSION_LIVE_CAPS`. */
  caps?: StageCaps;
  env?: Record<string, string | undefined>;
  /** Runs one check (`bun scripts/live.ts …`): its exit code and output. */
  run(args: string[]): Promise<{ code: number; out: string }>;
  /** Whether the network is there. */
  online(): Promise<boolean>;
  /** The harness's version a check runs (the pin's, or the newest release's). */
  version?(h: Harness, newest: boolean): Promise<string>;
  /** Checks at once (default: `liveParallel`). */
  parallel?: number;
  say(line: string): void;
}

export async function liveStage(checks: LiveCheck[], o: StageOptions): Promise<{ failed: boolean; spent: number; planTokens: number }> {
  const env = o.env ?? process.env;
  if (!checks.length) return { failed: false, spent: 0, planTokens: 0 };
  const names = checks.map((c) => `${c.kind} ${c.harness}`).join(", ");
  if (env.CI) {
    o.say(`── live: not in CI (local only) · would run: ${names}`);
    return { failed: false, spent: 0, planTokens: 0 };
  }
  if (!(await o.online())) {
    o.say(`── live: SKIP (offline) · would run: ${names}`);
    return { failed: false, spent: 0, planTokens: 0 };
  }
  const cachePath = join(o.root, LIVE_CACHE);
  const cache: CacheFile = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const version = o.version ?? (async (h: Harness, newest: boolean) => (newest ? (await resolveNewest([h], undefined, []))[h]!.version : readPin()[h].version));
  const caps = o.caps ?? REGRESSION_LIVE_CAPS;
  const parallel = Math.max(1, o.parallel ?? liveParallel(env));
  // The run's directory: the budget its checks share (each reserves a call's worst case under a lock) and each check's own ledger.
  const dir = mkdtempSync(join(tmpdir(), "gluon-live-stage-"));
  StageBudget.create(join(dir, "budget.json"), caps);
  let failed = false;
  const total = stageUse([]);
  o.say(`── live: ${names} (caps this run: ${describeStageCaps(caps)}; ${parallel} at once; a pass is kept until src/ or the harness changes)`);
  const one = async (c: LiveCheck) => {
    const label = `live ${c.kind} ${c.harness}`;
    const v = await version(c.harness as Harness, !!o.newest).catch(() => "unknown");
    const key = liveKey(c, v, o.root);
    const hit = cache[key];
    if (hit) {
      o.say(`── ${label} ${v}: ok (passed ${hit.at.slice(0, 16).replace("T", " ")} on this code; $0 now)`);
      return;
    }
    const r = await o.run(["--regression-stage", `--stage-dir=${dir}`, `--tier=${c.kind}`, `--harness=${c.harness}`, ...(o.newest ? ["--newest"] : [])]);
    const used = usedBy(join(dir, stageLedgerName(c.kind, c.harness)));
    for (const b of STAGE_BUCKETS) total[b] += used[b];
    const spent = dollars(used);
    const verdict = parseVerdict(r.out);
    const passed = r.code === 0 && !!verdict && verdict.pass > 0 && verdict.fail === 0;
    const capped = r.code === 2 || /over what is left of its cap/.test(r.out);
    const status = r.code === 1 ? "FAILED" : capped ? "SKIP (over this run's cap: ask the user before raising it with --live-caps)" : passed ? "ok" : "SKIP (nothing could run here)";
    // One block per check, printed whole as it ends (they run at once).
    const lines = r.out.split("\n").filter((l) => (r.code === 1 ? l.trim() : /^(PASS|FAIL|SKIP) /.test(l)));
    o.say([`── ${label} ${v}: ${status} · $${spent.toFixed(4)}${used.plans ? ` · ${used.plans} plan tokens` : ""}${verdict ? ` · PASS ${verdict.pass} · FAIL ${verdict.fail} · SKIP ${verdict.skip}` : ""}`, ...lines.map((l) => `   ${l}`)].join("\n"));
    if (r.code === 1) failed = true;
    if (passed) cache[key] = { at: new Date().toISOString(), check: `${c.kind} ${c.harness}`, version: v, usd: spent };
  };
  const queue = [...checks];
  try {
    await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) await one(c);
    }));
  } finally {
    mergeLedgers(join(o.root, REGRESSION_LIVE_LEDGER), checks.map((c) => join(dir, stageLedgerName(c.kind, c.harness))));
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 1)}\n`);
  const spent = dollars(total);
  o.say(`── live: $${spent.toFixed(4)} spent this run (Bedrock $${total.bedrock.toFixed(4)} · OpenRouter $${total.openrouter.toFixed(4)} · API keys $${total.keys.toFixed(4)}) · ${total.plans} plan tokens (ledger ${REGRESSION_LIVE_LEDGER})`);
  return { failed, spent, planTokens: total.plans };
}

/** Whether the network is there: one small GET, 3 s at most. */
export async function online(): Promise<boolean> {
  try {
    await fetch("https://registry.npmjs.org/-/ping", { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}
