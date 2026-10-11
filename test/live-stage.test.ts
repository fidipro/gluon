/**
 * `bun run regression`'s live stage (scripts/live-stage.ts, issue #31): the caps per run and per bucket, what each check is told is left, the
 * cache that keeps a pass until the code or the harness changes, and when the stage never runs (CI, offline). Offline: each check's
 * run is a function here that writes the ledger the way `scripts/live.ts --regression-stage` does.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NO_BUCKET_CAPS, REGRESSION_LIVE_LEDGER, Spend, StageBudget, stageLedgerName, type Bucket, type LedgerFile, type StageCaps } from "../scripts/live-lib.ts";
import { LIVE_CACHE, liveKey, liveParallel, liveStage, parseVerdict, type StageOptions } from "../scripts/live-stage.ts";
import type { LiveCheck } from "./areas.ts";

const J: LiveCheck = { kind: "journey", harness: "claude-code" };
const H = (h: string): LiveCheck => ({ kind: "harness", harness: h });

/** A root with a src/ file and a live script (what the cache key reads). */
function root(): string {
  const r = mkdtempSync(join(tmpdir(), "live-stage-"));
  mkdirSync(join(r, "src"));
  mkdirSync(join(r, "scripts"));
  writeFileSync(join(r, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(r, "scripts", "live.ts"), "// live\n");
  return r;
}

/**
 * Each check's run, as `scripts/live.ts --regression-stage --stage-dir` does it: reserves `worst[i]` (default: what it spends) of
 * `bucket[i]` (API keys by default) from the shared budget, charges `usd[i]` (or `tokens[i]` on a plan) into its own ledger, and
 * answers `codes[i]` with a verdict line (a refused reservation: exit 2 and the refusal); records the args and the budget it saw.
 */
function runner(plan: { usd: number; code: number; verdict?: string; bucket?: Bucket; tokens?: number; worst?: number }[]) {
  const calls: string[][] = [];
  const lefts: StageCaps[] = [];
  const run: StageOptions["run"] = async (args) => {
    const p = plan[calls.length] ?? { usd: 0, code: 0, verdict: "PASS 1 · FAIL 0 · SKIP 0" };
    calls.push(args);
    const dir = args.find((a) => a.startsWith("--stage-dir="))!.slice("--stage-dir=".length);
    const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))!.split("=")[1];
    const budget = new StageBudget(join(dir, "budget.json"));
    lefts.push(budget.left());
    const spend = new Spend(join(dir, stageLedgerName(flag("tier"), flag("harness"))), NO_BUCKET_CAPS, Infinity, false, true, budget);
    const bucket = p.bucket ?? "other";
    const ok = spend.allowUsd(bucket, "x", "m", p.worst ?? p.usd, p.tokens ?? 0);
    if (ok) spend.chargeUsd(bucket, "x", "m", p.usd, p.tokens ?? 0, 0, true);
    spend.settle();
    if (!ok) return { code: 2, out: `SKIP x · refused, over a cap: ${spend.run.refused[0]}\nPASS 0 · FAIL 0 · SKIP 1` };
    return { code: p.code, out: `PASS ${p.code === 1 ? "harness · launch" : "x"}\n${p.verdict ?? (p.code === 1 ? "PASS 0 · FAIL 1 · SKIP 0" : "PASS 1 · FAIL 0 · SKIP 0")}` };
  };
  return { run, calls, lefts };
}

const opts = (r: string, run: StageOptions["run"], extra: Partial<StageOptions> = {}): StageOptions => ({
  root: r,
  env: {},
  run,
  online: async () => true,
  version: async () => "1.0.0",
  say: () => {},
  ...extra,
});

describe("the live stage", () => {
  test("never in CI, never offline: nothing runs, nothing fails", async () => {
    const r = root();
    const { run, calls } = runner([]);
    const lines: string[] = [];
    expect(await liveStage([J], opts(r, run, { env: { CI: "true" }, say: (l) => lines.push(l) }))).toEqual({ failed: false, spent: 0, planTokens: 0 });
    expect(await liveStage([J], opts(r, run, { online: async () => false, say: (l) => lines.push(l) }))).toEqual({ failed: false, spent: 0, planTokens: 0 });
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toContain("not in CI");
    expect(lines.join("\n")).toContain("SKIP (offline)");
  });

  test("the checks share one budget per bucket: each reserves its worst case and pays what it used; over a cap is a SKIP that says to ask the user", async () => {
    const r = root();
    const { run, calls, lefts } = runner([
      { usd: 0.2, worst: 0.25, code: 0, bucket: "bedrock" },
      { usd: 0, code: 0, bucket: "subscription", tokens: 43_000 },
      { usd: 0.05, worst: 0.2, code: 0 },
    ]);
    const lines: string[] = [];
    const out = await liveStage([J, H("codex"), H("opencode")], opts(r, run, { parallel: 1, say: (l) => lines.push(l) }));
    expect(calls[0]).toEqual(["--regression-stage", expect.stringMatching(/^--stage-dir=/), "--tier=journey", "--harness=claude-code"]);
    expect(lefts.map((l) => [l.plans, Number(l.bedrock.toFixed(4)), l.keys])).toEqual([[200_000, 0.3, 0.1], [200_000, 0.1, 0.1], [157_000, 0.1, 0.1]]);
    expect(out).toMatchObject({ failed: false, planTokens: 43_000 });
    expect(out.spent).toBeCloseTo(0.2, 6);
    expect(lines.join("\n")).toContain("live harness opencode 1.0.0: SKIP (over this run's cap: ask the user before raising it with --live-caps)");
    // The checks' own ledgers end up in the stage's.
    expect((JSON.parse(readFileSync(join(r, REGRESSION_LIVE_LEDGER), "utf8")) as LedgerFile).runs.flatMap((x) => x.calls).map((c) => c.bucket)).toEqual(["bedrock", "subscription"]);
  });

  test("they run at once, up to the stage's limit", async () => {
    const r = root();
    let now = 0;
    let most = 0;
    const run: StageOptions["run"] = async () => {
      most = Math.max(most, ++now);
      await Bun.sleep(30); // sleep-ok: the window in which the others must start
      now--;
      return { code: 0, out: "PASS 1 · FAIL 0 · SKIP 0" };
    };
    await liveStage([J, H("codex"), H("opencode"), H("kimi-code"), H("antigravity")], opts(r, run, { parallel: 3 }));
    expect(most).toBe(3);
    // By default: at most 4, as many as the free memory holds (~1.5 GB each), at least 1; GLUON_LIVE_PARALLEL overrides it.
    expect([liveParallel({}, 9), liveParallel({}, 3.2), liveParallel({}, 0.5), liveParallel({ GLUON_LIVE_PARALLEL: "6" }, 1)]).toEqual([4, 2, 1, 6]);
  });

  test("--live-caps (after the user agreed) raises a cap for this run", async () => {
    const r = root();
    const { run, lefts } = runner([]);
    await liveStage([H("codex")], opts(r, run, { caps: { plans: 200_000, bedrock: 1, openrouter: 0.1, keys: 0.1 } }));
    expect(lefts[0]!.bedrock).toBe(1);
  });

  test("a pass is kept: the same code and harness version cost nothing the next run; a change to src/ or the version runs it again", async () => {
    const r = root();
    const first = runner([{ usd: 0.02, code: 0 }]);
    await liveStage([H("codex")], opts(r, first.run));
    const again = runner([]);
    const lines: string[] = [];
    expect((await liveStage([H("codex")], opts(r, again.run, { say: (l) => lines.push(l) }))).spent).toBe(0);
    expect(again.calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/live harness codex 1\.0\.0: ok \(passed .* on this code; \$0 now\)/);
    await liveStage([H("codex")], opts(r, again.run, { version: async () => "1.0.1" }));
    writeFileSync(join(r, "src", "a.ts"), "export const a = 2;\n");
    await liveStage([H("codex")], opts(r, again.run, { version: async () => "1.0.1" }));
    expect(again.calls).toHaveLength(2);
  });

  test("a FAIL fails the run and is never kept; a cap that stopped it, or nothing that could run here, is a SKIP, not kept either", async () => {
    const r = root();
    const { run, calls } = runner([
      { usd: 0.01, code: 1 },
      { usd: 0, code: 2, verdict: "PASS 0 · FAIL 0 · SKIP 1" },
      { usd: 0, code: 0, verdict: "PASS 0 · FAIL 0 · SKIP 1" },
    ]);
    const lines: string[] = [];
    expect((await liveStage([H("codex"), H("opencode"), H("kimi-code")], opts(r, run, { say: (l) => lines.push(l) }))).failed).toBe(true);
    expect(lines.join("\n")).toContain("live harness codex 1.0.0: FAILED");
    expect(lines.join("\n")).toContain("live harness opencode 1.0.0: SKIP (over this run's cap: ask the user before raising it with --live-caps)");
    expect(lines.join("\n")).toContain("live harness kimi-code 1.0.0: SKIP (nothing could run here)");
    expect(JSON.parse(readFileSync(join(r, LIVE_CACHE), "utf8"))).toEqual({});
    expect(calls).toHaveLength(3);
  });

  test("--newest reaches each check", async () => {
    const r = root();
    const { run, calls } = runner([]);
    await liveStage([H("codex")], opts(r, run, { newest: true }));
    expect(calls[0]).toContain("--newest");
  });

  test("the cache key: the check, the version and every src/ and live-script byte", () => {
    const r = root();
    const k = liveKey(H("codex"), "1.0.0", r);
    expect(liveKey(H("codex"), "1.0.0", r)).toBe(k);
    expect(liveKey(H("opencode"), "1.0.0", r)).not.toBe(k);
    expect(liveKey(H("codex"), "1.0.1", r)).not.toBe(k);
    writeFileSync(join(r, "scripts", "live.ts"), "// changed\n");
    expect(liveKey(H("codex"), "1.0.0", r)).not.toBe(k);
  });

  test("the verdict is the last one printed", () => {
    expect(parseVerdict("PASS 1 · FAIL 0 · SKIP 0\n…\nPASS 3 · FAIL 1 · SKIP 2 · a cap stopped the run")).toEqual({ pass: 3, fail: 1, skip: 2 });
    expect(parseVerdict("nothing")).toBeNull();
  });
});
