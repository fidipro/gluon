/**
 * Asking each harness's official binary whether it is installed and signed in — the only way
 * Gluon checks a subscription. It never reads a credential file or the OS credential store:
 * `claude auth status --json`, `codex login status`, `agy models`, `grok models`, `opencode auth list` (the OpenCode plan),
 * `kimi provider list` (the Kimi Code plan).
 */
import { codexLoginStatus } from "./agent/codex.ts";
import { subscriptionEnv } from "./agent/subscription.ts";
import { assertShimArgs, binPath, killTree, missingReason, neutralCwd } from "./detect.ts";
import { HARNESS_INFO, tooOld, type Harness } from "./harnesses.ts";
import { maskSecrets } from "./secrets.ts";

export { onPath } from "./detect.ts";

/**
 * Runs a command in `neutralCwd()` and reads its output; `code` null: it timed out (killed). A timeout doesn't wait
 * for the output to close either: a child the command started may still hold the pipe.
 */
export async function run(argv: string[], timeoutMs: number, env: Record<string, string | undefined> = process.env): Promise<{ stdout: string; stderr: string; code: number | null }> {
  try {
    assertShimArgs(argv);
  } catch (e) {
    return { stdout: "", stderr: (e as Error).message, code: 1 };
  }
  const proc = Bun.spawn(argv, { cwd: neutralCwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      killTree(proc);
      resolve(null);
    }, timeoutMs);
  });
  const r = await Promise.race([Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]), timedOut]);
  clearTimeout(timer);
  if (!r) return { stdout: "", stderr: "", code: null };
  const [stdout, stderr, code] = r;
  return { stdout, stderr, code: proc.signalCode ? null : code };
}

/**
 * Whether a failure is one that passes — a timeout, the network, a rate limit, a server error — as
 * opposed to a definitive answer (signed out, key rejected, model not listed, access denied).
 */
export function isTransient(message: string): boolean {
  return /timed? ?out|did not answer in time|network|could not reach|fetch failed|ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|rate.?limit|throttl|too many requests|\b429\b|\b5\d\d\b|server error|internal ?server|aborted|overloaded|temporarily unavailable|service ?unavailable|not ready|try again|usage limit/i.test(message);
}

export const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
// Terminal colour codes some binaries print even to a pipe.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

export interface ClaudeStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  error?: string;
}

/** `claude auth status`, keeping only what Gluon shows (never the account's email or ids). */
export async function claudeStatus(): Promise<ClaudeStatus> {
  const claude = binPath("claude");
  if (!claude) return { installed: false, loggedIn: false };
  const r = await run([claude, "auth", "status", "--json"], 15_000, subscriptionEnv());
  try {
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return { installed: true, loggedIn: j.loggedIn === true, authMethod: s(j.authMethod), subscriptionType: s(j.subscriptionType) };
  } catch {
    const why = r.code === null ? "timed out" : firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
    return { installed: true, loggedIn: false, error: maskSecrets(`\`claude auth status\` failed: ${why}`) };
  }
}

/** "Claude Max plan", or how `claude` is signed in when it isn't a plan. */
export function planLabel(s: ClaudeStatus): string {
  if (s.subscriptionType) return `Claude ${s.subscriptionType.charAt(0).toUpperCase()}${s.subscriptionType.slice(1)} plan`;
  if (s.authMethod === "claude.ai") return "Claude plan";
  return s.authMethod ? `${s.authMethod} (not a Claude plan)` : "signed in";
}

export const onPlan = (s: ClaudeStatus) => s.authMethod === "claude.ai" || !!s.subscriptionType;

/** One tiny call through `claude -p` with none of the user's settings or tools. Null when it works. */
export async function claudePing(model: string): Promise<string | null> {
  const claude = binPath("claude");
  if (!claude) return missingReason("claude");
  const argv = [claude, "-p", "--model", model, "--output-format", "json", "--tools", "", "--setting-sources", "", "--no-session-persistence", "--system-prompt", "Reply with the single word: ok", "ping"];
  const r = await run(argv, 90_000, subscriptionEnv());
  if (r.code === null) return "`claude -p` timed out";
  try {
    const j = JSON.parse(r.stdout) as { is_error?: boolean; result?: string };
    if (!j.is_error && r.code === 0) return null;
    return maskSecrets(firstLine(j.result ?? "") || `claude -p exited ${r.code}`);
  } catch {
    return maskSecrets(firstLine(r.stderr) || firstLine(r.stdout) || `claude -p exited ${r.code}`);
  }
}

/** Model ids an official binary lists (`agy models`, `grok models`); signed out when it lists none. */
export async function listedModels(binary: "agy" | "grok"): Promise<{ loggedIn: boolean; models: string[]; account?: string; error?: string }> {
  const bin = binPath(binary);
  if (!bin) return { loggedIn: false, models: [], error: missingReason(binary) };
  const r = await run([bin, "models"], 60_000);
  const out = plain(`${r.stdout}\n${r.stderr}`);
  if (r.code === null) return { loggedIn: false, models: [], error: `\`${binary} models\` timed out` };
  const models =
    binary === "agy"
      ? [...out.matchAll(/^([a-z0-9][\w.-]*)\t/gm)].map((m) => m[1]!)
      : [...out.matchAll(/^\s*\*?\s*([a-z0-9][\w.-]*)(?:\s+\(default\))?\s*$/gm)].map((m) => m[1]!).filter((m) => /\d/.test(m));
  const account = binary === "grok" ? out.match(/logged in with ([^\s.]+(?:\.[a-z]+)?)/i)?.[1] : undefined;
  if (r.code === 0 && models.length) return { loggedIn: true, models, ...(account ? { account } : {}) };
  return { loggedIn: false, models: [], error: maskSecrets(firstLine(out.replace(/^Fetching available models\.\.\.\s*/i, "")) || `exit ${r.code}`) };
}

/** What `opencode auth list --format json` says: each integration with the connections it has (stored sign-ins, or only an environment variable). */
interface OpencodeIntegration {
  id: string;
  connections: { type?: string; status?: { status?: string; message?: string } }[];
}

/**
 * OpenCode's own list of sign-ins (`opencode auth list`, JSON; it never prints a secret). --standalone: a private server that
 * exits with the command, never OpenCode's background one. Null when it can't be read; `[]`: nothing signed in.
 */
async function opencodeAuthList(): Promise<OpencodeIntegration[] | null> {
  const opencode = binPath("opencode");
  if (!opencode) return null;
  const r = await run([opencode, "auth", "list", "--standalone", "--format", "json"], 30_000);
  try {
    const list = JSON.parse(r.stdout);
    return Array.isArray(list) ? list.filter((i): i is OpencodeIntegration => typeof i?.id === "string" && Array.isArray(i.connections)) : null;
  } catch {
    return null;
  }
}

/** The plan's integration in OpenCode (`opencode auth login opencode-go`). */
const OPENCODE_PLAN = "opencode-go";

/**
 * The OpenCode plan's sign-in: a stored sign-in (`type: "credential"`) of the `opencode-go` integration that doesn't need to be
 * redone. An environment variable (`type: "env"`, e.g. the user's own OPENCODE_API_KEY) is not the plan: it counts for nothing here.
 */
export async function opencodePlanStatus(): Promise<LoginStatus> {
  if (!binPath("opencode")) return { installed: false, loggedIn: false };
  const list = await opencodeAuthList();
  if (!list) return { installed: true, loggedIn: false, error: "`opencode auth list` gave no answer", transient: true };
  const stored = list.find((i) => i.id === OPENCODE_PLAN)?.connections.filter((c) => c.type === "credential") ?? [];
  if (!stored.length) return { installed: true, loggedIn: false };
  if (stored.every((c) => c.status?.status === "needs_auth")) return { installed: true, loggedIn: false, error: "OpenCode says the plan needs to be signed in to again" };
  return { installed: true, loggedIn: true, detail: "OpenCode Go plan" };
}

/** How many sign-ins OpenCode keeps itself besides the plan (`opencode auth list`); informational only. */
export async function opencodeCredentials(): Promise<number | null> {
  const list = await opencodeAuthList();
  return list ? list.filter((i) => i.id !== OPENCODE_PLAN).reduce((n, i) => n + i.connections.filter((c) => c.type === "credential").length, 0) : null;
}

/** The Kimi Code plan's sign-in, from the one thing its binary prints about it: `kimi provider list` (`<id>  type=<t>  models=<n>  source=oauth|inline|…`). */
const KIMI_PROVIDER_LINE = /^(\S+)\s+type=\S+\s+models=\d+\s+source=(\S+)/;

/**
 * The Kimi Code plan's sign-in. Kimi has no login-status command, so this asks `kimi provider list` (text form: `--json` dumps the raw
 * config, inline keys included; Gluon never reads Kimi's files): signed in when a provider's source is `oauth` or it is the managed
 * `managed:kimi-code` one (what `kimi login` adds); not signed in when it lists none (`No providers configured.`, seen on a signed-out
 * Kimi 2.1.1) or only keyed ones; any other answer says nothing about it (`transient`: the models stay offered, the user can launch and
 * sign in from Kimi's own `/login`). The `oauth` line is from Kimi's source and docs, not yet seen after a real login: one live check on a
 * signed-in machine. The command may create Kimi's own config.toml in its home on a first run: Kimi writing its own file.
 */
export function parseKimiProviders(out: string): { signedIn: boolean } | null {
  const text = plain(out);
  const providers = text.split("\n").flatMap((l) => {
    const m = KIMI_PROVIDER_LINE.exec(l.trim());
    return m ? [{ id: m[1]!, source: m[2]! }] : [];
  });
  // The managed provider counts whatever its source is called, but never as a key or a registry import (`inline`, `apiJson(…)`): BUG-430.
  if (providers.length) return { signedIn: providers.some((p) => p.source.startsWith("oauth") || (p.id === "managed:kimi-code" && !/^(inline|apiJson)/.test(p.source))) };
  return /^\s*No providers configured\.?\s*$/m.test(text) ? { signedIn: false } : null;
}

export async function kimiPlanStatus(): Promise<LoginStatus> {
  const kimi = binPath("kimi");
  if (!kimi) return { installed: false, loggedIn: false };
  const r = await run([kimi, "provider", "list"], 30_000, { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: "1" });
  if (r.code === null) return { installed: true, loggedIn: false, error: "`kimi provider list` timed out", transient: true };
  const parsed = r.code === 0 ? parseKimiProviders(r.stdout) : null;
  if (!parsed) return { installed: true, loggedIn: false, error: maskSecrets(`\`kimi provider list\` gave no answer Gluon can read${r.code === 0 ? "" : ` (exit ${r.code})`}`), transient: true };
  return parsed.signedIn ? { installed: true, loggedIn: true, detail: "Kimi Code plan" } : { installed: true, loggedIn: false };
}

/** Why the installed harness is too old to launch, or null (asks `--version` only when it has a minimum). */
export async function versionProblem(h: Harness): Promise<string | null> {
  return HARNESS_INFO[h].minMajor ? tooOld(h, await versionOf(h)) : null;
}

/** `<binary> --version`, first line, or null. */
export async function versionOf(harness: Harness): Promise<string | null> {
  const bin = binPath(HARNESS_INFO[harness].binary);
  if (!bin) return null;
  const r = await run([bin, "--version"], 15_000);
  const line = firstLine(plain(r.stdout) || plain(r.stderr));
  return r.code === 0 && line ? (line.match(/\d+\.\d+[\w.-]*/)?.[0] ?? line) : null;
}

export interface LoginStatus {
  installed: boolean;
  loggedIn: boolean;
  /** What the user is signed in with, when it's fine to show ("Claude Max plan", "ChatGPT"). */
  detail?: string;
  /** Signed in, but not with the subscription (e.g. codex with an API key, claude with a key). */
  wrongMethod?: string;
  /** Models the binary lists (agy, grok). */
  models?: string[];
  error?: string;
  /** The check itself failed (timed out, crashed, the network): it says nothing about the sign-in. */
  transient?: boolean;
}

/** A harness's subscription sign-in, asked of its own binary. */
export async function loginStatus(harness: Harness): Promise<LoginStatus> {
  const bin = HARNESS_INFO[harness].binary;
  if (!binPath(bin)) return { installed: false, loggedIn: false };
  switch (harness) {
    case "claude-code": {
      const s = await claudeStatus();
      // An error: `claude auth status` gave no answer (a signed-out claude answers loggedIn: false).
      if (!s.loggedIn) return { installed: true, loggedIn: false, ...(s.error ? { error: s.error, transient: true } : {}) };
      if (!onPlan(s)) return { installed: true, loggedIn: true, detail: planLabel(s), wrongMethod: `\`claude\` is signed in with ${s.authMethod ?? "something other than a plan"}, not a Claude plan` };
      return { installed: true, loggedIn: true, detail: planLabel(s) };
    }
    case "codex": {
      const s = await codexLoginStatus();
      if (!s.loggedIn) return { installed: s.installed, loggedIn: false, ...(s.error ? { error: s.error } : {}), ...(s.transient ? { transient: true } : {}) };
      if (s.method !== "chatgpt") return { installed: true, loggedIn: true, detail: "an API key", wrongMethod: "`codex` is signed in with an API key, not a ChatGPT plan" };
      return { installed: true, loggedIn: true, detail: "ChatGPT" };
    }
    case "antigravity":
    case "grok-build": {
      const s = await listedModels(bin as "agy" | "grok");
      const transient = !s.loggedIn && !!s.error && isTransient(s.error);
      return { installed: true, loggedIn: s.loggedIn, models: s.models, ...(s.loggedIn ? { detail: harness === "grok-build" ? `${s.account ?? "xAI"} account` : "Google account" } : {}), ...(s.error ? { error: s.error } : {}), ...(transient ? { transient } : {}) };
    }
    case "opencode":
      // Its only subscription is the plan provider (`PROVIDERS["opencode-go"].subscription`).
      return opencodePlanStatus();
    case "kimi-code":
      return kimiPlanStatus();
  }
}
