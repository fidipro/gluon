/**
 * `gluon doctor`: tests access for real, never assumes it. Per harness: installed, version,
 * connection and its sign-in; per connection: every model probed (✓/✗ with the reason, the
 * fallback used); per connected agent, the effective `handoff` settings and what its adapter
 * does with them, and Gluon's own files in other tools' directories (`permanent.ts`); the
 * brain order, each step probed, the active one marked. Results are written to the config's
 * `verified`. Tokens are masked everywhere.
 *
 * Exit code: 1 when it prints any ✗ — something connected that doesn't work (an agent that isn't
 * installed or signed in, a model it can't reach, a brain step that fails), or no brain / no
 * launchable agent at all. "·" lines are information (not connected, not tried, a fallback not
 * needed) and "!" lines notes; neither changes the exit code.
 */
import { homedir } from "node:os";
import { ADAPTERS, versionAtLeast } from "./adapters/index.ts";
import { listPermanentFiles } from "./adapters/permanent.ts";
import { BRAIN_EFFORT_DEFAULT } from "./agent/effort.ts";
import { chooseBrain, envWarnings, shownEffort, stepLabel, type StepResult } from "./brain.ts";
import { awsSetup, connsOf, type Config } from "./config.ts";
import { absentLabel, installed } from "./detect.ts";
import { handoffFor } from "./handoff.ts";
import { HARNESS_INFO, HARNESSES, installHint, OPENROUTER_KEY_NOTICE, PROVIDERS, subscriptionOf, tooOld, type Harness, type ProviderId } from "./harnesses.ts";
import { offeredOn } from "./models.ts";
import { maskSecrets, secret, secretSource } from "./secrets.ts";
import { loginStatus, opencodeCredentials, versionOf } from "./status.ts";
import { probeConnection, recordProbes, summaryLine, type ConnectionProbe } from "./verify.ts";

/** "AWS profile work, us-east-1": the AWS setup Bedrock uses (never a key). */
export function awsLabel(config: Config): string {
  const { profile, region } = awsSetup(config);
  return `AWS ${profile ? `profile ${profile}` : "default credentials"}, ${region}`;
}

/** `~/…` for a path under the home directory. */
function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** "OpenAI key (from ~/.config/gluon/.env)": which key, and where it comes from. */
function keyLabel(conn: ProviderId): string {
  const { label, env } = PROVIDERS[conn];
  const source = env ? secretSource(env) : null;
  return `${label} key${source ? ` (from ${tilde(source)})` : ""}`;
}

/** Prints a line; remembers whether any ✗ was printed (the exit code). */
let failed = false;
const out = (s: string) => {
  if (/^\s*✗/m.test(s)) failed = true;
  console.log(maskSecrets(s));
};

/** A working check's warnings, one `!` line each under it. */
function warningLines(warnings: string[] | undefined, indent: string): string[] {
  return (warnings ?? []).map((w) => `${indent}! ${w}`);
}

/** One step of the order and how its check went; `withEffort`: and the effort it sends (`gluon brain`). */
export function stepLine(r: StepResult, active: number | null, withEffort = false): string {
  const n = `${r.index + 1}. ${stepLabel(r.step)}`;
  const effort = withEffort ? shownEffort(r.step) : null;
  const tail = effort ? ` · effort ${effort}${r.step.effort ? "" : " (default)"}` : withEffort ? " · no effort setting" : "";
  if (r.result === null) return `  · ${n} · not tried (step ${(active ?? 0) + 1} is in use)${tail}`;
  if (r.result.ok) return [`  ✓ ${n}${r.index === active ? "   ← in use" : ""}${tail}`, ...warningLines(r.result.warnings, "      ")].join("\n");
  // A step that isn't connected isn't a failure: nothing to fix unless you want it.
  return `  ${/^not connected/.test(r.result.error) ? "·" : "✗"} ${n} · ${r.result.error}${tail}`;
}

async function harnessReport(config: Config, h: Harness, cwd: string): Promise<{ lines: string[]; probes: ConnectionProbe[]; ok: boolean; version: string | null }> {
  const info = HARNESS_INFO[h];
  const version = await versionOf(h);
  const conns = connsOf(config, h);
  const name = `${info.label} (${info.binary}${version ? ` ${version}` : ""})`;
  if (!installed(h)) {
    return { lines: [`${conns.length ? "✗" : "·"} ${info.label} (${info.binary}) · ${absentLabel(h)} · install: ${installHint(h)} (or \`gluon install ${h}\`)`], probes: [], ok: conns.length === 0, version };
  }
  const old = tooOld(h, version);
  if (old) return { lines: [`${conns.length ? "✗" : "·"} ${name} · ${old}`], probes: [], ok: conns.length === 0, version };
  if (!conns.length) return { lines: [`· ${name} · not connected · \`gluon connect ${h}\``], probes: [], ok: true, version };
  const lines: string[] = [];
  const probes: ConnectionProbe[] = [];
  let ok = true;
  for (const conn of conns) {
    const sub = subscriptionOf(h, conn);
    let head = sub ? `${sub.plan} (personal)` : conn === "plan" ? "plan" : conn === "bedrock" ? `Amazon Bedrock · ${awsLabel(config)}` : keyLabel(conn);
    // Asked once: the head says it, and the probe goes on from it.
    const status = sub ? await loginStatus(h) : undefined;
    if (status) head += status.loggedIn && !status.wrongMethod ? ` · signed in: ${status.detail}` : ` · ${status.wrongMethod ?? (status.transient ? "sign-in not checked" : "not signed in")}`;
    const p = await probeConnection(config, h, conn, { cwd, status });
    probes.push(p);
    const summary = summaryLine(p);
    lines.push(`${summary.slice(0, 1)} ${name} · ${head}`);
    if (p.problem) {
      lines.push(`    ✗ ${p.problem}`);
      ok = false;
      continue;
    }
    for (const m of p.models) lines.push(...(m.result.ok ? [`    ✓ ${m.entry.id} · ${m.id}`, ...warningLines(m.result.warnings, "        ")] : [`    ✗ ${m.entry.id} · ${m.id} · ${m.result.error}`]));
    if (!p.models.some((m) => m.result.ok)) ok = false;
    else lines.push(`    ${summary.replace(/^[✓✗] /, "")}`);
  }
  if (h === "opencode") {
    const n = await opencodeCredentials();
    if (n) lines.push(`    ! OpenCode also has ${n} login${n === 1 ? "" : "s"} of its own (\`opencode auth list\`); Gluon launches it with the connected keys only`);
  }
  return { lines, probes, ok, version };
}

/**
 * Per connected agent: the effective `handoff` settings and what its adapter does with them
 * (supported, skipped, ignored); then Gluon's own files in other tools' directories. Never ✗.
 */
export function handoffLines(config: Config, agents: { harness: Harness; version: string | null }[], files: string[] = listPermanentFiles()): string[] {
  const lines = [
    "\nAgent sessions in Gluon (`handoff` in the config)",
    "  · Gluon asks on a typed /clear or /compact (ask) whether to end the session, and shows home at once on the key; below, what each agent adds",
  ];
  for (const { harness, version } of agents) {
    const s = handoffFor(config.handoff, harness);
    const a = ADAPTERS[harness];
    lines.push(`  · ${HARNESS_INFO[harness].label} · on exit: ${s.on_exit} · /clear: ${s.on_clear} · /compact: ${s.on_compact} · key: ${s.key}`);
    if (a.minVersion && !(version && versionAtLeast(version, a.minVersion))) lines.push(`      ! needs ${HARNESS_INFO[harness].binary} ${a.minVersion} or newer for Gluon's hooks and plugins`);
    else for (const n of a.notes({ harness, version, handoff: s })) lines.push(`      · ${n}`);
  }
  if (!agents.length) lines.push("  · no connected agent");
  lines.push(files.length ? `  · Gluon's own files in other tools' directories: ${files.map(tilde).join(", ")} (\`gluon uninstall\` removes them)` : "  · Gluon has no files in other tools' directories");
  return lines;
}

/** Runs the checks and prints them; resolves with the exit code. */
export async function doctor(config: Config, cwd: string): Promise<number> {
  failed = false;
  out("Agents");
  const reports = await Promise.all(HARNESSES.map((h) => harnessReport(config, h, cwd)));
  for (const r of reports) for (const l of r.lines) out(`  ${l}`);
  recordProbes(config, reports.flatMap((r) => r.probes));
  const offered = HARNESSES.filter((h) => installed(h) && connsOf(config, h).some((c) => config.models[h].some((m) => offeredOn(config, h, c, m))));
  if (!offered.length) out("  ✗ No connected agent can be launched yet: `gluon setup`");
  const connected = HARNESSES.map((h, i) => ({ harness: h, version: reports[i]!.version })).filter(({ harness }) => installed(harness) && connsOf(config, harness).length > 0);
  for (const l of handoffLines(config, connected)) out(l);
  // Gluon reads an OpenRouter key's usage for each session's billed figure: only true if nothing else spends on the key.
  if (HARNESSES.some((h) => connsOf(config, h).includes("openrouter")) || secret(PROVIDERS.openrouter.env!)) out(`\n${OPENROUTER_KEY_NOTICE}`);

  out("\nBrain order");
  const { active, steps } = await chooseBrain(config, cwd, { all: true });
  for (const r of steps) out(stepLine(r, active));
  if (active === null) out("  ✗ No step works, so Gluon has no brain: connect Claude Code or Codex with a plan, or an Anthropic, OpenAI, Bedrock or OpenRouter key (`gluon setup`).");
  for (const w of envWarnings(active === null ? null : config.brain.order[active]!)) out(`  ! ${w}`);
  return !failed && active !== null && offered.length > 0 && reports.every((r) => r.ok) ? 0 : 1;
}

/** `gluon brain`: tries the order until a step works; ✓ on it, why each earlier step was skipped. */
export async function showBrain(config: Config, cwd: string): Promise<number> {
  out(`Brain order (edit \`brain.order\` in the config; a step's optional \`effort\` is the intake agent's effort, ${BRAIN_EFFORT_DEFAULT} by default)`);
  const { active, steps } = await chooseBrain(config, cwd, { onStep: () => {} });
  for (const r of steps) out(stepLine(r, active, true));
  if (active === null) out("  ✗ No step works: `gluon doctor` shows why, `gluon setup` connects more.");
  return active === null ? 1 : 0;
}
