#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * The real-harness section of `bun run test:live` (`--tier=regression`, and `--tier=harness --harness=<id>` alone).
 *
 * For each harness binary on PATH: Gluon on the demo brain (free: no brain call) in a private tmux server, on a throwaway
 * config and a temp git repo, launches that harness on its cheapest model over an API-key connection (never a sign-in: a
 * harness that would need one is skipped, and the guard aborts on any sign-in screen). The one prompt is the launch's spec,
 * "Reply with just OK". Checks, each PASS / FAIL / SKIP:
 *   1. Gluon's frame shows the agent;  2. the status goes working → awaiting;  3. the agent answered OK;
 *   4. the reader finds the input line (a typed /clear makes Gluon ask: it read the line);  5. the home key returns to Gluon, Enter goes back;
 *   6. the cost figure is shown;  7. the figure stays within the check's token budget.
 * The spend is Gluon's own figure when it shows one, else the check's worst case (an upper estimate): charged to the ledger.
 *
 * The keys: only the one provider's key, copied into a `.env` next to the throwaway config (Gluon's own secret store; never
 * process.env, never printed). HOME is a scratch directory (the harness's own config is never touched), with `~/.aws` linked
 * in for Bedrock; `--home=real` uses the real one instead (a first-run dialog then writes to the harness's real config).
 * The tmux driver and the guard are `scripts/live-driver.ts`'s (`TmuxDriver`, `GuardedDriver`).
 *
 *   bun scripts/live-harness.ts --harness=codex [--conn=openrouter] [--model="GPT-6 Luna"] [--home=scratch|real] [--ledger f] [--caps …] [--dry-run]
 *
 * `--tier=harness` also saves the screens (plain text and ANSI) to qa/logs/screens/<id>-<version>/ and prints how the input-line
 * region differs from test/fixtures/screens/<id>/ (no assertion on that diff: a person reads it).
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { stringify } from "yaml";
import { bedrockConnected } from "../src/brain.ts";
import { defaults, loadConfig, type Config } from "../src/config.ts";
import { HARNESS_INFO, HARNESSES, type Harness } from "../src/harnesses.ts";
import { loadSecrets, maskSecrets, parseEnv, secret, useSecrets } from "../src/secrets.ts";
import { HARNESS_WORD } from "../src/sessions.ts";
import { versionOf } from "../src/status.ts";
import { GuardedDriver, inputHolds, LoginScreenError, onPath, PromptCapError, scrubEnv, TmuxDriver, type Launch } from "./live-driver.ts";
import {
  awsRegion, BINARY, CHECKED_HARNESSES, bucketOf, cheapestModel, costFigure, DEFAULT_CAPS, DEFAULT_LEDGER, harnessWorstCase, HARNESS_RUN_CAP, HARNESS_TOKENS, parseArgs, pickConn,
  Spend, type Args, type Available, type Bucket, type ConnPick,
} from "./live-lib.ts";

/** The one prompt of a checked launch: the spec the harness is asked to answer. */
const TASK = (agent: string) => `Reply with just OK. Do not read, run or change anything. (${agent})`;

/** One option of the agent choice: its number, whether it's highlighted, harness label, model, effort. */
interface Option {
  n: number;
  on: boolean;
  label: string;
  model: string;
  effort?: string;
}

/** The agent choice's options on screen (`❯ 2. codex × gpt-6 sol × high · recommended`). */
function options(lines: string[]): Option[] {
  const out: Option[] = [];
  for (const l of lines) {
    const m = /^\s*(❯\s*)?(\d)\.\s+(.*?)\s*$/.exec(l);
    if (!m || !m[3]!.includes(" × ")) continue;
    const [label, model, effort] = m[3]!.replace(/ · .*$/, "").split(" × ").map((s) => s.trim());
    out.push({ n: Number(m[2]), on: !!m[1], label: label!, model: model!, ...(effort ? { effort } : {}) });
  }
  return out;
}

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.tsx");
/** Bun's flags from gluon's shebang: Gluon runs exactly as the installed command does. */
const BUN_FLAGS = readFileSync(CLI, "utf8").split(/\r?\n/)[0]!.replace(/^#!.*?\bbun\s+/, "").split(/\s+/).filter(Boolean);
const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];
export const SCREENS_DIR = join(ROOT, "qa/logs/screens");

// ——— keys and AWS, from the dev key file and the AWS setup ———

/**
 * The dev key file's keys (GLUON_DEV_ENV, default the repo's .env), handed to Gluon's secrets (never process.env), after the
 * throwaway config is the one Gluon reads (`GLUON_CONFIG`, set here when it isn't yet). Idempotent. Returns the names of the keys set.
 */
export function loadDevKeys(tmp: string): { names: string[]; file: string } {
  process.env.GLUON_CONFIG ??= join(tmp, "config.yaml");
  loadSecrets();
  const file = process.env.GLUON_DEV_ENV || join(ROOT, ".env");
  const entries = parseEnv(file);
  useSecrets(entries, file);
  return { names: entries.filter(([, v]) => v).map(([k]) => k), file };
}

/** Bedrock's region and profile as the AWS setup says (env, then the AWS config file's profile): `region` null when nothing says. */
export function awsSetupFromHost(env: Record<string, string | undefined> = process.env): { region: string | null; from: string; profile?: string } {
  const file = join(env.HOME || homedir(), ".aws", "config");
  let text: string | null = null;
  try {
    text = existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {}
  const r = awsRegion(env, text);
  return { region: r?.region ?? null, from: r?.from ?? "nothing (no AWS_REGION, AWS_DEFAULT_REGION or profile region)", ...(env.AWS_PROFILE ? { profile: env.AWS_PROFILE } : {}) };
}

/** Which connections a check can use here: the keys loaded, and a Bedrock setup (a region or profile). */
export function availableHere(config: Config): Available {
  return { hasKey: (name) => !!secret(name), bedrock: bedrockConnected(config) };
}

// ——— the plan of one harness check ———

export interface HarnessPlan {
  harness: Harness;
  binary: string | null;
  pick: ConnPick;
  /** The model id on the connection, and its label. */
  model?: { id: string; label: string };
  bucket?: Bucket;
  worst: number;
}

/** What a check of `h` would do (free: reads the catalog, the keys and PATH). */
export function planHarness(h: Harness, config: Config, have: Available, want: { conn?: string; model?: string; campaign?: boolean } = {}): HarnessPlan {
  const binary = onPath(BINARY[h]);
  const pick = pickConn(h, have, want.conn);
  const base = { harness: h, binary, pick, worst: 0 };
  if (!pick.ok) return base;
  const m = cheapestModel(config.models[h], pick.conn, want.model);
  if (!m) return { ...base, pick: { ok: false, why: `no model${want.model ? ` "${want.model}"` : ""} on ${pick.conn}` } };
  return { ...base, model: { id: m.id, label: m.entry.label }, bucket: bucketOf(pick.conn, !!want.campaign), worst: harnessWorstCase(m.id, pick.conn) };
}

// ——— the screen, as Gluon draws it ———

const isSession = (l: string[]) => !!l[0]?.includes("◆ gluon");
const isHome = (l: string[]) => !isSession(l) && /› (describe (the|another) session|reply to the intake agent)/.test(l.join("\n"));
const infoRow = (l: string[]) => (l[1] ?? "").trim();
const shownLabel = (l: string[]) => (isSession(l) ? infoRow(l).split(" × ")[0]! : null);
const awaiting = (l: string[]) => infoRow(l).includes("awaiting your input");
const bar = (l: string[]) => l.at(-1) ?? "";
/** A line that is just OK (after a border, a bullet or a mark): the agent's reply, whatever it draws before it. */
export const saysOK = (lines: string[]) => lines.some((l) => /^[^\p{L}\p{N}]*OK[^\p{L}\p{N}]*$/u.test(l));
const DIALOGS = /do you trust the files|trust this folder|allow codex to work in this folder|hooks need review|trust the contents|workspace trust|choose the text style|security notes/i;

/**
 * The proposal's mode as the harness's own option row says it: every row ends ` · explore` / ` · plan` (`· explore (plan mode)` where the
 * harness does it another way), and build shows nothing (`proposalOptions`, `modeWord`). Null when the row isn't on screen. Never read from
 * the rest of the screen: Antigravity's explore note says "plan mode" and made a whole-screen reading land on plan (BUG-665).
 */
export function proposalMode(lines: string[], label: string): "build" | "explore" | "plan" | null {
  for (const l of lines) {
    const m = /^\s*(?:❯\s*)?\d\.\s+(.*?)\s*$/.exec(l);
    if (!m || !m[1]!.includes(" × ") || m[1]!.split(" × ")[0]!.trim().toLowerCase() !== label.toLowerCase()) continue;
    return (/ · (explore|plan)\b/.exec(m[1]!)?.[1] as "explore" | "plan" | undefined) ?? "build";
  }
  return null;
}

export interface Assertion {
  harness: string;
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

export interface HarnessOutcome {
  asserts: Assertion[];
  /** Dollars charged to the ledger for this check. */
  charged: number;
  /** The cap refused it (nothing ran). */
  refused: boolean;
}

export interface HarnessRunOptions {
  spend: Spend;
  conn?: string;
  model?: string;
  home: "scratch" | "real";
  /** Save the screens and print the fixture diff (`--tier=harness`). */
  screens: boolean;
  /** `--caps` was given: OpenRouter is its own sub-bucket. */
  campaign?: boolean;
  /** How long an agent may take to answer (a launch, a turn). */
  turnMs?: number;
  /** Extra environment for Gluon (only `FAKE_*` and the allowlist get through `scrubEnv`): a test's fake agent. */
  env?: Record<string, string>;
  say(line: string): void;
  /** Scenarios (the QA campaign's live runs; nothing in the tiers sets these): the launch's mode (`ctrl+t` on the proposal), the demo task's text, the guard's prompt cap. */
  mode?: "build" | "explore" | "plan";
  task?: string;
  maxPrompts?: number;
  /** false: skip the standard checks after the frame shows the agent; `scenario` runs at once. */
  standard?: boolean;
  /** Called with the scratch world before Gluon starts (an agent's own scratch state: a recent model, a setting). */
  prepare?(w: { scratch: string; home: string; repo: string; cfgDir: string; bin: string }): void;
  /** Called with the running session after the standard checks (or at once, `standard: false`). */
  scenario?(c: ScenarioCtx): Promise<void>;
}

/** What a scenario gets: the guarded driver and its helpers, in the scratch world of one check. */
export interface ScenarioCtx {
  h: Harness;
  label: string;
  version: string;
  plan: HarnessPlan;
  d: GuardedDriver;
  tmux: TmuxDriver;
  lines(): Promise<string[]>;
  until(pred: (l: string[]) => boolean, ms: number, every?: number): Promise<boolean>;
  answerDialog(l: string[]): Promise<boolean>;
  saveScreen(name: string): Promise<void>;
  say(s: string): void;
  add(name: string, status: Assertion["status"], detail: string): void;
  scratch: string;
  home: string;
  repo: string;
  screensOut: string;
  /** Adds dollars the scenario spent beyond the launch (a second session, say). */
  charge(usd: number, what: string): void;
  /** Replaces what the whole check is charged (a scenario that knows the figure of its sessions). */
  setCharged(usd: number): void;
  /** How Gluon was started (to start it again on the same scratch world: `gluon resume`). */
  launch: Launch;
}

/** A fresh temp repo: one commit, a tiny package. */
function makeRepo(dir: string): string {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{ "name": "tiny", "scripts": { "test": "bun test" } }\n');
  writeFileSync(join(repo, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=live", "-c", "user.email=live@localhost", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env: process.env });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "Initial commit");
  return repo;
}

/** Gluon's throwaway config for one check: the harness on one API-key connection, asking before /clear ends a session. */
export function checkConfig(h: Harness, conn: string, aws: { region: string | null; profile?: string }): string {
  const connection = h === "opencode" ? { auth: "api", providers: [conn] } : { auth: "api", provider: conn };
  return stringify({
    handoff: { on_clear: "ask" },
    connections: { [h]: connection },
    ...(conn === "bedrock" && (aws.region || aws.profile) ? { bedrock: { ...(aws.region ? { region: aws.region } : {}), ...(aws.profile ? { profile: aws.profile } : {}) } } : {}),
  });
}

/** The newest fixture file of a harness (`test/fixtures/screens/<id>/<version>.json`), or null. */
export function newestFixture(h: Harness, dir = join(ROOT, "test/fixtures/screens")): { version: string; file: string } | null {
  const d = join(dir, h);
  if (!existsSync(d)) return null;
  const versions = readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const v = versions.at(-1);
  return v ? { version: v, file: join(d, `${v}.json`) } : null;
}

/** The last `n` non-empty content rows of a screen (the strip, the info row and the bar are not content): where the agent's input line is. */
export function inputRegion(rows: string[], n = 6): string[] {
  const body = rows.map((r) => r.replace(/\s+$/, ""));
  while (body.length && !body.at(-1)) body.pop();
  return body.filter((r) => r.trim()).slice(-n);
}

/** A short text on how two input-line regions differ (lines only in one of them); no verdict. */
export function regionDiff(live: string[], fixture: string[]): string {
  const norm = (s: string) => s.trim();
  const a = new Set(live.map(norm));
  const b = new Set(fixture.map(norm));
  const onlyLive = live.filter((l) => !b.has(norm(l)));
  const onlyFixture = fixture.filter((l) => !a.has(norm(l)));
  if (!onlyLive.length && !onlyFixture.length) return `same ${live.length} lines`;
  const show = (ls: string[]) => ls.slice(0, 6).map((l) => `      ${JSON.stringify(l.trim().slice(0, 100))}`).join("\n");
  return [`${live.length - onlyLive.length} of ${live.length} live lines are in the fixture`, onlyLive.length ? `    only live (${onlyLive.length}):\n${show(onlyLive)}` : "", onlyFixture.length ? `    only fixture (${onlyFixture.length}):\n${show(onlyFixture)}` : ""].filter(Boolean).join("\n");
}

/**
 * One harness's check. Returns its assertions; never throws for a harness problem (a screen that isn't as expected is a FAIL, a
 * sign-in screen a SKIP). `plan` is what `planHarness` said.
 */
export async function checkHarness(plan: HarnessPlan, config: Config, o: HarnessRunOptions): Promise<HarnessOutcome> {
  const h = plan.harness;
  const label = HARNESS_WORD[h];
  const asserts: Assertion[] = [];
  const say = (s: string) => o.say(maskSecrets(s));
  const add = (name: string, status: Assertion["status"], detail: string) => {
    asserts.push({ harness: h, name, status, detail });
    say(`${status.padEnd(4)} ${h} · ${name}${detail ? `: ${detail}` : ""}`);
  };
  if (!plan.pick.ok) {
    add("launch", "SKIP", plan.pick.why);
    return { asserts, charged: 0, refused: false };
  }
  if (!plan.binary || !plan.model || !plan.bucket) {
    add("launch", "SKIP", plan.binary ? "no model" : `${BINARY[h]} is not on PATH`);
    return { asserts, charged: 0, refused: false };
  }
  const conn = plan.pick.conn;
  const what = `real-harness ${h} (${conn})`;
  if (!o.spend.allowUsd(plan.bucket, what, plan.model.id, plan.worst)) {
    add("launch", "SKIP", `refused, over a cap: ${o.spend.run.refused.at(-1)}`);
    return { asserts, charged: 0, refused: true };
  }
  const turnMs = o.turnMs ?? 180_000;
  const aws = awsSetupFromHost();
  // ——— the scratch world ———
  const scratch = mkdtempSync(join(tmpdir(), `gluonlive-${h}-`));
  chmodSync(scratch, 0o700);
  const home = o.home === "real" ? process.env.HOME || homedir() : join(scratch, "home");
  mkdirSync(join(scratch, "home"), { recursive: true });
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const target = realpathSync(plan.binary);
  symlinkSync(target, join(bin, BINARY[h]));
  symlinkSync(process.execPath, join(bin, "bun"));
  try {
    if (/^#!.*\bnode\b/.test(readFileSync(target, "utf8").slice(0, 200))) {
      const node = onPath("node");
      if (node) symlinkSync(realpathSync(node), join(bin, "node"));
    }
  } catch {}
  // Bedrock's credentials come from the user's AWS files: the one directory linked in, nothing else of HOME.
  if (o.home === "scratch" && conn === "bedrock" && existsSync(join(homedir(), ".aws"))) symlinkSync(join(homedir(), ".aws"), join(scratch, "home", ".aws"));
  const repo = makeRepo(scratch);
  const cfgDir = join(scratch, "cfg");
  mkdirSync(cfgDir, { mode: 0o700 });
  const yaml = checkConfig(h, conn, aws);
  writeFileSync(join(cfgDir, "config.yaml"), yaml, { mode: 0o600 });
  if (plan.pick.key) writeFileSync(join(cfgDir, ".env"), `${plan.pick.key}=${secret(plan.pick.key)}\n`, { mode: 0o600 });
  writeFileSync(join(cfgDir, "probes.json"), "{}");
  o.prepare?.({ scratch, home, repo, cfgDir, bin });
  // The demo brain never fetches price tables (`refreshAllowed`), so the figures would show `—`: build them here, in the scratch HOME,
  // with the official `gluon pricing update` (free: models.dev, OpenRouter's listing and the installed binary), before Gluon starts.
  const pricing = Bun.spawnSync([process.execPath, ...BUN_FLAGS, CLI, "pricing", "update"], {
    cwd: repo,
    env: { PATH: [bin, ...SYSTEM_PATH].join(delimiter), HOME: home, USER: process.env.USER ?? "", LANG: "C.UTF-8", GLUON_CONFIG: join(cfgDir, "config.yaml") },
    timeout: 90_000,
  });
  say(`  pricing update: ${pricing.stdout.toString().trim().split("\n").join("; ") || `exit ${pricing.exitCode}`}`);
  const launch: Launch = {
    mode: "real",
    cols: 100,
    rows: 30,
    cwd: repo,
    argv: [process.execPath, ...BUN_FLAGS, CLI, "--demo"],
    env: scrubEnv({ PATH: [bin, ...SYSTEM_PATH].join(delimiter), HOME: home, USER: process.env.USER, LOGNAME: process.env.LOGNAME, SHELL: process.env.SHELL, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8", GLUON_CONFIG: join(cfgDir, "config.yaml"), GLUON_TEST_PROBES: join(cfgDir, "probes.json"), ...o.env }),
    yaml,
    fakes: [],
    alt: [],
    agents: [BINARY[h]],
    scratch: [scratch],
    homeKey: "ctrlBackslash",
    homeKeyLabel: "ctrl+\\",
    userConfig: false,
  };
  const version = (await versionOf(h)) ?? "unknown";
  say(`${h} ${version} · ${conn} · ${plan.model.label} (${plan.model.id}) · worst case $${plan.worst.toFixed(4)} · HOME ${o.home}`);

  let tmux: TmuxDriver;
  try {
    tmux = await TmuxDriver.start(launch, { socket: `gluonlive-${h}-${process.pid}`, startMs: 60_000 });
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    add("Gluon starts", "FAIL", (e as Error).message.split("\n")[0]!);
    return { asserts, charged: 0, refused: false };
  }
  let aborted: string | null = null;
  let abortScreen = "";
  const d = new GuardedDriver(tmux, { maxPrompts: o.maxPrompts ?? 1, onAbort: (why) => {
      aborted = why;
      // The screen that made it stop, kept before the server goes (`--tier=harness` saves it).
      const cap = tmux.tmux(["capture-pane", "-p", "-t", `${tmux.session}:0.0`]);
      if (cap.code === 0) abortScreen = cap.out;
      void tmux.close();
    } });
  d.watch(300);
  const lines = async () => (await d.screen()).lines;
  const until = async (pred: (l: string[]) => boolean, ms: number, every = 200) => {
    for (const end = Date.now() + ms; ; ) {
      if (pred(await lines())) return true;
      if (Date.now() >= end) return false;
      await d.wait(every);
    }
  };
  const screensOut = join(SCREENS_DIR, `${h}-${version}`);
  const saveScreen = async (name: string) => {
    if (!o.screens || aborted) return;
    mkdirSync(screensOut, { recursive: true });
    const text = maskSecrets((await lines()).join("\n").replace(/\s+$/gm, ""));
    writeFileSync(join(screensOut, `${name}.txt`), text + "\n");
    const ansi = tmux.tmux(["capture-pane", "-p", "-e", "-N", "-t", `${tmux.session}:0.0`]);
    if (ansi.code === 0) writeFileSync(join(screensOut, `${name}.ansi`), maskSecrets(ansi.out));
  };
  const answered = new Set<string>();
  let escs = 0;
  let trustAll = 0;
  /** Answers a first-run trust dialog (the repo and HOME are throwaway) with its yes option; true when it did. */
  const answerDialog = async (l: string[]) => {
    const update = l.find((x) => /update available/i.test(x));
    if (update && l.some((x) => /esc skip/i.test(x)) && !answered.has(update.trim())) {
      answered.add(update.trim());
      await d.keys(["esc"]);
      return true;
    }
    // Codex's hook list: `t` trusts them all, esc closes it.
    if (l.some((x) => /t trust all · enter review · esc close/.test(x)) && trustAll++ < 3) {
      say("  dialog: hooks list → t, esc");
      await tmux.type("t");
      await d.wait(500);
      await tmux.keys(["esc"]);
      return true;
    }
    // Codex's per-hook review (it comes up mid-turn on a fresh HOME; one-time per hook): `t` trusts it.
    const hook = l.find((x) => /^\W*›?\s*\[!\]\s*Hook \d+/.test(x.replace(/^[│\s]+/, "")));
    if (hook && l.some((x) => /t trust · esc back/.test(x)) && !answered.has(`hook:${hook.trim()}`)) {
      answered.add(`hook:${hook.trim()}`);
      say(`  dialog: ${hook.replace(/[│\s]+/g, " ").trim().slice(0, 60)} → t`);
      await tmux.type("t");
      return true;
    }
    if (l.some((x) => /space\/enter toggle · esc back/.test(x)) && escs++ < 5) {
      say("  dialog: hook trusted → esc");
      await tmux.keys(["esc"]);
      return true;
    }
    const dialog = l.find((x) => DIALOGS.test(x));
    if (!dialog || answered.has(dialog.trim())) return false;
    answered.add(dialog.trim());
    // Claude Code's first-run theme chooser and security notes (a scratch HOME is always a first run): Enter takes the default.
    if (/choose the text style|security notes/i.test(dialog)) {
      say(`  dialog: ${dialog.trim().slice(0, 90)} → enter`);
      await tmux.keys(["enter"]);
      return true;
    }
    const selected = l.findIndex((x) => /❯/.test(x));
    const yes = l.findIndex((x) => /\byes\b.*trust|trust.*\byes\b/i.test(x));
    const moves: ("up" | "down")[] = selected >= 0 && yes >= 0 && /no,? exit/i.test(l[selected]!) ? Array(Math.abs(yes - selected)).fill(yes > selected ? "down" : "up") : [];
    say(`  dialog: ${dialog.trim().slice(0, 90)} → ${[...moves, "enter"].join(" ")}`);
    // Straight to tmux: an arrow in a session would make the guard's model of the line dirty, and a dialog's Enter is not a prompt.
    await tmux.keys([...moves, "enter"]);
    return true;
  };

  let figure: { usd: number; approx: boolean } | null = null;
  let sentPrompt = false;
  let scenarioSpend = 0;
  let chargedOverride: number | null = null;
  try {
    // ——— the demo's question and proposal, then the harness's own option on its cheapest model ———
    await d.type(o.task ?? TASK(BINARY[h]));
    await d.keys(["enter"]);
    if (!(await until((l) => l.join(" ").replace(/\s+/g, " ").includes("Should the fix include"), 30_000))) throw new Error("the demo's question didn't show");
    await d.wait(1500);
    await d.keys(["down", "enter"]); // "Just the fix"
    if (!(await until((l) => l.some((x) => x.includes("keep talking")), 30_000))) throw new Error("the agent choice didn't show");
    await d.wait(1200);
    const mine = () => lines().then((l) => options(l).find((x) => x.label.toLowerCase() === label) ?? null);
    if (!(await mine())) {
      await d.type(`use ${h} please`);
      await d.keys(["enter"]);
      await until((l) => l.join(" ").includes("cheaper setup") && l.some((x) => x.includes("keep talking")), 30_000);
      await d.wait(1200);
    }
    if (!(await mine())) throw new Error(`the proposal doesn't offer ${label}: ${options(await lines()).map((x) => `${x.label} × ${x.model}`).join("; ") || "no options"}`);
    // Each key is followed by a pause so the row has been redrawn when it is read (a read in between picked the dearest model once).
    const press = async (k: "down" | "tab" | "shiftTab") => {
      await d.keys([k]);
      await d.wait(400);
    };
    for (let i = 0; i < 6 && !(await mine())?.on; i++) await press("down");
    const wanted = [plan.model.label, plan.model.id].map((s) => s.toLowerCase());
    const showsWanted = (m?: string) => !!m && wanted.some((w) => m.toLowerCase().includes(w) || w.includes(m.toLowerCase()));
    const first = await mine();
    if (!first) throw new Error("the option is gone");
    // Tab cycles the models (it wraps): to the one planned; failing that, the cheapest by name.
    const seen = [first.model];
    for (let i = 0; i < 12 && !showsWanted((await mine())?.model); i++) {
      await press("tab");
      const m = (await mine())?.model;
      if (!m || (seen.includes(m) && !showsWanted(m))) break;
      seen.push(m);
    }
    let chosen = (await mine())!;
    // Never launch another model than the planned one: its worst case is what the cap was checked against (a dearer one cost $0.22).
    if (!showsWanted(chosen.model)) throw new Error(`${plan.model.label} wasn't among the offered models (${seen.join(", ")}): nothing launched`);
    // The lowest effort the row offers (Shift+Tab cycles).
    const efforts = [chosen.effort].filter((e): e is string => !!e);
    if (efforts.length) {
      const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
      for (let i = 0; i < 8; i++) {
        await press("shiftTab");
        const e = (await mine())?.effort;
        if (!e || e === efforts[0]) break;
        efforts.push(e);
      }
      const low = efforts.reduce((x, y) => ((order.indexOf(y) + 1 || 99) < (order.indexOf(x) + 1 || 99) ? y : x));
      for (let i = 0; i < 8 && (await mine())?.effort !== low; i++) await press("shiftTab");
      chosen = (await mine())!;
    }
    if (o.mode) {
      // Ctrl+T cycles the whole proposal's mode (build, explore, plan, build: from any mode two presses reach any other); the harness's own
      // row says which one it is on. Never a key beyond the switch: when the mode isn't reached in three presses, nothing launches.
      let shown = proposalMode(await lines(), label);
      for (let i = 0; i < 3 && shown !== o.mode; i++) {
        await d.keys(["ctrlT"]);
        await d.wait(500);
        shown = proposalMode(await lines(), label);
      }
      if (shown !== o.mode) throw new Error(`the proposal shows ${shown ?? "no row for " + label} mode, not ${o.mode}: nothing launched`);
      await saveScreen("proposal");
    }
    say(`  launching ${chosen.label} × ${chosen.model}${chosen.effort ? ` × ${chosen.effort}` : ""}`);
    await d.keys(["enter"]); // the launch: its spec is the one prompt
    sentPrompt = true;
    const inFrame = await until((l) => shownLabel(l) === label, 30_000);
    add("Gluon's frame shows the agent", inFrame ? "PASS" : "FAIL", inFrame ? `${label}'s session in the frame` : `no session view; shown: ${shownLabel(await lines()) ?? "home"}`);
    if (!inFrame) throw new Error("no session");

    if (process.env.GLUON_LIVE_DEBUG) {
      await d.wait(3000);
      say(debugEnv(repo));
    }

    if (o.standard !== false) {
      // ——— status: working, then awaiting after the reply ———
      let working = false;
      let replied = false;
      let idleSince = 0;
      for (const end = Date.now() + turnMs; Date.now() < end; ) {
        const l = await lines();
        if (isSession(l) && !awaiting(l)) working = true;
        if (await answerDialog(l)) continue;
        replied = saysOK(l);
        idleSince = awaiting(l) ? idleSince || Date.now() : 0;
        // Done once it awaits with its reply on screen; awaiting for 15 s with no reply is an answer too (no OK).
        if (working && awaiting(l) && (replied || Date.now() - idleSince > 15_000)) break;
        await d.wait(500);
      }
      const now = await lines();
      const done = awaiting(now);
      add("status goes working → awaiting", working && done ? "PASS" : "FAIL", `${working ? "saw working" : "never saw working"}; ${done ? "awaiting your input" : `not awaiting after ${turnMs / 1000} s: ${infoRow(now).slice(0, 100)}`}`);
      add('the agent answered "OK"', replied ? "PASS" : "FAIL", replied ? "a line that is just OK is on screen" : "no OK line on screen");
      await saveScreen("session");

      // ——— the reader finds the input line: a typed /clear makes Gluon ask ———
      if (done) {
        // A review dialog the agent opens after its turn (Codex's hooks) would take the typed text: answer what is there first.
        for (let i = 0; i < 8 && (await answerDialog(await lines())); i++) await d.wait(800);
        await d.type("/clear");
        // A slow agent draws the typed text late (OpenCode showed "/cle" for seconds): Enter only once the whole word is on a line of its own.
        const typed = await until((l) => inputHolds(l, "/clear"), 10_000);
        let asked = false;
        try {
          await d.keys(["enter"]);
          asked = await until((l) => /^ \? (\/\S+ ends this session|End (this )?session\?)/.test(bar(l)), 8000);
        } catch (e) {
          if (!(e instanceof PromptCapError)) throw e;
        }
        add("the reader finds the input line (/clear asks first)", asked ? "PASS" : "FAIL", asked ? bar(await lines()).trim().slice(0, 100) : `no question in the bottom bar after typing /clear + Enter (${typed ? "the line held /clear" : "the typed text never showed in full"})`);
        await saveScreen("clear-question");
        if (asked) await d.keys(["esc"]);
        await d.keys(Array<"backspace">(6).fill("backspace"));
        await d.wait(300);
      } else add("the reader finds the input line (/clear asks first)", "SKIP", "the agent never reached awaiting");

      // ——— return to Gluon and back ———
      await d.keys(["ctrlBackslash", "ctrlBackslash"]); // the home key is a prefix: twice goes home
      const home1 = await until(isHome, 5000);
      await saveScreen("home");
      let back = false;
      if (home1) {
        await d.keys(["enter"]);
        back = await until((l) => shownLabel(l) === label, 5000);
      }
      add("return to Gluon (home key) and back (Enter)", home1 && back ? "PASS" : "FAIL", home1 ? (back ? "home view, then the session again" : "home view, but Enter didn't return to the session") : "no home view after the home key twice");

      // ——— the cost figure ———
      for (const end = Date.now() + 60_000; Date.now() < end && !figure; ) {
        figure = costFigure(infoRow(await lines()));
        if (!figure) await d.wait(1000);
      }
      add("the cost figure is shown", figure ? "PASS" : "FAIL", figure ? `${figure.approx ? "~" : ""}$${figure.usd} on the info row` : `none on the info row: ${infoRow(await lines()).slice(0, 110)}`);
      if (figure) add("the spend is within the check's token budget", figure.usd <= plan.worst ? "PASS" : "FAIL", `$${figure.usd} against a budget of $${plan.worst.toFixed(4)} (${HARNESS_TOKENS.input} in / ${HARNESS_TOKENS.output} out)`);
      await saveScreen("final");
      if (o.screens) await printFixtureDiff(h, version, (await lines()), say);
    }
    if (o.scenario) {
      let extra = 0;
      await o.scenario({
        h, label, version, plan, d, tmux, lines, until, answerDialog, saveScreen, say, add, scratch, home, repo, screensOut, launch,
        setCharged: (usd) => (chargedOverride = usd),
        charge: (usd, what) => {
          extra += usd;
          say(`  scenario spend ${what}: $${usd.toFixed(4)}`);
        },
      });
      scenarioSpend = extra;
      // Gluon's own cumulative figure for the session, if it is still on screen.
      if (!figure) figure = await lines().then((l) => costFigure(infoRow(l))).catch(() => null);
    }
  } catch (e) {
    if (aborted || e instanceof LoginScreenError) {
      // A sign-in screen came before any model call: nothing was spent, nothing is charged.
      sentPrompt = false;
      add("launch", "SKIP", `needs a sign-in, stopped: ${aborted ?? (e as Error).message}`);
      if (o.screens && abortScreen) {
        mkdirSync(screensOut, { recursive: true });
        writeFileSync(join(screensOut, "signin-stop.txt"), maskSecrets(abortScreen.replace(/\s+$/gm, "")) + "\n");
      }
    }
    else {
      add("launch", "FAIL", (e as Error).message.split("\n")[0]!);
      await saveScreen("failure").catch(() => {});
      const s = await tmux.screen().then((x) => x.lines.join("\n").replace(/\s+$/gm, "")).catch(() => "");
      if (s) say(maskSecrets(s.split("\n").map((x) => `      | ${x}`).join("\n")));
    }
  } finally {
    // `--tier=harness`: keep Gluon's own state of this run (the cost audit's counts and model names, the price tables) beside the screens, before the driver removes the scratch directory.
    if (o.screens && o.home === "scratch") {
      try {
        const st = join(scratch, "home/.local/state/gluon");
        if (existsSync(st)) cpSync(st, join(screensOut, "state"), { recursive: true, filter: (src) => !/analytics\.db/.test(src) });
      } catch {}
    }
    await d.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
  // ——— the ledger: Gluon's figure, else the worst case (an upper estimate); nothing when no prompt went out ———
  let charged = 0;
  if (sentPrompt) {
    charged = chargedOverride ?? (figure ? figure.usd : plan.worst) + scenarioSpend;
    o.spend.chargeUsd(plan.bucket, what, plan.model.id, charged, 0, 0, true);
    say(`  spend $${charged.toFixed(4)} (${figure ? "Gluon's figure" : "no figure: the worst case"}) → ${plan.bucket}`);
  }
  return { asserts, charged, refused: false };
}

/** `GLUON_LIVE_DEBUG=1`: the names and the non-secret values of the harness-related variables of every process running in `repo`, to see what a launch really handed its agent. */
function debugEnv(repo: string): string {
  const out: string[] = [];
  for (const pid of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try {
      if (realpathSync(`/proc/${pid}/cwd`) !== realpathSync(repo)) continue;
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
      out.push(`  pid ${pid} ${cmd}: ${env.filter((e) => /^(OTEL_|CLAUDE_|ANTHROPIC_|AWS_REGION|KIMI_|OPENCODE_|CODEX_|GLUON_|OPENROUTER_)/.test(e)).map((e) => (/KEY|TOKEN|HEADERS|SECRET/.test(e.split("=")[0]!) ? `${e.split("=")[0]}=<set>` : e.slice(0, 140))).join(" | ")}`);
    } catch {}
  }
  return out.join("\n") || "  (no process in the repo)";
}

/** Prints how the live input-line region differs from the newest fixture's idle screen. */
async function printFixtureDiff(h: Harness, version: string, live: string[], say: (s: string) => void): Promise<void> {
  const fx = newestFixture(h);
  if (!fx) return say(`  fixture diff: test/fixtures/screens/${h}/ has no capture`);
  const fixture = JSON.parse(readFileSync(fx.file, "utf8")) as { states: { name: string; rows: { text: string }[] }[] };
  const state = fixture.states.find((s) => s.name === "idle") ?? fixture.states[0];
  if (!state) return say(`  fixture diff: ${h}/${fx.version}.json has no states`);
  const region = inputRegion(live.slice(2, -1));
  const there = inputRegion(state.rows.map((r) => r.text));
  say(`  input-line region, live ${version} vs fixture ${fx.version} (${state.name})${fx.version === version ? "" : " (versions differ)"}:\n    ${regionDiff(region, there)}`);
}

// ——— the section ———

/** The harnesses a section covers: `only` (one), else every checked one. Grok Build is listed as skipped. */
export function harnessesFor(only?: string): Harness[] {
  if (!only) return [...CHECKED_HARNESSES];
  if (!(HARNESSES as readonly string[]).includes(only)) throw new Error(`--harness: ${only} is not one of ${HARNESSES.join(", ")}`);
  return [only as Harness];
}

/** Runs the section; returns every assertion. Prints PASS / FAIL / SKIP lines through `say`. */
export async function runHarnessSection(o: HarnessRunOptions & { harness?: string }, config: Config = loadConfig()): Promise<{ asserts: Assertion[]; refused: boolean }> {
  const have = availableHere(config);
  const asserts: Assertion[] = [];
  let refused = false;
  if (!o.harness) o.say("grok-build: SKIP · Grok Build has no API-key route (its xAI plan needs a sign-in)");
  for (const h of harnessesFor(o.harness)) {
    const plan = planHarness(h, config, have, { conn: o.conn, model: o.model, campaign: o.campaign });
    const r = await checkHarness(plan, config, o);
    asserts.push(...r.asserts);
    refused ||= r.refused;
    if (r.refused) break; // a cap: the rest would be refused too (the worst cases only grow)
  }
  return { asserts, refused };
}

/** `PASS n · FAIL n · SKIP n`, and the exit code: 1 on a FAIL, 2 when only a cap stopped it. */
export function verdict(asserts: Pick<Assertion, "status">[], refused: boolean): { line: string; code: number } {
  const n = (s: string) => asserts.filter((a) => a.status === s).length;
  return { line: `PASS ${n("PASS")} · FAIL ${n("FAIL")} · SKIP ${n("SKIP")}${refused ? " · a cap stopped the run before it finished" : ""}`, code: n("FAIL") ? 1 : refused ? 2 : 0 };
}

// ——— standalone: bun scripts/live-harness.ts --harness=<id> … ———

if (import.meta.main) {
  const a: Args = parseArgs(["--tier=harness", ...process.argv.slice(2).filter((x) => !x.startsWith("--home"))]);
  const home = process.argv.find((x) => x.startsWith("--home="))?.slice("--home=".length) === "real" ? "real" : "scratch";
  const tmp = mkdtempSync(join(tmpdir(), "gluon-live-"));
  process.env.GLUON_CONFIG = join(tmp, "config.yaml");
  delete process.env.GLUON_TEST_PROBES;
  const keys = loadDevKeys(tmp);
  const aws = awsSetupFromHost();
  const { saveConfig } = await import("../src/config.ts");
  if (aws.region || aws.profile) saveConfig([[["bedrock"], { ...(aws.region ? { region: aws.region } : {}), ...(aws.profile ? { profile: aws.profile } : {}) }]]);
  const config = loadConfig();
  const campaign = !!a.caps;
  const spend = new Spend(resolve(a.ledger ?? join(ROOT, DEFAULT_LEDGER)), a.caps ?? DEFAULT_CAPS, HARNESS_RUN_CAP, campaign, !a.dryRun);
  console.log(`keys present: ${keys.names.join(", ") || "none"} (${keys.file}) · AWS region: ${aws.region ?? "none"} (${aws.from})`);
  try {
    if (a.dryRun) {
      const p = planHarness(a.harness as Harness, config, availableHere(config), { conn: a.conn, model: a.model, campaign });
      console.log(p.pick.ok ? `${p.harness}: ${p.pick.conn} · ${p.model?.label ?? "no model"} · worst case $${p.worst.toFixed(4)}${p.binary ? "" : ` · ${BINARY[p.harness]} is not on PATH`}` : `${p.harness}: skipped · ${p.pick.why}`);
    } else {
      const r = await runHarnessSection({ spend, campaign, ...(a.conn ? { conn: a.conn } : {}), ...(a.model ? { model: a.model } : {}), home, screens: true, harness: a.harness, say: (s) => console.log(s) }, config);
      const v = verdict(r.asserts, r.refused);
      console.log(`\n${v.line}`);
      process.exitCode = v.code;
    }
  } finally {
    spend.save();
    rmSync(tmp, { recursive: true, force: true });
  }
}
