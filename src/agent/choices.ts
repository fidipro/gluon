/**
 * A proposal's options: the session name and the agent triples (harness × model × effort) the
 * developer picks from, and the Tab adjust of one triple. Pure: no I/O.
 */
import type { AgentOption, Config, Effort } from "../config.ts";
import { HARNESS_INFO, MODES, permissionLevels, type Harness, type Mode, type Permissions } from "../harnesses.ts";
import { validateChoice, type LaunchChoice } from "../launchers.ts";
import { MAX_SPEC } from "../workspaces.ts";

/** One option of a proposal: an agent is a harness × model × effort. */
export interface AgentTriple {
  harness: LaunchChoice["harness"];
  model: string;
  effort?: Effort;
  /** ctrl+p's level on an option of the agent choice (the home view's); route never sets one. */
  permissions?: Permissions;
}

/** What `propose_launch` proposes, once valid: one spec for every option, the recommended option first. */
export interface Proposal {
  /** The session's name: `Gluon-` and a short kebab-case slug (`sessionName`). */
  name: string;
  /** The recommended agent, then up to `MAX_ALTERNATIVES` alternatives; each one valid and different. */
  choices: AgentTriple[];
  spec: string;
  reason: string;
  /** How the session starts, for every option; none: build (the harness as it is). */
  mode?: Mode;
  /** The types the session covers (names from routing.yaml), as given to `route`: for stats and evals. */
  types?: string[];
  /** `route`'s lines on why this pick: the mode, level and effort, preferences, caps. */
  why?: string[];
}

export const MAX_ALTERNATIVES = 2;
export const MAX_NAME = 24;
/** What every session's name starts with: the developer tells Gluon's sessions from others by it. */
export const NAME_PREFIX = "Gluon-";
/** The longest slug after `NAME_PREFIX`. */
const MAX_SLUG = MAX_NAME - NAME_PREFIX.length;

/** Words a name derived from the spec skips. */
const FILLER = new Set("a an the to of and or for in on at by with from into so that this it is be as please i we you my our".split(" "));

/** `raw` as a kebab-case slug of at most `max` characters (cut at a word when it can), or null when nothing is left. */
export function slugName(raw: unknown, max = MAX_NAME): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return null;
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max + 1);
  const atWord = cut.lastIndexOf("-");
  return (atWord > 0 ? cut.slice(0, atWord) : slug.slice(0, max)).replace(/-+$/, "");
}

/**
 * A session's name: `Gluon-` and `slug` cut to fit `MAX_NAME` in all. Added after slugging, so the
 * capital G stays; every leading `gluon-` of the slug goes, so it is never prefixed twice (BUG-202).
 */
export function sessionName(slug: string): string {
  const bare = slug.replace(/^(?:gluon(?:-+|$))+/i, "");
  return NAME_PREFIX + (slugName(bare, MAX_SLUG) ?? "session");
}

/**
 * `name`, or, when a session in `taken` already has it, `name-2` (then `-3` …: the first free),
 * still within `MAX_NAME`: the end of the slug is cut to make room, at a word when it can (BUG-219).
 */
export function numberedName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const room = MAX_NAME - suffix.length;
    const atWord = name.slice(0, room + 1).lastIndexOf("-");
    const base = name.length <= room ? name : (atWord >= NAME_PREFIX.length ? name.slice(0, atWord) : name.slice(0, room)).replace(/-+$/, "");
    if (!used.has(base + suffix)) return base + suffix;
  }
}

/**
 * A slug from the spec's first line, short enough for `sessionName`: its first few words that
 * aren't filler, or "session".
 */
export function nameFromSpec(spec: string): string {
  const line = spec.split("\n").map((l) => l.replace(/[#*_`>[\]()]+/g, " ").trim()).find(Boolean) ?? "";
  const words = line.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FILLER.has(w));
  let name = "";
  for (const w of words) {
    const word = slugName(w);
    if (!word) continue; // a word in a script the slug can't hold
    const next = name ? `${name}-${word}` : word;
    if (next.length > MAX_SLUG || next.split("-").length > 4) break;
    name = next;
  }
  return name || slugName(words.find((w) => slugName(w)), MAX_SLUG) || "session";
}

const sameTriple = (a: AgentTriple, b: AgentTriple) => a.harness === b.harness && a.model === b.model && (a.effort ?? null) === (b.effort ?? null);

const triple = (c: { harness: unknown; model: unknown; effort?: unknown }): AgentTriple =>
  ({ harness: c.harness, model: c.model, ...(c.effort !== undefined && c.effort !== null && c.effort !== "" ? { effort: c.effort } : {}) }) as AgentTriple;

/** What the last `route` call decided (`Session` keeps it): `propose_launch` can offer nothing else. */
export interface Routed {
  mode: Mode;
  recommended: AgentTriple;
  alternatives: AgentTriple[];
  why: string[];
  /** The type names of the call. */
  types: string[];
}

/**
 * `propose_launch`'s input as a proposal, or why it can't be launched. The mode, the recommended agent and
 * the alternatives come from the last route (`routed`), never from the input: the intake can't propose
 * something route didn't return. The recommended agent must be valid (`validateChoice`, effort required
 * where the agent takes one); an alternative that isn't, or repeats an earlier option, is dropped; a missing
 * or empty name is derived from the spec, and either one is named `Gluon-…` (`sessionName`). A mode is kept when it is explore
 * or plan; build is no mode. The types are the input's that route was given (else all of route's).
 * `config.agents` are the agents the brain was offered.
 */
export function parseProposal(config: Config, input: Record<string, unknown>, routed: Routed): Proposal | string {
  const spec = typeof input.spec === "string" ? input.spec.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  // The workspace file the session is saved in drops a longer spec (`MAX_SPEC`, `src/workspaces.ts`): the session could never be resumed (BUG-639).
  if (spec.length > MAX_SPEC) return `the spec has ${spec.length.toLocaleString("en-US")} characters; a session's spec can have at most ${MAX_SPEC.toLocaleString("en-US")} (it is saved with the session). Shorten it and propose again.`;
  const main = triple(routed.recommended);
  const mode = MODES.find((m) => m === routed.mode);
  // An option whose agent can't run the mode (`ModeLaunch.unavailable`) is no option: the main one comes back to the brain as an error, an alternative is dropped.
  // Route already leaves such an agent out (`RouteHarness.noModes`); this is the second line.
  const inMode = mode && mode !== "build" ? { mode } : {};
  const error = validateChoice(config, { ...main, ...inMode, spec, reason }, { requireEffort: true });
  if (error) return error;
  const choices: AgentTriple[] = [main];
  for (const alt of routed.alternatives) {
    if (choices.length > MAX_ALTERNATIVES) break;
    const t = triple(alt);
    if (validateChoice(config, { ...t, ...inMode, spec, reason }, { requireEffort: true })) continue;
    if (!choices.some((c) => sameTriple(c, t))) choices.push(t);
  }
  const named = Array.isArray(input.types) ? input.types.filter((t): t is string => typeof t === "string" && routed.types.includes(t)) : [];
  return {
    name: sessionName(slugName(input.name) ?? nameFromSpec(spec)),
    choices,
    spec,
    reason,
    ...inMode,
    types: named.length ? [...new Set(named)] : routed.types,
    why: routed.why,
  };
}

/** What the developer changed on an option of the agent choice before Enter (`pickChoice`). */
export type ChoiceOverride = { model?: string; effort?: Effort; mode?: Mode; permissions?: Permissions };

/**
 * The option a developer picked, with `override` (model and/or effort from a Tab adjust, a mode
 * from ctrl+t, the option's permissions from ctrl+p; the override's wins over the proposal's) applied, as a launch, or why it can't be
 * launched. The harness never changes. Build is no mode; permissions are build's alone (other modes set their own), and `own` is none.
 */
export function pickChoice(config: Config, proposal: Proposal, index = 0, override: ChoiceOverride = {}): LaunchChoice | string {
  const base = proposal.choices[index];
  if (!base) return `no option ${index + 1}`;
  // An `effort` key set to undefined is an override too: the adjusted model takes none (Tab from a model with an effort to one without).
  const picked = triple({ ...base, ...(override.model !== undefined ? { model: override.model } : {}), ...("effort" in override ? { effort: override.effort } : {}) });
  const mode = override.mode ?? proposal.mode;
  const permissions = (!mode || mode === "build") && override.permissions && override.permissions !== "own" ? override.permissions : undefined;
  const choice: LaunchChoice = { ...picked, ...(mode && mode !== "build" ? { mode } : {}), ...(permissions ? { permissions } : {}), spec: proposal.spec, reason: proposal.reason };
  return validateChoice(config, choice, { requireEffort: true }) ?? choice;
}

const step = <T>(list: readonly T[], current: T | undefined, dir: 1 | -1): T | undefined => {
  if (!list.length) return undefined;
  const i = current === undefined ? -1 : list.indexOf(current);
  if (i < 0) return dir > 0 ? list[0] : list.at(-1);
  return list[(i + dir + list.length) % list.length];
};

/**
 * Tab adjust: the same agent with its next (`dir` 1) or previous offered model, wrapping; unchanged when it has no other.
 * Efforts are the model's: the effort stays when the new model takes it, else it becomes that model's default (or none).
 */
export function cycleModel(choice: AgentTriple, agents: AgentOption[], dir: 1 | -1 = 1): AgentTriple {
  const agent = agents.find((a) => a.harness === choice.harness);
  const id = agent && step(agent.models.map((m) => m.id), choice.model, dir);
  const model = agent?.models.find((m) => m.id === id);
  if (!model) return choice;
  const { effort: _, ...rest } = choice;
  const effort = choice.effort && model.efforts.includes(choice.effort) ? choice.effort : startEffort(model);
  return { ...rest, model: model.id, ...(effort ? { effort } : {}) };
}

/** The effort a model starts at: its default, else medium where it takes it, else its first; none for a model that takes none. */
export const startEffort = (model: { efforts: Effort[]; defaultEffort?: Effort }): Effort | undefined => model.defaultEffort ?? (model.efforts.includes("medium") ? "medium" : model.efforts[0]);

/** Tab adjust: the same agent and model with its next (`dir` 1) or previous effort of that model, wrapping; unchanged for a model that takes none. */
export function cycleEffort(choice: AgentTriple, agents: AgentOption[], dir: 1 | -1 = 1): AgentTriple {
  const model = agents.find((a) => a.harness === choice.harness)?.models.find((m) => m.id === choice.model);
  const effort = model && step(model.efforts, choice.effort, dir);
  return effort ? { ...choice, effort } : choice;
}

/**
 * ctrl+t: the next mode (build, explore, plan, build …) for the whole proposal; `current` none is build. A mode `harness` (the highlighted agent)
 * can't run (`ModeLaunch.unavailable`: Kimi Code's explore) is skipped, so the refusal never waits for enter (BUG-672).
 */
export function cycleMode(current: Mode | undefined, harness?: Harness): Mode {
  const runs = (m: Mode) => m === "build" || !harness || !HARNESS_INFO[harness]?.modes[m]?.unavailable;
  let next = current ?? "build";
  for (let i = 0; i < MODES.length; i++) {
    next = MODES[(MODES.indexOf(next) + 1) % MODES.length]!;
    if (runs(next)) return next;
  }
  return current ?? "build";
}

/** ctrl+p: the highlighted option's next permission level (`permissionLevels`: its harness's own first), wrapping; `own` for one with none. */
export function cyclePermissions(current: Permissions | undefined, harness: Harness): Permissions {
  const levels = permissionLevels(harness);
  return levels[(levels.indexOf(current ?? "own") + 1) % levels.length] ?? "own";
}
