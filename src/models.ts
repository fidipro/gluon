/**
 * Which models the brain may offer, and which id a launch uses. The rule: a model is offered only
 * when a probe (doctor, onboarding) verified that one of its harness's connections reaches it.
 * A model id this connection never probed (a fresh setup, or an id new in a later catalog) is
 * offered, so setup isn't empty before the first check; only an id a probe failed to reach is hidden.
 */
import { agentsFrom, connsOf, type AgentOption, type Config, type ModelOption } from "./config.ts";
import { installed as isInstalled } from "./detect.ts";
import { checkedKey, effortsOn, HARNESS_INFO, idOn, isPlanConn, PROVIDERS, subscriptionOf, verifiedKey, type Conn, type Harness, type ModelEntry } from "./harnesses.ts";

/** true: verified; false: not served here, or probed and not reached; null: this id was never probed on this connection. */
export function reach(config: Config, harness: Harness, conn: Conn, entry: ModelEntry): boolean | null {
  const id = idOn(entry, conn);
  if (!id) return false;
  const key = verifiedKey(harness, conn, id);
  if (config.verified[key]) return true;
  return config.unreached[key] ? false : null;
}

/** Whether this model is offered on this connection: served there, and not probed and found unreachable. */
export function offeredOn(config: Config, harness: Harness, conn: Conn, entry: ModelEntry): boolean {
  return reach(config, harness, conn, entry) !== false;
}

/** The connections a launch of this harness can use: its own, or (not connected) its own login / any key provider. */
function launchConns(config: Config, harness: Harness, entry?: ModelEntry): Conn[] {
  const conns = connsOf(config, harness);
  if (conns.length) return conns;
  if (HARNESS_INFO[harness].subscription) return ["plan"];
  return entry ? (Object.keys(entry.ids) as Conn[]).filter((c) => c !== "plan") : [];
}

/**
 * Why this harness's connection can't serve the model (the catalog has no id for it there), or
 * null. "muse-spark-1.3 isn't available on OpenCode's OpenCode Go plan connection (models: deepseek-flash, muse-spark-1.3-contributor)".
 */
export function unservedModel(config: Config, harness: Harness, modelId: string): string | null {
  const entry = config.models[harness].find((m) => m.id === modelId);
  if (!entry) return null;
  const conns = launchConns(config, harness, entry);
  if (conns.some((c) => entry.ids[c])) return null;
  const info = HARNESS_INFO[harness];
  const where = conns.length === 1 && subscriptionOf(harness, conns[0]!) ? `${info.label}'s ${subscriptionOf(harness, conns[0]!)!.plan}` : `${info.label}'s ${conns.map((c) => (c === "plan" ? "plan" : PROVIDERS[c].label)).join(", ")} connection`;
  const served = config.models[harness].filter((m) => conns.some((c) => m.ids[c])).map((m) => m.id);
  return `${modelId} isn't available on ${where} (models: ${served.join(", ") || "none"})`;
}

/** The connection and id a launch of this model uses: the first connection offering it. */
export function resolveModel(config: Config, harness: Harness, modelId: string): { conn: Conn; id: string } | null {
  const entry = config.models[harness].find((m) => m.id === modelId);
  if (!entry) return null;
  // Not connected: a harness with a subscription runs on its own login; OpenCode on its first provider for the model.
  // A plan is prepaid: a model it serves goes through it even when the config lists OpenRouter first (BUG-424).
  const listed = launchConns(config, harness, entry);
  const conns = [...listed.filter(isPlanConn), ...listed.filter((c) => !isPlanConn(c))];
  const offered = conns.find((c) => idOn(entry, c) && offeredOn(config, harness, c, entry));
  const conn = offered ?? conns.find((c) => idOn(entry, c));
  return conn ? { conn, id: idOn(entry, conn)! } : null;
}

/**
 * The agents and models the brain may propose: installed harnesses that are connected, with their
 * offered models. `demo`: with nothing connected, every installed harness with its models. A model with an `optIn`
 * (its maker gets the session's code) is offered only where `optedIn(key)` says so; by default never.
 */
export function offeredAgents(config: Config, { installed = isInstalled, demo = false, optedIn = () => false }: { installed?: (h: Harness) => boolean; demo?: boolean; optedIn?: (key: string) => boolean } = {}): AgentOption[] {
  const all = agentsFrom(config.models);
  const out: AgentOption[] = [];
  for (const agent of all) {
    const h = agent.harness;
    if (!installed(h)) continue;
    const conns = connsOf(config, h);
    const entries = config.models[h].filter((m) => (!m.optIn || optedIn(m.optIn)) && (conns.length ? conns.some((c) => offeredOn(config, h, c, m)) : demo));
    // A model that takes no effort on the connection it would run on is offered without one (`ModelEntry.effortConns`).
    const offered = (m: ModelOption): ModelOption => {
      const entry = entries.find((e) => e.id === m.id)!;
      const conn = resolveModel(config, h, m.id)?.conn;
      if (!conn || effortsOn(entry, conn).length === entry.efforts.length) return m;
      const { defaultEffort: _, ...rest } = m;
      return { ...rest, efforts: [] };
    };
    if (entries.length) out.push({ ...agent, models: agent.models.filter((m) => entries.some((e) => e.id === m.id)).map(offered) });
  }
  return out;
}

// Gluon's own context windows and percentage live in `src/cost/context.ts` (issue #39); re-exported for the existing imports.
export { CLAUDE_1M_WINDOW, CLAUDE_STANDARD_WINDOW, CODEX_BASELINE_TOKENS, CODEX_FALLBACK_WINDOW, claudeContextWindow, claudeContextWindowByName, codexCatalogWindows, codexContextWindows, codexUsableWindow, contextPercent, type CodexWindow } from "./cost/context.ts";
