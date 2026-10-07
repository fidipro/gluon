---
title: "Modes"
description: "Start a session in build, explore or plan mode, and what each mode does for each agent."
---

A mode is how a session starts. The intake agent proposes one with the agent, and you can change it before you start.

| Mode | What it does |
|---|---|
| `build` | The agent as it is. This is the default, and the row shows nothing. |
| `explore` | Strictly read-only: understand, investigate or review without changes. Rows show `· explore`. |
| `plan` | The agent's own plan mode: a plan to agree before anything changes. Rows show `· plan`. |

Press `ctrl+t` in the agent choice to cycle build, explore and plan for the whole choice (a mode the highlighted agent cannot run, like explore for Kimi Code, is skipped). The sessions list shows each session's mode. From the command line, a direct launch can take a mode without the chat, and a dry run prints what it would run ([command line reference](../reference/cli.md)).

A saved session keeps its mode, and a session reopened with `gluon resume` goes through the agent's own resume with `explore` applied again: Codex gets its read-only sandbox and no approvals again, Grok Build its sandbox and deny rules, OpenCode its read-only agent, Claude Code its read-only permission mode and removed write tools (its own session keeps the permission mode as well). `plan` is not applied again (it is a state of the conversation: once you approve a plan the agent leaves it), and Gluon types and sends nothing again, no `/plan` and no brief. The row shows the mode the session was started in.

A Codex, Grok Build or OpenCode session saved by an earlier Gluon has no mode on record, so Gluon cannot tell whether it was read-only and does not resume it: the chat says so and names the delete option of `gluon sessions` ([command line reference](../reference/cli.md)), which deletes the whole workspace. Claude Code sessions without a mode resume as before, since its own session keeps its permission mode.

## What each mode does per agent

What a mode does is the agent's own, so it differs.

- **Claude Code.** `explore` starts it in a read-only permission mode with its write tools removed. `plan` starts it in its plan mode.
- **Codex.** `explore` starts it in its read-only sandbox, never asking for approval. Codex has no flag for plan mode, so Gluon types `/plan` into it once it is up.
- **Antigravity.** It has no read-only mode, so `explore` is its plan mode and the row says `explore (plan mode)`. `plan` is its plan mode.
- **Grok Build.** `explore` starts it in its read-only sandbox with `Edit`, `Write` and `Bash` denied, so it can read, search and list files but run no shell commands. Its interface ignores the permission flag, which is why denying is what stops the prompts. Like Codex, `plan` is a typed `/plan`.
- **OpenCode.** `explore` starts it in an agent that may only read. `plan` starts it in its `plan` agent.
- **Kimi Code.** `plan` starts it in its plan mode. It has no `explore`: its interactive mode ignores an agent file, so nothing can make it read-only, and it is never started in explore. Routing leaves it out of an explore session.

:::caution
Codex and Grok Build plan mode works only in Gluon's frame, because Gluon types `/plan` into the running agent. A direct launch from the command line and a terminal without a pseudo-terminal refuse it. Use `explore` or `build` there.
:::

The flags and settings behind each mode are `HARNESS_INFO.modes` in `src/harnesses.ts`, and the [CLI reference](../reference/cli.md) says how a direct launch takes a mode.

## What Gluon adds to the spec

- Explore never gets a [worktree](worktrees.md).
- A short block at the end of the spec says what the mode allows, whatever the intake agent wrote before `ctrl+t` changed it.
- When your repository has an instruction file the chosen agent does not load itself (`CLAUDE.md` for Codex, say), the spec ends with a line telling it to read that file.
- Kimi Code takes no prompt on its command line, so in every mode Gluon types its brief line (`Read the session brief in <file> and start.`) into it. If the line cannot be typed, because you typed first or its input box never showed, Gluon shows the line in the chat and over the top of the agent's frame, so you can type it yourself. It goes away when you press Esc.

## Next steps

- [Worktrees](worktrees.md): where build and plan sessions work.
- [Routing](routing.md): how the intake agent's choice of mode feeds routing.
- [Kimi Code](harnesses/kimi-code.md): why it has no explore mode.

<!-- Keeping this file fresh: update in the change that alters what starts a harness in explore or plan (HARNESS_INFO.modes in src/harnesses.ts), the typed `/plan` or brief line (src/launchers.ts, src/intake.ts) or the mode block added to a spec (src/intake.ts). Recheck against docs/contributing/maintenance.md after a harness update. -->
