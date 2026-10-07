---
title: "Quickstart"
description: "Run Gluon in a repository, say what you want to build and start your first agent session."
---

This page takes you from `gluon` to a running agent session in five steps. It assumes Gluon is [installed](install.md). To look at the UI first without keys or API calls, run Gluon in demo mode (see the [command line reference](../reference/cli.md)): it is the whole UI with a scripted intake agent.

<!-- example -->
```sh
gluon --demo
```

## Start Gluon

Open a terminal in the repository you want to work on and run:

```sh
cd your-repo
gluon
```

The first run opens setup. Setup checks which agents you use and connects each one with an API key or your own subscription. A missing agent is offered its vendor's official installer. Nothing is saved until the last screen, then Gluon checks every model for real (a few tiny billable calls) and picks the intake agent's model. [Connect your agents](connect-agents.md) walks through it. You can run `gluon setup` again at any time.

## Say what the session is for

Type what you want in the chat under the sessions list: one change, several, or something to explore. You can also pass it on the command line, as in `gluon "prices round down on the invoice page"`.

The intake agent looks around the repository, read-only, and asks only what it cannot tell from the code. It asks at most one batch of questions per proposal, shown one at a time, with likely answers to pick or your own to type.

## Pick the agent

The intake agent writes the spec the agent will get and shows it in a box. Under it is the recommended harness × model × effort, up to two alternatives, and `keep talking`.

- Tab changes the highlighted option's model and Shift+Tab its effort.
- Ctrl+T cycles the session's [mode](../guides/modes.md) for every option.
- PgUp and PgDn scroll a spec that is cut to fit, and Ctrl+O folds it to one line.

The intake agent never picks the agent itself. Your [routing](../guides/routing.md) does, among the models your connections can reach.

## Start the session

Enter starts the session in Gluon's frame:

- a tab strip at the top,
- a line with the agent, time, cost, context and files changed,
- the agent's own UI inside,
- the keys at the bottom.

In a git repository the session works in its own [worktree](../guides/worktrees.md).

## Keep going

Press `Ctrl+\` to open a one-key menu while every session keeps running. Then:

- the left and right arrows go to the previous or next session (home is the leftmost tab),
- `Ctrl+\` again shows the sessions home,
- `z` zooms the session, so the agent gets the whole terminal but the last row.

From home, start another session, or open one with Enter on its row or a click. When you quit, Gluon prints `Resume this session: gluon resume <id>`, and [`gluon resume`](../guides/sessions.md#resume-a-workspace) brings the sessions back.

:::tip
Every key is in [Keyboard and mouse](../guides/keyboard.md). Press `?` on the home view with an empty chat to list them in Gluon itself.
:::

## Next steps

- [Connect your agents](connect-agents.md): install agents and connect them with a key or a plan.
- [Sessions](../guides/sessions.md): what each row shows, saved sessions and resume.
- [Routing](../guides/routing.md): change which agent runs which kind of session.
- [Keyboard and mouse](../guides/keyboard.md): every key on the home view and inside a session.

<!-- Keeping this file fresh: update in the change that alters the first-run flow or the agent choice step (src/auth.ts, src/ui/, src/intake.ts), the session frame's chrome or its home key (src/pty/compositor.ts, src/handoff.ts), or what `gluon` prints at quit (src/gluon.ts). -->
