/**
 * `bun run regression`'s live stage (issue #31): after the offline stages pass, the live checks the change needs (`liveChecks`,
 * test/areas.ts) run for real, on the pinned harness binaries (`--newest`: the newest releases), with the user's own credentials:
 * a plan first when its harness is signed in to it, then Bedrock, then an API key (scripts/live-lib.ts `pickConn`).
 *
 * - The whole stage spends at most `REGRESSION_LIVE_RUN_CAP` ($0.50): each check is told what is left (`--run-cap`), and what it
 *   spent is read back from the stage's ledger. There is no monthly cap. A check the money doesn't reach is a SKIP.
 * - A check that passed is not paid for again while nothing it depends on changed: its result is kept in qa/logs/live-cache.json
 *   under a hash of src/, the live scripts and the harness version. Only a pass is kept.
 * - Never in CI (`CI` set), never offline, never after a failed stage; without credentials each check SKIPs. A SKIP never fails
 *   the run; a FAIL does. Checks never retry (a retry costs money).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Harness } from "../src/harnesses.ts";
import type { LiveCheck } from "../test/areas.ts";
import { readPin, resolveNewest } from "./harness-cache.ts";
import { REGRESSION_LIVE_LEDGER, REGRESSION_LIVE_RUN_CAP, type LedgerFile } from "./live-lib.ts";

export const LIVE_CACHE = "qa/logs/live-cache.json";
/** Below this, nothing more is started: no check is that cheap. */
const MIN_LEFT = 0.005;

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

/** What the runs a check appended to the ledger cost (the ledger's runs after the first `from`). */
export function spentSince(ledger: string, from: number): number {
  if (!existsSync(ledger)) return 0;
  const f = JSON.parse(readFileSync(ledger, "utf8")) as LedgerFile;
  return f.runs.slice(from).flatMap((r) => r.calls).reduce((a, c) => a + c.usd, 0);
}
const ledgerRuns = (ledger: string) => (existsSync(ledger) ? (JSON.parse(readFileSync(ledger, "utf8")) as LedgerFile).runs.length : 0);

export interface StageOptions {
  root: string;
  newest?: boolean;
  env?: Record<string, string | undefined>;
  /** Runs one check (`bun scripts/live.ts …`): its exit code and output. */
  run(args: string[]): Promise<{ code: number; out: string }>;
  /** Whether the network is there. */
  online(): Promise<boolean>;
  /** The harness's version a check runs (the pin's, or the newest release's). */
  version?(h: Harness, newest: boolean): Promise<string>;
  say(line: string): void;
}

export async function liveStage(checks: LiveCheck[], o: StageOptions): Promise<{ failed: boolean; spent: number }> {
  const env = o.env ?? process.env;
  if (!checks.length) return { failed: false, spent: 0 };
  const names = checks.map((c) => `${c.kind} ${c.harness}`).join(", ");
  if (env.CI) {
    o.say(`── live: not in CI (local only) · would run: ${names}`);
    return { failed: false, spent: 0 };
  }
  if (!(await o.online())) {
    o.say(`── live: SKIP (offline) · would run: ${names}`);
    return { failed: false, spent: 0 };
  }
  const cachePath = join(o.root, LIVE_CACHE);
  const ledger = join(o.root, REGRESSION_LIVE_LEDGER);
  const cache: CacheFile = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const version = o.version ?? (async (h: Harness, newest: boolean) => (newest ? (await resolveNewest([h], undefined, []))[h]!.version : readPin()[h].version));
  let left = REGRESSION_LIVE_RUN_CAP;
  let failed = false;
  o.say(`── live: ${names} (at most $${REGRESSION_LIVE_RUN_CAP.toFixed(2)} in all; a pass is kept until src/ or the harness changes)`);
  for (const c of checks) {
    const label = `live ${c.kind} ${c.harness}`;
    const v = await version(c.harness as Harness, !!o.newest).catch(() => "unknown");
    const key = liveKey(c, v, o.root);
    const hit = cache[key];
    if (hit) {
      o.say(`── ${label} ${v}: ok (passed ${hit.at.slice(0, 16).replace("T", " ")} on this code; $0 now)`);
      continue;
    }
    if (left < MIN_LEFT) {
      o.say(`── ${label} ${v}: SKIP (this run's $${REGRESSION_LIVE_RUN_CAP.toFixed(2)} is spent)`);
      continue;
    }
    const from = ledgerRuns(ledger);
    const args = ["--regression-stage", `--run-cap=${left.toFixed(4)}`, `--tier=${c.kind}`, `--harness=${c.harness}`, ...(o.newest ? ["--newest"] : [])];
    const r = await o.run(args);
    const spent = spentSince(ledger, from);
    left -= spent;
    const verdict = parseVerdict(r.out);
    const passed = r.code === 0 && !!verdict && verdict.pass > 0 && verdict.fail === 0;
    const status = r.code === 1 ? "FAILED" : r.code === 2 ? "SKIP (the cap stopped it)" : passed ? "ok" : "SKIP (nothing could run here)";
    o.say(`── ${label} ${v}: ${status} · $${spent.toFixed(4)}${verdict ? ` · PASS ${verdict.pass} · FAIL ${verdict.fail} · SKIP ${verdict.skip}` : ""}`);
    const lines = r.out.split("\n").filter((l) => (r.code === 1 ? l.trim() : /^(PASS|FAIL|SKIP) /.test(l)));
    for (const l of lines) o.say(`   ${l}`);
    if (r.code === 1) failed = true;
    if (passed) cache[key] = { at: new Date().toISOString(), check: `${c.kind} ${c.harness}`, version: v, usd: spent };
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 1)}\n`);
  const spent = REGRESSION_LIVE_RUN_CAP - left;
  o.say(`── live: $${spent.toFixed(4)} spent this run (ledger ${REGRESSION_LIVE_LEDGER})`);
  return { failed, spent };
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
