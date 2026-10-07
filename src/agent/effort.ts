/**
 * The intake agent's effort: what each step of `brain.order` may set (`effort`, default
 * `BRAIN_EFFORT_DEFAULT`), and what each route sends for it. Pure: config validation, the clients
 * and the header all ask here, so the header shows exactly what a client sends.
 *
 * Gluon's names are low · medium · high · xhigh · max. What each API takes:
 * - Anthropic Messages (API key, Bedrock Claude, and the Agent SDK's `effort` on a Claude plan):
 *   `output_config.effort`, the same five names, per model (`claudeEfforts`).
 * - OpenAI Responses: `reasoning.effort`, for reasoning models only (`openaiEfforts`).
 * - OpenRouter Chat Completions: `reasoning.effort`, its names up to `xhigh` (`OPENROUTER_LEVELS`).
 * - Bedrock ConverseStream: `outputConfig.effort` (low … max), for the reasoning models we know.
 * - Codex app-server (ChatGPT plan): `turn/start`'s `effort`, one of the model's
 *   `supported_reasoning_levels` in Codex's catalog.
 * A level a model lacks is clamped to the nearest one it has (ties go to the lower, cheaper one).
 * The Agent SDK's option is set per query. A step with no `effort` runs at medium. The checks
 * (`doctor`, `gluon brain`) send none.
 */
import type { BrainStep, Effort } from "../config.ts";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Gluon's own intake agent runs at this effort when its step sets none. */
export const BRAIN_EFFORT_DEFAULT: Effort = "medium";

/** Every level the APIs name, cheapest first: what "nearest" is measured on. */
const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** OpenRouter's `reasoning.effort` values (it has no `max`). */
export const OPENROUTER_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Bedrock Converse's `outputConfig.effort` values. */
const CONVERSE_LEVELS: readonly string[] = EFFORTS;

/**
 * The level of `supported` nearest to `wanted` (cheapest first on `LADDER`; a tie goes to the
 * lower). Levels off the ladder (codex's `none`, `ultra`, …) are never picked. Null: none left.
 */
export function clampEffort(wanted: string, supported: readonly string[]): string | null {
  const rank = (level: string) => (LADDER as readonly string[]).indexOf(level);
  const usable = supported.filter((s) => rank(s) !== -1);
  if (usable.includes(wanted)) return wanted;
  const at = rank(wanted);
  if (at === -1 || !usable.length) return null;
  const distance = (s: string) => Math.abs(rank(s) - at);
  return usable.reduce((best, s) => (distance(s) < distance(best) || (distance(s) === distance(best) && rank(s) < rank(best)) ? s : best));
}

/** A model id without its region / vendor prefix: `claude-sonnet-5-5` from `global.anthropic.claude-sonnet-5-5`, `gpt-6-sol` from `openai/gpt-6-sol`. */
const bare = (model: string) => model.replace(/^(us|eu|global|apac)\./, "").replace(/^(anthropic|openai)[./]/, "");

/**
 * The effort levels a Claude model takes (`output_config.effort`): every level from Opus 4.7,
 * Sonnet 5 and Haiku 5.5 on (and Fable, Mythos); no `xhigh` on Opus / Sonnet 4.6; low–high on Opus 4.5;
 * none on Sonnet 4.5, Haiku 4.5 and older models (the API rejects it). Claude Code's aliases are the latest.
 */
export function claudeEfforts(model: string): Effort[] {
  const id = bare(model);
  if (/^(opus|sonnet|haiku|fable|mythos|best|opusplan)(\[1m\])?$/.test(id)) return [...EFFORTS];
  const m = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?!\d)/);
  if (!m) return [];
  const [family, major, minor] = [m[1]!, Number(m[2]), Number(m[3] ?? 0)];
  const version = major + minor / 10;
  if (family === "fable" || family === "mythos") return [...EFFORTS];
  if (family === "haiku") return version >= 5 ? [...EFFORTS] : [];
  if (family === "opus") {
    if (version >= 4.7) return [...EFFORTS];
    if (version >= 4.6) return ["low", "medium", "high", "max"];
    if (version >= 4.5) return ["low", "medium", "high"];
    return [];
  }
  if (version >= 5) return [...EFFORTS];
  if (version >= 4.6) return ["low", "medium", "high", "max"];
  return [];
}

/**
 * The effort levels an OpenAI model takes (`reasoning.effort`), Gluon's names only: reasoning
 * models (the o-series, GPT-5 and later; gpt-oss) take low–high, GPT-5.2 on adds `xhigh`, GPT-6
 * `max`. Other models (GPT-4o, GPT-4.1, …) take none.
 */
export function openaiEfforts(model: string): Effort[] {
  const id = bare(model);
  if (/^o\d/.test(id) || /^gpt-oss/.test(id)) return ["low", "medium", "high"];
  const m = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!m) return [];
  const [major, minor] = [Number(m[1]), Number(m[2] ?? 0)];
  if (major >= 6) return [...EFFORTS];
  if (major === 5 && minor >= 2) return ["low", "medium", "high", "xhigh"];
  if (major === 5) return ["low", "medium", "high"];
  return [];
}

const isClaude = (model: string) => /(^|\.|\/)anthropic[./]|^claude-/.test(model) || /^(opus|sonnet|haiku|fable|mythos)/.test(model);

/**
 * The levels a step may set in `brain.order`: [] when its model takes none, null when only the
 * route knows at run time (the ChatGPT plan: Codex's catalog; any level, clamped then).
 */
export function stepEfforts(step: Pick<BrainStep, "route" | "model">): Effort[] | null {
  switch (step.route) {
    case "claude-plan":
    case "anthropic-api":
      return claudeEfforts(step.model);
    case "chatgpt-plan":
      return null;
    case "openai-api":
      return openaiEfforts(step.model);
    case "bedrock":
      return isClaude(step.model) ? claudeEfforts(step.model) : openaiEfforts(step.model);
    case "openrouter":
      return step.model.startsWith("anthropic/") ? claudeEfforts(step.model) : step.model.startsWith("openai/") ? openaiEfforts(step.model) : [];
  }
}

/**
 * What a step sends as its effort, in the API's own name, or null for nothing: the step's effort
 * (default medium), clamped to what the model and the API take. On the ChatGPT plan, `codexLevels`
 * are the model's `supported_reasoning_levels` from Codex's catalog (undefined: not read yet, or
 * the catalog doesn't say, so Gluon's level is sent as it is; []: the model takes none).
 */
export function sentEffort(step: BrainStep, codexLevels?: readonly string[]): string | null {
  const wanted = step.effort ?? BRAIN_EFFORT_DEFAULT;
  if (step.route === "chatgpt-plan") return codexLevels === undefined ? wanted : clampEffort(wanted, codexLevels);
  const supported = stepEfforts(step) ?? [];
  // OpenRouter has no `max`: a model's `max` is sent as its `xhigh`.
  if (step.route === "openrouter") return clampEffort(wanted, supported.map((e) => (e === "max" ? "xhigh" : e)).filter((e) => (OPENROUTER_LEVELS as readonly string[]).includes(e)));
  if (step.route === "bedrock" && !isClaude(step.model)) return clampEffort(wanted, supported.filter((e) => CONVERSE_LEVELS.includes(e)));
  return clampEffort(wanted, supported);
}

/** The `supported_reasoning_levels` of each model in Codex's catalog (`codex debug models` JSON), by slug; a model without the field is left out. */
export function codexReasoningLevels(catalogJson: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  try {
    const catalog = JSON.parse(catalogJson) as { models?: unknown };
    for (const m of Array.isArray(catalog?.models) ? (catalog.models as Record<string, unknown>[]) : []) {
      const levels = m?.supported_reasoning_levels;
      if (typeof m?.slug !== "string" || !Array.isArray(levels)) continue;
      out[m.slug] = levels.flatMap((l) => (typeof l === "string" ? [l] : l && typeof l === "object" && typeof (l as { effort?: unknown }).effort === "string" ? [(l as { effort: string }).effort] : []));
    }
  } catch {}
  return out;
}
