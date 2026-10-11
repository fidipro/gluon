/**
 * `bun run regression`'s live stage (scripts/live-stage.ts, issue #31): the caps per run and per bucket, what each check is told is left, the
 * cache that keeps a pass until the code or the harness changes, and when the stage never runs (CI, offline). Offline: each check's
 * run is a function here that writes the ledger the way `scripts/live.ts --regression-stage` does.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REGRESSION_LIVE_LEDGER } from "../scripts/live-lib.ts";
import { LIVE_CACHE, liveKey, liveStage, parseVerdict, type StageOptions } from "../scripts/live-stage.ts";
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

/** Each check's run: spends `usd[i]` (in `bucket[i]`, API keys by default) into the ledger and answers `codes[i]` with a verdict line; records the args it got. */
function runner(r: string, plan: { usd: number; code: number; verdict?: string; bucket?: string; tokens?: number }[]) {
  const calls: string[][] = [];
  const run: StageOptions["run"] = async (args) => {
    const p = plan[calls.length] ?? { usd: 0, code: 0, verdict: "PASS 1 · FAIL 0 · SKIP 0" };
    calls.push(args);
    const ledger = join(r, REGRESSION_LIVE_LEDGER);
    mkdirSync(dirname(ledger), { recursive: true });
    let f = { caps: {}, spent: { bedrock: 0, other: 0 }, runs: [] as unknown[] };
    try {
      f = JSON.parse(readFileSync(ledger, "utf8"));
    } catch {}
    f.runs.push({ at: new Date().toISOString(), calls: [{ bucket: p.bucket ?? "other", what: "x", model: "m", input: p.tokens ?? 0, output: 0, usd: p.usd }], refused: [] });
    writeFileSync(ledger, JSON.stringify(f));
    return { code: p.code, out: `PASS ${p.code === 1 ? "harness · launch" : "x"}\n${p.verdict ?? (p.code === 1 ? "PASS 0 · FAIL 1 · SKIP 0" : "PASS 1 · FAIL 0 · SKIP 0")}` };
  };
  return { run, calls };
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
    const { run, calls } = runner(r, []);
    const lines: string[] = [];
    expect(await liveStage([J], opts(r, run, { env: { CI: "true" }, say: (l) => lines.push(l) }))).toEqual({ failed: false, spent: 0, planTokens: 0 });
    expect(await liveStage([J], opts(r, run, { online: async () => false, say: (l) => lines.push(l) }))).toEqual({ failed: false, spent: 0, planTokens: 0 });
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toContain("not in CI");
    expect(lines.join("\n")).toContain("SKIP (offline)");
  });

  test("each check is told what each bucket has left; a check over a cap is a SKIP that says to ask the user", async () => {
    const r = root();
    const { run, calls } = runner(r, [
      { usd: 0.2, code: 0, bucket: "bedrock" },
      { usd: 0, code: 0, bucket: "subscription", tokens: 43_000 },
      { usd: 0, code: 2, verdict: "PASS 0 · FAIL 0 · SKIP 1" },
    ]);
    const lines: string[] = [];
    const out = await liveStage([J, H("codex"), H("opencode")], opts(r, run, { say: (l) => lines.push(l) }));
    expect(calls.map((a) => a.find((x) => x.startsWith("--stage-left=")))).toEqual([
      "--stage-left=plans=200000,bedrock=0.3000,openrouter=0.1000,keys=0.1000",
      "--stage-left=plans=200000,bedrock=0.1000,openrouter=0.1000,keys=0.1000",
      "--stage-left=plans=157000,bedrock=0.1000,openrouter=0.1000,keys=0.1000",
    ]);
    expect(calls[0]).toEqual(["--regression-stage", "--stage-left=plans=200000,bedrock=0.3000,openrouter=0.1000,keys=0.1000", "--tier=journey", "--harness=claude-code"]);
    expect(out).toMatchObject({ failed: false, planTokens: 43_000 });
    expect(out.spent).toBeCloseTo(0.2, 6);
    expect(lines.join("\n")).toContain("live harness opencode 1.0.0: SKIP (over this run's cap: ask the user before raising it with --live-caps)");
  });

  test("--live-caps (after the user agreed) raises a cap for this run", async () => {
    const r = root();
    const { run, calls } = runner(r, []);
    await liveStage([H("codex")], opts(r, run, { caps: { plans: 200_000, bedrock: 1, openrouter: 0.1, keys: 0.1 } }));
    expect(calls[0]).toContain("--stage-left=plans=200000,bedrock=1.0000,openrouter=0.1000,keys=0.1000");
  });

  test("a pass is kept: the same code and harness version cost nothing the next run; a change to src/ or the version runs it again", async () => {
    const r = root();
    const first = runner(r, [{ usd: 0.02, code: 0 }]);
    await liveStage([H("codex")], opts(r, first.run));
    const again = runner(r, []);
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
    const { run, calls } = runner(r, [
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
    const { run, calls } = runner(r, []);
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
