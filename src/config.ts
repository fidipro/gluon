import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { isMap, isScalar, parse, parseDocument, type Pair, type Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import { catalog, HARNESS_INFO, HARNESSES, type Conn, type Effort, type Harness, type ModelEntry, type ProviderId } from "./harnesses.ts";
import { EFFORTS, stepEfforts } from "./agent/effort.ts";
import { pathFor, xdgBase } from "./xdg.ts";
import { HANDOFF_GLOBAL_KEYS, HANDOFF_KEYS, HANDOFF_YAML, LEGACY_HANDOFF_KEYS, handoffDefaults, ON_CLEAR, ON_COMPACT, ON_EXIT, type HandoffConfig, type HandoffSettings } from "./handoff.ts";

export type { Conn, Effort, Harness, ModelEntry, ProviderId, Vendor } from "./harnesses.ts";
export { HARNESSES } from "./harnesses.ts";

/** How a harness signs in: "api" gets a provider's key from Gluon; "subscription" uses the harness's own login. */
export type Auth = "api" | "subscription";

/**
 * One harness's connection. A single-provider harness has `auth` (and `provider` for "api");
 * OpenCode has `providers` (keys only).
 */
export interface Connection {
  auth: Auth;
  provider?: ProviderId;
  providers?: ProviderId[];
}

/** Where the brain can run. */
export type Route = "claude-plan" | "chatgpt-plan" | "anthropic-api" | "openai-api" | "bedrock" | "openrouter";
export const ROUTES: Route[] = ["claude-plan", "chatgpt-plan", "anthropic-api", "openai-api", "bedrock", "openrouter"];

export interface BrainStep {
  route: Route;
  model: string;
  /** The intake agent's effort on this step; unset: `BRAIN_EFFORT_DEFAULT` (`agent/effort.ts`). */
  effort?: Effort;
}

/** One model an agent can be launched with, as described to the brain. */
export interface ModelOption {
  id: string; // what the brain proposes
  label: string; // what the developer reads
  note: string; // what the brain reads when choosing
  efforts: Effort[]; // this model's efforts; empty: it takes no effort (omit it)
  defaultEffort?: Effort; // its sweet spot
}

export interface AgentOption {
  harness: Harness;
  label: string;
  note: string;
  models: ModelOption[];
}

export interface Config {
  connections: Partial<Record<Harness, Connection>>;
  /** The AWS setup Bedrock connections (and a Bedrock brain) use; unset fields fall back to the AWS SDK's own defaults. */
  bedrock: { profile?: string; region?: string };
  /** Each harness's model catalog (`catalog()`: facts, not configuration). */
  models: Record<Harness, ModelEntry[]>;
  /** "harness/conn/model-id" → the date a probe reached it. */
  verified: Record<string, string>;
  /** "harness/conn" → the date its models were last probed. */
  checked: Record<string, string>;
  /** "harness/conn/model-id" → the date a probe definitively failed to reach it (hidden from the offer). An id in neither this nor `verified` was never probed there: offered like an unchecked connection. */
  unreached: Record<string, string>;
  brain: { order: BrainStep[]; active: number | null };
  /** Every harness with its whole catalog, derived from `models` (the brain gets the offered subset). */
  agents: AgentOption[];
  /** What happens around an agent's session: returning to Gluon on exit, /clear, /compact (`handoff.ts`). */
  handoff: HandoffConfig;
  /** Gluon's own cost figures (`src/cost/`): `audit: false` keeps no audit ledger on disk (the figures are unaffected); `antigravity_statusline: true` lets Gluon set Antigravity's status line (its context: it has no cost). */
  cost: { audit: boolean; antigravityStatusline: boolean };
  /** One row per launched session in a local SQLite file (`src/analytics.ts`, `gluon stats`); `false` records nothing. On by default. */
  analytics: boolean;
  /** Gluon's own updates (`src/update/update.ts`): `auto` installs a new release by itself, `notify` only says it exists, `off` checks nothing. */
  updates: UpdateMode;
}

export const UPDATE_MODES = ["auto", "notify", "off"] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

export const DEFAULT_ORDER: BrainStep[] = [
  { route: "claude-plan", model: "claude-sonnet-5-5" },
  { route: "chatgpt-plan", model: "gpt-6.1-sol" },
  { route: "anthropic-api", model: "claude-sonnet-5-5" },
  { route: "openai-api", model: "gpt-6-sol" },
  { route: "bedrock", model: "global.anthropic.claude-sonnet-5-5" },
  { route: "bedrock", model: "us.openai.gpt-6-sol" },
  { route: "openrouter", model: "anthropic/claude-sonnet-5.5" },
  { route: "openrouter", model: "openai/gpt-6-sol" },
  { route: "bedrock", model: "us.anthropic.claude-sonnet-4-6" },
  { route: "openrouter", model: "anthropic/claude-sonnet-4.6" },
];

export function agentsFrom(models: Record<Harness, ModelEntry[]>): AgentOption[] {
  return HARNESSES.map((h) => ({
    harness: h,
    label: HARNESS_INFO[h].label,
    note: HARNESS_INFO[h].note,
    models: models[h].map((m) => ({ id: m.id, label: m.label, note: m.note, efforts: m.efforts, ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}) })),
  }));
}

export function defaults(): Config {
  const models = catalog();
  return { connections: {}, bedrock: {}, models, verified: {}, checked: {}, unreached: {}, brain: { order: structuredClone(DEFAULT_ORDER), active: null }, agents: agentsFrom(models), handoff: handoffDefaults(), cost: { audit: true, antigravityStatusline: false }, analytics: true, updates: "auto" };
}

/** GLUON_CONFIG (main.tsx makes it absolute at startup), else `gluon/config.yaml` under XDG_CONFIG_HOME (an absolute one only), else %APPDATA% on Windows, else ~/.config. */
export function configPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env.GLUON_CONFIG) return env.GLUON_CONFIG;
  const p = pathFor(platform);
  const base = xdgBase(env.XDG_CONFIG_HOME, platform) || (platform === "win32" ? env.APPDATA || p.join(home, "AppData", "Roaming") : p.join(home, ".config"));
  return p.join(base, "gluon", "config.yaml");
}

export class ConfigError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : v instanceof Date ? v.toISOString().slice(0, 10) : undefined);

function connectionFrom(harness: Harness, raw: unknown): Connection {
  const where = `connections.${harness}`;
  const info = HARNESS_INFO[harness];
  if (!isObject(raw)) throw new ConfigError(`${where} must be a mapping`);
  if (info.multiProvider) {
    const providers = raw.providers ?? [];
    if (!Array.isArray(providers)) throw new ConfigError(`${where}.providers must be a list`);
    // A provider an earlier version offered (Zen, Moonshot, …) is dropped with a notice, not an error: the rest still works.
    const kept = providers.filter((p) => info.providers.includes(p));
    const gone = providers.filter((p) => !info.providers.includes(p));
    if (gone.length) warnOnce(`${where}.providers: ${gone.map((p) => JSON.stringify(p)).join(", ")} ${gone.length === 1 ? "is" : "are"} no longer offered (${info.label} uses ${info.providers.join(", ")}); ignored. Run \`gluon connect ${harness}\` to set it up again.`);
    return { auth: "api", providers: kept as ProviderId[] };
  }
  if (raw.auth === "subscription") {
    if (!info.subscription) throw new ConfigError(`${where}: ${info.label} has no subscription sign-in`);
    return { auth: "subscription" };
  }
  if (raw.auth !== "api") throw new ConfigError(`${where}.auth must be api or subscription (got ${JSON.stringify(raw.auth)})`);
  if (!info.providers.includes(raw.provider as ProviderId)) throw new ConfigError(`${where}.provider must be one of ${info.providers.join(", ")} (got ${JSON.stringify(raw.provider)})`);
  return { auth: "api", provider: raw.provider as ProviderId };
}

function stepFrom(raw: unknown, i: number): BrainStep {
  const where = `brain.order[${i}]`;
  if (!isObject(raw)) throw new ConfigError(`${where} must be a mapping like { route: claude-plan, model: claude-sonnet-5-5 }`);
  if (!ROUTES.includes(raw.route as Route)) throw new ConfigError(`${where}.route must be one of ${ROUTES.join(", ")} (got ${JSON.stringify(raw.route)})`);
  if (typeof raw.model !== "string" || !raw.model) throw new ConfigError(`${where}.model must be a model id`);
  const step: BrainStep = { route: raw.route as Route, model: raw.model };
  if (raw.effort === undefined || raw.effort === null) return step;
  if (!EFFORTS.includes(raw.effort as Effort)) throw new ConfigError(`${where}.effort must be one of ${EFFORTS.join(", ")} (got ${JSON.stringify(raw.effort)})`);
  const takes = stepEfforts(step);
  if (takes && !takes.includes(raw.effort as Effort)) {
    throw new ConfigError(
      takes.length
        ? `${where}.effort: ${raw.model} on ${raw.route} takes ${takes.join(", ")} (got ${raw.effort})`
        : `${where}.effort: ${raw.model} on ${raw.route} takes no effort setting; remove effort (got ${raw.effort})`,
    );
  }
  return { ...step, effort: raw.effort as Effort };
}

function dates(key: string, raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new ConfigError(`${key} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const s = str(v);
    if (s) out[k] = s;
  }
  return out;
}

const pairIn = (map: unknown, key: string): Pair<Scalar, any> | undefined =>
  isMap(map) ? (map.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair<Scalar, any> | undefined) : undefined;
/** The comment on a pair (after its value, or on its key's line). */
const commentOn = (p?: Pair<Scalar, any>) => (p ? (isScalar(p.value) ? p.value.comment : undefined) ?? p.key.comment ?? undefined : undefined);

/** The first pass's brain.provider, as a route of the brain order. */
const OLD_ROUTES: Record<string, Route> = { bedrock: "bedrock", anthropic: "anthropic-api", api: "anthropic-api", subscription: "claude-plan" };

/**
 * The first pass's keys (`brain.provider` / `brain.model`, `auth`, `aws`, `agents`) mapped to the
 * new shape, keeping the comments on them. Returns the migrated file, or null when there is
 * nothing to migrate.
 *
 * - `brain.provider` + `brain.model` become the first step of `brain.order` (the default order
 *   follows it when the file had none);
 * - `auth.<harness>` becomes `connections.<harness>` (OpenCode's had no providers: left for setup);
 * - `aws` becomes `bedrock` (merged into one that exists);
 * - `brain.subscriptionNotice` goes (there is no personal-use notice any more; `notices` is ignored);
 * - `agents` goes: its models were ids for two harnesses on one connection each, which don't map
 *   onto the per-connection catalog. What it listed is said in `warnings`, to be told
 *   to the user once.
 */
export function migrate(text: string, warnings: string[] = []): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  const file = doc.toJS();
  if (!isObject(file)) return null;
  const brain = isObject(file.brain) ? file.brain : {};
  // A `connections` that isn't a mapping is loadConfig's to name ("connections must be a mapping"), not a crash while moving `auth` into it.
  if (file.connections !== undefined && file.connections !== null && !isObject(file.connections)) return null;
  const old = "auth" in file || "aws" in file || "agents" in file || "provider" in brain || "subscriptionNotice" in brain || "model" in brain;
  if (!old) return null;
  if (file.connections === null) doc.delete("connections"); // an empty `connections:` is a mapping not yet written
  const root = doc.contents as YAMLMap;
  // A comment at the top of the file hangs on the first key: kept if that key goes.
  const firstPair = root.items[0];
  const top = firstPair && isScalar(firstPair.key) ? firstPair.key.commentBefore : undefined;
  const brainNode = pairIn(root, "brain")?.value;
  const connections = isObject(file.connections) ? file.connections : {};
  const auth = isObject(file.auth) ? file.auth : {};
  const authNode = pairIn(root, "auth")?.value;
  const connect = (h: Harness, c: Connection, comment?: string) => {
    if (h in connections) return;
    const node = doc.createNode(c) as YAMLMap;
    doc.setIn(["connections", h], node);
    node.flow = true;
    if (comment) node.comment = comment;
  };
  if (auth["claude-code"] === "api") connect("claude-code", { auth: "api", provider: "anthropic" }, commentOn(pairIn(authNode, "claude-code")));
  else if (auth["claude-code"] === "subscription" || brain.provider === "subscription") connect("claude-code", { auth: "subscription" }, commentOn(pairIn(authNode, "claude-code")));

  // aws → bedrock, moving the pairs themselves so their comments come along.
  const aws = pairIn(root, "aws");
  if (aws) {
    const keep = (map: YAMLMap) => (map.items = map.items.filter((p) => isScalar(p.key) && (p.key.value === "profile" || p.key.value === "region") && !(isScalar(p.value) && (p.value.value === null || p.value.value === ""))));
    const bedrock = pairIn(root, "bedrock");
    if (!bedrock && isMap(aws.value)) {
      aws.key.value = "bedrock";
      keep(aws.value);
    } else {
      if (bedrock && isMap(bedrock.value) && isMap(aws.value)) {
        keep(aws.value);
        for (const p of aws.value.items) if (!pairIn(bedrock.value, String((p.key as Scalar).value))) bedrock.value.items.push(p);
      }
      doc.delete("aws");
    }
  }

  // brain.provider + brain.model → the first step of the order.
  const route = typeof brain.provider === "string" ? OLD_ROUTES[brain.provider] : undefined;
  if (route && typeof brain.model === "string" && brain.model) {
    const step = { route, model: brain.model };
    const order = Array.isArray(brain.order) ? (brain.order as BrainStep[]) : null;
    const comment = commentOn(pairIn(brainNode, "provider")) ?? commentOn(pairIn(brainNode, "model"));
    if (!order) doc.setIn(["brain", "order"], doc.createNode([step, ...DEFAULT_ORDER.filter((s) => s.route !== route || s.model !== brain.model)]));
    else if (!order.some((s) => isObject(s) && s.route === route && s.model === brain.model)) (doc.getIn(["brain", "order"], true) as YAMLSeq).items.unshift(doc.createNode(step));
    const seq = doc.getIn(["brain", "order"], true) as YAMLSeq;
    for (const item of seq.items) if (isMap(item)) item.flow = true;
    const first = seq.items[0] as YAMLMap;
    first.commentBefore = ` the brain you chose (first pass: brain.provider ${brain.provider}, brain.model)`;
    if (comment) first.comment = comment;
  }
  if (Array.isArray(file.agents) && file.agents.length) {
    const listed = file.agents
      .filter(isObject)
      .map((a) => `${String(a.harness ?? "?")}: ${Array.isArray(a.models) ? a.models.map((m) => (isObject(m) ? String(m.id) : String(m))).join(", ") : "no models"}`);
    warnings.push(`the first version's \`agents:\` list was dropped from the config (${listed.join("; ")}). Gluon's model catalog is built in now.`);
  }
  for (const k of ["auth", "agents"]) doc.delete(k);
  if (isMap(doc.get("brain", true))) for (const k of ["provider", "model", "subscriptionNotice"]) doc.deleteIn(["brain", k]);
  if (isMap(doc.get("brain", true)) && (doc.get("brain", true) as YAMLMap).items.length === 0) doc.delete("brain");
  if (top && firstPair && !root.items.includes(firstPair)) doc.commentBefore = doc.commentBefore ? `${doc.commentBefore}\n${top}` : top;
  return doc.toString();
}

/**
 * `brain.active` as an index of the order. It is saved as the step itself ({ route, model, effort? }), so
 * editing the order never points it at another step; a step no longer in the order, or an old
 * index out of range, is dropped (the order is tried again). Gluon writes it, not the user.
 */
export function activeIndex(order: BrainStep[], raw: unknown): number | null {
  if (isObject(raw)) {
    const i = order.findIndex((s) => s.route === raw.route && s.model === raw.model && (s.effort ?? null) === (raw.effort ?? null));
    return i === -1 ? null : i;
  }
  return Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) < order.length ? (raw as number) : null;
}

/** How `brain.active` is saved: the step itself. */
export const activeValue = (config: Config, index: number | null) => {
  const step = index === null ? undefined : config.brain.order[index];
  return step ? { route: step.route, model: step.model, ...(step.effort ? { effort: step.effort } : {}) } : undefined;
};

const warned = new Set<string>();
/** Tells the user something about their config, once per run. */
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  say(message);
}

/** Where config messages go while Gluon runs (its chat), instead of the console Ink would drop (BUG-174). */
let sink: ((message: string) => void) | null = null;
export function setConfigNotices(fn: ((message: string) => void) | null): void {
  sink = fn;
}
const say = (message: string) => (sink ? sink(message) : console.error(`gluon: ${message}`));

/** Warned once per path: a config Gluon can't write (read-only, e.g. managed by a dotfile manager). */
const unwritable = new Set<string>();

/** Writes the config file; a failure is a warning (the change stays in memory for this run). */
function writeConfig(path: string, text: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 }); // a new file is the user's alone, whatever the umask (BUG-586)
    if (process.platform !== "win32") {
      // `mode` applies only to a new file: an existing one that others can write (0666, made under umask 000) loses that; its read bits stay as the user set them.
      try {
        const mode = statSync(path).mode;
        if (mode & 0o022) chmodSync(path, mode & 0o755);
      } catch {}
    }
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (!unwritable.has(path)) {
      unwritable.add(path);
      const why = err.code === "EACCES" || err.code === "EPERM" ? "permission denied" : err.code === "EROFS" ? "read-only file system" : err.message;
      say(`couldn't save to ${path}: ${why}. Carrying on without saving (checks and choices are kept for this run only).`);
    }
    return false;
  }
}

/** The config file's text; a path that exists but can't be read (a directory, no permission) is a ConfigError saying so, not "invalid YAML". */
function readConfigText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`${path} can't be read: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Defaults, with each section replaced by the config file's when present. Migrates first-pass keys once. Throws ConfigError. */
export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return defaults();
  const text = readConfigText(path);
  let file: unknown;
  try {
    file = parse(text) ?? {};
  } catch (e) {
    throw new ConfigError(`${path} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    if (!isObject(file)) throw new ConfigError("expected a mapping (connections, bedrock, verified, brain)");
    const warnings: string[] = [];
    let migrated: string | null;
    try {
      migrated = migrate(text, warnings);
    } catch (e) {
      throw new ConfigError(`first-version keys can't be updated: ${(e as Error).message.split("\n")[0]}`);
    }
    for (const w of warnings) warnOnce(`${path}: ${w}`);
    if (migrated !== null) {
      writeConfig(path, migrated);
      file = parse(migrated) ?? {};
      if (!isObject(file)) throw new ConfigError("expected a mapping");
    }
    const handoff = migrateHandoff(readFileSync(path, "utf8"));
    if (handoff !== null) {
      warnOnce(`${path}: the handoff section now asks before returning (on_clear/on_compact: ask | stay); updated`);
      writeConfig(path, handoff);
      file = parse(handoff) ?? {};
      if (!isObject(file)) throw new ConfigError("expected a mapping");
    }
    for (const key of ["connections", "bedrock", "brain", "handoff", "cost"] as const) {
      if (file[key] !== undefined && file[key] !== null && !isObject(file[key])) throw new ConfigError(`${key} must be a mapping`);
    }
    const config = defaults();
    for (const [h, raw] of Object.entries((file.connections ?? {}) as object)) {
      if (!HARNESSES.includes(h as Harness)) throw new ConfigError(`connections.${h}: unknown harness (one of ${HARNESSES.join(", ")})`);
      config.connections[h as Harness] = connectionFrom(h as Harness, raw);
    }
    const bedrock = (file.bedrock ?? {}) as Record<string, unknown>;
    for (const k of ["profile", "region"] as const) {
      if (bedrock[k] !== undefined && bedrock[k] !== null) {
        if (typeof bedrock[k] !== "string") throw new ConfigError(`bedrock.${k} must be a string`);
        if (bedrock[k]) config.bedrock[k] = bedrock[k] as string;
      }
    }
    // `notices` (the personal-use notices of earlier versions) is ignored, whatever it holds.
    // `models:` (the catalog was configurable in earlier versions) is ignored: the catalog is Gluon's, with each model's ids and efforts.
    if (file.models !== undefined) warnOnce(`${path}: \`models:\` is no longer read; Gluon's model catalog is built in. Remove it from the file.`);
    config.verified = dates("verified", file.verified);
    config.checked = dates("checked", file.checked);
    config.unreached = dates("unreached", file.unreached);
    const brain = (file.brain ?? {}) as Record<string, unknown>;
    if (brain.order !== undefined) {
      if (!Array.isArray(brain.order) || brain.order.length === 0) throw new ConfigError("brain.order must be a non-empty list");
      config.brain.order = brain.order.map(stepFrom);
    }
    config.brain.active = activeIndex(config.brain.order, brain.active);
    config.handoff = handoffFrom(file.handoff);
    const cost = (file.cost ?? {}) as Record<string, unknown>;
    if (cost.audit !== undefined && cost.audit !== null) {
      if (cost.audit !== true && cost.audit !== false && cost.audit !== "on" && cost.audit !== "off") throw new ConfigError("cost.audit must be on or off");
      config.cost.audit = cost.audit === true || cost.audit === "on";
    }
    if (file.analytics !== undefined && file.analytics !== null) {
      if (file.analytics !== true && file.analytics !== false && file.analytics !== "on" && file.analytics !== "off") throw new ConfigError("analytics must be on or off");
      config.analytics = file.analytics === true || file.analytics === "on";
    }
    if (file.updates !== undefined && file.updates !== null) {
      // YAML 1.1 readers turn a bare `off` into false: taken as `off` (and true as `auto`).
      const u = file.updates === false ? "off" : file.updates === true ? "auto" : file.updates;
      if (!(UPDATE_MODES as readonly unknown[]).includes(u)) throw new ConfigError(`updates must be one of ${UPDATE_MODES.join(", ")}`);
      config.updates = u as UpdateMode;
    }
    // Antigravity's cost and context need one key in its own settings (the owner's exception, `agy-settings.ts`): off until you turn it on.
    if (cost.antigravity_statusline !== undefined && cost.antigravity_statusline !== null) {
      if (cost.antigravity_statusline !== true && cost.antigravity_statusline !== false && cost.antigravity_statusline !== "on" && cost.antigravity_statusline !== "off") throw new ConfigError("cost.antigravity_statusline must be on or off");
      config.cost.antigravityStatusline = cost.antigravity_statusline === true || cost.antigravity_statusline === "on";
    }
    return config;
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(`${path}: ${e.message}`);
    throw e;
  }
}

/** The keys `handoff.key` may name: ctrl+ a key that sends a control code of its own. */
const KEY_NAMES = /^ctrl\+[\]\\^_]$/;

/** One `handoff` setting (or an agent's override); `where` names it in errors. */
function handoffSettings(raw: Record<string, unknown>, where: string, allowed: readonly string[]): Partial<HandoffSettings> {
  const out: Partial<HandoffSettings> = {};
  for (const [k, v] of Object.entries(raw)) {
    if ((LEGACY_HANDOFF_KEYS as readonly string[]).includes(k)) continue;
    if (!allowed.includes(k)) throw new ConfigError(`${where}.${k}: unknown setting (one of ${allowed.join(", ")})`);
    if (v === null || v === undefined) continue;
    const one = (name: string, values: readonly string[]) => {
      if (typeof v !== "string" || !values.includes(v)) throw new ConfigError(`${where}.${name} must be one of ${values.join(", ")}`);
      return v;
    };
    if (k === "on_exit") out.on_exit = one(k, ON_EXIT) as HandoffSettings["on_exit"];
    else if (k === "on_clear") out.on_clear = one(k, ON_CLEAR) as HandoffSettings["on_clear"];
    else if (k === "on_compact") out.on_compact = one(k, ON_COMPACT) as HandoffSettings["on_compact"];
    else if (k === "key") {
      if (typeof v !== "string" || !KEY_NAMES.test(v)) throw new ConfigError(`${where}.key must be a key like ctrl+\\ or ctrl+]`);
      out.key = v;
    }
  }
  return out;
}

/** The `handoff` section: defaults, overridden by the file's values; per-agent overrides under `agents`. */
function handoffFrom(raw: unknown): HandoffConfig {
  const h = handoffDefaults();
  if (raw === undefined || raw === null) return h;
  if (!isObject(raw)) throw new ConfigError("handoff must be a mapping");
  const { agents, mouse_capture, ...rest } = raw;
  Object.assign(h, handoffSettings(rest, "handoff", [...HANDOFF_KEYS, ...HANDOFF_GLOBAL_KEYS, "agents"]));
  if (mouse_capture !== undefined && mouse_capture !== null) {
    if (typeof mouse_capture !== "boolean") throw new ConfigError("handoff.mouse_capture must be true or false");
    h.mouse_capture = mouse_capture;
  }
  if (agents !== undefined && agents !== null) {
    if (!isObject(agents)) throw new ConfigError("handoff.agents must be a mapping of agents (one of " + HARNESSES.join(", ") + ")");
    for (const [a, v] of Object.entries(agents)) {
      if (!HARNESSES.includes(a as Harness)) throw new ConfigError(`handoff.agents.${a}: unknown agent (one of ${HARNESSES.join(", ")})`);
      if (v === null || v === undefined) continue;
      if (!isObject(v)) throw new ConfigError(`handoff.agents.${a} must be a mapping (${HANDOFF_KEYS.join(", ")})`);
      h.agents[a as Harness] = handoffSettings(v, `handoff.agents.${a}`, HANDOFF_KEYS);
    }
  }
  return h;
}

/** The first `handoff` values (`on_clear: return`, `on_compact: suggest | off`) and what they became. */
const OLD_HANDOFF: Record<string, Record<string, string>> = { on_clear: { return: "ask" }, on_compact: { suggest: "ask", off: "stay" } };

/**
 * A config whose `handoff` section still has the first values: the section is replaced by the
 * current one (its comments describe the new values), the user's choices carried over. Null when
 * there's nothing to change.
 */
export function migrateHandoff(text: string): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length || !isMap(doc.get("handoff"))) return null;
  const old = (doc.toJS() as { handoff?: Record<string, unknown> }).handoff ?? {};
  const convert = (o: Record<string, unknown>) => {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      const to = typeof v === "string" ? OLD_HANDOFF[k]?.[v] : undefined;
      if (to) changed = true;
      out[k] = to ?? v;
    }
    return { out, changed };
  };
  const top = convert(Object.fromEntries(Object.entries(old).filter(([k]) => k !== "agents")));
  let changed = top.changed;
  const agents: Record<string, unknown> = {};
  if (isObject(old.agents)) {
    for (const [a, v] of Object.entries(old.agents)) {
      const c = isObject(v) ? convert(v) : { out: v, changed: false };
      changed ||= c.changed;
      agents[a] = c.out;
    }
  }
  if (!changed) return null;
  doc.delete("handoff");
  const rest = doc.toString();
  const fresh = parseDocument(`${rest === "{}\n" ? "" : rest}${rest.endsWith("\n") || !rest ? "" : "\n"}\n${HANDOFF_YAML}`);
  for (const [k, v] of Object.entries(top.out)) fresh.setIn(["handoff", k], v);
  if (Object.keys(agents).length) fresh.setIn(["handoff", "agents"], agents);
  const result = fresh.toString();
  return fresh.errors.length || parseDocument(result).errors.length ? null : result;
}

/**
 * Adds the `handoff` section, with its comments, to an existing config file that has none, so the
 * user finds the settings there. Never creates the file (setup writes nothing until its last
 * screen); a file Gluon can't write, or can't append to safely, is left as it is.
 */
export function ensureHandoffSection(path = configPath()): void {
  try {
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    const doc = parseDocument(text);
    if (doc.errors.length || doc.hasIn(["handoff"])) return;
    const next = `${text}${text.endsWith("\n") || !text ? "" : "\n"}\n${HANDOFF_YAML}`;
    // Appending only works on a block-style file. A flow/JSON config (`{…}`) or one ending a document
    // with `...` is left alone (BUG-154): written only when the result parses, has the section and
    // keeps every other value as it was. Never makes a valid config invalid.
    const after = parseDocument(next);
    if (after.errors.length || !after.hasIn(["handoff"])) return;
    const { handoff: _, ...rest } = (after.toJS() ?? {}) as Record<string, unknown>;
    if (!Bun.deepEquals(rest, doc.toJS() ?? {}, true)) return;
    writeConfig(path, next);
  } catch {}
}

/**
 * Sets keys in the config file (a path like ["brain", "active"] per entry; `undefined` deletes),
 * keeping the user's comments and everything else in it.
 */
/** The config file as a YAML document; throws ConfigError when it isn't valid YAML (nothing can be saved to it). */
export function configDocument(path = configPath()) {
  const doc = parseDocument(existsSync(path) ? readConfigText(path) : "");
  if (doc.errors.length) throw new ConfigError(`${path} is not valid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  return doc;
}

export function saveConfig(changes: [string[], unknown][]): void {
  const path = configPath();
  const doc = configDocument(path);
  if (doc.contents === null) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  for (const [keys, value] of changes) {
    if (value === undefined) {
      if (doc.hasIn(keys)) doc.deleteIn(keys);
    }
    else doc.setIn(keys, value);
  }
  writeConfig(path, doc.toString());
}

/**
 * The AWS setup every Bedrock use goes through — the brain, the probes and the launched agents:
 * the configured profile and region, else the environment's (AWS_PROFILE, AWS_REGION /
 * AWS_DEFAULT_REGION), else the default credentials in us-east-1. One source, so the brain never
 * bills a different account than the agents.
 */
export function awsSetup(config: Config): { profile?: string; region: string } {
  const profile = config.bedrock.profile || process.env.AWS_PROFILE || undefined;
  const region = config.bedrock.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || awsConfigRegion(profile) || "us-east-1";
  return { ...(profile ? { profile } : {}), region };
}

/**
 * The `region` of the AWS config's profile (`$AWS_CONFIG_FILE`, else `~/.aws/config`; `[default]`, or `[profile <name>]`):
 * what the AWS CLI and SDK use when neither the config nor the environment names one (BUG-624). That key only, never a credential
 * or any other line; undefined when the file or the key isn't there.
 */
export function awsConfigRegion(profile: string | undefined, env: Record<string, string | undefined> = process.env, home = homedir()): string | undefined {
  let text: string;
  try {
    text = readFileSync(env.AWS_CONFIG_FILE || join(home, ".aws", "config"), "utf8");
  } catch {
    return undefined;
  }
  const want = !profile || profile === "default" ? ["default", "profile default"] : [`profile ${profile}`];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[\s*(.*?)\s*\]$/);
    if (section) {
      inside = want.includes(section[1]!.replace(/\s+/g, " "));
      continue;
    }
    const kv = inside ? line.match(/^region\s*=\s*(\S+)\s*$/) : null;
    if (kv) return kv[1];
  }
  return undefined;
}

/** Today, as the config records dates. */
export const today = () => new Date().toISOString().slice(0, 10);

/** The connections a harness reaches models through ([] when not connected). */
export function connsOf(config: Config, harness: Harness): Conn[] {
  const c = config.connections[harness];
  if (!c) return [];
  if (HARNESS_INFO[harness].multiProvider) return c.providers ?? [];
  return c.auth === "subscription" ? ["plan"] : c.provider ? [c.provider] : [];
}
