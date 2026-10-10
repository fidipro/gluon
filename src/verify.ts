/**
 * Probing: does each connection really reach its models? Subscriptions are asked through the
 * harness's own binary (`claude -p` per model, `codex app-server`, `agy models`, `grok models`,
 * `opencode auth list` for the OpenCode plan, whose models come from its public listing; `kimi provider list` for the Kimi Code plan, whose
 * models are taken as served once signed in);
 * API keys through the provider: a free model listing where the provider has one (and, where that
 * listing is public, a key check: OpenRouter's key endpoint), else (Bedrock) a
 * tiny call of at most 16 output tokens. Results go to the config's `verified` and `checked`.
 *
 * GLUON_TEST_PROBES (tests only): a JSON file { "<provider>/<model id>": true | "error" } that
 * answers API probes instead of the network, so the regression suite stays offline and free. A
 * model not listed answers ok. Subscriptions are faked by fake binaries on PATH instead. Release
 * builds (`scripts/build.ts` "release", `scripts/pack.ts` "npm": anything but "test") compile the seam out.
 */
import { readFileSync } from "node:fs";
import { clip, probeConverse } from "./agent/bedrock-converse.ts";
import { probeChatgptPlan } from "./agent/codex.ts";
import { awsSetup, connsOf, saveConfig, today, type Config } from "./config.ts";
import { checkedKey, HARNESS_INFO, idOn, PROVIDERS, subscriptionOf, verifiedKey, type Conn, type Harness, type ModelEntry, type ProviderId } from "./harnesses.ts";
import { maskSecrets, secret } from "./secrets.ts";
import { claudePing, isTransient, loginStatus, type LoginStatus } from "./status.ts";

/** A failed probe is `transient` when it says nothing about access (a timeout, the network, a rate limit, a server error). */
/** A check of a model or step; `warnings`: it works, but with something the user should know (e.g. what Gluon hasn't checked in this codex). */
export type Probe = { ok: true; usage?: { input: number; output: number }; warnings?: string[] } | { ok: false; error: string; transient?: boolean };

export interface ModelProbe {
  entry: ModelEntry;
  id: string;
  result: Probe;
}

export interface ConnectionProbe {
  harness: Harness;
  conn: Conn;
  /** Why nothing could be probed (not installed, signed out, no key), or null. */
  problem: string | null;
  /** The problem says nothing about access (a timeout, the network, a server error): the last results stand. */
  transient?: boolean;
  models: ModelProbe[];
}

/** The test seam's answers file, or undefined (always, in a release build). */
export const testProbesPath = (): string | undefined => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? undefined : process.env.GLUON_TEST_PROBES);
// The build flag written out here, not detect.ts's BUILD, so the bundler drops the seam's name from release builds.
declare const GLUON_BUILD: string | undefined;

/** The fake answers for API probes, when the test seam is on. */
function testProbes(): Record<string, true | string> | null {
  const path = testProbesPath();
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** The test seam's answer for "<scope>/<model>", or null when the seam is off. */
export function fakeProbe(scope: string, model: string): Probe | null {
  const fake = testProbes();
  if (!fake) return null;
  const v = fake[`${scope}/${model}`] ?? fake[`${scope}/*`] ?? true;
  return v === true ? { ok: true, usage: { input: 8, output: 1 } } : { ok: false, error: String(v), ...(isTransient(String(v)) ? { transient: true } : {}) };
}

/** The message in a provider's JSON error body ({"error": {"message"}} or {"message"}), shortened. */
export function errorDetail(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    return m ? clip(m.split(/(?<=\.)\s+(?=[A-Z])/)[0]!, 200) : "";
  } catch {
    return clip(body.trim().split("\n")[0]!, 200);
  }
}

/** Headers for a provider's model listing. */
function listHeaders(p: ProviderId, key: string): Record<string, string> {
  if (p === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (p === "gemini") return { "x-goog-api-key": key };
  return { authorization: `Bearer ${key}` };
}

/** An HTTP failure, carrying its status (429 and 5xx are transient). */
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const rejected = (status: number, detail = "") => httpError(status, `${status === 401 || status === 403 ? `the API key was rejected (${status})` : status === 402 ? "the key has no credit left (402)" : `the key check failed (${status})`}${detail ? `: ${detail}` : ""}`);

/** OpenRouter's model listing is public, so it proves nothing about the key: its key endpoint (free) does. */
async function checkKey(p: ProviderId, key: string, signal: AbortSignal): Promise<void> {
  if (p !== "openrouter") return;
  const r = await fetch("https://openrouter.ai/api/v1/key", { headers: listHeaders(p, key), signal });
  if (!r.ok) throw rejected(r.status);
}

/** The model ids a key can use, from the provider's own listing (free). */
async function listModels(p: ProviderId, key: string, signal: AbortSignal): Promise<Set<string>> {
  const url = PROVIDERS[p].models!;
  const r = await fetch(url, { headers: key ? listHeaders(p, key) : {}, signal });
  if (!r.ok) {
    const detail = errorDetail(await r.text().catch(() => ""));
    throw httpError(r.status, `${r.status === 401 || r.status === 403 ? `the API key was rejected (${r.status})` : `listing models failed (${r.status})`}${detail ? `: ${detail}` : ""}`);
  }
  const j = (await r.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
  const ids = new Set<string>();
  for (const m of j.data ?? []) if (m.id) ids.add(m.id);
  for (const m of j.models ?? []) if (m.name) ids.add(m.name.replace(/^models\//, ""));
  return ids;
}

/**
 * Whether a listing offers this model: by its id, or (Anthropic) by a dated snapshot of an alias
 * such as `claude-haiku-4-5` → `claude-haiku-4-5-20251001`, which is all the listing names.
 */
export function isListed(listed: Set<string>, id: string): boolean {
  if (listed.has(id)) return true;
  const dated = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}$`);
  for (const l of listed) if (dated.test(l)) return true;
  return false;
}

/** Probes a key connection's models. */
async function probeKey(config: Config, p: ProviderId, entries: [ModelEntry, string][], signal: AbortSignal): Promise<{ problem: string | null; transient?: boolean; models: ModelProbe[] }> {
  const info = PROVIDERS[p];
  if (p === "bedrock") {
    const models: ModelProbe[] = [];
    for (const [entry, id] of entries) {
      const result: Probe = fakeProbe("bedrock", id) ?? (await probeConverse({ model: id, ...awsSetup(config), signal }));
      if (!result.ok && isTransient(result.error)) result.transient = true;
      models.push({ entry, id, result });
    }
    return { problem: null, models };
  }
  const key = secret(info.env!);
  if (!key) return { problem: `${info.env} isn't set`, models: [] };
  if (testProbes()) return { problem: null, models: entries.map(([entry, id]) => ({ entry, id, result: fakeProbe(p, id)! })) };
  try {
    const listed = await listModels(p, key, signal);
    await checkKey(p, key, signal);
    return {
      problem: null,
      models: entries.map(([entry, id]) => ({ entry, id, result: isListed(listed, id) ? { ok: true } : { ok: false, error: `${id} isn't listed for this ${info.label} key` } })),
    };
  } catch (e) {
    const err = e as Error & { status?: number };
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    const message = timedOut ? "timed out" : err.message;
    // No HTTP answer (the network), a rate limit or a server error: says nothing about the key.
    const transient = timedOut || err.status === undefined || err.status === 429 || err.status >= 500;
    return { problem: maskSecrets(`${info.label}: ${message}`.split(key).join("••••")), ...(transient ? { transient } : {}), models: [] };
  }
}

/** Probes a subscription's models through the harness's own binary. `status`: its sign-in, when already asked. */
async function probePlan(harness: Harness, entries: [ModelEntry, string][], cwd: string, known?: LoginStatus): Promise<{ problem: string | null; transient?: boolean; models: ModelProbe[] }> {
  const status = known ?? (await loginStatus(harness));
  if (!status.installed) return { problem: `${HARNESS_INFO[harness].binary} is not installed`, models: [] };
  // The status check itself failed (timed out, crashed): that isn't a sign-out.
  if (status.transient) return { problem: `couldn't check the sign-in${status.error ? ` (${status.error})` : ""}`, transient: true, models: [] };
  if (!status.loggedIn) return { problem: status.error ? `not signed in (${status.error})` : "not signed in", models: [] };
  if (status.wrongMethod) return { problem: status.wrongMethod, models: [] };
  const models: ModelProbe[] = [];
  for (const [entry, id] of entries) {
    let result: Probe;
    if (harness === "claude-code") {
      const error = await claudePing(id);
      result = error ? { ok: false, error, ...(isTransient(error) ? { transient: true } : {}) } : { ok: true };
    } else if (harness === "codex") {
      const r = await probeChatgptPlan(id, cwd);
      result = r.ok ? { ok: true, ...(r.warnings?.length ? { warnings: r.warnings } : {}) } : { ok: false, error: r.error, ...(isTransient(r.error) ? { transient: true } : {}) };
    } else if (harness === "kimi-code") {
      // Kimi lists no models for the plan and a call would spend the plan's quota: the sign-in is all Gluon asks (`kimiPlanStatus`).
      result = { ok: true };
    } else {
      // agy lists ids with the effort in them (gemini-3.8-flash-high).
      const listed = (status.models ?? []).some((m) => offersModel(m, id));
      result = listed ? { ok: true } : { ok: false, error: `${id} isn't offered to this account (\`${HARNESS_INFO[harness].binary} models\`)` };
    }
    models.push({ entry, id, result });
  }
  return { problem: null, models };
}

/**
 * The OpenCode plan: signed in by OpenCode's own `auth list` (the harness's `loginStatus`), served models from the plan's public
 * listing (no key: Gluon never has the plan's). `status`: its sign-in, when already asked.
 */
async function probePlanProvider(harness: Harness, conn: ProviderId, entries: [ModelEntry, string][], signal: AbortSignal, known?: LoginStatus): Promise<{ problem: string | null; transient?: boolean; models: ModelProbe[] }> {
  const status = known ?? (await loginStatus(harness));
  if (!status.installed) return { problem: `${HARNESS_INFO[harness].binary} is not installed`, models: [] };
  if (status.transient) return { problem: `couldn't check the sign-in${status.error ? ` (${status.error})` : ""}`, transient: true, models: [] };
  if (!status.loggedIn) return { problem: status.error ? `not signed in (${status.error})` : "not signed in", models: [] };
  const fake = testProbes();
  if (fake) return { problem: null, models: entries.map(([entry, id]) => ({ entry, id, result: fakeProbe(conn, id)! })) };
  try {
    const listed = await listModels(conn, "", signal);
    return { problem: null, models: entries.map(([entry, id]) => ({ entry, id, result: listed.has(id) ? { ok: true } : { ok: false, error: `${id} isn't served by the ${PROVIDERS[conn].label}` } })) };
  } catch (e) {
    const err = e as Error & { status?: number };
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    const transient = timedOut || err.status === undefined || err.status === 429 || err.status >= 500;
    return { problem: maskSecrets(`${PROVIDERS[conn].label}: ${timedOut ? "timed out" : err.message}`), ...(transient ? { transient } : {}), models: [] };
  }
}

/**
 * Whether a model id agy lists is this model: the id itself, or the id with an effort appended
 * (`gemini-3.8-flash-high`) — not another model that shares its start (`gemini-3.8-flash-lite-high`).
 */
export function offersModel(listed: string, id: string): boolean {
  return listed === id || (listed.startsWith(`${id}-`) && /^(minimal|low|medium|high|xhigh|max)$/.test(listed.slice(id.length + 1)));
}

/** Probes every model of one connection of one harness. `status`: the harness's sign-in, when the caller already asked (doctor). */
export async function probeConnection(config: Config, harness: Harness, conn: Conn, { cwd = process.cwd(), signal = AbortSignal.timeout(120_000), status }: { cwd?: string; signal?: AbortSignal; status?: LoginStatus } = {}): Promise<ConnectionProbe> {
  const entries = config.models[harness].flatMap((m) => {
    const id = idOn(m, conn);
    return id ? [[m, id] as [ModelEntry, string]] : [];
  });
  const r = conn === "plan" ? await probePlan(harness, entries, cwd, status) : subscriptionOf(harness, conn) ? await probePlanProvider(harness, conn, entries, signal, status) : await probeKey(config, conn, entries, signal);
  const out: ConnectionProbe = { harness, conn, ...r };
  if (out.problem && out.transient) out.problem += "; the last check's results are kept";
  return out;
}

/**
 * Records probe results: verified models get today's date, the others lose theirs and are marked `unreached` (an id never probed is in neither: it stays offered); the connection
 * is marked checked. A connection that couldn't be probed (signed out, no key) reaches nothing.
 * Only definitive answers count: a transient failure (a timeout, the network, a rate limit, a
 * server error) leaves the last results as they were.
 */
export function recordProbes(config: Config, probes: ConnectionProbe[]): void {
  const date = today();
  const edits: [string[], unknown][] = [];
  for (const p of probes) {
    if (p.problem && p.transient) continue;
    const models: { id: string; result: Probe }[] = p.problem
      ? config.models[p.harness].flatMap((m) => {
          const id = idOn(m, p.conn);
          return id ? [{ id, result: { ok: false as const, error: p.problem! } }] : [];
        })
      : p.models;
    const definitive = models.filter((m) => m.result.ok || !m.result.transient);
    for (const m of definitive) {
      const k = verifiedKey(p.harness, p.conn, m.id);
      if (m.result.ok) {
        config.verified[k] = date;
        delete config.unreached[k];
      } else {
        delete config.verified[k];
        config.unreached[k] = date;
      }
      edits.push([["verified", k], m.result.ok ? date : undefined], [["unreached", k], m.result.ok ? undefined : date]);
    }
    if (!definitive.length && models.length) continue;
    config.checked[checkedKey(p.harness, p.conn)] = date;
    edits.push([["checked", checkedKey(p.harness, p.conn)], date]);
  }
  if (edits.length) saveConfig(edits);
}

/** Probes every connection of the given (connected, installed) harnesses, in parallel per harness. */
export async function probeHarnesses(config: Config, harnesses: Harness[], opts: { cwd?: string; onProbe?: (p: ConnectionProbe) => void } = {}): Promise<ConnectionProbe[]> {
  const all = await Promise.all(
    harnesses.map(async (h) => {
      const out: ConnectionProbe[] = [];
      for (const conn of connsOf(config, h)) {
        const p = await probeConnection(config, h, conn, { cwd: opts.cwd });
        opts.onProbe?.(p);
        out.push(p);
      }
      return out;
    }),
  );
  const flat = all.flat();
  recordProbes(config, flat);
  return flat;
}

const short = (id: string, h: Harness) => (h === "claude-code" ? id.replace(/^claude-/, "") : id.replace(/^gpt-6[.\d]*-/, ""));

/** `✓ Claude Code · plan · haiku sonnet opus fable`, `✗ Codex · Amazon Bedrock · gpt-6-astra unavailable (using luna, sol)`. */
export function summaryLine(p: ConnectionProbe): string {
  const info = HARNESS_INFO[p.harness];
  const where = p.conn === "plan" ? "plan" : PROVIDERS[p.conn].label;
  if (p.problem) return `✗ ${info.label} · ${where} · ${p.problem}`;
  const using = p.models.filter((m) => m.result.ok).map((m) => short(m.entry.id, p.harness));
  const bad = p.models.filter((m) => !m.result.ok);
  if (!bad.length) return `✓ ${info.label} · ${where} · ${using.join(" ")}`;
  return `✗ ${info.label} · ${where} · ${bad.map((m) => m.entry.id).join(", ")} unavailable (${using.length ? `using ${using.join(", ")}` : "nothing reachable"})`;
}
