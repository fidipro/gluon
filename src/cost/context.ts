/**
 * Gluon's own context calculation (issue #39): how full a session's window is, from the tokens of
 * the last request (the telemetry's or a harness's per-request counts) and a window that comes only
 * from Gluon's own tables or logic (`ownWindow`). What a harness itself reports as its context
 * (Claude's `session.measure`, OpenCode's model list, agy's `used_percentage`) is never shown: it is
 * compared with ours in the ledger (`ContextEntry`).
 *
 * Pure: no file, network or environment access (the environment arrives as an argument), and never
 * imported by `src/adapters/common.ts`.
 */
import type { Harness } from "../harnesses.ts";
import { agyWindow } from "./antigravity.ts";
import { grokWindowOf, type GrokWindowSource } from "./grok.ts";
import { kimiWindow } from "./kimi.ts";
import { claudeCatalogModel, currentTables, priceEntry, type ClaudeCatalog, type Tables } from "./tables.ts";

export const CLAUDE_STANDARD_WINDOW = 200_000;
export const CLAUDE_1M_WINDOW = 1_000_000;

const oneMillionDisabled = (env: Record<string, string | undefined>) => !!env.CLAUDE_CODE_DISABLE_1M_CONTEXT && !/^(0|false)$/i.test(env.CLAUDE_CODE_DISABLE_1M_CONTEXT);

/**
 * A Claude model's context window as Claude Code sizes it (its model catalog in the 2.1.287
 * binary; Haiku 5.5 from 2.1.293's): 1M natively for Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5 and later, Fable and Mythos;
 * 200k for Opus 4.6, Sonnet 4.6 and older, 1M for those with the `[1m]` suffix; 200k for Haiku 4.5 and older (no 1M
 * form); 200k for all with `CLAUDE_CODE_DISABLE_1M_CONTEXT`. Takes any form a launch or the harness
 * names it by: an alias (`opus`), Gluon's id (`sonnet-4.6`), the API's (`claude-opus-5-5`,
 * dated or not), Bedrock's or OpenRouter's. Undefined when it isn't a Claude model.
 */
export function claudeContextWindowByName(model: string, env: Record<string, string | undefined> = process.env): number | undefined {
  const id = model.toLowerCase().replaceAll(".", "-");
  const m = id.match(/(?:^|[/.:-])(?:claude-)?(opus|sonnet|haiku|fable|mythos)(?:-(\d+)(?:-(\d{1,2}))?)?(?=$|[-@:[])/) ?? id.match(/^(opus|sonnet|haiku|fable|mythos)(?:plan)?(?:\[1m\])?$/);
  if (!m) return undefined;
  if (oneMillionDisabled(env)) return CLAUDE_STANDARD_WINDOW;
  const [, family, major, minor] = m;
  // Claude 3 names put the version first (`claude-3-7-sonnet-…`).
  if ((family === "haiku" && major !== undefined && Number(major) < 5) || /claude-3-/.test(id)) return CLAUDE_STANDARD_WINDOW;
  if (/\[1m\]/.test(id) || family === "fable" || family === "mythos" || major === undefined) return CLAUDE_1M_WINDOW;
  const version = Number(major) + Number(minor ?? 0) / 10;
  const native = family === "opus" ? version >= 4.7 : version >= 5;
  return native ? CLAUDE_1M_WINDOW : CLAUDE_STANDARD_WINDOW;
}

/**
 * A Claude model's context window: from Claude Code's own catalog when the name is in it (its API,
 * Bedrock or Vertex id, dated or not; `[1m]` only where the catalog supports the suffix), else by the
 * name (`claudeContextWindowByName`: an alias such as `opus`, a Gluon id, a model newer than the table).
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT` makes every window 200k.
 */
export function claudeContextWindow(model: string, env: Record<string, string | undefined> = process.env, catalog?: ClaudeCatalog): number | undefined {
  const m = claudeCatalogModel(model, catalog);
  if (!m) return claudeContextWindowByName(model, env);
  if (oneMillionDisabled(env)) return CLAUDE_STANDARD_WINDOW;
  return /\[1m\]$/i.test(model) && m.supports1mSuffix ? CLAUDE_1M_WINDOW : m.window;
}

/** What Codex's catalog says of a model's window: the one it uses, the most it allows, the share of it a conversation may fill. */
export interface CodexWindow {
  context: number;
  max: number;
  percent: number;
}

/** Codex's own default for a model it has no catalog entry for (`model_info_from_slug`). */
export const CODEX_FALLBACK_WINDOW: CodexWindow = { context: 272_000, max: 272_000, percent: 95 };

/**
 * Codex's catalog by model slug (`codex debug models` JSON, as `src/agent/codex.ts` reads it):
 * `context_window` (else `max_context_window`), `max_context_window` and
 * `effective_context_window_percent` (95 when the catalog has none, as Codex's own default).
 * Empty when it isn't that shape.
 */
export function codexCatalogWindows(catalogJson: string): Record<string, CodexWindow> {
  const out: Record<string, CodexWindow> = {};
  try {
    const catalog = JSON.parse(catalogJson) as { models?: unknown };
    for (const m of Array.isArray(catalog?.models) ? (catalog.models as Record<string, unknown>[]) : []) {
      const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
      const context = pos(m?.context_window) ?? pos(m?.max_context_window);
      const max = pos(m?.max_context_window) ?? context;
      const percent = typeof m?.effective_context_window_percent === "number" ? m.effective_context_window_percent : 95;
      if (typeof m?.slug === "string" && !(m.slug in Object.prototype) && context && max && percent > 0 && percent <= 100) out[m.slug] = { context, max, percent };
    }
  } catch {}
  return out;
}

/**
 * The window Codex lets a conversation of this model use, resolved as Codex does
 * (`construct_model_info_from_candidates`): the catalog slug that is the longest prefix of the
 * model; else, for `namespace/name` (one segment, a plain provider id), the same on the name; else
 * Codex's fallback entry. A `model_context_window` override (the config's: exported as the
 * conversation's `context_window`) replaces the window, capped by the model's maximum; the
 * result is that times the effective percent, rounded down.
 */
export function codexUsableWindow(model: string, catalog: Record<string, CodexWindow>, override?: number): number {
  const slug = codexSlug(model, catalog);
  const w = slug === undefined ? CODEX_FALLBACK_WINDOW : catalog[slug]!;
  const window = override !== undefined && override > 0 ? Math.min(override, w.max) : w.context;
  return Math.floor((window * w.percent) / 100);
}

/** The catalog slug Codex resolves a model to (see `codexUsableWindow`), or undefined when it falls to its fallback entry. */
function codexSlug(model: string, catalog: Record<string, CodexWindow>): string | undefined {
  const longest = (name: string) => {
    let best: string | undefined;
    for (const slug of Object.keys(catalog)) if (name.startsWith(slug) && (best === undefined || slug.length > best.length)) best = slug;
    return best;
  };
  let slug = longest(model);
  if (slug === undefined) {
    const [namespace, name, ...rest] = model.split("/");
    if (name !== undefined && !rest.length && /^[A-Za-z0-9_-]+$/.test(namespace!)) slug = longest(name);
  }
  return slug;
}

/**
 * Codex's context windows by model slug, from its catalog: `context_window` × `effective_context_window_percent`
 * (the part Codex lets a conversation use, as its footer counts it). Empty when it isn't that shape.
 */
export function codexContextWindows(catalogJson: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [slug, w] of Object.entries(codexCatalogWindows(catalogJson))) out[slug] = Math.floor((w.context * w.percent) / 100);
  return out;
}

/**
 * Codex's own count of what the user controls: a baseline of tokens always in the context (its
 * `BASELINE_TOKENS`: prompts, tools and room to compact) is taken from the prompt and the window.
 */
export const CODEX_BASELINE_TOKENS = 12_000;

/** Codex's footer counts the baseline off both sides (it shows what is left: 100 minus this). */
function codexPercent(tokens: number, window: number): number {
  if (window <= CODEX_BASELINE_TOKENS) return 100;
  return Math.min(100, (Math.max(0, tokens - CODEX_BASELINE_TOKENS) / (window - CODEX_BASELINE_TOKENS)) * 100);
}

/**
 * How full the context window is, in percent (0–100), or undefined when the window isn't known.
 * `window`: the window itself, or a model to look up (Claude by `claudeContextWindow`, Codex in
 * `codex`, its catalog's windows). Each harness is counted as its own display counts it: Codex's
 * footer takes `CODEX_BASELINE_TOKENS` off both sides. `peak`: the largest prompt this session has
 * had: Claude Code's telemetry names a model without its `[1m]` suffix, so a prompt larger than the
 * 200k window it would otherwise be sized by proves a 1M one (it is undetectable below that: such
 * a session reads 5× too full until it grows past 200k).
 */
export function contextPercent(tokens: number, window: number | string | undefined, { codex = {}, env = process.env, peak = 0, codexCatalog, codexOverride }: { codex?: Record<string, number>; env?: Record<string, string | undefined>; peak?: number; codexCatalog?: Record<string, CodexWindow>; codexOverride?: number } = {}): number | undefined {
  if (!(tokens >= 0) || !Number.isFinite(tokens)) return undefined;
  // A Codex session (`codexCatalog`, even an empty one): any model name resolves as Codex resolves it.
  const codexWindow = typeof window === "string" ? (codexCatalog ? codexUsableWindow(window, codexCatalog, codexOverride) : codex[window]) : undefined;
  if (codexWindow) return codexPercent(tokens, codexWindow);
  let size = typeof window === "number" ? window : window === undefined ? undefined : claudeContextWindow(window, env);
  if (typeof window === "string" && size === CLAUDE_STANDARD_WINDOW && Math.max(tokens, peak) > size) size = CLAUDE_1M_WINDOW;
  if (!size || !(size > 0)) return undefined;
  return Math.min(100, (tokens / size) * 100);
}

/** Where an own window came from: a Gluon table or rule, or `none` (Gluon has no window of its own for it). */
export type WindowSource = "claude-catalog" | "claude-name" | "claude-launched" | "claude-peak" | "claude-1m-disabled" | "codex-catalog" | "codex-fallback" | GrokWindowSource | "agy-table" | "kimi-models-dev" | "opencode-models-dev" | "override" | "none";

export interface OwnWindowOptions {
  /** The model the session was launched with (its name as the launch used): the window of a reported name Gluon can't size. */
  launchedModel?: string;
  /** The largest prompt this model has had in the session (per model: BUG-366): a Claude prompt past 200k proves a 1M window (the telemetry names models without `[1m]`). */
  peak?: number;
  /** The environment the window rules read (`CLAUDE_CODE_DISABLE_1M_CONTEXT`); empty unless the caller passes one (this file reads none). */
  env?: Record<string, string | undefined>;
  /** A window the user's own config sets (Codex's `model_context_window`, capped by the model's maximum): Codex's alone; no other harness reads it. */
  override?: number;
  /** The tables to size by (a session's pinned ones, `CostTracker.tables()`); default: the current ones. */
  tables?: Tables;
}

/**
 * Whether the launched model's `[1m]` suffix is the one the reported model has: same catalog model (or, for a launch by alias such as
 * `opus[1m]`, the same family), and the catalog says that model supports the suffix.
 */
function launchedOneMillion(launched: string, reported: string, catalog?: ClaudeCatalog): boolean {
  if (!/\[1m\]$/i.test(launched)) return false;
  const r = claudeCatalogModel(reported, catalog);
  if (!r?.supports1mSuffix) return false;
  const l = claudeCatalogModel(launched, catalog);
  return l ? l.id === r.id : launched.replace(/\[1m\]$/i, "").toLowerCase() === r.family;
}

/**
 * The table a harness's window is read from (`ownWindow`): Claude Code's catalog, Codex's windows, Grok's table, models.dev's for the rest. Until that table
 * exists the window is unknown (never a name rule or a default of a harness's); a session pins it once, as it pins its prices (`CostTracker.windowReady`).
 */
export const windowTable = (harness: Harness): keyof Tables | undefined => (harness === "claude-code" ? "claudeCatalog" : harness === "codex" ? "codexWindows" : harness === "grok-build" ? "grokModels" : "modelsdev");

/**
 * The window Gluon sizes a session's context by, from its own tables: Claude Code's catalog and
 * rules, Codex's windows (`codexWindows`, built from the installed `codex`'s catalog), Grok's table, Antigravity's table and
 * models.dev's `limit.context` for OpenCode (a model it has no entry for: none). `model`: the name the harness
 * reported on the request (OpenCode: `<provider>/<id>`).
 */
export function ownWindow(harness: Harness, model: string | undefined, { launchedModel, peak = 0, env = {}, override, tables = currentTables() }: OwnWindowOptions = {}): { window: number | undefined; source: WindowSource } {
  const name = model ?? launchedModel;
  if (harness === "codex") {
    if (!name) return { window: undefined, source: "none" };
    // Codex's own resolution (prefix, namespace, fallback; the config's `model_context_window`) over the local table (none yet: the fallback an unknown model gets).
    const catalog = tables.codexWindows?.models ?? {};
    return { window: codexUsableWindow(name, catalog, override), source: override && override > 0 ? "override" : codexSlug(name, catalog) !== undefined ? "codex-catalog" : "codex-fallback" };
  }
  // The config's `model_context_window` is Codex's: no other harness reads it, so it is no window of theirs (BUG-366).
  if (harness === "grok-build") return name ? grokWindowOf(name, tables.grokModels) : { window: undefined, source: "none" };
  if (harness === "kimi-code") {
    const window = name ? kimiWindow(name, tables.modelsdev) : undefined;
    return window === undefined ? { window: undefined, source: "none" } : { window, source: "kimi-models-dev" };
  }
  if (harness === "antigravity") {
    // The reported name first, else the launched model's (the status line may name a model Gluon has no entry for).
    const window = (model ? agyWindow(model, tables.modelsdev) : undefined) ?? (launchedModel ? agyWindow(launchedModel, tables.modelsdev) : undefined);
    return window === undefined ? { window: undefined, source: "none" } : { window, source: "agy-table" };
  }
  if (harness === "claude-code") {
    const catalog = tables.claudeCatalog;
    let window = model ? claudeContextWindow(model, env, catalog) : undefined;
    let source: WindowSource = model && claudeCatalogModel(model, catalog) ? "claude-catalog" : "claude-name";
    if (window === undefined && launchedModel) {
      window = claudeContextWindow(launchedModel, env, catalog);
      source = "claude-launched";
    }
    if (window === undefined) return { window: undefined, source: "none" };
    if (oneMillionDisabled(env)) return { window, source: "claude-1m-disabled" };
    // The telemetry names a model without its `[1m]`: the launched model's suffix carries over to the same model, where the catalog supports it.
    if (window === CLAUDE_STANDARD_WINDOW && model && launchedModel && launchedOneMillion(launchedModel, model, catalog)) return { window: CLAUDE_1M_WINDOW, source: "claude-launched" };
    if (window === CLAUDE_STANDARD_WINDOW && peak > window) return { window: CLAUDE_1M_WINDOW, source: "claude-peak" };
    return { window, source };
  }
  // OpenCode sizes a model by models.dev's `limit.context` (its footer's denominator) too: `model` is `<provider>/<id>`, the table's key.
  if (harness === "opencode") {
    const window = priceEntry(name, tables.modelsdev)?.context;
    return window ? { window, source: "opencode-models-dev" } : { window: undefined, source: "none" };
  }
  return { window: undefined, source: "none" };
}

/** Whether a window is a guess (a model no table of ours knows, sized by a default): shown nowhere as a figure, recorded with `unknown-model` (BUG-369). */
export const windowIsGuess = (source: WindowSource): boolean => source === "grok-default";

/** Gluon's own percentage (0–100) of this window for these tokens, counted as the harness's own display counts it (Codex: baseline off both sides); undefined when either is unknown. */
export function ownPercent(harness: Harness, tokens: number, window: number | undefined): number | undefined {
  if (!(tokens >= 0) || !Number.isFinite(tokens) || !window || !(window > 0)) return undefined;
  return harness === "codex" ? codexPercent(tokens, window) : Math.min(100, (tokens / window) * 100);
}

/** Which of the two figures differ: the tokens counted, the window used, both, or neither (the percentages agree within a point). */
export type ContextCause = "none" | "tokens" | "window" | "both";

/**
 * Why our percentage differs from a harness's: tokens (we count different ones), window (the sizes
 * differ), both. A figure missing on either side counts as differing; equal percentages (within a
 * point, the display's rounding) are `none` whatever the inputs.
 */
export function contextCause(own: { pct?: number; tokens?: number; window?: number }, reported: { pct?: number; tokens?: number; window?: number }): ContextCause {
  if (own.pct !== undefined && reported.pct !== undefined && Math.abs(own.pct - reported.pct) <= 1) return "none";
  const tokens = own.tokens !== undefined && reported.tokens !== undefined && Math.abs(own.tokens - reported.tokens) <= Math.max(1, reported.tokens / 1000);
  const window = own.window !== undefined && reported.window !== undefined && own.window === reported.window;
  return tokens && window ? "none" : tokens ? "window" : window ? "tokens" : "both";
}
