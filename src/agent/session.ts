import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.ts";
import type { Effort } from "../config.ts";
import type { Mode } from "../harnesses.ts";
import type { LaunchChoice } from "../launchers.ts";
import { maskSecrets } from "../secrets.ts";
import { routeCatalog, routeEnv } from "../intake.ts";
import { defaultRouting } from "../routing-config.ts";
import { route, type Config as RoutingConfig, type RouteInput } from "../routing.ts";
import { parseProposal, pickChoice, type AgentTriple, type ChoiceOverride, type Proposal, type Routed } from "./choices.ts";
import { pathInstructions } from "./prompt.ts";
import { describeRepoTool, MAX_NEXT_QUESTIONS, REPO_TOOLS, runRepoTool, TOOLS, type Activity, type Question } from "./tools.ts";

/** Model calls per developer message, invalid proposals per message, and repo tool calls per message. */
const MAX_STEPS = 16;
const MAX_INVALID = 2;
const MAX_TOOLS = 12;

/** Option labels the brain adds that duplicate the UI's own "Something else" row. */
const OTHER_OPTION = /^\s*(other|something else|else|none of (the|these)|אחר|משהו אחר)\b/i;

/** One model call: streams text through onText and resolves with the final message. */
export type ModelClient = (
  req: { system: string; messages: Anthropic.MessageParam[]; tools: Anthropic.Tool[]; signal: AbortSignal },
  onText: (delta: string) => void,
) => Promise<{ content: Anthropic.ContentBlock[]; stop_reason: string | null }>;

/** What a tool call gives back to the brain. `stop`: end the turn after answering, with this notice. */
export type ToolOutput = { content: string; error?: boolean; stop?: string };

/** What a brain that runs the tool loop itself reports back, and how it runs Gluon's tools. */
export interface LoopHooks {
  /** A model call starts. */
  begin(): void;
  text(delta: string): void;
  /** The model call is done; `content` names its tool calls without their prefix. */
  end(content: Anthropic.ContentBlock[]): void;
  /** Runs one of Gluon's tools; a question or proposal resolves once the developer answers. */
  tool(name: string, input: Record<string, unknown>): Promise<ToolOutput>;
  /** The brain's process stopped after a conversation and was started again: it remembers nothing. */
  restarted?(): void;
}

/** A brain that runs the tool loop itself (the Claude Agent SDK), calling back into the session. */
export interface LoopBrain {
  /** One developer message; resolves when the brain ends its turn. */
  send(text: string, system: string, hooks: LoopHooks, signal: AbortSignal): Promise<void>;
  close?(): void;
}

type Explored = Extract<Item, { kind: "explored" }>;

/** What the history shows, in order. */
export type Item =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "explored"; rows: Activity[] }
  | { id: number; kind: "question"; question: string }
  | ({ id: number; kind: "proposal" } & ShownProposal)
  | { id: number; kind: "notice"; text: string; tone: "error" | "info" };

/**
 * A proposal as shown: its options (`choices`, recommended first), and `choice`, the recommended
 * one as it launches. `spec` is that one's.
 */
export type ShownProposal = Proposal & { choice: LaunchChoice };

export type Pending =
  | { kind: "question"; question: Question }
  | ({ kind: "proposal" } & ShownProposal)
  | null;

/** A launch the developer confirmed, with the session's name. */
export type NamedChoice = LaunchChoice & {
  name: string;
  /** The proposal's routing data (`route`'s types and why lines): recorded by the local analytics (`src/analytics.ts`), never sent anywhere. */
  types?: string[];
  why?: string[];
};

export interface State {
  items: Item[];
  /** Items still changing (the streaming reply, the current Explored group); drawn below the history. */
  live: Item[];
  pending: Pending;
  workingSince: number | null;
  status: string;
  /** The brain's label, when it moved to another step of the order during the session. */
  brain?: string;
}

/** The next brain to try when this one's model turns out to be unavailable, or null. `error`: what the brain threw (raw). */
export type BrainFallback = (message: string, error: unknown) => Promise<{ client: ModelClient | LoopBrain; label: string } | null>;

export class Session {
  private messages: Anthropic.MessageParam[] = [];
  private state: State = { items: [], live: [], pending: null, workingSince: null, status: "Working" };
  private nextId = 1;
  /** Directories whose AGENTS.md / CLAUDE.md the brain has been shown (`pathInstructions`). */
  private instructionDirs = new Set<string>();
  private listeners = new Set<(s: State) => void>();
  private abort: AbortController | null = null;
  /** tool_results gathered for the current assistant turn, waiting on the developer. */
  private held: { results: Anthropic.ToolResultBlockParam[]; toolUseId: string } | null = null;
  /** tool_results of a turn that was stopped; they open the next user message. */
  private carry: Anthropic.ToolResultBlockParam[] | null = null;
  /**
   * Where the developer's current message starts in the history, and the tool_results it answered
   * (as they must open it again): a brain that takes over sees the history from before it.
   */
  private turnStart: { at: number; carry: Anthropic.ToolResultBlockParam[] | null } = { at: 0, carry: null };
  private steps = 0;
  private invalid = 0;
  private toolCalls = 0;
  private onError: (message: string) => string;
  /** The reply being streamed, and the Explored group new repo tool calls go into. */
  private reply: Extract<Item, { kind: "assistant" }> | null = null;
  private explored: Explored | null = null;
  /** Loop brains: the question or proposal waiting on the developer, and whether this model call made one. */
  private waiter: { resolve: (text: string) => void; reject: (e: Error) => void } | null = null;
  private asked = false;
  /** An `ask_user` with several questions: the ones still to show, and the answers so far. */
  private series: { rest: Question[]; done: { question: string; answer: string }[] } | null = null;
  /** Loop brains: why Gluon ended the turn itself. */
  private stopped: string | null = null;
  /** Loop brains: the last model call of the turn said something (words or a tool call); false at the start of every call, and of every message the developer sends. */
  private said = false;
  /** What the last `route` call decided: the only thing `propose_launch` may offer. Cleared once a proposal is shown (a reply goes back through route). */
  private routed: Routed | null = null;
  /** The one `ask_user` batch of this proposal round has been shown; reset when a proposal is shown. */
  private askedBatch = false;

  constructor(
    private client: ModelClient | LoopBrain,
    private config: Config,
    private system: string,
    private root: string,
    onError?: (message: string) => string,
    private fallback?: BrainFallback,
    /** The developer's routing.yaml (`loadRouting`); the shipped default when a caller names none. */
    private routing: RoutingConfig = defaultRouting(),
  ) {
    this.onError = onError ?? (() => "");
  }

  /**
   * After an error: when the brain's model is unavailable, moves to the next brain and says so.
   * Returns whether it moved.
   */
  private async moveOn(message: string, error: unknown): Promise<boolean> {
    const next = this.fallback ? await this.fallback(message, error).catch(() => null) : null;
    if (!next) return false;
    if (typeof this.client !== "function") this.client.close?.();
    if (typeof next.client !== "function" || typeof this.client !== "function") {
      // A brain that runs its own loop keeps its own history; the next one starts fresh.
      this.messages = [];
      this.carry = null;
    } else {
      // Back to before the developer's message (they send it again), so every tool_use in the
      // history still has its tool_result right after it.
      this.messages = this.messages.slice(0, this.turnStart.at);
      this.carry = this.turnStart.carry;
    }
    this.client = next.client;
    this.routed = null;
    this.held = null;
    this.commit({ id: this.id(), kind: "notice", tone: "error", text: `Error: ${message}\nThat model isn't available, so the intake agent moved to ${next.label}. Send your message again.` });
    this.set({ brain: next.label });
    return true;
  }

  subscribe(fn: (s: State) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  get snapshot(): State {
    return this.state;
  }

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  private commit(...items: Item[]) {
    this.set({ items: [...this.state.items, ...items] });
  }

  private id() {
    return this.nextId++;
  }

  /** The developer typed something: a new message, an answer, or a reply to a proposal. */
  async submit(shown: string): Promise<void> {
    const pending = this.state.pending;
    if (pending?.kind === "question") {
      this.commit({ id: this.id(), kind: "question", question: pending.question.question });
    }
    this.commit({ id: this.id(), kind: "user", text: shown });
    // Whatever the developer says (an interruption, a message after a text-only turn, an answer) goes back through route: a route made before it can't carry it (BUG-458).
    this.routed = null;
    // Several questions come one by one; the brain gets the answers together after the last.
    let text = shown;
    if (pending?.kind === "question" && this.series) {
      const { rest, done } = this.series;
      done.push({ question: pending.question.question, answer: shown });
      const next = rest.shift();
      if (next) {
        this.set({ pending: { kind: "question", question: { ...next, step: { n: done.length + 1, of: done.length + 1 + rest.length } } } });
        return;
      }
      text = done.map((d) => `${d.question} → ${d.answer}`).join("\n");
      this.series = null;
    }
    this.set({ pending: null });
    if (typeof this.client !== "function") return this.submitLoop(text, pending);
    this.turnStart = { at: this.messages.length, carry: null };
    if (this.held) {
      const { results, toolUseId } = this.held;
      this.held = null;
      this.turnStart.carry = [...results, { type: "tool_result", tool_use_id: toolUseId, content: "The developer's answer is in their next message." }];
      const content =
        pending?.kind === "proposal"
          ? `The developer did not launch. They replied: ${text}`
          : `The developer answered: ${text}`;
      results.push({ type: "tool_result", tool_use_id: toolUseId, content });
      this.messages.push({ role: "user", content: results });
    } else if (this.carry) {
      this.turnStart.carry = this.carry;
      this.messages.push({ role: "user", content: [...this.carry, { type: "text", text }] });
    } else {
      this.messages.push({ role: "user", content: text });
    }
    this.carry = null;
    await this.run();
  }

  /**
   * The developer started the session with option `index` of the proposal (0: the recommended one),
   * its model or effort changed by `override` (Tab adjust), its mode (ctrl+t; wins over the proposal's) and its permissions (ctrl+p). Null when nothing is proposed, the
   * option isn't one, or the override isn't offered for that agent.
   */
  confirm(index = 0, override?: ChoiceOverride): NamedChoice | null {
    const pending = this.state.pending;
    if (pending?.kind !== "proposal") return null;
    const choice = pickChoice(this.config, pending, index, override);
    if (typeof choice === "string") return null;
    return { ...choice, name: pending.name, ...(pending.types ? { types: [...pending.types] } : {}), ...(pending.why ? { why: [...pending.why] } : {}) };
  }

  /** Shows a message from Gluon itself (not the brain) in the history. */
  notice(text: string, tone: "error" | "info" = "error"): void {
    this.commit({ id: this.id(), kind: "notice", tone, text });
  }

  interrupt(): void {
    this.abort?.abort();
  }

  /** Ends the session: stops the brain and anything waiting on the developer. */
  close(): void {
    this.abort?.abort();
    this.waiter?.reject(new Error("closed"));
    this.waiter = null;
    if (typeof this.client !== "function") this.client.close?.();
  }

  get busy(): boolean {
    return this.state.workingSince !== null;
  }

  private async run(): Promise<void> {
    this.set({ workingSince: Date.now(), status: "Working" });
    this.steps = this.invalid = this.toolCalls = 0;
    try {
      while (await this.step()) {
        if (++this.steps >= MAX_STEPS) {
          this.carry = this.messages.pop()!.content as Anthropic.ToolResultBlockParam[];
          throw new TurnStopped(`The intake agent made ${MAX_STEPS} calls without asking or proposing, so it stopped. Reply to continue.`);
        }
      }
    } catch (e) {
      const aborted = this.abort?.signal.aborted;
      this.flushLive();
      const message = maskSecrets((e as Error).message);
      // The developer sends the message again to the next brain (moveOn rewinds the history).
      if (!aborted && !(e instanceof TurnStopped) && this.fallback && (await this.moveOn(message, e))) return;
      const hint = aborted || e instanceof TurnStopped ? "" : maskSecrets(this.onError(message));
      this.commit({
        id: this.id(),
        kind: "notice",
        tone: aborted ? "info" : "error",
        text: aborted ? "Interrupted — tell the intake agent what to do instead." : `Error: ${message}${hint ? `\n${hint}` : ""}`,
      });
      if (!(e instanceof TurnStopped)) this.dropDanglingToolUse();
    } finally {
      this.abort = null;
      this.set({ workingSince: null });
    }
  }

  /** After an interrupt or error the last assistant turn may hold unanswered tool_use blocks; drop it. */
  private dropDanglingToolUse() {
    const last = this.messages.at(-1);
    if (last?.role === "assistant") this.messages.pop();
    this.held = null;
    this.carry = null;
  }

  private flushLive() {
    const done = this.state.live.filter((i) => i.kind !== "assistant" || i.text.trim());
    this.set({ live: [], items: [...this.state.items, ...done] });
  }

  private beginReply() {
    this.reply = { id: this.id(), kind: "assistant", text: "" };
    this.set({ live: [...this.state.live, this.reply] });
  }

  private onText(delta: string) {
    const reply = this.reply!;
    reply.text += delta;
    this.set({ live: this.state.live.map((i) => (i.id === reply.id ? { ...reply } : i)), status: "Working" });
  }

  /** The model call is done: its words go into the history, or its tool calls into the Explored group. */
  private endReply(content: Anthropic.ContentBlock[]) {
    const reply = this.reply!;
    // An Explored group stays live (printed history cannot change) until the brain says something,
    // so exploration with no words in between grows one cell, as in Codex.
    const prior = this.state.live.find((i): i is Explored => i.kind === "explored");
    this.explored = null;
    // The question popup shows the question; a closing question in chat would say it twice.
    if (content.some((b) => b.type === "tool_use" && b.name === "ask_user")) reply.text = withoutClosingQuestion(reply.text);
    if (reply.text.trim()) {
      this.set({ live: [], items: [...this.state.items, ...(prior ? [prior] : []), { ...reply }] });
    } else {
      this.explored = prior ?? null;
      this.set({ live: prior ? [prior] : [] });
    }
  }

  /** Runs one tool call: a repo tool, or a question or proposal to wait on. */
  private async handleTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput | { wait: NonNullable<Pending> }> {
    if (REPO_TOOLS.has(name)) {
      const activity = describeRepoTool(name, input);
      const explored = (this.explored ??= { id: this.id(), kind: "explored", rows: [] });
      explored.rows.push(activity);
      const show = () => this.set({ live: [{ ...explored, rows: [...explored.rows] }], status: "Exploring" });
      show();
      if (++this.toolCalls > MAX_TOOLS) {
        activity.error = "skipped";
        show();
        return { content: "Exploration budget used up for this turn. Ask the developer or propose now with what you know.", error: true };
      }
      try {
        const content = await runRepoTool(this.root, name, input, signal);
        return { content: content + pathInstructions(this.root, name, input, this.instructionDirs) };
      } catch (e) {
        if (signal.aborted) throw e;
        activity.error = (e as Error).message;
        show();
        return { content: (e as Error).message, error: true };
      }
    }
    if (name === "route") return this.routeTool(input);
    if (name === "ask_user") {
      // One batch of questions per proposal round, enforced here (the prompt says it too): more is a nuisance (the developer answers at most once before a proposal).
      if (this.askedBatch) return { content: "You've already asked your one batch of questions for this proposal. Don't ask again: assume what you must, list it under Assumptions in the spec, and go on to route and propose_launch.", error: true };
      const questions = cleanQuestions(input);
      if (typeof questions === "string") return { content: `Invalid question: ${questions}`, error: true };
      const [first, ...rest] = questions as [Question, ...Question[]];
      this.series = rest.length ? { rest, done: [] } : null;
      return { wait: { kind: "question", question: rest.length ? { ...first, step: { n: 1, of: questions.length } } : first } };
    }
    if (name === "propose_launch") {
      if (!this.routed) return { content: "Call route first: Gluon takes the mode, the recommended agent and the alternatives from route's result, not from propose_launch. Then call propose_launch again.", error: true };
      const proposal = parseProposal(this.config, input, this.routed);
      if (typeof proposal !== "string") {
        const main = proposal.choices[0]!;
        return { wait: { kind: "proposal", ...proposal, choice: { ...main, spec: proposal.spec, reason: proposal.reason } } };
      }
      const error = proposal;
      const content = `Invalid proposal: ${error}`;
      this.flushLive();
      if (++this.invalid >= MAX_INVALID) return { content, error: true, stop: `The intake agent's proposal wasn't valid (${error}), twice. Reply to tell it what you want.` };
      this.commit({ id: this.id(), kind: "notice", tone: "info", text: `The intake agent proposed something that can't be launched (${error}); asking it to fix that.` });
      return { content, error: true };
    }
    return { content: `Unknown tool ${name}`, error: true };
  }

  /** `route`: the deterministic part of the choice, in code; its result is what a proposal may offer. */
  private routeTool(input: Record<string, unknown>): ToolOutput {
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const types = (Array.isArray(input.types) ? input.types : []).map((t) => (typeof t === "object" && t !== null ? (t as Record<string, unknown>) : { type: t }));
    const call = {
      types: types.map((t) => ({ ...t, type: str(t.type) ?? "" })),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(str(input.pinned) ? { pinned: str(input.pinned) } : {}),
      ...(str(input.harness) ? { harness: str(input.harness) } : {}),
      ...(str(input.because) ? { because: str(input.because) } : {}),
    } as unknown as RouteInput;
    let out: ReturnType<typeof route>;
    try {
      out = route(this.routing, routeCatalog(this.config, this.config.agents, this.routing), call, routeEnv(this.config));
    } catch (e) {
      // A routing.yaml shape route didn't foresee: the brain is told (`gluon routing check` finds it), the turn goes on.
      out = { error: `route failed on routing.yaml: ${(e as Error).message}; the developer can run \`gluon routing check\`` };
    }
    if ("error" in out) {
      // A failed route leaves nothing to propose from.
      this.routed = null;
      return { content: JSON.stringify(out), error: true };
    }
    this.routed = { mode: out.mode, recommended: out.recommended as AgentTriple, alternatives: out.alternatives as AgentTriple[], why: out.why, types: call.types.map((t) => t.type) };
    return { content: JSON.stringify(out) };
  }

  /** Shows the question or proposal the brain is waiting on. */
  private wait(pending: NonNullable<Pending>) {
    this.flushLive();
    if (pending.kind === "question") this.askedBatch = true;
    if (pending.kind === "proposal") {
      // The next round starts here: a reply to this proposal goes back through route, and may ask one more batch.
      this.routed = null;
      this.askedBatch = false;
      const { kind: _, ...shown } = pending;
      this.commit({ id: this.id(), kind: "proposal", ...shown });
    }
    this.set({ pending });
  }

  /** One model call and its tools. Returns true to call the model again. */
  private async step(): Promise<boolean> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.beginReply();
    const res = await (this.client as ModelClient)({ system: this.system, messages: this.messages, tools: TOOLS, signal }, (delta) => this.onText(delta));
    // No blank text block goes into the history: the Anthropic API refuses it, even beside a tool call.
    const content = res.content.filter((b) => b.type !== "text" || b.text.trim());
    const silent = res.stop_reason !== "max_tokens" && !content.some((b) => b.type === "tool_use" || b.type === "text");
    if (silent) {
      // No words and no tool call (a lone thinking block counts as none): an empty assistant turn would be refused with every later request (BUG-613).
      // Back to before the developer's message, as `moveOn` does: they send it again.
      this.endReply(content);
      this.flushLive();
      this.messages = this.messages.slice(0, this.turnStart.at);
      this.carry = this.turnStart.carry;
      this.held = null;
      this.notice("The intake agent said nothing; send your message again.");
      return false;
    }
    this.messages.push({ role: "assistant", content });
    this.endReply(content);

    const uses = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) {
      this.flushLive();
      if (res.stop_reason === "max_tokens") throw new Error("The intake agent's reply was cut off (too long).");
      return false; // the brain spoke; the developer's turn
    }
    // A reply cut off mid-tool-call carries incomplete input: answer every call with an error.
    const cutOff = res.stop_reason === "max_tokens";

    const results: Anthropic.ToolResultBlockParam[] = [];
    let waiting: { use: Anthropic.ToolUseBlock; pending: NonNullable<Pending> } | null = null;
    const fail = (use: Anthropic.ToolUseBlock, content: string) => results.push({ type: "tool_result", tool_use_id: use.id, content, is_error: true });

    for (const use of uses) {
      if (cutOff) {
        fail(use, "Your reply hit the output limit and this call was cut off. Try again with a shorter input (e.g. a more concise spec).");
        continue;
      }
      if (waiting && !REPO_TOOLS.has(use.name)) {
        fail(use, "Skipped: one question or proposal at a time.");
        continue;
      }
      const out = await this.handleTool(use.name, (use.input ?? {}) as Record<string, unknown>, signal);
      if ("wait" in out) {
        waiting = { use, pending: out.wait };
        continue;
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content: out.content, ...(out.error ? { is_error: true } : {}) });
      if (out.stop) {
        // Answer the remaining calls; the results open the developer's next message.
        for (const rest of uses.slice(uses.indexOf(use) + 1)) fail(rest, "Skipped.");
        this.carry = results;
        throw new TurnStopped(out.stop);
      }
    }
    if (waiting) {
      this.held = { results, toolUseId: waiting.use.id };
      this.wait(waiting.pending);
      return false;
    }
    this.messages.push({ role: "user", content: results });
    return true;
  }

  /** A loop brain: the developer's text answers the waiting tool call, or starts a new turn. */
  private async submitLoop(text: string, pending: Pending): Promise<void> {
    const waiter = this.waiter;
    this.waiter = null;
    this.steps = this.invalid = this.toolCalls = 0;
    this.said = false;
    this.set({ workingSince: Date.now(), status: "Working" });
    if (waiter) waiter.resolve(pending?.kind === "proposal" ? `The developer did not launch. They replied: ${text}` : `The developer answered: ${text}`);
    else void this.runLoop(text);
    await this.untilIdle();
  }

  private untilIdle(): Promise<void> {
    return new Promise((resolve) => {
      const check = (s: State) => {
        if (s.workingSince !== null) return;
        this.listeners.delete(check);
        resolve();
      };
      this.listeners.add(check);
      check(this.state);
    });
  }

  /** Ends the turn from Gluon's side (a cap was hit), with this notice. */
  private stop(message: string) {
    this.stopped ??= message;
    this.abort?.abort();
  }

  private async runLoop(text: string): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.stopped = null;
    this.said = false;
    const hooks: LoopHooks = {
      begin: () => {
        if (++this.steps > MAX_STEPS) this.stop(`The intake agent made ${MAX_STEPS} calls without asking or proposing, so it stopped. Reply to continue.`);
        this.asked = false;
        this.said = false;
        this.beginReply();
      },
      text: (delta) => {
        if (delta.trim()) this.said = true;
        this.onText(delta);
      },
      end: (content) => {
        if (content.some((b) => b.type === "tool_use" || (b.type === "text" && b.text.trim()))) this.said = true;
        this.endReply(content);
      },
      restarted: () => {
        this.instructionDirs.clear();
        this.notice("The intake agent restarted; it doesn't remember this conversation — repeat what matters.", "info");
      },
      tool: async (name, input) => {
        if (signal.aborted) return { content: "Stopped.", error: true };
        this.said = true;
        if (!REPO_TOOLS.has(name) && this.asked) return { content: "Skipped: one question or proposal at a time.", error: true };
        const out = await this.handleTool(name, input, signal);
        if (!("wait" in out)) {
          if (out.stop) this.stop(out.stop);
          return out;
        }
        // Checked again after the await: two calls made in the same tick both passed the check
        // above, and only the first may wait on the developer (a second waiter would orphan it).
        if (this.asked) return { content: "Skipped: one question or proposal at a time.", error: true };
        this.asked = true;
        const answer = new Promise<string>((resolve, reject) => (this.waiter = { resolve, reject }));
        this.wait(out.wait);
        this.set({ workingSince: null });
        return { content: await answer };
      },
    };
    try {
      await (this.client as LoopBrain).send(text, this.system, hooks, signal);
      this.flushLive();
      // The brain ended its turn without an error. A brain whose interrupt raises lands in the catch; one that just returns still owes the developer why it ended.
      if (this.stopped) this.commit({ id: this.id(), kind: "notice", tone: "error", text: this.stopped });
      else if (!signal.aborted && !this.said) this.notice("The intake agent said nothing; send your message again.");
    } catch (e) {
      this.flushLive();
      const stopped = this.stopped;
      const aborted = signal.aborted && !stopped;
      const message = maskSecrets((e as Error).message);
      if (!aborted && !stopped && (await this.moveOn(message, e))) return;
      const hint = aborted || stopped ? "" : maskSecrets(this.onError(message));
      this.commit({
        id: this.id(),
        kind: "notice",
        tone: aborted ? "info" : "error",
        text: stopped ?? (aborted ? "Interrupted — tell the intake agent what to do instead." : `Error: ${message}${hint ? `\n${hint}` : ""}`),
      });
    } finally {
      if (this.abort?.signal === signal) this.abort = null;
      // A question left open by a turn that ended can't be answered any more.
      if (this.waiter) {
        this.waiter = null;
        this.set({ pending: null });
      }
      this.set({ workingSince: null });
    }
  }
}

/** Drops a trailing question sentence ("… Which functions do you want?"). */
export function withoutClosingQuestion(text: string): string {
  return text.replace(/(^|(?<=[.!:…]\s+|\n))[^.!?:…\n]*\?\s*$/u, "").trim();
}

/** Ends the turn on purpose; the conversation stays consistent for the next message. */
class TurnStopped extends Error {}

/** The questions to show (the first, then `next_questions`), or why they can't be shown. */
function cleanQuestions(input: Record<string, unknown>): Question[] | string {
  const first = cleanQuestion(input);
  if (typeof first === "string") return first;
  const more = Array.isArray(input.next_questions) ? input.next_questions.slice(0, MAX_NEXT_QUESTIONS) : [];
  const questions = [first];
  for (const m of more) {
    const q = typeof m === "object" && m !== null ? cleanQuestion(m as Record<string, unknown>) : "not a question";
    if (typeof q === "string") return `next_questions: ${q}`;
    questions.push(q);
  }
  return questions;
}

/** One question to show, or why it can't be shown. Drops the brain's own "Other" options. */
function cleanQuestion(input: Record<string, unknown>): Question | string {
  if (typeof input.question !== "string" || !input.question.trim()) return "question is empty";
  if (!Array.isArray(input.options)) return "options must be a list";
  const options = input.options
    .filter((o): o is { label: string; description?: unknown } => typeof o === "object" && o !== null && typeof o.label === "string" && o.label.trim() !== "")
    .filter((o) => !OTHER_OPTION.test(o.label))
    .slice(0, 8)
    .map((o) => ({ label: o.label.trim(), ...(typeof o.description === "string" && o.description.trim() ? { description: o.description.trim() } : {}) }));
  if (options.length === 0) return "give 2-4 options with labels";
  return { question: input.question.trim(), options };
}
