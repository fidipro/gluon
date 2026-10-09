/**
 * Gluon's sessions: what the home list and the in-session chrome show. One store for the whole
 * process, plain TypeScript (no React), read by the home view (Ink) and the compositor alike.
 *
 * A session is either a **draft** (the intake chat that hasn't launched yet; at most one) or
 * a **run** (an agent in its own PTY). Status, activity, cost and context come from the agent's
 * hooks, telemetry and a quiet-output fallback; they are display only and never trigger anything.
 * Done is the user's word alone (`markedDone`, Ctrl+D on the home list): an agent's "turn
 * finished" reads as awaiting input. A session that ends closes: its row is removed.
 */
import { numberedName } from "./agent/choices.ts";
import type { AgentState } from "./events.ts";
import type { Effort, Harness, Mode, Permissions } from "./harnesses.ts";

export type SessionState = "awaiting" | "working" | "done" | "drafting";

/** The order the home list groups sessions in (empty groups are hidden; `groupOf`). */
export const GROUPS: readonly SessionState[] = ["awaiting", "working", "done", "drafting"];

export const GROUP_LABEL: Record<SessionState, string> = {
  awaiting: "Awaiting input",
  working: "Working",
  done: "Done",
  drafting: "Drafting",
};

export interface AgentTripleView {
  harness: Harness;
  model: string;
  effort?: Effort;
  /** How it started, when not build (explore, plan); none for a resumed session (the harness keeps its own). */
  mode?: Mode;
  /** Who approves its commands and edits, in build mode (ctrl+p); none or `own`: the harness itself. */
  permissions?: Permissions;
}

export interface SessionView {
  id: number;
  /** Short slug; `(untitled)` for a draft the chat hasn't named yet. */
  name: string;
  state: SessionState;
  /** Null for a draft (agent not chosen yet). */
  agent: AgentTripleView | null;
  /** One line, display only (sanitised where it comes from the agent). */
  activity: string;
  /** Dollars so far; `approx` when it's an API-equivalent figure (a plan); `own: false` when it is the harness's own total, because Gluon had no price for a request. Undefined = unknown (—). */
  cost?: { usd: number; approx: boolean; own?: boolean; /** What OpenRouter billed (the key's usage over the session): exact. */ billed?: boolean };
  /** Context-window usage, 0–100. Undefined = unknown (—). */
  contextPct?: number;
  /** Files changed since the session started (approximate: the tree is shared). */
  filesChanged?: number;
  startedAt: number;
  /** The user marked it done (Ctrl+D on its row): its group is Done whatever its state. */
  markedDone?: boolean;
}

/** What the store needs from a live agent; implemented by the compositor's AgentSession. */
export interface RunHandle {
  /** Ends the agent (SIGTERM, then SIGKILL; killTree on Windows). */
  end(): Promise<void>;
  readonly alive: boolean;
}

type Listener = () => void;

/** A run's activity before anything came from it, and once it prints with no activity of its own to show. */
export const STARTING = "Starting";
export const WORKING = "Working";
/** A resumed session's activity until its agent says otherwise. */
export const RESUMED = "Resumed";
/**
 * The drafting row's activity: talking with the intake agent, or waiting for the user's pick (its
 * agent choice open; BUG-222) or answer (its question asked; BUG-239).
 */
export const TALKING = "Talking it through";
export const PICKING = "Waiting for your pick";
export const ANSWERING = "Waiting for your answer";

/**
 * A run's state from what its agent reports (`state`) and Gluon's own question on its bar (`question`).
 * Its turn finished (`done`: Claude Code's and Codex's Stop, Grok's Stop*, an idle prompt, OpenCode's
 * idle) is awaiting input: only the user says a session is done (BUG-193).
 */
export const runState = (state: AgentState, question?: string | null): Exclude<SessionState, "done" | "drafting"> => (question || state === "done" ? "awaiting" : state);

/** A row's group in the list: Done when the user marked it so, else its state (a draft is never done). */
export const groupOf = (s: Pick<SessionView, "state" | "markedDone">): SessionState => (s.markedDone && s.state !== "drafting" ? "done" : s.state);

export class SessionStore {
  private list: SessionView[] = [];
  private handles = new Map<number, RunHandle>();
  private listeners = new Set<Listener>();
  private nextId = 1;
  private version = 0;
  private launches = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Bumps on every change (for `useSyncExternalStore`). */
  get snapshotVersion(): number {
    return this.version;
  }

  get sessions(): readonly SessionView[] {
    return this.list;
  }

  /** A session was launched in this run (the header then says `no sessions running`, not `yet`; BUG-222). */
  get ran(): boolean {
    return this.launches > 0;
  }

  get(id: number): SessionView | undefined {
    return this.list.find((s) => s.id === id);
  }

  handle(id: number): RunHandle | undefined {
    return this.handles.get(id);
  }

  /** The draft row (at most one), created when the chat starts. */
  draft(): SessionView | undefined {
    return this.list.find((s) => s.state === "drafting");
  }

  ensureDraft(now = Date.now()): SessionView {
    const d = this.draft();
    if (d) return d;
    const s: SessionView = { id: this.nextId++, name: "(untitled)", state: "drafting", agent: null, activity: TALKING, startedAt: now };
    this.list.push(s);
    this.emit();
    return s;
  }

  dropDraft(): void {
    const before = this.list.length;
    this.list = this.list.filter((s) => s.state !== "drafting");
    if (this.list.length !== before) this.emit();
  }

  /** `name`, numbered when another session in the list has it (`numberedName`; BUG-219). */
  private freeName(name: string, self?: SessionView): string {
    return numberedName(
      name,
      this.list.filter((s) => s !== self).map((s) => s.name),
    );
  }

  /** Names a session: `name`, numbered when another session has it (BUG-219). */
  rename(id: number, name: string): void {
    const s = this.get(id);
    if (s) this.update(id, { name: this.freeName(name, s) });
  }

  /**
   * The draft becomes a run (or a new run is added when there's no draft); its name is unique in
   * the list (BUG-219). `draft: false`: a run that isn't the chat's (a resumed session): the draft stays.
   */
  launched(name: string, agent: AgentTripleView, handle: RunHandle, now = Date.now(), draft = true): SessionView {
    const d = draft ? this.draft() : undefined;
    const s: SessionView = d ?? { id: this.nextId++, name, state: "working", agent, activity: "", startedAt: now };
    Object.assign(s, { name: this.freeName(name, s), state: "working" as const, agent, activity: STARTING, startedAt: now });
    if (!d) this.list.push(s);
    this.launches++;
    this.handles.set(s.id, handle);
    this.emit();
    return s;
  }

  update(id: number, patch: Partial<Omit<SessionView, "id">>): void {
    const s = this.get(id);
    if (!s) return;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if ((s as unknown as Record<string, unknown>)[k] !== v) {
        (s as unknown as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Ctrl+D on a run's row: marks it done, or not done any more (the user's word alone; BUG-193). */
  toggleDone(id: number): void {
    const s = this.get(id);
    if (!s || s.state === "drafting") return;
    this.update(id, { markedDone: !s.markedDone });
  }

  /**
   * Removes a row: its session ended (it closes), or the user deleted it. Never ends an agent:
   * that is `end()` on its handle, after the user said yes (BUG-164); its exit removes the row.
   */
  remove(id: number): void {
    const s = this.get(id);
    if (!s) return;
    this.list = this.list.filter((x) => x !== s);
    this.handles.delete(id);
    this.emit();
  }

  /** Runs whose agent is still alive. */
  live(): SessionView[] {
    return this.list.filter((s) => this.handles.get(s.id)?.alive);
  }

  async endAll(): Promise<void> {
    await Promise.all([...this.handles.values()].filter((h) => h.alive).map((h) => h.end()));
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

/** Sessions in list order: grouped (GROUPS, `groupOf`), oldest first within a group. */
export function ordered(sessions: readonly SessionView[]): SessionView[] {
  return GROUPS.flatMap((g) => sessions.filter((s) => groupOf(s) === g).sort((a, b) => a.startedAt - b.startedAt));
}

/**
 * Runs only, in tab order: the order they were launched, whatever their state (the drafting row is
 * never a tab). The tab strip, ←/→ and the home view's digits all use it, so a
 * session changing state never moves its tab.
 */
export function tabs(sessions: readonly SessionView[]): SessionView[] {
  return sessions.filter((s) => s.state !== "drafting").sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
}

export function counts(sessions: readonly SessionView[]): Record<SessionState, number> {
  const c: Record<SessionState, number> = { awaiting: 0, working: 0, done: 0, drafting: 0 };
  for (const s of sessions) c[groupOf(s)]++;
  return c;
}

/** `now`, `3m`, `25m`, `1h`, `2d`. */
export function elapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** `$4.12`, `~$4.12` for an estimate (an API-equivalent, an OpenRouter session's running figure), `$4.12*` for the harness's own total (Gluon had no price for a request), `$4.12✓` for what OpenRouter billed, `—` when unknown. Under one cent it keeps four decimals (`$0.0022`, `<$0.0001`), never `$0.00` for a figure above 0. */
export function costLabel(cost: SessionView["cost"]): string {
  if (!cost) return "—";
  const amount = cost.usd > 0 && cost.usd < 0.00995 ? (cost.usd >= 0.00005 ? `$${cost.usd.toFixed(4)}` : "<$0.0001") : `$${cost.usd.toFixed(2)}`;
  return `${cost.approx ? "~" : ""}${amount}${cost.own === false ? "*" : ""}${cost.billed ? "✓" : ""}`;
}

/** `38%`, `—` when unknown. */
export function contextLabel(pct: number | undefined): string {
  return pct === undefined ? "—" : `${Math.round(Math.max(0, Math.min(100, pct)))}%`;
}

/** `claude code`, `codex`, … as the brief writes harnesses. */
export const HARNESS_WORD: Record<Harness, string> = {
  "claude-code": "claude code",
  codex: "codex",
  antigravity: "antigravity",
  "grok-build": "grok build",
  opencode: "opencode",
  "kimi-code": "kimi code",
};
