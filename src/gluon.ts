/**
 * Gluon: the app. One long-lived process: the home view (sessions list + the intake chat,
 * `src/ui/Home.tsx`), any number of agent sessions running at once in their own pseudo-terminals
 * (`pty/session.ts`), and the compositor that owns the terminal and shows one of them in a frame
 * (`pty/compositor.ts`). Agents die with Gluon, but the workspace is saved (`workspaces.ts`:
 * `Recorder`, rewritten on every change) so `gluon resume <id>` reopens its sessions. A session
 * that ends (the agent exits, or Gluon ends it at the user's yes) closes: its row goes, it leaves
 * the record, and the home view shows; quitting Gluon ends the agents but keeps the record.
 * Without a pseudo-terminal (`ptyAvailable`), a session gets the terminal itself, one at a time
 * (`handOffSession`), and the home view comes back when it ends.
 *
 * Owns: the `SessionStore` both views read; the telemetry listener (cost, context); one
 * intake agent `Session` per draft (a new one after each start); the brain's fallback state; the
 * files-changed poll. Status, cost and context only ever update the store: they never act.
 */
import { dirname } from "node:path";
import { homedir } from "node:os";
import { useApp } from "ink";
import { createElement, useEffect, useState, type ReactNode } from "react";
import { NAME_PREFIX } from "./agent/choices.ts";
import { codexEnvWarnings } from "./agent/codex.ts";
import { demoClient } from "./agent/clients.ts";
import { repoContext, systemPrompt } from "./agent/prompt.ts";
import { Session, type BrainFallback, type LoopBrain, type ModelClient, type NamedChoice } from "./agent/session.ts";
import { subscriptionEnvWarnings } from "./agent/subscription.ts";
import { statusSnapshot } from "./agent/tools.ts";
import { pollChanges, type PolledSession } from "./files-poll.ts";
import { gitQuery } from "./agent/git.ts";
import { adapterOutput } from "./adapters/index.ts";
import { ensurePermanentFiles } from "./adapters/permanent.ts";
import { brainErrorHint, brainFor, modelUnavailable, notConnected, probeStep, quickCheck, envWarnings, stepLabel } from "./brain.ts";
import { activeValue, configPath, connsOf, ensureHandoffSection, saveConfig, setConfigNotices, type BrainStep, type Config } from "./config.ts";
import { binPath, installed } from "./detect.ts";
import { safeLine, stepGate } from "./events.ts";
import { handoffFor } from "./handoff.ts";
import { HARNESS_INFO, idOn, isPlanConn, permissionLevels, tooOld, type Conn, type Harness } from "./harnesses.ts";
import { buildCommand, handOffSession, launchProblem, modeLostOnResume, NO_PTY_NOTE, typedModeProblem, validateChoice, withMode, type Command, type SessionEnd } from "./launchers.ts";
import { launcherLines, optedInBy, routeCatalog, withLauncherLines } from "./intake.ts";
import { offeredAgents } from "./models.ts";
import type { Config as RoutingConfig } from "./routing.ts";
import { Compositor, type Choice, type HomeView } from "./pty/compositor.ts";
import { launchSession, ptyAvailable, SIGNAL_GRACE_MS, type AgentSession, type SessionStatus } from "./pty/session.ts";
import type { MouseReport } from "./pty/types.ts";
import { maskSecrets, secret } from "./secrets.ts";
import { costLabel, RESUMED, runState, SessionStore, STARTING, WORKING, type SessionView } from "./sessions.ts";
import { loginStatus, versionOf } from "./status.ts";
import { ensureAgyStatusLine } from "./adapters/agy-settings.ts";
import { claudeCacheTtl } from "./cost/harness-config.ts";
import { CostTracker } from "./cost/tracker.ts";
import { kimiUsage, KIMI_END_WAIT_MS, removeKimiExports } from "./kimi-usage.ts";
import { billedSource, BilledMeter, Registry, settled } from "./openrouter-billed.ts";
import { agyContextTokens } from "./cost/antigravity.ts";
import { ownPercent, ownWindow, windowIsGuess } from "./cost/context.ts";
import { readGrokUsage } from "./cost/grok-usage.ts";
import { priceKey } from "./cost/keys.ts";
import { Analytics, type Run } from "./analytics.ts";
import { Ledger, type LedgerEntry } from "./cost/ledger.ts";
import { openLedgerFile, removeLedger, type LedgerWriter } from "./cost/ledger-file.ts";
import { refreshAllowed, refreshNetworkTables, refreshOnLaunch } from "./cost/refresh.ts";
import { onTablesChanged } from "./cost/tables.ts";
import { opencodeContextTokens } from "./cost/opencode.ts";
import { ownTelemetry, tryStartTelemetry } from "./telemetry.ts";
import { Home, type HomeProps } from "./ui/Home.tsx";
import type { HomeQuestion } from "./ui/list.tsx";
import type { HeaderInfo } from "./ui/header.tsx";
import { repoLabel, truncate, type Readiness } from "./ui/layout.ts";
import { inkRender } from "./ui/rawmode.ts";
import type { Rgb, TerminalInfo, Theme } from "./ui/theme.ts";
import { ownStart, Recorder, type ChildRecord, type Workspace } from "./workspaces.ts";

export type { HomeView } from "./pty/compositor.ts";

export interface GluonContext {
  config: Config;
  cwd: string;
  demo: boolean;
  /** The brain's step (null: the demo brain). */
  step: BrainStep | null;
  theme: Theme;
  /** The terminal's background (OSC 11 at startup): the agents' OSC 11 queries are answered with it. */
  background: Rgb | null;
  /** The rest the startup probe learned (`queryTerminal`): kitty keys, foreground and cursor colours. */
  terminal?: TerminalInfo;
  version: string;
  /** The task from the command line: the first draft starts with it. */
  task: string;
  /** `gluon resume`: the saved workspace to reopen (Gluon already runs in its directory). */
  resume?: Workspace;
  /** The user's routing.yaml (`loadRouting`): the intake's types, preferences and instructions, and `route`'s rank and limits. */
  routing: RoutingConfig;
}

/** How often the work tree's changes are counted (one `git status` for all sessions). */
export const FILES_POLL_MS = 5000;

/**
 * The brain in use and its fallback: when its model turns out to be unavailable, the next step of
 * `brain.order` that works (what `main.tsx` keeps in module variables for the old flow).
 */
export class BrainState {
  constructor(
    private config: Config,
    public step: BrainStep | null,
    private cwd: string,
  ) {}

  client(demoRouting: RoutingConfig | null): ModelClient | LoopBrain {
    return demoRouting ? demoClient(demoRouting) : brainFor(this.config, this.step!, this.cwd);
  }

  readonly fallback: BrainFallback = async (_message, error) => {
    if (!this.step || !modelUnavailable(error)) return null;
    const from = this.config.brain.order.indexOf(this.step);
    for (let i = from + 1; i < this.config.brain.order.length; i++) {
      const next = this.config.brain.order[i]!;
      if (notConnected(this.config, next)) continue;
      if (!(await probeStep(this.config, next, this.cwd)).ok) continue;
      this.step = next;
      this.config.brain.active = i;
      saveConfig([[["brain", "active"], activeValue(this.config, i)]]);
      return { client: brainFor(this.config, next, this.cwd), label: stepLabel(next) };
    }
    return null;
  };
}

/** What the home view needs from Gluon, changing over time (`subscribe`). */
interface HomeHost {
  session: Session;
  header: HeaderInfo;
  readiness: Readiness[];
  /** The home view's question on the last row, while it is up (`ask`): the hint names its keys. */
  asking: HomeQuestion | null;
  /** The session the home view was last shown from (a new object each time): its row is selected. */
  back: { id: number } | null;
  subscribe(fn: () => void): () => void;
}

/** Captures Ink's app context (for `suspendTerminal`) from inside the render. */
function Bridge({ onApp, children }: { onApp: (app: ReturnType<typeof useApp>) => void; children?: ReactNode }) {
  onApp(useApp());
  return children;
}

/** The Home component, re-rendered with Gluon's current chat, header and readiness. */
function HomeRoot({ host, props }: { host: HomeHost; props: Omit<HomeProps, "session" | "header" | "readiness" | "asking" | "back"> }) {
  const snapshot = () => ({ session: host.session, header: host.header, readiness: host.readiness, asking: host.asking });
  const [snap, setSnap] = useState(snapshot);
  useEffect(() => host.subscribe(() => setSnap(snapshot())), [host]);
  // Read live, not from the snapshot: a key right after the home key comes before this render (BUG-236).
  return createElement(Home, { ...props, ...snap, back: () => host.back });
}

/**
 * A `HomeView` for an Ink element: rendered through `inkRender` with the compositor's streams,
 * suspended with Ink's own `suspendTerminal` (input detached, renders dropped) and resumed with a
 * full redraw. `mouse`: where the mouse reports Gluon gets at home go (BUG-269).
 */
export function inkHomeView(node: ReactNode, mouse?: (m: MouseReport) => void): HomeView {
  let app: ReturnType<typeof useApp> | undefined;
  let ink: ReturnType<typeof inkRender> | undefined;
  let suspension: { resume(): Promise<void> } | undefined;
  return {
    mount(input, output, rendered) {
      ink = inkRender(createElement(Bridge, { onApp: (a) => (app = a) }, node), { exitOnCtrlC: false, stdin: input, stdout: output, ...(rendered ? { onRender: rendered } : {}) });
    },
    async suspend() {
      if (!suspension && app) suspension = await app.suspendTerminal();
    },
    async resume() {
      const s = suspension;
      suspension = undefined;
      await s?.resume();
    },
    async unmount() {
      ink?.unmount();
      await ink?.waitUntilExit().catch(() => {});
    },
    ...(mouse ? { mouse } : {}),
  };
}

/** The chat's line after a session that had the terminal itself (no pseudo-terminal): how it ended, and why one at a time. */
export function directNotice(label: string, end: SessionEnd): string {
  const how = end.reason === "back" ? `Back from ${label}` : `${label} exited (code ${end.code})`;
  return `${how}. No pseudo-terminal here, so sessions run one at a time.`;
}

/** The chat's line after an agent in Gluon's frame exited on its own with an error (its session closed). */
export const exitNotice = (name: string, code: number) => `${name} exited (code ${code})`;

/** The first-run list's order (design brief 5.1). */
export const READINESS_ORDER: readonly Harness[] = ["claude-code", "codex", "grok-build", "antigravity", "opencode", "kimi-code"];

/** A readiness note; OpenCode's says it is the lane for open-weight models. */
const withNote = (h: Harness, note?: string): { note?: string } => {
  const parts = [...(h === "opencode" ? ["open-weight models"] : []), ...(note ? [note] : [])];
  return parts.length ? { note: parts.join(" · ") } : {};
};

/**
 * Every harness's readiness before any status check: not installed, not connected, an API key
 * connection whose key isn't set (`key missing`, BUG-182), ready on a key, or `checking` (a plan:
 * its official binary's own login check follows).
 */
export function initialReadiness(config: Config, isInstalled: (h: Harness) => boolean): Readiness[] {
  return READINESS_ORDER.map((h): Readiness => {
    if (!isInstalled(h)) return { harness: h, state: "missing" };
    const conns = connsOf(config, h);
    if (conns.length === 0) return { harness: h, state: "signin", note: "not connected" };
    // A plan (the harness's own, or OpenCode's) is asked of its official binary; a key that works makes OpenCode ready without it.
    const plan = conns.some(isPlanConn);
    const keyed = conns.filter((c) => !isPlanConn(c));
    if (plan && !keyed.some((c) => !launchProblem(config, h, c))) return { harness: h, state: "checking" };
    if (!plan && conns.every((c) => launchProblem(config, h, c))) return { harness: h, state: "nokey" };
    return { harness: h, state: "ready", ...withNote(h, "api key") };
  });
}

/** Delete on the drafting row asks this first. */
export const DISCARD_QUESTION = "Discard this chat?";

/** Longest session name the end question shows (cells): the question stays one line. */
const END_NAME_MAX = 32;

/** Delete on a running session's row asks this first: `End Gluon-fix-add-bug?` (BUG-213). */
export const endQuestion = (name: string) => `End ${truncate(name, END_NAME_MAX)}?`;

/** An agent that exits non-zero this soon after being resumed refused its session (the id, the directory): the user is asked. */
export const RESUME_EARLY_MS = 20_000;

/**
 * Whether an agent's exit `code`, `since` the resume started it, means it refused the session: a
 * non-zero code under 128 within `RESUME_EARLY_MS`. 128 and over is a signal (130: the user's
 * Ctrl+C, 143: a kill), not a refusal. A harness that refuses an unknown id but exits 0 isn't caught.
 */
export const resumeRefused = (code: number, since: number, now: number = Date.now()): boolean => code !== 0 && code < 128 && now - since < RESUME_EARLY_MS;

/**
 * Why a saved session is not resumed at all, or null: its harness keeps no explore mode of its own (`modeLostOnResume`) and the record
 * has no mode (saved before Gluon recorded it), so it can't be told whether it was read-only and a resume would not restore that.
 * It is not offered a fresh start either (that would be a build session): the record stays, and the user decides (BUG-612).
 */
export function resumeModeProblem(child: Pick<ChildRecord, "harness" | "mode">, workspaceId: string | null | undefined): string | null {
  if (child.mode || !modeLostOnResume(child.harness)) return null;
  return `was saved before Gluon recorded a session's mode, so it can't be told whether it was read-only (explore), and a resume would not keep that. It was not resumed and stays in the record: delete the workspace with \`gluon sessions --delete ${workspaceId ?? "<id>"}\` (all of its sessions go), or start a new session.`;
}

/** Why a saved session can't be resumed as it is, or null (its harness has a way and the id is known). */
export function resumeProblem(child: Pick<ChildRecord, "harness" | "resume">): string | null {
  if (!HARNESS_INFO[child.harness].resume) return "it has no way to resume a session";
  return child.resume ? null : "it never reported its session id";
}

/** `1 session running — quit and end it?` */
export const quitQuestion = (n: number) => `${n} session${n === 1 ? "" : "s"} running — quit and end ${n === 1 ? "it" : "them"}?`;

/**
 * The home view's questions with their shorter forms, longest first, for a narrow bar
 * (`questionBar`): each keeps what it is about — the session's name (without `Gluon-`), the count
 * (BUG-264).
 */
export const homeQuestions = {
  discard: (): readonly string[] => [DISCARD_QUESTION, "Discard chat?"],
  end: (name: string): readonly string[] => {
    const bare = name.startsWith(NAME_PREFIX) && name.length > NAME_PREFIX.length ? name.slice(NAME_PREFIX.length) : null;
    return bare === null ? [endQuestion(name)] : [endQuestion(name), endQuestion(bare)];
  },
  quit: (n: number): readonly string[] => [quitQuestion(n), `Quit and end ${n} session${n === 1 ? "" : "s"}?`, `End ${n} and quit?`],
  /** A saved session that can't be resumed (`why`: whatever a launch or an agent said, so masked and one safe line): start it again from its saved spec? */
  again: (name: string, label: string, reason: string): readonly string[] => {
    const why = safeLine(maskSecrets(reason), 200);
    const bare = name.startsWith(NAME_PREFIX) && name.length > NAME_PREFIX.length ? name.slice(NAME_PREFIX.length) : name;
    return [`${truncate(name, END_NAME_MAX)} (${label}) can't be resumed (${why}). Start it again with its saved spec?`, `${truncate(bare, END_NAME_MAX)} can't be resumed. Start it again?`, `Start ${truncate(bare, END_NAME_MAX)} again?`];
  },
  /** Without a pseudo-terminal sessions run one at a time: resume this one now? */
  now: (name: string, label: string): readonly string[] => [`Resume ${truncate(name, END_NAME_MAX)} (${label}) now? Sessions run one at a time here.`, `Resume ${truncate(name, END_NAME_MAX)}?`],
};

export async function runGluon(ctx: GluonContext): Promise<never> {
  // Read once now: on Windows it is a PowerShell call (0.3 to 1 s) that must not freeze the UI at the first save (`ownStart`).
  ownStart();
  const { config, cwd, demo, routing } = ctx;
  // A model whose maker would get the session's code is offered only when routing.yaml opts in (`allow_muse_contributor`).
  const agents = offeredAgents(config, { demo, optedIn: optedInBy(routing) });
  if (agents.length === 0) {
    console.error("gluon: no connected agent has a model it can reach (run `gluon doctor`).");
    process.exit(2);
  }
  const brain = new BrainState(config, ctx.step, cwd);
  const repo = repoContext(cwd);
  const store = new SessionStore();
  const { server: telemetry, notice: telemetryNotice } = tryStartTelemetry();
  const runs = new Map<number, AgentSession>();
  // The audit ledger (`src/cost/ledger-file.ts`): one private file per Gluon process, opened at the first entry; `cost.audit: off` keeps none.
  let ledgerWrite: LedgerWriter | null | undefined;
  if (!config.cost.audit) try { removeLedger(); } catch {} // `cost.audit: off` keeps none: also the one an earlier launch wrote (BUG-356)
  const ledgerSink = (e: LedgerEntry) => {
    if (ledgerWrite === undefined) ledgerWrite = config.cost.audit ? openLedgerFile() : null;
    ledgerWrite?.(e);
  };
  // Local analytics (`src/analytics.ts`): one row per launched session in `<state dir>/analytics.db`; `analytics: off` keeps none. Never throws.
  const analytics = new Analytics({ enabled: config.analytics });
  const leaving = new Set<number>();
  const truecolor = ctx.theme.gluon.truecolor;
  const pty = ptyAvailable();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((f) => f());

  const newChat = () =>
    new Session(
      brain.client(demo ? routing : null),
      { ...config, agents },
      systemPrompt({ ...config, agents }, repo, routing),
      cwd,
      (message) => brainErrorHint(brain.step, message, config),
      brain.fallback,
      routing,
    );

  const host: HomeHost = {
    session: newChat(),
    header: {
      version: ctx.version,
      repo: repoLabel(null, cwd),
      branch: repo.branch,
      ...(ctx.resume ? { workspace: ctx.resume.id } : {}),
    },
    readiness: initialReadiness(config, installed),
    asking: null,
    back: null,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  // The saved workspace (`workspaces.ts`): a write that fails never stops Gluon, it says so once.
  // A note from the first save comes while a start swaps the chat for a new one (this very turn): it goes into the new chat.
  const recorder = new Recorder(cwd, ctx.resume, { onError: (m) => queueMicrotask(() => host.session.notice(maskSecrets(m), "info")) });
  // A resumed workspace is this Gluon's from now on (its file names this process).
  recorder.claim();
  /** The row of each session in the record, and the records whose row is about to go but stay (a resumed agent that refused; quitting). */
  const keyOf = new Map<number, string>();
  const kept = new Set<string>();
  const showWorkspace = () => {
    const id = recorder.id ?? undefined;
    if (host.header.workspace === id) return;
    const { workspace: _, ...rest } = host.header;
    host.header = { ...rest, ...(id ? { workspace: id } : {}) };
    changed();
  };

  // Config messages (a file it can't save, a section updated) go into the chat while Gluon runs:
  // Ink would drop anything written to the console (BUG-174).
  setConfigNotices((m) => host.session.notice(maskSecrets(m), "info"));
  if (telemetryNotice) host.session.notice(telemetryNotice, "info");

  // Prices and windows follow the network in the background (`src/cost/refresh.ts`): never awaited, never before the first screen; a failure keeps the
  // stored tables, a move is logged in the ledger, and a new table redraws what shows a price.
  const tablesLedger = new Ledger(ledgerSink);
  onTablesChanged(changed);
  // The demo makes no network call by design: no refresh in it, at start or at a launch (`refreshAllowed`).
  if (refreshAllowed(demo)) void refreshNetworkTables({ ledger: (e) => tablesLedger.add(e) });

  // Gluon's own updates (`src/update/update.ts`): at most one check of GitHub a day, in the background, never before the first screen; `updates: auto`
  // installs a verified release for the next start. Not in the demo (no network call). Loaded only here: the Sigstore libraries cost nothing at start.
  void import("./update/update.ts")
    .then((u) => u.backgroundUpdate({ mode: u.updateMode(config.updates), demo, current: ctx.version, notice: (m) => host.session.notice(maskSecrets(m), "info") }))
    .catch(() => {});

  // The first chat: the brain's reachability and environment notes, as the old flow says them.
  if (!demo && brain.step) {
    const s = brain.step;
    void quickCheck(config, s).then((error) => {
      if (error) host.session.notice(maskSecrets(`The intake agent can't be reached: ${error}\n${brainErrorHint(s, error, config)}`));
    });
    for (const w of envWarnings(s)) host.session.notice(w, "info");
  }

  // Readiness in the background: only the official binaries' own status checks (no paid probe).
  for (const r of host.readiness) {
    if (r.state !== "checking") continue;
    void loginStatus(r.harness)
      .then((s) => {
        const ok = s.loggedIn && !s.wrongMethod;
        host.readiness = host.readiness.map((x) => (x.harness === r.harness ? { harness: r.harness, state: ok ? "ready" : "signin", ...withNote(r.harness, s.loggedIn && s.detail ? s.detail.toLowerCase() : undefined) } : x));
        changed();
      })
      .catch(() => {});
  }

  // The repo's name from its remote (never its host or credentials: `repoLabel`).
  const git = binPath("git");
  if (git && repo.isRepo)
    void gitQuery(git, ["remote", "get-url", "origin"], cwd).then((r) => {
      if (r.code === 0 && r.stdout.trim()) {
        host.header = { ...host.header, repo: repoLabel(r.stdout.trim(), cwd) };
        changed();
      }
    });

  let shuttingDown = false;
  /** The sessions' trackers until their session ends (`tracker.ended()`), for an exit that doesn't wait for it. */
  const trackers = new Set<CostTracker>();
  /** OpenRouter sessions whose billed figure hasn't settled (`src/openrouter-billed.ts`). */
  const billedMeters = new Set<BilledMeter>();
  const billedRegistry = new Registry();
  async function shutdown(code: number, grace = SIGNAL_GRACE_MS): Promise<never> {
    if (!shuttingDown) {
      shuttingDown = true;
      clearInterval(filesTimer);
      await Promise.all([...runs.values()].filter((s) => s.alive).map((s) => s.end(grace)));
      // Kimi's last usage export, so its records are in the ledger before it closes (bounded: an export is cheap).
      await Promise.race([Promise.allSettled([...kimiEnds]), Bun.sleep(KIMI_END_WAIT_MS)]);
      // An export still running when the wait is over: its zip goes now, not at the next start's sweep (BUG-480).
      removeKimiExports();
      // An OpenRouter figure still settling can't wait for OpenRouter's usage (30 to 110 s late): unsettled, no figure (`BilledMeter.abandon`).
      for (const m of billedMeters) m.abandon();
      telemetry?.stop();
      // The audit's last count (what its rate cap refused since the marker) goes out now: no later write would carry it (BUG-403).
      ledgerWrite?.close();
      // Sessions still open end as "quit" (their agents ended above: their own end was already recorded).
      analytics.close();
      setConfigNotices(null);
      host.session.close();
      await compositor.stop();
      // The terminal is back: the way to the saved sessions, on the shell's own screen.
      if (recorder.id) process.stdout.write(`Resume this session: gluon resume ${recorder.id}\n`);
    } else {
      // A second signal (or quit) while the first still waits for the agents: leave at once, but give the terminal back first (BUG-666).
      compositor.abort();
    }
    process.exit(code);
  }

  // The mouse at home: a click on the list, the wheel (BUG-269).
  const mice = new Set<(m: MouseReport) => void>();
  const compositor = new Compositor({
    store,
    home: inkHomeView(
      createElement(HomeRoot, {
        host,
        props: {
          store,
          theme: ctx.theme,
          offeredAgents: agents,
          config,
          onOpen: (id) => void compositor.open(id),
          // Keys typed with the Enter wait for the session it starts (BUG-273); without a pseudo-terminal the agent takes the terminal.
          onStart: (choice) => void (pty ? compositor.starting(start(choice)) : start(choice)).catch((e) => host.session.notice(maskSecrets(`Couldn't start the session: ${(e as Error).message}`))),
          onQuit: () => void quit(),
          onEnd: (id) => void endSession(id),
          onDiscard: () => void discardDraft(),
          homeKey: config.handoff.key,
          canOpen: pty,
          onDraft: (typed) => setTyping(typed),
          // None without `handoff.mouse_capture`: the key list then names no click or wheel.
          ...(config.handoff.mouse_capture
            ? {
                mouse: (fn: (m: MouseReport) => void) => {
                  mice.add(fn);
                  return () => void mice.delete(fn);
                },
              }
            : {}),
        },
      }),
      (m) => mice.forEach((f) => f(m)),
    ),
    homeKey: config.handoff.key,
    onHome: (id) => {
      host.back = { id };
      changed();
    },
    mouseCapture: config.handoff.mouse_capture,
    truecolor,
    config,
    onSignal: (sig) => void shutdown(sig === "SIGHUP" ? 129 : sig === "SIGINT" ? 130 : 143),
  });

  /**
   * `question` on the home view's last row (`Compositor.choose`): yes, no, or null when it was taken
   * away (another question, a session opened); meanwhile the hint names its keys (BUG-224). Only
   * the latest question clears the hint: one taken away must not clear the one that replaced it.
   */
  let questionNo = 0;
  async function askOrNull(kind: HomeQuestion, question: readonly string[], signal?: AbortSignal, selfRaised = false): Promise<Choice> {
    const mine = ++questionNo;
    host.asking = kind;
    changed();
    try {
      return await compositor.choose(question, signal, selfRaised);
    } finally {
      if (mine === questionNo) {
        host.asking = null;
        changed();
      }
    }
  }
  const ask = async (kind: HomeQuestion, question: readonly string[], signal?: AbortSignal) => (await askOrNull(kind, question, signal)) === true;

  const questionOver = () =>
    new Promise<void>((done) => {
      const off = host.subscribe(() => {
        if (host.asking) return;
        off();
        done();
      });
    });

  /** Whether the composer holds typed text (the home view says); a question of Gluon's own waits for it to empty. */
  let typing = false;
  const composerWaiters: (() => void)[] = [];
  const setTyping = (typed: boolean) => {
    typing = typed;
    if (!typed) composerWaiters.splice(0).forEach((f) => f());
  };
  const composerFree = () => (typing ? new Promise<void>((r) => composerWaiters.push(r)) : Promise.resolve());
  /** After the user typed over one of Gluon's questions: how long it leaves them be before asking again. */
  const TYPED_QUIET_MS = 1500;

  /**
   * Gluon's own question to the user, asked again until they answer it: undefined when Gluon is
   * quitting. `selfRaised`: it comes unasked, so it never comes while the composer holds text and
   * gives way to the user typing (`Compositor.choose`); its answer may also be `"keep"` (Ctrl+C).
   */
  async function decide(kind: HomeQuestion, question: readonly string[], selfRaised = false): Promise<boolean | "keep" | undefined> {
    for (;;) {
      // Never over the user's own question (their Delete, Ctrl+C): after it.
      while (host.asking && !shuttingDown) await questionOver();
      if (shuttingDown) return undefined;
      if (selfRaised && typing) {
        await composerFree();
        continue;
      }
      const answer = await askOrNull(kind, question, undefined, selfRaised);
      if (answer === "typed") {
        await Bun.sleep(TYPED_QUIET_MS);
        continue;
      }
      if (answer !== null) return answer;
    }
  }

  /**
   * Delete on a run's row: asked first (BUG-164); on yes the row goes at once, as on a yes to
   * `/clear`, and the agent ends in the background (the subscriber below keeps it in `runs` until
   * it exits, so quitting or a crash still ends it; BUG-200).
   */
  async function endSession(id: number) {
    const s = runs.get(id);
    if (!s?.alive) return store.remove(id);
    // Its row goes meanwhile (its agent exited): the question goes with it (BUG-262).
    const gone = new AbortController();
    const off = store.subscribe(() => !store.get(id) && gone.abort());
    try {
      if (!(await ask("end", homeQuestions.end(store.get(id)?.name ?? "this session"), gone.signal))) return;
    } finally {
      off();
    }
    store.remove(id);
    void s.end();
  }

  /** Delete on the drafting row: asked first, then the chat starts over (BUG-193). */
  async function discardDraft() {
    if (!store.draft() || !(await ask("discard", homeQuestions.discard()))) return;
    store.dropDraft();
    host.session.close();
    host.session = newChat();
    changed();
  }

  async function quit() {
    const live = store.live().length;
    if (live && !(await ask("quit", homeQuestions.quit(live)))) return;
    await shutdown(130, SIGNAL_GRACE_MS);
  }

  // Never leave an agent running behind a Gluon that exits.
  process.on("exit", () => {
    for (const s of runs.values()) s.kill();
    // A crash (or an exit that skips `session.exited`) still judges what waits for ours: the ledger writes synchronously (BUG-475).
    for (const t of trackers) t.ended();
    for (const m of billedMeters) m.abandon();
  });
  // Crash safety: an uncaught error ends every agent and gives the terminal back before exiting.
  const crash = (e: unknown) => {
    for (const s of runs.values()) s.kill();
    compositor.abort();
    // The open sessions' rows get their end ("quit") instead of staying "running" until the heartbeat runs out; never throws.
    analytics.close();
    try {
      process.stderr.write(`gluon: ${maskSecrets(e instanceof Error ? e.message : String(e))}\n${recorder.id ? `Resume this session: gluon resume ${recorder.id}\n` : ""}`);
    } catch {}
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);

  // The work tree's changes: the header's count, and per session since its start.
  const baselines = new Map<number, Map<string, string>>();
  let lastSnapshot: Map<string, string> | null = null;
  let polling = false;
  const pollFiles = async () => {
    if (polling || !repo.isRepo) return;
    polling = true;
    try {
      const live: PolledSession[] = [];
      for (const [id, base] of baselines) if (runs.get(id)?.alive) live.push({ id, base });
      const polled = await pollChanges(cwd, live);
      if (!polled) return;
      const snap = polled.header;
      lastSnapshot = snap;
      if (host.header.modified !== snap.size) {
        host.header = { ...host.header, modified: snap.size };
        changed();
      }
      for (const [id, n] of polled.changed) store.update(id, { filesChanged: n });
    } finally {
      polling = false;
    }
  };
  // Kimi Code's usage refreshes (`src/kimi-usage.ts`) are driven by this timer, never by what is on the screen: each decides for itself whether one is due.
  const kimiTicks = new Map<number, () => void>();
  const kimiEnds = new Set<Promise<void>>();
  // An OpenRouter session's live calibration (`BilledMeter.tick`): the same timer, never the screen; the meter decides whether a reading is due.
  const billedTicks = new Map<number, () => void>();
  const filesTimer = setInterval(() => {
    void pollFiles();
    for (const [id, tick] of kimiTicks) if (runs.get(id)?.alive) tick();
    for (const [id, tick] of billedTicks) if (runs.get(id)?.alive) tick();
    analytics.tick();
  }, FILES_POLL_MS);
  void pollFiles();

  let sectionChecked = false;
  // What the sessions' screen models answer for the real terminal.
  const t = ctx.terminal;
  const colours = { ...(ctx.background ? { bg: ctx.background } : {}), ...(t?.fg ? { fg: t.fg } : {}), ...(t?.cursor ? { cursor: t.cursor } : {}) };
  const screenOptions = { colours, kitty: !!t?.kitty };

  /**
   * No pseudo-terminal here: the agent gets the terminal itself until it ends (`handOffSession`),
   * then the home view is back with one line on how it ended. One session at a time.
   */
  async function startDirect(picked: NamedChoice, choice: NamedChoice, cmd: Command, notes: string[], version: string | null, minted?: string, again?: Again): Promise<Refused> {
    const { harness } = choice;
    const settings = handoffFor(config.handoff, harness);
    const label = HARNESS_INFO[harness].label;
    let running = true;
    const view = store.launched(choice.name, { harness, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}), ...(choice.mode && choice.mode !== "build" ? { mode: choice.mode } : {}) }, { get alive() { return running; }, end: async () => {} }, Date.now(), !again);
    // The record keeps the spec as picked: the mode block is added again at every start.
    const key = track(view, picked, minted, again);
    const run = beginRun(view, picked, cmd, version, minted, again, key);
    // A resumed session comes with the chat the user has; a new one starts it over.
    if (!again) {
      host.session.close();
      host.session = newChat();
    }
    announceSaved();
    changed();
    let end: SessionEnd | Error;
    const startedAt = Date.now();
    try {
      end = await compositor.handOver(async () => {
        // Not through `console`: Ink, suspended, would drop it. Nothing through stdout either:
        // a write there right before the agent starts left the agent's terminal dead on macOS (BUG-189).
        const lines = [...[...notes, NO_PTY_NOTE].map((n) => `gluon: note: ${n}`), ...(settings.on_exit === "return" ? [`Quit ${label} to come back to Gluon`] : [])];
        process.stderr.write(lines.map((l) => `${l}\n`).join(""));
        return handOffSession(cmd, settings, cwd);
      });
    } catch (e) {
      end = e as Error;
    }
    running = false;
    run?.end(end instanceof Error ? { code: null, reason: "spawn-failed" } : { code: end.code, reason: end.reason });
    if (end instanceof Error) {
      // A session that was in the record stays there: it wasn't the session that failed.
      if (again) kept.add(key);
      store.remove(view.id);
      if (again) return { problem: end.message };
      host.session.notice(maskSecrets(`Couldn't start ${label}: ${end.message}\nThe spec, to launch by hand:\n\n${choice.spec.trim()}`));
      return;
    }
    // A resumed session whose agent refused it (as `wire` has it): it stays in the record, and the question follows.
    const refused = again?.resume && end.reason === "exit" && resumeRefused(end.code, startedAt);
    if (refused) kept.add(key);
    // An ended session closes: the row goes (and leaves the record), the chat says how it ended.
    store.remove(view.id);
    if (refused) return { problem: `${label} exited with code ${end.code} right after resuming` };
    if (end.reason === "exit" && settings.on_exit === "quit") return void shutdown(end.code);
    host.session.notice(directNotice(label, end), "info");
  }

  /** A launch that continues a saved session (`resume`: reopen it; else start it again from its saved spec). */
  interface Again {
    child: ChildRecord;
    resume: boolean;
  }
  /** Why a resumed session's launch was refused: the question that follows says it (nothing goes in the chat). */
  type Refused = { problem: string } | undefined;

  /** The launched row's place in the saved workspace: a new session in the record, or the one it continues. Returns its key. */
  function track(view: SessionView, choice: NamedChoice, minted: string | undefined, again?: Again): string {
    const resume = minted ? { id: minted, source: "minted" as const } : undefined;
    let key: string;
    if (again) {
      key = again.child.key;
      // Started again: a new id (or none), not the one the harness refused (a Codex or OpenCode one sends its id by hook).
      if (!again.resume) recorder.update(key, { name: view.name, resume, mode: choice.mode ?? "build", permissions: choice.permissions });
      if (again.child.done) store.update(view.id, { markedDone: true });
    } else {
      key = recorder.add({ name: view.name, harness: choice.harness, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}), mode: choice.mode ?? "build", ...(choice.permissions ? { permissions: choice.permissions } : {}), spec: choice.spec, startedAt: view.startedAt, ...(resume ? { resume } : {}) }).key;
    }
    keyOf.set(view.id, key);
    return key;
  }

  /** The session's row in the local analytics (`src/analytics.ts`), from what the user picked: the spec as shown, not Gluon's mode additions. */
  function beginRun(view: SessionView, picked: NamedChoice, cmd: Command, version: string | null, minted: string | undefined, again: Again | undefined, key: string): Run | undefined {
    const saved = again?.resume ? again.child.resume : undefined;
    const agentSessionId = minted ?? saved?.id;
    return analytics.begin({
      kind: again ? (again.resume ? "resume" : "restart") : "new",
      childKey: key,
      ...(recorder.id ? { workspaceId: recorder.id } : {}),
      name: view.name,
      cwd,
      ...(host.header.repo ? { repo: host.header.repo } : {}),
      ...(host.header.branch ? { branch: host.header.branch } : {}),
      harness: picked.harness,
      ...(version ? { harnessVersion: version } : {}),
      model: picked.model,
      ...(picked.effort ? { effort: picked.effort } : {}),
      // A resumed session goes through the harness's own resume: no mode applied.
      ...(again?.resume ? {} : { mode: picked.mode ?? "build" }),
      conn: cmd.conn ?? "plan",
      ...(picked.types ? { routingTypes: picked.types } : {}),
      ...(picked.why ? { routingWhy: picked.why } : {}),
      spec: picked.spec,
      ...(agentSessionId ? { agentSessionId, agentSessionSource: minted ? ("minted" as const) : (saved?.source ?? ("minted" as const)) } : {}),
      gluonVersion: ctx.version,
    });
  }

  /** Once a session is saved: the header names the workspace (a chat note would cost a short terminal its session list: BUG-162), and quitting prints how to come back. */
  function announceSaved() {
    if (recorder.id) showWorkspace();
  }

  /**
   * The user picked an agent: the draft becomes a run, shown in the frame; the chat starts over.
   * `again`: a saved session instead (`resumeWorkspace`): its row joins the list, the chat and the view stay as
   * they are, and a refusal comes back as `Refused` for the question that follows.
   */
  async function start(picked: NamedChoice, again?: Again): Promise<Refused> {
    const chat = host.session;
    const { harness } = picked;
    const notes: string[] = [];
    // The brief says what the mode lets the agent do, whatever the spec says (ctrl+t may have changed the mode after the brain wrote it: BUG-410).
    // A resume goes through the harness's own resume: no mode block in it, no mode applied.
    // The launcher adds, per option, a line for each instruction file the harness doesn't load and (OpenCode) the subagent models (`src/intake.ts`).
    const choice = again?.resume ? picked : { ...picked, spec: withMode(withLauncherLines(picked.spec, launcherLines({ routing, catalog: routeCatalog({ ...config, agents }, agents, routing), harness, model: picked.model, instructionFiles: (repo.instructions ?? []).map((f) => f.file) })), picked.mode) };
    const settings = handoffFor(config.handoff, harness);
    const label = HARNESS_INFO[harness].label;
    const refuse = (problem: string, notice = problem): Refused => {
      if (again) return { problem };
      chat.notice(notice);
    };
    const version = await versionOf(harness);
    // Claude Code and Grok Build take the id Gluon names at the launch; a resume names the saved one.
    const minted = !again?.resume && HARNESS_INFO[harness].resume === "minted" ? crypto.randomUUID() : undefined;
    const ref = again?.resume ? { id: again.child.resume!.id, resume: true } : minted ? { id: minted, resume: false } : undefined;
    let cmd: Command;
    try {
      cmd = buildCommand(config, choice, adapterOutput({ harness, version, handoff: settings, env: process.env }), ref);
    } catch (e) {
      return refuse((e as Error).message, maskSecrets(`Couldn't start ${label}: ${(e as Error).message}`));
    }
    // OpenCode's plugin takes the history of a resumed session off its cumulative figures (`src/adapters/opencode.ts`).
    if (harness === "opencode" && ref?.resume) cmd = { ...cmd, env: { ...cmd.env, GLUON_RESUMED: "1" } };
    const problem = launchProblem(config, harness, cmd.conn) ?? tooOld(harness, version);
    if (problem) return refuse(problem);
    // The launch refreshes this harness's tables, the network ones when the last is old, an OpenRouter model's row: in the background, never awaited.
    if (refreshAllowed(demo)) {
      const launched = config.models[harness].find((m) => m.id === choice.model);
      const launchedPrice = launched ? priceKey(harness, launched.ids, cmd.conn ?? "plan") : undefined;
      refreshOnLaunch({ harness, version, ...(cmd.conn === "openrouter" && launchedPrice?.startsWith("openrouter/") ? { openrouterKey: launchedPrice } : {}), deps: { ledger: (e) => tablesLedger.add(e) } });
    }
    if (cmd.conn === "plan") notes.push(...(harness === "claude-code" ? subscriptionEnvWarnings() : harness === "codex" ? codexEnvWarnings() : []));
    const permanent = ensurePermanentFiles(harness);
    if (permanent) notes.push(permanent);
    // Antigravity's context comes from its status line (it has no cost Gluon can use): one key in its own settings, only when the owner's setting is on.
    if (harness === "antigravity" && config.cost.antigravityStatusline) {
      const note = ensureAgyStatusLine({ configDir: dirname(configPath()) });
      if (note) notes.push(note);
    }
    if (!sectionChecked) {
      sectionChecked = true;
      ensureHandoffSection();
    }
    // No pseudo-terminal: nothing can type the mode's first line into the agent.
    // (A resume types nothing: the mode's line went in the first time.)
    const typed = !pty && !again?.resume ? typedModeProblem(harness, choice.mode) : null;
    if (typed) return refuse(typed, maskSecrets(`Couldn't start ${label}: ${typed}`));
    if (!pty) return startDirect(picked, choice, cmd, notes, version, minted, again);
    if (telemetry && (harness === "claude-code" || harness === "grok-build") && ownTelemetry(process.env, harness)) notes.push(`cost and context aren't shown for this session: your environment has OpenTelemetry settings of its own (OTEL_*, ${harness === "grok-build" ? "GROK_EXTERNAL_OTEL" : "CLAUDE_CODE_ENABLE_TELEMETRY"}), which Gluon leaves as they are.`);
    const approx = cmd.conn !== undefined && isPlanConn(cmd.conn);
    let id = -1;
    // This session's row in the local analytics (begun once the session is up, below).
    let run: Run | undefined;
    // The largest prompt so far of each model: it tells a 1M window from a 200k one (`ownWindow`). Per model: a /model switch to a 200k one does not inherit the 1M another proved (BUG-366).
    const peaks = new Map<string, number>();
    // Gluon's own cost (`src/cost/`): the harness's own figures only audit it.
    const entry = config.models[harness].find((m) => m.id === choice.model);
    // No connection named: the harness runs on its own login (its plan).
    const conn: Conn = cmd.conn ?? "plan";
    const launchedKey = entry ? priceKey(harness, entry.ids, conn) : undefined;
    const ledger = new Ledger(ledgerSink);
    // Claude's cache TTL is what the user's own settings and environment say (`harness-config.ts`: named keys only); unset, Claude's automatic rule is assumed.
    const cacheTtl = harness === "claude-code" ? claudeCacheTtl({ home: homedir(), cwd, env: process.env, bedrock: conn === "bedrock" }) : undefined;
    // A table this session needed and didn't have yet arrived (`tables`, below): what it priced, redrawn; a session is pinned to the tables it was made with.
    let tablesArrived: (change: { priced: number }) => void = () => {};
    const tracker = new CostTracker({ harness, conn, ...(launchedKey ? { launchedKey } : {}), ...(version ? { harnessVersion: version } : {}), ...(cacheTtl && (cacheTtl.main || cacheTtl.subagent) ? { cacheTtl } : {}), ledger, onTables: (c) => tablesArrived(c) });
    trackers.add(tracker);
    // OpenRouter bills each request at the provider that served it: the figure is an estimate (`~`) unless the price table says the model has one endpoint price (offline data), and the key's usage settles it.
    const billedFrom = conn === "openrouter" ? billedSource() : null;
    const orKey = billedFrom ? secret("OPENROUTER_API_KEY") : undefined;
    if (conn === "openrouter") tracker.openrouterSession();
    let billed: BilledMeter | undefined;
    // The last request's prompt as Gluon counts it (the telemetry's): what the context % is computed from, and what a harness's own figure is audited against.
    let last: { tokens: number; model: string; windowOverride?: number } | undefined;
    let grokSession: string | undefined;
    let grokAudited = 0;
    let grokAuditing = false;
    // A resumed Grok session's `grok usage` totals include its history: what they were before this launch's first turn is taken off the audit.
    const grokResumed = harness === "grok-build" && ref?.resume ? ref.id : undefined;
    let grokBaselined = grokResumed === undefined;
    const grokBefore = grokResumed ? readGrokUsage(grokResumed, { tries: 1, after: -1 }).then((r) => {
      // One that finished after the first request is no baseline (it holds that turn): the first audit takes it instead.
      if (r && r.micros !== null && grokSession === undefined) {
        tracker.grokBaseline(r.micros, r.modelCalls);
        grokBaselined = true;
      }
    }, () => {}) : undefined;
    const auditGrok = async () => {
      if (grokAuditing || !grokSession) return;
      grokAuditing = true;
      try {
        await grokBefore;
        const report = await readGrokUsage(grokSession, { after: grokAudited });
        if (report) {
          grokAudited = report.turns;
          if (!grokBaselined && tracker.grokBaselineFromReport(report)) grokBaselined = true;
          tracker.grokUsageReport(report);
        }
      } catch {} finally {
        grokAuditing = false;
      }
    };
    const showCost = () => {
      const f = tracker.figure();
      // `own: false`: the harness's own total stands in because a request had no price of ours (marked in the row).
      // No figure while a request waits for its price table: the row shows `—` until it is priced.
      if ((f || tracker.pendingNow()) && id >= 0) store.update(id, { cost: f ? { usd: f.usd, approx: f.approx, own: f.own, ...(f.billed ? { billed: true } : {}) } : undefined });
      if (f) run?.set({ cost: f });
      billed?.observe(tracker.ownUsdNow());
    };
    /** Gluon's own window and percentage for a prompt of this size (`src/cost/context.ts`): Gluon's tables only, never a figure a harness reports. */
    const ownContext = (c: NonNullable<typeof last>) => {
      const { window, source } = ownWindow(harness, c.model, { tables: tracker.tables(), launchedModel: (harness === "claude-code" && entry && idOn(entry, conn)) || choice.model, peak: Math.max(peaks.get(c.model) ?? 0, c.tokens), env: process.env, ...(c.windowOverride ? { override: c.windowOverride } : {}) });
      // A default window for a model no table knows is a guess: kept for the ledger (marked `unknown-model`), never shown as the row's % (BUG-369).
      return { window, pct: ownPercent(harness, c.tokens, window), guessed: windowIsGuess(source) };
    };
    /**
     * The row's context %: from the last request's tokens (null: the context was compacted, unknown until the next request) and our own window.
     * OpenCode's steps call this for the conversation on screen (its window is models.dev's `limit.context`); what its status channel says
     * is audited and not shown (`onReportedContext`).
     */
    const showContext = (c: typeof last | null) => {
      last = c ?? undefined;
      if (c) peaks.set(c.model, Math.max(peaks.get(c.model) ?? 0, c.tokens));
      // The window table not here yet (first run, still fetching): the % is unknown until it is (`tablesArrived`).
      const own = c && tracker.windowReady() ? ownContext(c) : undefined;
      // The ledger pairs a reading the harness sent a few ms ahead of this request's record with this figure (`ownContextChanged`).
      tracker.ownContextChanged(c ? { tokens: c.tokens, ...(own?.window ? { window: own.window } : {}), ...(own?.guessed ? { guessed: true } : {}) } : undefined);
      if (id >= 0) store.update(id, { contextPct: own && !own.guessed ? own.pct : undefined });
      // Only a real reading is recorded (an unknown one keeps the last).
      if (own && !own.guessed) run?.set({ contextPct: own.pct });
    };
    tablesArrived = ({ priced }) => {
      // Requests priced late rewrite the estimate the live calibration compares with the key's usage: it starts again from the new one.
      if (priced) billed?.restate(tracker.ownUsdNow());
      showCost();
      if (last) showContext(last);
    };
    const channel = telemetry?.session({
      onCost: (usd) => {
        tracker.reportedCumulative(usd);
        showCost();
      },
      onUsage: (u) => {
        if (u.harness === "claude-code") tracker.claudeRequest(u);
        else if (u.harness === "grok-build") {
          grokSession ??= u.session;
          tracker.grokRequest(u);
        }
        else tracker.codexResponse(u);
        showCost();
      },
      // Codex's own estimate of a turn's cost: audited against ours in the ledger, never shown.
      onTurnCost: (t) => tracker.codexTurnCost(t),
      // null: the conversation was compacted, its size is unknown until the next request (as in the agent's own status line).
      // Codex resolves a model's window as Codex does (its catalog, its fallback, the config's override); Grok's is its catalog's.
      onContext: (c) => showContext(c ? { tokens: c.tokens, model: c.model ?? choice.model, ...(c.windowOverride ? { windowOverride: c.windowOverride } : {}) } : null),
    });
    // Kimi Code's usage comes from its own `kimi export` of the session this launch made (`src/kimi-usage.ts`); the notice is kept for the end.
    const kimi =
      harness === "kimi-code"
        ? kimiUsage({
            cwd,
            startedAt: Date.now(),
            onRecords: (records) => {
              tracker.kimiRecords(records);
              showCost();
            },
            onProblem: (reason) => ledger.add({ kind: "dropped", t: Date.now(), harness, what: "usage", reason: `kimi-${reason}`, count: 1 }),
          })
        : undefined;
    // The key's usage before the session (bounded: a slow answer is no baseline, never a stuck launch); registered first, so a session starting meanwhile sees this one.
    if (billedFrom && orKey) {
      const note = (m: string) => {
        if (!shuttingDown) host.session.notice(maskSecrets(`${choice.name}: ${m}`), "info");
      };
      billed = await BilledMeter.begin({
        key: orKey,
        source: billedFrom,
        registry: billedRegistry,
        onCalibration: (k) => {
          tracker.setCalibration(k);
          showCost();
        },
        onSettled: (r) => {
          billedMeters.delete(billed!);
          billedTicks.delete(id);
          settled(r, { tracker, ledger, harness, note });
          // The key's billed figure replaces the estimate: the row gets it too.
          const f = tracker.figure();
          if (f) run?.set({ cost: f });
        },
      });
      billedMeters.add(billed);
    }
    const { cols, rows } = compositor.interior;
    let session: AgentSession;
    try {
      const launched = launchSession(cmd, settings, { cwd, cols, rows, screen: screenOptions, ...(channel ? { telemetry: channel } : {}) });
      session = launched.session;
      notes.push(...launched.notes);
    } catch (e) {
      channel?.close();
      kimi?.dispose();
      billed?.cancel();
      return refuse((e as Error).message, maskSecrets(`Couldn't start ${label}: ${(e as Error).message}\nThe spec, to launch by hand:\n\n${choice.spec.trim()}`));
    }
    const view = store.launched(choice.name, { harness, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}), ...(choice.mode && choice.mode !== "build" ? { mode: choice.mode } : {}) }, session, Date.now(), !again);
    id = view.id;
    runs.set(id, session);
    if (kimi) kimiTicks.set(id, kimi.tick);
    if (billed) billedTicks.set(id, () => billed!.tick(tracker.ownUsdNow(), tracker.usageExpected(), tracker.requestsNow()));
    const key = track(view, picked, minted, again);
    run = beginRun(view, picked, cmd, version, minted, again, key);
    // Codex and OpenCode send their session id by hook (`session` event): saved when it comes.
    if (HARNESS_INFO[harness].resume === "captured")
      session.onSessionId((sid) => {
        recorder.update(key, { resume: { id: sid, source: "captured" } });
        run?.set({ agentSessionId: sid, agentSessionSource: "captured" });
      });
    // Codex's hooks name the thread they run in: that is the main conversation (a `/fork` or `/new` moves it); context follows it, cost sums all.
    if (harness === "codex") session.onMainSession((sid) => channel?.setMainConversation(sid));
    if (again?.resume) store.update(id, { activity: RESUMED });
    if (lastSnapshot) baselines.set(id, lastSnapshot);
    else
      void statusSnapshot(cwd).then((s) => {
        if (s) baselines.set(id, s);
      });
    wire(id, session, approx, settings.on_exit, {
      // The agent ended (before Gluon's own shutdown handling): the row's end. Its own quit, a `/clear` or the home key are the exit's reason; Gluon quitting is "quit".
      onEnded: (code, reason) => {
        const cost = tracker.figure();
        run?.end({ code, reason: shuttingDown ? "quit" : reason, ...(cost ? { cost } : {}) });
      },
      // Claude's plugin measures what its own status line shows: audit only, never the figure (with the user's own OTEL it is all there is, and still not shown).
      onReportedCost: (usd) => {
        // Antigravity reports none (the row's cost is `—` until issue #76), and one it did would not be shown.
        if (harness === "antigravity") return;
        if (harness === "claude-code") return tracker.observeCost(usd);
        tracker.reportedCumulative(usd);
        showCost();
      },
      // Antigravity's status line: the conversation's size (`total_input_tokens`, as agy counts its own %) over Gluon's window. Every reading sets it,
      // the zero of a `/clear` included, so the old conversation's figure is never kept (BUG-389). No cost: agy's totals are the size, not what was billed (BUG-387).
      onAgyTotals: (u) => {
        const tokens = agyContextTokens(u, last?.tokens);
        if (tokens !== undefined) showContext({ tokens, model: u.model ?? choice.model });
      },
      onStepsRepeated: (count) => tracker.stepsRepeated(count),
      onStep: (step, context) => {
        tracker.opencodeStep(step);
        showCost();
        // The context of the conversation on screen (the plugin says which steps are: subagents', title requests and failed compactions' are not): the last step's whole prompt and answer.
        if (context === "step") showContext({ tokens: opencodeContextTokens(step.tokens), model: step.model });
        else if (context === "compacted") showContext(null);
      },
      // What the harness says its context is (Claude's `session.measure`, OpenCode's footer, agy's status line): beside ours in the ledger, never shown.
      // Ours is the tracker's last (`ownContextChanged`): the reading comes before the request's own record, and waits for it (BUG-472).
      onReportedContext: (m) => tracker.observeContext({ reported: m }),
      // Grok's own persisted totals audit ours once a turn is over (`src/cost/grok-usage.ts`).
      onDone: () => {
        if (harness === "grok-build") {
          // A turn's end leaves no subagent running, however its records ended (an interrupted one sends no `completed`: BUG-401).
          channel?.turnEnded();
          void auditGrok();
        }
        if (harness === "codex") tracker.codexTurnEnded();
      },
    }, again?.resume ? again.child : undefined, key);
    // Codex's PreCompact hook: the compaction's own request is no context, and until the next one the context is unknown.
    session.onCompacting(() => {
      channel?.expectCompaction();
      if (id >= 0) store.update(id, { contextPct: undefined });
    });
    void session.exited.finally(() => {
      channel?.close();
      // A `grok usage` report still waiting for requests that never came is a dropped entry, not silence; a running total or a context reading
      // still waiting for our own figure is compared now.
      tracker.ended();
      trackers.delete(tracker);
      billedTicks.delete(id);
      // What the tracker's last judgement added (a late usage record) goes into the row already ended.
      const late = tracker.figure();
      if (late) run?.set({ cost: late });
      // The session's last requests are in OpenRouter's usage 30 to 110 s from now: it settles in the background, the UI and a quit never wait for it.
      if (billed && !shuttingDown) void billed.finish({ usd: tracker.ownUsdNow(), expects: tracker.usageExpected(), requests: tracker.requestsNow() });
      if (kimi) {
        kimiTicks.delete(id);
        // Kimi has exited: its session is final. One last export (the user's own quit, or Gluon's), then the figure's problem, if any, in the chat.
        const end: Promise<void> = kimi.end().then(
          () => {
            if (shuttingDown || kimi.session) return;
            const why = kimi.problem === "ambiguous" ? "more than one Kimi Code session of this directory started meanwhile" : kimi.problem === "export-failed" || kimi.problem === "unreadable" ? "`kimi export` gave nothing Gluon can read" : undefined;
            if (why) host.session.notice(maskSecrets(`${choice.name}: no cost figure (${why}).`), "info");
          },
          () => {},
        ).finally(() => kimiEnds.delete(end));
        kimiEnds.add(end);
      }
    });
    compositor.add(id, session);
    // The launch's first line (Codex's `/plan …`) couldn't be typed: the note names the line for the user to type, in the home chat and
    // in the agent's frame (a new session opens straight into it: BUG-409).
    session.onNote((n) => {
      host.session.notice(maskSecrets(`note: ${n}`), "info");
      compositor.note(id, maskSecrets(n));
    });
    if (again) {
      for (const n of notes) host.session.notice(`note: ${n}`, "info");
      announceSaved();
      changed();
      return;
    }
    // A new draft: the next chat starts empty.
    chat.close();
    host.session = newChat();
    for (const n of notes) host.session.notice(`note: ${n}`, "info");
    announceSaved();
    changed();
    await compositor.open(id);
  }

  /** What a session's own signals feed besides the row: the harness's reported cost, Antigravity's conversation size, its steps, the context it reports (audited, not shown), a finished turn. */
  interface WireHooks {
    onEnded: (code: number, reason: string) => void;
    onReportedCost: (usd: number) => void;
    onAgyTotals: (u: { model?: string; input: number }) => void;
    onStep: (step: Parameters<CostTracker["opencodeStep"]>[0], context?: "step" | "compacted") => void;
    onStepsRepeated: (count: number) => void;
    onReportedContext: (m: { tokens?: number; window?: number; pct?: number }) => void;
    onDone: () => void;
  }

  /**
   * The session's signals into the store (display only), and what its end means. `resumed`: the saved
   * session this one reopens (its agent refusing it, soon after the start, is a question; `offerAgain`).
   */
  function wire(id: number, s: AgentSession, approx: boolean, onExit: string, hooks: WireHooks, resumed?: ChildRecord, key?: string) {
    const startedAt = Date.now();
    let wasDone = false;
    const status = (st: SessionStatus) => {
      if (!s.alive) return;
      // An agent with no activity of its own to show (no hooks): "Working" while it is, never "Starting" for good.
      const state = runState(st.state, s.question);
      const patch: Parameters<SessionStore["update"]>[1] = { state, activity: s.question ?? st.activity ?? (st.state === "working" ? WORKING : "") };
      store.update(id, patch);
      if (st.state === "done" && !wasDone) hooks.onDone();
      wasDone = st.state === "done";
    };
    s.onStatus(status);
    // The figures the harness reported, each once (a later state change re-sends none: BUG-399). The harness's own running total (OpenCode's plugin)
    // is audited against ours, shown only when ours can't be. A size it reports is never shown (the context % is Gluon's own: `showContext`);
    // a compaction clears the figure.
    s.onFigures((f) => {
      if (!s.alive) return;
      if (f.contextTokens === null) store.update(id, { contextPct: undefined });
      if (f.costUsd !== undefined) hooks.onReportedCost(f.costUsd);
      if (f.totals) hooks.onAgyTotals({ input: f.totals.input, ...(f.model ? { model: f.model } : {}) });
      if (typeof f.contextTokens === "number") hooks.onReportedContext({ tokens: f.contextTokens, ...(f.contextWindow ? { window: f.contextWindow } : {}) });
    });
    // OpenCode's per-step usage: priced by Gluon (`src/cost/`), each step once.
    const gate = stepGate();
    s.onSteps((steps) => {
      const { fresh, repeated } = gate(steps);
      if (repeated) hooks.onStepsRepeated(repeated);
      for (const st of fresh) {
        hooks.onStep({ model: st.model, tokens: { input: st.input, output: st.output, reasoning: st.reasoning, cache: { read: st.cacheRead, write: st.cacheWrite } }, ...(st.cost !== undefined ? { reportedUsd: st.cost } : {}), ...(st.side ? { side: true } : {}) }, st.context);
      }
    });
    // Gluon's own question ("/clear ends this session in Gluon — end it?") is what the row waits for.
    s.onQuestion((q) => (q ? store.update(id, { state: "awaiting", activity: q }) : status(s.state)));
    // The first output with nothing said yet: it is at work (BUG-179).
    const first = s.onChange(() => {
      first();
      if (store.get(id)?.activity === STARTING) store.update(id, { activity: WORKING });
    });
    s.onBack(() => {
      const v = compositor.current;
      if (v.kind === "session" && v.id === id) void compositor.home();
    });
    // A yes to ending it: the row goes now; the agent ends in the background (BUG-191).
    s.onClosed(() => store.remove(id));
    s.onExit((code) => {
      hooks.onEnded(code, s.reason);
      baselines.delete(id);
      // Quitting: every agent ends; the frame goes with Gluon.
      if (shuttingDown) return;
      // An ended session closes: its row goes (and its screen, home shown if it was up: the
      // subscriber below). An agent that exited on its own with an error leaves its line in the chat.
      const name = store.get(id)?.name;
      // A resumed agent that exited with an error soon after starting (its row still there: the user didn't end it)
      // refused the session: it stays in the record.
      const refused = resumed && key && name !== undefined && s.reason === "exit" && resumeRefused(code, startedAt);
      if (refused) kept.add(key);
      store.remove(id);
      if (s.reason === "exit" && code !== 0 && name) host.session.notice(exitNotice(name, code), "info");
      if (refused) return later(() => offerAgain(resumed, `${HARNESS_INFO[resumed.harness].label} exited with code ${code} right after resuming`));
      // `on_exit: quit`: Gluon goes with the last session the agent itself ended, when no draft is open.
      if (s.reason === "exit" && onExit === "quit" && store.live().length === 0 && !store.draft()) void shutdown(code);
    });
  }

  // The record follows the list: a session's name and done mark as the user sets them; a session
  // that ended (its row went) leaves it. Not while quitting: the agents ending then are not sessions
  // ended, and the record keeps them for `gluon resume`.
  store.subscribe(() => {
    for (const [rowId, key] of keyOf) {
      const row = store.get(rowId);
      if (row) {
        recorder.update(key, { name: row.name, done: row.markedDone ? true : undefined });
        continue;
      }
      keyOf.delete(rowId);
      if (!shuttingDown && !kept.delete(key)) recorder.remove(key);
    }
    showWorkspace();
  });

  // A saved effort the model no longer takes (efforts are per model now: some take none) is dropped, not a reason the session can't come back (BUG-423).
  const takes = (c: ChildRecord) => !c.effort || !!config.models[c.harness].find((m) => m.id === c.model)?.efforts.includes(c.effort);
  const choiceOf = (c: ChildRecord): NamedChoice => ({ name: c.name, harness: c.harness, model: c.model, ...(c.effort && takes(c) ? { effort: c.effort } : {}), ...(c.mode ? { mode: c.mode } : {}), ...(c.permissions && permissionLevels(c.harness).includes(c.permissions) ? { permissions: c.permissions } : {}), spec: c.spec, reason: "resumed" });

  /** Why a saved session can't be launched at all now (its agent is gone or its model is), or null. */
  function launchCheck(c: ChildRecord): string | null {
    const label = HARNESS_INFO[c.harness].label;
    const agent = agents.find((a) => a.harness === c.harness);
    if (!agent) return `${label} isn't connected or installed`;
    if (!agent.models.some((m) => m.id === c.model)) return `${label} doesn't offer ${c.model} any more`;
    return validateChoice({ ...config, agents }, choiceOf(c));
  }

  /** Questions about saved sessions, one at a time. */
  let questions: Promise<void> = Promise.resolve();
  const later = (f: () => Promise<void>) => void (questions = questions.then(f).catch(() => {}));

  /** A saved session that couldn't be resumed (`why`): start it again from its saved spec (yes), or drop it from the record (no). */
  async function offerAgain(child: ChildRecord, why: string) {
    if (shuttingDown || !recorder.get(child.key)) return;
    const label = HARNESS_INFO[child.harness].label;
    const cannot = launchCheck(child);
    if (cannot) {
      host.session.notice(maskSecrets(`${child.name} (${label}) can't be resumed (${why}), nor started again (${cannot}). It stays in workspace ${recorder.id ?? "its record"} until you can; to let it go, quit Gluon and delete that workspace with: gluon sessions --delete ${recorder.id ?? "<id>"}`), "info");
      return;
    }
    const answer = await decide("again", homeQuestions.again(child.name, label, why), true);
    if (answer === undefined) return;
    // Ctrl+C: not now. The record stays, and the next resume asks again; only Esc drops it.
    if (answer === "keep") return void host.session.notice(maskSecrets(`${child.name} stays in workspace ${recorder.id ?? "its record"}: gluon resume asks about it again.`), "info");
    if (!answer) {
      recorder.remove(child.key);
      return showWorkspace();
    }
    const refused = await start(choiceOf(child), { child, resume: false });
    if (refused) host.session.notice(maskSecrets(`Couldn't start ${child.name} (${label}): ${refused.problem}\nIt stays in the record.`), "info");
  }

  /**
   * `gluon resume`: every saved session in turn, reopened with its harness's own resume (no spec sent
   * again). Those that can't be (no way, no id, refused) are asked about once the others are up.
   * Without a pseudo-terminal, one at a time, each only if the user says so.
   */
  async function resumeWorkspace() {
    const again: [ChildRecord, string][] = [];
    for (const child of [...recorder.children]) {
      if (shuttingDown) return;
      const label = HARNESS_INFO[child.harness].label;
      const unmoded = resumeModeProblem(child, recorder.id);
      if (unmoded) {
        host.session.notice(maskSecrets(`${child.name} (${label}) ${unmoded}`), "info");
        continue;
      }
      const why = resumeProblem(child) ?? launchCheck(child);
      if (why) {
        again.push([child, why]);
        continue;
      }
      if (!pty && (await decide("resume", homeQuestions.now(child.name, label), true)) !== true) continue;
      const refused = await start(choiceOf(child), { child, resume: true });
      if (refused) again.push([child, refused.problem]);
    }
    for (const [child, why] of again) later(() => offerAgain(child, why));
  }

  // A row removed from the list (its session ended, or the user deleted it): its screen goes too.
  store.subscribe(() => {
    for (const [id, s] of runs) {
      if (store.get(id) || leaving.has(id)) continue;
      // An agent still ending (a /clear it runs first) stays in `runs` until it exits, so quitting
      // or a crash still ends it.
      leaving.add(id);
      void compositor.remove(id).then(async () => {
        await s.exited.catch(() => {});
        runs.delete(id);
        leaving.delete(id);
        s.dispose();
      });
    }
  });

  await compositor.start();
  if (ctx.resume) {
    const n = ctx.resume.sessions.length;
    host.session.notice(`Resuming workspace ${ctx.resume.id} (${ctx.resume.name}): ${n} saved session${n === 1 ? "" : "s"}.`, "info");
    void resumeWorkspace().catch((e) => host.session.notice(maskSecrets(`Couldn't resume: ${(e as Error).message}`)));
  }
  if (ctx.task) {
    store.ensureDraft();
    void host.session.submit(ctx.task);
  }
  // Runs until quit (`shutdown` exits).
  return new Promise<never>(() => {});
}
