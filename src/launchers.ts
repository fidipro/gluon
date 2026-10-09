import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ADAPTER_DIR, ADAPTER_DIR_JSON, SELF, type AdapterOutput } from "./adapters/types.ts";
import { awsSetup, configPath, connsOf, type AgentOption, type Config, type Harness } from "./config.ts";
import { effortsOn, HARNESS_INFO, MODES, modeUnavailable, OPENAI_API_BASE, OPENROUTER_ANTHROPIC_BASE, OPENROUTER_OPENAI_BASE, permissionLevels, permissionsUnavailable, PROVIDERS, type Conn, type Effort, type HarnessInfo, type Mode, type ModeLaunch, type ModelEntry, type Permissions, type SessionRef } from "./harnesses.ts";
import { RESUME_ID } from "./workspaces.ts";
import { assertShimArgs, binPath, cmdSafe, isShim, killTree, missingReason, shortPath, showChar, unsafeChar } from "./detect.ts";
import { createEventsDir, EVENTS_ENV, HANDOFF_ENV, readEvents, SELF_ENV, writeAnswer } from "./events.ts";
import { kimiWindow } from "./cost/kimi.ts";
import { telemetryLaunch, type TelemetryLaunch, type TelemetrySession } from "./telemetry.ts";
import { handoffPieces, type HandoffSettings } from "./handoff.ts";
import { resolveModel, unservedModel } from "./models.ts";
import { privateDir, secret } from "./secrets.ts";
import { selfExecutable } from "./self.ts";
import { afterHandoff, endStdinReader, freshStdin, releaseRaw } from "./ui/rawmode.ts";

/** What Gluon proposes and the developer confirms. */
export interface LaunchChoice {
  harness: Harness;
  model: string;
  effort?: Effort;
  /** How the session starts; none: build. */
  mode?: Mode;
  /** Who approves the agent's commands and edits in build mode (`Permissions`); none: the harness's own. */
  permissions?: Permissions;
  spec: string;
  reason: string;
}

export interface Command {
  argv: string[];
  env: Record<string, string>;
  /** The connection the launch uses. */
  conn?: Conn;
  /** The spec, carried by the last argument (after `--`, or as `--prompt=<spec>`); none for a login. */
  spec?: string;
  /** A resume: no spec; Codex's argv still ends `-- <session id>`. */
  resumed?: true;
  /** A UI launch's adapter (its files are written by `handOffSession`). */
  adapter?: AdapterOutput;
  /** The agent launched (a launch, not a login): which screen reader and slash commands its PTY uses. */
  harness?: Harness;
  /** The launch's mode, when not build. */
  mode?: Mode;
  /**
   * A mode the harness has no flag for (`ModeLaunch.typed`): the line Gluon types into the agent's
   * PTY once its composer is up. The spec is then not in argv: `launchPlan` writes it to a file and
   * the line names it. Only a PTY launch can type it. "" for a harness whose every launch is typed (`typedSpec`): the line is just the brief's.
   */
  firstLine?: string;
  /** The harness takes no prompt in argv (`HarnessInfo.typedSpec`): nothing in `argv` is the spec, which only `firstLine`'s brief carries. */
  typedSpec?: true;
}

/**
 * Why a UI launch's agent ended: it exited; or Gluon ended it — the user said yes to returning
 * at its /clear (`clear`) or instead of a compaction (`compact`), pressed the return key or the
 * agent sent `back` (`back`).
 */
export type ReturnReason = "exit" | "clear" | "back" | "compact";
export interface SessionEnd {
  /** The agent's exit code (128 + signal when killed). */
  code: number;
  reason: ReturnReason;
}

export function findAgent(config: Config, harness: Harness): AgentOption | undefined {
  return config.agents.find((a) => a.harness === harness);
}

/**
 * Returns an error message, or null when the choice names an offered agent, model and effort.
 * `requireEffort`: an agent that takes an effort must be given one (the brain must decide it).
 */
export function validateChoice(config: Config, c: LaunchChoice, { requireEffort = false } = {}): string | null {
  const agent = findAgent(config, c.harness);
  if (!agent) return `unknown harness "${c.harness}" (available: ${config.agents.map((a) => a.harness).join(", ")})`;
  if (!agent.models.some((m) => m.id === c.model)) {
    return `${agent.label} has no model "${c.model ?? ""}" (models: ${agent.models.map((m) => m.id).join(", ")})`;
  }
  const unserved = unservedModel(config, c.harness, c.model);
  if (unserved) return unserved;
  const unavailable = c.mode && c.mode !== "build" ? HARNESS_INFO[c.harness]?.modes[c.mode]?.unavailable : undefined;
  if (unavailable) return modeUnavailable(agent.label, c.mode!, unavailable);
  if (c.permissions && !permissionLevels(c.harness).includes(c.permissions)) return permissionsUnavailable(agent.label, c.permissions);
  // Efforts belong to the model: DeepSeek takes low, high, max; Kimi, Claude and Codex each their own. On a connection that can't apply them (`effortConns`) there are none.
  const option = agent.models.find((m) => m.id === c.model)!;
  const entry = config.models[c.harness]?.find((m) => m.id === c.model);
  const conn = entry && resolveModel(config, c.harness, c.model)?.conn;
  const efforts = entry && conn ? effortsOn({ efforts: option.efforts, effortConns: entry.effortConns }, conn) : option.efforts;
  const who = `${agent.label}'s ${c.model}`;
  if (c.effort && !efforts.includes(c.effort)) {
    return efforts.length ? `${who} does not take effort "${c.effort}" (efforts: ${efforts.join(", ")})` : `${who} takes no effort; omit it`;
  }
  if (requireEffort && !c.effort && efforts.length) return `${who} needs an effort (one of ${efforts.join(", ")})`;
  if (typeof c.spec !== "string" || !c.spec.trim()) return "spec is empty";
  return null;
}

/**
 * Login tokens: never forwarded to anything Gluon starts, on any connection. (One the user
 * exported themselves is inherited as is, by local processes only.)
 */
export const TOKEN_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_ACCESS_TOKEN",
  "CHATGPT_ACCESS_TOKEN",
  "OPENAI_ACCESS_TOKEN",
  "XAI_ACCESS_TOKEN",
  "GROK_AUTH_TOKEN",
  "GROK_ACCESS_TOKEN",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_ACCESS_TOKEN",
  "GEMINI_OAUTH_TOKEN",
];
const TOKEN_LIKE = /OAUTH|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|SESSION_TOKEN$/;

/** Variables that route an agent's traffic elsewhere. */
export const BASE_URL_ENV = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL", "XAI_BASE_URL", "OPENROUTER_BASE_URL"];
const BASE_URL_LIKE = /_BASE_URL$|_API_BASE$/;

/** The only base URLs Gluon sets: an API-key aggregator connection, pointed at the aggregator's documented endpoint. */
const AGGREGATOR_ENV: Partial<Record<Conn, Record<string, string>>> = {
  openrouter: { ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_BASE, OPENAI_BASE_URL: OPENROUTER_OPENAI_BASE },
};
/** A base URL only one harness takes, on one aggregator connection: Kimi Code's `KIMI_MODEL_BASE_URL` on OpenRouter (never on its plan). */
const HARNESS_AGGREGATOR_ENV: Partial<Record<Harness, Partial<Record<Conn, Record<string, string>>>>> = {
  "kimi-code": { openrouter: { KIMI_MODEL_BASE_URL: OPENROUTER_OPENAI_BASE } },
};

/** Always refused, whatever the connection (kept for callers that list them). */
export const FORBIDDEN_ENV = [...TOKEN_ENV, ...BASE_URL_ENV];

/**
 * Throws when an environment Gluon builds carries a login token, or a base URL other than an
 * API-key aggregator's own documented endpoint on that aggregator's connection. `conn`: the
 * connection the environment is for (none: a subscription, a login, or the brain's plan routes); `harness`: whose launch it is, for the
 * one base URL a single harness takes (`HARNESS_AGGREGATOR_ENV`).
 */
export function assertSafeEnv(env: Record<string, string | undefined>, conn?: Conn, harness?: Harness): void {
  for (const k of Object.keys(env)) {
    if (TOKEN_ENV.includes(k) || TOKEN_LIKE.test(k)) throw new Error(`Gluon doesn't pass ${k} to an agent: login tokens are never forwarded`);
    if (BASE_URL_ENV.includes(k) || BASE_URL_LIKE.test(k)) {
      const allowed = conn ? (AGGREGATOR_ENV[conn]?.[k] ?? (harness ? HARNESS_AGGREGATOR_ENV[harness]?.[conn]?.[k] : undefined)) : undefined;
      if (allowed === undefined || env[k] !== allowed) throw new Error(`Gluon doesn't pass ${k} to an agent${conn === "plan" || !conn ? " on a subscription" : ` on ${conn}`}: only an API-key aggregator's documented endpoint is allowed`);
    }
    // Kimi Code's key variable: the key of its own API-key connection (OpenRouter's or Moonshot's) on that launch alone, never on its plan (BUG-431).
    if (k === "KIMI_MODEL_API_KEY" && !((conn === "openrouter" || conn === "moonshot") && harness === "kimi-code")) throw new Error("Gluon passes KIMI_MODEL_API_KEY only as an OpenRouter or Moonshot key for Kimi Code");
    if (k === "ANTHROPIC_AUTH_TOKEN" && conn !== "openrouter") throw new Error("Gluon passes ANTHROPIC_AUTH_TOKEN only as an OpenRouter key");
  }
}

/** The key variable a connection hands its harness, or null (a subscription, or Bedrock's AWS setup). */
export function keyVar(conn: Conn): string | null {
  return conn === "plan" ? null : (PROVIDERS[conn].env ?? null);
}

/** Why a launch on this connection can't work as configured (a missing key), or null. */
export function launchProblem(config: Config, harness: Harness, conn?: Conn): string | null {
  const conns = connsOf(config, harness);
  const c = conn ?? conns[0];
  // A harness that isn't connected runs as it is (its own login or setup): nothing to check.
  if (!c || !conns.includes(c)) return null;
  const v = keyVar(c);
  if (v && !secret(v)) return `${HARNESS_INFO[harness].label} is set to use ${PROVIDERS[c as Exclude<Conn, "plan">].label}, but ${v} isn't set. Run \`gluon connect ${harness}\`.`;
  return null;
}

/** Where grok looks for a login on an xAI-key launch: a file that never exists (handOff removes it). */
export const grokKeyAuthPath = () => join(dirname(configPath()), "grok-key-launch", "no-login.json");

/** AWS settings for a Bedrock launch: `awsSetup`, as the brain and the probes use it (a region is required by the agents). */
function awsEnv(config: Config): Record<string, string> {
  const { profile, region } = awsSetup(config);
  return { ...(profile ? { AWS_PROFILE: profile } : {}), AWS_REGION: region };
}

/**
 * OpenCode takes a model's effort as the `settings` of that model in its config (`providers.<provider>.models.<model>.settings`): OpenRouter's
 * are `reasoning.effort`, the OpenCode plan's `reasoningEffort`. The plan's Muse has no `max`: it is asked for `xhigh`.
 * Applies to every agent of the session, the explore and plan ones too. Nothing without an effort (OpenCode's own default).
 */
export function opencodeEffort(conn: Conn, id: string, entry: Pick<ModelEntry, "family">, effort: Effort | undefined): { providers?: Record<string, unknown> } {
  if (!effort || conn === "plan") return {};
  const provider = PROVIDERS[conn].opencodeId ?? conn;
  const plan = !!PROVIDERS[conn].subscription;
  const level = plan && entry.family === "muse" && effort === "max" ? "xhigh" : effort;
  return { providers: { [provider]: { models: { [id]: { settings: plan ? { reasoningEffort: level } : { reasoning: { effort: level } } } } } } };
}

/**
 * What a resume applies of a mode's launch (`ModeLaunch`): only explore's enforcement that sits in the launch and not in the
 * harness's session: Codex's sandbox and approval flags, Grok Build's sandbox and deny rules, OpenCode's agent and deny rules
 * (QA-live-02: a resumed Codex was workspace-write with no approvals, a resumed OpenCode was Build), and Claude Code's `--permission-mode
 * dontAsk --disallowedTools …` again (its session keeps `dontAsk`; the tool list is not known to survive: defence in depth,
 * the options are the ones a new launch passes before `--resume=<id>`). Plan is the conversation's state (the user approves it and the agent leaves it): forcing it again at a resume
 * would put a finished plan back, so nothing is applied, and a typed `/plan` was already sent. Nothing is typed on a resume.
 */
function resumedLaunch(info: HarnessInfo, mode: Mode | undefined): ModeLaunch | undefined {
  const l = mode === "explore" ? info.modes.explore : undefined;
  if (!l) return undefined;
  return { ...(l.argv ? { argv: l.argv } : {}), ...(l.opencodeConfig ? { opencodeConfig: l.opencodeConfig } : {}) };
}

/**
 * Whether a saved session of this harness with no mode on record (written before Gluon saved it) can't be resumed safely: the
 * harness can resume and its explore enforcement is in the launch (`resumedLaunch`), so a resume would drop it if the session was
 * an explore one and nothing says it wasn't. Codex, Grok Build and OpenCode. Claude Code's own session still holds its permission mode (`partlyKeptOnResume`), so its records resume;
 * Antigravity and Kimi Code can't be resumed.
 */
export function modeLostOnResume(harness: Harness): boolean {
  const info = HARNESS_INFO[harness];
  const explore = info.modes.explore;
  return !!info.resume && !explore.unavailable && !explore.partlyKeptOnResume && !!(explore.argv || explore.opencodeConfig);
}

/**
 * The spec is passed so that one starting with `-`(a markdown bullet) is never read as an option.
 * `adapter`: what a UI launch adds so the agent can send the user back (`adapters/`); never for
 * `--launch`. `session`: the session to start under or resume (`SessionRef`; a resume carries no spec and applies of
 * the mode only what the harness loses: `resumedLaunch`).
 */
export function buildCommand(config: Config, c: LaunchChoice, adapter?: AdapterOutput, session?: SessionRef): Command {
  if (session && !RESUME_ID.test(session.id)) throw new Error("not a valid session id");
  const spec = c.spec.trim();
  const info = HARNESS_INFO[c.harness];
  if (!info) throw new Error(`unknown harness "${c.harness}"`);
  // Antigravity has no id to resume by: its argv would start a new session with the spec.
  if (session?.resume && !info.resume) throw new Error(`${info.label} can't resume a session`);
  const resolved = resolveModel(config, c.harness, c.model);
  if (!resolved) throw new Error(`${info.label} can't reach model "${c.model}" on its connection`);
  const { conn, id } = resolved;
  const entry = config.models[c.harness].find((m) => m.id === c.model)!;
  const env: Record<string, string> = {};
  const extra: string[] = [];
  let model = id;
  // Build adds nothing; explore and plan add what `HarnessInfo.modes` says. A resume goes through the harness's own resume and
  // applies only what that harness loses (`resumedLaunch`): an explore session's argv or OpenCode config again, never a typed
  // line, a brief or a plan (the session already had them), and nothing for a harness that keeps its mode itself.
  const mode = c.mode && c.mode !== "build" ? c.mode : undefined;
  const full = mode ? info.modes[mode] : undefined;
  if (mode && !full) throw new Error(`unknown mode "${mode}" (modes: ${MODES.join(", ")})`);
  if (full?.unavailable) throw new Error(modeUnavailable(info.label, mode!, full.unavailable));
  const launch = session?.resume ? resumedLaunch(info, mode) : full;
  // Only the key for the chosen model's provider; nothing at all on a subscription.
  const v = keyVar(conn);
  const key = v ? secret(v) : undefined;
  if (conn === "bedrock") Object.assign(env, awsEnv(config));
  switch (c.harness) {
    case "claude-code":
      if (conn === "bedrock") env.CLAUDE_CODE_USE_BEDROCK = "1";
      else if (conn === "openrouter") {
        // OpenRouter's documented Claude Code setup.
        env.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_BASE;
        if (key) env.ANTHROPIC_AUTH_TOKEN = key;
        env.ANTHROPIC_API_KEY = "";
      } else if (v && key) env[v] = key;
      break;
    case "codex":
      // Bedrock's runtime provider takes the `global.openai.*` inference profiles; `amazon-bedrock` is the Mantle one (`openai.*` ids): BUG-420.
      if (conn === "bedrock") extra.push("-c", 'model_provider="amazon-bedrock-runtime"');
      else if (conn === "openai") {
        // Codex signed in to ChatGPT ignores OPENAI_API_KEY on its built-in provider: a provider of
        // its own that reads the key makes the key what runs (codex 0.158; forced_login_method
        // would log the user out instead).
        extra.push("-c", `model_providers.openai-api-key={name="OpenAI API key",base_url="${OPENAI_API_BASE}",env_key="OPENAI_API_KEY",wire_api="responses"}`, "-c", 'model_provider="openai-api-key"');
      }
      else if (conn === "openrouter") {
        extra.push("-c", `model_providers.openrouter={name="OpenRouter",base_url="${OPENROUTER_OPENAI_BASE}",env_key="OPENROUTER_API_KEY"}`, "-c", 'model_provider="openrouter"');
      }
      if (v && key) env[v] = key;
      break;
    case "grok-build":
      if (v && key) env[v] = key;
      // grok signed in to grok.com ignores XAI_API_KEY: pointed at an auth file that doesn't exist,
      // it has no login and uses the key (GROK_AUTH_PATH, undocumented; grok 1.0.44). The user's
      // own grok login is never read or touched.
      if (conn === "xai") env.GROK_AUTH_PATH = grokKeyAuthPath();
      break;
    case "kimi-code":
      // No auto-update: an update swaps the binary under a running Gluon and its screen reader (and writes Kimi's own files).
      env.KIMI_CODE_NO_AUTO_UPDATE = "1";
      if (conn === "openrouter" || conn === "moonshot") {
        // Kimi's documented environment model: in memory only, nothing written to its config. Its own variable names for the key.
        // Moonshot: Gluon sets no base URL, type `kimi` (Kimi's default, pinned so an inherited type of the user's never sends the key to another vendor's default URL) reaches Moonshot's global API.
        env.KIMI_MODEL_PROVIDER_TYPE = conn === "openrouter" ? "openai" : "kimi";
        if (conn === "openrouter") env.KIMI_MODEL_BASE_URL = OPENROUTER_OPENAI_BASE;
        if (key) env.KIMI_MODEL_API_KEY = key;
        env.KIMI_MODEL_NAME = id;
        // Without it Kimi sizes an environment model at 256K whatever the model: Gluon's window for it (`src/cost/kimi.ts`).
        const window = kimiWindow(c.model);
        if (window) env.KIMI_MODEL_MAX_CONTEXT_SIZE = String(window);
      } else extra.push("-m", `kimi-code/${id}`); // the plan: the alias `kimi login` adds for the model
      // The effort is Kimi's own provider's (the plan's): an API-key provider's type ignores the variable (Moonshot's untested), so it isn't passed there (`effortConns`; BUG-433).
      if (c.effort && conn === "plan") env.KIMI_MODEL_THINKING_EFFORT = c.effort;
      break;
    case "opencode":
      model = `${PROVIDERS[conn as Exclude<Conn, "plan">]?.opencodeId ?? conn}/${id}`;
      // A mode's config is merged at the top level; what Gluon sets itself (`model`, `providers`) stays.
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model, ...opencodeEffort(conn, id, entry, c.effort), ...Object.fromEntries(Object.entries(launch?.opencodeConfig ?? {}).filter(([k]) => k !== "model" && k !== "providers")) });
      if (v && key) env[v] = key;
      break;
    default:
      if (v && key) env[v] = key;
  }
  if (launch?.argv) extra.push(...launch.argv);
  // Permissions are build's alone (explore and plan set their own); a resume applies them again, as a new launch does.
  if (c.permissions && c.permissions !== "own" && !mode) {
    const flags = info.permissions?.[c.permissions];
    if (!flags) throw new Error(permissionsUnavailable(info.label, c.permissions));
    extra.push(...flags);
  }
  // Plan mode has an effort of its own: without this Codex switches to its own default when /plan is typed.
  if (launch?.typed && c.effort && c.harness === "codex") extra.push("-c", `plan_mode_reasoning_effort="${c.effort}"`);
  if (adapter) {
    extra.push(...adapter.argv);
    Object.assign(env, adapter.env);
  }
  assertSafeEnv(env, conn, c.harness);
  const typedSpec = info.typedSpec && !session?.resume;
  return {
    // Antigravity names the effort in the model id (`gemini-3.8-flash-high`): without one, the model's own default.
    argv: info.argv(model, c.effort ?? (c.harness === "antigravity" ? entry.defaultEffort : undefined), spec, extra, session),
    env,
    conn,
    ...(session?.resume ? { resumed: true as const } : { spec }),
    harness: c.harness,
    ...(adapter ? { adapter } : {}),
    ...(mode && !session?.resume ? { mode } : {}),
    ...(launch?.typed ? { firstLine: launch.typed } : typedSpec ? { firstLine: "" } : {}),
    ...(typedSpec ? { typedSpec: true as const } : {}),
  };
}

/**
 * What a mode lets the agent do, in words, for the brief: Gluon adds it whenever the mode isn't build, whatever the spec
 * says (the developer may have switched the mode after the brain wrote it: BUG-410). Neutral to the harness.
 */
export function modeBrief(mode: Mode | undefined): string | null {
  if (mode === "explore") return "## Mode: explore\n\nThis session is read-only: investigate and report what you find. Make no changes: edit, create or delete no files, and change no repository state or settings. If the goal above asks for a change, report what it would take instead of making it.";
  if (mode === "plan") return "## Mode: plan\n\nProduce a plan for the developer to approve; don't implement it, and make no changes until they approve. If the goal above asks for the change itself, plan that change instead.";
  return null;
}

/** The spec with the mode's block after it (none for build). */
export function withMode(spec: string, mode: Mode | undefined): string {
  const brief = modeBrief(mode);
  return brief ? `${spec.trim()}\n\n${brief}` : spec;
}

/**
 * Said where nothing can type into the agent (`--launch`, a UI launch without a pseudo-terminal), for a mode Gluon types in
 * (`ModeLaunch.typed`: Codex, Grok Build) or a harness that takes no prompt in argv (`HarnessInfo.typedSpec`: Kimi Code).
 */
export const typedModeRefusal = (harness: Harness | undefined): string =>
  harness && HARNESS_INFO[harness].typedSpec
    ? `${HARNESS_INFO[harness].label} takes no prompt on its command line: Gluon types the brief into it, which only its frame (a pseudo-terminal) can do`
    : `${harness ? HARNESS_INFO[harness].label : "This agent"} starts in plan mode only in Gluon's frame (Gluon types /plan into it); use --mode explore or build`;

/** Why this choice can't start where nothing types into the agent, or null. */
export function typedModeProblem(harness: Harness, mode: Mode | undefined): string | null {
  return HARNESS_INFO[harness]?.typedSpec || (mode && mode !== "build" && HARNESS_INFO[harness]?.modes[mode]?.typed) ? typedModeRefusal(harness) : null;
}

export const BINARIES: Record<Harness, string> = Object.fromEntries(Object.values(HARNESS_INFO).map((h) => [h.id, h.binary])) as Record<Harness, string>;

/** Longer than this, the command line fails to start (Windows: 32,767 UTF-16 units; Linux: 128 KiB for one argument). */
const MAX_ARGS = { win32: 30_000, other: 120_000 };
const tooLong = (argv: string[], platform: NodeJS.Platform) =>
  platform === "win32" ? argv.reduce((n, a) => n + a.length + 3, 0) > MAX_ARGS.win32 : argv.some((a) => Buffer.byteLength(a) > MAX_ARGS.other);

export interface LaunchPlan {
  argv: string[];
  /** The spec's file (removed with its directory after the agent exits). */
  specFile?: string;
  /** icacls couldn't limit the spec's directory to the user. */
  warning?: string;
  /** `Command.firstLine` made whole: the line to type (no Enter), naming the spec's file. */
  firstLine?: string;
}

/**
 * What runs for a command: the binary found for it (on Windows, a shim's native exe when there is
 * one) and its arguments. A `.cmd` / `.bat` shim runs through cmd.exe, which would act on the
 * spec's `&`, `|`, `%`, `"` and newlines; a spec too long for a command line fails to start. Then
 * the spec goes into a private file (a `privateDir` in the temp dir — its 8.3 short form when the
 * path itself has characters cmd.exe would act on) and the agent gets a one-line prompt naming it.
 * Throws, naming the character, when an argument still can't pass through cmd.exe.
 */
export function launchPlan(cmd: Command, bin: string, { tmp = tmpdir(), short = shortPath, platform = process.platform }: { tmp?: string; short?: (path: string) => string | null; platform?: NodeJS.Platform } = {}): LaunchPlan {
  const argv = [bin, ...cmd.argv.slice(1)];
  const plan: LaunchPlan = { argv };
  // A mode Gluon types in: the spec is in a file in any case, and the agent starts without a prompt.
  const typed = cmd.firstLine !== undefined && cmd.spec !== undefined;
  if (cmd.spec !== undefined && (typed || isShim(bin) || tooLong(argv, platform))) {
    const last = argv.at(-1)!;
    if (!cmd.typedSpec && !last.endsWith(cmd.spec)) throw new Error("the spec isn't the command's last argument");
    const base = isShim(bin) ? [tmp, short(tmp)].find((b): b is string => !!b && cmdSafe(b)) : tmp;
    if (!base) throw new Error(`the temp directory ${tmp} has ${showChar(unsafeChar(tmp)!)} in its path, which cmd.exe would act on, and has no short (8.3) name; set TEMP to a plain path (e.g. C:\\Temp) or install the agent's native .exe`);
    const { dir, warning } = privateDir(base, "gluon-spec-", platform === "win32");
    plan.specFile = join(dir, "session.md");
    if (warning) plan.warning = warning;
    // Its owner, so a sweep (`cleanStaleSpecs`, `gluon uninstall`) keeps a running launch's (BUG-143).
    writeFileSync(join(dir, "pid"), String(process.pid), { mode: 0o600 });
    writeFileSync(plan.specFile, `${cmd.spec}\n`, { mode: 0o600, flag: "wx" });
    if (typed) {
      // No spec in argv, and no `--` left before it (a `typedSpec` harness never had it there).
      if (!cmd.typedSpec) argv.splice(argv.length - (argv.at(-2) === "--" ? 2 : 1));
      plan.firstLine = cmd.firstLine ? `${cmd.firstLine} ${briefLine(plan.specFile)}` : briefLine(plan.specFile);
    } else argv[argv.length - 1] = last.slice(0, last.length - cmd.spec.length) + briefLine(plan.specFile);
  }
  try {
    assertShimArgs(argv);
  } catch (e) {
    if (plan.specFile) rmSync(dirname(plan.specFile), { recursive: true, force: true });
    throw e;
  }
  return plan;
}

/** The one-line prompt that names the spec's file. */
const briefLine = (file: string) => `Read the session brief in ${file} and start.`;

/** grok on an xAI key: an empty place for its login (`grokKeyAuthPath`), so grok uses the key. */
function emptyGrokAuth(cmd: Command) {
  if (!cmd.env.GROK_AUTH_PATH) return;
  try {
    mkdirSync(dirname(cmd.env.GROK_AUTH_PATH), { recursive: true, mode: 0o700 });
    rmSync(cmd.env.GROK_AUTH_PATH, { force: true });
  } catch {}
}

/**
 * Hands the terminal to the agent: Gluon's UI must already be unmounted. Runs the command in
 * `cwd` (a login: `neutralCwd()`; an agent: the repository) and resolves with its exit code.
 */
export async function handOff(cmd: Command, cwd?: string): Promise<number> {
  if (cmd.firstLine !== undefined) throw new Error(typedModeRefusal(cmd.harness));
  const bin = binPath(cmd.argv[0]!);
  if (!bin) throw new Error(missingReason(cmd.argv[0]!));
  const plan = launchPlan(cmd, bin);
  if (plan.warning) console.error(`gluon: note: ${plan.warning}`);
  emptyGrokAuth(cmd);
  try {
    return await inTerminal(plan.argv, { ...process.env, ...cmd.env }, cwd);
  } finally {
    if (plan.specFile) rmSync(dirname(plan.specFile), { recursive: true, force: true });
  }
}

/** The command with the launch's adapter directory and `GLUON_SELF` in place of their tokens (never in the spec). */
export function substituteTokens(cmd: Command, adapterDir: string, self: string): Command {
  const sub = (s: string) => s.replaceAll(ADAPTER_DIR_JSON, JSON.stringify(adapterDir).slice(1, -1)).replaceAll(ADAPTER_DIR, adapterDir).replaceAll(SELF, self);
  const last = cmd.spec === undefined || cmd.typedSpec ? cmd.argv.length : cmd.argv.length - 1;
  return {
    ...cmd,
    argv: cmd.argv.map((a, i) => (i < last ? sub(a) : a)),
    env: Object.fromEntries(Object.entries(cmd.env).map(([k, v]) => [k, sub(v)])),
    ...(cmd.adapter ? { adapter: { ...cmd.adapter, files: Object.fromEntries(Object.entries(cmd.adapter.files).map(([p, body]) => [p, sub(body)])) } } : {}),
  };
}

/** Writes an adapter's files under `dir` (0600, directories 0700; a path ending in "/" is an empty directory); a path that leaves `dir` is refused. */
export function writeAdapterFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const path = resolve(dir, rel);
    const r = relative(dir, path);
    if (!r || isAbsolute(rel) || isAbsolute(r) || r.split(/[\\/]/)[0] === "..") throw new Error(`an adapter file outside its directory: ${rel}`);
    if (rel.endsWith("/")) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, body, { mode: 0o600, flag: "wx" });
  }
}

export const ADAPTER_PREFIX = "gluon-adapter-";

/** Said at each UI launch that can't have a pseudo-terminal and runs as `--launch` does. */
export const NO_PTY_NOTE = "no pseudo-terminal here: the agent runs directly in this terminal, one session at a time (its /clear and /compact won't ask, and the home key is off)";

/** What a UI launch reports while its agent runs (display only). */
export interface SessionWatch {
  /** The launch's telemetry channel (`telemetry.ts`): the agent exports its cost and context there, where it can (`telemetryLaunch`). */
  telemetry?: Pick<TelemetrySession, "token" | "endpoint">;
}

/** The command with a telemetry launch's options before the spec (after the last `--`), and its variables. */
export function withTelemetry(cmd: Command, t: TelemetryLaunch | null): Command {
  if (!t) return cmd;
  assertSafeEnv(t.env, cmd.conn, cmd.harness);
  // Options only where the spec follows `--` (Codex): never into the spec or after it.
  const dash = cmd.argv.length - 2;
  const fits = t.argv.length > 0 && (cmd.spec !== undefined || cmd.resumed === true) && cmd.argv[dash] === "--";
  const argv = fits ? [...cmd.argv.slice(0, dash), ...t.argv, ...cmd.argv.slice(dash)] : cmd.argv;
  return { ...cmd, argv, env: { ...cmd.env, ...t.env } };
}

/**
 * A UI launch made ready to run: the events directory, the adapter's files, `GLUON_*` and the
 * telemetry variables in its environment, its launch plan. `cleanup()` removes every file and
 * directory it made (call it whatever happens); `notes`: what to tell the user (icacls warnings).
 */
export interface PreparedLaunch {
  argv: string[];
  env: Record<string, string | undefined>;
  /** The launch's events directory (`events.ts`). */
  events: string;
  notes: string[];
  /** The line Gluon types into the agent's PTY once its composer is up (`LaunchPlan.firstLine`). */
  firstLine?: string;
  cleanup(): void;
}

/**
 * Everything `handOffSession` does before the agent starts, shared with Gluon's `AgentSession`
 * (`pty/session.ts`). Throws (having removed what it made) when the agent can't be found or the
 * command can't run as planned.
 */
export function prepareLaunch(cmd: Command, settings: HandoffSettings, { tmp = tmpdir(), telemetry: channel }: { tmp?: string; telemetry?: SessionWatch["telemetry"] } = {}): PreparedLaunch {
  const bin = binPath(cmd.argv[0]!);
  if (!bin) throw new Error(missingReason(cmd.argv[0]!));
  const win = process.platform === "win32";
  const dirs: string[] = [];
  let specFile: string | undefined;
  const notes: string[] = [];
  const cleanup = () => {
    if (specFile) rmSync(dirname(specFile), { recursive: true, force: true });
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  };
  try {
    const events = createEventsDir(tmp);
    dirs.push(events.dir);
    if (events.warning) notes.push(events.warning);
    const adapter = cmd.adapter;
    let adapterDir = "";
    if (adapter && (Object.keys(adapter.files).length || JSON.stringify(adapter).includes(ADAPTER_DIR))) {
      const made = privateDir(tmp, ADAPTER_PREFIX, win);
      adapterDir = made.dir;
      dirs.push(made.dir);
      if (made.warning) notes.push(made.warning);
      writeFileSync(join(adapterDir, "pid"), String(process.pid), { mode: 0o600 });
    }
    const self = selfExecutable(adapterDir || events.dir);
    const telemetry = channel && cmd.harness ? telemetryLaunch(cmd.harness, channel) : null;
    const ready = substituteTokens(withTelemetry(cmd, telemetry), adapterDir, self);
    if (adapterDir && ready.adapter) writeAdapterFiles(adapterDir, ready.adapter.files);
    const plan = launchPlan(ready, bin, { tmp });
    specFile = plan.specFile;
    if (plan.warning) notes.push(plan.warning);
    emptyGrokAuth(ready);
    const env = { ...process.env, ...ready.env, [EVENTS_ENV]: events.dir, [HANDOFF_ENV]: handoffPieces(settings).join(","), [SELF_ENV]: self };
    return { argv: plan.argv, env, events: events.dir, notes, ...(plan.firstLine !== undefined ? { firstLine: plan.firstLine } : {}), cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * A UI launch without a pseudo-terminal (Gluon's one-at-a-time path, `gluon.ts`): like `handOff`,
 * plus the channel back (`events.ts`) — the events directory, the adapter's files, `GLUON_*` in
 * the agent's environment — and the reason the agent ended. The agent gets the terminal directly
 * (`inTerminal`); its directories are removed, the terminal reset and unread input dropped
 * whatever happened (`afterHandoff`).
 */
export async function handOffSession(cmd: Command, settings: HandoffSettings, cwd?: string, tmp = tmpdir()): Promise<SessionEnd> {
  let prepared: PreparedLaunch | undefined;
  try {
    if (cmd.firstLine !== undefined) throw new Error(typedModeRefusal(cmd.harness));
    prepared = prepareLaunch(cmd, settings, { tmp });
    // Not through `console`: Gluon's home view (Ink, suspended) would drop it.
    for (const n of prepared.notes) process.stderr.write(`gluon: note: ${n}\n`);
    return await inTerminal(prepared.argv, prepared.env, cwd, { events: prepared.events });
  } finally {
    prepared?.cleanup();
    await afterHandoff();
  }
}

/** `inTerminal`'s options. `events`: the directory to watch for events from the agent (a UI launch only). */
export interface TerminalOptions {
  events?: string;
}

/** How often the events directory is read (polling: no `fs.watch`, which misses events on some systems). */
export const POLL_MS = 100;
/** How long an agent gets to exit after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 3000;

/**
 * Runs a program (absolute path) in the terminal, Gluon's UI already unmounted, and resolves
 * with its exit code. A `.cmd` shim's arguments must pass through cmd.exe as they are (throws).
 * With `events` (a UI launch without a PTY), resolves with the reason too: `back` from inside the
 * agent, while it runs, ends it (SIGTERM, then SIGKILL after `KILL_GRACE_MS`; Windows: `killTree`);
 * a waiting hook's `compact` gets "no" at once (nothing can ask), so the agent compacts.
 */
export async function inTerminal(argv: string[], env: Record<string, string | undefined>, cwd: string | undefined, opts: TerminalOptions & { events: string }): Promise<SessionEnd>;
export async function inTerminal(argv: string[], env: Record<string, string | undefined>, cwd?: string, opts?: TerminalOptions): Promise<number>;
export async function inTerminal(argv: string[], env: Record<string, string | undefined>, cwd?: string, opts: TerminalOptions = {}): Promise<number | SessionEnd> {
  assertShimArgs(argv);
  // Line mode for the child (raw mode may still be held after the last menu, BUG-133), and stop
  // reading the terminal: on Windows a read left pending after Ink's unmount takes the first line
  // typed into the child (BUG-100). The next Ink render reads again. Where Bun's reader outlives the pause (macOS) it is
  // ended for good, before the spawn, and the UI gets a fresh one when the child is gone (BUG-614: `freshStdin`).
  releaseRaw();
  const endedReader = endStdinReader();
  // The child owns the terminal now; Ctrl-C goes to it, not to us.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  let poll: ReturnType<typeof setInterval> | undefined;
  let kill: ReturnType<typeof setTimeout> | undefined;
  let reason: ReturnReason = "exit";
  let spawned: ReturnType<typeof Bun.spawn> | undefined;
  // One way to end the agent, for `back` and for a signal: SIGTERM (or the signal) now, SIGKILL after the grace (one timer); Windows: `killTree`.
  const end = (signal: "SIGTERM" | "SIGHUP") => {
    if (!spawned || spawned.exitCode !== null || spawned.signalCode) return;
    if (process.platform === "win32") killTree(spawned);
    else {
      spawned.kill(signal);
      kill ??= setTimeout(() => spawned && spawned.exitCode === null && !spawned.signalCode && spawned.kill("SIGKILL"), KILL_GRACE_MS);
    }
  };
  // A SIGTERM or SIGHUP sent to Gluon alone (`kill`, a test's timeout, a closed window) must end the agent too, or it outlives
  // us (BUG-572). One that comes before the spawn is passed on right after it. Gluon then ends with 128 + the signal's number,
  // whatever the agent's own code (a shell's report), on every path: `--launch`, a login, an install, a launch from the home view.
  let signalled: "SIGTERM" | "SIGHUP" | undefined;
  const stop = (signal: "SIGTERM" | "SIGHUP") => {
    signalled ??= signal;
    end(signal);
  };
  const onTerm = () => stop("SIGTERM");
  const onHup = () => stop("SIGHUP");
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  try {
    const child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], cwd, env });
    spawned = child;
    if (signalled) stop(signalled);
    const alive = () => child.exitCode === null && !child.signalCode;
    if (opts.events) {
      const dir = opts.events;
      const seen = new Set<string>();
      poll = setInterval(() => {
        // An event counts only while the agent runs.
        if (!alive()) return;
        for (const e of readEvents(dir, seen)) {
          // Display only (a status), or kept only by the pseudo-terminal path (a session id: a session
          // that ends here leaves the record); neither returns to Gluon.
          if (e.name === "status" || e.name === "session") continue;
          if (e.name === "compact") {
            if (e.id) writeAnswer(dir, e.id, false);
            continue;
          }
          clearInterval(poll);
          reason = "back";
          end("SIGTERM");
          return;
        }
      }, POLL_MS);
    }
    const exit = await child.exited;
    // Killed by a signal (Ctrl+C: SIGINT): 128 + its number, as a shell reports it.
    const code = signalled ? 128 + (osConstants.signals[signalled] ?? 0) : child.signalCode ? 128 + (osConstants.signals[child.signalCode as keyof typeof osConstants.signals] ?? 0) : exit;
    return opts.events ? { code, reason } : code;
  } finally {
    clearInterval(poll);
    clearTimeout(kill);
    process.off("SIGINT", ignore);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
    // Whatever happened (a spawn that threw too) the UI reads again from a fresh reader; a Gluon told to end has no use for one.
    if (endedReader && !signalled) await freshStdin();
    // Gluon was asked to end and the agent has: so does Gluon, with the code returned above. After the caller's own cleanup (it
    // runs first, in this tick's microtasks), so a UI launch doesn't return to the home view of a Gluon that was told to stop.
    if (signalled) setImmediate(() => process.exit(128 + (osConstants.signals[signalled!] ?? 0)));
  }
}

