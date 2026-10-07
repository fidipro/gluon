/**
 * Sample data for Gluon's home view tests: the sessions of the design mockup
 * (`qa/gluon-design/gluon-screen-1-sessions-home.png`) in a real `SessionStore`, and a stand-in
 * for the intake agent `Session` whose state a test sets directly.
 */
import type { Effort } from "../../src/config.ts";
import type { Mode } from "../../src/harnesses.ts";
import type { NamedChoice, Session, ShownProposal, State } from "../../src/agent/session.ts";
import { SessionStore, type RunHandle } from "../../src/sessions.ts";

export const NOW = 1_800_000_000_000;
const min = 60_000;
const handle: RunHandle = { alive: true, end: async () => {} };

/** The mockup's five sessions: one awaiting input, two working, one the user marked done, one drafting. */
export function mockupStore(): SessionStore {
  const store = new SessionStore();
  const run = (name: string, agent: Parameters<SessionStore["launched"]>[1], ago: number, patch: Parameters<SessionStore["update"]>[1]) => {
    const s = store.launched(name, agent, handle, NOW - ago * min);
    store.update(s.id, patch);
    return s;
  };
  run("pty-return-flow", { harness: "claude-code", model: "opus", effort: "high" }, 25, { state: "awaiting", activity: "Keep the session resumable?", cost: { usd: 4.12, approx: false }, contextPct: 84 });
  run("flaky-launcher-test", { harness: "codex", model: "gpt-6.1-sol", effort: "medium" }, 8, { activity: "Running 14 tests", cost: { usd: 0.38, approx: false }, contextPct: 38 });
  run("config-docs-scan", { harness: "opencode", model: "deepseek-flash", effort: "low" }, 3, { activity: "Reading 31 files", cost: { usd: 0.06, approx: false } });
  const done = run("spawn-tty-explainer", { harness: "claude-code", model: "sonnet", effort: "low" }, 61, { activity: "Summary ready · 4 files read", cost: { usd: 0.21, approx: true }, contextPct: 12 });
  store.toggleDone(done.id);
  store.ensureDraft(NOW);
  return store;
}

/** An intake agent session whose state the test sets; records what was sent and started. */
export class StubSession {
  state: State = { items: [], live: [], pending: null, workingSince: null, status: "Working" };
  sent: string[] = [];
  confirmed: { index: number; override?: { model?: string; effort?: Effort; mode?: Mode } }[] = [];
  interrupted = 0;
  private listeners = new Set<(s: State) => void>();

  get snapshot() {
    return this.state;
  }
  get busy() {
    return this.state.workingSince !== null;
  }
  subscribe(fn: (s: State) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
  async submit(text: string) {
    this.sent.push(text);
  }
  confirm(index = 0, override?: { model?: string; effort?: Effort; mode?: Mode }): NamedChoice | null {
    const p = this.state.pending;
    if (p?.kind !== "proposal" || !p.choices[index]) return null;
    this.confirmed.push({ index, override });
    const mode = override?.mode ?? p.mode;
    return { ...p.choices[index]!, ...override, ...(mode && mode !== "build" ? { mode } : {}), spec: p.spec, reason: p.reason, name: p.name, worktree: p.worktree };
  }
  interrupt() {
    this.interrupted++;
  }
  asSession() {
    return this as unknown as Session;
  }
}

/** The mockup's agent choice. */
export const PROPOSAL: ShownProposal = {
  name: "resume-flag",
  reason: "A small scoped edit, about 3 files in src/cli.",
  spec: "Add a --resume flag so a finished session can be reopened.\n\n- keep the conversation\n- restore the working tree",
  choices: [
    { harness: "claude-code", model: "sonnet", effort: "medium" },
    { harness: "codex", model: "gpt-6.1-sol", effort: "medium" },
    { harness: "opencode", model: "deepseek-flash", effort: "low" },
  ],
  worktree: true,
  choice: { harness: "claude-code", model: "sonnet", effort: "medium", spec: "", reason: "" },
};

/** The mockup's chat, up to the agent choice. */
export function mockupChat(s: StubSession) {
  s.set({
    items: [
      { id: 1, kind: "user", text: "add a resume flag so a finished session can be reopened" },
      { id: 2, kind: "explored", rows: [{ kind: "search", text: "session", where: "src/cli" }, { kind: "read", text: "src/cli/a.ts" }, { kind: "read", text: "src/cli/b.ts" }, { kind: "read", text: "src/cli/c.ts" }] },
      { id: 3, kind: "question", question: "Same agent or a different one? And should it restore the conversation, or just the working tree?" },
      { id: 4, kind: "user", text: "same agent, restored conversation" },
      { id: 5, kind: "proposal", ...PROPOSAL },
    ],
    pending: { kind: "proposal", ...PROPOSAL },
  });
}
