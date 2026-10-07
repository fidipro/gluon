/**
 * Kimi Code's cost, Gluon's own: the usage records of the session's `kimi export` (`src/kimi-usage.ts` reads them: only these fields) priced at
 * Gluon's table. Kimi reports no cost of its own, so there is no audit pair. A record (Kimi 2.1.1, `usage.record` in the session's wire log) is one
 * request's usage, `inputOther` (the prompt minus the cache read) + `inputCacheCreation` + `inputCacheRead` + `output`: never a running total.
 * `usageScope` only says where the request came from (`turn`: a conversation turn's; `session`: any other, a compaction's or a title's): Kimi's own
 * session fold adds both, so each record counts once whatever its scope, and the main agent's and a subagent's alike (`agentId`).
 * The price is the route's: OpenRouter's (`openrouter/moonshotai/<id>`), Moonshot's own API (`moonshotai/<id>`: exact, a key bills it) or, on the plan, Moonshot's API price of the same model (an API-equivalent: `keys.ts`).
 * On an API key `model` is the environment alias `__kimi_env_model__`: the launched model's price is used, as it is for any name Gluon doesn't know.
 * The window is Gluon's too: models.dev's `limit.context` of the model on OpenRouter, the same as Moonshot's own (K3 1,048,576, K2.7 Code 262,144), the same size a launch tells
 * Kimi (`KIMI_MODEL_MAX_CONTEXT_SIZE`, else Kimi sizes an environment model at 256K whatever the model) and the plan's managed K3 has. Models are named
 * by Gluon's id, the provider's (`moonshotai/kimi-k3`) or the plan's (`k3`).
 */
import { DEFAULT_MODELS } from "../harnesses.ts";
import { priceKey } from "./keys.ts";
import { priceEntry, type ModelsDevTable, type PriceEntry } from "./tables.ts";
import { clamp, result, type CostResult } from "./types.ts";

/** The only fields kept of a `usage.record` (never a prompt, a message or a tool's text). */
export interface KimiUsageRecord {
  agentId: string;
  model: string;
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  usageScope?: "turn" | "session";
}

/** The alias Kimi gives an environment model (`KIMI_MODEL_*`): what `model` says over OpenRouter, whatever the model. */
export const KIMI_ENV_MODEL = "__kimi_env_model__";

/** The offered model a Kimi model name names (Gluon's id, the provider's or the plan's alias, with or without `kimi-code/`). */
function offered(model: string) {
  const name = model.replace(/^kimi-code\//, "");
  return DEFAULT_MODELS["kimi-code"].find((m) => m.id === name || Object.values(m.ids).includes(name));
}

export function kimiWindow(model: string, table?: ModelsDevTable): number | undefined {
  const entry = offered(model);
  return entry ? (priceEntry(priceKey("kimi-code", entry.ids, "openrouter"), table)?.context ?? undefined) : undefined;
}

/**
 * The price key of the model a record names on this connection: undefined for the environment alias (the launched model's key is the price:
 * nothing assumed) and for a name Gluon doesn't offer (`known: false`: the launched model's price stands in, an assumption).
 */
export function kimiPriceKey(model: string, conn: "plan" | "openrouter" | "moonshot" | string): { key?: string; known: boolean } {
  if (model === KIMI_ENV_MODEL) return { known: true };
  const entry = offered(model);
  const key = entry && (conn === "plan" || conn === "openrouter" || conn === "moonshot") ? priceKey("kimi-code", entry.ids, conn) : undefined;
  return key ? { key, known: true } : { known: false };
}

/**
 * One request's cost: `(inputOther·in + cacheRead·cr + cacheCreation·cw + output·out) / 1e6`. A missing cache price is the input price
 * (Moonshot bills no separate cache write: `inputCacheCreation` is 0 on what was captured).
 */
export function kimiCost(entry: PriceEntry, u: Pick<KimiUsageRecord, "inputOther" | "output" | "inputCacheRead" | "inputCacheCreation">): CostResult {
  const c = entry.cost;
  const input = clamp(c.input);
  const usd = (clamp(u.inputOther) * input + clamp(u.inputCacheRead) * (c.cache_read === undefined ? input : clamp(c.cache_read)) + clamp(u.inputCacheCreation) * (c.cache_write === undefined ? input : clamp(c.cache_write)) + clamp(u.output) * clamp(c.output)) / 1e6;
  return result(usd);
}

/**
 * Each export holds the session's whole wire log, and a log is append-only: the records of an agent already counted are its first
 * `seen` ones. `fresh` returns the ones not yet counted, never twice (a refresh that finds the same records adds nothing, a log that
 * shrank adds nothing and never counts back).
 */
export class KimiRecords {
  private seen = new Map<string, number>();

  fresh(byAgent: Map<string, KimiUsageRecord[]>): KimiUsageRecord[] {
    const out: KimiUsageRecord[] = [];
    for (const [agent, records] of byAgent) {
      const n = this.seen.get(agent) ?? 0;
      if (records.length > n) {
        out.push(...records.slice(n));
        this.seen.set(agent, records.length);
      }
    }
    return out;
  }
}
