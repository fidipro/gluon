/**
 * Per-launch adapters (issue #13): what Gluon adds to an agent's command so that the agent can
 * send the user back to Gluon (`events.ts`): `/gluon`, the return command pre-allowed, and
 * auto-compaction's question (`/clear`, typed `/compact` and the return key are the PTY's: `src/pty/`),
 * and the agent's status (`statusHook`, display only). An adapter is pure: it says what to add, and
 * `handOff` creates the directories, writes the files and cleans up. `--launch` uses none.
 */
import type { AgentEvent } from "../events.ts";
import type { HandoffPiece, HandoffSettings } from "../handoff.ts";
import type { Harness } from "../harnesses.ts";

/** Stands for the launch's adapter directory in argv, env values and file contents (`handOffSession` substitutes it). */
export const ADAPTER_DIR = "<gluon-adapter-dir>";
/** `ADAPTER_DIR` inside a JSON string value: substituted JSON-escaped (a Windows path's `\`; BUG-140). */
export const ADAPTER_DIR_JSON = "<gluon-adapter-dir-json>";
/**
 * Stands for `GLUON_SELF`'s value (`self.ts`) where a harness can't expand an environment
 * variable itself (no adapter needs it today). Hook commands use `"$GLUON_SELF"`.
 */
export const SELF = "<gluon-self>";

export interface AdapterContext {
  harness: Harness;
  /** The installed version (`versionOf`), or null when unknown. */
  version: string | null;
  /** The effective settings for this agent (`handoffFor`). */
  handoff: HandoffSettings;
  /**
   * The environment the agent inherits (`process.env`), for an adapter that must extend a variable
   * the user set rather than replace it (OpenCode's `OPENCODE_CLI_CONFIG_CONTENT`). Read, never changed.
   */
  env?: Record<string, string | undefined>;
  /** Where the agent runs (default `process.platform`): hook commands differ on Windows. */
  platform?: NodeJS.Platform;
}

export interface AdapterOutput {
  /** Spliced before the spec (the spec stays the last argument). */
  argv: string[];
  env: Record<string, string>;
  /** Files to write under `ADAPTER_DIR`: relative path → contents. */
  files: Record<string, string>;
}

export interface Adapter {
  harness: Harness;
  /** Below this version (or when it's unknown) the adapter adds nothing. */
  minVersion?: string;
  build(ctx: AdapterContext): AdapterOutput;
  /** What `doctor` says about it: what's supported, skipped or ignored with these settings. */
  notes(ctx: AdapterContext): string[];
  /**
   * A hook the harness runs, as `"$GLUON_SELF" hook <harness> <name>` (`internal.ts`): gets the
   * hook's input (the harness's JSON on stdin) and resolves with what to print and which events to
   * send. Runs only inside a Gluon launch; never rejects. Fast, except a `PreCompact` hook,
   * which waits for the user's answer (`askBeforeCompact`).
   */
  hook?(name: string, input: string, ctx: HookContext): Promise<HookResult>;
}

export interface HookContext {
  /** The launch's events directory (`GLUON_EVENTS`): a hook may keep small state files there. */
  eventsDir: string;
  /** The enabled pieces (`GLUON_HANDOFF`). */
  pieces: HandoffPiece[];
  /** How long a waiting hook waits for Gluon's answer (tests; default `askBeforeCompact`'s). */
  answerTimeoutMs?: number;
}

export interface HookResult {
  stdout?: string;
  /** The hook's exit code (default 0). */
  code?: number;
  /** Written to the events directory (`writeEvent`). */
  events?: AgentEvent[];
}

export const NO_ADAPTER: AdapterOutput = { argv: [], env: {}, files: {} };
