/**
 * The `handoff` settings: what happens around an agent's session in Gluon (issue #13): its end,
 * its /clear and /compact, the home key, the mouse.
 */
import type { Harness } from "./harnesses.ts";

export const ON_EXIT = ["return", "quit"] as const;
export const ON_CLEAR = ["ask", "stay"] as const;
export const ON_COMPACT = ["ask", "stay"] as const;

export interface HandoffSettings {
  /** return: the session closes when the agent exits and the sessions home shows; quit: Gluon exits with the agent's code (the last session). */
  on_exit: (typeof ON_EXIT)[number];
  /** ask: the agent's /clear (or /new) asks whether to end the session; stay: the agent's own /clear. */
  on_clear: (typeof ON_CLEAR)[number];
  /** ask: /compact and auto-compaction ask whether to end the session instead; stay: the agent compacts. */
  on_compact: (typeof ON_COMPACT)[number];
  /** The key that opens the session menu (←/→ switch, again: Gluon's sessions home) (`pty/keys.ts` names: "ctrl+\\", "ctrl+]", …). */
  key: string;
}

export interface HandoffConfig extends HandoffSettings {
  /** Per-agent values; they win over the ones above. */
  agents: Partial<Record<Harness, Partial<HandoffSettings>>>;
  /**
   * Gluon: the mouse wheel scrolls an open session's frame when its agent hasn't asked for the
   * mouse (Gluon turns mouse reporting on for that; at home a drag selects and copies text). false: never.
   */
  mouse_capture: boolean;
}

/** Settings of the whole `handoff` section only (no per-agent value). */
export const HANDOFF_GLOBAL_KEYS = ["mouse_capture"] as const;

export const HANDOFF_KEYS = ["on_exit", "on_clear", "on_compact", "key"] as const;

/** Keys an earlier version wrote: still accepted in a config file, ignored (`nudge`: the session brief no longer carries a return line). */
export const LEGACY_HANDOFF_KEYS = ["nudge"] as const;

/** Not ctrl+]: Codex binds it (skip_question). A saved ctrl+] still works. */
export const DEFAULT_KEY = "ctrl+\\";

export const handoffDefaults = (): HandoffConfig => ({ on_exit: "return", on_clear: "ask", on_compact: "ask", key: DEFAULT_KEY, agents: {}, mouse_capture: true });

/** The effective settings for one agent. */
export function handoffFor(h: HandoffConfig, harness: Harness): HandoffSettings {
  const { agents, mouse_capture: _, ...base } = h;
  return { ...base, ...agents[harness] };
}

/** What a launched agent may report back, as `GLUON_HANDOFF` lists it (comma-separated). */
export type HandoffPiece = "clear" | "compact";

export function handoffPieces(s: HandoffSettings): HandoffPiece[] {
  return [...(s.on_clear === "ask" ? ["clear" as const] : []), ...(s.on_compact === "ask" ? ["compact" as const] : [])];
}

export const parsePieces = (value: string | undefined): HandoffPiece[] =>
  (value ?? "").split(",").filter((p): p is HandoffPiece => p === "clear" || p === "compact");

/** The command that sends the user back to Gluon (the agent has `GLUON_SELF`; Claude Code runs it without a permission prompt: `returnRules`). */
export const RETURN_COMMAND = { posix: '"$GLUON_SELF" signal back', powershell: "& $env:GLUON_SELF signal back" };

/** The section Gluon adds to an existing config file, comments included. */
export const HANDOFF_YAML = `# Agent sessions in Gluon. Per-agent values under \`agents\` (claude-code, codex, opencode,
# grok-build, antigravity, kimi-code) win, e.g.  agents: { codex: { on_clear: stay } }
handoff:
  on_exit: return  # return: the session closes when the agent exits, back to the sessions home | quit: Gluon exits with the agent's code (the last session)
  on_clear: ask    # ask: the agent's /clear asks whether to end the session | stay: the agent's own /clear
  on_compact: ask  # ask: /compact (and auto-compaction where possible) asks whether to end the session instead | stay: the agent compacts
  key: ctrl+\\      # opens the session menu from anywhere in the agent: ←/→ switch, the key again shows the sessions home (or ctrl+], ctrl+^, ctrl+_)
  mouse_capture: true  # clicks on the sessions home's rows; the wheel scrolls the home chat, and a session's frame when its agent doesn't use the mouse (a drag over the home chat selects and copies text) | false: never
`;
