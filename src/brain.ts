/**
 * Gluon's own brain runs on the first step of `brain.order` (config) that is connected and
 * whose probe works; that step is saved as `brain.active`. Routes:
 *
 * - claude-plan: the user's Claude plan, only through their own `claude` (Agent SDK).
 * - chatgpt-plan: the user's ChatGPT plan, only through their own `codex app-server`.
 * - anthropic-api / openai-api: the user's key.
 * - bedrock: the user's AWS setup (Claude through the Anthropic Bedrock SDK, others through Converse).
 * - openrouter: the user's OpenRouter key (an aggregator; its documented base URL).
 *
 * No plan route ever gets a key, a token or a base URL.
 */
import { converseClient, probeConverse } from "./agent/bedrock-converse.ts";
import { anthropicBrain, awsCredentials, bedrockClaudeBrain } from "./agent/clients.ts";
import { chatgptPlanBrain, codexEnvWarnings, codexLevels, probeChatgptPlan, TOO_NEW, UNSUPPORTED } from "./agent/codex.ts";
import { sentEffort } from "./agent/effort.ts";
import { openaiClient, probeOpenAI } from "./agent/openai.ts";
import type { LoopBrain, ModelClient } from "./agent/session.ts";
import { subscriptionBrain, subscriptionEnvWarnings } from "./agent/subscription.ts";
import { activeValue, awsSetup, saveConfig, type BrainStep, type Config, type Effort, type Route } from "./config.ts";
import { missingReason } from "./detect.ts";
import { ANTHROPIC_API_BASE, OPENROUTER_OPENAI_BASE } from "./harnesses.ts";
import { keyTag, recordBrainReply } from "./openrouter-billed.ts";
import { REPO_URL } from "./repo.ts";
import { maskSecrets, secret } from "./secrets.ts";
import { claudePing, loginStatus } from "./status.ts";
import { errorDetail, fakeProbe, testProbesPath, type Probe } from "./verify.ts";

/** Honest attribution on OpenRouter requests (their documented app headers). */
export const OPENROUTER_HEADERS = { "HTTP-Referer": REPO_URL, "X-Title": "Gluon" };

/** "Sonnet 5.5" from us.anthropic.claude-sonnet-5-5, anthropic/claude-sonnet-5.5, claude-sonnet-5-5; "GPT-6 Sol" from gpt-6-sol; "gpt-oss-120b" from openai.gpt-oss-120b-1:0. */
export function modelName(id: string): string {
  const bare = id
    .replace(/^(us|eu|global|apac)\./, "")
    .replace(/^(anthropic|openai|meta|moonshotai|xai|z-ai|deepseek|qwen)[./]/, "")
    .replace(/-\d+:\d+$/, "")
    .replace(/(-\d{8})?(-v\d+)?(:\d+)?$/, "");
  const c = bare.match(/^claude-([a-z]+)-(\d+)[-.](\d+)/);
  if (c) return `${c[1]!.charAt(0).toUpperCase()}${c[1]!.slice(1)} ${c[2]}.${c[3]}`;
  const g = bare.match(/^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/);
  if (g) return `GPT-${g[1]} ${g[2]!.charAt(0).toUpperCase()}${g[2]!.slice(1)}`;
  return bare;
}

/** What the header, footer and doctor call a step. */
export function stepLabel(step: BrainStep): string {
  const name = modelName(step.model);
  switch (step.route) {
    case "claude-plan":
      return `${name} on your Claude plan (personal)`;
    case "chatgpt-plan":
      return `${name} on your ChatGPT plan (personal)`;
    case "anthropic-api":
      return `${name} · Anthropic API`;
    case "openai-api":
      return `${name} · OpenAI API`;
    case "bedrock":
      return `${name} on Bedrock`;
    case "openrouter":
      return `${name} via OpenRouter`;
  }
}

/**
 * The brain's requests on an OpenRouter key are told to `brainSpend` and to the other Gluon processes' meters (`recordBrainReply`): their exact cost is the brain's, not any session's, and a session's billed figure
 * (`src/openrouter-billed.ts`) takes it off the key's usage (QA-cost-04). Probes spend too.
 */
const orSpend = (key: string) => {
  const tag = keyTag(key);
  return ({ end, usd }: { end: number; usd: number | undefined }) => recordBrainReply(tag, end, usd);
};

/** The key an API brain route reads (from Gluon's secret store). */
export const KEY: Partial<Record<Route, string>> = { "anthropic-api": "ANTHROPIC_API_KEY", "openai-api": "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };

/** Whether Bedrock is set up: an AWS profile or region in the config, or a harness connected through Bedrock. */
export function bedrockConnected(config: Config): boolean {
  if (Object.values(config.bedrock).some(Boolean)) return true;
  return Object.values(config.connections).some((c) => c?.provider === "bedrock");
}

/** Why a step can't be used without trying it (not connected), or null. */
export function notConnected(config: Config, step: BrainStep): string | null {
  switch (step.route) {
    case "claude-plan":
      return config.connections["claude-code"]?.auth === "subscription" ? null : "not connected (Claude Code isn't on your Claude plan)";
    case "chatgpt-plan":
      return config.connections.codex?.auth === "subscription" ? null : "not connected (Codex isn't on your ChatGPT plan)";
    case "bedrock":
      return bedrockConnected(config) ? null : "not connected (no AWS setup for Bedrock)";
    default:
      return secret(KEY[step.route]!) ? null : `not connected (${KEY[step.route]} isn't set)`;
  }
}

const isClaude = (model: string) => /(^|\.)anthropic\.|^claude-/.test(model);

/** One tiny call on this step (≤16 output tokens; plan routes through the official binaries). */
export async function probeStep(config: Config, step: BrainStep, cwd: string): Promise<Probe> {
  const why = notConnected(config, step);
  if (why) return { ok: false, error: why };
  const { model } = step;
  try {
    switch (step.route) {
      case "claude-plan": {
        const s = await loginStatus("claude-code");
        if (!s.installed) return { ok: false, error: missingReason("claude") };
        if (!s.loggedIn) return { ok: false, error: s.error ?? "not logged in to Claude Code (`claude auth status`)" };
        if (s.wrongMethod) return { ok: false, error: s.wrongMethod };
        const error = await claudePing(model);
        return error ? { ok: false, error } : { ok: true };
      }
      case "chatgpt-plan": {
        const s = await loginStatus("codex");
        if (!s.installed) return { ok: false, error: missingReason("codex") };
        if (!s.loggedIn) return { ok: false, error: s.transient && s.error ? s.error : "not connected: `codex login status` says you're not signed in" };
        if (s.wrongMethod) return { ok: false, error: s.wrongMethod };
        const r = await probeChatgptPlan(model, cwd);
        return r.ok ? { ok: true, ...(r.warnings?.length ? { warnings: r.warnings } : {}) } : { ok: false, error: r.error };
      }
      case "anthropic-api":
        return fakeProbe(step.route, model) ?? (await anthropicProbe(secret("ANTHROPIC_API_KEY")!, model));
      case "openai-api":
        return fakeProbe(step.route, model) ?? (await probeOpenAI({ apiKey: secret("OPENAI_API_KEY")!, model, mode: "responses" }));
      case "openrouter":
        return fakeProbe(step.route, model) ?? (await probeOpenAI({ apiKey: secret("OPENROUTER_API_KEY")!, model, mode: "chat", baseURL: OPENROUTER_OPENAI_BASE, headers: OPENROUTER_HEADERS, onSpend: orSpend(secret("OPENROUTER_API_KEY")!) }));
      case "bedrock":
        return fakeProbe(step.route, model) ?? (await probeConverse({ model, ...awsSetup(config) }));
    }
  } catch (e) {
    // SDK errors read "400 {json}": keep the status and the provider's own message.
    const message = (e as Error).message.split("\n")[0] ?? String(e);
    const m = message.match(/^(\d{3}) (\{.*)$/);
    return { ok: false, error: maskSecrets(m ? `${errorDetail(m[2]!) || "error"} (${m[1]})` : message) };
  }
}

async function anthropicProbe(apiKey: string, model: string): Promise<Probe> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const res = await new Anthropic({ apiKey, authToken: null, baseURL: ANTHROPIC_API_BASE, timeout: 30_000, maxRetries: 1 }).messages.create({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
  return { ok: true, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
}

export interface StepResult {
  index: number;
  step: BrainStep;
  /** null: not tried (a step above works). */
  result: Probe | null;
}

/**
 * Tries the steps in order until one works; `all`: probe every connected step (doctor). Saves the
 * first working step as `brain.active` (or clears it). `onStep` reports each result as it comes.
 */
export async function chooseBrain(config: Config, cwd: string, { all = false, onStep }: { all?: boolean; onStep?: (r: StepResult) => void } = {}): Promise<{ active: number | null; steps: StepResult[] }> {
  let active: number | null = null;
  const steps: StepResult[] = [];
  for (const [index, step] of config.brain.order.entries()) {
    let result: Probe | null = null;
    const why = notConnected(config, step);
    if (why) result = { ok: false, error: why };
    else if (active === null || all) result = await probeStep(config, step, cwd);
    if (result?.ok && active === null) active = index;
    const r = { index, step, result };
    steps.push(r);
    onStep?.(r);
  }
  if (config.brain.active !== active) {
    config.brain.active = active;
    saveConfig([[["brain", "active"], activeValue(config, active)]]);
  }
  return { active, steps };
}

/** The step in use: `brain.active` when it is still connected. */
export function activeStep(config: Config): BrainStep | null {
  const i = config.brain.active;
  if (i === null) return null;
  const step = config.brain.order[i];
  return step && !notConnected(config, step) ? step : null;
}

/**
 * The brain client for a step. Nothing is called until the first message. Every call carries the
 * step's effort as `sentEffort` gives it (what the header shows); the ChatGPT plan clamps it to
 * Codex's catalog when it starts and tells `onEffort`.
 */
export function brainFor(config: Config, step: BrainStep, cwd: string, onEffort?: (effort: string | null) => void): ModelClient | LoopBrain {
  const { model } = step;
  const effort = sentEffort(step);
  switch (step.route) {
    case "claude-plan":
      return subscriptionBrain(model, cwd, undefined, effort as Effort | null);
    case "chatgpt-plan":
      return chatgptPlanBrain({ model, cwd, ...(step.effort ? { effort: step.effort } : {}), ...(onEffort ? { onEffort } : {}) });
    case "anthropic-api":
      return anthropicBrain(secret("ANTHROPIC_API_KEY")!, model, effort as Effort | null);
    case "openai-api":
      return openaiClient({ apiKey: secret("OPENAI_API_KEY")!, model, mode: "responses", effort });
    case "openrouter":
      return openaiClient({ apiKey: secret("OPENROUTER_API_KEY")!, model, mode: "chat", baseURL: OPENROUTER_OPENAI_BASE, headers: OPENROUTER_HEADERS, effort, onSpend: orSpend(secret("OPENROUTER_API_KEY")!) });
    case "bedrock":
      return isClaude(model) ? bedrockClaudeBrain(config, model, effort as Effort | null) : converseClient({ model, ...awsSetup(config), effort });
  }
}

/** The effort the header shows for a step: what its client sends (`sentEffort`; the ChatGPT plan with Codex's catalog when read). */
export function shownEffort(step: BrainStep): string | null {
  return sentEffort(step, step.route === "chatgpt-plan" ? codexLevels()[step.model] : undefined);
}

/** A quick check without a model call (sign-in, credentials), for startup. Null when fine. */
export async function quickCheck(config: Config, step: BrainStep): Promise<string | null> {
  const why = notConnected(config, step);
  if (why) return why;
  try {
    if (step.route === "claude-plan" || step.route === "chatgpt-plan") {
      const s = await loginStatus(step.route === "claude-plan" ? "claude-code" : "codex");
      if (!s.installed) return missingReason(step.route === "claude-plan" ? "claude" : "codex");
      if (!s.loggedIn) return s.error ?? "not signed in";
      return s.wrongMethod ?? null;
    }
    if (step.route === "bedrock" && !testProbesPath()) await awsCredentials(config)();
    return null;
  } catch (e) {
    return maskSecrets((e as Error).message.split("\n")[0] ?? String(e));
  }
}

/** Notes about the user's environment for a route (told, never stripped). */
export function envWarnings(step: BrainStep | null): string[] {
  if (step?.route === "claude-plan") return subscriptionEnvWarnings();
  if (step?.route === "chatgpt-plan") return codexEnvWarnings();
  const out: string[] = [];
  const sent = (name: string, to: string) => out.push(`${name} is set in your environment, so the brain's requests to ${to} carry those headers. Unset it to send none.`);
  if (step?.route === "anthropic-api" && process.env.ANTHROPIC_CUSTOM_HEADERS) sent("ANTHROPIC_CUSTOM_HEADERS", "Anthropic");
  if (step?.route === "openai-api" && process.env.OPENAI_CUSTOM_HEADERS) sent("OPENAI_CUSTOM_HEADERS", "OpenAI");
  if (step?.route === "bedrock") {
    if (isClaude(step.model) && process.env.ANTHROPIC_CUSTOM_HEADERS) sent("ANTHROPIC_CUSTOM_HEADERS", "Bedrock");
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) out.push("AWS_BEARER_TOKEN_BEDROCK is set in your environment, so Bedrock calls use that API key instead of your AWS profile or keys. Unset it to use your AWS setup.");
  }
  return out;
}

/** Words that say the model itself can't be used, in the providers' own raw errors and in Gluon's descriptions of them. */
const MODEL_UNAVAILABLE =
  /model.{0,80}(not (found|available|supported)|unavailable|does not exist|isn't available|no access)|is not available for this account|(don't|do not|does not) have access to (the |this )?model|not have access|model identifier is invalid|invalid model|not a valid model|unknown model|access ?denied|no endpoints found|model_not_found/i;
/** A prompt over the model's input limit (Bedrock's ValidationException words it with "model" in it). */
const PROMPT_TOO_LONG = /too long|too many (input )?tokens|exceeds? (the )?(maximum|max|context)/i;
/** Errors that pass (rate limits, outages): the model is fine, try again later. */
const TRANSIENT_NAMES = new Set(["ThrottlingException", "ServiceUnavailableException", "ModelNotReadyException", "InternalServerException", "ServiceQuotaExceededException", "ModelStreamErrorException"]);

/**
 * Whether an error means the model itself can't be used (so the order moves on). Takes the raw
 * error a brain threw (an SDK error object: AWS exception names, HTTP status, OpenAI's
 * `model_not_found`) or its text; runtime errors reach this raw, not as the probes describe them.
 */
export function modelUnavailable(e: unknown): boolean {
  const err = (typeof e === "object" && e !== null ? e : {}) as { name?: unknown; status?: unknown; code?: unknown; error?: { code?: unknown } | null; message?: unknown };
  const message = typeof e === "string" ? e : String(err.message ?? e ?? "");
  const name = typeof err.name === "string" ? err.name : "";
  const status = typeof err.status === "number" ? err.status : null;
  if (TRANSIENT_NAMES.has(name) || status === 429 || (status !== null && status >= 500)) return false;
  if (name === "AccessDeniedException" || name === "ResourceNotFoundException") return true;
  // A too-long prompt is the prompt's fault, not the model's: the next step would be refused the same way (QA-brain-08).
  if (name === "ValidationException") return /model/i.test(message) && !PROMPT_TOO_LONG.test(message);
  if (err.code === "model_not_found" || err.error?.code === "model_not_found") return true;
  if ((status === 403 || status === 404) && /model|endpoint/i.test(message)) return true;
  if (MODEL_UNAVAILABLE.test(message)) return true;
  // A bare 404 (a proxy's "404 Not Found") says nothing about the model.
  return /\b404\b/.test(message) && /\bmodel\b/i.test(message);
}

/** Hints appended to a brain error so the developer knows what to do next. */
export function brainErrorHint(step: BrainStep | null, message: string, config: Config): string {
  if (!step) return "Run `gluon doctor` to set up the intake agent.";
  switch (step.route) {
    case "claude-plan":
      if (/not installed|Windows install of/i.test(message)) return "Install Claude Code (`claude`), or run `gluon brain` to see the other steps.";
      if (/log ?in|logged|auth|credential|token|unauthori[sz]ed|401|403/i.test(message)) return "Sign in with `claude auth login`, then run `gluon doctor`.";
      if (/limit|quota|429|overloaded/i.test(message)) return "Your plan's usage limit may be reached; try later.";
      break;
    case "chatgpt-plan":
      // A refusal of a codex Gluon hasn't checked (`UNSUPPORTED` in codex.ts): sending again is refused again; its own text says what to do.
      if (message.includes(UNSUPPORTED) || message.includes(TOO_NEW)) return "`gluon doctor` checks every step of the intake agent order (`brain.order`).";
      if (/log ?in|logged|auth|signed|401/i.test(message)) return "Sign in with `codex login` (ChatGPT), then run `gluon doctor`.";
      if (/limit|quota|429/i.test(message)) return "Your plan's usage limit may be reached; try later.";
      break;
    case "bedrock":
      if (/credential|token|expired|security|signature|unauthori[sz]ed|forbidden|access ?denied/i.test(message)) {
        const { profile } = awsSetup(config);
        return `Check the AWS login${profile ? `: \`aws sso login --profile ${profile}\`` : ""}, then \`gluon doctor\`.`;
      }
      break;
    default:
      if (/credential|unauthori[sz]ed|forbidden|api[_ ]key|authentication|rejected|401/i.test(message)) return `Check ${KEY[step.route]} (\`gluon setup\` saves one), then run \`gluon doctor\`.`;
  }
  if (modelUnavailable(message)) return "`gluon doctor` checks every step of the intake agent order (`brain.order`).";
  return "Send your message again to retry; `gluon doctor` checks the intake agent.";
}
