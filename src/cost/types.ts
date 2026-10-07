/**
 * Gluon's own cost calculations (issue #39): one pure function per harness, each a port of the
 * harness's own arithmetic where it has one, fed by per-request token counts and a price table.
 * Nothing here reads a file, the network or the environment, and nothing here may be imported by
 * `gluon hook` (`src/adapters/common.ts`: light imports only). The harness's own cost figure is only
 * ever compared with ours (`audit.ts`), never shown instead of it.
 *
 * Prices are USD per million tokens. Money is returned in micro-USD (integer) beside the float the
 * harness's own code would have produced, so a bit-exact comparison stays possible (OpenCode).
 */

/** What makes a figure only an estimate: named, so the audit can attribute a residual to one. */
export type Assumption =
  | "unknown-model"
  | "launched-model-price"
  | "cache-ttl-assumed-5m"
  | "cache-ttl-assumed-1h"
  | "cache-ttl-inferred"
  | "service-tier-requested"
  | "long-context-tier-assumed"
  | "list-price"
  | "reasoning-in-output"
  | "side-model-assumed"
  | "grok-seed-price";

export interface CostResult {
  /** The harness-style float (the sum of terms in the harness's own order). */
  usd: number;
  /** `Math.round(usd * 1e6)`: the figure the ledger keeps. */
  micros: number;
  /** False when a named assumption was needed: the figure is an estimate. */
  exact: boolean;
  assumptions: Assumption[];
}

export const result = (usd: number, assumptions: Assumption[] = []): CostResult => ({ usd, micros: Math.round(usd * 1e6), exact: assumptions.length === 0, assumptions });

/** A finite, non-negative number, else 0 (what the harnesses do with a bad count or rate). */
export const clamp = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
