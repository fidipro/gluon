---
title: "Sessions"
description: "Work with several agent sessions at once, read what each row shows, and save and resume sessions with gluon resume."
---

A session is one agent's own binary running in a terminal of its own, drawn inside Gluon's frame. You can have any number at once. Home is the list of your sessions, with the intake chat docked under it.

## What each row shows

Each row on the home view is display only: Gluon never acts on it. A header line names the right-hand columns.

- **State.** Working or awaiting your input, taken from the agent's hooks or its screen. A finished turn awaits your input. A session is done once you mark it.
- **Latest activity.** What the agent is doing now.
- **Mode.** `· explore` or `· plan`. Build shows nothing. A session reopened with `gluon resume` shows the mode it was started in ([Modes](modes.md)).
- **Cost and context.** Both are Gluon's own figures: see [Cost and context](cost-and-context.md).
- **Files changed** in your checkout since the session started. Sessions work where Gluon was started, so they share the work tree.

Rows are grouped (awaiting input, working, drafting). `ctrl+d` marks the selected session done, and again marks it not done: only you decide what is done. `del` removes any row, asking first.

## Work in the frame

Inside a session every key is the agent's, except the home key and a few arrow-key shortcuts. [Keyboard and mouse](keyboard.md) lists them all. The frame has a tab strip at the top, a status line, the agent's own UI and the keys at the bottom.

When a session ends, whatever ended it (the agent exits, or you said yes to ending it), it closes: you are back on the sessions home and its row is gone. An agent that exited with an error leaves a line in the chat.

A typed `/clear` or `/new` asks "ends this session in Gluon, end it?" in the bottom bar, and `/compact` asks "End this session instead of compacting?". Enter says yes. Esc or Ctrl+C sends nothing: the command stays typed so you can edit it, and the session goes on. Claude Code, Codex and Grok Build ask the same before compacting on their own. You can change these questions in the `handoff` settings below.

:::note
Inside the frame you lose inline images, OSC 8 hyperlinks, and the agents' output in your terminal's own scrollback after Gluon quits, because Gluon draws on the alternate screen. Where no pseudo-terminal can be had, sessions run one at a time, each with your terminal directly.
:::

## Save and resume sessions

Gluon saves what it takes to reopen a run, as a *workspace* with a six-character id. A workspace holds each session's name, agent, model, effort, mode, directory, the spec it started with (keys masked) and the agent's own session id. The intake chat is not saved.

The header names the workspace (`workspace abc123`) once you launch a session. When you quit, Gluon prints `Resume this session: gluon resume abc123`.

### Resume a workspace

```sh
gluon resume abc123
```

From any directory, `gluon resume` changes to the saved directory, starts Gluon with a fresh intake chat and reopens each session with its agent's own resume, without sending the spec again. A unique start of the id is enough. With no id it offers this directory's workspaces, and the all-directories option offers every directory's ([command line reference](../reference/cli.md)).

A session you end, or whose agent exits on its own, leaves the record. Quitting Gluon keeps it too. `gluon sessions` lists all saved workspaces, each with the time it last changed in your local time and its offset from UTC (`2026-10-06 19:30 UTC-04:00`; `UTC` alone where the offset is 0). The picker of `gluon resume` shows the same time.

Gluon records only what it can read back. A workspace holds at most 200 sessions, a spec at most 1,000,000 characters, and the file at most 4 MB. A session that would pass a limit still runs, but it is not recorded: the chat says so, and the sessions already saved stay readable. The metaharness does not propose a spec over the limit. A saved file that cannot be read (a hand edit, a crash mid-write, a newer Gluon, a copy under another name) is not a session: `gluon sessions` names it, and its delete option with that id removes it.

### When a session cannot be resumed

Some sessions cannot be reopened: Antigravity and Kimi Code cannot be resumed, Codex and OpenCode need the id their hook sends, and an agent may refuse the id. Gluon asks about such a session on the home view:

- Enter starts it again from its saved spec,
- Esc drops it from the record,
- Ctrl+C keeps it for the next resume.

The question comes unasked, so it ignores keys for a moment, never comes while you have text in the chat, and gives way to anything you type.

When the session's agent is not connected or its model is gone, there is nothing to ask: the chat says it can be neither resumed nor started again and that the record stays in its workspace. To let it go, the notice names the delete option of `gluon sessions` with the workspace's id, which deletes the whole workspace (quit this Gluon first: it owns the workspace until then). A saved directory that was moved or renamed stops `gluon resume` with the same advice: move the directory back (the agents find their sessions by directory), or delete the saved session the same way.

One session is not asked about but refused: a Codex, Grok Build or OpenCode session saved before Gluon recorded modes. Gluon cannot tell whether it was an explore (read-only) session and a resume would not keep that, so the chat says it was not resumed and names the delete option of `gluon sessions` (it deletes the whole workspace). It is never started again as a build session. See [Modes](modes.md).

### One Gluon per workspace

`gluon resume` of a workspace that another Gluon has open stops and names that Gluon's process, and the force option opens it anyway. Two `gluon resume` started at the same moment cannot both get in: the first takes a claim on the workspace at once, and the other is refused. A process that only has the same number as a Gluon that quit or crashed (numbers are reused) is not taken for it, and such a left-over claim never blocks. (On macOS, and where Gluon cannot read when a process started, only the number is compared.) To delete a saved workspace, use `gluon sessions` with its delete option and the workspace's id. It asks first, and a yes option skips the question. Deleting one another Gluon has open stops unless you force it. The options are in the [command line reference](../reference/cli.md). `gluon uninstall` removes every saved workspace, but not while a Gluon is running: it names that Gluon's process, removes nothing and exits with 1. Quit the Gluon and run it again.

## Your history

Gluon also keeps a local history of every session it launched (agent, model, repository, start, time, cost), apart from the saved workspaces above. `gluon stats` summarises it per agent, model, day or repository, lists the newest sessions, shows one in full and takes a read-only query (stopped after 10 seconds, at most 10,000 rows, a cut is said; add a `LIMIT`). Nothing leaves your machine; `analytics: off` in the config stops it. [Analytics](analytics.md) shows how to read and query it. The options are in the [command reference](../reference/cli.md#gluon-stats), and what is stored is in [Security and privacy](security-privacy.md#session-analytics).

## Settings for sessions in Gluon

The config's `handoff` section holds the settings for sessions in Gluon. Gluon adds it, with a comment for each value, at the latest at your first launch. In it you choose:

- **The home key** that opens the session menu from inside a session. Its default is in the [config reference](../reference/config.md); Codex uses `ctrl+]` itself, so don't set that for it.
- **What an agent's exit does:** close the session and show home, or quit Gluon with the agent's exit code when it was the last session.
- **What `/clear` and `/compact` do:** ask first, or go on as the agent's own.
- **Whether Gluon captures the mouse.** With it on, clicks on the home view select and open sessions and the wheel scrolls the chat. Off, the mouse is left to your terminal.

A mapping per agent under `agents` overrides any of these for that agent. `gluon doctor` shows the settings in effect per agent and what each agent can do with them. A direct launch from the command line ignores them. The keys and their values are in the [config reference](../reference/config.md).

## Next steps

- [Keyboard and mouse](keyboard.md): the keys on the home view and inside a session.
- [Cost and context](cost-and-context.md): how the cost and context columns are counted.
- [Command reference](../reference/cli.md): `resume`, `sessions` and every other command.

<!-- Keeping this file fresh: update in the change that alters the sessions home, the frame, saved workspaces or `gluon resume` (src/gluon.ts, src/sessions.ts, src/workspaces.ts, src/pty/compositor.ts) the handoff settings (src/handoff.ts) or `gluon stats` (src/stats.ts, src/stats-sql.ts). Which agents can resume is `resume` in src/harnesses.ts. -->
