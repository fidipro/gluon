// Gluon itself, loaded by cli.tsx after startup.ts (before anything that may spawn).
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { codexEnvWarnings } from "./agent/codex.ts";
import { subscriptionEnvWarnings } from "./agent/subscription.ts";
import { gitQuery } from "./agent/git.ts";
import { repoContext } from "./agent/prompt.ts";
import { Analytics } from "./analytics.ts";
import { runSetup } from "./auth.ts";
import { activeStep, chooseBrain } from "./brain.ts";
import { ConfigError, configPath, connsOf, defaults, HARNESSES, loadConfig, type Config, type Effort, type Harness } from "./config.ts";
import { binPath, cleanStaleSpecs, installed, missingReason } from "./detect.ts";
import { doctor, showBrain } from "./doctor.ts";
import { harnessNamed, installCommand } from "./install.ts";
import { HARNESS_INFO, MODES, PERMISSIONS, type Mode, type Permissions } from "./harnesses.ts";
import { BINARIES, buildCommand, findAgent, handOff, launchProblem, typedModeProblem, validateChoice, type Command, type LaunchChoice } from "./launchers.ts";
import { versionProblem } from "./status.ts";
import { CLI_OPTIONS, HINT_COMMANDS, SUBCOMMANDS, usageText } from "./usage.ts";
import { allRouteCatalog, optedInBy } from "./intake.ts";
import { offeredAgents } from "./models.ts";
import { DEFAULT_ROUTING_YAML, loadRouting, predatesDefault, RoutingError, routingPath } from "./routing-config.ts";
import { checkConfig, type Config as RoutingConfig } from "./routing.ts";
import { loadSecrets, maskSecrets, maskValue, SECRET_ENV } from "./secrets.ts";
import { repoLabel } from "./ui/layout.ts";
import { Cancelled, pick } from "./ui/signin.tsx";
import { makeTheme, queryBackground, queryTerminal, type Theme } from "./ui/theme.ts";
import { claimWorkspace, deleteWorkspace, describeWorkspace, findWorkspace, liveOwner, localTime, sameDir, scanWorkspaces, type Workspace } from "./workspaces.ts";

const fail = (message: string, code = 2): never => {
  console.error(`gluon: ${message}`);
  process.exit(code);
};

// A relative GLUON_CONFIG is fixed against the cwd once, before anything reads the keys next to it: otherwise its `.env` is
// whatever the repository has, and a later chdir (a resume) names other files (BUG-621; BUG-291 did it for `resume` only).
if (process.env.GLUON_CONFIG) process.env.GLUON_CONFIG = resolve(process.env.GLUON_CONFIG);
loadSecrets();

/**
 * A word starting with "-" that has a space in it (a markdown bullet, `--help me`) can't be an option: it is prompt text. Only such words are
 * taken out (a NUL-led placeholder, which no argv holds, stands in for each); every other word still parses as a flag, before or after them,
 * and an explicit `--` ends the options as ever (BUG-599). `restore` puts the words back into what `parseArgs` returned.
 */
function promptArgs(args: string[]): { args: string[]; restore: (s: string) => string } {
  const words: string[] = [];
  const end = args.indexOf("--");
  const out = args.map((a, i) => {
    if ((end !== -1 && i >= end) || !/^-[^\s]*\s/.test(a)) return a;
    words.push(a);
    return `\0${words.length - 1}`;
  });
  return { args: out, restore: (s) => s.replace(/\0(\d+)/g, (_, n) => words[Number(n)]!) };
}

// `gluon uninstall --help` and `gluon cost-report --help` print the usage, as `pricing` does (BUG-617). Needs no config (the catalog is built in).
if ((Bun.argv[2] === "uninstall" || Bun.argv[2] === "cost-report") && Bun.argv.slice(3).some((a) => a === "--help" || a === "-h")) {
  console.log(usageText(defaults()));
  process.exit(0);
}

// Needs no config: a broken one mustn't stop an uninstall. Its own arguments: `--yes` is no
// option of anything else (an installer runs only on an explicit "Run it").
if (Bun.argv[2] === "uninstall") {
  const rest = Bun.argv.slice(3);
  if (rest.some((a) => a !== "--yes")) fail(`uninstall takes only --yes: gluon uninstall [--yes]. (To give it as a session, quote it: gluon "${Bun.argv.slice(2).join(" ")}")`);
  const { uninstall } = await import("./uninstall.ts");
  process.exit(uninstall({ yes: rest.length > 0, tty: !!process.stdin.isTTY && !!process.stdout.isTTY }));
}

// `gluon cost-report`: what the audit ledger holds (`src/cost/report.ts`). Needs no config.
if (Bun.argv[2] === "cost-report") {
  if (Bun.argv.length > 3) fail("cost-report takes no arguments: gluon cost-report");
  const [{ ledgerDir, readLedger }, { reportLines }, { tableInfos }] = await Promise.all([import("./cost/ledger-file.ts"), import("./cost/report.ts"), import("./cost/tables.ts")]);
  const dir = ledgerDir();
  console.log(reportLines(readLedger(dir), { tables: tableInfos(), dir }).join("\n"));
  process.exit(0);
}

// `gluon pricing update`: rebuilds the price tables (network prices, installed agents' windows) into Gluon's state dir (`src/cost/pricing-update.ts`). Needs no config.
if (Bun.argv[2] === "pricing") {
  const rest = Bun.argv.slice(3);
  const { pricingUpdate, PRICING_HELP } = await import("./cost/pricing-update.ts");
  if (rest.some((a) => a === "--help" || a === "-h")) {
    console.log(PRICING_HELP);
    process.exit(0);
  }
  if (rest[0] !== "update" || rest.length > 1) fail("pricing takes: gluon pricing update");
  process.exit(await pricingUpdate());
}

// `gluon update [--check]`: installs the latest verified release in place of this binary (`src/update/update.ts`). Needs no config:
// a broken one mustn't stop an update that may fix it.
if (Bun.argv[2] === "update") {
  const { updateCommand } = await import("./update/update.ts");
  process.exit(await updateCommand(Bun.argv.slice(3), { current: pkg.version }));
}

// `gluon stats`: queries the local analytics database (`src/stats.ts`, its own options: the global `delete` is a string). Needs no config.
if (Bun.argv[2] === "stats") {
  const { statsCommand } = await import("./stats.ts");
  process.exit(await statsCommand(Bun.argv.slice(3)));
}

// `--yes` is no option of anything global (an installer runs only on an explicit "Run it"): `gluon sessions --delete <id> --yes` has it, taken out here.
const yes = Bun.argv[2] === "sessions" && Bun.argv.slice(3).includes("--yes");
const prompts = promptArgs(yes ? Bun.argv.slice(2).filter((a) => a !== "--yes") : Bun.argv.slice(2));
let parsed: ReturnType<typeof parse>;
function parse() {
  return parseArgs({ args: prompts.args, allowPositionals: true, options: CLI_OPTIONS });
}
try {
  parsed = parse();
} catch (e) {
  const message = (e as Error).message.split("\n")[0]!.replace(/\. To specify a positional argument.*$/, "");
  const dash = /Unknown option '-(?!-?[\w-]+')/.test(message) ? `\nA prompt that starts with "-" goes after "--":  gluon --launch <harness> --model <m> -- "- the prompt"` : "";
  fail(`${message}${dash}\nSee gluon --help.`);
}
const { values, positionals } = parsed!;
// The prompt words back in (as a positional, or as the value of a string option).
positionals.forEach((p, i) => (positionals[i] = prompts.restore(p)));
for (const [k, v] of Object.entries(values)) if (typeof v === "string") (values as Record<string, unknown>)[k] = prompts.restore(v);

if (values.version) {
  console.log(pkg.version);
  process.exit(0);
}

// A flag given empty is not "not given" (BUG-601); the ones only a launch takes are refused elsewhere, not ignored (BUG-600).
if (!values.help) {
  if (values.launch === "") fail(`--launch needs an agent: gluon --launch <${HARNESSES.join("|")}> --model <m> -- "<prompt>"`);
  if (values.effort === "") fail(`--effort needs a value: gluon --launch <harness> --model <m> --effort <e> -- "<prompt>"`);
  if (!values.launch) {
    const given = (["mode", "model", "effort", "dry-run"] as const).find((f) => values[f] !== undefined);
    if (given) fail(`--${given} goes with --launch`);
  }
}

// Spec files a hard-killed launch left behind (launchPlan).
cleanStaleSpecs();

// Needs no config: a broken one mustn't stop an install.
if (positionals[0] === "install" && !values.launch && !values.help) {
  const unknown = positionals.slice(1).filter((n) => !harnessNamed(n));
  if (unknown.length) fail(`install which agent? ${unknown.join(", ")} isn't one of: ${HARNESSES.map((h) => (HARNESS_INFO[h].binary === h ? h : `${h} (${HARNESS_INFO[h].binary})`)).join(", ")}. (To give it as a session, quote it: gluon "${positionals.join(" ")}")`);
  try {
    process.exit(await installCommand(positionals.slice(1), { tty: !!process.stdin.isTTY && !!process.stdout.isTTY, theme: async () => makeTheme(await queryBackground()) }));
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    console.log("\n  Cancelled.");
    process.exit(130);
  }
}

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) fail(`bad config: ${e.message}`);
    throw e;
  }
}
let config = readConfig();

/** routing.yaml next to the config (written from the default when missing); a file that isn't valid YAML stops Gluon with its path and line. */
function readRouting(): RoutingConfig {
  try {
    return loadRouting();
  } catch (e) {
    if (e instanceof RoutingError) fail(`bad routing.yaml: ${e.message}`);
    throw e;
  }
}

if (values.help) {
  console.log(usageText(config));
  process.exit(0);
}

/** Levenshtein distance, to catch a mistyped subcommand. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** Prints the spec so the developer can copy it when the agent can't start. */
function launchFailed(cmd: Command, choice: LaunchChoice, error: Error): never {
  console.error(`\ngluon: couldn't launch ${cmd.argv[0]}: ${error.message}`);
  console.error(`The spec, to launch by hand:\n\n${choice.spec.trim()}\n`);
  process.exit(127);
}

/** How often a one-shot launch asks the analytics recorder whether a heartbeat is due. */
const ANALYTICS_TICK_MS = 5000;

/** `--launch`: the agent gets the terminal directly (no adapter, no channel back); exits with its code. */
async function launch(choice: LaunchChoice): Promise<never> {
  const { harness } = choice;
  let cmd: Command;
  try {
    cmd = buildCommand(config, choice);
  } catch (e) {
    fail((e as Error).message, 1);
  }
  const problem = launchProblem(config, harness, cmd!.conn) ?? (await versionProblem(harness));
  if (problem) launchFailed(cmd!, choice, new Error(problem));
  if (cmd!.conn === "plan") {
    const warnings = harness === "claude-code" ? subscriptionEnvWarnings() : harness === "codex" ? codexEnvWarnings() : [];
    for (const w of warnings) console.error(`gluon: note: ${w}`);
  }
  // Local analytics (`src/analytics.ts`): the one-shot launch's row, written before the agent starts and ended after it; never a reason to stop.
  const analytics = new Analytics({ enabled: config.analytics });
  const run = await launchRow(analytics, choice, cmd!);
  // The row's heartbeat while the agent runs (a launch over a minute is not "unfinished", BUG-567); `tick` decides whether a write is due.
  const beat = setInterval(() => analytics.tick(), ANALYTICS_TICK_MS);
  beat.unref();
  try {
    const code = await handOff(cmd!);
    clearInterval(beat);
    run?.end({ code, reason: "exit" });
    analytics.close();
    process.exit(code);
  } catch (e) {
    clearInterval(beat);
    run?.end({ code: null, reason: "spawn-failed" });
    analytics.close();
    launchFailed(cmd!, choice, e as Error);
  }
}

/** The `--launch` session's analytics row: where it runs (the repository's name as the home view shows it, its branch) and what was asked. */
async function launchRow(analytics: Analytics, choice: LaunchChoice, cmd: Command) {
  if (!config.analytics) return undefined;
  const cwd = process.cwd();
  let repo = repoLabel(null, cwd);
  let branch: string | null = null;
  try {
    const context = repoContext(cwd);
    branch = context.branch;
    const git = binPath("git");
    if (git && context.isRepo) {
      const r = await gitQuery(git, ["remote", "get-url", "origin"], cwd);
      if (r.code === 0 && r.stdout.trim()) repo = repoLabel(r.stdout.trim(), cwd);
    }
  } catch {}
  return analytics.begin({
    kind: "launch",
    name: "launch",
    cwd,
    repo,
    ...(branch ? { branch } : {}),
    harness: choice.harness,
    model: choice.model,
    ...(choice.effort ? { effort: choice.effort } : {}),
    mode: choice.mode ?? "build",
    conn: cmd.conn ?? "plan",
    spec: choice.spec,
    gluonVersion: pkg.version,
  });
}

/** The setup (or one `connect`); Ctrl+C in any of its menus quits Gluon at once (exit 130). */
async function setup(opts: Parameters<typeof runSetup>[2], theme: Theme): Promise<boolean> {
  try {
    return await runSetup(config, theme, opts);
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    console.log("\n  Setup cancelled.");
    process.exit(130);
  }
}

const needTty = (what: string) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail(`${what} needs an interactive terminal (stdin and stdout must be a TTY).`);
};

// A subcommand with words it doesn't take: say so, rather than start a chat with them as the task.
if (!values.launch && SUBCOMMANDS.includes(positionals[0]!) && positionals[0] !== "install") {
  const [cmd, ...rest] = positionals;
  const takes = cmd === "connect" || cmd === "resume" || cmd === "routing" ? 1 : cmd === "brain" && /^(api|subscription)$/.test(rest[0] ?? "") ? 1 : 0;
  if (rest.length > takes) {
    const usage = cmd === "connect" ? "gluon connect <agent>" : cmd === "resume" ? "gluon resume [<id>]" : cmd === "routing" ? "gluon routing check|path|default" : `gluon ${cmd}`;
    fail(`${cmd} takes ${cmd === "connect" ? "one agent" : cmd === "resume" ? "one id" : cmd === "routing" ? "check, path or default" : "no arguments"}: ${usage}. (To give it as a session, quote it: gluon "${positionals.join(" ")}")`);
  }
}
if (values.all && (values.launch || !["resume", "sessions"].includes(positionals[0]!))) fail("--all goes with `gluon resume` and `gluon sessions`");
if (values.force && (values.launch || !(positionals[0] === "resume" || (positionals[0] === "sessions" && values.delete !== undefined)))) fail("--force goes with `gluon resume` and `gluon sessions --delete <id>`");
if ((values.delete !== undefined || yes) && (values.launch || positionals[0] !== "sessions")) fail("--delete and --yes go with `gluon sessions`");
if (yes && values.delete === undefined) fail("--yes goes with `gluon sessions --delete <id>`");
if (values.delete !== undefined && values.all) fail("--all and --delete don't go together");

// Saved sessions (workspaces.ts). These read files only: no brain, no agent, before the checks below.
const here = (w: Workspace) => sameDir(w.cwd, process.cwd());
const when = (w: Workspace) => localTime(w.updatedAt);

if (!values.launch && positionals[0] === "sessions" && values.delete !== undefined) {
  const { saved, unreadable } = scanWorkspaces();
  const found = findWorkspace(values.delete, saved);
  // A file that can't be read is not listed as a session, but its id deletes it (BUG-638): it would otherwise stay for good.
  const broken = "error" in found ? unreadable.find((id) => id === values.delete!.trim().toLowerCase()) : undefined;
  const ws = "ws" in found ? found.ws : undefined;
  if ("error" in found && broken === undefined) fail(found.error, 1);
  const id = ws?.id ?? broken!;
  const n = ws?.sessions.length ?? 0;
  const what = ws ? `${ws.id} (${ws.name}, ${n} session${n === 1 ? "" : "s"})` : `${id} (a file that can't be read)`;
  // A Gluon that has it open would write it again at its next change: the delete would silently undo itself.
  const openIn = ws && liveOwner(ws);
  if (openIn !== undefined && !values.force) {
    fail(`saved session ${id} is open in another Gluon (process ${openIn}); quit it first, or delete it anyway with: gluon sessions --delete ${id} --force`, 1);
  }
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) fail(`deleting ${what} needs a terminal to ask first; to delete without asking: gluon sessions --delete ${id} --yes`);
    if (!/^y(es)?$/i.test((prompt(`Delete saved session ${what}? [y/N]`) ?? "").trim())) {
      console.log("Nothing deleted.");
      process.exit(0);
    }
  }
  console.log(deleteWorkspace(id) ? `Deleted saved session ${what}.` : `Saved session ${id} was already gone.`);
  process.exit(0);
}

if (!values.launch && positionals[0] === "sessions") {
  const { saved, unreadable } = scanWorkspaces();
  // A file that can't be read (a crash mid-write, a hand edit, a newer build) is named, so it can be deleted by its id (BUG-638).
  const broken = unreadable.map((id) => `? ${id}  can't be read; remove it: gluon sessions --delete ${id}`);
  if (saved.length === 0) {
    console.log(["No saved sessions. A Gluon that launched a session saves it: gluon resume <id> reopens it.", ...broken].join("\n"));
    process.exit(0);
  }
  const mine = saved.filter(here);
  console.log([...[...mine, ...saved.filter((w) => !here(w))].map((w) => `${here(w) ? "*" : " "} ${describeWorkspace(w)}`), ...broken].join("\n"));
  if (mine.length) console.log("\n* is this directory. Reopen one: gluon resume <id>");
  process.exit(0);
}

// `gluon routing check|path|default`: routing.yaml against this build's agents. Reads files only: no brain, no agent.
if (!values.launch && positionals[0] === "routing") {
  const what = positionals[1];
  if (positionals.length !== 2 || (what !== "check" && what !== "path" && what !== "default")) fail("routing takes check, path or default: gluon routing check | gluon routing path | gluon routing default");
  if (what === "default") {
    process.stdout.write(DEFAULT_ROUTING_YAML);
    process.exit(0);
  }
  if (what === "path") {
    console.log(routingPath());
    process.exit(0);
  }
  const mine = readRouting();
  const problems = [...checkConfig(mine, allRouteCatalog(config)), ...[predatesDefault(mine)].filter((p): p is string => !!p)];
  console.log(problems.length ? [`${routingPath()}: ${problems.length} problem${problems.length === 1 ? "" : "s"}`, ...problems.map((p) => `  ${p}`)].join("\n") : `${routingPath()}: ok`);
  process.exit(problems.length ? 1 : 0);
}

/** `gluon resume [id]`: the workspace to reopen, from its id (or a unique prefix) or the user's pick; exits when there is none. */
async function workspaceToResume(): Promise<Workspace> {
  const saved = scanWorkspaces().saved;
  const given = positionals[1];
  if (given) {
    const found = findWorkspace(given, saved);
    return "error" in found ? fail(found.error, 1) : found.ws;
  }
  const pool = values.all ? saved : saved.filter(here);
  if (pool.length === 0) {
    console.error(`gluon: no saved sessions${values.all ? "" : " here"}${saved.length && !values.all ? " (gluon resume --all or gluon sessions shows other directories')" : ""}`);
    process.exit(1);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(pool.map(describeWorkspace).join("\n"));
    console.error("gluon: resume which? Give an id: gluon resume <id>");
    process.exit(2);
  }
  let choice: number | null;
  try {
    choice = await pick({
      theme: makeTheme(await queryBackground()),
      title: values.all ? "Resume which saved session?" : "Resume which session in this directory?",
      options: pool.map((w) => {
        const names = w.sessions.map((c) => c.name).join(", ");
        return { label: `${w.id}  ${w.name}`, description: `${names} · ${when(w)}${values.all ? ` · ${w.cwd}` : ""}` };
      }),
    });
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    choice = null;
  }
  if (choice === null) {
    console.log("\n  Nothing resumed.");
    process.exit(130);
  }
  return pool[choice]!;
}

// A resume runs in the directory it was saved in: the harnesses find their sessions by it.
let resume: Workspace | undefined;
if (!values.launch && positionals[0] === "resume") {
  resume = await workspaceToResume();
  // One Gluon at a time per workspace: two would each rewrite the file from their own list. A pid that is dead (a Gluon that quit or crashed) never blocks.
  const openIn = liveOwner(resume);
  const inUse = (pid: number | undefined) => fail(`saved session ${resume!.id} is open in another Gluon${pid === undefined ? "" : ` (process ${pid})`}; quit it first, or reopen it anyway with: gluon resume ${resume!.id} --force`, 1);
  if (openIn !== undefined && !values.force) inUse(openIn);
  // The claim at once, not when the Recorder first writes (about a second later): two Gluons started together would both pass the check above (QA-resume-02).
  const claimed = claimWorkspace(resume.id, { force: values.force });
  if (!claimed.ok) inUse(claimed.pid);
  let isDir = false;
  try {
    isDir = statSync(resume.cwd).isDirectory();
  } catch {}
  if (!isDir) fail(`the directory of saved session ${resume.id} no longer exists: ${resume.cwd}\nMove it back there (the agents find their sessions by directory), or delete the saved session: gluon sessions --delete ${resume.id}`, 1);
  if (!here(resume)) {
    // The config's place is fixed first: a relative GLUON_CONFIG would name the repository's files from here on (BUG-291).
    process.env.GLUON_CONFIG = resolve(configPath());
    try {
      process.chdir(resume.cwd);
    } catch (e) {
      fail(`can't enter ${resume.cwd} to resume ${resume.id}: ${(e as Error).message}`, 1);
    }
    console.log(`gluon: resuming ${resume.id} in ${resume.cwd} (where it was saved)`);
  }
}

const cwd = process.cwd();

if (positionals[0] === "doctor" && positionals.length === 1) process.exit(await doctor(config, cwd));

if (positionals[0] === "brain" && positionals.length === 1) process.exit(await showBrain(config, cwd));
if (positionals[0] === "brain" && positionals.length === 2 && /^(api|subscription)$/.test(positionals[1]!)) {
  fail("the brain now runs on the first working step of `brain.order` in the config: `gluon brain` shows it, `gluon setup` connects plans and keys");
}

if (positionals[0] === "setup" && positionals.length === 1) {
  needTty("gluon setup");
  process.exit((await setup({ cwd }, makeTheme(await queryBackground()))) ? 0 : 1);
}

if (positionals[0] === "connect" && positionals.length <= 2) {
  const h = positionals[1] as Harness | undefined;
  if (!h || !HARNESSES.includes(h)) fail(`connect which agent? One of: ${HARNESSES.join(", ")}`);
  needTty("gluon connect");
  process.exit((await setup({ only: h, cwd }, makeTheme(await queryBackground()))) ? 0 : 1);
}

if (values.launch) {
  if (values.mode !== undefined && !MODES.includes(values.mode as Mode)) fail(`--mode takes one of: ${MODES.join(", ")}`);
  if (values.permissions !== undefined && !PERMISSIONS.includes(values.permissions as Permissions)) fail(`--permissions takes one of: ${PERMISSIONS.join(", ")}`);
  if (values.permissions !== undefined && values.permissions !== "own" && values.mode !== undefined && values.mode !== "build") fail(`--permissions is for build mode: ${values.mode} sets its own`);
  const choice: LaunchChoice = {
    harness: values.launch as Harness,
    model: values.model ?? "",
    effort: values.effort as Effort | undefined,
    ...(values.mode !== undefined ? { mode: values.mode as Mode } : {}),
    ...(values.permissions !== undefined && values.permissions !== "own" ? { permissions: values.permissions as Permissions } : {}),
    spec: positionals.join(" "),
    reason: "launched directly",
  };
  // validateChoice would say `has no model ""`: say what is missing instead (BUG-602). An unknown harness stays its first complaint.
  const agent = findAgent(config, choice.harness);
  if (agent && !values.model) fail(`--model is required with --launch (${choice.harness} models: ${agent.models.map((m) => m.id).join(", ")})`);
  const error = validateChoice(config, choice);
  if (error) fail(error);
  // Nothing can type into the agent here: refused before anything starts, a dry run included.
  const typedProblem = typedModeProblem(choice.harness, choice.mode);
  if (typedProblem) fail(typedProblem);
  if (values["dry-run"]) {
    let cmd: Command;
    try {
      cmd = buildCommand(config, choice);
    } catch (e) {
      fail((e as Error).message);
    }
    // Keys masked by name (whatever their shape), then anything else that looks like one.
    const env = Object.fromEntries(Object.entries(cmd!.env).map(([k, v]) => [k, v && SECRET_ENV.includes(k) ? maskValue(v) : v]));
    const { spec: _, harness: _h, ...shown } = cmd!;
    console.log(maskSecrets(JSON.stringify({ ...shown, env }, null, 2)));
    process.exit(0);
  }
  if (!binPath(BINARIES[choice.harness])) {
    launchFailed(buildCommand(config, choice), choice, new Error(missingReason(BINARIES[choice.harness])));
  }
  await launch(choice);
}

const task = resume ? "" : positionals.join(" ").trim();
if (!resume && positionals.length === 1 && /^[a-z-]+$/.test(task)) {
  const near = HINT_COMMANDS.find((c) => distance(c, task) <= 2);
  if (near) fail(`unknown command "${task}" — did you mean "gluon ${near}"? (To give it as a session, quote a longer sentence.)`);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  fail(`needs an interactive terminal (stdin and stdout must be a TTY). To launch an agent without the chat, use --launch; see --help.`);
}

const demo = values.demo ?? false;
const background = await queryBackground();
const theme = makeTheme(background);
// The first run: connect the coding agents, then check them and the brain order.
if (!demo && Object.keys(config.connections).length === 0) {
  const ready = await setup({ cwd }, theme);
  config = readConfig();
  if (!ready) {
    console.log(`\n${Object.keys(config.connections).length ? "Gluon has no working intake agent yet: run `gluon doctor` to see why" : "Run `gluon setup` when you're ready"}, or try \`gluon --demo\`.`);
    process.exit(Object.keys(config.connections).length ? 1 : 0);
  }
  console.log("");
}

let step = demo ? null : activeStep(config);
if (!demo && !step) {
  const { active, steps } = await chooseBrain(config, cwd);
  step = active === null ? null : config.brain.order[active]!;
  const chosen = active === null ? null : steps[active]?.result;
  for (const w of chosen?.ok ? (chosen.warnings ?? []) : []) console.log(maskSecrets(`! ${w}`));
  if (!step) fail("no step of the intake agent order (`brain.order`) works: run `gluon doctor` to see why, or try --demo");
}

const routing = readRouting();
if (offeredAgents(config, { demo, optedIn: optedInBy(routing) }).length === 0) {
  const found = HARNESSES.filter((h) => installed(h));
  fail(
    found.length === 0
      ? `no agent is installed: none of ${HARNESSES.map((h) => HARNESS_INFO[h].binary).join(", ")} is on PATH. Run gluon install, or gluon doctor.`
      : `no connected agent has a model it can reach (${found.filter((h) => connsOf(config, h).length).length ? "run `gluon doctor`" : "run `gluon setup`"}).`,
  );
}

// Gluon: the sessions home and every agent session, until the user quits. Its sessions answer
// their agents' terminal queries for the real terminal: what it supports, asked once here.
const terminal = await queryTerminal();
const { runGluon } = await import("./gluon.ts");
await runGluon({ config, cwd, demo, step, theme, background, terminal, version: pkg.version, task, routing, ...(resume ? { resume } : {}) });
