// Routing: turns the intake agent's classification into mode + agent, using routing.yaml (the
// user's preferences, including which models serve each level) and a catalog (facts about
// harnesses and models, passed in: this file knows none). Deterministic, offline.
//
// The intake agent decides, per type, how many steps to move the model and the effort (using the
// type's example lists as guidance). `route` only does the arithmetic, applies the user's rank and
// limits, and picks the model. Loading routing.yaml: `routing-config.ts`.

export const LEVELS = ["light", "standard", "strong", "extra", "frontier"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];
export type Effort = (typeof EFFORTS)[number];
export type Mode = "explore" | "build" | "plan";
export const MODES: Mode[] = ["explore", "build", "plan"]; // strength order: plan > build > explore

/** Facts about one model, as routing needs them. */
export interface RouteModel {
  id: string;               // what route, pins and routing.yaml use
  name?: string;            // what the developer may call it
  efforts: Effort[];        // [] = no effort control
  defaultEffort?: Effort;   // this model's sweet spot; route starts here (medium when unset)
  family?: string;          // models of one family can delegate to each other as subagents
  current?: string;         // for a "latest" alias: the concrete model id the launcher passes
  sharesDataWith?: string;  // the maker gets the session's code and prompts
  optIn?: string;           // routing.yaml key that must be true before this model is used
}
export interface RouteHarness {
  id: string;
  name: string;
  delegatesInFamily?: boolean;  // the launcher tells the agent which family models it may use for subagents
  noModes?: Mode[];             // modes this harness can't run (`ModeLaunch.unavailable`): a session in one never goes to it
  models: RouteModel[];
}
export type RouteCatalog = RouteHarness[];

export interface TypeDef {
  means: string; mode: Mode; model: Level; effort: Effort; ask?: string[]; use?: string | null;
  plan_when?: string[]; build_when?: string[]; explore_when?: string[];
  stronger_model_when?: string[]; more_effort_when?: string[]; lighter_model_when?: string[];
}
export interface Config {
  version?: number;
  rank: Partial<Record<Level, string[]>>;   // per level, "harness/model" in priority order
  allow_muse_contributor?: boolean;
  limits?: { never_harnesses?: string[]; never_models?: string[]; max_model?: Level; max_effort?: Effort };
  prefer?: string[] | null;
  instructions?: string | null;
  types: Record<string, TypeDef>;
}
export interface TypeCall {
  type: string;
  model_steps?: number;        // -2..2, the intake agent's judgment
  effort_steps?: number;       // 0..2, the intake agent's judgment
  mode?: Mode;                 // only when it differs from the type's
  reasons?: string;            // what it saw
}
export interface RouteInput {
  types: TypeCall[];
  mode?: Mode;                 // the developer asked for a mode
  pinned?: string;             // the developer named: harness | harness/model | harness/model@effort
  harness?: string;            // from a preference: within each level, try this harness's models first
  because?: string;            // the preference note, required with `harness`
}
export interface Agent { harness: string; model: string; effort?: Effort }
export type RouteResult =
  | { mode: Mode; recommended: Agent; alternatives: Agent[]; why: string[] }
  | { error: string };

/** The harnesses the user has connected (each on its own: subscription, key or Bedrock). Route only needs to know which. Undefined = all. */
export interface Env { connected?: string[] }

const MEDIUM = EFFORTS.indexOf("medium");
const XHIGH = EFFORTS.indexOf("xhigh");
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const fmt = (a: Agent) => `${a.harness}/${a.model}${a.effort ? "@" + a.effort : ""}`;
const key = (h: string, m: string) => `${h}/${m}`;
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
/** A YAML value that should be a list of strings: anything else counts as empty (`checkConfig` says so). */
const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const rankList = (cfg: Config, level: Level): string[] => list(cfg.rank?.[level]);
const isLevel = (x: unknown): x is Level => LEVELS.includes(x as Level);
const isEffort = (x: unknown): x is Effort => EFFORTS.includes(x as Effort);
const optedIn = (cfg: Config, m: RouteModel) => !m.optIn || (cfg as unknown as Record<string, unknown>)[m.optIn] === true;

/** The catalog as this user sees it: denied, unconnected and not-opted-in models removed. */
export function usableCatalog(cfg: Config, catalog: RouteCatalog, env: Env = {}): RouteCatalog {
  const deny = list(cfg.limits?.never_harnesses);
  const denyModels = list(cfg.limits?.never_models);
  return catalog
    .filter((h) => !deny.includes(h.id) && (!env.connected || env.connected.includes(h.id)))
    .map((h) => ({
      ...h,
      models: h.models
        .filter((m) => !denyModels.includes(m.id) && !denyModels.includes(key(h.id, m.id)))
        .filter((m) => optedIn(cfg, m)),
    }));
}

/** The level index a model serves: the rank list it appears in (-1 = none, pin-only). */
export function levelOf(cfg: Config, harness: string, model: string): number {
  return LEVELS.findIndex((l) => rankList(cfg, l).includes(key(harness, model)));
}

/**
 * A pin is `harness`, `harness/model` or `harness/model@effort`, each part non-empty and no part twice: `claude-code/sonnet@`
 * is no agent with an empty effort and `@max@low` doesn't drop its second effort (BUG-647). The names aren't looked up here.
 */
function parsePin(pin: string): { hid: string; mid?: string; eff?: string } | { error: string } {
  const bad = { error: `"${pin}" isn't a pin: use harness, harness/model or harness/model@effort` };
  const at = pin.split("@");
  if (at.length > 2) return bad;
  const parts = at[0]!.split("/");
  if (parts.length > 2 || parts.some((p) => p === "") || (at.length === 2 && at[1] === "")) return bad;
  return { hid: parts[0]!, ...(parts[1] ? { mid: parts[1] } : {}), ...(at[1] ? { eff: at[1] } : {}) };
}

/** Edit distance with a swapped pair of letters counting once (`modle` is one from `model`). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
  }
  return d[a.length]![b.length]!;
}

/**
 * Keys of `obj` that aren't in `known` but look like one of them (a typo: `limit:` for `limits:`), as problems under `where`.
 * Other unknown keys are left alone: a file may carry its own anchors (`x: &lvl light`) (BUG-645).
 */
function nearMisses(obj: unknown, known: readonly string[], where: string): string[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return [];
  const out: string[] = [];
  for (const k of Object.keys(obj)) {
    if (known.includes(k)) continue;
    const lower = k.toLowerCase();
    const near = known
      .map((n) => ({ n, d: editDistance(lower, n) }))
      .filter(({ n, d }) => d <= (Math.min(lower.length, n.length) < 5 ? 1 : 2))
      .sort((a, b) => a.d - b.d || Math.abs(a.n.length - lower.length) - Math.abs(b.n.length - lower.length))[0]?.n;
    if (near) out.push(`${where}${k}: not a key routing.yaml has (it is ignored); did you mean ${near}?`);
  }
  return out;
}

const TOP_KEYS = ["version", "rank", "allow_muse_contributor", "limits", "prefer", "instructions", "types"] as const;
const LIMIT_KEYS = ["never_harnesses", "never_models", "max_model", "max_effort"] as const;
const TYPE_KEYS = ["means", "mode", "model", "effort", "ask", "use", "plan_when", "build_when", "explore_when", "stronger_model_when", "more_effort_when", "lighter_model_when"] as const;

/** Problems in routing.yaml, for `gluon routing check`. */
export function checkConfig(cfg: Config, catalog: RouteCatalog): string[] {
  const errors: string[] = [];
  const seen = new Map<string, Level>();
  const exists = (h: string | undefined, m?: string) => {
    const harness = catalog.find((x) => x.id === h);
    return !!harness && (!m || !!harness.models.find((x) => x.id === m));
  };
  const isMap = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x);
  errors.push(...nearMisses(cfg, [...TOP_KEYS, ...catalog.flatMap((h) => h.models.flatMap((m) => (m.optIn ? [m.optIn] : [])))], ""));
  if (!isMap(cfg.rank)) errors.push("rank: must be a mapping from level to a list of harness/model");
  else {
    for (const l of Object.keys(cfg.rank)) if (!isLevel(l)) errors.push(`rank: unknown level ${l}`);
    for (const l of LEVELS) {
      const entries = cfg.rank[l];
      if (entries == null) continue;
      if (!Array.isArray(entries)) { errors.push(`rank.${l}: must be a list`); continue; }
      for (const entry of entries) {
        const [h, m] = typeof entry === "string" ? entry.split("/") : [];
        if (!m || !exists(h, m)) errors.push(`rank.${l}: unknown model ${entry}`);
        if (seen.has(String(entry))) errors.push(`rank.${l}: ${entry} is already in rank.${seen.get(String(entry))}`);
        seen.set(String(entry), l);
      }
    }
  }
  const lim = cfg.limits ?? {};
  if (!isMap(lim)) errors.push("limits: must be a mapping");
  else {
    errors.push(...nearMisses(lim, LIMIT_KEYS, "limits."));
    if (lim.max_model && !isLevel(lim.max_model)) errors.push(`limits.max_model: unknown level ${lim.max_model}`);
    if (lim.max_effort && !isEffort(lim.max_effort)) errors.push(`limits.max_effort: unknown effort ${lim.max_effort}`);
    for (const f of ["never_harnesses", "never_models"] as const) {
      const v = lim[f];
      if (v == null) continue;
      if (!Array.isArray(v)) { errors.push(`limits.${f}: must be a list`); continue; }
      for (const e of v) {
        const [a, b] = String(e).split("/");
        const ok = f === "never_harnesses" ? exists(String(e)) : b ? exists(a, b) : catalog.some((h) => h.models.some((m) => m.id === a));
        if (!ok) errors.push(`limits.${f}: unknown ${f === "never_harnesses" ? "harness" : "model"} ${e}`);
      }
    }
  }
  if (cfg.prefer != null && !Array.isArray(cfg.prefer)) errors.push("prefer: must be a list of notes");
  if (cfg.instructions != null && typeof cfg.instructions !== "string") errors.push("instructions: must be text");
  if (cfg.allow_muse_contributor != null && typeof cfg.allow_muse_contributor !== "boolean") errors.push("allow_muse_contributor: must be true or false (anything else leaves it off)");
  if (!isMap(cfg.types)) errors.push("types: must be a mapping from a type's name to its fields");
  else for (const [name, t] of Object.entries(cfg.types)) {
    if (!isMap(t)) { errors.push(`types.${name}: must be a mapping`); continue; }
    errors.push(...nearMisses(t, TYPE_KEYS, `types.${name}.`));
    if (!MODES.includes(t.mode)) errors.push(`types.${name}.mode: unknown mode ${t.mode}`);
    if (!isLevel(t.model)) errors.push(`types.${name}.model: unknown level ${t.model}`);
    if (!isEffort(t.effort)) errors.push(`types.${name}.effort: unknown effort ${t.effort}`);
    for (const f of ["lighter_model_when", "stronger_model_when", "more_effort_when", "plan_when", "build_when", "explore_when", "ask"] as const) {
      if (t[f] != null && !Array.isArray(t[f])) errors.push(`types.${name}.${f}: must be a list`);
    }
    if (t.use) {
      if (typeof t.use !== "string") errors.push(`types.${name}.use: must be harness, harness/model or harness/model@effort`);
      else {
        const pin = parsePin(t.use);
        if ("error" in pin) errors.push(`types.${name}.use: must be harness, harness/model or harness/model@effort`);
        else {
          const { hid: h, mid: m, eff: e } = pin;
          if (!exists(h, m)) errors.push(`types.${name}.use: unknown agent ${t.use}`);
          else if (e && !isEffort(e)) errors.push(`types.${name}.use: unknown effort ${e}`);
          else if (e && m && !catalog.find((x) => x.id === h)!.models.find((x) => x.id === m)!.efforts.includes(e as Effort)) errors.push(`types.${name}.use: ${m} doesn't accept effort ${e}`);
        }
      }
    }
  }
  return errors;
}

/** The efforts this model may use under the limits: `max` only when the model's own default is max (a pin bypasses this). */
function allowedEfforts(m: RouteModel, maxEffort: number): Effort[] {
  return m.efforts.filter((e) => EFFORTS.indexOf(e) <= maxEffort && (e !== "max" || m.defaultEffort === "max"));
}

/** A model is usable under the limits if it has no effort control, or at least one allowed effort. */
const usable = (m: RouteModel, maxEffort: number) => m.efforts.length === 0 || allowedEfforts(m, maxEffort).length > 0;

/** The effort for this model: its own default (sweet spot) moved by `steps`, then the nearest allowed level, rounding up. */
function pickEffort(m: RouteModel, steps: number, maxEffort: number): Effort | undefined {
  const ok = allowedEfforts(m, maxEffort);
  if (ok.length === 0) return undefined;
  const need = clamp(EFFORTS.indexOf(m.defaultEffort ?? "medium") + steps, 0, maxEffort);
  return ok.find((e) => EFFORTS.indexOf(e) >= need) ?? ok[ok.length - 1];
}

/**
 * Can this model give the effort the session needs? A model without effort control can't give more
 * than its default; xhigh counts as reaching max, since max is only used when it is the model's own
 * default or pinned.
 */
function reaches(m: RouteModel, steps: number, maxEffort: number): boolean {
  if (m.efforts.length === 0) return steps <= 0;
  const ok = allowedEfforts(m, maxEffort);
  if (ok.length === 0) return false;
  const need = clamp(EFFORTS.indexOf(m.defaultEffort ?? "medium") + steps, 0, maxEffort);
  return EFFORTS.indexOf(ok[ok.length - 1]!) >= Math.min(need, XHIGH);
}

const LEVEL_USE: Record<Level, string> = {
  light: "small, mechanical subtasks", standard: "everyday subtasks",
  strong: "harder subtasks", extra: "hard or ambiguous subtasks", frontier: "the hardest subtasks",
};
/**
 * Launcher helper: for harnesses that delegate within a family (OpenCode), the line added to the
 * agent's instructions listing the models it may use for subagents, in rank order (cheapest first).
 */
export function subagentNote(cfg: Config, catalog: RouteCatalog, agent: Agent): string | undefined {
  const h = usableCatalog(cfg, catalog).find((x) => x.id === agent.harness);
  const main = h?.models.find((m) => m.id === agent.model);
  if (!h?.delegatesInFamily || !main?.family) return undefined;
  const order = LEVELS.flatMap((l) => rankList(cfg, l));
  const maxLevel = LEVELS.indexOf(cfg.limits?.max_model ?? "frontier");
  const members = h.models
    .filter((m) => m.family === main.family && levelOf(cfg, h.id, m.id) >= 0 && levelOf(cfg, h.id, m.id) <= maxLevel)
    .sort((a, b) => order.indexOf(key(h.id, a.id)) - order.indexOf(key(h.id, b.id)));
  if (members.length < 2) return undefined;
  const items = members.map((m) => `${m.current ?? m.id} (${LEVEL_USE[LEVELS[levelOf(cfg, h.id, m.id)]!]})`).join(", ");
  return `For subagents, you may set the model to one of these, cheapest first: ${items}. Use the cheapest one that fits the subtask; use no other model.`;
}

export function route(cfg: Config, catalog: RouteCatalog, input: RouteInput, env: Env = {}): RouteResult {
  const why: string[] = [];
  const harnesses = usableCatalog(cfg, catalog, env);
  const maxLevel = LEVELS.indexOf(cfg.limits?.max_model ?? "frontier");
  const maxEffort = EFFORTS.indexOf(cfg.limits?.max_effort ?? "max");
  if (maxLevel < 0 || maxEffort < 0) return { error: "routing.yaml has an unknown limits.max_model or limits.max_effort; `gluon routing check` says which" };
  if (!Array.isArray(input.types) || input.types.length === 0) return { error: "route needs at least one type" };
  if (input.harness && !input.because) return { error: "`harness` comes from a preference: quote the note in `because`" };
  if (input.mode && !MODES.includes(input.mode)) return { error: "mode must be explore, build or plan" };

  // 1-2. Each type on its own: mode, level, effort steps.
  let mode: Mode = "explore", level = 0, steps = -Infinity;
  for (const tc of input.types) {
    const t = cfg.types && Object.hasOwn(cfg.types, tc.type) ? cfg.types[tc.type] : undefined;
    if (!t) return { error: `unknown type "${tc.type}"; use one from <types>` };
    const ms = tc.model_steps ?? 0, es = tc.effort_steps ?? 0;
    if (!Number.isInteger(ms) || ms < -2 || ms > 2) return { error: `${tc.type}: model_steps must be an integer from -2 to 2` };
    if (!Number.isInteger(es) || es < 0 || es > 2) return { error: `${tc.type}: effort_steps must be an integer from 0 to 2` };
    if (tc.mode && !MODES.includes(tc.mode)) return { error: `${tc.type}: mode must be explore, build or plan` };
    if (!MODES.includes(t.mode) || !isLevel(t.model) || !isEffort(t.effort)) return { error: `types.${tc.type} in routing.yaml has an unknown mode, model or effort; \`gluon routing check\` says which` };
    const tMode = tc.mode ?? t.mode;
    const tLevel = clamp(LEVELS.indexOf(t.model) + ms, 0, LEVELS.length - 1);
    // A type's effort is relative to medium: medium = the model's own default.
    const tSteps = EFFORTS.indexOf(t.effort) - MEDIUM + es;
    why.push(`${tc.type}: ${tMode}, ${LEVELS[tLevel]}, effort ${signed(tSteps)}${tc.reasons ? ` (${tc.reasons})` : ""}`);
    // 3. Strongest across types.
    if (MODES.indexOf(tMode) > MODES.indexOf(mode)) mode = tMode;
    level = Math.max(level, tLevel);
    steps = Math.max(steps, tSteps);
  }
  if (input.mode) { mode = input.mode; why.push(`mode ${mode}: the developer asked`); }
  // A preference naming a harness that isn't available (unknown, denied, not connected) can't be applied: say so, route without it (BUG-451).
  let prefer = input.harness;
  if (prefer && !harnesses.some((h) => h.id === prefer)) {
    why.push(`preference "${input.because}" names ${prefer}, which isn't available; ignored`);
    prefer = undefined;
  } else if (prefer) why.push(`preference: "${input.because}"`);
  if (level > maxLevel) why.push(`level capped at ${LEVELS[maxLevel]} by your limits`);
  level = Math.min(level, maxLevel);

  // A harness that can't run the session's mode (Kimi Code's explore) is out for it: no candidate, no alternative, no pin.
  const cantRun = harnesses.filter((h) => h.noModes?.includes(mode)).map((h) => h.id);
  if (cantRun.length) why.push(`${cantRun.join(", ")} can't run ${mode} mode: left out`);
  const runnable = harnesses.filter((h) => !cantRun.includes(h.id));

  type Cand = { h: string; m: RouteModel };
  const find = (h: string, m: string) => runnable.find((x) => x.id === h)?.models.find((x) => x.id === m);

  // The usable models at one level, in rank order; a preferred harness first.
  const at = (lvl: number, onlyHarness?: string): Cand[] => {
    const entries = rankList(cfg, LEVELS[lvl]!)
      .map((e) => { const [h, m] = e.split("/"); const model = find(h!, m!); return model ? { h: h!, m: model } : undefined; })
      .filter((x): x is Cand => !!x && usable(x.m, maxEffort))
      .filter((x) => !onlyHarness || x.h === onlyHarness);
    return prefer ? [...entries.filter((x) => x.h === prefer), ...entries.filter((x) => x.h !== prefer)] : entries;
  };

  // From the needed level upward, the first level with a model that can give the effort the session
  // needs; each level rounded up lowers that need one step (the stronger model needs less thinking
  // for the same work). If no model reaches it anywhere, the first usable model, at its top effort.
  const firstFrom = (lvl: number, onlyHarness?: string) => {
    for (let l = lvl; l <= maxLevel; l++) {
      const found = at(l, onlyHarness).filter((c) => reaches(c.m, steps - (l - lvl), maxEffort));
      if (found.length) return { l, list: found, reached: true };
    }
    for (let l = lvl; l <= maxLevel; l++) {
      const found = at(l, onlyHarness);
      if (found.length) return { l, list: found, reached: false };
    }
    return undefined;
  };

  const agentFor = (c: Cand, l: number, lvl: number): Agent =>
    ({ harness: c.h, model: c.m.id, effort: pickEffort(c.m, steps - Math.max(0, l - lvl), maxEffort) });

  // Pins: the developer's, or a `use:` shared by every type.
  // A `use:` that isn't text is a mistake `checkConfig` reports: no pin (BUG-460).
  const typePins = input.types.map((t) => { const u = cfg.types[t.type]!.use; return typeof u === "string" && u ? u : undefined; });
  const sharedPin = typePins.every((p) => p && p === typePins[0]) ? typePins[0] ?? undefined : undefined;
  const resolvePin = (pin: string): Agent | { error: string } => {
    const parsed = parsePin(pin);
    if ("error" in parsed) return parsed;
    const { hid, mid, eff: e } = parsed;
    const eff = e as Effort | undefined;
    if (eff && !isEffort(eff)) return { error: `unknown effort ${e}` };
    if (eff && EFFORTS.indexOf(eff) > maxEffort) return { error: `${eff} is above your max_effort (${EFFORTS[maxEffort]})` };
    if (!harnesses.find((x) => x.id === hid)) return { error: `${hid} isn't available (not connected, or denied in your config)` };
    if (cantRun.includes(hid!)) return { error: `${hid} can't run ${mode} mode; pick another agent or another mode` };
    if (mid) {
      const m = find(hid!, mid);
      if (!m) {
        const raw = catalog.find((x) => x.id === hid)?.models.find((x) => x.id === mid);
        if (raw?.optIn && !optedIn(cfg, raw)) return { error: `${mid} shares data with ${raw.sharesDataWith}; set ${raw.optIn}: true in routing.yaml to use it` };
        return { error: `${hid}/${mid} isn't available (unknown, or denied in your config)` };
      }
      if (levelOf(cfg, hid!, mid) > maxLevel) return { error: `${mid} is above your max_model (${LEVELS[maxLevel]})` };
      if (eff && !m.efforts.includes(eff)) return { error: `${mid} accepts efforts: ${m.efforts.join(", ") || "none"}` };
      if (!eff && !usable(m, maxEffort)) return { error: `${mid} has no effort within your max_effort (${EFFORTS[maxEffort]})` };
      return { harness: hid!, model: mid, effort: eff ?? pickEffort(m, steps, maxEffort) };
    }
    // A harness alone: its best model at the level or above (one that takes the named effort, if any); nothing there: its best below.
    const takes = (c: Cand) => !eff || c.m.efforts.includes(eff);
    const found = firstFrom(level, hid);
    const up = found?.list.find(takes);
    if (up) return { ...agentFor(up, found!.l, level), ...(eff ? { effort: eff } : {}) };
    if (found) return { error: `${hid}'s models at ${LEVELS[level]} or above don't accept effort ${eff} (${found.list[0]!.m.id} accepts: ${found.list[0]!.m.efforts.join(", ") || "none"})` };
    let below: Cand | undefined, bl = -1;
    for (let l = level - 1; l >= 0 && !below; l--) { below = at(l, hid).find(takes); bl = l; }
    if (!below) return { error: `${hid} has no ranked model you can use${eff ? ` with effort ${eff}` : ""}` };
    why.push(`${hid} has nothing at ${LEVELS[level]}; using its best model, ${LEVELS[bl]}`);
    return { ...agentFor(below, bl, bl), ...(eff ? { effort: eff } : {}) };
  };
  if (input.pinned) {
    const agent = resolvePin(input.pinned);
    if ("error" in agent) return agent;
    why.push(`pinned by the developer: ${input.pinned}`);
    return { mode, recommended: agent, alternatives: [], why };
  }
  // A type's `use:` that isn't available is not the developer's word: route normally and say so (BUG-452).
  if (sharedPin) {
    const agent = resolvePin(sharedPin);
    if ("error" in agent) why.push(`use: ${sharedPin} isn't available (${agent.error}); routing normally`);
    else {
      why.push(`pinned by every type's use: ${sharedPin}`);
      return { mode, recommended: agent, alternatives: [], why };
    }
  }

  // 4. The first model in the level's rank list that can give the needed effort.
  const found = firstFrom(level);
  if (!found) return { error: `no connected model at ${LEVELS[level]} or above` };
  const recommended = agentFor(found.list[0]!, found.l, level);
  if (found.l > level) why.push(`nothing usable at ${LEVELS[level]} for this effort; rounded up to ${LEVELS[found.l]}`);
  if (!found.reached) why.push("no model reaches the needed effort; using the best available");

  // 5. Alternatives: the next model in the same list, then the first one level down.
  const alternatives: Agent[] = [];
  const same = (a: Agent, b: Agent) => a.harness === b.harness && a.model === b.model;
  const next = found.list.slice(1).map((c) => agentFor(c, found.l, level)).find((a) => !same(a, recommended));
  if (next) alternatives.push(next);
  if (level > 0) {
    const down = firstFrom(level - 1);
    if (down && down.l < found.l) {
      const a = agentFor(down.list[0]!, down.l, level - 1);
      if (!same(a, recommended) && !alternatives.some((x) => same(x, a))) alternatives.push(a);
    }
  }
  // The model's own default and what was applied to it: a level rounded up takes a step off per level (`agentFor`).
  const top = found.list[0]!.m;
  const applied = steps - (found.l - level);
  const rounded = applied !== steps ? ` (${signed(applied)} after rounding up to ${LEVELS[found.l]})` : "";
  const from = top.efforts.length ? ` from ${top.id}'s default (${top.defaultEffort ?? "medium"})` : ` (${top.id} takes no effort setting)`;
  why.push(`session: ${mode}, ${LEVELS[level]}, effort ${signed(steps)}${rounded}${from} → ${fmt(recommended)}`);
  return { mode, recommended, alternatives: alternatives.slice(0, 2), why };
}

// --- the `<available_agents>` block: what the intake agent sees of the catalog and routing.yaml

/** "id (Name)"; the name only when it differs from the id; a "(latest)" in it reads ", latest". */
function label(id: string, name?: string): string {
  const n = name?.replace(/\s*\(([^)]*)\)/g, ", $1");
  return n && n !== id ? `${id} (${n})` : id;
}

/**
 * The block the intake agent gets at the start of a session: every usable model under its harness
 * (harnesses in catalog order, models in rank order, unranked last), then one line for each thing
 * that is not available and why. Levels, efforts and prices are left out: routing happens in code.
 * `catalog` is what this user's Gluon offers; `allCatalog` (default: `catalog`) is where the
 * unavailable lines come from, so a harness Gluon doesn't offer yet can still be explained.
 */
export function renderAvailableAgents(cfg: Config, catalog: RouteCatalog, env: Env = {}, allCatalog: RouteCatalog = catalog): string {
  const maxLevel = LEVELS.indexOf(cfg.limits?.max_model ?? "frontier");
  const maxEffort = EFFORTS.indexOf(cfg.limits?.max_effort ?? "max") < 0 ? EFFORTS.length - 1 : EFFORTS.indexOf(cfg.limits?.max_effort ?? "max");
  const deny = list(cfg.limits?.never_harnesses);
  const denyModels = list(cfg.limits?.never_models);
  const order = LEVELS.flatMap((l) => rankList(cfg, l));
  const rankOf = (h: string, m: string) => { const i = order.indexOf(key(h, m)); return i < 0 ? Infinity : i; };
  const above = (h: string, m: string) => maxLevel >= 0 && levelOf(cfg, h, m) > maxLevel;
  const connected = (h: string) => !env.connected || env.connected.includes(h);

  const lines: string[] = [];
  for (const h of usableCatalog(cfg, catalog, env)) {
    const models = h.models
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => !above(h.id, m.id) && usable(m, maxEffort))
      .sort((a, b) => rankOf(h.id, a.m.id) - rankOf(h.id, b.m.id) || a.i - b.i)
      .map(({ m }) => m);
    if (!models.length) continue;
    lines.push(`- ${label(h.id, h.name)}`, `  models: ${models.map((m) => label(m.id, m.name)).join(", ")}`, ...(h.noModes?.length ? [`  can't run ${h.noModes.join(" or ")} mode: never route such a session to it`] : []));
  }

  // Unavailable, grouped by reason, each group in catalog order.
  const harnessLines: string[] = [], modelGroups: string[][] = [[], [], [], []];
  const connectedLines: string[] = [];
  for (const h of allCatalog) {
    if (deny.includes(h.id)) harnessLines.push(`- ${label(h.id, h.name)}: denied in your config`);
    else if (!connected(h.id)) connectedLines.push(`- ${label(h.id, h.name)}: not connected (\`gluon connect ${h.id}\`)`);
    if (deny.includes(h.id) || !connected(h.id) || !catalog.some((x) => x.id === h.id)) continue;
    for (const m of h.models) {
      if (denyModels.includes(m.id) || denyModels.includes(key(h.id, m.id))) modelGroups[1]!.push(`- ${label(m.id, m.name)}: in never_models in routing.yaml`);
      else if (!optedIn(cfg, m)) modelGroups[2]!.push(`- ${label(m.id, m.name)}: shares data with ${m.sharesDataWith ?? "its maker"}; set \`${m.optIn}: true\` in routing.yaml`);
      else if (above(h.id, m.id)) modelGroups[0]!.push(`- ${label(m.id, m.name)}: above your max_model (${LEVELS[maxLevel]})`);
      else if (!usable(m, maxEffort)) modelGroups[3]!.push(`- ${label(m.id, m.name)}: no effort within your max_effort (${EFFORTS[maxEffort]})`);
    }
  }
  const unavailable = [...harnessLines, ...connectedLines, ...modelGroups.flat()];

  return [
    "<available_agents>",
    "Harness and model ids are what route's `pinned` and `harness` take. Names in parentheses are what the developer may call them.",
    ...lines,
    ...(unavailable.length ? ["Unavailable. If the developer asks for one of these, say why in one sentence and pass nothing:", ...unavailable] : []),
    "</available_agents>",
  ].join("\n");
}
