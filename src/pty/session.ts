/**
 * Gluon: one agent in its own pseudo-terminal, kept running whether or not it is on screen. Built
 * from `handOffSession`'s pieces (`prepareLaunch`: events directory, adapter files, `GLUON_*`,
 * telemetry) but with no stdin, stdout or process signals: the compositor (`compositor.ts`) owns
 * the real terminal and hands each session its keys; the session keeps a screen model (with
 * scrollback, for the frame's scroll mode) that the compositor paints from.
 *
 * What goes into the agent's PTY, and nothing else (`send`; `test/pty-session.test.ts`):
 * - the user's own bytes, unchanged (`input`, through the interceptor: a held Enter goes on at a
 *   yes to ending the session; at a no it is never sent, BUG-234); a paste without its markers when the agent hasn't turned bracketed
 *   paste on (Gluon keeps it on on the real terminal: `unbracketed`);
 * - the screen model's replies to the agent's queries (DA1, CPR, DECRQM, OSC 10/11/12, kitty's
 *   `CSI ? u`), in the order the queries came: no real terminal sees a background session's
 *   output, so the model answers for it;
 * - the user's mouse reports, moved to the frame's interior (`mouse`);
 * - one launch line, from `PreparedLaunch.firstLine` (`/plan Read the session brief in <file> and
 *   start.`: Codex has no flag for Plan mode), typed at most once: only once the agent's composer is
 *   up and empty and it has turned bracketed paste on, only while the user has typed nothing (what
 *   they send to the agent's own dialog, a folder-trust question, leaves no draft), the text first
 *   and, after a pause and only when the composer shows it, its Enter (`typeFirstLine`). When it
 *   can't be typed, the user is told the exact line (`onNote`).
 *
 * Keys and screen stay in memory: nothing here logs, writes or sends them. Status (working,
 * awaiting, done; activity, cost, context) is display only and never ends or holds the agent.
 */
import { constants as osConstants } from "node:os";
import { killTree } from "../detect.ts";
import { EventsWatch, writeAnswer, type AgentState, type StatusInfo, type StepUsage } from "../events.ts";
import type { HandoffSettings } from "../handoff.ts";
import { HARNESS_INFO, type Harness } from "../harnesses.ts";
import { KILL_GRACE_MS, POLL_MS, prepareLaunch, type Command, type ReturnReason, type SessionWatch } from "../launchers.ts";
import type { RunHandle } from "../sessions.ts";
import { createInterceptor } from "./intercept.ts";
import { isCtrlC, unbracketed } from "./keys.ts";
import { READERS } from "./readers/index.ts";
import { createScreen, type ScreenOptions, type TermScreen } from "./screen.ts";
import { COMPACT_TIMEOUT_MS, END_COMPACT_QUESTION, END_QUESTION, endQuestion, type Interceptor, type Key } from "./types.ts";

/** A row's activity once a hook said the turn ended after a tool line. */
export const TURN_FINISHED = "Turn finished";

/**
 * After a yes to /clear: the agent runs its own /clear (its session closes properly, the user's
 * SessionEnd hooks run), then is ended once it has reacted (output or a status event since the
 * Enter) and been quiet SETTLE_QUIET_MS, or after SETTLE_MAX_MS at most. A slow agent isn't cut
 * off before its /clear and hooks have run (BUG-176).
 */
export const SETTLE_QUIET_MS = 1000;
export const SETTLE_MAX_MS = 10_000;
/**
 * An Enter right after forwarded keys (the same chunk: a fast typist, a key-repeat, a terminal that
 * batches) waits up to ECHO_MAX_MS for the agent to echo them, so the screen shows the line
 * (BUG-150): output after the last key, then ECHO_QUIET_MS without more.
 */
export const ECHO_MAX_MS = 150;
export const ECHO_QUIET_MS = 30;

/** Tests only: no pseudo-terminal here (the one-at-a-time path). Compiled out of release builds, like `testProbesPath`. */
const noPtySeam = (): boolean => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? false : !!process.env.GLUON_TEST_NO_PTY);
/** Tests only: how long a waiting hook's compaction question stays up. Compiled out of release builds. */
const compactTimeoutSeam = (): number => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? 0 : Number(process.env.GLUON_TEST_COMPACT_TIMEOUT_MS) || 0);
declare const GLUON_BUILD: string | undefined;

/** Whether this Bun and this terminal can run agents in pseudo-terminals (else one at a time, in the terminal itself). */
export const ptyAvailable = () => !noPtySeam() && typeof (Bun as { Terminal?: unknown }).Terminal === "function" && !!process.stdin.isTTY && !!process.stdout.isTTY;

export { END_COMPACT_QUESTION, END_QUESTION };

/** Rows of the agent's output kept above its screen for the frame's scroll mode. */
export const SCROLLBACK = 5000;
/** No output for this long, and the agent's input line (or its own dialog) on screen: it waits for the user (no hooks). */
export const QUIET_AWAIT_MS = 3000;
/** Output this soon after a key is its echo, not work. */
export const ECHO_GRACE_MS = 300;
/** A hook's status this recent wins over what the output suggests. */
export const HOOK_TRUST_MS = 30_000;
/**
 * Output this soon after Gluon resized the PTY is the agent's redraw, not work (BUG-204); so is
 * output this soon after the redraw's last output (its rest, or the next resize's redraw).
 */
export const REDRAW_GRACE_MS = 1000;
/**
 * A TUI that debounces SIGWINCH redraws late: the first output past REDRAW_GRACE_MS after a resize,
 * up to this soon, is still its redraw, however late in that window it comes (BUG-242); ConPTY's
 * immediate repaint inside REDRAW_GRACE_MS doesn't use that up (BUG-669). Past it, output is work again.
 */
export const REDRAW_WAIT_MS = 5000;
/** How long an agent gets after SIGTERM when Gluon itself is ending (then SIGKILL). */
export const SIGNAL_GRACE_MS = 1000;

/** The process side of a session: what `Bun.spawn` gives with a terminal (a fake in tests). */
export interface AgentProcess {
  /** Writes into the PTY. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** The exit code (128 + the signal's number when killed). */
  readonly exited: Promise<number>;
  alive(): boolean;
  /** Ends it: SIGTERM or SIGKILL (Windows: the whole tree). */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  close(): void;
}

export interface SpawnOptions {
  cwd?: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  onData(data: Uint8Array): void;
}

export type Spawner = (argv: string[], opts: SpawnOptions) => AgentProcess;

/** Thrown when no pseudo-terminal can be had: the session can't start. */
export class NoPty extends Error {}

/** The default `Spawner`: a Bun pseudo-terminal (ConPTY on Windows). */
export const spawnInPty: Spawner = (argv, o) => {
  if (typeof (Bun as { Terminal?: unknown }).Terminal !== "function") throw new NoPty("no pseudo-terminal here");
  const win = process.platform === "win32";
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(argv, { cwd: o.cwd, env: o.env, terminal: { cols: o.cols, rows: o.rows, data: (_t, d) => o.onData(d) } });
  } catch (e) {
    throw new NoPty((e as Error).message);
  }
  const terminal = child.terminal!;
  const alive = () => child.exitCode === null && !child.signalCode;
  return {
    write: (d) => {
      if (!terminal.closed) terminal.write(d);
    },
    resize: (c, r) => {
      if (!terminal.closed) terminal.resize(c, r);
    },
    exited: child.exited.then((code) => (child.signalCode ? 128 + (osConstants.signals[child.signalCode as keyof typeof osConstants.signals] ?? 0) : code)),
    alive,
    kill(signal) {
      if (!alive()) return;
      if (win) killTree(child);
      else child.kill(signal);
    },
    close() {
      try {
        terminal.close();
      } catch {}
    },
  };
};

/** What the session reports for the store (display only). */
export interface SessionStatus {
  state: AgentState;
  activity?: string;
  /** The harness's own figures, from its status events. */
  costUsd?: number;
  /** null: unknown until the next request (the context was just compacted). */
  contextTokens?: number | null;
  contextWindow?: number;
  model?: string;
  /** Antigravity's token totals (`StatusInfo`): the input is the conversation's size, its context. */
  totals?: { input: number; output: number };
}

/** Why the PTY got bytes: the only four kinds there are (`launch`: the launch's first line, once). */
export type SendKind = "user" | "reply" | "mouse" | "launch";

/**
 * The launch line's timing (`AgentSessionOptions.firstLineTiming`; tests shorten it). Codex loses an
 * Enter written before its composer is drawn and swallows one that comes in the same chunk as the
 * text (its paste-burst handling): so the text goes, a pause, then the Enter.
 */
export interface FirstLineTiming {
  /** How long the composer may take to show (a folder-trust question and the hooks' review come first). */
  waitMs: number;
  /** Between the text and its Enter. */
  pauseMs: number;
  /** How long the typed text may take to show on the composer. */
  landMs: number;
  /** How long after the Enter the harness has to show it is in Plan mode (`ScreenReader.planMode`). */
  planMs: number;
}
export const FIRST_LINE_TIMING: FirstLineTiming = { waitMs: 60_000, pauseMs: 200, landMs: 3000, planMs: 8000 };

export interface AgentSessionOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  harness: Harness;
  settings: HandoffSettings;
  /** The launch's events directory (`events.ts`). */
  events?: string;
  /** The PTY's size: the frame's interior. */
  cols: number;
  rows: number;
  /** The real terminal's colours and kitty support, for the model's replies (`ScreenOptions`). */
  screen?: Omit<ScreenOptions, "scrollback">;
  spawn?: Spawner;
  /** How long a waiting hook's compaction question stays up (tests shorten it). */
  compactTimeoutMs?: number;
  now?: () => number;
  /** How often the quiet-output fallback looks (tests shorten it). */
  tickMs?: number;
  /** After a yes to /clear, the longest wait before the agent is ended (`SETTLE_MAX_MS`; tests shorten it). */
  settleMaxMs?: number;
  /**
   * The line Gluon types into the agent once its composer is up (`PreparedLaunch.firstLine`; the
   * whole line, no Enter): see the file's comment.
   */
  firstLine?: string;
  firstLineTiming?: Partial<FirstLineTiming>;
  /** Tests: every write into the PTY, with its kind. */
  onSend?: (kind: SendKind, data: string) => void;
}

type Listener<T> = (v: T) => void;
/** What a status event newly said about the harness's own figures: only what changed (`hookStatus`); the context's tokens and window come together. */
export type Figures = Pick<SessionStatus, "costUsd" | "contextTokens" | "contextWindow" | "model" | "totals">;
interface SessionEvents {
  change: void;
  status: SessionStatus;
  question: string | null;
  back: void;
  /** The user said yes to ending it: over for them now; the agent ends in the background. */
  closed: void;
  exit: number;
  /** OpenCode's per-step usage (`StatusInfo.steps`): delivered once, never part of the merged status. */
  steps: StepUsage[];
  /** The figures a status event reported that differ from the last ones delivered (`Figures`): a stale figure in the merged status is never delivered again. */
  figures: Figures;
  /** Codex's PreCompact hook ran: a compaction starts (`StatusInfo.compacting`). */
  compacting: void;
  sessionId: string;
  mainSession: string;
  /** Something to tell the user about this session (the launch line couldn't be typed). */
  note: string;
}

/** One agent session (see the file's comment). Implements the store's `RunHandle`. */
export class AgentSession implements RunHandle {
  readonly screen: TermScreen;
  readonly harness: Harness;
  /** The exit code once the agent has exited (128 + signal when killed). */
  code: number | null = null;
  /** Why it ended: on its own (`exit`), or Gluon ended it (`clear`, `compact`: the user said yes; `back`: `end()`). */
  reason: ReturnReason = "exit";
  readonly exited: Promise<number>;

  private proc: AgentProcess;
  private interceptor: Interceptor;
  private now: () => number;
  private outText = new TextDecoder();
  private screenDone: Promise<void> = Promise.resolve();
  private lastOutput: number;
  private lastForward = -Infinity;
  /**
   * The redraw a resize Gluon made is owed (`isRedraw`): when the last resize was, and the redraw's
   * last output so far (null: none yet), and whether any came past REDRAW_GRACE_MS (`late`: the
   * agent's own, after ConPTY's immediate repaint, BUG-669). Null once the redraw is over.
   */
  private redraw: { from: number; last: number | null; late: boolean } | null = null;
  private closing = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private q: { text: string; done: (yes: boolean) => void } | null = null;
  private status: SessionStatus = { state: "working" };
  /** The last figures delivered (`figures`). */
  private figSeen: Figures = {};
  private hookAt = -Infinity;
  /** When the last status event came (any field): the agent is still at it. */
  private lastEvent = -Infinity;
  private hooksSeen = false;
  /** The last state a hook gave. */
  private hookState: AgentState = "working";
  /** `working` came from output, not a hook: quiet output goes back to `hookState` (BUG-204). */
  private guessed = false;
  /** An interruption marker on the screen already ended a Working state; any output since makes the screen new again (`interrupted`). */
  private interruptHandled = false;
  /**
   * Where the activity came from: a hook's tool line (with `working`), stale once the turn ends; a
   * question (with `awaiting`: "Claude needs your permission to use Bash"), stale once answered or
   * the turn ends (BUG-214); null: the agent's own, or none.
   */
  private activityFrom: "tool" | "question" | null = null;
  /** The tool line a question came over: the activity again once the question is answered. */
  private beforeQuestion: string | undefined;
  /** A typed command's key is held while its question is up (`holdsLine`). */
  private holding = false;
  /** The agent's own session id: the first valid `session` event (`onSessionId`). */
  private agentSessionId: string | undefined;
  /** The latest `session` event's id: the agent's main thread now (a `/fork` or `/new` starts another). */
  private mainSessionId: string | undefined;
  private listeners: { [K in keyof SessionEvents]: Set<Listener<SessionEvents[K]>> } = { change: new Set(), status: new Set(), question: new Set(), back: new Set(), closed: new Set(), exit: new Set(), sessionId: new Set(), mainSession: new Set(), steps: new Set(), figures: new Set(), compacting: new Set(), note: new Set() };
  /** What `note` said so far (replayed to a listener that comes later). */
  private told: string[] = [];
  /** The user sent keys or mouse reports to the agent (not to a dialog of its own): the launch line is theirs to type now. */
  private userTyped = false;

  constructor(private o: AgentSessionOptions) {
    this.harness = o.harness;
    this.now = o.now ?? (() => performance.now());
    this.lastOutput = this.now();
    this.screen = createScreen(o.cols, o.rows, { ...o.screen, scrollback: SCROLLBACK });
    this.interceptor = createInterceptor({ harness: o.harness, clear: o.settings.on_clear === "ask", compact: o.settings.on_compact === "ask" });
    // Replies come out in the order of the queries, while the parser walks the output.
    this.screen.onReply((d) => this.send("reply", d));
    this.screen.onChange(() => this.emit("change", undefined));
    this.proc = (o.spawn ?? spawnInPty)(o.argv, { cwd: o.cwd, env: o.env, cols: o.cols, rows: o.rows, onData: (d) => this.output(d) });
    this.exited = this.proc.exited.then(async (code) => {
      // The rest of its output reaches the model before the session counts as over.
      await this.screenSynced();
      this.code = code;
      this.finish();
      this.emit("exit", code);
      return code;
    });
    if (o.events) this.watchEvents(o.events);
    if (o.firstLine) void this.typeFirstLine(o.firstLine).catch(() => {});
    this.tick = setInterval(() => this.fallback(), o.tickMs ?? 1000);
    this.tick.unref?.();
  }

  get alive(): boolean {
    return this.code === null && this.proc.alive();
  }

  /** The question on the bar while one is up ("/clear ends this session in Gluon — end it?"). */
  get question(): string | null {
    return this.q?.text ?? null;
  }

  /** The question up is about a typed command whose key is held: a no leaves the typed line as it is (BUG-234). */
  get holdsLine(): boolean {
    return this.holding && this.q !== null;
  }

  /** The agent shows a dialog of its own that waits for a pick: a key now answers it, it is no typed text (BUG-705). */
  get awaitsChoice(): boolean {
    try {
      return !!READERS[this.harness].awaitsChoice?.(this.screen);
    } catch {
      return false;
    }
  }

  get state(): SessionStatus {
    return this.status;
  }

  onChange(fn: Listener<void>) {
    return this.on("change", fn);
  }
  onStatus(fn: Listener<SessionStatus>) {
    return this.on("status", fn);
  }
  onCompacting(fn: Listener<void>) {
    return this.on("compacting", fn);
  }
  onSteps(fn: Listener<StepUsage[]>) {
    return this.on("steps", fn);
  }
  onFigures(fn: Listener<Figures>) {
    return this.on("figures", fn);
  }
  onQuestion(fn: Listener<string | null>) {
    return this.on("question", fn);
  }
  /** `back` from inside the agent (`/gluon`, the return command): show the home view; the agent keeps running. */
  onBack(fn: Listener<void>) {
    return this.on("back", fn);
  }
  /**
   * A yes to ending the session (a typed /clear, /compact, an auto-compaction): the session
   * closes for the user at once, synchronously with the Enter (BUG-201), while the agent still runs
   * its own /clear (`settle`, up to `SETTLE_MAX_MS` mid-turn in Codex) and is then ended (BUG-191).
   */
  onClosed(fn: Listener<void>) {
    return this.on("closed", fn);
  }
  onExit(fn: Listener<number>) {
    return this.on("exit", fn);
  }

  /**
   * What to tell the user about this session, each note once: the launch's first line couldn't be
   * typed, and the note says the line. Called at once for the notes already given. Returns the unsubscribe function.
   */
  onNote(fn: Listener<string>): () => void {
    for (const n of this.told) {
      try {
        fn(n);
      } catch {}
    }
    return this.on("note", fn);
  }

  /** The agent's own session id (`session` event), once it has sent one. */
  get sessionId(): string | undefined {
    return this.agentSessionId;
  }

  /**
   * The agent's own session id, for `gluon resume`: fires at most once, with the FIRST valid
   * `session` event (later ones, a sub-agent's, are ignored). Called at once when it has already
   * arrived. Returns the unsubscribe function.
   */
  onSessionId(cb: (id: string) => void): () => void {
    if (this.agentSessionId !== undefined) {
      try {
        cb(this.agentSessionId);
      } catch {}
      return () => {};
    }
    return this.on("sessionId", cb);
  }

  /**
   * The id of the agent's main thread, each time it changes (Codex: its hooks name the thread they
   * run in, so a `/fork` or `/new` is heard here; the context follows it). Unlike `onSessionId`
   * (the first only, for `gluon resume`). Called at once with the latest when there is one.
   */
  onMainSession(cb: (id: string) => void): () => void {
    if (this.mainSessionId !== undefined) {
      try {
        cb(this.mainSessionId);
      } catch {}
    }
    return this.on("mainSession", cb);
  }

  private on<K extends keyof SessionEvents>(k: K, fn: Listener<SessionEvents[K]>): () => void {
    this.listeners[k].add(fn);
    return () => void this.listeners[k].delete(fn);
  }

  private emit<K extends keyof SessionEvents>(k: K, v: SessionEvents[K]) {
    for (const fn of this.listeners[k]) {
      try {
        fn(v);
      } catch {}
    }
  }

  /** Every byte into the PTY goes through here: the user's, the model's replies, shifted mouse reports, the launch line. */
  private send(kind: SendKind, data: string) {
    if (!data || !this.alive) return;
    this.o.onSend?.(kind, data);
    this.proc.write(data);
    if (kind === "reply") return;
    this.lastForward = this.now();
    // The user acted after the redraw came: what the agent prints now answers them (BUG-242).
    if (this.redraw?.last != null) this.redraw = null;
  }

  private output(data: Uint8Array) {
    const at = this.now();
    this.lastOutput = at;
    this.interruptHandled = false;
    const text = this.outText.decode(data, { stream: true });
    try {
      this.screenDone = this.screen.write(text).catch(() => {});
    } catch {}
    // Output that isn't the echo of a key nor a redraw Gluon caused: the agent is at work (unless
    // its hooks said otherwise lately; and with hooks only until the output goes quiet: `fallback`).
    if (at - this.lastForward <= ECHO_GRACE_MS || this.isRedraw(at)) return;
    if (this.status.state !== "working" && (!this.hooksSeen || at - this.hookAt > HOOK_TRUST_MS) && !this.q) {
      this.guessed = this.hooksSeen;
      this.setStatus({ state: "working" });
    }
  }

  /**
   * Whether output at `at` is the agent's redraw after Gluon's resize, not work: anything within
   * REDRAW_GRACE_MS of the resize (on Windows ConPTY repaints there at once, whatever the agent
   * does); the first output past it within REDRAW_WAIT_MS, whatever came inside it (a TUI that
   * debounces SIGWINCH, BUG-242, BUG-669); and output within REDRAW_GRACE_MS of the redraw's last,
   * up to REDRAW_WAIT_MS. Then the redraw is over: what comes next (after a pause, past the window, or
   * after the user's own keys) is work again.
   */
  private isRedraw(at: number): boolean {
    const r = this.redraw;
    if (!r) return false;
    const since = at - r.from;
    if (since <= REDRAW_GRACE_MS) {
      r.last = at;
      return true;
    }
    if (since <= REDRAW_WAIT_MS && (!r.late || at - r.last! <= REDRAW_GRACE_MS)) {
      r.last = at;
      r.late = true;
      return true;
    }
    this.redraw = null;
    return false;
  }

  private setStatus(patch: Partial<SessionStatus>) {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.emit("status", next);
  }

  /**
   * Without hooks: quiet output and the agent's input line (or a dialog of its own: `awaitsChoice`)
   * on screen → awaiting the user. With hooks: quiet output after a `working` only the output
   * suggested → the hooks' last state, so a redraw or a stray line never leaves an idle agent
   * Working for good (BUG-204).
   */
  private fallback() {
    if (!this.alive || this.q || this.status.state !== "working") return;
    if (this.now() - this.lastOutput < QUIET_AWAIT_MS) return;
    if (this.hooksSeen) {
      if (this.guessed) {
        this.guessed = false;
        this.setStatus({ state: this.hookState });
      } else if (this.interrupted()) {
        // Esc sends no hook (Claude Code, Codex): the last `working` would stand for good (BUG-609).
        this.interruptHandled = true;
        this.hookState = "awaiting";
        this.setStatus({ state: "awaiting", ...(this.activityFrom === "tool" ? { activity: undefined } : {}) });
        if (this.activityFrom === "tool") this.activityFrom = null;
      }
      return;
    }
    // Its input box, or a dialog of its own waiting for a pick (before any hook: BUG-244).
    let waiting = false;
    try {
      const reader = READERS[this.harness];
      waiting = reader.inputLine(this.screen) !== null || !!reader.awaitsChoice?.(this.screen);
    } catch {}
    if (waiting) this.setStatus({ state: "awaiting" });
  }

  /**
   * The agent's own rows say its turn was cut off (`ScreenReader.interrupted`), after the last hook
   * and with the output quiet. Within "the screen alone never triggers anything" (`src/pty/AGENTS.md`):
   * this never starts a hold, a question or any input; it only ends a Working state a hook set, which
   * is shown and never acted on, and a screen that fakes the words (a repo's output) can at most
   * show an idle row for a session that still works, until the next hook or output says otherwise.
   * It counts once per screen (`interruptHandled`): a hook's `working` after it (a new prompt, whose
   * redraw is yet to come) is the agent's later word and stays until the screen changes.
   */
  private interrupted(): boolean {
    if (this.interruptHandled) return false;
    try {
      return READERS[this.harness].interrupted?.(this.screen) === true;
    } catch {
      return false;
    }
  }

  /** Waits until the screen model has taken in all output so far. */
  private async screenSynced() {
    for (let p = this.screenDone; ; p = this.screenDone) {
      await p;
      if (p === this.screenDone) return;
    }
  }

  /** Keys just forwarded: until the agent has echoed them (or ECHO_MAX_MS). */
  private async echoed() {
    const start = this.now();
    if (start - this.lastForward >= ECHO_MAX_MS) return;
    while (this.alive && this.now() - start < ECHO_MAX_MS) {
      if (this.lastOutput > this.lastForward && this.now() - this.lastOutput >= ECHO_QUIET_MS) return;
      await Bun.sleep(10);
    }
  }

  private async settle(from: number) {
    const max = this.o.settleMaxMs ?? SETTLE_MAX_MS;
    while (this.alive && this.now() - from < max) {
      const last = Math.max(this.lastOutput, this.lastEvent);
      if (last > from && this.now() - last >= SETTLE_QUIET_MS) return;
      await Bun.sleep(25);
    }
  }

  /**
   * A key from the user for this agent (the compositor has taken its own keys). While the question
   * is up, every key answers it: Enter yes; Esc or Ctrl+C no; others are dropped. The home key never
   * gets here: `route` takes it first (the home view shows; the question stays pending).
   */
  input(k: Key): void {
    if (this.q) {
      if (k.pasted) return;
      if (k.name === "enter") this.q.done(true);
      else if (k.name === "escape" || isCtrlC(k)) this.q.done(false);
      return;
    }
    if (this.closing || !this.alive) return;
    this.userActed();
    this.queue(() => this.handleKey(k));
  }

  /** A mouse report already moved to the agent's screen and written in its encoding (`encodeMouse`). */
  mouse(bytes: string): void {
    if (this.closing || this.q) return;
    this.userActed();
    // After the keys before it (an Enter may be waiting for the screen).
    this.queue(() => {
      if (!this.closing) this.send("mouse", bytes);
    });
  }

  /** The user's terminal's bytes for the agent that aren't keys (a focus report the agent asked for): as they are. */
  passthrough(bytes: string): void {
    if (this.closing) return;
    this.queue(() => {
      if (!this.closing) this.send("user", bytes);
    });
  }

  /**
   * The user sent a key or a mouse report (a focus report from their terminal is neither). What goes
   * to a dialog of the agent's own (a folder-trust question: `awaitsChoice`) leaves no draft: not counted.
   */
  private userActed() {
    if (this.userTyped || this.awaitsChoice) return;
    this.userTyped = true;
  }

  private tell(note: string) {
    this.told.push(note);
    this.emit("note", note);
  }

  /**
   * Writes `data` in order with the user's keys; false when the user typed first, the session ended or the agent
   * shows a dialog of its own (`awaitsChoice`: a digit would pick an option, an Enter the highlighted one; BUG-670): nothing is written then.
   */
  private typeNow(data: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.queue(() => {
        if (this.userTyped || this.closing || !this.alive || this.awaitsChoice) return resolve(false);
        this.send("launch", data);
        resolve(true);
      });
    });
  }

  /**
   * Types the launch's first line into the agent, once (`AgentSessionOptions.firstLine`). Only while
   * the user has typed nothing and, by the harness's reader, the composer is up and empty and the
   * agent has turned bracketed paste on and shows no dialog of its own (folder trust, hooks' review, Codex's
   * update offer: `awaitsChoice`, also after the text went in; BUG-670); nothing is typed into a dialog.
   * The text goes, then after a pause the Enter, and only when the composer shows the text. Otherwise (the user typed, no composer within `waitMs`, the
   * text didn't land) nothing more is typed and the user gets the line to type themselves (`onNote`).
   * The screen only decides whether to type the one line the launch gave, never what.
   */
  private async typeFirstLine(line: string) {
    const t = { ...FIRST_LINE_TIMING, ...this.o.firstLineTiming };
    const reader = READERS[this.harness];
    const label = HARNESS_INFO[this.harness].label;
    const inputLine = () => {
      try {
        return reader.inputLine(this.screen);
      } catch {
        return null;
      }
    };
    // Nothing is told once the session is ending, nor twice: the first thing that went wrong says it.
    const failed = (why: string, typed = false) => {
      if (!this.alive || this.closing) return;
      this.tell(`couldn't type the first line into ${label} (${this.userTyped ? "you typed first" : this.awaitsChoice ? "it is showing a dialog of its own" : why}); ${typed ? "it may be on its line already: clear that, then " : ""}type this yourself: ${line}`);
    };
    // Waits for `ok`, polled, up to `ms`; false at the deadline, once the user typed, or when the agent ends.
    const wait = async (ok: () => boolean, ms: number) => {
      const from = this.now();
      for (;;) {
        await this.screenSynced();
        if (this.userTyped || !this.alive || this.closing) return false;
        if (ok()) return true;
        if (this.now() - from >= ms) return false;
        await Bun.sleep(20);
      }
    };
    // The reader's `ready`: an agent can draw its composer before it can take a line (Kimi Code, before its model is set; BUG-674).
    const ready = () => {
      try {
        return reader.ready?.(this.screen) ?? true;
      } catch {
        return true;
      }
    };
    if (!(await wait(() => this.screen.modes().bracketedPaste && !this.awaitsChoice && inputLine() === "" && ready(), t.waitMs))) return failed(inputLine() === "" && !ready() ? "it didn't finish starting" : "its composer didn't show");
    if (!(await this.typeNow(line))) return failed("it was not typed");
    // The Enter only after the pause that tells the harness this isn't a paste, and when the composer shows the text.
    await Bun.sleep(t.pauseMs);
    // Whitespace aside: the composer wraps a long line over rows (Codex word-wraps, dropping the space it breaks at).
    const bare = (s: string) => s.replace(/\s+/g, "");
    if (!(await wait(() => !this.awaitsChoice && bare(inputLine() ?? "").includes(bare(line)), t.landMs))) return failed("the text didn't reach its composer", true);
    if (!(await this.typeNow("\r"))) return failed("its Enter was not sent", true);
    // A `/plan` that didn't take leaves the agent in its default mode with the brief unread.
    if (!line.startsWith("/plan") || !reader.planMode) return;
    if (!(await wait(() => reader.planMode!(this.screen) === true, t.planMs)) && this.alive && !this.closing && !this.userTyped) {
      this.tell(`${label} may not be in Plan mode: its screen doesn't show it. If it isn't, type this yourself: ${line}`);
    }
  }

  private queue(job: () => Promise<void> | void) {
    this.chain = this.chain.then(job).catch(() => {});
  }

  private forward(raw: string) {
    this.send("user", raw);
  }

  private async handleKey(k: Key) {
    if (this.closing) return;
    // The screen as it is when the key lands: the interceptor reads what an Enter (or Tab) runs.
    if ((k.name === "enter" || k.name === "tab") && !k.pasted) {
      await this.echoed();
      await this.screenSynced();
    }
    let what = null;
    try {
      what = this.interceptor.key(k, this.screen);
    } catch {}
    // A paste for an agent that hasn't turned bracketed paste on: the markers Gluon asked the real
    // terminal for don't go on (BUG-172).
    if (k.pasted) return this.forward(this.screen.modes().bracketedPaste ? k.raw : unbracketed(k));
    if (!what) return this.forward(k.raw);
    this.holding = true;
    const yes = await this.ask(what === "clear" ? endQuestion(this.interceptor.command() ?? "/clear") : END_COMPACT_QUESTION);
    this.holding = false;
    if (this.closing) return;
    // No: the held key is never sent — the typed command stays on the agent's line to edit or
    // delete, and the session goes on (BUG-234). The next Enter on it asks again.
    if (!yes) return this.interceptor.unsent();
    if (what === "compact") return this.stop("compact");
    // The agent runs its own /clear first (its session closes properly, the user's hooks run).
    this.closing = true;
    const from = this.now();
    this.send("user", k.raw);
    await this.settle(from);
    this.stop("clear");
  }

  /**
   * Shows `question` (whether to end the session) in the bottom bar until answered (or `timeoutMs`:
   * no). The agent's output goes on. A yes emits `closed` at once, in the same call: the keys read
   * with the Enter, and those after it, go where the user now is, not to this agent (BUG-201).
   */
  private ask(question: string, timeoutMs?: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const q = {
        text: question,
        done: (yes: boolean) => {
          if (this.q !== q) return;
          clearTimeout(timer);
          this.q = null;
          this.emit("question", null);
          if (yes) this.emit("closed", undefined);
          resolve(yes);
        },
      };
      this.q = q;
      if (timeoutMs !== undefined) timer = setTimeout(() => q.done(false), timeoutMs);
      this.emit("question", question);
    });
  }

  private async compactEvent(dir: string, id: string) {
    if (this.closing) return;
    if (this.o.settings.on_compact !== "ask") return writeAnswer(dir, id, false);
    const yes = await this.ask(END_COMPACT_QUESTION, this.o.compactTimeoutMs ?? (compactTimeoutSeam() || COMPACT_TIMEOUT_MS));
    if (!yes) return writeAnswer(dir, id, false);
    // Yes: ended at once, its hook never answered (a stopped compaction prints the harness's
    // "blocked" line, BUG-151); the hook goes with the agent or finds its events dir gone.
    if (!this.closing) this.stop("compact");
  }

  private watchEvents(dir: string) {
    // Many sessions poll at once: a directory that did not change is not listed again (`EventsWatch`).
    const watch = new EventsWatch(dir);
    this.poll = setInterval(() => {
      // An event counts only while the agent runs; while it is being ended, only its status
      // (a /clear's hooks still running: `settle`).
      if (!this.alive) return;
      for (const e of watch.read()) {
        if (e.name === "session") {
          // Taken even while the agent is being ended; only the first counts.
          if (e.id && this.agentSessionId === undefined) {
            this.agentSessionId = e.id;
            this.emit("sessionId", e.id);
          }
          if (e.id && e.id !== this.mainSessionId) {
            this.mainSessionId = e.id;
            this.emit("mainSession", e.id);
          }
        } else if (e.name === "status") {
          if (e.status) this.hookStatus(e.status);
        } else if (this.closing) continue;
        else if (e.name === "compact") {
          if (e.id) {
            const id = e.id;
            this.queue(() => this.compactEvent(dir, id));
          }
        } else this.emit("back", undefined);
      }
    }, POLL_MS);
  }

  private hookStatus(s: StatusInfo) {
    this.lastEvent = this.now();
    const patch: Partial<SessionStatus> = {};
    if (s.state) {
      this.hooksSeen = true;
      this.hookAt = this.now();
      this.hookState = s.state;
      this.guessed = false;
      patch.state = s.state;
    }
    if (s.activity !== undefined) {
      const from = s.state === "working" ? "tool" : s.state === "awaiting" ? "question" : null;
      if (from === "question" && this.activityFrom !== "question") this.beforeQuestion = this.activityFrom === "tool" ? this.status.activity : undefined;
      patch.activity = s.activity;
      this.activityFrom = from;
    } else if (s.state === "done" && this.activityFrom) {
      // A turn's end (Claude Code's Stop, its idle notification) leaves neither the last tool line
      // as if it still ran (BUG-187) nor a question already answered (BUG-214).
      patch.activity = TURN_FINISHED;
      this.activityFrom = null;
    } else if (s.state === "working" && this.activityFrom === "question") {
      // Working again: the question was answered. The tool line it came over (the tool now runs),
      // or none (the row says Working) — never the answered question (BUG-214).
      patch.activity = this.beforeQuestion;
      this.activityFrom = this.beforeQuestion === undefined ? null : "tool";
    } else if (s.state === "working" && this.status.activity === TURN_FINISHED) {
      // A new turn starts (UserPromptSubmit sends no tool line): the last turn's end is not this one's (BUG-610).
      patch.activity = undefined;
    }
    if (s.steps) this.emit("steps", s.steps);
    if (s.compacting) this.emit("compacting", undefined);
    if (s.costUsd !== undefined) patch.costUsd = s.costUsd;
    if (s.contextTokens !== undefined) patch.contextTokens = s.contextTokens;
    if (s.contextWindow !== undefined) patch.contextWindow = s.contextWindow;
    if (s.model !== undefined) patch.model = s.model;
    if (s.totals !== undefined) patch.totals = s.totals;
    this.figures(s);
    this.setStatus(patch);
  }

  /**
   * The merged status keeps the last figures, so every later state change would carry them again: a stale cost or
   * context sent to the audit as a new sample (BUG-399). A figure is delivered when this event's value is not the last delivered.
   */
  private figures(s: StatusInfo) {
    const f: Figures = {};
    const seen = this.figSeen;
    if (s.costUsd !== undefined && s.costUsd !== seen.costUsd) f.costUsd = s.costUsd;
    if (s.totals !== undefined && (s.totals.input !== seen.totals?.input || s.totals.output !== seen.totals?.output)) f.totals = s.totals;
    if ((s.contextTokens !== undefined && s.contextTokens !== seen.contextTokens) || (s.contextWindow !== undefined && s.contextWindow !== seen.contextWindow)) {
      f.contextTokens = s.contextTokens !== undefined ? s.contextTokens : (this.status.contextTokens ?? undefined);
      const window = s.contextWindow ?? this.status.contextWindow;
      if (window !== undefined) f.contextWindow = window;
      if (f.contextTokens === undefined) delete f.contextTokens;
    }
    if (Object.keys(f).length === 0) return;
    const model = s.model ?? this.status.model;
    if (model !== undefined) f.model = model;
    if (s.costUsd !== undefined) seen.costUsd = s.costUsd;
    if (s.totals !== undefined) seen.totals = s.totals;
    if (s.contextTokens !== undefined) seen.contextTokens = s.contextTokens;
    if (s.contextWindow !== undefined) seen.contextWindow = s.contextWindow;
    this.emit("figures", f);
  }

  resize(cols: number, rows: number): void {
    if (cols === this.screen.cols && rows === this.screen.rows) return;
    try {
      this.screen.resize(cols, rows);
      if (this.alive) {
        this.redraw = { from: this.now(), last: null, late: false };
        this.proc.resize(cols, rows);
      }
    } catch {}
  }

  /** Gluon ends the agent: SIGTERM, then SIGKILL after `grace` (Windows: the process tree). */
  private stop(reason: ReturnReason, grace = KILL_GRACE_MS) {
    this.closing = true;
    if (!this.alive || this.killTimer) return;
    this.reason = reason;
    this.q?.done(false);
    this.proc.kill("SIGTERM");
    // Kept referenced: finish() clears it at the exit, and an unref'd timer here never fired on
    // Windows CI, so end() waited forever (BUG-190).
    this.killTimer = setTimeout(() => this.proc.kill("SIGKILL"), grace);
  }

  /** Ends the agent (the store's `RunHandle`); resolves once it has exited. */
  async end(grace = KILL_GRACE_MS): Promise<void> {
    this.stop("back", grace);
    await this.exited.catch(() => {});
  }

  private finish() {
    this.closing = true;
    clearInterval(this.poll);
    clearInterval(this.tick);
    clearTimeout(this.killTimer);
    this.q?.done(false);
    this.setStatus({ state: "done" });
    this.proc.close();
  }

  /** SIGKILL now, nothing awaited (the process is exiting). */
  kill(): void {
    try {
      if (this.alive) this.proc.kill("SIGKILL");
    } catch {}
  }

  /** Frees the screen model (after the session is removed from the list). */
  dispose(): void {
    this.finish();
    this.screen.dispose();
  }
}

/** A session as `launchSession` starts it: the session and the notes to show (icacls warnings). */
export interface Launched {
  session: AgentSession;
  notes: string[];
}

/**
 * Starts a UI launch's agent as a Gluon session: `prepareLaunch` (events directory, adapter files,
 * `GLUON_*`, telemetry), then the agent in its PTY at the frame's interior size. Its files are
 * removed when it exits.
 */
export function launchSession(cmd: Command, settings: HandoffSettings, o: { cwd: string; cols: number; rows: number; tmp?: string; telemetry?: SessionWatch["telemetry"]; screen?: AgentSessionOptions["screen"]; spawn?: Spawner; compactTimeoutMs?: number; firstLineTiming?: AgentSessionOptions["firstLineTiming"] }): Launched {
  if (!cmd.harness) throw new Error("not an agent launch");
  const prepared = prepareLaunch(cmd, settings, { ...(o.tmp ? { tmp: o.tmp } : {}), ...(o.telemetry ? { telemetry: o.telemetry } : {}) });
  let session: AgentSession;
  try {
    session = new AgentSession({ argv: prepared.argv, env: prepared.env, cwd: o.cwd, harness: cmd.harness, settings, events: prepared.events, cols: o.cols, rows: o.rows, ...(o.screen ? { screen: o.screen } : {}), ...(o.spawn ? { spawn: o.spawn } : {}), ...(o.compactTimeoutMs ? { compactTimeoutMs: o.compactTimeoutMs } : {}), ...(prepared.firstLine ? { firstLine: prepared.firstLine, ...(o.firstLineTiming ? { firstLineTiming: o.firstLineTiming } : {}) } : {}) });
  } catch (e) {
    prepared.cleanup();
    throw e;
  }
  void session.exited.finally(() => prepared.cleanup());
  return { session, notes: prepared.notes };
}
