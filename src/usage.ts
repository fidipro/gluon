// The usage text, the command line's options and its subcommands: one source for `gluon --help` (main.tsx) and the reference
// docs (`scripts/docs/gen.ts`). No side effects: importing it starts nothing.
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";

/** `parseArgs` options of the command line (`--yes` is no global option: main.tsx takes it out for `gluon sessions --delete`). */
export const CLI_OPTIONS = {
  launch: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  mode: { type: "string" },
  "dry-run": { type: "boolean" },
  all: { type: "boolean" },
  force: { type: "boolean" },
  delete: { type: "string" },
  demo: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export const SUBCOMMANDS = ["doctor", "setup", "brain", "connect", "install", "uninstall", "resume", "sessions", "routing"];

/** Commands `src/main.tsx` handles before the config loads: not in `SUBCOMMANDS` (that one's matching words take the config-needing paths). */
export const EARLY_COMMANDS = ["cost-report", "pricing", "stats", "update"];

/** The words a mistyped single-word session is compared with ("did you mean"): every command. */
export const HINT_COMMANDS = [...SUBCOMMANDS, ...EARLY_COMMANDS];

/** What `gluon --help` prints: the commands, then each agent with its models and efforts (from the config's catalog). */
export function usageText(config: Config, version: string = pkg.version): string {
  return `gluon ${version} — Gluon, a control platform for coding agents

  gluon                                   open Gluon: your sessions and the intake chat
  gluon "<what to build>"                 open Gluon with this as the first message
  gluon --demo                            the same UI with a scripted intake agent (no API calls)
  gluon --launch <harness> --model <m> [--effort <e>] [--mode <m>] [--dry-run] -- "<prompt>"
                                          skip the chat and launch an agent directly
                                          (--mode: build, the default; explore, read-only; plan, the agent's plan mode)
  gluon setup                             connect your coding agents (API key or subscription)
  gluon connect <harness>                 connect or reconnect one agent
  gluon install [<harness>…]              install missing agents with their official installers
                                          (shows each command, runs it only if you say so)
  gluon sessions                          list the saved sessions (workspaces) of every directory
  gluon sessions --delete <id> [--yes] [--force]
                                          delete one saved workspace (asks first; --yes without a terminal;
                                          --force: even while another Gluon has it open)
  gluon resume [<id>] [--all] [--force]   reopen a saved workspace: its sessions pick up where they were
                                          (no id: choose among this directory's; --all: every directory's;
                                          --force: even while another Gluon has it open)
  gluon routing check                     check routing.yaml (which agent runs a session, and what the intake agent is
                                          told about your preferences) against the agents below; exit 1 on a problem
  gluon routing path                      where routing.yaml is
  gluon routing default                   print the routing.yaml this Gluon ships (to compare with yours)
  gluon brain                             show the intake agent order (brain.order) and the step in use
  gluon doctor                            check every agent, model and brain step for real
  gluon cost-report                       what Gluon's own cost figures were audited against (no model calls)
  gluon pricing update                    rebuild the price tables now: prices from models.dev, OpenRouter and your
                                          installed Claude Code, windows from your installed agents (kept in
                                          Gluon's state dir; Gluon also does it in the background)
  gluon stats [--by agent|model|day|repo] [--agent <h>] [--repo <text>] [--since <when>] [--until <when>] [--json]
                                          what Gluon recorded about your launched sessions (a local file; no
                                          model calls): sessions, time and cost per agent, model, day or repo
  gluon stats sessions [--limit <n>]      the newest sessions, one per line (same filters)
  gluon stats <id>                        one session in full: its spec, routing and cost (an id prefix, 4+ characters)
  gluon stats sql "<query>"               a read-only SELECT against the table sessions (10 s, 10000 rows at most)
  gluon stats --delete [--yes]            delete every recorded session (asks first)
  gluon update [--check]                  install the latest Gluon release (signature and checksum verified first;
                                          --check: only say whether there is one). Gluon also updates itself at
                                          start: config key updates (auto, notify, off) or GLUON_UPDATES
  gluon uninstall [--yes]                 remove Gluon's config, saved keys and files
                                             (and the binary, on a standalone install)
  gluon --version

harnesses: ${config.agents.map((a) => `${a.harness} (models: ${a.models.map((m) => `${m.id}${m.efforts.length ? ` [${m.efforts.join(", ")}]` : ""}`).join(", ")})`).join("\n           ")}`;
}
