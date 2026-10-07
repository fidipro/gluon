/**
 * What a price/window table may contain (issue #39): a per-file allowlist of keys and shapes, checked
 * recursively, plus the report of how far a table moved from the previous one. Used by the local
 * store's reader and writer (`tables-store.ts`), by the refresh (`refresh.ts`, `gluon pricing update`) and by
 * `scripts/pricing/validate.ts`, so a table is trusted by the same rules wherever it comes
 * from. Pure and light: no imports, no file access (it is loaded by `tables.ts`, which `gluon hook` never loads).
 *
 * Unknown keys are refused, and so is every string that isn't an id, a digest, a version or a
 * date: a table is data, never text a harness's catalog could use to carry anything else.
 */

export const TABLE_NAMES = ["modelsdev", "claude-catalog", "codex-windows", "grok-models", "grok-observed-windows"] as const;
export type TableName = (typeof TABLE_NAMES)[number];
/** The file of each table, in the local store (`tables-store.ts`) and, for the observed one, in `src/cost/tables/`. */
export const tableFile = (name: TableName): string => `${name}.json`;
/** The table a file name is, or undefined. */
export const tableNameOf = (file: string): TableName | undefined => TABLE_NAMES.find((n) => file === tableFile(n) || file.endsWith(`/${tableFile(n)}`) || file.endsWith(`\\${tableFile(n)}`));

export const MAX_TABLE_BYTES = 2_000_000;

type Rule =
  | { t: "num"; min: number; max: number; int?: boolean }
  | { t: "str"; re: RegExp }
  | { t: "bool" }
  | { t: "null" }
  | { t: "lit"; v: string | number }
  | { t: "or"; of: Rule[] }
  | { t: "arr"; of: Rule; max: number }
  /** Fixed keys; `opt` ones may be absent. */
  | { t: "obj"; keys: Record<string, Rule | { opt: Rule }> }
  /** Keys that match a pattern (ids), each value of one shape. */
  | { t: "map"; key: RegExp; of: Rule; max: number };

const ID = /^[A-Za-z0-9._:/@~[\]-]{1,200}$/;
const WORD = /^[A-Za-z0-9_.-]{1,64}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** A day (a generator's `generatedAt`), or a moment (what Gluon writes locally). */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A short human line (a seed table's `note`): printable ASCII only, bounded. */
const NOTE = /^[\x20-\x7e]{1,400}$/;

const num = (min: number, max: number, int = false): Rule => ({ t: "num", min, max, ...(int ? { int } : {}) });
const str = (re: RegExp): Rule => ({ t: "str", re });
const lit = (v: string | number): Rule => ({ t: "lit", v });
const or = (...of: Rule[]): Rule => ({ t: "or", of });
const nul: Rule = { t: "null" };
const opt = (of: Rule) => ({ opt: of });
// Null-prototype: a key named like an Object.prototype member (`constructor`, `__proto__`) is no key of the rule (BUG-371).
const obj = (keys: Record<string, Rule | { opt: Rule }>): Rule => ({ t: "obj", keys: Object.assign(Object.create(null) as Record<string, Rule | { opt: Rule }>, keys) });
const arr = (of: Rule, max: number): Rule => ({ t: "arr", of, max });
const map = (key: RegExp, of: Rule, max: number): Rule => ({ t: "map", key, of, max });

/** USD per million tokens. */
const PRICE = num(0, 5_000);
const WINDOW = num(1_000, 100_000_000, true);
const SIZES = { input: opt(PRICE), output: opt(PRICE), cache_read: opt(PRICE), cache_write: opt(PRICE) };
const COST = obj({ input: PRICE, output: PRICE, cache_read: opt(PRICE), cache_write: opt(PRICE), reasoning: opt(PRICE), input_audio: opt(PRICE), output_audio: opt(PRICE), tiers: opt(arr(obj({ tier: obj({ type: str(WORD), size: num(1, 100_000_000, true) }), ...SIZES }), 8)), context_over_200k: opt(obj(SIZES)) });
/** The endpoints OpenRouter lists for a model (`scripts/pricing/modelsdev.ts`): how many, and the cheapest and dearest input and output price. */
const RANGE = obj({ min: PRICE, max: PRICE });
const ENDPOINTS = obj({ count: num(1, 500, true), input: RANGE, output: RANGE });
/** One Claude price row (USD per million tokens; web search per request): a catalog tier (`long_prompt`: its row for prompts over a size, 2.1.293 on), or a fast-mode row. */
const LONG_PROMPT = obj({ above_prompt_tokens: num(1, 100_000_000, true), input: PRICE, output: PRICE, cache_write_5m: PRICE, cache_write_1h: opt(PRICE), cache_read: PRICE });
const TIER = obj({ input: PRICE, output: PRICE, cache_write_5m: PRICE, cache_write_1h: PRICE, cache_read: PRICE, web_search: PRICE, long_prompt: opt(LONG_PROMPT) });
const MODE_COST = obj({ input: PRICE, output: PRICE, cache_read: opt(PRICE), cache_write: opt(PRICE), reasoning: opt(PRICE) });

/** When a table was fetched or rebuilt on this machine (`tables-store.ts`): a moment, never a day. */
const FETCHED = { fetchedAt: opt(str(ISO)) };
/** Where a Grok window came from: the binary's own catalog, or the observed table (never models.dev: BUG-396). */
const GROK_WINDOW_ORIGIN = or(lit("binary"), lit("observed"));
/** Where a Grok price came from: the binary's own catalog, or models.dev as a marked seed. */
const GROK_PRICE_ORIGIN = or(lit("binary"), lit("models.dev-seed"));

export const SCHEMAS: Record<TableName, Rule> = {
  modelsdev: obj({
    schema: lit(1),
    source: lit("models.dev"),
    catalogUpdatedAt: or(str(ISO), nul),
    catalogDigest: str(HEX64),
    // Models Gluon offers that the sources had no price for when the table was built (a list, not a failure: they have no figure of ours).
    missing: arr(str(ID), 500),
    ...FETCHED,
    // A day when a generator made it (the public API has no catalog date), a moment when Gluon did.
    generatedAt: opt(or(str(ISO), str(DAY))),
    // `priceSource`: an `openrouter/*` price taken from OpenRouter's own listing (what bills); `modelsdevCost`: models.dev's where it differs.
    entries: map(ID, obj({ cost: COST, context: or(num(0, 100_000_000, true), nul), status: opt(str(WORD)), priceSource: opt(lit("openrouter")), staleSince: opt(str(ISO)), endpoints: opt(ENDPOINTS), modelsdevCost: opt(obj(SIZES)), modes: opt(map(WORD, obj({ cost: MODE_COST, serviceTier: opt(str(WORD)), speed: opt(str(WORD)) }), 16)) }), 2_000),
  }),
  "claude-catalog": obj({
    schema: lit(1),
    source: lit("claude-code binary"),
    claudeCodeVersion: str(VERSION),
    catalogDigest: str(HEX64),
    pricingTiers: map(WORD, TIER, 64),
    models: arr(obj({ id: str(ID), family: str(WORD), providerIds: map(WORD, str(ID), 16), pricing: str(WORD), window: num(100_000, 100_000_000, true), native1m: { t: "bool" }, supports1mSuffix: { t: "bool" }, supports1mBeta: { t: "bool" } }), 500),
    // Claude Code's fast-mode rows by catalog model id (from its price function, not the catalog).
    fastPricing: opt(map(ID, TIER, 100)),
    generatedAt: opt(str(ISO)),
    ...FETCHED,
  }),
  // `scripts/pricing/codex.ts` (`CodexWindowsTable`, `tables.ts`): a header and, per model slug, the window Codex sizes a conversation by,
  // the most it allows and the share of it a conversation may fill. The digest is the catalog text's (`digest`, not `catalogDigest`).
  "codex-windows": obj({
    schema: lit(1),
    source: lit("codex debug models"),
    codexVersion: str(VERSION),
    generatedAt: or(str(ISO), str(DAY)),
    digest: str(HEX64),
    note: opt(str(NOTE)),
    ...FETCHED,
    models: map(ID, obj({ context: WINDOW, max: WINDOW, percent: num(1, 100) }), 1_000),
  }),
  // `scripts/pricing/grok.ts` (`GrokModelsTable`, `tables.ts`): the windows Grok sizes models by (the binary's, else the observed table's)
  // and, where the binary has no price, models.dev's as a marked seed (`costSource`). The digest is the embedded catalog text's.
  "grok-models": obj({
    schema: lit(1),
    source: lit("grok binary default_models.json"),
    grokVersion: str(VERSION),
    generatedAt: or(str(ISO), str(DAY)),
    digest: str(HEX64),
    ...FETCHED,
    models: map(ID, obj({ context: opt(WINDOW), source: opt(GROK_WINDOW_ORIGIN), autoCompactPercent: opt(num(1, 100)), cost: opt(COST), costSource: opt(GROK_PRICE_ORIGIN) }), 500),
  }),
  // `GrokObservedWindowsTable` (`tables.ts`): the one table written by hand, not by a generator; it may be empty (every model it held is in the binary now).
  "grok-observed-windows": obj({
    schema: lit(1),
    source: lit("observed"),
    note: str(NOTE),
    models: map(ID, obj({ context: WINDOW, observedAt: str(DAY), grokVersion: str(VERSION), evidence: str(NOTE) }), 100),
  }),
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Why `value` doesn't fit `rule` (at `path`), or null. */
function check(rule: Rule, value: unknown, path: string): string | null {
  switch (rule.t) {
    case "num":
      return typeof value === "number" && Number.isFinite(value) && value >= rule.min && value <= rule.max && (!rule.int || Number.isInteger(value)) ? null : `${path} is not ${rule.int ? "an integer" : "a number"} from ${rule.min} to ${rule.max}`;
    case "str":
      return typeof value === "string" && rule.re.test(value) ? null : `${path} is a string that is not an id (${JSON.stringify(typeof value === "string" ? value.slice(0, 40) : value)})`;
    case "bool":
      return typeof value === "boolean" ? null : `${path} is not true or false`;
    case "null":
      return value === null ? null : `${path} is not null`;
    case "lit":
      return value === rule.v ? null : `${path} is not ${JSON.stringify(rule.v)}`;
    case "or": {
      const why = rule.of.map((r) => check(r, value, path));
      if (why.some((w) => w === null)) return null;
      // The alternative of the value's own kind says what is wrong with it.
      const kind = value === null ? "null" : typeof value === "number" ? "num" : typeof value === "string" ? "str" : typeof value === "boolean" ? "bool" : "";
      return why[rule.of.findIndex((r) => r.t === kind)] ?? why[0]!;
    }
    case "arr": {
      if (!Array.isArray(value) || value.length > rule.max) return `${path} is not a list of at most ${rule.max}`;
      for (const [i, v] of value.entries()) {
        const why = check(rule.of, v, `${path}[${i}]`);
        if (why) return why;
      }
      return null;
    }
    case "obj": {
      if (!isObj(value)) return `${path} is not an object`;
      for (const k of Object.keys(value)) if (!Object.hasOwn(rule.keys, k)) return `${path} has an unknown key ${JSON.stringify(k.slice(0, 40))}`;
      for (const [k, r] of Object.entries(rule.keys)) {
        const optional = "opt" in r && !("t" in r);
        const sub = optional ? (r as { opt: Rule }).opt : (r as Rule);
        if (!Object.hasOwn(value, k) || value[k] === undefined) {
          if (!optional) return `${path}.${k} is missing`;
          continue;
        }
        const why = check(sub, value[k], `${path}.${k}`);
        if (why) return why;
      }
      return null;
    }
    case "map": {
      if (!isObj(value)) return `${path} is not an object`;
      const keys = Object.keys(value);
      if (keys.length > rule.max) return `${path} has more than ${rule.max} keys`;
      for (const k of keys) {
        if (!rule.key.test(k) || k in Object.prototype) return `${path} has a key that is not an id (${JSON.stringify(k.slice(0, 40))})`;
        const why = check(rule.of, value[k], `${path}.${k}`);
        if (why) return why;
      }
      return null;
    }
  }
}

/**
 * Why one row of a table's map (a `modelsdev` entry, a `grok-models` model) isn't one `tableProblem` would accept, or null. The builders skip such a row
 * (and say so) instead of building a table that is refused whole: one odd model on models.dev must not stop every price (BUG-604).
 */
export function rowProblem(name: "modelsdev" | "grok-models", key: string, row: unknown): string | null {
  const root = SCHEMAS[name];
  const rule = root.t === "obj" ? root.keys[name === "modelsdev" ? "entries" : "models"] : undefined;
  if (!rule || !("t" in rule) || rule.t !== "map") return `${name}: no row rule`;
  if (!rule.key.test(key) || key in Object.prototype) return `${key} is not an id`;
  return check(rule.of, row, key);
}

/** Why a parsed table isn't one Gluon accepts (shape, allowlist, then the checks of its source), or null. */
export function tableProblem(name: TableName, table: unknown): string | null {
  const why = check(SCHEMAS[name], table, name);
  if (why) return why;
  const t = table as Record<string, unknown>;
  if (name === "modelsdev") {
    if (Object.keys(t.entries as object).length < 1) return "modelsdev: no entries";
  } else if (name === "claude-catalog") {
    const tiers = t.pricingTiers as Record<string, unknown>;
    const models = t.models as { id: string; pricing: string }[];
    if (models.length < 10) return "claude-catalog: too few models";
    for (const m of models) if (!(m.pricing in tiers)) return `claude-catalog: ${m.id} has no known price tier`;
  } else if (name !== "grok-observed-windows" && Object.keys(t.models as object).length < 1) return `${name}: no models`;
  return null;
}

/** Parses a table's text (at most `MAX_TABLE_BYTES`) and checks it: the table, or why not. */
export function parseTable(name: TableName, text: string): { table: Record<string, unknown> } | { problem: string } {
  if (text.length > MAX_TABLE_BYTES) return { problem: `${name} is larger than 2 MB` };
  let table: unknown;
  try {
    table = JSON.parse(text);
  } catch {
    return { problem: `${name} is not JSON` };
  }
  const problem = tableProblem(name, table);
  return problem ? { problem } : { table: table as Record<string, unknown> };
}

// ---- the change guard ----

const flatten = (v: unknown, path: string, out: Map<string, number>): void => {
  if (typeof v === "number") out.set(path, v);
  else if (Array.isArray(v)) v.forEach((x, i) => flatten(x, `${path}[${i}]`, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) flatten(x, `${path}.${k}`, out);
};

/** The models of a (valid) table and the prices that apply to each, as `model.field` → USD per million. */
export function priceView(name: TableName, table: Record<string, unknown>): { models: Set<string>; prices: Map<string, number> } {
  const prices = new Map<string, number>();
  const models = new Set<string>();
  if (name === "modelsdev") {
    for (const [key, e] of Object.entries((table.entries ?? {}) as Record<string, { cost: unknown; modes?: Record<string, { cost: unknown }> }>)) {
      models.add(key);
      flatten(e.cost, `${key}.cost`, prices);
      for (const [mode, m] of Object.entries(e.modes ?? {})) flatten(m.cost, `${key}.modes.${mode}`, prices);
    }
  } else if (name === "claude-catalog") {
    const tiers = (table.pricingTiers ?? {}) as Record<string, Record<string, unknown>>;
    for (const m of (table.models ?? []) as { id: string; pricing: string }[]) {
      models.add(m.id);
      flatten(tiers[m.pricing] ?? {}, m.id, prices);
    }
    for (const [id, row] of Object.entries((table.fastPricing ?? {}) as Record<string, unknown>)) flatten(row, `${id}.fast`, prices);
  } else if (name === "grok-models") {
    for (const [id, row] of Object.entries((table.models ?? {}) as Record<string, { cost?: unknown }>)) {
      models.add(id);
      flatten(row.cost, `${id}.cost`, prices);
    }
  } else {
    const all = new Map<string, number>();
    for (const [id, row] of Object.entries((table.models ?? {}) as Record<string, unknown>)) {
      models.add(id);
      flatten(row, id, all);
    }
    for (const [k, v] of all) if (/(price|cost|usd|rate)[^.]*$/i.test(k)) prices.set(k, v);
  }
  return { models, prices };
}

/** Whether the model a price key belongs to is in `models` (ids may hold dots: the longest prefix at a `.` or `[` that is one). */
const hasOwner = (key: string, models: Set<string>): boolean => {
  for (let i = key.length - 1; i > 0; i--) if ((key[i] === "." || key[i] === "[") && models.has(key.slice(0, i))) return true;
  return false;
};

export const MAX_CHANGED_FRACTION = 0.15;
export const MAX_PRICE_RATIO = 3;

export interface Change {
  /** A big move: `refresh.ts` accepts it and logs it in the ledger (a manual refresh checks the shape only, `validate.ts --shape-only`); every price that moved is in `moved`. */
  problems: string[];
  moved: string[];
  /** The same moves as data: the price (`model.field`) and its value before and after. */
  changes: { key: string; from: number; to: number }[];
  /** The models of the previous table that the next one lacks. */
  gone: string[];
}

/**
 * How far `next` moved from the `previous` table (none: a first table). Refused: more than 15% of
 * the prices changed, one price moved more than 3x (from or to zero included), a model disappeared, a
 * zero price on a model the previous table already had (a model new to the table may be free).
 */
export function changeProblems(name: TableName, previous: Record<string, unknown> | undefined, next: Record<string, unknown>): Change {
  // Written by hand and reviewed as a diff: it has no price, and a model leaves it when the binary lists it.
  if (name === "grok-observed-windows") return { problems: [], moved: [], changes: [], gone: [] };
  const a = previous ? priceView(name, previous) : { models: new Set<string>(), prices: new Map<string, number>() };
  const b = priceView(name, next);
  const problems: string[] = [];
  const moved: string[] = [];
  const changes: Change["changes"] = [];
  const gone: string[] = [];
  for (const m of a.models) if (!b.models.has(m)) (problems.push(`model ${m} disappeared`), gone.push(m));
  let changed = 0;
  for (const [k, was] of a.prices) {
    const now = b.prices.get(k);
    if (now === undefined) {
      if (hasOwner(k, b.models)) changed++;
      continue;
    }
    if (now === was) continue;
    changed++;
    moved.push(`${k}: ${was} -> ${now}`);
    changes.push({ key: k, from: was, to: now });
    if (now === 0) problems.push(`${k} became zero (was ${was})`);
    else if (was === 0 || now / was > MAX_PRICE_RATIO || was / now > MAX_PRICE_RATIO) problems.push(`${k} moved more than ${MAX_PRICE_RATIO}x (${was} -> ${now})`);
  }
  // A model new to a table that has others may well be free (models.dev lists free models); a zero price on a model the previous table already had, or in a first table, is what is refused.
  for (const [k, now] of b.prices) if (!a.prices.has(k) && now === 0 && (!previous || hasOwner(k, a.models))) problems.push(`${k} is a zero price the committed table does not have`);
  if (a.prices.size && changed / a.prices.size > MAX_CHANGED_FRACTION) problems.push(`${changed} of ${a.prices.size} prices changed (more than ${MAX_CHANGED_FRACTION * 100}%)`);
  return { problems, moved, changes, gone };
}

/**
 * Where models.dev and OpenRouter's own listing disagree by more than `MAX_PRICE_RATIO` on an `openrouter/*` entry's input, output
 * or cache price (`priceSource`, `modelsdevCost`: the generator keeps models.dev's row where they differ; OpenRouter's is the one
 * priced from). Only a disagreement the previous table did not already carry (same models.dev row), so each is reported once: a
 * report for a human (`validate.ts --report-large`), never a failure.
 */
export function openRouterDisagreements(previous: Record<string, unknown> | undefined, next: Record<string, unknown>): string[] {
  type Row = { cost?: Record<string, number>; modelsdevCost?: Record<string, number>; priceSource?: string };
  const was = (previous?.entries ?? {}) as Record<string, Row>;
  const out: string[] = [];
  for (const [key, e] of Object.entries((next.entries ?? {}) as Record<string, Row>)) {
    if (e.priceSource !== "openrouter" || !e.modelsdevCost || !e.cost) continue;
    if (JSON.stringify(was[key]?.modelsdevCost) === JSON.stringify(e.modelsdevCost)) continue;
    const far: string[] = [];
    for (const [f, md] of Object.entries(e.modelsdevCost)) {
      const or = e.cost[f];
      if (or === undefined || md === or) continue;
      if (or === 0 || md === 0 || or / md > MAX_PRICE_RATIO || md / or > MAX_PRICE_RATIO) far.push(`${f} ${md} (models.dev) vs ${or} (OpenRouter)`);
    }
    if (far.length) out.push(`${key}: models.dev and OpenRouter disagree by more than ${MAX_PRICE_RATIO}x, OpenRouter's (what bills) is used: ${far.join(", ")}`);
  }
  return out;
}
