#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun run test:live`: real checks, on a budget. Never part of `bun run regression` (offline).
 *
 * - Every harness's official status check, every connection's models probed (free listings where
 *   the provider has one, else a tiny call of ≤16 output tokens), every step of the brain order
 *   probed, and one short brain session per working step (the task below, until the brain asks or
 *   proposes; one answer to its question at most).
 * - Spend ledger: qa/logs/live-spend.json. Buckets with hard caps: Bedrock ≤ $5, all other APIs
 *   (Anthropic, OpenAI, Gemini, OpenRouter) ≤ $3, over all runs. Each call is priced from its token
 *   usage × the price table below (a session's usage is estimated from the characters sent and
 *   received, rounded up), and a call whose worst case could push its bucket over the cap is refused.
 * - Subscriptions (Claude plan, ChatGPT plan, Google, xAI) cost no API money; kept to a few probes
 *   and one session on the Claude plan.
 *
 * - `bun run test:live --only=nested-instructions`: only the check that the brain reads a nested
 *   AGENTS.md (issue #11), on the Anthropic API and the Claude plan; this run is capped at $0.50.
 * - `bun run test:live --only=git-tools`: no harness checks or model probes; a two-commit repo whose
 *   last commit broke `add`, one session per working brain-order step, and which git tools each
 *   brain called (issue #17); this run is capped at $1.
 * - `bun run test:live --tier=regression`: a fixed, asserted set (every assertion PASS / FAIL / SKIP, exit 1 on a FAIL), the whole
 *   run capped at $3 over all buckets: a probe of each brain step, one short brain chat on the cheapest working route, the git-tools and
 *   nested-instructions checks, and the real-harness section (`scripts/live-harness.ts`: each installed harness launched from Gluon's
 *   demo brain on its cheapest model over an API key). `--tier=harness --harness=<id>`: that section for one harness, with its screens
 *   saved to qa/logs/screens/ (run it after a harness update). `--dry-run` prints what a run would call and its worst-case cost, and spends nothing.
 * - A campaign: `--ledger <path> --caps bedrock=30,other=10,openrouter=0.5` keeps its own ledger and caps; OpenRouter is a sub-bucket
 *   inside `other`, and Claude-plan usage is charged to `other` at the Anthropic API's prices, flagged `estimated`. Without these flags
 *   the ledger is qa/logs/live-spend.json with the caps above, and a plan costs no API money.
 *
 * Keys come from a dev key file, GLUON_DEV_ENV (default: the repo's .env), handed to Gluon's
 * secrets explicitly (never process.env); the default AWS credentials, in the region of AWS_REGION / AWS_DEFAULT_REGION or the AWS
 * config's profile (`awsSetupFromHost`); a throwaway config.
 * In a git worktree there is no .env (it is gitignored): set GLUON_DEV_ENV to the main repo's .env,
 * as an absolute path: GLUON_DEV_ENV=/path/to/main-checkout/.env bun run test:live.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probeConverse } from "../src/agent/bedrock-converse.ts";
import { repoContext, systemPrompt } from "../src/agent/prompt.ts";
import { Session, type LoopBrain, type ModelClient, type State } from "../src/agent/session.ts";
import { brainFor, KEY as BRAIN_KEY, notConnected, probeStep, stepLabel } from "../src/brain.ts";
import { loadConfig, saveConfig, type BrainStep, type Config } from "../src/config.ts";
import { HARNESS_INFO, HARNESSES, isPlanConn, PROVIDERS, subscriptionOf, type Conn, type Harness } from "../src/harnesses.ts";
import { offeredAgents } from "../src/models.ts";
import { maskSecrets } from "../src/secrets.ts";
import { claudePing, loginStatus, versionOf } from "../src/status.ts";
import { probeConnection, recordProbes, summaryLine, type ConnectionProbe, type ModelProbe, type Probe } from "../src/verify.ts";
import { availableHere, awsSetupFromHost, checkHarness, harnessesFor, loadDevKeys, planHarness, runHarnessSection, verdict, type Assertion } from "./live-harness.ts";
import {
  bucketOf, chatStep, DEFAULT_CAPS, DEFAULT_LEDGER, JOURNEY_AGENT_CAP, JOURNEY_BRAIN, JOURNEY_BRAIN_CAP, JOURNEY_HARNESS_CAP, JOURNEY_MONTH_CAP, journeyMonthSpend, parseArgs, PROBE,
  planCharged, planLines, planRouteBlock, regressionSubset, runCapOf, sectionsOf, SESSION, Spend, usd,
  type Args, type Bucket, type PlanItem, type Section,
} from "./live-lib.ts";

const ROOT = resolve(import.meta.dir, "..");
let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const campaign = !!args.caps;
const LEDGER = args.ledger ? resolve(args.ledger) : join(ROOT, DEFAULT_LEDGER);
const CAPS = args.caps ?? DEFAULT_CAPS;
/** A targeted run's own cap, on top of the buckets' (all paid buckets together). */
const RUN_CAP = runCapOf(args);
const spend = new Spend(LEDGER, CAPS, RUN_CAP, campaign, !args.dryRun);
const sections = sectionsOf(args);
const out = (s: string) => console.log(maskSecrets(s));

/** Whether a call with this worst case fits its bucket and the run's cap; refused calls are logged. */
const allow = (bucket: Bucket, what: string, model: string, maxIn: number, maxOut: number) => spend.allow(bucket, what, model, maxIn, maxOut);
const charge = (bucket: Bucket, what: string, model: string, input: number, output: number, estimated = false) => spend.charge(bucket, what, model, input, output, estimated);
const bucketFor = (route: string) => bucketOf(route, campaign);

// ——— setup: a throwaway config and repos, the dev key file for keys ———
const TMP = mkdtempSync(join(tmpdir(), "gluon-live-"));
process.env.GLUON_CONFIG = join(TMP, "config.yaml");
delete process.env.GLUON_TEST_PROBES;
// The maintainers' cheap model (Sonnet 4.6, Claude Code over Bedrock only): the seam is on for this source run, never in a release build.
process.env.GLUON_TEST_MAINTAINER_MODELS = "1";
const keys = loadDevKeys(TMP);
const aws = awsSetupFromHost();
const date = new Date().toISOString().slice(0, 10);
saveConfig([
  [["connections"], {
    "claude-code": { auth: "subscription" },
    codex: { auth: "subscription" },
    antigravity: { auth: "subscription" },
    "grok-build": { auth: "subscription" },
    opencode: { auth: "api", providers: ["opencode-go", "openrouter"] },
    "kimi-code": { auth: "api", provider: "openrouter" },
  }],
  // The region is the AWS setup's (AWS_REGION, AWS_DEFAULT_REGION, the profile's in ~/.aws/config), never a guess: with none, Bedrock stays unconnected here.
  ...(aws.region || aws.profile ? [[["bedrock"], { ...(aws.region ? { region: aws.region } : {}), ...(aws.profile ? { profile: aws.profile } : {}) }] as [string[], unknown]] : []),
  [["notices"], { claude: date, chatgpt: date, google: date, xai: date }],
]);
const config: Config = loadConfig();

/** The Claude plan runs in this scratch HOME (with the user's own token in the environment): the real ~/.claude is never touched. */
const PLAN_HOME = join(TMP, "claude-plan-home");
/** Why a plan route can't run here (see `planRouteBlock`), or null. */
const planBlock = (step: BrainStep): string | null => planRouteBlock(step.route, process.env);
/**
 * Runs `fn` with HOME (the child `claude` reads it from the environment it is spawned with) pointed at a scratch directory when the
 * step is the Claude plan; restored after. Nothing else in this process reads HOME while a plan call runs: the checks are sequential.
 */
async function inPlanHome<T>(step: BrainStep, fn: () => Promise<T>): Promise<T> {
  if (step.route !== "claude-plan") return fn();
  mkdirSync(PLAN_HOME, { recursive: true, mode: 0o700 });
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = PLAN_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

interface Ctx {
  repo: string;
  task: string;
}
const gitIn = (repo: string, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=live", "-c", "user.email=live@localhost", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env: process.env });
const broken = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
// Issue #11: a rule only a nested AGENTS.md states (the root has none), on the path to the file to fix.
const NESTED_RULE = "bun run check:strict";
/** A tiny repo: `git`, two commits whose last broke `add` (issue #17); else the broken file and the nested AGENTS.md (issue #11). */
function makeRepo(kind: "git" | "fix"): Ctx {
  const repo = join(TMP, `repo-${kind}`);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{ "name": "tiny", "scripts": { "test": "bun test" } }\n');
  gitIn(repo, "init", "-q");
  if (kind === "git") {
    writeFileSync(join(repo, "src/math.ts"), broken.replace("a - b", "a + b"));
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", "Add math helpers");
    writeFileSync(join(repo, "src/math.ts"), broken);
    gitIn(repo, "commit", "-qam", "Tidy math helpers");
  } else writeFileSync(join(repo, "src/math.ts"), broken);
  writeFileSync(join(repo, "src/AGENTS.md"), `# src/\n\n- After any change under src/, run \`${NESTED_RULE}\` (not \`bun test\`): it also checks types.\n`);
  return { repo, task: kind === "git" ? "My last commit broke add. Fix it." : "The add function in src/math.ts subtracts instead of adding. Fix it." };
}
const fixCtx = makeRepo("fix");
const gitCtx = makeRepo("git");

/** One short brain session on the task (one answer to a question at most), charged to its bucket. */
const session = (step: BrainStep, bucket: Bucket, label: string, agents: Config["agents"], system: string, ctx: Ctx) => inPlanHome(step, () => sessionIn(step, bucket, label, agents, system, ctx));
async function sessionIn(step: BrainStep, bucket: Bucket, label: string, agents: Config["agents"], system: string, ctx: Ctx): Promise<{ result: string; state: State }> {
  let chars = { in: 0, out: 0 };
  const inner = brainFor(config, step, ctx.repo);
  // Count what goes in and out, for the estimate (Anthropic-shaped messages, ~3 chars a token, rounded up).
  const client: ModelClient | LoopBrain =
    typeof inner === "function"
      ? async (req, onText) => {
          chars.in += req.system.length + JSON.stringify(req.messages).length + JSON.stringify(req.tools).length;
          const res = await inner(req, onText);
          chars.out += JSON.stringify(res.content).length;
          return res;
        }
      : inner;
  const s = new Session(client, { ...config, agents }, system, ctx.repo);
  let state: State = s.snapshot;
  s.subscribe((x) => (state = x));
  const timeout = <T>(p: Promise<T>) => Promise.race([p, Bun.sleep(150_000).then(() => (s.interrupt(), "timeout" as const))]);
  const result = await (async () => {
    if ((await timeout(s.submit(ctx.task))) === "timeout") return "timed out";
    if (state.pending?.kind === "question") {
      const answer = state.pending.question.options[0]!.label;
      if ((await timeout(s.submit(answer))) === "timeout") return "timed out after the answer";
    }
    const errors = state.items.filter((it) => it.kind === "notice" && it.tone === "error").map((it) => (it as { text: string }).text.split("\n")[0]);
    if (state.pending?.kind === "proposal") {
      const c = state.pending.choice;
      return `proposed ${c.harness} · ${c.model}${c.effort ? ` · ${c.effort}` : ""}`;
    }
    if (state.pending?.kind === "question") return `asked "${state.pending.question.question}"`;
    return errors.length ? `error: ${errors[0]}` : "ended without a proposal";
  })().finally(() => {
    s.close();
    if (bucket !== "subscription") charge(bucket, `brain session ${label}`, step.model, Math.ceil(chars.in / 3), Math.ceil(chars.out / 3), true);
    else charge("subscription", `brain session ${label}`, step.model, 0, 0);
  });
  return { result, state };
}

/** `--only=nested-instructions`: the Anthropic API and the Claude plan. */
const NESTED_STEPS: BrainStep[] = [{ route: "anthropic-api", model: "claude-sonnet-5-5" }, { route: "claude-plan", model: "claude-sonnet-5-5" }];

/** Issue #11, on two steps: the brain gets src/AGENTS.md when it works in src/ and carries its rule into the spec. Returns whether both passed. */
async function nestedInstructions(steps: BrainStep[] = NESTED_STEPS): Promise<boolean | null> {
  out("Nested AGENTS.md (issue #11)");
  const agents = offeredAgents(config);
  const system = systemPrompt({ ...config, agents }, repoContext(fixCtx.repo));
  let failed = 0;
  let ran = 0;
  for (const step of steps) {
    const bucket = bucketFor(step.route);
    const label = stepLabel(step);
    const blocked = planBlock(step);
    if (blocked) {
      out(`  - ${label} · skipped: ${blocked}`);
      continue;
    }
    if (!allow(bucket, `nested-instructions ${label}`, step.model, SESSION.input, SESSION.output)) {
      out(`  ✗ ${label} · refused: over budget`);
      failed++;
      continue;
    }
    ran++;
    const { result, state } = await session(step, bucket, label, agents, system, fixCtx);
    const reads = [...state.items, ...state.live].flatMap((it) => (it.kind === "explored" ? it.rows : [])).filter((r) => r.kind === "read" && !r.error).map((r) => r.text);
    // src/AGENTS.md comes with any repo tool's result under src/ (pathInstructions); the brain needn't open it.
    const read = reads.some((r) => /^(\.\/)?src\//.test(r));
    const spec = state.pending?.kind === "proposal" ? state.pending.choice.spec : "";
    const ok = read && spec.includes(NESTED_RULE);
    if (!ok) failed++;
    out(`  ${ok ? "✓" : "✗"} ${label} · touched src/: ${read ? "yes" : "no"} · rule in spec: ${spec.includes(NESTED_RULE) ? "yes" : "no"} · ${result}`);
    out(`      reads: ${reads.join(", ") || "(none)"}`);
  }
  if (failed) process.exitCode = 1;
  return ran === 0 ? null : failed === 0;
}

// ——— brain-order probes, each made once per run ———
const probed = new Map<string, Probe>();
const stepKey = (s: BrainStep) => `${s.route}|${s.model}`;

/** Probes a step (once: later calls get the first answer and charge nothing), charged to its bucket. Null: refused over budget. */
async function probeOnce(step: BrainStep, label: string): Promise<Probe | null> {
  const known = probed.get(stepKey(step));
  if (known) return known;
  const bucket = bucketFor(step.route);
  if (!allow(bucket, `brain probe ${label}`, step.model, PROBE.input, PROBE.output)) return null;
  const blocked = planBlock(step);
  // The Claude plan with its token, in a scratch HOME: the one real call (`claude auth status` would read a login that isn't there).
  const r: Probe = blocked ? { ok: false, error: blocked } : step.route === "claude-plan" ? await inPlanHome(step, async () => ((e) => (e ? { ok: false, error: e } : { ok: true }) as Probe)(await claudePing(step.model))) : await probeStep(config, step, ctx0);
  if (bucket !== "subscription" && !blocked && (r.ok || !/^not connected/.test(r.error))) charge(bucket, `brain probe ${label}`, step.model, r.ok ? (r.usage?.input ?? PROBE.input) : 0, r.ok ? (r.usage?.output ?? PROBE.output) : 0, (r.ok && !r.usage) || planCharged(step.route, campaign));
  probed.set(stepKey(step), r);
  return r;
}
const ctx0 = fixCtx.repo;

/** Each step of the brain order probed, then one short session on each working step; `after` reports on it. */
async function brainOrder(ctx: Ctx, after: (label: string, state: State) => string = () => "", only?: BrainStep[]) {
  const agents = offeredAgents(config);
  const system = systemPrompt({ ...config, agents }, repoContext(ctx.repo));
  for (const [i, step] of config.brain.order.entries()) {
    if (only && !only.includes(step)) continue;
    const bucket = bucketFor(step.route);
    const label = `${i + 1}. ${stepLabel(step)}`;
    const r = await probeOnce(step, label);
    if (!r) {
      out(`  ✗ ${label} · refused: over budget`);
      continue;
    }
    if (!r.ok) {
      out(`  ✗ ${label} · ${r.error}`);
      continue;
    }
    if (!allow(bucket, `brain session ${label}`, step.model, SESSION.input, SESSION.output)) {
      out(`  ✓ ${label} · probe ok · session refused: over budget`);
      continue;
    }
    const { result, state } = await session(step, bucket, label, agents, system, ctx);
    out(`  ✓ ${label} · probe ok · session: ${result}${after(label, state)}`);
  }
}

async function everything() {
  // ——— harnesses: installed, version, official status check (free) ———
  out("Harnesses");
  const status: Partial<Record<Harness, string>> = {};
  for (const h of HARNESSES) {
    const info = HARNESS_INFO[h];
    const v = await versionOf(h);
    if (!v) {
      status[h] = "not installed";
      out(`  ✗ ${info.label}: not installed`);
      continue;
    }
    // The harness's own plan, or (OpenCode) the plan provider's: asked of the official binary, free.
    if (!info.subscription && !info.providers.some((p) => PROVIDERS[p].subscription)) {
      status[h] = `installed ${v} (keys only)`;
      out(`  ✓ ${info.label} ${v} · keys only`);
      continue;
    }
    const s = await loginStatus(h);
    status[h] = s.loggedIn && !s.wrongMethod ? `signed in (${s.detail})` : s.wrongMethod ?? "not connected (not signed in)";
    out(`  ${s.loggedIn && !s.wrongMethod ? "✓" : "✗"} ${info.label} ${v} · ${status[h]}`);
  }

  // ——— connections: every model probed ———
  out("\nConnections");
  const probes: ConnectionProbe[] = [];
  const probe = async (h: Harness, conn: Conn) => {
    if (conn === "bedrock") {
      if (!availableHere(config).bedrock) return { harness: h, conn, problem: "no AWS region or profile (AWS_REGION, AWS_PROFILE or the AWS config)", models: [] } as ConnectionProbe;
      // Tiny paid calls: each guarded and charged.
      const models: ModelProbe[] = [];
      for (const entry of config.models[h].filter((m) => m.ids.bedrock)) {
        const id = entry.ids.bedrock!;
        if (!allow("bedrock", `probe ${h}/bedrock`, id, PROBE.input, PROBE.output)) continue;
        const result = await probeConverse({ model: id, region: config.bedrock.region, profile: config.bedrock.profile });
        charge("bedrock", `probe ${h}/bedrock`, id, result.ok ? (result.usage?.input ?? PROBE.input) : 0, result.ok ? (result.usage?.output ?? PROBE.output) : 0);
        models.push({ entry, id, result });
      }
      return { harness: h, conn, problem: null, models } as ConnectionProbe;
    }
    if (subscriptionOf(h, conn) && status[h] && !status[h]!.startsWith("signed in")) return { harness: h, conn, problem: status[h]!, models: [] } as ConnectionProbe;
    const p = await probeConnection(config, h, conn, { cwd: fixCtx.repo });
    if (isPlanConn(conn)) for (const m of p.models) charge("subscription", `probe ${h}/${conn}`, m.id, 0, 0);
    return p;
  };
  for (const [h, conn] of CONNECTION_PLAN) {
    if (status[h] === "not installed") continue;
    const p = await probe(h, conn);
    probes.push(p);
    out(`  ${summaryLine(p)}`);
    for (const m of p.models) if (!m.result.ok) out(`      ✗ ${m.id}: ${m.result.error}`);
  }
  recordProbes(config, probes.filter((p) => config.connections[p.harness] && (p.conn === "plan" || config.connections[p.harness]?.providers?.includes(p.conn as never))));

  out("\nBrain order");
  await brainOrder(fixCtx);
}

const CONNECTION_PLAN: [Harness, Conn][] = [
  ["claude-code", "plan"], ["claude-code", "anthropic"], ["claude-code", "bedrock"], ["claude-code", "openrouter"],
  ["codex", "plan"], ["codex", "openai"], ["codex", "bedrock"], ["codex", "openrouter"],
  ["antigravity", "plan"], ["antigravity", "gemini"],
  ["grok-build", "plan"],
  // Bedrock is Claude Code's and Codex's only (above); OpenCode has its plan (a stored sign-in) and OpenRouter.
  ["opencode", "opencode-go"], ["opencode", "openrouter"],
  // Kimi Code's plan has no listing and a call would spend its quota (`kimiPlanStatus` is its check); over OpenRouter its two models are probed like any key route's.
  ["kimi-code", "openrouter"],
];

/** Issue #17: which git tools each working brain calls on "my last commit broke add". Returns whether it passed. */
async function gitTools(only?: BrainStep[]): Promise<boolean> {
  out(`Git tools (issue #17): no harness checks or model probes; this run may spend at most $${RUN_CAP}\n\nBrain order`);
  const use: { calls: string[]; errors: string[] }[] = [];
  await brainOrder(gitCtx, (_label, state) => {
    const rows = [...state.items, ...state.live].flatMap((it) => (it.kind === "explored" ? it.rows : [])).filter((r) => r.kind === "git");
    const u = { calls: rows.map((r) => r.text), errors: rows.filter((r) => r.error).map((r) => `${r.text}: ${r.error}`) };
    use.push(u);
    return ` · git: ${u.calls.join(", ") || "none"}${u.errors.length ? ` · tool errors: ${u.errors.join("; ")}` : ""}`;
  }, only);
  // Passes when most brains look at history (git_log / git_diff) and no git tool call fails.
  const looked = use.filter((u) => u.calls.some((c) => c.startsWith("log") || c.startsWith("diff")));
  const failed = use.filter((u) => u.errors.length);
  const pass = use.length > 0 && looked.length * 2 > use.length && failed.length === 0;
  out(`\nGit tools: ${looked.length}/${use.length} brains used git_log or git_diff; ${failed.length} with tool errors · ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
  return pass;
}

// ——— --tier=regression: a fixed set, every assertion PASS / FAIL / SKIP ———

const asserts: Pick<Assertion, "status">[] = [];
/** The routes that probed fine in (a): what the regression subset picks its API route from. */
const workingSteps: BrainStep[] = [];
const subset = () => regressionSubset(config.brain.order, (s) => workingSteps.includes(s), campaign);
function assert(name: string, status: "PASS" | "FAIL" | "SKIP", detail = "") {
  asserts.push({ status });
  out(`${status.padEnd(4)} ${name}${detail ? `: ${detail}` : ""}`);
}
/** A probe that says the route isn't set up here (no key, not signed in, not installed): not a failure of the product. */
const NOT_HERE = /^not connected|not logged in|not signed in|signed in with|not installed|not found on PATH/i;

/** (a) A probe of each brain step. (b) One short chat on the cheapest working route. Returns the steps that probed fine. */
async function probesAndChat(): Promise<void> {
  out("\n(a) Probes of each brain route");
  const working: BrainStep[] = [];
  for (const [i, step] of config.brain.order.entries()) {
    const label = `${i + 1}. ${stepLabel(step)}`;
    const r = await probeOnce(step, label);
    if (!r) assert(`probe ${label}`, "SKIP", "refused: over budget");
    else if (r.ok) {
      assert(`probe ${label}`, "PASS");
      working.push(step);
      workingSteps.push(step);
    } else assert(`probe ${label}`, NOT_HERE.test(r.error) ? "SKIP" : "FAIL", r.error);
  }
  out("\n(b) One short brain chat on the cheapest working route");
  const chat = chatStep(working, campaign);
  if (!chat) return assert("brain chat", "SKIP", "no route probed fine");
  const label = stepLabel(chat);
  const bucket = bucketFor(chat.route);
  if (!allow(bucket, `brain chat ${label}`, chat.model, SESSION.input, SESSION.output)) return assert("brain chat", "SKIP", `refused: ${spend.run.refused.at(-1)}`);
  const agents = offeredAgents(config);
  const { result } = await session(chat, bucket, label, agents, systemPrompt({ ...config, agents }, repoContext(fixCtx.repo)), fixCtx);
  assert(`brain chat on ${label} comes back with a question or a proposal`, /^(proposed|asked) /.test(result) ? "PASS" : "FAIL", result);
}

async function regression() {
  out(`Regression tier: probes, a brain chat, git tools, nested instructions, real harnesses; this run may spend at most $${RUN_CAP}`);
  if (sections.includes("probes")) await probesAndChat();
  if (sections.includes("git-tools")) {
    out(`\n(c) Git tools, on a fixed subset: the plan routes and the cheapest working API route (the full order: --only=git-tools)`);
    process.exitCode = 0;
    assert("git tools: most brains look at history, no tool errors", (await gitTools(subset())) ? "PASS" : "FAIL");
  }
  if (sections.includes("nested-instructions")) {
    out("\n(c) Nested instructions, on the same subset");
    process.exitCode = 0;
    const nested = await nestedInstructions(subset());
    assert("nested instructions: the brain reads src/AGENTS.md and carries its rule", nested === null ? "SKIP" : nested ? "PASS" : "FAIL", nested === null ? "no route could run here" : "");
  }
  if (sections.includes("real-harness")) await realHarness(false);
  const v = verdict(asserts, spend.run.refused.length > 0);
  out(`\n${v.line}`);
  process.exitCode = v.code;
}

/** (d) The real-harness section (scripts/live-harness.ts): each installed harness, or `--harness`. */
async function realHarness(screens: boolean) {
  out("\n(d) Real harnesses, launched from Gluon's demo brain on their cheapest model over an API key");
  const r = await runHarnessSection({ spend, campaign, ...(args.conn ? { conn: args.conn } : {}), ...(args.model ? { model: args.model } : {}), home: "scratch", screens, ...(args.harness ? { harness: args.harness } : {}), say: out }, config);
  for (const a of r.asserts) asserts.push({ status: a.status });
}

// ——— --tier=journey: the user's way through on the real brain, to the agent's reply ———

/** A journey's wall clock: past it, the check fails (its screens tell where it stood). */
const JOURNEY_MS = 5 * 60_000;

/** The journey's brain: the connected API route (a plan needs a sign-in in a scratch HOME) whose worst case is lowest, within its cap. */
function journeyBrain(): { step: BrainStep; worst: number; bucket: Bucket } | { why: string } {
  const pool = config.brain.order.filter((s) => !s.route.endsWith("-plan") && !notConnected(config, s));
  const priced = pool.map((step) => ({ step, bucket: bucketFor(step.route), worst: usd(step.model, bucketFor(step.route), JOURNEY_BRAIN.input, JOURNEY_BRAIN.output) })).sort((a, b) => a.worst - b.worst);
  const pick = priced[0];
  if (!pick) return { why: "no API brain route is connected here" };
  if (pick.worst > JOURNEY_BRAIN_CAP) return { why: `the cheapest brain route (${stepLabel(pick.step)}) could cost $${pick.worst.toFixed(4)}, over a journey's brain cap of $${JOURNEY_BRAIN_CAP}` };
  return pick;
}

/** One journey per harness (or `--harness`'s): every cap checked before anything is called; the brain is charged at its worst case. */
async function journey() {
  out(`Journey tier: ${args.harness ?? "every harness"}: the real brain asks and proposes, Gluon launches the agent, the agent replies; this run may spend at most $${RUN_CAP} (a journey ≤ $${JOURNEY_HARNESS_CAP}, this month's journeys ≤ $${JOURNEY_MONTH_CAP})`);
  const brain = journeyBrain();
  if ("why" in brain) {
    out(`SKIP journey: ${brain.why}`);
    asserts.push({ status: "SKIP" });
    return;
  }
  const have = availableHere(config);
  for (const h of harnessesFor(args.harness)) {
    const plan = planHarness(h, config, have, { conn: args.conn, model: args.model, campaign });
    const skip = (why: string) => {
      out(`SKIP journey ${h}: ${why}`);
      asserts.push({ status: "SKIP" });
    };
    if (!plan.pick.ok || !plan.binary || !plan.model || !plan.bucket) {
      skip(!plan.pick.ok ? plan.pick.why : !plan.binary ? `${HARNESS_INFO[h].binary} is not on PATH` : "no model");
      continue;
    }
    if (plan.worst > JOURNEY_AGENT_CAP) {
      skip(`its cheapest model could cost $${plan.worst.toFixed(4)}, over a journey's agent cap of $${JOURNEY_AGENT_CAP}`);
      continue;
    }
    const worst = brain.worst + plan.worst;
    const month = journeyMonthSpend(spend.file.runs, new Date());
    if (worst > JOURNEY_HARNESS_CAP) {
      skip(`its worst case $${worst.toFixed(4)} is over a journey's cap of $${JOURNEY_HARNESS_CAP}`);
      continue;
    }
    if (month + worst > JOURNEY_MONTH_CAP) {
      skip(`this month's journeys have cost $${month.toFixed(4)}; this one's worst case would take them over $${JOURNEY_MONTH_CAP}`);
      spend.run.refused.push(`journey ${h}: the month's cap`);
      break;
    }
    if (!spend.allowUsd(brain.bucket, `journey ${h} brain`, brain.step.model, worst)) {
      skip(`refused, over a cap: ${spend.run.refused.at(-1)}`);
      break;
    }
    out(`\njourney ${h}: brain ${stepLabel(brain.step)} (≤ $${brain.worst.toFixed(4)}) → ${plan.pick.conn} · ${plan.model.label} (≤ $${plan.worst.toFixed(4)})`);
    const r = await checkHarness(plan, config, {
      spend, campaign, home: "scratch", screens: true, say: out, turnMs: 120_000, deadline: Date.now() + JOURNEY_MS,
      brain: { step: brain.step, ...(BRAIN_KEY[brain.step.route] ? { key: BRAIN_KEY[brain.step.route] } : {}), turns: JOURNEY_BRAIN.turns },
    });
    // Gluon's brain usage doesn't reach this script: the brain is charged its worst case (an upper estimate), flagged as such.
    if (!r.refused) spend.chargeUsd(brain.bucket, `journey ${h} brain (${stepLabel(brain.step)})`, brain.step.model, brain.worst, JOURNEY_BRAIN.input, JOURNEY_BRAIN.output, true);
    for (const a of r.asserts) asserts.push({ status: a.status });
    if (r.refused) break;
  }
}

// ——— --dry-run: what would be called, and the worst case ———

function planOf(): PlanItem[] {
  const items: PlanItem[] = [];
  const have = availableHere(config);
  const add = (section: PlanItem["section"], what: string, worst: number, bucket: Bucket, note?: string) => items.push({ section, what, worst, bucket, ...(note ? { note } : {}) });
  /** A brain call of `n` tokens on a step: free and noted when the step isn't connected here. */
  const stepItem = (section: Section, kind: string, i: number, step: BrainStep, n: { input: number; output: number }) => {
    const label = `${kind} ${i + 1}. ${stepLabel(step)}`;
    const why = notConnected(config, step) ?? planBlock(step);
    const bucket = bucketFor(step.route);
    if (why) return add(section, label, 0, bucket, `skipped: ${why}`);
    const plan = step.route === "claude-plan" && campaign;
    const worst = bucket === "subscription" ? 0 : usd(step.model, bucket, n.input, n.output);
    add(section, label, worst, bucket, bucket === "subscription" ? "official binary on your plan: no API money" : plan ? "Claude plan, charged at API-equivalent (estimated)" : step.route === "bedrock" ? `region ${config.bedrock.region ?? "default"}` : undefined);
  };
  if (sections.includes("harnesses")) for (const h of HARNESSES) add("harnesses", `${HARNESS_INFO[h].label}: --version and the official login check`, 0, "subscription", "free");
  if (sections.includes("connections")) {
    for (const [h, conn] of CONNECTION_PLAN) {
      if (conn === "bedrock" && !have.bedrock) add("connections", `${h}/bedrock`, 0, "bedrock", "skipped: no AWS region or profile");
      else if (conn === "bedrock") for (const m of config.models[h].filter((x) => x.ids.bedrock)) add("connections", `${h}/bedrock ${m.ids.bedrock}: probe`, usd(m.ids.bedrock!, "bedrock", PROBE.input, PROBE.output), "bedrock");
      else add("connections", `${h}/${conn}: models listed or probed`, 0, bucketFor(conn === "plan" ? "claude-plan" : conn), "a free listing, or a call of ≤16 output tokens that this script does not charge");
    }
  }
  const orders = config.brain.order;
  if (sections.includes("probes") || sections.includes("brain-order")) orders.forEach((s, i) => stepItem(sections.includes("probes") ? "probes" : "brain-order", "probe", i, s, PROBE));
  if (sections.includes("brain-order")) orders.forEach((s, i) => stepItem("brain-order", "session", i, s, SESSION));
  if (sections.includes("brain-chat")) {
    const connected = orders.filter((s) => !notConnected(config, s) && !planBlock(s));
    const candidates = connected.filter((s) => !s.route.endsWith("-plan"));
    const pool = candidates.length ? candidates : connected;
    const pick = chatStep(pool, campaign);
    if (pick) add("brain-chat", `one chat on the cheapest working route (of ${pool.length} connected here: ${stepLabel(pick)})`, usd(pick.model, bucketFor(pick.route) === "subscription" ? "other" : bucketFor(pick.route), SESSION.input, SESSION.output), bucketFor(pick.route), "if it fails to probe, the next cheapest is used");
    else add("brain-chat", "one chat on the cheapest working route", 0, "other", "no route is connected here");
  }
  // The regression tier runs these two on a fixed subset (the plan routes and the cheapest connected API route); --only runs the whole order / two steps.
  const sub = args.tier === "regression" ? regressionSubset(orders, (s) => !notConnected(config, s) && !planBlock(s), campaign) : orders;
  if (sections.includes("git-tools")) orders.forEach((s, i) => (sub.includes(s) ? stepItem("git-tools", "session", i, s, SESSION) : undefined));
  if (sections.includes("nested-instructions")) {
    for (const [i, s] of (args.tier === "regression" ? sub : NESTED_STEPS).entries()) stepItem("nested-instructions", "session", i, s, SESSION);
  }
  if (sections.includes("journey")) {
    const brain = journeyBrain();
    if ("why" in brain) add("journey", "the real brain", 0, "other", `skipped: ${brain.why}`);
    else {
      const month = journeyMonthSpend(spend.file.runs, new Date());
      add("journey", `brain: ${stepLabel(brain.step)}, at most ${JOURNEY_BRAIN.turns} turns (this month's journeys so far: $${month.toFixed(4)} of $${JOURNEY_MONTH_CAP})`, 0, brain.bucket, "charged per journey below");
      for (const h of harnessesFor(args.harness)) {
        const p = planHarness(h, config, have, { conn: args.conn, model: args.model, campaign });
        if (!p.pick.ok) add("journey", `${h}`, 0, "other", `skipped: ${p.pick.why}`);
        else if (!p.binary) add("journey", `${h}`, 0, p.bucket ?? "other", `skipped: ${HARNESS_INFO[h].binary} is not on PATH`);
        else add("journey", `${h}: the brain asks and proposes → ${p.pick.conn} · ${p.model?.label} (${p.model?.id}) launched, replies once`, brain.worst + p.worst, p.bucket!, brain.worst + p.worst > JOURNEY_HARNESS_CAP ? `skipped: over a journey's cap of $${JOURNEY_HARNESS_CAP}` : undefined);
      }
    }
  }
  if (sections.includes("real-harness")) {
    if (!args.harness) add("real-harness", "grok-build", 0, "subscription", "skipped: no API-key route (its xAI plan needs a sign-in)");
    for (const h of harnessesFor(args.harness)) {
      const p = planHarness(h, config, have, { conn: args.conn, model: args.model, campaign });
      if (!p.pick.ok) add("real-harness", `${h}`, 0, "other", `skipped: ${p.pick.why}`);
      else if (!p.binary) add("real-harness", `${h}`, 0, p.bucket ?? "other", `skipped: ${HARNESS_INFO[h].binary} is not on PATH`);
      else add("real-harness", `${h}: Gluon (demo brain, free) → ${p.pick.conn} · ${p.model?.label} (${p.model?.id}), one prompt "Reply with just OK"${args.tier === "harness" ? ", screens saved" : ""}`, p.worst, p.bucket!);
    }
  }
  return items;
}

function dryRun() {
  const mode = args.tier ? `--tier=${args.tier}${args.harness ? ` --harness=${args.harness}` : ""}` : args.only ? `--only=${args.only}` : "(no flags: the long check)";
  out(`DRY RUN ${mode}: nothing is called, nothing is written`);
  out(`ledger: ${LEDGER}${campaign ? " (campaign: OpenRouter is a sub-bucket of other; the Claude plan is charged to other at API-equivalent)" : ""}`);
  const cap = (b: "bedrock" | "other" | "openrouter") => (CAPS[b] === undefined ? "no sub-cap" : `$${CAPS[b]}`);
  out(`caps · spent so far: bedrock ${cap("bedrock")} · $${spend.spent("bedrock").toFixed(4)}; other ${cap("other")} · $${spend.spent("other").toFixed(4)}${campaign ? `; openrouter ${cap("openrouter")} · $${spend.spent("openrouter").toFixed(4)}` : ""}`);
  out(`this run's cap: ${Number.isFinite(RUN_CAP) ? `$${RUN_CAP}` : "none (only the buckets')"}`);
  out(`keys present in ${keys.file}: ${keys.names.join(", ") || "none"} (values never printed)`);
  out(`Bedrock region: ${aws.region ?? "none"} (${aws.from})${aws.profile ? ` · profile ${aws.profile}` : ""}`);
  for (const l of planLines(planOf(), RUN_CAP)) out(l);
}

try {
  if (args.dryRun) dryRun();
  else if (args.tier === "regression") await regression();
  else if (args.tier === "journey") {
    await journey();
    const v = verdict(asserts, spend.run.refused.length > 0);
    out(`\n${v.line}`);
    process.exitCode = v.code;
  }
  else if (args.tier === "harness") {
    out(`Harness tier: ${args.harness}, the real-harness section alone; this run may spend at most $${RUN_CAP}`);
    await realHarness(true);
    const v = verdict(asserts, spend.run.refused.length > 0);
    out(`\n${v.line}`);
    process.exitCode = v.code;
  } else if (args.only === "nested-instructions") await nestedInstructions();
  else if (args.only === "git-tools") await gitTools();
  else await everything();
} finally {
  spend.save();
  rmSync(TMP, { recursive: true, force: true });
  if (!args.dryRun) {
    out("\nSpend (this run · all runs · cap)");
    for (const b of ["bedrock", "other", ...(campaign ? (["openrouter"] as const) : [])] as const) out(`  ${b.padEnd(10)} $${spend.runIn(b).toFixed(4)} · $${spend.spent(b).toFixed(4)} · ${CAPS[b] === undefined ? "no sub-cap" : `$${CAPS[b]}`}`);
    out(`  subscription calls: ${spend.run.calls.filter((c) => c.bucket === "subscription").length} (no API money)`);
    if (spend.run.refused.length) out(`  refused: ${spend.run.refused.join("; ")}`);
    out(`  ledger: ${LEDGER.startsWith(ROOT) ? LEDGER.slice(ROOT.length + 1) : LEDGER}`);
  }
}
