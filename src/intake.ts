// The intake's seam to the rest of Gluon: the catalog as routing sees it, the connected harnesses,
// and the lines the launcher adds to a spec. `routing.ts` knows no harness; this file does.
import type { AgentOption, Config } from "./config.ts";
import { agentsFrom } from "./config.ts";
import { effortsOn, HARNESS_INFO, MODES, type Harness } from "./harnesses.ts";
import { resolveModel } from "./models.ts";
import { subagentNote, type Config as RoutingConfig, type Env, type RouteCatalog } from "./routing.ts";

/** Harnesses whose models delegate to their own family as subagents (the launcher says which models, `subagentNote`). */
const DELEGATES_IN_FAMILY: Harness[] = ["opencode"];

/** `routing.yaml`'s opt-in keys: a model with `optIn: key` is used only when `routing[key] === true`. */
export const optedInBy = (routing: RoutingConfig) => (key: string): boolean => (routing as unknown as Record<string, unknown>)[key] === true;

/**
 * The catalog routing works on: each harness in `agents` (default `config.agents`: what Gluon offered,
 * installed, connected and reachable) with the models of `config.models` that `agents` lists. A model
 * with an opt-in key stays in whatever `agents` says, so route can explain a pin to it ("set
 * allow_muse_contributor"); `usableCatalog` removes it unless routing.yaml opts in.
 */
export function routeCatalog(config: Config, agents: AgentOption[] = config.agents, routing?: RoutingConfig): RouteCatalog {
  const optedIn = routing ? optedInBy(routing) : () => false;
  return agents.map((a) => {
    const entries = config.models[a.harness] ?? [];
    // Modes the harness can't run (`ModeLaunch.unavailable`): route leaves it out of a session in one.
    const noModes = MODES.filter((m) => m !== "build" && HARNESS_INFO[a.harness]?.modes[m]?.unavailable);
    return {
      id: a.harness,
      name: a.label,
      ...(noModes.length ? { noModes } : {}),
      ...(DELEGATES_IN_FAMILY.includes(a.harness) ? { delegatesInFamily: true } : {}),
      models: entries
        .filter((m) => a.models.some((o) => o.id === m.id) || (m.optIn !== undefined && !optedIn(m.optIn)))
        .map((m) => {
          // The efforts the model takes on the connection it runs on (`effortConns`): K3 on OpenRouter takes none, so route never picks one Kimi can't receive.
          const conn = resolveModel(config, a.harness, m.id)?.conn;
          const efforts = conn ? effortsOn(m, conn) : m.efforts;
          return {
            id: m.id,
            name: m.label,
            efforts,
            ...(m.defaultEffort && efforts.length ? { defaultEffort: m.defaultEffort } : {}),
            ...(m.family ? { family: m.family } : {}),
            ...(m.current ? { current: m.current } : {}),
            ...(m.sharesDataWith ? { sharesDataWith: m.sharesDataWith } : {}),
            ...(m.optIn ? { optIn: m.optIn } : {}),
          };
        }),
    };
  });
}

/** Everything Gluon knows (installed or not, connected or not): where the unavailable lines of `<available_agents>` come from. */
export const allRouteCatalog = (config: Config): RouteCatalog => routeCatalog(config, agentsFrom(config.models));

/** The harnesses route may use: those Gluon offers (`config.agents`). */
export const routeEnv = (config: Config): Env => ({ connected: config.agents.map((a) => a.harness) });

/**
 * The instruction files (of those in `present`) that `harness` doesn't load: it must be told to read them
 * (`HARNESS_INFO[h].instructionFiles` says which it loads). A harness this build has no row for loads none
 * it could be told to read: it gets no line.
 */
export function unloadedInstructionFiles(harness: Harness, present: string[]): string[] {
  const info = HARNESS_INFO[harness]?.instructionFiles;
  if (!info) return [];
  const loaded = info.firstOnly ? info.files.filter((f) => present.includes(f)).slice(0, 1) : info.files;
  return present.filter((f) => !loaded.includes(f));
}

/** The line the launcher adds for one instruction file the harness doesn't load. */
export const readInstructionLine = (file: string): string =>
  `Read \`${file}\` before you start: it is this project's instructions for coding agents, and your harness doesn't load it.`;

/**
 * What the launcher adds after the spec for this option: a line per instruction file the repository has
 * and the harness doesn't load, and, for a harness that delegates within a family (OpenCode), the
 * models it may use for subagents. Empty when there is nothing to add.
 */
export function launcherLines(opts: { routing: RoutingConfig; catalog: RouteCatalog; harness: Harness; model: string; instructionFiles: string[] }): string[] {
  const lines = unloadedInstructionFiles(opts.harness, opts.instructionFiles).map(readInstructionLine);
  const note = subagentNote(opts.routing, opts.catalog, { harness: opts.harness, model: opts.model });
  return note ? [...lines, note] : lines;
}

/** The spec with the launcher's lines after it. */
export function withLauncherLines(spec: string, lines: string[]): string {
  return lines.length ? `${spec.trim()}\n\n${lines.join("\n\n")}` : spec;
}
