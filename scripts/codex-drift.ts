#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun scripts/codex-drift.ts --binary <codex>`: whether a codex release gives the ChatGPT-plan intake
 * agent (`src/agent/codex.ts`) anything of its own. Above all, the tools in the model request: the
 * brain runs as it does for a user (`chatgptPlanBrain`: the same features turned off, catalog, thread)
 * and sends one message to a model provider on 127.0.0.1, which records each request and answers with
 * a short reply; every tool in a request must be one of Gluon's. Also: a catalog Gluon can't read, a
 * thread-item type outside BRAIN_ITEMS and FOREIGN_ITEMS (a turn that has one is stopped). What the
 * brain runs with anyway is noted, not drift: new features (turned off unchecked), features codex
 * keeps on and catalog fields Gluon hasn't checked (the tool check says whether they give tools).
 * codex-watch.yml runs it on every new codex release. Prints a Markdown report; exits 0 (nothing to
 * do), 1 (drift: fix codex.ts) or 2 (couldn't check). The tool check is tried twice before it counts.
 *
 * Only the given binary runs, never one from PATH, in a temp directory with an empty CODEX_HOME and a
 * bare environment: it sees codex's defaults, never a user's config or sign-in, and its model traffic
 * goes to the local provider only (no key, no sign-in; CI only — the brain itself never gets a base URL).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAIN_ITEMS, catalogWithoutTools, chatgptPlanBrain, uncheckedCatalogFields, CODEX_FEATURES_OFF, featuresToDisable, FOREIGN_ITEMS, newFeatures, uncheckedFeatures, type SpawnCodex } from "../src/agent/codex.ts";
import { TOOLS } from "../src/agent/tools.ts";
import { DEFAULT_ORDER } from "../src/config.ts";

/** One model's turn: the tools its requests carried that aren't Gluon's, Gluon's it lacked, or why it failed. */
export type ToolCheck = { model: string; extra: string[]; missing: string[]; error: string | null };

export type Drift = {
  version: string;
  /** Still on after every feature outside CODEX_FEATURES_KEPT was turned off, and not kept on purpose (noted, not drift). */
  features: string[];
  /** Catalog fields set on a model that Gluon hasn't checked, passed through to codex (noted, not drift). */
  catalogFields: string[];
  /** On in this codex, in neither of Gluon's lists: turned off unchecked (noted, not drift). */
  newOff: string[];
  /** What the model was sent, per model. */
  tools: ToolCheck[];
  /** Why Gluon can't read the catalog, if it can't. */
  catalog: string | null;
  /** Item types neither allowed nor known to be foreign (the brain already refuses them). */
  items: string[];
  /** Names of CODEX_FEATURES_OFF this codex doesn't list (harmless: only known names are passed). */
  gone: string[];
};

/** The thread-item types in `generate-json-schema`'s bundle: each `ThreadItem` variant's `type`. */
export function itemTypes(schema: unknown): string[] {
  const find = (o: unknown): any => {
    if (!o || typeof o !== "object") return null;
    if ("ThreadItem" in o) return (o as Record<string, unknown>).ThreadItem;
    for (const v of Object.values(o)) {
      const r = find(v);
      if (r) return r;
    }
    return null;
  };
  const variants = find(schema)?.oneOf ?? find(schema)?.anyOf;
  if (!Array.isArray(variants)) throw new Error("the app-server schema has no ThreadItem variants");
  return variants.map((v: any) => v?.properties?.type?.enum?.[0]).filter((t: unknown): t is string => typeof t === "string");
}

/** Every tool in a Responses request body: each entry of any `tools` list (`namespace` entries opened), as `type:name`. */
export function requestTools(body: unknown): string[] {
  const out: string[] = [];
  const walk = (o: unknown, tool: boolean) => {
    if (Array.isArray(o)) return o.forEach((x) => walk(x, tool));
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    if (tool && r.type !== "namespace") out.push(`${String(r.type)}:${String(r.name ?? "")}`);
    for (const [k, v] of Object.entries(r)) walk(v, k === "tools");
  };
  walk(body, false);
  return out;
}

const GLUON = TOOLS.map((t) => `function:${t.name}`);

/** A model's check from the request bodies its turn sent (none: the turn sent nothing, an error). */
export function checkTools(model: string, bodies: unknown[], error: string | null): ToolCheck {
  const seen = new Set(bodies.flatMap(requestTools));
  return {
    model,
    extra: [...seen].filter((t) => !GLUON.includes(t)),
    missing: bodies.length ? GLUON.filter((t) => !seen.has(t)) : [],
    error: error ?? (bodies.length ? null : "codex sent no model request"),
  };
}

/**
 * What a codex has that Gluon hasn't classified. `list` is the plain `features list`, `listOff` the same
 * with `featuresToDisable` turned off (codex forces some on), `catalog` `debug models --bundled`, `tools`
 * the tool check's results.
 */
export function drift(version: string, list: string, listOff: string, catalog: string, items: string[], tools: ToolCheck[] = []): Drift {
  const known = new Set(featureNames(list));
  let refusal: string | null = null;
  let catalogFields: string[] = [];
  try {
    catalogWithoutTools(catalog);
    catalogFields = uncheckedCatalogFields(catalog);
  } catch (e) {
    refusal = (e as Error).message;
  }
  return {
    version,
    features: uncheckedFeatures(listOff),
    catalogFields,
    newOff: newFeatures(list),
    tools: tools.filter((t) => t.extra.length || t.missing.length || t.error),
    catalog: refusal,
    items: [...new Set(items)].filter((t) => !BRAIN_ITEMS.has(t) && !FOREIGN_ITEMS.has(t)),
    gone: CODEX_FEATURES_OFF.filter((f) => !known.has(f)),
  };
}

export const drifted = (d: Drift) => d.tools.length > 0 || d.catalog !== null || d.items.length > 0;

/** The names `features list` shows. */
function featureNames(list: string): string[] {
  return list
    .split("\n")
    .map((l) => l.trim().split(/\s{2,}/)[0]!)
    .filter(Boolean);
}

/** A name codex printed, as a code span: it goes into an issue, so nothing in it can format, link or mention. */
const code = (s: string) => `\`${s.replace(/[^\w.:-]/g, "?")}\``;

/** The report: what is new and where it goes in `src/agent/codex.ts`. */
export function report(d: Drift): string {
  const lines = [`## codex ${d.version.replace(/[^\w.+-]/g, "?")}`, ""];
  if (!drifted(d)) lines.push("Nothing to do for the intake agent: the model is sent Gluon's tools only, and every item type is classified.");
  // Models with the same result share a line.
  const byResult = new Map<string, string[]>();
  for (const t of d.tools) {
    const what = [t.extra.length && `tools of codex's own: ${t.extra.map(code).join(", ")}`, t.missing.length && `without Gluon's ${t.missing.map(code).join(", ")}`, t.error && `failed: ${t.error.replace(/[`@<>\[\]\n]/g, "?")}`].filter(Boolean).join("; ");
    byResult.set(what, [...(byResult.get(what) ?? []), t.model]);
  }
  for (const [what, models] of byResult) {
    lines.push(`- **The model request (${models.map(code).join(", ")})**: ${what}. Find the feature or setting that gives a tool (\`CODEX_FEATURES_OFF\`, the thread's config, \`CATALOG_TOOLS_OFF\`); a failure may be a feature codex needs that Gluon turned off (below). Until then the intake agent may be offered it.`);
  }
  if (d.catalog) lines.push(`- **Model catalog**: ${d.catalog.replace(/[`@<>\[\]\n]/g, "?")}. Until Gluon reads it again the intake agent can't start on this codex.`);
  if (d.items.length) lines.push(`- **New thread-item types**: ${d.items.map(code).join(", ")}. Each goes in \`BRAIN_ITEMS\` or \`FOREIGN_ITEMS\`; until then a turn that has one is stopped.`);
  if (d.newOff.length) lines.push(`- New features, turned off unchecked (nothing to do unless the intake agent needs one): ${d.newOff.map(code).join(", ")}.`);
  if (d.features.length) lines.push(`- Features codex keeps on when Gluon turns them off (the brain runs with them, and \`gluon doctor\` warns; the tool check above says whether they give tools): ${d.features.map(code).join(", ")}. Each goes in \`CODEX_FEATURES_KEPT\` with why it gives the model no tool.`);
  if (d.catalogFields.length) lines.push(`- Catalog fields Gluon hasn't checked, passed to codex as they are (\`gluon doctor\` warns; the tool check above says whether they give tools): ${d.catalogFields.map(code).join(", ")}. Each goes in \`CATALOG_FIELDS\`, or in \`CATALOG_TOOLS_OFF\` if it adds tools.`);
  if (d.gone.length) lines.push(`- Names of \`CODEX_FEATURES_OFF\` this codex doesn't list (harmless; delete them once no supported codex has them): ${d.gone.map(code).join(", ")}.`);
  if (drifted(d)) lines.push("", "Then refresh `test/fixtures/codex-features-list.txt` from `codex features list` and run `bun run test:area brain`.");
  return lines.join("\n");
}

/** The SSE reply of the local provider: one short assistant message, then the response completes. */
function reply(): string {
  const events = [
    { type: "response.created", response: { id: "resp_drift" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_drift", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
    { type: "response.completed", response: { id: "resp_drift", usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A request body, decoded as codex may send it (zstd or gzip); throws on any other encoding. */
async function requestBody(req: Request): Promise<unknown> {
  const raw = new Uint8Array(await req.arrayBuffer());
  const enc = (req.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const bytes = !enc || enc === "identity" ? raw : enc === "zstd" ? Bun.zstdDecompressSync(raw) : enc === "gzip" ? Bun.gunzipSync(raw) : null;
  if (!bytes) throw new Error(`a model request in an encoding the check can't read (${enc})`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * The brain's one turn per model, as for a user, against a provider on 127.0.0.1: what each turn's
 * requests carried. `command` runs codex (the binary, or a fake in tests, which may add `extraEnv` to
 * its bare environment). A model's turn that times out or sends a request the check can't read is
 * that model's `error`; the others are still checked. Throws only when the check itself can't run.
 */
export async function toolCheck(command: string[], models: string[], dir: string, home: string, opts: { timeoutMs?: number; extraEnv?: Record<string, string> } = {}): Promise<ToolCheck[]> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let bodies: unknown[] = [];
  let unreadable: Error | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/responses")) return new Response("not found", { status: 404 });
      try {
        bodies.push(await requestBody(req));
      } catch (e) {
        unreadable = e as Error;
      }
      return new Response(reply(), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const provider = [
    "-c",
    "model_provider=gluon_drift",
    "-c",
    `model_providers.gluon_drift={name="gluon-drift",base_url="http://127.0.0.1:${server.port}/v1",env_key="GLUON_DRIFT_KEY",wire_api="responses",request_max_retries=0,stream_max_retries=0}`,
  ];
  // Windows needs its system variables to start a process or open a socket at all.
  const system = process.platform === "win32" ? Object.fromEntries(["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "SystemDrive"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))) : {};
  const env = { ...system, PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR, CODEX_HOME: home, GLUON_DRIFT_KEY: "none", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...opts.extraEnv };
  const spawn: SpawnCodex = (argv) => Bun.spawn([...command, ...argv.slice(1), ...(argv[1] === "app-server" ? provider : [])], { cwd: dir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const hooks = { begin() {}, text() {}, end() {}, tool: async () => ({ content: "Not available in this check.", error: true }) };
  const out: ToolCheck[] = [];
  try {
    for (const model of models) {
      bodies = [];
      unreadable = null;
      const brain = chatgptPlanBrain({ model, cwd: dir, spawn });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer from codex for ${model} in ${timeoutMs / 1000} s`)), timeoutMs)));
      let error: string | null = null;
      try {
        await Promise.race([brain.send("Reply with the single word: ok", "You are a check. Reply with the single word: ok", hooks, new AbortController().signal).catch((e: Error) => (error = e.message)), timeout]);
      } catch (e) {
        error = (e as Error).message;
      } finally {
        clearTimeout(timer);
        brain.close?.();
      }
      out.push(checkTools(model, bodies, (unreadable as Error | null)?.message ?? error));
    }
  } finally {
    server.stop(true);
  }
  return out;
}

/** The models to check: the default brain order's on the ChatGPT plan, then every model of codex's catalog. */
export function modelsToCheck(catalog: string): string[] {
  const own = DEFAULT_ORDER.filter((s) => s.route === "chatgpt-plan").map((s) => s.model);
  let slugs: string[] = [];
  try {
    slugs = (JSON.parse(catalog).models ?? []).map((m: { slug?: unknown }) => m?.slug).filter((x: unknown): x is string => typeof x === "string");
  } catch {}
  return [...new Set([...own, ...slugs])];
}

function run(binary: string, args: string[], cwd: string, home: string): string {
  const p = Bun.spawnSync([binary, ...args], { cwd, env: { ...process.env, CODEX_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  if (p.exitCode !== 0) throw new Error(`\`codex ${args.join(" ")}\` failed (exit code ${p.exitCode}): ${p.stderr.toString().trim().split("\n").at(-1) ?? ""}`);
  return p.stdout.toString();
}

async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf("--binary");
  const binary = i >= 0 ? argv[i + 1] : undefined;
  if (!binary || binary.startsWith("-")) {
    console.error("usage: bun scripts/codex-drift.ts --binary <path to codex>");
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), "gluon-codex-drift-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home);
    const version = run(binary, ["--version"], dir, home).trim().replace(/^codex-cli\s+/, "");
    const list = run(binary, ["features", "list"], dir, home);
    const listOff = run(binary, ["features", "list", ...featuresToDisable(list).flatMap((f) => ["--disable", f])], dir, home);
    const catalog = run(binary, ["debug", "models", "--bundled"], dir, home);
    const out = join(dir, "schema");
    run(binary, ["app-server", "generate-json-schema", "--out", out], dir, home);
    const items = itemTypes(JSON.parse(readFileSync(join(out, "codex_app_server_protocol.schemas.json"), "utf8")));
    // A check that couldn't run, or found something, is run once more before it counts (a slow runner, a codex hiccup).
    const once = () => toolCheck([binary], modelsToCheck(catalog), dir, home);
    let tools = await once().catch(once);
    if (tools.some((t) => t.extra.length || t.missing.length || t.error)) tools = await once();
    const d = drift(version, list, listOff, catalog, items, tools);
    console.log(report(d));
    return drifted(d) ? 1 : 0;
  } catch (e) {
    console.log(`## codex: couldn't check\n\n${(e as Error).message}`);
    return 2;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
