/**
 * Which price-table entry a harness's model on a connection is priced by: the models.dev provider
 * and model id (`<provider>/<id>`), the key of the models.dev table (`tables.ts`). A connection decides the
 * price (the same model costs differently on Bedrock or OpenRouter than on the vendor's API).
 */
import { PROVIDERS, type Conn, type Harness } from "../harnesses.ts";

/** The models.dev provider a harness's own login ("plan") is priced as. */
const PLAN_PROVIDER: Record<Harness, string> = { "claude-code": "anthropic", codex: "openai", antigravity: "google", "grok-build": "xai", opencode: "opencode", "kimi-code": "moonshotai" };
/** The key of the vendor's own API id for a plan connection. */
const PLAN_ID: Record<Harness, "anthropic" | "openai" | "gemini" | "xai" | null> = { "claude-code": "anthropic", codex: "openai", antigravity: "gemini", "grok-build": "xai", opencode: null, "kimi-code": null };

/** `<models.dev provider>/<model id>` for a model (`ids`: its ids by connection) on a connection, or undefined. */
export function priceKey(harness: Harness, ids: Partial<Record<Conn, string>>, conn: Conn): string | undefined {
  if (conn === "plan") {
    const k = PLAN_ID[harness];
    // Kimi Code's plan ids are its own aliases (`k3`): the plan is priced as Moonshot's API price of the same model (its own id, else OpenRouter's `moonshotai/<id>`).
    const id = harness === "kimi-code" ? (ids.moonshot ?? ids.openrouter?.replace(/^moonshotai\//, "")) : k ? ids[k] : ids.plan;
    return id ? `${PLAN_PROVIDER[harness]}/${id}` : undefined;
  }
  const id = ids[conn];
  // Moonshot is no OpenCode provider (no `opencodeId`: OpenCode's price table must not reach it, BUG-422): Kimi Code's own key is priced as the plan is.
  const provider = conn === "moonshot" ? PLAN_PROVIDER["kimi-code"] : PROVIDERS[conn].opencodeId;
  return id && provider ? `${provider}/${id}` : undefined;
}
