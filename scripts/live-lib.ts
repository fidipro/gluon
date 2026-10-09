/**
 * The pure parts of `bun run test:live` (`scripts/live.ts`) and its real-harness section
 * (`scripts/live-harness.ts`): flags, tiers, the price table, the spend ledger with its caps and
 * buckets, the AWS region, and which connection and model a harness check uses. No network, no
 * process spawn: `test/live-script.test.ts` runs all of it offline. The ledger writes a file only
 * when it is given a path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Harness, ModelEntry } from "../src/harnesses.ts";

// ——— buckets, caps, prices ———

/** What a call is charged to. `openrouter` is a sub-bucket of `other` (campaign runs only); `subscription` costs no API money. */
export type Bucket = "bedrock" | "other" | "openrouter" | "subscription";
export interface Caps {
  bedrock: number;
  other: number;
  /** A sub-limit inside `other`: set only by `--caps openrouter=…`. */
  openrouter?: number;
}
/** The caps of a plain `bun run test:live`, over all its runs. */
export const DEFAULT_CAPS: Readonly<Caps> = { bedrock: 5, other: 3 };
export const DEFAULT_LEDGER = "qa/logs/live-spend.json";
/** `--tier=regression`: the whole run, all buckets together (USD). */
export const REGRESSION_RUN_CAP = 3;
/** `--tier=harness`: one harness's check, all buckets together (USD). */
export const HARNESS_RUN_CAP = 1;
/**
 * `--tier=journey` (`bun run regression --live`): the user's whole way through, on the real brain. Hard caps, in USD: one journey's
 * brain part (at most `JOURNEY_BRAIN.turns` turns), its agent part (the cheapest model, one prompt), one harness's journey, every
 * harness's, and all journeys in a calendar month (the ledger's runs).
 */
export const JOURNEY_BRAIN = { input: 36_000, output: 3_000, turns: 3 } as const;
export const JOURNEY_BRAIN_CAP = 0.2;
export const JOURNEY_AGENT_CAP = 0.2;
export const JOURNEY_HARNESS_CAP = 0.4;
export const JOURNEY_RUN_CAP = 1.5;
export const JOURNEY_MONTH_CAP = 5;
/** What every journey has been charged in `now`'s calendar month (UTC), from the ledger's runs. */
export function journeyMonthSpend(runs: { at: string; calls: { what: string; usd: number }[] }[], now: Date): number {
  const month = now.toISOString().slice(0, 7);
  return runs.filter((r) => r.at.startsWith(month)).flatMap((r) => r.calls).filter((c) => c.what.startsWith("journey ")).reduce((a, c) => a + c.usd, 0);
}

/**
 * `bedrock=30,other=10,openrouter=0.5` → caps. A key left out keeps its default (`openrouter` has none:
 * it is only a sub-limit when given). Throws on an unknown key, a repeated one, or a number that is not
 * a finite amount ≥ 0.
 */
export function parseCaps(text: string): Caps {
  const caps: Caps = { ...DEFAULT_CAPS };
  const seen = new Set<string>();
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z]+)=(.+)$/.exec(part);
    if (!m) throw new Error(`--caps: "${part}" is not name=amount (for example bedrock=30,other=10,openrouter=0.5)`);
    const [, name, raw] = m as unknown as [string, "bedrock" | "other" | "openrouter", string];
    if (name !== "bedrock" && name !== "other" && name !== "openrouter") throw new Error(`--caps: unknown bucket "${name}" (known: bedrock, other, openrouter)`);
    if (seen.has(name)) throw new Error(`--caps: ${name} is given twice`);
    seen.add(name);
    const n = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n)) throw new Error(`--caps: ${name}=${raw} is not an amount in dollars`);
    caps[name] = n;
  }
  if (!seen.size) throw new Error("--caps: name at least one bucket (bedrock=…, other=…, openrouter=…)");
  return caps;
}

/** $ per million tokens [input, output]; conservative (list prices or above). Unknown models: the default. */
export const PRICES: [RegExp, number, number][] = [
  [/haiku-4[-.]5/, 1, 5],
  // Haiku 5.5's long-prompt row (over 100k); its usual one is a fifth of it.
  [/haiku-5[-.]5/, 0.5, 2.5],
  [/sonnet-(5[-.]5|4[-.]6)/, 3, 15],
  [/opus/, 15, 75],
  [/fable/, 30, 150],
  [/gpt-6-luna/, 0.25, 1],
  [/gpt-6(\.1)?-sol/, 4, 15],
  [/gpt-6-astra/, 20, 75],
  [/deepseek/, 0.5, 2],
  [/muse-spark-1\.3-contributor/, 0.25, 0.5],
  [/muse-spark/, 2, 6],
  [/grok-4\.7/, 5, 25],
  [/gemini-3\.8-flash/, 0.5, 3],
  // Not looked up (no price source offline): an upper bound for Kimi over OpenRouter. Raise it if the ledger's figures say otherwise.
  [/kimi/, 1.5, 6],
];
export const DEFAULT_PRICE: [number, number] = [20, 100];
/** Bedrock's cross-region inference profiles can cost a little more (`global.` ones don't: this is conservative). */
export const BEDROCK_MARKUP = 1.1;

export function price(model: string, bucket: Bucket): [number, number] {
  const p = PRICES.find(([re]) => re.test(model));
  const [i, o] = p ? [p[1], p[2]] : DEFAULT_PRICE;
  const m = bucket === "bedrock" ? BEDROCK_MARKUP : 1;
  return [i * m, o * m];
}

export const usd = (model: string, bucket: Bucket, input: number, output: number): number => {
  const [i, o] = price(model, bucket);
  return (input * i + output * o) / 1_000_000;
};

/**
 * What a Claude-plan call is worth at API prices: the Anthropic API's price table (`anthropic-api`, bucket `other`).
 * Campaign runs charge it to `other`, flagged `estimated`.
 */
export const planEstimate = (model: string, input: number, output: number): number => usd(model, "other", input, output);

/**
 * The bucket a route (a brain step's route, or a harness connection: `anthropic`, `openai`, `gemini`, `bedrock`, `openrouter`) is charged to.
 * `campaign` (`--caps` was given): OpenRouter is its own sub-bucket (counted inside `other` too) and the Claude plan is charged at
 * API-equivalent to `other`; without it, OpenRouter is plain `other` and every plan is `subscription`, as before.
 */
export function bucketOf(route: string, campaign: boolean): Bucket {
  if (route === "bedrock") return "bedrock";
  if (route === "openrouter") return campaign ? "openrouter" : "other";
  if (route === "claude-plan") return campaign ? "other" : "subscription";
  return route.endsWith("-plan") ? "subscription" : "other";
}

/**
 * Why a plan route cannot run in a live run without touching the user's real home, or null when it can. The Claude plan runs in a
 * scratch HOME, which has no login: it needs the user's own `CLAUDE_CODE_OAUTH_TOKEN` in the environment (never read from a file).
 * The ChatGPT plan only has the real HOME's sign-in: it runs only when `GLUON_LIVE_CHATGPT_PLAN=1` says so. The message reads as
 * "not connected" so a tier counts it as a SKIP.
 */
export function planRouteBlock(route: string, env: Record<string, string | undefined>): string | null {
  if (route === "claude-plan" && !env.CLAUDE_CODE_OAUTH_TOKEN) return "not connected (the Claude plan runs in a scratch HOME: set CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`)";
  if (route === "chatgpt-plan" && env.GLUON_LIVE_CHATGPT_PLAN !== "1") return "not connected (the ChatGPT plan uses the real HOME's sign-in: opt in with GLUON_LIVE_CHATGPT_PLAN=1)";
  return null;
}

/** A Claude-plan charge in a campaign run is an estimate, whatever the call counted. */
export const planCharged = (route: string, campaign: boolean): boolean => campaign && route === "claude-plan";

// ——— the spend ledger ———

export interface Call {
  bucket: Bucket;
  what: string;
  model: string;
  input: number;
  output: number;
  usd: number;
  estimated?: boolean;
}
export interface RunRecord {
  at: string;
  calls: Call[];
  refused: string[];
}
export interface LedgerFile {
  caps: Caps;
  spent: { bedrock: number; other: number; openrouter?: number };
  runs: RunRecord[];
}

const round6 = (n: number) => Number(n.toFixed(6));

/**
 * The ledger of all runs on one file, plus this run. `allow` is asked before a call with the call's worst case
 * (this run's total, its bucket's cap and, for OpenRouter, `other`'s cap too); `charge` after it with what it used.
 * `path: null` keeps it in memory (tests); `write: false` reads the file and never writes it (dry runs).
 */
export class Spend {
  readonly file: LedgerFile;
  readonly run: RunRecord = { at: new Date().toISOString(), calls: [], refused: [] };

  constructor(
    readonly path: string | null,
    readonly caps: Caps,
    readonly runCap: number,
    readonly campaign: boolean,
    /** false: the file is read, never written (a dry run). */
    readonly write = true,
  ) {
    const old: Partial<LedgerFile> | null = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    this.file = { caps, spent: { bedrock: old?.spent?.bedrock ?? 0, other: old?.spent?.other ?? 0, ...(old?.spent?.openrouter !== undefined || caps.openrouter !== undefined ? { openrouter: old?.spent?.openrouter ?? 0 } : {}) }, runs: old?.runs ?? [] };
    this.file.runs.push(this.run);
  }

  save(): void {
    if (!this.path || !this.write) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.file, null, 2) + "\n");
  }

  /** This run's spend so far, in dollars (all buckets: an OpenRouter call counts once). */
  runTotal(): number {
    return this.run.calls.reduce((a, c) => a + c.usd, 0);
  }

  /** This run's spend in one bucket. */
  runIn(bucket: Bucket): number {
    return this.run.calls.filter((c) => c.bucket === bucket).reduce((a, c) => a + c.usd, 0);
  }

  /** The dollars spent so far, over all runs, in `bucket` (OpenRouter is read from its own count). */
  spent(bucket: "bedrock" | "other" | "openrouter"): number {
    return this.file.spent[bucket] ?? 0;
  }

  /** Whether a call whose worst case is `worst` dollars fits; a refusal is logged (and saved). */
  allowUsd(bucket: Bucket, what: string, model: string, worst: number): boolean {
    if (bucket === "subscription") return true;
    const refuse = (why: string) => {
      this.run.refused.push(`${what} (${model}): worst case $${worst.toFixed(4)} would take ${why}`);
      this.save();
      return false;
    };
    if (this.runTotal() + worst > this.runCap) return refuse(`this run over $${this.runCap}`);
    if (this.spent(bucket === "openrouter" ? "other" : bucket) + worst > this.caps[bucket === "openrouter" ? "other" : bucket]) return refuse(`${bucket === "openrouter" ? "other" : bucket} over $${this.caps[bucket === "openrouter" ? "other" : bucket]}`);
    if (bucket === "openrouter" && this.caps.openrouter !== undefined && this.spent("openrouter") + worst > this.caps.openrouter) return refuse(`openrouter over $${this.caps.openrouter}`);
    return true;
  }

  /** `allowUsd` for a call of at most `maxIn` input and `maxOut` output tokens. */
  allow(bucket: Bucket, what: string, model: string, maxIn: number, maxOut: number): boolean {
    return this.allowUsd(bucket, what, model, usd(model, bucket, maxIn, maxOut));
  }

  /** Charges a cost in dollars. A subscription call is logged with no cost. */
  chargeUsd(bucket: Bucket, what: string, model: string, cost: number, input = 0, output = 0, estimated = false): void {
    const c = bucket === "subscription" ? 0 : cost;
    this.run.calls.push({ bucket, what, model, input, output, usd: round6(c), ...(estimated ? { estimated } : {}) });
    if (bucket !== "subscription") {
      const home = bucket === "openrouter" ? "other" : bucket;
      this.file.spent[home] = round6(this.file.spent[home] + c);
      if (bucket === "openrouter") this.file.spent.openrouter = round6((this.file.spent.openrouter ?? 0) + c);
    }
    this.save();
  }

  /** Charges a call by its tokens × the price table. */
  charge(bucket: Bucket, what: string, model: string, input: number, output: number, estimated = false): void {
    this.chargeUsd(bucket, what, model, usd(model, bucket, input, output), input, output, estimated);
  }
}

// ——— flags and tiers ———

export type Tier = "regression" | "harness" | "journey";
export type Only = "nested-instructions" | "git-tools";
export interface Args {
  only?: Only;
  tier?: Tier;
  harness?: string;
  /** `--conn`: the connection the harness check uses instead of its first usable one. */
  conn?: string;
  /** `--model`: the model (an id or a label) the harness check uses instead of the cheapest. */
  model?: string;
  ledger?: string;
  caps?: Caps;
  dryRun: boolean;
}

/** Flags take `--name=value` or `--name value`. Throws on an unknown or contradictory flag. */
export function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const value = () => {
      if (eq >= 0) return arg.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
      return v;
    };
    switch (name) {
      case "--only": {
        const v = value();
        if (v !== "nested-instructions" && v !== "git-tools") throw new Error(`unknown check: ${v} (known: nested-instructions, git-tools)`);
        a.only = v;
        break;
      }
      case "--tier": {
        const v = value();
        if (v !== "regression" && v !== "harness" && v !== "journey") throw new Error(`unknown tier: ${v} (known: regression, harness, journey)`);
        a.tier = v;
        break;
      }
      case "--harness": a.harness = value(); break;
      case "--conn": a.conn = value(); break;
      case "--model": a.model = value(); break;
      case "--ledger": a.ledger = value(); break;
      case "--caps": a.caps = parseCaps(value()); break;
      case "--dry-run": a.dryRun = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  if (a.only && a.tier) throw new Error("--only and --tier are two ways to pick a run: use one");
  if (a.tier === "harness" && !a.harness) throw new Error("--tier=harness needs --harness=<id> (claude-code, codex, antigravity, opencode, kimi-code)");
  if (a.harness && !a.tier) throw new Error("--harness goes with --tier=harness, --tier=journey (or --tier=regression, to run one harness's section only)");
  if ((a.conn || a.model) && !a.tier) throw new Error("--conn and --model go with --tier=harness or --tier=regression");
  return a;
}

/** A run's whole-run cap in dollars: a targeted check's own, the tier's, or none (the buckets' caps alone). */
export function runCapOf(a: Pick<Args, "only" | "tier" | "harness">): number {
  if (a.tier === "regression") return REGRESSION_RUN_CAP;
  if (a.tier === "harness") return HARNESS_RUN_CAP;
  if (a.tier === "journey") return a.harness ? JOURNEY_HARNESS_CAP : JOURNEY_RUN_CAP;
  return a.only === "git-tools" ? 1 : a.only ? 0.5 : Infinity;
}

/** What a run does, in order. `probes`: every brain step (and, outside a tier, every harness check and connection too). */
export type Section = "harnesses" | "connections" | "probes" | "brain-chat" | "git-tools" | "nested-instructions" | "real-harness" | "brain-order" | "journey";

/**
 * The sections a run is made of. The plain run is the long check (harness status, every connection probed, the brain order with
 * a session per working step); `--only` runs one check; `--tier=regression` is the fixed set; `--tier=harness` is one harness's section.
 */
export function sectionsOf(a: Pick<Args, "only" | "tier" | "harness">): Section[] {
  if (a.tier === "regression") return a.harness ? ["real-harness"] : ["probes", "brain-chat", "git-tools", "nested-instructions", "real-harness"];
  if (a.tier === "harness") return ["real-harness"];
  if (a.tier === "journey") return ["journey"];
  if (a.only === "nested-instructions") return ["nested-instructions"];
  if (a.only === "git-tools") return ["git-tools"];
  return ["harnesses", "connections", "brain-order"];
}

// ——— AWS region ———

/**
 * The region Bedrock uses: `AWS_REGION`, then `AWS_DEFAULT_REGION`, then the `region` of the profile in the AWS config file
 * (`AWS_PROFILE`, else `default`; `[profile name]` sections, `[default]`), else null (nothing known: the script does not guess).
 */
export function awsRegion(env: Record<string, string | undefined>, awsConfig: string | null): { region: string; from: string } | null {
  if (env.AWS_REGION) return { region: env.AWS_REGION, from: "AWS_REGION" };
  if (env.AWS_DEFAULT_REGION) return { region: env.AWS_DEFAULT_REGION, from: "AWS_DEFAULT_REGION" };
  if (!awsConfig) return null;
  const profile = env.AWS_PROFILE || "default";
  const section = profile === "default" ? "default" : `profile ${profile}`;
  let inside = false;
  for (const raw of awsConfig.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      inside = head[1]!.trim().replace(/\s+/g, " ") === section;
      continue;
    }
    const kv = /^region\s*=\s*(\S+)/.exec(line);
    if (inside && kv) return { region: kv[1]!, from: `the AWS config's [${section}]` };
  }
  return null;
}

// ——— which connection and model a harness check uses ———

/** The harnesses with a real-harness check (Grok Build has no API-key route: skipped). */
export const CHECKED_HARNESSES: Harness[] = ["claude-code", "codex", "antigravity", "opencode", "kimi-code"];
/** The binary on PATH of each harness (`HARNESS_INFO[h].binary`, written out so this file stays pure). */
export const BINARY: Record<Harness, string> = { "claude-code": "claude", codex: "codex", antigravity: "agy", "grok-build": "grok", opencode: "opencode", "kimi-code": "kimi" };

/** A connection a check may use: its id, and the key it needs (`bedrock` needs the AWS setup, not a key). */
export interface ConnOption {
  conn: "bedrock" | "anthropic" | "openai" | "gemini" | "openrouter";
  key?: string;
}
/** In the order the checks prefer them: Bedrock (the largest budget), the provider's own key, then OpenRouter (the smallest). Never a plan: a sign-in. */
export const HARNESS_CONNS: Record<Harness, ConnOption[]> = {
  "claude-code": [{ conn: "bedrock" }, { conn: "anthropic", key: "ANTHROPIC_API_KEY" }, { conn: "openrouter", key: "OPENROUTER_API_KEY" }],
  codex: [{ conn: "bedrock" }, { conn: "openai", key: "OPENAI_API_KEY" }, { conn: "openrouter", key: "OPENROUTER_API_KEY" }],
  antigravity: [{ conn: "gemini", key: "GEMINI_API_KEY" }],
  "grok-build": [],
  opencode: [{ conn: "openrouter", key: "OPENROUTER_API_KEY" }],
  "kimi-code": [{ conn: "openrouter", key: "OPENROUTER_API_KEY" }],
};

/** What is available to a check: which keys are set, and whether Bedrock has a region or profile. */
export interface Available {
  hasKey(name: string): boolean;
  bedrock: boolean;
}

export type ConnPick = { ok: true; conn: ConnOption["conn"]; key?: string } | { ok: false; why: string };

/** The connection a harness check uses: `want` when given (and usable), else the first usable one in `HARNESS_CONNS`. */
export function pickConn(h: Harness, have: Available, want?: string): ConnPick {
  const options = HARNESS_CONNS[h];
  if (!options.length) return { ok: false, why: h === "grok-build" ? "Grok Build has no API-key route (its xAI plan needs a sign-in)" : "no API-key connection" };
  const usable = (o: ConnOption) => (o.conn === "bedrock" ? have.bedrock : !!o.key && have.hasKey(o.key));
  const why = (o: ConnOption) => (o.conn === "bedrock" ? "no AWS region or profile (AWS_REGION, AWS_PROFILE or the AWS config)" : `${o.key} is not set`);
  if (want) {
    const o = options.find((x) => x.conn === want);
    if (!o) return { ok: false, why: `${h} has no ${want} API-key connection here (known: ${options.map((x) => x.conn).join(", ")})` };
    return usable(o) ? { ok: true, conn: o.conn, ...(o.key ? { key: o.key } : {}) } : { ok: false, why: why(o) };
  }
  const o = options.find(usable);
  if (o) return { ok: true, conn: o.conn, ...(o.key ? { key: o.key } : {}) };
  return { ok: false, why: `no API-key connection is usable: ${options.map(why).join("; ")}` };
}

/**
 * The cheapest model of a harness on a connection, by the price table (a tie keeps the catalog's order). `want`: an id or a label
 * (case-insensitive) instead. A model needing an opt-in (`optIn`) is never picked on its own.
 */
export function cheapestModel(models: ModelEntry[], conn: string, want?: string): { entry: ModelEntry; id: string } | null {
  const bucket = bucketOf(conn, true);
  const served = models.filter((m) => m.ids[conn as keyof ModelEntry["ids"]] && (want || !m.optIn));
  if (want) {
    const w = want.toLowerCase();
    const m = served.find((x) => x.id.toLowerCase() === w || x.label.toLowerCase() === w || x.ids[conn as keyof ModelEntry["ids"]]!.toLowerCase() === w);
    return m ? { entry: m, id: m.ids[conn as keyof ModelEntry["ids"]]! } : null;
  }
  let best: { entry: ModelEntry; id: string; cost: number } | null = null;
  for (const m of served) {
    const id = m.ids[conn as keyof ModelEntry["ids"]]!;
    const cost = usd(id, bucket, 1_000_000, 1_000_000);
    if (!best || cost < best.cost) best = { entry: m, id, cost };
  }
  return best ? { entry: best.entry, id: best.id } : null;
}

/** The most one harness check may use: its launch's prompt is the only one, and a harness's own system prompt is most of the input. */
export const HARNESS_TOKENS = { input: 40_000, output: 3_000 } as const;

/** One harness check's worst case in dollars on a model and connection. */
export const harnessWorstCase = (model: string, conn: string): number => usd(model, bucketOf(conn, true), HARNESS_TOKENS.input, HARNESS_TOKENS.output);

/** The first dollar figure on a Gluon info line (`~$0.0123`, `$0.04*`, `$1.20✓`, `<$0.0001`), or null (`—` or none shown). */
export function costFigure(line: string): { usd: number; approx: boolean } | null {
  const m = /(~?)(?:(<)\$(0\.0001)|\$(\d+(?:\.\d+)?))/.exec(line);
  if (!m) return null;
  return { usd: m[2] ? Number(m[3]) : Number(m[4]), approx: m[1] === "~" };
}

// ——— brain calls ———

/** What a brain session may use at most: ~60k tokens in and 8k out (a few model calls). */
export const SESSION = { input: 60_000, output: 8_000 } as const;
/** What a brain probe may use at most. */
export const PROBE = { input: 40, output: 16 } as const;

/**
 * The step for the one brain chat: the cheapest working one by its session's worst case. A step on a paid API goes before a plan
 * (a plan costs no API money, but the API client is what a change to the brain breaks); plans only when no API works.
 */
export function chatStep<S extends { route: string; model: string }>(working: S[], campaign: boolean): S | null {
  const cost = (s: S) => {
    const b = bucketOf(s.route, campaign);
    return usd(s.model, b === "subscription" ? "other" : b, SESSION.input, SESSION.output);
  };
  const paid = working.filter((s) => !s.route.endsWith("-plan"));
  const pool = paid.length ? paid : working;
  return [...pool].sort((x, y) => cost(x) - cost(y))[0] ?? null;
}

/**
 * The small fixed subset of brain routes the regression tier runs its git-tools and nested-instructions checks on (so the tier's
 * worst case fits its cap): the plan routes in the order (free of API money) and the one cheapest API route that `usable` accepts
 * (connected, or probed fine). In the order's own order.
 */
export function regressionSubset<S extends { route: string; model: string }>(order: S[], usable: (s: S) => boolean, campaign: boolean): S[] {
  const api = chatStep(order.filter((s) => !s.route.endsWith("-plan") && usable(s)), campaign);
  return order.filter((s) => s.route.endsWith("-plan") || s === api);
}

// ——— the dry run's plan ———

export interface PlanItem {
  section: Section | "setup";
  what: string;
  /** Worst case in dollars (0: free, or a plan call that costs no API money). */
  worst: number;
  bucket: Bucket;
  /** A free call, or one that is skipped (said here). */
  note?: string;
}

/** The plan's total (the sum of the items' worst cases; a real run stops at its cap long before it, as it checks before each call). */
export const planTotal = (items: PlanItem[]): number => items.reduce((a, i) => a + i.worst, 0);

/** The plan as lines to print. */
export function planLines(items: PlanItem[], runCap: number): string[] {
  const out: string[] = [];
  let section = "";
  for (const i of items) {
    if (i.section !== section) {
      section = i.section;
      out.push(`\n[${section}]`);
    }
    out.push(`  ${i.worst > 0 ? `≤ $${i.worst.toFixed(4)}`.padEnd(10) : "free".padEnd(10)} ${i.bucket.padEnd(13)} ${i.what}${i.note ? ` · ${i.note}` : ""}`);
  }
  const total = planTotal(items);
  out.push(`\nWorst case, every item at its maximum: $${total.toFixed(4)}`);
  if (Number.isFinite(runCap)) out.push(`The run's cap is $${runCap}${total > runCap ? ": over it in this worst case, so a run where every call hit its maximum would stop short" : ""}. Each call is checked against what this run spent so far + its own worst case, so a run ends at the cap, never past it.`);
  return out;
}
