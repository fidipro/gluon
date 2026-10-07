/**
 * Onboarding: connecting the coding agents (first run, `gluon setup`, `gluon connect <agent>`).
 * Each agent signs in with a provider's API key (saved to Gluon's own .env, 0600, never put in
 * process.env) or with the user's own subscription through the agent's own login. Gluon only
 * runs the official programs for a subscription — their status check and their login command — and
 * never reads their tokens or edits their settings.
 *
 * The setup is a list of screens walked with a cursor (`SetupFlow.run`): each screen, once
 * answered, says which comes next; Esc goes back one screen (its earlier answer pre-selected), and
 * on the first screen leaves. Answers go into a draft that is written (config.yaml, the .env) only
 * when the last screen is answered, so going back, Esc on the first screen and Ctrl+C change
 * nothing. Side effects between screens (a status check, a login handoff, the offer to install a
 * missing agent) aren't screens: going back never re-runs a login or an install, nor offers an
 * install again; a login menu whose login worked is skipped on the way back.
 */
import { homedir } from "node:os";
import { codexEnvWarnings } from "./agent/codex.ts";
import { subscriptionEnvWarnings } from "./agent/subscription.ts";
import { activeStep, bedrockConnected, chooseBrain, stepLabel } from "./brain.ts";
import { configDocument, ConfigError, connsOf, saveConfig, type Config, type Connection, type Harness } from "./config.ts";
import { absentLabel, installed, neutralCwd } from "./detect.ts";
import { HARNESS_INFO, HARNESSES, installHint, OPENROUTER_KEY_NOTICE, PROVIDERS, type ProviderId, type Subscription } from "./harnesses.ts";
import { offerInstall, offPathAdvice } from "./install.ts";
import { handOff } from "./launchers.ts";
import { saveSecrets, secretSource, secretsPath, storageNote } from "./secrets.ts";
import { loginStatus, type LoginStatus } from "./status.ts";
import { askText, pick, pickMany, type EscAction } from "./ui/signin.tsx";
import type { Theme } from "./ui/theme.ts";
import { probeHarnesses, summaryLine } from "./verify.ts";
import { awsLabel } from "./doctor.ts";

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const note = (s: string) => console.log(`  ! ${s}`);
const windowsOnly = (h: Harness) => (absentLabel(h) === "not installed" ? "" : ` (${absentLabel(h)})`);

/** What the setup will write when it finishes. Nothing is written before. */
interface Draft {
  /** The agents to connect in this run (the checklist's answer, or the one `connect` names). */
  chosen: Harness[];
  connections: Partial<Record<Harness, Connection>>;
  /** Connected in this run, in order. */
  connected: Harness[];
  /** Connected before and unchecked, confirmed. */
  dropped: Harness[];
  bedrock: Config["bedrock"];
  /** Pasted keys: variable → key. */
  secrets: Record<string, string>;
  /** OpenCode's providers so far. */
  opencode: ProviderId[];
}

/** One screen of the setup: shown with its earlier answer (if any), then says what comes next. */
interface Step {
  /** Names the screen, for its earlier answer: unique within a run. */
  id: string;
  /** Shows the screen; null for Esc. `esc`: what Esc does here (the footer says it). */
  show(earlier: unknown, esc: EscAction): Promise<unknown>;
  next(answer: unknown): Later;
}
/** The next screen, or null: the setup is done. */
type Next = Step | null;
type Later = Next | Promise<Next>;
type After = () => Later;

type Props<F extends (...a: any) => any> = Omit<Parameters<F>[0], "theme" | "esc">;

export class SetupFlow {
  draft: Draft;
  private answers = new Map<string, unknown>();
  private detour = false;
  /** Agents offered an install in this run (once each, whatever the answer), and where one landed off PATH. */
  private offered = new Set<Harness>();
  private offPath = new Map<Harness, string>();

  constructor(
    private config: Config,
    private theme: Theme,
    chosen: Harness[] = [],
  ) {
    this.draft = { chosen, connections: structuredClone(config.connections), connected: [], dropped: [], bedrock: { ...config.bedrock }, secrets: {}, opencode: [] };
  }

  /**
   * Walks the screens from `first`. Each entry of the trail keeps the draft as it was before its
   * screen was answered, so going back undoes what the later screens did. Resolves false when Esc
   * leaves the first screen; Ctrl+C throws `Cancelled`.
   */
  async run(first: Later): Promise<boolean> {
    const trail: { step: Step; draft: Draft }[] = [];
    let step = await first;
    while (step) {
      trail.push({ step, draft: structuredClone(this.draft) });
      const answer = await step.show(this.answers.get(step.id), trail.length > 1 ? "back" : "cancel");
      if (answer === null) {
        trail.pop();
        const prev = trail.pop();
        if (!prev) return false;
        this.draft = prev.draft;
        step = prev.step;
        continue;
      }
      this.answers.set(step.id, answer);
      this.detour = false;
      step = await step.next(answer);
      if (this.detour) trail.pop();
    }
    return true;
  }

  /** The screen just answered led to a login that worked: going back skips it. */
  private skipOnTheWayBack() {
    this.detour = true;
  }

  private menu(id: string, props: (earlier?: number) => Props<typeof pick>, next: (choice: number) => Later): Step {
    return { id, show: (e, esc) => pick({ theme: this.theme, esc, ...props(e as number | undefined) }), next: (a) => next(a as number) };
  }

  private checklist(id: string, props: (earlier?: number[]) => Props<typeof pickMany>, next: (chosen: number[]) => Later): Step {
    return { id, show: (e, esc) => pickMany({ theme: this.theme, esc, ...props(e as number[] | undefined) }), next: (a) => next(a as number[]) };
  }

  private prompt(id: string, props: Props<typeof askText>, next: (value: string) => Later): Step {
    return { id, show: (e, esc) => askText({ theme: this.theme, esc, ...props, ...(e !== undefined ? { initial: e as string } : {}) }), next: (a) => next(a as string) };
  }

  /** The config as it will be, for what's already set up. */
  private view(): Config {
    return { ...this.config, connections: this.draft.connections, bedrock: this.draft.bedrock };
  }

  /** Whether a provider is already set up (a key Gluon can use, or the AWS setup), so it can be reused. */
  private reusable(p: ProviderId): string | null {
    if (PROVIDERS[p].subscription) return null;
    if (p === "bedrock") return bedrockConnected(this.view()) ? awsLabel(this.view()) : null;
    const env = PROVIDERS[p].env!;
    if (this.draft.secrets[env]) return `the ${env} you pasted`;
    const source = secretSource(env);
    return source ? `${env} from ${source === "your environment" ? source : tilde(source)}` : null;
  }

  /** The checklist of agents (setup's first screen), then a confirmation for the ones unchecked. */
  agents(): Step {
    const first = Object.keys(this.config.connections).length === 0;
    return this.checklist(
      "agents",
      (earlier) => ({
        title: "Connect your coding agents",
        body: ["Gluon starts each session with one of these. Pick the ones to connect (change it later: `gluon connect <agent>`)."],
        options: HARNESSES.map((h, i) => {
          const info = HARNESS_INFO[h];
          const has = connsOf(this.config, h).length > 0;
          return {
            label: info.label,
            description: installed(h) ? `installed (\`${info.binary}\`)${has ? " · connected" : ""}` : absentLabel(h),
            checked: earlier ? earlier.includes(i) : has || (first && installed(h)),
          };
        }),
      }),
      (picked) => {
        const chosen = picked.map((i) => HARNESSES[i]!);
        this.draft.chosen = chosen;
        const dropped = HARNESSES.filter((h) => this.config.connections[h] && !chosen.includes(h));
        if (!dropped.length) return this.harnesses(0);
        const names = dropped.map((h) => HARNESS_INFO[h].label).join(", ");
        return this.menu(
          `disconnect/${dropped.join(",")}`,
          (earlier) => ({
            title: `Disconnect ${names}?`,
            body: ["Gluon stops offering it. Its own login and any key you saved stay where they are."],
            options: [
              { label: "Disconnect", description: `Remove ${names} from Gluon's connections` },
              { label: "Keep connected", description: "Leave it as it is" },
            ],
            initial: earlier ?? 0,
          }),
          (choice) => {
            if (choice === 0) {
              for (const h of dropped) delete this.draft.connections[h];
              this.draft.dropped = dropped;
            }
            return this.harnesses(0);
          },
        );
      },
    );
  }

  /**
   * The chosen agents from the i-th on. One that isn't installed is offered an install (once per
   * run, not a screen); still missing, it has no screen (the summary says so).
   */
  async harnesses(i: number): Promise<Next> {
    const list = this.draft.chosen;
    for (; i < list.length && !installed(list[i]!); i++) {
      const h = list[i]!;
      if (this.offered.has(h)) continue;
      this.offered.add(h);
      const r = await offerInstall(h, this.theme);
      if (r.outcome === "installed") break;
      if (r.dir) this.offPath.set(h, r.dir);
    }
    if (i >= list.length) return null;
    return this.harness(list[i]!, () => this.harnesses(i + 1));
  }

  /** One agent: API key (which provider) or subscription (personal use); OpenCode: its providers. */
  private harness(h: Harness, after: After): Step {
    const info = HARNESS_INFO[h];
    if (info.multiProvider) return this.openCode(after);
    const current = this.config.connections[h];
    const connect = (c: Connection) => {
      this.draft.connections[h] = c;
      this.draft.connected.push(h);
      return after();
    };
    return this.menu(
      `${h}/how`,
      (earlier) => ({
        title: `How should ${info.label} sign in?`,
        options: [
          { label: "API key", description: `${info.providers.map((p) => PROVIDERS[p].label).join(" · ")}; billed per use` },
          { label: "Subscription (personal use)", description: `Your ${info.subscription!.plan}, through \`${info.binary}\`'s own login` },
        ],
        initial: earlier ?? (current?.auth === "subscription" ? 1 : 0),
      }),
      (how) => {
        if (how === 1) return this.subscription(h, () => connect({ auth: "subscription" }), after);
        const withKey = (p: ProviderId) => this.provider(h, p, () => connect({ auth: "api", provider: p }));
        if (info.providers.length === 1) return withKey(info.providers[0]!);
        return this.menu(
          `${h}/provider`,
          (earlier) => ({
            title: "Which provider?",
            options: info.providers.map((p) => {
              const has = this.reusable(p);
              return { label: PROVIDERS[p].label, description: has ? `already connected (${has})` : (PROVIDERS[p].env ?? "your AWS profile and region") };
            }),
            initial: earlier ?? Math.max(0, info.providers.indexOf(current?.provider as ProviderId)),
          }),
          (which) => withKey(info.providers[which]!),
        );
      },
    );
  }

  /**
   * Subscription: the harness's own status check, then its own login if needed (a handoff) and the
   * check again. `connected`: on the plan; `after`: not connected, go on.
   */
  private async subscription(h: Harness, connected: After, after: After, sub: Subscription = HARNESS_INFO[h].subscription!): Promise<Next> {
    const info = HARNESS_INFO[h];
    const signedIn = (status: LoginStatus) => {
      ok(`Signed in to ${info.label} · ${status.detail ?? "signed in"}`);
      for (const w of h === "claude-code" ? subscriptionEnvWarnings() : h === "codex" ? codexEnvWarnings() : []) note(w);
      return connected();
    };
    const status = await loginStatus(h);
    if (!status.installed) {
      bad(`${info.label} (\`${info.binary}\`) isn't installed${windowsOnly(h)}. Install it (\`${installHint(h)}\`, or \`gluon install ${h}\`), then try again.`);
      return after();
    }
    if (status.loggedIn && !status.wrongMethod) return signedIn(status);
    return this.menu(
      `${h}/login`,
      (earlier) => ({
        title: status.wrongMethod ? `${info.label} isn't signed in with your ${sub.plan}` : `You're not signed in to ${info.label}`,
        body: [status.wrongMethod ?? "", sub.loginNote ?? "", status.loggedIn ? "" : (status.error ?? "")].filter(Boolean),
        options: [
          { label: "Sign in now", description: `Runs \`${sub.loginArgv.join(" ")}\`; you come back here when it's done` },
          { label: "Not now", description: `${info.label} stays as it is` },
        ],
        initial: earlier ?? 0,
      }),
      async (choice) => {
        if (choice !== 0) return after();
        try {
          await handOff({ argv: sub.loginArgv, env: {} }, neutralCwd());
        } catch (e) {
          bad((e as Error).message);
          return after();
        }
        const again = await loginStatus(h);
        if (!again.loggedIn || again.wrongMethod) {
          bad(`Still not signed in${again.wrongMethod ? ` with your ${sub.plan}` : ""}. Run \`${sub.loginArgv.join(" ")}\` yourself, then \`gluon connect ${h}\`.`);
          return after();
        }
        this.skipOnTheWayBack();
        return signedIn(again);
      },
    );
  }

  /** Makes sure a provider can be used: reuses its key or AWS setup, or asks for one. `id`: whose screens. */
  private provider(id: string, p: ProviderId, after: After): Later {
    const info = PROVIDERS[p];
    const existing = this.reusable(p);
    const ask = () => (p === "bedrock" ? this.aws(id, after) : this.key(id, p, after));
    if (!existing) return ask();
    return this.menu(
      `${id}/reuse/${p}`,
      (earlier) => ({
        title: `${info.label}: use what's already set up?`,
        options: [
          { label: `Use ${existing}`, description: "Already connected" },
          {
            label: p === "bedrock" ? "Set a different AWS profile or region" : "Paste a different key",
            // A key saved by Gluon wins over the environment's (secrets.ts), so it does replace it.
            description: p !== "bedrock" && !this.draft.secrets[info.env!] && secretSource(info.env!) === "your environment" ? "Saved for Gluon; used instead of the one in your environment" : "Replaces it for Gluon",
          },
        ],
        initial: earlier ?? 0,
      }),
      (choice) => (choice === 0 ? after() : ask()),
    );
  }

  /**
   * The AWS profile and region. An empty answer pins nothing: the config leaves it out, and
   * `awsSetup` uses the environment's (AWS_PROFILE; AWS_REGION / AWS_DEFAULT_REGION) or the
   * defaults, which the prompt shows. A value already configured is pre-filled.
   */
  private aws(id: string, after: After): Step {
    const envProfile = process.env.AWS_PROFILE || undefined;
    const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
    const regionVar = process.env.AWS_REGION ? "AWS_REGION" : "AWS_DEFAULT_REGION";
    return this.prompt(
      `${id}/aws-profile`,
      {
        title: "Which AWS profile should Bedrock use?",
        body: [
          "From your own AWS setup (`~/.aws`); Gluon passes the name, never the credentials.",
          `Enter on an empty line doesn't pin one: Bedrock uses ${envProfile ? `AWS_PROFILE (now ${envProfile})` : "the default credentials"}.`,
        ],
        hint: envProfile ? `${envProfile} (AWS_PROFILE)` : "default credentials",
        ...(this.draft.bedrock.profile ? { initial: this.draft.bedrock.profile } : {}),
      },
      (profile) =>
        this.prompt(
          `${id}/aws-region`,
          {
            title: "Which AWS region?",
            body: [`Enter on an empty line doesn't pin one: Bedrock uses ${envRegion ? `${regionVar} (now ${envRegion})` : "us-east-1"}.`],
            hint: envRegion ? `${envRegion} (${regionVar})` : "us-east-1",
            ...(this.draft.bedrock.region ? { initial: this.draft.bedrock.region } : {}),
          },
          (region) => {
            this.draft.bedrock = { ...(profile && profile !== "default" ? { profile } : {}), ...(region ? { region } : {}) };
            return after();
          },
        ),
    );
  }

  private key(id: string, p: ProviderId, after: After): Step {
    const info = PROVIDERS[p];
    return this.prompt(
      `${id}/key/${p}`,
      {
        title: `Paste your ${info.label} API key`,
        body: [...(info.keyUrl ? [`Create one at ${info.keyUrl}`] : []), ...(p === "openrouter" ? [OPENROUTER_KEY_NOTICE] : []), `It's saved to \`${tilde(secretsPath())}\` as ${info.env}, ${storageNote()}.`],
        secret: true,
      },
      (key) => {
        this.draft.secrets[info.env!] = key;
        return after();
      },
    );
  }

  /** What a provider asks for, in a list: its key's variable, the plan's own login, or the AWS setup. */
  private hint(p: ProviderId): string {
    const info = PROVIDERS[p];
    return info.subscription ? `${info.subscription.plan} (personal), through \`${HARNESS_INFO.opencode.binary}\`'s own login` : (info.env ?? "AWS profile and region");
  }

  /** Connects one OpenCode provider: a plan signs in through OpenCode itself, a key is pasted. `skipped`: not connected, go on. */
  private connectProvider(p: ProviderId, connected: After, skipped: After): Later {
    const sub = PROVIDERS[p].subscription;
    return sub ? this.subscription("opencode", connected, skipped, sub) : this.provider("opencode", p, connected);
  }

  /** OpenCode: a checklist of providers (OpenRouter, its plan), a key or sign-in for each, and "add another". */
  private openCode(after: After): Step {
    const info = HARNESS_INFO.opencode;
    const current = this.config.connections.opencode?.providers ?? [];
    return this.checklist(
      "opencode/providers",
      (earlier) => ({
        title: "Which providers should OpenCode use?",
        body: ["OpenCode runs on an OpenRouter key or your OpenCode Go plan (its own login). Gluon hands it only the key for the model it launches; the plan needs none."],
        options: info.providers.map((p, i) => {
          const has = this.reusable(p);
          return { label: PROVIDERS[p].label, description: `${this.hint(p)}${has ? " · already set" : ""}`, checked: earlier ? earlier.includes(i) : current.includes(p) };
        }),
      }),
      (chosen) => {
        this.draft.opencode = [];
        return this.openCodeAdd(chosen.map((i) => info.providers[i]!), after);
      },
    );
  }

  private openCodeAdd(queue: ProviderId[], after: After): Later {
    const [p, ...rest] = queue;
    if (!p) return this.openCodeMore(after);
    return this.connectProvider(
      p,
      () => {
        this.draft.opencode.push(p);
        return this.openCodeAdd(rest, after);
      },
      () => this.openCodeAdd(rest, after),
    );
  }

  /** "Done" or "Add another provider". Done with no provider leaves OpenCode as it was. */
  private openCodeMore(after: After): Later {
    const info = HARNESS_INFO.opencode;
    const providers = [...this.draft.opencode];
    const rest = info.providers.filter((p) => !providers.includes(p));
    const done = () => {
      if (providers.length) {
        this.draft.connections.opencode = { auth: "api", providers };
        this.draft.connected.push("opencode");
      }
      return after();
    };
    if (!rest.length) return done();
    const at = providers.join(",");
    return this.menu(
      `opencode/more/${at}`,
      (earlier) => ({
        title: providers.length ? `OpenCode: ${providers.map((p) => PROVIDERS[p].label).join(", ")}` : "OpenCode has no provider yet",
        options: [
          { label: "Done", description: providers.length ? "Save these providers" : "Leave OpenCode as it is" },
          { label: "Add another provider", description: rest.map((p) => PROVIDERS[p].label).join(", ") },
        ],
        initial: earlier ?? 0,
      }),
      (more) =>
        more === 0
          ? done()
          : this.menu(
              `opencode/which/${at}`,
              (earlier) => ({ title: "Which provider?", options: rest.map((p) => ({ label: PROVIDERS[p].label, description: this.hint(p) })), initial: earlier ?? 0 }),
              (which) =>
                this.connectProvider(
                  rest[which]!,
                  () => {
                    this.draft.opencode.push(rest[which]!);
                    return this.openCodeMore(after);
                  },
                  () => this.openCodeMore(after),
                ),
            ),
    );
  }

  /**
   * Writes the draft and says what changed: the config is checked first (not valid YAML: nothing
   * is saved), then every key goes to the .env in one replace, then config.yaml in one write. A
   * failure before the config write leaves both files as they were and nothing changed in memory.
   */
  commit(): void {
    const d = this.draft;
    const config = this.config;
    const changes: [string[], unknown][] = [];
    const bedrock = JSON.stringify(d.bedrock) !== JSON.stringify(config.bedrock);
    if (bedrock) changes.push([["bedrock"], d.bedrock]);
    for (const h of d.dropped) changes.push([["connections", h], undefined]);
    for (const h of d.connected) changes.push([["connections", h], d.connections[h]]);
    if (changes.length) configDocument();
    const keys = Object.entries(d.secrets);
    let warning: string | undefined;
    try {
      if (keys.length) warning = saveSecrets(keys);
    } catch (e) {
      throw new ConfigError(`couldn't save the keys to ${tilde(secretsPath())}: ${(e as Error).message}. Nothing was saved`);
    }
    if (changes.length) saveConfig(changes);
    if (bedrock) config.bedrock = d.bedrock;
    for (const h of d.dropped) delete config.connections[h];
    for (const h of d.connected) config.connections[h] = d.connections[h];
    for (const [env] of keys) ok(`Saved ${env} to ${tilde(secretsPath())}`);
    if (warning) note(warning);
    if (bedrock) ok(`Amazon Bedrock · ${awsLabel(config)}`);
    for (const h of d.dropped) ok(`${HARNESS_INFO[h].label} disconnected`);
    for (const h of d.chosen) {
      const info = HARNESS_INFO[h];
      const c = config.connections[h];
      const dir = this.offPath.get(h);
      if (!installed(h) && dir) note(`${info.label} was installed to ${dir}, which isn't on your PATH: ${offPathAdvice(dir)}, then run \`gluon connect ${h}\`.`);
      else if (!installed(h)) bad(`${info.label} (\`${info.binary}\`) isn't installed${windowsOnly(h)}. Install it: \`${installHint(h)}\` (or \`gluon install ${h}\`), then run \`gluon connect ${h}\`.`);
      else if (!d.connected.includes(h)) {
        if (!c) console.log(`  ${info.label} isn't connected.`);
      } else if (info.multiProvider) ok(`OpenCode · ${c!.providers!.map((p) => PROVIDERS[p].label).join(", ")}`);
      else if (c!.auth === "subscription") ok(`${info.label} signs in with your ${info.subscription!.plan} (personal)`);
      else {
        ok(`${info.label} signs in with ${PROVIDERS[c!.provider!].label}`);
        const extra = info.keyNote?.[c!.provider!];
        if (extra) note(extra);
      }
    }
    if (!d.chosen.length && !HARNESSES.some((h) => installed(h))) {
      console.log(`  No coding agent is installed yet. Install one (${HARNESSES.map((h) => `\`${HARNESS_INFO[h].binary}\``).join(", ")}), then run \`gluon setup\`.`);
    }
  }
}

/** Probes each connected, installed harness and the brain order; prints the summary. Returns whether a brain works. */
export async function verifyAll(config: Config, cwd: string): Promise<boolean> {
  const harnesses = HARNESSES.filter((h) => connsOf(config, h).length && installed(h));
  if (harnesses.length) {
    console.log("\n  Checking your connections…");
    await probeHarnesses(config, harnesses, { cwd, onProbe: (p) => console.log(`  ${summaryLine(p)}`) });
  }
  const { active, steps } = await chooseBrain(config, cwd);
  if (active === null) {
    const tried = steps.filter((s) => s.result && !/^not connected/.test(s.result.ok ? "" : s.result.error));
    bad(`Intake agent · no step of \`brain.order\` works${tried.length ? `: ${tried.map((s) => `${stepLabel(s.step)}: ${s.result!.ok ? "" : s.result!.error}`).join("; ")}` : " (connect Claude Code or Codex with a plan, or an Anthropic, OpenAI, Bedrock or OpenRouter key)"}`);
    return false;
  }
  console.log(`  Intake agent · ${stepLabel(config.brain.order[active]!)}`);
  return true;
}

/**
 * The setup: which agents to connect (a checklist), how each signs in, then a check of everything.
 * `only`: connect just this one (`gluon connect <agent>`). Returns whether a brain works afterwards.
 * Esc goes back one screen (on the first: leaves, nothing changed); Ctrl+C in any screen throws
 * `Cancelled` (the caller quits, nothing written or probed). Nothing is written until the last
 * screen is answered. The checks (paid probes) run only when an agent was connected in this run.
 */
export async function runSetup(config: Config, theme: Theme, { only, cwd = process.cwd() }: { only?: Harness; cwd?: string } = {}): Promise<boolean> {
  const flow = new SetupFlow(config, theme, only ? [only] : []);
  if (!(await flow.run(only ? flow.harnesses(0) : flow.agents()))) {
    console.log("  Nothing changed.");
    return false;
  }
  try {
    flow.commit();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.log(`\n  ✗ ${e.message}.`);
    return false;
  }
  // Nothing (re)connected in this run: nothing new to check, and no paid probe.
  if (!flow.draft.connected.length) return !only && activeStep(config) !== null;
  return verifyAll(config, cwd);
}
