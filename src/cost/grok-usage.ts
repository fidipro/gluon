/**
 * The `grok usage <session>` audit (issue #39, owner-approved): Grok Build's own persisted token and
 * cost totals for a session, read by running its official binary (never its files), to audit
 * Gluon's own estimate. Verified on 1.0.46 against a mock backend and live (subscription, grok-4.7): its
 * figures appear about 100 ms AFTER a turn's Stop hook returns (so it runs from Gluon, with retries, never
 * from the hook) and BEFORE the turn's last OTLP batch reaches Gluon (0.5 to 1.5 s: the audit waits for as
 * many requests as `modelCalls`, `CostTracker.grokUsageReport`), it covers EVERY request of the session
 * (a subagent's too, with its own `modelCalls`; a compaction has no request and no price), `turnNumber`
 * is 1-based, a turn the server stamped no cost on has none and sets `costIsPartial`, and one tick is
 * 1e-10 USD. Its per-request costs equal the OTLP `cost_usd_micros` to the micro.
 * The id comes from the agent's own telemetry (spoofable): only a UUID is ever passed, which cannot
 * start with `-`, so it is not put after `--` (`grok usage -- <id>` is accepted too, live: not needed).
 */
import { binPath, killTree, neutralCwd } from "../detect.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKS_PER_MICRO = 1e4;

export interface GrokUsageReport {
  turns: number;
  /** The session's cost in micro-USD, floored as Grok's own export is; null when none of its turns has a cost. */
  micros: number | null;
  /** Some turn has no cost: the total is a part. */
  partial: boolean;
  /** Includes the cache reads (as Grok's own export). */
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  modelCalls: number;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e15 ? v : undefined);

/** The report of `grok usage`'s JSON, or null when it isn't that. Never throws. */
export function parseGrokUsage(text: string): GrokUsageReport | null {
  try {
    const j = JSON.parse(text) as { session?: Record<string, unknown>; turns?: Record<string, unknown>[] };
    if (!j || typeof j !== "object" || !j.session || typeof j.session !== "object" || !Array.isArray(j.turns) || j.turns.length > 100_000) return null;
    const s = j.session;
    const ticks = num(s.costUsdTicks);
    const partial = j.turns.some((t) => num(t.costUsdTicks) === undefined) || s.costIsPartial === true;
    return { turns: j.turns.length, micros: ticks === undefined ? null : Math.floor(ticks / TICKS_PER_MICRO), partial, inputTokens: num(s.inputTokens) ?? 0, outputTokens: num(s.outputTokens) ?? 0, cachedReadTokens: num(s.cachedReadTokens) ?? 0, modelCalls: num(s.modelCalls) ?? 0 };
  } catch {
    return null;
  }
}

export type SpawnUsage = (argv: string[], opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }) => Promise<string | null>;

/** The most `grok usage` may print (4 MiB; a real session of hundreds of turns is a few tens of KB): more is hostile or broken, and is killed unread. */
export const MAX_USAGE_BYTES = 4 * 1024 * 1024;

/** Runs the official binary; the output text, or null (not installed, failed, timed out or printing more than `MAX_USAGE_BYTES`: killed with its tree). */
export const defaultSpawn: SpawnUsage = async (argv, { cwd, env, timeoutMs }) => {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => killTree(proc), timeoutMs);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of proc.stdout) {
      size += chunk.byteLength;
      if (size > MAX_USAGE_BYTES) {
        killTree(proc);
        return null;
      }
      chunks.push(chunk);
    }
    return (await proc.exited) === 0 ? Buffer.concat(chunks).toString("utf8") : null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Reads `grok usage` for a session once a turn has finished: retried (250 ms apart, at most `tries`)
 * until it shows more turns than `after`; null when it never does. Only a UUID id is run.
 */
export async function readGrokUsage(sessionId: string, { after = 0, tries = 12, delayMs = 250, timeoutMs = 8_000, spawn = defaultSpawn, bin, env = process.env }: { after?: number; tries?: number; delayMs?: number; timeoutMs?: number; spawn?: SpawnUsage; /** The binary (tests); null: none; default: Grok on PATH (`binPath`). */ bin?: string | null; env?: Record<string, string | undefined> } = {}): Promise<GrokUsageReport | null> {
  const grok = bin === undefined ? (binPath("grok") ?? null) : bin;
  if (!UUID.test(sessionId) || !grok) return null;
  for (let i = 0; i < tries; i++) {
    const out = await spawn([grok, "usage", sessionId], { cwd: neutralCwd(), env: { ...env, GROK_DISABLE_AUTOUPDATER: "1" }, timeoutMs }).catch(() => null);
    const report = out === null ? null : parseGrokUsage(out);
    if (report && report.turns > after) return report;
    if (i + 1 < tries) await Bun.sleep(delayMs);
  }
  return null;
}
