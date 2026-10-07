/**
 * Hidden subcommands that run inside a launched agent (issue #13), never shown in `--help`:
 * `gluon signal back` (the user asked to return to Gluon, `events.ts`) and
 * `gluon hook <harness> <name>` (a harness's hook, handled by its adapter: `Adapter.hook`).
 * They load nothing else, need no config and never fail the agent: outside a Gluon launch
 * (`GLUON_EVENTS` unset) they do nothing.
 */
import { EVENTS_ENV, HANDOFF_ENV, parseEvent, writeEvent } from "./events.ts";
import { parsePieces } from "./handoff.ts";
import type { Harness } from "./harnesses.ts";

/** Runs one of them; resolves with the exit code. */
export async function internal(sub: "signal" | "hook", args: string[]): Promise<number> {
  // A person typing an unquoted session that starts with one of these words (`gluon signal is
  // flaky`): say how to give it, like the other subcommands. A harness never runs them on a
  // terminal (BUG-141); inside an agent they stay silent and exit 0.
  if (args.length && process.stdin.isTTY && process.stdout.isTTY && !(await validArgs(sub, args))) {
    process.stderr.write(`gluon: ${sub} is used by Gluon inside a launched agent. (To give it as a session, quote it: gluon "${[sub, ...args].join(" ")}")\n`);
    return 2;
  }
  return sub === "hook" ? hook(args) : signal(args);
}

/** Whether these are arguments the subcommand takes: an event (`signal`), an adapter's hook (`hook`), none (`mcp`). */
async function validArgs(sub: "signal" | "hook", args: string[]): Promise<boolean> {
  if (sub === "signal") return args.length === 1 && args[0] === "back";
  const { ADAPTERS } = await import("./adapters/index.ts");
  return args.length === 2 && !!ADAPTERS[args[0] as Harness]?.hook;
}

/**
 * `signal back`: drops the `back` event into the launch's events directory. Prints nothing to
 * stdout and always exits 0 (a hook's failure must never disturb the agent); any other event, or
 * an events directory that doesn't exist (never created here), is ignored.
 */
function signal(args: string[]): number {
  const dir = process.env[EVENTS_ENV];
  if (!dir) {
    if (process.stderr.isTTY) process.stderr.write("gluon signal is used by Gluon's hooks inside a launched agent\n");
    return 0;
  }
  const event = args.length === 1 ? parseEvent(args[0]!) : null;
  // `compact` comes only from a waiting hook (`Adapter.hook`), with its own id.
  if (event?.name === "back" && !event.id) writeEvent(dir, event);
  return 0;
}

/** `hook <harness> <name>`: the adapter's answer to the harness's hook; nothing outside a Gluon launch. */
async function hook([harness, name]: string[]): Promise<number> {
  const dir = process.env[EVENTS_ENV];
  if (!dir || !harness || !name) return 0;
  try {
    const { ADAPTERS } = await import("./adapters/index.ts");
    const adapter = ADAPTERS[harness as Harness];
    if (!adapter?.hook) return 0;
    const input = await Bun.stdin.text();
    const r = await adapter.hook(name, input, { eventsDir: dir, pieces: parsePieces(process.env[HANDOFF_ENV]) });
    for (const e of r.events ?? []) writeEvent(dir, e);
    if (r.stdout) process.stdout.write(r.stdout);
    return r.code ?? 0;
  } catch {
    return 0;
  }
}
