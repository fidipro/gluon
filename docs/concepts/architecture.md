---
title: "How Gluon works"
description: "What happens between the gluon command and the agents at work in its UI."
---

A tour of what happens between `gluon` and the agents at work in its UI. The rules and traps worth
knowing before changing the code are in [AGENTS.md](../../AGENTS.md) and the `AGENTS.md` of each
area it points to. This page says how the pieces fit; the detail of each piece is in the header
comment of its file.

```
what to build ─▶ intake (LLM + read-only repo tools): one batch of questions, a spec, types and steps
                                      │ route (code: routing.yaml + the catalog)
                                      ▼
                 agent choice (mode + harness × model × effort, with alternatives) + spec
                                                                                 │ enter
                                                                                 ▼
                                        a session: the agent's own binary in Gluon's frame, with the spec;
                                        several at once, switched from the sessions home
```

Terms used below:

- **Harness**: one of the six coding-agent programs Gluon launches (Claude Code, Codex, Antigravity,
  Grok Build, OpenCode, Kimi Code). An **agent** is harness × model × effort.
- **Session**: one piece of work with one agent. Its **type** (feature, debug, review…) comes from
  your `routing.yaml` and decides how strong a model and effort it gets.
- **Mode**: explore (read-only), plan or build; see [modes](../guides/modes.md).
- **Spec**: the written brief the intake agent produces and the launched agent starts with.
- **Plan** (as in "on a plan"): a vendor subscription such as the Claude or ChatGPT plan, as opposed
  to an API key.
- **Intake agent**: the LLM that asks questions and writes the spec. The code and config call it the
  brain (`brain.order`, `gluon brain`). It writes the spec and classifies the session; code picks the agent.

## The intake chat

The home view (`src/ui/Home.tsx`) is Ink (React for terminals), modelled on Codex's TUI: the header,
the sessions list and the intake chat docked below it. Each chat is one draft; a new one starts
after each launch.

The intake agent gets a system prompt (`src/agent/prompt.ts`): a fixed text plus slots filled when
the chat starts: your `routing.yaml` notes, the session types, the agents Gluon offers (ids and
names only) and the repository (its layout and its `AGENTS.md` / `CLAUDE.md`, treated as the
repository's text, never as instructions to the intake agent). It works in a tool loop
(`src/agent/session.ts`):

- **Repository tools**, read-only: list files, grep, read a file, and `git_status`, `git_log`,
  `git_diff`. `forge` reads GitHub / GitLab issues and pull requests through your own `gh` / `glab`.
  Schemas and limits: `src/agent/tools.ts`.
- **`route`**, which runs in code, not as a repository tool. The intake agent gives it each session
  type with how far to move model and effort, and gets back the mode, the recommended agent and the
  alternatives. `Session` keeps the last result, and `propose_launch` can offer only that result.
- **`ask_user`** and **`propose_launch`**, the two tools that wait for you: questions with likely
  answers (one batch per proposal round), and the session's name, spec, types and worktree setting.

The options you pick from are built in `src/agent/choices.ts`.

**Mode and worktree.** The mode of a proposal comes from `route` (the strongest of its types' modes,
or the one you asked for); Ctrl+T changes it before Enter. Gluon writes the mode block into the
spec itself, so the intake agent doesn't. Where a worktree goes is Gluon's decision, not the model's
or the harness's (`src/worktree.ts`): the same for all six agents, inside the main checkout, and
Gluon creates nothing itself: the spec tells the agent to. See [worktrees](../guides/worktrees.md)
and [modes](../guides/modes.md).

**The repository tools are read-only and sandboxed to the repository**: no path out of it (`..`,
absolute paths, symlinks, other drives), no writes, no shell. Secret files can't be read or
searched, by one rule for every search backend (`isSecretPath`, `src/agent/scan.ts`). The git tools
see only the directory Gluon runs in and go through the hardened `gitQuery`
([below](#running-in-an-untrusted-repository)). `git` and `rg` are spawned by their absolute path
from `PATH`, never from the repository.

## Routing: `routing.yaml` and `route`

Which agent runs a session is code's decision, from your `routing.yaml` (next to `config.yaml`;
`gluon routing path` says where, `gluon routing check` reports mistakes). The intake agent decides
what the session is and how far to move model and effort; `route` (`src/routing.ts`, no harness
names in it) does the arithmetic: the strongest of each across the types, capped by your limits,
then the first model in the level's rank list that is offered and can give the effort.

The catalog `route` works on is built by `src/intake.ts` from the models Gluon offers (installed,
connected, a reachable model) and their facts in `src/harnesses.ts`. After you start an option, the
launcher adds to the spec what the chosen harness lacks (`src/gluon.ts`): the mode block, and a
line pointing at any instruction file the harness doesn't load itself.

The embedded default `routing.yaml` changes with the catalog. A user's file that equals an older
shipped default is replaced at load; an edited file is kept. So changing `src/routing.yaml` means
bumping its `version:` and adding its hash to `SHIPPED_ROUTING` (`src/routing-config.ts`). The user
side is in [routing](../guides/routing.md) and [routing.yaml](../reference/routing-yaml.md).

## The intake agent

The intake agent runs on the **first step of `brain.order` that is connected and answers a check**,
saved as `brain.active`. By default the plans come first (Claude, then ChatGPT), then API keys,
Bedrock and OpenRouter. `gluon brain` prints the order, the step in use and why earlier steps were
skipped. Antigravity, Grok Build, OpenCode and Kimi Code are agents only, never the intake agent.
If the model becomes unavailable mid-chat, the chat moves to the next working step and says so.

Each step may set an `effort`; every call sends the effort explicitly, in the field its route
takes, clamped to what the model supports (`src/agent/effort.ts`). A step without one runs at
medium.

| Route | Client |
|---|---|
| `claude-plan` | the Claude Agent SDK driving your own `claude`; Gluon's tools as in-process MCP tools (`src/agent/subscription.ts`) |
| `chatgpt-plan` | your own `codex app-server` over JSON-RPC; Gluon's tools as dynamic tools (`src/agent/codex.ts`) |
| `anthropic-api`, `openai-api`, `openrouter` | the provider's SDK or HTTP API |
| `bedrock` | Claude through the Bedrock SDK, other models through ConverseStream |

The API routes pass their endpoint explicitly and never read a base URL from your environment: an
SDK would send your key and conversation wherever `OPENAI_BASE_URL` points.

### The intake agent on a plan

On a plan the intake agent runs only through the vendor's official program on your own login. Gluon
never sees your token and never calls the vendor's API itself. Questions and proposals count toward
your plan's usage. The sessions are ephemeral (nothing in `~/.claude/projects` or Codex's history);
if the program stops mid-chat, the next message starts it again without the earlier conversation,
and Gluon says so. Gluon's prompt goes to the program unchanged; Gluon never claims to be the
vendor's product.

On the ChatGPT plan the intake agent gets Gluon's tools and nothing of Codex's own. This fails
closed: if the installed `codex` shows a feature or catalog field Gluon hasn't checked, the route
is refused and the order moves on (`src/agent/codex.ts` has the checks). `codex app-server` is
experimental, so a Codex update can break this route; `gluon doctor` shows it.

## Gluon: the sessions and the frame

Gluon is one long-lived app (`src/gluon.ts`): the sessions home and any number of agents running
at once, each in a pseudo-terminal of its own (ConPTY on Windows). The agents end with Gluon, but
the sessions are saved so `gluon resume` can reopen them ([below](#saved-sessions-and-resume)).

```
              ┌──────────── Gluon (one process) ────────────┐
 keyboard ──▶ │ compositor: one reader, one key decoder     │
              │   home view (Ink)  or  one session's frame  │ ──▶ your terminal (alternate screen)
              │ SessionStore: drafts and runs, display only │
              └──────────────────────────────────────────────┘
                AgentSession × N: the agent in its own PTY, a screen model, the events channel
```

- **The store** (`src/sessions.ts`) holds what both views show: the drafting row (at most one) and
  every run with its agent, model, effort, state, latest activity, cost, context % and files
  changed. It is display only: nothing is decided from it. "Done" is only ever the user's word
  (Ctrl+D); an agent's finished turn reads as awaiting input.
- **A session** (`src/pty/session.ts`) is the agent's own binary started in the repository with the
  spec, in a pseudo-terminal. It has no stdin, stdout or signals of its own: its output goes only
  into a screen model (`@xterm/headless`, `src/pty/screen.ts`), and it gets keys only from the
  compositor. It keeps running whether or not it is on screen.
- **The compositor** (`src/pty/compositor.ts`) alone reads the keyboard and writes the terminal. It
  shows either the home view or one session in Gluon's chrome (`src/pty/chrome.ts`), painted from
  that session's screen model (`src/pty/paint.ts`: only what changed). Keys go through one decoder
  (`src/pty/keys.ts`) whatever the terminal protocol. The home key (`handoff.key`, default `ctrl+\`)
  is a prefix in a session: the next key switches tab, goes home, zooms or cancels. Every other key
  goes to the agent as the terminal sent it. The terminal carries the shown agent's modes (mouse,
  kitty keys, focus: `src/pty/modes.ts`), switched as sessions are shown. [Keyboard](../guides/keyboard.md)
  lists the keys.

**What is lost inside the frame**: inline images, OSC 8 hyperlinks, and the agent's output in your
terminal's own scrollback once Gluon quits (it draws on the alternate screen).

### The agent's own /clear and /compact

A session that clears or compacts itself would silently end a session Gluon is tracking, so Gluon
asks first. When you type `/clear`, `/new` or `/compact`, it holds the Enter and asks in the bottom
bar whether to end the session (`on_clear`, `on_compact`). Rules that keep this safe
(`src/pty/intercept.ts`, `src/pty/readers/`):

- **The screen alone never triggers anything.** The repository's text can draw on it. A hold needs
  a `/` the user typed, and a paste never counts.
- **Unsure → forward.** A screen a reader can't read, or a line it can't match, lets the Enter go on.
- **Keys and screen stay in memory only.**

### The events channel

Per launch, a private directory outside the repository named in `GLUON_EVENTS`, with `GLUON_SELF`
naming a command that runs this Gluon (`src/events.ts`). `gluon signal back` (`/gluon` in Claude
Code and OpenCode) or `gluon hook <agent> <name>` (an agent's hook) drops one small file there;
Gluon polls it. Both commands do nothing outside a launch from Gluon. It carries:

- **`back`**: shows the home view; the agent keeps running.
- **`session`**: the harness's own conversation id, so the session can be resumed. It is checked
  against a fixed pattern and only ever saved, never shown or used as a path.
- **`compact`**: where the agent's `PreCompact` hook can wait (Claude Code, Codex, Grok Build),
  Gluon asks before an auto-compaction. OpenCode and Antigravity compact without asking.
- **`status`**: working, waiting for the user or turn finished, plus the latest activity. Display
  only, never acted on. Agents without hooks fall back to watching output.

### Status, cost and context

Cost and context are **Gluon's own calculation** (`src/cost/`). Each request a harness reports usage
for is priced by a function that ports that harness's own arithmetic, from a price table built on
the user's machine. No price table ships in the repository. `src/cost/refresh.ts` fetches prices
(models.dev, OpenRouter) in the background and reads context windows from the installed harness
binaries; `gluon pricing update` does it in the foreground. Offline, the last stored table stays.

```
harness usage ─▶ price table ─▶ CostTracker ─▶ session row (cost, context %)
                                       └────▶ audit ledger ◀── what the harness itself reported
```

What a harness itself reports (its own cost or window) is only an **audit**: it goes into a private
ledger beside Gluon's figure with the likeliest cause of any difference, and is never shown while
Gluon's figure exists. `gluon cost-report` summarises the ledger. Prompts, responses and tool
content are never exported; only counts and model names.

Markers: `~` an estimate or an API-equivalent price on a plan; `*` the harness's own total, shown
when the model has no price entry; `✓` a cost OpenRouter billed; `—` unknown. On OpenRouter the
provider's price per request varies, so after the session Gluon reads the usage of the key (a key
only Gluon uses) and shows the difference as the cost (`src/openrouter-billed.ts`).

Where each harness's figures come from (the per-harness assumptions are in the header comments of
the files named):

| Harness | Cost and context come from | Code |
|---|---|---|
| Claude Code | its OpenTelemetry export to a local listener, priced from Claude Code's own catalog | `src/telemetry.ts`, `src/cost/claude.ts` |
| Codex | its OpenTelemetry logs, windows from `codex debug models` | `src/cost/codex.ts` |
| OpenCode | its plugin following OpenCode's events | `src/adapters/opencode.ts`, `src/cost/opencode.ts` |
| Grok Build | its OpenTelemetry export (protobuf) | `src/otlp-protobuf.ts`, `src/cost/grok.ts` |
| Kimi Code | `kimi export` of the session, read in memory and deleted | `src/kimi-usage.ts`, `src/cost/kimi.ts` |
| Antigravity | its status line, context only (cost is `—`) | `src/adapters/agy-settings.ts` |

Per-agent adapters are in `src/adapters/`; `gluon doctor` shows, per agent, the effective settings
and what its adapter does with them. Gluon keeps two files in another tool's directory, both inert
unless `GLUON_EVENTS` is set and both removed by `gluon uninstall`: Grok Build's hooks file and
Antigravity's plugin (`src/adapters/permanent.ts`). The one other thing it writes there is
Antigravity's `statusLine` key, only with `cost.antigravity_statusline` on.

### Ending

A session that ends closes, whatever ended it (the agent's exit, a yes at its `/clear` or
`/compact`, Delete on its row): its row leaves the list and the sessions home shows. Delete on a
running row asks first; the agent then ends in the background (SIGTERM, then SIGKILL after
`KILL_GRACE_MS`, `src/launchers.ts`). Quitting asks first while sessions run, then ends them. Any
failure in Gluon ends every agent and gives the terminal back before exiting. A SIGTERM, SIGHUP or
SIGINT does the same (the agents get a grace to end); a second one while Gluon waits for them
gives the terminal back and exits at once. In the setup menus, before the frame, a signal restores
line mode and the cursor and exits 128 plus the signal's number.

### Saved sessions and resume

A **workspace** is one Gluon run in a repository: an id (`gluon resume abc123`), a name, the
directory, and a record per session (name, harness, model, effort, spec, worktree, mode and the
harness's own resume id). The intake chat is not saved. It is one private file per workspace
next to the config (`src/workspaces.ts`), written whole on every change. Quitting or a crash ends
the agents but keeps the record. `gluon resume` refuses a workspace another live Gluon has open.

How a session is found again depends on the harness (`resume` in `HARNESS_INFO`): Claude Code and
Grok Build run under an id Gluon makes; Codex and OpenCode make their own and send it through the
`session` event; Antigravity and Kimi Code can't be resumed. A resume sends no spec again and
re-applies only what the harness would lose (the explore mode's launch-time enforcement). A session
whose agent refuses the resume is asked about on the home view. The user side is in
[sessions](../guides/sessions.md).

### Session analytics

Gluon keeps a history of what it launched: one row per session in a private SQLite file
(`src/analytics.ts`; on by default, `analytics: off` stops it). `gluon stats` (`src/stats.ts`) reads
it. Unlike the cost ledger it holds a prompt and a path. Recording never breaks a launch. See
[analytics](../guides/analytics.md).

### Updates

At start, in the background and never before the first screen, `src/update/` asks GitHub which release is the latest:
once a day while Gluon is up to date, and at each start while it knows of a newer one (confirmed before it acts). With `updates: auto` (the default) it downloads `SHA256SUMS`, checks its Sigstore signature against the
Release workflow on `main` (the trusted root comes from Sigstore's TUF repository), downloads this platform's binary,
checks its hash, makes sure it answers `--version`, and renames it over the running executable (on Windows the old one
is moved aside first). The new version runs from the next start; `gluon update` does the same in the foreground.

### Without a pseudo-terminal

When Bun has no pseudo-terminal, the home view is the same, but a launch hands your terminal to the
agent directly (`handOffSession`, as `--launch` does) and the home view comes back when it ends.
Sessions run one at a time here, `/clear` and `/compact` don't ask, and a Codex or OpenCode session
can't be resumed.

### The agent's environment

`gluon --launch <agent> --model <m> [--dry-run] -- "<prompt>"` gives the agent your terminal
directly, with no pseudo-terminal, events channel or adapter files, and Gluon exits with its code.
`--dry-run` prints the exact command and environment, keys masked.

The agent's environment is yours, plus only the saved key of the provider its model runs on (and,
for a key connection, what makes the agent use it: see
[connections](../guides/connections.md#use-an-api-key)). Gluon never adds a login token, and sets a
base URL only on an API-key connection. On a plan connection, when one of your own variables would
change what the agent does, Gluon warns and leaves it. On Windows, see
[platforms](platforms.md#windows) for how the spec reaches an npm-installed agent.

## Checks: `gluon doctor`

`doctor` tests access for real, never assumes it: each agent (installed, version, sign-in), each
connection and model (✓ or ✗ with the reason; subscriptions through the agent's own binary, keys
through the provider), what each agent's adapter does with your settings, and the brain order. Tokens
are masked. The exit code is 1 when it prints any ✗ (something you connected that doesn't work) or
when there is no brain or no launchable agent; `·` lines and `!` notes don't count.

## Running in an untrusted repository

Gluon is meant to be run inside repositories you didn't write. It holds your keys, so the
repository's own code must never run inside it:

- **Nothing autoloads from the current directory** (`.env`, `bunfig.toml`, `tsconfig.json`,
  `package.json`): the executables are built with every autoload off, and the source entry runs as
  `bun --no-env-file --config=/dev/null`.
- **Binaries are found on `PATH`** (relative entries ignored) **and spawned by absolute path**; on
  Windows the current directory isn't searched and system tools run from System32.
- **Checks, version probes, logins and installers run in an empty private directory**
  (`neutralCwd()`), never in the repository.
- **git is hardened** (`src/agent/git.ts`): no fsmonitor, hooks, external diff drivers, textconv,
  filters or remote protocols, short timeouts, and the index is never rewritten. A hostile
  `.git/config` or `.gitattributes` can't run a command through these tools (`test/tools.test.ts`).
- **The intake agent's tools can't read secret files or leave the repository**, and the same rule
  applies to the `AGENTS.md` / `CLAUDE.md` put in its prompt.

## Offline testing

The regression suite drives the real UI in a pseudo-terminal and checks the screen, offline: a
scripted intake agent (the same one as `bun run demo`), fake agents, temporary repositories, and API
checks answered from a file. `test/e2e/README.md` describes the harness; `bun run test:area <area>`
runs one area's tests, and [CONTRIBUTING.md](../../CONTRIBUTING.md) ("When to run what") says what to
run for a change in the sessions frame or the cost code. Read the `AGENTS.md` of the area you edit
first (`src/`, `src/pty/`, `src/cost/`, `test/`).

## Next steps

- [Platforms](platforms.md): what is tested where, and the notes for each platform.
- [Maintenance](../contributing/maintenance.md): what to do when a harness or a provider changes under Gluon.
- [Contributing](../contributing/contributing.md): set up a checkout, run the tests and keep the rules.

<!-- Keeping this file fresh: update when the flow it describes changes: the intake chat and its tools, routing (`route`, `routing.yaml`), the brain order and its routes, the sessions and the frame (store, session, compositor, events channel), how cost and context are sourced, saved sessions and resume, the path without a pseudo-terminal, `doctor`, or the protections for an untrusted repository. Describe behaviour and point to the file or command; the detail of a mechanism belongs in that file's header comment, not here. No bug ids, issue numbers or dates. Check src/gluon.ts, src/routing.ts, src/harnesses.ts and src/telemetry.ts. -->
