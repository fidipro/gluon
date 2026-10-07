/**
 * What OpenRouter billed a session, from the usage of its key (`src/openrouter-billed.ts` reads it): the pure arithmetic.
 * OpenRouter bills each request at the provider that served it, so tokens x table price can be off by 2x; the key's `usage`
 * read before and after a session is exact, when nothing else spent on the key meanwhile (the user decided this: 2026-10-06).
 * No file, network or environment access here.
 */

/** OpenRouter's usage lags the requests by 30 to 90 s: a reading at `t` holds the requests up to about `t` minus this. */
export const CALIBRATION_LAG_MS = 60_000;
/** Below this much of our own estimate (at the lagged time) the ratio is noise: no calibration yet. */
export const CALIBRATION_FLOOR_USD = 0.001;
/** A ratio outside this range is not a price difference between providers: the table price stands (k = 1). */
export const RATIO_MIN = 0.05;
export const RATIO_MAX = 20;
/** A ratio further than this from 1 (25%) is a price difference observed live: the ledger names it (`openrouter-provider-price`). */
export const PRICE_DRIFT = 0.25;

/** Gluon's own running estimate over time, to find what it was `CALIBRATION_LAG_MS` ago. Bounded. */
export class EstimateHistory {
  private readonly points: { t: number; usd: number }[] = [];

  /** The estimate is `usd` at `t` (a repeat of the last value adds nothing). */
  push(t: number, usd: number): void {
    const last = this.points.at(-1);
    if (last && last.usd === usd) return;
    this.points.push({ t, usd });
    // Older than ten minutes is never looked up (the lag is about one); keep the newest of those as the value then.
    while (this.points.length > 2 && this.points[1]!.t < t - 10 * 60_000) this.points.shift();
    if (this.points.length > 2048) this.points.splice(1, 1);
  }

  /** What the estimate was at `t` (0 before the first point). */
  at(t: number): number {
    let usd = 0;
    for (const p of this.points) {
      if (p.t > t) break;
      usd = p.usd;
    }
    return usd;
  }
}

/**
 * The ratio k of what OpenRouter billed up to a reading (`billedUsd`, the key's usage minus its usage at the start) to our own
 * estimate of the same requests (the estimate `CALIBRATION_LAG_MS` before the reading). Undefined while that estimate is too small to
 * mean anything; 1 outside `RATIO_MIN..RATIO_MAX`. The latest k is used as it is, never smoothed: the providers a router picks change
 * between requests, and the last full window is the best account of what it is picking now.
 */
export function ratio(billedUsd: number, estimateUsd: number): number | undefined {
  if (!Number.isFinite(billedUsd) || !Number.isFinite(estimateUsd) || estimateUsd < CALIBRATION_FLOOR_USD || billedUsd < 0) return undefined;
  const k = billedUsd / estimateUsd;
  return k >= RATIO_MIN && k <= RATIO_MAX ? k : 1;
}

/** One session's window on a key: from before its first request until its usage had landed (`end` undefined: still open). */
export interface Window {
  start: number;
  end?: number;
}

/** Whether two windows share a moment (an open one reaches to the end of time). */
export function overlap(a: Window, b: Window): boolean {
  return a.start < (b.end ?? Infinity) && b.start < (a.end ?? Infinity);
}

/** When the key's usage was read: the request went out at `from` and the answer came in at `to` (the usage it shows is of some moment between). */
export interface Reading {
  from: number;
  to: number;
}

/** One request of Gluon's own brain on an OpenRouter key: when its reply ended, and the exact `usage.cost` of that reply (undefined: not known, e.g. an error or a stopped stream). */
export interface BrainCall {
  /** `keyTag` of the key it was sent with: never the key. */
  key: string;
  end: number;
  usd: number | undefined;
}

/** How soon after a request OpenRouter's usage can show it, and how late it still can (the meter's `minLagMs` and `tailMs`). */
export interface Lag {
  minMs: number;
  maxMs: number;
}

/** What the brain's spend means for one session's delta (the key's usage at `final` minus at `base`). */
export interface BrainShare {
  /** The exact cost of the brain's replies that certainly landed in the delta: take it off. */
  usd: number;
  /** A reply that is in the delta, or may be, has no known cost, or may have landed before the baseline: the delta can't be corrected. Never gets better. */
  unknown: boolean;
  /** A reply is in the delta only if it landed before this final reading: not known yet. A later reading settles it. */
  pending: boolean;
}

/** Whether a reply's cost is in the usage of a reading: certainly (`yes`: even the slowest lag had passed), certainly not (`no`: even the fastest had not), or not known. */
function landed(end: number, r: Reading, lag: Lag): "yes" | "no" | "maybe" {
  if (end + lag.maxMs <= r.from) return "yes";
  if (end + lag.minMs > r.to) return "no";
  return "maybe";
}

const MAX_BRAIN_CALLS = 2048;

/**
 * Gluon's own brain's requests on OpenRouter keys, in memory (times and costs, never a key or a prompt). The brain is not part of any session: its cost
 * is the brain's, and a session's delta of the key's usage must not hold it (QA-cost-04). `share` says how much of a delta is the brain's.
 */
export class BrainSpend {
  private calls: BrainCall[] = [];
  /** The end of the newest call dropped for the cap: a window that starts before it can't be told. */
  private lostUntil = 0;

  /** A brain request ended (its reply, an error or a stop) at `end`. */
  record(key: string, end: number, usd: number | undefined): void {
    this.calls.push({ key, end, usd: typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : undefined });
    if (this.calls.length > MAX_BRAIN_CALLS) this.lostUntil = Math.max(this.lostUntil, this.calls.shift()!.end);
  }

  /** Records up to `t` are gone or unreadable (a cap, a pruned or torn file of another Gluon): a window that starts before `t` plus the slowest lag can't be told. */
  lose(t: number): void {
    this.lostUntil = Math.max(this.lostUntil, t);
  }

  /** What the brain's requests on `key` did to a delta read from `base` to `final`. */
  share(key: string, base: Reading, final: Reading, lag: Lag): BrainShare {
    const out: BrainShare = { usd: 0, unknown: this.lostUntil > 0 && this.lostUntil + lag.maxMs > base.from, pending: false };
    for (const c of this.calls) {
      if (c.key !== key) continue;
      const b = landed(c.end, base, lag);
      const f = landed(c.end, final, lag);
      // Landed before the baseline, or not landed by the final reading: not in the delta.
      if (b === "yes" || f === "no") continue;
      if (c.usd === undefined || b === "maybe") out.unknown = true;
      else if (f === "yes") out.usd += c.usd;
      else out.pending = true;
    }
    return out;
  }
}

/** The process's brain (`src/brain.ts` records into it, every OpenRouter session's meter reads it). */
export const brainSpend = new BrainSpend();

/** A micro-USD figure of a USD reading. */
export const micros = (usd: number): number => Math.round(usd * 1e6);
