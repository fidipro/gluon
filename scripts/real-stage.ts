/**
 * `bun run regression`'s real stage (issue #31): the real-harness tier (test/real/harness.real.test.ts) for the harnesses a change
 * touches: the real binaries, Gluon's frame, a model API on loopback. Free and offline but for installing the binaries: the pinned
 * ones from the cache (`bun scripts/harness-pin.ts --install`), or with `newest` (`--newest`, and always in CI: before a merge the
 * tests run on each harness's newest release) the newest, downloaded and hash-checked first.
 * Needs tmux (Linux, macOS); without it, or when a binary can't be had (offline, nothing cached), the stage is skipped, saying why.
 */
import type { Harness } from "../src/harnesses.ts";
import type { LiveCheck } from "../test/areas.ts";
import { harnessBin } from "./harness-cache.ts";

export const REAL_TEST = "test/real/harness.real.test.ts";
/** The harnesses that can be pointed at a loopback model API (`testModelBase`, src/launchers.ts); Antigravity and Grok Build can't. */
export const REAL_HARNESSES: Harness[] = ["claude-code", "codex", "opencode", "kimi-code"];

/** The harnesses a run's real stage covers: those of its harness checks that the tier can run. */
export const realHarnesses = (checks: LiveCheck[]): Harness[] => REAL_HARNESSES.filter((h) => checks.some((c) => c.kind === "harness" && c.harness === h));

export interface RealOptions {
  newest: boolean;
  tmux: boolean;
  say(line: string): void;
  /** Runs the tier (`bun test …`) with these extra variables: its exit code and output. */
  run(env: Record<string, string>): Promise<{ code: number; out: string }>;
  /** The binary of a harness (default: the cache's, installed when missing). */
  bin?(h: Harness, newest: boolean): Promise<{ path: string; version: string }>;
}

export async function realStage(hs: Harness[], o: RealOptions): Promise<{ failed: boolean }> {
  if (!hs.length) return { failed: false };
  if (!o.tmux) {
    o.say(`── real: SKIP (no tmux here) · would run: ${hs.join(", ")}`);
    return { failed: false };
  }
  const bins: Partial<Record<Harness, { path: string; version: string }>> = {};
  const bin = o.bin ?? ((h: Harness, newest: boolean) => harnessBin(h, { newest, log: (s) => o.say(`   ${s}`) }));
  for (const h of hs) {
    try {
      bins[h] = await bin(h, o.newest);
    } catch (e) {
      o.say(`── real: SKIP (no ${h} binary: ${e instanceof Error ? e.message.split("\n")[0] : e}; offline? bun scripts/harness-pin.ts --install)`);
      return { failed: false };
    }
  }
  o.say(`── real: ${hs.map((h) => `${h} ${bins[h]!.version}`).join(", ")} (${o.newest ? "newest" : "pinned"}; loopback model API)`);
  const r = await o.run({ GLUON_REAL_HARNESSES: hs.join(","), GLUON_REAL_BINS: JSON.stringify(bins) });
  const lines = r.out.split("\n");
  o.say(`── real: ${r.code === 0 ? "ok" : "FAILED"}\n${(r.code === 0 ? lines.filter((l) => /^\s*\d+ (pass|fail|skip)|^Ran /.test(l)) : lines).join("\n").trimEnd()}`);
  return { failed: r.code !== 0 };
}
