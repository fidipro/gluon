/**
 * The home view's rules that need no terminal: the agents' readiness before any check, the
 * questions it asks (discard, end, quit, start again) with their shorter forms, and whether a
 * resumed agent refused its session. Pure, so they are tested as functions; `src/gluon.ts` acts
 * on what these return.
 */
import { NAME_PREFIX } from "./agent/choices.ts";
import { connsOf, type Config } from "./config.ts";
import { safeLine } from "./events.ts";
import { HARNESS_INFO, isPlanConn, type Harness } from "./harnesses.ts";
import { launchProblem, modeLostOnResume } from "./launchers.ts";
import { maskSecrets } from "./secrets.ts";
import { truncate, type Readiness } from "./ui/layout.ts";
import type { ChildRecord } from "./workspaces.ts";

/** The first-run list's order (design brief 5.1). */
export const READINESS_ORDER: readonly Harness[] = ["claude-code", "codex", "grok-build", "antigravity", "opencode", "kimi-code"];

/** A readiness note; OpenCode's says it is the lane for open-weight models. */
export const withNote = (h: Harness, note?: string): { note?: string } => {
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
